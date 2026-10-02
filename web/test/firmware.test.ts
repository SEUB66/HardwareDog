import Ajv from 'ajv';
import { afterAll, describe, expect, it } from 'vitest';
import schema from '../../protocol/hdp_v1.json';
import { DogdTransport } from '../src/core/dogd';
import { decodeFrame, type DeviceFrame, type HostCommand } from '../src/core/protocol';
import { System, memoryStore } from '../src/core/system';
import type { Transport, TransportSink } from '../src/core/transport';
import { createLineDecoder } from '../src/core/transport';

/**
 * LVL 60 GATE, the part a PC can prove:
 *
 *   SIMULATOR   PASS   (protocol-contract.test.ts)
 *   FIRMWARE    PASS   this file: the firmware core (firmware/components/hdp),
 *                      built for a PC with a register-level INA226, must emit
 *                      only frames that validate against protocol/hdp_v1.json,
 *                      and the engine must read them like the simulator's
 *   REPLAY      PASS   (session.test.ts)
 *
 * What a PC cannot prove (I2C timing, the real INA226, USB, Wi-Fi) is
 * checked on the board: docs/FIRMWARE.md, bring-up. Not claimed here.
 *
 *   FIRMWARE_HOST_BIN=../firmware/host/build/hwdog-host [DOGD_BIN=...]
 */

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BIN = env['FIRMWARE_HOST_BIN'];
const DOGD = env['DOGD_BIN'];
const T0 = 1_759_000_000_000;

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validFrame = ajv.getSchema(`${schema.$id}#/definitions/deviceFrame`)!;

interface Child {
  stdin: { write(s: string): void; end(): void };
  stdout: { on(e: 'data', f: (b: Uint8Array) => void): void };
  stderr: { on(e: 'data', f: (b: Uint8Array) => void): void };
  on(e: 'exit', f: (code: number) => void): void;
  kill(): void;
}
const node = async <T,>(name: string) => (await import(/* @vite-ignore */ ['node', name].join(':'))) as T;
const children: Child[] = [];
afterAll(() => children.forEach((c) => c.kill()));

async function spawn(bin: string, args: string[]): Promise<Child> {
  const cp = await node<{ spawn(bin: string, args: string[]): Child }>('child_process');
  const c = cp.spawn(bin, args);
  children.push(c);
  return c;
}

