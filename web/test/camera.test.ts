import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, emptyFilter, filterFamilies } from '../src/core/camera/catalog';
import { BLE_SIGNATURES, bleClues, bleLabel, usbClues } from '../src/core/camera/clues';
import { demoLanApi } from '../src/core/camera/demo';
import { Inspections, PHOTO_LIMITS, priority, type Inspection, type PhotoRecord } from '../src/core/camera/inspection';
import { classify, emptyNote, NetModel, type NetDevice } from '../src/core/camera/model';
import { CameraNet, DOGD_HOWTO, type LanApi } from '../src/core/camera/net';
import { bleForReport, buildReport, CONCLUSION, conclusionOpen, type BleView, type ReportInput } from '../src/core/camera/report';
import type { BleDevice } from '../src/core/ble/model';
import type { DogdLanObservation, DogdLanStatus } from '../src/core/dogd';
import { SCREENS } from '../src/core/commands';
import { isNewScreen } from '../src/core/features';
import { LabBus, type LabEvent } from '../src/core/lab/events';
import { messageText, suggest } from '../src/core/lab/rules';
import { MemoryKv } from '../src/core/lab/store';
import { sceneFor } from '../src/ui/lab/sprites';

let seq = 0;
const obs = (o: Partial<DogdLanObservation>): DogdLanObservation => ({
  seq: ++seq,
  scan: 1,
  mono_ms: 0,
  wall_ms: 1_790_000_000_000 + seq,
  kind: 'neighbor',
  method: 'neighbors',
  iface: 'wlan0',
  ip: '192.168.1.10',
  mac: null,
  vendor: null,
  vendor_source: null,
  name: null,
  service: null,
  port: null,
  fields: {},
  raw: null,
  ...o,
});

function device(...list: Partial<DogdLanObservation>[]): NetDevice {
  const m = new NetModel();
  for (const o of list) m.add(obs(o), 'PHYSICAL');
  return [...m.devices.values()][0]!;
}

