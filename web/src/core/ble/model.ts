/**
 * HARDWARE DOG / BLE OBSERVATIONS
 *
 * What a scan sees, kept as it was given, with where it came from:
 *
 *   id          the identifier the adapter API reported, and its kind:
 *               a Web Bluetooth device id (random, per site and browser),
 *               a BlueZ address, a demo id. Not a physical identity: two
 *               ids are never merged, even when they look like one device
 *               (random addresses change on purpose).
 *   address     only when the API gives it, with its type (public, random)
 *   advName     the name in the advertisement; systemName: the name the OS
 *               keeps (cache, alias). A name proves no model.
 *   rssi        dBm as reported. A radio level, never a distance.
 *   payloads    manufacturer and service data, bytes as received.
 *
 * These are what the OS Bluetooth API reports about advertisements, not a
 * radio capture: no packet timing, no channel, no raw PDU.
 */

export type BleSourceKind = 'WEB BLUETOOTH' | 'DOGD' | 'DEMO' | 'REPLAY';
export type BleIdKind = 'web-bluetooth-id' | 'bluez-address' | 'demo-id' | 'replay';

export interface BleObservation {
  /** Host wall clock and monotonic clock at reception, ms. */
  at: number;
  mono: number;
  source: BleSourceKind;
  /** The adapter that saw it, as the source names it ("browser", "hci0 00:1A:7D:..."). */
  adapter: string;
  id: string;
  idKind: BleIdKind;
  address: string | null;
  addressType: 'public' | 'random' | null;
  advName: string | null;
  systemName: string | null;
  rssi: number | null;
  txPower: number | null;
  /** null: the API does not say. */
  connectable: boolean | null;
  /** Service UUIDs advertised: 16-bit as "180F", 128-bit lower case. */
  services: string[];
  manufacturer: { company: number; data: Uint8Array }[];
  serviceData: { uuid: string; data: Uint8Array }[];
}

export interface RssiPoint {
  mono: number;
  rssi: number;
}

export interface BleDevice {
  /** source|id: the same id from two sources is two rows. */
  key: string;
  id: string;
  idKind: BleIdKind;
  source: BleSourceKind;
  adapter: string;
  address: string | null;
  addressType: 'public' | 'random' | null;
  advName: string | null;
  systemName: string | null;
  firstSeen: number;
  lastSeen: number;
  lastMono: number;
  count: number;
  rssi: number | null;
  rssiHistory: RssiPoint[];
  txPower: number | null;
  connectable: boolean | null;
  services: string[];
  manufacturer: Map<number, Uint8Array>;
  serviceData: Map<string, Uint8Array>;
  /** The payload before the last change, per field, for the inspector's comparison. */
  previous: Map<string, Uint8Array>;
  payloadChanges: number;
  /** Advertised entries past BLE_LIMITS.maxEntries: counted, not kept (said in the inspector). */
  truncated: number;
}

export const BLE_LIMITS = {
  maxDevices: 2000,
  rssiPoints: 600,
  maxPayload: 512,
  /** Advertised service UUIDs, manufacturer entries and service data kept per device: the rest is counted, not kept. */
  maxEntries: 64,
} as const;

/** One advertisement is bounded too: an advertiser cannot make one observation cost more than this. */
export const capList = <T>(list: readonly T[]): T[] => list.slice(0, BLE_LIMITS.maxEntries);

/** Estimated presence from the last time seen. An estimate, named so. */
export type Presence = 'PRESENT' | 'RECENT' | 'GONE';
export function presence(d: BleDevice, nowMono: number): Presence {
  const age = nowMono - d.lastMono;
  return age < 10_000 ? 'PRESENT' : age < 60_000 ? 'RECENT' : 'GONE';
}

/** A 16-bit Bluetooth SIG UUID as "180F" when it is one, else lower-case 128-bit. */
export function shortUuid(uuid: string | number): string {
  if (typeof uuid === 'number') return uuid.toString(16).toUpperCase().padStart(4, '0');
  const u = uuid.toLowerCase();
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(u);
  if (m) return m[1]!.toUpperCase();
  if (/^[0-9a-f]{4}$/.test(u)) return u.toUpperCase();
  return u;
}

const same = (a: Uint8Array | undefined, b: Uint8Array) => a !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The live picture of a scan: one row per observed id. Updated on every
 * observation (capture never waits for a screen); the screen reads it at
 * its own pace. Counts what it refuses (too many devices), says it.
 */
