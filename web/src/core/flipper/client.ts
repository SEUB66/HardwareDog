/**
 * HARDWARE DOG / FLIPPER ZERO RPC CLIENT
 *
 * One command on the wire at a time, each with its own id; a reply is
 * matched by id, a streamed reply (has_next) is collected until its end.
 * Every command has an inactivity timeout, an overall deadline and a cap
 * on its reply parts, and can be cancelled; a reply to a cancelled command
 * is drained, never mistaken for the next one. A device that streams
 * without end (a broken one, or a gadget posing as a Flipper) fails the
 * command; it never grows the page's memory or keeps it waiting.
 *
 * Errors keep the device's own code (ERROR_STORAGE_NOT_EXIST...). Codes
 * Hardware Dog produces itself are named HD_* or TIMEOUT / ABORTED /
 * LINK_LOST, so a reader can always tell who said what.
 *
 * Writes never overwrite by accident: write() checks the path first and
 * refuses an existing file unless the caller passed overwrite: true, which
 * the interface only does after the operator confirmed it.
 */

import { DelimitedReader, delimited } from './proto';
import { decodeMain, encodeMain, statusName, type Content, type DateTime, type FlipperFile, type GpioPin, type MainMessage } from './rpc';

/** A byte pipe to a Flipper already in RPC mode (serial.ts) or to the demo device (demo.ts). */
export interface ByteLink {
  readonly origin: 'PHYSICAL' | 'SIMULATED';
  readonly label: string;
  write(bytes: Uint8Array): Promise<void>;
  onData: ((bytes: Uint8Array) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(): Promise<void>;
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const RPC_LIMITS = {
  /** Silence after which a command fails: each reply part restarts it. */
  timeoutMs: 6000,
  /** A command's whole reply, however lively: ten silences. Transfers get more for their size. */
  deadlineMs: 60_000,
  /** Reply parts one command accepts: a 16 MiB read is 32 768 parts of 512 bytes. */
  maxParts: 40_000,
  /** Bytes per storage write frame. */
  writeChunk: 512,
  /** Largest file read into memory. */
  maxRead: 16 * 1024 * 1024,
  maxWrite: 4 * 1024 * 1024,
  /** Entries accepted from one directory listing. */
  maxList: 10_000,
} as const;

/** Device paths Hardware Dog accepts: under /ext, /int or /any, no tricks. */
export function checkFlipperPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 255) throw new RpcError('HD_BAD_PATH', 'path must be 1 to 255 characters');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new RpcError('HD_BAD_PATH', 'path contains a control character or a backslash');
  if (!/^\/(ext|int|any)(\/|$)/.test(path)) throw new RpcError('HD_BAD_PATH', 'path must start with /ext, /int or /any');
  const segments = path.split('/').slice(1);
  if (segments.some((s, i) => (s === '' && i !== segments.length - 1) || s === '.' || s === '..')) throw new RpcError('HD_BAD_PATH', 'path has an empty, "." or ".." segment');
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export const joinPath = (dir: string, name: string): string => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
export const parentOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
};

