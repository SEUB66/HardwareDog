import type { DeviceFrame, HostCommand } from './protocol';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';
import type { CheckStatus, ProbeTest } from './types';
import { PROTOCOL_VERSION } from './protocol';

/** Deterministic PRNG (mulberry32) so simulated sessions are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorOptions {
  seed?: number;
  /** When true, time only moves through advance(); used by tests. */
  manual?: boolean;
  /** Power sample period in ms. */
  samplePeriod?: number;
}

interface Scheduled {
  at: number;
  run: () => void;
}

const TARGET_BAUD = 115200;
const SUPPLY_VOLTS = 5.07;
const CABLE_OHMS = 0.09;

const BOOT_LOG = [
  'ESP-ROM:esp32s3-20210327',
  'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)',
  'bootloader 0.9',
  'loading config',
  'sensor init',
  'network ready',
];

/**
 * A simulated Hardware Dog with a simulated target plugged into it.
 *
 * The target has a marginal supply: periodic load bursts sag the rail,
 * and deep sags make it drop off USB and reboot. This exercises every
 * path the real instrument cares about. The simulator speaks the real
 * protocol as text, so frames go through the same decoder as hardware.
 */
export class SimulatedDevice implements Transport {
  readonly kind = 'SIMULATOR' as const;
  readonly label = 'SIMULATED DEVICE / SIMULATED TARGET';

  private readonly rand: () => number;
  private readonly manual: boolean;
  private readonly samplePeriod: number;
  private sink: TransportSink | null = null;
  private lines: ReturnType<typeof createLineDecoder> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private t = 0;
  private queue: Scheduled[] = [];

  // Target state.
  private usbConnected = false;
  private baud = TARGET_BAUD;
  private nextBurstAt = 0;
  private burstUntil = 0;
  private burstDepth = 0;
  private burstCurrent = 0;
  private burstDetaches = false;
  private detachScheduled = false;
  private baseCurrent = 0.112;
  private nextSampleAt = 0;
  private nextNetAt = 0;
  private nextChatterAt = 0;

  constructor(options: SimulatorOptions = {}) {
    this.rand = prng(options.seed ?? 0x0d06);
    this.manual = options.manual ?? false;
    this.samplePeriod = options.samplePeriod ?? 20;
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.lines = createLineDecoder(sink);
    this.t = 0;
    this.emit({ type: 'hello', t: 0, proto: PROTOCOL_VERSION, device: 'HD-001', rev: 'A', fw: '0.1.0' });
    this.emit({ type: 'uart.config', t: 0, port: 'UART0', baud: this.baud, bits: 8, parity: 'NONE', stop: 1 });
    this.emitNet();
    this.nextNetAt = 2000;
    this.nextBurstAt = 6000 + this.rand() * 4000;
    this.nextChatterAt = 3000;
    this.at(180, () => this.attach());
    if (!this.manual) {
      this.startedAt = Date.now();
      this.timer = setInterval(() => this.advanceTo(Date.now() - this.startedAt), 10);
    }
  }

