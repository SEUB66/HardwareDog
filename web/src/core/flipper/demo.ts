/**
 * HARDWARE DOG / DEMO FLIPPER (SIMULATED)
 *
 * A pretend Flipper Zero for DEMO MODE and for tests. It speaks the same
 * RPC bytes as the real device, through the same client, so everything
 * above it is exercised for real; what it says about itself is labeled
 * DEMO everywhere (origin SIMULATED, device name DEMO, firmware "demo").
 * Its files are written by Hardware Dog for the demo, not captured.
 *
 * Faults can be injected (a status for a request, a cable pulled after N
 * bytes) to test what the interface does when things go wrong.
 */

import type { ByteLink } from './client';
import { DelimitedReader, delimited } from './proto';
import { decodeMain, encodeMain, type Content, type FlipperFile, type MainMessage } from './rpc';

const enc = new TextEncoder();

export const DEMO_FILES: Record<string, string> = {
  '/ext/infrared/demo_tv.ir': `Filetype: IR signals file
Version: 1
# DEMO FILE written by Hardware Dog, not a capture
name: Power
type: parsed
protocol: NECext
address: EE 87 00 00
command: 5D A0 00 00
#
name: Vol_up
type: raw
frequency: 38000
duty_cycle: 0.330000
data: 9024 4512 579 552 579 552 579 1683 579 552 579 552 579 552 579 552 579 552 579 1683 579 1683 579 552 579 1683 579 1683 579 1683 579 1683 579 1683 579 552
`,
  '/ext/infrared/demo_tv_v2.ir': `Filetype: IR signals file
Version: 1
# DEMO FILE written by Hardware Dog, not a capture
name: Power
type: parsed
protocol: NECext
address: EE 87 00 00
command: 5C A3 00 00
#
name: Vol_up
type: raw
frequency: 38000
duty_cycle: 0.330000
data: 9024 4512 579 552 579 552 579 1683 579 552 579 552 579 552 579 552 579 552 579 1683 579 1683 579 552 579 1683 579 1683 579 1683 579 1683 579 1683 579 552 579 39000
`,
  '/ext/subghz/demo_gate.sub': `Filetype: Flipper SubGhz Key File
Version: 1
# DEMO FILE written by Hardware Dog, not a capture
Frequency: 433920000
Preset: FuriHalSubGhzPresetOok650Async
Protocol: Princeton
Bit: 24
Key: 00 00 00 00 00 95 D5 D4
TE: 400
`,
  '/ext/subghz/demo_raw.sub': `Filetype: Flipper SubGhz RAW File
Version: 1
# DEMO FILE written by Hardware Dog, not a capture
Frequency: 433920000
Preset: FuriHalSubGhzPresetOok650Async
Protocol: RAW
RAW_Data: 400 -1200 400 -1200 1200 -400 400 -1200 1200 -400 1200 -400 400 -1200 400 -12400
RAW_Data: 400 -1200 400 -1200 1200 -400 400 -1200 1200 -400 1200 -400 400 -1200 400 -12400
`,
  '/ext/nfc/demo_tag.nfc': `Filetype: Flipper NFC device
Version: 4
# DEMO FILE written by Hardware Dog, not a capture
Device type: NTAG/Ultralight
UID: 04 A1 B2 C3 D4 E5 80
ATQA: 00 44
SAK: 00
Page 0: 04 A1 B2 9F
Page 1: C3 D4 E5 80
Page 2: F6 48 00 00
Page 3: E1 10 12 00
Page 4: 03 0B D1 01
Page 5: ?? ?? ?? ??
`,
  '/ext/lfrfid/demo_badge.rfid': `Filetype: Flipper RFID key
Version: 1
# DEMO FILE written by Hardware Dog, not a capture
Key type: EM4100
Data: 01 23 45 67 89
`,
  '/ext/ibutton/demo_key.ibtn': `Filetype: Flipper iButton key
Version: 2
# DEMO FILE written by Hardware Dog, not a capture
Protocol: DS1990
Rom Data: 01 DE AD BE EF 00 00 7A
`,
  '/ext/notes/readme.txt': 'This is the Hardware Dog demo Flipper. Nothing here was captured.\n',
};

