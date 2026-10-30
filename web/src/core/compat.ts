/**
 * HARDWARE DOG / OLDER BROWSERS
 *
 * The interface is built for ES2020 syntax (Safari 14, Firefox 78, Chrome 85
 * and later). The few newer functions it uses are filled in here when the
 * browser lacks them, before anything else runs (the first import of
 * main.tsx): an iPhone stuck on iOS 14 or 15 still opens the tool and its
 * demo. Nothing is fetched; a browser that has them keeps its own.
 *
 *   Array/String/typed array .at()   Safari 15.4, Chrome 92, Firefox 90
 *   structuredClone()                Safari 15.4, Chrome 98, Firefox 94
 *   AbortSignal.timeout()            Safari 16, Chrome 103, Firefox 100
 */

function at<T>(this: ArrayLike<T>, index: number): T | undefined {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

const define = (proto: object, name: string, value: unknown) => {
  if (!(name in proto)) Object.defineProperty(proto, name, { value, writable: true, configurable: true });
};

/** Fill in what this browser lacks. Safe to call twice. */
export function installCompat(g: typeof globalThis = globalThis): void {
  define(g.Array.prototype, 'at', at);
  define(g.String.prototype, 'at', at);
  const typed = g.Uint8Array && Object.getPrototypeOf(g.Uint8Array.prototype);
  if (typed) define(typed, 'at', at);
  if (typeof g.structuredClone !== 'function')
    // Only plain data is cloned here (sessions' descriptions): JSON keeps all of it.
    (g as { structuredClone?: <T>(v: T) => T }).structuredClone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  if (g.AbortSignal && typeof (g.AbortSignal as { timeout?: unknown }).timeout !== 'function')
    (g.AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
      return c.signal;
    };
}

installCompat();
