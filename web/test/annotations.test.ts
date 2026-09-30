import { describe, expect, it } from 'vitest';
import { layoutAnnotations, timeTicks, type AnnotationInput, type Bounds } from '../src/ui/components/annotations';

const bounds: Bounds = { left: 46, right: 630, top: 10, bottom: 170 };

type Labels = ReturnType<typeof layoutAnnotations>['labels'];

const overlapping = (labels: Labels) => {
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!.box, b = labels[j]!.box;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) return true;
    }
  return false;
};

const insideAll = (labels: Labels, b: Bounds) =>
  labels.every((l) => l.box.x0 >= b.left && l.box.x1 <= b.right && l.box.y0 >= b.top && l.box.y1 <= b.bottom);

describe('layoutAnnotations', () => {
  it('stacks markers that are close together instead of overlapping them', () => {
    const items: AnnotationInput[] = [
      { id: 'a', kind: 'marker', x: 300, y: 0, text: 'USB LOST', short: 'LOST' },
      { id: 'b', kind: 'marker', x: 312, y: 0, text: 'USB UP', short: 'UP' },
      { id: 'c', kind: 'marker', x: 318, y: 0, text: 'USB LOST', short: 'LOST' },
    ];
    const out = layoutAnnotations(items, bounds).labels;
    expect(out).toHaveLength(3);
    expect(overlapping(out)).toBe(false);
    expect(insideAll(out, bounds)).toBe(true);
  });

  it('flips a marker label to the left at the right edge of the plot', () => {
    const [l] = layoutAnnotations([{ id: 'a', kind: 'marker', x: 625, y: 0, text: 'USB LOST' }], bounds).labels;
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
    ).labels;
    const t = out.find((l) => l.id === 't')!;
    expect(Math.abs(t.y - 22)).toBeLessThanOrEqual(14);
    expect(overlapping(out)).toBe(false);
    // Never struck through by the marker line at x = 50.
    expect(t.box.x0 > 51 || t.box.x1 < 49).toBe(true);
  });

  it('collapses a burst of events on one spot into "+N EVENTS"', () => {
    // 11 events within 70 ms land on the same pixel.
    const items: AnnotationInput[] = [
      ...Array.from({ length: 9 }, (_, n) => ({ id: `u${n}`, kind: 'marker' as const, x: 300 + (n % 3), y: 0, text: 'USB UP', short: 'UP', priority: 1 })),
      { id: 'reset', kind: 'marker', x: 301, y: 0, text: 'USB RESET', short: 'RESET', priority: 3 },
      { id: 'drop', kind: 'marker', x: 300, y: 0, text: 'POWER DROP', short: 'DROP', priority: 4 },
    ];
    const { labels, hidden } = layoutAnnotations(items, bounds);
    expect(labels.map((l) => l.text)).toEqual(['POWER DROP', 'USB RESET', '+9 EVENTS']);
    expect(hidden).toBe(0);
    expect(overlapping(labels)).toBe(false);
    expect(insideAll(labels, bounds)).toBe(true);
  });

  it('never overlaps under random load, and accounts for every marker', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 200; round++) {
      const n = 1 + Math.floor(rand() * 40);
      const items: AnnotationInput[] = Array.from({ length: n }, (_, k) => ({
        id: `${round}-${k}`,
        kind: 'marker' as const,
        x: bounds.left + rand() * (bounds.right - bounds.left),
        y: 0,
        text: rand() > 0.5 ? 'USB LOST' : 'POWER DROP',
        short: 'EV',
        priority: Math.floor(rand() * 4),
      }));
      items.push({ id: 't', kind: 'threshold', x: 0, y: bounds.top + rand() * 150, text: 'UNDERVOLTAGE 4.75 V', short: '4.75 V' });
      const { labels, hidden } = layoutAnnotations(items, bounds, { compact: rand() > 0.5 });
      expect(overlapping(labels)).toBe(false);
      expect(insideAll(labels, bounds)).toBe(true);
      const explicit = labels.filter((l) => l.kind === 'marker').length;
      const collapsed = labels.filter((l) => l.kind === 'overflow').reduce((sum, l) => sum + Number(/\+(\d+)/.exec(l.text)![1]), 0);
      expect(explicit + collapsed + hidden).toBe(n);
    }
  });

  it('gives up on text only when not even "+N" fits, and reports it', () => {
    const tight: Bounds = { left: 0, right: 20, top: 0, bottom: 12 };
    const items: AnnotationInput[] = Array.from({ length: 5 }, (_, n) => ({ id: String(n), kind: 'marker' as const, x: 10, y: 0, text: 'USB DISCONNECTED', short: 'LOST' }));
    const { labels, hidden } = layoutAnnotations(items, tight, { lanes: 1 });
    expect(overlapping(labels)).toBe(false);
    expect(labels.length + hidden).toBeGreaterThan(0);
  });

  it('prefers short text in compact mode', () => {
    const [l] = layoutAnnotations([{ id: 'a', kind: 'marker', x: 100, y: 0, text: 'USB LOST', short: 'LOST' }], bounds, {
      compact: true,
    }).labels;
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