export const DEMO_INFO: [string, string][] = [
  ['format.major', '3'],
  ['format.minor', '0'],
  ['hardware.model', 'Flipper Zero'],
  ['hardware.name', 'DEMO'],
  ['hardware.uid', '00000000DEADBEEF'],
  ['firmware.origin.fork', 'demo'],
  ['firmware.version', 'demo'],
  ['firmware.branch', 'demo'],
  ['firmware.target', '7'],
  ['protobuf.version.major', '0'],
  ['protobuf.version.minor', '25'],
];

export interface DemoOptions {
  /** Reply delay, ms (0: next tick). */
  latencyMs?: number;
  /** Return a PB.CommandStatus number to fail a request, or null. */
  fail?: (content: Content) => number | null;
  /** Pull the cable after the demo has sent this many bytes. */
  dropAfterBytes?: number;
  /** Never answer requests of this kind (timeout tests). */
  silent?: Content['kind'];
}

interface Node {
  dir: boolean;
  data: Uint8Array;
}

export class DemoFlipper implements ByteLink {
  readonly origin = 'SIMULATED' as const;
  readonly label = 'DEMO FLIPPER (SIMULATED)';
  onData: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly fs = new Map<string, Node>();
  private readonly reader: DelimitedReader;
  private writes = new Map<number, { path: string; chunks: Uint8Array[] }>();
  private sent = 0;
  private nextAt = 0;
  private closed = false;
  /** Every request received, in order: tests check nothing was sent twice. */
  readonly received: MainMessage[] = [];

  constructor(private readonly options: DemoOptions = {}) {
    for (const d of ['/ext', '/int', '/ext/infrared', '/ext/subghz', '/ext/nfc', '/ext/lfrfid', '/ext/ibutton', '/ext/notes']) this.fs.set(d, { dir: true, data: new Uint8Array(0) });
    for (const [p, t] of Object.entries(DEMO_FILES)) this.fs.set(p, { dir: false, data: enc.encode(t) });
    this.reader = new DelimitedReader((m) => this.handle(decodeMain(m)));
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('demo link closed');
    this.reader.push(bytes);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Pull the cable: the link drops, as a real one would. */
  unplug(reason = 'demo cable pulled'): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(reason);
  }

  private reply(m: MainMessage): void {
    const bytes = delimited(encodeMain(m));
    const deliver = () => {
      if (this.closed) return;
      if (this.options.dropAfterBytes !== undefined && this.sent + bytes.length > this.options.dropAfterBytes) {
        this.unplug('demo cable pulled during a transfer');
        return;
      }
      this.sent += bytes.length;
      this.onData?.(bytes);
    };
    if (!this.options.latencyMs) return queueMicrotask(deliver);
    // One frame after the other, like a cable: a long reply takes time to arrive.
    const now = Date.now();
    this.nextAt = Math.max(now, this.nextAt) + this.options.latencyMs;
    setTimeout(deliver, this.nextAt - now);
  }

  private ok(id: number, content: Content, hasNext = false): void {
    this.reply({ commandId: id, status: 0, hasNext, content });
  }

  private status(id: number, status: number): void {
    this.reply({ commandId: id, status, hasNext: false, content: { kind: 'empty' } });
  }

