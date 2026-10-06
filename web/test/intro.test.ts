import { describe, expect, it } from 'vitest';
import { BANNER, DOG, TAGLINE } from '../src/core/ascii';
import { PROTOCOL_VERSION } from '../src/core/protocol';
import { RULES } from '../src/core/system';
import { BANNER_COLS, INTRO, PROMPT, bannerCells, cellAt, codeAt, codeLines, dogAt, taglineAt, typed } from '../src/ui/intro';

// Phase one of the start: the terminal intro. It must show the character
// of the software, take its time, and claim nothing it has not checked.

const text = (line: [string, string][]) => line.map(([, s]) => s).join('');

describe('the terminal intro', () => {
  it('takes its time: about nine seconds, each part after the other', () => {
    expect(INTRO.end).toBeGreaterThanOrEqual(8000);
    expect(INTRO.bannerFrom).toBeLessThan(INTRO.bannerTo);
    expect(INTRO.bannerTo).toBeLessThanOrEqual(INTRO.dog);
    expect(INTRO.dog).toBeLessThan(INTRO.code);
    // Every line is typed before the tagline, the tagline settles before the hold.
    expect(INTRO.code + codeLines(RULES.length).length * INTRO.codeLineMs).toBeLessThanOrEqual(INTRO.tagline);
    expect(INTRO.tagline + TAGLINE.length * 45).toBeLessThanOrEqual(INTRO.hold);
    expect(INTRO.hold).toBeLessThan(INTRO.end);
  });

  it('decodes every cell of the banner out of 0 and 1, and locks them all in time', () => {
    const cells = bannerCells();
    const visible = [...BANNER].filter((c) => c !== ' ' && c !== '\n').length;
    expect(cells).toHaveLength(visible);
    for (const c of cells) {
      expect(c.from).toBeGreaterThanOrEqual(INTRO.bannerFrom);
      expect(c.lockAt).toBeGreaterThan(c.from);
      expect(c.lockAt).toBeLessThanOrEqual(INTRO.bannerTo);
      expect(cellAt(c, c.from - 1).kind).toBe('none');
      const mid = cellAt(c, (c.from + c.lockAt) / 2);
      expect(mid.kind).toBe('bit');
      if (mid.kind === 'bit') expect(['0', '1']).toContain(mid.bit);
      expect(cellAt(c, INTRO.bannerTo).kind).toBe('locked');
    }
    // HW in one color, DOG in the other.
    expect(new Set(cells.filter((c) => c.x < 20).map((c) => c.word))).toEqual(new Set(['HW']));
    expect(new Set(cells.filter((c) => c.x > BANNER_COLS - 8).map((c) => c.word))).toEqual(new Set(['DOG']));
  });

  it('is the same every time', () => {
    expect(bannerCells()).toEqual(bannerCells());
  });

  it('types the prompt, then the dog line by line', () => {
    expect(typed(PROMPT, 0, 0, 55)).toBe('$');
    expect(typed(PROMPT, 0, 10_000, 55)).toBe(PROMPT);
    expect(dogAt(INTRO.dog - 1)).toEqual([]);
    expect(dogAt(INTRO.code)).toEqual(DOG.slice(0, 3));
    expect(dogAt(INTRO.end)).toEqual(DOG);
  });

  it('says as code only what is true of this build', () => {
    const lines = codeLines(RULES.length).map(text);
    expect(lines.join('\n')).toContain(`hdp.protocol   = ${PROTOCOL_VERSION};`);
    expect(lines.join('\n')).toContain(`rules.loaded   = ${RULES.length};`);
    expect(lines.join('\n')).toContain("'LOCAL FIRST', 'NO CLOUD', 'NO TELEMETRY'");
    // Comments line up in one column.
    const at = lines.filter((l) => l.includes('//')).map((l) => l.indexOf('//'));
    expect(new Set(at).size).toBe(1);
  });

  it('types the code a line at a time, never past the end', () => {
    const code = codeLines(RULES.length);
    expect(codeAt(code, INTRO.code - 1)).toEqual([]);
    const half = codeAt(code, INTRO.code + INTRO.codeLineMs * 2.5);
    expect(half).toHaveLength(3);
    expect(text(half[2]!).length).toBeLessThan(text(code[2]!).length);
    expect(codeAt(code, INTRO.end).map(text)).toEqual(code.map(text));
  });

  it('settles the tagline letter by letter', () => {
    expect(taglineAt(INTRO.tagline - 1)).toBe('');
    expect(taglineAt(INTRO.tagline)).toHaveLength(TAGLINE.length);
    expect(taglineAt(INTRO.tagline)).not.toBe(TAGLINE);
    expect(taglineAt(INTRO.hold)).toBe(TAGLINE);
  });
});
