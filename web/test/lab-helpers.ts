import type { LabClock } from '../src/core/lab/events';
import type { Scheduler } from '../src/core/lab/messages';

/** A scheduler and clocks driven by the test: time moves only when told. */
export class FakeTime implements Scheduler, LabClock {
  t = 0;
  wall = 1_790_000_000_000;
  private timers = new Map<number, { due: number; fn: () => void }>();
  private next = 1;

  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { due: this.t + ms, fn });
    return id;
  }
  clear(id: number): void {
    this.timers.delete(id);
  }
  now(): number {
    return this.wall + this.t;
  }
  mono(): number {
    return this.t;
  }
  get pending(): number {
    return this.timers.size;
  }
  /** Move time forward, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let first: [number, { due: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].due <= end && (!first || entry[1].due < first[1].due)) first = entry;
      if (!first) break;
      this.timers.delete(first[0]);
      this.t = first[1].due;
      first[1].fn();
    }
    this.t = end;
  }
}
