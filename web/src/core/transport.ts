import type { DeviceFrame, HostCommand } from './protocol';
import { LineSplitter, decodeFrame } from './protocol';
import type { Origin, Thresholds, TransportKind } from './types';

/** Receives everything a transport produces. */
export interface TransportSink {
  frame(frame: DeviceFrame): void;
  /** A line that could not be decoded, or a link-level problem. */
  error(message: string, raw?: string): void;
  /** The link went away. Not called after a deliberate close(). */
  lost(reason: string): void;
  /** An operator note carried by the source (recordings only). */
  annotate?(text: string): void;
  /** Thresholds changed by the operator at this point (recordings only). */
  configure?(thresholds: Thresholds): void;
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
  open(sink: TransportSink): Promise<void>;
  send(cmd: HostCommand): void;
  close(): Promise<void>;
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
