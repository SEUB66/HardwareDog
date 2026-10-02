/*
 * HARDWARE DOG / CALIBRATION (LVL 65)
 *
 * The device declares what its power numbers are worth (power.meter). A
 * calibration compares it with a reference instrument (a multimeter on the
 * same rail, the same load) at a few points, fits a gain (and an offset for
 * the current), and stores it on the device with the largest residual seen.
 *
 * DIAGNOSTIC MEASUREMENT, NOT CERTIFIED METROLOGY. A calibration against a
 * bench multimeter is worth what that multimeter is worth: its name is
 * stored with the calibration and shown with every number.
 */
import type { ErrorBound, MeterCalCommand, MeterCalibration } from './protocol';

/** One comparison: what Hardware Dog measured before calibration, what the reference read. */
export interface CalPoint {
  rawV: number;
  rawI: number;
  refV: number;
  refI: number;
}

export const CAL_LIMITS = { gainMin: 0.9, gainMax: 1.1, offsetMax: 0.05 } as const;

/** Points closer than this in current cannot fix an offset: gain only. */
const OFFSET_SPREAD_A = 0.05;

export type CalFit = { ok: true; fit: Omit<MeterCalCommand, 'date' | 'ref'> } | { ok: false; error: string };

/** What the device would have measured without its current calibration. */
export function rawOf(v: number, i: number, cal: MeterCalibration | null): { v: number; i: number } {
  if (!cal) return { v, i };
  return { v: v / cal.v_gain, i: (i - cal.i_offset) / cal.i_gain };
}

/** Largest error expected on a reading: pct % of it + abs. */
export function uncertainty(value: number, bound: ErrorBound): number {
  return (Math.abs(value) * bound.pct) / 100 + bound.abs;
}

/**
 * Voltage: gain through zero (the INA226 bus offset is a few mV, below what
 * a bench comparison resolves). Current: gain and offset when the points
 * span enough current, else gain only.
 */
export function fitCalibration(points: readonly CalPoint[]): CalFit {
  if (points.length < 2) return { ok: false, error: `need at least 2 points, have ${points.length}` };
  for (const p of points) {
    if (![p.rawV, p.rawI, p.refV, p.refI].every(Number.isFinite)) return { ok: false, error: 'a point is not a number' };
    if (p.rawV <= 0 || p.refV <= 0) return { ok: false, error: 'voltage points must be above 0 V' };
  }

  const vGain = sum(points, (p) => p.rawV * p.refV) / sum(points, (p) => p.rawV * p.rawV);

  const minI = Math.min(...points.map((p) => p.rawI));
  const maxI = Math.max(...points.map((p) => p.rawI));
  let iGain: number;
  let iOffset: number;
  if (maxI - minI >= OFFSET_SPREAD_A) {
    const n = points.length;
    const mx = sum(points, (p) => p.rawI) / n;
    const my = sum(points, (p) => p.refI) / n;
    iGain = sum(points, (p) => (p.rawI - mx) * (p.refI - my)) / sum(points, (p) => (p.rawI - mx) ** 2);
    iOffset = my - iGain * mx;
  } else {
    const ss = sum(points, (p) => p.rawI * p.rawI);
    if (ss === 0) return { ok: false, error: 'no current flowing: put a load on the rail' };
    iGain = sum(points, (p) => p.rawI * p.refI) / ss;
    iOffset = 0;
  }

  const disagree = (g: number) => g < CAL_LIMITS.gainMin || g > CAL_LIMITS.gainMax;
  if (disagree(vGain) || disagree(iGain)) {
    return { ok: false, error: 'Hardware Dog and the reference disagree by more than 10 %: check the wiring and the reference. Nothing stored.' };
  }
  if (Math.abs(iOffset) > CAL_LIMITS.offsetMax) {
    return { ok: false, error: 'current offset above 50 mA: check the wiring and the reference. Nothing stored.' };
  }

  const vErr = Math.max(...points.map((p) => Math.abs(p.refV - p.rawV * vGain)));
  const iErr = Math.max(...points.map((p) => Math.abs(p.refI - (p.rawI * iGain + iOffset))));
  return { ok: true, fit: { v_gain: round(vGain, 6), i_gain: round(iGain, 6), i_offset: round(iOffset, 6), v_err: round(vErr, 6), i_err: round(iErr, 6) } };
}

const sum = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const round = (x: number, digits: number) => Number(x.toFixed(digits));
