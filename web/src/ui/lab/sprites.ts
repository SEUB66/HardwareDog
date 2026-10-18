/**
 * HARDWARE DOG / TV SPRITES — THE COMPANION'S SCENES
 *
 * What plays inside the TV screen. The scenes are the owner's drawings:
 * the two sketch sheets (assets/brand/source/hd-companion-sheet-1.png and
 * -2.png) cut cell by cell and brought to the screen's pixel grid by
 * web/scripts/build-companion-scenes.mjs, nothing redrawn: same face, same
 * desk, one decor per mood and per activity, the big monitors as drawn.
 *
 * The drawings come alive here:
 *   - the companion breathes (its head and shoulders one pixel lower, on a
 *     slow cycle) and blinks, from frames made from the drawing itself
 *   - what is around it moves: code typed on the monitor, the spectrum on
 *     the scanner, blocks travelling between the two computers, rain on
 *     the window, steam from the mug, smoke from the iron, Zzz, sparkles,
 *     LEDs, the IR beam, the loading bar...
 *
 * Drawn on a 136 x 100 canvas, one canvas pixel per art pixel, scaled up
 * without smoothing. Every frame is a pure function of (scene, time):
 * remounting the TV (another section, a detached window) resumes, it never
 * restarts. A SpriteSet is replaceable: a Hardware Dog TV with the dog
 * would bring its own sheets and overlays, the engine stays the same.
 */

import type { Anim, Stage, Subject } from '../../core/lab/companion';
import atlasUrl from '../../../../assets/brand/web/hd-companion-scenes.webp';
import atlasJson from '../../../../assets/brand/web/hd-companion-scenes.json';

export const SCREEN_W = 136;
export const SCREEN_H = 100;

export const PALETTE = {
  outline: '#2a1a12',
  body: '#ff8a1e',
  cream: '#f2f0e9',
  cyan: '#00e5ff',
  green: '#79d98a',
  red: '#ff5f56',
  pink: '#ff6fae',
  amber: '#e4b04a',
} as const;

/** A scene: an animation of the companion, or the TV switching off. */
export type SceneName = Anim | 'shutdown';

export interface SpriteSet {
  id: string;
  /**
   * `subject`: what the animation is about (tool, file kind), to pick the
   * right scene. `stage`: the section on screen (the decor at rest) and
   * whether a small scene may play.
   */
  drawScene(ctx: CanvasRenderingContext2D, scene: SceneName, t: number, subject?: Subject | null, stage?: Stage | null): void;
  drawSplash(ctx: CanvasRenderingContext2D, t: number): void;
  /** Start loading the frames before the TV is switched on. */
  preload?(): void;
}

/** The drawn scenes, by their name on the sketch sheets. */
export const SCENE_IDS = [
  'coding',
  'mad',
  'connect',
  'scan',
  'analyze',
  'transfer',
  'success',
  'disconnected',
  'idle',
  'boot',
  'bluetooth',
  'rfid',
  'infrared',
  'uart',
  'backup',
  'repair',
  'report',
  'shutdown',
] as const;
export type SceneId = (typeof SCENE_IDS)[number];

interface AtlasScene {
  at: [number, number][];
  art: { top: number; height: number };
  eye: { x0: number; y0: number; x1: number; y1: number } | null;
}
const ATLAS = atlasJson as unknown as { frame: { w: number; h: number }; scenes: Record<SceneId, AtlasScene> };

// ----------------------------------------------------------- canvas bits

export function rect(ctx: CanvasRenderingContext2D, c: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function alpha(ctx: CanvasRenderingContext2D, a: number, c: string, x: number, y: number, w = 1, h = 1): void {
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  rect(ctx, c, x, y, w, h);
  ctx.globalAlpha = 1;
}

/** A repeatable pseudo-random number in 0..1 from an integer. */
export const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** On for `on` ms every `every` ms. */
export const pulse = (t: number, every: number, on: number, phase = 0) => (t + phase) % every < on;

// ------------------------------------------------------------------ font

const FONT: Record<string, string[]> = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.....', '..#..'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export function pixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, shadow?: string, scale = 1): number {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' ']!;
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (g[r]![c] !== '#') continue;
        if (shadow) rect(ctx, shadow, cx + c * scale + scale, y + r * scale + scale, scale, scale);
        rect(ctx, color, cx + c * scale, y + r * scale, scale, scale);
      }
    cx += 6 * scale;
  }
  return cx - x;
}

export const pixelTextWidth = (text: string, scale = 1) => text.length * 6 * scale - scale;

// ----------------------------------------------------------------- atlas

