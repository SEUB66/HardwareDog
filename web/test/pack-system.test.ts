/**
 * LVL 90 gate, in software: several Dogs, one timeline, one clock.
 *
 * The same simulated incident is watched by one Hardware Dog, then by a
 * pack of three (supply, target, network) whose clocks started at other
 * moments and whose links have their own latency. The engine must reach
 * the same diagnosis: the rules never know which Dog spoke.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIOS, type ScenarioId } from '../src/core/scenarios';
import { BENCH_PACK, SimulatedPack, type SimDog } from '../src/core/simpack';
import { System, memoryStore } from '../src/core/system';
import { PackTransport } from '../src/core/transport';
import { FakeTransport, T0, diagnosisKeys, runScenario } from './helpers';

async function runPack(scenario: ScenarioId, seed: number, sessionMs = 90_000, dogs: readonly SimDog[] = BENCH_PACK) {
  let now = T0;
  const sys = new System(memoryStore(), () => now);
  const pack = new SimulatedPack({ seed, manual: true, scenario, dogs });
  const sent: string[] = [];
  const send = pack.send.bind(pack);
  pack.send = (cmd, dog) => {
    sent.push(`${dog}:${cmd.cmd}`);
    send(cmd, dog);
  };
  await sys.boot(pack, () => {}, 0);
  for (let elapsed = 0; elapsed < sessionMs; elapsed += 5) pack.advance(5, (t) => (now = T0 + t));
  await sys.disconnect();
  sys.evaluate(now);
  return { sys, sent };
}

const ids = Object.keys(SCENARIOS) as ScenarioId[];

describe('LVL 90 gate: a pack diagnoses like one Hardware Dog', () => {
  for (const id of ids) {
    it(`${id} ${SCENARIOS[id].title}: three Dogs, three clocks, same diagnosis`, async () => {
      const one = await runScenario(id, 7, 90_000);
      const { sys } = await runPack(id, 7, 90_000);
      expect(diagnosisKeys(sys)).toEqual(one.diagnoses.map((d) => `${d.id}:${d.confidence}`));
      expect(sys.frameErrors).toBe(0);
    });
  }

  it('every Dog is on the host clock to a few ms, and stays sampled', async () => {
    const { sys, sent } = await runPack('HD-T001', 7, 35_000);
    for (const d of BENCH_PACK) {
      const err = sys.pack!.clocks.get(d.dog)!.errAt(T0 + 35_000);
      expect(err, d.dog).not.toBeNull();
      expect(err!, d.dog).toBeLessThan(10);
      // after its hello, then every 10 s
      expect(sent.filter((s) => s === `${d.dog}:time`).length, d.dog).toBe(4);
    }
    expect(sys.dogs.map((d) => [d.id, d.device?.id, d.observes])).toEqual([
      ['D1', 'HD-P0WER', ['power']],
      ['D2', 'HD-TARGET', ['usb', 'uart', 'i2c']],
      ['D3', 'HD-NET', ['net', 'probe']],
    ]);
  });
});

describe('no fake certainty across clocks', () => {
  it('a 40-60 ms link: still certain, because the drop started long before the disconnect', async () => {
    const slow = BENCH_PACK.map((d) => (d.dog === 'D1' ? { ...d, latencyMs: [40, 60] as [number, number] } : d));
    const one = await runScenario('HD-T001', 7, 90_000);
    const { sys } = await runPack('HD-T001', 7, 90_000, slow);
    expect(diagnosisKeys(sys)).toEqual(one.diagnoses.map((d) => `${d.id}:${d.confidence}`));
    expect(sys.facts.detaches.every((d) => d.undetermined === undefined)).toBe(true);
  });

  it('a 150-200 ms link: the supply / USB correlation is UNDETERMINED, never guessed either way', async () => {
    // The supply Dog sits behind a slow link (a busy Wi-Fi): its clock is known to +-175 ms at best,
    // and the drops start 60-80 ms before the disconnects.
    const slow = BENCH_PACK.map((d) => (d.dog === 'D1' ? { ...d, latencyMs: [150, 200] as [number, number] } : d));
    const { sys } = await runPack('HD-T001', 7, 90_000, slow);
    const keys = diagnosisKeys(sys).map((k) => k.split(':')[0]);
    expect(keys).not.toContain('POWER_INSTABILITY'); // not claimed
    expect(keys).not.toContain('USB_INTERMITTENT'); // not blamed on USB either
    const unplaced = sys.facts.detaches.filter((d) => d.undetermined !== undefined);
    expect(unplaced.length).toBeGreaterThan(0);
    expect(unplaced.every((d) => d.undetermined! > 100)).toBe(true);
    const sag = sys.diagnoses.find((d) => d.id === 'SUPPLY_SAG')!;
    expect(sag.basis).toContain('none known to be followed');
    expect(sag.observed.join(' ')).toMatch(/could not be placed against the drops/);
    expect(sys.trace.all().some((e) => e.message === 'disconnect vs voltage drop: undetermined')).toBe(true);
  });
});

/** Two fake Dogs the test drives by hand. */
async function fakePack() {
  let now = T0;
  const sys = new System(memoryStore(), () => now);
  const a = new FakeTransport();
  const b = new FakeTransport();
  const pack = new PackTransport([
    { dog: 'D1', link: a },
    { dog: 'D2', link: b },
  ]);
  await sys.connect(pack);
  return { sys, a, b, at: (t: number) => (now = T0 + t) };
}