  private children(path: string): FlipperFile[] {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: FlipperFile[] = [];
    for (const [p, n] of this.fs) {
      if (!p.startsWith(prefix) || p.slice(prefix.length).includes('/') || p === path) continue;
      out.push({ type: n.dir ? 'DIR' : 'FILE', name: p.slice(prefix.length), size: n.dir ? 0 : n.data.length });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private handle(m: MainMessage): void {
    this.received.push(m);
    const id = m.commandId;
    const c = m.content;
    let written = new Uint8Array(0);
    if (c.kind === 'storage_write_request') {
      // A write comes in parts (has_next): the file exists once the last one is in.
      const w = this.writes.get(id) ?? { path: c.path, chunks: [] };
      w.chunks.push(c.data);
      this.writes.set(id, w);
      if (m.hasNext) return;
      this.writes.delete(id);
      written = new Uint8Array(w.chunks.reduce((n, x) => n + x.length, 0));
      let at = 0;
      for (const x of w.chunks) {
        written.set(x, at);
        at += x.length;
      }
    }
    if (this.options.silent === c.kind) return;
    const failed = this.options.fail?.(c);
    if (failed) return this.status(id, failed);
    const node = 'path' in c && typeof c.path === 'string' ? this.fs.get(c.path.replace(/\/$/, '')) : undefined;
    switch (c.kind) {
      case 'ping_request':
        return this.ok(id, { kind: 'ping_response', data: c.data });
      case 'device_info_request':
        DEMO_INFO.forEach(([key, value], i) => this.ok(id, { kind: 'device_info_response', key, value }, i < DEMO_INFO.length - 1));
        return;
      case 'power_info_request':
        return this.ok(id, { kind: 'power_info_response', key: 'charge.level', value: '87' });
      case 'protobuf_version_request':
        return this.ok(id, { kind: 'protobuf_version_response', major: 0, minor: 25 });
      case 'datetime_request': {
        const d = new Date();
        return this.ok(id, { kind: 'datetime_response', datetime: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), weekday: d.getDay() || 7 } });
      }
      case 'storage_info_request':
        return this.ok(id, { kind: 'storage_info_response', total: 32_000_000_000n, free: 31_000_000_000n });
      case 'storage_stat_request':
        if (!node) return this.status(id, 7);
        return this.ok(id, { kind: 'storage_stat_response', file: { type: node.dir ? 'DIR' : 'FILE', name: c.path.split('/').pop() ?? '', size: node.data.length } });
      case 'storage_list_request': {
        if (!node?.dir) return this.status(id, 7);
        const files = this.children(c.path);
        // Like the device: a few entries per message, has_next until the end.
        if (files.length === 0) return this.ok(id, { kind: 'storage_list_response', files: [] });
        for (let i = 0; i < files.length; i += 3) this.ok(id, { kind: 'storage_list_response', files: files.slice(i, i + 3) }, i + 3 < files.length);
        return;
      }
      case 'storage_read_request': {
        if (!node || node.dir) return this.status(id, 7);
        const d = node.data;
        if (d.length === 0) return this.ok(id, { kind: 'storage_read_response', file: { type: 'FILE', name: '', size: 0, data: new Uint8Array(0) } });
        for (let i = 0; i < d.length; i += 512) this.ok(id, { kind: 'storage_read_response', file: { type: 'FILE', name: '', size: 0, data: d.slice(i, i + 512) } }, i + 512 < d.length);
        return;
      }
      case 'storage_write_request': {
        const parent = c.path.slice(0, c.path.lastIndexOf('/'));
        if (!this.fs.get(parent)?.dir) return this.status(id, 7);
        this.fs.set(c.path, { dir: false, data: written });
        return this.status(id, 0);
      }
      case 'storage_mkdir_request':
        if (node) return this.status(id, 6);
        this.fs.set(c.path, { dir: true, data: new Uint8Array(0) });
        return this.status(id, 0);
      case 'storage_delete_request':
        if (!node) return this.status(id, 7);
        if (node.dir && this.children(c.path).length && !c.recursive) return this.status(id, 18);
        for (const p of [...this.fs.keys()]) if (p === c.path || p.startsWith(`${c.path}/`)) this.fs.delete(p);
        return this.status(id, 0);
      case 'storage_rename_request': {
        const from = this.fs.get(c.oldPath);
        if (!from) return this.status(id, 7);
        if (this.fs.has(c.newPath)) return this.status(id, 6);
        this.fs.delete(c.oldPath);
        this.fs.set(c.newPath, from);
        return this.status(id, 0);
      }
      case 'storage_md5sum_request':
        if (!node || node.dir) return this.status(id, 7);
        return this.ok(id, { kind: 'storage_md5sum_response', md5: 'not-computed-by-demo' });
      case 'gpio_get_pin_mode':
        return this.ok(id, { kind: 'gpio_get_pin_mode_response', mode: 'INPUT' });
      case 'gpio_read_pin':
        return this.ok(id, { kind: 'gpio_read_pin_response', value: 1 });
      default:
        return this.status(id, 3);
    }
  }
}