let atlas: HTMLImageElement | null = null;

/** The frames, loaded once for every TV (docked, floating, detached). */
function frames(): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  if (!atlas) {
    atlas = new Image();
    atlas.decoding = 'async';
    atlas.src = atlasUrl;
  }
  return atlas.complete && atlas.naturalWidth > 0 ? atlas : null;
}

/** Start loading the frames before the TV is switched on. */
export function preloadCompanion(): void {
  frames();
}

const BREATH = 1700;
const BLINK_EVERY = 3400;
const BLINK_MS = 150;

/**
 * The frame of a scene at time t: base and breath alternate on a slow
 * cycle, and now and then it blinks (only on a base phase, so the eye
 * closes where it is).
 */
export function frameAt(id: SceneId, t: number): 0 | 1 | 2 {
  const s = ATLAS.scenes[id];
  const phase = (t + 500) % BREATH;
  if (s.eye && t % BLINK_EVERY < BLINK_MS && phase < BREATH / 2) return 2;
  return phase < BREATH / 2 ? 0 : 1;
}

/** The scene as drawn (and breathing): false while the frames load. */
function base(ctx: CanvasRenderingContext2D, id: SceneId, t: number): boolean {
  const img = frames();
  if (!img) return false;
  const [sx, sy] = ATLAS.scenes[id].at[frameAt(id, t)]!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
  return true;
}

/** A piece of the drawing moved by dy (the ? hopping, the floppy going in). */
function hop(ctx: CanvasRenderingContext2D, id: SceneId, x: number, y: number, w: number, h: number, dy: number, fill: string): void {
  const img = frames();
  if (!img || !dy) return;
  const [sx, sy] = ATLAS.scenes[id].at[0]!;
  rect(ctx, fill, x, y, w, h);
  ctx.drawImage(img, sx + x, sy + y, w, h, x, y + dy, w, h);
}

// -------------------------------------------------------------- overlays

/** Code typed line after line, the last line growing, a cursor after it. */
export function typing(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, w: number, rows: number, bg: string, colors: string[]): void {
  const LINE = 1400;
  const n = Math.floor(t / LINE);
  rect(ctx, bg, x, y, w, rows * 3);
  for (let r = 0; r < rows; r++) {
    const line = n - (rows - 1) + r;
    const indent = 2 * Math.floor(rnd(line * 7) * 3);
    const full = 6 + Math.floor(rnd(line) * (w - 10 - indent));
    const len = r === rows - 1 ? Math.min(full, Math.floor(((t % LINE) / LINE) * full * 1.4)) : full;
    let cx = x + 1 + indent;
    let k = 0;
    while (cx < x + 1 + indent + len) {
      const word = 2 + Math.floor(rnd(line * 31 + k) * 6);
      const ww = Math.min(word, x + 1 + indent + len - cx);
      rect(ctx, colors[Math.floor(rnd(line * 13 + k) * colors.length)]!, cx, y + r * 3 + 1, ww, 1);
      cx += word + 1;
      k++;
    }
    if (r === rows - 1 && pulse(t, 500, 260)) rect(ctx, colors[0]!, cx, y + r * 3, 2, 3);
  }
}

/** Rain on a window pane: short streaks falling, a little slanted. */
function rain(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, w: number, h: number, seed: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let i = 0; i < Math.round((w * h) / 45); i++) {
    const speed = 0.045 + rnd(seed + i) * 0.03;
    const py = (rnd(seed + i * 3) * h + t * speed) % (h + 4);
    const px = (rnd(seed + i * 7) * (w + 8) - py * 0.35) % (w + 8);
    alpha(ctx, 0.75, '#9cc7ff', x + px, y + py - 3, 1, 2);
    alpha(ctx, 0.35, '#9cc7ff', x + px + 1, y + py - 5, 1, 2);
  }
  ctx.restore();
}

/** Something light rising and fading from a point: steam, smoke. */
export function rise(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, color: string, height: number, puffs = 3, period = 2400): void {
  for (let i = 0; i < puffs; i++) {
    const p = ((t + (i * period) / puffs) % period) / period;
    const py = y - p * height;
    const px = x + Math.sin(p * 6.5 + i) * 2;
    alpha(ctx, (1 - p) * 0.8, color, px, py, 2, 2);
    alpha(ctx, (1 - p) * 0.5, color, px + 1, py - 2, 1, 2);
  }
}

