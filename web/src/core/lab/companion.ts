/**
 * HARDWARE DOG / COMPANION ENGINE
 *
 * The state behind the retro TV. It watches the lab bus and keeps three
 * states apart, because they are three different facts:
 *
 *   TV          OFF, BOOTING, ON, SHUTTING_DOWN   what the TV itself is doing
 *   HARDWARE    UNKNOWN, ABSENT, CONNECTING,      what the watched link is
 *               CONNECTED, DISCONNECTED
 *   OPERATION   IDLE, SEARCH, READ, TRANSFER,     what the tools are doing
 *               SUCCESS, WARNING, ERROR
 *
 * POWER only switches the TV: it never touches the Flipper, never stops a
 * capture. The engine observes the tools; it never runs them. Actions a
 * message offers are command ids, run by the app's command registry.
 *
 * No animation outlives the fact it shows: an operation that failed stops
 * its working animation at once; a link that drops ends every operation
 * of that link on screen.
 *
 * Timers come from an injectable scheduler, so every transition is tested
 * without waiting (web/test/companion.test.ts).
 */

import type { LabBus, LabEvent, LabSource, OpKind } from './events';
import { MessageQueue, type CompanionMessage, type Scheduler } from './messages';
import { suggest, type Lang } from './rules';

export type TvPower = 'OFF' | 'BOOTING' | 'ON' | 'SHUTTING_DOWN';
export type HardwareState = 'UNKNOWN' | 'ABSENT' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';
export type OpState = 'IDLE' | 'SEARCH' | 'READ' | 'TRANSFER' | 'SUCCESS' | 'WARNING' | 'ERROR';
/** What the dial puts on the screen. It never starts anything on the hardware. */
export const DIAL_MODES = ['COMPANION', 'TOOL', 'EVENT'] as const;
export type DialMode = (typeof DIAL_MODES)[number];

/** The animation the screen should play now. `none`: the screen is dark. */
export type Anim = 'none' | 'idle' | 'wait' | 'greet' | 'connect' | 'search' | 'read' | 'transfer' | 'success' | 'warning' | 'error' | 'disconnect';

/** What an animation is about: the tool, and the kind of file when known. */
export interface Subject {
  tool: string;
  topic: string | null;
}

export const HARDWARE_STATES: readonly HardwareState[] = ['UNKNOWN', 'ABSENT', 'CONNECTING', 'CONNECTED', 'DISCONNECTED'];

/** Durations, ms. The power-on sequence is ~2 s; reduced motion cuts it to a fade. */
export const TIMING = {
  boot: 2000,
  bootReduced: 250,
  off: 650,
  offReduced: 150,
  greet: 1800,
  success: 1500,
  warning: 4000,
  error: 9000,
  disconnect: 4000,
  /** The EVENT view refreshes at most this often under a burst of observations. */
  eventThrottle: 250,
} as const;

const OP_RANK: Record<OpKind, number> = { connect: 0, search: 1, read: 2, transfer: 3, write: 3 };
const OP_STATE: Record<OpKind, OpState> = { connect: 'IDLE', search: 'SEARCH', read: 'READ', transfer: 'TRANSFER', write: 'TRANSFER' };

const isOpKind = (v: unknown): v is OpKind => typeof v === 'string' && v in OP_RANK;
const isHardware = (v: unknown): v is HardwareState => typeof v === 'string' && (HARDWARE_STATES as readonly string[]).includes(v);

export interface CompanionOptions {
  scheduler?: Scheduler;
  /** Monotonic clock, ms. */
  mono?: () => number;
  reducedMotion?: () => boolean;
  lang?: Lang;
  /** The source whose link is the HARDWARE state (Flipper for the Flipper TV). */
  watch?: LabSource;
}

interface ActiveOp {
  kind: OpKind;
  source: LabSource;
  tool: string;
  /** What it is about (a file kind: ir, subghz, nfc...), when the tool says. */
  topic: string | null;
  message: string;
  progress: LabEvent['progress'] | null;
}

export const browserScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
};

export class Companion {
  power: TvPower = 'OFF';
  /** Where the TV is heading: a press during a transition is kept, not lost. */
  private wantOn = false;
  /** Monotonic time the current power transition started, and how long it lasts. */
  transition: { from: number; ms: number } | null = null;

  hardware: HardwareState = 'UNKNOWN';
  hardwareDetail = '';
  private hardwareAt = 0;
  op: OpState = 'IDLE';
  dial: DialMode = 'COMPANION';
  greeting = false;

  readonly messages: MessageQueue;
  /** The latest event worth showing (EVENT view). */
  lastEvent: LabEvent | null = null;
  /** The latest link line per source (TOOL view). */
  readonly links = new Map<LabSource, string>();
  private readonly active = new Map<string, ActiveOp>();

