/**
 * HARDWARE DOG / TV SPRITES — THE COMPANION AND ITS LITTLE LIFE
 *
 * What plays inside the TV screen: a small cartoon dolphin, upright, with
 * a big readable head, living in little scenes. Its gestures tell what the
 * tool is doing: it works at a computer while the tool analyses, handles a
 * cable while it connects, examines with a magnifier while it reads,
 * carries a floppy while it transfers, celebrates a success, scratches its
 * head at a warning, takes a wrench to an error, dozes while it waits.
 *
 * Drawn on a 136 x 100 canvas, one canvas pixel per art pixel, scaled up
 * without smoothing. The character is built from simple shapes plus an
 * outline pass, so every pose (arms, eyes, mouth, sitting, walking) stays
 * in one style; props and rooms are drawn the same way, in full color.
 *
 * A SpriteSet is replaceable: a Hardware Dog TV with the dog would supply
 * its own drawScene and drawSplash, and nothing in the engine changes.
 * Every frame is a pure function of (animation, time): remounting the TV
 * (another section, a detached window) resumes, it never restarts.
 */

import type { Anim } from '../../core/lab/companion';

export const SCREEN_W = 136;
export const SCREEN_H = 100;

export const PALETTE = {
  outline: '#2a1a12',
  body: '#ff8a1e',
  shade: '#d9650e',
  light: '#ffb766',
  belly: '#ffe6c4',
  white: '#fffaf0',
  pupil: '#1c1024',
  pink: '#ff6fae',
  tongue: '#ff4f7a',
  tear: '#5fcbff',
  cyan: '#00e5ff',
  cream: '#f2f0e9',
  green: '#79d98a',
  amber: '#e4b04a',
  red: '#ff5f56',
} as const;

/** Room colors: full color, warm, never a monochrome screen. */
const C = {
  wallTeal: '#2c6e8a',
  wallTealDark: '#255c74',
  wallPurple: '#5d4a91',
  wallPurpleDark: '#4f3e7d',
  wallWarm: '#b0524a',
  wallWarmDark: '#9a4640',
  wallNight: '#1f2a4d',
  wallNightDark: '#1a2342',
  wallGray: '#4a5664',
  wallGrayDark: '#404b57',
  base: '#e9dcc0',
  floor: '#9a6239',
  floorDark: '#7e4e2c',
  floorLight: '#b0754a',
  sky: '#8fd8ff',
  skyLow: '#c8f0ff',
  dusk: '#5a4b8f',
  duskLow: '#b06a8a',
  frame: '#efe6d2',
  frameDark: '#c7b99a',
  cloud: '#ffffff',
  sun: '#ffd447',
  moon: '#fff3b0',
  leaf: '#4caf50',
  leafDark: '#2e7d32',
  leafLight: '#8bd36b',
  pot: '#c8643a',
  potDark: '#9e4b2a',
  wood: '#a7703f',
  woodDark: '#7d522c',
  beige: '#ddd5c0',
  beigeDark: '#b3aa92',
  screen: '#0d2b20',
  screenText: '#6cff8a',
  screenText2: '#36c15a',
  metal: '#b9c0c7',
  metalDark: '#7d858c',
  gold: '#f2c14e',
  goldDark: '#b88a23',
  glass: '#bff3ff',
  device: '#f4f1ea',
  deviceDark: '#c9c3b6',
  deviceScreen: '#ff9a3c',
  chair: '#d84a4a',
  chairDark: '#a83434',
  cushion: '#4fb3a9',
  cushionDark: '#38877f',
  mug: '#ffffff',
  coffee: '#6b3f22',
  smoke: '#c9ced6',
  book1: '#e85d75',
  book2: '#57b5e7',
  book3: '#f2c14e',
  book4: '#79d98a',
  floppy1: '#4a7bd8',
  floppy2: '#e85d75',
  floppy3: '#79d98a',
  label: '#f2f0e9',
  cream: '#f2f0e9',
} as const;

export interface SpriteSet {
  id: string;
  drawScene(ctx: CanvasRenderingContext2D, anim: Anim, t: number): void;
  drawSplash(ctx: CanvasRenderingContext2D, t: number): void;
}

// ------------------------------------------------------------ pixel layer

type Col = string | null;
type Pt = [number, number];

