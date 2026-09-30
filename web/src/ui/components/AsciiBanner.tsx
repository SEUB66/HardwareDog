import { BANNER } from '../../core/ascii';

const W = 9;
const H = 18;
const GAP = 1.6; // half distance between the two strokes of a double line

/**
 * Draws the ASCII banner from its own character grid.
 *
 * Web fonts rarely ship block and box-drawing glyphs, so the browser mixes
 * in fallback fonts and the banner breaks apart. Rendering the same grid
 * as geometry keeps it identical everywhere and still 1-bit friendly:
 * '█' becomes a cell, the double-line box characters become its shadow.
 */
export function AsciiBanner({ text = BANNER, scale = 1, label = 'HW DOG' }: { text?: string; scale?: number; label?: string }) {
  const rows = text.split('\n');
  const cols = Math.max(...rows.map((r) => [...r].length));
  const blocks: string[] = [];
  const lines: string[] = [];

  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const x0 = x * W;
      const y0 = y * H;
      const cx = x0 + W / 2;
      const cy = y0 + H / 2;
      const r = x0 + W;
      const b = y0 + H;
      const hLine = (from: number, to: number) => {
        lines.push(`M${from} ${cy - GAP}H${to}`, `M${from} ${cy + GAP}H${to}`);
      };
      const vLine = (from: number, to: number) => {
        lines.push(`M${cx - GAP} ${from}V${to}`, `M${cx + GAP} ${from}V${to}`);
      };
      switch (ch) {
        case '█':
          blocks.push(`M${x0} ${y0}h${W}v${H}h${-W}z`);
          break;
        case '═':
          hLine(x0, r);
          break;
        case '║':
          vLine(y0, b);
          break;
        case '╔':
          lines.push(`M${r} ${cy - GAP}H${cx - GAP}V${b}`, `M${r} ${cy + GAP}H${cx + GAP}V${b}`);
          break;
        case '╗':
          lines.push(`M${x0} ${cy - GAP}H${cx + GAP}V${b}`, `M${x0} ${cy + GAP}H${cx - GAP}V${b}`);
          break;
        case '╚':
          lines.push(`M${r} ${cy + GAP}H${cx - GAP}V${y0}`, `M${r} ${cy - GAP}H${cx + GAP}V${y0}`);
          break;
        case '╝':
          lines.push(`M${x0} ${cy + GAP}H${cx + GAP}V${y0}`, `M${x0} ${cy - GAP}H${cx - GAP}V${y0}`);
          break;
      }
    });
  });

  const width = cols * W;
  const height = rows.length * H;
  return (
    <svg
      class="ascii-banner"
      viewBox={`0 0 ${width} ${height}`}
      width={width * scale}
      height={height * scale}
      role="img"
      aria-label={label}
      shape-rendering="crispEdges"
    >
      <path d={lines.join('')} fill="none" stroke="var(--text-dim)" stroke-width="1" />
      <path d={blocks.join('')} fill="var(--text)" />
    </svg>
  );
}
