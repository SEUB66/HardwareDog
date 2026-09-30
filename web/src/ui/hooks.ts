import { useEffect, useState } from 'preact/hooks';
import type { System } from '../core/system';

/**
 * Re-render when the system changes, at most once per animation frame.
 * Power frames arrive at 50 Hz; the screen does not need to redraw more
 * often than it can display.
 */
export function useSystem(system: System): number {
  const [revision, setRevision] = useState(system.revision);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setRevision(system.revision);
    };
    const unsubscribe = system.subscribe(() => {
      if (frame === 0) frame = requestAnimationFrame(update);
    });
    return () => {
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [system]);
  return revision;
}

/** Wall-clock time, refreshed every `period` ms. */
export function useNow(period = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(id);
  }, [period]);
  return now;
}
