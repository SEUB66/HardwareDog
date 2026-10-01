/**
 * HARDWARE DOG / SESSION FILES (.hdlog)
 *
 * A session is recorded as newline-delimited JSON:
 *
 *   {"hdlog":2,"recording":"9f2c...","origin":"PHYSICAL",...}   header
 *   {"at":1759242061002,"frame":{"type":"power",...}}            HDP frame received
 *   {"at":1759242061010,"reject":"not valid JSON","raw":"..."}   line the decoder rejected
 *   {"at":1759242061100,"cmd":{"cmd":"i2c.scan"}}                command sent to the device
 *   {"at":1759242061200,"mark":"device reboot"}                  operator note
 *   {"at":1759242061250,"thresholds":{...}}                      operator changed a threshold
 *   {"at":1759242061300,"lost":"serial stream ended"}            link lost
 *   {"seal":{"n":1,"lines":5,"sha256":"..."}}                    hash chain over the lines above
 *   {"end":{"closed":"NORMAL","entries":5,...,"sha256":"..."}}   footer, written once, last
 *
 * `at` is host wall-clock time in ms. Frames are stored as received, so a
 * replay feeds them back through the real decoder: a recording is
 * reality, played again, and the trace engine cannot tell the difference.
 *
 * INTEGRITY, NOT DRM. Seals chain SHA-256 hashes over the lines, so any
 * byte changed after recording is detected, even in a file whose
 * recording never finished. The footer hashes everything before it. A
 * hash proves the bytes did not change since they were sealed; it does
 * not prove who wrote them (anyone can recompute it). Signatures by the
 * device key come later, with the firmware.
 *
 * PROVENANCE. `origin` is PHYSICAL or SIMULATED and never changes. A
 * replay is what the operator is looking at, not a property of the file:
 * exporting a replay gives back the same file, byte for byte.
 */

import { RULESET_VERSION } from './diagnostics';
import type { DeviceFrame, HostCommand } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import { Sha256, sha256 } from './sha256';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';
import type { Thresholds, TransportKind } from './types';

export const HDLOG_VERSION = 2;

export type Origin = 'PHYSICAL' | 'SIMULATED';

export interface SessionHeader {
  hdlog: number;
  proto: number;
  /** Unique id of this recording (128 random bits, hex). */
  recording: string;
  /** HD-YYYYMMDD-HHMM of the recorded session. */
  id: string;
  startedAt: number;
  /** Real hardware or the simulator. Set once, never rewritten. */
  origin: Origin;
  /** The transport the events came through. */
  source: Exclude<TransportKind, 'REPLAY'>;
  endpoint: string;
  /** Simulator fault scenario, when the origin is SIMULATED. */
  scenario: string | null;
  /** Interface build that recorded it. */
  app: string;
  /** Diagnostic ruleset version in force while recording. */
  ruleset: number;
  /** Diagnostic thresholds in force when recording started. */
  thresholds?: Thresholds;
}

export type SessionEntry =
  | { at: number; frame: DeviceFrame }
  | { at: number; reject: string; raw?: string }
  | { at: number; cmd: HostCommand }
  | { at: number; mark: string }
  | { at: number; thresholds: Thresholds }
  | { at: number; lost: string };

export interface Seal {
  /** 1, 2, 3... */
  n: number;
  /** Lines covered by this seal (since the previous seal or the header). */
  lines: number;
  /** sha256(previous seal hash + the covered lines), hex. */
  sha256: string;
}

export interface Footer {
  /**
   * NORMAL     closed by the recorder at the end of the session
   * RECOVERED  closed later, after an unclean stop (tab closed, crash)
   * SNAPSHOT   exported while the session was still recording
   */
  closed: 'NORMAL' | 'RECOVERED' | 'SNAPSHOT';
  startedAt: number;
  endedAt: number;
  entries: number;
  frames: number;
  rejects: number;
  commands: number;
  marks: number;
  thresholds: number;
  lost: number;
  seals: number;
  /** From the last hello frame, if the device sent one. */
  device: { id: string; rev: string; fw: string } | null;
  /** sha256 of every byte of the file before this line, hex. */
  sha256: string;
}

export type IntegrityStatus = 'VERIFIED' | 'RECOVERED' | 'INCOMPLETE' | 'MODIFIED' | 'UNVERIFIED';

