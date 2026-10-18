/**
 * HARDWARE DOG / COMPANION ENGINE
 *
 * The state behind the retro TV: one companion for the whole interface.
 * It watches the lab bus and keeps apart what are different facts:
 *
 *   TV          OFF, BOOTING, ON, SHUTTING_DOWN   what the TV itself is doing
 *   FOCUS       the section on screen, its source what the person looks at,
 *               and its profile                   and who lives in the TV
 *   HARDWARE    UNKNOWN, ABSENT, CONNECTING,      what the focused source's
 *               CONNECTED, DISCONNECTED           link is
 *   OPERATION   IDLE, SEARCH, READ, TRANSFER,     what the tools are doing
 *               SUCCESS, WARNING, ERROR,
 *               CANCELLED, UNAVAILABLE
 *   SCENE       what the screen plays and says    derived from the above
 *
 * Two profiles: Hardware Dog (the turquoise TV, the robot dog) everywhere,
 * Flipper Lab (the orange TV, its companion) in Flipper Lab. Changing
 * section changes the focus and the profile: nothing reconnects, no
 * operation is lost, the CRT does not start again.
 *
 * POWER only switches the TV: it never touches a device, never stops a
 * scan or a recording. The engine observes the tools; it never runs them.
 * Actions a message offers are command ids, run by the app's command
 * registry.
 *
 * The tool looked at comes first: its operations are shown before the
 * others, its results play on screen; a failure elsewhere is said in a
 * message that offers to open that tool, without taking the screen. A
 * late answer (the end of an operation a newer one of the same tool
 * replaced, an end said twice) changes nothing on screen. A scene stays
 * at least TIMING.minScene before the next one, so a burst of events
 * never makes the screen flicker.
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
export type OpState = 'IDLE' | 'SEARCH' | 'READ' | 'TRANSFER' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CANCELLED' | 'UNAVAILABLE';

/** Who lives in the TV: Hardware Dog's dog, or Flipper Lab's companion. */
export type CompanionProfile = 'hwdog' | 'flipper';

/** What the person looks at. */
export interface Focus {
  /** The section on screen (the app's screen id: STATUS, BLE, FLIPPER...). */
  section: string;
  /** The source whose link and operations come first; null: none in particular. */
  source: LabSource | null;
  profile: CompanionProfile;
  /** Why this section's tool cannot work here (no Web Serial in this browser...), or null. */
  unavailable: string | null;
}
/** What the dial puts on the screen. It never starts anything on the hardware. */
export const DIAL_MODES = ['COMPANION', 'TOOL', 'EVENT'] as const;
export type DialMode = (typeof DIAL_MODES)[number];

/** The animation the screen should play now. `none`: the screen is dark. */
export type Anim = 'none' | 'idle' | 'wait' | 'greet' | 'connect' | 'search' | 'read' | 'transfer' | 'success' | 'warning' | 'error' | 'disconnect' | 'permission' | 'cancel' | 'unavailable';

/** Where the companion is, for a scene at rest: the section's decor, and whether a joke may play. */
export interface Stage {
  section: string;
  /** Nothing running, nothing serious said: a small scene or a value may show. */
  calm: boolean;
  /** The exact code of the result on screen (an error, a warning), or null: a timeout is not drawn like a refusal. */
  code: string | null;
}

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
  /** The tool is put down, then rest. */
  cancel: 1400,
  /** A limitation said (no Web Serial here...): then the section's own state. */
  unavailable: 8000,
  /** A scene stays at least this long before the next one: no flicker under bursts. */
  minScene: 900,
  /** The EVENT view refreshes at most this often under a burst of observations. */
  eventThrottle: 250,
} as const;

/** Codes that say a function does not exist here (browser, platform), not that it failed. */
export const UNAVAILABLE_CODES: readonly string[] = ['SERIAL_UNSUPPORTED', 'BLE_UNSUPPORTED', 'USB_UNSUPPORTED', 'FEATURE_UNAVAILABLE'];

