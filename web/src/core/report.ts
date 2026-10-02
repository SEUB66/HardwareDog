import { BANNER, DESCRIPTOR, TAGLINE } from './ascii';
import type { System } from './system';
import type { Meter } from './protocol';
import type { Diagnosis } from './diagnostics';
import { RULESET_VERSION, diagnose } from './diagnostics';
import type { Footer, IntegrityStatus, Origin } from './session';

const CLOSED_TEXT: Record<Footer['closed'], string> = {
  NORMAL: 'NORMAL, by the recorder',
  RECOVERED: 'RECOVERED after an unclean stop',
  SNAPSHOT: 'SNAPSHOT, exported while recording',
};
import { clock, duration, frequency, hex, i2cAddress, milliamps, ms, percent, sessionId, volts, NO_VALUE } from './format';
import type { TraceEvent } from './types';

/**
 * Diagnostic report generation.
 *
 * Findings come from the diagnostic engine only (core/diagnostics.ts).
 * They are typed so the report can never blur the line between what was
 * measured, what lines up in time, what might explain it, and what to
 * check next.
 */
export type FindingKind = 'OBSERVED' | 'CORRELATION' | 'POSSIBLE CAUSE' | 'NEXT CHECK';

export interface Finding {
  kind: FindingKind;
  text: string;
  diagnosis: Diagnosis['id'];
}

export type SectionResult = 'PASS' | 'WARNING' | 'FAIL' | 'NO DATA';

export interface ReportSection {
  title: string;
  rows: [string, string][];
  result: SectionResult;
  notes: string[];
}

export interface Report {
  session: string;
  device: string;
  firmware: string;
  source: string;
  simulated: boolean;
  /** The recording behind this report: live, or the file being replayed. */
  recording: RecordingRef | null;
  startedAt: number;
  generatedAt: number;
  duration: string;
  sections: ReportSection[];
  diagnoses: Diagnosis[];
  findings: Finding[];
  /** What the power numbers are worth, as the device declared it. Null: not declared. */
  measurement: Meter | null;
  /** The events the diagnoses rest on, with a little context around them. */
  timeline: TimelineExcerpt;
}

export interface TimelineEntry {
  t: number;
  source: TraceEvent['source'];
  severity: TraceEvent['severity'];
  message: string;
  value: string | null;
  seq: number | null;
  /** A diagnosis cites this event's frame, or a rule produced it. */
  evidence: boolean;
}

export interface TimelineExcerpt {
  entries: TimelineEntry[];
  /** Events of the session not shown here (the full trace is in the JSON export). */
  omitted: number;
  /** How the excerpt was chosen, said in the report. */
  basis: 'EVIDENCE' | 'WARNINGS' | 'LATEST' | 'EMPTY';
}

const CONTEXT = 2;

/**
 * A technician reads a timeline, not a list of counts. The excerpt is the
 * events the diagnoses cite (and the rule events), each with the two
 * events before and after it. Without a diagnosis: the warnings, else the
 * latest events. Chronological, capped, and it says what it left out.
 */
export function timelineExcerpt(events: readonly TraceEvent[], diagnoses: readonly Diagnosis[], limit = 60): TimelineExcerpt {
  const cited = new Set(diagnoses.flatMap((d) => d.evidence));
  const isEvidence = (e: TraceEvent) => (e.seq !== undefined && cited.has(e.seq)) || e.source === 'RULE';
  let picked: number[] = [];
  let basis: TimelineExcerpt['basis'] = 'EVIDENCE';
  const keys = events.flatMap((e, i) => (isEvidence(e) ? [i] : []));
  if (keys.length > 0) {
    const set = new Set<number>();
    for (const i of keys) for (let k = Math.max(0, i - CONTEXT); k <= Math.min(events.length - 1, i + CONTEXT); k++) set.add(k);
    picked = [...set].sort((a, b) => a - b);
  } else {
    const warn = events.flatMap((e, i) => (e.severity === 'WARN' || e.severity === 'FAIL' ? [i] : []));
    basis = warn.length ? 'WARNINGS' : events.length ? 'LATEST' : 'EMPTY';
    picked = warn.length ? warn.slice(-20) : events.map((_, i) => i).slice(-10);
  }
  const shown = picked.slice(0, limit);
  return {
    entries: shown.map((i) => {
      const e = events[i]!;
      return { t: e.t, source: e.source, severity: e.severity, message: e.message, value: e.value ?? null, seq: e.seq ?? null, evidence: isEvidence(e) };
    }),
    omitted: events.length - shown.length,
    basis,
  };
}

