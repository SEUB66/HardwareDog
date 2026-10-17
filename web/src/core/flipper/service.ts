/**
 * HARDWARE DOG / FLIPPER LAB SERVICE
 *
 * The one Flipper session of the interface. Every screen, the floating TV
 * and a detached window read this object; none of them opens a link of
 * its own, so there is never a second connection to the hardware.
 *
 * Every operation is said on the lab bus: op.start, op.progress (with a
 * total only when the device gave one), op.end with the device's exact
 * code on failure. The link state is said too (link.state), with the
 * reason when it drops. The companion watches; this service does not
 * know it exists.
 *
 * Read-only first: connecting reads information, browsing lists and
 * stats, copying reads. Writing, creating, renaming and deleting are
 * separate calls the interface only makes on an explicit request, and
 * writing never replaces a file unless overwrite was confirmed.
 */

import type { HardwareState } from '../lab/companion';
import { errorInfo, newOp, type LabBus, type OpKind } from '../lab/events';
import { FlipperClient, FlipperRpc, RpcError, checkFlipperPath, type ByteLink } from './client';
import { DemoFlipper, type DemoOptions } from './demo';
import { kindFromPath } from './formats';
import { FlipperLibrary, type LibraryItem } from './library';
import type { FlipperFile, GpioPin } from './rpc';
import { FlipperSerialLink, pickFlipperPort } from './serial';

export interface StorageSpace {
  total: bigint;
  free: bigint;
}

export interface FlipperView {
  link: HardwareState;
  /** Why the link is down, as the browser or the device said it. */
  reason: string | null;
  label: string | null;
  origin: 'PHYSICAL' | 'SIMULATED' | null;
  info: [string, string][];
  protobuf: { major: number; minor: number } | null;
  storage: { ext: StorageSpace | null; int: StorageSpace | null };
  cwd: string;
  entries: FlipperFile[] | null;
  /** The latest failure of an operation, exactly as reported. */
  error: { code: string; message: string } | null;
  busy: string | null;
}

/** A device name and firmware from device info, whichever key style the firmware uses. */
export function describeDevice(info: readonly [string, string][]): { name: string | null; firmware: string | null; model: string | null } {
  const get = (...keys: string[]) => info.find(([k]) => keys.includes(k))?.[1] ?? null;
  return {
    name: get('hardware.name', 'hardware_name'),
    firmware: get('firmware.version', 'firmware_version'),
    model: get('hardware.model', 'hardware_model'),
  };
}

export class FlipperService {
  view: FlipperView = {
    link: 'UNKNOWN',
    reason: null,
    label: null,
    origin: null,
    info: [],
    protobuf: null,
    storage: { ext: null, int: null },
    cwd: '/ext',
    entries: null,
    error: null,
    busy: null,
  };
  private rpc: FlipperRpc | null = null;
  client: FlipperClient | null = null;
  private connecting: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private rev = 0;
  /** How the last connection was made: RETRY uses the same way. */
  lastMode: 'serial' | 'demo' = 'serial';
  /** The demo device of this session, when it is one (tests pull its cable). */
  demo: DemoFlipper | null = null;

