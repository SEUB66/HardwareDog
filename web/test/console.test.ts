import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSOLE_DEVICE, ConsoleTransport, IDLE_FLUSH_MS, LineSplitter, MAX_CONSOLE_LINE, isGarbled } from '../src/core/console';
import type { DeviceFrame } from '../src/core/protocol';
import { decodeFrame } from '../src/core/protocol';
import { NO_HARDWARE_DOG, System, memoryStore } from '../src/core/system';
import { ReplayTransport, SessionRecorder, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { thresholdsOf } from '../src/core/types';
import type { TransportSink } from '../src/core/transport';
import type { SerialPortLike } from '../src/core/webserial';

// No probe: the serial console of any board, read by the browser, on the
// same timeline and through the same rules as a Hardware Dog's UART.

const bytes = (s: string) => new TextEncoder().encode(s);

/** A serial port the test feeds, like Web Serial's: a new readable after a read error. */
class FakePort implements SerialPortLike {
  opens: number[] = [];
  closed = 0;
  written: string[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;

  getInfo() {
    return { usbVendorId: 0x2341, usbProductId: 0x0043 };
  }
  async open(o: { baudRate: number }) {
    this.opens.push(o.baudRate);
    this.fresh();
    this.writable = new WritableStream({ write: (c) => void this.written.push(new TextDecoder().decode(c)) });
  }
  async close() {
    this.closed++;
    this.readable = null;
  }
  private fresh() {
    this.readable = new ReadableStream({ start: (c) => void (this.ctrl = c) });
  }
  feed(s: string | Uint8Array) {
    this.ctrl!.enqueue(typeof s === 'string' ? bytes(s) : s);
  }
  /** A recoverable read error: this stream fails, the next one reads on. */
  fail(name: string) {
    const c = this.ctrl!;
    this.fresh();
    c.error(Object.assign(new Error(name), { name }));
  }
  /** The board is unplugged. */
  unplug() {
    const c = this.ctrl!;
    this.readable = null;
    c.error(Object.assign(new Error('The device has been lost.'), { name: 'NetworkError' }));
  }
}

function sink() {
  const frames: DeviceFrame[] = [];
  const lost: string[] = [];
  const s: TransportSink = { frame: (f) => void frames.push(f), error: () => {}, lost: (r) => void lost.push(r) };
  return { s, frames, lost, rx: () => frames.filter((f) => f.type === 'uart.rx').map((f) => (f as { data: string }).data) };
}

const settle = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
};

describe('LineSplitter', () => {
  const split = (...chunks: string[]) => {
    const out: string[] = [];
    const s = new LineSplitter((l) => out.push(l));
    for (const c of chunks) s.push(bytes(c));
    return { out, s };
  };

  it('ends a line at \\n, \\r\\n and a lone \\r, across chunks', () => {
    expect(split('a\nb\r\nc\rd\n').out).toEqual(['a', 'b', 'c', 'd']);
    // \r\n cut between two reads is one end of line, not two.
    expect(split('boot\r', '\nready\r\n').out).toEqual(['boot', 'ready']);
  });

  it('keeps a multi-byte character cut between two reads', () => {
    const e = bytes('température 25°C\n');
    const out: string[] = [];
    const s = new LineSplitter((l) => out.push(l));
    s.push(e.slice(0, 4));
    s.push(e.slice(4));
    expect(out).toEqual(['température 25°C']);
  });

  it('removes colors (ESP-IDF logs) and skips empty lines', () => {
    expect(split('\x1b[0;32mI (312) cpu_start: Pro cpu up.\x1b[0m\r\n\r\n\n').out).toEqual(['I (312) cpu_start: Pro cpu up.']);
  });

  it('cuts a line that never ends, so memory stays bounded', () => {
    const { out, s } = split('x'.repeat(MAX_CONSOLE_LINE * 2 + 5));
    expect(out).toHaveLength(2);
    expect(s.waiting).toBe(true);
    s.flush();
    expect(out[2]).toBe('xxxxx');
  });
});

describe('garbled lines', () => {
  it('tells text from bytes read at the wrong baud rate', () => {
    expect(isGarbled('ets Jun  8 2016 00:22:57')).toBe(false);
    expect(isGarbled('��\u0001x�\u0013�')).toBe(true);
    expect(isGarbled('ok')).toBe(false);
    // What 115200 baud looks like read at 9600, decoded.
    const wrong = new TextDecoder().decode(new Uint8Array([0xe0, 0x00, 0xfe, 0x80, 0x1c, 0xf8, 0x00, 0x80, 0xe6, 0x78]));
    expect(isGarbled(wrong)).toBe(true);
  });
});

describe('ConsoleTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says what it is, then the port and its rate, then every line', async () => {
    const port = new FakePort();
    let now = 5_000;
    const t = new ConsoleTransport(port, 115200, () => now);
    const { s, frames, rx } = sink();
    await t.open(s);
    expect(t.label).toBe('CONSOLE USB 2341:0043');
    expect(frames[0]).toMatchObject({ type: 'hello', device: CONSOLE_DEVICE, rev: 'HOST', caps: ['uart'] });
    expect(frames[1]).toMatchObject({ type: 'uart.config', port: 'CONSOLE USB 2341:0043', baud: 115200, bits: 8, parity: 'NONE', stop: 1 });
    now = 5_250;
    port.feed('Hello from Arduino\r\n');
    await settle();
    expect(rx()).toEqual(['Hello from Arduino']);
    expect(frames.at(-1)!.t).toBe(250);
    // Every frame is valid HDP: a recording of it replays through the same decoder.
    for (const f of frames) expect(decodeFrame(JSON.stringify(f))).toMatchObject({ ok: true, frame: f });
    await t.close();
  });

  it('shows a prompt with no end of line after a short silence', async () => {
    const port = new FakePort();
    const t = new ConsoleTransport(port, 115200, () => 0);
    const { s, rx } = sink();
    await t.open(s);
    port.feed('login: ');
    await settle();
    expect(rx()).toEqual([]);
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    expect(rx()).toEqual(['login: ']);
    await t.close();
  });

  it('records a garbled line as evidence of a wrong baud rate', async () => {
    const port = new FakePort();
    const t = new ConsoleTransport(port, 9600, () => 0);
    const { s, frames } = sink();
    await t.open(s);
    port.feed(new Uint8Array([0xe0, 0x00, 0xfe, 0x80, 0x1c, 0xf8, 0x00, 0x80, 0xe6, 0x78, 0x0a]));
    await settle();
    expect(frames.at(-1)).toMatchObject({ type: 'uart.error', kind: 'garbled' });
    await t.close();
  });

  it('keeps reading after a framing error, and says it', async () => {
    const port = new FakePort();
    const t = new ConsoleTransport(port, 115200, () => 0);
    const { s, frames, rx, lost } = sink();
    await t.open(s);
    port.fail('FramingError');
    await settle();
    port.feed('still here\n');
    await settle();
    expect(frames.some((f) => f.type === 'uart.error' && f.kind === 'framing')).toBe(true);
    expect(rx()).toEqual(['still here']);
    expect(lost).toEqual([]);
    await t.close();
  });

  it('reports the board unplugged as a lost link', async () => {
    const port = new FakePort();
    const t = new ConsoleTransport(port, 115200, () => 0);
    const { s, lost } = sink();
    await t.open(s);
    port.unplug();
    await settle();
    expect(lost).toEqual(['The device has been lost.']);
  });

  it('opens the port again at another rate, and sends lines', async () => {
    const port = new FakePort();
    const t = new ConsoleTransport(port, 115200, () => 0);
    const { s, frames } = sink();
    await t.open(s);
    t.send({ cmd: 'uart.tx', data: 'help' });
    await settle();
    expect(port.written).toEqual(['help\n']);
    t.send({ cmd: 'uart.config', baud: 9600 });
    await vi.runAllTimersAsync();
    expect(port.opens).toEqual([115200, 9600]);
    expect(port.closed).toBe(1);
    expect(frames.at(-1)).toMatchObject({ type: 'uart.config', baud: 9600 });
    await t.close();
  });
});

