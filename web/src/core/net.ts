/**
 * HARDWARE DOG / A POOR CONNECTION
 *
 * What the page fetches for later (the other TV, the next banner, the
 * offline copy, a section not opened yet) waits until the page has what it
 * needs: loaded, its pictures in, a moment without a new download, the
 * browser idle. What only makes later faster is skipped where the
 * connection asks to spare data. What is needed now is never held back.
 */

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * The connection asks to spare data: Save-Data is on, or the link is 2G
 * class. Unknown (most browsers outside Chromium): not frugal.
 */
export function frugal(): boolean {
  const c = (globalThis.navigator as (Navigator & { connection?: NetworkInformationLike }) | undefined)?.connection;
  return !!c && (c.saveData === true || c.effectiveType === '2g' || c.effectiveType === 'slow-2g');
}

const idle = (fn: () => void, timeout: number) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, Math.min(timeout, 1500));
};

/** Run `fn` once the page has loaded and the browser is idle (at the latest `timeout` ms after the load). */
export function afterLoad(fn: () => void, timeout = 4000): void {
  if (typeof window === 'undefined') return;
  if (document.readyState === 'complete') idle(fn, timeout);
  else window.addEventListener('load', () => idle(fn, timeout), { once: true });
}

let held: Promise<void> | null = null;
let release: (() => void) | null = null;

/**
 * The page holds what is for later until it says it is ready (the interface
 * says so after its boot screen, when its own first pictures are asked for):
 * a quiet boot screen is not a page that has what it needs.
 */
export function holdLater(): void {
  held ??= new Promise((r) => (release = r));
}

/** The page is ready: what was held may start once it is quiet. */
export function releaseLater(): void {
  release?.();
}

/** Pictures the page needs now, loaded outside the document (the TV's sprite sheets). */
const pending = new Set<HTMLImageElement>();

/** Count `img` as needed now until it has loaded (or failed): what is for later waits for it. */
export function track(img: HTMLImageElement): void {
  if (img.complete) return;
  pending.add(img);
  const done = () => pending.delete(img);
  img.addEventListener('load', done, { once: true });
  img.addEventListener('error', done, { once: true });
}

/** A picture of the page still coming: a tracked one, or an eager <img> of the document. */
function picturesComing(): boolean {
  if (pending.size > 0) return true;
  for (const img of Array.from(document.querySelectorAll('img'))) if (!img.complete && img.loading !== 'lazy') return true;
  return false;
}

/**
 * Run `fn` once the page has what it needs: loaded, ready if it holds
 * (holdLater), its pictures in, no download of this site finished for
 * `quietMs`, the browser idle. At the latest `maxMs` after the load: what
 * waits is never lost.
 */
export function afterQuiet(fn: () => void, quietMs = 2500, maxMs = 30_000): void {
  afterLoad(() => {
    const start = performance.now();
    let last = start;
    let ready = held === null;
    void held?.then(() => {
      ready = true;
      last = performance.now();
    });
    let watch: PerformanceObserver | null = null;
    try {
      watch = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => e.name.startsWith(location.origin))) last = performance.now();
      });
      watch.observe({ type: 'resource' });
    } catch {
      watch = null;
    }
    const check = () => {
      const now = performance.now();
      if (now - start < maxMs && (!ready || picturesComing() || now - last < quietMs)) return void setTimeout(check, 500);
      watch?.disconnect();
      idle(fn, 4000);
    };
    check();
  }, 1000);
}

/** `afterQuiet`, unless the connection is frugal: for what only makes later faster. */
export function warmLater(fn: () => void, maxMs?: number): void {
  if (!frugal()) afterQuiet(fn, undefined, maxMs);
}