/** An indexed pixel buffer: shapes, an outline pass, then onto the canvas. */
export class Layer {
  readonly px: Col[];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Array<Col>(w * h).fill(null);
  }
  get(x: number, y: number): Col {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y * this.w + x]! : null;
  }
  set(x: number, y: number, c: Col): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }
  rect(x: number, y: number, w: number, h: number, c: Col): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  /** Filled ellipse; `over`: only where these colors already are (clipping). */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Col, over?: Col[]): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        if (over && !over.includes(this.get(x, y))) continue;
        this.set(x, y, c);
      }
  }
  /** A thick rounded segment: arms, tails, cables. */
  capsule(a: Pt, b: Pt, r: number, c: Col, over?: Col[]): void {
    const [x0, y0] = a;
    const [x1, y1] = b;
    const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
    for (let y = Math.floor(Math.min(y0, y1) - r); y <= Math.ceil(Math.max(y0, y1) + r); y++)
      for (let x = Math.floor(Math.min(x0, x1) - r); x <= Math.ceil(Math.max(x0, x1) + r); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / len2));
        const d = Math.hypot(px - (x0 + t * (x1 - x0)), py - (y0 + t * (y1 - y0)));
        if (d > r) continue;
        if (over && !over.includes(this.get(x, y))) continue;
        this.set(x, y, c);
      }
  }
  tri(a: Pt, b: Pt, d: Pt, c: Col): void {
    const s = (p: Pt, q: Pt, r: Pt) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
    for (let y = Math.floor(Math.min(a[1], b[1], d[1])); y <= Math.ceil(Math.max(a[1], b[1], d[1])); y++)
      for (let x = Math.floor(Math.min(a[0], b[0], d[0])); x <= Math.ceil(Math.max(a[0], b[0], d[0])); x++) {
        const p: Pt = [x + 0.5, y + 0.5];
        const d1 = s(p, a, b);
        const d2 = s(p, b, d);
        const d3 = s(p, d, a);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) this.set(x, y, c);
      }
  }
  line(a: Pt, b: Pt, c: Col): void {
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
    for (let i = 0; i <= n; i++) this.set(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, c);
  }
  /** Outline every shape: each empty pixel touching a filled one. */
  outline(c: string): this {
    const filled = this.px.map((p) => p !== null);
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (filled[y * this.w + x]) continue;
        const near =
          (x > 0 && filled[y * this.w + x - 1]) || (x < this.w - 1 && filled[y * this.w + x + 1]) || (y > 0 && filled[(y - 1) * this.w + x]) || (y < this.h - 1 && filled[(y + 1) * this.w + x]);
        if (near) this.px[y * this.w + x] = c;
      }
    return this;
  }
  over(src: Layer): this {
    for (let i = 0; i < this.px.length; i++) if (src.px[i] !== null) this.px[i] = src.px[i]!;
    return this;
  }
  /** Onto the canvas at (x, y), mirrored when the character faces left. Runs of a color in one fillRect. */
  blit(ctx: CanvasRenderingContext2D, x: number, y: number, flip = false): void {
    x = Math.round(x);
    y = Math.round(y);
    for (let j = 0; j < this.h; j++) {
      let run: Col = null;
      let start = 0;
      for (let i = 0; i <= this.w; i++) {
        const c = i < this.w ? this.px[j * this.w + (flip ? this.w - 1 - i : i)]! : null;
        if (c === run) continue;
        if (run) {
          ctx.fillStyle = run;
          ctx.fillRect(x + start, y + j, i - start, 1);
        }
        run = c;
        start = i;
      }
    }
  }
}

// ---------------------------------------------------------- the character

export type Eye = 'open' | 'blink' | 'happy' | 'sad' | 'angry' | 'sleep' | 'focus' | 'wide';
export type Mouth = 'closed' | 'smile' | 'open' | 'frown' | 'tongue';

export interface Pose {
  eye: Eye;
  /** Where the pupil looks, -1..1 each way. */
  look?: Pt;
  mouth?: Mouth;
  /** Hand positions in character coordinates; null: resting at the side. */
  front?: Pt | null;
  back?: Pt | null;
  /** Elbows, for arms that bend (raised beside the head, never across the face). */
  frontElbow?: Pt;
  backElbow?: Pt;
  sit?: boolean;
  /** Walking: which foot is up (0: both down). */
  step?: 0 | 1 | 2;
  blush?: boolean;
  tear?: boolean;
  sweat?: boolean;
}

/** The character's box, and its landmarks (facing right). */
export const CW = 52;
export const CH = 56;
const SHOULDER_BACK: Pt = [16, 31];
const SHOULDER_FRONT: Pt = [27, 31];
const REST_BACK: Pt = [13, 40];
const REST_FRONT: Pt = [29, 40];
/** Bottom of the feet, in character coordinates: put it on the floor. */
export const FEET_Y = 51;

const cache = new Map<string, Layer>();

