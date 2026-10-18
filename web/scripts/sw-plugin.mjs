/**
 * HARDWARE DOG / THE SERVICE WORKER OF A BUILD
 *
 * A Vite plugin (web/vite.config.ts) that writes dist/sw.js from
 * web/sw/service-worker.js: its version is a hash of every file it keeps
 * and of their content, so the same sources build the same worker
 * (npm run build:verify) and any change makes a new one.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

/** What the service worker keeps for offline use from the start: the interface, not every picture. */
export const PRECACHE_FILE = /^(index|diagnostic|engineering)\.html$|\.(js|css|woff2)$|^assets\/(hd-tv-|hd-dog-scenes|hd-companion-scenes|hd-head-|hd-mark-|hd-boot)/;
/** Public files the interface needs offline (icons, manifest, the static introduction). */
export const PRECACHE_PUBLIC = /^(manifest\.webmanifest|favicon\.ico|favicon-(16|32)\.png|apple-touch-icon\.png|icon-(maskable-)?(192|512)\.png|intro\.css)$/;

/** @returns {import('vite').Plugin} */
export function serviceWorker() {
  return {
    name: 'hwdog-sw',
    apply: 'build',
    // after Vite's own plugins: an HTML page's empty script chunk is gone by then
    enforce: 'post',
    generateBundle(_options, bundle) {
      /** @type {[string, string | Uint8Array][]} */
      const files = [];
      for (const [name, out] of Object.entries(bundle)) {
        const data = out.type === 'chunk' ? out.code : out.source;
        // an empty chunk is never written: listing it would make the whole install fail
        if (PRECACHE_FILE.test(name) && !(out.type === 'chunk' && data.trim() === '')) files.push([name, data]);
      }
      for (const name of readdirSync('public')) if (PRECACHE_PUBLIC.test(name)) files.push([name, readFileSync(`public/${name}`)]);
      files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const hash = createHash('sha256');
      for (const [name, data] of files) hash.update(name).update('\0').update(data).update('\0');
      const version = hash.digest('hex').slice(0, 16);
      const source = readFileSync('sw/service-worker.js', 'utf8')
        .replace("'__HWDOG_VERSION__'", JSON.stringify(version))
        .replace('__HWDOG_PRECACHE__', JSON.stringify(files.map(([name]) => name)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
