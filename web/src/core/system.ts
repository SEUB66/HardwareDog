import type { DeviceFrame } from './protocol';
import type { Transport } from './transport';
import { Trace } from './trace';
import type {
  BusState,
  CheckStatus,
  DeviceInfo,
  LinkState,
  NetState,
  PowerState,
  ProbeRun,
  ProbeTest,
  SerialState,
  Settings,
  Severity,
  Source,
  TransportKind,
  UsbState,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { hex, i2cAddress, milliamps, ms, volts } from './format';

/** Key/value persistence. Local only: nothing ever leaves the machine. */
export interface SettingsStore {
  load(): Partial<Settings> | null;
  save(settings: Settings): boolean;
}

export const memoryStore = (): SettingsStore => {
  let saved: Settings | null = null;
  return {
    load: () => saved,
    save: (s) => {
      saved = { ...s };
      return true;
    },
  };
};

export const browserStore = (key = 'hwdog.settings.v1'): SettingsStore => ({
  load() {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    } catch {
      return null;
    }
  },
  save(settings) {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(settings));
      return true;
    } catch {
      return false;
    }
  },
});

export type BootStatus = 'OK' | 'WARN' | 'FAIL';

export interface BootStep {
  label: string;
  status: BootStatus;
  detail?: string;
}

export interface LinkError {
  what: string;
  where: string;
  when: number;
  detail: string;
}

/** Rules the instrument evaluates continuously. Shown on SETUP. */
export const RULES = [
  'UNDERVOLTAGE      rail below threshold, with hysteresis',
  'OVERCURRENT       draw above threshold',
  'USB/POWER CORR    disconnect within window of an undervoltage',
  'UART FRAMING      repeated framing errors -> baud mismatch hypothesis',
] as const;

const POWER_WINDOW_MS = 15_000;
const HYSTERESIS_V = 0.05;
const SERIAL_LINES = 500;

type Listener = () => void;

const emptyPower = (): PowerState => ({
  voltage: null,
  current: null,
  peakCurrent: null,
  minVoltage: null,
  condition: 'NO SIGNAL',
  samples: [],
  sampleCount: 0,
  voltageSum: 0,
  currentSum: 0,
  lastDropAt: null,
  lastDropVoltage: null,
  dropCount: 0,
});

const emptyUsb = (): UsbState => ({
  connected: false,
  descriptor: null,
  connections: 0,
  disconnects: 0,
  lastSeenAt: null,
  lastDetachAt: null,
  correlatedDisconnects: 0,
});

const emptySerial = (): SerialState => ({
  port: 'UART0',
  baud: 115200,
  dataBits: 8,
  parity: 'NONE',
  stopBits: 1,
  rxBytes: 0,
  txBytes: 0,
  errors: 0,
  active: false,
  lines: [],
});

const emptyBus = (): BusState => ({ protocol: 'I2C', speedHz: null, state: 'IDLE', devices: [], lastScanAt: null });

const emptyNet = (): NetState => ({
  link: null,
  address: null,
  dhcp: 'UNKNOWN',
  gateway: { address: null, status: 'UNKNOWN' },
  dns: { address: null, status: 'UNKNOWN' },
  internet: 'UNKNOWN',
  latencyMs: null,
  packetLoss: null,
  updatedAt: null,
});

const statusSeverity = (s: CheckStatus): Severity => (s === 'PASS' ? 'PASS' : s === 'FAIL' ? 'FAIL' : s === 'WARN' ? 'WARN' : 'INFO');

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * The one and only source of truth.
 *
 * The GUI and the command layer both call the methods below; neither keeps
 * its own copy of device state. Frames from the transport are the only
 * way device state changes.
 */
export class System {
  readonly trace = new Trace();
  readonly startedAt: number;