export function character(p: Pose): Layer {
  const key = JSON.stringify(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const P = PALETTE;
  const L = new Layer(CW, CH);
  const back = p.back ?? REST_BACK;
  const front = p.front ?? REST_FRONT;

  const arm = (l: Layer, shoulder: Pt, elbow: Pt | undefined, hand: Pt, r: number, c: string) => {
    if (elbow) {
      l.capsule(shoulder, elbow, r, c);
      l.capsule(elbow, hand, r, c);
    } else l.capsule(shoulder, hand, r, c);
    l.ellipse(hand[0], hand[1], r + 0.3, r + 0.1, c);
  };
  // back arm, behind everything
  arm(L, SHOULDER_BACK, p.backElbow, back, 2.3, P.shade);
  // a straight front arm raised above the shoulder goes up behind the head, never across the face
  const raised = !p.frontElbow && front[1] < 24;
  if (raised) arm(L, SHOULDER_FRONT, undefined, front, 2.4, P.body);
  // tail and feet
  if (p.sit) {
    L.capsule([14, 47], [31, 49.5], 2.2, P.body);
    L.tri([30, 49], [38, 43], [36, 49], P.body);
    L.tri([30, 50], [38, 54], [36, 49], P.body);
  } else {
    L.capsule([14, 45], [9, 47.5], 2.1, P.body);
    // small horizontal flukes, a V
    L.tri([10, 47], [3, 42], [6, 48], P.body);
    L.tri([10, 48], [3, 53], [6, 47], P.body);
    const up1 = p.step === 1 ? 2 : 0;
    const up2 = p.step === 2 ? 2 : 0;
    L.ellipse(16, 49.5 - up1, 3.4, 1.9, P.shade);
    L.ellipse(26, 49.5 - up2, 3.4, 1.9, P.shade);
  }
  // body and belly
  if (p.sit) L.ellipse(21, 40, 11, 9.5, P.body);
  else L.ellipse(21, 38, 10, 10, P.body);
  L.ellipse(25, p.sit ? 41 : 40, 6, 7, P.belly, [P.body]);
  // head: a big round melon
  L.ellipse(22, 16.5, 15, 13, P.body);
  L.ellipse(18, 8.5, 7, 3, P.light, [P.body]);
  // a short, rounded bottle-nose beak; the chin and throat pale
  L.capsule([33, 21], [40, 22.5], 4.6, P.body);
  L.ellipse(30, 26, 11, 4.5, P.belly, [P.body]);
  L.ellipse(39, 25.5, 4, 1.7, P.belly, [P.body]);
  L.ellipse(38, 18.6, 2.6, 1, P.light, [P.body]);
  L.outline(P.outline);
  // the crease where the beak meets the melon
  L.set(34, 16, P.shade);
  L.set(33, 17, P.shade);

  // front arm, outlined on its own so it reads over the body
  if (!raised) {
    const F = new Layer(CW, CH);
    arm(F, SHOULDER_FRONT, p.frontElbow, front, 2.4, P.body);
    F.ellipse(front[0] - 0.5, front[1] - 0.8, 1.2, 0.8, P.light, [P.body]);
    F.outline(P.outline);
    L.over(F);
  }

  // eye: a big one, the face of the character
  const [lx, ly] = p.look ?? [0, 0];
  const ex = 29;
  const ey = 12;
  const eyeRing = (rx: number, ry: number) => {
    L.ellipse(ex, ey, rx + 1, ry + 1, P.outline);
    L.ellipse(ex, ey, rx, ry, P.white);
  };
  switch (p.eye) {
    case 'blink':
    case 'sleep':
      L.line([ex - 3, ey + 1], [ex + 3, ey + 1], P.outline);
      L.set(ex - 3, ey, P.outline);
      L.set(ex + 3, ey, P.outline);
      if (p.eye === 'sleep') L.line([ex - 2, ey + 2], [ex + 2, ey + 2], P.shade);
      break;
    case 'happy':
      L.line([ex - 3, ey + 2], [ex - 1, ey], P.outline);
      L.line([ex - 1, ey], [ex + 1, ey], P.outline);
      L.line([ex + 1, ey], [ex + 3, ey + 2], P.outline);
      break;
    case 'wide':
      eyeRing(3.8, 4.4);
      L.rect(ex + Math.round(lx), ey + Math.round(ly), 2, 2, P.pupil);
      break;
    default: {
      eyeRing(3.1, 3.8);
      const px = ex - 1 + Math.round(lx * 1.4);
      const py = ey - 1 + Math.round(ly * 1.4);
      L.rect(px, py, 3, 3 + (p.eye === 'sad' ? 0 : 1), P.pupil);
      L.set(px, py, P.white);
      if (p.eye === 'sad') L.line([ex - 3, ey - 6], [ex + 3, ey - 8], P.outline);
      if (p.eye === 'angry') L.line([ex - 3, ey - 8], [ex + 3, ey - 5], P.outline);
    }
  }
  // mouth along the beak: a long smile line, the dolphin's own
  const m = p.mouth ?? 'closed';
  if (m === 'open') {
    L.line([34, 23], [36, 24], P.outline);
    L.line([36, 24], [43, 23], P.outline);
    L.rect(36, 25, 7, 2, P.outline);
    L.rect(37, 25, 4, 1, P.tongue);
  } else {
    L.line([35, 24], [37, 24], P.outline);
    L.line([37, 24], [43, 23.5], P.outline);
    if (m === 'smile') {
      L.set(34, 23, P.outline);
      L.set(33, 22, P.outline);
    }
    if (m === 'frown') L.set(34, 25, P.outline);
    if (m === 'tongue') {
      L.set(41, 25, P.tongue);
      L.set(42, 25, P.tongue);
      L.set(41, 26, P.tongue);
    }
  }
  if (p.blush) {
    L.set(25, 19, P.pink);
    L.set(26, 19, P.pink);
    L.set(27, 19, P.pink);
  }
  if (p.tear) {
    L.set(30, 17, P.tear);
    L.set(30, 18, P.tear);
    L.set(29, 19, P.tear);
  }
  if (p.sweat) {
    L.set(12, 6, P.tear);
    L.set(11, 7, P.tear);
    L.set(12, 7, P.tear);
    L.set(12, 8, P.tear);
  }
  cache.set(key, L);
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  return L;
}

/** A hand of the character, in screen coordinates, wherever it stands and faces. */
function at(origin: Pt, local: Pt, flip = false): Pt {
  return [origin[0] + (flip ? CW - 1 - local[0] : local[0]), origin[1] + local[1]];
}

// ----------------------------------------------------------- canvas bits

function rect(ctx: CanvasRenderingContext2D, c: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** Small things drawn as their own outlined layer. */
function thing(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, draw: (l: Layer) => void, flip = false): void {
  const l = new Layer(w, h);
  draw(l);
  l.outline(PALETTE.outline);
  l.blit(ctx, x, y, flip);
}

const tick = (t: number, ms: number) => Math.floor(t / ms);
const blinking = (t: number, every = 3300) => t % every < 140;
/** A repeatable pseudo-random number from an integer. */
const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// ------------------------------------------------------------------ font

/** 5 x 7 pixel letters, for the splash and little signs. */
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
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
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

/** A speech bubble with a few letters or a sign in it. */
function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  const w = pixelTextWidth(text) + 6;
  thing(ctx, x, y, w + 2, 15, (l) => {
    l.rect(1, 1, w, 10, C.cloud);
    l.tri([4, 10], [9, 10], [3, 14], C.cloud);
  });
  pixelText(ctx, text, x + 4, y + 3, color);
}

// ----------------------------------------------------------------- rooms

const FLOOR_Y = 76;

function room(ctx: CanvasRenderingContext2D, wall: string, wallDark: string): void {
  rect(ctx, wall, 0, 0, SCREEN_W, FLOOR_Y);
  for (let x = 4; x < SCREEN_W; x += 10) rect(ctx, wallDark, x, 0, 2, FLOOR_Y);
  rect(ctx, C.base, 0, FLOOR_Y - 3, SCREEN_W, 3);
  rect(ctx, C.floor, 0, FLOOR_Y, SCREEN_W, SCREEN_H - FLOOR_Y);
  for (let y = FLOOR_Y + 5, row = 0; y < SCREEN_H; y += 6, row++) {
    rect(ctx, C.floorDark, 0, y, SCREEN_W, 1);
    for (let x = (row % 2) * 11; x < SCREEN_W; x += 22) rect(ctx, C.floorDark, x, y - 5, 1, 5);
  }
  rect(ctx, C.floorLight, 0, FLOOR_Y, SCREEN_W, 1);
}

function window_(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, night = false): void {
  const w = 34;
  const h = 28;
  rect(ctx, C.frameDark, x - 1, y - 1, w + 2, h + 3);
  rect(ctx, C.frame, x, y, w, h);
  for (let j = 0; j < h - 4; j++) rect(ctx, j < (h - 4) / 2 ? (night ? C.dusk : C.sky) : night ? C.duskLow : C.skyLow, x + 2, y + 2 + j, w - 4, 1);
  if (night) {
    rect(ctx, C.moon, x + 22, y + 5, 4, 4);
    rect(ctx, C.dusk, x + 21, y + 4, 2, 2);
    for (let i = 0; i < 5; i++) rect(ctx, C.cloud, x + 4 + Math.round(rnd(i) * 26), y + 4 + Math.round(rnd(i + 9) * 8), 1, 1);
  } else {
    rect(ctx, C.sun, x + 24, y + 5, 5, 5);
    const cx = x + 2 + ((t / 260) % (w + 10)) - 10;
    for (const [dx, dy, ww] of [
      [0, 10, 9],
      [2, 8, 5],
      [12, 15, 7],
    ] as const)
      for (let i = 0; i < ww; i++) {
        const px = cx + dx + i;
        if (px > x + 1 && px < x + w - 2) rect(ctx, C.cloud, px, y + dy, 1, 2);
      }
  }
  rect(ctx, C.frame, x + w / 2 - 1, y, 2, h - 2);
  rect(ctx, C.frame, x, y + h / 2 - 2, w, 2);
  rect(ctx, C.frameDark, x - 2, y + h - 2, w + 4, 3);
}

function plant(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const sway = Math.round(Math.sin(t / 900));
  thing(ctx, x - 9, y - 22, 26, 32, (l) => {
    for (const [dx, dy, r] of [
      [0, 10, 0],
      [-5, 6, 1],
      [5, 5, 2],
      [-2, 1, 3],
      [3, 0, 4],
    ] as const) {
      l.ellipse(13 + dx + (r % 2 ? sway : 0), 8 + dy, 3, 6, r % 2 ? C.leafDark : C.leaf);
      l.line([13 + dx, 12 + dy], [13, 21], C.leafDark);
    }
    l.ellipse(15, 4, 1.5, 3, C.leafLight);
    l.rect(7, 21, 13, 9, C.pot);
    l.rect(6, 20, 15, 3, C.potDark);
  });
}

const HEART: Pt[] = [
  [6, 7],
  [7, 7],
  [10, 7],
  [11, 7],
  [5, 8],
  [6, 8],
  [7, 8],
  [8, 8],
  [9, 8],
  [10, 8],
  [11, 8],
  [12, 8],
  [6, 9],
  [7, 9],
  [8, 9],
  [9, 9],
  [10, 9],
  [11, 9],
  [7, 10],
  [8, 10],
  [9, 10],
  [10, 10],
  [8, 11],
  [9, 11],
];

function poster(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  rect(ctx, C.cream, x, y, 20, 24);
  rect(ctx, C.wallTealDark, x + 2, y + 2, 16, 20);
  for (const [dx, dy] of HEART) rect(ctx, PALETTE.pink, x + dx, y + dy);
  rect(ctx, PALETTE.cyan, x + 4, y + 15, 12, 1);
  rect(ctx, PALETTE.cyan, x + 4, y + 18, 8, 1);
}

function shelf(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  rect(ctx, C.woodDark, x, y + 12, 30, 3);
  const books = [C.book1, C.book2, C.book3, C.book4, C.book2, C.book1];
  books.forEach((b, i) => rect(ctx, b, x + 2 + i * 4, y + (i % 3), 3, 12 - (i % 3)));
}

function desk(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  rect(ctx, C.wood, x, y, w, 4);
  rect(ctx, C.woodDark, x, y + 4, w, 1);
  rect(ctx, C.woodDark, x + 3, y + 5, 3, FLOOR_Y + 8 - y);
  rect(ctx, C.woodDark, x + w - 6, y + 5, 3, FLOOR_Y + 8 - y);
}

/** A beige retro computer; its screen shows what the tool is doing. */
function computer(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, mode: 'code' | 'error' | 'ok' = 'code'): void {
  thing(ctx, x, y, 40, 36, (l) => {
    l.rect(2, 1, 34, 25, C.beige);
    l.rect(2, 22, 34, 4, C.beigeDark);
    l.rect(13, 26, 12, 3, C.beigeDark);
    l.rect(0, 29, 38, 6, C.beige);
    l.rect(0, 33, 38, 2, C.beigeDark);
  });
  rect(ctx, C.screen, x + 6, y + 5, 28, 17);
  if (mode === 'code') {
    const scroll = tick(t, 180);
    for (let i = 0; i < 5; i++) {
      const n = scroll + i;
      rect(ctx, i === 4 && tick(t, 300) % 2 ? C.screen : C.screenText, x + 8, y + 7 + i * 3, 3 + Math.round(rnd(n) * 18), 1);
      rect(ctx, C.screenText2, x + 8 + 4 + Math.round(rnd(n + 50) * 6), y + 7 + i * 3, 2, 1);
    }
  } else if (mode === 'error') {
    if (tick(t, 400) % 2 === 0) {
      for (let i = 0; i < 7; i++) {
        rect(ctx, PALETTE.red, x + 16 + i, y + 9 + i, 2, 1);
        rect(ctx, PALETTE.red, x + 22 - i, y + 9 + i, 2, 1);
      }
    }
  } else {
    for (const [dx, dy] of [
      [12, 13],
      [13, 14],
      [14, 15],
      [15, 14],
      [16, 13],
      [17, 12],
      [18, 11],
      [19, 10],
    ] as const)
      rect(ctx, C.screenText, x + dx, y + dy, 2, 2);
  }
  for (let i = 0; i < 8; i++) rect(ctx, C.beigeDark, x + 3 + i * 4, y + 30, 3, 2);
  rect(ctx, PALETTE.green, x + 32, y + 24, 2, 1);
}

/** The Flipper itself: a small white device with an orange screen. */
function device(ctx: CanvasRenderingContext2D, x: number, y: number, screenOn: boolean, t: number, smoke = false): void {
  thing(ctx, x, y, 30, 18, (l) => {
    l.rect(1, 1, 27, 15, C.device);
    l.rect(1, 13, 27, 3, C.deviceDark);
    l.ellipse(23, 8, 3.5, 3.5, C.deviceDark);
    l.ellipse(23, 8, 1.5, 1.5, PALETTE.body);
  });
  rect(ctx, screenOn ? C.deviceScreen : '#3a2a20', x + 4, y + 4, 13, 8);
  if (screenOn) rect(ctx, '#ffd9a8', x + 6, y + 6, 4 + (tick(t, 300) % 5), 2);
  rect(ctx, '#2a1a12', x, y + 7, 2, 3); // the USB port
  if (smoke)
    for (let i = 0; i < 4; i++) {
      const p = (((t / 900 + i / 4) % 1) + 1) % 1;
      const r = 1 + Math.round(p * 2);
      rect(ctx, C.smoke, x + 12 + Math.round(Math.sin(p * 6 + i) * 3), y - 2 - p * 22, r, r);
    }
}

function floppy(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  thing(ctx, x, y, 11, 11, (l) => {
    l.rect(1, 1, 9, 9, color);
    l.rect(3, 1, 5, 3, C.metal);
    l.rect(3, 6, 5, 4, C.label);
  });
}

function cable(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, t: number, sag = 8): void {
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = from[0] + (to[0] - from[0]) * u;
    const y = from[1] + (to[1] - from[1]) * u + Math.sin(u * Math.PI) * sag + Math.sin(u * 9 + t / 260) * 0.6;
    rect(ctx, '#2a1a12', x, y, 2, 2);
    rect(ctx, '#3a8fa8', x, y, 1, 1);
  }
}

