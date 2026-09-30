import type { DeviceFrame, HostCommand } from './protocol';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';
import type { CheckStatus, ProbeTest } from './types';
import { PROTOCOL_VERSION } from './protocol';
import type { Range, Scenario, ScenarioId } from './scenarios';
import { DEFAULT_SCENARIO, SCENARIOS } from './scenarios';

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
  /** Physical situation to simulate. Default: HD-T001 (marginal supply). */
  scenario?: ScenarioId;
}

interface Scheduled {
  at: number;
  run: () => void;
}

/** Hardware Dog's own UART starts here; a target may run at another rate. */
const MONITOR_BAUD = 115200;

const bootLog = (rst: string) => [
  'ESP-ROM:esp32s3-20210327',
  `${rst},boot:0x8 (SPI_FAST_FLASH_BOOT)`,
  'bootloader 0.9',
  'loading config',
  'sensor init',
  'network ready',
];

/**
 * A simulated Hardware Dog with a simulated target plugged into it.
 *
 * The scenario (core/scenarios.ts) sets the physics: supply resistance,
 * load bursts, target firmware behavior, network layers. The simulator
 * only ever speaks the real protocol, as text, through the same decoder
 * as hardware; the diagnostic engine never sees the scenario itself.
 */
export class SimulatedDevice implements Transport {
  readonly kind = 'SIMULATOR' as const;
  readonly label: string;
  readonly scenario: Scenario;

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
  private powered = false;
  private usbConnected = false;
  private baud = MONITOR_BAUD;
  private runCurrent = 0.112;
  private nextBurstAt = Infinity;
  private burstUntil = 0;
  private burstCurrent = 0;
  private burstSag = 0;
  private brownoutScheduled = false;
  private spikeUntil = 0;
  private spikeCurrent = 0;
  private nextSampleAt = 0;
  private nextNetAt = 0;
  private nextChatterAt = 0;
  private resetting = false;

  constructor(options: SimulatorOptions = {}) {
    this.rand = prng(options.seed ?? 0x0d06);
    this.manual = options.manual ?? false;
    this.samplePeriod = options.samplePeriod ?? 20;
    this.scenario = SCENARIOS[options.scenario ?? DEFAULT_SCENARIO];
    this.label = `SIMULATED DEVICE / ${this.scenario.id} ${this.scenario.title}`;
  }

  async open(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.lines = createLineDecoder(sink);
    this.t = 0;
    this.emit({ type: 'hello', t: 0, proto: PROTOCOL_VERSION, device: 'HD-001', rev: 'A', fw: '0.1.0' });
    this.emit({ type: 'uart.config', t: 0, port: 'UART0', baud: this.baud, bits: 8, parity: 'NONE', stop: 1 });
    this.emitNet();
    this.nextNetAt = 2000;
    this.nextChatterAt = 3000;
    const { supply, target } = this.scenario;
    if (supply.bursts) this.nextBurstAt = this.between(supply.bursts.every) - 2000;
    if (target.usbDrops) this.at(this.between(target.usbDrops.every), () => this.usbDrop());
    if (target.resetLoop) this.at(this.between(target.resetLoop.every), () => this.watchdogReset());
    if (target.spikes) this.at(this.between(target.spikes.every), () => this.spike());
    this.at(180, () => this.powerUp('rst:0x1 (POWERON)'));
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
        this.at(this.t + 12, () => this.targetSays(this.powered ? `? unknown command: ${cmd.data.trim()}` : ''));
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

  private between([min, max]: Range): number {
    return min + this.rand() * (max - min);
  }

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
    const { supply } = this.scenario;
    const bursts = supply.bursts;

    if (bursts && this.powered && t >= this.nextBurstAt && t >= this.burstUntil) {
      // Radio / motor style load burst.
      this.burstUntil = t + 260 + this.rand() * 120;
      this.burstCurrent = this.between(bursts.current);
      this.burstSag = this.between(bursts.sag);
      this.brownoutScheduled = false;
      this.nextBurstAt = t + this.between(bursts.every);
    }

    const bursting = t < this.burstUntil;
    const spiking = t < this.spikeUntil;
    let current = 0.004;
    if (this.powered) current = this.resetting ? 0.045 : this.runCurrent + (this.rand() - 0.5) * 0.01;
    if (bursting) current = this.burstCurrent + (this.rand() - 0.5) * 0.02;
    if (spiking) current = this.spikeCurrent + (this.rand() - 0.5) * 0.03;
    let voltage = supply.volts - current * supply.ohms + (this.rand() - 0.5) * 0.012;

    if (bursting && bursts) {
      // Marginal supply: the rail collapses under load.
      voltage -= this.burstSag;
      if (bursts.brownoutBelow !== null && !this.brownoutScheduled && voltage < bursts.brownoutBelow) {
        this.brownoutScheduled = true;
        const delay = 55 + Math.round(this.rand() * 35);
        this.at(t + delay, () => this.brownout());
      }
    }

    this.emit({ type: 'power', t, v: round(voltage, 3), i: round(Math.max(0, current), 4) });

    if (this.powered && !this.resetting && t >= this.nextChatterAt) {
      this.nextChatterAt = t + 2500 + this.rand() * 2500;
      const temp = (23.5 + this.rand() * 1.5).toFixed(1);
      this.targetSays(`sensor: t=${temp}C rh=${Math.round(40 + this.rand() * 4)}%`);
    }

    if (t >= this.nextNetAt) {
      this.nextNetAt = t + 2000;
      this.emitNet();
    }
  }

