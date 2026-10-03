import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import schema from '../../protocol/hdp_v1.json';
import { decodeFrame, encodeCommand, type DeviceFrame, type HostCommand } from '../src/core/protocol';
import { SCENARIO_IDS } from '../src/core/scenarios';
import { SimulatedDevice } from '../src/core/simulator';
import { SimulatedPack } from '../src/core/simpack';
import type { TransportSink } from '../src/core/transport';

/**
 * CONTRACT: ONE EVENT MODEL.
 *
 * protocol/hdp_v1.json is what every HDP producer must emit: the firmware
 * and the simulator alike. The trace engine must never be able to tell
 * which one produced a frame.
 */

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validateFrame = ajv.getSchema(`${schema.$id}#/definitions/deviceFrame`)! as (data: unknown) => boolean;
const validateCommand = ajv.getSchema(`${schema.$id}#/definitions/hostCommand`)! as (data: unknown) => boolean;
const lastErrors = (v: unknown) => ajv.errorsText((v as { errors?: Parameters<typeof ajv.errorsText>[0] }).errors);

/** Capture the raw frames a simulator session emits, in every scenario. */
async function capture(scenario: (typeof SCENARIO_IDS)[number], seconds: number) {
  const frames: DeviceFrame[] = [];
  const errors: string[] = [];
  const sink: TransportSink = { frame: (f) => frames.push(f), error: (m) => errors.push(m), lost: () => {} };
  const sim = new SimulatedDevice({ seed: 5, manual: true, scenario });
  await sim.open(sink);
  // Exercise every command path too.
  sim.send({ cmd: 'i2c.scan' });
  sim.send({ cmd: 'usb.enumerate' });
  sim.send({ cmd: 'net.refresh' });
  sim.send({ cmd: 'probe', id: 'p1', target: '192.168.1.1', tests: ['PING', 'DNS', 'TCP', 'HTTP'] });
  sim.send({ cmd: 'probe', id: 'p2', target: 'example.invalid', tests: ['DNS', 'HTTP'] });
  sim.send({ cmd: 'uart.tx', data: 'status' });
  sim.send({ cmd: 'time', id: 4294967295 });
  for (let k = 0; k < seconds * 10; k++) sim.advance(100);
  await sim.close();
  return { frames, errors };
}

describe('HDP v1 contract', () => {
  it('every simulator frame, in every scenario, validates against protocol/hdp_v1.json', async () => {
    const types = new Set<string>();
    for (const id of SCENARIO_IDS) {
      const { frames, errors } = await capture(id, 40);
      expect(errors, id).toEqual([]);
      for (const f of frames) {
        types.add(f.type);
        if (!validateFrame(f)) throw new Error(`${id} ${f.type}: ${lastErrors(validateFrame)}\n${JSON.stringify(f)}`);
      }
    }
    // The simulator exercises the whole device vocabulary.
    expect([...types].sort()).toEqual(
      ['hello', 'i2c.error', 'i2c.scan', 'log', 'net.status', 'power', 'power.meter', 'probe.done', 'probe.result', 'time', 'uart.config', 'uart.error', 'uart.rx', 'usb.attach', 'usb.detach'],
    );
  });

  it('every host command the interface can send validates', () => {
    const commands: HostCommand[] = [
      { cmd: 'hello', proto: 1 },
      { cmd: 'usb.enumerate' },
      { cmd: 'uart.config', baud: 115200 },
      { cmd: 'uart.tx', data: 'AT+RST' },
      { cmd: 'i2c.scan' },
      { cmd: 'net.refresh' },
      { cmd: 'probe', id: 'p1', target: '192.168.1.1', tests: ['PING', 'DNS', 'TCP'] },
      { cmd: 'meter.cal', date: '2026-10-02', ref: 'Fluke 87V', v_gain: 1.0012, i_gain: 0.991, i_offset: 0.0003, v_err: 0.002, i_err: 0.0004 },
      { cmd: 'meter.clear' },
      { cmd: 'i2c.watch', every_ms: 5000 },
      { cmd: 'i2c.watch', every_ms: 0 },
      { cmd: 'net.watch', every_ms: 10000, dns: 'example.com', upstream: 'example.org' },
      { cmd: 'net.watch', every_ms: 0 },
    ];
    for (const c of commands) {
      expect(validateCommand(JSON.parse(encodeCommand(c))), `${c.cmd}: ${lastErrors(validateCommand)}`).toBe(true);
    }
  });

  it('the decoder and the schema agree on invalid frames', () => {
    const bad = [
      '{"type":"power","t":-1,"v":5,"i":0}',
      '{"type":"power","t":1,"v":"5","i":0}',
      '{"type":"i2c.scan","t":1,"speed":400000,"devices":[{"addr":200}]}',
      '{"type":"warp","t":1}',
      '{"type":"time","t":1,"id":-1}',
      '{"type":"time","t":1,"id":1.5}',
      '{"type":"time","t":1}',
      '{"type":"i2c.error","t":1,"kind":"MELTED"}',
      '{"type":"power.meter","t":1,"sensor":"INA226","shunt_ohm":0,"v_max":36,"i_max":0.8,"v_res":0.00125,"i_res":0.0000245,"rate_hz":50,"v_err":{"pct":0.1,"abs":0.0075},"i_err":{"pct":1.1,"abs":0.0001},"basis":"DATASHEET","cal":null}',
      '{"type":"power.meter","t":1,"sensor":"INA226","shunt_ohm":0.1,"v_max":36,"i_max":0.8,"v_res":0.00125,"i_res":0.0000245,"rate_hz":50,"v_err":{"pct":-1,"abs":0.0075},"i_err":{"pct":1.1,"abs":0.0001},"basis":"DATASHEET","cal":null}',
    ];
    for (const raw of bad) {
      expect(decodeFrame(raw).ok, raw).toBe(false);
      expect(validateFrame(JSON.parse(raw)), raw).toBe(false);
    }
  });

  it('every frame of a simulated pack (three Dogs, time samples included) validates too', async () => {
    const frames: DeviceFrame[] = [];
    const errors: string[] = [];
    const pack = new SimulatedPack({ seed: 5, manual: true, scenario: 'HD-T016' });
    await pack.open({ frame: (f) => frames.push(f), error: (m) => errors.push(m), lost: () => {} });
    for (const dog of pack.dogs) pack.send({ cmd: 'time', id: 7 }, dog);
    for (let k = 0; k < 400; k++) pack.advance(100);
    await pack.close();
    expect(errors).toEqual([]);
    expect(frames.filter((f) => f.type === 'hello')).toHaveLength(3);
    expect(frames.filter((f) => f.type === 'time')).toHaveLength(3);
    for (const f of frames) if (!validateFrame(f)) throw new Error(`${f.type}: ${lastErrors(validateFrame)}\n${JSON.stringify(f)}`);
  });
});