function plug(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 12, 7, (l) => {
    l.rect(1, 1, 6, 5, PALETTE.cyan);
    l.rect(7, 2, 4, 3, C.metal);
  });
}

function confetti(ctx: CanvasRenderingContext2D, t: number): void {
  const colors = [PALETTE.pink, PALETTE.cyan, C.sun, PALETTE.green, '#b48cff', '#ff8a1e'];
  for (let i = 0; i < 26; i++) {
    const speed = 20 + rnd(i) * 30;
    const y = (((t / 1000) * speed + rnd(i + 3) * 100) % 110) - 6;
    const x = rnd(i + 7) * SCREEN_W + Math.sin(t / 300 + i) * 3;
    rect(ctx, colors[i % colors.length]!, x, y, i % 3 ? 2 : 1, i % 3 ? 1 : 2);
  }
}

function zzz(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  for (let i = 0; i < 3; i++) {
    const p = (((t / 2400 + i / 3) % 1) + 1) % 1;
    pixelText(ctx, 'Z', x + p * 10 + i, y - p * 18, p < 0.85 ? C.cloud : C.base);
  }
}

// ---------------------------------------------------------------- scenes

/** The character on the floor at x, facing right (or left), with a pose. */
function stand(ctx: CanvasRenderingContext2D, x: number, pose: Pose, flip = false, lift = 0): Pt {
  const origin: Pt = [Math.round(x), FLOOR_Y + 4 - FEET_Y - Math.round(lift)];
  character(pose).blit(ctx, origin[0], origin[1], flip);
  return origin;
}

