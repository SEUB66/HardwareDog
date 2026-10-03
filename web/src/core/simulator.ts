import type { DeviceFrame, HostCommand, MeterCalibration } from './protocol';
import type { Transport, TransportSink } from './transport';
import { createLineDecoder } from './transport';
import type { CheckStatus, ProbeTest } from './types';
import { CAPABILITIES, PROTOCOL_VERSION } from './protocol';
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
  readonly origin = 'SIMULATED' as const;
  readonly label: string;
  readonly scenario: Scenario;

  private readonly rand: () => number;
  private readonly manual: boolean;
  private readonly samplePeriod: number;
  private sink: TransportSink | null = null;
  private lines: ReturnType<typeof createLineDecoder> | null = null;
  private wire: ((text: string) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private t = 0;
  private queue: Scheduled[] = [];

  // Target state.
  private powered = false;
  private usbConnected = false;
  private baud = MONITOR_BAUD;
  /** Calibration stored by meter.cal, with the residuals it was given. */
  private cal: { cal: MeterCalibration; v_err: number; i_err: number } | null = null;
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
  /** Network device powered by the rail (followsPower): where it is in its reboot. */
  private netPhase: 'UP' | 'DOWN' | 'LINK' | 'DHCP' = 'UP';
  /** Periodic I2C scan (i2c watch). 0 = off. */
  private i2cWatchMs = 0;
  private i2cTimer = 0;
  /** The flaky device is off the bus until this time. */
  private i2cAbsentUntil = -1;

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
    this.start();
  }

  /**
   * Run as a device on a byte stream: HDP text goes to `write` instead of a
   * decoder, exactly what a firmware writes on its serial port. Used to put
   * the simulator behind dogd. Commands come back through send().
   */
  attachWire(write: (text: string) => void): void {
    this.wire = write;
    this.start();
  }

  private start(): void {
    this.t = 0;
    this.emit({ type: 'hello', t: 0, proto: PROTOCOL_VERSION, device: 'HD-001', rev: 'A', fw: '0.1.0', caps: [...CAPABILITIES] });
    this.emit({ type: 'uart.config', t: 0, port: 'UART0', baud: this.baud, bits: 8, parity: 'NONE', stop: 1 });
    this.emitMeter();
    this.emitNet();
    this.nextNetAt = 2000;
    this.nextChatterAt = 3000;
    const { supply, target } = this.scenario;
    if (supply.bursts) this.nextBurstAt = this.between(supply.bursts.every) - 2000;
    if (target.usbDrops) this.at(this.between(target.usbDrops.every), () => this.usbDrop());
    if (target.resetLoop) this.at(this.between(target.resetLoop.every), () => this.watchdogReset());
    if (target.spikes) this.at(this.between(target.spikes.every), () => this.spike());
    const i2c = this.scenario.i2c;
    if (i2c) {
      this.setI2cWatch(i2c.watchMs);
      if (i2c.flaky) this.at(this.between(i2c.flaky.every), () => this.i2cDrop());
    }
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
    this.wire = null;
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
        this.at(this.t + 260, () => this.emitScan());
        break;
      case 'i2c.watch':
        this.setI2cWatch(cmd.every_ms);
        break;
      case 'net.watch':
        // The simulated network is checked on every report already.
        this.at(this.t + 30, () => this.emitNet());
        break;
      case 'net.refresh':
        this.at(this.t + 30, () => this.emitNet());
        break;
      case 'probe':
        this.runProbe(cmd.id, cmd.target, cmd.tests);
        break;
      case 'time':
        // The clock now, at once: what a pack aligns Dogs with.
        this.emit({ type: 'time', t: this.t, id: cmd.id });
        break;
      case 'meter.cal': {
        const { cmd: _cmd, v_err, i_err, ...cal } = cmd;
        this.cal = { cal, v_err, i_err };
        this.at(this.t + 5, () => this.emitMeter());
        break;
      }
      case 'meter.clear':
        this.cal = null;
        this.at(this.t + 5, () => this.emitMeter());
        break;
    }
  }

  /**
   * The simulated meter declares the accuracy of the INA226 it imitates,
   * from the datasheet (or from the calibration it was given). Its sensor
   * name says it is simulated: rule 6, no identity it does not have.
   */
  private emitMeter(): void {
    const c = this.cal;
    this.emit({
      type: 'power.meter',
      t: this.t,
      sensor: 'SIMULATED INA226',
      shunt_ohm: 0.1,
      v_max: 36,
      i_max: 0.8,
      v_res: 0.00125,
      i_res: 0.0000245,
      rate_hz: 50,
      // Same figures as the firmware: datasheet worst case, or residual + one LSB.
      v_err: c ? { pct: 0, abs: c.v_err + 0.00125 } : { pct: 0.1, abs: 0.00875 },
      i_err: c ? { pct: 0, abs: c.i_err + 0.0000245 } : { pct: 1.1, abs: 0.0001245 },
      basis: c ? 'CALIBRATION' : 'DATASHEET',
      cal: c ? c.cal : null,
    });
  }

  // ---------------------------------------------------------------- internals

  private between([min, max]: Range): number {
    return min + this.rand() * (max - min);
  }

  private emit(frame: DeviceFrame): void {
    // Serialize and decode like a real link would.
    const text = JSON.stringify(frame) + '\n';
    if (this.wire) this.wire(text);
    else this.lines?.push(text);
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', t: this.t, level, message });
  }

  private at(at: number, run: () => void): void {
    this.queue.push({ at, run });
    this.queue.sort((a, b) => a.at - b.at);
  }

  private advanceTo(target: number): void {
    while (this.sink || this.wire) {
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

    // A stored calibration corrects the reading, as on the device.
    const g = this.cal?.cal;
    const v = g ? voltage * g.v_gain : voltage;
    const i = g ? Math.max(0, current) * g.i_gain + g.i_offset : Math.max(0, current);
    this.emit({ type: 'power', t, v: round(v, 3), i: round(i, 4) });

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

  private setI2cWatch(everyMs: number): void {
    this.i2cWatchMs = everyMs >= 1000 ? everyMs : 0;
    const timer = ++this.i2cTimer;
    const tick = () => {
      if (timer !== this.i2cTimer || this.i2cWatchMs === 0) return;
      this.emitScan(true);
      this.at(this.t + this.i2cWatchMs, tick);
    };
    if (this.i2cWatchMs) this.at(this.t + this.i2cWatchMs, tick);
  }

  /** One scan of the target bus: a stuck line is a bus fault, never an empty scan. */
  private emitScan(periodic = false): void {
    const fault = this.scenario.i2c?.fault;
    if (fault) {
      this.emit({ type: 'i2c.error', t: this.t, kind: fault.kind, detail: 'line low while the bus is idle', ...(periodic ? { every_ms: this.i2cWatchMs } : {}) });
      return;
    }
    const flaky = this.scenario.i2c?.flaky;
    const devices = [
      { addr: 0x3c, ident: null, method: null },
      { addr: 0x40, ident: 'INA226', method: 'manufacturer ID register 0xFE = 0x5449' },
      { addr: 0x52, ident: null, method: null },
      { addr: 0x76, ident: 'BME280', method: 'chip ID register 0xD0 = 0x60' },
    ].filter((d) => !(flaky && d.addr === flaky.addr && this.t < this.i2cAbsentUntil));
    this.emit({ type: 'i2c.scan', t: this.t, speed: 400000, devices, ...(periodic ? { every_ms: this.i2cWatchMs } : {}) });
  }

  /** The loose wire: the flaky device leaves the bus for a while. */
  private i2cDrop(): void {
    const flaky = this.scenario.i2c!.flaky!;
    this.i2cAbsentUntil = this.t + this.between(flaky.outage);
    this.at(this.t + this.between(flaky.every), () => this.i2cDrop());
  }

  /** The network device behind the port reboots with the rail: link, then DHCP, then DNS. */
  private setNetPhase(phase: 'UP' | 'DOWN' | 'LINK' | 'DHCP'): void {
    this.netPhase = phase;
    this.emitNet();
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
    if (this.scenario.net.followsPower && this.netPhase === 'UP') {
      const down = 100 + Math.round(this.rand() * 300);
      const link = down + 2500 + Math.round(this.rand() * 1500);
      const dhcp = link + 900 + Math.round(this.rand() * 900);
      const dns = dhcp + 300 + Math.round(this.rand() * 300);
      this.at(this.t + down, () => this.setNetPhase('DOWN'));
      this.at(this.t + link, () => this.setNetPhase('LINK'));
      this.at(this.t + dhcp, () => this.setNetPhase('DHCP'));
      this.at(this.t + dns, () => this.setNetPhase('UP'));
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
    const phase = this.netPhase;
    const base = this.scenario.net;
    // While the network device reboots: link first, then DHCP, then DNS.
    const n: Scenario['net'] =
      phase === 'UP'
        ? base
        : phase === 'DOWN'
          ? { ...base, link: false }
          : phase === 'LINK'
            ? { ...base, dhcp: 'PENDING', gateway: 'UNKNOWN', dns: 'UNKNOWN', internet: 'UNKNOWN' }
            : { ...base, dns: 'PENDING', internet: 'UNKNOWN' };
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