/** The person cancelled (a chooser closed, STOP during a start): not an error. */
export function isCancel(e: Pick<LabEvent, 'code' | 'severity' | 'params'>): boolean {
  if (e.params?.['outcome'] === 'cancelled') return true;
  if (e.code === 'CANCELLED' || e.code === 'ABORTED' || e.code === 'AbortError') return true;
  return e.code === 'NotFoundError' && e.severity === 'INFO';
}

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
  /** The first focus's source: whose link is the HARDWARE state until the app says where the person is. */
  watch?: LabSource;
  /** The first focus's profile. */
  profile?: CompanionProfile;
}

interface ActiveOp {
  id: string;
  kind: OpKind;
  source: LabSource;
  tool: string;
  /** Bus order of its start: a newer operation of the same tool makes an older one's late end stale. */
  seq: number;
  /** Waiting for the person (a chooser, a permission prompt). */
  waiting: boolean;
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
  private readonly linkInfo = new Map<LabSource, { state: HardwareState; detail: string; at: number }>();
  /** Real, demo or replay: the origin of each source's latest event. */
  private readonly origins = new Map<LabSource, LabEvent['origin']>();
  private readonly active = new Map<string, ActiveOp>();
  /** Operations already ended: an end said twice is said once. */
  private readonly ended = new Set<string>();
  focus: Focus;

  private listeners = new Set<() => void>();
  private rev = 0;
  private powerTimer: number | null = null;
  private greetTimer: number | null = null;
  private holdTimer: number | null = null;
  private disconnectTimer: number | null = null;
  private eventTimer: number | null = null;
  private sceneTimer: number | null = null;
  private pendingEvent: LabEvent | null = null;
  private recentDisconnect = false;
  private readonly unsubscribe: () => void;
  private readonly scheduler: Scheduler;
  private readonly mono: () => number;
  private readonly reduced: () => boolean;
  lang: Lang;

