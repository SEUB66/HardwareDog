import { describe, expect, it } from 'vitest';
import { BUILD } from '../src/core/ascii';
import { SCENARIOS, isScenarioId, type ScenarioId } from '../src/core/scenarios';
import { ReplayTransport, SessionRecorder, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { SimulatedDevice } from '../src/core/simulator';
import { System, memoryStore } from '../src/core/system';
import { thresholdsOf } from '../src/core/types';

/**
 * examples/sessions/*.hdlog are recorded sessions kept in the repository.
 * Each one must replay, through today's decoder and rules, to the
 * diagnosis its fault scenario expects: a recording is a regression test,
 * and the file format must stay readable.
 *
 * Regenerate with: npm run examples
 */

const EXAMPLES: { scenario: ScenarioId; seed: number; seconds: number }[] = [
  { scenario: 'HD-T000', seed: 1, seconds: 30 },
  { scenario: 'HD-T001', seed: 1, seconds: 30 },
  { scenario: 'HD-T005', seed: 1, seconds: 30 },
];

/** 2026-09-30 14:21:00 UTC, the date in the design spec. */
const STARTED_AT = Date.UTC(2026, 8, 30, 14, 21, 0);

const files = import.meta.glob('../../examples/sessions/*.hdlog', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

async function record(scenario: ScenarioId, seed: number, seconds: number): Promise<string> {
  let now = STARTED_AT;
  const sys = new System(memoryStore(), () => now);
  const sim = new SimulatedDevice({ seed, manual: true, scenario });
  sys.recorder = new SessionRecorder(
    newHeader({
      id: 'HD-20260930-1421',
      startedAt: STARTED_AT,
      source: 'SIMULATOR',
      endpoint: sim.label,
      scenario,
      app: BUILD,
      thresholds: thresholdsOf(sys.settings),
    }),
  );
  await sys.boot(sim, () => {}, 0);
  for (let k = 0; k < seconds * 10; k++) {
    sim.advance(100);
    now = STARTED_AT + sim.uptime;
  }
  return toHdlog(sys.recorder.recording);
}

describe('example sessions', () => {
  it.runIf(env['UPDATE_EXAMPLES'] === '1')('regenerates examples/sessions', async () => {
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { writeFileSync(path: URL, data: string): void };
    for (const e of EXAMPLES) {
      fs.writeFileSync(new URL(`../../examples/sessions/${e.scenario}.hdlog`, import.meta.url), await record(e.scenario, e.seed, e.seconds));
    }
  });

  it.skipIf(env['UPDATE_EXAMPLES'] === '1')('ships one recording per listed example', () => {
    const names = Object.keys(files).map((f) => f.split('/').pop());
    expect(names.sort()).toEqual(EXAMPLES.map((e) => `${e.scenario}.hdlog`).sort());
  });

  for (const [path, text] of Object.entries(files)) {
    it(`${path.split('/').pop()} replays to the diagnosis its scenario expects`, async () => {
      const recording = parseHdlog(text);
      const scenario = recording.header.scenario ?? '';
      expect(recording.header.source).toBe('SIMULATOR');
      expect(isScenarioId(scenario)).toBe(true);
      const r = new ReplayTransport(recording);
      const sys = new System(memoryStore(), () => r.clock);
      await sys.boot(r, () => {}, 0);
      expect(sys.frameErrors).toBe(0);
      expect(sys.diagnoses.map((d) => d.id)).toEqual(SCENARIOS[scenario as ScenarioId].expect);
      for (const d of sys.diagnoses) expect(d.confidence).toBe('HIGH');
      // Exported again, a replay gives back the same file.
      expect(toHdlog(r.recording)).toBe(text);
    });
  }
});
