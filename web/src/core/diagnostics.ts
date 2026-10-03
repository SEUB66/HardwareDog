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
import type { Clk } from './pack';
import { relation } from './pack';
import { clock, milliamps, ms, volts } from './format';

/**
 * Version of the rules below. Bump it whenever a rule, a default threshold
 * or a confidence definition changes: recordings carry the version they
 * were made with, and a replay on other rules says so.
 */
export const RULESET_VERSION = 3; // 3: NETWORK_POWER_LOSS, I2C_DEVICE_DISAPPEARED, I2C_BUS_INSTABILITY

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
  'NETWORK_POWER_LOSS',
  'I2C_DEVICE_DISAPPEARED',
  'I2C_BUS_INSTABILITY',
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

/** "+-4 ms", "+-2 to 9 ms", "unbounded": how well two probes' clocks agree. */
function alignment(margins: (number | null)[]): string {
  if (margins.some((m) => m === null || !Number.isFinite(m))) return 'without a bound (no time sample yet)';
  const ms = margins as number[];
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  const r = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString());
  return lo === hi ? `to +-${r(hi)} ms` : `to +-${r(lo)} to ${r(hi)} ms`;
}

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
  /** The clock it was read on, in a pack (several Dogs). */
  clk?: Clk;
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
  clk?: Clk;
  /**
   * In a pack: the drop and the disconnect came from two clocks whose
   * alignment (this margin, ms; null: unbounded) cannot tell whether the
   * disconnect followed the drop inside the window. Neither explained nor
   * unexplained: said as it is.
   */
  undetermined?: number | null;
}

export interface ResetFact {
  seq: number;
  t: number;
  code: number;
  reason: string;
  clk?: Clk;
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
  clk?: Clk;
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
  i2c: { scans: I2cScanFact[]; errors: I2cErrorFact[] };
  outages: NetOutageFact[];
}

export const emptyFacts = (): SessionFacts => ({
  drops: [],
  spikes: [],
  attaches: [],
  detaches: [],
  unenumerated: { since: null, longestMs: 0, firstAt: null, firstSeq: null },
  uart: { baud: 115200, rxLines: 0, rxAtBaud: 0, framingAtBaud: [], resets: [] },
  net: [],
  i2c: { scans: [], errors: [] },
  outages: [],
});

/** Keep fact lists bounded on long sessions. */
export const FACT_LIMIT = 500;
export const NET_HISTORY = 30;

/** "rst:0x8 (TG1WDT_SYS_RST)" -> reset fact. ESP-IDF boot banner format. */
export function parseResetLine(line: string, t: number, seq = 0): ResetFact | null {
  const m = /rst:0x([0-9a-f]+)\s*\(([A-Z0-9_]+)\)/i.exec(line);
  return m ? { seq, t, code: parseInt(m[1]!, 16), reason: m[2]!.toUpperCase() } : null;
}

/** One scan of the target I2C bus: the addresses that answered. */
export interface I2cScanFact {
  seq: number;
  t: number;
  addresses: number[];
  clk?: Clk;
}

export interface I2cErrorFact {
  seq: number;
  t: number;
  kind: string;
  clk?: Clk;
}

/**
 * The network link went down, and how it came back: link, DHCP, DNS.
 * `cause` is what preceded it inside NET_POWER_WINDOW_MS, if anything.
 */
export interface NetOutageFact {
  seq: number;
  t: number;
  cause: null | { kind: 'DROP' | 'RESET'; t: number; seq: number; text: string };
  clk?: Clk;
  /** In a pack: a drop or reset that the clocks' alignment (ms, null: unbounded) cannot place. */
  undetermined?: number | null;
  upAt: number | null;
  upSeq: number | null;
  dhcpAt: number | null;
  dhcpSeq: number | null;
  dnsAt: number | null;
  dnsSeq: number | null;
}

// ------------------------------------------------------------------ thresholds

/** Target current above which the target counts as powered and running. */
export const RUNNING_CURRENT = 0.05;
/** Powered without USB for this long means it does not enumerate. */
export const UNENUMERATED_MS = 3000;
/**
 * A link that goes down this soon after a voltage drop or a target reset
 * went down with it. Seconds, not milliseconds: the link is reported by
 * net.status, and a rebooting network device takes time to drop it.
 */
export const NET_POWER_WINDOW_MS = 5000;
/** An I2C device lost this soon after a voltage drop was lost with it. */
export const I2C_POWER_WINDOW_MS = 2000;

