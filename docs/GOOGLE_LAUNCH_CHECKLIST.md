# HARDWARE DOG / GOOGLE LAUNCH CHECKLIST

```text
WHAT      putting hardwaredog.org in front of Google: what is ready, what to
          submit, what only the site's owner can do
SITE      https://hardwaredog.org  (Netlify project "hwdog", static build of web/)
STATUS    files ready in this repository; nothing submitted to Google yet
```

No analytics, tag manager, pixel or tracking script is part of this
launch, and none is needed for Search Console.

---

## 1. WHAT IS OBSERVED, WHAT IS ASSUMED

```text
OBSERVED (Netlify, read-only)   project hwdog; primary domain https://hardwaredog.org;
                                production deploys from main on every merge;
                                deploy previews require a Netlify team login
                                (they are not public); no redirect rules in
                                netlify.toml (domain redirects are Netlify's
                                own, set in the domain settings)
OBSERVED (this repository)      the site is three static pages, each a real
                                file: / (index.html, French), /diagnostic.html
                                (the tool, English), /engineering.html (French);
                                no client-side routes; the tool's sections are
                                not URLs, so they get no pages of their own
NOT OBSERVED                    the live site's answers (HTTPS, www, old
                                hwdog.netlify.app, headers, 404): this work
                                session's network refuses hardwaredog.org.
                                Section 5 lists the exact checks to run
ASSUMED (to confirm in 5)       Netlify serves HTTPS with a valid certificate;
                                www.hardwaredog.org and hwdog.netlify.app
                                redirect (301) to https://hardwaredog.org/;
                                a missing path answers 404 with /404.html
```

## 2. WHAT THE SITE NOW SERVES

```text
URL                                              WHAT                        INDEX
https://hardwaredog.org/                         the presentation (French)   yes
https://hardwaredog.org/diagnostic.html          the tool, with a static     yes
                                                 introduction readable
                                                 without JavaScript
https://hardwaredog.org/engineering.html         architecture and roadmap    yes
https://hardwaredog.org/sitemap.xml              the three pages above       -
https://hardwaredog.org/robots.txt               Allow all + Sitemap line    -
https://hardwaredog.org/og/hardware-dog-1200x630.jpg   the share image       -
https://hardwaredog.org/manifest.webmanifest     the installed app           -
any other path                                   404.html, status 404,       no
                                                 noindex
```

Each indexable page has, in its initial HTML (no JavaScript needed): a
title, a meta description, `<link rel="canonical">` to its own address
above, Open Graph (type, title, description, url, image with its size,
type and alt text) and `twitter:card = summary_large_image`. The
presentation page carries the structured data (WebSite, SoftwareApplication:
name, address, category, free for personal use, license, author; no
rating, review, user count or award). No hreflang: the language changes in
the interface only, the addresses do not.

The sitemap has no `lastmod`: no reliable per-page date is kept, and a
build date would be false.

## 3. GOOGLE SEARCH CONSOLE (the owner, signed in to Google)

1. Open https://search.google.com/search-console and look at the property
   list: a property **Domain: hardwaredog.org** or a **URL prefix:
   https://hardwaredog.org/** may already exist. If one exists and shows
   as verified, keep it and its verification as they are; go to step 4.
2. If none exists, add a property. Prefer **Domain** (`hardwaredog.org`): it
   covers https, http and www. Google then shows a **DNS TXT record**
   (`google-site-verification=...`). Add that exact value at the DNS host
   of hardwaredog.org (Netlify DNS if the domain uses Netlify's name
   servers: Netlify > Domains > hardwaredog.org > DNS records > Add record >
   TXT, name `@`). Wait for it to propagate, then click Verify.
