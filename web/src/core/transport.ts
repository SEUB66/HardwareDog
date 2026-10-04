import type { DeviceFrame, HostCommand } from './protocol';
import { LineSplitter, decodeFrame } from './protocol';
import type { Origin, Thresholds, TransportKind } from './types';

/**
 * Receives everything a transport produces. In a pack (several Dogs) every
 * call names the Dog it comes from (D1, D2...); a single device names none.
 */
export interface TransportSink {
  frame(frame: DeviceFrame, dog?: string): void;
  /** A line that could not be decoded, or a link-level problem. */
  error(message: string, raw?: string, dog?: string): void;
  /** The link went away. Not called after a deliberate close(). */
  lost(reason: string, dog?: string): void;
  /** An operator note carried by the source (recordings only). */
  annotate?(text: string): void;
  /** Thresholds changed by the operator at this point (recordings only). */
  configure?(thresholds: Thresholds): void;
  /** A command the host sent at this point (recordings only: never executed again). */
  sent?(cmd: HostCommand, dog?: string): void;
  /** A finite source (a recording) has delivered everything. */
  ended?(): void;
}

/**
 * A byte link to a Hardware Dog. The System does not care whether the
 * other end is real hardware or the simulator: both speak the same
 * protocol, and both go through the same decoder.
 */
export interface Transport {
  readonly kind: TransportKind;
  /** Human-readable description of the other end, e.g. "USB CDC 303A:1001". */
  readonly label: string;
  /** Real hardware or the simulator, as far as this transport knows. */
  readonly origin: Origin;
  /** A pack: the Dogs, in their fixed order. Absent: one device. */
  readonly dogs?: readonly string[];
  open(sink: TransportSink): Promise<void>;
  /** In a pack, `dog` says which Dog the command is for. */
  send(cmd: HostCommand, dog?: string): void;
  close(): Promise<void>;
}

/**
 * Several Dogs as one transport: each member is a full link of its own
 * (Web Serial, dogd, simulator), and every frame is tagged with its Dog.
 * Putting them on one timeline is the System's job (core/pack.ts), the
 * same live and in a replay.
 */
export class PackTransport implements Transport {
  readonly kind = 'PACK' as const;
  readonly origin: Origin;
  readonly dogs: readonly string[];

  constructor(private readonly members: readonly { dog: string; link: Transport }[]) {
    if (members.length < 2) throw new Error('a pack is two Dogs or more');
    const ids = members.map((m) => m.dog);
    if (new Set(ids).size !== ids.length) throw new Error('every Dog of a pack needs its own id');
    this.dogs = ids;
    if (members.some((m) => m.link.kind === 'PACK' || m.link.kind === 'REPLAY')) throw new Error('a Dog of a pack is one live link');
    // Evidence is physical only if every Dog is real hardware.
    this.origin = members.every((m) => m.link.origin === 'PHYSICAL') ? 'PHYSICAL' : 'SIMULATED';
  }

  /** Each Dog's link, as a recording header lists it. */
  get links(): { dog: string; kind: Exclude<TransportKind, 'REPLAY' | 'PACK'>; label: string; origin: Origin }[] {
    return this.members.map((m) => ({ dog: m.dog, kind: m.link.kind as Exclude<TransportKind, 'REPLAY' | 'PACK'>, label: m.link.label, origin: m.link.origin }));
  }

  get label(): string {
    return `PACK ${this.members.map((m) => `${m.dog} ${m.link.label}`).join(' + ')}`;
  }

  async open(sink: TransportSink): Promise<void> {
    const opened: Transport[] = [];
    try {
      for (const { dog, link } of this.members) {
        await link.open({
          frame: (f) => sink.frame(f, dog),
          error: (message, raw) => sink.error(message, raw, dog),
          lost: (reason) => sink.lost(reason, dog),
        });
        opened.push(link);
      }
    } catch (e) {
      await Promise.all(opened.map((l) => l.close()));
      throw e;
    }
  }

  send(cmd: HostCommand, dog?: string): void {
    for (const m of this.members) if (dog === undefined || m.dog === dog) m.link.send(cmd);
  }

  async close(): Promise<void> {
    await Promise.all(this.members.map((m) => m.link.close()));
  }
}

/** Wires a line splitter and the frame decoder to a sink. */
export function createLineDecoder(sink: TransportSink): LineSplitter {
  return new LineSplitter(
    (line) => {
      const result = decodeFrame(line);
      if (result.ok) sink.frame(result.frame);
      else sink.error(`frame rejected: ${result.error}`, result.raw);
    },
    (dropped) => sink.error(`line exceeded buffer, ${dropped} bytes dropped`),
  );
}
