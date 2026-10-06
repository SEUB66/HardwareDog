import type { DeviceFrame, HostCommand } from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import type { Transport, TransportSink } from './transport';
import type { SerialPortLike } from './webserial';
import { portLabel, serialApi } from './webserial';

/**
 * A serial console read by this browser: no Hardware Dog needed.
 *
 * Any serial port works: an Arduino, an ESP32, a router's console, a
 * USB-UART adapter on any board. The browser reads the bytes and turns
 * them into the same HDP frames a Hardware Dog would send for its UART
 * (uart.config, uart.rx, uart.error), so the timeline, the rules, the
 * recording, the replay and the report work unchanged.
 *
 * Its hello says what it is: device CONSOLE, rev HOST, observing uart
 * only. Power, USB, I2C and network are not observed, and say so.
 */

/** The device id of a console session: this browser, not a probe. */
export const CONSOLE_DEVICE = 'CONSOLE';

/** 74880: what an ESP8266 boot ROM speaks. */
export const CONSOLE_BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600] as const;
export const DEFAULT_CONSOLE_BAUD = 115200;

/** A line with no end yet is shown after this much silence (a prompt, a progress bar). */
export const IDLE_FLUSH_MS = 300;
/** Longer than this without an end of line: cut, so one runaway stream cannot fill memory. */
export const MAX_CONSOLE_LINE = 1024;

/** Colors and cursor moves (ESP-IDF logs are colored): not text. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * A line that does not read as text: bytes at the wrong baud rate decode as
 * replacement and control characters. An observation, not a framing error
 * reported by the UART: it is recorded as uart.error "garbled".
 */
export function isGarbled(line: string): boolean {
  const chars = [...line];
  if (chars.length < 4) return false;
  let bad = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09) || (c >= 0x7f && c < 0xa0)) bad++;
  }
  return bad / chars.length >= 0.3;
}

/** Bytes in, console lines out: \n, \r\n and a lone \r all end a line. */
export class LineSplitter {
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';

  constructor(private readonly emit: (line: string) => void) {}

  push(bytes: Uint8Array): void {
    this.pending += this.decoder.decode(bytes, { stream: true });
    for (;;) {
      const end = this.pending.search(/[\r\n]/);
      if (end < 0) break;
      // A \r last in the chunk may be the first half of \r\n: wait for the next byte.
      if (this.pending[end] === '\r' && end === this.pending.length - 1) break;
      const width = this.pending[end] === '\r' && this.pending[end + 1] === '\n' ? 2 : 1;
      this.line(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + width);
    }
    while (this.pending.length > MAX_CONSOLE_LINE) {
      this.line(this.pending.slice(0, MAX_CONSOLE_LINE));
      this.pending = this.pending.slice(MAX_CONSOLE_LINE);
    }
  }

  /** Whether part of a line is waiting for its end. */
  get waiting(): boolean {
    return this.pending.replace(/\r$/, '').length > 0;
  }

  /** Emit what is waiting, as a line (after silence, or at the end). */
  flush(): void {
    const rest = this.pending.replace(/\r$/, '');
    this.pending = '';
    this.line(rest);
  }

  private line(raw: string): void {
    const text = raw.replace(ANSI, '');
    if (text.trim().length > 0) this.emit(text);
  }
}

/** Web Serial's recoverable read errors, by DOMException name. */
const READ_ERRORS: Record<string, string> = {
  FramingError: 'framing',
  ParityError: 'parity',
  BufferOverrunError: 'overrun',
  BreakError: 'break',
};

export class ConsoleTransport implements Transport {
  readonly kind = 'WEB SERIAL' as const;
  readonly origin = 'PHYSICAL' as const;
  readonly label: string;

  private sink: TransportSink | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private splitter: LineSplitter | null = null;
  private openedAt = 0;
  private closing = false;
  private readonly encoder = new TextEncoder();

