/**
 * HARDWARE DOG / FLIPPER ZERO OVER WEB SERIAL
 *
 * A Flipper Zero on USB is a CDC serial port (VID 0483, PID 5740) running
 * a text CLI. `start_rpc_session` switches that port to the protobuf RPC
 * the official apps use; from then on it carries length-delimited
 * PB.Main messages, both ways (client.ts).
 *
 *   open port -> wait for the CLI prompt ">: " -> "start_rpc_session\r"
 *   -> skip the echoed line -> RPC bytes
 *
 * Nothing is written to the device before the operator picked it in the
 * browser's port chooser. Nothing here can flash or update firmware.
 * Only one session at a time: the service refuses a second connect, and a
 * detached window reuses this one (it is the same page).
 */

import type { SerialLike, SerialPortLike } from '../webserial';
import { serialApi } from '../webserial';
import type { ByteLink } from './client';

export const FLIPPER_USB = { usbVendorId: 0x0483, usbProductId: 0x5740 } as const;

const PROMPT = '>: ';
const START = 'start_rpc_session\r';
const enc = new TextEncoder();

export class SerialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SerialError';
  }
}

/** Pick a Flipper in the browser's chooser. Must run inside the click. */
export async function pickFlipperPort(api: SerialLike | null = serialApi()): Promise<SerialPortLike> {
  if (!api) throw new SerialError('SERIAL_UNSUPPORTED', 'Web Serial is not available in this browser (Chromium-based browsers only)');
  return api.requestPort({ filters: [FLIPPER_USB] });
}

export class FlipperSerialLink implements ByteLink {
  readonly origin = 'PHYSICAL' as const;
  readonly label: string;
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing = false;
  private rpc = false;
  private text = '';
  private early: Uint8Array[] = [];
  private waiter: { want: (t: string) => number; resolve: (rest: Uint8Array) => void } | null = null;

  constructor(private readonly port: SerialPortLike) {
    const info = port.getInfo();
    const h = (n: number | undefined) => (n ?? 0).toString(16).toUpperCase().padStart(4, '0');
    this.label = `FLIPPER USB ${h(info.usbVendorId)}:${h(info.usbProductId)}`;
  }

  /** Open the port and switch the CLI to RPC. Throws with a code on every failure. */
  async open(timeoutMs = 4000): Promise<void> {
    try {
      // The Flipper ignores the rate (USB CDC); one is still required.
      await this.port.open({ baudRate: 230400 });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      throw new SerialError(name && name !== 'Error' ? name : 'SERIAL_OPEN', `could not open the port: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.port.readable || !this.port.writable) throw new SerialError('SERIAL_OPEN', 'port opened without streams');
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    void this.readLoop(this.reader);
    try {
      // A fresh CLI shows its prompt after a newline; one already open shows it again.
      const prompt = this.until((t) => (t.lastIndexOf(PROMPT) >= 0 ? t.lastIndexOf(PROMPT) + PROMPT.length : -1), timeoutMs);
      await this.write(enc.encode('\r'));
      await prompt;
      this.text = '';
      const started = this.until((t) => {
        const i = t.indexOf('start_rpc_session');
        if (i < 0) return -1;
        const nl = t.indexOf('\n', i);
        return nl < 0 ? -1 : nl + 1;
      }, timeoutMs);
      await this.write(enc.encode(START));
      const rest = await started;
      this.rpc = true;
      if (rest.length) this.early.push(rest);
      for (const b of this.early.splice(0)) this.onData?.(b);
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  /** Resolve with the bytes after the point `want` finds in the CLI text. */
  private until(want: (t: string) => number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new SerialError('TIMEOUT', `the Flipper CLI did not answer in ${timeoutMs / 1000} s (is it a Flipper? is another app using it?)`));
      }, timeoutMs);
      this.waiter = {
        want,
        resolve: (rest) => {
          clearTimeout(timer);
          resolve(rest);
        },
      };
      this.feedText(new Uint8Array(0));
    });
  }

  private feedText(bytes: Uint8Array): void {
    // The CLI is ASCII; latin-1 keeps one char per byte so offsets stay byte offsets.
    for (const b of bytes) this.text += String.fromCharCode(b);
    if (this.text.length > 64 * 1024) this.text = this.text.slice(-4096);
    const w = this.waiter;
    if (!w) return;
    const at = w.want(this.text);
    if (at < 0) return;
    this.waiter = null;
    const rest = Uint8Array.from(this.text.slice(at), (c) => c.charCodeAt(0));
    this.text = '';
    w.resolve(rest);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    let reason = 'serial stream ended';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        if (this.rpc) this.onData?.(value);
        else this.feedText(value);
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
    if (!this.closing) this.onClose?.(reason);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new SerialError('LINK_LOST', 'port is closed');
    await this.writer.write(bytes);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // the device side already closed it
    }
    try {
      this.writer?.releaseLock();
    } catch {
      // nothing to release
    }
    await this.port.close().catch(() => {});
    this.reader = null;
    this.writer = null;
  }
}
