import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PRECACHE_FILE, PRECACHE_PUBLIC, serviceWorker } from '../scripts/sw-plugin.mjs';
import { Pwa, updateBlocker } from '../src/core/pwa';

/**
 * LAUNCH (hardwaredog.org): the install, the icons, the share previews,
 * what a crawler reads without JavaScript, the sitemap, and the service
 * worker's rules. docs/GOOGLE_LAUNCH_CHECKLIST.md, docs/WEB_APP.md.
 */

const pub = decodeURIComponent(new URL('../public/', import.meta.url).pathname);
const raw = import.meta.glob('../public/{manifest.webmanifest,robots.txt,sitemap.xml,404.html}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const pages = import.meta.glob('../{index,diagnostic,engineering}.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const swSource = (import.meta.glob('../sw/service-worker.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)['../sw/service-worker.js']!;

const ORIGIN = 'https://hardwaredog.org';
const manifest = JSON.parse(raw['../public/manifest.webmanifest']!) as {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

const meta = (html: string, key: string) => html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1] ?? null;
const canonicalOf = (html: string) => html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;

describe('the installed app (manifest)', () => {
  it('keeps the identity of existing installs and opens the tool', () => {
    // start_url is unchanged since the first manifest; id is the identity browsers already computed from it
    expect(manifest.start_url).toBe('./diagnostic.html');
    expect(manifest.id).toBe('./diagnostic.html');
    expect(manifest.scope).toBe('./');
    expect(manifest.name).toBe('Hardware Dog');
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.theme_color).toBe(manifest.background_color);
  });

  it('declares every icon with its real size and type, any and maskable at 192 and 512', async () => {
    const want = ['192x192 any', '512x512 any', '192x192 maskable', '512x512 maskable'];
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(want.sort());
    for (const icon of manifest.icons) {
      const m = await sharp(`${pub}${icon.src}`).metadata();
      expect(`${m.width}x${m.height}`, icon.src).toBe(icon.sizes);
      expect(m.format, icon.src).toBe('png');
      expect(icon.type).toBe('image/png');
    }
  });

  it('maskable icons: full bleed, no rounded corner, everything drawn inside the safe zone (40 % radius)', async () => {
    for (const size of [192, 512]) {
      const { data, info } = await sharp(`${pub}icon-maskable-${size}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const px = (x: number, y: number): number[] => {
        const i = (y * info.width + x) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      };
      const ground = px(0, 0);
      // opaque corners in the ground's color: the system draws its own mask
      for (const [x, y] of [
        [0, 0],
        [size - 1, 0],
        [0, size - 1],
        [size - 1, size - 1],
      ]) {
        const c = px(x, y);
        expect(c[3]).toBe(255);
        expect(Math.abs(c[0]! - ground[0]!) + Math.abs(c[1]! - ground[1]!) + Math.abs(c[2]! - ground[2]!)).toBeLessThan(12);
      }
      let reach = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const c = px(x, y);
          if (Math.abs(c[0]! - ground[0]!) + Math.abs(c[1]! - ground[1]!) + Math.abs(c[2]! - ground[2]!) > 60) reach = Math.max(reach, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
        }
      expect(reach / size, `icon-maskable-${size}`).toBeLessThanOrEqual(0.4);
      expect(reach / size).toBeGreaterThan(0.3); // and not lost in the middle
    }
  });

  it('browser icons float: the head on a transparent ground (favicons and the "any" icons)', async () => {
    for (const f of ['favicon-16.png', 'favicon-32.png', 'icon-192.png', 'icon-512.png']) {
      const { data, info } = await sharp(`${pub}${f}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const a = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
      let clear = 0;
      for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (a(x, y) === 0) clear++;
      // a real transparent ground around the head; the favicons' face crop fills most of its square, its corners stay clear
      expect(clear / (info.width * info.height), f).toBeGreaterThan(f.startsWith('favicon') ? 0.04 : 0.3);
      expect(a(0, info.height - 1), f).toBe(0);
      expect(a(Math.floor(info.width / 2), Math.floor(info.height / 2)), f).toBe(255); // the head itself is opaque
    }
  });

  it('apple touch icon: 180 x 180, opaque (iOS rounds it itself)', async () => {
    const m = await sharp(`${pub}apple-touch-icon.png`).metadata();
    expect([m.width, m.height, m.hasAlpha]).toEqual([180, 180, false]);
  });

  it('favicons: 16 and 32 PNG, and an ICO holding 16, 32 and 48', async () => {
    for (const s of [16, 32]) {
      const m = await sharp(`${pub}favicon-${s}.png`).metadata();
      expect([m.width, m.height, m.format]).toEqual([s, s, 'png']);
    }
    const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { readFileSync(p: string): Uint8Array };
    const bytes = fs.readFileSync(`${pub}favicon.ico`);
    const ico = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(ico.getUint16(2, true)).toBe(1); // icon
    const n = ico.getUint16(4, true);
    const sizes = Array.from({ length: n }, (_, i) => ico.getUint8(6 + i * 16));
    expect(sizes).toEqual([16, 32, 48]);
  });
});

describe('what a crawler and a share preview read (raw HTML, no JavaScript)', () => {
  const expected: Record<string, string> = {
    '../index.html': `${ORIGIN}/`,
    '../diagnostic.html': `${ORIGIN}/diagnostic.html`,
    '../engineering.html': `${ORIGIN}/engineering.html`,
  };

  for (const [file, url] of Object.entries(expected)) {
    it(`${file.slice(3)}: title, description, canonical, Open Graph, card, icons, manifest`, async () => {
      const html = pages[file]!;
      expect(html).toMatch(/<title>[^<]{10,70}<\/title>/);
      expect(meta(html, 'description')!.length).toBeGreaterThan(50);
      expect(canonicalOf(html)).toBe(url);
      expect(meta(html, 'og:url')).toBe(url);
      expect(meta(html, 'og:type')).toBe('website');
      expect(meta(html, 'og:title')).toBeTruthy();
      expect(meta(html, 'og:description')).toBeTruthy();
      const image = meta(html, 'og:image')!;
      expect(image).toBe(`${ORIGIN}/og/hardware-dog-1200x630.jpg`);
      expect(meta(html, 'og:image:width')).toBe('1200');
      expect(meta(html, 'og:image:height')).toBe('630');
      expect(meta(html, 'og:image:alt')!.length).toBeGreaterThan(30);
      expect(meta(html, 'twitter:card')).toBe('summary_large_image');
      expect(meta(html, 'twitter:image')).toBe(image);
      expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest"');
      expect(html).toMatch(/<link rel="apple-touch-icon" sizes="180x180" href="\.\/apple-touch-icon\.png"/);
      expect(html).toMatch(/<link rel="icon" href="\.\/favicon\.ico"/);
      expect(html).not.toMatch(/noindex/);
      // a heading a reader and a crawler see without running anything
      expect(html).toMatch(/<h1[^>]*>/);
      const m = await sharp(`${pub}og/hardware-dog-1200x630.jpg`).metadata();
      expect([m.width, m.height, m.format]).toEqual([1200, 630, 'jpeg']);
    });
  }

  it('the tool page says what it is and its limits before JavaScript runs', () => {
    const html = pages['../diagnostic.html']!;
    const intro = html.slice(html.indexOf('<main id="intro"'), html.indexOf('</main>'));
    for (const word of ['Camera Sniffer', 'Bluetooth Lab', 'Flipper Lab', 'serial', 'dogd', 'Limits', 'does not prove']) expect(intro).toContain(word);
    expect(intro).not.toMatch(/detects (all|every)|100 ?%|guarantee/i);
  });

  it('structured data: WebSite and SoftwareApplication, facts only (no rating, review, user count or award)', () => {
    const html = pages['../index.html']!;
    const json = JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)![1]!) as { '@graph': Record<string, unknown>[] };
    expect(json['@graph'].map((n) => n['@type'])).toEqual(['WebSite', 'SoftwareApplication']);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/aggregateRating|review|ratingValue|userInteractionCount|award|NGO|nonprofit/i);
    expect(json['@graph'][1]!['url']).toBe(`${ORIGIN}/diagnostic.html`);
  });

  it('no tracking: no analytics, tag manager or pixel in any page', () => {
    for (const html of Object.values(pages)) expect(html).not.toMatch(/googletagmanager|google-analytics|gtag\(|fbq\(|plausible|matomo|hotjar|clarity\.ms/i);
  });

  it('a missing page is a real 404 page, not indexed', () => {
    const html = raw['../public/404.html']!;
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toMatch(/<h1>404/);
  });
});

describe('sitemap and robots', () => {
  const sitemap = raw['../public/sitemap.xml']!;
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

  it('a valid sitemap of the public, canonical pages only', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect((sitemap.match(/<url>/g) ?? []).length).toBe((sitemap.match(/<\/url>/g) ?? []).length);
    // exactly the canonical addresses of the pages, nothing else: no fragment, no parameter, no export
    const canonicals = Object.values(pages).map(canonicalOf).sort();
    expect([...locs].sort()).toEqual(canonicals);
    for (const loc of locs) expect(loc).toMatch(/^https:\/\/hardwaredog\.org\/[a-z.]*$/);
    // no date pretending to be a modification date
    expect(sitemap).not.toContain('<lastmod>');
  });

  it('robots.txt allows the site and names the sitemap by its absolute URL', () => {
    const robots = raw['../public/robots.txt']!;
    expect(robots).toContain('Sitemap: https://hardwaredog.org/sitemap.xml');
    expect(robots).toMatch(/User-agent: \*\nAllow: \//);
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m);
  });
});

/** The worker of a build, with a fake bundle: what it keeps, and its version. */
function buildWorker(bundle: Record<string, { type: 'chunk'; code: string } | { type: 'asset'; source: string }>): string {
  let out = '';
  const plugin = serviceWorker() as unknown as { generateBundle: (this: { emitFile: (f: { source: string }) => void }, o: unknown, b: unknown) => void };
  plugin.generateBundle.call({ emitFile: (f) => (out = f.source) }, {}, bundle);
  return out;
}

const BUNDLE = {
  'diagnostic.html': { type: 'asset' as const, source: '<html>' },
  'index.html': { type: 'asset' as const, source: '<html>' },
  'assets/diagnostic-abc.js': { type: 'chunk' as const, code: 'console.log(1)' },
  'assets/home-empty.js': { type: 'chunk' as const, code: '\n' },
  'assets/diagnostic-abc.css': { type: 'asset' as const, source: 'body{}' },
  'assets/ibm-plex-mono-latin-400-normal-x.woff2': { type: 'asset' as const, source: 'font' },
  'assets/ibm-plex-mono-latin-400-normal-x.woff': { type: 'asset' as const, source: 'font' },
  'assets/hd-tv-turquoise-560-x.webp': { type: 'asset' as const, source: 'img' },
  'assets/camera-sniffer-01-power-connections-2400-x.webp': { type: 'asset' as const, source: 'img' },
};

describe('the service worker of a build', () => {
  it('keeps the interface for offline use, not every picture, nor the installer, robots or the sitemap', () => {
    const sw = buildWorker(BUNDLE);
    const list = JSON.parse(sw.match(/const PRECACHE = (\[.*\]);/)![1]!) as string[];
    expect(list).toContain('diagnostic.html');
    expect(list).toContain('assets/diagnostic-abc.js');
    expect(list).toContain('assets/diagnostic-abc.css');
    expect(list).toContain('assets/ibm-plex-mono-latin-400-normal-x.woff2');
    expect(list).toContain('assets/hd-tv-turquoise-560-x.webp');
    expect(list).toContain('manifest.webmanifest');
    expect(list).toContain('icon-maskable-512.png');
    expect(list).not.toContain('assets/ibm-plex-mono-latin-400-normal-x.woff');
    expect(list).not.toContain('assets/home-empty.js'); // never written: it would fail the whole install
    expect(list).not.toContain('assets/camera-sniffer-01-power-connections-2400-x.webp');
    for (const never of ['install', 'robots.txt', 'sitemap.xml', '404.html', 'og/hardware-dog-1200x630.jpg']) expect(PRECACHE_FILE.test(never) || PRECACHE_PUBLIC.test(never), never).toBe(false);
  });

  it('the same sources build the same worker; a changed file makes a new version', () => {
    const a = buildWorker(BUNDLE);
    expect(buildWorker(BUNDLE)).toBe(a);
    const b = buildWorker({ ...BUNDLE, 'assets/diagnostic-abc.js': { type: 'chunk', code: 'console.log(2)' } });
    expect(b.match(/const VERSION = "(\w+)"/)![1]).not.toBe(a.match(/const VERSION = "(\w+)"/)![1]);
  });

  it('reaches no other host and imports nothing', () => {
    const urls = swSource.split('\n').filter((l) => /https?:\/\//.test(l));
    expect(urls).toEqual([]);
    expect(swSource).not.toMatch(/importScripts/);
  });
});

/** The worker run in a small fake of its environment: what it answers, and what it leaves alone. */
async function runWorker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const stores = new Map<string, Map<string, string>>([
    ['hwdog-old', new Map()],
    ['other-app', new Map()],
  ]);
  const network: string[] = [];
  let skipped = 0;
  let claimed = 0;
  const self = {
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => void skipped++,
    clients: { claim: async () => void claimed++ },
  };
  const key = (r: unknown) => (typeof r === 'string' ? r : (r as { url: string }).url);
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const s = stores.get(name)!;
      return { addAll: async (rs: unknown[]) => rs.forEach((r) => s.set(key(r), `cached ${key(r)}`)), put: async (r: unknown) => void s.set(key(r), `cached ${key(r)}`) };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: unknown, o?: { cacheName?: string }) => {
      const s = o?.cacheName ? stores.get(o.cacheName) : undefined;
      const hit = s?.get(key(r));
      return hit ? { body: hit } : undefined;
    },
  };
  const fetch = async (r: unknown) => {
    network.push(key(r));
    return {
      body: `network ${key(r)}`,
      ok: true,
      type: 'basic',
      clone() {
        return this;
      },
    };
  };
  class Req {
    constructor(
      readonly url: string,
      readonly init?: unknown,
    ) {}
  }
  class Res {
    constructor(
      readonly body: string,
      readonly init: { status: number },
    ) {}
  }
  const source = buildWorker(BUNDLE);
  new Function('self', 'caches', 'fetch', 'Request', 'Response', source)(self, caches, fetch, Req, Res);
  const wait = async (fn: (e: unknown) => void, e: Record<string, unknown>) => {
    let p: Promise<unknown> = Promise.resolve();
    fn({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const request = (url: string, extra: Record<string, unknown> = {}) => {
    let answer: Promise<{ body: string }> | null = null;
    listeners['fetch']!({ request: { method: 'GET', mode: 'cors', url, ...extra }, respondWith: (x: Promise<{ body: string }>) => (answer = x) });
    return answer as Promise<{ body: string }> | null;
  };
  return { listeners, stores, network, wait, request, skipped: () => skipped, claimed: () => claimed };
}

describe('the service worker, running', () => {
  it('installs this build, waits, takes over only when the page asks, deletes only its own old caches', async () => {
    const w = await runWorker();
    await w.wait(w.listeners['install']!, {});
    expect(w.skipped()).toBe(0); // a new version never takes over on its own
    const current = [...w.stores.keys()].find((k) => /^hwdog-[0-9a-f]{16}$/.test(k))!;
    expect(w.stores.get(current)!.has(`${ORIGIN}/diagnostic.html`)).toBe(true);
    await w.wait(w.listeners['activate']!, {});
    expect(w.stores.has('hwdog-old')).toBe(false);
    expect(w.stores.has('other-app')).toBe(true);
    expect(w.claimed()).toBe(1);
    w.listeners['message']!({ data: 'something else' });
    expect(w.skipped()).toBe(0);
    w.listeners['message']!({ data: 'hwdog:activate' });
    expect(w.skipped()).toBe(1);
  });

  it('opens the tool from its cache (with a query too), leaves dogd, other hosts, POST and the installer alone', async () => {
    const w = await runWorker();
    await w.wait(w.listeners['install']!, {});
    expect((await w.request(`${ORIGIN}/diagnostic.html?demo`, { mode: 'navigate' }))!.body).toBe(`cached ${ORIGIN}/diagnostic.html`);
    expect((await w.request(`${ORIGIN}/`, { mode: 'navigate' }))!.body).toBe(`cached ${ORIGIN}/index.html`);
    expect((await w.request(`${ORIGIN}/assets/diagnostic-abc.js`))!.body).toBe(`cached ${ORIGIN}/assets/diagnostic-abc.js`);
    // a picture not kept yet: fetched, then kept for next time
    expect((await w.request(`${ORIGIN}/assets/camera-sniffer-01-power-connections-2400-x.webp`))!.body).toContain('network');
    expect(w.request('http://127.0.0.1:4782/v1/health')).toBeNull();
    expect(w.request('https://example.com/x.js')).toBeNull();
    expect(w.request(`${ORIGIN}/install`)).toBeNull();
    expect(w.request(`${ORIGIN}/sitemap.xml`)).toBeNull();
    expect(w.request(`${ORIGIN}/robots.txt`)).toBeNull();
    expect(w.request(`${ORIGIN}/diagnostic.html`, { method: 'POST' })).toBeNull();
  });
});

describe('install and update in the page', () => {
  it('an update waits while anything runs', () => {
    expect(updateBlocker({ operations: 1, recording: false, labRecording: false })).toMatch(/operation/);
    expect(updateBlocker({ operations: 0, recording: true, labRecording: false })).toMatch(/recording/);
    expect(updateBlocker({ operations: 0, recording: false, labRecording: true })).toMatch(/lab session/);
    expect(updateBlocker({ operations: 0, recording: false, labRecording: false })).toBeNull();
  });

  it('iPhone and iPad get the written steps, not a prompt', () => {
    expect(Pwa.ios('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 5)).toBe(true);
    expect(Pwa.ios('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true); // an iPad
    expect(Pwa.ios('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false);
    expect(Pwa.ios('Mozilla/5.0 (Linux; Android 14)', 'Linux armv8l', 5)).toBe(false);
  });
});
