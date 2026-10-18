import { describe, expect, it } from 'vitest';
import { carousel, go, hold, next, pause, play, prev, ROTATE_MS, swipe, turns } from '../src/core/carousel';
import { CAMERA_SLIDES, HOME_SLIDES } from '../src/ui/brand/slides';

describe('banner carousel', () => {
  it('turns on its own only while nothing holds it, about every 8 s', () => {
    expect(ROTATE_MS).toBe(8000);
    let s = carousel(4);
    expect(turns(s, false)).toBe(true);
    s = next(s);
    expect(s.index).toBe(1);
    expect(turns(s, false)).toBe(true);
    for (const r of ['focus', 'hidden', 'offscreen', 'busy'] as const) {
      const held = hold(s, r, true);
      expect(turns(held, false), r).toBe(false);
      expect(turns(hold(held, r, false), false), r).toBe(true);
    }
    // two reasons: released one by one
    const two = hold(hold(s, 'focus', true), 'busy', true);
    expect(turns(hold(two, 'focus', false), false)).toBe(false);
  });

  it('a slide chosen by hand keeps it turning and restarts the 8 s; only pause stops it', () => {
    const a = carousel(3);
    let s = next(a);
    expect(s.stopped).toBe(false);
    expect(turns(s, false)).toBe(true);
    // choosing the slide already shown still restarts the countdown
    expect(go(s, s.index).moves).toBe(s.moves + 1);
    s = pause(s);
    expect(turns(s, false)).toBe(false);
    expect(turns(next(s), false)).toBe(false);
    s = play(s);
    expect(turns(s, false)).toBe(true);
  });

  it('never turns with reduced motion, nor with one slide; wraps both ways', () => {
    expect(turns(carousel(4), true)).toBe(false);
    expect(turns(carousel(1), false)).toBe(false);
    expect(prev(carousel(4)).index).toBe(3);
    expect(next(go(carousel(4), 3)).index).toBe(0);
  });

  it('a swipe is clearly sideways; a scroll or a tap is not one', () => {
    expect(swipe(-80, 10)).toBe(1);
    expect(swipe(80, 10)).toBe(-1);
    expect(swipe(30, 0)).toBeNull();
    expect(swipe(-80, 70)).toBeNull();
  });

  it('home and Camera Sniffer have their own slides, in the order given, each with alt text and captions in both languages', () => {
    expect(HOME_SLIDES.map((s) => s.id)).toEqual(['no-cookies', 'your-data', 'no-leash', 'one-last-fix']);
    expect(CAMERA_SLIDES.map((s) => s.id)).toEqual(['camera-sniffer', 'scan-this', 'human-verification']);
    for (const s of [...HOME_SLIDES, ...CAMERA_SLIDES]) {
      expect(s.alt.length, s.id).toBeGreaterThan(40);
      expect(s.caption.en && s.caption.fr, s.id).toBeTruthy();
      expect(Object.keys(s.src)).toEqual(['800', '1200', '1983']);
    }
    // nothing a scan did not establish, nothing the code does not do
    const text = JSON.stringify([...HOME_SLIDES, ...CAMERA_SLIDES]);
    expect(text).not.toMatch(/no camera|aucune caméra|0 (byte|octet)|safe place|lieu sûr|disappears|disparaît/i);
  });
});
