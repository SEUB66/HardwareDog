/** Formatting helpers. Units are always explicit; missing data is always "--". */

export const NO_VALUE = '--';

const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');

/** 12:42:01.002 */
export function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 12:42:01 */
export function clockShort(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 00:14:22 — durations can exceed 24 h, hours are not wrapped. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

export function volts(v: number | null, digits = 2): string {
  return v === null ? NO_VALUE : `${v.toFixed(digits)} V`;
}

export function milliamps(a: number | null): string {
  return a === null ? NO_VALUE : `${Math.round(a * 1000)} mA`;
}

export function amps(a: number | null, digits = 3): string {
  return a === null ? NO_VALUE : `${a.toFixed(digits)} A`;
}

export function watts(w: number | null, digits = 3): string {
  return w === null ? NO_VALUE : `${w.toFixed(digits)} W`;
}

export function hex(n: number | null, width = 4): string {
  return n === null ? NO_VALUE : n.toString(16).toUpperCase().padStart(width, '0');
}

export function i2cAddress(n: number): string {
  return `0x${n.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function frequency(hz: number | null): string {
  if (hz === null) return NO_VALUE;
  if (hz >= 1_000_000) return `${hz / 1_000_000} MHz`;
  if (hz >= 1000) return `${hz / 1000} kHz`;
  return `${hz} Hz`;
}

export function ms(n: number | null): string {
  return n === null ? NO_VALUE : `${Math.round(n)} ms`;
}

export function percent(n: number | null, digits = 1): string {
  return n === null ? NO_VALUE : `${n.toFixed(digits)}%`;
}

/** HD-20260930-1421 */
export function sessionId(t: number): string {
  const d = new Date(t);
  return `HD-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
