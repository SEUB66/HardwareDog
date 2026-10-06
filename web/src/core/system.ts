import type { Capability, DeviceFrame, Meter } from './protocol';
import { CAPABILITIES, capabilityOf } from './protocol';
import type { Clk, Placed, Stamp } from './pack';
import { Pack, SYNC_EVERY_MS, during, margin, relation } from './pack';
import { fitCalibration, rawOf, type CalPoint } from './calibration';
import type { Transport } from './transport';
import { Trace } from './trace';
import type {
  BusState,
  CheckStatus,
  DeviceInfo,
  DogState,
  LinkState,
  NetState,
  PowerState,
  ProbeRun,
  ProbeTest,
  SerialState,
  Settings,
  Severity,
  Origin,
  Source,
  Thresholds,
  TransportKind,
  UsbDescriptor,
  UsbState,
  DogView,
} from './types';
import { DEFAULT_SETTINGS, THRESHOLD_KEYS, thresholdsOf } from './types';
import { hex, i2cAddress, milliamps, ms, volts } from './format';
import type { Confidence, Diagnosis, DiagnosisId, SessionFacts } from './diagnostics';
import type { HostCommand } from './protocol';
import type { Integrity, SessionHeader, SessionRecorder } from './session';
import { ReplayTransport } from './session';
import { FACT_LIMIT, NET_HISTORY, NET_POWER_WINDOW_MS, RUNNING_CURRENT, diagnose, emptyFacts, parseResetLine } from './diagnostics';

const describeThresholds = (t: Thresholds) =>
  `UV ${volts(t.undervoltageThreshold)}  OC ${t.overcurrentThreshold.toFixed(2)} A  WINDOW ${t.correlationWindowMs} ms`;

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
/** A Hardware Dog says hello as soon as its port opens: past this, the port is something else. */
export const HELLO_WAIT_MS = 3_000;
/** Shown on STATUS while the link is up: the port answered, but not as a Hardware Dog. */
export const NO_HARDWARE_DOG = 'NO HARDWARE DOG ON THIS PORT';
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

const emptyBus = (): BusState => ({ protocol: 'I2C', speedHz: null, state: 'IDLE', devices: [], lastScanAt: null, watchMs: 0, faults: 0, lastFault: null });

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

/** One USB device, as the trace names it: VID:PID and what it says it is. */
const usbName = (d: UsbDescriptor | null): string => {
  if (!d) return 'unknown device';
  const id = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  return [`${id(d.vid)}:${id(d.pid)}`, d.manufacturer, d.product].filter(Boolean).join(' ');
};

