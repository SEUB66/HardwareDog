import { describe, expect, it } from 'vitest';
import { Companion, TIMING } from '../src/core/lab/companion';
import { LabBus, type LabEventInput } from '../src/core/lab/events';
import { DEDUP_MS, MIN_SHOW_MS, MessageQueue } from '../src/core/lab/messages';
import { CommandRegistry } from '../src/core/lab/registry';
import { FakeTime } from './lab-helpers';

function rig(reduced = false) {
  const time = new FakeTime();
  const bus = new LabBus(time);
  const c = new Companion(bus, { scheduler: time, mono: () => time.t, reducedMotion: () => reduced });
  const emit = (e: Partial<LabEventInput>) => bus.emit({ source: 'FLIPPER', tool: 'flipper', type: 'info', severity: 'INFO', message: '', origin: 'SIMULATED', ...e });
  return { time, bus, c, emit };
}

describe('companion: TV power', () => {
  it('boots in about two seconds, greets, then idles', () => {
    const { time, c } = rig();
    expect(c.power).toBe('OFF');
    expect(c.anim).toBe('none');
    c.pressPower();
    expect(c.power).toBe('BOOTING');
    time.advance(TIMING.boot - 1);
    expect(c.power).toBe('BOOTING');
    time.advance(1);
    expect(c.power).toBe('ON');
    expect(c.anim).toBe('greet');
    time.advance(TIMING.greet);
    expect(c.anim).toBe('wait'); // nothing connected: it dozes
  });

  it('clicks during a transition: the sequence finishes, the last click decides', () => {
    const { time, c } = rig();
    c.pressPower();
    time.advance(500);
    c.pressPower(); // off, please
    expect(c.power).toBe('BOOTING');
    time.advance(TIMING.boot - 500);
    expect(c.power).toBe('SHUTTING_DOWN');
    time.advance(TIMING.off);
    expect(c.power).toBe('OFF');

    c.pressPower();
    c.pressPower();
    c.pressPower(); // on, off, on: ends on
    time.advance(TIMING.boot + TIMING.off + TIMING.boot);
    expect(c.power).toBe('ON');
  });

  it('reduced motion: a short fade instead of the sequence', () => {
    const { time, c } = rig(true);
    c.pressPower();
    time.advance(TIMING.bootReduced);
    expect(c.power).toBe('ON');
  });

  it('POWER never reaches the hardware state or the operations', () => {
    const { time, c, emit } = rig();
    emit({ type: 'link.state', params: { state: 'CONNECTED' } });
    emit({ type: 'op.start', op: 'r1', params: { kind: 'read' } });
    c.pressPower();
    time.advance(TIMING.boot);
    c.pressPower();
    time.advance(TIMING.off);
    expect(c.hardware).toBe('CONNECTED');
    expect(c.op).toBe('READ');
  });
});

