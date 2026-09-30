import { BANNER, DESCRIPTOR, TAGLINE } from './ascii';
import type { System } from './system';
import type { Diagnosis } from './diagnostics';
import { diagnose } from './diagnostics';
import { duration, frequency, hex, i2cAddress, milliamps, ms, percent, sessionId, volts, NO_VALUE } from './format';

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
  startedAt: number;
  generatedAt: number;
  duration: string;
  sections: ReportSection[];
  diagnoses: Diagnosis[];
  findings: Finding[];
}

export function buildReport(sys: System, now = Date.now()): Report {
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
  const usbResult: SectionResult = u.connections === 0 ? 'NO DATA' : u.disconnects > 0 ? 'WARNING' : 'PASS';
  const usbNotes: string[] = [];
  if (u.correlatedDisconnects > 0) {
    usbNotes.push(`${u.correlatedDisconnects} / ${u.disconnects} disconnects within ${cfg.correlationWindowMs} ms of a voltage drop.`);
  }
  const d = u.descriptor;
  sections.push({
    title: 'USB',
    result: usbResult,
    notes: usbNotes,
    rows: [
      ['STATE', u.connected ? 'CONNECTED' : 'DISCONNECTED'],
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
    session: sessionId(sys.startedAt),
    device: sys.device.id,
    firmware: sys.device.firmware,
    source: sys.transportKind ?? 'NONE',
    simulated: sys.transportKind === 'SIMULATOR',
    startedAt: sys.startedAt,
    generatedAt: now,
    duration: duration(now - sys.startedAt),
    sections,
    diagnoses,
    findings,
  };
}

const RULE = '--------------------------------';

/** Plain-text report. Readable with no color, no fonts, no software. */
export function reportToText(r: Report, options: { banner?: boolean } = {}): string {
  const out: string[] = [];
  const kv = (k: string, v: string) => out.push(`${k.padEnd(22)}${v}`);
  if (options.banner ?? true) out.push(BANNER, '', DESCRIPTOR, '');
  out.push('HARDWARE DOG', 'DIAGNOSTIC REPORT', '');
  kv('SESSION', r.session);
  kv('DEVICE', r.device);
  kv('FIRMWARE', r.firmware);
  kv('SOURCE', r.source);
  kv('DURATION', r.duration);
  kv('GENERATED', `${new Date(r.generatedAt).toISOString()}`);
  if (r.simulated) out.push('', '!! SIMULATED DATA. NOT A MEASUREMENT OF REAL HARDWARE.');

  for (const s of r.sections) {
    out.push('', RULE, '', s.title, '');
    for (const [k, v] of s.rows) kv(k, v);
    out.push('', 'RESULT', s.result);
    if (s.notes.length) out.push('', ...s.notes);
  }

  out.push('', RULE, '', 'DIAGNOSIS', '');
  if (r.diagnoses.length === 0) out.push('NO FINDINGS', 'No diagnostic rule matched this session.', '');
  r.diagnoses.forEach((d, n) => {
    out.push(`[${n + 1}] ${d.title.padEnd(34)}CONFIDENCE ${d.confidence}`, `    basis: ${d.basis}`, '');
    for (const f of r.findings.filter((x) => x.diagnosis === d.id)) kv(f.kind, f.text);
    out.push('');
  });
  if (r.diagnoses.length > 0) {
    out.push('POSSIBLE CAUSE is a hypothesis ranked by the evidence above.', 'Confidence rules: docs/DIAGNOSTICS.md', '');
  }

  out.push(RULE, '', 'MODE          LOCAL', 'DEVICE DATA   LOCAL ONLY', '', `${DESCRIPTOR} // ${TAGLINE}`, '');
  return out.join('\n');
}