export class BleScanModel {
  readonly devices = new Map<string, BleDevice>();
  observations = 0;
  /** Observations not kept: the device table was full. */
  refused = 0;
  /** Losses the source reported (dogd's queue overflowed). */
  sourceLost = 0;
  private window: number[] = [];
  private listeners = new Set<() => void>();
  private rev = 0;

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }

  clear(): void {
    this.devices.clear();
    this.observations = 0;
    this.refused = 0;
    this.sourceLost = 0;
    this.window = [];
    this.changed();
  }

  private changed(): void {
    this.rev++;
    for (const l of [...this.listeners]) l();
  }

  /** Observations per second, over the last second. */
  rate(nowMono: number): number {
    while (this.window.length && nowMono - this.window[0]! > 1000) this.window.shift();
    return this.window.length;
  }

  /** Take one observation. Returns the row and whether its payload changed. */
  add(o: BleObservation): { device: BleDevice; changed: boolean } | null {
    const key = `${o.source}|${o.id}`;
    let d = this.devices.get(key);
    if (!d) {
      if (this.devices.size >= BLE_LIMITS.maxDevices) {
        this.refused++;
        return null;
      }
      d = {
        key,
        id: o.id,
        idKind: o.idKind,
        source: o.source,
        adapter: o.adapter,
        address: o.address,
        addressType: o.addressType,
        advName: null,
        systemName: null,
        firstSeen: o.at,
        lastSeen: o.at,
        lastMono: o.mono,
        count: 0,
        rssi: null,
        rssiHistory: [],
        txPower: null,
        connectable: null,
        services: [],
        manufacturer: new Map(),
        serviceData: new Map(),
        previous: new Map(),
        payloadChanges: 0,
        truncated: 0,
      };
      this.devices.set(key, d);
    }
    this.observations++;
    this.window.push(o.mono);
    if (this.window.length > 5000) this.window.splice(0, this.window.length - 5000);
    d.count++;
    d.lastSeen = o.at;
    d.lastMono = o.mono;
    if (o.advName) d.advName = o.advName;
    if (o.systemName) d.systemName = o.systemName;
    if (o.address) d.address = o.address;
    if (o.addressType) d.addressType = o.addressType;
    if (o.txPower !== null) d.txPower = o.txPower;
    if (o.connectable !== null) d.connectable = o.connectable;
    if (o.rssi !== null) {
      d.rssi = o.rssi;
      d.rssiHistory.push({ mono: o.mono, rssi: o.rssi });
      if (d.rssiHistory.length > BLE_LIMITS.rssiPoints) d.rssiHistory.splice(0, d.rssiHistory.length - BLE_LIMITS.rssiPoints);
    }
    d.truncated += Math.max(0, o.services.length - BLE_LIMITS.maxEntries);
    for (const s of capList(o.services)) {
      if (d.services.includes(s)) continue;
      if (d.services.length < BLE_LIMITS.maxEntries) d.services.push(s);
      else d.truncated++;
    }
    let changed = false;
    const keep = (field: string, map: Map<string | number, Uint8Array>, k: string | number, data: Uint8Array) => {
      const bytes = data.length > BLE_LIMITS.maxPayload ? data.slice(0, BLE_LIMITS.maxPayload) : data;
      const before = map.get(k);
      if (!before && map.size >= BLE_LIMITS.maxEntries) {
        d!.truncated++;
        return;
      }
      if (!same(before, bytes)) {
        if (before) {
          d!.previous.set(field, before);
          d!.payloadChanges++;
        }
        map.set(k, bytes);
        changed = true;
      }
    };
    for (const m of capList(o.manufacturer)) keep(`m:${m.company}`, d.manufacturer as Map<string | number, Uint8Array>, m.company, m.data);
    for (const s of capList(o.serviceData)) keep(`s:${s.uuid}`, d.serviceData as Map<string | number, Uint8Array>, s.uuid, s.data);
    this.changed();
    return { device: d, changed };
  }
}

export type BleSort = 'rssi' | 'name' | 'lastSeen' | 'firstSeen' | 'count';

export interface BleFilter {
  text: string;
  minRssi: number | null;
  namedOnly: boolean;
  connectableOnly: boolean;
}

export const displayName = (d: BleDevice): string | null => d.advName ?? d.systemName;

/** Filter and sort, stable: ties keep the order of their keys, rows never jump between renders. */
export function viewDevices(devices: Iterable<BleDevice>, filter: BleFilter, sort: BleSort, companyName: (c: number) => string | null = () => null): BleDevice[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [...devices].filter((d) => {
    if (filter.minRssi !== null && (d.rssi === null || d.rssi < filter.minRssi)) return false;
    if (filter.namedOnly && !displayName(d)) return false;
    if (filter.connectableOnly && d.connectable !== true) return false;
    if (!words.length) return true;
    const hay = `${d.advName ?? ''} ${d.systemName ?? ''} ${d.id} ${d.address ?? ''} ${d.services.join(' ')} ${[...d.manufacturer.keys()].map((c) => `${shortUuid(c)} ${companyName(c) ?? ''}`).join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const by: Record<BleSort, (a: BleDevice, b: BleDevice) => number> = {
    rssi: (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
    name: (a, b) => (displayName(a) ?? '￿').localeCompare(displayName(b) ?? '￿'),
    lastSeen: (a, b) => b.lastMono - a.lastMono,
    firstSeen: (a, b) => a.firstSeen - b.firstSeen,
    count: (a, b) => b.count - a.count,
  };
  return out.sort((a, b) => by[sort](a, b) || a.key.localeCompare(b.key));
}
