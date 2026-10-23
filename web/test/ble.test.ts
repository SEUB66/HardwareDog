import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePayload, loadNumbers, names } from '../src/core/ble/decode';
import { BLE_LIMITS, BleScanModel, presence, shortUuid, viewDevices, type BleObservation } from '../src/core/ble/model';
import { BleService, observationOf, payloadParams } from '../src/core/ble/service';
import { fromDogd } from '../src/core/ble/sources';
import { formatValue, parseValue } from '../src/core/ble/values';
import { LabBus } from '../src/core/lab/events';
import { LabRecorder, parseHdlab, toHdlab } from '../src/core/lab/session';
import { FakeTime } from './lab-helpers';

const obs = (o: Partial<BleObservation>): BleObservation => ({
  at: 0,
  mono: 0,
  source: 'DEMO',
  adapter: 'demo',
  id: 'X',
  idKind: 'demo-id',
  address: null,
  addressType: null,
  advName: null,
  systemName: null,
  rssi: -60,
  txPower: null,
  connectable: null,
  services: [],
  manufacturer: [],
  serviceData: [],
  ...o,
});

describe('BLE model', () => {
  it('never merges ids, keeps the payload before a change, counts observations', () => {
    const m = new BleScanModel();
    m.add(obs({ id: 'A', manufacturer: [{ company: 0xffff, data: Uint8Array.of(1) }] }));
    const r = m.add(obs({ id: 'A', manufacturer: [{ company: 0xffff, data: Uint8Array.of(2) }] }))!;
    m.add(obs({ id: 'B', advName: 'A' }));
    expect(m.devices.size).toBe(2);
    expect(r.changed).toBe(true);
    expect(r.device.previous.get('m:65535')).toEqual(Uint8Array.of(1));
    expect(r.device.payloadChanges).toBe(1);
    expect(m.observations).toBe(3);
  });

  it('a device advertising a new random UUID every time stays bounded and fast, and the cut is counted', () => {
    const m = new BleScanModel();
    const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
    const started = performance.now();
    for (let n = 0; n < 5000; n++) m.add(obs({ id: 'SPAM', services: [uuid(n), uuid(n + 100_000)], serviceData: [{ uuid: uuid(n), data: Uint8Array.of(1) }] }));
    expect(performance.now() - started).toBeLessThan(2000);
    const d = m.devices.get('DEMO|SPAM')!;
    expect(d.services).toHaveLength(BLE_LIMITS.maxEntries);
    expect(d.serviceData.size).toBe(BLE_LIMITS.maxEntries);
    expect(d.truncated).toBe(2 * 5000 - BLE_LIMITS.maxEntries + 5000 - BLE_LIMITS.maxEntries);
    // one advertisement cannot carry more than the limit either
    m.add(obs({ id: 'BIG', services: Array.from({ length: 500 }, (_, n) => uuid(n)) }));
    expect(m.devices.get('DEMO|BIG')!.services).toHaveLength(BLE_LIMITS.maxEntries);
    expect(m.devices.get('DEMO|BIG')!.truncated).toBe(500 - BLE_LIMITS.maxEntries);
  });

  it('refuses beyond its limit and says it', () => {
    const m = new BleScanModel();
    for (let i = 0; i < BLE_LIMITS.maxDevices + 3; i++) m.add(obs({ id: `D${i}` }));
    expect(m.devices.size).toBe(BLE_LIMITS.maxDevices);
    expect(m.refused).toBe(3);
  });

  it('sorts stably and filters', () => {
    const m = new BleScanModel();
    m.add(obs({ id: 'b', rssi: -50 }));
    m.add(obs({ id: 'a', rssi: -50 }));
    m.add(obs({ id: 'c', rssi: -90, advName: 'Thermo' }));
    const filter = { text: '', minRssi: null, namedOnly: false, connectableOnly: false };
    expect(viewDevices(m.devices.values(), filter, 'rssi').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(viewDevices(m.devices.values(), { ...filter, namedOnly: true }, 'rssi').map((d) => d.id)).toEqual(['c']);
    expect(viewDevices(m.devices.values(), { ...filter, minRssi: -60 }, 'name').map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('presence is an estimate from the last time seen', () => {
    const m = new BleScanModel();
    const d = m.add(obs({ mono: 0 }))!.device;
    expect(presence(d, 5000)).toBe('PRESENT');
    expect(presence(d, 30_000)).toBe('RECENT');
    expect(presence(d, 120_000)).toBe('GONE');
  });

  it('short UUIDs for the SIG base, full ones otherwise', () => {
    expect(shortUuid('0000180f-0000-1000-8000-00805f9b34fb')).toBe('180F');
    expect(shortUuid(0x4c)).toBe('004C');
    expect(shortUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  });
});

describe('BLE decoders', () => {
  it('decodes iBeacon and Eddystone TLM with their decoder id and version', () => {
    const ib = Uint8Array.of(0x02, 0x15, ...new Array(16).fill(0xab), 0x00, 0x07, 0x00, 0x2a, 0xc5);
    const d = decodePayload('manufacturer', 0x004c, ib)!;
    expect(d.decoder).toBe('apple.ibeacon');
    expect(d.version).toBe('1');
    expect(d.fields.find((f) => f.name === 'major')?.value).toBe(7);
    expect(d.fields.find((f) => f.name.startsWith('measured power'))?.value).toBe(-59);
    const tlm = Uint8Array.of(0x20, 0x00, 0x0b, 0xb8, 0x16, 0x80, 0, 0, 0x03, 0xe8, 0, 0, 0, 100);
    const t = decodePayload('service', 'FEAA', tlm)!;
    expect(t.fields.find((f) => f.name === 'battery')?.value).toBe(3000);
    expect(t.fields.find((f) => f.name === 'temperature')?.value).toBe(22.5);
  });

  it('leaves unknown payloads raw', () => {
    expect(decodePayload('manufacturer', 0x0006, Uint8Array.of(1, 2, 3))).toBeNull();
    expect(decodePayload('manufacturer', 0x004c, Uint8Array.of(0x10, 0x05))).toBeNull();
  });

  it('names companies and services from the bundled dictionary, offline', async () => {
    const n = await loadNumbers();
    expect(n.source.license).toBe('BSD-3-Clause');
    expect(names.company(0x004c)).toMatch(/Apple/);
    expect(names.service('0000180f-0000-1000-8000-00805f9b34fb')).toBe('Battery Service');
  });
});

describe('byte values with explicit byte order', () => {
  it('reads and writes both endians', () => {
    expect(formatValue(Uint8Array.of(0x01, 0x02), 'u16le')).toBe('513');
    expect(formatValue(Uint8Array.of(0x01, 0x02), 'u16be')).toBe('258');
    expect(formatValue(Uint8Array.of(0xff, 0x01, 0x02), 's16le')).toBe('511, (+1 byte(s) left over)');
    expect(parseValue('513', 'u16le')).toEqual(Uint8Array.of(0x01, 0x02));
    expect(parseValue('0x01 a0:FF', 'hex')).toEqual(Uint8Array.of(0x01, 0xa0, 0xff));
    expect(() => parseValue('300', 'u8')).toThrow('outside');
    expect(() => parseValue('1 2 3', 'hex')).toThrow();
  });
});

describe('BLE scan, session and replay', () => {
  it('a demo scan records sampled observations; a reopened session rebuilds the same devices', async () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const rec = new LabRecorder(bus, 'ble', 'test');
    const ble = new BleService(bus);
    // Feed the service directly through a fake source: deterministic times.
    const model = ble as unknown as { observe(o: BleObservation): void; state: string };
    for (let i = 0; i < 50; i++) {
      time.advance(100);
      model.observe(obs({ id: 'S', at: time.now(), mono: time.mono(), rssi: -60 - (i % 3), serviceData: [{ uuid: '180F', data: Uint8Array.of(i < 25 ? 90 : 89) }] }));
    }
    expect(ble.model.devices.get('DEMO|S')?.count).toBe(50);
    const data = rec.stop();
    const written = data.events.filter((e) => e.type === 'observe');
    // once a second, plus the payload change
    expect(written.length).toBeGreaterThanOrEqual(5);
    expect(written.length).toBeLessThan(10);
    const repeats = written.reduce((n, e) => n + Number(e.params?.['repeats'] ?? 0), 0);
    expect(repeats + written.length).toBeLessThanOrEqual(50);
    const reopened = parseHdlab(toHdlab(data));
    expect(reopened.integrity).toBe('VERIFIED');
    const back = new BleService(new LabBus(time));
    expect(await back.replay(reopened)).toBe(written.length);
    const d = [...back.model.devices.values()][0]!;
    expect(d.id).toBe('S');
    expect(d.serviceData.get('180F')).toEqual(Uint8Array.of(89));
    expect(d.previous.get('s:180F')).toEqual(Uint8Array.of(90));
    expect(back.state).toBe('REPLAY');
  });

  it('payload params round-trip exactly', () => {
    const o = obs({ manufacturer: [{ company: 0x004c, data: Uint8Array.of(2, 0x15) }], serviceData: [{ uuid: 'FEAA', data: Uint8Array.of(0x20) }] });
    const p = payloadParams(o);
    expect(p).toEqual({ mfr: '004C=0215', svc: 'FEAA=20' });
    const back = observationOf({ seq: 1, at: 0, mono: 0, source: 'BLE', tool: 'ble.scan', type: 'observe', severity: 'INFO', message: '', origin: 'PHYSICAL', params: { id: 'X', ...p } })!;
    expect(back.manufacturer).toEqual(o.manufacturer);
    expect(back.serviceData).toEqual(o.serviceData);
  });

  it('a dogd report keeps the BlueZ address, its type, and both names', () => {
    const time = new FakeTime();
    time.advance(10_000);
    const o = fromDogd(
      { seq: 1, mono_ms: 900, wall_ms: 5, adapter: 'hci0 00:1A', address: 'C0:FF:EE:00:00:01', address_type: 'random', name: 'Sensor', alias: 'Kitchen', rssi: -70, tx_power: null, uuids: ['0000180f-0000-1000-8000-00805f9b34fb'], manufacturer: { '76': '0215' }, service_data: { '0000feaa-0000-1000-8000-00805f9b34fb': '20' } },
      1000,
      time,
    );
    expect(o).toMatchObject({ id: 'C0:FF:EE:00:00:01', idKind: 'bluez-address', addressType: 'random', advName: 'Sensor', systemName: 'Kitchen', services: ['180F'] });
    expect(o.mono).toBe(10_000 - 100);
    expect(o.manufacturer[0]).toEqual({ company: 76, data: Uint8Array.of(2, 0x15) });
    expect(o.serviceData[0]!.uuid).toBe('FEAA');
  });
});

describe('stopping and picking never leave anything running behind', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
  });

  it('STOP pressed while dogd is starting discovery: no poller survives, dogd is told to stop', async () => {
    let release: (v: unknown) => void = () => {};
    const bodies: string[] = [];
    let polls = 0;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/ble/scan')) {
        const body = String(init?.body ?? '');
        bodies.push(body);
        if (body.includes('start')) await new Promise((r) => (release = r));
        return new Response(JSON.stringify({ supported: true, state: body.includes('start') ? 'scanning' : 'ready', adapter: 'hci0', detail: '' }));
      }
      polls++;
      return new Response(JSON.stringify({ now_mono_ms: 1, next: polls, lost: 0, observations: [] }));
    }) as unknown as typeof fetch;
    const s = new BleService(new LabBus());
    const started = s.start('DOGD');
    await new Promise((r) => setTimeout(r, 5));
    await s.stop();
    release(null);
    await started;
    const before = polls;
    await new Promise((r) => setTimeout(r, 900));
    expect(s.state).toBe('STOPPED');
    expect(polls).toBe(before);
    // the late "scanning" answer is followed by one more stop
    expect(bodies.filter((b) => !b.includes('start')).length).toBe(2);
  });

  it('dogd discovery ended by the system (adapter off): the scan says so instead of showing SCANNING', async () => {
    let off = false;
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/v1/ble/scan')) return new Response(JSON.stringify({ supported: true, state: 'scanning', adapter: 'hci0', detail: '' }));
      if (u.endsWith('/v1/ble/status')) return new Response(JSON.stringify({ supported: true, state: off ? 'error' : 'scanning', adapter: 'hci0', detail: off ? 'adapter hci0 was powered off: discovery ended' : '' }));
      return new Response(JSON.stringify({ now_mono_ms: 1, next: 1, lost: 0, observations: [] }));
    }) as unknown as typeof fetch;
    const s = new BleService(new LabBus());
    await s.start('DOGD');
    off = true;
    await new Promise((r) => setTimeout(r, 2600));
    expect(s.state).toBe('ERROR');
    expect(s.error?.message).toContain('powered off');
  });

  it('a cancelled device chooser keeps the device already in use', async () => {
    let n = 0;
    const device = () => Object.assign(new EventTarget(), { id: `dev${++n}`, gatt: { connected: false, connect: async () => { throw new Error('no'); }, disconnect: () => {}, getPrimaryServices: async () => [] } });
    let cancel = false;
    vi.stubGlobal('navigator', { bluetooth: Object.assign(new EventTarget(), { requestDevice: async () => { if (cancel) throw new DOMException('cancelled', 'NotFoundError'); return device(); } }) });
    const s = new BleService(new LabBus());
    const first = await s.pickGatt([]);
    cancel = true;
    await expect(s.pickGatt([])).rejects.toThrow();
    expect(s.gatt).toBe(first);
  });

  it('a session closed while connecting lets the link go when it arrives', async () => {
    let resolve: (v: unknown) => void = () => {};
    const calls: string[] = [];
    const server = { connected: true, connect: async () => server, disconnect: () => calls.push('server.disconnect'), getPrimaryServices: async () => [] };
    const gatt = { connected: false, connect: () => new Promise((r) => (resolve = r)).then(() => server), disconnect: () => calls.push('gatt.disconnect'), getPrimaryServices: async () => [] };
    vi.stubGlobal('navigator', { bluetooth: Object.assign(new EventTarget(), { requestDevice: async () => Object.assign(new EventTarget(), { id: 'd', gatt }) }) });
    const s = new BleService(new LabBus());
    const g = await s.pickGatt([]);
    const connecting = g.connect();
    s.closeGatt();
    resolve(null);
    await connecting;
    expect(calls).toContain('gatt.disconnect');
    expect(calls).toContain('server.disconnect');
    expect(g.state).toBe('DISCONNECTED');
  });
});
