import { BANNER, DOG, TAGLINE } from '../core/ascii';
import { PROTOCOL_VERSION } from '../core/protocol';

/**
 * The terminal intro: the first phase of the start, before the real checks.
 *
 * It shows the character of the software, and claims nothing: no line here
 * says a check passed. The checks come after, in phase two, each one real.
 * Everything is a function of the time since the intro began, so the same
 * moment always looks the same, and it can be tested without a browser.
 */

/** When each part starts, in milliseconds from the beginning. */
export const INTRO = {
  prompt: 0,
  /** The banner's cells appear as 0 and 1, then lock into the letters. */
  bannerFrom: 700,
  bannerTo: 3600,
  dog: 3700,
  dogLineMs: 280,
  code: 4300,
  codeLineMs: 520,
  tagline: 7700,
  /** Everything is on screen: a moment to look at it. */
  hold: 8600,
  /** Fade to phase two. */
  end: 9400,
  /** "press any key" appears: before, a stray key would cut the show short. */
  skippable: 1500,
} as const;

export const PROMPT = '$ hwdog --boot';
export const PROMPT_CHAR_MS = 55;

export interface Cell {
  x: number;
  y: number;
  ch: string;
  /** When the cell starts flickering as 0 / 1, and when it locks. */
  from: number;
  lockAt: number;
  /** HW or DOG: the two words take the two colors of the brand. */
  word: 'HW' | 'DOG';
}

/** A small deterministic generator: the intro looks the same every time. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const ROWS = BANNER.split('\n').map((r) => [...r]);
export const BANNER_COLS = Math.max(...ROWS.map((r) => r.length));
export const BANNER_ROWS = ROWS.length;
/** The first column of "DOG" in the banner. */
const DOG_FROM = ROWS[0]!.join('').indexOf('██████╗');

/**
 * Every visible cell of the banner, with its timing: a wave from left to
 * right, each cell a little early or late so it reads as decoding, not as
 * a wipe.
 */
export function bannerCells(seed = 0x48d06): Cell[] {
  const random = rng(seed);
  const span = INTRO.bannerTo - INTRO.bannerFrom;
  const cells: Cell[] = [];
  ROWS.forEach((row, y) =>
    row.forEach((ch, x) => {
      if (ch === ' ') return;
      const wave = (x / BANNER_COLS) * span * 0.62;
      const from = INTRO.bannerFrom + wave * 0.5 + random() * 260;
      const lockAt = Math.min(INTRO.bannerTo, INTRO.bannerFrom + wave + 520 + random() * span * 0.3);
      cells.push({ x, y, ch, from, lockAt: Math.max(lockAt, from + 220), word: x >= DOG_FROM ? 'DOG' : 'HW' });
    }),
  );
  return cells;
}

/** What a cell shows at time t: nothing yet, a flickering bit, or its letter. */
export function cellAt(cell: Cell, t: number): { kind: 'none' } | { kind: 'bit'; bit: '0' | '1' } | { kind: 'locked'; flash: number } {
  if (t < cell.from) return { kind: 'none' };
  if (t < cell.lockAt) {
    // A new bit every 70 ms, different for every cell.
    const step = Math.floor((t - cell.from) / 70);
    return { kind: 'bit', bit: (step * 7 + cell.x * 3 + cell.y) % 2 === 0 ? '0' : '1' };
  }
  // A short white flash as the cell locks, fading over 240 ms.
  return { kind: 'locked', flash: Math.max(0, 1 - (t - cell.lockAt) / 240) };
}

/** How many characters of a typed string show at time t. */
export function typed(text: string, start: number, t: number, charMs: number): string {
  if (t < start) return '';
  return text.slice(0, Math.floor((t - start) / charMs) + 1);
}

/** The dog lines on screen at time t, one after another. */
export function dogAt(t: number): readonly string[] {
  if (t < INTRO.dog) return [];
  return DOG.slice(0, Math.min(DOG.length, Math.floor((t - INTRO.dog) / INTRO.dogLineMs) + 1));
}

export type TokenKind = 'kw' | 'id' | 'op' | 'str' | 'num' | 'com' | 'fn' | 'plain';
export type Token = [TokenKind, string];

/**
 * The code shown in the intro: what the software holds to, said as code.
 * Every value is true of this build (the protocol version and the number of
 * rules come from the code itself), so even the decoration does not lie.
 */
export function codeLines(rules: number): Token[][] {
  // A value set on a name, its comment in one column.
  const set = (obj: string, key: string, value: Token, note: string): Token[] => {
    const left = `${obj}.${key}`.padEnd(15, ' ');
    const used = left.length + 2 + value[1].length + 1;
    return [['id', obj], ['op', '.'], ['id', left.slice(obj.length + 1)], ['op', '= '], value, ['op', ';'], ['com', ' '.repeat(Math.max(2, COMMENT_AT - used)) + '// ' + note]];
  };
  return [
    [['kw', 'import'], ['plain', ' { '], ['id', 'hdp'], ['op', ', '], ['id', 'hdlog'], ['op', ', '], ['id', 'rules'], ['plain', ' } '], ['kw', 'from'], ['plain', ' '], ['str', "'hardware-dog'"], ['op', ';']],
    [['kw', 'const'], ['plain', ' '], ['id', 'LAWS'], ['op', ' = ['], ['str', "'LOCAL FIRST'"], ['op', ', '], ['str', "'NO CLOUD'"], ['op', ', '], ['str', "'NO TELEMETRY'"], ['op', '];']],
    set('hdp', 'protocol', ['num', String(PROTOCOL_VERSION)], 'one stream, one clock'),
    set('hdlog', 'seal', ['str', "'sha256'"], 'evidence, never rewritten'),
    set('rules', 'loaded', ['num', String(rules)], 'deterministic, no guess'),
    [['id', 'dog'], ['op', '.'], ['fn', 'sniff'], ['op', '();'], ['com', ' '.repeat(COMMENT_AT - 12) + '// ' + TAGLINE]],
  ];
}

/** The column where comments start. */
const COMMENT_AT = 30;

/** The code on screen at time t: whole lines, and the one being typed. */
export function codeAt(lines: Token[][], t: number): Token[][] {
  if (t < INTRO.code) return [];
  const elapsed = t - INTRO.code;
  const full = Math.floor(elapsed / INTRO.codeLineMs);
  const out = lines.slice(0, Math.min(full, lines.length));
  if (full < lines.length) {
    const line = lines[full]!;
    const total = line.reduce((n, [, s]) => n + s.length, 0);
    let left = Math.floor(((elapsed % INTRO.codeLineMs) / INTRO.codeLineMs) * total * 1.4);
    const partial: Token[] = [];
    for (const [k, s] of line) {
      if (left <= 0) break;
      partial.push([k, s.slice(0, left)]);
      left -= s.length;
    }
    out.push(partial);
  }
  return out;
}

/** The tagline arrives scrambled, and settles letter by letter. */
export function taglineAt(t: number): string {
  if (t < INTRO.tagline) return '';
  const settled = Math.floor((t - INTRO.tagline) / 45);
  return [...TAGLINE]
    .map((ch, i) => (i < settled || ch === ' ' ? ch : '01#$%&*<>/'[(i * 7 + Math.floor(t / 60)) % 10]!))
    .join('');
}
