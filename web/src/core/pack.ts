/**
 * HARDWARE DOG / PACK: several Dogs, one timeline, one clock.
 *
 * A pack is several Hardware Dogs (probes) watching one incident: a POWER
 * DOG on the supply, a USB DOG on the cable, a NET DOG on the switch. Each
 * one speaks HDP v1 and counts time from its own boot. This module puts
 * their frames on one timeline, in the true order of events, and says how
 * well their clocks are aligned. It is pure and deterministic: the same
 * arrivals give the same timeline, live and in a replay.
 *
 * ONE CLOCK. Every Dog's clock is mapped onto the host clock:
 *
 *   hello          provisional: host = arrival - t. The link latency is
 *                  unknown, so the error is UNBOUNDED until a time sample.
 *   time sample    the host sends {"cmd":"time","id":n} at h0 and receives
 *                  {"type":"time","t":T,"id":n} at h1: the Dog read T
 *                  somewhere between h0 and h1, so offset = (h0 + h1) / 2 - T
 *                  with an error of (h1 - h0) / 2.
 *   drift          crystals drift; the error of a sample grows by DRIFT_PPM
 *                  per ms away from it. The sample with the smallest error at
 *                  that moment is used.
 *
 * ONE TIMELINE. Frames from one Dog arrive in its own order, but the Dogs'
 * links differ: a USB detach can arrive before the voltage drop that caused
 * it. A frame is put on the timeline only once every other live Dog has
 * spoken past it, or HOLD_MS after it at the latest. Releases happen only
 * when a frame arrives (never on a timer), so a replay releases exactly
 * what the live session released.
 *
 * NO FAKE CERTAINTY. Two times from different clocks are compared with the
 * sum of their errors as a margin: a correlation is IN, OUT, or UNKNOWN
 * (relation()). Two times from the same clock compare exactly.
 */

import type { DeviceFrame } from './protocol';

/** Assumed worst-case drift between a Dog's crystal and the host: 100 ppm. */
export const DRIFT_PPM = 100;
/** Longest a frame waits for the other Dogs before it goes on the timeline. */
export const HOLD_MS = 500;
/** How often each Dog's clock is sampled again. */
export const SYNC_EVERY_MS = 10_000;
/** Time samples kept per Dog. */
const SAMPLES = 16;

/** Which clock a time comes from, and its error against the host clock (ms, null: unbounded). */
export interface Clk {
  dog: string;
  err: number | null;
}

/** A time, with its clock when it is not the only one. */
export interface Stamp {
  t: number;
  clk?: Clk;
}

export type Relation = 'IN' | 'OUT' | 'UNKNOWN';

/**
 * Does `b` follow `a` within `windowMs`? Exact on one clock; across two
 * clocks the sum of their errors is a margin either way, and a question
 * the margin cannot settle is UNKNOWN, never a guess.
 */
export function relation(a: Stamp, b: Stamp, windowMs: number): Relation {
  return during(a, a, b, windowMs);
}

/**
 * Did `b` happen during the episode [from, to] (one clock), or within
 * `windowMs` after it ended? A disconnect in the middle of a voltage drop
 * is inside it, even if the last low sample came a moment later.
 */
export function during(from: Stamp, to: Stamp, b: Stamp, windowMs: number): Relation {
  const m = margin(from, b);
  if (b.t - m >= from.t && b.t + m <= to.t + windowMs) return 'IN';
  if (b.t + m < from.t || b.t - m > to.t + windowMs) return 'OUT';
  return 'UNKNOWN';
}

/** The margin `relation` used, for display (ms, Infinity: unbounded). */
export function margin(a: Stamp, b: Stamp): number {
  return sameClock(a, b) ? 0 : (a.clk?.err ?? Infinity) + (b.clk?.err ?? Infinity);
}

const sameClock = (a: Stamp, b: Stamp) => (a.clk?.dog ?? null) === (b.clk?.dog ?? null);

interface Sample {
  offset: number;
  half: number;
  at: number;
}

/** One Dog's clock against the host clock. */
export class DogClock {
  private provisional: number | null = null;
  private samples: Sample[] = [];
  private pending = new Map<number, number>();
  private last = -Infinity;

  /** The Dog (re)booted: its clock starts again, every sample is void. */
  hello(t: number, at: number): void {
    this.provisional = at - t;
    this.samples = [];
    this.pending.clear();
    this.last = -Infinity;
  }

