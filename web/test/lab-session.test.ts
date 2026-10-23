import { describe, expect, it } from 'vitest';
import { LabBus, type LabEventInput } from '../src/core/lab/events';
import { HDLAB_LIMITS, LabRecorder, compare, labReport, near, parseHdlab, splitAt, toHdlab } from '../src/core/lab/session';
import { FakeTime } from './lab-helpers';
import { LabSessions, type StoredLabSession } from '../src/core/lab/manager';
import { MemoryKv } from '../src/core/lab/store';
import { sha256 } from '../src/core/sha256';

/** The seal of an .hdlab body, written out: every line with its LF. */
const sealOf = (lines: string[]) => sha256(lines.map((l) => l + '\n').join(''));

const base: LabEventInput = { source: 'BLE', tool: 'ble.scan', type: 'observe', severity: 'INFO', message: 'adv', origin: 'SIMULATED' };

function session() {
  const time = new FakeTime();
  const bus = new LabBus(time);
  const rec = new LabRecorder(bus, 'bench', 'test');
  bus.emit({ ...base, device: 'A', raw: 'AAE=', measures: [{ name: 'rssi', value: -60, unit: 'dBm', provenance: 'MEASURED' }] });
  time.advance(500);
  const marker = bus.emit({ source: 'USER', tool: 'lab', type: 'marker', severity: 'INFO', message: 'button pressed', origin: 'PHYSICAL' });
  time.advance(500);
  bus.emit({ ...base, device: 'A', raw: 'AAI=', measures: [{ name: 'rssi', value: -50, unit: 'dBm', provenance: 'MEASURED' }] });
  bus.emit({ ...base, device: 'B', measures: [{ name: 'rssi', value: -80, unit: 'dBm', provenance: 'MEASURED' }] });
  bus.emit({ source: 'FLIPPER', tool: 'flipper.files', type: 'op.end', op: 'x', severity: 'FAIL', code: 'ERROR_STORAGE_NOT_EXIST', message: 'read /ext/x', origin: 'SIMULATED' });
  time.advance(10_000);
  return { time, bus, rec, marker };
}

describe('lab sessions (.hdlab)', () => {
  it('round-trips byte for byte and verifies its seal', () => {
    const { rec } = session();
    const data = rec.stop();
    const text = toHdlab(data);
    const back = parseHdlab(text);
    expect(back.integrity).toBe('VERIFIED');
    expect(back.events).toEqual(data.events);
    expect(toHdlab(back)).toBe(text);
  });

  it('says MODIFIED when one byte changed, UNSEALED with no footer', () => {
    const { rec } = session();
    const text = toHdlab(rec.stop());
    expect(parseHdlab(text.replace('button pressed', 'button pushed')).integrity).toBe('MODIFIED');
    const lines = text.trimEnd().split('\n');
    expect(parseHdlab(lines.slice(0, -1).join('\n') + '\n').integrity).toBe('UNSEALED');
  });

  it('seals its footer too: losses and end time cannot be edited unseen', () => {
    const { rec } = session();
    const text = toHdlab(rec.stop());
    expect(text.split('\n')[0]).toContain('"footerSealed":true');
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/,"self":"[0-9a-f]{64}"\}$/);
    expect(parseHdlab(text.replace('"lost":0', '"lost":7')).integrity).toBe('MODIFIED');
    expect(parseHdlab(text.replace(/"endMono":(\d+)/, (_, t) => `"endMono":${Number(t) + 3_600_000}`)).integrity).toBe('MODIFIED');
    expect(parseHdlab(text.replace(/,"self":"[0-9a-f]{64}"/, '')).integrity).toBe('MODIFIED');
    // a file from before the footer sealed itself: read as it was
    const older = text.replace(',"footerSealed":true', '');
    const lines = older.trimEnd().split('\n');
    const footer = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    delete footer['self'];
    const body = lines.slice(0, -1);
    footer['sha256'] = sealOf(body);
    expect(parseHdlab([...body, JSON.stringify(footer)].join('\n') + '\n').integrity).toBe('VERIFIED');
  });

  it('refuses malformed files with the line that is wrong', () => {
    expect(() => parseHdlab('')).toThrow();
    expect(() => parseHdlab('{"format":"hdlog"}\n')).toThrow('not an .hdlab');
    const { rec } = session();
    const lines = toHdlab(rec.stop()).trimEnd().split('\n');
    lines[2] = '{"seq":"x"}';
    expect(() => parseHdlab(lines.join('\n'))).toThrow('line 3');
    lines[2] = 'not json';
    expect(() => parseHdlab(lines.join('\n'))).toThrow('line 3: not JSON');
  });

  it('counts what it could not keep, and says it', () => {
    const time = new FakeTime();
    const bus = new LabBus(time, 10);
    const rec = new LabRecorder(bus, '', 'test');
    for (let i = 0; i < HDLAB_LIMITS.maxEvents + 7; i++) bus.emit(base);
    const data = rec.stop();
    expect(data.events).toHaveLength(HDLAB_LIMITS.maxEvents);
    expect(data.footer?.lost).toBe(7);
    expect(bus.dropped).toBe(HDLAB_LIMITS.maxEvents + 7 - 10);
  });

  it('compares before / after a marker, without inventing causes', () => {
    const { rec, marker } = session();
    const data = rec.stop();
    const [before, after] = splitAt(data.events, marker.seq);
    const c = compare(before, after);
    expect(c.bleOnlyAfter).toEqual(['B']);
    expect(c.bleBoth).toEqual([{ device: 'A', rssiBefore: -60, rssiAfter: -50, payloadChanged: true }]);
    expect(near(data.events, marker, 600).map((e) => e.device)).toEqual(['A', 'A', 'B', undefined]);
    const report = labReport(data);
    expect(report).toContain('not a cause');
    expect(report).toContain('[ERROR_STORAGE_NOT_EXIST]');
    expect(report).toContain('DEMO data');
    expect(report).toContain('not a distance');
  });
});

