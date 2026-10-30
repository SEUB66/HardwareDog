/**
 * HARDWARE DOG / WHO MADE A USB DEVICE
 *
 * A USB device says two numbers (vendor id, product id); its name strings
 * are optional, and the cheap boards met on a bench often leave them out.
 * This short table names the vendors and chips met there most: USB-to-serial
 * bridges, development boards, debug probes, the Flipper Zero. Taken from
 * the public USB id registry (linux-usb.org usb.ids) and the vendors' own
 * documentation; a number not listed stays a number, never a guess.
 *
 * A USB-to-serial bridge is not the board: it is the chip the board talks
 * through (an ESP32 behind a CH340, an STM32 behind an ST-LINK). Said so.
 */

export type UsbKind = 'usb-serial bridge' | 'board' | 'debug probe' | 'bootloader' | 'device';

export interface UsbKnown {
  vendor: string;
  /** The product, when this id is a known one. */
  product?: string;
  kind?: UsbKind;
  /** One line for the person at the bench. */
  note?: string;
}

const BRIDGE_NOTE = 'a USB-to-serial chip: the board behind it talks through it, and USB does not name that board';

/** Vendors, by vendor id. */
const VENDORS: Record<number, string> = {
  0x0403: 'FTDI',
  0x10c4: 'Silicon Labs',
  0x1a86: 'QinHeng (WCH)',
  0x067b: 'Prolific',
  0x2341: 'Arduino',
  0x2a03: 'Arduino (arduino.org)',
  0x303a: 'Espressif',
  0x2e8a: 'Raspberry Pi',
  0x0483: 'STMicroelectronics',
  0x239a: 'Adafruit',
  0x1915: 'Nordic Semiconductor',
  0x0d28: 'Arm (mbed)',
  0x1366: 'SEGGER',
  0x16c0: 'Van Ooijen (V-USB, PJRC Teensy)',
  0x1d50: 'OpenMoko (open hardware ids)',
  0x1209: 'pid.codes (open hardware ids)',
  0x2886: 'Seeed Technology',
  0x1fc9: 'NXP',
  0x04d8: 'Microchip',
  0x03eb: 'Atmel (Microchip)',
  0x0451: 'Texas Instruments',
  0x0525: 'Netchip (Linux USB gadget)',
  0x18d1: 'Google',
  0x05ac: 'Apple',
  0x046d: 'Logitech',
  0x045e: 'Microsoft',
  0x0bda: 'Realtek',
  0x8087: 'Intel',
  0x8086: 'Intel',
  0x0781: 'SanDisk',
  0x090c: 'Silicon Motion',
  0x05e3: 'Genesys Logic',
  0x2109: 'VIA Labs',
  0x04e8: 'Samsung',
};

/** Products, by "vid:pid". */
const PRODUCTS: Record<string, Omit<UsbKnown, 'vendor'>> = {
  '0403:6001': { product: 'FT232R', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '0403:6010': { product: 'FT2232', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '0403:6011': { product: 'FT4232H', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '0403:6014': { product: 'FT232H', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '0403:6015': { product: 'FT-X series', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '10c4:ea60': { product: 'CP210x', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '10c4:ea70': { product: 'CP2105 (two ports)', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '1a86:7523': { product: 'CH340', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '1a86:55d4': { product: 'CH9102', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '067b:2303': { product: 'PL2303', kind: 'usb-serial bridge', note: BRIDGE_NOTE },
  '2341:0043': { product: 'Uno R3', kind: 'board' },
  '2341:0042': { product: 'Mega 2560 R3', kind: 'board' },
  '2341:8036': { product: 'Leonardo', kind: 'board' },
  '303a:1001': { product: 'USB Serial/JTAG (ESP32-S3, -C3, -C6)', kind: 'board', note: 'the chip\'s own USB: the console and the flash port in one' },
  '2e8a:0003': { product: 'RP2040 boot (RPI-RP2)', kind: 'bootloader', note: 'the boot ROM, shown as a USB drive: the program is not running' },
  '2e8a:000a': { product: 'Pico (SDK serial)', kind: 'board' },
  '0483:5740': { product: 'Virtual COM port (STM32), also the Flipper Zero', kind: 'device', note: 'a Flipper Zero uses this id: Flipper Lab talks to it' },
  '0483:3748': { product: 'ST-LINK/V2', kind: 'debug probe' },
  '0483:374b': { product: 'ST-LINK/V2-1', kind: 'debug probe', note: 'the probe of a Nucleo board: its serial port is the target\'s console' },
  '0483:df11': { product: 'STM32 DFU bootloader', kind: 'bootloader', note: 'the boot ROM: the program is not running' },
  '0d28:0204': { product: 'DAPLink (CMSIS-DAP)', kind: 'debug probe' },
  '1366:0101': { product: 'J-Link', kind: 'debug probe' },
  '16c0:0483': { product: 'Teensy (serial)', kind: 'board' },
  '1d50:6018': { product: 'Black Magic Probe', kind: 'debug probe' },
  '0525:a4a7': { product: 'Gadget serial (a Linux board as a USB device)', kind: 'device' },
};

const key = (vid: number, pid: number) => `${vid.toString(16).padStart(4, '0')}:${pid.toString(16).padStart(4, '0')}`;

/** What the table says about vid:pid; null when the vendor is not listed. */
export function usbKnown(vid: number | null | undefined, pid: number | null | undefined): UsbKnown | null {
  if (vid === null || vid === undefined) return null;
  const vendor = VENDORS[vid];
  if (!vendor) return null;
  const p = pid === null || pid === undefined ? undefined : PRODUCTS[key(vid, pid)];
  return { vendor, ...p };
}

/** "QinHeng (WCH) CH340 · usb-serial bridge", or null. */
export function usbLabel(vid: number | null | undefined, pid: number | null | undefined): string | null {
  const k = usbKnown(vid, pid);
  if (!k) return null;
  return [k.product ? `${k.vendor} ${k.product}` : k.vendor, k.kind && k.kind !== 'device' ? k.kind : null].filter(Boolean).join(' · ');
}
