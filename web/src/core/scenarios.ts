import type { CheckStatus } from './types';
import type { I2cErrorKind } from './protocol';
import type { DiagnosisId } from './diagnostics';

/**
 * Fault scenarios for the simulator (docs/DIAGNOSTICS.md).
 *
 * A scenario describes the PHYSICAL situation: supply, cable, target
 * firmware, network. The simulator turns it into HDP frames only; the
 * diagnostic engine never sees the scenario. `expect` is the answer key
 * used by the reliability matrix in test/scenarios.test.ts.
 */

export type Range = readonly [min: number, max: number];

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** What is physically wrong, in one line. */
  fault: string;
  /** Exactly the diagnoses the engine must produce. Empty = healthy. */
  expect: readonly DiagnosisId[];
  supply: {
    volts: number;
    /** Cable + connector resistance, ohms. */
    ohms: number;
    /** Periodic load bursts that sag the rail (radio, motor). */
    bursts: null | {
      every: Range;
      current: Range;
      /** Extra sag in volts on top of I*R. */
      sag: Range;
      /** Target browns out and drops off USB when the rail goes below this. */
      brownoutBelow: number | null;
    };
  };
  target: {
    /** Idle and running current, amps. */
    current: number;
    /** The target enumerates on USB. */
    enumerates: boolean;
    /** Actual UART baud of the target. Hardware Dog starts at 115200. */
    baud: number;
    /** USB data link drops while the target keeps running (connector, cable). */
    usbDrops: null | { every: Range; outage: Range };
    /** Firmware reset loop: the target reboots on its own. */
    resetLoop: null | { every: Range; reason: string; code: number };
    /** Current spikes above the limit on a stiff supply. */
    spikes: null | { every: Range; current: Range; duration: Range };
  };
  /** Target I2C bus, scanned periodically (the device's i2c watch, set at boot). */
  i2c?: {
    watchMs: number;
    /** A device that drops off the bus and comes back (loose wire). */
    flaky: null | { addr: number; every: Range; outage: Range };
    /** A line stuck low while idle (missing pull-up): every scan fails. */
    fault: null | { kind: I2cErrorKind };
  };
  net: {
    /** The network device behind the port is powered by the target rail: it goes down with it. */
    followsPower?: boolean;
    link: boolean;
    dhcp: CheckStatus;
    gateway: CheckStatus;
    dns: CheckStatus;
    internet: CheckStatus;
    latency: Range;
    /** Packet loss percent. */
    loss: Range;
  };
}

