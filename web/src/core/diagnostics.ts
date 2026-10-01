/**
 * HARDWARE DOG / DIAGNOSTIC ENGINE
 *
 * Deterministic. No AI, no heuristics that cannot be written down.
 * Every rule, threshold and confidence level is documented in
 * docs/DIAGNOSTICS.md and exercised by test/scenarios.test.ts.
 *
 * The engine reads SessionFacts, a structured record the System keeps as
 * frames arrive. It never reads the trace (the operator can clear it) and
 * never sees the simulator scenario.
 *
 * Output keeps the four levels of spec section 37 apart:
 *   OBSERVED       measured facts, with times
 *   CORRELATION    facts that line up in time, with counts
 *   POSSIBLE CAUSE a hypothesis, with a confidence and its reason
 *   NEXT CHECK     what to measure to confirm or reject it
 */

import type { CheckStatus, Settings } from './types';
import { clock, milliamps, ms, volts } from './format';

/**
 * Version of the rules below. Bump it whenever a rule, a default threshold
 * or a confidence definition changes: recordings carry the version they
 * were made with, and a replay on other rules says so.
 */
export const RULESET_VERSION = 1;

export const DIAGNOSIS_IDS = [
  'POWER_INSTABILITY',
  'SUPPLY_SAG',
  'OVERCURRENT',
  'USB_INTERMITTENT',
  'USB_NOT_ENUMERATED',
  'TARGET_RESET_LOOP',
  'SERIAL_CONFIGURATION_MISMATCH',
  'NO_LINK',
  'DHCP_FAILURE',
  'GATEWAY_UNREACHABLE',
  'DNS_FAILURE',
  'UPSTREAM_FAILURE',
  'NETWORK_UNSTABLE',
] as const;
export type DiagnosisId = (typeof DIAGNOSIS_IDS)[number];

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Diagnosis {
  id: DiagnosisId;
  title: string;
  confidence: Confidence;
  /** Why this confidence, in terms of the evidence count. */
  basis: string;
  observed: string[];
  correlation: string | null;
  cause: string;
  next: string;
  /** Time of the first supporting evidence. */
  since: number;
  /**
   * EVIDENCE REFERENCES: the HDP frames this diagnosis rests on, by their
   * sequence number in the session (1 = first frame received). Identical
   * live, in a replay and through dogd: the same frames arrive in the
   * same order. With the recording id, (recording, seq) names one frame
   * of one .hdlog for good.
   */
  evidence: number[];
}

/** At most this many references per diagnosis: the first and the latest. */
export const EVIDENCE_LIMIT = 64;

function evidence(...seqs: (number | null | undefined)[]): number[] {
  const all = [...new Set(seqs.filter((s): s is number => typeof s === 'number'))].sort((a, b) => a - b);
  if (all.length <= EVIDENCE_LIMIT) return all;
  const half = EVIDENCE_LIMIT / 2;
  return [...all.slice(0, half), ...all.slice(-half)];
}

// ------------------------------------------------------------------ facts

export interface DropFact {
  /** HDP frame that opened the drop. */
  seq: number;
  start: number;
  end: number | null;
  min: number;
}

export interface SpikeFact {
  seq: number;
  start: number;
  end: number | null;
  peak: number;
}

export interface DetachFact {
  seq: number;
  t: number;
  /** Start of the undervoltage that preceded it inside the window, if any. */
  dropAt: number | null;
  dropSeq: number | null;
  dropMin: number | null;
  /** Target current ~100 ms after the disconnect: still running or not. */
  currentAfter: number | null;
}

export interface ResetFact {
  seq: number;
  t: number;
  code: number;
  reason: string;
}

export interface NetFact {
  seq: number;
  t: number;
  linkUp: boolean | null;
  dhcp: CheckStatus;
  gateway: CheckStatus;
  dns: CheckStatus;
  internet: CheckStatus;
  latency: number | null;
  loss: number | null;
}

export interface SessionFacts {
  drops: DropFact[];
  spikes: SpikeFact[];
  attaches: number[];
  detaches: DetachFact[];
  /** Target drawing current while no USB device is enumerated. */
  unenumerated: { since: number | null; longestMs: number; firstAt: number | null; firstSeq: number | null };
  uart: {
    baud: number;
    rxLines: number;
    /** Counters reset whenever the baud rate changes. */
    rxAtBaud: number;
    framingAtBaud: { t: number; seq: number }[];
    resets: ResetFact[];
  };
  net: NetFact[];
}

export const emptyFacts = (): SessionFacts => ({
  drops: [],
  spikes: [],
  attaches: [],
  detaches: [],
  unenumerated: { since: null, longestMs: 0, firstAt: null, firstSeq: null },
  uart: { baud: 115200, rxLines: 0, rxAtBaud: 0, framingAtBaud: [], resets: [] },
  net: [],
});