  constructor(
    private readonly bus: LabBus,
    readonly library: FlipperLibrary,
  ) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }
  private changed(patch: Partial<FlipperView> = {}): void {
    this.view = { ...this.view, ...patch };
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  private get origin(): 'PHYSICAL' | 'SIMULATED' {
    return this.view.origin ?? 'PHYSICAL';
  }

  private link(state: HardwareState, message: string, reason?: string): void {
    this.changed({ link: state, reason: reason ?? null });
    this.bus.emit({
      source: 'FLIPPER',
      tool: 'flipper.link',
      type: 'link.state',
      severity: state === 'CONNECTED' ? 'PASS' : state === 'DISCONNECTED' && reason === 'lost' ? 'FAIL' : 'INFO',
      message,
      params: { state, reason: reason ?? null, label: this.view.label },
      origin: this.origin,
      ...(this.view.label ? { device: this.view.label } : {}),
    });
  }

  /** Run one operation, said on the bus from start to end. */
  private async op<T>(
    kind: OpKind,
    tool: string,
    message: string,
    run: (progress: (done: number, total: number | null, unit?: string) => void) => Promise<T>,
    endParams?: (r: T) => Record<string, string | number | boolean | null>,
    /** What the operation is about (the kind of file), for whoever watches. */
    topic?: string,
  ): Promise<T> {
    const op = newOp(tool);
    const base = { source: 'FLIPPER' as const, tool, op, origin: this.origin, ...(this.view.label ? { device: this.view.label } : {}) };
    this.bus.emit({ ...base, type: 'op.start', severity: 'INFO', message, params: topic ? { kind, topic } : { kind } });
    this.changed({ busy: message });
    let lastProgress = 0;
    try {
      const result = await run((done, total, unit = 'bytes') => {
        // Progress is a fact from the device; it is said at most ~10 times a second.
        const now = this.bus.clock.mono();
        if (now - lastProgress < 100 && done !== total) return;
        lastProgress = now;
        this.bus.emit({ ...base, type: 'op.progress', severity: 'INFO', message, progress: { done, total, unit } });
      });
      this.bus.emit({ ...base, type: 'op.end', severity: 'PASS', message, ...(endParams ? { params: endParams(result) } : {}) });
      this.changed({ busy: null, error: null });
      return result;
    } catch (e) {
      const { message: why, code } = errorInfo(e);
      this.bus.emit({ ...base, type: 'op.end', severity: 'FAIL', message: `${message}: ${why}`, ...(code ? { code } : {}) });
      this.changed({ busy: null, error: { code: code ?? 'ERROR', message: why } });
      throw e;
    }
  }

  get connected(): boolean {
    return this.view.link === 'CONNECTED' && this.client !== null;
  }

  /**
   * Connect: a real Flipper picked in the browser (serial) or the demo.
   * A connect while connecting or connected starts nothing new.
   */
  connect(mode: 'serial' | 'demo', demo?: DemoOptions): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.connected) return Promise.resolve();
    this.lastMode = mode;
    this.connecting = this.doConnect(mode, demo).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(mode: 'serial' | 'demo', demoOptions?: DemoOptions): Promise<void> {
    let link: ByteLink;
    if (mode === 'serial') {
      // The chooser must open inside the click: nothing is awaited before it.
      let port;
      try {
        port = await pickFlipperPort();
      } catch (e) {
        const { message, code } = errorInfo(e);
        this.changed({ origin: 'PHYSICAL' });
        this.bus.emit({ source: 'FLIPPER', tool: 'flipper.link', type: 'op.end', op: newOp('flipper.link'), severity: code === 'NotFoundError' ? 'INFO' : 'FAIL', message: `connect: ${message}`, origin: 'PHYSICAL', ...(code ? { code } : {}) });
        this.link('ABSENT', 'no Flipper picked');
        if (code === 'NotFoundError') return;
        throw e;
      }
      link = new FlipperSerialLink(port);
    } else {
      this.demo = new DemoFlipper(demoOptions);
      link = this.demo;
    }
    this.changed({ label: link.label, origin: link.origin, info: [], protobuf: null, storage: { ext: null, int: null }, entries: null, error: null });
    this.link('CONNECTING', `connecting ${link.label}`);
    try {
      await this.op('connect', 'flipper.link', `connect ${link.label}`, async () => {
        if (link instanceof FlipperSerialLink) await link.open();
        const rpc = new FlipperRpc(link);
        const client = new FlipperClient(rpc);
        await client.ping();
        this.rpc = rpc;
        this.client = client;
        rpc.onClose((reason) => this.lost(rpc, reason));
      });
    } catch (e) {
      await link.close().catch(() => {});
      this.rpc = null;
      this.client = null;
      this.link('DISCONNECTED', `could not connect: ${errorInfo(e).message}`, 'failed');
      throw e;
    }
    this.link('CONNECTED', `${link.label} connected (RPC)`);
    await this.refreshInfo().catch(() => {});
    await this.list(this.view.cwd).catch(() => {});
  }

  private lost(rpc: FlipperRpc, reason: string): void {
    if (this.rpc !== rpc) return;
    this.rpc = null;
    this.client = null;
    if (reason === 'closed') return;
    this.link('DISCONNECTED', `link lost: ${reason}`, 'lost');
  }

  async disconnect(): Promise<void> {
    const rpc = this.rpc;
    this.rpc = null;
    this.client = null;
    if (rpc) await rpc.close();
    this.link('DISCONNECTED', 'disconnected on request', 'closed');
  }

  private need(): FlipperClient {
    if (!this.client) throw new RpcError('HD_NOT_CONNECTED', 'no Flipper connected');
    return this.client;
  }

  /** Device information, protobuf version, storage space. Read-only. */
  async refreshInfo(): Promise<void> {
    const c = this.need();
    await this.op('read', 'flipper.info', 'read device information', async () => {
      const info = await c.deviceInfo();
      const protobuf = await c.protobufVersion().catch(() => null);
      const ext = await c.storageInfo('/ext').catch(() => null);
      const int = await c.storageInfo('/int').catch(() => null);
      this.changed({ info, protobuf, storage: { ext, int } });
    });
  }

  async list(path: string): Promise<FlipperFile[]> {
    const c = this.need();
    const p = checkFlipperPath(path);
    return this.op(
      'search',
      'flipper.files',
      `list ${p}`,
      async (progress) => {
        const files = await c.list(p, { onProgress: (n) => progress(n, null, 'entries') });
        files.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'DIR' ? -1 : 1));
        this.changed({ cwd: p, entries: files });
        return files;
      },
      (files) => ({ entries: files.length }),
    );
  }

  /** Read a file into memory (preview). Nothing is kept unless copied. */
  read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const c = this.need();
    return this.op('read', 'flipper.files', `read ${path}`, (progress) => c.read(path, { signal, onProgress: (d, t) => progress(d, t) }), (b) => ({ bytes: b.length }), kindFromPath(path));
  }

  /** Copy a file to this computer's library, on request. */
  async copyToLibrary(path: string): Promise<{ item: LibraryItem; added: boolean }> {
    const c = this.need();
    const device = describeDevice(this.view.info).name ?? this.view.label ?? 'FLIPPER';
    return this.op(
      'transfer',
      'flipper.copy',
      `copy ${path}`,
      async (progress) => {
        const data = await c.read(path, { onProgress: (d, t) => progress(d, t) });
        return this.library.add({ path, device, origin: this.origin, data, at: this.bus.clock.now() });
      },
      (r) => ({ copied: r.added, name: r.item.name, sha256: r.item.sha256 }),
      kindFromPath(path),
    );
  }

  /** Write bytes to the device. Refuses an existing file unless overwrite was confirmed. */
  write(path: string, data: Uint8Array, overwrite = false): Promise<void> {
    const c = this.need();
    return this.op('write', 'flipper.write', `write ${path} (${data.length} bytes)${overwrite ? ', overwrite confirmed' : ''}`, (progress) => c.write(path, data, { overwrite, onProgress: (d, t) => progress(d, t) }));
  }

  mkdir(path: string): Promise<void> {
    const c = this.need();
    return this.op('write', 'flipper.write', `create folder ${path}`, () => c.mkdir(path));
  }

  remove(path: string, recursive = false): Promise<void> {
    const c = this.need();
    return this.op('write', 'flipper.write', `delete ${path}${recursive ? ' (recursive)' : ''}`, () => c.remove(path, recursive));
  }

  rename(from: string, to: string): Promise<void> {
    const c = this.need();
    return this.op('write', 'flipper.write', `rename ${from} -> ${to}`, () => c.rename(from, to));
  }

  gpioRead(pin: GpioPin): Promise<{ mode: 'INPUT' | 'OUTPUT'; value: number }> {
    const c = this.need();
    return this.op('read', 'flipper.gpio', `read GPIO ${pin}`, () => c.gpioRead(pin), (r) => ({ pin, mode: r.mode, value: r.value }));
  }
}
