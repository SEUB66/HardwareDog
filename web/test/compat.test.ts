import { describe, expect, it } from 'vitest';
import { installCompat } from '../src/core/compat';

/** Every source file of the interface, as text. */
const sources = import.meta.glob('../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('older browsers (core/compat.ts)', () => {
  it('fills in .at(), structuredClone and AbortSignal.timeout where they are missing, and keeps the browser\'s own', () => {
    const g = {
      Array: { prototype: Object.create(Array.prototype, { at: { value: undefined, writable: true, configurable: true } }) },
      String: { prototype: {} },
      Uint8Array: undefined,
      AbortSignal: class {},
    } as unknown as typeof globalThis;
    delete (g.Array.prototype as { at?: unknown }).at;
    installCompat(g);
    const at = (g.Array.prototype as unknown as { at: (this: unknown[], i: number) => unknown }).at;
    expect(at.call([1, 2, 3], -1)).toBe(3);
    expect(at.call([1, 2, 3], 0)).toBe(1);
    expect(at.call([1, 2, 3], 3)).toBeUndefined();
    expect((g.String.prototype as unknown as { at: (this: string, i: number) => unknown }).at.call('dog', -1)).toBe('g');
    const clone = (g as unknown as { structuredClone: <T>(v: T) => T }).structuredClone;
    const m = { key: 'a', header: { n: 1 } };
    expect(clone(m)).toEqual(m);
    expect(clone(m)).not.toBe(m);
    expect(typeof (g.AbortSignal as unknown as { timeout: unknown }).timeout).toBe('function');
    // a browser that has them keeps its own
    const own = Array.prototype.at;
    installCompat();
    expect(Array.prototype.at).toBe(own);
    expect([1, 2].at(-1)).toBe(2);
  });

  it('no regex lookbehind anywhere: Safari before 16.4 cannot parse one and the whole page would stop', () => {
    const found = Object.entries(sources).filter(([, text]) => /\(\?<[=!]/.test(text.replace(/\/\/.*$/gm, '')));
    expect(found.map(([f]) => f)).toEqual([]);
  });
});