  async close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.sink = null;
    this.queue = [];
  }

  /** Move simulated time forward. Only meaningful in manual mode. */
  advance(ms: number): void {
    this.advanceTo(this.t + ms);
  }

  /** Current simulated device uptime in ms. */
  get uptime(): number {
    return this.t;
  }

  send(cmd: HostCommand): void {
    switch (cmd.cmd) {
      case 'hello':
        break;
      case 'usb.enumerate':
        this.at(this.t + 40, () => {
          if (this.usbConnected) this.emitAttach();
          else this.log('warn', 'enumerate requested: no USB device present');
        });
        break;
      case 'uart.config':
        this.baud = cmd.baud;
        this.at(this.t + 5, () =>
          this.emit({ type: 'uart.config', t: this.t, port: 'UART0', baud: cmd.baud, bits: 8, parity: 'NONE', stop: 1 }),
        );
        break;
      case 'uart.tx':
        this.at(this.t + 12, () => this.targetSays(this.usbConnected ? `? unknown command: ${cmd.data.trim()}` : ''));
        break;
      case 'i2c.scan':
        this.at(this.t + 260, () =>
          this.emit({
            type: 'i2c.scan',
            t: this.t,
            speed: 400000,
            devices: [
              { addr: 0x3c, ident: null, method: null },
              { addr: 0x40, ident: 'INA226', method: 'manufacturer ID register 0xFE = 0x5449' },
              { addr: 0x52, ident: null, method: null },
              { addr: 0x76, ident: 'BME280', method: 'chip ID register 0xD0 = 0x60' },
            ],
          }),
        );
        break;
      case 'net.refresh':
        this.at(this.t + 30, () => this.emitNet());
        break;
      case 'probe':
        this.runProbe(cmd.id, cmd.target, cmd.tests);
        break;
    }
  }

  // ---------------------------------------------------------------- internals

  private emit(frame: DeviceFrame): void {
    // Serialize and decode like a real link would.
    this.lines?.push(JSON.stringify(frame) + '\n');
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', t: this.t, level, message });
  }

  private at(at: number, run: () => void): void {
    this.queue.push({ at, run });
    this.queue.sort((a, b) => a.at - b.at);
  }

  private advanceTo(target: number): void {
    while (this.sink) {
      const nextJob = this.queue[0]?.at ?? Infinity;
      const next = Math.min(nextJob, this.nextSampleAt, target + 1);
      if (next > target) break;
      this.t = next;
      if (nextJob === next) {
        this.queue.shift()!.run();
        continue;
      }
      this.sample();
      this.nextSampleAt += this.samplePeriod;
    }
    this.t = Math.max(this.t, target);
  }

  private sample(): void {
    const t = this.t;

    if (t >= this.nextBurstAt && t >= this.burstUntil) {
      // Radio / motor style load burst.
      this.burstUntil = t + 260 + this.rand() * 120;
      this.burstCurrent = 0.62 + this.rand() * 0.14;
      this.burstDepth = this.rand();
      this.burstDetaches = this.usbConnected && this.burstDepth > 0.35;
      this.detachScheduled = false;
      this.nextBurstAt = t + 9000 + this.rand() * 7000;
    }

    const bursting = t < this.burstUntil;
    const noise = (this.rand() - 0.5) * 0.012;
    let current = this.usbConnected ? this.baseCurrent + (this.rand() - 0.5) * 0.01 : 0.004;
    if (bursting) current = this.burstCurrent + (this.rand() - 0.5) * 0.02;
    let voltage = SUPPLY_VOLTS - current * CABLE_OHMS + noise;

    if (bursting) {
      // Marginal supply: the rail collapses under load, deeper on bad bursts.
      const sag = 0.18 + this.burstDepth * 0.32;
      voltage -= sag;
      if (this.burstDetaches && !this.detachScheduled && voltage < 4.72) {
        this.detachScheduled = true;
        const delay = 55 + Math.round(this.rand() * 35);
        this.at(t + delay, () => this.detach());
      }
    }

    this.emit({ type: 'power', t, v: round(voltage, 3), i: round(Math.max(0, current), 4) });

    if (this.usbConnected && t >= this.nextChatterAt) {
      this.nextChatterAt = t + 2500 + this.rand() * 2500;
      const temp = (23.5 + this.rand() * 1.5).toFixed(1);
      this.targetSays(`sensor: t=${temp}C rh=${Math.round(40 + this.rand() * 4)}%`);
    }

    if (t >= this.nextNetAt) {
      this.nextNetAt = t + 2000;
      this.emitNet();
    }
  }

  private attach(): void {
    this.usbConnected = true;
    this.baseCurrent = 0.1 + this.rand() * 0.03;
    this.emitAttach();
    BOOT_LOG.forEach((line, n) => this.at(this.t + 120 + n * 90, () => this.targetSays(line)));
    // Settle into normal operating current after boot.
    this.at(this.t + 700, () => {
      this.baseCurrent = 0.29 + this.rand() * 0.04;
    });
  }

  private emitAttach(): void {
    this.emit({
      type: 'usb.attach',
      t: this.t,
      speed: 'HIGH',
      vid: 0x303a,
      pid: 0x1001,
      cls: 'CDC',
      power: 'BUS',
      manufacturer: 'Espressif',
      product: 'USB JTAG/Serial',
      serial: '48:27:E2:5C:1A:90',
    });
  }

  private detach(): void {
    if (!this.usbConnected) return;
    this.usbConnected = false;
    this.emit({ type: 'usb.detach', t: this.t });
    this.at(this.t + 1200 + Math.round(this.rand() * 600), () => this.attach());
  }

  /** The target writes a line on its UART. Wrong baud rate means garbage. */
  private targetSays(line: string): void {
    if (!this.usbConnected || line === '') return;
    if (this.baud !== TARGET_BAUD) {
      const garbage = Array.from({ length: Math.max(4, Math.round(line.length / 3)) }, () =>
        String.fromCharCode(0x80 + Math.floor(this.rand() * 0x7f)),
      ).join('');
      this.emit({ type: 'uart.rx', t: this.t, data: garbage });
      this.emit({ type: 'uart.error', t: this.t, kind: 'framing' });
      return;
    }
    this.emit({ type: 'uart.rx', t: this.t, data: line });
  }

  private emitNet(): void {
    const latency = 9 + Math.round(this.rand() * 7);
    this.emit({
      type: 'net.status',
      t: this.t,
      link: { up: true, mbps: 1000, duplex: 'FULL' },
      address: '192.168.1.84',
      dhcp: 'PASS',
      gateway: { address: '192.168.1.1', status: 'PASS' },
      dns: { address: '1.1.1.1', status: 'PASS' },
      internet: 'PASS',
      latency,
      loss: 0,
    });
  }

  private runProbe(id: string, target: string, tests: ProbeTest[]): void {
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target);
    const known = !isIp || target === '192.168.1.1' || target === '1.1.1.1' || target === '192.168.1.84';
    const nxdomain = !isIp && /(^|\.)invalid$/.test(target);
    let delay = 80;
    for (const test of tests) {
      delay += 120 + Math.round(this.rand() * 200);
      const result = this.probeOne(test, target, isIp, known, nxdomain);
      this.at(this.t + delay, () => this.emit({ type: 'probe.result', t: this.t, id, test, ...result }));
    }
    this.at(this.t + delay + 20, () => this.emit({ type: 'probe.done', t: this.t, id }));
  }

  private probeOne(
    test: ProbeTest,
    target: string,
    isIp: boolean,
    known: boolean,
    nxdomain: boolean,
  ): { status: CheckStatus; detail: string } {
    const rtt = 2 + Math.round(this.rand() * 14);
    if (nxdomain) {
      return test === 'DNS'
        ? { status: 'FAIL', detail: `NXDOMAIN for ${target} from 1.1.1.1` }
        : { status: 'FAIL', detail: 'not run: name did not resolve' };
    }
    switch (test) {
      case 'PING':
        return known
          ? { status: 'PASS', detail: `4/4 replies, avg ${rtt} ms` }
          : { status: 'FAIL', detail: '0/4 replies, timeout 1000 ms' };
      case 'DNS':
        return isIp
          ? { status: 'PASS', detail: `1.1.1.1 answered in ${rtt + 8} ms` }
          : { status: 'PASS', detail: `${target} -> 93.184.215.${10 + Math.round(this.rand() * 40)} in ${rtt + 8} ms` };
      case 'TCP':
        return known
          ? { status: 'PASS', detail: `port 80 open, connect ${rtt} ms` }
          : { status: 'FAIL', detail: 'port 80: no SYN-ACK within 3000 ms' };
      case 'HTTP':
        return known
          ? { status: 'PASS', detail: `GET / -> 200 in ${rtt * 3 + 20} ms` }
          : { status: 'FAIL', detail: 'not run: TCP connect failed' };
    }
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
