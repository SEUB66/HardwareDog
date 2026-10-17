/**
 * HARDWARE DOG / BLUETOOTH CAPABILITIES
 *
 * What this computer and this browser can do, checked live, with the
 * reason when they cannot. Four different answers, never mixed:
 *
 *   UNSUPPORTED         the API does not exist here (browser, OS, flag)
 *   PERMISSION_MISSING  it exists, access was refused or not granted yet
 *   NO_ADAPTER          it exists, there is no Bluetooth adapter (or it is off)
 *   TEMPORARY_ERROR     it should work, it failed now: retry
 */

import { dogdBleStatus } from '../dogd';
import { bluetoothApi } from './webbt';

export type CapState = 'AVAILABLE' | 'UNSUPPORTED' | 'PERMISSION_MISSING' | 'NO_ADAPTER' | 'TEMPORARY_ERROR' | 'UNKNOWN';

export interface Capability {
  transport: 'WEB BLUETOOTH' | 'DOGD';
  feature: 'scan' | 'gatt' | 'watch one device';
  state: CapState;
  detail: string;
}

/** The documented support, for the table under the live check. The live check is what counts. */
export const SUPPORT_MATRIX: { os: string; webGatt: string; webScan: string; dogdScan: string }[] = [
  { os: 'Linux (Kali, Debian, Ubuntu)', webGatt: 'behind a flag, partial', webScan: 'behind a flag', dogdScan: 'yes (BlueZ, D-Bus)' },
  { os: 'Windows 10/11', webGatt: 'Chromium browsers', webScan: 'behind a flag', dogdScan: 'not yet' },
  { os: 'macOS', webGatt: 'Chromium browsers', webScan: 'behind a flag', dogdScan: 'not yet' },
  { os: 'Android', webGatt: 'Chrome', webScan: 'behind a flag', dogdScan: 'no dogd' },
  { os: 'ChromeOS', webGatt: 'Chrome', webScan: 'behind a flag', dogdScan: 'no dogd' },
  { os: 'iOS / iPadOS', webGatt: 'no (no Web Bluetooth)', webScan: 'no', dogdScan: 'no dogd' },
  { os: 'Firefox, Safari (any OS)', webGatt: 'no (no Web Bluetooth)', webScan: 'no', dogdScan: 'dogd works with any browser' },
];

export async function detectCapabilities(): Promise<Capability[]> {
  const out: Capability[] = [];
  const api = bluetoothApi();
  const secure = typeof isSecureContext === 'undefined' ? true : isSecureContext;
  if (!api) {
    const why = !secure ? 'Web Bluetooth needs a secure page (https or localhost)' : 'this browser has no Web Bluetooth (Chromium-based browsers only)';
    out.push({ transport: 'WEB BLUETOOTH', feature: 'gatt', state: 'UNSUPPORTED', detail: why });
    out.push({ transport: 'WEB BLUETOOTH', feature: 'scan', state: 'UNSUPPORTED', detail: why });
  } else {
    let adapter: boolean | null = null;
    try {
      adapter = api.getAvailability ? await api.getAvailability() : null;
    } catch {
      adapter = null;
    }
    const noAdapter = adapter === false;
    out.push({
      transport: 'WEB BLUETOOTH',
      feature: 'gatt',
      state: noAdapter ? 'NO_ADAPTER' : adapter === null ? 'UNKNOWN' : 'AVAILABLE',
      detail: noAdapter ? 'the browser reports no usable Bluetooth adapter (absent, off, or blocked by the OS)' : 'pick one device in the browser chooser, then connect',
    });
    out.push({
      transport: 'WEB BLUETOOTH',
      feature: 'scan',
      state: !api.requestLEScan ? 'UNSUPPORTED' : noAdapter ? 'NO_ADAPTER' : 'AVAILABLE',
      detail: !api.requestLEScan ? 'requestLEScan is experimental: chrome://flags, "Experimental Web Platform features"' : 'asks permission when the scan starts',
    });
    const proto = (globalThis as unknown as { BluetoothDevice?: { prototype: object } }).BluetoothDevice?.prototype;
    out.push({
      transport: 'WEB BLUETOOTH',
      feature: 'watch one device',
      state: proto && 'watchAdvertisements' in proto ? (noAdapter ? 'NO_ADAPTER' : 'AVAILABLE') : 'UNSUPPORTED',
      detail: proto && 'watchAdvertisements' in proto ? 'advertisements of one picked device' : 'watchAdvertisements is experimental (same flag)',
    });
  }
  try {
    const s = await dogdBleStatus();
    const state: CapState = !s.supported ? 'UNSUPPORTED' : s.state === 'ready' || s.state === 'scanning' ? 'AVAILABLE' : s.state === 'no_adapter' ? 'NO_ADAPTER' : s.state === 'permission' ? 'PERMISSION_MISSING' : 'TEMPORARY_ERROR';
    out.push({ transport: 'DOGD', feature: 'scan', state, detail: s.detail || (s.adapter ? `adapter ${s.adapter}` : s.state) });
  } catch (e) {
    out.push({ transport: 'DOGD', feature: 'scan', state: 'UNKNOWN', detail: `dogd not reached on this computer (${e instanceof Error ? e.message.split('.')[0] : String(e)})` });
  }
  return out;
}
