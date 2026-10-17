/**
 * HARDWARE DOG / COMPANION MESSAGES
 *
 * Short suggestions on the TV. Rules are local (rules.ts): no remote AI.
 *
 *   PRIORITY      an error beats a warning beats a success beats a tip
 *   DEDUPLICATION the same message again within DEDUP_MS is counted, not repeated
 *   RATE LIMIT    a message stays at least MIN_SHOW_MS unless a more serious one comes
 *   EXPIRY        tips go, errors stay until read or replaced
 *
 * The TV is not the only place an error is said: the tool shows it and the
 * log keeps it. Losing a TV message never loses the fact.
 */

import type { LabAction, LabSeverity } from './events';

export interface Scheduler {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

export interface Suggestion {
  /** Same key = same message, for deduplication. */
  key: string;
  severity: LabSeverity;
  text: string;
  /** The exact error code, when there is one. */
  code?: string;
  actions?: LabAction[];
}

export interface CompanionMessage extends Suggestion {
  id: number;
  /** Monotonic time it was first said, and last said. */
  first: number;
  last: number;
  /** How many times it was said within the dedup window. */
  count: number;
}

const RANK: Record<LabSeverity, number> = { FAIL: 3, WARN: 2, PASS: 1, INFO: 0 };
/** How long a message stays on screen, ms. null: until dismissed or replaced. */
const SHOW_MS: Record<LabSeverity, number | null> = { INFO: 6000, PASS: 4000, WARN: 12000, FAIL: null };

export const DEDUP_MS = 10_000;
export const MIN_SHOW_MS = 2500;
const QUEUE_MAX = 8;
const HISTORY_MAX = 50;

export class MessageQueue {
  current: CompanionMessage | null = null;
  private queue: CompanionMessage[] = [];
  /** Every message said, newest last: the TV forgets, the history does not. */
  readonly history: CompanionMessage[] = [];
  private shownAt = 0;
  private nextId = 1;
  private expiry: number | null = null;
  private rotate: number | null = null;
  private now = 0;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly changed: () => void,
  ) {}

  push(s: Suggestion, now: number): void {
    this.now = now;
    // The same message again: counted, its time refreshed, not shown twice.
    const same = [this.current, ...this.queue].find((m) => m !== null && m.key === s.key && now - m.last < DEDUP_MS);
    if (same) {
      same.count++;
      same.last = now;
      if (same === this.current) this.schedule(same);
      this.changed();
      return;
    }
    const msg: CompanionMessage = { ...s, id: this.nextId++, first: now, last: now, count: 1 };
    this.history.push(msg);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);

    if (!this.current) return this.show(msg, now);
    if (RANK[msg.severity] > RANK[this.current.severity]) {
      // More serious: it takes the screen now; the one it replaces waits if it still matters.
      if (SHOW_MS[this.current.severity] === null || RANK[this.current.severity] >= RANK.WARN) this.enqueue(this.current);
      return this.show(msg, now);
    }
    this.enqueue(msg);
    // Rate limit: the next one comes once the current has been readable long enough.
    if (this.rotate === null && SHOW_MS[this.current.severity] !== null) {
      const wait = Math.max(0, MIN_SHOW_MS - (now - this.shownAt));
      this.rotate = this.scheduler.set(() => {
        this.rotate = null;
        this.next();
      }, wait);
    }
  }

  /** The operator read it. */
  dismiss(): void {
    this.next();
  }

  /** Forget everything on screen and waiting (the history stays). */
  clear(): void {
    this.cancel();
    this.queue = [];
    this.current = null;
    this.changed();
  }

  /** Withdraw messages that no longer hold (a lost link that came back). The history keeps them. */
  drop(stale: (m: CompanionMessage) => boolean): void {
    this.queue = this.queue.filter((m) => !stale(m));
    if (this.current && stale(this.current)) this.next();
    else this.changed();
  }

  get waiting(): number {
    return this.queue.length;
  }

  private enqueue(m: CompanionMessage): void {
    if (this.queue.includes(m)) return;
    this.queue.push(m);
    // Most serious first, then oldest first; the least serious overflow goes.
    this.queue.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.first - b.first);
    if (this.queue.length > QUEUE_MAX) this.queue.length = QUEUE_MAX;
  }

  private show(m: CompanionMessage, now: number): void {
    this.cancel();
    this.current = m;
    this.shownAt = now;
    this.schedule(m);
    this.changed();
  }

  private schedule(m: CompanionMessage): void {
    if (this.expiry !== null) this.scheduler.clear(this.expiry);
    this.expiry = null;
    const ms = SHOW_MS[m.severity];
    if (ms === null) return;
    this.expiry = this.scheduler.set(() => {
      this.expiry = null;
      this.next();
    }, ms);
  }

  private next(): void {
    this.cancel();
    const m = this.queue.shift() ?? null;
    if (m) this.show(m, this.now + MIN_SHOW_MS);
    else {
      this.current = null;
      this.changed();
    }
  }

  private cancel(): void {
    if (this.expiry !== null) this.scheduler.clear(this.expiry);
    if (this.rotate !== null) this.scheduler.clear(this.rotate);
    this.expiry = null;
    this.rotate = null;
  }

  dispose(): void {
    this.cancel();
  }
}
