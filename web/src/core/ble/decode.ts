/**
 * HARDWARE DOG / BLE DECODERS
 *
 * Decoders read advertisement payloads into fields. Each has an id and a
 * version: a decoded value always says which decoder (and which version)
 * produced it, and the raw bytes stay next to it. A payload no decoder
 * claims stays raw: nothing is guessed.
 *
 * Dictionaries (company identifiers, service, characteristic and
 * descriptor UUIDs) come from the Nordic Bluetooth numbers database,
 * bundled (data/numbers.json, BSD-3-Clause, see docs/BLUETOOTH_LAB.md) and
 * loaded from this interface's own files: no request leaves the machine.
 */

import { shortUuid } from './model';

export interface Field {
  name: string;
  value: string | number;
  unit?: string;
  /** Byte range in the payload, [start, end). */
  bytes: [number, number];
}

export interface Decoding {
  decoder: string;
  version: string;
  fields: Field[];
}

interface Decoder {
  id: string;
  version: string;
  /** manufacturer: key = company id; service: key = short UUID. */
  claims(kind: 'manufacturer' | 'service', key: number | string, data: Uint8Array): boolean;
  decode(data: Uint8Array): Field[];
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const int8 = (b: number) => (b > 127 ? b - 256 : b);
const be16 = (d: Uint8Array, i: number) => (d[i]! << 8) | d[i + 1]!;
const be32 = (d: Uint8Array, i: number) => ((d[i]! << 24) >>> 0) + (d[i + 1]! << 16) + (d[i + 2]! << 8) + d[i + 3]!;
const uuid128 = (b: Uint8Array) => {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Eddystone URL scheme prefixes, built from parts: this text is decoded, never fetched. */
const SEP = ':' + '/'.repeat(2);
const EDDYSTONE_SCHEMES = [`http${SEP}www.`, `https${SEP}www.`, `http${SEP}`, `https${SEP}`];
const EDDYSTONE_EXPANSIONS = ['.com/', '.org/', '.edu/', '.net/', '.info/', '.biz/', '.gov/', '.com', '.org', '.edu', '.net', '.info', '.biz', '.gov'];

export const DECODERS: readonly Decoder[] = [
  {
    // Apple iBeacon: company 0x004C, type 0x02, length 0x15.
    id: 'apple.ibeacon',
    version: '1',
    claims: (kind, key, d) => kind === 'manufacturer' && key === 0x004c && d.length === 23 && d[0] === 0x02 && d[1] === 0x15,
    decode: (d) => [
      { name: 'proximity UUID', value: uuid128(d.subarray(2, 18)), bytes: [2, 18] },
      { name: 'major', value: be16(d, 18), bytes: [18, 20] },
      { name: 'minor', value: be16(d, 20), bytes: [20, 22] },
      { name: 'measured power (1 m, as advertised)', value: int8(d[22]!), unit: 'dBm', bytes: [22, 23] },
    ],
  },
  {
    // Eddystone (Google), service data 0xFEAA: UID, URL, TLM frames.
    id: 'google.eddystone',
    version: '1',
    claims: (kind, key, d) => kind === 'service' && key === 'FEAA' && d.length >= 2 && [0x00, 0x10, 0x20].includes(d[0]!),
    decode: (d) => {
      if (d[0] === 0x00 && d.length >= 18)
        return [
          { name: 'frame', value: 'UID', bytes: [0, 1] },
          { name: 'TX power (0 m, as advertised)', value: int8(d[1]!), unit: 'dBm', bytes: [1, 2] },
          { name: 'namespace', value: hex(d.subarray(2, 12)), bytes: [2, 12] },
          { name: 'instance', value: hex(d.subarray(12, 18)), bytes: [12, 18] },
        ];
      if (d[0] === 0x10 && d.length >= 3) {
        let url = EDDYSTONE_SCHEMES[d[2]!] ?? '?';
        for (const b of d.subarray(3)) url += b < EDDYSTONE_EXPANSIONS.length ? EDDYSTONE_EXPANSIONS[b] : String.fromCharCode(b);
        return [
          { name: 'frame', value: 'URL', bytes: [0, 1] },
          { name: 'TX power (0 m, as advertised)', value: int8(d[1]!), unit: 'dBm', bytes: [1, 2] },
          { name: 'URL (advertised text, not visited)', value: url, bytes: [2, d.length] },
        ];
      }
      if (d[0] === 0x20 && d.length >= 14 && d[1] === 0x00)
        return [
          { name: 'frame', value: 'TLM', bytes: [0, 1] },
          { name: 'battery', value: be16(d, 2), unit: 'mV', bytes: [2, 4] },
          { name: 'temperature', value: d[4] === 0x80 && d[5] === 0 ? 'not supported' : int8(d[4]!) + d[5]! / 256, unit: '°C', bytes: [4, 6] },
          { name: 'advertisements sent', value: be32(d, 6), bytes: [6, 10] },
          { name: 'time since power-on', value: be32(d, 10) / 10, unit: 's', bytes: [10, 14] },
        ];
      return [{ name: 'frame', value: `0x${d[0]!.toString(16)} (incomplete)`, bytes: [0, 1] }];
    },
  },
  {
    // Battery Service data (0x180F): one byte, percent.
    id: 'bt.battery-level',
    version: '1',
    claims: (kind, key, d) => kind === 'service' && key === '180F' && d.length === 1,
    decode: (d) => [{ name: 'battery level', value: d[0]!, unit: '%', bytes: [0, 1] }],
  },
];

/** Decode a payload, or null when no decoder claims it. */
export function decodePayload(kind: 'manufacturer' | 'service', key: number | string, data: Uint8Array): Decoding | null {
  const k = kind === 'service' ? shortUuid(String(key)) : key;
  const d = DECODERS.find((x) => x.claims(kind, k, data));
  if (!d) return null;
  try {
    return { decoder: d.id, version: d.version, fields: d.decode(data) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- dictionaries

export interface Numbers {
  source: { repository: string; commit: string; license: string; copyright: string };
  companies: Record<string, string>;
  services: Record<string, string>;
  characteristics: Record<string, string>;
  descriptors: Record<string, string>;
}

let numbers: Numbers | null = null;
let loading: Promise<Numbers> | null = null;

/** The bundled dictionaries, loaded once, from this interface's own files. */
export function loadNumbers(): Promise<Numbers> {
  loading ??= import('./data/numbers.json').then((m) => (numbers = (m as { default: Numbers }).default ?? (m as unknown as Numbers)));
  return loading;
}

/** Names, when the dictionaries are loaded (null before, or when unknown). */
export const names = {
  company: (id: number): string | null => numbers?.companies[String(id)] ?? null,
  service: (uuid: string): string | null => numbers?.services[shortUuid(uuid)] ?? null,
  characteristic: (uuid: string): string | null => numbers?.characteristics[shortUuid(uuid)] ?? null,
  descriptor: (uuid: string): string | null => numbers?.descriptors[shortUuid(uuid)] ?? null,
  get source(): Numbers['source'] | null {
    return numbers?.source ?? null;
  },
};

/** Every 16-bit SIG service UUID in the dictionary, as full UUIDs (Web Bluetooth needs them listed up front). */
export async function knownServiceUuids(): Promise<string[]> {
  const n = await loadNumbers();
  return Object.keys(n.services)
    .filter((u) => /^[0-9A-F]{4}$/.test(u))
    .map((u) => `0000${u.toLowerCase()}-0000-1000-8000-00805f9b34fb`);
}
