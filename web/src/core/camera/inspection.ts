/**
 * HARDWARE DOG / CAMERA SNIFFER / GUIDED PHYSICAL INSPECTION
 *
 * A room, the objects in it, what was seen, the next check. Photos are
 * taken and annotated in this browser and stay in it (IndexedDB); nothing
 * is sent anywhere.
 *
 * The priority is an aid to organise the visit, never a probability of a
 * camera: it orders objects by what the person told us (a private room,
 * an object facing a private space, a concrete observation to check). An
 * object is never flagged for belonging to the catalog.
 */

import { newOp, type LabBus, type LabOrigin } from '../lab/events';
import type { KvBackend } from '../lab/store';
import { family, type Room } from './catalog';

export const ITEM_STATUSES = ['TO_EXAMINE', 'EXAMINED_NOTHING_NOTED', 'NEEDS_CHECK', 'CONFIRMED_DOCUMENTED', 'NOT_VERIFIED'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const STATUS_LABEL: Record<ItemStatus, string> = {
  TO_EXAMINE: 'To examine',
  EXAMINED_NOTHING_NOTED: 'Examined: nothing noted',
  NEEDS_CHECK: 'Needs a further check',
  CONFIRMED_DOCUMENTED: 'Camera confirmed (documented)',
  NOT_VERIFIED: 'Could not be verified',
};

export interface Annotation {
  /** 0..1 of the photo. */
  x: number;
  y: number;
  note: string;
}

export interface PhotoRecord {
  id: string;
  itemId: string;
  at: number;
  type: string;
  width: number;
  height: number;
  data: Blob;
  annotations: Annotation[];
}

export interface Item {
  id: string;
  /** A catalog family, or null for an object the catalog does not cover. */
  familyId: string | null;
  label: string;
  where: string;
  /** Faces a bed, a shower, a toilet, a changing area. */
  facesPrivate: boolean;
  /** Something concrete was seen that needs a check (an opening, a reference, an orientation). */
  concrete: boolean;
  status: ItemStatus;
  observations: string;
  nextCheck: string;
  checksDone: string[];
  photos: string[];
  updated: number;
}

export interface RoomVisit {
  id: string;
  kind: Room;
  label: string;
  items: Item[];
}

export interface Inspection {
  id: string;
  created: number;
  place: string;
  rooms: RoomVisit[];
  finished: number | null;
}

const PRIVATE_ROOMS: Room[] = ['bedroom', 'bathroom'];

/** Organisation priority, 0..3: the order of the visit, not a likelihood. */
export function priority(room: RoomVisit, item: Item): number {
  return (PRIVATE_ROOMS.includes(room.kind) ? 1 : 0) + (item.facesPrivate ? 1 : 0) + (item.concrete ? 1 : 0);
}

/** Why an item is where it is in the order, in the person's own terms. */
export function priorityWhy(room: RoomVisit, item: Item): string[] {
  const why: string[] = [];
  if (PRIVATE_ROOMS.includes(room.kind)) why.push('private room');
  if (item.facesPrivate) why.push('faces a private space');
  if (item.concrete) why.push('a concrete observation to check');
  return why;
}

const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const newInspection = (place = ''): Inspection => ({ id: id('insp'), created: Date.now(), place, rooms: [], finished: null });

export class Inspections {
  current: Inspection = newInspection();
  private listeners = new Set<() => void>();
  private rev = 0;
  origin: LabOrigin = 'PHYSICAL';

  constructor(
    private readonly bus: LabBus,
    private readonly store: KvBackend<Inspection>,
    readonly photos: KvBackend<PhotoRecord>,
  ) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }
  private changed(save = true): void {
    this.rev++;
    if (save) void this.store.put(this.current.id, this.current).catch(() => {});
    for (const l of [...this.listeners]) l();
  }

  /** The most recent unfinished inspection, if this browser kept one. */
  async restore(): Promise<void> {
    const all = await this.store.all().catch(() => [] as Inspection[]);
    const open = all.filter((i) => !i.finished).sort((a, b) => b.created - a.created)[0];
    if (open) {
      this.current = open;
      this.changed(false);
    }
  }

  start(place: string): void {
    this.current = newInspection(place.trim());
    this.bus.emit({ source: 'USER', tool: 'camera.inspect', type: 'marker', severity: 'INFO', message: `inspection started${place.trim() ? `: ${place.trim()}` : ''}`, origin: this.origin, params: { declared: true } });
    this.changed();
  }

  addRoom(kind: Room, label = ''): RoomVisit {
    const r: RoomVisit = { id: id('room'), kind, label: label.trim(), items: [] };
    this.current.rooms.push(r);
    this.changed();
    return r;
  }

  removeRoom(roomId: string): void {
    this.current.rooms = this.current.rooms.filter((r) => r.id !== roomId);
    this.changed();
  }

  addItem(roomId: string, familyId: string | null, label = '', where = ''): Item | null {
    const room = this.current.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    const f = family(familyId);
    const item: Item = {
      id: id('item'),
      familyId: f?.id ?? null,
      label: label.trim() || f?.name || 'Object',
      where: where.trim(),
      facesPrivate: false,
      concrete: false,
      status: 'TO_EXAMINE',
      observations: '',
      nextCheck: '',
      checksDone: [],
      photos: [],
      updated: Date.now(),
    };
    room.items.push(item);
    this.changed();
    return item;
  }

  find(itemId: string): { room: RoomVisit; item: Item } | null {
    for (const room of this.current.rooms) {
      const item = room.items.find((i) => i.id === itemId);
      if (item) return { room, item };
    }
    return null;
  }

  /** Change an object. A status change is said on the timeline (and on the TV). */
  update(itemId: string, patch: Partial<Omit<Item, 'id'>>): void {
    const found = this.find(itemId);
    if (!found) return;
    const before = found.item.status;
    Object.assign(found.item, patch, { updated: Date.now() });
    if (patch.status && patch.status !== before) {
      const op = newOp('camera.object');
      const say = patch.status === 'NEEDS_CHECK' ? 'cam.visual' : undefined;
      this.bus.emit({ source: 'CAMERA', tool: 'camera.object', type: 'op.start', op, severity: 'INFO', message: `examining ${found.item.label}`, origin: this.origin, params: { kind: 'read' } });
      this.bus.emit({
        source: 'USER',
        tool: 'camera.object',
        type: 'note',
        op,
        severity: 'INFO',
        message: `${found.item.label} (${found.room.label || found.room.kind}): ${STATUS_LABEL[patch.status]}${found.item.observations ? ` · ${found.item.observations}` : ''}`,
        origin: this.origin,
        params: { declared: true, status: patch.status, family: found.item.familyId },
      });
      this.bus.emit({ source: 'CAMERA', tool: 'camera.object', type: 'op.end', op, severity: 'PASS', message: `${found.item.label}: ${STATUS_LABEL[patch.status]}`, origin: this.origin, params: { ...(say ? { say } : {}) } });
    }
    this.changed();
  }

  removeItem(itemId: string): void {
    for (const r of this.current.rooms) r.items = r.items.filter((i) => i.id !== itemId);
    this.changed();
  }

  /** The objects of the visit, ordered by organisation priority, then as added. */
  ordered(): { room: RoomVisit; item: Item; priority: number }[] {
    const all = this.current.rooms.flatMap((room, ri) => room.items.map((item, ii) => ({ room, item, priority: priority(room, item), order: ri * 1000 + ii })));
    return all.sort((a, b) => b.priority - a.priority || a.order - b.order).map(({ room, item, priority: p }) => ({ room, item, priority: p }));
  }

  async addPhoto(itemId: string, data: Blob, width: number, height: number): Promise<PhotoRecord | null> {
    const found = this.find(itemId);
    if (!found) return null;
    const rec: PhotoRecord = { id: id('photo'), itemId, at: Date.now(), type: data.type || 'image/jpeg', width, height, data, annotations: [] };
    await this.photos.put(rec.id, rec);
    found.item.photos.push(rec.id);
    this.bus.emit({ source: 'USER', tool: 'camera.photo', type: 'note', severity: 'INFO', message: `photo of ${found.item.label} kept in this browser`, origin: this.origin, params: { declared: true, photo: rec.id } });
    this.changed();
    return rec;
  }

  async annotate(photoId: string, annotations: Annotation[]): Promise<void> {
    const rec = await this.photos.get(photoId);
    if (!rec) return;
    rec.annotations = annotations.slice(0, 40).map((a) => ({ x: Math.min(1, Math.max(0, a.x)), y: Math.min(1, Math.max(0, a.y)), note: a.note.slice(0, 300) }));
    await this.photos.put(photoId, rec);
    this.changed(false);
  }

  async removePhoto(photoId: string): Promise<void> {
    await this.photos.remove(photoId);
    for (const r of this.current.rooms) for (const i of r.items) i.photos = i.photos.filter((p) => p !== photoId);
    this.changed();
  }

  /** End the visit: the report says what was and was not verified. */
  finish(): void {
    this.current.finished = Date.now();
    const op = newOp('camera.inspect');
    const left = this.current.rooms.flatMap((r) => r.items).filter((i) => i.status === 'TO_EXAMINE' || i.status === 'NEEDS_CHECK').length;
    this.bus.emit({ source: 'CAMERA', tool: 'camera.inspect', type: 'op.start', op, severity: 'INFO', message: 'inspection finished', origin: this.origin, params: { kind: 'read' } });
    this.bus.emit({ source: 'CAMERA', tool: 'camera.inspect', type: 'op.end', op, severity: 'PASS', message: `inspection finished${left ? `: ${left} object(s) left to check` : ''}`, origin: this.origin, params: { say: 'cam.done', left } });
    this.changed();
  }

  reopen(): void {
    this.current.finished = null;
    this.changed();
  }
}
