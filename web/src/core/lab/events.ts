/**
 * HARDWARE DOG / LAB EVENTS
 *
 * The contract between the lab tools (Flipper Lab, Bluetooth Lab, markers)
 * and everything that watches them: the companion TV, the operation log,
 * the lab session recorder. A tool says what happened; it never says how
 * a watcher should look. The companion observes the tools, it never
 * drives them.
 *
 * Every event keeps its provenance: which tool, which link, real hardware
 * or a demo or a replay, what was measured, decoded, estimated or unknown.
 * Nothing here invents a progress percentage: a progress with no total is
 * indeterminate and says so.
 *
 * Two clocks: `at` is this computer's wall clock (Date.now), for people
 * and exports; `mono` is its monotonic clock (performance.now), for
 * durations. A device's own time, when it gives one, is `sourceTime`; it
 * is never assumed to agree with ours.
 */

export const LAB_SOURCES = ['FLIPPER', 'BLE', 'CAMERA', 'USER', 'LAB'] as const;
export type LabSource = (typeof LAB_SOURCES)[number];

export type LabSeverity = 'INFO' | 'PASS' | 'WARN' | 'FAIL';

/** Where a value comes from. ESTIMATED is never shown as MEASURED. */
export type Provenance = 'MEASURED' | 'DECODED' | 'ESTIMATED' | 'UNKNOWN';

/** Real hardware, the demo device, or a recording played back. */
export type LabOrigin = 'PHYSICAL' | 'SIMULATED' | 'REPLAY';

/** What a long operation is doing, as far as the companion is concerned. */
export type OpKind = 'connect' | 'search' | 'read' | 'transfer' | 'write';

/** An action a message offers. It runs through the app's command registry. */
export interface LabAction {
  label: string;
  /** Command id in the registry, e.g. `flipper.connect`, `lab.log`. */
  command: string;
  args?: Record<string, string>;
}

export interface Measure {
  name: string;
  value: number;
  unit: string;
  provenance: Provenance;
}

export interface Decoded {
  decoder: string;
  version: string;
  fields: Record<string, string | number | boolean | null>;
}

/**
 * Event types:
 *   link.state   a tool's link: params.state = HardwareState
 *   op.start     an operation begins: op, params.kind = OpKind
 *   op.progress  progress: done / total (null total = indeterminate)
 *   op.end       an operation ends: severity PASS / WARN / FAIL, code if any
 *   observe      an observation (a BLE advertisement, a file read): raw, decoded, measures
 *   marker       an operator marker on the timeline (button pressed, cable plugged)
 *   note         free text from the operator
 *   info         anything else a tool wants in the log
 */
export type LabEventType = 'link.state' | 'op.start' | 'op.progress' | 'op.end' | 'observe' | 'marker' | 'note' | 'info';

export interface LabEvent {
  /** Order of reception, unique in a bus (and in a session). */
  seq: number;
  /** Wall clock at reception, ms since 1970. */
  at: number;
  /** Monotonic clock at reception, ms (performance.now): durations only. */
  mono: number;
  source: LabSource;
  /** The tool inside the source: `flipper.files`, `ble.scan`, `ble.gatt`... */
  tool: string;
  type: LabEventType;
  /** Operation id: every op.* event of one operation carries the same one. */
  op?: string;
  severity: LabSeverity;
  message: string;
  params?: Record<string, string | number | boolean | null>;
  /** Known progress: done of total. total null: indeterminate, no percentage. */
  progress?: { done: number; total: number | null; unit: string };
  /** The error code exactly as the device or the API gave it. Never made up. */
  code?: string;
  actions?: LabAction[];
  origin: LabOrigin;
  /** The device in its context (observed id, port label). Not a global identity. */
  device?: string;
  /** The bytes as received, base64. */
  raw?: string;
  decoded?: Decoded;
  measures?: Measure[];
  /** The device's own timestamp, when it gives one (its clock, its unit in params). */
  sourceTime?: number;
}

export type LabEventInput = Omit<LabEvent, 'seq' | 'at' | 'mono'> & { at?: number; mono?: number };

export interface LabClock {
  now(): number;
  mono(): number;
}

export const systemClock: LabClock = {
  now: () => Date.now(),
  mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

type Listener = (event: LabEvent) => void;

/**
 * One bus for the whole interface: tools publish, watchers subscribe.
 * It keeps the latest events in a bounded ring for the log; what falls off
 * is counted, never silently forgotten.
 */
export class LabBus {
  private listeners = new Set<Listener>();
  private ring: LabEvent[] = [];
  private nextSeq = 1;
  /** Events that fell off the ring (still delivered to subscribers). */
  dropped = 0;

  constructor(
    readonly clock: LabClock = systemClock,
    private readonly capacity = 5000,
  ) {}

  emit(input: LabEventInput): LabEvent {
    const event: LabEvent = { ...input, seq: this.nextSeq++, at: input.at ?? this.clock.now(), mono: input.mono ?? this.clock.mono() };
    this.ring.push(event);
    if (this.ring.length > this.capacity) {
      const over = this.ring.length - this.capacity;
      this.ring.splice(0, over);
      this.dropped += over;
    }
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // A broken watcher must never break a tool, nor the other watchers.
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The latest events, oldest first, optionally filtered. */
  recent(filter?: (e: LabEvent) => boolean): readonly LabEvent[] {
    return filter ? this.ring.filter(filter) : this.ring;
  }

  get size(): number {
    return this.ring.length;
  }
}

let opCounter = 0;
/** A fresh operation id: `flipper.read-17`. */
export const newOp = (tool: string): string => `${tool}-${++opCounter}`;

/** Base64 of bytes, without btoa's latin-1 trap. */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The message of anything thrown, and its code when the thrower gave one. */
export function errorInfo(e: unknown): { message: string; code?: string } {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    // DOMException names (NotFoundError, SecurityError...) are real codes from the browser.
    const name = e.name && e.name !== 'Error' ? e.name : undefined;
    const c = typeof code === 'string' ? code : name;
    return c ? { message: e.message, code: c } : { message: e.message };
  }
  return { message: String(e) };
}

/** An instant operation (a report written, a file saved), said as one op from start to end. */
export function instantOp(bus: LabBus, e: { source: LabSource; tool: string; message: string; kind: OpKind; origin: LabOrigin; params?: LabEvent['params'] }): void {
  const op = newOp(e.tool);
  bus.emit({ source: e.source, tool: e.tool, type: 'op.start', op, severity: 'INFO', message: e.message, origin: e.origin, params: { kind: e.kind } });
  bus.emit({ source: e.source, tool: e.tool, type: 'op.end', op, severity: 'PASS', message: e.message, origin: e.origin, ...(e.params ? { params: e.params } : {}) });
}
