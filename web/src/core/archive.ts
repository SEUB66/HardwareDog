/**
 * HARDWARE DOG / SESSION ARCHIVE
 *
 * Every live session is written to this browser while it happens, as
 * chunks of .hdlog lines (IndexedDB). Nothing leaves the machine.
 *
 *   sessions   key -> SessionMeta (header, counts, last diagnoses)
 *   chunks     [key, seq] -> NDJSON text, in write order
 *
 * An archived session exports byte for byte as an .hdlog file: header
 * line, then the chunks in order.
 *
 * Retention: simulator sessions are pruned (newest SIM_RETENTION kept).
 * Sessions recorded from real hardware are never deleted automatically:
 * they are evidence. The operator deletes them.
 */

import type { Recording, SessionEntry, SessionHeader, SessionRecorder } from './session';
import { encodeEntry, parseHdlog } from './session';

export const SIM_RETENTION = 5;
/** Flush to storage when this much text is waiting, even between ticks. */
const CHUNK_BYTES = 256 * 1024;

export interface SessionMeta {
  key: string;
  header: SessionHeader;
  entries: number;
  /** Size of the .hdlog file, header included. */
  bytes: number;
  /** Host time of the last entry written. */
  lastAt: number;
  /** Diagnoses as "ID:CONFIDENCE" when last written. */
  diagnoses: string[];
}

