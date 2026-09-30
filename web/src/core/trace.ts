import type { Severity, Source, TraceEvent } from './types';

/**
 * The trace engine: one chronological timeline for every source.
 *
 * Recording never stops. "Pause" freezes what the operator is looking at
 * while events keep being captured, so pausing to read a line never loses
 * the next fault.
 */
export class Trace {
  private events: TraceEvent[] = [];
  private nextId = 1;
  private frozenAt: number | null = null;

  constructor(private readonly capacity = 10_000) {}

  append(t: number, source: Source, severity: Severity, message: string, value?: string): TraceEvent {
    const event: TraceEvent = { id: this.nextId++, t, source, severity, message };
    if (value !== undefined) event.value = value;
    // Frames can arrive slightly out of order across sources; keep the
    // timeline sorted so correlation reads the true order of events.
    let at = this.events.length;
    while (at > 0 && this.events[at - 1]!.t > t) at--;
    this.events.splice(at, 0, event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return event;
  }

  /** Every recorded event, oldest first. */
  all(): readonly TraceEvent[] {
    return this.events;
  }

  /** What the operator should see: everything, or everything up to the pause. */
  visible(): readonly TraceEvent[] {
    if (this.frozenAt === null) return this.events;
    const limit = this.frozenAt;
    return this.events.filter((e) => e.id <= limit);
  }

  get paused(): boolean {
    return this.frozenAt !== null;
  }

  /** Events captured since the display was paused. */
  get buffered(): number {
    if (this.frozenAt === null) return 0;
    const limit = this.frozenAt;
    return this.events.reduce((n, e) => (e.id > limit ? n + 1 : n), 0);
  }

  pause(): void {
    if (this.frozenAt === null) this.frozenAt = this.nextId - 1;
  }

  resume(): void {
    this.frozenAt = null;
  }

  clear(): void {
    this.events = [];
    if (this.frozenAt !== null) this.frozenAt = this.nextId - 1;
  }

  get size(): number {
    return this.events.length;
  }

  /** Latest event of a source at or before `t`, if any. */
  lastBefore(t: number, predicate: (e: TraceEvent) => boolean): TraceEvent | null {
    for (let n = this.events.length - 1; n >= 0; n--) {
      const e = this.events[n]!;
      if (e.t <= t && predicate(e)) return e;
    }
    return null;
  }
}