describe('Camera Sniffer catalog (offline)', () => {
  it('has the 16 families, each fully described, alphabetical and never ranked by frequency', () => {
    expect(CATALOG.families).toHaveLength(16);
    const names = filterFamilies(emptyFilter()).map((f) => f.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    for (const f of CATALOG.families) {
      expect(f.observable.length, f.id).toBeGreaterThan(0);
      expect(f.lookalikes.length, f.id).toBeGreaterThan(0);
      expect(f.checks.length, f.id).toBeGreaterThan(0);
      expect(f.limits.length, f.id).toBeGreaterThan(10);
      expect(f.rooms.length, f.id).toBeGreaterThan(0);
      expect(JSON.stringify(f)).not.toMatch(/most common|most frequent|\d+\s?%/i);
      for (const m of f.models) {
        expect(m.source && m.retrieved && m.status && m.lens).toBeTruthy();
        expect(typeof m.verified).toBe('boolean');
        // no photo without a credit and a license
        if (m.photo) expect(m.photo.credit && m.photo.license).toBeTruthy();
        // a claim that was not checked says so
        if (!m.verified) expect(m.status.toLowerCase()).toMatch(/could not|not (read|opened|confirmed)/);
      }
    }
    expect(CATALOG.note).toMatch(/never ranked by frequency/);
  });

  it('filters by room, power, storage, communication, method and text', () => {
    const f = emptyFilter();
    expect(filterFamilies({ ...f, room: 'vehicle' }).every((x) => x.rooms.includes('vehicle'))).toBe(true);
    expect(filterFamilies({ ...f, power: 'mains' }).map((x) => x.id)).toContain('usb-charger');
    expect(filterFamilies({ ...f, power: 'mains' }).map((x) => x.id)).not.toContain('tissue-box');
    expect(filterFamilies({ ...f, method: 'usb' }).every((x) => x.methods.includes('usb'))).toBe(true);
    expect(filterFamilies({ ...f, comms: 'ble' }).map((x) => x.id)).toContain('eyeglasses');
    expect(filterFamilies({ ...f, text: 'smoke' }).map((x) => x.id)).toContain('smoke-detector');
    expect(filterFamilies({ ...f, text: 'tissue' }).map((x) => x.id)).toEqual(['tissue-box']);
    expect(filterFamilies({ ...f, storage: true }).length).toBeGreaterThan(0);
  });
});

describe('explainable classification (never a percentage)', () => {
  it('an ONVIF NetworkVideoTransmitter is compatible with video equipment, a model when it reports one', () => {
    const d = device({ kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter tds:Device' });
    const c = classify(d);
    expect(c.state).toBe('VIDEO_COMPATIBLE');
    expect(c.reasons[0]!.text).toMatch(/recorder/i);
    expect(c.reasons[0]!.evidence).toBe(d.evidence[0]!.id);
    const m = classify(device({ kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter', fields: { hardware: 'NVR-8' } }));
    expect(m.state).toBe('MODEL_IDENTIFIED');
    expect(m.model).toMatch(/NVR-8.*as the device reports it/);
  });

  it('RTSP and media announcements are a media service, never a camera on their own', () => {
    expect(classify(device({ kind: 'service', method: 'services', port: 554, service: 'rtsp', fields: { rtsp_status: 'RTSP/1.0 200 OK' } })).state).toBe('MEDIA_SERVICE');
    expect(classify(device({ kind: 'upnp', method: 'ssdp', service: 'urn:schemas-upnp-org:device:MediaServer:1', fields: { manufacturer: 'NAS Co', model_name: 'DS-2' } })).state).toBe('MEDIA_SERVICE');
    expect(classify(device({ kind: 'mdns', method: 'mdns', service: '_googlecast._tcp.local', port: 8009 })).state).toBe('MEDIA_SERVICE');
  });

  it('a name, a manufacturer or an open port alone only adds hints', () => {
    const d = device(
      { kind: 'neighbor', mac: '00:11:22:33:44:55', vendor: 'Camera Corp' },
      { kind: 'mdns', method: 'mdns', name: 'ipcam-hall', service: '_http._tcp.local', port: 80 },
      { kind: 'service', method: 'services', port: 554, service: 'rtsp' },
      { kind: 'ssdp', method: 'ssdp', service: 'upnp:rootdevice', fields: { server: 'Linux UPnP/1.0 IPCam/1' } },
    );
    const c = classify(d);
    expect(c.state).toBe('DISCOVERED');
    const hints = c.reasons.filter((r) => r.role === 'HINT').map((r) => r.text).join(' ');
    expect(hints).toMatch(/identifies nothing/);
    expect(hints).toMatch(/origin of its network chip/);
    expect(hints).toMatch(/a port is not a service/);
    expect(JSON.stringify(c)).not.toMatch(/hidden camera|%/i);
  });

  it('only a documented verification confirms; marking known changes no observation', () => {
    const d = device({ kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter' });
    const known = classify(d, { ...emptyNote(), known: true, label: 'my NVR' });
    expect(known.state).toBe('VIDEO_COMPATIBLE');
    expect(known.reasons.at(-1)!.role).toBe('USER');
    expect(d.evidence).toHaveLength(1);
    expect(classify(d, { ...emptyNote(), confirmation: 'seen in the hallway, lens facing the door' }).state).toBe('CONFIRMED');
  });

  it('a device seen only through unreadable answers is undetermined', () => {
    expect(classify(device({ kind: 'upnp', method: 'ssdp', fields: { note: 'the description could not be read as UPnP XML' } })).state).toBe('UNDETERMINED');
  });

  it('keeps every observation once: repeats refresh the time, notes stay apart', () => {
    const m = new NetModel();
    const a = obs({ kind: 'mdns', method: 'mdns', service: '_ipp._tcp.local', port: 631 });
    m.add(a, 'PHYSICAL');
    m.add(a, 'PHYSICAL');
    m.add({ ...a, seq: ++seq, wall_ms: a.wall_ms + 5000 }, 'PHYSICAL');
    const d = [...m.devices.values()][0]!;
    expect(d.evidence).toHaveLength(1);
    expect(d.lastSeen).toBe(a.wall_ms + 5000);
    m.add(obs({ kind: 'note', ip: null, fields: { note: 'mDNS socket: denied' } }), 'PHYSICAL');
    expect(m.devices.size).toBe(1);
    expect(m.notes).toHaveLength(1);
  });
});

describe('network discovery service', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (api?: LanApi) => {
    const bus = new LabBus();
    const events: LabEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const net = new CameraNet(bus, () => api ?? demoLanApi(() => Date.now()));
    return { bus, events, net };
  };

  it('what was said about a device stays with that device and those results', () => {
    const { net } = make();
    net.model.add(obs({ ip: '192.168.1.23', kind: 'neighbor', mac: 'aa:bb:cc:00:00:01' }), 'PHYSICAL');
    const key = [...net.model.devices.keys()][0]!;
    net.setNote(key, { known: true, confirmation: 'lens behind the smoke detector grille, flat A' });
    expect(net.note(key).known).toBe(true);
    expect(net.liveNotes().get(key)?.confirmation).toMatch(/flat A/);
    // another place, another device at the same address: it inherits nothing
    net.model.clear();
    net.model.add(obs({ ip: '192.168.1.23', kind: 'neighbor', mac: 'dd:ee:ff:00:00:02' }), 'PHYSICAL');
    expect(net.note(key)).toEqual({ known: false, label: '', confirmation: '', ble: [] });
    expect(net.liveNotes().get(key)?.known).toBe(false);
    // CLEAR RESULTS takes what was said with them
    net.clear();
    net.model.add(obs({ ip: '192.168.1.23', kind: 'neighbor', mac: 'aa:bb:cc:00:00:01' }), 'PHYSICAL');
    expect(net.note(key).known).toBe(false);
  });

  it('scans the demo network end to end, records it and says it neutrally', async () => {
    const { net, events } = make();
    await net.refresh('DEMO');
    expect(net.iface).toBe('demo0');
    expect(net.interfaces.find((i) => i.name === 'demo-guest')!.refused).toMatch(/16/);
    await net.start();
    expect(net.state).toBe('SCANNING');
    await vi.advanceTimersByTimeAsync(6000);
    expect(net.state).toBe('DONE');
    expect(net.model.devices.size).toBe(8);
    expect([...net.model.devices.values()].every((d) => d.origin === 'SIMULATED')).toBe(true);
    const start = events.find((e) => e.type === 'op.start')!;
    expect(start.params?.['kind']).toBe('search');
    expect(start.origin).toBe('SIMULATED');
    const end = events.find((e) => e.type === 'op.end')!;
    expect(end.severity).toBe('PASS');
    expect(end.params?.['say']).toBe('cam.video');
    expect(events.filter((e) => e.type === 'observe').every((e) => e.origin === 'SIMULATED')).toBe(true);
    // every evidence points at its lab event
    for (const d of net.model.devices.values()) for (const ev of d.evidence) expect(ev.labSeq).toBeGreaterThan(0);
    expect(events.some((e) => e.params?.['say'] === 'cam.unidentified')).toBe(true);
  });

  it('a second start while scanning starts nothing; a stop keeps what was observed', async () => {
    const { net, events } = make();
    await net.refresh('DEMO');
    await net.start();
    await net.start();
    expect(events.filter((e) => e.type === 'op.start')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1200);
    const seen = net.model.devices.size;
    expect(seen).toBeGreaterThan(0);
    await net.stop();
    expect(net.state).toBe('CANCELLED');
    expect(net.model.devices.size).toBeGreaterThanOrEqual(seen);
    expect(events.at(-1)!.code).toBe('CANCELLED');
  });

  it('two quick clicks on START make one scan, and it is read to the end', async () => {
    const { net, events } = make();
    await net.refresh('DEMO');
    await Promise.all([net.start(), net.start()]);
    expect(events.filter((e) => e.type === 'op.start')).toHaveLength(1);
    expect(net.error).toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(net.state).toBe('DONE');
    expect(net.model.devices.size).toBe(8);
  });

  it('a scan numbered from 1 again (a restarted engine) is not taken for a repeat, and simulated never mixes with physical', async () => {
    const m = new NetModel();
    expect(m.add(obs({ seq: 1, scan: 1, ip: '192.168.1.5', kind: 'neighbor', mac: 'aa:bb:cc:00:00:01' }), 'PHYSICAL', undefined, 1)).not.toBeNull();
    const again = m.add(obs({ seq: 1, scan: 1, ip: '192.168.1.5', kind: 'service', port: 554, service: 'rtsp', fields: { rtsp_status: 'RTSP/1.0 200 OK' } }), 'PHYSICAL', undefined, 2);
    expect(again).not.toBeNull();
    expect(classify(again!).state).toBe('MEDIA_SERVICE');

    const { net } = make();
    net.model.add(obs({ ip: '10.0.0.9' }), 'PHYSICAL', undefined, 0);
    await net.refresh('DEMO');
    await net.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect([...net.model.devices.values()].every((d) => d.origin === 'SIMULATED')).toBe(true);
  });

  it('without dogd it says how to start it, and nothing breaks', async () => {
    const broken: LanApi = {
      interfaces: () => Promise.reject(new Error('no dogd at 127.0.0.1:4782')),
      status: () => Promise.reject(new Error('x')),
      scan: () => Promise.reject(new Error('x')),
      observations: () => Promise.reject(new Error('x')),
    };
    const net = new CameraNet(new LabBus(), () => broken);
    await net.refresh('DEMO');
    expect(net.error?.code).toBe('DOGD_ABSENT');
    expect(net.interfaces).toEqual([]);
    await net.start();
    expect(net.error?.code).toBe('NO_IFACE');
    expect(DOGD_HOWTO).toMatch(/dogd serve/);
  });

  it('a refused scan and a lost engine are errors with the cause, observations kept', async () => {
    const demo = demoLanApi(() => Date.now());
    let alive = true;
    const flaky: LanApi = {
      interfaces: () => demo.interfaces(),
      scan: (r) => demo.scan(r),
      status: () => (alive ? demo.status() : Promise.reject(new Error('connection refused'))),
      observations: (s) => (alive ? demo.observations(s) : Promise.reject(new Error('connection refused'))),
    };
    const { net, events } = make(flaky);
    await net.refresh('DEMO');
    await net.start();
    await vi.advanceTimersByTimeAsync(1000);
    const kept = net.model.devices.size;
    alive = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(net.state).toBe('ERROR');
    expect(net.error?.code).toBe('DOGD_LOST');
    expect(net.model.devices.size).toBe(kept);
    expect(events.at(-1)!.severity).toBe('FAIL');

    const refusing: LanApi = { ...demo, scan: () => Promise.reject(new Error('a scan is already running: stop it first')) };
    const r = make(refusing);
    await r.net.refresh('DEMO');
    await r.net.start();
    expect(r.net.error).toEqual({ code: 'SCAN_REFUSED', message: 'a scan is already running: stop it first' });
  });

  it('malformed or incomplete records do not break the model', async () => {
    const status: DogdLanStatus = { supported: true, state: 'done', detail: 'ok', scan: 1, iface: 'wlan0', methods: ['neighbors'], step: null, done: 0, total: null, started_wall_ms: null, finished_wall_ms: null, oui_source: null };
    // like dogd's ring: nothing before the scan, then three odd records
    let started = false;
    const odd: LanApi = {
      interfaces: async () => ({ supported: true, interfaces: [{ name: 'wlan0', address: '192.168.1.2', prefix: 24, network: '192.168.1.0/24', up: true, private: true, loopback: false, refused: null }] }),
      scan: async () => ((started = true), { ...status, state: 'scanning' }),
      status: async () => status,
      observations: async (since) =>
        !started
          ? { next: 0, lost: 0, observations: [] }
          : since >= 3
          ? { next: 3, lost: 2, observations: [] }
          : { next: 3, lost: 2, observations: [obs({ seq: 1, ip: null, kind: 'note', fields: {} }), obs({ seq: 2, kind: 'upnp', fields: { note: 'unreadable' }, raw: '<x' }), obs({ seq: 3, ip: '192.168.1.9', service: null })] },
    };
    const { net } = make(odd);
    await net.refresh('DEMO');
    await net.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(net.state).toBe('DONE');
    expect(net.lost).toBeGreaterThan(0);
    expect(net.model.notes).toHaveLength(1);
  });
});

describe('messages, TV scenes and the menu', () => {
  it('speaks French and English, neutrally, also outside the TV', () => {
    expect(messageText('cam.searching', 'fr')).toBe('Recherche sur le réseau sélectionné.');
    expect(messageText('cam.video', 'fr')).toBe('Service vidéo à examiner.');
    expect(messageText('cam.unidentified', 'fr')).toBe('Cet appareil n’est pas encore identifié.');
    expect(messageText('cam.visual', 'fr')).toBe('Cette vérification nécessite une inspection visuelle.');
    expect(messageText('cam.done', 'fr')).toBe('Inspection terminée. Certains appareils peuvent rester invisibles aux scans.');
    const e: LabEvent = { seq: 1, at: 0, mono: 0, source: 'CAMERA', tool: 'camera.net', type: 'op.end', severity: 'PASS', message: '', origin: 'PHYSICAL', params: { say: 'cam.video' } };
    expect(suggest(e, 'en')!.text).toBe('Video service to examine.');
    expect(suggest(e, 'en')!.severity).toBe('INFO');
    expect(suggest({ ...e, severity: 'FAIL', code: 'DOGD_LOST', params: {} }, 'fr')!.text).toMatch(/dogd/);
    for (const k of ['cam.searching', 'cam.video', 'cam.unidentified', 'cam.visual', 'cam.done', 'cam.netdone']) expect(messageText(k, 'en')).not.toMatch(/spy|found a camera|safe/i);
  });

  it('plays the drawn scenes: scanning, the magnifier, the printout', () => {
    expect(sceneFor('search', 0, { tool: 'camera.net', topic: null })?.id).toBe('scan');
    expect(sceneFor('read', 0, { tool: 'camera.object', topic: null })?.id).toBe('analyze');
    expect(sceneFor('read', 0, { tool: 'camera.compare', topic: null })?.id).toBe('report');
    expect(sceneFor('success', 0, { tool: 'camera.inspect', topic: null })?.id).toBe('report');
    expect(sceneFor('success', 0, { tool: 'camera.report', topic: null })?.id).toBe('report');
  });

  it('is a section of the menu, marked new', () => {
    expect(SCREENS).toContain('CAMERA');
    expect(isNewScreen('CAMERA')).toBe(true);
    expect(isNewScreen('STATUS')).toBe(false);
  });
});

describe('Bluetooth and USB clues', () => {
  const ble = (p: Partial<BleDevice>): BleDevice => ({
    key: `DEMO|${p.id ?? 'x'}`,
    id: 'x',
    idKind: 'ADDRESS',
    source: 'DEMO',
    adapter: 'demo',
    address: null,
    addressType: null,
    advName: null,
    systemName: null,
    firstSeen: 0,
    lastSeen: 0,
    lastMono: 0,
    count: 1,
    rssi: -60,
    rssiHistory: [],
    txPower: null,
    connectable: null,
    services: [],
    manufacturer: new Map(),
    serviceData: new Map(),
    previous: new Map(),
    payloadChanges: 0,
    ...p,
  } as BleDevice);

  it('names trackers from documented signatures, and nothing else', () => {
    const clues = bleClues([
      ble({ id: 'a', manufacturer: new Map([[0x004c, new Uint8Array([0x12, 0x19, 0x10])]]) }),
      ble({ id: 'b', services: ['0000feed-0000-1000-8000-00805f9b34fb'] }),
      ble({ id: 'c', advName: 'SPYCAM-01' }),
      ble({ id: 'd', manufacturer: new Map([[0x004c, new Uint8Array([0x10, 0x05])]]) }),
    ]);
    const by = (id: string) => clues.find((c) => c.id === id)!;
    expect(bleLabel(by('a'))).toMatch(/Find My.*offline iPhone.*not counted as a camera clue, not excluded either/);
    expect(bleLabel(by('b'))).toMatch(/Tile.*not counted as a camera clue/);
    // a name proves nothing: no signature, not identified
    expect(bleLabel(by('c'))).toBe('BLE device not identified');
    expect(bleLabel(by('d'))).toBe('BLE device not identified');
    for (const s of BLE_SIGNATURES) expect(s.source.length).toBeGreaterThan(20);
  });

  it('reads USB interfaces by class: video is a clue, nothing is not an exclusion', () => {
    const u = usbClues([
      { port: '1-1', vid: 0x046d, pid: 0x0825, manufacturer: 'Logitech', product: 'Webcam C270', serial: null, speed: 'HIGH', cls: 'MISC', power: 'BUS', max_ma: 500, interfaces: ['VIDEO', 'VIDEO', 'AUDIO', 'AUDIO'] },
      { port: '1-2', vid: 0x1234, pid: 0x0001, manufacturer: null, product: null, serial: null, speed: 'FULL', cls: 'MSC', power: 'BUS', max_ma: 100 },
      { port: '1', vid: 0x05e3, pid: 0x0610, manufacturer: null, product: null, serial: null, speed: 'HIGH', cls: 'HUB', power: 'SELF', max_ma: null, interfaces: ['HUB'] },
    ]);
    expect(u).toHaveLength(2);
    expect(u[0]!.video).toBe(true);
    expect(u[0]!.reading).toMatch(/proves neither/);
    expect(u[1]!.functions).toEqual(['STORAGE']);
    expect(u[1]!.reading).toMatch(/excludes nothing/);
  });
});

describe('guided inspection', () => {
  const make = () => {
    const bus = new LabBus();
    const events: LabEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const store = new MemoryKv<Inspection>();
    const photos = new MemoryKv<PhotoRecord>();
    return { bus, events, store, photos, insp: new Inspections(bus, store, photos) };
  };

  it('"confirmed (documented)" needs what was seen written down', () => {
    const { insp } = make();
    insp.start('');
    const r = insp.addRoom('bedroom');
    const item = insp.addItem(r.id, 'usb-charger')!;
    insp.update(item.id, { status: 'CONFIRMED_DOCUMENTED' });
    expect(insp.find(item.id)!.item.status).toBe('TO_EXAMINE');
    insp.update(item.id, { status: 'CONFIRMED_DOCUMENTED', observations: 'lens behind the grille, recording light on' });
    expect(insp.find(item.id)!.item.status).toBe('CONFIRMED_DOCUMENTED');
  });

  it('a photo is an image of bounded size; a refused one is an error to show, never dropped silently', async () => {
    const { insp } = make();
    insp.start('');
    const item = insp.addItem(insp.addRoom('bedroom').id, 'usb-charger')!;
    await expect(insp.addPhoto(item.id, new Blob(['x'], { type: 'text/html' }), 1, 1)).rejects.toThrow(/not an image/);
    const huge = { type: 'image/jpeg', size: PHOTO_LIMITS.maxBytes + 1 } as Blob;
    await expect(insp.addPhoto(item.id, huge, 1, 1)).rejects.toThrow(/more than 25 MB/);
    const full: typeof insp.photos = Object.assign(Object.create(insp.photos), { put: async () => Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' })) });
    const strict = new Inspections(new LabBus(), new MemoryKv<Inspection>(), full);
    strict.start('');
    const other = strict.addItem(strict.addRoom('bedroom').id, 'usb-charger')!;
    await expect(strict.addPhoto(other.id, new Blob(['x'], { type: 'image/jpeg' }), 1, 1)).rejects.toThrow('quota');
    expect(strict.find(other.id)!.item.photos).toEqual([]);
  });

  it('erasing the documentation of a confirmed object withdraws the confirmation, on the timeline', () => {
    const { insp, events } = make();
    insp.start('');
    const r = insp.addRoom('bedroom');
    const item = insp.addItem(r.id, 'usb-charger')!;
    insp.update(item.id, { status: 'CONFIRMED_DOCUMENTED', observations: 'lens behind the grille' });
    insp.update(item.id, { observations: '  ' });
    expect(insp.find(item.id)!.item.status).toBe('NEEDS_CHECK');
    const note = events.filter((e) => e.type === 'note').at(-1)!;
    expect(note.message).toMatch(/documentation was erased: confirmation withdrawn/);
    expect(note.params?.['withdrawn']).toBe(true);
    // a status change that keeps the documentation is not touched
    insp.update(item.id, { status: 'CONFIRMED_DOCUMENTED', observations: 'lens again' });
    insp.update(item.id, { nextCheck: 'RF scan' });
    expect(insp.find(item.id)!.item.status).toBe('CONFIRMED_DOCUMENTED');
  });

  it('orders the visit by what was said, never by catalog membership', () => {
    const { insp } = make();
    insp.start('Rental, 3rd floor');
    const kitchen = insp.addRoom('kitchen');
    const bed = insp.addRoom('bedroom', 'main');
    const a = insp.addItem(kitchen.id, 'usb-charger')!;
    const b = insp.addItem(bed.id, null, 'Lamp')!;
    const c = insp.addItem(bed.id, 'smoke-detector')!;
    // belonging to the catalog changes nothing
    expect(priority(kitchen, a)).toBe(0);
    insp.update(c.id, { facesPrivate: true, concrete: true });
    expect(insp.ordered().map((x) => x.item.id)).toEqual([c.id, b.id, a.id]);
    expect(priority(bed, insp.find(c.id)!.item)).toBe(3);
  });

  it('says status changes on the timeline, keeps photos local with their marks, and resumes', async () => {
    const { insp, events, store, photos, bus } = make();
    insp.start('');
    const r = insp.addRoom('bathroom');
    const item = insp.addItem(r.id, 'air-freshener')!;
    insp.update(item.id, { status: 'NEEDS_CHECK', observations: 'small round opening on the face' });
    expect(events.some((e) => e.type === 'op.end' && e.params?.['say'] === 'cam.visual')).toBe(true);
    expect(events.some((e) => e.source === 'USER' && e.params?.['declared'] === true && e.message.includes('Needs a further check'))).toBe(true);
    const rec = await insp.addPhoto(item.id, new Blob(['x'], { type: 'image/jpeg' }), 10, 10);
    await insp.annotate(rec!.id, [{ x: 2, y: -1, note: 'opening' }]);
    expect((await photos.get(rec!.id))!.annotations).toEqual([{ x: 1, y: 0, note: 'opening' }]);
    await new Promise((res) => setTimeout(res, 0));
    const again = new Inspections(bus, store, photos);
    await again.restore();
    expect(again.current.rooms[0]!.items[0]!.observations).toBe('small round opening on the face');
    insp.finish();
    expect(events.at(-1)!.params?.['say']).toBe('cam.done');
  });

  it('photos of a private room go with the object, the room or the inspection they belong to', async () => {
    const { insp, store, photos } = make();
    insp.start('Flat A');
    const bath = insp.addRoom('bathroom');
    const mirror = insp.addItem(bath.id, null, 'Mirror')!;
    const shelf = insp.addItem(bath.id, null, 'Shelf')!;
    const bed = insp.addRoom('bedroom');
    const lamp = insp.addItem(bed.id, null, 'Lamp')!;
    const shot = async (itemId: string) => (await insp.addPhoto(itemId, new Blob(['x'], { type: 'image/jpeg' }), 10, 10))!.id;
    const [m1, m2, s1, l1] = [await shot(mirror.id), await shot(mirror.id), await shot(shelf.id), await shot(lamp.id)];
    expect(insp.photoCount({ roomId: bath.id })).toBe(3);
    expect(insp.photoCount({ itemId: mirror.id })).toBe(2);
    await insp.removeItem(mirror.id);
    expect(await photos.get(m1)).toBeUndefined();
    expect(await photos.get(m2)).toBeUndefined();
    await insp.removeRoom(bath.id);
    expect(await photos.get(s1)).toBeUndefined();
    expect(await photos.get(l1)).toBeDefined();
    const old = insp.current.id;
    await insp.discard('Flat B');
    expect(await photos.get(l1)).toBeUndefined();
    expect(await store.get(old)).toBeUndefined();
    expect(insp.current.place).toBe('Flat B');
    expect(await photos.all()).toEqual([]);
  });
});

describe('report', () => {
  const base = (over: Partial<ReportInput> = {}): ReportInput => ({
    inspection: { id: 'i', created: 1_790_000_000_000, place: 'Flat 12, Rue Exemple', rooms: [], finished: null },
    devices: [],
    notes: new Map(),
    network: { iface: 'wlan0', network: '192.168.1.0/24', methods: ['neighbors', 'mdns'], state: 'DONE', detail: '3 host(s) seen on wlan0', origin: 'PHYSICAL', ran: true, lost: 0, scanNotes: [] },
    ble: { ran: true, source: 'DOGD', origin: 'PHYSICAL', clues: [] },
    usb: { ran: false, supported: false, clues: [] },
    generated: 1_790_000_100_000,
    lang: 'en',
    ...over,
  });
  const FORBIDDEN = /no camera|aucune caméra|pièce sécurisée|room is (safe|secure)|place is (safe|secure)|guaranteed/i;

  it('concludes with the methods used, never with an absence of cameras', () => {
    const r = buildReport(base(), { maskNetwork: false, hidePersonal: false });
    expect(r.conclusion).toBe('No clue identified with the methods used.');
    expect(r.text).not.toMatch(FORBIDDEN);
    expect(r.text).toMatch(/## LIMITS/);
    expect(buildReport(base({ lang: 'fr' }), { maskNetwork: false, hidePersonal: false }).conclusion).toBe(CONCLUSION.none.fr);
  });

  it('a device that announced nothing is still to identify: no strongest conclusion until it is known', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.44', kind: 'neighbor', mac: '10:20:30:40:50:60' }), 'PHYSICAL');
    const devices = [...m.devices.values()];
    const open = buildReport(base({ devices }), { maskNetwork: false, hidePersonal: false });
    expect(open.conclusion).toBe(conclusionOpen(1, 'en'));
    expect(open.text).toMatch(/192\.168\.1\.44 \(Device discovered\): identify it/);
    expect(open.text).not.toMatch(/Nothing left in the list/);
    const notes = new Map([[devices[0]!.key, { ...emptyNote(), known: true, label: 'my phone' }]]);
    expect(buildReport(base({ devices, notes }), { maskNetwork: false, hidePersonal: false }).conclusion).toBe(CONCLUSION.none.en);
  });

  it('Bluetooth facts come from a live scan started during this inspection, never from a replay', () => {
    const devices = new Map([['DEMO|A', { key: 'DEMO|A' } as never]]);
    const view = (o: Partial<BleView>): BleView => ({ sourceKind: 'DOGD', scanStartedAt: 2000, origin: 'PHYSICAL', state: 'SCANNING', replayOf: null, replayIntegrity: null, replaySimulated: false, model: { devices: new Map() }, ...o });
    expect(bleForReport(view({}), 1000)).toMatchObject({ ran: true, source: 'DOGD', clues: [] });
    // a live scan that saw nothing was a scan all the same
    expect(bleForReport(view({ state: 'IDLE' }), 1000).ran).toBe(true);
    const replay = bleForReport(view({ sourceKind: 'REPLAY', scanStartedAt: null, origin: 'REPLAY', state: 'REPLAY', replayOf: 'bench', replayIntegrity: 'MODIFIED', replaySimulated: true, model: { devices } }), 1000);
    expect(replay).toMatchObject({ ran: false, clues: [] });
    expect(replay.note).toBe('Bluetooth Lab shows a replay of bench (MODIFIED, SIMULATED): not observed during this inspection, not counted.');
    const older = bleForReport(view({ scanStartedAt: 500, model: { devices } }), 1000);
    expect(older).toMatchObject({ ran: false, note: 'Bluetooth Lab shows a scan started before this inspection: not counted.' });
    const text = buildReport(base({ ble: replay }), { maskNetwork: false, hidePersonal: false }).text;
    expect(text).toContain('- Bluetooth: not scanned during this inspection');
    expect(text).toContain('replay of bench (MODIFIED, SIMULATED)');
  });

  it('with no method run and nothing examined, it concludes nothing', () => {
    const idle = base({ network: { ...base().network, ran: false }, ble: { ...base().ble, ran: false } });
    const r = buildReport(idle, { maskNetwork: false, hidePersonal: false });
    expect(r.conclusion).toBe(CONCLUSION.nothing.en);
    expect(r.text).not.toContain(CONCLUSION.none.en);
    expect(buildReport({ ...idle, lang: 'fr' }, { maskNetwork: false, hidePersonal: false }).conclusion).toBe(CONCLUSION.nothing.fr);
  });

  it('separates facts, interpretations, declarations and what is left, with event references', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.70', kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter', name: 'Hall cam' }), 'PHYSICAL', 42);
    m.add(obs({ ip: '192.168.1.70', kind: 'neighbor', mac: 'aa:bb:cc:00:11:22' }), 'PHYSICAL', 43);
    const devices = [...m.devices.values()];
    const notes = new Map([[devices[0]!.key, { ...emptyNote(), known: true, label: 'landlord NVR' }]]);
    const r = buildReport(base({ devices, notes }), { maskNetwork: false, hidePersonal: false });
    expect(r.clues).toBe(1);
    expect(r.conclusion).toBe(CONCLUSION.some.en);
    const at = (h: string) => r.text.indexOf(h);
    expect(at('## FACTS')).toBeLessThan(at('## INTERPRETATIONS'));
    expect(at('## INTERPRETATIONS')).toBeLessThan(at('## DECLARATIONS'));
    expect(at('## DECLARATIONS')).toBeLessThan(at('## TO VERIFY'));
    expect(r.text).toMatch(/\[#42\]/);
    expect(r.text).toMatch(/marked known: landlord NVR/);
    expect(r.text).not.toMatch(FORBIDDEN);
  });

  it('masks network identifiers and hides personal notes when asked, in the exported text', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.70', kind: 'mdns', method: 'mdns', service: '_rtsp._tcp.local', name: 'Living room', port: 554 }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.70', kind: 'neighbor', mac: 'aa:bb:cc:00:11:22' }), 'PHYSICAL');
    const insp: Inspection = { id: 'i', created: 1, place: 'Flat 12, Rue Exemple', finished: null, rooms: [{ id: 'r', kind: 'bedroom', label: 'Anna’s room', items: [{ id: 'x', familyId: 'usb-charger', label: 'charger', where: 'by the bed', facesPrivate: true, concrete: true, status: 'NEEDS_CHECK', observations: 'opening on the left side', nextCheck: 'ask the host', checksDone: [], photos: ['p'], updated: 1 }] }] };
    const r = buildReport(base({ devices: [...m.devices.values()], inspection: insp }), { maskNetwork: true, hidePersonal: true });
    for (const secret of ['192.168.1.70', 'aa:bb:cc:00:11:22', 'Living room', 'Flat 12', 'Anna', 'opening on the left', 'by the bed', 'ask the host']) expect(r.text, secret).not.toContain(secret);
    expect(r.text).toMatch(/host-1/);
    expect(r.text).toMatch(/1 photo\(s\) kept in the browser \(not in this file\)/);
    const open = buildReport(base({ devices: [...m.devices.values()], inspection: insp }), { maskNetwork: false, hidePersonal: false });
    expect(open.text).toContain('192.168.1.70');
    expect(open.text).toContain('opening on the left side');
  });

  it('masks what hides inside other text: longer names, UUIDs, other MAC spellings, addresses someone typed', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.20', kind: 'mdns', method: 'mdns', service: '_http._tcp.local', name: 'Camera' }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.21', kind: 'mdns', method: 'mdns', service: '_http._tcp.local', name: 'Camera Bedroom Anna' }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.21', kind: 'ssdp', method: 'ssdp', service: 'uuid:2f402f80-da50-11e1-9b23-00178812abcd' }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.21', kind: 'neighbor', mac: '00:17:88:12:ab:cd' }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.22', kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter', fields: { hardware: 'IPC-00-17-88-12-AB-CD' } }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.23', kind: 'upnp', method: 'ssdp', service: 'urn:x', fields: { manufacturer: 'Acme', model_name: 'CAM 001788aabbcc' } }), 'PHYSICAL');
    const devices = [...m.devices.values()];
    const notes = new Map([[devices[1]!.key, { ...emptyNote(), known: true, label: 'cam at 192.168.1.5 / aa:bb:cc:dd:ee:ff', confirmation: 'seen at 192.168.1.21' }]]);
    const r = buildReport(base({ devices, notes }), { maskNetwork: true, hidePersonal: false });
    for (const secret of ['Bedroom', 'Anna', '2f402f80', '00178812abcd', '00-17-88-12-AB-CD', '001788aabbcc', '192.168.1.5', 'aa:bb:cc:dd:ee:ff', '192.168.1.21']) expect(r.text, secret).not.toContain(secret);
    expect(r.text).toMatch(/name-\d/);
  });

  it('a conclusion that says too much is never given while devices or objects are left to identify', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.40', kind: 'service', method: 'services', port: 554, service: 'rtsp', fields: { rtsp_status: 'RTSP/1.0 200 OK' } }), 'PHYSICAL');
    const r = buildReport(base({ devices: [...m.devices.values()] }), { maskNetwork: false, hidePersonal: false });
    expect(r.clues).toBe(0);
    expect(r.conclusion).toBe(conclusionOpen(1, 'en'));
    expect(conclusionOpen(2, 'fr')).toMatch(/^Aucun indice identifié pour l’instant avec les méthodes utilisées/);
    const known = buildReport(base({ devices: [...m.devices.values()], notes: new Map([[[...m.devices.keys()][0]!, { ...emptyNote(), known: true }]]) }), { maskNetwork: false, hidePersonal: false });
    expect(known.conclusion).toBe(CONCLUSION.none.en);
  });

  it('a device cannot write into the report: no forged line, no hidden rest, no remote image (audit 2026-10)', () => {
    const m = new NetModel();
    const hardware = 'X\n\n**RESULT: No clue identified with the methods used.**\n\n<!--';
    m.add(obs({ ip: '192.168.1.60', kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter', fields: { hardware } }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.61', kind: 'upnp', method: 'ssdp', service: 'urn:x', fields: { manufacturer: 'Acme', model_name: 'M1\n## LIMITS\n- none ![t](https://tracker.example/p.gif)' } }), 'PHYSICAL');
    for (const maskNetwork of [true, false]) {
      const r = buildReport(base({ devices: [...m.devices.values()] }), { maskNetwork, hidePersonal: false });
      const lines = r.text.split('\n');
      expect(lines.filter((l) => /^\s*(\*\*)?RESULT/.test(l)).length, String(maskNetwork)).toBe(2); // the report's own two
      expect(lines.find((l) => l.includes('**RESULT'))).toMatch(/^  - /); // the device's words stay inside its own evidence line
      expect(lines.filter((l) => l === '## LIMITS')).toHaveLength(1);
      expect(r.text).not.toMatch(/(^|[^\\])<!--/m);
      expect(r.text).not.toMatch(/!\[t\]\(https/);
    }
  });

  it('lists every answer an interpretation cites, and counts the ones it does not list', () => {
    const m = new NetModel();
    for (let i = 0; i < 20; i++) m.add(obs({ ip: '192.168.1.50', kind: 'mdns', method: 'mdns', service: `_svc${i}._tcp.local` }), 'PHYSICAL');
    m.add(obs({ ip: '192.168.1.50', kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter' }), 'PHYSICAL', 99);
    const r = buildReport(base({ devices: [...m.devices.values()] }), { maskNetwork: false, hidePersonal: false });
    const facts = r.text.slice(r.text.indexOf('## FACTS'), r.text.indexOf('## INTERPRETATIONS'));
    expect(facts).toMatch(/NetworkVideoTransmitter.*\[#99\]/);
    expect(facts).toMatch(/more answer\(s\)/);
  });

  it('a model reported on the network is never shown as a confirmed hidden camera', () => {
    const m = new NetModel();
    m.add(obs({ ip: '192.168.1.60', kind: 'wsd', method: 'wsd', service: 'dn:NetworkVideoTransmitter', fields: { hardware: 'IPC-X1' } }), 'PHYSICAL');
    const d = [...m.devices.values()][0]!;
    expect(classify(d).state).toBe('MODEL_IDENTIFIED');
    const r = buildReport(base({ devices: [d] }), { maskNetwork: false, hidePersonal: false });
    expect(r.text).toContain('Model reported by the device');
    expect(r.text).toMatch(/not established: That it is a camera hidden here/);
    const facts = r.text.slice(r.text.indexOf('## FACTS'), r.text.indexOf('## LIMITS'));
    expect(facts).not.toMatch(/camera confirmed/i);
    // only a person's documented verification confirms, and it reads as theirs
    const notes = new Map([[d.key, { ...emptyNote(), confirmation: 'lens seen behind the smoke detector grille, bedroom ceiling' }]]);
    const c = buildReport(base({ devices: [d], notes }), { maskNetwork: false, hidePersonal: false });
    expect(c.text).toMatch(/camera confirmed by your verification: lens seen/);
    expect(c.text).toMatch(/not established: Anything by the scan itself/);
  });

  it('labels simulated data', () => {
    const r = buildReport(base({ network: { ...base().network, origin: 'SIMULATED' } }), { maskNetwork: false, hidePersonal: false });
    expect(r.text).toMatch(/SIMULATED DATA/);
  });
});

describe('the posters slideshow', () => {
  it('has the five sheets, objects 01 to 80 without a gap, and wraps both ways', async () => {
    const { POSTERS, step } = await import('../src/ui/camera/PosterSlider');
    expect(POSTERS).toHaveLength(5);
    POSTERS.forEach((p, i) => expect(p.range).toEqual([i * 16 + 1, i * 16 + 16]));
    expect(step(4, 1)).toBe(0);
    expect(step(0, -1)).toBe(4);
    expect(step(2, 1)).toBe(3);
  });
});

describe('the lab database upgrade', () => {
  it('waits for a tab holding the older version, then works in memory and says why; this version never blocks a newer one', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { labStoreProblem, openLabStore, resetLabStore } = await import('../src/core/lab/store');
    const factory = new IDBFactory();
    // an old tab: version 1, no versionchange handler
    const old = await new Promise<IDBDatabase>((res) => {
      const r = factory.open('hwdog-lab', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sessions');
      r.onsuccess = () => res(r.result);
    });
    resetLabStore();
    const kv = await openLabStore('camera', factory);
    expect(kv.kind).toBe('MEMORY');
    expect(labStoreProblem()).toMatch(/older version/);
    old.close();
    resetLabStore();
    expect((await openLabStore('camera', factory)).kind).toBe('INDEXEDDB');
    // a newer version (4) opened elsewhere is not blocked by this one
    const newer = await new Promise<IDBDatabase>((res, rej) => {
      const r = factory.open('hwdog-lab', 4);
      r.onsuccess = () => res(r.result);
      r.onblocked = () => rej(new Error('blocked'));
    });
    expect(newer.version).toBe(4);
    newer.close();
    resetLabStore();
  }, 10_000);
});
