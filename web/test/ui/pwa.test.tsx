// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pwa, TAKEOVER_MS } from '../../src/core/pwa';

/** A service worker container the test drives: one registration, one waiting worker. */
function fakeWorkers(controlled = true) {
  const target = new EventTarget();
  const posted: unknown[] = [];
  const reg = Object.assign(new EventTarget(), { waiting: { postMessage: (m: unknown) => void posted.push(m) } as { postMessage(m: unknown): void } | null, installing: null, update: async () => {} });
  const sw = Object.assign(target, { controller: controlled ? {} : null, register: async () => reg });
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  return { sw, reg, posted, takeOver: () => sw.dispatchEvent(new Event('controllerchange')) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.useRealTimers();
});

describe('PWA update (audit 2026-10)', () => {
  it('another tab started the new version: this one says so, and RELOAD reloads', async () => {
    const w = fakeWorkers();
    let reloads = 0;
    const p = new Pwa(() => void reloads++);
    p.start(true);
    await settle();
    expect(p.update).toBe(true);
    // the other tab pressed RELOAD: the worker took over this page too, and is no longer waiting
    w.reg.waiting = null;
    w.takeOver();
    expect(p.update).toBe(false);
    expect(p.elsewhere).toBe(true);
    expect(reloads).toBe(0);
    p.applyUpdate();
    expect(reloads).toBe(1);
  });

  it('RELOAD here: the waiting worker is asked, the page reloads once it took over', async () => {
    const w = fakeWorkers();
    let reloads = 0;
    const p = new Pwa(() => void reloads++);
    p.start(true);
    await settle();
    p.applyUpdate();
    p.applyUpdate();
    expect(w.posted).toEqual(['hwdog:activate']);
    w.takeOver();
    expect(reloads).toBe(1);
    expect(p.elsewhere).toBe(false);
  });

  it('a new version that never takes over is said, and RELOAD works again', async () => {
    const w = fakeWorkers();
    const p = new Pwa(() => {});
    p.start(true);
    await settle();
    vi.useFakeTimers();
    p.applyUpdate();
    vi.advanceTimersByTime(TAKEOVER_MS + 1);
    expect(p.stalled).toBe(true);
    p.applyUpdate();
    expect(w.posted).toEqual(['hwdog:activate', 'hwdog:activate']);
  });

  it("the first visit's worker claiming the page is no update", async () => {
    const w = fakeWorkers(false);
    w.reg.waiting = null;
    const p = new Pwa(() => {});
    p.start(true);
    await settle();
    w.takeOver();
    expect(p.elsewhere).toBe(false);
    expect(p.update).toBe(false);
  });
});
