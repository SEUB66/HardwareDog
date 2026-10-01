import { describe, expect, it } from 'vitest';

/**
 * LAW 3 — LOCAL IS THE SOURCE OF TRUTH. THE CLOUD IS NEVER REQUIRED.
 * (docs/LAWS.md)
 *
 * The interface never calls home: no network API in the source, nothing
 * loaded from a remote host. Probes that the DEVICE runs on its own
 * network (ping, DNS, HTTP GET) are HDP commands, not browser requests.
 */

const sources = import.meta.glob('../src/**/*.{ts,tsx,css}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const html = import.meta.glob('../index.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const FORBIDDEN: [RegExp, string][] = [
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\bnew\s+WebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bimportScripts\b/, 'importScripts'],
  [/@import\s+url\(\s*['"]?https?:/, 'remote CSS import'],
  [/url\(\s*['"]?https?:/, 'remote CSS asset'],
];

/** Text that only describes what the device does on ITS network. */
const ALLOWED_URL = /send "GET \/" to http:\/\/\$\{t\}\//;

describe('LAW: the cloud is never required', () => {
  it('scans the whole interface source', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  for (const [path, text] of Object.entries(sources)) {
    it(`${path.replace('../src/', 'src/')} makes no network call`, () => {
      for (const [re, what] of FORBIDDEN) expect(re.test(text), `${what} in ${path}`).toBe(false);
      const urls = text.split('\n').filter((l) => /https?:\/\//.test(l) && !ALLOWED_URL.test(l));
      expect(urls, `remote URL in ${path}`).toEqual([]);
    });
  }

  it('index.html loads nothing from a remote host', () => {
    const page = Object.values(html)[0]!;
    expect(page).not.toMatch(/(src|href)\s*=\s*["']https?:/);
    expect(page).not.toMatch(/(src|href)\s*=\s*["']\/\//);
  });
});