/** Keep fact lists bounded on long sessions. */
export const FACT_LIMIT = 500;
export const NET_HISTORY = 30;

/** "rst:0x8 (TG1WDT_SYS_RST)" -> reset fact. ESP-IDF boot banner format. */
export function parseResetLine(line: string, t: number, seq = 0): ResetFact | null {
  const m = /rst:0x([0-9a-f]+)\s*\(([A-Z0-9_]+)\)/i.exec(line);
  return m ? { seq, t, code: parseInt(m[1]!, 16), reason: m[2]!.toUpperCase() } : null;
}

// ------------------------------------------------------------------ thresholds

/** Target current above which the target counts as powered and running. */
export const RUNNING_CURRENT = 0.05;
/** Powered without USB for this long means it does not enumerate. */
export const UNENUMERATED_MS = 3000;

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

// ------------------------------------------------------------------ engine

export function diagnose(f: SessionFacts, s: Settings, now: number): Diagnosis[] {
  const out: Diagnosis[] = [];
  const add = (d: Diagnosis) => out.push(d);

  // POWER: disconnects explained by the supply.
  const correlated = f.detaches.filter((d) => d.dropAt !== null);
  const n = f.detaches.length;
  const c = correlated.length;
  if (c > 0) {
    const ratio = c / n;
    const confidence: Confidence = c >= 3 && ratio >= 0.8 ? 'HIGH' : c >= 2 && ratio >= 0.5 ? 'MEDIUM' : 'LOW';
    const minV = Math.min(...f.drops.map((d) => d.min));
    const delays = correlated.map((d) => d.t - d.dropAt!);
    add({
      id: 'POWER_INSTABILITY',
      title: 'POWER INSTABILITY',
      confidence,
      basis: `${c} of ${n} disconnects followed a drop (${pct(c, n)} %)`,
      observed: [
        `${f.drops.length} undervoltage event(s) below ${volts(s.undervoltageThreshold)}, minimum ${volts(minV)}.`,
        `${n} USB disconnect(s), last at ${clock(f.detaches[n - 1]!.t)}.`,
      ],
      correlation: `${c} / ${n} disconnects occurred within ${s.correlationWindowMs} ms of a voltage drop below ${volts(s.undervoltageThreshold)} (delay ${ms(Math.min(...delays))} to ${ms(Math.max(...delays))}).`,
      cause: 'The target browns out when its load rises: the supply or the cable cannot hold the rail.',
      next: 'Measure VBUS at the target under load. Try a shorter / thicker cable or a powered hub.',
      since: correlated[0]!.dropAt!,
      evidence: evidence(...correlated.flatMap((d) => [d.dropSeq, d.seq])),
    });
  } else if (f.drops.length > 0) {
    const minV = Math.min(...f.drops.map((d) => d.min));
    add({
      id: 'SUPPLY_SAG',
      title: 'SUPPLY SAG',
      confidence: f.drops.length >= 3 ? 'MEDIUM' : 'LOW',
      basis: `${f.drops.length} drop(s), none followed by a disconnect`,
      observed: [`${f.drops.length} undervoltage event(s) below ${volts(s.undervoltageThreshold)}, minimum ${volts(minV)}.`],
      correlation: null,
      cause: 'The rail sags under load but the target has survived it so far.',
      next: 'Check the supply margin before it becomes a brownout.',
      since: f.drops[0]!.start,
      evidence: evidence(...f.drops.map((d) => d.seq)),
    });
  }

  // OVERCURRENT
  if (f.spikes.length > 0) {
    const peak = Math.max(...f.spikes.map((x) => x.peak));
    const k = f.spikes.length;
    add({
      id: 'OVERCURRENT',
      title: 'OVERCURRENT',
      confidence: k >= 3 ? 'HIGH' : k === 2 ? 'MEDIUM' : 'LOW',
      basis: `${k} event(s) above the limit`,
      observed: [`${k} event(s) above ${milliamps(s.overcurrentThreshold)}, peak ${milliamps(peak)}.`],
      correlation: null,
      cause: 'The target draws more than the configured limit: stalled motor, short circuit, or an undersized limit.',
      next: 'Identify the load active at those times; confirm the limit matches the port and the target.',
      since: f.spikes[0]!.start,
      evidence: evidence(...f.spikes.map((x) => x.seq)),
    });
  }

  // USB: disconnects the supply does not explain.
  const unexplained = f.detaches.filter((d) => d.dropAt === null);
  if (unexplained.length >= 2) {
    const u = unexplained.length;
    const kept = unexplained.filter((d) => d.currentAfter !== null && d.currentAfter >= RUNNING_CURRENT).length;
    add({
      id: 'USB_INTERMITTENT',
      title: 'INTERMITTENT USB',
      confidence: u >= 3 ? 'HIGH' : 'MEDIUM',
      basis: `${u} disconnects with no voltage drop in the window`,
      observed: [
        `${u} USB disconnect(s) with the rail above ${volts(s.undervoltageThreshold)}.`,
        `Target kept drawing current after ${kept} of ${u} of them.`,
      ],
      correlation: kept * 2 > u ? `${kept} / ${u} disconnects happened while the target stayed powered.` : null,
      cause:
        kept * 2 > u
          ? 'The USB data link drops while the target keeps running: connector, cable data pairs, or the target USB stack.'
          : 'USB link loss that the supply does not explain.',
      next: 'Wiggle-test the connector, swap the cable, then check the target USB stack logs.',
      since: unexplained[0]!.t,
      evidence: evidence(...unexplained.map((d) => d.seq)),
    });
  }

  // USB: powered but never enumerated.
  const un = f.unenumerated;
  const running = un.since !== null ? Math.max(un.longestMs, now - un.since) : un.longestMs;
  if (running >= UNENUMERATED_MS && un.firstAt !== null && (un.since !== null || f.attaches.length === 0)) {
    add({
      id: 'USB_NOT_ENUMERATED',
      title: 'USB NOT ENUMERATED',
      confidence: running >= 10_000 && f.attaches.length === 0 ? 'HIGH' : 'MEDIUM',
      basis: `powered ${ms(running)} with no USB device${f.attaches.length === 0 ? ', never enumerated' : ''}`,
      observed: [`Target drew more than ${milliamps(RUNNING_CURRENT)} for ${ms(running)} with no USB device present.`],
      correlation: null,
      cause: 'The target is powered but does not enumerate: charge-only cable, broken data lines, or target USB firmware.',
      next: 'Try a known data cable, then check the target boots its USB stack (serial log).',
      since: un.firstAt,
      evidence: evidence(un.firstSeq),
    });
  }

  // TARGET: resets that are not power cycles.
  const resets = f.uart.resets.filter((r) => r.code !== 0x1 && !/BROWN/.test(r.reason));
  if (resets.length >= 2) {
    const reasons = [...new Set(resets.map((r) => r.reason))];
    const gaps = resets.slice(1).map((r, i) => r.t - resets[i]!.t);
    const wdt = reasons.some((r) => /WDT/.test(r));
    add({
      id: 'TARGET_RESET_LOOP',
      title: 'TARGET RESET LOOP',
      confidence: resets.length >= 3 ? 'HIGH' : 'MEDIUM',
      basis: `${resets.length} non-power resets reported by the target`,
      observed: [
        `${resets.length} target resets, reason ${reasons.join(', ')}.`,
        `Interval ${ms(Math.min(...gaps))} to ${ms(Math.max(...gaps))}.`,
      ],
      correlation: null,
      cause: wdt
        ? 'Watchdog resets: the firmware hangs or a task blocks.'
        : 'The firmware restarts itself (panic or software reset).',
      next: 'Read the lines before each reset on SERIAL; look for the task that stops feeding the watchdog.',
      since: resets[0]!.t,
      evidence: evidence(...resets.map((r) => r.seq)),
    });
  }

  // SERIAL: framing errors at the current baud rate.
  const e = f.uart.framingAtBaud.length;
  const lastE = f.uart.framingAtBaud.at(-1)?.t;
  if (e >= 3 && lastE !== undefined && now - lastE < 15_000) {
    const ratio = e / Math.max(1, f.uart.rxAtBaud);
    if (ratio >= 0.3) {
      add({
        id: 'SERIAL_CONFIGURATION_MISMATCH',
        title: 'SERIAL CONFIGURATION MISMATCH',
        confidence: e >= 5 && ratio >= 0.8 ? 'HIGH' : 'MEDIUM',
        basis: `${e} framing errors on ${f.uart.rxAtBaud} lines (${pct(e, f.uart.rxAtBaud)} %)`,
        observed: [`${e} framing errors at ${f.uart.baud} baud, on ${pct(e, f.uart.rxAtBaud)} % of received lines.`],
        correlation: null,
        cause: 'The target UART runs at another baud rate (or data / parity / stop bits differ).',
        next: 'Try common rates on SERIAL: 9600, 57600, 115200, 921600. Errors stop at the right one.',
        since: f.uart.framingAtBaud[0]!.t,
        evidence: evidence(...f.uart.framingAtBaud.map((x) => x.seq)),
      });
    }
  }

  // NETWORK: the lowest failing layer explains everything above it.
  const net = diagnoseNetwork(f.net);
  if (net) add(net);

  return out;
}