/** Zs floating up from a point, growing as they go. */
export function zzz(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, color: string): void {
  const PERIOD = 2600;
  for (let i = 0; i < 2; i++) {
    const p = ((t + i * (PERIOD / 2)) % PERIOD) / PERIOD;
    const s = p < 0.5 ? 3 : 4;
    const zx = Math.round(x + p * 8 + Math.sin(p * 6) * 1.5);
    const zy = Math.round(y - p * 14);
    ctx.globalAlpha = p < 0.8 ? 1 : (1 - p) * 5;
    rect(ctx, color, zx, zy, s, 1);
    for (let k = 1; k < s - 1; k++) rect(ctx, color, zx + s - 1 - k, zy + k, 1, 1);
    rect(ctx, color, zx, zy + s - 1, s, 1);
    ctx.globalAlpha = 1;
  }
}

/** A four-point sparkle, in phase with its own period. */
export function twinkle(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, color: string, phase: number): void {
  const p = ((t + phase) % 1200) / 1200;
  const r = p < 0.25 ? 1 : p < 0.5 ? 2 : p < 0.7 ? 1 : 0;
  if (!r) return;
  rect(ctx, color, x, y, 1, 1);
  for (let k = 1; k <= r; k++) {
    rect(ctx, color, x - k, y, 1, 1);
    rect(ctx, color, x + k, y, 1, 1);
    rect(ctx, color, x, y - k, 1, 1);
    rect(ctx, color, x, y + k, 1, 1);
  }
}

/** A small LED blinking with a halo. */
export function led(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, color: string, every: number, on: number, phase = 0): void {
  if (!pulse(t, every, on, phase)) return;
  alpha(ctx, 0.35, color, x - 1, y - 1, 3, 3);
  rect(ctx, color, x, y, 1, 1);
}

/** Arcs pulsing outward from a point (radio, NFC). */
export function waves(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, color: string, dir: 1 | -1, max = 3): void {
  const k = Math.floor(t / 300) % (max + 2);
  for (let i = 1; i <= Math.min(k, max); i++) {
    const r = 2 + i * 2;
    for (let a = -0.9; a <= 0.9; a += 0.25) alpha(ctx, 1 - i / (max + 1.5), color, x + dir * Math.cos(a) * r, y + Math.sin(a) * r, 1, 1);
  }
}

/** A light passing across a lens. */
export function glint(ctx: CanvasRenderingContext2D, t: number, cx: number, cy: number, r: number): void {
  const p = (t % 2600) / 700;
  if (p > 1) return;
  const off = -r + p * r * 2;
  for (let k = -r; k <= r; k++) {
    const x = cx + off + k * 0.5;
    const y = cy + k;
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) alpha(ctx, 0.7, '#ffffff', x, y, 1, 1);
  }
}

/** A spectrum, bars moving like a live signal. */
export function spectrum(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, w: number, h: number, bg: string, color: string): void {
  rect(ctx, bg, x, y, w, h);
  const f = t / 140;
  for (let i = 0; i < w; i += 2) {
    const v = 0.35 + 0.35 * Math.sin(i * 0.45 + f) * Math.sin(i * 0.13 - f * 0.6) + 0.3 * rnd(Math.floor(f) * 97 + i);
    const bh = Math.max(1, Math.round(v * h * (1 - Math.abs(i - w / 2) / w)));
    rect(ctx, color, x + i, y + h - bh, 1, bh);
  }
  rect(ctx, color, x, y + h - 1, w, 1);
}

/** Blocks travelling right with an arrow head, as drawn between the computers. */
function travel(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, w: number, h: number, bg: string, color: string): void {
  rect(ctx, bg, x, y, w, h);
  const shift = Math.floor(t / 90) % 4;
  for (let bx = x + shift - 4; bx < x + w - 5; bx += 4) if (bx >= x) rect(ctx, color, bx, y + 1, 2, h - 2);
  const ax = x + w - 5;
  for (let k = 0; k < 3; k++) rect(ctx, color, ax + k, y + k * 0.5, 1, h - k);
}

// ---------------------------------------------------------------- scenes

type Overlay = (ctx: CanvasRenderingContext2D, t: number) => void;

/**
 * What moves in each drawing, at the drawing's own coordinates on the
 * 136 x 100 frame (see hd-companion-scenes.json for where each drawing
 * sits: the art band, the eye).
 */