function sceneIdle(ctx: CanvasRenderingContext2D, t: number): void {
  // Looks around, blinks, taps a foot, waters its plant.
  room(ctx, C.wallTeal, C.wallTealDark);
  window_(ctx, 92, 10, t);
  poster(ctx, 8, 12);
  plant(ctx, 14, 70, t);
  const p = t % 9000;
  const blink = blinking(t);
  if (p < 2200) stand(ctx, 46, { eye: blink ? 'blink' : 'open', look: [1, -0.6], mouth: 'smile' });
  else if (p < 4000) stand(ctx, 46, { eye: blink ? 'blink' : 'open', look: [1, 0], mouth: 'closed' }, true);
  else if (p < 6000) {
    const tap = tick(p, 250) % 2 === 0;
    stand(ctx, 46, { eye: blink ? 'blink' : 'open', look: [0.6, 0.3], mouth: 'smile', step: tap ? 2 : 0, front: tap ? [31, 38] : null });
  } else {
    // watering the plant on the left
    const o = stand(ctx, 34, { eye: 'happy', mouth: 'smile', front: [42, 30], back: [36, 33] }, true);
    const can = at(o, [44, 26], true);
    thing(ctx, can[0] - 10, can[1] - 4, 13, 10, (l) => {
      l.rect(4, 2, 7, 6, PALETTE.cyan);
      l.line([4, 3], [0, 0], PALETTE.cyan);
      l.rect(6, 0, 3, 2, '#3a8fa8');
    });
    for (let i = 0; i < 3; i++) {
      const d = (((t / 400 + i / 3) % 1) + 1) % 1;
      rect(ctx, PALETTE.tear, can[0] - 12 - d * 2, can[1] - 3 + d * 14, 1, 2);
    }
  }
}

