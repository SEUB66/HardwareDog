import { useEffect, useRef, useState } from 'preact/hooks';
import { clock, clockShort } from '../../core/format';
import type { PowerSample } from '../../core/types';

export interface ChartMarker {
  t: number;
  label: string;
}

interface SignalChartProps {
  title: string;
  unit: string;
  samples: PowerSample[];
  pick: (s: PowerSample) => number;
  format: (value: number) => string;
  /** Fixed scale. Expands only if the signal leaves it, never shrinks to fit. */
  domain: [number, number];
  step: number;
  tickLabel: (value: number) => string;
  threshold?: { value: number; label: string };
  markers?: ChartMarker[];
  /** Right edge of the time axis (host ms). */
  end: number;
  windowMs: number;
  height?: number;
}

const M = { left: 46, right: 10, top: 10, bottom: 22 };

/**
 * Oscilloscope-style trace: thin grid, sharp line, real units, fixed scale.
 * No smoothing. When there are more samples than pixels, each pixel column
 * keeps its min and max so a 20 ms dip can never be averaged away.
 */
export function SignalChart(props: SignalChartProps) {
  const { samples, pick, domain, step, threshold, markers = [], end, windowMs, height = 190 } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [cursor, setCursor] = useState<PowerSample | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = end - windowMs;
  const visible = samples.filter((s) => s.t >= start && s.t <= end);
  const values = visible.map(pick);
  let [lo, hi] = domain;
  for (const v of values) {
    if (v < lo) lo = Math.floor(v / step) * step;
    if (v > hi) hi = Math.ceil(v / step) * step;
  }

  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - start) / windowMs) * plotW;
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * plotH;

  // Peak-detect decimation: per pixel column keep first, min, max, last.
  const points: string[] = [];
  let col = -1;
  let bucket: { x: number; min: number; max: number; first: number; last: number } | null = null;
  const flush = () => {
    if (!bucket) return;
    const { x: bx, first, min, max, last } = bucket;
    points.push(`${bx},${y(first).toFixed(1)}`);
    if (min !== first && min !== last) points.push(`${bx},${y(min).toFixed(1)}`);
    if (max !== first && max !== last) points.push(`${bx},${y(max).toFixed(1)}`);
    if (last !== first) points.push(`${bx},${y(last).toFixed(1)}`);
  };
  visible.forEach((s, n) => {
    const v = values[n]!;
    const px = Math.round(x(s.t));
    if (px !== col) {
      flush();
      col = px;
      bucket = { x: px, min: v, max: v, first: v, last: v };
    } else if (bucket) {
      bucket.min = Math.min(bucket.min, v);
      bucket.max = Math.max(bucket.max, v);
      bucket.last = v;
    }
  });
  flush();

  const yTicks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(Math.round(v / step) * step);
  const xStep = windowMs <= 20_000 ? 3000 : 10_000;
  const xTicks: number[] = [];
  for (let t = Math.ceil(start / xStep) * xStep; t <= end; t += xStep) xTicks.push(t);

  const last = visible.at(-1);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const summary =
    last && min !== null && max !== null
      ? `${props.title}: now ${props.format(pick(last))}, min ${props.format(min)}, max ${props.format(max)} over the last ${windowMs / 1000} s`
      : `${props.title}: no signal`;

  const onMove = (e: PointerEvent) => {
    const svg = e.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const t = start + ((e.clientX - rect.left - M.left) / plotW) * windowMs;
    if (visible.length === 0 || t < start || t > end) return setCursor(null);
    let best = visible[0]!;
    for (const s of visible) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    setCursor(best);
  };

  return (
    <figure class="chart" style={{ margin: 0 }}>
      <header>
        <span class="title">{props.title}</span>
        <span>UNIT {props.unit}</span>
        <span>WINDOW {windowMs / 1000} s</span>
        <span>
          MIN {min === null ? '--' : props.format(min)} / MAX {max === null ? '--' : props.format(max)}
        </span>
        <span class="cursor" aria-live="off">
          {cursor ? `${clock(cursor.t)}  ${props.format(pick(cursor))}` : ''}
        </span>
      </header>
      <div ref={wrap}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          onPointerMove={onMove}
          onPointerLeave={() => setCursor(null)}
        >
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line class="gridline" x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
              <text class="tick-label" x={M.left - 6} y={y(v) + 3} text-anchor="end">
                {props.tickLabel(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={`x${t}`}>
              <line class="gridline" x1={x(t)} x2={x(t)} y1={M.top} y2={M.top + plotH} />
              <text class="tick-label" x={x(t)} y={height - 6} text-anchor="middle">
                {clockShort(t)}
              </text>
            </g>
          ))}
          <line class="axis" x1={M.left} x2={M.left} y1={M.top} y2={M.top + plotH} />
          <line class="axis" x1={M.left} x2={width - M.right} y1={M.top + plotH} y2={M.top + plotH} />

          {threshold && threshold.value >= lo && threshold.value <= hi && (
            <g>
              <line class="threshold" x1={M.left} x2={width - M.right} y1={y(threshold.value)} y2={y(threshold.value)} />
              <text class="threshold-label" x={M.left + 4} y={y(threshold.value) + 12}>
                {threshold.label}
              </text>
            </g>
          )}

          {markers
            .filter((m) => m.t >= start && m.t <= end)
            .map((m) => (
              <g key={`m${m.t}`}>
                <line class="marker" x1={x(m.t)} x2={x(m.t)} y1={M.top} y2={M.top + plotH} />
                <text class="marker-label" x={x(m.t) + 3} y={M.top + 9}>
                  {m.label}
                </text>
              </g>
            ))}

          {points.length > 1 && <polyline class="signal" points={points.join(' ')} />}

          {cursor && (
            <g>
              <line class="crosshair" x1={x(cursor.t)} x2={x(cursor.t)} y1={M.top} y2={M.top + plotH} />
              <circle class="dot" cx={x(cursor.t)} cy={y(pick(cursor))} r={4} />
            </g>
          )}
        </svg>
      </div>
    </figure>
  );
}