  constructor(bus: LabBus, options: CompanionOptions = {}) {
    this.scheduler = options.scheduler ?? browserScheduler;
    this.mono = options.mono ?? (() => bus.clock.mono());
    this.reduced = options.reducedMotion ?? (() => false);
    this.lang = options.lang ?? 'en';
    this.focus = { section: 'FLIPPER', source: options.watch ?? 'FLIPPER', profile: options.profile ?? 'flipper', unavailable: null };
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

  // ---------------------------------------------------------------- focus

  /** The source whose link the HARDWARE state follows: the focused one. */
  get watch(): LabSource | null {
    return this.focus.source;
  }

  get profile(): CompanionProfile {
    return this.focus.profile;
  }

  /**
   * The person moved to another section: what comes first, who lives in
   * the TV. Nothing else changes: no link, no operation, no power state.
   */
  setFocus(patch: Partial<Focus>): void {
    const next = { ...this.focus, ...patch };
    const f = this.focus;
    if (next.section === f.section && next.source === f.source && next.profile === f.profile && next.unavailable === f.unavailable) return;
    const sourceChanged = next.source !== f.source;
    this.focus = next;
    if (sourceChanged) {
      const info = next.source ? this.linkInfo.get(next.source) : undefined;
      this.hardware = info?.state ?? 'UNKNOWN';
      this.hardwareDetail = info?.detail ?? '';
      this.hardwareAt = info?.at ?? this.mono();
      this.recentDisconnect = false;
      // a result of the tool left behind is not this tool's
      this.clearHold();
      this.recompute();
    }
    this.changed();
  }

  /** Whether events of a source are the focused tool's: they may take the screen. */
  private focused(source: LabSource): boolean {
    return this.focus.source === null || source === this.focus.source || source === 'LAB' || source === 'USER';
  }

  /** DEMO, REPLAY, or null (real hardware): what the focused tool shows. */
  get badge(): 'DEMO' | 'REPLAY' | null {
    const o = this.focus.source ? this.origins.get(this.focus.source) : undefined;
    return o === 'SIMULATED' ? 'DEMO' : o === 'REPLAY' ? 'REPLAY' : null;
  }

  // ------------------------------------------------------------- watching

  private observe(e: LabEvent): void {
    if (e.source !== 'USER') this.origins.set(e.source, e.origin);
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
    let quiet = false;
    if (e.type === 'link.state') this.onLink(e);
    else if (e.type === 'op.start' && e.op) this.onOpStart(e);
    else if (e.type === 'op.progress' && e.op) {
      const op = this.active.get(e.op);
      if (op) {
        if (e.progress) op.progress = e.progress;
        if (e.params && 'wait' in e.params) op.waiting = e.params['wait'] === 'user';
        this.recompute();
      }
    } else if (e.type === 'op.end' && e.op) quiet = !this.onOpEnd(e);
    // A late or repeated end changes nothing on screen: the log keeps it.
    if (quiet) return this.changed();
    this.lastEvent = e;
    const s = suggest(e, this.lang);
    if (s) {
      // A recording played back offers nothing that would reach a device.
      if (e.origin === 'REPLAY' && s.actions) s.actions = s.actions.filter((a) => a.command === 'lab.log');
      // Elsewhere than the tool looked at: said, with the way to that tool.
      else if (!this.focused(e.source) && (s.severity === 'FAIL' || s.severity === 'WARN'))
        s.actions = [...(s.actions ?? []), { label: this.lang === 'fr' ? 'Ouvrir l’outil' : 'Open the tool', command: 'lab.open', args: { source: e.source } }];
      this.messages.push(s, this.mono());
    }
    this.changed();
  }

  private onLink(e: LabEvent): void {
    const state = e.params?.['state'];
    if (!isHardware(state)) return;
    this.links.set(e.source, e.message);
    this.linkInfo.set(e.source, { state, detail: e.message, at: this.mono() });
    if (e.source !== this.watch) {
      // Another source's link dropped: its operations end on screen all the same.
      if (state === 'DISCONNECTED' || state === 'ABSENT') {
        for (const [id, op] of this.active) if (op.source === e.source) this.active.delete(id);
        this.recompute();
      }
      return;
    }
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
    if (!isOpKind(kind) || this.active.has(e.op!) || this.ended.has(e.op!)) return;
    const topic = e.params?.['topic'];
    this.active.set(e.op!, {
      id: e.op!,
      kind,
      source: e.source,
      tool: e.tool,
      seq: e.seq,
      waiting: e.params?.['wait'] === 'user',
      topic: typeof topic === 'string' ? topic : null,
      message: e.message,
      progress: e.progress ?? null,
    });
    // A new operation of the tool looked at clears an old result: the screen shows what is happening now.
    if (this.focused(e.source)) this.clearHold();
    this.recompute();
  }

  /** An operation ended. false: a late or repeated end, nothing to show. */
  private onOpEnd(e: LabEvent): boolean {
    if (this.ended.has(e.op!)) return false;
    const ended = this.active.get(e.op!);
    if (!ended) return true; // never seen starting: said in a message, nothing on screen to end
    this.active.delete(e.op!);
    this.ended.add(e.op!);
    if (this.ended.size > 500) this.ended.delete(this.ended.values().next().value!);
    // A newer operation of the same tool runs: this answer is about the past.
    if ([...this.active.values()].some((o) => o.tool === ended.tool && o.seq > ended.seq)) {
      this.recompute();
      return false;
    }
    if (!this.focused(ended.source)) {
      // Not the tool looked at: no scene of its own; a failure is said in a message.
      this.recompute();
      return true;
    }
    this.lastResult = { tool: ended.tool, topic: ended.topic };
    this.lastCode = e.code ?? null;
    this.clearHold();
    if (isCancel(e)) this.hold('CANCELLED', TIMING.cancel);
    else if (e.params?.['outcome'] === 'stopped') this.recompute();
    else if (e.code && UNAVAILABLE_CODES.includes(e.code)) this.hold('UNAVAILABLE', TIMING.unavailable);
    else if (e.severity === 'FAIL') this.hold('ERROR', TIMING.error);
    else if (e.severity === 'WARN') this.hold('WARNING', TIMING.warning);
    else if (this.active.size === 0) this.hold('SUCCESS', TIMING.success);
    else this.recompute();
    return true;
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
    const best = this.operations[0];
    this.op = best ? OP_STATE[best.kind] : 'IDLE';
  }

  /** The operation that ended last: what a result on screen is about, and its code. */
  private lastResult: Subject | null = null;
  private lastCode: string | null = null;

  /**
   * What the animation is about: the tool and the kind of file of the
   * operation shown (running, or just ended). The screen picks its scene
   * from it (an IR file read is not shown like an NFC one); null: nothing.
   */
  get subject(): Subject | null {
    if (this.op === 'SUCCESS' || this.op === 'ERROR' || this.op === 'WARNING' || this.op === 'CANCELLED' || this.op === 'UNAVAILABLE') return this.lastResult;
    const top = this.operations[0];
    return top ? { tool: top.tool, topic: top.topic } : null;
  }

  /** The operations running now: the focused tool's first, then the most significant, then the newest. */
  get operations(): readonly ActiveOp[] {
    return [...this.active.values()].sort((a, b) => Number(this.focused(b.source)) - Number(this.focused(a.source)) || OP_RANK[b.kind] - OP_RANK[a.kind] || b.seq - a.seq);
  }

  /** The section's decor at rest, and whether a small scene may play. */
  get stage(): Stage {
    const m = this.messages.current;
    return {
      section: this.focus.section,
      calm: this.active.size === 0 && (!m || m.severity === 'INFO' || m.severity === 'PASS'),
      code: this.op === 'ERROR' || this.op === 'WARNING' ? this.lastCode : null,
    };
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
    if (this.op === 'UNAVAILABLE') return 'unavailable';
    if (this.recentDisconnect) return 'disconnect';
    if (this.op === 'CANCELLED') return 'cancel';
    // It waits for the person: it never pretends to work meanwhile.
    if (this.operations[0]?.waiting) return 'permission';
    if (this.op === 'TRANSFER') return 'transfer';
    if (this.op === 'READ') return 'read';
    if (this.op === 'SEARCH') return 'search';
    if (this.hardware === 'CONNECTING' || [...this.active.values()].some((o) => o.kind === 'connect')) return 'connect';
    if (this.op === 'SUCCESS') return 'success';
    if (this.greeting) return 'greet';
    // A section whose tool cannot work here: said, no activity pretended.
    if (this.focus.unavailable) return 'unavailable';
    // Nothing to do with a link up: it keeps busy. No link: it sits and dozes.
    return this.hardware === 'CONNECTED' ? 'idle' : 'wait';
  }

  /**
   * What the screen plays: the animation, held at least TIMING.minScene
   * before the next one (power on and off excepted). `animSince` is when
   * it started.
   */
  get scene(): Anim {
    return this.lastAnim;
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
      const now = this.mono();
      const wait = TIMING.minScene - (now - this.animSince);
      if (a === 'none' || this.lastAnim === 'none' || wait <= 0) {
        this.lastAnim = a;
        this.animSince = now;
        if (this.sceneTimer !== null) this.scheduler.clear(this.sceneTimer);
        this.sceneTimer = null;
      } else if (this.sceneTimer === null) {
        this.sceneTimer = this.scheduler.set(() => {
          this.sceneTimer = null;
          this.changed();
        }, wait);
      }
    }
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  dispose(): void {
    this.unsubscribe();
    for (const t of [this.powerTimer, this.greetTimer, this.holdTimer, this.disconnectTimer, this.eventTimer, this.sceneTimer]) if (t !== null) this.scheduler.clear(t);
    this.messages.dispose();
    this.listeners.clear();
  }

  /** The message on screen, if any. */
  get message(): CompanionMessage | null {
    return this.messages.current;
  }
}
