/**
 * HARDWARE DOG / LAB SESSIONS (.hdlab)
 *
 * One session for every lab tool: Flipper operations, BLE observations,
 * GATT reads and writes, operator markers and notes, on one timeline, in
 * the order this computer received them.
 *
 *   header   {"format":"hdlab","version":1,...}   who, when, which clocks
 *   events   one LabEvent per line, seq ascending
 *   footer   {"end":true,...,"sha256":"...","self":"..."}   counts, losses, the seals
 *
 * The seal is the SHA-256 of every line before the footer (each with its
 * "\n"); "self", the SHA-256 of the footer line before it, seals the
 * footer's own fields (end time, losses). A reopened file is VERIFIED when
 * both match, MODIFIED when bytes changed, UNSEALED when it has no footer
 * (a session that never stopped). A header with "footerSealed" says the
 * footer must seal itself; files from before 2026-10 have neither.
 *
 * Replay is a visualization: a reopened session is read-only and nothing
 * in it is ever sent to a device again.
 *
 * Clocks: `at` is this computer's wall clock, `mono` its monotonic clock.
 * Durations come from `mono`. Events from two devices are ordered by when
 * this computer received them: their own clocks are not synchronized and
 * the file never claims they are.
 */

import { Sha256, sha256 } from '../sha256';
import type { LabBus, LabEvent, LabOrigin } from './events';
import { LAB_SOURCES } from './events';

export const HDLAB_LIMITS = {
  /** Events kept in one session; the rest are counted as lost, and said. */
  maxEvents: 50_000,
  /** Largest file reopened. */
  maxBytes: 32 * 1024 * 1024,
  maxLine: 256 * 1024,
} as const;

export interface LabSessionHeader {
  format: 'hdlab';
  version: 1;
  id: string;
  name: string;
  startedAt: number;
  /** Monotonic time at start: `mono - startMono` is the time into the session. */
  startMono: number;
  app: string;
  clock: string;
  /** The footer seals its own line ("self"). Absent in older files. */
  footerSealed?: true;
}

export interface LabSessionFooter {
  end: true;
  endedAt: number;
  endMono: number;
  events: number;
  /** Events received but not kept (the session limit), counted. */
  lost: number;
  sha256: string;
  /** sha256 of the footer line up to `,"self"`. Absent in older files. */
  self?: string;
}

export type LabIntegrity = 'VERIFIED' | 'MODIFIED' | 'UNSEALED' | 'LIVE';

export interface LabSessionData {
  header: LabSessionHeader;
  events: LabEvent[];
  footer: LabSessionFooter | null;
  integrity: LabIntegrity;
}

export const CLOCK_NOTE = 'at: host wall clock (ms); mono: host monotonic clock (ms); device clocks are not synchronized to the host';

