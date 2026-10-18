/**
 * HARDWARE DOG / CAROUSEL STATE
 *
 * What a banner carousel does, without a browser: which slide is shown,
 * and whether it may turn on its own. It turns only when nothing holds
 * it (pointer over it, keyboard focus in it, tab hidden, carousel off
 * screen, a scan or an inspection running), when no one stopped it, and
 * never with reduced motion. A person who moves it by hand stops it until
 * they press play again.
 */

export type HoldReason = 'hover' | 'focus' | 'hidden' | 'offscreen' | 'busy';

export interface CarouselState {
  index: number;
  count: number;
  /** What holds it right now; each reason is released on its own. */
  held: readonly HoldReason[];
  /** Stopped by a person (a slide chosen by hand, or pause): only play resumes it. */
  stopped: boolean;
}

/** About 8 s per slide. */
export const ROTATE_MS = 8000;

export const carousel = (count: number): CarouselState => ({ index: 0, count, held: [], stopped: false });

const wrap = (i: number, n: number) => (n <= 0 ? 0 : ((i % n) + n) % n);

/** Show slide i. By hand (the default) it also stops the rotation. */
export function go(s: CarouselState, i: number, byHand = true): CarouselState {
  return { ...s, index: wrap(i, s.count), stopped: s.stopped || byHand };
}
export const next = (s: CarouselState, byHand = true) => go(s, s.index + 1, byHand);
export const prev = (s: CarouselState, byHand = true) => go(s, s.index - 1, byHand);

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
