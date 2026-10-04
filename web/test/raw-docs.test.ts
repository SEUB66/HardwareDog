import { describe, expect, it } from 'vitest';
import page from '../engineering.html?raw';

/**
 * engineering.html shows the repository's docs raw. A public page must not
 * show an older plan than the repository: when this fails, run
 * `npm run docs:sync`.
 */
const docs = import.meta.glob('../../docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

describe('engineering.html shows the docs as they are', () => {
  const shown = [...page.matchAll(/<pre tabindex="0" aria-label="([A-Z_]+\.md) raw source">([\s\S]*?)<\/pre>/g)];

  it('shows some docs', () => {
    expect(shown.map((m) => m[1])).toEqual(['ARCHITECTURE.md', 'ENGINEERING_PLAN.md', 'FIRMWARE.md']);
  });

  for (const [, name, body] of shown) {
    it(`${name} is the repository's (npm run docs:sync)`, () => {
      expect(unescape(body!)).toBe(docs[`../../docs/${name}`]);
    });
  }
});
