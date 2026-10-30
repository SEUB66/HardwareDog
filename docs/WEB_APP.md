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
icons               192 and 512 "any": the pixel head floating, transparent
                    around it, its black outline kept
                    192 and 512 "maskable": the same head on its own dark
                    ground, full bleed, every drawn pixel inside the 40 %
                    safe circle, no rounded corner (the system masks it and
                    would fill a transparent ground itself)
apple-touch-icon    180, opaque on the dark ground (iOS fills transparency
                    with black and rounds the corners itself)
favicons            16 and 32 PNG, favicon.ico with 16, 32 and 48: the head
                    floating, its face only, checked at 16 px on light and
                    dark tabs
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
  architecture page; the code (every lab section included), styles, fonts,
  icons, the TVs and the companion's scenes; the demo; sessions, reports and
  exports already in this
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

## A POOR CONNECTION

What the interface needs first comes first; what only makes later faster
waits, and is skipped where the connection asks to spare data
(web/src/core/net.ts):

```text
FIRST          the tool's code without the lab sections (Flipper, Bluetooth,
               Camera Sniffer load when opened, ui/lazyScreen.tsx); during
               the boot screen, when the network has nothing else to do,
               What's New's picture and its TV (frame and scenes) are asked
               for, so they are there when the boot ends
LATER          once the interface is up, its pictures are in and no download
               finished for 2.5 s (at the latest 30 s after the load): the
               service worker's offline copy, the other TV and its scenes,
               the lab sections, the next banner
NEVER DOUBLE   the worker keeps the build files the page already loaded
               (from the HTTP cache: their names carry their hash) and asks
               only for pages and public files afresh; the TV's knob is cut
               from the frame the browser chose, not a second size
FRUGAL         Save-Data on, or a 2G-class link: nothing is fetched ahead
               (other TV, next banner, lab sections); the offline copy still
               installs once the page is quiet
SIZES          pictures come at the size the screen shows them (srcset):
               1200 px variants of the lab banners for phones, the creator
               photos at 500/750/1000, a 240 px avatar, a 480 px lockup;
               app icons as palette PNG (a third of the bytes, same pixels)
FAILED         a lab section that fails to download is retried twice on its
               own (1 s, 3 s) under a fresh address (a browser keeps a failed
               module import failed), then says so with RETRY and RELOAD;
               the first download of the tool, slow or failed, is said in
               the static introduction (public/boot-watch.js) with RELOAD
```

Measured on a phone (390 px, DPR 3) under Chromium's throttling, first
visit, service worker blocked (what the page itself fetches):

```text
                         FAST 3G (1.6 Mb/s, 150 ms)   SLOW 3G (400 kb/s, 400 ms)
                         before      after            before      after
tool's code in           1.5 s       1.3 s            5.6 s       5.0 s
What's New picture in    18.9 s      3.2 s            36.6 s      12.3 s
its TV in                21.4 s      4.5 s            > 40 s      18.8 s
startup code (gzip)      208 kB      174 kB
```

The boot screen ends about 15 s after the start: with these changes What's
New opens complete on Fast 3G. Pictures: every picture of the pages is
WebP; the app icons stay PNG and the favicon ICO (what systems read), the
social preview images JPEG (what link previews read).

## COMPATIBILITY

```text
THE DEMO, REPLAYS, REPORTS   any current browser, phones included: built for
                             ES2020 (Safari 14, iOS 14, Firefox 78, Chrome 85
                             and later)
FILLED IN                    the few newer functions used (Array/String .at(),
                             structuredClone, AbortSignal.timeout) are filled
                             in first thing on a browser that lacks them
                             (web/src/core/compat.ts); a regex lookbehind,
                             which Safari before 16.4 cannot even parse, is
                             refused by a test
STYLES                       newer CSS (color-mix, :has) has a plain fallback
                             before it: older browsers lose a tint, not a
                             screen
DEVICES                      Web Serial (console, probe, Flipper): Chrome, Edge,
                             Opera on a computer; Web Bluetooth: Chrome, Edge on
                             a computer or Android (scanning behind a flag);
                             none of it on iPhone or iPad (every browser there
                             runs Safari's engine); dogd on a computer for the
                             network and this computer's USB
```

THIS DEVICE (on the home, folded, and in SETUP) says which browser, system
and kind of device this is, and for each tool whether it works here, partly
or not, why, and what to use instead (web/src/core/device.ts). Checked in
the browser when shown; nothing is sent.

Checked in Chromium (desktop and phone sizes), and in Chromium with the
functions older Safari and Firefox lack removed: every screen, the demo, the
labs' demos, exports, a replay, dogd, offline.

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
/boot-watch.js          (default: revalidated) kept by the worker for offline
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
