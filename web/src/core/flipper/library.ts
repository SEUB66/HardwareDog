/**
 * HARDWARE DOG / LOCAL CAPTURE LIBRARY
 *
 * Files copied from a Flipper, on explicit request only, kept in this
 * browser with where they came from: the device path, the device, real or
 * demo, when, and their SHA-256. Notes, tags, search and sort are local.
 * Nothing is uploaded; nothing is written back to a device from here
 * without the operator asking (and confirming an overwrite).
 */

import { sha256 } from '../sha256';
import type { KvBackend } from '../lab/store';
import { kindFromPath, type FileKind } from './formats';

export interface LibraryItem {
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
  data: Uint8Array;
  notes: string;
  tags: string[];
}

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
  constructor(private readonly kv: KvBackend<LibraryItem>) {}

  get persistent(): boolean {
    return this.kv.kind === 'INDEXEDDB';
  }

  list(): Promise<LibraryItem[]> {
    return this.kv.all();
  }

  /** Add a copy. The same bytes from the same path are not stored twice: the existing item comes back. */
  async add(input: { path: string; device: string; origin: LibraryItem['origin']; data: Uint8Array; at: number }): Promise<{ item: LibraryItem; added: boolean }> {
    const hash = sha256(input.data);
    const id = sha256(`${hash}:${input.path}`).slice(0, 32);
    const existing = await this.kv.get(id);
    if (existing) return { item: existing, added: false };
    const all = await this.kv.all();
    if (all.length >= LIBRARY_LIMITS.maxItems) throw new Error(`the library holds ${LIBRARY_LIMITS.maxItems} items: remove some first`);
    const item: LibraryItem = {
      id,
      name: input.path.split('/').pop() || input.path,
      path: input.path,
      device: input.device,
      origin: input.origin,
      copiedAt: input.at,
      size: input.data.length,
      sha256: hash,
      kind: kindFromPath(input.path),
      data: input.data,
      notes: '',
      tags: input.origin === 'SIMULATED' ? ['demo'] : [],
    };
    await this.kv.put(id, item);
    return { item, added: true };
  }

  async annotate(id: string, change: { notes?: string; tags?: string[] }): Promise<LibraryItem> {
    const item = await this.kv.get(id);
    if (!item) throw new Error('no such library item');
    if (change.notes !== undefined) item.notes = change.notes.slice(0, LIBRARY_LIMITS.maxNotes);
    if (change.tags !== undefined) item.tags = [...new Set(change.tags.map(cleanTag).filter(Boolean))].slice(0, LIBRARY_LIMITS.maxTags);
    await this.kv.put(id, item);
    return item;
  }

  remove(id: string): Promise<void> {
    return this.kv.remove(id);
  }
}

/**
 * Search and sort, stable: equal items keep the order of their ids, so a
 * list never reshuffles between two renders. Words must all match (name,
 * path, kind, device, tags, notes); `tag:x` and `kind:x` match exactly.
 */
export function searchLibrary(items: readonly LibraryItem[], query: string, sort: LibrarySort = 'newest'): LibraryItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (i: LibraryItem) =>
    words.every((w) => {
      if (w.startsWith('tag:')) return i.tags.includes(w.slice(4));
      if (w.startsWith('kind:')) return i.kind === w.slice(5);
      return `${i.name} ${i.path} ${i.kind} ${i.device} ${i.tags.join(' ')} ${i.notes}`.toLowerCase().includes(w);
    });
  const by: Record<LibrarySort, (a: LibraryItem, b: LibraryItem) => number> = {
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