3. If you choose a **URL prefix** property instead and Google offers an
   **HTML file** or a **meta tag**: send the exact file (e.g.
   `google1234abcd.html`) or the exact `content` value. The file goes in
   `web/public/` (served at the site's root); the tag goes in the `<head>`
   of `web/index.html` as
   `<meta name="google-site-verification" content="EXACT-VALUE">`. Nothing
   is in place yet: no token is invented.
4. **Sitemaps** > Add a new sitemap: `sitemap.xml`
   (full address https://hardwaredog.org/sitemap.xml) > Submit. Look at its
   status later; a submission is not an indexing.
5. **URL inspection**, one by one, after the deploy has been checked
   (section 5): `https://hardwaredog.org/`,
   `https://hardwaredog.org/diagnostic.html`,
   `https://hardwaredog.org/engineering.html`. For each: *Test live URL*,
   look at the rendered page and at "Indexing allowed? Yes"; then
   *Request indexing*.

Google may take days or weeks, and decides itself what it indexes and how
it ranks it. Nothing here guarantees either.

## 4. SHARE PREVIEWS

After the deploy, paste https://hardwaredog.org/ into the preview tools of
the networks you use (they read the same Open Graph tags). The image is a
public file, served without a cookie, a login or JavaScript.

## 5. AFTER THE DEPLOY: CHECK THE REAL SITE

From any computer (each line: expected answer):

```text
curl -sI https://hardwaredog.org/                    200, text/html
curl -sI https://www.hardwaredog.org/                301 → https://hardwaredog.org/
curl -sI http://hardwaredog.org/                     301 → https://hardwaredog.org/
curl -sI https://hwdog.netlify.app/                  301 → https://hardwaredog.org/
curl -sI https://hardwaredog.org/diagnostic.html     200, no X-Robots-Tag: noindex
curl -sI https://hardwaredog.org/engineering.html    200
curl -sI https://hardwaredog.org/does-not-exist      404
curl -s  https://hardwaredog.org/robots.txt          the Sitemap line
curl -s  https://hardwaredog.org/sitemap.xml         three <loc>, the canonical addresses
curl -sI https://hardwaredog.org/manifest.webmanifest   200, application/manifest+json
curl -sI https://hardwaredog.org/sw.js               200, Cache-Control: no-cache
curl -sI https://hardwaredog.org/og/hardware-dog-1200x630.jpg   200, image/jpeg
curl -s  https://hardwaredog.org/diagnostic.html | grep -c 'og:image'   1 or more
```

If www or the old address does not redirect: Netlify > Domain management:
make hardwaredog.org the primary domain; www as a domain alias redirects to
it. No redirect loop is possible from the repository: it declares none.

---

## RESULTS (this pull request)

```text
PASS     manifest: identity kept (start_url, id), icons with real sizes, types and purposes
PASS     maskable icons in the safe zone under round and rounded-square masks, no built-in corner
PASS     apple-touch-icon 180 opaque; favicons 16 / 32 / ICO 16-32-48, legible at 16 px (checked by eye)
PASS     share image 1200 x 630, readable at preview sizes (500 and 300 px wide, checked by eye)
PASS     metadata present in the raw HTML of the three pages (tests and the built files)
PASS     a reader without JavaScript gets the H1 and what each tool does and its limits
PASS     sitemap XML valid and equal to the canonical addresses; robots.txt names it
PASS     a missing path: 404 page with status 404, noindex (local server like Netlify)
PASS     no tracking script; no new third-party call (law tests, CSP console clean)
PASS     Chrome: manifest without errors, installable, service worker active (headless, local)
PASS     offline after one visit, server stopped: the tool, ?demo, the landing page; unknown path 503
PASS     update during a demo BLE scan: waits, the scan continues; reload after STOP, old caches removed
PASS     iPhone 13 emulation (Chromium): the Add to Home Screen line, no side scroll
NOT RUN  native install prompt and launching the installed app: headless Chromium shows no prompt
NOT RUN  real Android and iOS devices: none in this session
NOT RUN  production checks (section 5): this session's network refuses hardwaredog.org;
         to run after the deploy, by the owner or a session allowed to reach the site
NOT RUN  Search Console: needs the owner's Google account
```

## WHAT ONLY THE OWNER CAN DO

```text
1  approve the pull request (its merge deploys to production)
2  Search Console: the property, and its verification value if one is asked
   (DNS TXT value, HTML file, or meta tag content, exactly as Google gives it)
3  submit the sitemap, request indexing (section 3)
4  run, or let a session run, the production checks (section 5)
```