export interface Integrity {
  /**
   * VERIFIED    finalized by the recorder, every hash and count matches
   * RECOVERED   finalized after an unclean stop, every hash matches
   * INCOMPLETE  never finalized; every sealed line is intact
   * MODIFIED    bytes changed after they were sealed (see problems)
   * UNVERIFIED  hdlog v1: no integrity data
   */
  status: IntegrityStatus;
  /** sha256 of the whole file as read, hex: what `sha256sum` prints. */
  fileSha256: string;
  problems: string[];
  /** Entries after the last seal: written, but not covered by any hash. */
  unsealed: number;
  footer: Footer | null;
}

export interface Recording {
  header: SessionHeader;
  entries: SessionEntry[];
  /** Present when the recording was read from a file. */
  integrity?: Integrity;
  /** The file as read: exporting a replay gives it back unchanged. */
  text?: string;
}

const ENTRY_KINDS = ['frame', 'reject', 'cmd', 'mark', 'thresholds', 'lost'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 128 random bits. getRandomValues works on plain HTTP too. */
export function newRecordingId(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const newHeader = (
  fields: Omit<SessionHeader, 'hdlog' | 'proto' | 'recording' | 'origin' | 'ruleset'> & { recording?: string },
): SessionHeader => ({
  hdlog: HDLOG_VERSION,
  proto: PROTOCOL_VERSION,
  recording: fields.recording ?? newRecordingId(),
  id: fields.id,
  startedAt: fields.startedAt,
  origin: fields.source === 'SIMULATOR' ? 'SIMULATED' : 'PHYSICAL',
  source: fields.source,
  endpoint: fields.endpoint,
  scenario: fields.scenario,
  app: fields.app,
  ruleset: RULESET_VERSION,
  ...(fields.thresholds ? { thresholds: fields.thresholds } : {}),
});

// ------------------------------------------------------------------ recorder

type Listener = (entry: SessionEntry) => void;

/**
 * Collects a session as it happens. Listeners persist it incrementally
 * (core/archive.ts); `keep: false` leaves memory to them, for long sessions.
 * The header is frozen: what was recorded is what the file says.
 */
export class SessionRecorder {
  readonly entries: SessionEntry[] = [];
  readonly header: Readonly<SessionHeader>;
  private listeners = new Set<Listener>();
  private readonly keep: boolean;

  constructor(header: SessionHeader, options: { keep?: boolean } = {}) {
    this.header = Object.freeze({ ...header });
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

// ------------------------------------------------------------------ writing

export const encodeEntry = (e: SessionEntry): string => JSON.stringify(e);

type Counts = Omit<Footer, 'closed' | 'startedAt' | 'endedAt' | 'seals' | 'device' | 'sha256'>;

const emptyCounts = (): Counts => ({ entries: 0, frames: 0, rejects: 0, commands: 0, marks: 0, thresholds: 0, lost: 0 });

function count(c: Counts, e: SessionEntry): void {
  c.entries++;
  if ('frame' in e) c.frames++;
  else if ('reject' in e) c.rejects++;
  else if ('cmd' in e) c.commands++;
  else if ('mark' in e) c.marks++;
  else if ('thresholds' in e) c.thresholds++;
  else c.lost++;
}

const helloOf = (e: SessionEntry): Footer['device'] | undefined =>
  'frame' in e && e.frame.type === 'hello' ? { id: e.frame.device, rev: e.frame.rev, fw: e.frame.fw } : undefined;

/**
 * Turns entries into sealed .hdlog text, incrementally. The archive calls
 * seal() at every flush and finish() once; toHdlog() does it in one go.
 */
export class HdlogSealer {
  readonly headerLine: string;
  private readonly payload = new Sha256();
  private chain: string;
  private pending: string[] = [];
  private seals = 0;
  private readonly counts = emptyCounts();
  private lastAt: number;
  private device: Footer['device'] = null;
  private finished = false;

  constructor(readonly header: SessionHeader) {
    this.headerLine = JSON.stringify(header) + '\n';
    this.payload.update(this.headerLine);
    this.chain = sha256(this.headerLine);
    this.lastAt = header.startedAt;
  }

  /** Encode one entry; it is written at the next seal(). Returns its line. */
  add(e: SessionEntry): string {
    if (this.finished) throw new Error('hdlog: entry after footer');
    const line = encodeEntry(e) + '\n';
    this.pending.push(line);
    count(this.counts, e);
    this.lastAt = e.at;
    this.device = helloOf(e) ?? this.device;
    return line;
  }

  get entries(): number {
    return this.counts.entries;
  }

  /** The pending lines plus their seal, or '' when nothing is pending. */
  seal(): string {
    if (this.pending.length === 0) return '';
    const block = this.pending.join('');
    this.chain = sha256(this.chain + block);
    const seal: Seal = { n: ++this.seals, lines: this.pending.length, sha256: this.chain };
    const text = block + JSON.stringify({ seal }) + '\n';
    this.payload.update(text);
    this.pending = [];
    return text;
  }

  /** Seal what is pending and close the file with its footer. */
  finish(closed: Footer['closed'] = 'NORMAL'): string {
    const text = this.seal();
    this.finished = true;
    return text + this.footer(closed);
  }

  /**
   * The footer for everything sealed so far, without closing: a SNAPSHOT
   * is a complete, verifiable copy of a session that keeps recording.
   * Call it right after seal().
   */
  footer(closed: Footer['closed']): string {
    const end: Footer = {
      closed,
      startedAt: this.header.startedAt,
      endedAt: this.lastAt,
      ...this.counts,
      seals: this.seals,
      device: this.device,
      sha256: this.payload.clone().hex(),
    };
    return JSON.stringify({ end }) + '\n';
  }
}

/** A complete, finalized .hdlog file. A replayed recording comes back unchanged. */
export function toHdlog(r: Recording): string {
  if (r.text !== undefined) return r.text;
  const sealer = new HdlogSealer(r.header);
  for (const e of r.entries) sealer.add(e);
  return sealer.headerLine + sealer.finish();
}

// ------------------------------------------------------------------ reading

export class HdlogError extends Error {}

/**
 * Limits for files from anyone. A hostile or broken file is refused with
 * a reason; it never exhausts the browser or reaches the engine malformed.
 */
export const HDLOG_LIMITS = {
  /** Whole file. About 15 hours of a live session at 50 power frames/s. */
  maxBytes: 256 * 1024 * 1024,
  /** One line: an HDP frame is at most 64 KiB, plus the entry around it. */
  maxLine: 128 * 1024,
  /** Free-text header fields and marks. */
  maxText: 1000,
} as const;

/** The same ranges the interface accepts (SETUP). */
const THRESHOLD_RANGES: Record<keyof Thresholds, [number, number]> = {
  undervoltageThreshold: [3, 5.5],
  overcurrentThreshold: [0.05, 5],
  correlationWindowMs: [10, 2000],
};

function checkThresholds(t: unknown, where: string): void {
  if (!isObj(t)) throw new HdlogError(`${where}: thresholds must be an object`);
  for (const [k, [lo, hi]] of Object.entries(THRESHOLD_RANGES)) {
    const v = t[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new HdlogError(`${where}: threshold ${k} out of range (${lo}..${hi})`);
  }
}

const isText = (v: unknown, max: number = HDLOG_LIMITS.maxText): v is string => typeof v === 'string' && v.length <= max;

/** What each entry kind must carry. The frame itself is checked by the HDP decoder at replay. */
function checkEntry(e: Record<string, unknown>, where: string): void {
  if ('frame' in e && !isObj(e['frame'])) throw new HdlogError(`${where}: frame must be an object`);
  if ('reject' in e && (!isText(e['reject']) || ('raw' in e && !isText(e['raw'], HDLOG_LIMITS.maxLine)))) throw new HdlogError(`${where}: malformed reject`);
  if ('cmd' in e && !isObj(e['cmd'])) throw new HdlogError(`${where}: cmd must be an object`);
  if ('mark' in e && !isText(e['mark'])) throw new HdlogError(`${where}: mark must be text, at most ${HDLOG_LIMITS.maxText} characters`);
  if ('lost' in e && !isText(e['lost'])) throw new HdlogError(`${where}: malformed lost`);
  if ('thresholds' in e) checkThresholds(e['thresholds'], where);
}

function readHeader(line: string): SessionHeader {
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    throw new HdlogError('line 1: header is not JSON');
  }
  if (!isObj(header) || typeof header['hdlog'] !== 'number') throw new HdlogError('line 1: not an .hdlog file');
  if (header['hdlog'] > HDLOG_VERSION) {
    throw new HdlogError(`line 1: hdlog v${header['hdlog']} was written by a newer Hardware Dog; this build reads v1 to v${HDLOG_VERSION}`);
  }
  if (header['hdlog'] !== 1 && header['hdlog'] !== 2) throw new HdlogError(`line 1: unknown hdlog version ${String(header['hdlog'])}`);
  for (const k of ['id', 'source', 'endpoint', 'app'] as const) {
    if (!isText(header[k], 256)) throw new HdlogError(`line 1: header field "${k}" missing or too long`);
  }
  if (header['scenario'] !== undefined && header['scenario'] !== null && !isText(header['scenario'], 64)) throw new HdlogError('line 1: header field "scenario" malformed');
  if (typeof header['startedAt'] !== 'number' || !Number.isFinite(header['startedAt']) || header['startedAt'] < 0) throw new HdlogError('line 1: header field "startedAt" missing');
  if (header['proto'] !== undefined && !Number.isInteger(header['proto'])) throw new HdlogError('line 1: header field "proto" malformed');
  if (header['thresholds'] !== undefined) checkThresholds(header['thresholds'], 'line 1');
  if (header['source'] !== 'SIMULATOR' && header['source'] !== 'WEB SERIAL') throw new HdlogError('line 1: unknown source');
  const derived: Origin = header['source'] === 'SIMULATOR' ? 'SIMULATED' : 'PHYSICAL';
  if (header['hdlog'] === 1) {
    // v1 had no explicit origin: it follows from the source.
    return { ...(header as object), origin: derived, recording: '', ruleset: 0, scenario: (header['scenario'] as string | null) ?? null } as SessionHeader;
  }
  if (typeof header['recording'] !== 'string' || !/^[0-9a-f]{32}$/.test(header['recording'])) throw new HdlogError('line 1: header field "recording" missing');
  if (header['origin'] !== 'PHYSICAL' && header['origin'] !== 'SIMULATED') throw new HdlogError('line 1: header field "origin" must be PHYSICAL or SIMULATED');
  if (header['origin'] !== derived) throw new HdlogError(`line 1: origin ${String(header['origin'])} contradicts source ${String(header['source'])}`);
  if (typeof header['ruleset'] !== 'number') throw new HdlogError('line 1: header field "ruleset" missing');
  return header as unknown as SessionHeader;
}

/**
 * Parse an .hdlog file (v1 or v2) and check its integrity. Structure
 * errors throw HdlogError with a line number. Integrity problems do not
 * throw: the file stays readable, and Integrity says what changed. Frame
 * CONTENT is validated later by the real decoder during replay.
 */
export function parseHdlog(text: string): Recording {
  if (text.length > HDLOG_LIMITS.maxBytes) throw new HdlogError(`file larger than ${HDLOG_LIMITS.maxBytes / 1024 / 1024} MiB`);
  const raw = text.split('\n');
  if (raw.at(-1) === '') raw.pop();
  const long = raw.findIndex((l) => l.length > HDLOG_LIMITS.maxLine);
  if (long >= 0) throw new HdlogError(`line ${long + 1}: longer than ${HDLOG_LIMITS.maxLine / 1024} KiB`);
  if (raw.length === 0 || raw[0]!.trim() === '') throw new HdlogError('empty file');
  const header = readHeader(raw[0]!);
  const v2 = header.hdlog === 2;
  const problems: string[] = [];
  const entries: SessionEntry[] = [];
  let footer: Footer | null = null;
  let footerLine = 0;
  let last = -Infinity;
  // Integrity state (v2)
  let chain = sha256(raw[0]! + '\n');
  let blockLines = 0;
  let blockText: string[] = [];
  let seals = 0;
  const payload = new Sha256().update(raw[0]! + '\n');
  const counts = emptyCounts();
  let device: Footer['device'] = null;

  for (let n = 1; n < raw.length; n++) {
    const line = raw[n]!;
    const where = `line ${n + 1}`;
    if (footer) {
      problems.push(`${where}: data after the footer`);
      break;
    }
    if (line.trim() === '') {
      if (v2) problems.push(`${where}: blank line inserted`);
      continue;
    }
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      throw new HdlogError(`${where}: not JSON`);
    }
    if (!isObj(e)) throw new HdlogError(`${where}: not an object`);
    if (v2 && 'seal' in e) {
      const s = e['seal'];
      if (!isObj(s) || typeof s['sha256'] !== 'string') throw new HdlogError(`${where}: malformed seal`);
      chain = sha256(chain + blockText.join(''));
      seals++;
      if (s['sha256'] !== chain) problems.push(`${where}: seal ${seals} does not match the ${blockLines} lines above it`);
      else if (s['lines'] !== blockLines || s['n'] !== seals) problems.push(`${where}: seal ${seals} numbering does not match`);
      chain = typeof s['sha256'] === 'string' ? s['sha256'] : chain;
      payload.update(line + '\n');
      blockText = [];
      blockLines = 0;
      continue;
    }
    if (v2 && 'end' in e) {
      if (!isObj(e['end'])) throw new HdlogError(`${where}: malformed footer`);
      footer = e['end'] as unknown as Footer;
      footerLine = n + 1;
      continue;
    }
    if (typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) throw new HdlogError(`${where}: entry without "at"`);
    if (e['at'] < last) throw new HdlogError(`${where}: time goes backwards`);
    last = e['at'];
    const kinds = ENTRY_KINDS.filter((k) => k in e);
    if (kinds.length !== 1) throw new HdlogError(`${where}: entry must have exactly one of ${ENTRY_KINDS.join(' / ')}`);
    checkEntry(e, where);
    const entry = e as SessionEntry;
    entries.push(entry);
    count(counts, entry);
    device = helloOf(entry) ?? device;
    blockText.push(line + '\n');
    blockLines++;
    payload.update(line + '\n');
  }

  const fileSha256 = sha256(text);
  if (!v2) return { header, entries, text, integrity: { status: 'UNVERIFIED', fileSha256, problems: [], unsealed: entries.length, footer: null } };

  const unsealed = blockLines;
  if (footer) {
    const where = `line ${footerLine}`;
    if (unsealed > 0) problems.push(`${where}: ${unsealed} entries before the footer are not sealed`);
    if (footer.sha256 !== payload.hex()) problems.push(`${where}: footer hash does not match the file`);
    const expected: Partial<Footer> = { ...counts, seals, startedAt: header.startedAt };
    for (const [k, v] of Object.entries(expected)) {
      if (footer[k as keyof Footer] !== v) problems.push(`${where}: footer says ${k} = ${String(footer[k as keyof Footer])}, file has ${String(v)}`);
    }
    if (JSON.stringify(footer.device) !== JSON.stringify(device)) problems.push(`${where}: footer device does not match the hello frame`);
  }
  const status: IntegrityStatus =
    problems.length > 0 ? 'MODIFIED' : !footer ? 'INCOMPLETE' : footer.closed === 'RECOVERED' ? 'RECOVERED' : 'VERIFIED';
  return { header, entries, text, integrity: { status, fileSha256, problems, unsealed: footer ? 0 : unsealed, footer } };
}

/**
 * Close a file whose recording never finished (browser closed, crash).
 * Only the sealed part is kept: unsealed trailing lines were never
 * covered by a hash. Returns null if the file is not INCOMPLETE.
 */
export function recoverHdlog(text: string): string | null {
  const r = parseHdlog(text);
  if (r.integrity?.status !== 'INCOMPLETE') return null;
  const keep = r.entries.length - r.integrity.unsealed;
  const sealer = new HdlogSealer(r.header);
  const lines = text.split('\n');
  // Rebuild from the sealed entries: the result must be byte-identical up
  // to the last seal, so re-seal with the same blocks.
  const out: string[] = [lines[0]! + '\n'];
  let taken = 0;
  for (let n = 1; n < lines.length && taken < keep; n++) {
    const line = lines[n]!;
    if (line === '') continue;
    const e = JSON.parse(line) as Record<string, unknown>;
    if ('seal' in e) {
      out.push(sealer.seal());
      continue;
    }
    sealer.add(e as unknown as SessionEntry);
    taken++;
  }
  out.push(sealer.finish('RECOVERED'));
  return out.join('');
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

  send(_cmd: HostCommand): void {
    // Read-only: a recording never executes or answers commands.
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

