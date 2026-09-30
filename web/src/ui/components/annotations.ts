/**
 * Chart annotation layout.
 *
 * Contract: NO UNCONTROLLED OVERLAP. With live data, enough events can
 * always land on the same pixel to make "label everything" impossible,
 * so the layout degrades in a fixed order instead of overlapping:
 *
 *   1. priority    important events are placed first
 *   2. stagger     other side of the line, then lower lanes
 *   3. clamp       every label stays inside the plot
 *   4. abbreviate  the short text, through the same positions
 *   5. collapse    a cluster keeps its top labels and becomes "+N EVENTS"
 *
 * Only if even "+N" has no free position is a cluster left unlabeled, and
 * that is reported through `hidden`. Pure function: geometry in,
 * positions out, unit tested.
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
  /** Higher is more important. Default 0. */
  priority?: number;
}

export interface PlacedLabel {
  id: string;
  kind: AnnotationInput['kind'] | 'overflow';
  text: string;
  /** Text baseline origin. */
  x: number;
  y: number;
  anchor: 'start' | 'end';
  /** Occupied rectangle, for tests and debugging. */
  box: Rect;
}

export interface LayoutResult {
  labels: PlacedLabel[];
  /** Markers whose text could not be shown at all, not even as "+N". */
  hidden: number;
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
  /** Rendered height of one label: ascent + descent of the label font. */
  lineHeight: number;
  /** Space below the baseline taken by descenders. */
  descent: number;
  /** Gap between a label and its line. */
  pad: number;
  /** Maximum stacked lanes for markers. */
  lanes: number;
  /** Prefer the short text from the start (narrow charts). */
  compact: boolean;
  /** Markers closer than this (px) form one cluster. */
  clusterGap: number;
  /** Individual labels kept per cluster before collapsing into "+N". */
  perCluster: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  // IBM Plex Mono at 10 px: 6.0 px advance, ~10.3 px ascent, ~2.7 px descent.
  charWidth: 6.1,
  lineHeight: 14,
  descent: 3,
  pad: 3,
  lanes: 3,
  compact: false,
  clusterGap: 8,
  perCluster: 2,
};

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (r: Rect, b: Bounds) => r.x0 >= b.left && r.x1 <= b.right && r.y0 >= b.top && r.y1 <= b.bottom;

export function layoutAnnotations(
  items: AnnotationInput[],
  bounds: Bounds,
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const o = { ...DEFAULT_LAYOUT, ...options };
  const labels: PlacedLabel[] = [];
  const taken: Rect[] = [];
  let hidden = 0;
  const markers = items.filter((i) => i.kind === 'marker').sort((a, b) => a.x - b.x);
  // Threshold labels also keep clear of marker lines, so a value like
  // "4.75 V" is never struck through by an event line.
  const lines: Rect[] = markers.map((i) => ({ x0: i.x - 1, y0: bounds.top, x1: i.x + 1, y1: bounds.bottom }));

  const place = (item: AnnotationInput, texts: string[], kind: PlacedLabel['kind']): PlacedLabel | null => {
    for (const text of texts) {
      const w = text.length * o.charWidth;
      for (const c of candidates(item, w, bounds, o)) {
        const box = { x0: c.x0, y0: c.baseline - o.lineHeight + o.descent, x1: c.x0 + w, y1: c.baseline + o.descent };
        if (!inside(box, bounds) || taken.some((t) => overlaps(t, box))) continue;
        if (item.kind === 'threshold' && lines.some((l) => overlaps(l, box))) continue;
        const label: PlacedLabel = { id: item.id, kind, text, x: c.anchor === 'start' ? box.x0 : box.x1, y: c.baseline, anchor: c.anchor, box };
        labels.push(label);
        taken.push(box);
        return label;
      }
    }
    return null;
  };
  const textsOf = (item: AnnotationInput) =>
    o.compact && item.short ? [item.short] : item.short ? [item.text, item.short] : [item.text];
  const unplace = (label: PlacedLabel) => {
    labels.splice(labels.indexOf(label), 1);
    taken.splice(taken.indexOf(label.box), 1);
  };

  // Thresholds first: they belong to fixed lines and have fewer options.
  for (const t of items.filter((i) => i.kind === 'threshold')) place(t, textsOf(t), 'threshold');

  // Markers, cluster by cluster, left to right.
  const clusters: AnnotationInput[][] = [];
  for (const m of markers) {
    const last = clusters.at(-1);
    if (last && m.x - last.at(-1)!.x < o.clusterGap) last.push(m);
    else clusters.push([m]);
  }

  for (const cluster of clusters) {
    const ranked = [...cluster].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.x - b.x);
    const shown: PlacedLabel[] = [];
    for (const m of ranked) {
      if (shown.length >= o.perCluster) break;
      const l = place(m, textsOf(m), 'marker');
      if (l) shown.push(l);
    }
    let rest = cluster.length - shown.length;
    // Collapse: "+N EVENTS" for the rest; free a slot if it does not fit.
    while (rest > 0) {
      const anchor = cluster.reduce((a, b) => (b.x > a.x ? b : a));
      const overflow = place(
        { id: `+${anchor.id}`, kind: 'marker', x: anchor.x, y: 0, text: `+${rest} EVENTS` },
        o.compact ? [`+${rest}`] : [`+${rest} EVENTS`, `+${rest}`],
        'overflow',
      );
      if (overflow) break;
      const drop = shown.pop();
      if (!drop) {
        hidden += rest;
        break;
      }
      unplace(drop);
      rest++;
    }
  }
  return { labels, hidden };
}

interface Candidate {
  x0: number;
  baseline: number;
  anchor: 'start' | 'end';
}

function* candidates(item: AnnotationInput, w: number, b: Bounds, o: LayoutOptions): Generator<Candidate> {
  if (item.kind === 'threshold') {
    // Attached to the line: above it, then below it; left end, then right end.
    const above = item.y - o.pad - o.descent;
    const below = item.y + o.pad + o.lineHeight - o.descent;
    for (const baseline of [above, below]) {
      yield { x0: b.left + o.pad, baseline, anchor: 'start' };
      yield { x0: b.right - o.pad - w, baseline, anchor: 'end' };
    }
    return;
  }
  // Markers: lanes from the top of the plot, right of the line then left of it.
  for (let lane = 0; lane < o.lanes; lane++) {
    const baseline = b.top + o.lineHeight - o.descent + lane * (o.lineHeight + 1);
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
