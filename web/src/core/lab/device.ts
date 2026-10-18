/**
 * HARDWARE DOG / THE SESSION ON THE LAB BUS
 *
 * The Hardware Dog session (a board on the probe, a serial console, dogd's
 * sources, a recording played back) says on the lab bus what its link and
 * its operations do, as source DEVICE, so the companion follows them like
 * any lab tool's. It says facts the app already has; it invents none:
 *
 *   link       the session's link: ABSENT (nothing chosen), CONNECTING,
 *              CONNECTED, DISCONNECTED (lost), said once per change
 *   operation  an id, a tool, a start, an end: PASS, FAIL with the exact
 *              code, cancelled by the person, stopped on request; waiting
 *              for the person while a browser chooser is open
 *   watch      something that runs until stopped (the network checks, the
 *              I2C watch, a replay): one operation, from on to off
 *
 * No progress is invented: none is said. Nothing here drives the session.
 */

import type { HardwareState } from './companion';
import type { LabBus, LabEvent, LabOrigin, OpKind } from './events';
import { errorInfo, newOp } from './events';

/** The session's link, as the companion counts links. */
export function deviceLink(chosen: boolean, link: string): HardwareState {
  if (!chosen) return 'ABSENT';
  if (link === 'ONLINE') return 'CONNECTED';
  if (link === 'LOST') return 'DISCONNECTED';
  if (link === 'WAITING') return 'CONNECTING';
  return 'UNKNOWN';
}

export class DeviceBridge {
  private lastLink: string | null = null;
  private readonly watches = new Map<string, string>();

  constructor(private readonly bus: LabBus) {}

  /** The link, said when it changes (and when its origin does: a demo is not a board). */
  link(state: HardwareState, message: string, origin: LabOrigin): void {
    const key = `${state}|${origin}`;
    if (key === this.lastLink) return;
    const lost = state === 'DISCONNECTED';
    this.lastLink = key;
    this.bus.emit({
      source: 'DEVICE',
      tool: 'device.link',
      type: 'link.state',
      severity: lost ? 'FAIL' : state === 'CONNECTED' ? 'PASS' : 'INFO',
      message,
      origin,
      params: lost ? { state, reason: 'lost' } : { state },
    });
  }

  /** An operation begins. `wait`: it waits for the person first (a chooser). */
  begin(tool: string, kind: OpKind, message: string, origin: LabOrigin, wait = false): string {
    const op = newOp(tool);
    this.bus.emit({ source: 'DEVICE', tool, type: 'op.start', op, severity: 'INFO', message, origin, params: wait ? { kind, wait: 'user' } : { kind } });
    return op;
  }

  /** The wait for the person is over (the chooser answered): the operation goes on. */
  resume(op: string, tool: string, message: string, origin: LabOrigin): void {
    this.bus.emit({ source: 'DEVICE', tool, type: 'op.progress', op, severity: 'INFO', message, origin, params: { wait: null } });
  }

  /** An operation ends. */
  end(op: string, tool: string, e: { severity: LabEvent['severity']; message: string; origin: LabOrigin; code?: string; outcome?: 'cancelled' | 'stopped' }): void {
    this.bus.emit({
      source: 'DEVICE',
      tool,
      type: 'op.end',
      op,
      severity: e.severity,
      message: e.message,
      origin: e.origin,
      ...(e.code ? { code: e.code } : {}),
      ...(e.outcome ? { params: { outcome: e.outcome } } : {}),
    });
  }

  /**
   * How a browser chooser ended, said as the end of its operation: closed
   * without a choice is a cancel (not an error), anything else keeps its
   * exact code.
   */
  failed(op: string, tool: string, error: unknown, origin: LabOrigin): void {
    const { message, code } = errorInfo(error);
    if (code === 'NotFoundError' || code === 'AbortError') this.end(op, tool, { severity: 'INFO', message, origin, code, outcome: 'cancelled' });
    else this.end(op, tool, { severity: 'FAIL', message, origin, ...(code ? { code } : {}) });
  }

  /** Something that runs until stopped: one operation from on to off, said once each way. */
  watch(tool: string, on: boolean, kind: OpKind, message: string, origin: LabOrigin): void {
    const running = this.watches.get(tool);
    if (on && !running) this.watches.set(tool, this.begin(tool, kind, message, origin));
    else if (!on && running) {
      this.watches.delete(tool);
      this.end(running, tool, { severity: 'INFO', message: `${message}: stopped`, origin, outcome: 'stopped' });
    }
  }
}
