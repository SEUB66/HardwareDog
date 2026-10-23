/**
 * HARDWARE DOG / LOCAL CAPTURE LIBRARY
 *
 * Files copied from a Flipper, on explicit request only, kept in this
 * browser with where they came from: the device path, the device, real or
 * demo, when, and their SHA-256. Notes, tags, search and sort are local.
 * Nothing is uploaded; nothing is written back to a device from here
 * without the operator asking (and confirming an overwrite).
 *
 * What a list shows (LibraryEntry) and the bytes are kept apart: listing,
 * searching and the item limit never load a file; its bytes are read
 * when it is opened, compared or saved.
 */

import { sha256 } from '../sha256';
import type { KvBackend } from '../lab/store';
import { kindFromPath, type FileKind } from './formats';

export interface LibraryEntry {
  /** sha256 + device path: the same bytes from two places are two items. */
  id: string;
  name: string;
  path: string;
  /** The device it came from, as it named itself (hardware.name), or its link label. */
  device: string;
  origin: 'PHYSICAL' | 'SIMULATED';
  copiedAt: number;
  size: number;
  sha256: string;
  kind: FileKind;
  notes: string;
  tags: string[];
}

export interface LibraryItem extends LibraryEntry {
  data: Uint8Array;
}

/** An entry as stored; items copied before the split still carry their bytes until the upgrade moves them. */
type Stored = LibraryEntry & { data?: Uint8Array };

const entryOf = (v: Stored): LibraryEntry => {
  const { data: _bytes, ...entry } = v;
  return entry;
};

export type LibrarySort = 'newest' | 'oldest' | 'name' | 'kind' | 'size';

export const LIBRARY_LIMITS = { maxItems: 5000, maxTags: 16, maxTagLength: 32, maxNotes: 4000 } as const;

/** A tag as stored: trimmed, lower case, no spaces, bounded. */
export const cleanTag = (t: string): string =>
  t
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIBRARY_LIMITS.maxTagLength);

export class FlipperLibrary {
  constructor(
    private readonly kv: KvBackend<Stored>,
    private readonly bytes: KvBackend<Uint8Array>,
  ) {}

  get persistent(): boolean {
    return this.kv.kind === 'INDEXEDDB';
  }

  /** Every entry, without the files' bytes. */
  async list(): Promise<LibraryEntry[]> {
    return (await this.kv.all()).map(entryOf);
  }

  /** One item with its bytes; null when it is gone. */
  async open(id: string): Promise<LibraryItem | null> {
    const v = await this.kv.get(id);
    if (!v) return null;
    const data = v.data ?? (await this.bytes.get(id));
    if (!data) throw new Error(`the bytes of ${v.name} are missing from this browser`);
    return { ...entryOf(v), data };
  }

  /** Add a copy. The same bytes from the same path are not stored twice: the existing item comes back. */
  async add(input: { path: string; device: string; origin: LibraryItem['origin']; data: Uint8Array; at: number }): Promise<{ item: LibraryItem; added: boolean }> {
    const hash = sha256(input.data);
    const id = sha256(`${hash}:${input.path}`).slice(0, 32);
    const existing = await this.kv.get(id);
    // Same hash, same bytes: what was passed is what is kept.
    if (existing) return { item: { ...entryOf(existing), data: input.data }, added: false };
    if ((await this.kv.count()) >= LIBRARY_LIMITS.maxItems) throw new Error(`the library holds ${LIBRARY_LIMITS.maxItems} items: remove some first`);
    const entry: LibraryEntry = {
      id,
      name: input.path.split('/').pop() || input.path,
      path: input.path,
      device: input.device,
      origin: input.origin,
      copiedAt: input.at,
      size: input.data.length,
      sha256: hash,
      kind: kindFromPath(input.path),
      notes: '',
      tags: input.origin === 'SIMULATED' ? ['demo'] : [],
    };
    // Bytes first: an entry never lists a file that is not there.
    await this.bytes.put(id, input.data);
    await this.kv.put(id, entry);
    return { item: { ...entry, data: input.data }, added: true };
  }

  async annotate(id: string, change: { notes?: string; tags?: string[] }): Promise<LibraryEntry> {
    const v = await this.kv.get(id);
    if (!v) throw new Error('no such library item');
    if (change.notes !== undefined) v.notes = change.notes.slice(0, LIBRARY_LIMITS.maxNotes);
    if (change.tags !== undefined) v.tags = [...new Set(change.tags.map(cleanTag).filter(Boolean))].slice(0, LIBRARY_LIMITS.maxTags);
    await this.kv.put(id, v);
    return entryOf(v);
  }

  async remove(id: string): Promise<void> {
    await this.kv.remove(id);
    await this.bytes.remove(id);
  }
}

/**
 * Search and sort, stable: equal items keep the order of their ids, so a
 * list never reshuffles between two renders. Words must all match (name,
 * path, kind, device, tags, notes); `tag:x` and `kind:x` match exactly.
 */
export function searchLibrary<T extends LibraryEntry>(items: readonly T[], query: string, sort: LibrarySort = 'newest'): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (i: LibraryEntry) =>
    words.every((w) => {
      if (w.startsWith('tag:')) return i.tags.includes(w.slice(4));
      if (w.startsWith('kind:')) return i.kind === w.slice(5);
      return `${i.name} ${i.path} ${i.kind} ${i.device} ${i.tags.join(' ')} ${i.notes}`.toLowerCase().includes(w);
    });
  const by: Record<LibrarySort, (a: LibraryEntry, b: LibraryEntry) => number> = {
    newest: (a, b) => b.copiedAt - a.copiedAt,
    oldest: (a, b) => a.copiedAt - b.copiedAt,
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => a.kind.localeCompare(b.kind),
    size: (a, b) => b.size - a.size,
  };
  return items.filter(hit).sort((a, b) => by[sort](a, b) || a.id.localeCompare(b.id));
}

/** A safe local file name for a download: no path, no control characters. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const n = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return n || 'file';
}
