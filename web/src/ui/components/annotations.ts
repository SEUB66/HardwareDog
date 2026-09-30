/**
 * Chart annotation layout.
 *
 * Places text labels for event markers and threshold lines so that no two
 * labels overlap and every label stays inside the plot. Pure function:
 * geometry in, positions out, so it is unit tested and reused by every
 * chart as more event types appear.
 *
 * Strategy, in order, for each label:
 *   1. preferred position
 *   2. other side of its anchor (markers flip left / right)
 *   3. next lane (markers stack downward from the top)
 *   4. the short text, through the same positions
 *   5. hidden: the line stays, the text is dropped. Never an overlap.
 */

export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AnnotationInput {
  id: string;
  kind: 'marker' | 'threshold';
  /** Marker: x of the vertical line. Threshold: ignored. */
  x: number;
  /** Threshold: y of the horizontal line. Marker: ignored. */
  y: number;
  text: string;
  /** Shorter form used when the full text does not fit. */
  short?: string;
}

export interface PlacedLabel {
  id: string;
  kind: AnnotationInput['kind'];
  text: string;
  /** Text baseline origin. */
  x: number;
  y: number;
  anchor: 'start' | 'end';
  /** Occupied rectangle, for tests and debugging. */
  box: Rect;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutOptions {
  /** Advance width of one character at the label font size. */
  charWidth: number;
  /** Height of one text line (cap height + descender). */
  lineHeight: number;
  /** Gap between a label and its line. */
  pad: number;
  /** Maximum stacked lanes for markers. */
  lanes: number;
  /** Prefer the short text from the start (narrow charts). */
  compact: boolean;
}

export const DEFAULT_LAYOUT: LayoutOptions = { charWidth: 6.1, lineHeight: 11, pad: 3, lanes: 3, compact: false };

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (r: Rect, b: Bounds) => r.x0 >= b.left && r.x1 <= b.right && r.y0 >= b.top && r.y1 <= b.bottom;

export function layoutAnnotations(
  items: AnnotationInput[],
  bounds: Bounds,
  options: Partial<LayoutOptions> = {},
): PlacedLabel[] {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const placed: PlacedLabel[] = [];
  const taken: Rect[] = [];
  // Threshold labels also keep clear of marker lines, so a value like
  // "4.75 V" is never struck through by an event line.
  const lines: Rect[] = items
    .filter((i) => i.kind === 'marker')
    .map((i) => ({ x0: i.x - 1, y0: bounds.top, x1: i.x + 1, y1: bounds.bottom }));

  // Thresholds first: they belong to fixed lines and have fewer options.
  const ordered = [...items.filter((i) => i.kind === 'threshold'), ...items.filter((i) => i.kind === 'marker').sort((a, b) => a.x - b.x)];

  for (const item of ordered) {
    const texts = o.compact && item.short ? [item.short] : item.short ? [item.text, item.short] : [item.text];
    let done: PlacedLabel | null = null;

    for (const text of texts) {
      const w = text.length * o.charWidth;
      for (const c of candidates(item, w, bounds, o)) {
        const box = { x0: c.x0, y0: c.baseline - o.lineHeight + 2, x1: c.x0 + w, y1: c.baseline + 2 };
        if (!inside(box, bounds) || taken.some((t) => overlaps(t, box))) continue;
        if (item.kind === 'threshold' && lines.some((l) => overlaps(l, box))) continue;
        done = {
          id: item.id,
          kind: item.kind,
          text,
          x: c.anchor === 'start' ? box.x0 : box.x1,
          y: c.baseline,
          anchor: c.anchor,
          box,
        };
        break;
      }
      if (done) break;
    }

    if (done) {
      placed.push(done);
      taken.push(done.box);
    }
  }
  return placed;
}

interface Candidate {
  x0: number;
  baseline: number;
  anchor: 'start' | 'end';
}

function* candidates(item: AnnotationInput, w: number, b: Bounds, o: LayoutOptions): Generator<Candidate> {
  if (item.kind === 'threshold') {
    // Attached to the line: above it, then below it; left end, then right end.
    const above = item.y - o.pad;
    const below = item.y + o.pad + o.lineHeight - 2;
    for (const baseline of [above, below]) {
      yield { x0: b.left + o.pad, baseline, anchor: 'start' };
      yield { x0: b.right - o.pad - w, baseline, anchor: 'end' };
    }
    return;
  }
  // Markers: lanes from the top of the plot, right of the line then left of it.
  for (let lane = 0; lane < o.lanes; lane++) {
    const baseline = b.top + o.lineHeight - 2 + lane * (o.lineHeight + 1);
    yield { x0: item.x + o.pad, baseline, anchor: 'start' };
    yield { x0: item.x - o.pad - w, baseline, anchor: 'end' };
  }
}

/** Evenly spaced time ticks with at least `minGap` px between labels. */
export function timeTicks(start: number, end: number, plotWidth: number, minGap: number): number[] {
  const span = end - start;
  const steps = [1000, 2000, 3000, 5000, 10_000, 15_000, 30_000, 60_000];
  const step = steps.find((s) => (s / span) * plotWidth >= minGap) ?? steps[steps.length - 1]!;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  return ticks;
}
