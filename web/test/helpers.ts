import type { DeviceFrame, HostCommand } from '../src/core/protocol';
import type { Transport, TransportSink } from '../src/core/transport';
import { System, memoryStore } from '../src/core/system';
import { SimulatedDevice } from '../src/core/simulator';
import type { ScenarioId } from '../src/core/scenarios';

/** A transport whose frames are pushed by the test. */
export class FakeTransport implements Transport {
  readonly kind = 'SIMULATOR' as const;
  readonly label = 'FAKE';
  sink: TransportSink | null = null;
  sent: HostCommand[] = [];
  failOpen: string | null = null;

  async open(sink: TransportSink): Promise<void> {
    if (this.failOpen) throw new Error(this.failOpen);
    this.sink = sink;
  }
  send(cmd: HostCommand): void {
    this.sent.push(cmd);
  }
  async close(): Promise<void> {
    this.sink = null;
  }
  push(frame: DeviceFrame): void {
    this.sink!.frame(frame);
  }
}

/** A system with a controllable clock. Device uptime 0 == host time 1_000_000. */
export async function connectedSystem() {
  let now = 1_000_000;
  const clock = { set: (t: number) => (now = t), get: () => now };
  const sys = new System(memoryStore(), () => now);
  const transport = new FakeTransport();
  await sys.connect(transport);
  transport.push({ type: 'hello', t: 0, proto: 1, device: 'HD-001', rev: 'A', fw: '0.1.0' });
  return { sys, transport, clock };
}

export const attach = (t: number): DeviceFrame => ({
  type: 'usb.attach',
  t,
  speed: 'FULL', // ESP32-S3 USB Serial/JTAG is a full-speed (12 Mbps) device
  vid: 0x303a,
  pid: 0x1001,
  cls: 'CDC',
  power: 'BUS',
  manufacturer: 'Espressif',
  product: 'USB JTAG/Serial',
  serial: null,
});

/** Run a simulated session in manual time and return the final diagnosis. */
export async function runScenario(scenario: ScenarioId, seed: number, sessionMs = 90_000) {
  let now = 0;
  const sys = new System(memoryStore(), () => now);
  const sim = new SimulatedDevice({ seed, manual: true, scenario });
  await sys.boot(sim, () => {}, 0);
  for (let elapsed = 0; elapsed < sessionMs; elapsed += 100) {
    sim.advance(100);
    now = sim.uptime;
  }
  return { sys, sim, diagnoses: sys.evaluate(now) };
}