describe('lab sessions kept safe (audit 2026-10)', () => {
  it('two sessions started in the same second have two ids, in UTC', () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const a = new LabRecorder(bus, '', 'test');
    a.stop();
    const b = new LabRecorder(bus, '', 'test');
    expect(a.header.id).not.toBe(b.header.id);
    expect(a.header.id).toMatch(/^LAB-\d{8}T\d{6}\.\d{3}Z-[0-9a-f]{4}$/);
  });

  it('a refused save keeps the session, open and exportable; the list holds no text', async () => {
    const time = new FakeTime();
    const bus = new LabBus(time);
    const kv = new MemoryKv<StoredLabSession>();
    const s = new LabSessions(bus, kv, 'test');
    s.start('ok');
    bus.emit(base);
    await s.stop();
    expect(s.stored).toHaveLength(1);
    expect('text' in s.stored[0]!).toBe(false);
    const full: typeof kv = Object.assign(Object.create(kv), { put: async () => Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' })) });
    const t = new LabSessions(bus, full, 'test');
    t.start('big');
    bus.emit(base);
    await expect(t.stop()).rejects.toThrow(/EXPORT .HDLAB keeps it/);
    expect(t.unsaved?.error).toMatch(/QuotaExceededError/);
    expect(t.opened?.header.name).toBe('big');
    expect(parseHdlab(t.unsavedText()!).integrity).toBe('VERIFIED');
  });

  it('an event with a mistyped optional field is refused, with its line', () => {
    const { rec } = session();
    const lines = toHdlab(rec.stop()).trimEnd().split('\n');
    const ev = JSON.parse(lines[1]!) as Record<string, unknown>;
    for (const broken of [{ measures: 'x' }, { measures: [{ name: 'rssi', value: 'loud', unit: 'dBm', provenance: 'MEASURED' }] }, { progress: { done: 'a' } }, { device: 42 }, { params: { a: { b: 1 } } }, { decoded: { decoder: 'x' } }]) {
      const text = [lines[0], JSON.stringify({ ...ev, ...broken })].join('\n') + '\n';
      expect(() => parseHdlab(text), JSON.stringify(broken)).toThrow(/line 2/);
    }
  });

  it('the same payloads seen in another order did not change', () => {
    const adv = (raw: string): LabEventInput => ({ ...base, device: 'A', raw });
    const time = new FakeTime();
    const bus = new LabBus(time);
    const events = [adv('AAE='), adv('AAI='), adv('AAI='), adv('AAE=')].map((e) => bus.emit(e));
    expect(compare(events.slice(0, 2), events.slice(2)).bleBoth[0]!.payloadChanged).toBe(false);
  });
});
