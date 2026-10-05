/**
 * A simulated pack: one simulated world (core/simulator.ts, one incident),
 * watched by several simulated Dogs. Each Dog observes some capabilities,
 * booted at its own moment (its clock is not the others'), and sits behind
 * its own link with its own latency. Every frame is still HDP text through
 * the real decoder: the pack logic cannot tell it from real probes.
 *
 * Time only moves through advance() (tests) or the world's own timer (the
 * interface); frames reach the host when their link latency has passed.
 */

import type { Capability, DeviceFrame, HostCommand } from './protocol';
import { LineSplitter, PROTOCOL_VERSION, capabilityOf } from './protocol';
import { prng, SimulatedDevice, type SimulatorOptions } from './simulator';
import type { Transport, TransportSink } from './transport';
import { PackTransport, createLineDecoder } from './transport';

export interface SimDog {
  /** Place in the pack: D1, D2... */
  dog: string;
  /** What it says in its hello. */
  device: string;
  caps: Capability[];
  /** It booted this long before the world's t = 0: its clock reads that much more. */
  bootedBeforeMs: number;
  /** One-way link latency, ms, drawn in [min, max] for every frame and command. */
  latencyMs: [number, number];
}

interface InFlight {
  at: number;
  text: string;
}

class Hub {
  readonly world: SimulatedDevice;
  private readonly rand: () => number;
  private readonly sinks = new Map<string, ReturnType<typeof createLineDecoder>>();
  private readonly flight = new Map<string, InFlight[]>();
  private readonly lastDue = new Map<string, number>();
  private readonly splitter: LineSplitter;
  private started = false;
  private closed = 0;
  private readonly manual: boolean;

  constructor(
    readonly dogs: readonly SimDog[],
    options: SimulatorOptions,
  ) {
    this.world = new SimulatedDevice(options);
    this.manual = options.manual ?? false;
    this.rand = prng((options.seed ?? 0x0d06) ^ 0x9ac4);
    this.splitter = new LineSplitter((line) => this.route(JSON.parse(line) as DeviceFrame));
    for (const d of dogs) {
      this.flight.set(d.dog, []);
      this.lastDue.set(d.dog, -Infinity);
    }
  }

  open(dog: string, sink: TransportSink): void {
    this.sinks.set(dog, createLineDecoder(sink));
    if (this.sinks.size === this.dogs.length && !this.started) {
      this.started = true;
      this.world.attachWire((text) => {
        this.splitter.push(text);
        if (!this.manual) this.flush(this.world.uptime);
      });
    }
  }

  close(): void {
    if (++this.closed === this.dogs.length) void this.world.close();
  }

  /** The world frame `f` (on the world clock) as each Dog that observes it sees it. */
  private route(f: DeviceFrame): void {
    if (f.type === 'hello') {
      for (const d of this.dogs) {
        this.toHost(d, { type: 'hello', t: f.t + d.bootedBeforeMs, proto: PROTOCOL_VERSION, device: d.device, rev: 'SIM', fw: f.fw, caps: d.caps }, f.t);
      }
      return;
    }
    const cap = capabilityOf(f.type);
    const d = cap === null ? this.dogs[0]! : this.dogs.find((x) => x.caps.includes(cap));
    if (d) this.toHost(d, { ...f, t: f.t + d.bootedBeforeMs }, f.t);
  }

  private latency(d: SimDog): number {
    const [a, b] = d.latencyMs;
    return a + this.rand() * (b - a);
  }

  /** On the wire to the host: arrives after the link latency, in order. */
  private toHost(d: SimDog, f: DeviceFrame, worldT: number): void {
    const due = Math.max(this.lastDue.get(d.dog)!, worldT + this.latency(d));
    this.lastDue.set(d.dog, due);
    this.flight.get(d.dog)!.push({ at: due, text: JSON.stringify(f) + '\n' });
  }

  /** Deliver everything whose latency has passed by world time `t`, oldest first. */
  flush(t: number): void {
    for (;;) {
      let next: { dog: string; item: InFlight } | null = null;
      for (const d of this.dogs) {
        const item = this.flight.get(d.dog)![0];
        if (item && item.at <= t && (!next || item.at < next.item.at)) next = { dog: d.dog, item };
      }
      if (!next) return;
      this.flight.get(next.dog)!.shift();
      this.sinks.get(next.dog)?.push(next.item.text);
    }
  }

  /** A command for Dog `dog`, sent now: it reaches the Dog after the link latency. */
  command(dog: string, cmd: HostCommand): void {
    const d = this.dogs.find((x) => x.dog === dog)!;
    const reached = this.world.uptime + this.latency(d);
    if (cmd.cmd === 'time') {
      this.toHost(d, { type: 'time', t: Math.round(reached + d.bootedBeforeMs), id: cmd.id }, reached);
      return;
    }
    if (cmd.cmd === 'hello') return;
    this.world.send(cmd);
  }
}

class SimulatedDog implements Transport {
  readonly kind = 'SIMULATOR' as const;
  readonly origin = 'SIMULATED' as const;
  readonly label: string;

  constructor(
    private readonly hub: Hub,
    private readonly dog: SimDog,
  ) {
    this.label = `SIMULATED DOG ${dog.device} (${dog.caps.join(' ')})`;
  }

  async open(sink: TransportSink): Promise<void> {
    this.hub.open(this.dog.dog, sink);
  }

  send(cmd: HostCommand): void {
    this.hub.command(this.dog.dog, cmd);
  }

  async close(): Promise<void> {
    this.hub.close();
  }
}

/** The usual bench: one Dog on the supply, one on the target, one on the network. */
export const BENCH_PACK: readonly SimDog[] = [
  { dog: 'D1', device: 'HD-P0WER', caps: ['power'], bootedBeforeMs: 12_345, latencyMs: [1, 4] },
  { dog: 'D2', device: 'HD-TARGET', caps: ['usb', 'uart', 'i2c'], bootedBeforeMs: 777, latencyMs: [1, 3] },
  { dog: 'D3', device: 'HD-NET', caps: ['net', 'probe'], bootedBeforeMs: 3_600_000, latencyMs: [2, 6] },
];

/** A pack of simulated Dogs around one simulated incident. */
export class SimulatedPack extends PackTransport {
  private readonly hub: Hub;

  constructor(options: SimulatorOptions & { dogs?: readonly SimDog[] } = {}) {
    const hub = new Hub(options.dogs ?? BENCH_PACK, options);
    super(hub.dogs.map((d) => ({ dog: d.dog, link: new SimulatedDog(hub, d) })));
    this.hub = hub;
  }

  /**
   * Move the world forward (manual mode) and deliver what has arrived.
   * `beforeDelivery` lets a test set the host clock to the arrival time.
   */
  advance(ms: number, beforeDelivery?: (worldT: number) => void): void {
    this.hub.world.advance(ms);
    beforeDelivery?.(this.hub.world.uptime);
    this.hub.flush(this.hub.world.uptime);
  }

  /** The fault scenario the pack is watching. */
  get scenario() {
    return this.hub.world.scenario;
  }

  /** World time, ms since the incident started. */
  get uptime(): number {
    return this.hub.world.uptime;
  }
}
