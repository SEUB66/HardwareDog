import { describe, expect, it } from 'vitest';
import { usbKnown, usbLabel } from '../src/core/usbids';

describe('who made a USB device (core/usbids.ts)', () => {
  it('names the bridges, boards and probes of a bench, and says a bridge is not the board', () => {
    expect(usbLabel(0x1a86, 0x7523)).toBe('QinHeng (WCH) CH340 · usb-serial bridge');
    expect(usbKnown(0x1a86, 0x7523)?.note).toMatch(/does not name that board/);
    expect(usbLabel(0x10c4, 0xea60)).toBe('Silicon Labs CP210x · usb-serial bridge');
    expect(usbLabel(0x0483, 0x374b)).toBe('STMicroelectronics ST-LINK/V2-1 · debug probe');
    expect(usbKnown(0x0483, 0x5740)?.product).toMatch(/Flipper Zero/);
    expect(usbLabel(0x2e8a, 0x0003)).toMatch(/bootloader/);
  });

  it('a known vendor with an unknown product is the vendor only; an unknown vendor is nothing, never a guess', () => {
    expect(usbLabel(0x303a, 0x9999)).toBe('Espressif');
    expect(usbKnown(0xbeef, 0x0001)).toBeNull();
    expect(usbLabel(null, null)).toBeNull();
  });
});