const hello = (device: string, caps?: ('power' | 'usb' | 'uart' | 'i2c' | 'net' | 'probe')[]) => ({
  type: 'hello' as const,
  t: 0,
  proto: 1,
  device,
  rev: 'A',
  fw: '1',
  ...(caps ? { caps } : {}),
});

describe('a pack has one source of truth per signal', () => {
  it('a second Dog claiming the same capability is refused, said once, and counted', async () => {
    const { sys, a, b, at } = await fakePack();
    a.push(hello('HD-A', ['power', 'usb']));
    b.push(hello('HD-B', ['power', 'net']));
    at(600);
    b.push({ type: 'power', t: 100, v: 3.1, i: 0.2 }); // B is not the power source
    b.push({ type: 'power', t: 120, v: 3.1, i: 0.2 });
    a.push({ type: 'power', t: 600, v: 5.0, i: 0.1 });
    await sys.disconnect(); // end of session: everything held goes on the timeline
    expect(sys.owners.get('power')).toBe('D1');
    expect(sys.owners.get('net')).toBe('D2');
    expect(sys.dogs[1]!.observes).toEqual(['net']);
    expect(sys.power.minVoltage).toBe(5.0);
    expect(sys.frameErrors).toBe(2);
    const said = sys.trace.all().filter((e) => e.message === 'D2: power frames ignored');
    expect(said).toHaveLength(1);
    expect(sys.trace.all().some((e) => e.message.includes('power is already observed by D1'))).toBe(true);
  });

  it('commands go to the Dog that observes them; hello to all; time to one', async () => {
    const { sys, a, b } = await fakePack();
    a.push(hello('HD-A', ['power']));
    b.push(hello('HD-B', ['i2c', 'uart']));
    a.sent.length = 0;
    b.sent.length = 0;
    expect(sys.scanI2c()).toBeNull();
    expect(sys.setBaud(9600)).toBeNull();
    expect(a.sent.map((c) => c.cmd)).toEqual([]);
    expect(b.sent.map((c) => c.cmd)).toEqual(['i2c.scan', 'uart.config']);
    // no Dog observes the network: said, not sent anywhere
    expect(sys.refreshNet()).not.toBeNull();
  });

  it('a Dog that drops out: the pack goes on, its signals say NO SIGNAL', async () => {
    const { sys, a, b, at } = await fakePack();
    a.push(hello('HD-A', ['power']));
    b.push(hello('HD-B', ['usb']));
    at(10);
    a.push({ type: 'power', t: 10, v: 5, i: 0.1 });
    b.push({ type: 'usb.detach', t: 10 });
    a.sink!.lost('cable pulled');
    expect(sys.link).toBe('ONLINE');
    expect(sys.dogs[0]!.lost).toBe(true);
    expect(sys.power.condition).toBe('NO SIGNAL');
    b.sink!.lost('gone too');
    expect(sys.link).toBe('LOST');
  });
});