const OVERLAYS: Record<SceneId, Overlay> = {
  coding: (ctx, t) => {
    typing(ctx, t, 37, 38, 32, 4, '#0d1a2e', ['#7de3ff', '#ff6fae', '#79d98a', '#f2f0e9']);
  },
  mad: (ctx, t) => {
    rain(ctx, t, 82, 17, 24, 27, 11);
    rain(ctx, t, 110, 17, 20, 27, 53);
    rise(ctx, t, 83, 63, '#e8e2d6', 9);
  },
  connect: (ctx, t) => {
    led(ctx, t, 130, 60, '#ff8a1e', 700, 350);
    twinkle(ctx, t, 77, 56, '#fff6b0', 0);
  },
  scan: (ctx, t) => {
    spectrum(ctx, t, 35, 40, 28, 13, '#0b2a2c', '#3ee6c8');
    led(ctx, t, 21, 21, '#ff5f56', 900, 300);
  },
  analyze: (ctx, t) => {
    glint(ctx, t, 64, 49, 4);
    led(ctx, t, 72, 66, '#ff5f56', 1100, 400);
  },
  transfer: (ctx, t) => {
    travel(ctx, t, 51, 37, 34, 5, '#0d1424', '#3ee6e6');
  },
  success: (ctx, t) => {
    twinkle(ctx, t, 12, 46, '#fff27a', 0);
    twinkle(ctx, t, 19, 54, '#fff27a', 400);
    twinkle(ctx, t, 88, 52, '#fff27a', 800);
    twinkle(ctx, t, 86, 60, '#fff27a', 200);
    for (let i = 0; i < 10; i++) {
      const p = ((t + i * 470) % 2400) / 2400;
      const cx = 8 + rnd(i) * 90 + Math.sin(p * 8 + i) * 2;
      rect(ctx, ['#ff6fae', '#7de3ff', '#fff27a', '#79d98a'][i % 4]!, cx, 14 + p * 40, 1, 1);
    }
  },
  disconnected: (ctx, t) => {
    hop(ctx, 'disconnected', 74, 17, 8, 12, pulse(t, 900, 450) ? -1 : 0, '#26285a');
    twinkle(ctx, t, 44, 47, '#fff6b0', 0);
    twinkle(ctx, t, 84, 45, '#fff6b0', 600);
  },
  idle: (ctx, t) => {
    zzz(ctx, t, 88, 28, '#ff6fae');
  },
  boot: (ctx, t) => {
    const p = (t % 4200) / 3600;
    rect(ctx, '#0d1a2e', 96, 52, 23, 3);
    rect(ctx, '#3ee6e6', 96, 52, Math.round(Math.min(1, p) * 23), 3);
  },
  bluetooth: (ctx, t) => {
    waves(ctx, t, 78, 52, '#3ee6e6', 1);
  },
  rfid: (ctx, t) => {
    led(ctx, t, 97, 75, '#79ff8a', 800, 400);
    waves(ctx, t, 103, 64, '#3ee6e6', -1, 2);
  },
  infrared: (ctx, t) => {
    if (pulse(t, 1000, 450)) {
      alpha(ctx, 0.5, '#ff5f56', 86, 42, 4, 4);
      for (let x = 90; x < 96; x += 2) rect(ctx, '#ff5f56', x, 44 - (x - 90) * 0.4, 1, 1);
    }
    const band = 28 + ((t / 30) % 26);
    alpha(ctx, 0.18, '#000000', 93, band, 31, 2);
  },
  uart: (ctx, t) => {
    led(ctx, t, 112, 51, '#3ee6e6', 600, 300);
    led(ctx, t, 92, 62, '#ff5f56', 300, 120);
    led(ctx, t, 95, 62, '#79d98a', 300, 120, 150);
  },
  backup: (ctx, t) => {
    hop(ctx, 'backup', 63, 33, 18, 16, pulse(t, 1600, 800) ? 1 : 0, '#26285a');
    led(ctx, t, 122, 56, '#ff5f56', 400, 200);
  },
  repair: (ctx, t) => {
    rise(ctx, t, 82, 58, '#d8d4e8', 16, 4, 2000);
    if (pulse(t, 260, 90)) rect(ctx, '#fff6b0', 80, 61, 1, 1);
  },
  report: (ctx, t) => {
    led(ctx, t, 123, 60, '#79ff8a', 900, 450);
  },
  shutdown: (ctx, t) => {
    for (const [i, [x, y]] of ([
      [4, 18],
      [12, 24],
      [21, 17],
      [7, 33],
      [18, 30],
    ] as const).entries())
      if (pulse(t, 1300 + i * 170, 700, i * 300)) rect(ctx, '#fff8c8', x, y, 1, 1);
  },
};

/**
 * The drawn scene for an animation. What it is about picks among the
 * scenes: an IR capture is read at the old TV, an NFC one at the card
 * reader, a BLE scan with the little board, a GPIO session at the UART
 * terminal; a copy to the library is filed in the floppy box; a report
 * done is a printout. An error is the cross face first, then it tries a
 * fix with the iron.
 */
