import { describe, expect, it } from 'vitest';
import { buildReport, reportToText } from '../src/core/report';
import { SCENARIO_IDS, type ScenarioId } from '../src/core/scenarios';
import { RULESET_VERSION } from '../src/core/diagnostics';
import { HDLOG_LIMITS, HdlogError, ReplayTransport, newHeader, parseHdlog, recoverHdlog, toHdlog } from '../src/core/session';
import v1Fixture from './fixtures/hdlog-v1.hdlog?raw';
import { sha256 } from '../src/core/sha256';
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
    // The recording's own id, whatever the time zone of the replaying machine.
    expect(report.session).toBe('HD-TEST');
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

  it('replays a threshold change at the moment it was made', async () => {
    const live = await recordSession('HD-T000', 30, {
      everySecond: (second, sys) => second === 10 && sys.updateSettings({ undervoltageThreshold: 5.2 }),
    });
    expect(live.recording.entries.some((e) => 'thresholds' in e)).toBe(true);
    expect(live.sys.diagnoses.length).toBeGreaterThan(0);
    const { sys } = await replay(toHdlog(live.recording));
    expect(diagnosisKeys(sys)).toEqual(diagnosisKeys(live.sys));
    expect(sys.facts).toEqual(live.sys.facts);
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

describe('.hdlog v2 integrity and provenance', () => {
  const file = async () => toHdlog((await recordSession('HD-T001', 12)).recording);
  const lines = (t: string) => t.split('\n').slice(0, -1);
  const join = (l: string[]) => l.join('\n') + '\n';

  it('is VERIFIED as written, with counts and the device in the footer', async () => {
    const text = await file();
    const r = parseHdlog(text);
    expect(r.integrity!.status).toBe('VERIFIED');
    expect(r.integrity!.fileSha256).toBe(sha256(text));
    const f = r.integrity!.footer!;
    expect(f.closed).toBe('NORMAL');
    expect(f.entries).toBe(r.entries.length);
    expect(f.frames).toBe(r.entries.filter((e) => 'frame' in e).length);
    expect(f.device).toEqual({ id: 'HD-001', rev: 'A', fw: '0.1.0' });
    expect(r.header.origin).toBe('SIMULATED');
    expect(r.header.ruleset).toBe(RULESET_VERSION);
    expect(r.header.recording).toMatch(/^[0-9a-f]{32}$/);
  });

  it('detects one changed byte, and says where', async () => {
    const l = lines(await file());
    const n = l.findIndex((x) => x.includes('"type":"power"'));
    l[n] = l[n]!.replace(/"v":(\d)/, (_, d) => `"v":${(Number(d) + 1) % 10}`);
    const r = parseHdlog(join(l));
    expect(r.integrity!.status).toBe('MODIFIED');
    expect(r.integrity!.problems.join(' ')).toMatch(/seal 1 does not match/);
    // Still readable: the operator sees the data AND the warning.
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it('detects a deleted line, a changed footer, data after the footer and CRLF', async () => {
    const text = await file();
    const l = lines(text);
    expect(parseHdlog(join([l[0]!, ...l.slice(2)])).integrity!.status).toBe('MODIFIED');
    const footer = l.at(-1)!.replace(/"marks":0/, '"marks":3');
    expect(parseHdlog(join([...l.slice(0, -1), footer])).integrity!.problems.join(' ')).toMatch(/marks/);
    expect(parseHdlog(join([...l, '{"at":1,"mark":"late"}'])).integrity!.problems.join(' ')).toMatch(/after the footer/);
    expect(parseHdlog(text.replace(/\n/g, '\r\n')).integrity!.status).toBe('MODIFIED');
  });

  it('cannot be relabeled: origin must match the source', async () => {
    const l = lines(await file());
    l[0] = l[0]!.replace('"origin":"SIMULATED"', '"origin":"PHYSICAL"');
    expect(() => parseHdlog(join(l))).toThrow(/contradicts source/);
  });

  it('a recording that never finished is INCOMPLETE, replayable, and recoverable', async () => {
    const l = lines(await file());
    const lastSeal = l.map((x, n) => (x.startsWith('{"seal"') ? n : -1)).filter((n) => n > 0).at(-1)!;
    const cut = join([...l.slice(0, lastSeal + 1), ...l.slice(1, 4)].map((x, n) => (n > lastSeal ? x.replace(/"at":\d+/, `"at":9${'9'.repeat(12)}`) : x)));
    const r = parseHdlog(cut);
    expect(r.integrity!.status).toBe('INCOMPLETE');
    expect(r.integrity!.unsealed).toBe(3);
    const recovered = recoverHdlog(cut)!;
    const rr = parseHdlog(recovered);
    expect(rr.integrity!.status).toBe('RECOVERED');
    expect(rr.entries).toHaveLength(r.entries.length - 3);
    expect(recovered.startsWith(join(l.slice(0, lastSeal + 1)))).toBe(true);
    expect(recoverHdlog(recovered)).toBeNull();
  });

  it('reads v1 files as UNVERIFIED, origin derived from the source', () => {
    const v1 = [
      '{"hdlog":1,"proto":1,"id":"HD-X","startedAt":1,"source":"WEB SERIAL","endpoint":"x","scenario":null,"app":"0.1.0"}',
      '{"at":2,"mark":"a"}',
      '',
    ].join('\n');
    const r = parseHdlog(v1);
    expect(r.integrity!.status).toBe('UNVERIFIED');
    expect(r.header.origin).toBe('PHYSICAL');
    expect(toHdlog(r)).toBe(v1); // exported again unchanged
  });

  it('freezes the header: provenance cannot be rewritten while recording', async () => {
    const live = await recordSession('HD-T000', 1);
    expect(Object.isFrozen(live.recorder.header)).toBe(true);
  });

  it('the report names the recording, its integrity and its hash', async () => {
    const live = await recordSession('HD-T001', 6);
    const liveText = reportToText(buildReport(live.sys));
    expect(liveText).toContain(`RECORDING             ${live.recorder.header.recording}`);
    expect(liveText).toContain('NOT FINALIZED');

    const text = toHdlog(live.recording);
    const ok = await replay(text);
    const okText = reportToText(buildReport(ok.sys));
    expect(okText).toMatch(/INTEGRITY\s+VERIFIED/);
    expect(okText).toContain(sha256(text));
    expect(okText).toContain('REPLAY OF SIMULATED');

    const tampered = text.replace(/"v":5\.0/, '"v":5.1');
    expect(tampered).not.toBe(text);
    const bad = await replay(tampered);
    const badText = reportToText(buildReport(bad.sys));
    expect(badText).toMatch(/INTEGRITY\s+MODIFIED/);
    expect(badText).toContain('!! MODIFIED RECORDING');
  });

  it('never executes recorded commands', async () => {
    const live = await recordSession('HD-T000', 3);
    live.sys.scanI2c();
    live.sys.probe('192.168.1.1', ['PING']);
    live.sys.sendSerial('AT+RST');
    const recorded = live.recording.entries.filter((e) => 'cmd' in e);
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    const r = new ReplayTransport(parseHdlog(toHdlog(live.recording)));
    const sent: unknown[] = [];
    r.send = (cmd) => void sent.push(cmd);
    const sys = new System(memoryStore(), () => r.clock);
    await sys.boot(r, () => {}, 0);
    expect(sent).toEqual([]);
    expect(sys.trace.all().some((e) => e.source === 'USER' && /requested|probe|tx/.test(e.message))).toBe(false);
  });
});

describe('.hdlog files from anyone', () => {
  const header = JSON.stringify(newHeader({ id: 'HD-X', startedAt: 1, source: 'WEB SERIAL', endpoint: 'x', scenario: null, app: 'x' }));
  const file = (...lines: string[]) => [header, ...lines, ''].join('\n');

  it('refuses hostile content with a reason, before it reaches the engine', () => {
    expect(() => parseHdlog(file(`{"at":2,"mark":"${'x'.repeat(2000)}"}`))).toThrow(/mark must be text/);
    expect(() => parseHdlog(file('{"at":2,"thresholds":{"undervoltageThreshold":-1,"overcurrentThreshold":0.9,"correlationWindowMs":100}}'))).toThrow(
      /out of range/,
    );
    expect(() => parseHdlog(file('{"at":2,"frame":"power"}'))).toThrow(/frame must be an object/);
    expect(() => parseHdlog(file(`{"at":2,"mark":"a","pad":"${'x'.repeat(HDLOG_LIMITS.maxLine)}"}`))).toThrow(/longer than/);
    expect(() => parseHdlog(file('[' .repeat(5000) + ']'.repeat(5000)))).toThrow(HdlogError);
    expect(() => parseHdlog(header.replace('"endpoint":"x"', `"endpoint":"${'x'.repeat(300)}"`))).toThrow(/too long/);
    // Unknown keys are tolerated (newer writers), and cannot pollute prototypes.
    const r = parseHdlog(file('{"at":2,"mark":"a","__proto__":{"polluted":true}}'));
    expect(r.entries).toHaveLength(1);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('says plainly when a file comes from a newer Hardware Dog', () => {
    expect(() => parseHdlog(header.replace('"hdlog":2', '"hdlog":3'))).toThrow(/written by a newer Hardware Dog; this build reads v1 to v2/);
  });

  it('opens a v1 file recorded by an earlier build, and replays it to the same diagnosis', async () => {
    const r = parseHdlog(v1Fixture);
    expect(r.integrity!.status).toBe('UNVERIFIED');
    expect(r.header.origin).toBe('SIMULATED');
    const { sys } = await replay(v1Fixture);
    expect(diagnosisKeys(sys)).toEqual(['POWER_INSTABILITY:HIGH']);
    expect(toHdlog(r)).toBe(v1Fixture); // never rewritten
  });
});