  /** Target gets power and boots. */
  private powerUp(rst: string): void {
    this.powered = true;
    this.runCurrent = 0.1 + this.rand() * 0.03;
    if (this.scenario.target.enumerates) {
      this.usbConnected = true;
      this.emitAttach();
    }
    this.boot(rst);
  }

  private boot(rst: string): void {
    bootLog(rst).forEach((line, n) => this.at(this.t + 120 + n * 90, () => this.targetSays(line)));
    // Settle into normal operating current after boot.
    this.at(this.t + 700, () => {
      this.runCurrent = this.scenario.target.current + (this.rand() - 0.5) * 0.04;
    });
  }

  /** Supply collapse: the target loses power, drops off USB, then reboots. */
  private brownout(): void {
    if (!this.powered) return;
    this.powered = false;
    if (this.usbConnected) {
      this.usbConnected = false;
      this.emit({ type: 'usb.detach', t: this.t });
    }
    this.at(this.t + 1200 + Math.round(this.rand() * 600), () => this.powerUp('rst:0x1 (POWERON)'));
  }

  /** Data line glitch: USB drops, the target keeps running. */
  private usbDrop(): void {
    const drops = this.scenario.target.usbDrops!;
    if (this.usbConnected) {
      this.usbConnected = false;
      this.emit({ type: 'usb.detach', t: this.t });
      this.at(this.t + this.between(drops.outage), () => {
        if (!this.powered) return;
        this.usbConnected = true;
        this.emitAttach();
      });
    }
    this.at(this.t + this.between(drops.every), () => this.usbDrop());
  }

  /** Firmware hang: the watchdog reboots the target. USB-UART bridge stays up. */
  private watchdogReset(): void {
    const loop = this.scenario.target.resetLoop!;
    if (this.powered && !this.resetting) {
      this.targetSays('E (task_wdt): Task watchdog got triggered.');
      this.resetting = true;
      this.at(this.t + 60, () => {
        this.resetting = false;
        this.boot(`rst:0x${loop.code.toString(16)} (${loop.reason})`);
      });
    }
    this.at(this.t + this.between(loop.every), () => this.watchdogReset());
  }

  /** Load spike on a stiff supply: current jumps, voltage holds. */
  private spike(): void {
    const s = this.scenario.target.spikes!;
    if (this.powered) {
      this.spikeCurrent = this.between(s.current);
      this.spikeUntil = this.t + this.between(s.duration);
    }
    this.at(this.t + this.between(s.every), () => this.spike());
  }

  private emitAttach(): void {
    this.emit({
      type: 'usb.attach',
      t: this.t,
      speed: 'FULL', // ESP32-S3 USB Serial/JTAG is a full-speed (12 Mbps) device
      vid: 0x303a,
      pid: 0x1001,
      cls: 'CDC',
      power: 'BUS',
      manufacturer: 'Espressif',
      product: 'USB JTAG/Serial',
      serial: '48:27:E2:5C:1A:90',
    });
  }

  /** The target writes a line on its UART. Wrong baud rate means garbage. */
  private targetSays(line: string): void {
    if (!this.powered || line === '') return;
    if (this.baud !== this.scenario.target.baud) {
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
    const n = this.scenario.net;
    const up = n.link;
    const has = (st: CheckStatus) => st === 'PASS' || st === 'WARN';
    this.emit({
      type: 'net.status',
      t: this.t,
      link: up ? { up: true, mbps: 1000, duplex: 'FULL' } : { up: false, mbps: null, duplex: null },
      address: up && has(n.dhcp) ? '192.168.1.84' : null,
      dhcp: up ? n.dhcp : 'UNKNOWN',
      gateway: { address: up && has(n.dhcp) ? '192.168.1.1' : null, status: up ? n.gateway : 'UNKNOWN' },
      dns: { address: up && has(n.dhcp) ? '1.1.1.1' : null, status: up ? n.dns : 'UNKNOWN' },
      internet: up ? n.internet : 'UNKNOWN',
      latency: up && has(n.gateway) ? Math.round(this.between(n.latency)) : null,
      loss: up && has(n.gateway) ? round(this.between(n.loss), 1) : null,
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
