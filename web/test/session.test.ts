import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/core/report';
import { SCENARIO_IDS, type ScenarioId } from '../src/core/scenarios';
import { HdlogError, ReplayTransport, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { System, memoryStore } from '../src/core/system';
import { diagnosisKeys, recordSession } from './helpers';

const record = (scenario: ScenarioId, seconds: number, seed = 4) => recordSession(scenario, seconds, { seed });

async function replay(text: string) {
  const r = new ReplayTransport(parseHdlog(text));
  const sys = new System(memoryStore(), () => r.clock);
  await sys.boot(r, () => {}, 0);
  return { sys, r };
}

/** Everything the device said, as the operator sees it. */
const timeline = (sys: System) =>
  sys.trace
    .all()
    .filter((e) => e.source !== 'SYS' && e.source !== 'USER')
    .map((e) => `${e.t} ${e.source} ${e.severity} ${e.message} ${e.value ?? ''}`);

describe('.hdlog recording and replay', () => {
  it('replays to the identical timeline, measurements and diagnosis', async () => {
    const live = await record('HD-T001', 40);
    const text = toHdlog(live.recording);
    const { sys } = await replay(text);
    expect(sys.frameErrors).toBe(0);
    expect(timeline(sys)).toEqual(timeline(live.sys));
    expect(diagnosisKeys(sys)).toEqual(diagnosisKeys(live.sys));
    expect(sys.power.sampleCount).toBe(live.sys.power.sampleCount);
    expect(sys.power.minVoltage).toBe(live.sys.power.minVoltage);
    expect(sys.usb.disconnects).toBe(live.sys.usb.disconnects);
    expect(sys.startedAt).toBe(live.sys.startedAt);
  });

  it('is exact for every fault scenario', async () => {
    for (const id of SCENARIO_IDS) {
      const live = await record(id, 25, 9);
      const { sys } = await replay(toHdlog(live.recording));
      expect(sys.diagnoses.map((d) => d.id), id).toEqual(live.sys.diagnoses.map((d) => d.id));
      expect(timeline(sys).length, id).toBe(timeline(live.sys).length);
    }
  });

  it('keeps rejected lines: the replay rejects the same bytes again', async () => {
    const live = await record('HD-T000', 3);
    live.recording.entries.push(
      { at: live.sys.startedAt + 3100, reject: 'frame rejected: not valid JSON', raw: '{"type":"power",' },
      { at: live.sys.startedAt + 3200, reject: 'frame rejected: unknown frame type "warp"', raw: '{"type":"warp","t":3200}' },
    );
    const { sys } = await replay(toHdlog(live.recording));
    expect(sys.frameErrors).toBe(2);
  });

  it('records commands and operator marks, and replays the marks', async () => {
    const live = await record('HD-T000', 2);
    live.sys.mark('device reboot');
    live.sys.scanI2c();
    const kinds = live.recording.entries.map((e) => Object.keys(e).find((k) => k !== 'at'));
    expect(kinds).toContain('cmd');
    expect(kinds).toContain('mark');
    const { sys } = await replay(toHdlog(live.recording));
    expect(sys.trace.all().some((e) => e.message === 'mark: device reboot')).toBe(true);
  });

  it('is read-only and says so', async () => {
    const live = await record('HD-T000', 2);
    const { sys } = await replay(toHdlog(live.recording));
    expect(sys.link).toBe('OFFLINE');
    expect(sys.scanI2c()).toBe('i2c scan: recorded session, read-only');
    expect(sys.probe('192.168.1.1', ['PING'])).toBe('probe: recorded session, read-only');
  });

  it('keeps the SIMULATED label on a replayed simulator session', async () => {
    const live = await record('HD-T004', 5);
    const { sys } = await replay(toHdlog(live.recording));
    const report = buildReport(sys, sys.startedAt + 6000);
    expect(report.simulated).toBe(true);
    expect(report.source).toContain('REPLAY');
    expect(report.source).toContain('SIMULATOR');
  });

  it('replays on the thresholds it was recorded with, without touching the operator\'s own', async () => {
    // A 5.2 V undervoltage threshold makes a healthy 5 V rail a finding.
    const live = await recordSession('HD-T000', 20, { settings: { undervoltageThreshold: 5.2 } });
    expect(live.sys.diagnoses.length).toBeGreaterThan(0);
    const store = memoryStore();
    const r = new ReplayTransport(parseHdlog(toHdlog(live.recording)));
    const sys = new System(store, () => r.clock);
    await sys.boot(r, () => {}, 0);
    expect(sys.recordedThresholds).toBe(true);
    expect(diagnosisKeys(sys)).toEqual(diagnosisKeys(live.sys));
    expect(store.load()?.undervoltageThreshold).toBe(4.75);
    sys.updateSettings({ sound: true });
    expect(store.load()?.undervoltageThreshold).toBe(4.75);
    expect(sys.settings.undervoltageThreshold).toBe(5.2);
  });

  it('plays in real time when asked, ending on its own', async () => {
    const live = await record('HD-T000', 2);
    const r = new ReplayTransport(parseHdlog(toHdlog(live.recording)), { manual: true });
    const sys = new System(memoryStore(), () => r.clock);
    await sys.connect(r);
    r.advanceTo(live.sys.startedAt + 1000);
    const half = sys.power.sampleCount;
    expect(half).toBeGreaterThan(0);
    expect(r.done).toBe(false);
    r.advanceTo(Infinity);
    expect(sys.power.sampleCount).toBeGreaterThan(half);
    expect(sys.link).toBe('OFFLINE');
  });
});

describe('parseHdlog', () => {
  const header = JSON.stringify(newHeader({ id: 'HD-X', startedAt: 1, source: 'SIMULATOR', endpoint: 'x', scenario: null, app: 'x' }));
  it('rejects broken files with a line number', () => {
    expect(() => parseHdlog('')).toThrow(HdlogError);
    expect(() => parseHdlog('{"hdlog":9}')).toThrow(/line 1/);
    expect(() => parseHdlog(`${header}\n{"at":5,"mark":"a"}\n{"at":4,"mark":"b"}`)).toThrow('line 3: time goes backwards');
    expect(() => parseHdlog(`${header}\n{"at":5,"mark":"a","lost":"b"}`)).toThrow(/exactly one/);
    expect(() => parseHdlog(`${header}\nnot json`)).toThrow('line 2: not JSON');
  });
});