export const SCENARIO_IDS = [
  'HD-T000',
  'HD-T001',
  'HD-T002',
  'HD-T003',
  'HD-T004',
  'HD-T005',
  'HD-T006',
  'HD-T007',
  'HD-T008',
  'HD-T009',
  'HD-T010',
  'HD-T011',
  'HD-T012',
  'HD-T013',
  'HD-T014',
  'HD-T015',
  'HD-T016',
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

const HEALTHY_NET: Scenario['net'] = {
  link: true,
  dhcp: 'PASS',
  gateway: 'PASS',
  dns: 'PASS',
  internet: 'PASS',
  latency: [9, 16],
  loss: [0, 0],
};

const HEALTHY_TARGET: Scenario['target'] = {
  current: 0.31,
  enumerates: true,
  baud: 115200,
  usbDrops: null,
  resetLoop: null,
  spikes: null,
};

const STIFF_SUPPLY: Scenario['supply'] = { volts: 5.07, ohms: 0.05, bursts: null };

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  'HD-T000': {
    id: 'HD-T000',
    title: 'HEALTHY BASELINE',
    fault: 'Nothing is wrong. Any diagnosis here is a false positive.',
    expect: [],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: HEALTHY_NET,
  },
  'HD-T001': {
    id: 'HD-T001',
    title: 'USB UNDERVOLTAGE',
    fault: 'Thin cable on a weak port: load bursts sag the rail and the target browns out.',
    expect: ['POWER_INSTABILITY'],
    supply: {
      volts: 5.07,
      ohms: 0.09,
      bursts: { every: [7000, 11000], current: [0.66, 0.76], sag: [0.3, 0.46], brownoutBelow: 4.7 },
    },
    target: HEALTHY_TARGET,
    net: HEALTHY_NET,
  },
  'HD-T002': {
    id: 'HD-T002',
    title: 'DHCP FAILURE',
    fault: 'Link is up but no DHCP server answers (wrong VLAN, server down).',
    expect: ['DHCP_FAILURE'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { link: true, dhcp: 'FAIL', gateway: 'UNKNOWN', dns: 'UNKNOWN', internet: 'UNKNOWN', latency: [0, 0], loss: [0, 0] },
  },
  'HD-T003': {
    id: 'HD-T003',
    title: 'DNS FAILURE',
    fault: 'The configured DNS server does not answer; the Internet is reachable by IP.',
    expect: ['DNS_FAILURE'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { ...HEALTHY_NET, dns: 'FAIL', internet: 'PASS' },
  },
  'HD-T004': {
    id: 'HD-T004',
    title: 'SERIAL FRAMING MISMATCH',
    fault: 'The target UART runs at 9600 baud; the monitor listens at 115200.',
    expect: ['SERIAL_CONFIGURATION_MISMATCH'],
    supply: STIFF_SUPPLY,
    target: { ...HEALTHY_TARGET, baud: 9600 },
    net: HEALTHY_NET,
  },
  'HD-T005': {
    id: 'HD-T005',
    title: 'INTERMITTENT USB DISCONNECT',
    fault: 'Worn connector: USB data drops while the supply stays solid.',
    expect: ['USB_INTERMITTENT'],
    supply: STIFF_SUPPLY,
    target: { ...HEALTHY_TARGET, usbDrops: { every: [5000, 9000], outage: [400, 900] } },
    net: HEALTHY_NET,
  },
  'HD-T006': {
    id: 'HD-T006',
    title: 'TARGET RESET LOOP',
    fault: 'Firmware hangs and the task watchdog reboots the target every few seconds.',
    expect: ['TARGET_RESET_LOOP'],
    supply: STIFF_SUPPLY,
    target: { ...HEALTHY_TARGET, resetLoop: { every: [5500, 7500], reason: 'TG1WDT_SYS_RST', code: 0x8 } },
    net: HEALTHY_NET,
  },
  'HD-T007': {
    id: 'HD-T007',
    title: 'UNSTABLE NETWORK',
    fault: 'Weak Wi-Fi: every layer answers, but latency swings and packets drop.',
    expect: ['NETWORK_UNSTABLE'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { ...HEALTHY_NET, latency: [18, 420], loss: [2, 14] },
  },
  'HD-T008': {
    id: 'HD-T008',
    title: 'UPSTREAM DOWN',
    fault: 'LAN and gateway are fine; the Internet connection beyond the gateway is down.',
    expect: ['UPSTREAM_FAILURE'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { ...HEALTHY_NET, dns: 'FAIL', internet: 'FAIL' },
  },
  'HD-T009': {
    id: 'HD-T009',
    title: 'OVERCURRENT',
    fault: 'A motor stalls: the target pulls more than 1 A in spikes on a stiff supply.',
    expect: ['OVERCURRENT'],
    supply: { volts: 5.1, ohms: 0.03, bursts: null },
    target: { ...HEALTHY_TARGET, spikes: { every: [4000, 7000], current: [1.05, 1.25], duration: [250, 500] } },
    net: HEALTHY_NET,
  },
  'HD-T010': {
    id: 'HD-T010',
    title: 'USB NOT ENUMERATED',
    fault: 'The target is powered but never enumerates (charge-only cable or broken USB firmware).',
    expect: ['USB_NOT_ENUMERATED'],
    supply: STIFF_SUPPLY,
    target: { ...HEALTHY_TARGET, enumerates: false },
    net: HEALTHY_NET,
  },
  'HD-T011': {
    id: 'HD-T011',
    title: 'NO NETWORK LINK',
    fault: 'The Ethernet cable is unplugged, or the far switch port is dead.',
    expect: ['NO_LINK'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { link: false, dhcp: 'UNKNOWN', gateway: 'UNKNOWN', dns: 'UNKNOWN', internet: 'UNKNOWN', latency: [0, 0], loss: [0, 0] },
  },
  'HD-T012': {
    id: 'HD-T012',
    title: 'GATEWAY UNREACHABLE',
    fault: 'DHCP gives an address, but the router does not answer (wrong subnet mask, router hung).',
    expect: ['GATEWAY_UNREACHABLE'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    net: { link: true, dhcp: 'PASS', gateway: 'FAIL', dns: 'UNKNOWN', internet: 'UNKNOWN', latency: [0, 0], loss: [0, 0] },
  },
  'HD-T013': {
    id: 'HD-T013',
    title: 'SUPPLY SAG',
    fault: 'Long thin cable: the rail sags under each load burst, but the target survives (for now).',
    expect: ['SUPPLY_SAG'],
    supply: {
      volts: 5.07,
      ohms: 0.09,
      bursts: { every: [6000, 9000], current: [0.6, 0.7], sag: [0.3, 0.4], brownoutBelow: null },
    },
    target: HEALTHY_TARGET,
    net: HEALTHY_NET,
  },
  'HD-T014': {
    id: 'HD-T014',
    title: 'I2C INTERMITTENT',
    fault: 'A sensor on long loose jumper wires drops off the I2C bus and comes back.',
    expect: ['I2C_DEVICE_DISAPPEARED'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    i2c: { watchMs: 3000, flaky: { addr: 0x76, every: [8000, 12000], outage: [3500, 6000] }, fault: null },
    net: HEALTHY_NET,
  },
  'HD-T015': {
    id: 'HD-T015',
    title: 'I2C MISSING PULL-UP',
    fault: 'The pull-up resistors of the target I2C bus are missing: SDA sits low, every scan fails.',
    expect: ['I2C_BUS_INSTABILITY'],
    supply: STIFF_SUPPLY,
    target: HEALTHY_TARGET,
    i2c: { watchMs: 3000, flaky: null, fault: { kind: 'SDA_LOW' } },
    net: HEALTHY_NET,
  },
  'HD-T016': {
    id: 'HD-T016',
    title: 'ROUTER LOSES POWER',
    fault: 'A USB-powered travel router on a thin cable: load bursts brown it out, it reboots, the network drops and comes back.',
    expect: ['POWER_INSTABILITY', 'NETWORK_POWER_LOSS'],
    supply: {
      volts: 5.07,
      ohms: 0.09,
      bursts: { every: [9000, 13000], current: [0.66, 0.76], sag: [0.3, 0.46], brownoutBelow: 4.7 },
    },
    target: HEALTHY_TARGET,
    net: { ...HEALTHY_NET, followsPower: true },
  },
};

export const DEFAULT_SCENARIO: ScenarioId = 'HD-T001';

export function isScenarioId(v: string): v is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(v);
}