const TIMELINE_BASIS: Record<TimelineExcerpt['basis'], string> = {
  EVIDENCE: 'events cited as evidence (>), with 2 events of context on each side',
  WARNINGS: 'no diagnosis: the warnings of the session',
  LATEST: 'no diagnosis, no warning: the latest events',
  EMPTY: 'no event recorded',
};

/** One timeline line, the same in every format. */
export function timelineLine(e: TimelineEntry): string {
  const mark = e.evidence ? '>' : ' ';
  const seq = e.seq !== null ? ` #${e.seq}` : '';
  return `${mark} ${clock(e.t)}  ${e.source.padEnd(5)} ${e.severity.padEnd(4)}  ${e.message}${e.value ? `  ${e.value}` : ''}${seq}`;
}

export interface RecordingRef {
  id: string;
  origin: Origin;
  /** null while the session is still being recorded live. */
  integrity: IntegrityStatus | null;
  fileSha256: string | null;
  problems: string[];
  closed: Footer['closed'] | null;
  /** Ruleset the recording was made with, and the one that produced this report. */
  ruleset: number;
  rulesetNow: number;
}

function recordingRef(sys: System): RecordingRef | null {
  const h = sys.replayOf ?? sys.recorder?.header ?? null;
  if (!h) return null;
  const i = sys.replayOf ? sys.replayIntegrity : null;
  return {
    id: h.recording,
    origin: h.origin,
    integrity: i?.status ?? null,
    fileSha256: i?.fileSha256 ?? null,
    problems: i?.problems ?? [],
    closed: i?.footer?.closed ?? null,
    ruleset: h.ruleset,
    rulesetNow: RULESET_VERSION,
  };
}