interface Pending {
  id: number;
  /** Kept only when no onPart consumer takes them. */
  parts: MainMessage[];
  count: number;
  resolve: (m: MainMessage[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
  timeoutMs: number;
  onPart?: (m: MainMessage) => void;
}

export interface CallOptions {
  timeoutMs?: number;
  /** The whole reply's time limit (RPC_LIMITS.deadlineMs). */
  deadlineMs?: number;
  signal?: AbortSignal;
  onPart?: (m: MainMessage) => void;
}

export class FlipperRpc {
  private nextId = 1;
  private current: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly reader: DelimitedReader;
  /** Ids given up on (cancelled, timed out): their late replies are drained. */
  private readonly abandoned = new Set<number>();
  closed: string | null = null;
  /** Replies that matched no command (late, unsolicited): counted, ignored. */
  stray = 0;
  private closeListeners = new Set<(reason: string) => void>();

  constructor(readonly link: ByteLink) {
    this.reader = new DelimitedReader((msg) => this.receive(msg));
    link.onData = (bytes) => {
      try {
        this.reader.push(bytes);
      } catch (e) {
        // A broken stream cannot be resynchronized: the session ends here, said why.
        void this.shutdown(`protocol: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    };
    link.onClose = (reason) => void this.shutdown(reason, false);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private receive(buf: Uint8Array): void {
    let m: MainMessage;
    try {
      m = decodeMain(buf);
    } catch (e) {
      void this.shutdown(`protocol: ${e instanceof Error ? e.message : String(e)}`, true);
      return;
    }
    const p = this.current;
    if (!p || m.commandId !== p.id) {
      if (!this.abandoned.has(m.commandId)) this.stray++;
      else if (!m.hasNext) this.abandoned.delete(m.commandId);
      return;
    }
    if (++p.count > RPC_LIMITS.maxParts) {
      if (m.hasNext) this.abandoned.add(p.id);
      this.finish(p, new RpcError('HD_TOO_MANY', `more than ${RPC_LIMITS.maxParts} reply parts`));
      return;
    }
    if (!p.onPart || m.status !== 0) p.parts.push(m);
    this.arm(p);
    if (m.status !== 0) {
      if (!m.hasNext) this.finish(p, new RpcError(statusName(m.status), `the Flipper answered ${statusName(m.status)}`));
      return;
    }
    try {
      p.onPart?.(m);
    } catch (e) {
      // The caller refused this reply (too large, too many entries): give up on it, drain the rest.
      if (m.hasNext) this.abandoned.add(p.id);
      this.finish(p, e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (!m.hasNext) this.finish(p, null);
  }

  private arm(p: Pending): void {
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      this.abandoned.add(p.id);
      this.finish(p, new RpcError('TIMEOUT', `no answer in ${p.timeoutMs / 1000} s`));
    }, p.timeoutMs);
  }

  private finish(p: Pending, error: Error | null): void {
    if (this.current !== p) return;
    if (p.timer !== null) clearTimeout(p.timer);
    if (p.deadline !== null) clearTimeout(p.deadline);
    this.current = null;
    if (error) p.reject(error);
    else p.resolve(p.parts);
  }

  /** Send one request (or a multi-part one) and collect the full reply. */
  call(content: Content | Content[], options: CallOptions = {}): Promise<MainMessage[]> {
    const run = () => this.send(Array.isArray(content) ? content : [content], options);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  private send(contents: Content[], options: CallOptions): Promise<MainMessage[]> {
    if (this.closed) return Promise.reject(new RpcError('LINK_LOST', this.closed));
    if (options.signal?.aborted) return Promise.reject(new RpcError('ABORTED', 'cancelled'));
    const id = this.nextId++;
    if (this.nextId > 0xffff_fff0) this.nextId = 1;
    return new Promise<MainMessage[]>((resolve, reject) => {
      const p: Pending = { id, parts: [], count: 0, resolve, reject, timer: null, deadline: null, timeoutMs: options.timeoutMs ?? RPC_LIMITS.timeoutMs, onPart: options.onPart };
      this.current = p;
      const deadlineMs = options.deadlineMs ?? RPC_LIMITS.deadlineMs;
      p.deadline = setTimeout(() => {
        this.abandoned.add(id);
        this.finish(p, new RpcError('TIMEOUT', `the answer took longer than ${deadlineMs / 1000} s`));
      }, deadlineMs);
      const abort = () => {
        this.abandoned.add(id);
        this.finish(p, new RpcError('ABORTED', 'cancelled'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      p.resolve = (m) => (cleanup(), resolve(m));
      p.reject = (e) => (cleanup(), reject(e));
      this.arm(p);
      void (async () => {
        try {
          for (let i = 0; i < contents.length; i++) {
            if (this.current !== p) return; // cancelled mid-way
            await this.link.write(delimited(encodeMain({ commandId: id, status: 0, hasNext: i < contents.length - 1, content: contents[i]! })));
            this.arm(p);
          }
        } catch (e) {
          this.finish(p, new RpcError('LINK_LOST', e instanceof Error ? e.message : String(e)));
        }
      })();
    });
  }

  private async shutdown(reason: string, closeLink: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = reason;
    if (this.current) this.finish(this.current, new RpcError('LINK_LOST', reason));
    if (closeLink) await this.link.close().catch(() => {});
    for (const l of [...this.closeListeners]) l(reason);
  }

  /** Close on purpose: nothing pending survives, the link is released. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.link.onClose = null;
    await this.shutdown('closed', true);
  }
}

const one = <K extends Content['kind']>(parts: MainMessage[], kind: K): Extract<Content, { kind: K }> => {
  const c = parts.find((p) => p.content.kind === kind)?.content;
  if (!c) throw new RpcError('HD_UNEXPECTED', `expected ${kind} in the reply`);
  return c as Extract<Content, { kind: K }>;
};

/** The slowest a Flipper moves a file (8 KiB/s, far below its USB speed): sets a transfer's deadline. */
const SLOWEST_BYTES_PER_MS = 8;

export interface ProgressFn {
  (done: number, total: number | null): void;
}

/** What Hardware Dog asks a Flipper. Read-only calls first; writes check before they act. */
export class FlipperClient {
  constructor(readonly rpc: FlipperRpc) {}

  async ping(): Promise<number> {
    const data = Uint8Array.from([0x48, 0x44, 0x4f, 0x47]); // "HDOG"
    const t0 = performance.now();
    const r = one(await this.rpc.call({ kind: 'ping_request', data }, { timeoutMs: 3000 }), 'ping_response');
    if (r.data.length !== data.length || r.data.some((b, i) => b !== data[i])) throw new RpcError('HD_PING_MISMATCH', 'ping answer does not echo the request');
    return performance.now() - t0;
  }

  /** Every key the device reports, in its order (hardware, firmware, radio...). */
  async deviceInfo(): Promise<[string, string][]> {
    const parts = await this.rpc.call({ kind: 'device_info_request' });
    return parts.flatMap((p) => (p.content.kind === 'device_info_response' ? [[p.content.key, p.content.value] as [string, string]] : []));
  }

  async powerInfo(): Promise<[string, string][]> {
    const parts = await this.rpc.call({ kind: 'power_info_request' });
    return parts.flatMap((p) => (p.content.kind === 'power_info_response' ? [[p.content.key, p.content.value] as [string, string]] : []));
  }

  async protobufVersion(): Promise<{ major: number; minor: number }> {
    const r = one(await this.rpc.call({ kind: 'protobuf_version_request' }), 'protobuf_version_response');
    return { major: r.major, minor: r.minor };
  }

  async datetime(): Promise<DateTime> {
    return one(await this.rpc.call({ kind: 'datetime_request' }), 'datetime_response').datetime;
  }

  async storageInfo(path: string): Promise<{ total: bigint; free: bigint }> {
    const r = one(await this.rpc.call({ kind: 'storage_info_request', path: checkFlipperPath(path) }), 'storage_info_response');
    return { total: r.total, free: r.free };
  }

  /** The file or directory at path; null when it does not exist. */
  async stat(path: string): Promise<FlipperFile | null> {
    try {
      return one(await this.rpc.call({ kind: 'storage_stat_request', path: checkFlipperPath(path) }), 'storage_stat_response').file;
    } catch (e) {
      if (e instanceof RpcError && e.code === 'ERROR_STORAGE_NOT_EXIST') return null;
      throw e;
    }
  }

  async list(path: string, options: { signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<FlipperFile[]> {
    const files: FlipperFile[] = [];
    await this.rpc.call(
      { kind: 'storage_list_request', path: checkFlipperPath(path) },
      {
        signal: options.signal,
        onPart: (m) => {
          if (m.content.kind !== 'storage_list_response') return;
          files.push(...m.content.files);
          if (files.length > RPC_LIMITS.maxList) throw new RpcError('HD_TOO_MANY', `more than ${RPC_LIMITS.maxList} entries`);
          // The device does not say how many entries are coming: no total, no percentage.
          options.onProgress?.(files.length, null);
        },
      },
    );
    return files;
  }

  /** Read a whole file. Progress has a total: the size the device reported first. */
  async read(path: string, options: { signal?: AbortSignal; onProgress?: ProgressFn } = {}): Promise<Uint8Array> {
    const p = checkFlipperPath(path);
    const st = await this.stat(p);
    if (!st) throw new RpcError('ERROR_STORAGE_NOT_EXIST', `${p} does not exist`);
    if (st.type === 'DIR') throw new RpcError('HD_IS_DIR', `${p} is a directory`);
    if (st.size > RPC_LIMITS.maxRead) throw new RpcError('HD_TOO_LARGE', `${st.size} bytes is more than ${RPC_LIMITS.maxRead}`);
    const chunks: Uint8Array[] = [];
    let done = 0;
    await this.rpc.call(
      { kind: 'storage_read_request', path: p },
      {
        signal: options.signal,
        deadlineMs: RPC_LIMITS.deadlineMs + st.size / SLOWEST_BYTES_PER_MS,
        onPart: (m) => {
          if (m.content.kind !== 'storage_read_response' || !m.content.file?.data) return;
          chunks.push(m.content.file.data);
          done += m.content.file.data.length;
          if (done > RPC_LIMITS.maxRead) throw new RpcError('HD_TOO_LARGE', 'the file grew past the read limit');
          options.onProgress?.(done, st.size);
        },
      },
    );
    const out = new Uint8Array(done);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  /**
   * Write a file. Refuses to replace an existing one unless overwrite is
   * true. A write cannot be cancelled half-way: the device would keep a
   * partial file, so once started it finishes or fails.
   */
  async write(path: string, data: Uint8Array, options: { overwrite?: boolean; onProgress?: ProgressFn } = {}): Promise<void> {
    const p = checkFlipperPath(path);
    if (data.length > RPC_LIMITS.maxWrite) throw new RpcError('HD_TOO_LARGE', `${data.length} bytes is more than ${RPC_LIMITS.maxWrite}`);
    const existing = await this.stat(p);
    if (existing?.type === 'DIR') throw new RpcError('HD_IS_DIR', `${p} is a directory`);
    if (existing && !options.overwrite) throw new RpcError('HD_COLLISION', `${p} already exists (${existing.size} bytes): not overwritten`);
    const parts: Content[] = [];
    for (let at = 0; at < data.length || parts.length === 0; at += RPC_LIMITS.writeChunk) parts.push({ kind: 'storage_write_request', path: p, data: data.subarray(at, at + RPC_LIMITS.writeChunk) });
    await this.rpc.call(parts, { timeoutMs: RPC_LIMITS.timeoutMs * 2, deadlineMs: RPC_LIMITS.deadlineMs + data.length / SLOWEST_BYTES_PER_MS });
    options.onProgress?.(data.length, data.length);
  }

  async mkdir(path: string): Promise<void> {
    await this.rpc.call({ kind: 'storage_mkdir_request', path: checkFlipperPath(path) });
  }

  /** Delete. A directory only when empty, unless recursive (the interface asks twice for that). */
  async remove(path: string, recursive = false): Promise<void> {
    const p = checkFlipperPath(path);
    if (/^\/(ext|int|any)$/.test(p)) throw new RpcError('HD_BAD_PATH', 'refusing to delete a storage root');
    await this.rpc.call({ kind: 'storage_delete_request', path: p, recursive });
  }

  /** Rename, never onto an existing name. */
  async rename(from: string, to: string): Promise<void> {
    const a = checkFlipperPath(from);
    const b = checkFlipperPath(to);
    if (await this.stat(b)) throw new RpcError('HD_COLLISION', `${b} already exists: not renamed`);
    await this.rpc.call({ kind: 'storage_rename_request', oldPath: a, newPath: b });
  }

  async md5(path: string): Promise<string> {
    return one(await this.rpc.call({ kind: 'storage_md5sum_request', path: checkFlipperPath(path) }), 'storage_md5sum_response').md5;
  }

  /** Read a GPIO pin. Reading never changes the pin's mode. */
  async gpioRead(pin: GpioPin): Promise<{ mode: 'INPUT' | 'OUTPUT'; value: number }> {
    const mode = one(await this.rpc.call({ kind: 'gpio_get_pin_mode', pin }), 'gpio_get_pin_mode_response').mode;
    const value = one(await this.rpc.call({ kind: 'gpio_read_pin', pin }), 'gpio_read_pin_response').value;
    return { mode, value };
  }
}
