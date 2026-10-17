/**
 * HARDWARE DOG / LAB STORE
 *
 * Lab sessions and the local capture library live in this browser
 * (IndexedDB), or in memory when the browser refuses storage. Nothing
 * leaves the machine.
 *
 *   hwdog-lab / sessions   id -> { meta, text }   .hdlab files
 *   hwdog-lab / library    id -> LibraryItem      files copied from a Flipper
 *   hwdog-lab / camera     id -> Inspection       Camera Sniffer inspections (rooms, objects, notes)
 *   hwdog-lab / photos     id -> PhotoRecord      photos taken during an inspection, never sent anywhere
 */

export interface KvBackend<T> {
  readonly kind: 'INDEXEDDB' | 'MEMORY';
  all(): Promise<T[]>;
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
const STORES = ['sessions', 'library', 'camera', 'photos'] as const;
export type LabStoreName = (typeof STORES)[number];

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 2: Camera Sniffer's stores; an older database gets them on upgrade, its data untouched.
    const req = factory.open(DB, 2);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
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
export async function openLabStore<T>(name: LabStoreName, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<KvBackend<T>> {
  if (!factory) return new MemoryKv<T>();
  shared ??= openDb(factory).catch(() => null);
  const db = await shared;
  return db ? new IdbKv<T>(db, name) : new MemoryKv<T>();
}

/** Tests: forget the shared connection. */
export function resetLabStore(): void {
  shared = null;
}