type Layer = 'NO_LINK' | 'DHCP_FAILURE' | 'GATEWAY_UNREACHABLE' | 'UPSTREAM_FAILURE' | 'DNS_FAILURE';

function failingLayer(r: NetFact): Layer | null {
  if (r.linkUp === false) return 'NO_LINK';
  if (r.dhcp === 'FAIL') return 'DHCP_FAILURE';
  if (r.gateway === 'FAIL') return 'GATEWAY_UNREACHABLE';
  // No Internet beyond a working gateway: DNS failing too is a consequence.
  if (r.internet === 'FAIL') return 'UPSTREAM_FAILURE';
  if (r.dns === 'FAIL') return 'DNS_FAILURE';
  return null;
}

const LAYER_TEXT: Record<Layer, { title: string; cause: string; next: string }> = {
  NO_LINK: {
    title: 'NO NETWORK LINK',
    cause: 'No physical link: cable, port, or the far switch.',
    next: 'Check the cable and the switch port LEDs; try another port.',
  },
  DHCP_FAILURE: {
    title: 'DHCP FAILURE',
    cause: 'The link is up but no DHCP server answers: server down, wrong VLAN, or exhausted pool.',
    next: 'Check the DHCP server and the VLAN of this port; try a static address to confirm.',
  },
  GATEWAY_UNREACHABLE: {
    title: 'GATEWAY UNREACHABLE',
    cause: 'An address was obtained but the gateway does not answer.',
    next: 'Probe the gateway (PROBE); check the router and the subnet mask.',
  },
  UPSTREAM_FAILURE: {
    title: 'UPSTREAM FAILURE',
    cause: 'The LAN and the gateway work; the connection beyond the gateway is down.',
    next: 'Check the WAN link / ISP status on the router. DNS failures here are a consequence.',
  },
  DNS_FAILURE: {
    title: 'DNS FAILURE',
    cause: 'The network works but the configured DNS server does not answer.',
    next: 'Probe another resolver (PROBE, DNS test); check the DNS server handed out by DHCP.',
  },
};

