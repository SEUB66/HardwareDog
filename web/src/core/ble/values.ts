/**
 * HARDWARE DOG / BYTE VALUES
 *
 * Reading and writing numbers with the byte order said out loud: u16le is
 * not u16be, and the screen always names which one it shows. A text typed
 * for a write is parsed into bytes and previewed before anything is sent.
 */

export const VALUE_FORMATS = ['hex', 'utf8', 'u8', 's8', 'u16le', 'u16be', 's16le', 's16be', 'u32le', 'u32be', 's32le', 's32be', 'f32le', 'f32be'] as const;
export type ValueFormat = (typeof VALUE_FORMATS)[number];

const width: Partial<Record<ValueFormat, number>> = { u8: 1, s8: 1, u16le: 2, u16be: 2, s16le: 2, s16be: 2, u32le: 4, u32be: 4, s32le: 4, s32be: 4, f32le: 4, f32be: 4 };

export const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Every value of this format in the bytes; a tail too short for one more is said, not padded. */
export function formatValue(b: Uint8Array, f: ValueFormat): string {
  if (f === 'hex') return toHex(b) || '(empty)';
  if (f === 'utf8') {
    try {
      return JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(b));
    } catch {
      return 'not valid UTF-8';
    }
  }
  const w = width[f]!;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = f.endsWith('le');
  const out: string[] = [];
  let i = 0;
  for (; i + w <= b.length; i += w) {
    switch (f) {
      case 'u8':
        out.push(String(dv.getUint8(i)));
        break;
      case 's8':
        out.push(String(dv.getInt8(i)));
        break;
      case 'u16le':
      case 'u16be':
        out.push(String(dv.getUint16(i, le)));
        break;
      case 's16le':
      case 's16be':
        out.push(String(dv.getInt16(i, le)));
        break;
      case 'u32le':
      case 'u32be':
        out.push(String(dv.getUint32(i, le)));
        break;
      case 's32le':
      case 's32be':
        out.push(String(dv.getInt32(i, le)));
        break;
      case 'f32le':
      case 'f32be':
        out.push(String(dv.getFloat32(i, le)));
        break;
    }
  }
  if (i < b.length) out.push(`(+${b.length - i} byte(s) left over)`);
  return out.join(', ') || '(too short)';
}

/** Parse what the operator typed into bytes. Throws with the reason; never sends a guess. */
export function parseValue(text: string, f: ValueFormat): Uint8Array {
  const t = text.trim();
  if (f === 'hex') {
    const clean = t.replace(/0x/gi, '').replace(/[\s,:-]+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error('hex: pairs of hex digits, e.g. 01 A0 FF');
    return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
  }
  if (f === 'utf8') return new TextEncoder().encode(text);
  const w = width[f]!;
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error('no value');
  const out = new Uint8Array(parts.length * w);
  const dv = new DataView(out.buffer);
  const le = f.endsWith('le');
  parts.forEach((p, k) => {
    const n = Number(p);
    if (!Number.isFinite(n)) throw new Error(`"${p}" is not a number`);
    const i = k * w;
    const int = (min: number, max: number) => {
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${p}" is outside ${min}..${max} for ${f}`);
      return n;
    };
    switch (f) {
      case 'u8':
        dv.setUint8(i, int(0, 255));
        break;
      case 's8':
        dv.setInt8(i, int(-128, 127));
        break;
      case 'u16le':
      case 'u16be':
        dv.setUint16(i, int(0, 0xffff), le);
        break;
      case 's16le':
      case 's16be':
        dv.setInt16(i, int(-0x8000, 0x7fff), le);
        break;
      case 'u32le':
      case 'u32be':
        dv.setUint32(i, int(0, 0xffffffff), le);
        break;
      case 's32le':
      case 's32be':
        dv.setInt32(i, int(-0x80000000, 0x7fffffff), le);
        break;
      case 'f32le':
      case 'f32be': {
        // f32 holds about ±3.4e38 down to 1.4e-45: past either end the device would get Infinity or 0.
        dv.setFloat32(i, n, le);
        const kept = dv.getFloat32(i, le);
        if (!Number.isFinite(kept)) throw new Error(`"${p}" is too large for ${f} (largest ±3.4e38)`);
        if (kept === 0 && n !== 0) throw new Error(`"${p}" is too small for ${f}: it would be sent as 0`);
        break;
      }
    }
  });
  return out;
}
