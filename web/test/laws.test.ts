import { describe, expect, it } from 'vitest';

/**
 * LAW 3 — LOCAL IS THE SOURCE OF TRUTH. THE CLOUD IS NEVER REQUIRED.
 * (docs/LAWS.md)
 *
 * The interface never calls home: no network API in the source, nothing
 * loaded from a remote host. Probes that the DEVICE runs on its own
 * network (ping, DNS, HTTP GET) are HDP commands, not browser requests.
 *
 * One exception, local by construction: src/core/dogd.ts talks to dogd,
 * the daemon on THIS machine, and only at 127.0.0.1.
 */

const sources = import.meta.glob('../src/**/*.{ts,tsx,css}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const html = import.meta.glob('../{index,diagnostic,engineering}.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

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

/** The local daemon: the only file that may open a connection, and only to loopback. */
const LOCAL_DAEMON = '../src/core/dogd.ts';
const LOOPBACK_URL = /^\s*export const DOGD_URL = 'http:\/\/127\.0\.0\.1:4782';$/;

describe('LAW: the cloud is never required', () => {
  it('scans the whole interface source', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  for (const [path, text] of Object.entries(sources)) {
    if (path === LOCAL_DAEMON) continue;
    it(`${path.replace('../src/', 'src/')} makes no network call`, () => {
      for (const [re, what] of FORBIDDEN) expect(re.test(text), `${what} in ${path}`).toBe(false);
      const urls = text.split('\n').filter((l) => /https?:\/\//.test(l) && !ALLOWED_URL.test(l));
      expect(urls, `remote URL in ${path}`).toEqual([]);
    });
  }

  it('src/core/dogd.ts reaches dogd on this machine, and nothing else', () => {
    const text = sources[LOCAL_DAEMON]!;
    const urls = text.split('\n').filter((l) => /(https?|wss?):\/\//.test(l));
    expect(urls).toHaveLength(1);
    expect(urls[0].trimEnd()).toMatch(LOOPBACK_URL);
    // every request goes to the base URL, never to an address built elsewhere
    for (const call of text.match(/fetch\([^,)]*/g) ?? []) expect(call).toMatch(/fetch\((url|`\$\{base\}\/v1\/)/);
    const sockets = text.split('\n').filter((l) => l.includes('new WebSocket('));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]).toContain('new WebSocket(`${this.base.replace(');
  });

  for (const [path, page] of Object.entries(html)) {
    it(`${path} loads nothing from a remote host`, () => {
      // A user-activated repository link is navigation, not a runtime dependency.
      const resources = page.replace(/<a\b[^>]*>/gi, '');
      expect(resources).not.toMatch(/(src|href)\s*=\s*["']https?:/);
      expect(resources).not.toMatch(/(src|href)\s*=\s*["']\/\//);
    });
  }
});
