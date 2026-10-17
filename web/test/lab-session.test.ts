import { describe, expect, it } from 'vitest';
import { LabBus, type LabEventInput } from '../src/core/lab/events';
import { HDLAB_LIMITS, LabRecorder, compare, labReport, near, parseHdlab, splitAt, toHdlab } from '../src/core/lab/session';
import { FakeTime } from './lab-helpers';

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