describe('a console session in the System', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function consoleSession(baud = 115200) {
    const port = new FakePort();
    const sys = new System(memoryStore(), () => Date.now());
    expect(await sys.connect(new ConsoleTransport(port, baud, () => Date.now()))).toBe(true);
    return { sys, port };
  }

  it('is a source of its own: uart observed, the rest not monitored, never NO HARDWARE DOG', async () => {
    const { sys } = await consoleSession();
    expect(sys.device.id).toBe(CONSOLE_DEVICE);
    expect(sys.origin).toBe('PHYSICAL');
    expect(sys.observes('uart')).toBe(true);
    for (const cap of ['power', 'usb', 'i2c', 'net']) expect(sys.observes(cap)).toBe(false);
    expect(sys.serial.active).toBe(true);
    expect(sys.serial.baud).toBe(115200);
    vi.advanceTimersByTime(10_000);
    expect(sys.lastError?.what).not.toBe(NO_HARDWARE_DOG);
    await sys.disconnect();
  });

  it('finds a reset loop in an ESP32 console', async () => {
    const { sys, port } = await consoleSession();
    for (let n = 0; n < 3; n++) {
      port.feed('ets Jun  8 2016 00:22:57\r\n\r\nrst:0xc (SW_CPU_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n');
      await settle();
      vi.advanceTimersByTime(2_000);
      sys.evaluate();
    }
    expect(sys.diagnoses.map((d) => d.id)).toContain('TARGET_RESET_LOOP');
    await sys.disconnect();
  });

  it('finds a wrong baud rate from garbled lines, and says it was garbled, not framing', async () => {
    const { sys, port } = await consoleSession(9600);
    const junk = new Uint8Array([0xe0, 0x00, 0xfe, 0x80, 0x1c, 0xf8, 0x00, 0x80, 0xe6, 0x78, 0x0a]);
    for (let n = 0; n < 6; n++) {
      port.feed(junk);
      await settle();
      vi.advanceTimersByTime(200);
    }
    sys.evaluate();
    const d = sys.diagnoses.find((x) => x.id === 'SERIAL_CONFIGURATION_MISMATCH');
    expect(d).toBeDefined();
    expect(d!.basis).toMatch(/^6 garbled lines on 6 lines/);
    await sys.disconnect();
  });
});

