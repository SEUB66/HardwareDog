/**
 * HARDWARE DOG / CAROUSEL STATE
 *
 * What a banner carousel does, without a browser: which slide is shown,
 * and whether it may turn on its own. It turns by itself, every 8 s,
 * unless something holds it (keyboard focus in it, tab hidden, carousel
 * off screen, a scan or an inspection running), unless pause was pressed,
 * and never with reduced motion. A slide chosen by hand (arrow, dot,
 * swipe) is shown for a full 8 s, then the turning carries on: only pause
 * stops it. A pointer resting over it does not hold it.
 */

export type HoldReason = 'focus' | 'hidden' | 'offscreen' | 'busy';

export interface CarouselState {
  index: number;
  count: number;
  /** What holds it right now; each reason is released on its own. */
  held: readonly HoldReason[];
  /** Stopped by the pause button: only play resumes it. */
  stopped: boolean;
  /** Counts every move, so a slide chosen by hand restarts the 8 s. */
  moves: number;
}

/** About 8 s per slide. */
export const ROTATE_MS = 8000;

export const carousel = (count: number): CarouselState => ({ index: 0, count, held: [], stopped: false, moves: 0 });

const wrap = (i: number, n: number) => (n <= 0 ? 0 : ((i % n) + n) % n);

/** Show slide i, by hand or on its own: the next turn comes 8 s later. */
export function go(s: CarouselState, i: number): CarouselState {
  return { ...s, index: wrap(i, s.count), moves: s.moves + 1 };
}
export const next = (s: CarouselState) => go(s, s.index + 1);
export const prev = (s: CarouselState) => go(s, s.index - 1);

export function hold(s: CarouselState, reason: HoldReason, on: boolean): CarouselState {
  const has = s.held.includes(reason);
  if (on === has) return s;
  return { ...s, held: on ? [...s.held, reason] : s.held.filter((r) => r !== reason) };
}

export const pause = (s: CarouselState): CarouselState => (s.stopped ? s : { ...s, stopped: true });
export const play = (s: CarouselState): CarouselState => (s.stopped ? { ...s, stopped: false } : s);

/** May the next slide come on its own? */
export const turns = (s: CarouselState, reducedMotion: boolean): boolean => !reducedMotion && s.count > 1 && !s.stopped && s.held.length === 0;

/** A horizontal swipe, or null: a scroll or a tap stays what it is. */
export function swipe(dx: number, dy: number): 1 | -1 | null {
  if (Math.abs(dx) < 50 || Math.abs(dx) < 1.5 * Math.abs(dy)) return null;
  return dx < 0 ? 1 : -1;
}
