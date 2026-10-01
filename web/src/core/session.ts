/**
 * HARDWARE DOG / SESSION RECORDING
 *
 * A session is recorded as `.hdlog`: newline-delimited JSON, one header
 * line, then one entry per event, in arrival order.
 *
 *   {"hdlog":1,"proto":1,"id":"HD-20260930-1421",...}      header
 *   {"at":1759242061002,"frame":{"type":"power",...}}       HDP frame received
 *   {"at":1759242061010,"reject":"not valid JSON","raw":"..."}  line the decoder rejected
 *   {"at":1759242061100,"cmd":{"cmd":"i2c.scan"}}           command sent to the device
 *   {"at":1759242061200,"mark":"device reboot"}             operator note
 *   {"at":1759242061250,"thresholds":{...}}                 operator changed a threshold
 *   {"at":1759242061300,"lost":"serial stream ended"}       link lost
 *
 * `at` is host wall-clock time in ms. Frames are stored as received, so a
 * replay feeds them back through the real decoder: a recording is
 * reality, played again, and the trace engine cannot tell the difference.
 */

import type { DeviceFrame, HostCommand } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';
import type { Thresholds, TransportKind } from './types';

export const HDLOG_VERSION = 1;

export interface SessionHeader {
  hdlog: typeof HDLOG_VERSION;
  proto: number;
  /** HD-YYYYMMDD-HHMM of the recorded session. */
  id: string;
  startedAt: number;
  /** Where the events came from when they were recorded. */
  source: Exclude<TransportKind, 'REPLAY'>;
  endpoint: string;
  /** Simulator fault scenario, when source is SIMULATOR. */
  scenario: string | null;
  /** Interface build that recorded it. */
  app: string;
  /** Diagnostic thresholds in force while recording: a replay uses them. */
  thresholds?: Thresholds;
}

export type SessionEntry =
  | { at: number; frame: DeviceFrame }
  | { at: number; reject: string; raw?: string }
  | { at: number; cmd: HostCommand }
  | { at: number; mark: string }
  | { at: number; thresholds: Thresholds }
  | { at: number; lost: string };

export interface Recording {
  header: SessionHeader;
  entries: SessionEntry[];
}

// ------------------------------------------------------------------ recorder

type Listener = (entry: SessionEntry) => void;

/**
 * Collects a session as it happens. Listeners persist it incrementally
 * (core/archive.ts); `keep: false` leaves memory to them, for long sessions.
 */
export class SessionRecorder {
  readonly entries: SessionEntry[] = [];
  private listeners = new Set<Listener>();
  private readonly keep: boolean;

  constructor(
    readonly header: SessionHeader,
    options: { keep?: boolean } = {},
  ) {
    this.keep = options.keep ?? true;
  }

  add(entry: SessionEntry): void {
    if (this.keep) this.entries.push(entry);
    for (const l of this.listeners) l(entry);
  }

  onEntry(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get recording(): Recording {
    return { header: this.header, entries: this.entries };
  }
}

// ------------------------------------------------------------------ format

export const encodeEntry = (e: SessionEntry): string => JSON.stringify(e);

export function toHdlog(r: Recording): string {
  return [JSON.stringify(r.header), ...r.entries.map(encodeEntry)].join('\n') + '\n';
}

export class HdlogError extends Error {}

const ENTRY_KINDS = ['frame', 'reject', 'cmd', 'mark', 'thresholds', 'lost'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parse an .hdlog file. Structure is validated here; frame CONTENT is
 * validated later by the real decoder during replay, like live data.
 */
export function parseHdlog(text: string): Recording {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new HdlogError('empty file');
  let header: unknown;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    throw new HdlogError('line 1: header is not JSON');
  }
  if (!isObj(header) || header['hdlog'] !== HDLOG_VERSION) throw new HdlogError(`line 1: not an .hdlog v${HDLOG_VERSION} header`);
  for (const k of ['id', 'source', 'endpoint', 'app'] as const) {
    if (typeof header[k] !== 'string') throw new HdlogError(`line 1: header field "${k}" missing`);
  }
  if (typeof header['startedAt'] !== 'number') throw new HdlogError('line 1: header field "startedAt" missing');
  if (header['source'] !== 'SIMULATOR' && header['source'] !== 'WEB SERIAL') throw new HdlogError('line 1: unknown source');

  const entries: SessionEntry[] = [];
  let last = -Infinity;
  lines.slice(1).forEach((line, n) => {
    const where = `line ${n + 2}`;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw new HdlogError(`${where}: not JSON`);
    }
    if (!isObj(e) || typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) throw new HdlogError(`${where}: entry without "at"`);
    if (e['at'] < last) throw new HdlogError(`${where}: time goes backwards`);
    last = e['at'];
    const kinds = ENTRY_KINDS.filter((k) => k in e);
    if (kinds.length !== 1) throw new HdlogError(`${where}: entry must have exactly one of ${ENTRY_KINDS.join(' / ')}`);
    entries.push(e as SessionEntry);
  });
  return { header: header as unknown as SessionHeader, entries };
}

