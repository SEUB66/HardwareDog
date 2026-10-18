import { useRef } from 'preact/hooks';

/**
 * A START button replaced by STOP in the same place (and back): the second
 * click of a double-click would land on the other one and undo the first.
 * `mark()` on start and on stop; `settled()` is false for a moment after.
 */
export function useSettled(ms = 600): { mark: () => void; settled: () => boolean } {
  const at = useRef(-Infinity);
  return { mark: () => (at.current = performance.now()), settled: () => performance.now() - at.current > ms };
}
