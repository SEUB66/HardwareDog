/**
 * Hardware Dog wire protocol, version 1.
 *
 * Newline-delimited JSON over any byte stream (USB CDC serial today).
 * Device -> host frames carry `t`, the device uptime in milliseconds.
 * Host -> device commands carry `cmd`.
 *
 * The full specification lives in docs/PROTOCOL.md. This module is the
 * single place that turns untrusted bytes into typed frames: anything that
 * does not validate is reported, never guessed.
 */

import type { CheckStatus, Parity, ProbeTest, UsbSpeed } from './types';
import { PROBE_TESTS } from './types';

export const PROTOCOL_VERSION = 1;

/**
 * What a device can observe (hello.caps). A hello without caps means every
 * capability: devices made before caps. Silence about a capability the
 * device does not have is never read as an observation.
 */
export const CAPABILITIES = ['power', 'usb', 'uart', 'i2c', 'net', 'probe'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type DeviceFrame =
  | { type: 'hello'; t: number; proto: number; device: string; rev: string; fw: string; chip?: string; caps?: Capability[] }
  | { type: 'power'; t: number; v: number; i: number }
  | ({ type: 'power.meter'; t: number } & Meter)
  | {
      type: 'usb.attach';
      t: number;
      speed: UsbSpeed;
      vid: number;
      pid: number;
      cls: string;
      power: 'BUS' | 'SELF';
      manufacturer: string | null;
      product: string | null;
      serial: string | null;
    }
  | { type: 'usb.detach'; t: number }
  | { type: 'uart.config'; t: number; port: string; baud: number; bits: 7 | 8; parity: Parity; stop: 1 | 2 }
  | { type: 'uart.rx'; t: number; data: string }
  | { type: 'uart.error'; t: number; kind: string }
  | {
      type: 'i2c.scan';
      t: number;
      speed: number;
      devices: { addr: number; ident: string | null; method: string | null }[];
      /** The periodic scan this one belongs to; absent: a one-off scan. */
      every_ms?: number;
    }
  | { type: 'i2c.error'; t: number; kind: I2cErrorKind; detail: string | null; every_ms?: number }
  | {
      type: 'net.status';
      t: number;
      link: { up: boolean; mbps: number | null; duplex: 'FULL' | 'HALF' | null } | null;
      address: string | null;
      dhcp: CheckStatus;
      gateway: { address: string | null; status: CheckStatus };
      dns: { address: string | null; status: CheckStatus };
      internet: CheckStatus;
      latency: number | null;
      loss: number | null;
    }
  | { type: 'probe.result'; t: number; id: string; test: ProbeTest; status: CheckStatus; detail: string }
  | { type: 'probe.done'; t: number; id: string }
  | { type: 'log'; t: number; level: 'info' | 'warn' | 'error'; message: string }
  /** Answer to the time command: the device clock now, same id. */
  | { type: 'time'; t: number; id: number };

/** The capability a frame belongs to; null: any Dog may send it (log, hello, time). */
export function capabilityOf(type: DeviceFrame['type']): Capability | null {
  if (type === 'power' || type === 'power.meter') return 'power';
  if (type.startsWith('usb.')) return 'usb';
  if (type.startsWith('uart.')) return 'uart';
  if (type.startsWith('i2c.')) return 'i2c';
  if (type === 'net.status') return 'net';
  if (type === 'probe.result' || type === 'probe.done') return 'probe';
  return null;
}

export type HostCommand =
  | { cmd: 'hello'; proto: number }
  | { cmd: 'usb.enumerate' }
  | { cmd: 'usb.follow'; vid?: number; pid?: number; serial?: string; port?: string }
  | { cmd: 'uart.config'; baud: number }
  | { cmd: 'uart.tx'; data: string }
  | { cmd: 'i2c.scan' }
  | { cmd: 'i2c.watch'; every_ms: number }
  | { cmd: 'net.refresh' }
  | { cmd: 'net.watch'; every_ms: number; dns?: string; upstream?: string }
  | ({ cmd: 'meter.cal' } & MeterCalCommand)
  | { cmd: 'meter.clear' }
  | { cmd: 'probe'; id: string; target: string; tests: ProbeTest[] }
  | { cmd: 'time'; id: number };

/** |error| <= pct % of the reading + abs (unit of the quantity). */
export interface ErrorBound {
  pct: number;
  abs: number;
}

export interface MeterCalibration {
  date: string;
  /** Reference instrument the device was compared against. */
  ref: string;
  v_gain: number;
  i_gain: number;
  i_offset: number;
}

/** What the power numbers are worth (power.meter). */
export interface Meter {
  sensor: string;
  shunt_ohm: number;
  v_max: number;
  i_max: number;
  v_res: number;
  i_res: number;
  rate_hz: number;
  v_err: ErrorBound;
  i_err: ErrorBound;
  basis: 'DATASHEET' | 'CALIBRATION';
  cal: MeterCalibration | null;
}

export interface MeterCalCommand extends MeterCalibration {
  /** Largest residual seen against the reference (V, A). */
  v_err: number;
  i_err: number;
}

export const I2C_ERROR_KINDS = ['SDA_LOW', 'SCL_LOW', 'TIMEOUT', 'ARB_LOST'] as const;
export type I2cErrorKind = (typeof I2C_ERROR_KINDS)[number];

export type DecodeResult = { ok: true; frame: DeviceFrame } | { ok: false; error: string; raw: string };

const CHECK_STATUSES: readonly CheckStatus[] = ['PASS', 'WARN', 'FAIL', 'PENDING', 'UNKNOWN'];
const USB_SPEEDS: readonly UsbSpeed[] = ['LOW', 'FULL', 'HIGH', 'SUPER'];
const PARITIES: readonly Parity[] = ['NONE', 'EVEN', 'ODD'];

class FrameError extends Error {}

type Obj = Record<string, unknown>;

function num(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FrameError(`field "${k}" must be a finite number`);
  return v;
}

function numOrNull(o: Obj, k: string): number | null {
  return o[k] === null || o[k] === undefined ? null : num(o, k);
}

function str(o: Obj, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new FrameError(`field "${k}" must be a string`);
  return v;
}

function strOrNull(o: Obj, k: string): string | null {
  return o[k] === null || o[k] === undefined ? null : str(o, k);
}

function bool(o: Obj, k: string): boolean {
  const v = o[k];
  if (typeof v !== 'boolean') throw new FrameError(`field "${k}" must be a boolean`);
  return v;
}

function obj(o: Obj, k: string): Obj {
  const v = o[k];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FrameError(`field "${k}" must be an object`);
  return v as Obj;
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = typeof o[k] === 'string' ? (o[k] as string).toUpperCase() : o[k];
  if (!allowed.includes(v as T)) throw new FrameError(`field "${k}" must be one of ${allowed.join(', ')}`);
  return v as T;
}

function status(o: Obj, k: string): CheckStatus {
  return oneOf(o, k, CHECK_STATUSES);
}

function hop(o: Obj, k: string): { address: string | null; status: CheckStatus } {
  const h = obj(o, k);
  return { address: strOrNull(h, 'address'), status: status(h, 'status') };
}

function positive(o: Obj, k: string): number {
  const v = num(o, k);
  if (v <= 0) throw new FrameError(`field "${k}" must be positive`);
  return v;
}

function errorBound(o: Obj, k: string): ErrorBound {
  const e = obj(o, k);
  const pct = num(e, 'pct');
  const abs = num(e, 'abs');
  if (pct < 0 || abs < 0) throw new FrameError(`field "${k}" must not be negative`);
  return { pct, abs };
}

function calibration(o: Obj): MeterCalibration | null {
  if (o['cal'] === null || o['cal'] === undefined) return null;
  const c = obj(o, 'cal');
  return { date: str(c, 'date'), ref: str(c, 'ref'), v_gain: num(c, 'v_gain'), i_gain: num(c, 'i_gain'), i_offset: num(c, 'i_offset') };
}

function parseFrame(o: Obj): DeviceFrame {
  const type = str(o, 'type');
  const t = num(o, 't');
  if (t < 0) throw new FrameError('field "t" must not be negative');

  switch (type) {
    case 'hello': {
      const hello: DeviceFrame = { type, t, proto: num(o, 'proto'), device: str(o, 'device'), rev: str(o, 'rev'), fw: str(o, 'fw') };
      // The 48-bit chip id, only well formed: never a guess.
      if (typeof o['chip'] === 'string' && /^[0-9a-f]{12}$/.test(o['chip'])) hello.chip = o['chip'];
      // Liberal: unknown capabilities from a newer device are ignored, not fatal.
      if (Array.isArray(o['caps'])) hello.caps = CAPABILITIES.filter((c) => (o['caps'] as unknown[]).includes(c));
      return hello;
    }
    case 'power':
      return { type, t, v: num(o, 'v'), i: num(o, 'i') };
    case 'usb.attach':
      return {
        type,
        t,
        speed: oneOf(o, 'speed', USB_SPEEDS),
        vid: num(o, 'vid'),
        pid: num(o, 'pid'),
        cls: str(o, 'cls'),
        power: oneOf(o, 'power', ['BUS', 'SELF'] as const),
        manufacturer: strOrNull(o, 'manufacturer'),
        product: strOrNull(o, 'product'),
        serial: strOrNull(o, 'serial'),
      };
    case 'power.meter':
      return {
        type,
        t,
        sensor: str(o, 'sensor'),
        shunt_ohm: positive(o, 'shunt_ohm'),
        v_max: positive(o, 'v_max'),
        i_max: positive(o, 'i_max'),
        v_res: positive(o, 'v_res'),
        i_res: positive(o, 'i_res'),
        rate_hz: positive(o, 'rate_hz'),
        v_err: errorBound(o, 'v_err'),
        i_err: errorBound(o, 'i_err'),
        basis: oneOf(o, 'basis', ['DATASHEET', 'CALIBRATION'] as const),
        cal: calibration(o),
      };
    case 'usb.detach':
      return { type, t };
    case 'uart.config': {
      const bits = num(o, 'bits');
      const stop = num(o, 'stop');
      if (bits !== 7 && bits !== 8) throw new FrameError('field "bits" must be 7 or 8');
      if (stop !== 1 && stop !== 2) throw new FrameError('field "stop" must be 1 or 2');
      return { type, t, port: str(o, 'port'), baud: num(o, 'baud'), bits, parity: oneOf(o, 'parity', PARITIES), stop };
    }
    case 'uart.rx':
      return { type, t, data: str(o, 'data') };
    case 'uart.error':
      return { type, t, kind: str(o, 'kind') };
    case 'i2c.scan': {
      const list = o['devices'];
      if (!Array.isArray(list)) throw new FrameError('field "devices" must be an array');
      const devices = list.map((d, n) => {
        if (typeof d !== 'object' || d === null) throw new FrameError(`devices[${n}] must be an object`);
        const addr = num(d as Obj, 'addr');
        if (!Number.isInteger(addr) || addr < 0 || addr > 0x7f) throw new FrameError(`devices[${n}].addr out of range`);
        return { addr, ident: strOrNull(d as Obj, 'ident'), method: strOrNull(d as Obj, 'method') };
      });
      const scan: DeviceFrame = { type, t, speed: num(o, 'speed'), devices };
      if (o['every_ms'] !== undefined && o['every_ms'] !== null) scan.every_ms = num(o, 'every_ms');
      return scan;
    }
    case 'i2c.error': {
      const e: DeviceFrame = { type, t, kind: oneOf(o, 'kind', I2C_ERROR_KINDS), detail: strOrNull(o, 'detail') };
      if (o['every_ms'] !== undefined && o['every_ms'] !== null) e.every_ms = num(o, 'every_ms');
      return e;
    }
    case 'net.status': {
      let link: { up: boolean; mbps: number | null; duplex: 'FULL' | 'HALF' | null } | null = null;
      if (o['link'] !== null && o['link'] !== undefined) {
        const l = obj(o, 'link');
        link = {
          up: bool(l, 'up'),
          mbps: numOrNull(l, 'mbps'),
          duplex: l['duplex'] === null || l['duplex'] === undefined ? null : oneOf(l, 'duplex', ['FULL', 'HALF'] as const),
        };
      }
      return {
        type,
        t,
        link,
        address: strOrNull(o, 'address'),
        dhcp: status(o, 'dhcp'),
        gateway: hop(o, 'gateway'),
        dns: hop(o, 'dns'),
        internet: status(o, 'internet'),
        latency: numOrNull(o, 'latency'),
        loss: numOrNull(o, 'loss'),
      };
    }
    case 'probe.result':
      return {
        type,
        t,
        id: str(o, 'id'),
        test: oneOf(o, 'test', PROBE_TESTS),
        status: status(o, 'status'),
        detail: str(o, 'detail'),
      };
    case 'probe.done':
      return { type, t, id: str(o, 'id') };
    case 'log':
      return { type, t, level: oneOf(o, 'level', ['INFO', 'WARN', 'ERROR'] as const).toLowerCase() as 'info' | 'warn' | 'error', message: str(o, 'message') };
    case 'time': {
      const id = num(o, 'id');
      if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new FrameError('field "id" must be an integer from 0 to 4294967295');
      return { type, t, id };
    }
    default:
      throw new FrameError(`unknown frame type "${type}"`);
  }
}

/** Decode one line of the stream. Never throws. */
export function decodeFrame(line: string): DecodeResult {
  const raw = line.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON', raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'frame must be a JSON object', raw };
  }
  try {
    return { ok: true, frame: parseFrame(parsed as Obj) };
  } catch (e) {
    return { ok: false, error: e instanceof FrameError ? e.message : String(e), raw };
  }
}

export function encodeCommand(cmd: HostCommand): string {
  return JSON.stringify(cmd) + '\n';
}

/**
 * Splits an arbitrary chunked byte stream into lines.
 * Lines longer than `maxLine` are dropped and reported, so a device that
 * never sends a newline cannot grow memory forever.
 */
export class LineSplitter {
  private buffer = '';
  private overflowed = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: (dropped: number) => void = () => {},
    private readonly maxLine = 64 * 1024,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (this.overflowed) {
        this.overflowed = false;
        continue;
      }
      if (line.length > 0) this.onLine(line);
    }
    if (this.buffer.length > this.maxLine) {
      this.onOverflow(this.buffer.length);
      this.buffer = '';
      this.overflowed = true;
    }
  }
}