export function sceneFor(scene: SceneName, t: number, subject: Subject | null = null): { id: SceneId; t: number } | null {
  const tool = subject?.tool ?? '';
  const topic = subject?.topic ?? '';
  switch (scene) {
    case 'none':
      return null;
    case 'shutdown':
      return { id: 'shutdown', t };
    case 'idle':
      return { id: 'coding', t };
    case 'wait':
      return { id: 'idle', t };
    case 'greet':
      return { id: 'boot', t };
    case 'search':
      return { id: tool.startsWith('ble.') ? 'bluetooth' : 'scan', t };
    case 'connect':
      return { id: 'connect', t };
    case 'read':
      // Camera Sniffer: an object examined with the lamp and the magnifier; a sheet compared is read like a printout
      if (tool === 'camera.compare') return { id: 'report', t };
      if (tool.startsWith('camera.')) return { id: 'analyze', t };
      if (topic === 'ir') return { id: 'infrared', t };
      if (topic === 'nfc' || topic === 'rfid' || topic === 'ibutton') return { id: 'rfid', t };
      if (topic === 'subghz') return { id: 'scan', t };
      if (tool === 'flipper.gpio') return { id: 'uart', t };
      return { id: 'analyze', t };
    case 'transfer':
      return { id: tool === 'flipper.copy' ? 'backup' : 'transfer', t };
    case 'success':
      return { id: tool === 'lab.report' || tool === 'camera.report' || tool === 'camera.inspect' ? 'report' : 'success', t };
    case 'warning':
      return { id: 'analyze', t };
    case 'error':
      return t < 3500 ? { id: 'mad', t } : { id: 'repair', t: t - 3500 };
    case 'disconnect':
      return { id: 'disconnected', t };
    // waiting for the person (the port chooser): the cable in hand, nothing pretended
    case 'permission':
      return { id: 'connect', t };
    // cancelled: back to its desk
    case 'cancel':
      return { id: 'coding', t };
    // not offered here: it rests, no activity
    case 'unavailable':
      return { id: 'idle', t };
  }
}

/** One scene, by its name on the sheets, at time t. */
export function drawSceneId(ctx: CanvasRenderingContext2D, id: SceneId, t: number): void {
  if (!base(ctx, id, t)) {
    // the frames are still loading: a quiet screen, never a broken one
    rect(ctx, '#0b1418', 0, 0, SCREEN_W, SCREEN_H);
    if (pulse(t, 600, 300)) rect(ctx, PALETTE.body, SCREEN_W / 2 - 1, SCREEN_H / 2 - 1, 2, 2);
    return;
  }
  OVERLAYS[id](ctx, t);
}

export function drawCompanionScene(ctx: CanvasRenderingContext2D, scene: SceneName, t: number, subject: Subject | null = null): void {
  const s = sceneFor(scene, t, subject);
  if (!s) return rect(ctx, '#000', 0, 0, SCREEN_W, SCREEN_H);
  drawSceneId(ctx, s.id, s.t);
}

export function drawCompanionSplash(ctx: CanvasRenderingContext2D, t: number): void {
  frames();
  rect(ctx, '#0b1418', 0, 0, SCREEN_W, SCREEN_H);
  // two lines, big letters coming up one by one, inside the curve of the glass
  const lines = ['FLIPPER', 'LAB'];
  let shown = Math.floor(t / 55) + 1;
  lines.forEach((line, i) => {
    const part = line.slice(0, Math.max(0, Math.min(line.length, shown)));
    shown -= line.length;
    pixelText(ctx, part, Math.round((SCREEN_W - pixelTextWidth(line, 2)) / 2), 18 + i * 20, PALETTE.body, PALETTE.outline, 2);
  });
  const w = pixelTextWidth('FLIPPER', 2);
  rect(ctx, PALETTE.cyan, (SCREEN_W - w) / 2, 56, w * Math.min(1, t / 500), 1);
  pixelText(ctx, 'HW DOG', Math.round((SCREEN_W - pixelTextWidth('HW DOG')) / 2), 64, PALETTE.cream);
}

/** The companion of Flipper Lab: the owner's drawings, alive. */
export const COMPANION: SpriteSet = { id: 'flipper-lab-companion', drawScene: drawCompanionScene, drawSplash: drawCompanionSplash, preload: preloadCompanion };
/** Older name, kept for imports. */
export const DOLPHIN = COMPANION;