const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));

// ------------------------------------------------------------------ engine

export function diagnose(f: SessionFacts, s: Settings, now: number): Diagnosis[] {
  const out: Diagnosis[] = [];
  const add = (d: Diagnosis) => out.push(d);

  // POWER: disconnects explained by the supply.
  const correlated = f.detaches.filter((d) => d.dropAt !== null);
  // In a pack, a disconnect the clocks cannot place is neither.
  const unplaced = f.detaches.filter((d) => d.undetermined !== undefined);
  const unplacedNote =
    unplaced.length > 0
      ? `${unplaced.length} disconnect(s) could not be placed against the drops: the probes' clocks are aligned ${alignment(unplaced.map((d) => d.undetermined!))}, too coarse for the ${s.correlationWindowMs} ms window.`
      : null;
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
        ...(unplacedNote ? [unplacedNote] : []),
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
      basis: unplaced.length
        ? `${f.drops.length} drop(s), none known to be followed by a disconnect`
        : `${f.drops.length} drop(s), none followed by a disconnect`,
      observed: [
        `${f.drops.length} undervoltage event(s) below ${volts(s.undervoltageThreshold)}, minimum ${volts(minV)}.`,
        ...(unplacedNote ? [unplacedNote] : []),
      ],
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
  const unexplained = f.detaches.filter((d) => d.dropAt === null && d.undetermined === undefined);
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

  // NETWORK: the lowest failing layer explains everything above it, unless
  // the link is down because the supply dropped: that is said below, and
  // "check the cable" would send the technician the wrong way.
  const open = f.outages.at(-1);
  const explained = open !== undefined && open.cause !== null && open.upAt === null;
  const net = explained ? null : diagnoseNetwork(f.net);
  if (net) add(net);

  // NETWORK + POWER: the link goes down with the supply.
  const linked = f.outages.filter((o) => o.cause !== null);
  if (linked.length > 0) {
    const back = linked.filter((o) => o.upAt !== null);
    const recovery = back.map((o) => (o.dnsAt ?? o.dhcpAt ?? o.upAt!) - o.t);
    const chain = (o: NetOutageFact) =>
      [
        `${o.cause!.text} ${clock(o.cause!.t)}`,
        `link down +${ms(o.t - o.cause!.t)}`,
        o.upAt !== null ? `up +${ms(o.upAt - o.t)}` : 'still down',
        o.dhcpAt !== null ? `DHCP +${ms(o.dhcpAt - o.t)}` : null,
        o.dnsAt !== null ? `DNS +${ms(o.dnsAt - o.t)}` : null,
      ]
        .filter(Boolean)
        .join(' > ');
    add({
      id: 'NETWORK_POWER_LOSS',
      title: 'NETWORK LOST WITH POWER',
      confidence: linked.length >= 2 ? 'HIGH' : 'MEDIUM',
      basis: `${linked.length} of ${f.outages.length} link loss(es) followed a voltage drop or a target reset`,
      observed: [
        `${f.outages.length} network link loss(es); ${linked.length} within ${ms(NET_POWER_WINDOW_MS)} of a voltage drop or a target reset.`,
        back.length
          ? `Network back (link, DHCP, DNS) after ${ms(Math.min(...recovery))} to ${ms(Math.max(...recovery))}.`
          : 'The network has not come back yet.',
      ],
      correlation: `Latest: ${chain(linked.at(-1)!)}.`,
      cause: 'The network goes down when the supply drops: the device behind this port (router, switch, or the target itself) loses power or reboots.',
      next: 'Measure the supply of the network device during the event; give it a stable supply and check its reboot log.',
      since: linked[0]!.cause!.t,
      evidence: evidence(...linked.flatMap((o) => [o.cause!.seq, o.seq, o.upSeq, o.dhcpSeq, o.dnsSeq])),
    });
  }

  // I2C: devices that stop answering, and a bus that fails.
  const lost = diagnoseI2cLoss(f, s);
  if (lost) add(lost);
  const errs = f.i2c.errors;
  if (errs.length > 0) {
    const kinds = [...new Set(errs.map((e) => e.kind))];
    const stuck = kinds.some((k) => k === 'SDA_LOW' || k === 'SCL_LOW');
    add({
      id: 'I2C_BUS_INSTABILITY',
      title: 'I2C BUS FAULT',
      confidence: errs.length >= 3 ? 'HIGH' : errs.length === 2 ? 'MEDIUM' : 'LOW',
      basis: `${errs.length} bus fault(s): ${kinds.join(', ')}`,
      observed: [`${errs.length} I2C bus fault(s) (${kinds.join(', ')}), last at ${clock(errs.at(-1)!.t)}.`],
      correlation: null,
      cause: stuck
        ? 'A line sits low while the bus is idle: missing pull-up resistors, a device holding SDA (stuck mid-transfer), or a short to ground.'
        : 'Transfers fail on the bus: noise, pull-ups too weak for the bus length or speed, or a misbehaving device.',
      next: stuck
        ? 'Measure SDA and SCL at idle: both must sit at the logic supply (3.3 V). At 0 V, fit 2.2-4.7 kOhm pull-ups, or power-cycle the device holding the line.'
        : 'Lower the bus speed, shorten the wires, check the pull-ups (2.2 kOhm at 400 kHz).',
      since: errs[0]!.t,
      evidence: evidence(...errs.map((e) => e.seq)),
    });
  }

  return out;
}

