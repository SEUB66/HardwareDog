/**
 * Shared domain types for the Hardware Dog interface.
 *
 * Everything the UI shows is derived from these structures, and these
 * structures are only ever mutated by the System in response to protocol
 * frames or user actions. See docs/ARCHITECTURE.md.
 */

export const SOURCES = ['SYS', 'POWER', 'USB', 'UART', 'I2C', 'NET', 'GPIO', 'RULE', 'USER'] as const;
export type Source = (typeof SOURCES)[number];

export const SEVERITIES = ['INFO', 'PASS', 'WARN', 'FAIL'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One line on the trace timeline. `t` is host wall-clock time in ms. */
export interface TraceEvent {
  id: number;
  t: number;
  source: Source;
  severity: Severity;
  message: string;
  value?: string;
}

/** Result of a single check. UNKNOWN means "not measured", never "probably fine". */
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'PENDING' | 'UNKNOWN';

export type LinkState = 'OFFLINE' | 'CONNECTING' | 'ONLINE' | 'LOST';

export type TransportKind = 'SIMULATOR' | 'WEB SERIAL' | 'REPLAY';

export interface DeviceInfo {
  id: string;
  rev: string;
  firmware: string;
  /** Host wall-clock time at which the device reported uptime 0. */
  bootedAt: number | null;
}

export interface PowerSample {
  t: number;
  voltage: number;
  current: number;
}

export type PowerCondition = 'NO SIGNAL' | 'STABLE' | 'UNDERVOLTAGE' | 'OVERCURRENT';

export interface PowerState {
  voltage: number | null;
  current: number | null;
  peakCurrent: number | null;
  minVoltage: number | null;
  condition: PowerCondition;
  /** Rolling window used by the charts. */
  samples: PowerSample[];
  /** Running aggregates for the whole session (not limited by the window). */
  sampleCount: number;
  voltageSum: number;
  currentSum: number;
  lastDropAt: number | null;
  lastDropVoltage: number | null;
  /** Number of distinct undervoltage events this session. */
  dropCount: number;
}

export type UsbSpeed = 'LOW' | 'FULL' | 'HIGH' | 'SUPER';

export interface UsbDescriptor {
  speed: UsbSpeed;
  vid: number;
  pid: number;
  deviceClass: string;
  powerSource: 'BUS' | 'SELF';
  manufacturer: string | null;
  product: string | null;
  serial: string | null;
}

export interface UsbState {
  connected: boolean;
  descriptor: UsbDescriptor | null;
  connections: number;
  disconnects: number;
  lastSeenAt: number | null;
  lastDetachAt: number | null;
  /** Disconnects that happened within the correlation window of a voltage drop. */
  correlatedDisconnects: number;
}

export type Parity = 'NONE' | 'EVEN' | 'ODD';

export interface SerialLine {
  t: number;
  dir: 'RX' | 'TX';
  text: string;
}

export interface SerialState {
  port: string;
  baud: number;
  dataBits: 7 | 8;
  parity: Parity;
  stopBits: 1 | 2;
  rxBytes: number;
  txBytes: number;
  errors: number;
  active: boolean;
  lines: SerialLine[];
}

export interface I2cDevice {
  address: number;
  /** Identity confirmed by the device (e.g. by reading an ID register). */
  confirmed: string | null;
  /** How the identity was confirmed, if it was. */
  method: string | null;
}

export type BusCondition = 'IDLE' | 'SCANNING' | 'ACTIVE' | 'FAULT';

export interface BusState {
  protocol: 'I2C';
  speedHz: number | null;
  state: BusCondition;
  devices: I2cDevice[];
  lastScanAt: number | null;
}

export interface NetHop {
  address: string | null;
  status: CheckStatus;
}

export interface NetState {
  link: { up: boolean; mbps: number | null; duplex: 'FULL' | 'HALF' | null } | null;
  address: string | null;
  dhcp: CheckStatus;
  gateway: NetHop;
  dns: NetHop;
  internet: CheckStatus;
  latencyMs: number | null;
  packetLoss: number | null;
  updatedAt: number | null;
}

export const PROBE_TESTS = ['PING', 'DNS', 'TCP', 'HTTP'] as const;
export type ProbeTest = (typeof PROBE_TESTS)[number];

export interface ProbeResult {
  test: ProbeTest;
  status: CheckStatus;
  detail: string;
}

export interface ProbeRun {
  id: string;
  target: string;
  tests: ProbeTest[];
  startedAt: number;
  finishedAt: number | null;
  results: ProbeResult[];
}

export interface Settings {
  sound: boolean;
  fieldMode: boolean;
  reducedMotion: boolean;
  undervoltageThreshold: number;
  overcurrentThreshold: number;
  correlationWindowMs: number;
}

/** The settings a diagnosis depends on. */
export type Thresholds = Pick<Settings, 'undervoltageThreshold' | 'overcurrentThreshold' | 'correlationWindowMs'>;

export const thresholdsOf = (s: Settings): Thresholds => ({
  undervoltageThreshold: s.undervoltageThreshold,
  overcurrentThreshold: s.overcurrentThreshold,
  correlationWindowMs: s.correlationWindowMs,
});

export const DEFAULT_SETTINGS: Settings = {
  sound: false,
  fieldMode: false,
  reducedMotion: false,
  undervoltageThreshold: 4.75,
  overcurrentThreshold: 0.9,
  correlationWindowMs: 100,
};
