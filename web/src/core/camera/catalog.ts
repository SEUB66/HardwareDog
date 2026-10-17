/**
 * HARDWARE DOG / CAMERA SNIFFER / OBJECT CATALOG
 *
 * Families of everyday objects in which cameras have been sold or
 * documented, bundled with the interface: it works offline. Never ranked
 * by frequency (there are no reliable statistics on what is found in
 * rentals): alphabetical, and filtered by what the person is looking at.
 *
 * A documented model cites where it was seen, when, and how far it was
 * verified. Vendor claims are claims. No photo is shown unless its reuse
 * is allowed and credited; otherwise a generic drawing, labeled as one.
 */

import data from './data/catalog.json';

export type Room = 'bedroom' | 'bathroom' | 'living' | 'kitchen' | 'office' | 'entrance' | 'vehicle';
export type Power = 'mains' | 'battery' | 'usb';
export type Comms = 'wifi' | 'ble' | 'none';
export type InspectMethod = 'visual' | 'orientation' | 'reference' | 'network' | 'ble' | 'usb';

export interface DocumentedModel {
  vendor: string;
  model: string;
  kind: string;
  title: string;
  /** Where it was seen (a site and path, shown as text: copy it to open it). */
  source: string;
  retrieved: string;
  /** false: the page could not be read or the claims were not checked. */
  verified: boolean;
  status: string;
  claims: string[];
  lens: string;
  /** A credited, reusable photo, when there is one. None in this version. */
  photo: { file: string; credit: string; license: string } | null;
}

export interface Family {
  id: string;
  name: string;
  rooms: Room[];
  power: Power[];
  storage: 'documented' | 'unknown';
  comms: Comms[];
  methods: InspectMethod[];
  observable: string[];
  lookalikes: string[];
  checks: string[];
  limits: string;
  models: DocumentedModel[];
}

export interface Catalog {
  version: string;
  note: string;
  rooms: Room[];
  families: Family[];
  references: { title: string; venue: string; use: string }[];
  vendors: { name: string; note: string }[];
}

export const CATALOG = data as unknown as Catalog;

export const ROOM_LABEL: Record<Room, string> = {
  bedroom: 'Bedroom',
  bathroom: 'Bathroom',
  living: 'Living room',
  kitchen: 'Kitchen',
  office: 'Office',
  entrance: 'Entrance / hallway',
  vehicle: 'Vehicle',
};

export const POWER_LABEL: Record<Power, string> = { mains: 'Mains', battery: 'Battery', usb: 'USB' };
export const COMMS_LABEL: Record<Comms, string> = { wifi: 'Wi-Fi documented', ble: 'Bluetooth documented', none: 'No radio (card only)' };
export const METHOD_LABEL: Record<InspectMethod, string> = {
  visual: 'Visual inspection',
  orientation: 'Orientation',
  reference: 'Product reference',
  network: 'Network scan',
  ble: 'Bluetooth scan',
  usb: 'USB inspection',
};

export interface CatalogFilter {
  room: Room | null;
  power: Power | null;
  storage: boolean;
  comms: Comms | null;
  method: InspectMethod | null;
  text: string;
}

export const emptyFilter = (): CatalogFilter => ({ room: null, power: null, storage: false, comms: null, method: null, text: '' });

/** The families matching a filter, alphabetical (never by frequency). */
export function filterFamilies(filter: CatalogFilter, families: Family[] = CATALOG.families): Family[] {
  const q = filter.text.trim().toLowerCase();
  return families
    .filter(
      (f) =>
        (!filter.room || f.rooms.includes(filter.room)) &&
        (!filter.power || f.power.includes(filter.power)) &&
        (!filter.storage || f.storage === 'documented') &&
        (!filter.comms || f.comms.includes(filter.comms)) &&
        (!filter.method || f.methods.includes(filter.method)) &&
        (!q || f.name.toLowerCase().includes(q) || f.observable.some((o) => o.toLowerCase().includes(q)) || f.lookalikes.some((o) => o.toLowerCase().includes(q))),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const family = (id: string | null | undefined): Family | undefined => CATALOG.families.find((f) => f.id === id);