  private listeners = new Set<() => void>();
  private rev = 0;
  private powerTimer: number | null = null;
  private greetTimer: number | null = null;
  private holdTimer: number | null = null;
  private disconnectTimer: number | null = null;
  private eventTimer: number | null = null;
  private pendingEvent: LabEvent | null = null;
  private recentDisconnect = false;
  private readonly unsubscribe: () => void;
  private readonly scheduler: Scheduler;
  private readonly mono: () => number;
  private readonly reduced: () => boolean;
  readonly watch: LabSource;
  lang: Lang;

  constructor(bus: LabBus, options: CompanionOptions = {}) {
    this.scheduler = options.scheduler ?? browserScheduler;
    this.mono = options.mono ?? (() => bus.clock.mono());
    this.reduced = options.reducedMotion ?? (() => false);
    this.lang = options.lang ?? 'en';
    this.watch = options.watch ?? 'FLIPPER';
    this.messages = new MessageQueue(this.scheduler, () => this.changed());
    this.unsubscribe = bus.subscribe((e) => this.observe(e));
  }

  // ---------------------------------------------------------------- power

  /** The POWER button. Clicks during a transition set where the TV ends up. */
  pressPower(): void {
    // Every click flips where the TV is heading. Mid-transition, the current
    // sequence finishes (the CRT never jumps), then the last click decides.
    this.wantOn = !this.wantOn;
    if (this.power === 'BOOTING' || this.power === 'SHUTTING_DOWN') this.changed();
    else this.step();
  }

  /** Set the TV on or off (restoring a saved state, a detached window). */
  setPower(on: boolean): void {
    this.wantOn = on;
    if (this.power === 'ON' || this.power === 'OFF') this.step();
  }

  get isOn(): boolean {
    return this.power === 'ON';
  }

  /** Where the TV will be once the current transition ends. */
  get heading(): boolean {
    return this.wantOn;
  }

  private step(): void {
    if (this.wantOn && this.power === 'OFF') this.startTransition('BOOTING', this.reduced() ? TIMING.bootReduced : TIMING.boot);
    else if (!this.wantOn && this.power === 'ON') this.startTransition('SHUTTING_DOWN', this.reduced() ? TIMING.offReduced : TIMING.off);
  }

  private startTransition(to: 'BOOTING' | 'SHUTTING_DOWN', ms: number): void {
    this.power = to;
    this.transition = { from: this.mono(), ms };
    this.clearGreeting();
    this.powerTimer = this.scheduler.set(() => {
      this.powerTimer = null;
      this.transition = null;
      if (to === 'BOOTING') {
        this.power = 'ON';
        this.greet();
      } else {
        this.power = 'OFF';
      }
      this.changed();
      this.step();
    }, ms);
    this.changed();
  }

  private greet(): void {
    this.greeting = true;
    this.greetTimer = this.scheduler.set(() => {
      this.greetTimer = null;
      this.greeting = false;
      this.changed();
    }, TIMING.greet);
  }

  private clearGreeting(): void {
    if (this.greetTimer !== null) this.scheduler.clear(this.greetTimer);
    this.greetTimer = null;
    this.greeting = false;
  }

  // ----------------------------------------------------------------- dial

  /** One notch of the dial: the next view. Nothing is sent to any device. */
  turnDial(direction: 1 | -1 = 1): void {
    const i = DIAL_MODES.indexOf(this.dial);
    this.dial = DIAL_MODES[(i + direction + DIAL_MODES.length) % DIAL_MODES.length]!;
    this.changed();
  }

  setDial(mode: DialMode): void {
    if (mode === this.dial) return;
    this.dial = mode;
    this.changed();
  }

  // ------------------------------------------------------------- watching

  private observe(e: LabEvent): void {
    if (e.type === 'observe') {
      // Observations come in bursts (a BLE scan): the EVENT view samples them.
      this.pendingEvent = e;
      if (this.eventTimer === null) {
        this.eventTimer = this.scheduler.set(() => {
          this.eventTimer = null;
          if (this.pendingEvent) this.lastEvent = this.pendingEvent;
          this.pendingEvent = null;
          this.changed();
        }, TIMING.eventThrottle);
      }
      return;
    }
    this.lastEvent = e;
    if (e.type === 'link.state') this.onLink(e);
    else if (e.type === 'op.start' && e.op) this.onOpStart(e);
    else if (e.type === 'op.progress' && e.op) {
      const op = this.active.get(e.op);
      if (op) op.progress = e.progress ?? null;
    } else if (e.type === 'op.end' && e.op) this.onOpEnd(e);
    const s = suggest(e, this.lang);
    if (s) this.messages.push(s, this.mono());
    this.changed();
  }

