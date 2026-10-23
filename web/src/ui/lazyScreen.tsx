/**
 * HARDWARE DOG / A SECTION LOADED WHEN IT IS OPENED
 *
 * The lab sections (Flipper, Bluetooth, Camera Sniffer) are their own
 * files: the interface opens without them, so a first visit on a slow
 * connection downloads less before it can be used. Each is fetched when it
 * is opened, or earlier, once the page is idle (never on a frugal
 * connection). Offline after one visit, the service worker has them all.
 *
 * A failed download is retried twice on its own (after 1 s, then 3 s). A
 * browser keeps a failed module import as failed: a retry asks for the same
 * file under a fresh address (?retry=n), or it would never reach the
 * network again. Then the section says what failed and offers RETRY, and
 * RELOAD as a last resort (said to close the current connection; what was
 * recorded is kept); the rest of the interface keeps working.
 */

import type { ComponentType, FunctionComponent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { warmLater } from '../core/net';

/** Waits before the automatic retries of a failed download. */
export const RETRY_MS = [1000, 3000] as const;

/** The file a failed import names in its error (Chromium, Firefox), if it does. */
export function failedModule(e: unknown): string | null {
  const m = /(https?:\/\/[^\s'"]+?\.js)(?:\?[^\s'"]*)?(?=$|[\s'"])/.exec(e instanceof Error ? e.message : String(e));
  return m ? m[1]! : null;
}

export interface LazyScreen<P> {
  Screen: FunctionComponent<P>;
  /** Fetch it now, without showing it (idle prefetch). */
  load: () => Promise<ComponentType<P>>;
}

type Importer<M> = (url?: string) => Promise<M>;

/**
 * `importer()` is the plain `import('./x')`; `importer(url)` imports that
 * address instead (a retry). `pick` takes the component from the module.
 */
export function lazyScreen<M, P extends object>(name: string, importer: Importer<M>, pick: (m: M) => ComponentType<P>, wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): LazyScreen<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  let retries = 0;
  // The address a failed import named: every later attempt asks for it afresh, the plain import stays failed.
  let failed: string | null = null;
  const attempt = async (): Promise<ComponentType<P>> => {
    const m = failed ? await importer(`${failed}?retry=${++retries}`) : await importer();
    return (loaded = pick(m));
  };
  const load = (): Promise<ComponentType<P>> => {
    if (loaded) return Promise.resolve(loaded);
    pending ??= (async () => {
      for (let n = 0; ; n++) {
        try {
          return await attempt();
        } catch (e) {
          failed = failedModule(e) ?? failed;
          if (n >= RETRY_MS.length) throw e;
          await wait(RETRY_MS[n]!);
        }
      }
    })().finally(() => (pending = null));
    return pending;
  };

  const Screen: FunctionComponent<P> = (props) => {
    const [, setReady] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [tries, setTries] = useState(0);
    useEffect(() => {
      if (loaded) return;
      let live = true;
      setError(null);
      load().then(
        () => live && setReady((n) => n + 1),
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
      return () => void (live = false);
    }, [tries]);
    if (loaded) {
      const C = loaded;
      return <C {...props} />;
    }
    if (error)
      return (
        <div class="lazy-screen" role="alert">
          <p class="note warn">
            {name} could not be loaded ({error}). The connection may have dropped; the rest of Hardware Dog keeps working.
          </p>
          <div class="actions">
            <button class="btn primary" onClick={() => setTries((n) => n + 1)}>
              RETRY
            </button>
            <button class="btn" onClick={() => location.reload()} title="Closes the current connection; what was recorded is kept in this browser">
              RELOAD THE PAGE
            </button>
          </div>
        </div>
      );
    return (
      <p class="lazy-screen dim" role="status">
        LOADING {name}…
      </p>
    );
  };
  return { Screen, load };
}

/** Fetch these sections once the page is idle, unless the connection is frugal. */
export function prefetchLater(screens: readonly { load: () => Promise<unknown> }[]): void {
  warmLater(() => {
    for (const s of screens) void s.load().catch(() => {});
  });
}