export function buildReport(sys: System, now = sys.now()): Report {
  const p = sys.power;
  const u = sys.usb;
  const s = sys.serial;
  const n = sys.net;
  const cfg = sys.settings;
  const sections: ReportSection[] = [];
  const diagnoses = diagnose(sys.facts, cfg, now);
  const findings: Finding[] = diagnoses.flatMap((d): Finding[] => [
    ...d.observed.map((text) => ({ kind: 'OBSERVED' as const, text, diagnosis: d.id })),
    ...(d.correlation ? [{ kind: 'CORRELATION' as const, text: d.correlation, diagnosis: d.id }] : []),
    { kind: 'POSSIBLE CAUSE', text: d.cause, diagnosis: d.id },
    { kind: 'NEXT CHECK', text: d.next, diagnosis: d.id },
  ]);

  // POWER
  const avgV = p.sampleCount ? p.voltageSum / p.sampleCount : null;
  const avgI = p.sampleCount ? p.currentSum / p.sampleCount : null;
  const powerResult: SectionResult = p.sampleCount === 0 ? 'NO DATA' : p.dropCount > 0 ? 'WARNING' : 'PASS';
  const powerNotes: string[] = [];
  if (p.dropCount > 0) powerNotes.push('Voltage instability detected.');
  sections.push({
    title: 'POWER',
    result: powerResult,
    notes: powerNotes,
    rows: [
      ['AVG VOLTAGE', volts(avgV)],
      ['MIN VOLTAGE', volts(p.minVoltage)],
      ['AVG CURRENT', milliamps(avgI)],
      ['PEAK CURRENT', milliamps(p.peakCurrent)],
      ['UNDERVOLTAGE EVENTS', String(p.dropCount)],
      ['SAMPLES', String(p.sampleCount)],
    ],
  });

  // USB
  const usbWatched = sys.observes('usb');
  const usbResult: SectionResult = !usbWatched || u.connections === 0 ? 'NO DATA' : u.disconnects > 0 ? 'WARNING' : 'PASS';
  const usbNotes: string[] = usbWatched ? [] : ['This device does not monitor USB (no USB host port): no USB observation is made.'];
  if (u.correlatedDisconnects > 0) {
    usbNotes.push(`${u.correlatedDisconnects} / ${u.disconnects} disconnects within ${cfg.correlationWindowMs} ms of a voltage drop.`);
  }
  const d = u.descriptor;
  sections.push({
    title: 'USB',
    result: usbResult,
    notes: usbNotes,
    rows: [
      ['STATE', !usbWatched ? 'NOT MONITORED' : u.connected ? 'CONNECTED' : 'DISCONNECTED'],
      ['DEVICE', d ? `${hex(d.vid)}:${hex(d.pid)} ${d.deviceClass}` : NO_VALUE],
      ['PRODUCT', d?.product ?? NO_VALUE],
      ['CONNECTIONS', String(u.connections)],
      ['DISCONNECTS', String(u.disconnects)],
    ],
  });

  // SERIAL
  const serialResult: SectionResult = !s.active ? 'NO DATA' : s.errors > 0 ? 'WARNING' : 'PASS';
  sections.push({
    title: 'SERIAL',
    result: serialResult,
    notes: [],
    rows: [
      ['PORT', s.port],
      ['CONFIG', `${s.baud} ${s.dataBits}${s.parity[0]}${s.stopBits}`],
      ['RX', `${s.rxBytes} B`],
      ['TX', `${s.txBytes} B`],
      ['ERRORS', String(s.errors)],
    ],
  });

  // BUS
  const b = sys.bus;
  sections.push({
    title: 'I2C BUS',
    result: b.lastScanAt === null ? 'NO DATA' : 'PASS',
    notes: b.devices.some((x) => !x.confirmed) ? ['Unconfirmed addresses are reported as UNKNOWN.'] : [],
    rows: [
      ['SPEED', frequency(b.speedHz)],
      ...b.devices.map((x): [string, string] => [i2cAddress(x.address), x.confirmed ?? 'UNKNOWN']),
    ],
  });

  // NETWORK
  const netChecks = [n.dhcp, n.gateway.status, n.dns.status, n.internet];
  const netResult: SectionResult =
    n.updatedAt === null ? 'NO DATA' : netChecks.includes('FAIL') ? 'FAIL' : netChecks.includes('WARN') ? 'WARNING' : 'PASS';
  sections.push({
    title: 'NETWORK',
    result: netResult,
    notes: [],
    rows: [
      ['LINK', n.link ? (n.link.up ? `UP ${n.link.mbps ?? '--'} Mbps / ${n.link.duplex ?? '--'}` : 'DOWN') : NO_VALUE],
      ['ADDRESS', n.address ?? NO_VALUE],
      ['DHCP', n.dhcp],
      ['GATEWAY', `${n.gateway.address ?? NO_VALUE} ${n.gateway.status}`],
      ['DNS', `${n.dns.address ?? NO_VALUE} ${n.dns.status}`],
      ['INTERNET', n.internet],
      ['LATENCY', ms(n.latencyMs)],
      ['PACKET LOSS', percent(n.packetLoss)],
    ],
  });

  // PROBES
  if (sys.probes.length > 0) {
    const rows: [string, string][] = [];
    for (const run of [...sys.probes].reverse()) {
      for (const r of run.results) rows.push([`${run.target} ${r.test}`, `${r.status}  ${r.detail}`]);
    }
    const anyFail = sys.probes.some((r) => r.results.some((x) => x.status === 'FAIL'));
    sections.push({ title: 'PROBES', result: anyFail ? 'FAIL' : 'PASS', notes: [], rows });
  }

  return {
    session: sys.replayOf?.id ?? sessionId(sys.startedAt),
    device: sys.device.id,
    firmware: sys.device.firmware,
    source: reportSource(sys),
    simulated: sys.origin === 'SIMULATED',
    recording: recordingRef(sys),
    startedAt: sys.startedAt,
    generatedAt: now,
    duration: duration(now - sys.startedAt),
    sections,
    diagnoses,
    findings,
    measurement: sys.meter,
    timeline: timelineExcerpt(sys.trace.all(), diagnoses),
  };
}

