# HARDWARE DOG / THE WEB APP: INSTALL, OFFLINE, UPDATES

```text
WHAT      how hardwaredog.org installs, what works offline, how updates arrive
WHERE     web/public/manifest.webmanifest, web/sw/service-worker.js,
          web/scripts/sw-plugin.mjs (builds dist/sw.js), web/src/core/pwa.ts,
          web/src/ui/Pwa.tsx, netlify.toml (headers)
STATUS    see VERIFICATION below
```

---

## INSTALL

The manifest (`manifest.webmanifest`) opens the tool, `diagnostic.html`, in
its own window (`display: standalone`). Its identity is unchanged since the
first manifest: `start_url` is still `./diagnostic.html`, and `id` says
explicitly what browsers already computed from it, so an existing install
stays the same app.

```text
name / short_name   Hardware Dog / HW DOG
start_url, id       ./diagnostic.html
scope               ./  (the whole site)
colors              #101112, the interface's own background
icons               192 and 512 "any" (the rounded app icon as drawn)
                    192 and 512 "maskable" (the pixel head on its own dark
                    ground, full bleed, every drawn pixel inside the 40 %
                    safe circle, no rounded corner: the system masks it)
apple-touch-icon    180, opaque (iOS rounds it itself)
favicons            16 and 32 PNG, favicon.ico with 16, 32 and 48: the pixel
                    head's face, checked at 16 px (the rounded icon's frame
                    and the collar's tag turn to noise there)
```

Where the browser offers installation (Chrome, Edge on a computer or on
Android: `beforeinstallprompt`), the home shows INSTALL, which opens the
browser's own prompt. On iPhone and iPad no such prompt exists: one line
says how (Share, Add to Home Screen). Nothing imitates a system prompt; the
offer can be hidden; Hardware Dog works the same without installing.

## OFFLINE

```text
WORKS OFFLINE, after one complete visit online (the service worker installed):
  the tool (diagnostic.html, also with ?demo), the landing page and the
  architecture page; the code, styles, fonts, icons, the TVs and the
  companion's scenes; the demo; sessions, reports and exports already in this
  browser (IndexedDB, as before: they never go through the cache)
  pictures shown once (banners, posters) are kept and shown again
DOES NOT WORK OFFLINE
  a first visit: nothing can be downloaded without a connection
  pictures never shown online yet (they come back with the connection)
  anything that needs the network by nature: dogd is local and keeps working
  (its own connection, never cached), but a network test needs a network
  another address of the site: a plain "Offline" page (503)
NEVER CACHED
  another origin (dogd on 127.0.0.1, anything else), requests other than GET,
  the installer script (/install), robots.txt, sitemap.xml, the worker itself
```

The interface already says when a function needs dogd or a device; the
home says when the browser is offline ("what is loaded keeps working").

## UPDATES

Every build makes a new worker: its version is a hash of the files it keeps
and of their content (`npm run build:verify` stays reproducible). The new
worker installs in the background into its own cache and **waits**. The
interface then says NEW VERSION READY:

```text
nothing running              RELOAD is offered; the person decides
an operation is running      RELOAD waits (a scan, a transfer, an inspection)
a session is recording       RELOAD waits (a device connected)
a lab session is recording   RELOAD waits
```

A click on RELOAD hands over to the new worker, which deletes the old
caches, then the page reloads once. A page never mixes two builds: the
pages and their files come from the same version's cache. The worker is
checked again every hour while the interface stays open, and on every
visit (`/sw.js` is served `no-cache`).

## HEADERS (netlify.toml)

```text
/sw.js                  Cache-Control: no-cache
/assets/*               Cache-Control: public, max-age=31536000, immutable
/manifest.webmanifest   Content-Type: application/manifest+json; no-cache
```

The site's Content-Security-Policy is unchanged: the worker, the manifest
and the icons are the site's own files.

---

## VERIFICATION

```text
AUTOMATED (web/test/launch.test.ts)   manifest, icon sizes and types, maskable
                                      safe zone and corners, apple icon, ICO,
                                      the worker: what it keeps, its version,
                                      run in a fake environment (install
                                      without takeover, cleanup of its own
                                      old caches only, cache-first pages with
                                      a query, dogd / other hosts / POST /
                                      installer untouched)
CHROMIUM, AUTOMATED, LOCAL            production build served like Netlify
(Playwright, headless)                (MIME types, 404 page, CSP): manifest
                                      without errors, installable (Chrome's
                                      installability check: no error), worker
                                      active; server stopped: the tool, the
                                      tool with ?demo and the landing page
                                      open, an unknown path answers 503;
                                      a new build while a demo BLE scan runs:
                                      RELOAD waits, the scan goes on, after
                                      STOP the reload brings the new version
                                      and the old caches are gone; no console
                                      error under the CSP
EMULATION                             iPhone 13 (Chromium): the Share / Add to
                                      Home Screen line shows, no side scroll
NOT RUN                               the native install prompt and launching
                                      the installed app (headless Chromium
                                      shows no prompt); a real Android or iOS
                                      device; the production site (this
                                      session's network refuses the host)
```