  link: LinkState = 'OFFLINE';
  transportKind: TransportKind | null = null;
  transportLabel = '';
  device: DeviceInfo = { id: '--', rev: '--', firmware: '--', bootedAt: null };
  power: PowerState = emptyPower();
  usb: UsbState = emptyUsb();
  serial: SerialState = emptySerial();
  bus: BusState = emptyBus();
  net: NetState = emptyNet();
  probes: ProbeRun[] = [];
  settings: Settings;
  storageOk: boolean;
  lastError: LinkError | null = null;
  frameErrors = 0;

  private transport: Transport | null = null;
  private listeners = new Set<Listener>();
  private version = 0;
  private lastLoggedPower: { v: number; i: number } | null = null;
  private dropStartedAt: number | null = null;
  private dropMin = Infinity;
  private lastBelowAt: number | null = null;
  private overcurrent = false;
  private framingErrorTimes: number[] = [];
  private lastBaudHypothesisAt = -Infinity;
  private lastFrameErrorLogAt = -Infinity;
  private suppressedFrameErrors = 0;
  private probeCounter = 0;
  private seenFrames = new Set<DeviceFrame['type']>();

  constructor(
    private readonly store: SettingsStore = memoryStore(),
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.now();
    this.settings = { ...DEFAULT_SETTINGS, ...(store.load() ?? {}) };
    this.storageOk = store.save(this.settings);
  }

