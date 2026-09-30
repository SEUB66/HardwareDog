import type { DeviceFrame, HostCommand } from '../src/core/protocol';
import type { Transport, TransportSink } from '../src/core/transport';
import { System, memoryStore } from '../src/core/system';

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
  speed: 'HIGH',
  vid: 0x303a,
  pid: 0x1001,
  cls: 'CDC',
  power: 'BUS',
  manufacturer: 'Espressif',
  product: 'USB JTAG/Serial',
  serial: null,
});
