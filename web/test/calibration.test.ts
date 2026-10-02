import { describe, expect, it } from 'vitest';
import { fitCalibration, rawOf, uncertainty } from '../src/core/calibration';
import type { DeviceFrame } from '../src/core/protocol';
import { connectedSystem } from './helpers';

const METER: DeviceFrame = {
  type: 'power.meter',
  t: 1,
  sensor: 'INA226',
  shunt_ohm: 0.1,
  v_max: 36,
  i_max: 0.8,
  v_res: 0.00125,
  i_res: 0.0000245,
  rate_hz: 50,
  v_err: { pct: 0.1, abs: 0.0075 },
  i_err: { pct: 1.1, abs: 0.0001 },
  basis: 'DATASHEET',
  cal: null,
};

describe('LVL 65: calibration against a reference instrument', () => {
  it('recovers a known gain and offset from three points', () => {
    // The device reads 0.5 % low on voltage, 2 % high on current with a 1 mA offset.
    const truth = [
      { v: 5.0, i: 0.002 },
      { v: 4.95, i: 0.1 },
      { v: 4.8, i: 0.5 },
    ];
    const points = truth.map((x) => ({ refV: x.v, refI: x.i, rawV: x.v / 1.005, rawI: (x.i - 0.001) / 0.98 }));
    const r = fitCalibration(points);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fit.v_gain).toBeCloseTo(1.005, 5);
    expect(r.fit.i_gain).toBeCloseTo(0.98, 5);
    expect(r.fit.i_offset).toBeCloseTo(0.001, 5);
    expect(r.fit.v_err).toBeLessThan(1e-5);
    expect(r.fit.i_err).toBeLessThan(1e-5);
  });

  it('reports the largest residual, not a made-up accuracy', () => {
    const r = fitCalibration([
      { rawV: 5, rawI: 0.1, refV: 5.01, refI: 0.1 },
      { rawV: 4.8, rawI: 0.5, refV: 4.8, refI: 0.503 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fit.v_err).toBeGreaterThan(0.004);
      expect(r.fit.v_err).toBeLessThan(0.01);
    }
  });

  it('uses gain only when the points do not span enough current', () => {
    const r = fitCalibration([
      { rawV: 5, rawI: 0.1, refV: 5, refI: 0.101 },
      { rawV: 4.9, rawI: 0.11, refV: 4.9, refI: 0.111 },
    ]);
    expect(r.ok && r.fit.i_offset).toBe(0);
  });

  it('refuses what cannot be a calibration', () => {
    expect(fitCalibration([{ rawV: 5, rawI: 0.1, refV: 5, refI: 0.1 }])).toMatchObject({ ok: false });
    expect(fitCalibration([
      { rawV: 5, rawI: 0.1, refV: 6, refI: 0.1 },
      { rawV: 4, rawI: 0.5, refV: 4.8, refI: 0.5 },
    ])).toMatchObject({ ok: false, error: expect.stringMatching(/10 %/) });
    expect(fitCalibration([
      { rawV: 5, rawI: 0, refV: 5, refI: 0 },
      { rawV: 4.9, rawI: 0, refV: 4.9, refI: 0 },
    ])).toMatchObject({ ok: false, error: expect.stringMatching(/load/) });
  });

  it('undoes the calibration in place to get the raw reading back', () => {
    const cal = { date: '2026-10-02', ref: 'X', v_gain: 1.01, i_gain: 0.98, i_offset: 0.001 };
    const raw = rawOf(5.05, 0.099, cal);
    expect(raw.v).toBeCloseTo(5, 9);
    expect(raw.i).toBeCloseTo(0.1, 9);
    expect(uncertainty(5, { pct: 0.1, abs: 0.0075 })).toBeCloseTo(0.0125, 9);
  });

  it('end to end: points from the live rail, fit, sent to the device', async () => {
    const { sys, transport, clock } = await connectedSystem();
    expect(sys.addCalPoint(5, 0.1)).toMatch(/power.meter/);
    transport.push(METER);
    expect(sys.meter?.basis).toBe('DATASHEET');
    const feed = (t0: number, v: number, i: number) => {
      for (let k = 0; k < 50; k++) {
        clock.set(1_000_000 + t0 + k * 20);
        transport.push({ type: 'power', t: t0 + k * 20, v, i });
      }
    };
    feed(1000, 4.975, 0.1); // reference: 5.000 V 0.101 A
    expect(sys.addCalPoint(5, 0.101)).toBeNull();
    feed(3000, 4.776, 0.49); // reference: 4.800 V 0.500 A
    expect(sys.addCalPoint(4.8, 0.5)).toBeNull();
    expect(sys.applyCalibration('Fluke 87V', '2026-10-02')).toBeNull();
    const sent = transport.sent.at(-1);
    expect(sent).toMatchObject({ cmd: 'meter.cal', ref: 'Fluke 87V', date: '2026-10-02' });
    if (sent?.cmd === 'meter.cal') expect(sent.v_gain).toBeCloseTo(1.005, 3);
    expect(sys.calPoints).toEqual([]);
    // A rebooted device has not declared its meter yet.
    transport.push({ type: 'hello', t: 0, proto: 1, device: 'HD-001', rev: 'A', fw: '0.1.0' });
    expect(sys.meter).toBeNull();
  });
});