describe('a console session as evidence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is recorded as PHYSICAL and replays to the same lines and diagnosis', async () => {
    const port = new FakePort();
    const sys = new System(memoryStore(), () => Date.now());
    const transport = new ConsoleTransport(port, 115200, () => Date.now());
    sys.recorder = new SessionRecorder(
      newHeader({ id: 'HD-CONSOLE', startedAt: Date.now(), source: 'WEB SERIAL', endpoint: transport.label, scenario: null, app: 'test', thresholds: thresholdsOf(sys.settings) }),
    );
    await sys.connect(transport);
    for (let n = 0; n < 3; n++) {
      port.feed('rst:0x8 (TG1WDT_SYS_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\nwaiting for sensor...\r\n');
      await settle();
      vi.advanceTimersByTime(5_000);
    }
    sys.evaluate();
    const live = sys.diagnoses.map((d) => `${d.id}:${d.confidence}`);
    expect(live).toContain('TARGET_RESET_LOOP:HIGH');
    const text = toHdlog(sys.recorder.recording);
    await sys.disconnect();

    const parsed = parseHdlog(text);
    expect(parsed.header.origin).toBe('PHYSICAL');
    const r = new ReplayTransport(parsed);
    const again = new System(memoryStore(), () => r.clock);
    await again.boot(r, () => {}, 0);
    expect(again.device.id).toBe(CONSOLE_DEVICE);
    expect(again.serial.lines.map((l) => l.text)).toEqual(sys.serial.lines.map((l) => l.text));
    expect(again.diagnoses.map((d) => `${d.id}:${d.confidence}`)).toEqual(live);
  });
});
