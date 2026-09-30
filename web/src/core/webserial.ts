import type { HostCommand } from './protocol';
import { encodeCommand, PROTOCOL_VERSION } from './protocol';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';

// Minimal Web Serial typings: the API is not part of the TypeScript DOM lib.
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(options?: object): Promise<SerialPortLike>;
}

function serialApi(): SerialLike | null {
  const nav = globalThis.navigator as (Navigator & { serial?: SerialLike }) | undefined;
  return nav?.serial ?? null;
}

export function webSerialSupported(): boolean {
  return serialApi() !== null;
}

const LINK_BAUD = 115200;

/**
 * Talks to real Hardware Dog firmware over USB CDC using Web Serial.
 * Requires a Chromium-based browser and a user gesture to pick the port.
 */
export class WebSerialTransport implements Transport {
  readonly kind = 'WEB SERIAL' as const;
  label = 'WEB SERIAL';

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private closing = false;
  private readonly encoder = new TextEncoder();

  /**
   * Show the browser port picker. Must run directly inside a user gesture
   * (a click), before anything else is awaited.
   */
  static async pick(): Promise<WebSerialTransport> {
    const api = serialApi();
    if (!api) throw new Error('Web Serial is not available in this browser');
    const t = new WebSerialTransport();
    t.port = await api.requestPort();
    return t;
  }

  async open(sink: TransportSink): Promise<void> {
    if (!this.port) throw new Error('no serial port selected');
    await this.port.open({ baudRate: LINK_BAUD });
    const info = this.port.getInfo();
    if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
      const h = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
      this.label = `USB CDC ${h(info.usbVendorId)}:${h(info.usbProductId)}`;
    }
    if (!this.port.readable || !this.port.writable) throw new Error('serial port opened without streams');
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    void this.readLoop(sink, this.reader);
    this.send({ cmd: 'hello', proto: PROTOCOL_VERSION });
  }

  private async readLoop(sink: TransportSink, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const lines = createLineDecoder(sink);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) lines.push(decoder.decode(value, { stream: true }));
      }
      if (!this.closing) sink.lost('serial stream ended');
    } catch (e) {
      if (!this.closing) sink.lost(e instanceof Error ? e.message : String(e));
    } finally {
      reader.releaseLock();
    }
  }

  send(cmd: HostCommand): void {
    if (!this.writer) return;
    void this.writer.write(this.encoder.encode(encodeCommand(cmd)));
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {
      // Already closed by the device side.
    }
    this.writer?.releaseLock();
    await this.port?.close().catch(() => {});
    this.port = null;
    this.reader = null;
    this.writer = null;
  }
}
