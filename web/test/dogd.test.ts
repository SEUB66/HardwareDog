import { afterAll, describe, expect, it } from 'vitest';
import { DogdTransport, dogdLink, dogdStore } from '../src/core/dogd';
import type { DeviceFrame, HostCommand } from '../src/core/protocol';
import type { ScenarioId } from '../src/core/scenarios';
import { SessionRecorder, newHeader, parseHdlog, toHdlog } from '../src/core/session';
import { SimulatedDevice } from '../src/core/simulator';
import { System, memoryStore } from '../src/core/system';
import type { Transport, TransportSink } from '../src/core/transport';

/**
 * LVL 55 GATE: dogd is transparent.
 *
 *   SIMULATOR ── direct ─────────────────────────────> System
 *   SIMULATOR ── TCP ──> dogd ── WebSocket ──> DogdTransport ──> System
 *
 * Same frames, same facts, same diagnosis, same evidence references.
 * Runs against a real dogd binary: DOGD_BIN=../dogd/target/debug/dogd.
 */

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BIN = env['DOGD_BIN'];
const T0 = 1_759_000_000_000;

// Node built-ins, typed here so the browser build never depends on @types/node.
interface Socket {
  write(s: string): void;
  on(e: 'data', f: (b: Uint8Array) => void): void;
  on(e: 'close', f: () => void): void;
  destroy(): void;
}
interface Server {
  listen(port: number, host: string, cb: () => void): void;
  address(): { port: number };
  close(): void;
}
interface Child {
  stdout: { on(e: 'data', f: (b: Uint8Array) => void): void };
  stderr: { on(e: 'data', f: (b: Uint8Array) => void): void };
  kill(): void;
  on(e: 'exit', f: () => void): void;
}
const node = async <T,>(name: string) => (await import(/* @vite-ignore */ ['node', name].join(':'))) as T;

/** A device on TCP: the simulator, attached to whatever connects. */
async function tcpDevice() {
  const net = await node<{ createServer(f: (s: Socket) => void): Server }>('net');
  const waiting: ((s: Socket) => void)[] = [];
  const sockets: Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    waiting.shift()?.(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    /** The next connection dogd makes (or the current one). */
    connection: () => new Promise<Socket>((r) => (sockets.length && !waiting.length ? r(sockets.at(-1)!) : waiting.push(r))),
    nextConnection: () => new Promise<Socket>((r) => waiting.push(r)),
    close: () => server.close(),
  };
}

/** Commands arriving from dogd, line by line. */
function commands(socket: Socket, on: (cmd: HostCommand) => void) {
  let buf = '';
  const text = new TextDecoder();
  socket.on('data', (b) => {
    buf += text.decode(b, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        on(JSON.parse(line) as HostCommand);
      } catch {
        // not a command
      }
    }
  });
}

const children: Child[] = [];
afterAll(() => children.forEach((c) => c.kill()));

async function startDogd(args: string[]): Promise<{ base: string; child: Child }> {
  const cp = await node<{ spawn(bin: string, args: string[]): Child }>('child_process');
  const child = cp.spawn(BIN!, ['serve', '--listen', '127.0.0.1:0', ...args]);
  children.push(child);
  let out = '';
  const listen = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dogd did not start: ${out}`)), 10_000);
    const read = (b: Uint8Array) => {
      out += new TextDecoder().decode(b);
      const m = /LISTEN\s+(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
  return { base: `http://${listen}`, child };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const online = async (base: string, epoch = 1) => {
  const l = await dogdLink(base).catch(() => null);
  return l?.state === 'ONLINE' && l.epoch >= epoch;
};

/**
 * The test clock follows the device: host time = T0 + frame time. Applied
 * to both paths, so wall-clock jitter on the dogd path cannot change a fact.
 */
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

function recorded(c: Clocked) {
  const sys = new System(memoryStore(), () => c.now);
  sys.recorder = new SessionRecorder(
    newHeader({ id: 'HD-DOGD', startedAt: T0, source: c.kind === 'DOGD' ? 'DOGD' : 'SIMULATOR', origin: c.origin, endpoint: c.label, scenario: null, app: 'test' }),
  );
  return sys;
}

async function direct(scenario: ScenarioId, seed: number, seconds: number) {
  const sim = new SimulatedDevice({ seed, manual: true, scenario });
  const c = new Clocked(sim);
  const sys = recorded(c);
  await sys.boot(c, () => {}, 0);
  for (let k = 0; k < seconds * 10; k++) sim.advance(100);
  sys.evaluate(c.now);
  return { sys, c };
}

