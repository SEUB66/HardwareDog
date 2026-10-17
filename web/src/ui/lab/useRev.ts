import { useEffect, useState } from 'preact/hooks';

export interface Observable {
  subscribe(listener: () => void): () => void;
  readonly revision: number;
}

/**
 * Re-render when an observable changes, at most once per animation frame:
 * a burst of updates (a BLE scan, a transfer) costs one render per frame.
 */
export function useRev(o: Observable | null): number {
  const [rev, setRev] = useState(o?.revision ?? 0);
  useEffect(() => {
    if (!o) return;
    let frame = 0;
    const unsubscribe = o.subscribe(() => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setRev(o.revision);
        });
    });
    return () => {
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [o]);
  return rev;
}

/** localStorage that may not be there (private mode, blocked storage): never throws. */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage refused: the preference lasts this visit only
    }
  },
};