/**
 * An address that answered a scan, then stopped answering in a later one.
 * Coming back and going again is the strongest sign (a loose wire); gone
 * for good after several sightings is weaker; one missing scan is a hint.
 */
function diagnoseI2cLoss(f: SessionFacts, s: Settings): Diagnosis | null {
  const scans = f.i2c.scans;
  if (scans.length < 2) return null;
  const all = [...new Set(scans.flatMap((x) => x.addresses))].sort((a, b) => a - b);
  type Loss = { addr: number; t: number; seq: number; clk: Clk | undefined; back: { t: number; seq: number } | null; absent: number };
  const losses: Loss[] = [];
  for (const addr of all) {
    let open: Loss | null = null;
    for (let k = 1; k < scans.length; k++) {
      const was = scans[k - 1]!.addresses.includes(addr);
      const is = scans[k]!.addresses.includes(addr);
      if (was && !is) {
        open = { addr, t: scans[k]!.t, seq: scans[k]!.seq, clk: scans[k]!.clk, back: null, absent: 1 };
        losses.push(open);
      } else if (!was && !is && open) open.absent++;
      else if (!was && is && open) {
        open.back = { t: scans[k]!.t, seq: scans[k]!.seq };
        open = null;
      }
    }
  }
  if (losses.length === 0) return null;
  const addrs = [...new Set(losses.map((l) => l.addr))];
  const name = (a: number) => `0x${a.toString(16).toUpperCase().padStart(2, '0')}`;
  const flapping = losses.filter((l) => l.back !== null).length;
  const confirmed = losses.some((l) => l.absent >= 2);
  const confidence: Confidence = flapping >= 2 ? 'HIGH' : flapping === 1 || confirmed ? 'MEDIUM' : 'LOW';
  const afterDrop = losses.filter((l) =>
    f.drops.some((d) => relation({ t: d.start, clk: d.clk }, { t: l.t, clk: l.clk }, I2C_POWER_WINDOW_MS) === 'IN'),
  );
  return {
    id: 'I2C_DEVICE_DISAPPEARED',
    title: 'I2C DEVICE DISAPPEARED',
    confidence,
    basis: `${losses.length} loss(es) of ${addrs.map(name).join(', ')} over ${scans.length} scans, ${flapping} came back`,
    observed: [
      ...addrs.map((a) => `${name(a)} answered ${scans.filter((x) => x.addresses.includes(a)).length} of ${scans.length} scans.`),
      `Last loss at ${clock(losses.at(-1)!.t)}.`,
    ],
    correlation: afterDrop.length
      ? `${afterDrop.length} / ${losses.length} losses within ${ms(I2C_POWER_WINDOW_MS)} of a voltage drop below ${volts(s.undervoltageThreshold)}.`
      : null,
    cause: afterDrop.length
      ? 'The device resets or browns out with the supply: it stops answering after each voltage drop.'
      : flapping
        ? 'The device stops answering and comes back: loose wire or connector, marginal pull-ups, or the device resetting.'
        : 'A device that answered no longer does: disconnected, unpowered, or hung.',
    next: `Check the wiring to ${addrs.map(name).join(', ')} (SDA, SCL, power, ground); reseat the connector; check the device supply.`,
    since: losses[0]!.t,
    evidence: evidence(...losses.flatMap((l) => [l.seq, l.back?.seq])),
  };
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