const statusSeverity = (s: CheckStatus): Severity => (s === 'PASS' ? 'PASS' : s === 'FAIL' ? 'FAIL' : s === 'WARN' ? 'WARN' : 'INFO');

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** The capability a command is for; null: every Dog (hello). time is always addressed. */
function commandCapability(cmd: HostCommand): Capability | null {
  switch (cmd.cmd) {
    case 'hello':
    case 'time':
      return null;
    case 'usb.enumerate':
    case 'usb.follow':
      return 'usb';
    case 'uart.config':
    case 'uart.tx':
      return 'uart';
    case 'i2c.scan':
    case 'i2c.watch':
      return 'i2c';
    case 'net.refresh':
    case 'net.watch':
      return 'net';
    case 'meter.cal':
    case 'meter.clear':
      return 'power';
    case 'probe':
      return 'probe';
  }
}

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
  device: DeviceInfo = { id: '--', rev: '--', firmware: '--', bootedAt: null, caps: null };
  /** What the power numbers are worth, as the device declared it (power.meter). Null: not declared. */
  meter: Meter | null = null;
  /** Network checks requested by net.watch (ACTIVE). Null: off. */
  netWatch: { everyMs: number; dns: string | null; upstream: string | null } | null = null;
  /** Comparisons with a reference instrument, waiting to be fitted. */
  calPoints: CalPoint[] = [];
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
  /** Whether any supply sample arrived in this session (USB rules say what they cannot know). */
  private powerSeen = false;
  /** The USB device a host source follows as its target (usb.follow). Null: none. */
  usbFollow: { vid: number; pid: number; serial: string | null; port: string | null } | null = null;
  /** Waiting for the first hello of a live link. */
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** Structured record the diagnostic engine reads. Survives trace clears. */
  facts: SessionFacts = emptyFacts();
  /** Current output of the diagnostic engine. */
  diagnoses: Diagnosis[] = [];
  /** Records this session as it happens (.hdlog). Null for replays. */
  recorder: SessionRecorder | null = null;
  /** PHYSICAL or SIMULATED: where this session's evidence comes from. */
  origin: Origin | null = null;
  /** Header of the recording being replayed, if this session is a replay. */
  replayOf: SessionHeader | null = null;
  /** Integrity of the file being replayed: VERIFIED, MODIFIED... */
  replayIntegrity: Integrity | null = null;
  /** Why recording stopped (storage refused a write), if it did. */
  recordingError: string | null = null;
  /**
   * A pack: several Dogs on one timeline and one clock (core/pack.ts).
   * Null: one device, exactly as before packs.
   */
  pack: Pack | null = null;
  /** The Dogs of a pack, in order. Empty for one device. */
  dogs: DogState[] = [];
  /** In a pack, one Dog observes each capability: the first to claim it. */
  readonly owners = new Map<Capability, string>();

  private transport: Transport | null = null;
  private listeners = new Set<Listener>();
  private version = 0;
  private lastLoggedPower: { v: number; i: number } | null = null;
  private dropStartedAt: number | null = null;
  /** HDP frames received in this session: the sequence of the last one. */
  private framesReceived = 0;
  /** Sequence of the frame being handled, null outside a frame. */
  private frameSeq: number | null = null;
  private dropMin = Infinity;
  private lastBelowAt: number | null = null;
  private overcurrent = false;
  private framingErrorTimes: number[] = [];
  private lastBaudHypothesisAt = -Infinity;
  private lastFrameErrorLogAt = -Infinity;
  private suppressedFrameErrors = 0;
  private probeCounter = 0;
  private seenFrames = new Set<DeviceFrame['type']>();
  private lastDiagnosisAt = -Infinity;
  private reported = new Map<DiagnosisId, Confidence>();
  /** Clock of the frame being handled, in a pack. */
  private clk: Clk | null = null;
  private lastBelowClk: Clk | undefined;
  private lastSync = new Map<string, number>();
  private syncId = 0;
  /** Dog/capability pairs already reported as refused (said once). */
  private refusedSaid = new Set<string>();

  /** The operator's own settings, as stored. A replay may run on others. */
  private own: Settings;

  /**
   * Host time, read once per arrival: while a frame (or a loss, an error, a
   * command sent) is handled, every reading is the time it was recorded at.
   * A replay reads the recording's times, so live and replay see the same.
   */
  readonly now = (): number => this.arrival ?? this.clock();
  private arrival: number | null = null;

  constructor(
    private readonly store: SettingsStore = memoryStore(),
    /** Host clock. A replay passes the recording's clock. */
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = this.now();
    this.own = { ...DEFAULT_SETTINGS, ...(store.load() ?? {}) };
    this.settings = { ...this.own };
    this.storageOk = store.save(this.own);
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
    this.trace.append(t, source, severity, message, value, this.frameSeq ?? undefined);
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

  /**
   * The interface starts with no device: the same boot screen, and only
   * what can really be checked without one. No device service is reported
   * on: with nothing connected there is nothing to say about them.
   */
  async start(onStep: (step: BootStep) => void, pace = 90): Promise<BootStep[]> {
    const steps: BootStep[] = [];
    const wait = (n: number) => (n > 0 ? new Promise((r) => setTimeout(r, n)) : Promise.resolve());
    const step = async (s: BootStep) => {
      steps.push(s);
      onStep(s);
      await wait(pace);
    };
    await step({ label: 'EVENT BUS', status: 'OK' });
    await step(
      this.storageOk
        ? { label: 'LOCAL STORAGE', status: 'OK' }
        : { label: 'LOCAL STORAGE', status: 'WARN', detail: 'unavailable, settings will not persist' },
    );
    await step({ label: 'TRACE ENGINE', status: 'OK' });
    await step({ label: 'DIAGNOSTIC RULES', status: 'OK', detail: `${RULES.length} loaded` });
    await step({ label: 'HARDWARE INTERFACE', status: 'WARN', detail: 'not connected: choose a source' });
    return steps;
  }

  /** Open a transport. Returns false (and records why) instead of throwing. */
  async connect(transport: Transport): Promise<boolean> {
    await this.disconnect();
    this.transport = transport;
    this.transportKind = transport.kind;
    this.transportLabel = transport.label;
    this.link = 'CONNECTING';
    this.origin = transport.origin;
    this.replayOf = transport instanceof ReplayTransport ? transport.recording.header : null;
    this.replayIntegrity = transport instanceof ReplayTransport ? (transport.recording.integrity ?? null) : null;
    this.pack = transport.dogs ? new Pack(transport.dogs) : null;
    this.dogs = (transport.dogs ?? []).map((id) => ({ id, device: null, observes: [], lost: false }));
    this.owners.clear();
    this.refusedSaid.clear();
    this.lastSync.clear();
    if (this.pack && this.recorder && !this.recorder.header.dogs) {
      // A pack goes in hdlog v3: a v2 file has no Dog on its lines and could not be replayed.
      this.recorder = null;
      this.recordingStopped('a pack needs an hdlog v3 recording (Dogs in the header): this session is not recorded');
    }
    // Same thresholds as when it was recorded, or the diagnosis could differ.
    if (this.replayOf?.thresholds) this.settings = { ...this.settings, ...this.replayOf.thresholds };
    this.changed();
    try {
      await transport.open({
        frame: (f, dog) =>
          this.arriving(() => {
            this.recorder?.add(dog === undefined ? { at: this.now(), frame: f } : { at: this.now(), dog, frame: f });
            if (this.pack && dog !== undefined) this.onPackFrame(dog, f);
            else this.onFrame(f);
          }),
        error: (message, raw, dog) =>
          this.arriving(() => {
            const on = dog === undefined ? {} : { dog };
            this.recorder?.add(raw === undefined ? { at: this.now(), ...on, reject: message } : { at: this.now(), ...on, reject: message, raw });
            this.onFrameError(dog === undefined ? message : `${dog}: ${message}`, raw);
          }),
        lost: (reason, dog) =>
          this.arriving(() => {
            this.recorder?.add(dog === undefined ? { at: this.now(), lost: reason } : { at: this.now(), dog, lost: reason });
            if (this.pack && dog !== undefined) this.onDogLost(dog, reason);
            else this.onLost(reason);
          }),
        sent: (cmd, dog) => {
          if (this.pack && dog !== undefined && cmd.cmd === 'time') this.pack.sent(dog, cmd.id, this.now());
        },
        annotate: (text) => this.mark(text),
        configure: (thresholds) => this.useThresholds(thresholds),
        ended: () => this.onReplayEnded(),
      });
      // A replay may already have ended; a live link may already have dropped.
      if (this.link !== 'CONNECTING') return this.replayOf !== null;
      this.transportLabel = transport.label;
      this.link = 'ONLINE';
      this.log(this.now(), 'SYS', 'PASS', `link up: ${transport.kind}`, transport.label);
      if (!this.replayOf) this.waitForHello(transport, this.frameErrors);
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

  /**
   * A port that opens is not yet a Hardware Dog: any USB serial device
   * opens. Without a hello, say so, and what came instead, rather than
   * showing an empty screen as if all were well.
   */
  private waitForHello(transport: Transport, errorsBefore: number): void {
    this.stopWaitingForHello();
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.transport !== transport || this.link !== 'ONLINE') return;
      const silent = this.pack ? this.dogs.filter((d) => d.device === null).map((d) => d.id) : this.device.id === '--' ? [''] : [];
      if (silent.length === 0) return;
      const refused = this.frameErrors - errorsBefore;
      const secs = HELLO_WAIT_MS / 1000;
      const which = this.pack ? `${silent.join(' ')}: ` : '';
      const detail =
        refused > 0
          ? `${which}the port talks, but not HDP (${refused} line${refused === 1 ? '' : 's'} refused, see TRACE). It is another serial device, or a board without the Hardware Dog firmware (docs/FIRMWARE.md).`
          : `${which}the port opened and stayed silent for ${secs} s. A Hardware Dog says hello at once: this is another serial device, a board without the Hardware Dog firmware, or a board in download mode (press RESET).`;
      this.lastError = { what: NO_HARDWARE_DOG, where: this.transportLabel || transport.kind, when: this.now(), detail };
      this.log(this.now(), 'SYS', 'FAIL', 'no Hardware Dog answered', detail);
      this.changed();
    }, HELLO_WAIT_MS);
  }

  private stopWaitingForHello(): void {
    if (this.helloTimer !== null) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  /** A hello arrived: a late one clears the warning it had caused. */
  private heardHello(): void {
    if (this.pack ? this.dogs.every((d) => d.device !== null) : true) this.stopWaitingForHello();
    if (this.lastError?.what === NO_HARDWARE_DOG && (!this.pack || this.dogs.every((d) => d.device !== null))) this.lastError = null;
  }

  async disconnect(): Promise<void> {
    this.stopWaitingForHello();
    if (!this.transport) return;
    const t = this.transport;
    this.transport = null;
    this.flushPack();
    await t.close();
    this.link = 'OFFLINE';
    this.usb.connected = false;
    this.power.condition = 'NO SIGNAL';
    this.log(this.now(), 'SYS', 'INFO', `link closed: ${t.kind}`);
    this.changed();
  }

  // ------------------------------------------------------------ frames

  /** Host wall-clock time for a device timestamp. */
  /** Handle one arrival on one reading of the clock (see now). */
  private arriving(handle: () => void): void {
    if (this.arrival !== null) return handle();
    this.arrival = this.clock();
    try {
      handle();
    } finally {
      this.arrival = null;
    }
  }

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

  /** A recording has been fully played: final diagnosis, link closed. */
  private onReplayEnded(): void {
    this.stopWaitingForHello();
    this.flushPack();
    const t = this.now();
    this.transport = null;
    if (this.link !== 'LOST') this.link = 'OFFLINE';
    this.evaluate(t);
    this.log(t, 'SYS', 'INFO', 'replay ended', this.replayOf ? `${this.replayOf.id} / ${this.replayOf.source}` : undefined);
    this.changed();
  }

  private onLost(reason: string): void {
    this.stopWaitingForHello();
    this.flushPack();
    const t = this.now();
    this.transport = null;
    this.link = 'LOST';
    this.usb.connected = false;
    this.power.condition = 'NO SIGNAL';
    this.lastError = { what: 'DEVICE LINK LOST', where: this.transportLabel || 'transport', when: t, detail: reason };
    this.log(t, 'SYS', 'FAIL', 'device link lost', reason);
    this.changed();
  }

  // ------------------------------------------------------------ pack

  /**
   * A frame from one Dog of a pack. It is numbered on arrival (the number
   * the evidence cites is its place in the stream, as recorded), then goes
   * on the timeline when the pack can place it in the true order.
   */
  private onPackFrame(dog: string, f: DeviceFrame): void {
    this.framesReceived++;
    this.seenFrames.add(f.type);
    const at = this.now();
    const placed = this.pack!.arrive(dog, this.framesReceived, f, at);
    // Keep each live Dog's clock sampled: at once after its hello, then every SYNC_EVERY_MS.
    if (this.transport && this.transportKind !== 'REPLAY') {
      if (f.type === 'hello') this.lastSync.delete(dog);
      const last = this.lastSync.get(dog);
      if (last === undefined || at - last >= SYNC_EVERY_MS) {
        this.lastSync.set(dog, at);
        this.sendTo(dog, { cmd: 'time', id: ++this.syncId });
      }
    }
    for (const p of placed) this.place(p);
  }

  /** Put one placed frame on the timeline, on its Dog's clock. */
  private place(p: Placed): void {
    this.frameSeq = p.seq;
    this.clk = { dog: p.dog, err: p.err };
    try {
      const f = p.frame;
      if (f.type === 'time') return; // clock samples: the pack has used them
      if (f.type === 'hello') return this.onDogHello(p.dog, f, p.t);
      const cap = capabilityOf(f.type);
      if (cap !== null && this.owners.get(cap) !== p.dog) return this.refuse(p.dog, cap, p.t);
      this.handleFrame(f, p.t);
    } finally {
      this.frameSeq = null;
      this.clk = null;
    }
  }

  /**
   * A Dog said who it is. Each capability is observed by one Dog only, the
   * first to claim it: one source of truth per signal, and the rules never
   * need to know which Dog spoke.
   */
  private onDogHello(dog: string, f: Extract<DeviceFrame, { type: 'hello' }>, t: number): void {
    const state = this.dogs.find((d) => d.id === dog)!;
    const claimed = f.caps ?? [...CAPABILITIES];
    const kept: Capability[] = [];
    for (const cap of claimed) {
      const owner = this.owners.get(cap);
      if (owner === undefined || owner === dog) {
        this.owners.set(cap, dog);
        kept.push(cap);
      } else {
        this.log(t, 'SYS', 'FAIL', `${dog} ${f.device}: ${cap} is already observed by ${owner}`, `${dog} ignored for ${cap}`);
      }
    }
    state.device = { id: f.device, rev: f.rev, firmware: f.fw, bootedAt: t - f.t, caps: f.caps ?? null };
    state.observes = kept;
    state.lost = false;
    this.heardHello();
    // The first Dog stands for the pack where one device is expected.
    if (this.dogs[0]!.id === dog || this.device.id === '--') this.device = { ...state.device, caps: [...this.owners.keys()] };
    else this.device = { ...this.device, caps: [...this.owners.keys()] };
    if (f.caps === undefined) this.log(t, 'SYS', 'WARN', `${dog} ${f.device} declares no capabilities`, 'claims every capability not yet observed');
    this.log(t, 'SYS', 'INFO', `${dog} device ${f.device} rev ${f.rev}`, `fw ${f.fw} / proto ${f.proto} / observes ${kept.join(' ') || 'nothing'}`);
    this.changed();
  }

  private refuse(dog: string, cap: Capability, t: number): void {
    this.frameErrors++;
    const key = `${dog}/${cap}`;
    if (this.refusedSaid.has(key)) return;
    this.refusedSaid.add(key);
    this.log(t, 'SYS', 'WARN', `${dog}: ${cap} frames ignored`, `${cap} is observed by ${this.owners.get(cap) ?? 'no Dog'}`);
    this.changed();
  }

  /** One Dog's link is gone; the pack goes on with the others. */
  /**
   * The pack as the interface shows it: every Dog, its link, what it
   * observes (and what it was refused), and how well its clock is known at
   * host time `t`. Empty when the source is one device.
   */
  packView(t = this.now()): DogView[] {
    if (!this.pack) return [];
    return this.dogs.map((d) => {
      const clock = this.pack!.clocks.get(d.id);
      const err = clock?.errAt(t) ?? null;
      const claimed = d.device ? (d.device.caps ?? [...CAPABILITIES]) : [];
      return {
        id: d.id,
        device: d.device,
        link: d.lost ? 'LOST' : d.device ? 'ONLINE' : 'WAITING',
        observes: d.observes,
        refused: claimed.filter((c) => !d.observes.includes(c)),
        clock: { state: !d.device ? 'NONE' : err === null ? 'UNBOUNDED' : 'ALIGNED', errMs: err },
      };
    });
  }

  private onDogLost(dog: string, reason: string): void {
    const t = this.now();
    const state = this.dogs.find((d) => d.id === dog);
    if (state) state.lost = true;
    for (const p of this.pack!.lost(dog, t)) this.place(p);
    if (this.owners.get('usb') === dog) this.usb.connected = false;
    if (this.owners.get('power') === dog) this.power.condition = 'NO SIGNAL';
    this.log(t, 'SYS', 'FAIL', `${dog} link lost`, reason);
    if (this.dogs.every((d) => d.lost)) this.onLost('every Dog of the pack is gone');
    this.changed();
  }

  /** Everything the pack still holds goes on the timeline (end of the session). */
  private flushPack(): void {
    if (!this.pack) return;
    for (const p of this.pack.flush()) this.place(p);
  }

  /** How well a Dog's clock is aligned now (ms, null: unbounded). */
  clockError(dog: string): number | null {
    return this.pack?.clocks.get(dog)?.errAt(this.now()) ?? null;
  }

  /** The clock of the frame being handled, to stamp the facts it makes. */
  private stamp(): { clk?: Clk } {
    return this.clk ? { clk: this.clk } : {};
  }

  /**
   * Every HDP frame gets the next sequence number of the session (1, 2,
   * 3...). Facts and trace events it produces carry it: diagnoses cite
   * their evidence by it. The same frames arrive in the same order live,
   * in a replay and through dogd, so the numbers are the same everywhere.
   */
  onFrame(f: DeviceFrame): void {
    this.framesReceived++;
    this.frameSeq = this.framesReceived;
    try {
      this.handleFrame(f);
    } finally {
      this.frameSeq = null;
    }
  }

  /** Whether the device declared this capability (no caps declared = everything). */
  observes(cap: string): boolean {
    if (this.pack) return this.owners.has(cap as Capability);
    return this.device.caps === null || this.device.caps.includes(cap);
  }

  /** Sequence of the frame being handled (facts cite it). */
  private get seq(): number {
    return this.frameSeq ?? this.framesReceived;
  }

  private handleFrame(f: DeviceFrame, placedAt?: number): void {
    this.seenFrames.add(f.type);
    if (f.type === 'hello') {
      this.device = { id: f.device, rev: f.rev, firmware: f.fw, bootedAt: this.now() - f.t, caps: f.caps ?? null };
      // A (re)booted device declares its meter again; until then it is unknown.
      this.meter = null;
      this.heardHello();
      this.log(this.hostTime(f.t), 'SYS', 'INFO', `device ${f.device} rev ${f.rev}`, `fw ${f.fw} / proto ${f.proto}`);
      this.changed();
      return;
    }
    const t = placedAt ?? this.hostTime(f.t);
    switch (f.type) {
      case 'power':
        this.onPower(t, f.v, f.i);
        break;
      case 'power.meter': {
        const { type: _type, t: _t, ...meter } = f;
        this.meter = meter;
        const v = meter.v_err;
        const i = meter.i_err;
        this.log(
          t,
          'POWER',
          'INFO',
          `meter: ${meter.sensor}, ${meter.basis === 'CALIBRATION' ? `calibrated ${meter.cal?.date ?? ''}` : 'datasheet accuracy'}`,
          `V ±${v.pct}% +${(v.abs * 1000).toFixed(1)} mV / I ±${i.pct}% +${(i.abs * 1000).toFixed(2)} mA`,
        );
        break;
      }
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
        if (this.facts.uart.baud !== f.baud) {
          // Judge the new rate on its own evidence.
          this.facts.uart.baud = f.baud;
          this.facts.uart.rxAtBaud = 0;
          this.facts.uart.framingAtBaud = [];
        }
        if (changed) this.log(t, 'UART', 'INFO', `${f.port} configured`, `${f.baud} ${f.bits}${f.parity[0]}${f.stop}`);
        break;
      }
      case 'uart.rx':
        this.serial.rxBytes += utf8Length(f.data) + 1;
        this.pushSerial({ t, dir: 'RX', text: f.data });
        this.log(t, 'UART', 'INFO', f.data.length > 120 ? f.data.slice(0, 117) + '...' : f.data);
        this.facts.uart.rxLines++;
        this.facts.uart.rxAtBaud++;
        {
          const parsed = parseResetLine(f.data, t, this.seq);
          const reset = parsed ? { ...parsed, ...this.stamp() } : null;
          if (reset) {
            this.remember(this.facts.uart.resets, reset);
            if (reset.code !== 0x1) this.log(t, 'UART', 'WARN', 'target reset', reset.reason);
          }
        }
        break;
      case 'uart.error':
        this.onUartError(t, f.kind);
        break;
      case 'i2c.scan':
        this.onI2cScan(t, f);
        break;
      case 'i2c.error':
        this.bus = {
          ...this.bus,
          ...(f.every_ms !== undefined ? { watchMs: f.every_ms } : {}),
          state: 'FAULT',
          faults: this.bus.faults + 1,
          lastFault: { t, kind: f.kind },
        };
        this.remember(this.facts.i2c.errors, { seq: this.seq, t, kind: f.kind, ...this.stamp() });
        this.log(t, 'I2C', 'FAIL', `bus fault ${f.kind}`, f.detail ?? undefined);
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
    if (t - this.lastDiagnosisAt >= 1000) this.evaluate(t);
    this.changed();
  }

  /**
   * Run the diagnostic engine and put every change on the timeline:
   * a new diagnosis, a confidence change, or a diagnosis that cleared.
   */
  evaluate(t = this.now()): Diagnosis[] {
    // Rule events are conclusions, not evidence: they cite frames instead.
    const seq = this.frameSeq;
    this.frameSeq = null;
    try {
      return this.runRules(t);
    } finally {
      this.frameSeq = seq;
    }
  }

  private runRules(t: number): Diagnosis[] {
    this.lastDiagnosisAt = t;
    this.diagnoses = diagnose(this.facts, this.settings, t);
    const seen = new Set<DiagnosisId>();
    for (const d of this.diagnoses) {
      seen.add(d.id);
      if (this.reported.get(d.id) !== d.confidence) {
        this.reported.set(d.id, d.confidence);
        this.log(t, 'RULE', 'WARN', `diagnosis: ${d.title}`, `confidence ${d.confidence} / ${d.basis}`);
      }
    }
    for (const id of [...this.reported.keys()]) {
      if (!seen.has(id)) {
        this.reported.delete(id);
        this.log(t, 'RULE', 'PASS', `cleared: ${id}`);
      }
    }
    return this.diagnoses;
  }

  private remember<T>(list: T[], item: T, limit = FACT_LIMIT): void {
    list.push(item);
    if (list.length > limit) list.splice(0, list.length - limit);
  }

  private onPower(t: number, v: number, i: number): void {
    this.powerSeen = true;
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
      this.lastBelowClk = this.clk ?? undefined;
      if (this.dropStartedAt === null) {
        this.dropStartedAt = t;
        this.dropMin = v;
        p.lastDropAt = t;
        p.lastDropVoltage = v;
        p.dropCount++;
        this.remember(this.facts.drops, { seq: this.seq, start: t, end: null, min: v, ...this.stamp() });
        this.log(t, 'POWER', 'WARN', 'voltage drop', `${volts(v)} < ${volts(s.undervoltageThreshold)}`);
      } else if (v < this.dropMin) {
        this.dropMin = v;
        p.lastDropVoltage = v;
        const open = this.facts.drops.at(-1);
        if (open && open.end === null) open.min = v;
      }
    } else if (this.dropStartedAt !== null && v >= s.undervoltageThreshold + HYSTERESIS_V) {
      this.log(t, 'POWER', 'PASS', 'voltage recovered', `min ${volts(this.dropMin)} for ${ms(t - this.dropStartedAt)}`);
      this.dropStartedAt = null;
      this.dropMin = Infinity;
      const open = this.facts.drops.at(-1);
      if (open && open.end === null) open.end = t;
    }

    // Rule: overcurrent.
    if (i > s.overcurrentThreshold && !this.overcurrent) {
      this.overcurrent = true;
      this.remember(this.facts.spikes, { seq: this.seq, start: t, end: null, peak: i });
      this.log(t, 'POWER', 'WARN', 'overcurrent', `${milliamps(i)} > ${milliamps(s.overcurrentThreshold)}`);
    } else if (this.overcurrent && i > s.overcurrentThreshold * 0.95) {
      const open = this.facts.spikes.at(-1);
      if (open && open.end === null) open.peak = Math.max(open.peak, i);
    } else if (i <= s.overcurrentThreshold * 0.95 && this.overcurrent) {
      this.overcurrent = false;
      const open = this.facts.spikes.at(-1);
      if (open && open.end === null) open.end = t;
      this.log(t, 'POWER', 'PASS', 'current back in range', milliamps(i));
    }

    p.condition = this.dropStartedAt !== null ? 'UNDERVOLTAGE' : this.overcurrent ? 'OVERCURRENT' : 'STABLE';

    // Facts: target running without USB, and whether it kept running after a disconnect.
    // Only a device that watches USB can say "no USB device": silence is not an observation.
    const un = this.facts.unenumerated;
    if (this.observes('usb') && !this.usb.connected && i >= RUNNING_CURRENT) {
      if (un.since === null) un.since = t;
      if (un.firstAt === null) {
        un.firstAt = t;
        un.firstSeq = this.seq;
      }
      un.longestMs = Math.max(un.longestMs, t - un.since);
    } else {
      un.since = null;
    }
    const detach = this.facts.detaches.at(-1);
    if (detach && detach.currentAfter === null && t - detach.t >= 100) detach.currentAfter = i;

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
      this.remember(this.facts.attaches, t);
      this.facts.unenumerated.since = null;
      this.log(t, 'USB', 'INFO', 'device connected', `${usbName(u.descriptor)} / ${f.speed} SPEED`);
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
    // Same device every time: the name says so, it is not a new one.
    this.log(t, 'USB', 'WARN', 'device disconnected', usbName(u.descriptor));

    // Rule: USB / power correlation. In a pack the drop and the disconnect
    // may come from two clocks: their alignment is part of the question.
    const window = this.settings.correlationWindowMs;
    // The question: did it happen during the latest drop, or within the window after it?
    const on = this.lastBelowClk ? { clk: this.lastBelowClk } : {};
    const below: Stamp | null = this.lastBelowAt === null ? null : { t: this.lastBelowAt, ...on };
    const started: Stamp | null = below === null ? null : { t: this.power.lastDropAt ?? this.lastBelowAt!, ...on };
    const here: Stamp = { t, ...this.stamp() };
    const rel = below === null ? 'OUT' : during(started!, below, here, window);
    const correlated = rel === 'IN';
    const m = below === null ? 0 : margin(below, here);
    this.remember(this.facts.detaches, {
      seq: this.seq,
      t,
      dropAt: correlated ? (this.power.lastDropAt ?? this.lastBelowAt) : null,
      dropSeq: correlated ? (this.facts.drops.at(-1)?.seq ?? null) : null,
      dropMin: correlated ? this.power.lastDropVoltage : null,
      currentAfter: null,
      ...(this.powerSeen ? {} : { supplyUnseen: true as const }),
      ...this.stamp(),
      ...(rel === 'UNKNOWN' ? { undetermined: Number.isFinite(m) ? m : null } : {}),
    });
    if (rel === 'UNKNOWN') {
      this.log(
        t,
        'RULE',
        'INFO',
        'disconnect vs voltage drop: undetermined',
        `${Math.round(t - this.lastBelowAt!)} ms apart, clocks aligned ${Number.isFinite(m) ? `+-${m.toFixed(1)} ms` : 'without a bound'}`,
      );
    }
    if (correlated) {
      u.correlatedDisconnects++;
      const dropAt = this.power.lastDropAt ?? this.lastBelowAt!;
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
    // A line that does not read as text (a console read by this browser) is the same clue.
    if (kind === 'framing') this.remember(this.facts.uart.framingAtBaud, { t, seq: this.seq });
    if (kind === 'garbled') this.remember(this.facts.uart.framingAtBaud, { t, seq: this.seq, kind: 'garbled' });
    // Rule: repeated framing errors -> baud mismatch is a hypothesis, not a fact.
    if (kind !== 'framing' && kind !== 'garbled') return;
    this.framingErrorTimes = this.framingErrorTimes.filter((x) => t - x < 5000);
    this.framingErrorTimes.push(t);
    if (this.framingErrorTimes.length >= 3 && t - this.lastBaudHypothesisAt > 10_000) {
      this.lastBaudHypothesisAt = t;
      this.log(t, 'RULE', 'WARN', 'possible cause: baud rate mismatch', `${this.framingErrorTimes.length} framing errors in 5 s at ${this.serial.baud}`);
    }
  }

  /**
   * A scan of the target bus. Periodic scans (i2c.watch) only put changes
   * on the timeline: an address that stops answering, or comes back.
   */
  private onI2cScan(t: number, f: Extract<DeviceFrame, { type: 'i2c.scan' }>): void {
    const previous = this.facts.i2c.scans.at(-1);
    const addresses = f.devices.map((d) => d.addr);
    this.bus = {
      ...this.bus,
      // The device says when a scan is part of a periodic watch (set at boot or by i2c.watch).
      ...(f.every_ms !== undefined ? { watchMs: f.every_ms } : {}),
      protocol: 'I2C',
      speedHz: f.speed,
      state: 'ACTIVE',
      lastScanAt: t,
      devices: f.devices.map((d) => ({ address: d.addr, confirmed: d.ident, method: d.method })),
    };
    this.remember(this.facts.i2c.scans, { seq: this.seq, t, addresses, ...this.stamp() });
    if (!previous || this.bus.watchMs === 0) {
      this.log(t, 'I2C', 'PASS', `scan complete`, `${f.devices.length} device(s)`);
      for (const d of f.devices) {
        this.log(t, 'I2C', 'INFO', `${i2cAddress(d.addr)} ${d.ident ?? 'UNKNOWN'}`, d.ident ? 'confirmed' : 'no identity');
      }
      if (!previous) return;
    }
    for (const a of previous.addresses) if (!addresses.includes(a)) this.log(t, 'I2C', 'WARN', `${i2cAddress(a)} no longer answers`);
    for (const a of addresses) if (!previous.addresses.includes(a)) this.log(t, 'I2C', 'INFO', `${i2cAddress(a)} answers`);
  }

  /**
   * The link went down: was it the supply? A drop or a target reset just
   * before is the cause candidate. Then follow the way back: link, DHCP, DNS.
   */
  private trackOutage(t: number, prevUp: boolean, next: NetState): void {
    const up = !!next.link?.up;
    if (prevUp && !up) {
      const drop = this.facts.drops.at(-1);
      const reset = this.facts.uart.resets.at(-1);
      const here: Stamp = { t, ...this.stamp() };
      const rel = (x: Stamp | null) => (x === null ? ('OUT' as const) : relation(x, here, NET_POWER_WINDOW_MS));
      const dropAt: Stamp | null = drop ? { t: drop.start, ...(drop.clk ? { clk: drop.clk } : {}) } : null;
      const resetAt: Stamp | null = reset ? { t: reset.t, ...(reset.clk ? { clk: reset.clk } : {}) } : null;
      const byDrop = rel(dropAt);
      const byReset = rel(resetAt);
      const cause =
        byDrop === 'IN'
          ? { kind: 'DROP' as const, t: drop!.start, seq: drop!.seq, text: `voltage drop ${volts(drop!.min)}` }
          : byReset === 'IN'
            ? { kind: 'RESET' as const, t: reset!.t, seq: reset!.seq, text: `target reset ${reset!.reason}` }
            : null;
      const unsure = cause === null && (byDrop === 'UNKNOWN' || byReset === 'UNKNOWN');
      const m = Math.max(dropAt && byDrop === 'UNKNOWN' ? margin(dropAt, here) : 0, resetAt && byReset === 'UNKNOWN' ? margin(resetAt, here) : 0);
      this.remember(this.facts.outages, {
        seq: this.seq,
        t,
        cause,
        ...this.stamp(),
        ...(unsure ? { undetermined: Number.isFinite(m) ? m : null } : {}),
        upAt: null,
        upSeq: null,
        dhcpAt: null,
        dhcpSeq: null,
        dnsAt: null,
        dnsSeq: null,
      });
      if (unsure) this.log(t, 'RULE', 'INFO', 'link down vs drop / reset: undetermined', `clocks aligned ${Number.isFinite(m) ? `+-${m.toFixed(1)} ms` : 'without a bound'}`);
      if (cause) this.log(t, 'RULE', 'WARN', `link down ${ms(t - cause.t)} after ${cause.text}`);
      return;
    }
    const o = this.facts.outages.at(-1);
    if (!o || o.dnsAt !== null) return;
    if (up && o.upAt === null) {
      o.upAt = t;
      o.upSeq = this.seq;
    }
    if (o.upAt !== null && o.dhcpAt === null && next.dhcp === 'PASS') {
      o.dhcpAt = t;
      o.dhcpSeq = this.seq;
    }
    if (o.dhcpAt !== null && next.dns.status === 'PASS') {
      o.dnsAt = t;
      o.dnsSeq = this.seq;
      this.log(t, 'NET', 'PASS', 'network back', `link +${ms(o.upAt! - o.t)} / DHCP +${ms(o.dhcpAt - o.t)} / DNS +${ms(t - o.t)} after the link loss`);
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
    if (!first) this.trackOutage(t, !!prev.link?.up, next);
    this.net = next;
    this.remember(
      this.facts.net,
      {
        seq: this.seq,
        t,
        linkUp: f.link ? f.link.up : null,
        dhcp: f.dhcp,
        gateway: f.gateway.status,
        dns: f.dns.status,
        internet: f.internet,
        latency: f.latency,
        loss: f.loss,
        ...this.stamp(),
      },
      NET_HISTORY,
    );
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

  /** Null when `action` can be sent now; else why not (and it is said). */
  private requireLink(action: string, cap?: Capability): string | null {
    if (this.transportKind === 'REPLAY' && !this.online) return `${action}: recorded session, read-only`;
    let msg: string | null = null;
    if (!this.online) msg = `${action}: no device link (${this.link})`;
    else if (this.pack && cap !== undefined && !this.owners.has(cap)) msg = `${action}: no Dog of the pack observes ${cap}`;
    if (msg === null) return null;
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

  /** Send a command to the device and record it. In a pack, to the Dog that observes it. */
  private send(cmd: HostCommand): void {
    if (!this.pack) {
      this.transport!.send(cmd);
      this.recorder?.add({ at: this.now(), cmd });
      return;
    }
    const cap = commandCapability(cmd);
    const dogs = cap === null ? this.dogs.map((d) => d.id) : [this.owners.get(cap)].filter((d): d is string => d !== undefined);
    for (const dog of dogs) this.sendTo(dog, cmd);
  }

  private sendTo(dog: string, cmd: HostCommand): void {
    const at = this.now();
    // Recorded before it is sent: a Dog may answer at once, and the answer
    // must follow its command in the file, as it did here.
    this.recorder?.add({ at, dog, cmd });
    if (cmd.cmd === 'time') this.pack?.sent(dog, cmd.id, at);
    this.transport!.send(cmd, dog);
  }

  /** A source could not be opened: said where it shows (STATUS), not only in the trace. */
  sourceFailed(what: string, where: string, detail: string): void {
    this.lastError = { what, where, when: this.now(), detail };
    this.log(this.now(), 'SYS', 'FAIL', what.toLowerCase(), detail);
    this.changed();
  }

  mark(text: string): void {
    this.recorder?.add({ at: this.now(), mark: text });
    this.log(this.now(), 'USER', 'INFO', `mark: ${text}`);
    this.changed();
  }

  /** Returns an error message, or null when the command was sent. */
  /**
   * Follow one USB device of the computer as the target (a host source):
   * its disconnects go to the USB rules. Null stops. Not a disconnect.
   */
  followUsb(target: { vid: number; pid: number; serial?: string | null; port?: string | null } | null): string | null {
    const err = this.requireLink('usb follow', 'usb');
    if (err) return err;
    if (target && (!Number.isInteger(target.vid) || !Number.isInteger(target.pid) || target.vid < 0 || target.pid < 0 || target.vid > 0xffff || target.pid > 0xffff)) {
      return 'usb follow: VID and PID are 0000 to FFFF';
    }
    this.usbFollow = target ? { vid: target.vid, pid: target.pid, serial: target.serial ?? null, port: target.port ?? null } : null;
    // A new target starts clean: the previous one's state is not its.
    this.usb = emptyUsb();
    this.send(
      target
        ? { cmd: 'usb.follow', vid: target.vid, pid: target.pid, ...(target.serial ? { serial: target.serial } : {}), ...(target.port ? { port: target.port } : {}) }
        : { cmd: 'usb.follow' },
    );
    this.log(this.now(), 'USER', 'INFO', target ? `usb follow ${hex(target.vid)}:${hex(target.pid)}` : 'usb follow off');
    this.changed();
    return null;
  }

  enumerateUsb(): string | null {
    const err = this.requireLink('usb enumerate', 'usb');
    if (err) return err;
    this.send({ cmd: 'usb.enumerate' });
    this.log(this.now(), 'USER', 'INFO', 'usb enumerate requested');
    this.changed();
    return null;
  }

  setBaud(baud: number): string | null {
    if (!Number.isInteger(baud) || baud < 300 || baud > 4_000_000) return `invalid baud rate: ${baud}`;
    const err = this.requireLink('serial config', 'uart');
    if (err) return err;
    this.send({ cmd: 'uart.config', baud });
    this.log(this.now(), 'USER', 'INFO', `serial baud -> ${baud}`);
    this.framingErrorTimes = [];
    this.changed();
    return null;
  }

  sendSerial(text: string): string | null {
    const err = this.requireLink('serial send', 'uart');
    if (err) return err;
    const t = this.now();
    this.send({ cmd: 'uart.tx', data: text });
    this.serial.txBytes += utf8Length(text) + 1;
    this.pushSerial({ t, dir: 'TX', text });
    this.log(t, 'USER', 'INFO', `uart tx: ${text}`);
    this.changed();
    return null;
  }

  /**
   * One calibration point: the mean of the last second of power samples,
   * as the device measured them before its current calibration, against
   * what the reference instrument reads now.
   */
  addCalPoint(refV: number, refI: number): string | null {
    const err = this.requireLink('meter point', 'power');
    if (err) return err;
    if (!this.meter) return 'the device has not declared its meter (power.meter): nothing to calibrate';
    if (!(refV > 0) || !Number.isFinite(refI)) return 'give the reference reading: volts above 0, current in mA';
    const samples = this.power.samples;
    const end = samples.at(-1)?.t ?? 0;
    const last = samples.filter((x) => x.t > end - 1000);
    if (last.length < 10) return `only ${last.length} power samples in the last second: wait for a steady reading`;
    const mean = (f: (x: (typeof last)[number]) => number) => last.reduce((a, x) => a + f(x), 0) / last.length;
    const raw = rawOf(mean((x) => x.voltage), mean((x) => x.current), this.meter.cal);
    this.calPoints.push({ rawV: raw.v, rawI: raw.i, refV, refI });
    this.log(this.now(), 'USER', 'INFO', `calibration point ${this.calPoints.length}`, `device ${raw.v.toFixed(4)} V ${(raw.i * 1000).toFixed(2)} mA / reference ${refV} V ${(refI * 1000).toFixed(2)} mA`);
    this.changed();
    return null;
  }

  /** Fit the points and store the calibration on the device. */
  applyCalibration(reference: string, date: string): string | null {
    const err = this.requireLink('meter cal', 'power');
    if (err) return err;
    const ref = reference.trim();
    if (!ref || ref.length > 64) return 'name the reference instrument (1 to 64 characters)';
    const r = fitCalibration(this.calPoints);
    if (!r.ok) return r.error;
    this.send({ cmd: 'meter.cal', date, ref, ...r.fit });
    this.log(this.now(), 'USER', 'INFO', `calibration sent: ${this.calPoints.length} points against ${ref}`, `V gain ${r.fit.v_gain} / I gain ${r.fit.i_gain} offset ${(r.fit.i_offset * 1000).toFixed(2)} mA`);
    this.calPoints = [];
    this.changed();
    return null;
  }

  clearCalibration(): string | null {
    const err = this.requireLink('meter clear', 'power');
    if (err) return err;
    this.calPoints = [];
    this.send({ cmd: 'meter.clear' });
    this.log(this.now(), 'USER', 'INFO', 'calibration cleared: datasheet accuracy');
    this.changed();
    return null;
  }

  /** ACTIVE: scan the target bus every `seconds` (0 stops). */
  watchI2c(seconds: number): string | null {
    if (!Number.isFinite(seconds) || seconds < 0 || (seconds > 0 && seconds < 1) || seconds > 600) return 'i2c watch: 1 to 600 seconds, or off';
    const err = this.requireLink('i2c watch', 'i2c');
    if (err) return err;
    const every = Math.round(seconds * 1000);
    this.bus = { ...this.bus, watchMs: every };
    this.send({ cmd: 'i2c.watch', every_ms: every });
    this.log(this.now(), 'USER', 'INFO', every ? `i2c watch every ${seconds} s` : 'i2c watch off', every ? 'ACTIVE: address probe 0x08-0x77 on each scan' : undefined);
    this.changed();
    return null;
  }

  /** ACTIVE: check gateway, DNS and upstream every `seconds` (0 stops). */
  watchNet(seconds: number, dns?: string, upstream?: string): string | null {
    if (!Number.isFinite(seconds) || seconds < 0 || (seconds > 0 && seconds < 2) || seconds > 600) return 'net watch: 2 to 600 seconds, or off';
    const host = /^[A-Za-z0-9.-]{1,253}$/;
    if ((dns && !host.test(dns)) || (upstream && !host.test(upstream))) return 'net watch: host names only (letters, digits, dots, dashes)';
    const err = this.requireLink('net watch', 'net');
    if (err) return err;
    const every = Math.round(seconds * 1000);
    this.netWatch = every ? { everyMs: every, dns: dns ?? null, upstream: upstream ?? null } : null;
    this.send({ cmd: 'net.watch', every_ms: every, ...(dns ? { dns } : {}), ...(upstream ? { upstream } : {}) });
    const what = ['ping gateway', dns ? `resolve ${dns}` : null, upstream ? `TCP ${upstream}:443` : null].filter(Boolean).join(', ');
    this.log(this.now(), 'USER', 'INFO', every ? `net watch every ${seconds} s` : 'net watch off', every ? `ACTIVE: ${what}` : undefined);
    this.changed();
    return null;
  }

  scanI2c(): string | null {
    const err = this.requireLink('i2c scan', 'i2c');
    if (err) return err;
    this.bus.state = 'SCANNING';
    this.send({ cmd: 'i2c.scan' });
    this.log(this.now(), 'USER', 'INFO', 'i2c scan requested', 'ACTIVE: address probe 0x08-0x77');
    this.changed();
    return null;
  }

  refreshNet(): string | null {
    const err = this.requireLink('net refresh', 'net');
    if (err) return err;
    this.send({ cmd: 'net.refresh' });
    this.changed();
    return null;
  }

  /** Start an active probe. Returns the run, or an error message. */
  probe(target: string, tests: ProbeTest[]): ProbeRun | string {
    const clean = target.trim();
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(clean)) return `invalid target: "${target}"`;
    if (tests.length === 0) return 'no tests selected';
    const err = this.requireLink('probe', 'probe');
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
    this.send({ cmd: 'probe', id: run.id, target: clean, tests: run.tests });
    this.log(run.startedAt, 'USER', 'INFO', `probe ${clean}`, `ACTIVE: ${run.tests.join(' ')}`);
    this.changed();
    return run;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.own = { ...this.own, ...patch };
    this.settings = { ...this.settings, ...patch };
    this.storageOk = this.store.save(this.own);
    if (THRESHOLD_KEYS.some((k) => k in patch)) {
      const t = thresholdsOf(this.settings);
      // A replay must apply the change at the same moment to diagnose the same.
      this.recorder?.add({ at: this.now(), thresholds: t });
      this.log(this.now(), 'SYS', 'INFO', 'thresholds changed', describeThresholds(t));
    }
    this.changed();
  }

  /** Thresholds carried by a recording: applied, never saved as the operator's. */
  private useThresholds(thresholds: Thresholds): void {
    this.settings = { ...this.settings, ...thresholds };
    this.log(this.now(), 'SYS', 'INFO', 'thresholds changed (recorded)', describeThresholds(thresholds));
    this.changed();
  }

  /** The session archive refused a write: say so on the timeline. */
  recordingStopped(reason: string): void {
    this.recordingError = reason;
    this.log(this.now(), 'SYS', 'WARN', 'session recording stopped', reason);
    this.changed();
  }

  /** True when a replay runs on the thresholds it was recorded with. */
  get recordedThresholds(): boolean {
    return this.replayOf?.thresholds !== undefined;
  }
}
