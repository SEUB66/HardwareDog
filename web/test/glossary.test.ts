import { describe, expect, it } from 'vitest';
import { ALL_ENTRIES, explain, explainPanel, explainSource, explainStatus } from '../src/core/glossary';
import { SEVERITIES, SOURCES } from '../src/core/types';

/** Every screen and component of the interface, as text. */
const ui = import.meta.glob('../src/ui/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** The text of `rows={[ ... ]}` blocks, with the scope of the panel they sit in. */
function kvLabels(): { file: string; scope: string | undefined; label: string }[] {
  const out: { file: string; scope: string | undefined; label: string }[] = [];
  for (const [file, src] of Object.entries(ui)) {
    const panels = [...src.matchAll(/<Panel title="([^"]+)"([^>]*)>/g)].map((m) => ({
      at: m.index,
      scope: /scope="([^"]+)"/.exec(m[2]!)?.[1] ?? m[1]!,
    }));
    for (const m of src.matchAll(/rows=\{\[/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (depth > 0 && i < src.length) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') depth--;
        i++;
      }
      const block = src.slice(m.index, i);
      const scope = panels.filter((p) => p.at < m.index).at(-1)?.scope;
      for (const r of block.matchAll(/\[\s*'([A-Z][A-Z0-9 ]*)',/g)) out.push({ file, scope, label: r[1]! });
    }
  }
  return out;
}

describe('glossary: no stat on screen without its meaning', () => {
  it('finds the labels it checks', () => {
    expect(kvLabels().length).toBeGreaterThan(60);
  });

  it('every label of every KV row is explained, in its panel', () => {
    const missing = kvLabels()
      .filter((l) => explain(l.label, l.scope) === undefined)
      .map((l) => `${l.file}: ${l.scope}/${l.label}`);
    expect(missing).toEqual([]);
  });

  it('every panel title is explained', () => {
    const missing: string[] = [];
    for (const src of Object.values(ui)) {
      for (const m of src.matchAll(/<Panel title="([^"]+)"([^>]*)>/g)) {
        if (!/info="/.test(m[2]!) && explainPanel(m[1]!) === undefined) missing.push(m[1]!);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every source, level and status word is explained', () => {
    const words = [
      ...SEVERITIES,
      ...['PASS', 'WARN', 'FAIL', 'PENDING', 'UNKNOWN', 'LIVE'],
      ...['OFFLINE', 'CONNECTING', 'ONLINE', 'LOST'],
      ...['STABLE', 'UNDERVOLTAGE', 'OVERCURRENT', 'NO SIGNAL'],
      ...['LOW', 'MEDIUM', 'HIGH'],
      ...['VERIFIED', 'RECOVERED', 'INCOMPLETE', 'MODIFIED', 'UNVERIFIED'],
    ];
    expect(words.filter((w) => explainStatus(w) === undefined)).toEqual([]);
    expect(SOURCES.filter((s) => explainSource(s) === undefined)).toEqual([]);
  });

  it('the same word means what it means where it is', () => {
    expect(explain('STATE', 'POWER')).toMatch(/rail/i);
    expect(explain('STATE', 'LINK')).toMatch(/frames/i);
    expect(explain('STATE', 'USB')).toMatch(/enumerated/i);
    expect(explain('SPEED', 'BUS')).toMatch(/I2C/);
    expect(explain('SPEED', 'USB')).toMatch(/USB/);
    expect(explain('state', 'power')).toBe(explain('STATE', 'POWER'));
  });

  it('every entry is a short plain-English sentence, without fake certainty', () => {
    for (const [key, text] of ALL_ENTRIES) {
      expect(text, key).toMatch(/[.?]$/);
      expect(text.length, key).toBeLessThanOrEqual(260);
      expect(text, key).toMatch(/^[\x20-\x7e]+$/);
      expect(text, key).not.toMatch(/\b(definitely|guaranteed|certainly|always the)\b/i);
    }
  });
});
