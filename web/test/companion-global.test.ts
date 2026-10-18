import { describe, expect, it } from 'vitest';
import { Companion, TIMING } from '../src/core/lab/companion';
import { DeviceBridge, deviceLink } from '../src/core/lab/device';
import { LabBus, type LabEventInput } from '../src/core/lab/events';
import { CommandRegistry } from '../src/core/lab/registry';
import { suggest } from '../src/core/lab/rules';
import { FakeTime } from './lab-helpers';

/** The app's companion: the dog, following the session (DEVICE), switched on. */
function rig() {
  const time = new FakeTime();
  const bus = new LabBus(time);
  const c = new Companion(bus, { scheduler: time, mono: () => time.t, watch: 'DEVICE', profile: 'hwdog', lang: 'fr' });
  c.setFocus({ section: 'STATUS' });
  c.pressPower();
  time.advance(TIMING.boot + TIMING.greet);
  const emit = (e: Partial<LabEventInput>) => bus.emit({ source: 'DEVICE', tool: 'device', type: 'info', severity: 'INFO', message: '', origin: 'PHYSICAL', ...e });
  return { time, bus, c, emit };
}

describe('one companion, two profiles', () => {
  it('a section change switches the profile and the focus: no reconnection, no lost operation, no new boot', () => {
    const { c, emit, time } = rig();
    emit({ source: 'BLE', tool: 'ble.scan', type: 'op.start', op: 's1', params: { kind: 'search' } });
    emit({ source: 'FLIPPER', type: 'link.state', params: { state: 'CONNECTED' } });
    const power = c.power;
    c.setFocus({ section: 'FLIPPER', source: 'FLIPPER', profile: 'flipper' });
    expect(c.profile).toBe('flipper');
    expect(c.hardware).toBe('CONNECTED'); // the Flipper's own link, kept while the dog was shown
    expect(c.power).toBe(power);
    expect(c.transition).toBeNull();
    expect(c.operations.map((o) => o.id)).toEqual(['s1']); // the BLE scan still runs
    c.setFocus({ section: 'BLE', source: 'BLE', profile: 'hwdog' });
    expect(c.profile).toBe('hwdog');
    time.advance(TIMING.minScene);
    expect(c.anim).toBe('search');
    expect(c.subject?.tool).toBe('ble.scan');
  });

  it('opening a section is a decor, not an activity: no scan pretended', () => {
    const { c, time } = rig();
    c.setFocus({ section: 'BLE', source: 'BLE' });
    time.advance(TIMING.minScene);
    expect(c.anim).toBe('wait');
    expect(c.stage).toEqual({ section: 'BLE', calm: true, code: null });
  });

  it('POWER during a scan switches the TV only', () => {
    const { c, emit, time } = rig();
    emit({ source: 'BLE', tool: 'ble.scan', type: 'op.start', op: 's', params: { kind: 'search' } });
    c.pressPower();
    time.advance(TIMING.off);
    expect(c.power).toBe('OFF');
    expect(c.anim).toBe('none');
    expect(c.operations).toHaveLength(1);
    c.pressPower();
    time.advance(TIMING.boot);
    expect(c.op).toBe('SEARCH');
  });
});

describe('the tool looked at comes first', () => {
  it('a failure elsewhere is said with a way to its tool, without taking the screen', () => {
    const { c, emit, time } = rig();
    c.setFocus({ section: 'BLE', source: 'BLE' });
    emit({ source: 'BLE', tool: 'ble.scan', type: 'op.start', op: 's', params: { kind: 'search' } });
    emit({ source: 'FLIPPER', tool: 'flipper.files', type: 'op.start', op: 'f', params: { kind: 'read' } });
    expect(c.operations[0]!.id).toBe('s'); // the focused tool first, though a read outranks a search
    emit({ source: 'FLIPPER', tool: 'flipper.files', type: 'op.end', op: 'f', severity: 'FAIL', code: 'ERROR_BUSY', message: 'read' });
    time.advance(TIMING.minScene);
    expect(c.anim).toBe('search');
    expect(c.message?.code).toBe('ERROR_BUSY');
    expect(c.message?.actions?.at(-1)).toEqual({ label: 'Ouvrir l’outil', command: 'lab.open', args: { source: 'FLIPPER' } });
  });

  it('the scene never flickers: it stays at least minScene', () => {
    const { c, emit, time } = rig();
    expect(c.scene).toBe('wait');
    time.advance(TIMING.minScene);
    emit({ type: 'op.start', op: 'a', tool: 'device.usb', params: { kind: 'read' } });
    expect(c.anim).toBe('read');
    // the wait scene has had its time: the read shows now
    expect(c.scene).toBe('read');
    emit({ type: 'op.end', op: 'a', severity: 'PASS', params: { outcome: 'stopped' } });
    emit({ type: 'op.start', op: 'b', tool: 'device.usb', params: { kind: 'read' } });
    emit({ type: 'op.end', op: 'b', severity: 'PASS', params: { outcome: 'stopped' } });
    expect(c.scene).toBe('read'); // a burst inside the window changes nothing on screen
    time.advance(TIMING.minScene);
    expect(c.scene).toBe('wait');
  });
});

