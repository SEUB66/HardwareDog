import { describe, expect, it } from 'vitest';
import { SimulatedDevice } from '../src/core/simulator';
import { System, memoryStore } from '../src/core/system';

async function run(seed: number, seconds: number) {
  let now = 0;
  const sys = new System(memoryStore(), () => now);
  const sim = new SimulatedDevice({ seed, manual: true });
  const steps = await sys.boot(sim, () => {}, 0);
  for (let s = 0; s < seconds * 10; s++) {
    sim.advance(100);
    now = sim.uptime;
  }
  return { sys, sim, steps };
}

describe('SimulatedDevice', () => {
  it('boots through the real protocol decoder with no frame errors', async () => {
    const { sys, steps } = await run(1, 5);
    expect(steps.find((s) => s.label === 'HARDWARE INTERFACE')?.status).toBe('OK');
    expect(sys.frameErrors).toBe(0);
    expect(sys.device.id).toBe('HD-001');
    expect(sys.usb.connected).toBe(true);
    expect(sys.power.sampleCount).toBeGreaterThan(200);
    expect(sys.net.gateway.status).toBe('PASS');
  });

  it('is deterministic for a given seed', async () => {
    const a = await run(7, 30);
    const b = await run(7, 30);
    expect(a.sys.power.minVoltage).toBe(b.sys.power.minVoltage);
    expect(a.sys.usb.disconnects).toBe(b.sys.usb.disconnects);
  });

  it('produces power drops that the correlation rule picks up', async () => {
    const { sys } = await run(3, 120);
    expect(sys.power.dropCount).toBeGreaterThan(0);
    expect(sys.usb.disconnects).toBeGreaterThan(0);
    expect(sys.usb.correlatedDisconnects).toBe(sys.usb.disconnects);
  });

  it('answers an I2C scan and a probe', async () => {
    const { sys, sim } = await run(1, 2);
    sys.scanI2c();
    sys.probe('192.168.1.250', ['PING', 'TCP']);
    sim.advance(2000);
    expect(sys.bus.devices.map((d) => d.address)).toEqual([0x3c, 0x40, 0x52, 0x76]);
    const probe = sys.probes[0]!;
    expect(probe.finishedAt).not.toBeNull();
    expect(probe.results.map((r) => r.status)).toEqual(['FAIL', 'FAIL']);
  });

  it('garbles UART output and raises framing errors at the wrong baud rate', async () => {
    const { sys, sim } = await run(2, 2);
    sys.setBaud(9600);
    for (let n = 0; n < 200; n++) sim.advance(100);
    expect(sys.serial.errors).toBeGreaterThan(0);
  });
});