function sceneWait(ctx: CanvasRenderingContext2D, t: number): void {
  // Nothing connected: it sits on its cushion by the window and dozes.
  room(ctx, C.wallNight, C.wallNightDark);
  window_(ctx, 92, 10, t, true);
  shelf(ctx, 10, 14);
  rect(ctx, C.woodDark, 22, 48, 2, 28);
  thing(ctx, 15, 40, 16, 10, (l) => l.tri([1, 9], [14, 9], [8, 1], C.sun));
  ctx.globalAlpha = 0.12;
  rect(ctx, C.sun, 6, 50, 36, 26);
  ctx.globalAlpha = 1;
  thing(ctx, 36, 68, 44, 12, (l) => l.ellipse(22, 7, 21, 5, C.cushion));
  rect(ctx, C.cushionDark, 40, 76, 36, 2);
  const awake = t % 11_000 > 9800;
  const breath = tick(t, 1600) % 2;
  character({ eye: awake ? (blinking(t, 600) ? 'blink' : 'open') : 'sleep', look: [-0.6, 0], mouth: awake ? 'closed' : 'smile', sit: true, front: [30, 44], back: [14, 44] }).blit(ctx, 36, 25 + breath);
  if (!awake) zzz(ctx, 76, 34, t);
}

function sceneGreet(ctx: CanvasRenderingContext2D, t: number): void {
  // A little hop, then hello with its flipper.
  room(ctx, C.wallTeal, C.wallTealDark);
  window_(ctx, 92, 10, t);
  poster(ctx, 8, 12);
  const hop = t < 600 ? Math.sin((t / 600) * Math.PI) * 8 : 0;
  const wave = tick(t, 200) % 2;
  stand(ctx, 44, { eye: 'happy', mouth: 'open', blush: true, back: wave ? [2, 10] : [4, 7], backElbow: [7, 24] }, false, hop);
  bubble(ctx, 86, 42, 'HI!', PALETTE.pink);
}

function sceneAnalyse(ctx: CanvasRenderingContext2D, t: number): void {
  // At the computer, typing, eyes on the screen.
  room(ctx, C.wallPurple, C.wallPurpleDark);
  shelf(ctx, 6, 10);
  desk(ctx, 62, 62, 70);
  computer(ctx, 82, 27, t, 'code');
  thing(ctx, 66, 54, 8, 9, (l) => {
    l.rect(1, 1, 5, 7, C.mug);
    l.rect(2, 2, 3, 2, C.coffee);
    l.rect(6, 3, 1, 3, C.mug);
  });
  for (let i = 0; i < 2; i++) rect(ctx, C.smoke, 68 + i * 2 + Math.round(Math.sin(t / 300 + i)), 48 - ((t / 90 + i * 4) % 6), 1, 2);
  rect(ctx, C.chairDark, 34, 66, 3, 12);
  thing(ctx, 22, 60, 30, 7, (l) => l.rect(1, 1, 27, 4, C.chair));
  const typing = tick(t, 140) % 2;
  const think = t % 7000 > 6000;
  character({
    eye: think ? 'open' : blinking(t, 4100) ? 'blink' : 'focus',
    look: think ? [0.2, -1] : [1, 0.6],
    mouth: think ? 'closed' : 'tongue',
    sit: true,
    front: think ? [33, 22] : [48, typing ? 34 : 36],
    back: think ? null : [44, typing ? 37 : 35],
  }).blit(ctx, 20, 61 - FEET_Y + 2);
}