const labId = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `LAB-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Records what the bus carries while it runs. Capture is independent of
 * any screen: the recorder holds the events whether the TV is on or not.
 */
export class LabRecorder {
  readonly header: LabSessionHeader;
  readonly events: LabEvent[] = [];
  lost = 0;
  footer: LabSessionFooter | null = null;
  private unsubscribe: (() => void) | null;

  constructor(
    private readonly bus: LabBus,
    name: string,
    app: string,
  ) {
    const startedAt = bus.clock.now();
    this.header = { format: 'hdlab', version: 1, id: labId(startedAt), name: name.trim() || labId(startedAt), startedAt, startMono: bus.clock.mono(), app, clock: CLOCK_NOTE, footerSealed: true };
    this.unsubscribe = bus.subscribe((e) => this.take(e));
  }

  private take(e: LabEvent): void {
    if (this.events.length >= HDLAB_LIMITS.maxEvents) {
      this.lost++;
      return;
    }
    this.events.push(e);
  }

  get recording(): boolean {
    return this.unsubscribe !== null;
  }

  rename(name: string): void {
    if (name.trim()) this.header.name = name.trim();
  }

  stop(): LabSessionData {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      const body = bodyLines(this.header, this.events);
      const footer = { end: true as const, endedAt: this.bus.clock.now(), endMono: this.bus.clock.mono(), events: this.events.length, lost: this.lost, sha256: seal(body) };
      this.footer = { ...footer, self: sha256(JSON.stringify(footer).slice(0, -1)) };
    }
    return this.data();
  }

  data(): LabSessionData {
    return { header: this.header, events: this.events, footer: this.footer, integrity: this.footer ? 'VERIFIED' : 'LIVE' };
  }
}

function bodyLines(header: LabSessionHeader, events: readonly LabEvent[]): string[] {
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
}

/** The footer's own seal, read from its line as written. */
const FOOTER_SELF = /^(\{"end":true,.*),"self":"([0-9a-f]{64})"\}$/;

function seal(lines: readonly string[]): string {
  const h = new Sha256();
  for (const l of lines) h.update(l + '\n');
  return h.hex();
}

/** The session as an .hdlab file. An unfinished session gets no footer: it is UNSEALED. */
export function toHdlab(data: Pick<LabSessionData, 'header' | 'events' | 'footer'>): string {
  const lines = bodyLines(data.header, data.events);
  if (data.footer) lines.push(JSON.stringify(data.footer));
  return lines.join('\n') + '\n';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SEVERITIES = ['INFO', 'PASS', 'WARN', 'FAIL'];
const TYPES = ['link.state', 'op.start', 'op.progress', 'op.end', 'observe', 'marker', 'note', 'info'];
const ORIGINS: LabOrigin[] = ['PHYSICAL', 'SIMULATED', 'REPLAY'];

function checkEvent(v: unknown, line: number): LabEvent {
  const bad = (what: string) => new Error(`line ${line}: ${what}`);
  if (!isObj(v)) throw bad('not an event');
  if (!Number.isSafeInteger(v['seq'])) throw bad('seq');
  if (typeof v['at'] !== 'number' || typeof v['mono'] !== 'number') throw bad('time');
  if (!(LAB_SOURCES as readonly string[]).includes(v['source'] as string)) throw bad('source');
  if (typeof v['tool'] !== 'string' || typeof v['message'] !== 'string') throw bad('tool / message');
  if (!TYPES.includes(v['type'] as string)) throw bad('type');
  if (!SEVERITIES.includes(v['severity'] as string)) throw bad('severity');
  if (!ORIGINS.includes(v['origin'] as LabOrigin)) throw bad('origin');
  if (v['params'] !== undefined && !isObj(v['params'])) throw bad('params');
  if (v['raw'] !== undefined && (typeof v['raw'] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v['raw']))) throw bad('raw');
  return v as unknown as LabEvent;
}

/** Reopen an .hdlab file: every line checked, the seal verified. Throws on a file that is not one. */
export function parseHdlab(text: string): LabSessionData {
  if (text.length > HDLAB_LIMITS.maxBytes) throw new Error(`larger than ${HDLAB_LIMITS.maxBytes / 1024 / 1024} MiB`);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new Error('empty file');
  const parse = (l: string, n: number) => {
    if (l.length > HDLAB_LIMITS.maxLine) throw new Error(`line ${n}: too long`);
    try {
      return JSON.parse(l) as unknown;
    } catch {
      throw new Error(`line ${n}: not JSON`);
    }
  };
  const header = parse(lines[0]!, 1);
  if (!isObj(header) || header['format'] !== 'hdlab' || header['version'] !== 1) throw new Error('not an .hdlab v1 file');
  if (typeof header['id'] !== 'string' || typeof header['name'] !== 'string' || typeof header['startedAt'] !== 'number' || typeof header['startMono'] !== 'number')
    throw new Error('header: id, name, startedAt, startMono');

  let footer: LabSessionFooter | null = null;
  let last = lines.length;
  const tail = parse(lines[lines.length - 1]!, lines.length);
  if (lines.length > 1 && isObj(tail) && tail['end'] === true) {
    if (typeof tail['sha256'] !== 'string' || !Number.isSafeInteger(tail['events'])) throw new Error('footer: events, sha256');
    footer = tail as unknown as LabSessionFooter;
    last = lines.length - 1;
  }
  const events: LabEvent[] = [];
  let prev = 0;
  for (let i = 1; i < last; i++) {
    const e = checkEvent(parse(lines[i]!, i + 1), i + 1);
    if (e.seq <= prev) throw new Error(`line ${i + 1}: seq out of order`);
    prev = e.seq;
    events.push(e);
  }
  let integrity: LabIntegrity = 'UNSEALED';
  if (footer) {
    const own = FOOTER_SELF.exec(lines[last]!);
    const selfOk = own ? sha256(own[1]!) === own[2] : header['footerSealed'] !== true && !('self' in footer);
    integrity = seal(lines.slice(0, last)) === footer.sha256 && footer.events === events.length && selfOk ? 'VERIFIED' : 'MODIFIED';
  }
  return { header: header as unknown as LabSessionHeader, events, footer, integrity };
}

// ------------------------------------------------------------ comparison

export interface BleDeviceSummary {
  device: string;
  name: string | null;
  observations: number;
  rssiMedian: number | null;
  /** Distinct payloads seen (manufacturer + service data), by their raw bytes. */
  payloads: string[];
}

export interface WindowSummary {
  events: number;
  bySourceType: Record<string, number>;
  failures: { seq: number; code: string | null; message: string }[];
  ble: Map<string, BleDeviceSummary>;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarize(events: readonly LabEvent[]): WindowSummary {
  const bySourceType: Record<string, number> = {};
  const failures: WindowSummary['failures'] = [];
  const rssi = new Map<string, number[]>();
  const ble = new Map<string, BleDeviceSummary>();
  for (const e of events) {
    const k = `${e.source} ${e.type}`;
    bySourceType[k] = (bySourceType[k] ?? 0) + 1;
    if (e.severity === 'FAIL') failures.push({ seq: e.seq, code: e.code ?? null, message: e.message });
    if (e.source === 'BLE' && e.type === 'observe' && e.device) {
      let d = ble.get(e.device);
      if (!d) ble.set(e.device, (d = { device: e.device, name: null, observations: 0, rssiMedian: null, payloads: [] }));
      d.observations += Number(e.params?.['repeats'] ?? 0) + 1;
      const name = e.params?.['name'];
      if (typeof name === 'string' && name) d.name = name;
      const r = e.measures?.find((m) => m.name === 'rssi');
      if (r) (rssi.get(e.device) ?? rssi.set(e.device, []).get(e.device)!).push(r.value);
      const payload = e.raw ?? (e.params?.['mfr'] !== undefined || e.params?.['svc'] !== undefined ? `${e.params?.['mfr'] ?? ''}|${e.params?.['svc'] ?? ''}` : undefined);
      if (payload !== undefined && !d.payloads.includes(payload)) d.payloads.push(payload);
    }
  }
  for (const [id, xs] of rssi) ble.get(id)!.rssiMedian = median(xs);
  return { events: events.length, bySourceType, failures, ble };
}

export interface Comparison {
  before: WindowSummary;
  after: WindowSummary;
  /** Event counts that differ, by source and type. */
  counts: { key: string; before: number; after: number }[];
  bleOnlyBefore: string[];
  bleOnlyAfter: string[];
  /** Devices in both, with what changed. RSSI is a radio level, never a distance. */
  bleBoth: { device: string; rssiBefore: number | null; rssiAfter: number | null; payloadChanged: boolean }[];
}

/** Before / after: two sessions, or one session split at a marker. Differences only, no causes. */
export function compare(before: readonly LabEvent[], after: readonly LabEvent[]): Comparison {
  const a = summarize(before);
  const b = summarize(after);
  const keys = [...new Set([...Object.keys(a.bySourceType), ...Object.keys(b.bySourceType)])].sort();
  const counts = keys.map((key) => ({ key, before: a.bySourceType[key] ?? 0, after: b.bySourceType[key] ?? 0 })).filter((c) => c.before !== c.after);
  const bleOnlyBefore = [...a.ble.keys()].filter((d) => !b.ble.has(d)).sort();
  const bleOnlyAfter = [...b.ble.keys()].filter((d) => !a.ble.has(d)).sort();
  const bleBoth = [...a.ble.keys()]
    .filter((d) => b.ble.has(d))
    .sort()
    .map((device) => {
      const x = a.ble.get(device)!;
      const y = b.ble.get(device)!;
      const payloadChanged = x.payloads.join('|') !== y.payloads.join('|');
      return { device, rssiBefore: x.rssiMedian, rssiAfter: y.rssiMedian, payloadChanged };
    });
  return { before: a, after: b, counts, bleOnlyBefore, bleOnlyAfter, bleBoth };
}

/** The events before and after a marker of the session (the marker itself excluded). */
export function splitAt(events: readonly LabEvent[], seq: number): [LabEvent[], LabEvent[]] {
  return [events.filter((e) => e.seq < seq), events.filter((e) => e.seq > seq)];
}

/** Events received within ±ms of an event (host monotonic clock). Proximity in time, not a cause. */
export function near(events: readonly LabEvent[], around: LabEvent, ms: number): LabEvent[] {
  return events.filter((e) => e.seq !== around.seq && Math.abs(e.mono - around.mono) <= ms);
}

// ---------------------------------------------------------------- report

const t = (data: LabSessionData, e: LabEvent) => `+${((e.mono - data.header.startMono) / 1000).toFixed(3)} s`;

/**
 * A plain-text report. Every statement points to the events it rests on
 * (#seq). Correlations are listed as proximity in time, never as causes.
 */
export function labReport(data: LabSessionData, nearMs = 2000): string {
  const { header, events, footer } = data;
  const s = summarize(events);
  const origins = [...new Set(events.map((e) => e.origin))];
  const out: string[] = [];
  out.push('HARDWARE DOG / LAB SESSION REPORT', '');
  out.push(`SESSION     ${header.id}  "${header.name}"`);
  out.push(`STARTED     ${new Date(header.startedAt).toISOString()}`);
  if (footer) out.push(`DURATION    ${((footer.endMono - header.startMono) / 1000).toFixed(1)} s (host monotonic clock)`);
  out.push(`INTEGRITY   ${data.integrity}`);
  out.push(`ORIGIN      ${origins.join(', ') || 'no events'}${origins.includes('SIMULATED') ? '  <- contains DEMO data, not hardware' : ''}`);
  out.push(`EVENTS      ${events.length}${footer?.lost ? `, ${footer.lost} LOST (session limit ${HDLAB_LIMITS.maxEvents})` : ''}`);
  out.push(`CLOCKS      ${CLOCK_NOTE}`, '');

  out.push('COUNTS');
  for (const [k, n] of Object.entries(s.bySourceType).sort()) out.push(`  ${k.padEnd(24)} ${n}`);
  out.push('');

  const markers = events.filter((e) => e.type === 'marker' || e.type === 'note');
  out.push(`MARKERS AND NOTES (${markers.length})`);
  for (const m of markers) {
    out.push(`  #${m.seq} ${t(data, m)}  ${m.type.toUpperCase()}  ${m.message}`);
    const close = near(events, m, nearMs).filter((e) => e.type !== 'marker' && e.type !== 'note');
    if (close.length) out.push(`      within ±${nearMs / 1000} s (proximity in time, not a cause): ${close.slice(0, 12).map((e) => `#${e.seq}`).join(' ')}${close.length > 12 ? ` +${close.length - 12}` : ''}`);
  }
  out.push('');

  out.push(`FAILURES (${s.failures.length})`);
  for (const f of s.failures) out.push(`  #${f.seq}  ${f.code ? `[${f.code}] ` : ''}${f.message}`);
  out.push('');

  if (s.ble.size) {
    out.push(`BLE DEVICES (${s.ble.size}) — ids are as observed by the adapter, not physical identities; RSSI is a level, not a distance`);
    for (const d of [...s.ble.values()].sort((x, y) => y.observations - x.observations))
      out.push(`  ${d.device.padEnd(28)} ${String(d.observations).padStart(6)} obs  RSSI median ${d.rssiMedian === null ? '--' : `${d.rssiMedian} dBm`}  ${d.payloads.length} payload(s)  ${d.name ?? ''}`);
    out.push('');
  }
  out.push('Replay of this session is a visualization: nothing in it is ever sent to a device again.');
  return out.join('\n') + '\n';
}