  /**
   * Show the browser port picker. Must run directly inside a user gesture
   * (a click), before anything else is awaited. Every serial port is listed.
   */
  static async pick(baud: number = DEFAULT_CONSOLE_BAUD): Promise<ConsoleTransport> {
    const api = serialApi();
    if (!api) throw new Error('Web Serial is not available in this browser');
    return new ConsoleTransport(await api.requestPort(), baud);
  }

  constructor(
    private readonly port: SerialPortLike,
    private baud: number,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.label = `CONSOLE ${portLabel(port).replace(/^USB CDC /, 'USB ')}`;
  }

  /** Milliseconds since the port was opened: the console's own clock. */
  private t(): number {
    return Math.round(this.clock() - this.openedAt);
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.openedAt = this.clock();
    await this.start();
    const hello: DeviceFrame = { type: 'hello', t: 0, proto: PROTOCOL_VERSION, device: CONSOLE_DEVICE, rev: 'HOST', fw: 'web-serial-console', caps: ['uart'] };
    sink.frame(hello);
    this.configured();
  }

  private configured(): void {
    this.sink?.frame({ type: 'uart.config', t: this.t(), port: this.label, baud: this.baud, bits: 8, parity: 'NONE', stop: 1 });
  }

  private async start(): Promise<void> {
    await this.port.open({ baudRate: this.baud, bufferSize: 64 * 1024 });
    if (!this.port.readable) throw new Error('serial port opened without a readable stream');
    this.writer = this.port.writable?.getWriter() ?? null;
    this.splitter = new LineSplitter((line) => this.onLine(line));
    this.reading = this.readLoop();
  }

  private onLine(line: string): void {
    const sink = this.sink;
    if (!sink) return;
    const t = this.t();
    sink.frame({ type: 'uart.rx', t, data: line });
    if (isGarbled(line)) sink.frame({ type: 'uart.error', t, kind: 'garbled' });
  }

  private async readLoop(): Promise<void> {
    // After a framing, parity, overrun or break error the stream ends and
    // port.readable is a new one: keep reading, the error is evidence.
    while (this.port.readable && !this.closing) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.received(value);
        }
      } catch (e) {
        if (this.closing) break;
        const kind = e instanceof Error ? READ_ERRORS[e.name] : undefined;
        if (kind === undefined) {
          this.sink?.lost(e instanceof Error ? e.message : String(e));
          return;
        }
        this.sink?.frame({ type: 'uart.error', t: this.t(), kind });
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) this.sink?.lost('serial stream ended');
  }

  private received(bytes: Uint8Array): void {
    const splitter = this.splitter!;
    splitter.push(bytes);
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = splitter.waiting
      ? setTimeout(() => {
          this.idle = null;
          splitter.flush();
        }, IDLE_FLUSH_MS)
      : null;
  }

  send(cmd: HostCommand): void {
    if (cmd.cmd === 'uart.tx') {
      void this.writer?.write(this.encoder.encode(`${cmd.data}\n`));
    } else if (cmd.cmd === 'uart.config') {
      void this.reconfigure(cmd.baud);
    }
    // Nothing else: a console observes only the UART (hello caps).
  }

  /** Another baud rate: close the port and open it again, said on the timeline. */
  private async reconfigure(baud: number): Promise<void> {
    if (baud === this.baud) return this.configured();
    // The end of the last line belongs to the old rate.
    this.splitter?.flush();
    await this.stop();
    this.baud = baud;
    this.closing = false;
    try {
      await this.start();
      this.configured();
    } catch (e) {
      this.sink?.lost(e instanceof Error ? e.message : String(e));
    }
  }

  private async stop(): Promise<void> {
    this.closing = true;
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
    try {
      await this.reader?.cancel();
    } catch {
      // Already closed by the device side.
    }
    await this.reading?.catch(() => {});
    this.writer?.releaseLock();
    this.writer = null;
    await this.port.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.stop();
    this.sink = null;
  }
}