/** Run the firmware core on a PC; commands go in on stdin, HDP comes out. */
async function firmware(scenario: string, seconds: number, commands: string[] = []): Promise<string[]> {
  const c = await spawn(BIN!, ['--fast', '--scenario', scenario, '--seconds', String(seconds)]);
  let out = '';
  const text = new TextDecoder();
  c.stdout.on('data', (b) => (out += text.decode(b, { stream: true })));
  for (const cmd of commands) c.stdin.write(cmd + '\n');
  c.stdin.end();
  await new Promise<void>((resolve, reject) => c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`)))));
  return out.split('\n').filter((l) => l !== '');
}

/** Feeds text lines to the System through the real line decoder. */
class LinesTransport implements Transport {
  readonly kind = 'WEB SERIAL' as const;
  readonly origin = 'SIMULATED' as const; // a PC build of the firmware, not a board
  readonly label = 'FIRMWARE HOST BUILD';
  constructor(private readonly lines: string[]) {}
  async open(sink: TransportSink) {
    const d = createLineDecoder(sink);
    for (const l of this.lines) d.push(l + '\n');
  }
  send(_cmd: HostCommand) {}
  async close() {}
}

/** Host time follows the device: T0 + frame time. Same on every path. */
class Clocked implements Transport {
  now = T0;
  frames = 0;
  constructor(readonly inner: Transport) {}
  get kind() {
    return this.inner.kind;
  }
  get label() {
    return this.inner.label;
  }
  get origin() {
    return this.inner.origin;
  }
  open(sink: TransportSink) {
    return this.inner.open({
      ...sink,
      frame: (f: DeviceFrame) => {
        this.now = T0 + f.t;
        this.frames++;
        sink.frame(f);
      },
    });
  }
  send(cmd: HostCommand) {
    this.inner.send(cmd);
  }
  close() {
    return this.inner.close();
  }
}

async function engine(lines: string[]) {
  const c = new Clocked(new LinesTransport(lines));
  const sys = new System(memoryStore(), () => c.now);
  await sys.boot(c, () => {}, 0);
  sys.evaluate(c.now);
  return sys;
}

function contract(lines: string[]) {
  for (const line of lines) {
    const json: unknown = JSON.parse(line);
    expect(validFrame(json), `${line}\n${ajv.errorsText(validFrame.errors)}`).toBe(true);
    const decoded = decodeFrame(line);
    expect(decoded.ok, line).toBe(true);
  }
}

describe.runIf(BIN)('firmware core (host build)', { timeout: 60_000 }, () => {
  for (const scenario of ['healthy', 'sag', 'serial', 'noina', 'wrongchip', 'i2cflaky', 'nopullup', 'router']) {
    it(`${scenario}: every frame validates against HDP v1`, async () => {
      const lines = await firmware(scenario, 30);
      expect(lines.length).toBeGreaterThan(scenario.startsWith('no') || scenario === 'wrongchip' ? 5 : 1000);
      contract(lines);
      const t = lines.map((l) => (JSON.parse(l) as { t: number }).t);
      for (let k = 1; k < t.length; k++) expect(t[k]).toBeGreaterThanOrEqual(t[k - 1]!); // rule 2
    });
  }

  it('answers every HDP command with valid frames, and rejects bad ones in HDP', async () => {
    const lines = await firmware('healthy', 2, [
      '{"cmd":"hello","proto":1}',
      '{"cmd":"i2c.scan"}',
      '{"cmd":"uart.config","baud":9600}',
      '{"cmd":"uart.tx","data":"AT+RST"}',
      '{"cmd":"net.refresh"}',
      '{"cmd":"usb.enumerate"}',
      '{"cmd":"probe","id":"p1","target":"192.168.1.1","tests":["PING","DNS"]}',
      'not json',
      '{"cmd":"uart.config","baud":1}',
      '{"cmd":"warp"}',
    ]);
    contract(lines);
    const frames = lines.map((l) => JSON.parse(l) as DeviceFrame);
    const scan = frames.find((f) => f.type === 'i2c.scan');
    expect(scan).toMatchObject({ speed: 100000, devices: [{ addr: 0x3c }, { addr: 0x76 }] });
    expect(frames.some((f) => f.type === 'uart.config' && f.baud === 9600)).toBe(true);
    // The host build has probes (a simulated LAN): results come back in the background.
    expect(frames.filter((f) => f.type === 'probe.result').map((f) => (f.type === 'probe.result' ? `${f.test} ${f.status}` : ''))).toEqual(['PING PASS', 'DNS PASS']);
    expect(frames.some((f) => f.type === 'probe.done')).toBe(true);
    const rejected = frames.filter((f) => f.type === 'log' && f.message.startsWith('command rejected'));
    expect(rejected).toHaveLength(3);
  });

  it('the engine reads the firmware like the simulator: a sagging rail is a SUPPLY SAG with evidence', async () => {
    const sys = await engine(await firmware('sag', 30));
    expect(sys.frameErrors).toBe(0);
    expect(sys.device.id).toBe('HD-HOST01');
    expect(sys.facts.drops.length).toBe(3); // bursts at 3 s, 12 s, 21 s
    const d = sys.diagnoses.find((x) => x.id === 'SUPPLY_SAG');
    expect(d?.confidence).toBe('MEDIUM');
    expect(d!.evidence.length).toBe(3);
    expect(sys.power.minVoltage).toBeLessThan(4.65);
  });

  it('LVL 65: the firmware says what its numbers are worth, and takes a calibration', async () => {
    const sys = await engine(await firmware('healthy', 2));
    expect(sys.meter).toMatchObject({ sensor: 'INA226', basis: 'DATASHEET', cal: null, rate_hz: 50, v_err: { pct: 0.1, abs: 0.00875 } });
    expect(sys.meter!.i_err.pct).toBeCloseTo(1.1, 6);

    const lines = await firmware('healthy', 2, [
      '{"cmd":"meter.cal","date":"2026-10-02","ref":"Fluke 87V","v_gain":1.02,"i_gain":1,"i_offset":0,"v_err":0.002,"i_err":0.0003}',
    ]);
    contract(lines);
    const cal = await engine(lines);
    expect(cal.meter).toMatchObject({ basis: 'CALIBRATION', cal: { date: '2026-10-02', ref: 'Fluke 87V', v_gain: 1.02 } });
    // The rail is 5.05 V: after the command, the samples carry the gain.
    expect(cal.power.voltage).toBeGreaterThan(5.1);
  });

  it('LVL 80: a sensor on a loose wire is an I2C device that disappears', async () => {
    const sys = await engine(await firmware('i2cflaky', 40));
    expect(sys.bus.watchMs).toBe(3000);
    const d = sys.diagnoses.find((x) => x.id === 'I2C_DEVICE_DISAPPEARED');
    expect(d?.confidence).toBe('HIGH');
    expect(d?.basis).toMatch(/0x76/);
    expect(sys.diagnoses.map((x) => x.id)).toEqual(['I2C_DEVICE_DISAPPEARED']);
  });

  it('LVL 80: missing pull-ups are a bus fault, never an empty scan', async () => {
    const lines = await firmware('nopullup', 12);
    expect(lines.some((l) => l.includes('"type":"i2c.scan"'))).toBe(false);
    const sys = await engine(lines);
    expect(sys.diagnoses.map((x) => `${x.id}:${x.confidence}`)).toEqual(['I2C_BUS_INSTABILITY:HIGH']);
    expect(sys.diagnoses[0]!.next).toMatch(/pull-ups/);
  });

  it('LVL 80: the router reboots with the rail, the chain is on the timeline', async () => {
    const sys = await engine(await firmware('router', 30));
    expect(sys.diagnoses.map((x) => x.id).sort()).toEqual(['NETWORK_POWER_LOSS', 'SUPPLY_SAG']);
    const d = sys.diagnoses.find((x) => x.id === 'NETWORK_POWER_LOSS')!;
    expect(d.confidence).toBe('HIGH');
    expect(d.correlation).toMatch(/voltage drop .* > link down \+\d+ ms > up \+\d+ ms > DHCP \+\d+ ms > DNS \+\d+ ms/);
    expect(sys.trace.all().some((e) => e.message === 'network back')).toBe(true);
  });

  it('a healthy board gives no finding', async () => {
    const sys = await engine(await firmware('healthy', 30));
    expect(sys.diagnoses).toEqual([]);
    expect(sys.power.voltage).toBeGreaterThan(5);
  });

  it('a wrong baud rate on the target UART is diagnosed', async () => {
    const sys = await engine(await firmware('serial', 30));
    expect(sys.diagnoses.map((d) => d.id)).toContain('SERIAL_CONFIGURATION_MISMATCH');
  });

  it('no INA226: no power numbers, and the reason is on the timeline', async () => {
    const sys = await engine(await firmware('noina', 5));
    expect(sys.power.sampleCount).toBe(0);
    expect(sys.trace.all().some((e) => e.message.includes('INA226 not answering'))).toBe(true);
  });

  it.runIf(DOGD)('FIRMWARE -> TCP -> dogd -> interface == FIRMWARE -> interface', async () => {
    const direct = await engine(await firmware('sag', 30));

    const port = 41000 + Math.floor(Math.random() * 2000);
    const fw = await spawn(BIN!, ['--fast', '--scenario', 'sag', '--seconds', '30', '--tcp', String(port), '--wait-hello', '2']);
    await new Promise<void>((r) => fw.stderr.on('data', (b) => new TextDecoder().decode(b).includes('LISTEN') && r()));
    const dogd = await spawn(DOGD!, ['serve', '--listen', '127.0.0.1:0', '--source', `tcp:127.0.0.1:${port}`, '--source-origin', 'simulated', '--data', `/tmp/dogd-fw-${port}`]);
    const base = await new Promise<string>((r) => {
      let s = '';
      dogd.stdout.on('data', (b) => {
        s += new TextDecoder().decode(b);
        const m = /LISTEN\s+(\S+)/.exec(s);
        if (m) r(`http://${m[1]}`);
      });
    });
    const deadline = Date.now() + 10_000;
    while ((await fetch(`${base}/v1/link`).then((r) => r.json() as Promise<{ state: string }>)).state !== 'ONLINE') {
      if (Date.now() > deadline) throw new Error('dogd never connected to the firmware');
      await new Promise((r) => setTimeout(r, 20));
    }
    const c = new Clocked(await DogdTransport.prepare(base));
    const sys = new System(memoryStore(), () => c.now);
    await sys.boot(c, () => {}, 0);
    const end = Date.now() + 20_000;
    while (c.frames < direct.trace.all().length && sys.link === 'ONLINE' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    // the firmware ends its run after 30 s of device time and closes the link
    while (sys.link === 'ONLINE' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    sys.evaluate(c.now);

    expect(sys.facts).toEqual(direct.facts);
    expect(sys.diagnoses.map((d) => [d.id, d.confidence, d.evidence])).toEqual(direct.diagnoses.map((d) => [d.id, d.confidence, d.evidence]));
    expect(sys.frameErrors).toBe(0);
  });
});