describe('operations: waiting, cancelled, unavailable, late answers', () => {
  it('waiting for the person (a chooser): the permission scene, said once, then the operation goes on', () => {
    const { c, bus, time } = rig();
    const dev = new DeviceBridge(bus);
    const op = dev.begin('device.connect', 'connect', 'choosing a USB port', 'PHYSICAL', true);
    time.advance(TIMING.minScene);
    expect(c.anim).toBe('permission');
    expect(c.message?.text).toBe('Permission nécessaire pour continuer.');
    dev.resume(op, 'device.connect', 'port chosen', 'PHYSICAL');
    expect(c.anim).toBe('connect');
  });

  it('a chooser closed is a cancel, never an error; a STOP is not a success', () => {
    const { c, bus, time } = rig();
    const dev = new DeviceBridge(bus);
    const op = dev.begin('device.connect', 'connect', 'choosing a USB port', 'PHYSICAL', true);
    dev.failed(op, 'device.connect', Object.assign(new Error('No port selected by the user.'), { name: 'NotFoundError' }), 'PHYSICAL');
    expect(c.op).toBe('CANCELLED');
    expect(c.anim).toBe('cancel');
    expect(c.message?.severity).toBe('INFO');
    time.advance(TIMING.cancel);
    expect(c.anim).toBe('wait');
    // a scan stopped on request goes back to rest without a success
    c.setFocus({ section: 'BLE', source: 'BLE' });
    bus.emit({ source: 'BLE', tool: 'ble.scan', type: 'op.start', op: 'x', severity: 'INFO', message: 'scan', origin: 'PHYSICAL', params: { kind: 'search' } });
    bus.emit({ source: 'BLE', tool: 'ble.scan', type: 'op.end', op: 'x', severity: 'PASS', message: 'stopped', origin: 'PHYSICAL', params: { outcome: 'stopped' } });
    expect(c.op).toBe('IDLE');
    expect(c.anim).toBe('wait');
  });

  it('a function this browser lacks is said as a limitation, with no activity', () => {
    const { c, emit, time } = rig();
    emit({ type: 'op.start', op: 'w', tool: 'device.connect', params: { kind: 'connect' } });
    emit({ type: 'op.end', op: 'w', tool: 'device.connect', severity: 'FAIL', code: 'SERIAL_UNSUPPORTED', message: 'no Web Serial' });
    expect(c.anim).toBe('unavailable');
    time.advance(TIMING.unavailable);
    expect(c.anim).toBe('wait');
    c.setFocus({ section: 'SERIAL', unavailable: 'NO WEB SERIAL' });
    time.advance(TIMING.minScene);
    expect(c.anim).toBe('unavailable');
  });

  it('a late answer of a replaced operation, or an end said twice, changes nothing on screen', () => {
    const { c, emit } = rig();
    emit({ type: 'op.start', op: 'old', tool: 'device.usb', params: { kind: 'read' } });
    emit({ type: 'op.start', op: 'new', tool: 'device.usb', params: { kind: 'read' } });
    emit({ type: 'op.end', op: 'old', tool: 'device.usb', severity: 'FAIL', code: 'TIMEOUT', message: 'late' });
    expect(c.op).toBe('READ');
    expect(c.message).toBeNull();
    emit({ type: 'op.end', op: 'new', tool: 'device.usb', severity: 'PASS', message: 'read' });
    expect(c.op).toBe('SUCCESS');
    emit({ type: 'op.end', op: 'new', tool: 'device.usb', severity: 'FAIL', code: 'TIMEOUT', message: 'again' });
    expect(c.op).toBe('SUCCESS');
    expect(c.message).toBeNull();
  });

  it('the code of the error on screen reaches the scene: no answer is not drawn like a refusal', () => {
    const { c, emit } = rig();
    emit({ type: 'op.start', op: 't', tool: 'device.dogd', params: { kind: 'connect' } });
    emit({ type: 'op.end', op: 't', tool: 'device.dogd', severity: 'FAIL', code: 'DOGD_UNREACHABLE', message: 'refused' });
    expect(c.anim).toBe('error');
    expect(c.stage.code).toBe('DOGD_UNREACHABLE');
  });

  it('a success plays once, then the scene at rest; no timer decides a success', () => {
    const { c, emit, time } = rig();
    emit({ type: 'op.start', op: 'r', tool: 'lab.report', params: { kind: 'write' } });
    time.advance(60_000);
    expect(c.op).toBe('TRANSFER'); // still running: time alone never makes it a success
    emit({ type: 'op.end', op: 'r', tool: 'lab.report', severity: 'PASS', message: 'report' });
    expect(c.anim).toBe('success');
    expect(c.message?.text).toBe('Export terminé.');
    time.advance(TIMING.success);
    expect(c.anim).toBe('wait');
  });
});

