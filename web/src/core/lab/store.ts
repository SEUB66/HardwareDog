/**
 * HARDWARE DOG / LAB STORE
 *
 * Lab sessions and the local capture library live in this browser
 * (IndexedDB), or in memory when the browser refuses storage. Nothing
 * leaves the machine.
 *
 *   hwdog-lab / sessions   id -> { meta, text }   .hdlab files
 *   hwdog-lab / library    id -> LibraryEntry     files copied from a Flipper: what, from where, notes
 *   hwdog-lab / library-data id -> Uint8Array    their bytes, apart: a list never loads every file
 *   hwdog-lab / camera     id -> Inspection       Camera Sniffer inspections (rooms, objects, notes)
 *   hwdog-lab / photos     id -> PhotoRecord      photos taken during an inspection, never sent anywhere
 */

import { browserIndexedDb } from '../archive';

export interface KvBackend<T> {
  readonly kind: 'INDEXEDDB' | 'MEMORY';
  all(): Promise<T[]>;
  count(): Promise<number>;
  get(id: string): Promise<T | undefined>;
  put(id: string, value: T): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryKv<T> implements KvBackend<T> {
  readonly kind = 'MEMORY' as const;
  private map = new Map<string, T>();
  async all(): Promise<T[]> {
    return [...this.map.values()];
  }
  async count(): Promise<number> {
    return this.map.size;
  }
  async get(id: string): Promise<T | undefined> {
    return this.map.get(id);
  }
  async put(id: string, value: T): Promise<void> {
    this.map.set(id, value);
  }
  async remove(id: string): Promise<void> {
    this.map.delete(id);
  }
}

const DB = 'hwdog-lab';
const STORES = ['sessions', 'library', 'library-data', 'camera', 'photos'] as const;
export type LabStoreName = (typeof STORES)[number];

/** Why the lab works in memory only, when it does (null: it does not, or no reason known). */
let problem: string | null = null;
export const labStoreProblem = (): string | null => problem;

function openDb(factory: IDBFactory, blockedWait = 4000): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 2: Camera Sniffer's stores; an older database gets them on upgrade, its data untouched.
    // 3: library bytes in their own store; items copied before move there, once.
    const req = factory.open(DB, 3);
    let late: ReturnType<typeof setTimeout> | null = null;
    req.onupgradeneeded = (ev) => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      if (ev.oldVersion > 0 && ev.oldVersion < 3) splitLibrary(req.transaction!);
    };
    req.onsuccess = () => {
      if (late) clearTimeout(late);
      const db = req.result;
      // A newer version opened in another tab: let it upgrade instead of blocking it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    // Another tab still holds the older version open. The upgrade waits for it to close;
    // past a few seconds the lab goes on in memory, and says why.
    req.onblocked = () => {
      late ??= setTimeout(() => {
        problem = 'Another Hardware Dog tab holds an older version of the lab (close it, then reload this page)';
        reject(new Error('indexedDB blocked'));
      }, blockedWait);
    };
  });
}

/** Move each library item's bytes to library-data, in the upgrade's own transaction. */
function splitLibrary(tx: IDBTransaction): void {
  const items = tx.objectStore('library');
  const bytes = tx.objectStore('library-data');
  const walk = items.openCursor();
  walk.onsuccess = () => {
    const c = walk.result;
    if (!c) return;
    const v = c.value as { data?: unknown } | null;
    if (v && v.data instanceof Uint8Array) {
      const { data, ...meta } = v;
      bytes.put(data, c.key);
      c.update(meta);
    }
    c.continue();
  };
}

class IdbKv<T> implements KvBackend<T> {
  readonly kind = 'INDEXEDDB' as const;
  constructor(
    private readonly db: IDBDatabase,
    private readonly store: LabStoreName,
  ) {}

  private request<R>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.store, mode);
      const req = run(tx.objectStore(this.store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  }

  all(): Promise<T[]> {
    return this.request('readonly', (s) => s.getAll() as IDBRequest<T[]>);
  }
  count(): Promise<number> {
    return this.request('readonly', (s) => s.count());
  }
  get(id: string): Promise<T | undefined> {
    return this.request('readonly', (s) => s.get(id) as IDBRequest<T | undefined>);
  }
  async put(id: string, value: T): Promise<void> {
    await this.request('readwrite', (s) => s.put(value, id));
  }
  async remove(id: string): Promise<void> {
    await this.request('readwrite', (s) => s.delete(id));
  }
}

let shared: Promise<IDBDatabase | null> | null = null;

/** A store of the lab database; memory when IndexedDB is not there or refuses. */
export async function openLabStore<T>(name: LabStoreName, factory: IDBFactory | undefined = browserIndexedDb() ?? undefined): Promise<KvBackend<T>> {
  if (!factory) return new MemoryKv<T>();
  shared ??= openDb(factory).catch(() => null);
  const db = await shared;
  return db ? new IdbKv<T>(db, name) : new MemoryKv<T>();
}

/** Tests: forget the shared connection. */
export function resetLabStore(): void {
  shared = null;
}