  /** The host sent time id at `at`. */
  sent(id: number, at: number): void {
    this.pending.set(id, at);
  }

  /** The Dog answered time id with its clock `t`, received at `at`. False: not ours. */
  answer(id: number, t: number, at: number): boolean {
    const h0 = this.pending.get(id);
    if (h0 === undefined || at < h0) return false;
    this.pending.delete(id);
    this.samples.push({ offset: (h0 + at) / 2 - t, half: (at - h0) / 2, at });
    if (this.samples.length > SAMPLES) this.samples.shift();
    return true;
  }

  get synced(): boolean {
    return this.samples.length > 0;
  }

  /** Best current error at host time `t` (ms, null: unbounded). */
  errAt(t: number): number | null {
    return this.best(t)?.err ?? null;
  }

  /**
   * A Dog time on the host clock, and its error. Within one Dog the order
   * of its own frames is the truth: a host time never goes back.
   */
  convert(t: number, arrival: number): { t: number; err: number | null } {
    const guess = this.provisional === null ? arrival : t + this.provisional;
    const best = this.best(guess);
    let host = best ? t + best.offset : guess;
    const err = best ? best.err : null;
    if (host < this.last) host = this.last;
    this.last = host;
    return { t: host, err };
  }

  private best(at: number): { offset: number; err: number } | null {
    let found: { offset: number; err: number } | null = null;
    for (const s of this.samples) {
      const err = s.half + (Math.abs(at - s.at) * DRIFT_PPM) / 1e6;
      if (!found || err < found.err) found = { offset: s.offset, err };
    }
    return found;
  }
}

/** A frame put on the timeline: which Dog, its arrival number, its host time and error. */
export interface Placed {
  dog: string;
  /** Session frame number, in arrival order: the number evidence cites. */
  seq: number;
  frame: DeviceFrame;
  t: number;
  err: number | null;
}

/**
 * The pack: clocks and the merge. `dogs` is the pack's fixed order (D1,
 * D2...); it breaks ties between equal times.
 */
export class Pack {
  readonly clocks = new Map<string, DogClock>();
  private queue: Placed[] = [];
  private frontier = new Map<string, number>();
  private live = new Set<string>();

  constructor(readonly dogs: readonly string[]) {
    for (const d of dogs) this.clocks.set(d, new DogClock());
  }

  /** The host sent a command; only time matters to the clocks. */
  sent(dog: string, id: number, at: number): void {
    this.clocks.get(dog)?.sent(id, at);
  }

  /**
   * A frame arrived from `dog` at host time `at`. Returns what can now go on
   * the timeline, in order.
   */
  arrive(dog: string, seq: number, frame: DeviceFrame, at: number): Placed[] {
    const clock = this.clocks.get(dog);
    if (!clock) return [];
    if (frame.type === 'hello') {
      clock.hello(frame.t, at);
      this.live.add(dog);
    }
    if (frame.type === 'time') clock.answer(frame.id, frame.t, at);
    const { t, err } = clock.convert(frame.t, at);
    this.frontier.set(dog, Math.max(this.frontier.get(dog) ?? -Infinity, t));
    this.insert({ dog, seq, frame, t, err });
    return this.release(at);
  }

  /** A Dog's link is gone: nothing more will come from it. */
  lost(dog: string, at: number): Placed[] {
    this.live.delete(dog);
    return this.release(at);
  }

  /** The end (link closed, replay ended): everything still held, in order. */
  flush(): Placed[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** Frames waiting for another Dog. */
  get held(): number {
    return this.queue.length;
  }

  private insert(p: Placed): void {
    const order = (a: Placed, b: Placed) =>
      a.t - b.t || this.dogs.indexOf(a.dog) - this.dogs.indexOf(b.dog) || a.seq - b.seq;
    let at = this.queue.length;
    while (at > 0 && order(this.queue[at - 1]!, p) > 0) at--;
    this.queue.splice(at, 0, p);
  }

  private release(now: number): Placed[] {
    const out: Placed[] = [];
    while (this.queue.length > 0) {
      const p = this.queue[0]!;
      const waitFor = [...this.live].filter((d) => d !== p.dog && (this.frontier.get(d) ?? -Infinity) < p.t);
      if (waitFor.length > 0 && now < p.t + HOLD_MS) break;
      out.push(this.queue.shift()!);
    }
    return out;
  }
}
