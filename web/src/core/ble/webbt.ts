/**
 * HARDWARE DOG / WEB BLUETOOTH
 *
 * What the browser's Bluetooth API offers, typed here (it is not part of
 * TypeScript's DOM library), and what this page can really do with it:
 *
 *   requestDevice + GATT   Chromium on Windows, macOS, ChromeOS, Android;
 *                          Linux behind a flag. One device, picked by the
 *                          operator in the browser's chooser.
 *   requestLEScan          a real scan of every advertisement: experimental,
 *                          behind chrome://flags (experimental web platform
 *                          features). Absent: said, not faked.
 *   watchAdvertisements    advertisements of one picked device: experimental.
 *
 * A page alone cannot scan everything: dogd can, on Linux (BlueZ).
 */

import type { BleObservation } from './model';
import { shortUuid } from './model';

export interface BtDataView {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}
export interface BtAdvertisingEvent extends Event {
  device: BtDevice;
  name?: string;
  rssi?: number;
  txPower?: number;
  uuids?: string[];
  manufacturerData?: Map<number, BtDataView>;
  serviceData?: Map<string, BtDataView>;
}
export interface BtDescriptor {
  uuid: string;
  readValue(): Promise<BtDataView>;
}
export interface BtCharacteristic extends EventTarget {
  uuid: string;
  properties: Record<'broadcast' | 'read' | 'writeWithoutResponse' | 'write' | 'notify' | 'indicate' | 'authenticatedSignedWrites' | 'reliableWrite' | 'writableAuxiliaries', boolean>;
  value?: BtDataView | null;
  readValue(): Promise<BtDataView>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
  startNotifications(): Promise<BtCharacteristic>;
  stopNotifications(): Promise<BtCharacteristic>;
  getDescriptors(): Promise<BtDescriptor[]>;
}
export interface BtService {
  uuid: string;
  isPrimary: boolean;
  getCharacteristics(): Promise<BtCharacteristic[]>;
}
export interface BtServer {
  connected: boolean;
  connect(): Promise<BtServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<BtService[]>;
}
export interface BtDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BtServer;
  watchAdvertisements?(o?: { signal?: AbortSignal }): Promise<void>;
}
export interface BtScan {
  active: boolean;
  stop(): void;
}
export interface BtApi extends EventTarget {
  getAvailability?(): Promise<boolean>;
  requestDevice(o: { acceptAllDevices?: boolean; filters?: object[]; optionalServices?: string[]; optionalManufacturerData?: number[] }): Promise<BtDevice>;
  requestLEScan?(o: { acceptAllAdvertisements?: boolean; keepRepeatedDevices?: boolean }): Promise<BtScan>;
}

export function bluetoothApi(): BtApi | null {
  const nav = globalThis.navigator as (Navigator & { bluetooth?: BtApi }) | undefined;
  return nav?.bluetooth ?? null;
}

export const bytesOf = (v: BtDataView): Uint8Array => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);

/** One advertisement event as an observation, every field from the API, nothing added. */
export function fromAdvertisement(e: BtAdvertisingEvent, at: number, mono: number): BleObservation {
  return {
    at,
    mono,
    source: 'WEB BLUETOOTH',
    adapter: 'browser',
    id: e.device.id,
    idKind: 'web-bluetooth-id',
    // Web Bluetooth never exposes the radio address.
    address: null,
    addressType: null,
    advName: e.name ?? null,
    systemName: e.device.name ?? null,
    rssi: typeof e.rssi === 'number' ? e.rssi : null,
    txPower: typeof e.txPower === 'number' ? e.txPower : null,
    connectable: null,
    services: (e.uuids ?? []).map((u) => shortUuid(u)),
    manufacturer: [...(e.manufacturerData ?? new Map<number, BtDataView>())].map(([company, v]) => ({ company, data: bytesOf(v) })),
    serviceData: [...(e.serviceData ?? new Map<string, BtDataView>())].map(([uuid, v]) => ({ uuid: shortUuid(uuid), data: bytesOf(v) })),
  };
}

export class BleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BleError';
  }
}
