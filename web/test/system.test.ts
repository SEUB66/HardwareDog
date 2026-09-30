import { describe, expect, it } from 'vitest';
import { System, memoryStore } from '../src/core/system';
import { buildReport, reportToText } from '../src/core/report';
import { FakeTransport, attach, connectedSystem } from './helpers';

const messages = (sys: System) => sys.trace.all().map((e) => `${e.source} ${e.severity} ${e.message}`);

describe('System clock', () => {
  it('maps device uptime onto host wall-clock time', async () => {
    const { sys, transport } = await connectedSystem();
    transport.push({ type: 'power', t: 1500, v: 5.04, i: 0.3 });
    const last = sys.power.samples.at(-1)!;
    expect(last.t).toBe(1_001_500);
  });
});

describe('undervoltage rule', () => {
  it('flags one drop per event, with hysteresis on recovery', async () => {
    const { sys, transport } = await connectedSystem();
    const v = [5.05, 4.7, 4.61, 4.74, 4.77, 4.72, 4.81, 5.02];
    v.forEach((volts, n) => transport.push({ type: 'power', t: 100 + n * 10, v: volts, i: 0.3 }));
    // 4.77 is above the 4.75 threshold but inside the 50 mV hysteresis band,
    // so 4.72 is still the same event.
    expect(sys.power.dropCount).toBe(1);
    expect(sys.power.minVoltage).toBe(4.61);
    expect(sys.power.condition).toBe('STABLE');
    const log = messages(sys);
    expect(log.filter((m) => m === 'POWER WARN voltage drop')).toHaveLength(1);
    expect(log.filter((m) => m === 'POWER PASS voltage recovered')).toHaveLength(1);
  });
});

describe('USB / power correlation rule', () => {
  it('correlates a disconnect inside the window and ignores one outside it', async () => {
    const { sys, transport } = await connectedSystem();
    transport.push(attach(0));
    transport.push({ type: 'power', t: 1000, v: 4.61, i: 0.7 });
    transport.push({ type: 'usb.detach', t: 1070 });
    expect(sys.usb.correlatedDisconnects).toBe(1);

    transport.push({ type: 'power', t: 1100, v: 5.05, i: 0.3 });
    transport.push(attach(2000));
    transport.push({ type: 'power', t: 2100, v: 5.05, i: 0.3 });
    transport.push({ type: 'usb.detach', t: 3000 });
    expect(sys.usb.disconnects).toBe(2);
    expect(sys.usb.correlatedDisconnects).toBe(1);
    expect(messages(sys)).toContain('RULE WARN disconnect 70 ms after voltage drop');
  });

  it('keeps observation, correlation and cause separate in the report', async () => {
    const { sys, transport, clock } = await connectedSystem();
    transport.push(attach(0));
    for (let k = 0; k < 3; k++) {
      const base = 1000 + k * 2000;
      transport.push({ type: 'power', t: base, v: 4.6, i: 0.7 });
      transport.push({ type: 'usb.detach', t: base + 60 });
      transport.push({ type: 'power', t: base + 100, v: 5.05, i: 0.3 });
      transport.push(attach(base + 1000));
    }
    clock.set(1_010_000);
    const report = buildReport(sys, clock.get());
    expect(report.findings.map((f) => f.kind)).toEqual(['OBSERVED', 'OBSERVED', 'CORRELATION', 'POSSIBLE CAUSE']);
    const text = reportToText(report);
    expect(text).toContain('3 / 3 disconnects occurred within 100 ms of a voltage drop below 4.75 V.');
    expect(text).toContain('POWER INSTABILITY');
    expect(text).toContain('!! SIMULATED DATA');
  });

  it('does not claim a cause when only a minority of disconnects line up', async () => {
    const { sys, transport } = await connectedSystem();
    transport.push(attach(0));
    transport.push({ type: 'power', t: 1000, v: 4.6, i: 0.7 });
    transport.push({ type: 'usb.detach', t: 1050 });
    transport.push({ type: 'power', t: 1200, v: 5.05, i: 0.3 });
    for (const t of [3000, 6000]) {
      transport.push(attach(t - 500));
      transport.push({ type: 'usb.detach', t });
    }
    const kinds = buildReport(sys).findings.map((f) => f.kind);
    expect(kinds).toContain('CORRELATION');
    expect(kinds).not.toContain('POSSIBLE CAUSE');
  });
});

describe('UART framing rule', () => {
  it('raises a baud mismatch hypothesis after repeated framing errors', async () => {
    const { sys, transport } = await connectedSystem();
    for (let n = 0; n < 3; n++) transport.push({ type: 'uart.error', t: 100 + n * 100, kind: 'framing' });
    expect(sys.serial.errors).toBe(3);
    expect(messages(sys)).toContain('RULE WARN possible cause: baud rate mismatch');
  });
});

describe('I2C', () => {
  it('reports unconfirmed addresses as UNKNOWN, never a guessed identity', async () => {
    const { sys, transport } = await connectedSystem();
    transport.push({
      type: 'i2c.scan',
      t: 10,
      speed: 400000,
      devices: [
        { addr: 0x40, ident: 'INA226', method: 'register' },
        { addr: 0x52, ident: null, method: null },
      ],
    });
    expect(sys.bus.devices[1]!.confirmed).toBeNull();
    expect(messages(sys)).toContain('I2C INFO 0x52 UNKNOWN');
  });
});

describe('actions', () => {
  it('refuses active operations without a link, and says why', async () => {
    const sys = new System(memoryStore());
    expect(sys.scanI2c()).toBe('i2c scan: no device link (OFFLINE)');
    expect(sys.probe('192.168.1.1', ['PING'])).toBe('probe: no device link (OFFLINE)');
  });

  it('validates probe targets before sending anything', async () => {
    const { sys, transport } = await connectedSystem();
    expect(sys.probe('bad target; rm', ['PING'])).toMatch(/invalid target/);
    expect(sys.probe('192.168.1.1', [])).toBe('no tests selected');
    expect(transport.sent).toHaveLength(0);
    const run = sys.probe('192.168.1.1', ['PING', 'DNS']);
    expect(typeof run).toBe('object');
    expect(transport.sent[0]).toMatchObject({ cmd: 'probe', target: '192.168.1.1', tests: ['PING', 'DNS'] });
  });

  it('records a failed link open as an explicit error', async () => {
    const sys = new System(memoryStore());
    const t = new FakeTransport();
    t.failOpen = 'port busy';
    expect(await sys.connect(t)).toBe(false);
    expect(sys.lastError).toMatchObject({ what: 'LINK OPEN FAILED', detail: 'port busy' });
  });

  it('records a lost link with what, where and when', async () => {
    const { sys, transport, clock } = await connectedSystem();
    clock.set(1_005_000);
    transport.sink!.lost('device unplugged');
    expect(sys.link).toBe('LOST');
    expect(sys.lastError).toMatchObject({ what: 'DEVICE LINK LOST', when: 1_005_000, detail: 'device unplugged' });
  });

  it('persists settings through the store', () => {
    const store = memoryStore();
    new System(store).updateSettings({ sound: true });
    expect(new System(store).settings.sound).toBe(true);
  });
});
