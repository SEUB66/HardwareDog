import { describe, expect, it } from 'vitest';
import { DogClock, DRIFT_PPM, HOLD_MS, Pack, relation, type Placed } from '../src/core/pack';
import type { DeviceFrame } from '../src/core/protocol';

const hello = (t: number): DeviceFrame => ({ type: 'hello', t, proto: 1, device: 'HD-X', rev: 'A', fw: '1' });
const power = (t: number, v = 5): DeviceFrame => ({ type: 'power', t, v, i: 0.1 });
const detach = (t: number): DeviceFrame => ({ type: 'usb.detach', t });
const time = (t: number, id: number): DeviceFrame => ({ type: 'time', t, id });

describe('one clock: a Dog clock against the host', () => {
  it('is provisional and UNBOUNDED after hello: the link latency is not known', () => {
    const c = new DogClock();
    c.hello(5000, 1_000_000); // the Dog booted 5 s before it said hello
    expect(c.convert(6000, 1_000_900)).toEqual({ t: 1_001_000, err: null });
    expect(c.synced).toBe(false);
  });

  it('a time round trip bounds it: error = half the round trip', () => {
    const c = new DogClock();
    c.hello(0, 1_000_000);
    c.sent(7, 1_000_100);
    // The Dog read 120 somewhere between 1_000_100 and 1_000_108.
    expect(c.answer(7, 120, 1_000_108)).toBe(true);
    const at = c.convert(120, 1_000_108);
    expect(at.t).toBe(1_000_104 - 120 + 120);
    expect(at.err).toBeCloseTo(4, 2);
    // An answer nobody asked for is not a sample.
    expect(c.answer(8, 999, 1_000_200)).toBe(false);
    expect(c.answer(7, 999, 1_000_200)).toBe(false); // used once
  });

  it('the error grows with drift away from the sample, and the best sample wins', () => {
    const c = new DogClock();
    c.hello(0, 0);
    c.sent(1, 0);
    c.answer(1, 2, 4); // +-2 ms at host 4
    const later = c.convert(600_002, 600_010); // 10 minutes later
    expect(later.err).toBeCloseTo(2 + (600_000 * DRIFT_PPM) / 1e6, 2); // 2 + 60 ms
    c.sent(2, 600_000);
    c.answer(2, 600_005, 600_010); // +-5 ms, but fresh
    expect(c.convert(600_010, 600_012).err).toBeCloseTo(5, 3);
  });

  it('a reboot voids every sample: the clock starts again', () => {
    const c = new DogClock();
    c.hello(0, 0);
    c.sent(1, 0);
    c.answer(1, 1, 2);
    c.hello(0, 50_000);
    expect(c.synced).toBe(false);
    expect(c.convert(10, 50_020).err).toBeNull();
  });

  it("within one Dog, host time never goes back (its own order is the truth)", () => {
    const c = new DogClock();
    c.hello(0, 0);
    c.sent(1, 0);
    c.answer(1, 0, 20); // offset 10 +-10
    expect(c.convert(100, 100).t).toBe(110);
    c.sent(2, 200);
    c.answer(2, 200, 202); // offset 1 +-1: a better sample moves the estimate back by 9
    expect(c.convert(101, 205).t).toBe(110); // clamped, not 102
    expect(c.convert(300, 305).t).toBe(301);
  });
});

describe('no fake certainty: comparing two times', () => {
  const on = (dog: string, err: number | null, t: number) => ({ t, clk: { dog, err } });

  it('one clock compares exactly, as before packs', () => {
    expect(relation({ t: 0 }, { t: 100 }, 100)).toBe('IN');
    expect(relation({ t: 0 }, { t: 101 }, 100)).toBe('OUT');
    expect(relation({ t: 10 }, { t: 0 }, 100)).toBe('OUT');
    expect(relation(on('D1', 50, 0), on('D1', 50, 100), 100)).toBe('IN');
  });

  it('two clocks: the sum of their errors is a margin either way', () => {
    expect(relation(on('D1', 2, 0), on('D2', 3, 40), 100)).toBe('IN');
    expect(relation(on('D1', 2, 0), on('D2', 3, 96), 100)).toBe('UNKNOWN'); // 96 + 5 > 100
    expect(relation(on('D1', 2, 0), on('D2', 3, 3), 100)).toBe('UNKNOWN'); // could be before
    expect(relation(on('D1', 2, 0), on('D2', 3, 106), 100)).toBe('OUT');
    expect(relation(on('D1', 2, 0), on('D2', 3, -6), 100)).toBe('OUT');
  });

  it('an unbounded clock settles nothing', () => {
    expect(relation(on('D1', null, 0), on('D2', 1, 50), 100)).toBe('UNKNOWN');
    expect(relation(on('D1', null, 0), on('D2', 1, 50_000), 100)).toBe('UNKNOWN');
  });
});

/** Two Dogs, both synced to +-1 ms; D2 booted 7 s before D1. */
function pack() {
  const p = new Pack(['D1', 'D2']);
  const out: Placed[] = [];
  let seq = 0;
  const arrive = (dog: string, f: DeviceFrame, at: number) => out.push(...p.arrive(dog, ++seq, f, at));
  arrive('D1', hello(0), 0);
  arrive('D2', hello(7000), 0);
  p.sent('D1', 1, 10);
  p.sent('D2', 1, 10);
  arrive('D1', time(11, 1), 12);
  arrive('D2', time(7011, 1), 12);
  return { p, out, arrive };
}

describe('one timeline: merging Dogs in the true order of events', () => {
  it('a detach that arrives first is still placed after the drop that came before it', () => {
    const { out, arrive } = pack();
    out.length = 0;
    arrive('D2', detach(7000 + 1050), 1052); // the USB Dog's link is fast
    expect(out).toEqual([]); // held: D1 has not spoken past 1050 yet
    arrive('D1', power(1000, 4.4), 1080); // the POWER Dog's link is slow: 80 ms
    arrive('D1', power(1060), 1081);
    expect(out.map((x) => [x.dog, x.frame.type, x.t])).toEqual([
      ['D1', 'power', 1000],
      ['D2', 'usb.detach', 1050],
    ]);
    // +-1 ms from the round trip, + about 0.1 ms of drift one second later.
    expect(out.map((x) => x.err)).toEqual([expect.closeTo(1.1, 1), expect.closeTo(1.1, 1)]);
  });

  it(`a silent Dog holds the others ${HOLD_MS} ms at most, and a lost one not at all`, () => {
    const { p, out, arrive } = pack();
    out.length = 0;
    arrive('D1', power(2000), 2001);
    expect(out).toEqual([]);
    arrive('D1', power(2000 + HOLD_MS), 2000 + HOLD_MS + 1);
    expect(out.map((x) => x.t)).toEqual([2000]);
    out.push(...p.lost('D2', 2600));
    expect(out.map((x) => x.t)).toEqual([2000, 2000 + HOLD_MS]);
    arrive('D1', power(2700), 2701);
    expect(out.at(-1)!.t).toBe(2700); // nobody to wait for
  });

  it('the same arrivals give the same timeline: a replay is the session again', () => {
    const run = () => {
      const { p, out, arrive } = pack();
      for (let k = 0; k < 200; k++) {
        const at = 100 + k * 13;
        arrive(k % 3 ? 'D1' : 'D2', k % 3 ? power(at - 9) : detach(7000 + at - 2), at);
      }
      out.push(...p.flush());
      return out.map((x) => `${x.dog}#${x.seq}@${x.t}`).join(' ');
    };
    expect(run()).toBe(run());
    const order = run().split(' ').map((s) => Number(s.split('@')[1]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