// ------------------------------------------------------------------ replay

const INSTANT_SLICE = 2000;

export interface ReplayOptions {
  /** 'instant' feeds everything at open(); a number plays at that speed. */
  speed?: 'instant' | number;
  /** Tests drive time with advanceTo(); no timers. */
  manual?: boolean;
}

/**
 * Plays a recording back as a transport. Frames are re-serialized and go
 * through the same line decoder as a live device. The System's clock
 * follows `clock`, so the timeline shows the original times.
 */
export class ReplayTransport implements Transport {
  readonly kind = 'REPLAY' as const;
  readonly label: string;
  /** Host time of the entry being played: the System uses it as "now". */
  clock: number;

  private sink: TransportSink | null = null;
  private lines: ReturnType<typeof createLineDecoder> | null = null;
  private next = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly recording: Recording,
    private readonly options: ReplayOptions = {},
  ) {
    const h = recording.header;
    this.label = `REPLAY ${h.id} / ${h.source}${h.scenario ? ` ${h.scenario}` : ''}`;
    this.clock = h.startedAt;
  }

  get done(): boolean {
    return this.next >= this.recording.entries.length;
  }

  get progress(): number {
    const n = this.recording.entries.length;
    return n === 0 ? 1 : this.next / n;
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.lines = createLineDecoder(sink);
    const speed = this.options.speed ?? 'instant';
    if (this.options.manual) return;
    if (speed === 'instant') {
      // In slices, so a long recording never freezes the interface.
      while (this.sink && !this.done) {
        this.advanceTo(Infinity, INSTANT_SLICE);
        if (!this.done) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return;
    }
    const t0 = Date.now();
    const start = this.recording.header.startedAt;
    this.timer = setInterval(() => this.advanceTo(start + (Date.now() - t0) * speed), 20);
  }

  /** Feed the entries recorded up to host time `t`, at most `max` of them. */
  advanceTo(t: number, max = Infinity): void {
    const entries = this.recording.entries;
    let fed = 0;
    while (this.sink && fed++ < max && this.next < entries.length && entries[this.next]!.at <= t) {
      const e = entries[this.next++]!;
      this.clock = e.at;
      if ('frame' in e) this.lines!.push(JSON.stringify(e.frame) + '\n');
      else if ('reject' in e) {
        // Give the decoder the same bytes: it must reject them again.
        if (e.raw !== undefined) this.lines!.push(e.raw.replace(/\n/g, ' ') + '\n');
        else this.sink.error(e.reject);
      } else if ('mark' in e) this.sink.annotate?.(e.mark);
      else if ('thresholds' in e) this.sink.configure?.(e.thresholds);
      else if ('lost' in e) this.sink.lost(e.lost);
      // 'cmd' entries document what was sent; a recording cannot be re-driven.
    }
    if (this.done && this.sink) {
      this.stop();
      this.sink.ended?.();
    }
  }

  send(): void {
    // Read-only: a recording does not answer commands.
  }

  async close(): Promise<void> {
    this.stop();
    this.sink = null;
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export const newHeader = (fields: Omit<SessionHeader, 'hdlog' | 'proto'>): SessionHeader => ({
  hdlog: HDLOG_VERSION,
  proto: PROTOCOL_VERSION,
  ...fields,
});
