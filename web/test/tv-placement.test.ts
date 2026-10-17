import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TvPlacement, tabBottom } from '../src/ui/lab/TvHost';

/** A window of a given size with the bottom menu (nav.nav) of a phone, or none. */
function screen(width: number, height: number, navHeight: number | null): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height });
  vi.stubGlobal('document', {
    querySelector: (sel: string) => (sel === 'nav.nav' && navHeight !== null ? { getBoundingClientRect: () => ({ top: height - navHeight, height: navHeight }) } : null),
  });
}

describe('floating TV placement', () => {
  beforeEach(() => vi.stubGlobal('localStorage', undefined));
  afterEach(() => vi.unstubAllGlobals());

  it('is a small TV on a phone, never more than 200 px nor under 150', () => {
    screen(390, 844, 58);
    const p = new TvPlacement();
    p.set({ width: 440 }, false);
    expect(p.floatWidth).toBe(179); // 46 % of 390
    screen(320, 568, 58);
    expect(p.floatWidth).toBe(150);
    screen(1366, 860, null);
    expect(p.floatWidth).toBe(440); // a computer keeps the chosen size
  });

  it('floats bottom-right, above the bottom menu, and stays there', () => {
    screen(390, 844, 58);
    const p = new TvPlacement();
    p.float();
    expect(p.state.mode).toBe('floating');
    const bottom = p.state.y + p.floatHeight;
    expect(bottom).toBeLessThanOrEqual(844 - 58);
    expect(p.state.x + p.floatWidth).toBeLessThanOrEqual(390);
    p.set({ x: 5000, y: 5000 }, false);
    p.clamp();
    expect(p.state.y + p.floatHeight).toBeLessThanOrEqual(844 - 58 + 0.5);
    expect(p.state.x + p.floatWidth).toBeLessThanOrEqual(390);
    expect(tabBottom()).toBe(58 + 12);
  });

  it('snaps to the nearest side on a phone when let go, not on a computer', () => {
    screen(390, 844, 58);
    const p = new TvPlacement();
    p.float();
    p.set({ x: 100 }, false);
    p.snap();
    expect(p.state.x).toBe(8);
    p.set({ x: 200 }, false);
    p.snap();
    expect(p.state.x).toBe(390 - p.floatWidth - 8);
    screen(1366, 860, null);
    p.set({ x: 300 }, false);
    p.snap();
    expect(p.state.x).toBe(300);
  });
});
