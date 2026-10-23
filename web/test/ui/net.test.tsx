// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { afterLoad, afterQuiet, frugal, holdLater, releaseLater, track, warmLater } from '../../src/core/net';

const setConnection = (c: object | undefined) => Object.defineProperty(navigator, 'connection', { value: c, configurable: true });
const setReadyState = (v: string) => Object.defineProperty(document, 'readyState', { value: v, configurable: true });

afterEach(() => {
  Reflect.deleteProperty(navigator, 'connection');
  Reflect.deleteProperty(document, 'readyState');
});

describe('a poor connection (core/net.ts)', () => {
  it('frugal: Save-Data or a 2G-class link; unknown is not frugal', () => {
    setConnection(undefined);
    expect(frugal()).toBe(false);
    setConnection({ saveData: true, effectiveType: '4g' });
    expect(frugal()).toBe(true);
    setConnection({ effectiveType: 'slow-2g' });
    expect(frugal()).toBe(true);
    setConnection({ effectiveType: '3g' });
    expect(frugal()).toBe(false);
  });

  it('what is for later waits for the page to load, and is skipped when frugal', async () => {
    setReadyState('loading');
    const ran: string[] = [];
    afterLoad(() => ran.push('later'), 50);
    setConnection({ saveData: true });
    warmLater(() => ran.push('warm'), 50);
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toEqual([]);
    window.dispatchEvent(new Event('load'));
    await new Promise((r) => setTimeout(r, 1700));
    expect(ran).toEqual(['later']);
  });

  it('what is held waits for the interface to say it is ready, then for its pictures and a quiet moment', async () => {
    const ran: string[] = [];
    holdLater();
    const sheet = new Image();
    Object.defineProperty(sheet, 'complete', { value: false, configurable: true });
    track(sheet);
    afterQuiet(() => ran.push('later'), 100, 20_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ran).toEqual([]); // not ready yet
    releaseLater();
    await new Promise((r) => setTimeout(r, 1500));
    expect(ran).toEqual([]); // the sprite sheet is still coming
    sheet.dispatchEvent(new Event('load'));
    await new Promise((r) => setTimeout(r, 2500));
    expect(ran).toEqual(['later']);
  }, 15_000);
});