async function throughDogd(base: string, socket: Socket, scenario: ScenarioId, seed: number, seconds: number) {
  const sim = new SimulatedDevice({ seed, manual: true, scenario });
  const received: HostCommand[] = [];
  commands(socket, (cmd) => {
    received.push(cmd);
    sim.send(cmd);
  });
  const c = new Clocked(await DogdTransport.prepare(base));
  const sys = recorded(c);
  await sys.boot(c, () => {}, 0);
  let lines = 0;
  sim.attachWire((text) => {
    lines++;
    socket.write(text);
  });
  for (let k = 0; k < seconds * 10; k++) sim.advance(100);
  await until('every frame through dogd', () => c.frames === lines);
  sys.evaluate(c.now);
  return { sys, c, sim, lines, received };
}

const timeline = (sys: System) =>
  sys.trace
    .all()
    .filter((e) => e.source !== 'SYS' && e.source !== 'USER')
    .map((e) => `${e.t} #${e.seq ?? ''} ${e.source} ${e.severity} ${e.message} ${e.value ?? ''}`);

const diagnosis = (sys: System) => sys.diagnoses.map((d) => ({ id: d.id, confidence: d.confidence, evidence: d.evidence }));

describe.runIf(BIN)('dogd (real binary)', { timeout: 60_000 }, () => {
  let device: Awaited<ReturnType<typeof tcpDevice>>;
  let base = '';
  let dataDir = '';

  it('starts local, with the simulator as a TCP device declared SIMULATED', async () => {
    const os = await node<{ tmpdir(): string }>('os');
    dataDir = `${os.tmpdir()}/dogd-it-${Date.now()}`;
    device = await tcpDevice();
    ({ base } = await startDogd(['--source', `tcp:127.0.0.1:${device.port}`, '--source-origin', 'simulated', '--data', dataDir]));
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({ status: 'ok', dogd: '0.1.0', hdp: 1 });
    await until('link online', () => online(base));
    const link = await dogdLink(base);
    expect(link.origin).toBe('SIMULATED');
  });

  it('KILLER TEST: simulator direct == simulator through dogd', async () => {
    const socket = await device.connection();
    const a = await direct('HD-T001', 4, 30);
    const b = await throughDogd(base, socket, 'HD-T001', 4, 30);

    expect(a.c.frames).toBe(b.c.frames);
    expect(diagnosis(b.sys)).toEqual(diagnosis(a.sys));
    expect(diagnosis(b.sys)[0]).toMatchObject({ id: 'POWER_INSTABILITY', confidence: 'HIGH' });
    expect(b.sys.facts).toEqual(a.sys.facts);
    expect(timeline(b.sys)).toEqual(timeline(a.sys));
    expect(b.sys.frameErrors).toBe(0);
    // the recordings hold the same frames at the same times
    const frames = (sys: System) => sys.recorder!.entries.filter((e) => 'frame' in e);
    expect(frames(b.sys)).toEqual(frames(a.sys));
    // provenance: through dogd, the operator's declaration is kept
    expect(b.sys.recorder!.header.source).toBe('DOGD');
    expect(b.sys.recorder!.header.origin).toBe('SIMULATED');
    expect(b.sys.origin).toBe('SIMULATED');

    // commands round-trip: interface -> dogd -> device -> dogd -> interface
    expect(b.sys.scanI2c()).toBeNull();
    await until('command reached the device through dogd', () => b.received.some((c) => c.cmd === 'i2c.scan'));
    const before = b.c.frames;
    for (let k = 0; k < 10; k++) b.sim.advance(100);
    await until('i2c scan result', () => b.sys.bus.state !== 'SCANNING' && b.c.frames > before);
    expect(b.sys.bus.lastScanAt).not.toBeNull();

    // malformed HDP is rejected by the SAME decoder, counted, never repaired
    socket.write('{"type":"power",\n{"type":"warp","t":1}\n');
    await until('rejects counted', () => b.sys.frameErrors === 2);
    expect(b.sys.trace.all().some((e) => e.message.startsWith('frame rejected: not valid JSON'))).toBe(true);
    await b.sys.disconnect();
  });

  it('replays a recording made through dogd to the same diagnosis', async () => {
    const socket = await device.connection();
    const live = await throughDogd(base, socket, 'HD-T005', 1, 30);
    const text = toHdlog(live.sys.recorder!.recording);
    const r = parseHdlog(text);
    expect(r.integrity!.status).toBe('VERIFIED');
    expect(r.header.source).toBe('DOGD');
    expect(r.header.origin).toBe('SIMULATED');
    const { replayRecording } = await import('../src/core/cases');
    const replayed = await replayRecording(r);
    expect(diagnosis(replayed)).toEqual(diagnosis(live.sys));
    await live.sys.disconnect();
  });

  it('a lost device link reaches the interface as LINK LOST, then reconnects cleanly', async () => {
    const socket = await device.connection();
    const t = await DogdTransport.prepare(base);
    const sys = new System(memoryStore());
    await sys.boot(t, () => {}, 0);
    expect(sys.link).toBe('ONLINE');
    const epoch = (await dogdLink(base)).epoch;
    const next = device.nextConnection();
    socket.destroy();
    await until('link lost in the interface', () => sys.link === 'LOST');
    expect(sys.lastError?.detail).toMatch(/device link lost/);
    await next;
    await until('dogd reconnected', () => online(base, epoch + 1));
    const again = new System(memoryStore());
    await again.boot(await DogdTransport.prepare(base), () => {}, 0);
    expect(again.link).toBe('ONLINE');
    await again.disconnect();
  });

  let stored = '';
  let recording = '';

  it('stores a session byte for byte, and its index survives a restart', async () => {
    const a = await direct('HD-T001', 4, 10);
    const text = toHdlog(a.sys.recorder!.recording);
    recording = a.sys.recorder!.header.recording;
    await dogdStore(recording, text, base);
    stored = text;
    const res = await fetch(`${base}/v1/sessions/${recording}/hdlog`);
    expect(await res.text()).toBe(text);
    const row = (await (await fetch(`${base}/v1/sessions/${recording}`)).json()) as Record<string, unknown>;
    expect(row).toMatchObject({ recording_id: recording, integrity: 'VERIFIED', closure: 'NORMAL', origin: 'SIMULATED' });
    expect(row['sha256']).toBe(parseHdlog(text).integrity!.fileSha256);
    // same bytes again: accepted, nothing changes; other bytes: refused
    await dogdStore(recording, text, base);
    await expect(dogdStore(recording, text.replace(/"v":5\.0/, '"v":5.1'), base)).rejects.toThrow(/409/);
  });

  it('after a restart, the index and the file are still there', async () => {
    for (const c of children.splice(0)) c.kill();
    const { base: b2 } = await startDogd(['--data', dataDir]);
    const list = (await (await fetch(`${b2}/v1/sessions`)).json()) as { sessions: { recording_id: string }[] };
    expect(list.sessions.map((s) => s.recording_id)).toContain(recording);
    expect(await (await fetch(`${b2}/v1/sessions/${recording}/hdlog`)).text()).toBe(stored);
    // no device configured: the HDP socket says so, the interface refuses to start a session
    await expect(DogdTransport.prepare(b2)).rejects.toThrow(/no device/);
    device.close();
  });
});

