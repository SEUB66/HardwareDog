import { describe, expect, it } from 'vitest';
import { FlipperClient, FlipperRpc, RpcError, checkFlipperPath } from '../src/core/flipper/client';
import { DEMO_FILES, DemoFlipper } from '../src/core/flipper/demo';
import { FormatError, compareParsed, parseFlipperFile, timingStats } from '../src/core/flipper/formats';
import { FlipperLibrary, safeFileName, searchLibrary, type LibraryEntry } from '../src/core/flipper/library';
import { DelimitedReader, ProtoWriter, delimited, readFields } from '../src/core/flipper/proto';
import { decodeMain, encodeMain, type MainMessage } from '../src/core/flipper/rpc';
import { FlipperSerialLink } from '../src/core/flipper/serial';
import { FlipperService } from '../src/core/flipper/service';
import { Companion } from '../src/core/lab/companion';
import { LabBus, type LabEvent } from '../src/core/lab/events';
import { MemoryKv } from '../src/core/lab/store';

const connect = (demo = new DemoFlipper()) => ({ demo, client: new FlipperClient(new FlipperRpc(demo)) });

describe('protobuf codec', () => {
  it('round-trips varints, including 64-bit values', () => {
    const w = new ProtoWriter().uint(1, 300).uint(2, 32_000_000_000n).string(3, 'é').bool(4, true);
    const f = readFields(w.finish());
    expect(f.map((x) => x.field)).toEqual([1, 2, 3, 4]);
    expect(f[0]!.int).toBe(300n);
    expect(f[1]!.int).toBe(32_000_000_000n);
  });

  it('refuses truncated and oversized input instead of waiting forever', () => {
    expect(() => readFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow('length past end');
    expect(() => readFields(Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow('varint too long');
    const r = new DelimitedReader(() => {}, 100);
    expect(() => r.push(Uint8Array.from([0xff, 0x01]))).toThrow('exceeds');
  });

  it('reassembles frames split anywhere', () => {
    const msgs: Uint8Array[] = [];
    const r = new DelimitedReader((m) => msgs.push(m));
    const a = delimited(encodeMain({ commandId: 7, status: 0, hasNext: true, content: { kind: 'storage_list_request', path: '/ext' } }));
    const b = delimited(encodeMain({ commandId: 8, status: 6, hasNext: false, content: { kind: 'empty' } }));
    const all = new Uint8Array([...a, ...b]);
    for (const byte of all) r.push(Uint8Array.of(byte));
    expect(msgs.map((m) => decodeMain(m))).toEqual<MainMessage[]>([
      { commandId: 7, status: 0, hasNext: true, content: { kind: 'storage_list_request', path: '/ext', includeMd5: false, filterMaxSize: 0 } },
      { commandId: 8, status: 6, hasNext: false, content: { kind: 'empty' } },
    ]);
  });

  it('encodes the PB.Main envelope with the field numbers of flipper.proto', () => {
    // command_id=1 (field 1), system_ping_request (field 5) with data (field 1)
    const bytes = encodeMain({ commandId: 1, status: 0, hasNext: false, content: { kind: 'ping_request', data: Uint8Array.of(0xaa) } });
    expect([...bytes]).toEqual([0x08, 0x01, 0x2a, 0x03, 0x0a, 0x01, 0xaa]);
  });
});

describe('Flipper RPC client (against the demo device)', () => {
  it('pings, reads device info and lists a directory streamed in parts', async () => {
    const { client } = connect();
    expect(await client.ping()).toBeGreaterThanOrEqual(0);
    const info = await client.deviceInfo();
    expect(info.find(([k]) => k === 'hardware.name')?.[1]).toBe('DEMO');
    const files = await client.list('/ext/infrared');
    expect(files.map((f) => f.name).sort()).toEqual(['demo_tv.ir', 'demo_tv_v2.ir']);
    const root = await client.list('/ext');
    expect(root.length).toBeGreaterThan(3); // more than one reply part
  });

  it('reads a file larger than one frame, byte for byte', async () => {
    const big = new Uint8Array(5000).map((_, i) => i & 0xff);
    const { demo, client } = connect();
    demo.fs.set('/ext/big.bin', { dir: false, data: big });
    const seen: [number, number | null][] = [];
    const data = await client.read('/ext/big.bin', { onProgress: (d, t) => seen.push([d, t]) });
    expect(data).toEqual(big);
    expect(seen.at(-1)).toEqual([5000, 5000]);
  });

  it('keeps the device error code exactly', async () => {
    const { client } = connect(new DemoFlipper({ fail: (c) => (c.kind === 'storage_list_request' ? 4 : null) }));
    await expect(client.list('/ext')).rejects.toMatchObject({ code: 'ERROR_BUSY' });
    await expect(client.read('/ext/nope')).rejects.toMatchObject({ code: 'ERROR_STORAGE_NOT_EXIST' });
  });

  it('never overwrites without overwrite: true, and writes in parts', async () => {
    const { demo, client } = connect();
    const data = new Uint8Array(1300).fill(65);
    await client.write('/ext/notes/new.txt', data);
    expect(demo.fs.get('/ext/notes/new.txt')?.data).toEqual(data);
    expect(demo.received.filter((m) => m.content.kind === 'storage_write_request')).toHaveLength(3);
    await expect(client.write('/ext/notes/new.txt', Uint8Array.of(1))).rejects.toMatchObject({ code: 'HD_COLLISION' });
    expect(demo.fs.get('/ext/notes/new.txt')?.data.length).toBe(1300);
    await client.write('/ext/notes/new.txt', Uint8Array.of(1), { overwrite: true });
    expect(demo.fs.get('/ext/notes/new.txt')?.data).toEqual(Uint8Array.of(1));
    await expect(client.rename('/ext/notes/new.txt', '/ext/notes/readme.txt')).rejects.toMatchObject({ code: 'HD_COLLISION' });
    await expect(client.remove('/ext')).rejects.toMatchObject({ code: 'HD_BAD_PATH' });
  });

  it('refuses dangerous paths before anything is sent', () => {
    for (const p of ['', 'ext/x', '/ext/../int', '/ext//x', '/etc/passwd', '/ext/a\\b', '/ext/\u0000']) expect(() => checkFlipperPath(p)).toThrow(RpcError);
    expect(checkFlipperPath('/ext/infrared/')).toBe('/ext/infrared');
  });

  it('times out, then drains the late reply instead of taking it for the next one', async () => {
    const { client, demo } = connect(new DemoFlipper({ silent: 'power_info_request' }));
    await expect(client.rpc.call({ kind: 'power_info_request' }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(await client.ping()).toBeGreaterThanOrEqual(0);
    expect(demo.received.length).toBe(2);
  });

  it('a cable pulled mid-transfer fails the operation with LINK_LOST', async () => {
    const demo = new DemoFlipper({ dropAfterBytes: 900 });
    demo.fs.set('/ext/big.bin', { dir: false, data: new Uint8Array(4000) });
    const { client } = connect(demo);
    await expect(client.read('/ext/big.bin')).rejects.toMatchObject({ code: 'LINK_LOST' });
    await expect(client.ping()).rejects.toMatchObject({ code: 'LINK_LOST' });
  });
});

describe('Flipper file formats', () => {
  it('reads every demo file with its kind', () => {
    const kinds = Object.entries(DEMO_FILES).filter(([p]) => !p.endsWith('.txt')).map(([, t]) => parseFlipperFile(t).kind);
    expect(kinds).toEqual(['ir', 'ir', 'subghz', 'subghz', 'nfc', 'rfid', 'ibutton']);
  });

  it('keeps decoded parameters apart from recorded timings', () => {
    const ir = parseFlipperFile(DEMO_FILES['/ext/infrared/demo_tv.ir']!).ir!;
    expect(ir[0]).toMatchObject({ type: 'parsed', protocol: 'NECext', address: [0xee, 0x87, 0, 0] });
    expect(ir[0]).not.toHaveProperty('timings');
    expect(ir[1]).toMatchObject({ type: 'raw', frequency: 38000 });
    const raw = parseFlipperFile(DEMO_FILES['/ext/subghz/demo_raw.sub']!).subghz!;
    expect(raw.timings).toHaveLength(32);
    expect(timingStats(raw.timings!)?.count).toBe(32);
    const nfc = parseFlipperFile(DEMO_FILES['/ext/nfc/demo_tag.nfc']!).nfc!;
    expect(nfc.memory.get(5)).toEqual([null, null, null, null]);
  });

  it('compares two captures of the same kind, and refuses two kinds', () => {
    const a = parseFlipperFile(DEMO_FILES['/ext/infrared/demo_tv.ir']!);
    const b = parseFlipperFile(DEMO_FILES['/ext/infrared/demo_tv_v2.ir']!);
    const c = compareParsed(a, b);
    expect(c.diffs.map((d) => d.where)).toEqual(['signal Power command', 'signal Vol_up timings']);
    expect(compareParsed(a, parseFlipperFile(DEMO_FILES['/ext/lfrfid/demo_badge.rfid']!)).comparable).toBe(false);
  });

  it('pairs IR signals by name and rank: a second POWER is compared too, and timings value by value', () => {
    const ir = (...signals: string[]) => parseFlipperFile(`Filetype: IR signals file\nVersion: 1\n${signals.join('#\n')}`);
    const parsed = (name: string, command: string) => `name: ${name}\ntype: parsed\nprotocol: NEC\naddress: 04 00 00 00\ncommand: ${command}\n`;
    const raw = (name: string, data: string) => `name: ${name}\ntype: raw\nfrequency: 38000\nduty_cycle: 0.330000\ndata: ${data}\n`;
    const a = ir(parsed('POWER', '08 00 00 00'), parsed('POWER', '09 00 00 00'));
    const b = ir(parsed('POWER', '08 00 00 00'), parsed('POWER', '0A 00 00 00'));
    expect(compareParsed(a, b).diffs).toEqual([{ where: 'signal POWER #2 command', a: '09 00 00 00', b: '0A 00 00 00' }]);
    const c = ir(parsed('POWER', '08 00 00 00'));
    expect(compareParsed(a, c).diffs.map((d) => d.where)).toEqual(['signals named POWER', 'signal POWER #2']);
    // same count, same total, different values: a difference all the same
    const d = compareParsed(ir(raw('VOL', '100 200 300 400')), ir(raw('VOL', '200 100 300 400')));
    expect(d.diffs).toEqual([{ where: 'signal VOL timings value 1', a: '100 us', b: '200 us' }]);
  });

  it('refuses malformed and binary files with the line', () => {
    expect(() => parseFlipperFile('hello')).toThrow(FormatError);
    expect(() => parseFlipperFile(Uint8Array.of(0, 1, 2, 0xff))).toThrow('UTF-8');
    expect(() => parseFlipperFile('Filetype: IR signals file\nVersion: 1\nname: x\ntype: raw\nfrequency: 38000\nduty_cycle: 0.33\ndata: 1 -2\n')).toThrow('line 7');
    expect(() => parseFlipperFile('Filetype: Flipper RFID key\nVersion: 1\nKey type: EM4100\nData: 01 ZZ\n')).toThrow('line 4');
  });
});

describe('Flipper service and the companion', () => {
  const rig = () => {
    const bus = new LabBus();
    const events: LabEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const service = new FlipperService(bus, new FlipperLibrary(new MemoryKv(), new MemoryKv()));
    return { bus, events, service };
  };

  it('connects once even when asked twice, then browses and copies on request', async () => {
    const { service, events } = rig();
    await Promise.all([service.connect('demo'), service.connect('demo')]);
    expect(service.view.link).toBe('CONNECTED');
    expect(events.filter((e) => e.type === 'link.state' && e.params?.['state'] === 'CONNECTING')).toHaveLength(1);
    expect(service.view.entries?.length).toBeGreaterThan(0);
    const first = await service.copyToLibrary('/ext/infrared/demo_tv.ir');
    const again = await service.copyToLibrary('/ext/infrared/demo_tv.ir');
    expect(first.added).toBe(true);
    expect(again.added).toBe(false);
    expect(first.item.origin).toBe('SIMULATED');
    expect(first.item.tags).toEqual(['demo']);
    expect(events.every((e) => e.origin === 'SIMULATED')).toBe(true);
  });

  it('a lost link is said with its reason, and the companion stops the work animation', async () => {
    const { service, bus } = rig();
    const companion = new Companion(bus);
    await service.connect('demo', { latencyMs: 1 });
    service.demo!.fs.set('/ext/big.bin', { dir: false, data: new Uint8Array(20_000) });
    const reading = service.read('/ext/big.bin');
    await new Promise((r) => setTimeout(r, 12));
    service.demo!.unplug();
    await expect(reading).rejects.toMatchObject({ code: 'LINK_LOST' });
    expect(service.view.link).toBe('DISCONNECTED');
    expect(service.view.reason).toBe('lost');
    expect(companion.operations).toHaveLength(0);
    expect(companion.hardware).toBe('DISCONNECTED');
    companion.dispose();
  });

  it('library search is stable and filters by tag and kind', async () => {
    const lib = new FlipperLibrary(new MemoryKv(), new MemoryKv());
    const a = (await lib.add({ path: '/ext/infrared/a.ir', device: 'X', origin: 'PHYSICAL', data: Uint8Array.of(1), at: 1 })).item;
    await lib.add({ path: '/ext/subghz/b.sub', device: 'X', origin: 'PHYSICAL', data: Uint8Array.of(2), at: 1 });
    await lib.annotate(a.id, { tags: ['Living Room', 'tv'], notes: 'remote' });
    const items = await lib.list();
    expect(searchLibrary(items, 'tag:living-room').map((i) => i.name)).toEqual(['a.ir']);
    expect(searchLibrary(items, 'kind:subghz').map((i) => i.name)).toEqual(['b.sub']);
    expect(searchLibrary(items, '', 'newest').map((i) => i.id)).toEqual(searchLibrary(items, '', 'newest').map((i) => i.id));
    expect(safeFileName('../../etc/passwd')).not.toMatch(/^\.|\//);
  });
});

/** A Flipper-shaped serial port the test drives: answers the CLI, then echoes the start line. */
class FlipperPort {
  written: string[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  closed = 0;
  private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  constructor(private readonly onWrite: (port: FlipperPort, text: string) => void = () => {}) {}
  getInfo() {
    return { usbVendorId: 0x0483, usbProductId: 0x5740 };
  }
  async open() {
    this.readable = new ReadableStream({ start: (c) => void (this.ctrl = c) });
    this.writable = new WritableStream({
      write: (c) => {
        const t = new TextDecoder('latin1').decode(c);
        this.written.push(t);
        this.onWrite(this, t);
      },
    });
  }
  async close() {
    this.closed++;
  }
  feed(b: string | Uint8Array) {
    this.ctrl!.enqueue(typeof b === 'string' ? Uint8Array.from(b, (c) => c.charCodeAt(0)) : b);
  }
  unplug() {
    this.ctrl!.error(Object.assign(new Error('The device has been lost.'), { name: 'NetworkError' }));
  }
}

/** A link the test answers by hand: every write is handed to `answer`. */
function handLink(answer: (id: number, send: (m: MainMessage) => void) => void) {
  const link = {
    origin: 'PHYSICAL' as const,
    label: 'HOSTILE',
    onData: null as ((b: Uint8Array) => void) | null,
    onClose: null as ((r: string) => void) | null,
    write: async (bytes: Uint8Array) => {
      const id = decodeMain(bytes.subarray(1)).commandId;
      answer(id, (m) => link.onData?.(delimited(encodeMain(m))));
    },
    close: async () => {},
  };
  return link;
}

describe('Flipper paths a hostile or broken device takes (audit 2026-10)', () => {
  it('a frame announcing more than 64 KiB ends the stream; a trickled frame is reassembled', () => {
    expect(() => new DelimitedReader(() => {}).push(Uint8Array.from([0x81, 0x80, 0x04]))).toThrow('exceeds 65536');
    const msgs: Uint8Array[] = [];
    const r = new DelimitedReader((m) => msgs.push(m));
    const payload = new Uint8Array(60_000).map((_, i) => i & 0xff);
    const frame = delimited(payload);
    for (let at = 0; at < frame.length; at += 7) r.push(frame.subarray(at, at + 7));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(payload);
    expect(r.pending).toBe(0);
  });

  it('random bytes only ever throw: no hang, nothing held past the frame limit', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let run = 0; run < 300; run++) {
      const r = new DelimitedReader((m) => {
        try {
          decodeMain(m);
        } catch {
          // a malformed message is refused, that is all
        }
      });
      try {
        for (let n = 0; n < 40; n++) r.push(Uint8Array.from({ length: Math.floor(rand() * 200) }, () => Math.floor(rand() * 256)));
      } catch (e) {
        expect(String(e)).toMatch(/protobuf/);
      }
      expect(r.pending).toBeLessThanOrEqual(64 * 1024 + 10 + 200);
    }
  });

  it('an endless streamed reply fails the command, and keeps nothing a consumer already took', async () => {
    const endless = handLink((id, send) => {
      for (let i = 0; i < 40_001; i++) send({ commandId: id, status: 0, hasNext: true, content: { kind: 'storage_list_response', files: [] } });
    });
    const rpc = new FlipperRpc(endless);
    let seen = 0;
    await expect(rpc.call({ kind: 'storage_list_request', path: '/ext' }, { onPart: () => void seen++ })).rejects.toMatchObject({ code: 'HD_TOO_MANY' });
    expect(seen).toBe(40_000);

    const three = handLink((id, send) => {
      for (let i = 0; i < 3; i++) send({ commandId: id, status: 0, hasNext: i < 2, content: { kind: 'storage_list_response', files: [] } });
    });
    const kept = await new FlipperRpc(three).call({ kind: 'storage_list_request', path: '/ext' }, { onPart: () => {} });
    expect(kept).toEqual([]);
  });

  it('a reply that keeps trickling still ends at its deadline', async () => {
    const timers: ReturnType<typeof setInterval>[] = [];
    const dribble = handLink((id, send) => {
      timers.push(setInterval(() => send({ commandId: id, status: 0, hasNext: true, content: { kind: 'storage_list_response', files: [] } }), 5));
    });
    const t0 = Date.now();
    await expect(new FlipperRpc(dribble).call({ kind: 'storage_list_request', path: '/ext' }, { timeoutMs: 1000, deadlineMs: 80 })).rejects.toMatchObject({ code: 'TIMEOUT', message: expect.stringMatching(/longer than 0.08 s/) });
    expect(Date.now() - t0).toBeLessThan(900);
    timers.forEach(clearInterval);
  });

  it('serial: a prompt split across chunks, the echo, then RPC bytes in the same chunk', async () => {
    const ping = delimited(encodeMain({ commandId: 1, status: 0, hasNext: false, content: { kind: 'ping_response', data: Uint8Array.from([0x48, 0x44, 0x4f, 0x47]) } }));
    const port = new FlipperPort((p, t) => {
      if (t === '\r') setTimeout(() => (p.feed('\r\n>'), p.feed(': ')), 1);
      if (t.startsWith('start_rpc_session')) setTimeout(() => p.feed(new Uint8Array([...Uint8Array.from('start_rpc_session\r\n', (c) => c.charCodeAt(0)), ...ping])), 1);
    });
    const link = new FlipperSerialLink(port);
    const got: Uint8Array[] = [];
    link.onData = (b) => void got.push(b);
    await link.open(500);
    expect(port.written).toEqual(['\r', 'start_rpc_session\r']);
    expect(got.flatMap((b) => [...b])).toEqual([...ping]);
    expect(link.label).toBe('FLIPPER USB 0483:5740');
  });

  it('serial: a port that never shows the prompt times out and is released; an unplug mid-RPC is said', async () => {
    const mute = new FlipperPort();
    await expect(new FlipperSerialLink(mute).open(30)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(mute.closed).toBe(1);

    const port = new FlipperPort((p, t) => {
      if (t === '\r') setTimeout(() => p.feed('>: '), 1);
      if (t.startsWith('start_rpc_session')) setTimeout(() => p.feed('start_rpc_session\r\n'), 1);
    });
    const link = new FlipperSerialLink(port);
    await link.open(500);
    const rpc = new FlipperRpc(link);
    const pending = rpc.call({ kind: 'ping_request', data: Uint8Array.of(1) });
    await new Promise((r) => setTimeout(r, 5));
    port.unplug();
    await expect(pending).rejects.toMatchObject({ code: 'LINK_LOST', message: 'The device has been lost.' });
  });
});

describe('the Flipper library keeps bytes apart (audit 2026-10)', () => {
  it('a COPY counts the library instead of loading it; lists hold no bytes; opening reads them', async () => {
    const meta = new MemoryKv<LibraryEntry>();
    let loadedAll = 0;
    const counted = Object.assign(Object.create(meta) as typeof meta, { all: async () => (loadedAll++, meta.all()) });
    const lib = new FlipperLibrary(counted, new MemoryKv());
    const { item } = await lib.add({ path: '/ext/infrared/a.ir', device: 'X', origin: 'PHYSICAL', data: Uint8Array.of(1, 2, 3), at: 1 });
    expect((await lib.add({ path: '/ext/infrared/a.ir', device: 'X', origin: 'PHYSICAL', data: Uint8Array.of(1, 2, 3), at: 2 })).added).toBe(false);
    expect(loadedAll).toBe(0);
    const [entry] = await lib.list();
    expect('data' in entry!).toBe(false);
    expect((await lib.open(item.id))!.data).toEqual(Uint8Array.of(1, 2, 3));
    await lib.remove(item.id);
    expect(await lib.open(item.id)).toBeNull();
  });

  it('items copied before the split move their bytes once, on upgrade, and still open', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const { openLabStore, resetLabStore } = await import('../src/core/lab/store');
    const factory = new IDBFactory();
    const old = { id: 'abc', name: 'a.ir', path: '/ext/a.ir', device: 'X', origin: 'PHYSICAL', copiedAt: 1, size: 2, sha256: 'h', kind: 'ir', notes: 'n', tags: [], data: Uint8Array.of(9, 8) };
    await new Promise<void>((res) => {
      const r = factory.open('hwdog-lab', 2);
      r.onupgradeneeded = () => {
        for (const s of ['sessions', 'library', 'camera', 'photos']) r.result.createObjectStore(s);
        r.transaction!.objectStore('library').put(old, 'abc');
      };
      r.onsuccess = () => (r.result.close(), res());
    });
    resetLabStore();
    const meta = await openLabStore<LibraryEntry>('library', factory);
    const bytes = await openLabStore<Uint8Array>('library-data', factory);
    expect(meta.kind).toBe('INDEXEDDB');
    expect('data' in (await meta.get('abc'))!).toBe(false);
    expect(await bytes.get('abc')).toEqual(Uint8Array.of(9, 8));
    const lib = new FlipperLibrary(meta, bytes);
    expect((await lib.open('abc'))!.data).toEqual(Uint8Array.of(9, 8));
    expect(await meta.count()).toBe(1);
    resetLabStore();
  });
});
