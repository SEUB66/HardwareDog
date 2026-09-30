import { describe, expect, it } from 'vitest';
import { layoutAnnotations, timeTicks, type AnnotationInput, type Bounds } from '../src/ui/components/annotations';

const bounds: Bounds = { left: 46, right: 630, top: 10, bottom: 170 };

const overlapping = (labels: ReturnType<typeof layoutAnnotations>) => {
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!.box, b = labels[j]!.box;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) return true;
    }
  return false;
};

const insideAll = (labels: ReturnType<typeof layoutAnnotations>, b: Bounds) =>
  labels.every((l) => l.box.x0 >= b.left && l.box.x1 <= b.right && l.box.y0 >= b.top && l.box.y1 <= b.bottom);

describe('layoutAnnotations', () => {
  it('stacks markers that are close together instead of overlapping them', () => {
    const items: AnnotationInput[] = [
      { id: 'a', kind: 'marker', x: 300, y: 0, text: 'USB LOST', short: 'LOST' },
      { id: 'b', kind: 'marker', x: 312, y: 0, text: 'USB UP', short: 'UP' },
      { id: 'c', kind: 'marker', x: 318, y: 0, text: 'USB LOST', short: 'LOST' },
    ];
    const out = layoutAnnotations(items, bounds);
    expect(out).toHaveLength(3);
    expect(overlapping(out)).toBe(false);
    expect(insideAll(out, bounds)).toBe(true);
  });

  it('flips a marker label to the left at the right edge of the plot', () => {
    const [l] = layoutAnnotations([{ id: 'a', kind: 'marker', x: 625, y: 0, text: 'USB LOST' }], bounds);
    expect(l!.anchor).toBe('end');
    expect(l!.box.x1).toBeLessThanOrEqual(625);
  });

  it('keeps a threshold label attached to its line and clear of a marker label', () => {
    const out = layoutAnnotations(
      [
        { id: 't', kind: 'threshold', x: 0, y: 22, text: 'LIMIT 900 mA', short: '900 mA' },
        { id: 'm', kind: 'marker', x: 50, y: 0, text: 'USB UP' },
      ],
      bounds,
    );
    const t = out.find((l) => l.id === 't')!;
    expect(Math.abs(t.y - 22)).toBeLessThanOrEqual(14);
    expect(overlapping(out)).toBe(false);
    // Never struck through by the marker line at x = 50.
    expect(t.box.x0 > 51 || t.box.x1 < 49).toBe(true);
  });

  it('uses the short text, then hides, rather than ever overlapping', () => {
    const tight: Bounds = { left: 0, right: 60, top: 0, bottom: 24 };
    const items: AnnotationInput[] = Array.from({ length: 6 }, (_, n) => ({
      id: String(n),
      kind: 'marker' as const,
      x: 20 + n,
      y: 0,
      text: 'USB DISCONNECTED',
      short: 'LOST',
    }));
    const out = layoutAnnotations(items, tight);
    expect(out.length).toBeLessThan(items.length);
    expect(out.every((l) => l.text === 'LOST')).toBe(true);
    expect(overlapping(out)).toBe(false);
    expect(insideAll(out, tight)).toBe(true);
  });

  it('prefers short text in compact mode', () => {
    const [l] = layoutAnnotations([{ id: 'a', kind: 'marker', x: 100, y: 0, text: 'USB LOST', short: 'LOST' }], bounds, {
      compact: true,
    });
    expect(l!.text).toBe('LOST');
  });
});

describe('timeTicks', () => {
  it('spaces labels by at least the minimum gap', () => {
    const ticks = timeTicks(0, 15_000, 300, 70);
    const gap = ((ticks[1]! - ticks[0]!) / 15_000) * 300;
    expect(gap).toBeGreaterThanOrEqual(70);
  });
});