function diagnoseNetwork(history: NetFact[]): Diagnosis | null {
  const latest = history.at(-1);
  if (!latest) return null;
  const layer = failingLayer(latest);

  if (layer) {
    let streak = 0;
    for (let i = history.length - 1; i >= 0 && failingLayer(history[i]!) === layer; i--) streak++;
    const first = history[history.length - streak]!;
    let confidence: Confidence = streak >= 3 ? 'HIGH' : streak === 2 ? 'MEDIUM' : 'LOW';
    // Without an Internet check we cannot rule out an upstream failure.
    if (layer === 'DNS_FAILURE' && latest.internet !== 'PASS' && confidence === 'HIGH') confidence = 'MEDIUM';
    const text = LAYER_TEXT[layer];
    const passing = (['dhcp', 'gateway', 'dns', 'internet'] as const).filter((k) => latest[k] === 'PASS').map((k) => k.toUpperCase());
    return {
      id: layer,
      title: text.title,
      confidence,
      basis: `failing in ${streak} consecutive report(s)`,
      observed: [
        `${text.title.split(' ')[0]} failing since ${clock(first.t)} (${streak} report(s)).`,
        passing.length ? `Still passing: ${passing.join(', ')}.` : 'No layer above it could be checked.',
      ],
      correlation: null,
      cause: text.cause,
      next: text.next,
      since: first.t,
      evidence: evidence(...history.slice(history.length - streak).map((r) => r.seq)),
    };
  }

  // Every layer answers: is the path stable?
  const recent = history.slice(-10).filter((r) => r.latency !== null);
  if (recent.length < 5) return null;
  const lat = recent.map((r) => r.latency!).sort((a, b) => a - b);
  const median = lat[Math.floor(lat.length / 2)]!;
  const min = lat[0]!;
  const max = lat[lat.length - 1]!;
  const lossAvg = recent.reduce((sum, r) => sum + (r.loss ?? 0), 0) / recent.length;
  // Jitter: the path swings by 100 ms or more and reaches 150 ms.
  const jitter = max >= 150 && max - min >= 100;
  const lossy = lossAvg >= 2;
  if (!jitter && !lossy) return null;
  return {
    id: 'NETWORK_UNSTABLE',
    title: 'UNSTABLE NETWORK',
    confidence: jitter && lossy ? 'HIGH' : 'MEDIUM',
    basis: `${recent.length} reports: ${jitter ? 'latency spikes' : ''}${jitter && lossy ? ' + ' : ''}${lossy ? 'packet loss' : ''}`,
    observed: [
      `Latency ${ms(min)} to ${ms(max)} (median ${ms(median)}) over ${recent.length} reports.`,
      `Average packet loss ${lossAvg.toFixed(1)} %.`,
    ],
    correlation: null,
    cause: 'Every layer answers but the path is unreliable: weak Wi-Fi, congestion, or a failing link.',
    next: 'Compare wired vs Wi-Fi; probe the gateway repeatedly to see if loss starts on the LAN.',
    since: recent[0]!.t,
    evidence: evidence(...recent.map((r) => r.seq)),
  };
}
