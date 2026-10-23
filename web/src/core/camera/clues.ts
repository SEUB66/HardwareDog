/**
 * HARDWARE DOG / CAMERA SNIFFER / BLUETOOTH AND USB CLUES
 *
 * Bluetooth: what Bluetooth Lab observes, read for this inspection. An
 * unknown Bluetooth device, or a tracker signature, is not counted as a
 * camera clue, and not excluded either: the only signatures here name
 * trackers, from documented sources, versioned, and a signature is bytes
 * anyone can send. Everything else stays "BLE device not identified".
 * Wi-Fi and Bluetooth observations are never merged on their own.
 *
 * USB: the interfaces a plugged device declares, by class. A video
 * interface is a technical clue; it proves neither recording nor
 * concealment. A charger declares no data interface at all: an empty
 * result excludes nothing.
 */

import type { HostUsbDevice } from '../dogd';
import type { BleDevice } from '../ble/model';
import { names } from '../ble/decode';

export const BLE_SIGNATURES_VERSION = 'ble-signatures 1 (2026-10-17)';

export interface BleSignature {
  id: string;
  label: string;
  source: string;
  match: (d: BleDevice) => boolean;
}

const hasService = (d: BleDevice, short: string) => d.services.some((u) => u.toUpperCase() === short || u.toUpperCase().startsWith(`0000${short}-`)) || [...d.serviceData.keys()].some((u) => u.toUpperCase() === short || u.toUpperCase().startsWith(`0000${short}-`));

export const BLE_SIGNATURES: BleSignature[] = [
  {
    id: 'dult',
    label: 'Location tracker (DULT advertisement): not counted as a camera clue',
    source: 'Bluetooth SIG assigned 16-bit UUID 0xFCB2 "Location Enabled Advertisement Service" (bundled Nordic numbers database), used by the IETF DULT accessory protocol.',
    match: (d) => hasService(d, 'FCB2'),
  },
  {
    id: 'apple-find-my',
    label: 'Apple Find My offline-finding beacon (an AirTag, AirPods, or an offline iPhone, iPad or Mac): not counted as a camera clue, not excluded either',
    source: 'Manufacturer data of company 0x004C (Apple) starting with type 0x12, as documented by Heinrich et al., "Who Can Find My Devices?", PETS 2021.',
    match: (d) => d.manufacturer.get(0x004c)?.[0] === 0x12,
  },
  {
    id: 'tile',
    label: 'Tile tracker: not counted as a camera clue',
    source: 'Bluetooth SIG 16-bit member UUIDs 0xFEED and 0xFEEC, assigned to Tile, Inc.',
    match: (d) => hasService(d, 'FEED') || hasService(d, 'FEEC'),
  },
  {
    id: 'samsung-smarttag',
    label: 'Samsung SmartTag (offline finding): not counted as a camera clue',
    source: 'Bluetooth SIG 16-bit member UUID 0xFD5A, assigned to Samsung Electronics Co., Ltd.',
    match: (d) => hasService(d, 'FD5A'),
  },
];

export interface BleClue {
  key: string;
  id: string;
  source: string;
  advName: string | null;
  systemName: string | null;
  services: string[];
  companies: string[];
  rssi: number | null;
  lastSeen: number;
  count: number;
  /** The signature that matched, or null: "BLE device not identified". */
  signature: BleSignature | null;
}

export function bleClues(devices: Iterable<BleDevice>): BleClue[] {
  const out: BleClue[] = [];
  for (const d of devices) {
    const sig = BLE_SIGNATURES.find((s) => s.match(d)) ?? null;
    out.push({
      key: d.key,
      id: d.id,
      source: d.source,
      advName: d.advName,
      systemName: d.systemName,
      services: d.services.map((u) => names.service(u) ?? u),
      companies: [...d.manufacturer.keys()].map((c) => `${names.company(c) ?? 'unknown company'} (0x${c.toString(16).padStart(4, '0')})`),
      rssi: d.rssi,
      lastSeen: d.lastSeen,
      count: d.count,
      signature: sig,
    });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen);
}

export const bleLabel = (c: BleClue): string => c.signature?.label ?? 'BLE device not identified';

// ------------------------------------------------------------------ USB

export type UsbFunction = 'VIDEO' | 'STORAGE' | 'SERIAL' | 'AUDIO' | 'HID' | 'OTHER';

const FUNCTION_OF: Record<string, UsbFunction> = {
  VIDEO: 'VIDEO',
  IMAGE: 'VIDEO',
  AV: 'VIDEO',
  MSC: 'STORAGE',
  CDC: 'SERIAL',
  'CDC-DATA': 'SERIAL',
  AUDIO: 'AUDIO',
  HID: 'HID',
};

export const USB_FUNCTION_LABEL: Record<UsbFunction, string> = {
  VIDEO: 'Video / image interface (UVC, PTP, A/V)',
  STORAGE: 'Storage (mass storage)',
  SERIAL: 'Serial (CDC)',
  AUDIO: 'Audio',
  HID: 'Input (HID)',
  OTHER: 'Other',
};

export interface UsbClue {
  port: string;
  id: string;
  name: string;
  /** Interface classes exactly as dogd read them from the OS. */
  interfaces: string[];
  functions: UsbFunction[];
  video: boolean;
  /** What to say about it, plainly. */
  reading: string;
}

export function usbClues(devices: HostUsbDevice[]): UsbClue[] {
  return devices
    .filter((d) => d.cls !== 'HUB')
    .map((d) => {
      const interfaces = d.interfaces && d.interfaces.length ? d.interfaces : [d.cls];
      const functions = [...new Set(interfaces.map((c) => FUNCTION_OF[c] ?? 'OTHER'))];
      const video = functions.includes('VIDEO');
      const id = `${d.vid.toString(16).padStart(4, '0').toUpperCase()}:${d.pid.toString(16).padStart(4, '0').toUpperCase()}`;
      const name = [d.manufacturer, d.product].filter(Boolean).join(' ') || id;
      return {
        port: d.port,
        id,
        name,
        interfaces,
        functions,
        video,
        reading: video
          ? 'Declares a video or image interface: a technical clue. It proves neither that it records nor that it is hidden (webcams declare it too).'
          : 'Declares no video interface. That excludes nothing: a camera may record to its own card and show only storage, or nothing until switched on.',
      };
    });
}

export const USB_EMPTY_NOTE = 'No USB device to read. A camera charger declares no data interface at all: an empty USB result excludes nothing. Never plug in an electrical object that looks suspicious or damaged to continue.';