describe('companion: follows real events', () => {
  const on = () => {
    const r = rig();
    r.c.pressPower();
    r.time.advance(TIMING.boot + TIMING.greet);
    return r;
  };

  it('a failed operation stops its working animation at once', () => {
    const { c, emit, time } = on();
    emit({ type: 'op.start', op: 'r1', params: { kind: 'read' } });
    expect(c.anim).toBe('read');
    emit({ type: 'op.end', op: 'r1', severity: 'FAIL', code: 'ERROR_STORAGE_NOT_EXIST', message: 'read /ext/x' });
    expect(c.anim).toBe('error');
    expect(c.message?.code).toBe('ERROR_STORAGE_NOT_EXIST');
    time.advance(TIMING.error);
    expect(c.anim).toBe('wait');
  });

  it('a lost link ends its operations on screen', () => {
    const { c, emit } = on();
    emit({ type: 'link.state', params: { state: 'CONNECTED' } });
    emit({ type: 'op.start', op: 't1', params: { kind: 'transfer' } });
    expect(c.anim).toBe('transfer');
    emit({ type: 'link.state', params: { state: 'DISCONNECTED', reason: 'lost' }, message: 'serial stream ended' });
    expect(c.operations).toHaveLength(0);
    expect(c.anim).toBe('disconnect');
    expect(c.message?.text).toContain('USB');
    expect(c.message?.actions?.map((a) => a.command)).toEqual(['flipper.connect', 'lab.log']);
    emit({ type: 'link.state', params: { state: 'CONNECTED' }, message: 'back' });
    expect(c.message?.key ?? '').not.toContain('link.lost');
  });

  it('success shows briefly, only when nothing else runs', () => {
    const { c, emit, time } = on();
    emit({ type: 'op.start', op: 'a', params: { kind: 'read' } });
    emit({ type: 'op.start', op: 'b', params: { kind: 'search' } });
    emit({ type: 'op.end', op: 'a', severity: 'PASS' });
    expect(c.anim).toBe('search');
    emit({ type: 'op.end', op: 'b', severity: 'PASS' });
    expect(c.anim).toBe('success');
    time.advance(TIMING.success);
    expect(c.anim).toBe('wait');
    emit({ type: 'link.state', params: { state: 'CONNECTED' } });
    expect(c.anim).toBe('idle'); // a link up and nothing to do: it keeps busy
  });

  it('progress is never invented: indeterminate stays indeterminate', () => {
    const { c, emit } = on();
    emit({ type: 'op.start', op: 'l', params: { kind: 'search' } });
    emit({ type: 'op.progress', op: 'l', progress: { done: 12, total: null, unit: 'entries' } });
    expect(c.operations[0]!.progress).toEqual({ done: 12, total: null, unit: 'entries' });
  });

  it('a burst of observations refreshes the EVENT view a few times, not each time', () => {
    const { c, emit, time } = on();
    const before = c.revision;
    for (let i = 0; i < 500; i++) emit({ source: 'BLE', type: 'observe', message: `adv ${i}` });
    time.advance(TIMING.eventThrottle);
    expect(c.revision - before).toBeLessThan(5);
    expect(c.lastEvent?.message).toBe('adv 499');
  });

  it('says what the animation is about: the tool and the kind of file', () => {
    const { c, emit } = on();
    emit({ type: 'op.start', op: 'r', tool: 'flipper.files', params: { kind: 'read', topic: 'ir' } });
    expect(c.subject).toEqual({ tool: 'flipper.files', topic: 'ir' });
    emit({ type: 'op.end', op: 'r', tool: 'flipper.files', severity: 'PASS' });
    expect(c.anim).toBe('success');
    expect(c.subject).toEqual({ tool: 'flipper.files', topic: 'ir' }); // the result is about what just ended
    emit({ source: 'BLE', type: 'op.start', op: 's', tool: 'ble.scan', params: { kind: 'search' } });
    expect(c.subject).toEqual({ tool: 'ble.scan', topic: null });
  });

  it('the dial changes the view, nothing else', () => {
    const { c } = on();
    c.turnDial();
    expect(c.dial).toBe('TOOL');
    c.turnDial();
    c.turnDial();
    expect(c.dial).toBe('COMPANION');
    c.turnDial(-1);
    expect(c.dial).toBe('EVENT');
  });
});

describe('companion messages', () => {
  it('deduplicates, prioritizes, rate-limits', () => {
    const time = new FakeTime();
    let changes = 0;
    const q = new MessageQueue(time, () => changes++);
    q.push({ key: 'a', severity: 'INFO', text: 'tip' }, 0);
    q.push({ key: 'a', severity: 'INFO', text: 'tip' }, 100);
    expect(q.current?.count).toBe(2);
    q.push({ key: 'b', severity: 'INFO', text: 'tip 2' }, 200);
    expect(q.current?.key).toBe('a');
    time.advance(MIN_SHOW_MS);
    expect(q.current?.key).toBe('b');
    q.push({ key: 'err', severity: 'FAIL', text: 'boom', code: 'ERROR_BUSY' }, 3000);
    expect(q.current?.key).toBe('err');
    time.advance(60_000);
    expect(q.current?.key).toBe('err'); // errors stay until read
    q.dismiss();
    expect(q.current).toBeNull();
    // the same key long after the window is a new message
    q.push({ key: 'a', severity: 'INFO', text: 'tip' }, 3000 + DEDUP_MS * 10);
    expect(q.current?.count).toBe(1);
    expect(q.history.length).toBe(4);
  });
});

describe('command registry', () => {
  it('never runs the same command twice at once', async () => {
    const r = new CommandRegistry();
    let runs = 0;
    let release!: () => void;
    r.register('flipper.connect', () => new Promise<void>((res) => {
      runs++;
      release = res;
    }));
    const first = r.run('flipper.connect');
    expect(await r.run('flipper.connect')).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    expect(await r.run('nope')).toBe(false);
  });
});
