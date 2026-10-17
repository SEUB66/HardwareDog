/**
 * Bytes as an engineer reads them: offset, hex, printable ASCII. Compared
 * to another buffer, the bytes that differ are marked (and named in the
 * title of each byte, so color is never the only sign).
 */

const h2 = (b: number) => b.toString(16).toUpperCase().padStart(2, '0');
const ascii = (b: number) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·');

export function HexView({ bytes, compare, width = 16, max = 4096, label }: { bytes: Uint8Array; compare?: Uint8Array | null; width?: number; max?: number; label?: string }) {
  const shown = bytes.subarray(0, max);
  const rows: number[] = [];
  for (let i = 0; i < shown.length; i += width) rows.push(i);
  const changed = (i: number) => compare != null && (i >= compare.length || compare[i] !== bytes[i]);
  const diffCount = compare ? [...shown].reduce((n, _, i) => n + (changed(i) ? 1 : 0), 0) + Math.max(0, compare.length - bytes.length) : 0;
  return (
    <div class="hex" role="group" aria-label={label ?? 'bytes'}>
      <div class="hex-meta">
        {bytes.length} byte(s)
        {compare ? ` · ${diffCount} differ from the reference (${compare.length} bytes), marked ▲` : ''}
        {bytes.length > max ? ` · first ${max} shown` : ''}
      </div>
      {bytes.length === 0 ? (
        <div class="hex-row dim">(empty)</div>
      ) : (
        rows.map((at) => (
          <div class="hex-row" key={at}>
            <span class="hex-off">{at.toString(16).toUpperCase().padStart(4, '0')}</span>
            <span class="hex-bytes">
              {[...shown.subarray(at, at + width)].map((b, j) => {
                const i = at + j;
                const d = changed(i);
                return (
                  <span key={i} class={d ? 'hex-b diff' : 'hex-b'} title={`byte ${i}: 0x${h2(b)} = ${b}${d ? ` (reference: ${compare && i < compare.length ? `0x${h2(compare[i]!)}` : 'absent'})` : ''}`}>
                    {h2(b)}
                    {d ? '▲' : ''}
                  </span>
                );
              })}
            </span>
            <span class="hex-ascii">{[...shown.subarray(at, at + width)].map(ascii).join('')}</span>
          </div>
        ))
      )}
    </div>
  );
}