function sceneConnect(ctx: CanvasRenderingContext2D, t: number): void {
  // Carrying the plug to the device's port, pushing it in.
  room(ctx, C.wallGray, C.wallGrayDark);
  shelf(ctx, 8, 12);
  desk(ctx, 96, 60, 38);
  const cyc = t % 2600;
  const plugged = cyc > 1500;
  device(ctx, 102, 42, plugged, t);
  const u = Math.min(1, cyc / 1500);
  const o = stand(ctx, 30 + u * 20, { eye: 'focus', look: [1, 0.4], mouth: plugged ? 'smile' : 'tongue', front: [48, 33], back: [44, 35], step: u < 1 ? (tick(cyc, 250) % 2 ? 1 : 2) : 0 });
  const hand = at(o, [48, 33]);
  const px = plugged ? 91 : hand[0];
  const py = plugged ? 46 : hand[1] - 3;
  cable(ctx, [0, 84], [px, py + 3], t, 10);
  plug(ctx, px, py);
  if (plugged && cyc < 1900)
    for (const [dx, dy] of [
      [0, -3],
      [0, 3],
      [-3, 0],
      [3, 0],
      [-2, -2],
      [2, 2],
    ] as const)
      rect(ctx, C.sun, 102 + dx, 50 + dy, 1, 1);
}

function sceneRead(ctx: CanvasRenderingContext2D, t: number): void {
  // Examining a card under a big magnifying glass: the lens enlarges what it is over.
  room(ctx, C.wallPurple, C.wallPurpleDark);
  window_(ctx, 96, 8, t);
  desk(ctx, 58, 64, 76);
  thing(ctx, 82, 56, 24, 10, (l) => {
    l.rect(1, 1, 22, 8, C.cream);
    l.rect(3, 3, 5, 4, C.gold);
    l.rect(10, 3, 10, 1, PALETTE.cyan);
    l.rect(10, 5, 7, 1, PALETTE.cyan);
  });
  const sweep = Math.sin(t / 700);
  const o = stand(ctx, 36 + sweep * 3, { eye: 'wide', look: [1, 0.6], mouth: tick(t, 900) % 3 === 0 ? 'open' : 'closed', front: [50, 26], back: [44, 30] });
  const hand = at(o, [50, 26]);
  const lx = Math.round(94 + sweep * 8);
  const ly = 50;
  for (let i = 0; i <= 8; i++) rect(ctx, C.woodDark, hand[0] + ((lx - 6 - hand[0]) * i) / 8, hand[1] + ((ly + 4 - hand[1]) * i) / 8, 2, 2);
  // the lens: what is under it, twice as big
  for (let j = -8; j <= 8; j++)
    for (let i = -8; i <= 8; i++) {
      if (i * i + j * j > 64) continue;
      const sx = Math.floor(lx - 82 + i / 2);
      const sy = Math.floor(ly - 56 + j / 2 + 2);
      const inCard = sx >= 1 && sx < 23 && sy >= 1 && sy < 9;
      const chip = sx >= 3 && sx < 8 && sy >= 3 && sy < 7;
      const line = sx >= 10 && sx < 20 && (sy === 3 || (sy === 5 && sx < 17));
      rect(ctx, !inCard ? C.glass : chip ? ((i + j) & 2 ? C.gold : C.goldDark) : line ? PALETTE.cyan : C.cream, lx + i, ly + j);
    }
  thing(ctx, lx - 10, ly - 10, 21, 21, (l) => {
    l.ellipse(10.5, 10.5, 10, 10, C.gold);
    l.ellipse(10.5, 10.5, 8.2, 8.2, null);
  });
  rect(ctx, C.cloud, lx - 4, ly - 5, 2, 1);
}

function sceneTransfer(ctx: CanvasRenderingContext2D, t: number): void {
  // Carrying floppies from the shelf to the computer, one at a time.
  room(ctx, C.wallTeal, C.wallTealDark);
  desk(ctx, 92, 62, 42);
  computer(ctx, 96, 27, t, 'code');
  thing(ctx, 4, 50, 22, 28, (l) => {
    l.rect(1, 1, 20, 3, C.woodDark);
    l.rect(1, 13, 20, 3, C.woodDark);
    l.rect(1, 25, 20, 2, C.woodDark);
  });
  const colors = [C.floppy1, C.floppy2, C.floppy3];
  const trip = tick(t, 3600);
  for (let i = 0; i < 3; i++) if (i !== trip % 3) rect(ctx, colors[i]!, 6 + i * 6, 56, 5, 7);
  const cyc = t % 3600;
  const going = cyc < 2200;
  const u = going ? cyc / 2200 : 1 - (cyc - 2200) / 1400;
  const step = tick(t, 220) % 2 ? 1 : 2;
  const o = stand(ctx, 18 + u * 50, going ? { eye: 'open', look: [1, 0.4], mouth: 'smile', front: [41, 36], back: [37, 38], step } : { eye: 'happy', mouth: 'smile', step }, !going);
  if (going) {
    const h = at(o, [41, 36]);
    floppy(ctx, h[0] - 5, h[1] - 9, colors[trip % 3]!);
  }
}