export interface ArchiveBackend {
  readonly kind: 'INDEXEDDB' | 'MEMORY';
  list(): Promise<SessionMeta[]>;
  /** Store the meta, and the chunk when `text` is not empty, atomically. */
  append(meta: SessionMeta, seq: number, text: string): Promise<void>;
  chunks(key: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

// ------------------------------------------------------------------ writer

/** Streams one recorder into the archive, a chunk at a time, in order. */
export class ArchiveWriter {
  readonly meta: SessionMeta;
  /** Set when a write failed. Recording stops there: no silent gaps. */
  error: string | null = null;

  private pending: string[] = [];
  private pendingBytes = 0;
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly onError: (message: string) => void;

  constructor(
    private readonly backend: ArchiveBackend,
    recorder: SessionRecorder,
    private readonly summary: () => string[] = () => [],
    options: { flushMs?: number | null; onError?: (message: string) => void } = {},
  ) {
    const h = recorder.header;
    this.meta = {
      key: `${h.startedAt}-${Math.random().toString(36).slice(2, 6)}`,
      header: h,
      entries: 0,
      bytes: byteLength(JSON.stringify(h)) + 1,
      lastAt: h.startedAt,
      diagnoses: [],
    };
    this.onError = options.onError ?? (() => {});
    this.unsubscribe = recorder.onEntry((e) => this.add(e));
    const flushMs = options.flushMs === undefined ? 2000 : options.flushMs;
    if (flushMs !== null) this.timer = setInterval(() => void this.flush(), flushMs);
    void this.flush(); // the session is listed from its first second
  }

  private add(e: SessionEntry): void {
    if (this.stopped) return;
    const line = encodeEntry(e);
    this.pending.push(line);
    const size = byteLength(line) + 1;
    this.pendingBytes += size;
    this.meta.entries++;
    this.meta.bytes += size;
    this.meta.lastAt = e.at;
    if (this.pendingBytes >= CHUNK_BYTES) void this.flush();
  }

  /** Write what is waiting. Writes are queued, so chunks never reorder. */
  flush(): Promise<void> {
    if (this.error) return this.queue;
    const text = this.pending.length ? this.pending.join('\n') + '\n' : '';
    this.pending = [];
    this.pendingBytes = 0;
    const seq = text ? this.seq++ : -1;
    const snapshot: SessionMeta = { ...this.meta, header: { ...this.meta.header }, diagnoses: this.summary() };
    this.queue = this.queue.then(async () => {
      if (this.error) return;
      try {
        await this.backend.append(snapshot, seq, text);
      } catch (err) {
        this.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        this.close();
        this.onError(this.error);
      }
    });
    return this.queue;
  }

  /** Final write, then detach from the recorder. */
  async stop(): Promise<void> {
    await this.flush();
    this.close();
  }

  private close(): void {
    this.stopped = true;
    this.unsubscribe();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

// ------------------------------------------------------------------ archive

export class SessionArchive {
  constructor(readonly backend: ArchiveBackend) {}

  /** IndexedDB when the browser allows it, memory otherwise. */
  static async open(timeoutMs = 1500): Promise<SessionArchive> {
    const idb = await Promise.race([
      idbBackend(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return new SessionArchive(idb ?? memoryBackend());
  }

  get persistent(): boolean {
    return this.backend.kind === 'INDEXEDDB';
  }

  /** Newest first. */
  async list(): Promise<SessionMeta[]> {
    const all = await this.backend.list();
    return all.sort((a, b) => b.header.startedAt - a.header.startedAt);
  }

  record(recorder: SessionRecorder, summary?: () => string[], options?: ConstructorParameters<typeof ArchiveWriter>[3]): ArchiveWriter {
    return new ArchiveWriter(this.backend, recorder, summary, options);
  }

  /** The archived session as an .hdlog file. */
  async text(key: string): Promise<string> {
    const meta = (await this.backend.list()).find((m) => m.key === key);
    if (!meta) throw new Error(`no archived session ${key}`);
    return JSON.stringify(meta.header) + '\n' + (await this.backend.chunks(key)).join('');
  }

  async load(key: string): Promise<Recording> {
    return parseHdlog(await this.text(key));
  }

  remove(key: string): Promise<void> {
    return this.backend.remove(key);
  }

  /**
   * Drop old simulator sessions, and hardware sessions that recorded
   * nothing. A hardware session with data is never pruned. `active` keys
   * are being recorded and are always kept.
   */
  async prune(active: readonly string[] = []): Promise<string[]> {
    const all = await this.list();
    let sims = all.filter((m) => m.header.source === 'SIMULATOR' && active.includes(m.key)).length;
    const drop: string[] = [];
    for (const m of all) {
      if (active.includes(m.key)) continue;
      if (m.header.source !== 'SIMULATOR') {
        if (m.entries === 0) drop.push(m.key);
      } else if (sims < SIM_RETENTION) sims++;
      else drop.push(m.key);
    }
    for (const key of drop) await this.backend.remove(key);
    return drop;
  }
}

// ------------------------------------------------------------------ backends

export function memoryBackend(): ArchiveBackend {
  const metas = new Map<string, SessionMeta>();
  const chunks = new Map<string, string[]>();
  return {
    kind: 'MEMORY',
    async list() {
      return [...metas.values()].map((m) => structuredClone(m));
    },
    async append(meta, seq, text) {
      metas.set(meta.key, structuredClone(meta));
      if (text) {
        const list = chunks.get(meta.key) ?? [];
        list[seq] = text;
        chunks.set(meta.key, list);
      }
    },
    async chunks(key) {
      return (chunks.get(key) ?? []).filter((c) => c !== undefined);
    },
    async remove(key) {
      metas.delete(key);
      chunks.delete(key);
    },
  };
}

const DB_NAME = 'hwdog';
const DB_VERSION = 1;

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });

/** IndexedDB backend, or null when the browser refuses storage. */
export async function idbBackend(factory: IDBFactory | null = globalThis.indexedDB ?? null): Promise<ArchiveBackend | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: ['key', 'seq'] });
    };
    db = await request(open);
  } catch {
    return null;
  }
  const range = (key: string) => IDBKeyRange.bound([key, 0], [key, Infinity]);
  return {
    kind: 'INDEXEDDB',
    async list() {
      return request(db.transaction('sessions').objectStore('sessions').getAll() as IDBRequest<SessionMeta[]>);
    },
    async append(meta, seq, text) {
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').put(meta);
      if (text) tx.objectStore('chunks').put({ key: meta.key, seq, text });
      await done(tx);
    },
    async chunks(key) {
      const rows = await request(db.transaction('chunks').objectStore('chunks').getAll(range(key)) as IDBRequest<{ text: string }[]>);
      return rows.map((r) => r.text);
    },
    async remove(key) {
      const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').delete(key);
      tx.objectStore('chunks').delete(range(key));
      await done(tx);
    },
  };
}