  private onLink(e: LabEvent): void {
    const state = e.params?.['state'];
    if (!isHardware(state)) return;
    this.links.set(e.source, e.message);
    if (e.source !== this.watch) return;
    const was = this.hardware;
    this.hardware = state;
    this.hardwareDetail = e.message;
    this.hardwareAt = this.mono();
    if (state === 'DISCONNECTED' || state === 'ABSENT') {
      // Nothing of that link is still running: its operations end on screen now.
      for (const [id, op] of this.active) if (op.source === e.source) this.active.delete(id);
      this.recompute();
      if (state === 'DISCONNECTED' && was !== 'DISCONNECTED') {
        this.recentDisconnect = true;
        if (this.disconnectTimer !== null) this.scheduler.clear(this.disconnectTimer);
        this.disconnectTimer = this.scheduler.set(() => {
          this.disconnectTimer = null;
          this.recentDisconnect = false;
          this.changed();
        }, TIMING.disconnect);
      }
    } else {
      this.recentDisconnect = false;
      // The link is back: "connection lost" no longer holds on screen.
      if (state === 'CONNECTED') this.messages.drop((m) => m.key.startsWith(`${e.source}:link.lost`) || m.key.startsWith(`${e.source}:ble.gattlost`));
    }
  }

  private onOpStart(e: LabEvent): void {
    const kind = e.params?.['kind'];
    if (!isOpKind(kind)) return;
    const topic = e.params?.['topic'];
    this.active.set(e.op!, { kind, source: e.source, tool: e.tool, topic: typeof topic === 'string' ? topic : null, message: e.message, progress: e.progress ?? null });
    // A new operation clears an old result: the screen shows what is happening now.
    this.clearHold();
    this.recompute();
  }

  private onOpEnd(e: LabEvent): void {
    const ended = this.active.get(e.op!);
    if (!ended || !this.active.delete(e.op!)) return;
    this.lastResult = { tool: ended.tool, topic: ended.topic };
    this.clearHold();
    if (e.severity === 'FAIL') this.hold('ERROR', TIMING.error);
    else if (e.severity === 'WARN') this.hold('WARNING', TIMING.warning);
    else if (this.active.size === 0) this.hold('SUCCESS', TIMING.success);
    else this.recompute();
  }

  private hold(state: OpState, ms: number): void {
    this.op = state;
    this.holdTimer = this.scheduler.set(() => {
      this.holdTimer = null;
      this.recompute();
      this.changed();
    }, ms);
  }

  private clearHold(): void {
    if (this.holdTimer !== null) this.scheduler.clear(this.holdTimer);
    this.holdTimer = null;
  }

  private recompute(): void {
    if (this.holdTimer !== null) return;
    let best: ActiveOp | null = null;
    for (const op of this.active.values()) if (!best || OP_RANK[op.kind] > OP_RANK[best.kind]) best = op;
    this.op = best ? OP_STATE[best.kind] : 'IDLE';
  }

  /** The operation that ended last: what a result on screen is about. */
  private lastResult: Subject | null = null;

  /**
   * What the animation is about: the tool and the kind of file of the
   * operation shown (running, or just ended). The screen picks its scene
   * from it (an IR file read is not shown like an NFC one); null: nothing.
   */
  get subject(): Subject | null {
    if (this.op === 'SUCCESS' || this.op === 'ERROR' || this.op === 'WARNING') return this.lastResult;
    const top = this.operations[0];
    return top ? { tool: top.tool, topic: top.topic } : null;
  }

  /** The operations running now, most significant first. */
  get operations(): readonly ActiveOp[] {
    return [...this.active.values()].sort((a, b) => OP_RANK[b.kind] - OP_RANK[a.kind]);
  }

  /** How long the hardware has been in its current state, ms. */
  hardwareFor(now = this.mono()): number {
    return now - this.hardwareAt;
  }

  /** What the screen plays now, from the three states. Results beat work, work beats idle. */
  get anim(): Anim {
    if (this.power !== 'ON') return 'none';
    if (this.op === 'ERROR') return 'error';
    if (this.op === 'WARNING') return 'warning';
    if (this.recentDisconnect) return 'disconnect';
    if (this.op === 'TRANSFER') return 'transfer';
    if (this.op === 'READ') return 'read';
    if (this.op === 'SEARCH') return 'search';
    if (this.hardware === 'CONNECTING' || [...this.active.values()].some((o) => o.kind === 'connect')) return 'connect';
    if (this.op === 'SUCCESS') return 'success';
    if (this.greeting) return 'greet';
    // Nothing to do with a link up: it keeps busy. No link: it sits and dozes.
    return this.hardware === 'CONNECTED' ? 'idle' : 'wait';
  }

  // ------------------------------------------------------------ plumbing

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get revision(): number {
    return this.rev;
  }

  /** The animation playing, and since when (monotonic): a remounted screen resumes it. */
  private lastAnim: Anim = 'none';
  animSince = 0;

  private changed(): void {
    const a = this.anim;
    if (a !== this.lastAnim) {
      this.lastAnim = a;
      this.animSince = this.mono();
    }
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  dispose(): void {
    this.unsubscribe();
    for (const t of [this.powerTimer, this.greetTimer, this.holdTimer, this.disconnectTimer, this.eventTimer]) if (t !== null) this.scheduler.clear(t);
    this.messages.dispose();
    this.listeners.clear();
  }

  /** The message on screen, if any. */
  get message(): CompanionMessage | null {
    return this.messages.current;
  }
}