/** Lines saying what the measurements are worth (LVL 65). Shared by every format. */
export function measurementLines(m: Meter | null): [string, string][] {
  if (!m) return [['METER', 'NOT DECLARED BY THE DEVICE: ACCURACY UNKNOWN']];
  // Three significant digits: 1.25 mV stays 1.25 mV, not "1.3".
  const mv = (x: number) => `${Number((x * 1000).toPrecision(3))} mV`;
  const ma = (x: number) => `${Number((x * 1000).toPrecision(3))} mA`;
  return [
    ['SENSOR', `${m.sensor}, shunt ${m.shunt_ohm} ohm`],
    ['RANGE', `0-${m.v_max} V / +-${m.i_max} A`],
    ['RESOLUTION', `${mv(m.v_res)} / ${ma(m.i_res)}`],
    ['RATE', `${m.rate_hz} samples/s`],
    ['VOLTAGE ERROR', `+-${m.v_err.pct}% + ${mv(m.v_err.abs)}`],
    ['CURRENT ERROR', `+-${m.i_err.pct}% + ${ma(m.i_err.abs)}`],
    ['BASIS', m.cal ? `CALIBRATED ${m.cal.date} against ${m.cal.ref}` : 'DATASHEET, NOT CALIBRATED'],
  ];
}

export const METROLOGY = 'DIAGNOSTIC MEASUREMENT, NOT CERTIFIED METROLOGY.';

/** A replay names what it replays: a recording keeps its origin. */
function reportSource(sys: System): string {
  const r = sys.replayOf;
  if (!r) return sys.transportKind ?? 'NONE';
  return `REPLAY OF ${r.origin} / ${r.id} / ${r.source}${r.scenario ? ` ${r.scenario}` : ''}`;
}

/** "HDP frames #12 #48 #97 (3)": the frames of the recording a diagnosis rests on. */
export function evidenceText(seqs: readonly number[]): string {
  if (seqs.length === 0) return 'none';
  const shown = seqs.length > 12 ? [...seqs.slice(0, 6), '...', ...seqs.slice(-6)] : seqs;
  return `HDP frames ${shown.map((s) => (typeof s === 'number' ? `#${s}` : s)).join(' ')} (${seqs.length})`;
}

const RULE = '--------------------------------';

/** How a line of the report is set: the same words in every format, only the emphasis changes. */
export type LineStyle = 'normal' | 'banner' | 'title' | 'alert' | 'note' | 'evidence' | 'rule';

export interface DocLine {
  text: string;
  style: LineStyle;
}

/**
 * The report as styled lines. TXT, HTML and PDF are all made from this,
 * so no format can say something another one does not.
 */
