/**
 * HARDWARE DOG / SERVICE WORKER
 *
 * Generated at build time (web/vite.config.ts, plugin "hwdog-sw"): VERSION
 * and PRECACHE are filled with this build's files. What it does:
 *
 *   OFFLINE    after one successful visit, the interface (its pages, code,
 *              styles, fonts, icons, the TV and the companion's scenes)
 *              opens without a connection; other pictures are kept once
 *              they have been shown
 *   VERSIONS   one cache per build (hwdog-<version>); an old version's
 *              caches are deleted only when the new one takes over, so a
 *              page never mixes the scripts of two builds
 *   UPDATES    a new version installs in the background and WAITS: the
 *              page offers to reload when nothing is running; it never
 *              takes over on its own in the middle of a scan, a connection
 *              or a recording
 *   NEVER      another origin (dogd on 127.0.0.1, anything else) is not
 *              touched; nor the installer script, robots.txt, the sitemap;
 *              nothing but GET; a diagnostic, a session, a scan never goes
 *              through a cache: they live in the page (IndexedDB), not here
 *
 * A first visit without a connection cannot download the application.
 */

const VERSION = '__HWDOG_VERSION__';
const PRECACHE = __HWDOG_PRECACHE__;
const CACHE = `hwdog-${VERSION}`;
const RUNTIME = `hwdog-runtime-${VERSION}`;
/** The pages of the site, kept with their own build's files. */
const PAGES = ['index.html', 'diagnostic.html', 'engineering.html'];
/** Same-origin paths that always go to the network, never cached. */
const NEVER = /^(install|robots\.txt|sitemap\.xml|sw\.js)$/;

const scope = new URL(self.registration.scope);
const rel = (url) => decodeURIComponent(url.pathname.slice(scope.pathname.length));
const abs = (path) => new URL(path, scope).href;

self.addEventListener('install', (event) => {
  // The whole interface of this build, or nothing: addAll fails as one.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((p) => new Request(abs(p), { cache: 'reload' })))));
  // No skipWaiting here: a new version waits until the page asks for it.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('hwdog-') && key !== CACHE && key !== RUNTIME) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page asks for the waiting version when nothing is running (web/src/core/pwa.ts).
self.addEventListener('message', (event) => {
  if (event.data === 'hwdog:activate') self.skipWaiting();
});

/** A page of the site: this build's copy (offline too); another path: the network, and a plain answer offline. */
async function page(request, path) {
  const name = path === '' ? 'index.html' : path;
  if (PAGES.includes(name)) {
    const kept = await caches.match(abs(name), { cacheName: CACHE });
    if (kept) return kept;
  }
  try {
    return await fetch(request);
  } catch {
    const body =
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline — Hardware Dog</title><body style="background:#101112;color:#f2f0e9;font:16px monospace;padding:24px"><h1>Offline</h1><p>This page is not kept for offline use. <a style="color:#00d9f5" href="' +
      abs('diagnostic.html') +
      '">Open Hardware Dog</a> works offline after one visit.</p>';
    return new Response(body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

/** A file of the build: from this build's caches; otherwise fetched, and kept if it is a plain success. */
async function file(request) {
  const kept = (await caches.match(request, { cacheName: CACHE })) ?? (await caches.match(request, { cacheName: RUNTIME }));
  if (kept) return kept;
  const answer = await fetch(request);
  if (answer.ok && answer.type === 'basic') {
    const copy = answer.clone();
    void caches.open(RUNTIME).then((c) => c.put(request, copy));
  }
  return answer;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = rel(url);
  if (NEVER.test(path)) return;
  if (request.mode === 'navigate') return event.respondWith(page(request, path));
  if (path.startsWith('assets/') || PRECACHE.includes(path)) return event.respondWith(file(request));
});
