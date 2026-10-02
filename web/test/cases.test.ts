import { describe, expect, it } from 'vitest';
import { BUILD } from '../src/core/ascii';
import { caseFrom, checkCase, parseCase, replayRecording } from '../src/core/cases';
import { SCENARIOS, type ScenarioId } from '../src/core/scenarios';
import { SessionRecorder, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { sha256 } from '../src/core/sha256';
import { SimulatedDevice } from '../src/core/simulator';
import { System, memoryStore } from '../src/core/system';
import { thresholdsOf } from '../src/core/types';
import { DIAGNOSIS_IDS } from '../src/core/diagnostics';

/**
 * cases/*.hdlog + cases/*.case.json: recorded incidents kept as regression
 * tests. Each recording must be the exact file its case names (SHA-256),
 * intact, and must replay to the facts and diagnosis the case states.
 *
 * The three seed cases come from the simulator. Regenerate them with:
 *   npm run cases
 */

const SEEDS: { id: string; scenario: ScenarioId; seed: number; seconds: number }[] = [
  { id: 'HD-C001', scenario: 'HD-T000', seed: 1, seconds: 30 },
  { id: 'HD-C002', scenario: 'HD-T001', seed: 1, seconds: 30 },
  { id: 'HD-C003', scenario: 'HD-T005', seed: 1, seconds: 30 },
  // LVL 45 gate: one case per diagnosis.
  { id: 'HD-C004', scenario: 'HD-T002', seed: 1, seconds: 30 },
  { id: 'HD-C005', scenario: 'HD-T003', seed: 1, seconds: 30 },
  { id: 'HD-C006', scenario: 'HD-T004', seed: 1, seconds: 30 },
  { id: 'HD-C007', scenario: 'HD-T006', seed: 1, seconds: 30 },
  { id: 'HD-C008', scenario: 'HD-T007', seed: 1, seconds: 30 },
  { id: 'HD-C009', scenario: 'HD-T008', seed: 1, seconds: 30 },
  { id: 'HD-C010', scenario: 'HD-T009', seed: 1, seconds: 30 },
  { id: 'HD-C011', scenario: 'HD-T010', seed: 1, seconds: 30 },
  { id: 'HD-C012', scenario: 'HD-T011', seed: 1, seconds: 30 },
  { id: 'HD-C013', scenario: 'HD-T012', seed: 1, seconds: 30 },
  { id: 'HD-C014', scenario: 'HD-T013', seed: 1, seconds: 40 },
];

/** 2026-09-30 14:21:00 UTC, the date in the design spec. */
const STARTED_AT = Date.UTC(2026, 8, 30, 14, 21, 0);

const hdlogs = import.meta.glob('../../cases/*.hdlog', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const cases = import.meta.glob('../../cases/*.case.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const UPDATE = env['UPDATE_CASES'] === '1';

async function recordSeed(s: (typeof SEEDS)[number]): Promise<string> {
  let now = STARTED_AT;
  const sys = new System(memoryStore(), () => now);
  const sim = new SimulatedDevice({ seed: s.seed, manual: true, scenario: s.scenario });
  sys.recorder = new SessionRecorder(
    newHeader({
      // Stable across regenerations: derived from what the seed case is.
      recording: sha256(`${s.id}/${s.scenario}/${s.seed}`).slice(0, 32),
      id: 'HD-20260930-1421',
      startedAt: STARTED_AT,
      source: 'SIMULATOR',
      endpoint: sim.label,
      scenario: s.scenario,
      app: BUILD,
      thresholds: thresholdsOf(sys.settings),
    }),
  );
  await sys.boot(sim, () => {}, 0);
  for (let k = 0; k < s.seconds * 10; k++) {
    sim.advance(100);
    now = STARTED_AT + sim.uptime;
  }
  return toHdlog(sys.recorder.recording);
}

describe('cases', () => {
  it.runIf(UPDATE)('writes the seed cases that do not exist yet', async () => {
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { writeFileSync(path: URL, data: string): void; existsSync(path: URL): boolean };
    for (const s of SEEDS) {
      // A recording is evidence: once written, never rewritten (PROTOCOL.md, compatibility).
      if (fs.existsSync(new URL(`../../cases/${s.id}.hdlog`, import.meta.url))) continue;
      const text = await recordSeed(s);
      const recording = parseHdlog(text);
      const sys = await replayRecording(recording);
      const c = caseFrom(sys, recording, {
        id: s.id,
        title: `${SCENARIOS[s.scenario].title} (simulator ${s.scenario})`,
        file: `${s.id}.hdlog`,
        context: { description: SCENARIOS[s.scenario].fault, hardware: `None: built-in simulator, scenario ${s.scenario}, seed ${s.seed}, ${s.seconds} s. Origin SIMULATED.` },
      });
      fs.writeFileSync(new URL(`../../cases/${s.id}.hdlog`, import.meta.url), text);
      fs.writeFileSync(new URL(`../../cases/${s.id}.case.json`, import.meta.url), JSON.stringify(c, null, 2) + '\n');
    }
  });

  it.skipIf(UPDATE)('every diagnosis has a case (LVL 45 gate)', () => {
    const covered = new Set(Object.values(cases).flatMap((json) => parseCase(json).expect.diagnoses.map((d) => d.id)));
    expect(DIAGNOSIS_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });

  it.skipIf(UPDATE)('every case has its recording, and every recording its case', () => {
    const base = (f: string) => f.split('/').pop()!.replace(/\.case\.json$|\.hdlog$/, '');
    expect(Object.keys(cases).map(base).sort()).toEqual(Object.keys(hdlogs).map(base).sort());
    expect(Object.keys(cases).length).toBeGreaterThanOrEqual(SEEDS.length);
  });

  for (const [path, json] of Object.entries(cases)) {
    it.skipIf(UPDATE)(`${path.split('/').pop()} still replays to what it expects`, async () => {
      const c = parseCase(json);
      const text = hdlogs[path.replace(/[^/]+$/, c.recording.file)];
      expect(text, `missing ${c.recording.file}`).toBeDefined();
      expect(await checkCase(c, text!)).toEqual([]);
    });
  }

  it('a seed case answers its scenario key, at the highest confidence its rule allows', async () => {
    for (const s of SEEDS) {
      const recording = parseHdlog(await recordSeed(s));
      const sys = await replayRecording(recording);
      expect(sys.diagnoses.map((d) => d.id), s.id).toEqual(SCENARIOS[s.scenario].expect);
      // SUPPLY SAG stops at MEDIUM by design (docs/DIAGNOSTICS.md).
      for (const d of sys.diagnoses) expect(d.confidence, s.id).toBe(d.id === 'SUPPLY_SAG' ? 'MEDIUM' : 'HIGH');
    }
  });

  it('fails, and says why, when the file or the expectation does not hold', async () => {
    const text = await recordSeed(SEEDS[1]!);
    const recording = parseHdlog(text);
    const c = caseFrom(await replayRecording(recording), recording, { id: 'HD-CTEST', title: 't', file: 'x.hdlog' });
    expect(await checkCase(c, text)).toEqual([]);

    const tampered = text.replace(/"v":5\.0/, '"v":5.1');
    const problems = await checkCase(c, tampered);
    expect(problems.join(' ')).toMatch(/sha256/);
    expect(problems.join(' ')).toMatch(/integrity is MODIFIED/);

    const wrong = { ...c, expect: { ...c.expect, facts: { ...c.expect.facts, undervoltage: 99 } } };
    expect((await checkCase(wrong, text)).join(' ')).toMatch(/fact undervoltage: expected 99/);
  });

  it('refuses to build a case from a file that is not intact', async () => {
    const text = (await recordSeed(SEEDS[0]!)).replace(/"v":5\.0/, '"v":5.1');
    const recording = parseHdlog(text);
    expect(() => caseFrom({} as System, recording, { id: 'x', title: 'x', file: 'x' })).toThrow(/MODIFIED/);
  });
});