export function reportLines(r: Report, options: { banner?: boolean } = {}): DocLine[] {
  const out: DocLine[] = [];
  const line = (text: string, style: LineStyle = 'normal') => out.push({ text, style });
  const blank = () => line('');
  const kv = (k: string, v: string) => line(`${k.padEnd(22)}${v}`);
  const section = (title: string) => {
    blank();
    line(RULE, 'rule');
    blank();
    line(title, 'title');
    blank();
  };
  if (options.banner ?? true) {
    for (const b of BANNER.split('\n')) line(b, 'banner');
    blank();
    line(DESCRIPTOR);
    blank();
  }
  line('HARDWARE DOG', 'title');
  line('DIAGNOSTIC REPORT', 'title');
  blank();
  kv('SESSION', r.session);
  kv('DEVICE', r.device);
  kv('FIRMWARE', r.firmware);
  kv('SOURCE', r.source);
  kv('DURATION', r.duration);
  kv('GENERATED', `${new Date(r.generatedAt).toISOString()}`);
  const rec = r.recording;
  if (rec) {
    kv('RECORDING', rec.id || 'hdlog v1, no recording id');
    kv('ORIGIN', rec.origin);
    if (rec.integrity === null) kv('INTEGRITY', 'RECORDING, NOT FINALIZED: hashed when the session ends');
    else kv('INTEGRITY', rec.integrity);
    if (rec.closed) kv('CLOSED', CLOSED_TEXT[rec.closed]);
    if (rec.fileSha256) kv('FILE SHA-256', rec.fileSha256);
    kv('RULESET', rec.ruleset === rec.rulesetNow || rec.integrity === null ? `v${rec.rulesetNow}` : `recorded v${rec.ruleset}, diagnosed v${rec.rulesetNow}`);
  }
  if (r.simulated) {
    blank();
    line('!! SIMULATED DATA. NOT A MEASUREMENT OF REAL HARDWARE.', 'alert');
  }
  if (rec?.integrity === 'MODIFIED') {
    blank();
    line('!! MODIFIED RECORDING. BYTES CHANGED AFTER THEY WERE SEALED. NOT EVIDENCE.', 'alert');
    for (const p of rec.problems) line(`   ${p}`, 'alert');
  }
  if (rec?.integrity === 'INCOMPLETE') {
    blank();
    line('!! INCOMPLETE RECORDING. NEVER FINALIZED: SEALED LINES ARE INTACT, THE END IS MISSING.', 'alert');
  }
  if (rec?.integrity === 'RECOVERED') {
    blank();
    line('NOTE  Recording closed after an unclean stop (RECOVERED). Every sealed line is intact.', 'note');
  }
  if (rec?.integrity === 'UNVERIFIED') {
    blank();
    line('NOTE  hdlog v1 file: no integrity data. Content cannot be verified.', 'note');
  }

  section('MEASUREMENT');
  for (const [k, v] of measurementLines(r.measurement)) kv(k, v);
  blank();
  line(METROLOGY, 'note');

  for (const s of r.sections) {
    section(s.title);
    for (const [k, v] of s.rows) kv(k, v);
    blank();
    line('RESULT');
    line(s.result, s.result === 'PASS' || s.result === 'NO DATA' ? 'normal' : 'alert');
    if (s.notes.length) {
      blank();
      for (const n of s.notes) line(n);
    }
  }

  section('DIAGNOSIS');
  if (r.diagnoses.length === 0) {
    line('NO FINDINGS');
    line('No diagnostic rule matched this session.');
    blank();
  }
  r.diagnoses.forEach((d, n) => {
    line(`[${n + 1}] ${d.title.padEnd(34)}CONFIDENCE ${d.confidence}`, 'alert');
    line(`    basis: ${d.basis}`);
    line(`    evidence: ${evidenceText(d.evidence)}`);
    blank();
    for (const f of r.findings.filter((x) => x.diagnosis === d.id)) kv(f.kind, f.text);
    blank();
  });
  if (r.diagnoses.length > 0) {
    line('POSSIBLE CAUSE is a hypothesis ranked by the evidence above.', 'note');
    line('Confidence rules: docs/DIAGNOSTICS.md', 'note');
    blank();
  }

  line(RULE, 'rule');
  blank();
  line('TIMELINE EXCERPT', 'title');
  blank();
  line(TIMELINE_BASIS[r.timeline.basis], 'note');
  blank();
  for (const e of r.timeline.entries) line(timelineLine(e), e.evidence ? 'evidence' : 'normal');
  if (r.timeline.omitted > 0) {
    blank();
    line(`${r.timeline.omitted} other events not shown: full trace in the JSON export and the .hdlog.`, 'note');
  }
  blank();

  line(RULE, 'rule');
  blank();
  line('MODE          LOCAL');
  line('DEVICE DATA   LOCAL ONLY');
  blank();
  line(`${DESCRIPTOR} // ${TAGLINE}`);
  blank();
  return out;
}

/** Plain-text report. Readable with no color, no fonts, no software. */
export function reportToText(r: Report, options: { banner?: boolean } = {}): string {
  return reportLines(r, options)
    .map((l) => l.text)
    .join('\n');
}