describe('demo and replay', () => {
  it('DEMO and REPLAY are said; a replayed event offers nothing that reaches a device', () => {
    const { c, emit } = rig();
    emit({ type: 'link.state', params: { state: 'CONNECTED' }, origin: 'SIMULATED' });
    expect(c.badge).toBe('DEMO');
    emit({ type: 'link.state', params: { state: 'DISCONNECTED', reason: 'lost' }, origin: 'REPLAY' });
    expect(c.badge).toBe('REPLAY');
    expect(c.message?.actions?.every((a) => a.command === 'lab.log')).toBe(true);
    emit({ type: 'op.start', op: 'f', tool: 'device.connect', params: { kind: 'connect' }, origin: 'REPLAY' });
    emit({ type: 'op.end', op: 'f', tool: 'device.connect', severity: 'FAIL', code: 'TIMEOUT', message: 'x', origin: 'REPLAY' });
    expect(c.message?.actions?.map((a) => a.command)).toEqual(['lab.log']);
  });
});

describe('the session on the bus', () => {
  it('says its link once per change, with the exact words', () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const dev = new DeviceBridge(bus);
    expect(deviceLink(false, 'ONLINE')).toBe('ABSENT');
    expect(deviceLink(true, 'ONLINE')).toBe('CONNECTED');
    expect(deviceLink(true, 'LOST')).toBe('DISCONNECTED');
    expect(deviceLink(true, 'WAITING')).toBe('CONNECTING');
    dev.link('CONNECTED', 'D1', 'PHYSICAL');
    dev.link('CONNECTED', 'D1', 'PHYSICAL');
    dev.link('DISCONNECTED', 'D1', 'PHYSICAL');
    const links = bus.recent((e) => e.type === 'link.state');
    expect(links.map((e) => e.params?.['state'])).toEqual(['CONNECTED', 'DISCONNECTED']);
    expect(suggest(links[0]!, 'fr')?.text).toBe('Appareil connecté.');
    expect(links[1]!.params?.['reason']).toBe('lost');
  });

  it('a watch is one operation from on to off, its end a stop, not a success', () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const dev = new DeviceBridge(bus);
    dev.watch('net.watch', true, 'search', 'network checks', 'PHYSICAL');
    dev.watch('net.watch', true, 'search', 'network checks', 'PHYSICAL');
    dev.watch('net.watch', false, 'search', 'network checks', 'PHYSICAL');
    const ops = bus.recent((e) => e.type.startsWith('op.'));
    expect(ops.map((e) => e.type)).toEqual(['op.start', 'op.end']);
    expect(ops[1]!.params?.['outcome']).toBe('stopped');
    expect(ops[0]!.op).toBe(ops[1]!.op);
  });
});

describe('actions from the TV', () => {
  it('RETRY runs once however often it is clicked, and its precondition is checked at the click', async () => {
    const r = new CommandRegistry();
    let ready = true;
    let runs = 0;
    let release!: () => void;
    r.register(
      'device.connect',
      () =>
        new Promise<void>((res) => {
          runs++;
          release = res;
        }),
      () => (ready ? null : 'this browser has no Web Serial'),
    );
    const first = r.run('device.connect');
    expect(await r.run('device.connect')).toBe(false);
    expect(r.blocked('device.connect')).toBe('already running');
    release();
    await first;
    ready = false;
    expect(r.blocked('device.connect')).toBe('this browser has no Web Serial');
    expect(await r.run('device.connect')).toBe(false);
    expect(runs).toBe(1);
    expect(r.blocked('nothing')).toBe('not available here');
  });

  it('a retry is offered only where the operation allows one; no automatic retry', () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const e = (x: Partial<LabEventInput>) => bus.emit({ source: 'DEVICE', tool: 'device.dogd', type: 'op.end', op: 'o', severity: 'FAIL', message: 'refused', origin: 'PHYSICAL', ...x });
    expect(suggest(e({ code: 'DOGD_UNREACHABLE' }), 'en')?.actions?.map((a) => a.command)).toEqual(['device.dogd', 'lab.log']);
    // a file that cannot be read is not retried: details only
    expect(suggest(e({ source: 'FLIPPER', code: 'FORMAT_INVALID' }), 'en')?.actions?.map((a) => a.command)).toEqual(['lab.log']);
    // a stop is not said as a failure
    expect(suggest(e({ severity: 'PASS', params: { outcome: 'stopped' } }), 'en')).toBeNull();
  });

  it('a Bluetooth adapter pulled out during a scan is said as such, its code kept', () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const ev = bus.emit({
      source: 'BLE',
      tool: 'ble.scan',
      type: 'op.end',
      op: 's',
      severity: 'FAIL',
      message: 'dogd: no_adapter',
      code: 'BLE_NO_ADAPTER',
      origin: 'PHYSICAL',
      params: { phase: 'running' },
    });
    const s = suggest(ev, 'fr');
    expect(s?.text).toBe('Adaptateur Bluetooth déconnecté.');
    expect(s?.code).toBe('BLE_NO_ADAPTER');
  });
});
