/**
 * LVL 100: complete documentation. Every relative link resolves, every
 * document is in the index, and every piece of evidence the 1.0 checklist
 * names exists. A doc that points nowhere is worse than no doc.
 */
import { describe, expect, it } from 'vitest';

const pages = import.meta.glob(['../../docs/*.md', '../../*.md', '../../cases/*.md', '../../.github/**/*.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const fs = async () => (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as { existsSync(p: URL): boolean };
const repo = new URL('../../', import.meta.url);

describe('the documentation', () => {
  it('finds the pages it checks', () => {
    expect(Object.keys(pages).length).toBeGreaterThan(20);
  });

  it('every relative link resolves', async () => {
    const { existsSync } = await fs();
    const broken: string[] = [];
    for (const [path, text] of Object.entries(pages)) {
      const base = new URL(path, import.meta.url);
      // Links in code blocks are examples, not links.
      const prose = text.replace(/```[\s\S]*?```/g, '');
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^(https?:|mailto:|#)/.test(target!)) continue;
        const file = target!.split('#')[0]!.split('?')[0]!;
        if (!existsSync(new URL(file, base))) broken.push(`${path.replace('../../', '')} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the index lists every document', () => {
    const index = pages['../../docs/README.md']!;
    const docs = Object.keys(pages)
      .filter((p) => /^\.\.\/\.\.\/docs\/[A-Z_]+\.md$/.test(p) && !p.endsWith('/README.md'))
      .map((p) => p.split('/').pop()!);
    expect(docs.filter((d) => !index.includes(`(${d})`))).toEqual([]);
  });

  it('every piece of evidence the 1.0 checklist names exists', async () => {
    const { existsSync } = await fs();
    const release = pages['../../docs/RELEASE.md']!;
    const cited = new Set(
      [...release.matchAll(/(?:^|[\s(,:])((?:\.github|web|dogd|firmware|protocol|cases|docs)\/[\w./-]+|[A-Z]+\.md|LICENSE|netlify\.toml)(?=[\s,;:)]|$)/gm)].map((m) =>
        m[1]!.replace(/[.,;:]$/, ''),
      ),
    );
    expect(cited.size).toBeGreaterThan(25);
    const missing = [...cited].filter((p) => !existsSync(new URL(p.startsWith('docs/') || p.includes('/') ? p : existsSync(new URL(p, repo)) ? p : `docs/${p}`, repo)));
    expect(missing).toEqual([]);
  });
});
