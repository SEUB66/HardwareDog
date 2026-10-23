/**
 * HARDWARE DOG / THE INTERFACE COULD NOT START
 *
 * Shown in place of the interface when its start failed (the archive or
 * the lab could not be opened): what failed, as the browser said it, and
 * what to try. The static introduction stays below it.
 */

export function StartFailed({ error }: { error: unknown }) {
  const why = error instanceof Error ? `${error.name !== 'Error' ? `${error.name}: ` : ''}${error.message}` : String(error);
  return (
    <section class="intro-static" role="alert">
      <h1>HARDWARE DOG COULD NOT START</h1>
      <p class="mono">{why}</p>
      <p>Nothing was sent anywhere. Reload the page. If this browser refuses storage to this site (a private window, a site setting, a page embedded in another), allow it or open Hardware Dog in a normal window.</p>
      <p>
        <button class="btn" onClick={() => location.reload()}>
          RELOAD
        </button>
      </p>
    </section>
  );
}