function sceneSuccess(ctx: CanvasRenderingContext2D, t: number): void {
  // It worked: arms up, a jump, confetti.
  room(ctx, C.wallWarm, C.wallWarmDark);
  window_(ctx, 92, 10, t);
  const jump = Math.abs(Math.sin((t / 700) * Math.PI)) * 10;
  const up = tick(t, 350) % 2;
  stand(ctx, 42, { eye: 'happy', mouth: 'open', blush: true, front: up ? [50, 13] : [49, 17], frontElbow: [45, 37], back: up ? [2, 8] : [3, 12], backElbow: [7, 24] }, false, jump);
  confetti(ctx, t);
  bubble(ctx, 88, 44, 'YAY!', PALETTE.green);
}

function sceneWarning(ctx: CanvasRenderingContext2D, t: number): void {
  // Something is off: it scratches its head, looking up.
  room(ctx, C.wallGray, C.wallGrayDark);
  const on = tick(t, 500) % 2 === 0;
  thing(ctx, 104, 8, 12, 12, (l) => l.ellipse(6, 6, 5, 5, on ? PALETTE.amber : '#7a5c22'));
  if (on) {
    ctx.globalAlpha = 0.1;
    rect(ctx, PALETTE.amber, 0, 0, SCREEN_W, FLOOR_Y);
    ctx.globalAlpha = 1;
  }
  plant(ctx, 120, 70, t);
  const scratch = tick(t, 160) % 2;
  stand(ctx, 44, { eye: 'open', look: [0.4, -1], mouth: 'frown', back: [8, scratch ? 3 : 5], backElbow: [6, 22], sweat: true });
  bubble(ctx, 84, 30, '?', PALETTE.amber);
}

function sceneError(ctx: CanvasRenderingContext2D, t: number): void {
  // It failed: puzzled, it takes a wrench to the smoking device.
  room(ctx, C.wallGray, C.wallGrayDark);
  desk(ctx, 76, 62, 58);
  computer(ctx, 94, 27, t, 'error');
  device(ctx, 78, 46, false, t, true);
  const swing = tick(t, 280) % 2;
  const hand: Pt = swing ? [46, 24] : [48, 32];
  const o = stand(ctx, 28, { eye: swing ? 'angry' : 'sad', look: [1, 0.6], mouth: 'frown', front: hand, back: [40, 36], sweat: true });
  const h = at(o, hand);
  thing(ctx, h[0] - 2, h[1] - 10, 12, 14, (l) => {
    l.rect(2, 4, 2, 9, C.metal);
    l.rect(0, 0, 6, 4, C.metal);
    l.rect(2, 0, 2, 2, null);
  });
  if (!swing)
    for (const [dx, dy] of [
      [0, 0],
      [2, -2],
      [-2, -1],
    ] as const)
      rect(ctx, C.sun, h[0] + 8 + dx, h[1] - 2 + dy, 1, 1);
}

function sceneDisconnect(ctx: CanvasRenderingContext2D, t: number): void {
  // The link dropped: it holds the loose plug and looks at it, sad.
  room(ctx, C.wallNight, C.wallNightDark);
  desk(ctx, 96, 60, 38);
  device(ctx, 102, 42, false, t);
  const look = t % 4000 < 2600;
  const o = stand(ctx, 34, { eye: 'sad', look: look ? [0.4, 1] : [1, 0], mouth: 'frown', front: [44, 34], back: null, tear: true });
  const h = at(o, [44, 34]);
  cable(ctx, [0, 86], [h[0] - 2, h[1] + 3], t, 6);
  plug(ctx, h[0] - 1, h[1] - 3 + (tick(t, 600) % 2));
  bubble(ctx, 90, 22, '?', C.wallPurple);
}

export function drawCompanionScene(ctx: CanvasRenderingContext2D, anim: Anim, t: number): void {
  switch (anim) {
    case 'none':
      return rect(ctx, '#000', 0, 0, SCREEN_W, SCREEN_H);
    case 'idle':
      return sceneIdle(ctx, t);
    case 'wait':
      return sceneWait(ctx, t);
    case 'greet':
      return sceneGreet(ctx, t);
    case 'search':
      return sceneAnalyse(ctx, t);
    case 'connect':
      return sceneConnect(ctx, t);
    case 'read':
      return sceneRead(ctx, t);
    case 'transfer':
      return sceneTransfer(ctx, t);
    case 'success':
      return sceneSuccess(ctx, t);
    case 'warning':
      return sceneWarning(ctx, t);
    case 'error':
      return sceneError(ctx, t);
    case 'disconnect':
      return sceneDisconnect(ctx, t);
  }
}

export function drawCompanionSplash(ctx: CanvasRenderingContext2D, t: number): void {
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

/** The companion of Flipper Lab: the little dolphin and its scenes. */
export const COMPANION: SpriteSet = { id: 'flipper-lab-companion', drawScene: drawCompanionScene, drawSplash: drawCompanionSplash };
/** Older name, kept for imports. */
export const DOLPHIN = COMPANION;
