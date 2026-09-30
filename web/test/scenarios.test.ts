import { describe, expect, it } from 'vitest';
import { SCENARIOS, SCENARIO_IDS } from '../src/core/scenarios';
import { runScenario } from './helpers';

/**
 * RELIABILITY MATRIX
 *
 * Every scenario, several seeds, a realistic session length. The engine
 * must produce exactly the expected diagnoses: nothing missing (false
 * negative) and nothing extra (false positive). HD-T000 must stay silent.
 */

const SEEDS = [1, 7, 42, 1337, 90210];

describe('reliability matrix', () => {
  for (const id of SCENARIO_IDS) {
    const scenario = SCENARIOS[id];
    it(`${id} ${scenario.title} -> ${scenario.expect.join(', ') || 'no diagnosis'}`, async () => {
      for (const seed of SEEDS) {
        const { sys, diagnoses } = await runScenario(id, seed);
        expect(sys.frameErrors, `seed ${seed}: protocol errors`).toBe(0);
        expect(diagnoses.map((d) => d.id).sort(), `seed ${seed}`).toEqual([...scenario.expect].sort());
      }
    });
  }

  it('reaches HIGH confidence on every fault within a 90 s session', async () => {
    for (const id of SCENARIO_IDS) {
      if (SCENARIOS[id].expect.length === 0) continue;
      const { diagnoses } = await runScenario(id, 3);
      for (const d of diagnoses) expect(`${id} ${d.id} ${d.confidence}`).toBe(`${id} ${d.id} HIGH`);
    }
  });
});

describe('endurance', () => {
  it('HD-T000 stays silent for 10 minutes', async () => {
    for (const seed of [2, 3, 5]) {
      const { diagnoses, sys } = await runScenario('HD-T000', seed, 600_000);
      expect(diagnoses, `seed ${seed}`).toEqual([]);
      expect(sys.trace.all().some((e) => e.source === 'RULE')).toBe(false);
    }
  });

  it('faults never drift into extra diagnoses over 5 minutes', async () => {
    for (const id of SCENARIO_IDS) {
      const { diagnoses } = await runScenario(id, 11, 300_000);
      expect(diagnoses.map((d) => d.id).sort(), id).toEqual([...SCENARIOS[id].expect].sort());
    }
  });
});

describe('detection time', () => {
  it('every fault is diagnosed within 30 s of simulated time', async () => {
    for (const id of SCENARIO_IDS) {
      if (SCENARIOS[id].expect.length === 0) continue;
      for (const seed of [1, 7, 42]) {
        const { sys } = await runScenario(id, seed, 30_000);
        expect(sys.diagnoses.map((d) => d.id), `${id} seed ${seed}`).toEqual(expect.arrayContaining([...SCENARIOS[id].expect]));
      }
    }
  });
});

describe('recovery', () => {
  it('clears SERIAL_CONFIGURATION_MISMATCH once the right baud rate is set', async () => {
    const { sys, sim } = await runScenario('HD-T004', 1, 20_000);
    expect(sys.diagnoses.map((d) => d.id)).toEqual(['SERIAL_CONFIGURATION_MISMATCH']);
    sys.setBaud(9600);
    for (let k = 0; k < 300; k++) sim.advance(100);
    expect(sys.evaluate(sim.uptime)).toEqual([]);
    expect(sys.trace.all().some((e) => e.message === 'cleared: SERIAL_CONFIGURATION_MISMATCH')).toBe(true);
  });
});