/**
 * No probe: dogd --source host is this computer, for the network. Its
 * results depend on the machine the test runs on, so the test checks what
 * must hold anywhere: what it is, what it observes, passive until asked,
 * and every answer one of the HDP checks.
 */
describe.runIf(BIN)('dogd --source host (real binary, this computer)', { timeout: 60_000 }, () => {
  const CHECKS = ['PASS', 'WARN', 'FAIL', 'PENDING', 'UNKNOWN'];

  it('is a device that observes the network only, passive until asked, then checks and probes', async () => {
    const os = await node<{ tmpdir(): string }>('os');
    const { base } = await startDogd(['--source', 'host', '--data', `${os.tmpdir()}/dogd-host-${Date.now()}`]);
    await until('host link online', () => online(base));
    const link = await dogdLink(base);
    expect(link.origin).toBe('PHYSICAL');
    expect(link.device?.device).toBe('HOST');

    const sys = new System(memoryStore());
    expect(await sys.connect(await DogdTransport.prepare(base))).toBe(true);
    await until('hello', () => sys.device.id === 'HOST');
    expect(sys.observes('net')).toBe(true);
    expect(sys.observes('probe')).toBe(true);
    for (const cap of ['power', 'usb', 'uart', 'i2c']) expect(sys.observes(cap)).toBe(false);

    // Passive: what the system knows, nothing judged that needs a packet.
    await until('a first net.status', () => sys.net.updatedAt !== null);
    expect(sys.net.gateway.status).toBe('UNKNOWN');
    expect(sys.net.dns.status).toBe('UNKNOWN');
    expect(sys.net.internet).toBe('UNKNOWN');
    expect(CHECKS).toContain(sys.net.dhcp);

    // Asked: the checks run, and each says one of the HDP checks.
    expect(sys.watchNet(2, 'localhost', 'localhost')).toBeNull();
    await until('a checked net.status', () => sys.net.dns.status !== 'UNKNOWN' || sys.net.address === null, 20_000);
    for (const c of [sys.net.gateway.status, sys.net.dns.status, sys.net.internet]) expect(CHECKS).toContain(c);

    // A probe from this computer: every test answered, then done.
    const run = sys.probe('localhost', ['DNS', 'TCP']);
    expect(typeof run).not.toBe('string');
    await until('probe done', () => sys.probes.some((p) => p.finishedAt !== null), 20_000);
    const done = sys.probes.find((p) => p.finishedAt !== null)!;
    expect(done.results.map((r) => r.test)).toEqual(['DNS', 'TCP']);
    for (const r of done.results) expect(CHECKS).toContain(r.status);
    // Every frame this computer sent is valid HDP: the decoder refused none.
    expect(sys.frameErrors).toBe(0);
    await sys.disconnect();
  });
});