  // ------------------------------------------------------------ subscription

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get revision(): number {
    return this.version;
  }

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private log(t: number, source: Source, severity: Severity, message: string, value?: string): void {
    this.trace.append(t, source, severity, message, value);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Bring the system up and report each stage truthfully.
   * `pace` spaces the steps out for the boot screen; tests pass 0.
   */
  async boot(transport: Transport, onStep: (step: BootStep) => void, pace = 90): Promise<BootStep[]> {
    const steps: BootStep[] = [];
    const wait = (n: number) => (n > 0 ? new Promise((r) => setTimeout(r, n)) : Promise.resolve());
    const step = async (s: BootStep) => {
      steps.push(s);
      onStep(s);
      await wait(pace);
    };

    this.log(this.now(), 'SYS', 'INFO', 'session started');
    await step({ label: 'EVENT BUS', status: 'OK' });
    await step(
      this.storageOk
        ? { label: 'LOCAL STORAGE', status: 'OK' }
        : { label: 'LOCAL STORAGE', status: 'WARN', detail: 'unavailable, settings will not persist' },
    );

    const linkOk = await this.connect(transport);
    await step(
      linkOk
        ? { label: 'HARDWARE INTERFACE', status: 'OK', detail: this.transportLabel }
        : { label: 'HARDWARE INTERFACE', status: 'FAIL', detail: this.lastError?.detail ?? 'no link' },
    );

    // Give the device a moment to report before judging each service.
    await wait(linkOk ? Math.max(pace * 2, 0) : 0);
    const seen = (type: DeviceFrame['type']) => this.seenFrames.has(type);
    await step(seen('power') ? { label: 'POWER MONITOR', status: 'OK' } : { label: 'POWER MONITOR', status: 'WARN', detail: 'no samples yet' });
    await step({ label: 'USB SERVICE', status: linkOk ? 'OK' : 'FAIL' });
    await step(
      seen('uart.config') ? { label: 'SERIAL SERVICE', status: 'OK' } : { label: 'SERIAL SERVICE', status: 'WARN', detail: 'no port config' },
    );
    await step(
      seen('net.status') ? { label: 'NETWORK SERVICE', status: 'OK' } : { label: 'NETWORK SERVICE', status: 'WARN', detail: 'no status yet' },
    );
    await step({ label: 'TRACE ENGINE', status: 'OK' });
    await step({ label: 'DIAGNOSTIC RULES', status: 'OK', detail: `${RULES.length} loaded` });

    const failed = steps.some((s) => s.status === 'FAIL');
    this.log(this.now(), 'SYS', failed ? 'FAIL' : 'PASS', failed ? 'boot completed with failures' : 'system ready');
    this.changed();
    return steps;
  }

  /** Open a transport. Returns false (and records why) instead of throwing. */
  async connect(transport: Transport): Promise<boolean> {
    await this.disconnect();
    this.transport = transport;
    this.transportKind = transport.kind;
    this.transportLabel = transport.label;
    this.link = 'CONNECTING';
    this.changed();
    try {
      await transport.open({
        frame: (f) => this.onFrame(f),
        error: (message, raw) => this.onFrameError(message, raw),
        lost: (reason) => this.onLost(reason),
      });
      this.transportLabel = transport.label;
      this.link = 'ONLINE';
      this.log(this.now(), 'SYS', 'PASS', `link up: ${transport.kind}`, transport.label);
      this.changed();
      return true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.transport = null;
      this.link = 'OFFLINE';
      this.lastError = { what: 'LINK OPEN FAILED', where: transport.kind, when: this.now(), detail };
      this.log(this.now(), 'SYS', 'FAIL', 'link open failed', detail);
      this.changed();
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.transport) return;
    const t = this.transport;
    this.transport = null;
    await t.close();
    this.link = 'OFFLINE';
    this.usb.connected = false;
    this.power.condition = 'NO SIGNAL';
    this.log(this.now(), 'SYS', 'INFO', `link closed: ${t.kind}`);
    this.changed();
  }

  // ------------------------------------------------------------ frames

  /** Host wall-clock time for a device timestamp. */
  private hostTime(deviceT: number): number {
    return this.device.bootedAt === null ? this.now() : this.device.bootedAt + deviceT;
  }

  private onFrameError(message: string, raw?: string): void {
    this.frameErrors++;
    const t = this.now();
    if (t - this.lastFrameErrorLogAt < 1000) {
      this.suppressedFrameErrors++;
      return;
    }
    const extra = this.suppressedFrameErrors > 0 ? ` (+${this.suppressedFrameErrors} suppressed)` : '';
    this.suppressedFrameErrors = 0;
    this.lastFrameErrorLogAt = t;
    this.log(t, 'SYS', 'WARN', message + extra, raw ? raw.slice(0, 60) : undefined);
    this.changed();
  }

  private onLost(reason: string): void {
    const t = this.now();
    this.transport = null;
    this.link = 'LOST';
    this.usb.connected = false;
    this.power.condition = 'NO SIGNAL';
    this.lastError = { what: 'DEVICE LINK LOST', where: this.transportLabel || 'transport', when: t, detail: reason };
    this.log(t, 'SYS', 'FAIL', 'device link lost', reason);
    this.changed();
  }

  onFrame(f: DeviceFrame): void {
    this.seenFrames.add(f.type);
    if (f.type === 'hello') {
      this.device = { id: f.device, rev: f.rev, firmware: f.fw, bootedAt: this.now() - f.t };
      this.log(this.hostTime(f.t), 'SYS', 'INFO', `device ${f.device} rev ${f.rev}`, `fw ${f.fw} / proto ${f.proto}`);
      this.changed();
      return;
    }
    const t = this.hostTime(f.t);
    switch (f.type) {
      case 'power':
        this.onPower(t, f.v, f.i);
        break;
      case 'usb.attach':
        this.onUsbAttach(t, f);
        break;
      case 'usb.detach':
        this.onUsbDetach(t);
        break;
      case 'uart.config': {
        const s = this.serial;
        const changed = s.baud !== f.baud || s.port !== f.port || !s.active;
        Object.assign(s, { port: f.port, baud: f.baud, dataBits: f.bits, parity: f.parity, stopBits: f.stop, active: true });
        if (changed) this.log(t, 'UART', 'INFO', `${f.port} configured`, `${f.baud} ${f.bits}${f.parity[0]}${f.stop}`);
        break;
      }
      case 'uart.rx':
        this.serial.rxBytes += utf8Length(f.data) + 1;
        this.pushSerial({ t, dir: 'RX', text: f.data });
        this.log(t, 'UART', 'INFO', f.data.length > 120 ? f.data.slice(0, 117) + '...' : f.data);
        break;
      case 'uart.error':
        this.onUartError(t, f.kind);
        break;
      case 'i2c.scan':
        this.bus = {
          protocol: 'I2C',
          speedHz: f.speed,
          state: 'ACTIVE',
          lastScanAt: t,
          devices: f.devices.map((d) => ({ address: d.addr, confirmed: d.ident, method: d.method })),
        };
        this.log(t, 'I2C', 'PASS', `scan complete`, `${f.devices.length} device(s)`);
        for (const d of f.devices) {
          this.log(t, 'I2C', 'INFO', `${i2cAddress(d.addr)} ${d.ident ?? 'UNKNOWN'}`, d.ident ? 'confirmed' : 'no identity');
        }
        break;
      case 'net.status':
        this.onNet(t, f);
        break;
      case 'probe.result': {
        const run = this.probes.find((p) => p.id === f.id);
        if (run) run.results.push({ test: f.test, status: f.status, detail: f.detail });
        this.log(t, 'NET', statusSeverity(f.status), `probe ${f.test} ${run?.target ?? ''}`.trim(), f.detail);
        break;
      }
      case 'probe.done': {
        const run = this.probes.find((p) => p.id === f.id);
        if (run) {
          run.finishedAt = t;
          const failed = run.results.filter((r) => r.status === 'FAIL').length;
          this.log(t, 'NET', failed ? 'FAIL' : 'PASS', `probe finished ${run.target}`, `${run.results.length - failed}/${run.results.length} pass`);
        }
        break;
      }
      case 'log':
        this.log(t, 'SYS', f.level === 'error' ? 'FAIL' : f.level === 'warn' ? 'WARN' : 'INFO', f.message);
        break;
    }
    this.changed();
  }

  private onPower(t: number, v: number, i: number): void {
    const p = this.power;
    const s = this.settings;
    p.voltage = v;
    p.current = i;
    p.sampleCount++;
    p.voltageSum += v;
    p.currentSum += i;
    p.peakCurrent = p.peakCurrent === null ? i : Math.max(p.peakCurrent, i);
    p.minVoltage = p.minVoltage === null ? v : Math.min(p.minVoltage, v);
    p.samples.push({ t, voltage: v, current: i });
    const cutoff = t - POWER_WINDOW_MS;
    let drop = 0;
    while (drop < p.samples.length && p.samples[drop]!.t < cutoff) drop++;
    if (drop > 0) p.samples.splice(0, drop);

    // Rule: undervoltage with hysteresis.
    if (v < s.undervoltageThreshold) {
      this.lastBelowAt = t;
      if (this.dropStartedAt === null) {
        this.dropStartedAt = t;
        this.dropMin = v;
        p.lastDropAt = t;
        p.lastDropVoltage = v;
        p.dropCount++;
        this.log(t, 'POWER', 'WARN', 'voltage drop', `${volts(v)} < ${volts(s.undervoltageThreshold)}`);
      } else if (v < this.dropMin) {
        this.dropMin = v;
        p.lastDropVoltage = v;
      }
    } else if (this.dropStartedAt !== null && v >= s.undervoltageThreshold + HYSTERESIS_V) {
      this.log(t, 'POWER', 'PASS', 'voltage recovered', `min ${volts(this.dropMin)} for ${ms(t - this.dropStartedAt)}`);
      this.dropStartedAt = null;
      this.dropMin = Infinity;
    }

    // Rule: overcurrent.
    if (i > s.overcurrentThreshold && !this.overcurrent) {
      this.overcurrent = true;
      this.log(t, 'POWER', 'WARN', 'overcurrent', `${milliamps(i)} > ${milliamps(s.overcurrentThreshold)}`);
    } else if (i <= s.overcurrentThreshold * 0.95 && this.overcurrent) {
      this.overcurrent = false;
      this.log(t, 'POWER', 'PASS', 'current back in range', milliamps(i));
    }

    p.condition = this.dropStartedAt !== null ? 'UNDERVOLTAGE' : this.overcurrent ? 'OVERCURRENT' : 'STABLE';

    // Log meaningful movement, not every sample.
    const last = this.lastLoggedPower;
    if (!last || Math.abs(v - last.v) >= 0.1 || Math.abs(i - last.i) >= 0.1) {
      this.lastLoggedPower = { v, i };
      this.log(t, 'POWER', 'INFO', `${volts(v)} / ${milliamps(i)}`);
    }
  }

  private onUsbAttach(t: number, f: Extract<DeviceFrame, { type: 'usb.attach' }>): void {
    const u = this.usb;
    const wasConnected = u.connected;
    u.connected = true;
    u.lastSeenAt = t;
    u.descriptor = {
      speed: f.speed,
      vid: f.vid,
      pid: f.pid,
      deviceClass: f.cls,
      powerSource: f.power,
      manufacturer: f.manufacturer,
      product: f.product,
      serial: f.serial,
    };
    if (!wasConnected) {
      u.connections++;
      this.log(t, 'USB', 'INFO', 'device connected', `${f.speed} SPEED`);
    }
    this.log(t, 'USB', 'PASS', 'descriptor received', `VID ${hex(f.vid)} / PID ${hex(f.pid)} ${f.cls}`);
  }

  private onUsbDetach(t: number): void {
    const u = this.usb;
    if (!u.connected) return;
    u.connected = false;
    u.disconnects++;
    u.lastSeenAt = t;
    u.lastDetachAt = t;
    this.log(t, 'USB', 'WARN', 'device disconnected');

    // Rule: USB / power correlation.
    const window = this.settings.correlationWindowMs;
    if (this.lastBelowAt !== null && t - this.lastBelowAt <= window && t >= this.lastBelowAt) {
      u.correlatedDisconnects++;
      const dropAt = this.power.lastDropAt ?? this.lastBelowAt;
      this.log(
        t,
        'RULE',
        'WARN',
        `disconnect ${Math.round(t - dropAt)} ms after voltage drop`,
        `min ${volts(this.power.lastDropVoltage)} / ${u.correlatedDisconnects} of ${u.disconnects} correlated`,
      );
    }
  }

  private onUartError(t: number, kind: string): void {
    this.serial.errors++;
    this.log(t, 'UART', 'WARN', `${kind} error`);
    // Rule: repeated framing errors -> baud mismatch is a hypothesis, not a fact.
    if (kind !== 'framing') return;
    this.framingErrorTimes = this.framingErrorTimes.filter((x) => t - x < 5000);
    this.framingErrorTimes.push(t);
    if (this.framingErrorTimes.length >= 3 && t - this.lastBaudHypothesisAt > 10_000) {
      this.lastBaudHypothesisAt = t;
      this.log(t, 'RULE', 'WARN', 'possible cause: baud rate mismatch', `${this.framingErrorTimes.length} framing errors in 5 s at ${this.serial.baud}`);
    }
  }

  private onNet(t: number, f: Extract<DeviceFrame, { type: 'net.status' }>): void {
    const prev = this.net;
    const next: NetState = {
      link: f.link,
      address: f.address,
      dhcp: f.dhcp,
      gateway: f.gateway,
      dns: f.dns,
      internet: f.internet,
      latencyMs: f.latency,
      packetLoss: f.loss,
      updatedAt: t,
    };
    const first = prev.updatedAt === null;
    const linkUp = !!next.link?.up;
    if (first || !!prev.link?.up !== linkUp) {
      this.log(t, 'NET', linkUp ? 'PASS' : 'FAIL', linkUp ? 'link up' : 'link down', next.link?.mbps ? `${next.link.mbps} Mbps / ${next.link.duplex ?? '--'}` : undefined);
    }
    const checks: [string, CheckStatus, CheckStatus][] = [
      ['DHCP', prev.dhcp, next.dhcp],
      ['GATEWAY', prev.gateway.status, next.gateway.status],
      ['DNS', prev.dns.status, next.dns.status],
      ['INTERNET', prev.internet, next.internet],
    ];
    for (const [name, a, b] of checks) {
      if (first || a !== b) this.log(t, 'NET', statusSeverity(b), `${name.toLowerCase()} ${b}`);
    }
    this.net = next;
  }

  private pushSerial(line: SerialState['lines'][number]): void {
    const lines = this.serial.lines;
    lines.push(line);
    if (lines.length > SERIAL_LINES) lines.splice(0, lines.length - SERIAL_LINES);
  }

  // ------------------------------------------------------------ actions

  get online(): boolean {
    return this.link === 'ONLINE' && this.transport !== null;
  }

  private requireLink(action: string): string | null {
    if (this.online) return null;
    const msg = `${action}: no device link (${this.link})`;
    this.log(this.now(), 'SYS', 'WARN', msg);
    this.changed();
    return msg;
  }

  pauseTrace(): void {
    this.trace.pause();
    this.changed();
  }

  resumeTrace(): void {
    this.trace.resume();
    this.changed();
  }

  toggleTrace(): void {
    if (this.trace.paused) this.resumeTrace();
    else this.pauseTrace();
  }

  clearTrace(): void {
    this.trace.clear();
    this.log(this.now(), 'USER', 'INFO', 'trace cleared');
    this.changed();
  }

  mark(text: string): void {
    this.log(this.now(), 'USER', 'INFO', `mark: ${text}`);
    this.changed();
  }

  /** Returns an error message, or null when the command was sent. */
  enumerateUsb(): string | null {
    const err = this.requireLink('usb enumerate');
    if (err) return err;
    this.transport!.send({ cmd: 'usb.enumerate' });
    this.log(this.now(), 'USER', 'INFO', 'usb enumerate requested');
    this.changed();
    return null;
  }

  setBaud(baud: number): string | null {
    if (!Number.isInteger(baud) || baud < 300 || baud > 4_000_000) return `invalid baud rate: ${baud}`;
    const err = this.requireLink('serial config');
    if (err) return err;
    this.transport!.send({ cmd: 'uart.config', baud });
    this.log(this.now(), 'USER', 'INFO', `serial baud -> ${baud}`);
    this.framingErrorTimes = [];
    this.changed();
    return null;
  }

  sendSerial(text: string): string | null {
    const err = this.requireLink('serial send');
    if (err) return err;
    const t = this.now();
    this.transport!.send({ cmd: 'uart.tx', data: text });
    this.serial.txBytes += utf8Length(text) + 1;
    this.pushSerial({ t, dir: 'TX', text });
    this.log(t, 'USER', 'INFO', `uart tx: ${text}`);
    this.changed();
    return null;
  }

  scanI2c(): string | null {
    const err = this.requireLink('i2c scan');
    if (err) return err;
    this.bus.state = 'SCANNING';
    this.transport!.send({ cmd: 'i2c.scan' });
    this.log(this.now(), 'USER', 'INFO', 'i2c scan requested', 'ACTIVE: address probe 0x08-0x77');
    this.changed();
    return null;
  }

  refreshNet(): string | null {
    const err = this.requireLink('net refresh');
    if (err) return err;
    this.transport!.send({ cmd: 'net.refresh' });
    this.changed();
    return null;
  }

  /** Start an active probe. Returns the run, or an error message. */
  probe(target: string, tests: ProbeTest[]): ProbeRun | string {
    const clean = target.trim();
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(clean)) return `invalid target: "${target}"`;
    if (tests.length === 0) return 'no tests selected';
    const err = this.requireLink('probe');
    if (err) return err;
    const run: ProbeRun = {
      id: `p${++this.probeCounter}`,
      target: clean,
      tests: [...tests],
      startedAt: this.now(),
      finishedAt: null,
      results: [],
    };
    this.probes.unshift(run);
    if (this.probes.length > 20) this.probes.length = 20;
    this.transport!.send({ cmd: 'probe', id: run.id, target: clean, tests: run.tests });
    this.log(run.startedAt, 'USER', 'INFO', `probe ${clean}`, `ACTIVE: ${run.tests.join(' ')}`);
    this.changed();
    return run;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.storageOk = this.store.save(this.settings);
    this.changed();
  }
}
