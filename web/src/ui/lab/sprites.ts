/**
 * HARDWARE DOG / TV SPRITES — THE COMPANION AT ITS DESK
 *
 * What plays inside the TV screen: the companion, a little cartoon
 * dolphin seen from the chest up at its desk, in a cozy lab. Its gestures
 * tell what the tool is doing: it codes with headphones on when the link
 * is up and all is quiet, turns the knob of a radio scanner while the tool
 * analyses, leans over a board with a magnifier while it reads, pushes the
 * cable into the Flipper while it connects, watches the blocks travel
 * between two computers while it transfers, throws its arms up at a
 * success, crosses them at an error, holds two cable ends when the link
 * drops, and sleeps on the desk when nothing is connected.
 *
 * Drawn on a 136 x 100 canvas, one canvas pixel per art pixel, scaled up
 * without smoothing, in full color. The companion is one profile (melon
 * flowing into a thick beak, big eye, cream throat) built from shapes plus
 * an outline pass, so every pose stays in one style.
 *
 * A SpriteSet is replaceable: a Hardware Dog TV with the dog would supply
 * its own drawScene and drawSplash, and nothing in the engine changes.
 * Every frame is a pure function of (animation, time): remounting the TV
 * (another section, a detached window) resumes, it never restarts.
 */

import type { Anim, Subject } from '../../core/lab/companion';

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

/** A scene: an animation of the companion, or the TV switching off. */
export type SceneName = Anim | 'shutdown';

export interface SpriteSet {
  id: string;
  /** `subject`: what the animation is about (tool, file kind), to pick the right scene. */
  drawScene(ctx: CanvasRenderingContext2D, scene: SceneName, t: number, subject?: Subject | null): void;
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

export type Eye = 'open' | 'blink' | 'happy' | 'closed' | 'focus' | 'wide';
export type Brow = 'none' | 'mad' | 'worried';
export type Mouth = 'closed' | 'smile' | 'open' | 'frown' | 'grin';

/**
 * The companion from the chest up, as it sits at its desk, facing right
 * (mirrored to face left). Its look comes from one profile: a big melon
 * flowing into a thick bottle-nose beak, a big eye, a cream throat and
 * belly, flippers it uses as hands.
 */
export interface Pose {
  eye: Eye;
  /** Where the pupil looks, -1..1 each way. */
  look?: Pt;
  brow?: Brow;
  mouth?: Mouth;
  /** Hands, in bust coordinates (null: resting on the desk). */
  front?: Pt | null;
  back?: Pt | null;
  frontElbow?: Pt;
  backElbow?: Pt;
  /** The near flipper goes up behind the head (both arms up: hooray). */
  frontBehind?: boolean;
  headphones?: boolean;
  /** Safety goggles, for soldering. */
  goggles?: boolean;
  blush?: boolean;
  sweat?: boolean;
}

export const BW = 64;
export const BH = 66;
const SHOULDER_FRONT: Pt = [36, 50];
const SHOULDER_BACK: Pt = [18, 50];
const DESK_FRONT: Pt = [48, 62];
const DESK_BACK: Pt = [12, 63];

const cache = new Map<string, Layer>();

export function bust(p: Pose): Layer {
  const key = JSON.stringify(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const P = PALETTE;
  const L = new Layer(BW, BH);
  const front = p.front ?? DESK_FRONT;
  const back = p.back ?? DESK_BACK;
  const arm = (l: Layer, shoulder: Pt, elbow: Pt | undefined, hand: Pt, c: string) => {
    if (elbow) {
      l.capsule(shoulder, elbow, 4.8, c);
      l.capsule(elbow, hand, 4.4, c);
    } else l.capsule(shoulder, hand, 4.6, c);
    l.ellipse(hand[0], hand[1], 5.2, 4.4, c);
  };

  // the far flipper, behind (and the near one too, when it is raised behind the head)
  arm(L, SHOULDER_BACK, p.backElbow, back, P.shade);
  if (p.frontBehind) arm(L, SHOULDER_FRONT, p.frontElbow, front, P.body);
  // one smooth silhouette: a wide melon sloping into a tapered beak, the back, the chest
  L.ellipse(28, 22, 19.5, 18.5, P.body);
  L.capsule([26, 26], [22, 52], 18, P.body);
  L.ellipse(28, 60, 25, 14, P.body);
  L.ellipse(43, 33, 8, 7, P.body);
  L.tri([36, 23], [56, 34.5], [36, 44], P.body);
  L.ellipse(53.5, 37.6, 4.4, 3.9, P.body);
  // shading on the back, a highlight on the melon and along the beak
  L.ellipse(7, 42, 8, 28, P.shade, [P.body]);
  L.ellipse(24, 9, 10, 3.4, P.light, [P.body]);
  L.line([44, 29], [52, 33], P.light);
  // the cream jaw, throat and belly, from under the mouth down
  L.tri([38, 39.5], [57, 39], [38, 46], P.belly);
  L.ellipse(41, 47, 10, 7, P.belly, [P.body]);
  L.ellipse(40, 60, 15, 18, P.belly, [P.body]);
  L.outline(P.outline);

  // the near flipper, over the body, outlined on its own
  if (!p.frontBehind) {
    const F = new Layer(BW, BH);
    arm(F, SHOULDER_FRONT, p.frontElbow, front, P.body);
    F.ellipse(front[0] - 1, front[1] - 1.5, 2, 1.2, P.light, [P.body]);
    F.outline(P.outline);
    L.over(F);
  }

  // headphones: the band over the melon, a cup behind the eye
  if (p.headphones) {
    const H = new Layer(BW, BH);
    for (let a = 3.6; a <= 5.1; a += 0.04) H.capsule([28 + Math.cos(a) * 19.8, 22 + Math.sin(a) * 18.8], [28 + Math.cos(a + 0.04) * 19.8, 22 + Math.sin(a + 0.04) * 18.8], 1.4, '#2b3a55');
    H.ellipse(21, 28, 5.5, 7, '#1d6f7a');
    H.ellipse(21, 28, 3.4, 5, '#0b3c44');
    H.ellipse(19.5, 25.5, 1, 1.6, P.cyan);
    H.outline(P.outline);
    L.over(H);
  }

  // the eye
  const ex = 37;
  const ey = 19;
  const [lx, ly] = p.look ?? [0, 0];
  const lid = (y: number) => {
    L.line([ex - 4, y], [ex - 2, y + 1], P.outline);
    L.line([ex - 2, y + 1], [ex + 2, y + 1], P.outline);
    L.line([ex + 2, y + 1], [ex + 4, y], P.outline);
  };
  switch (p.eye) {
    case 'blink':
    case 'closed':
      lid(ey + 1);
      L.line([ex - 2, ey + 3], [ex + 2, ey + 3], P.shade);
      break;
    case 'happy':
      L.line([ex - 4, ey + 2], [ex - 2, ey - 1], P.outline);
      L.line([ex - 2, ey - 1], [ex + 2, ey - 1], P.outline);
      L.line([ex + 2, ey - 1], [ex + 4, ey + 2], P.outline);
      L.line([ex - 3, ey + 2], [ex - 1, ey], P.outline);
      L.line([ex + 1, ey], [ex + 3, ey + 2], P.outline);
      break;
    default: {
      const big = p.eye === 'wide' ? 1 : 0;
      L.ellipse(ex, ey, 6.2 + big, 7.2 + big, P.outline);
      L.ellipse(ex, ey, 5.2 + big, 6.2 + big, P.white);
      const pw = p.eye === 'wide' ? 4 : 5;
      const px = ex - 2 + Math.round(lx * 1.6);
      const py = ey - 2 + Math.round(ly * 1.8);
      L.rect(px, py, pw, pw + 1, P.pupil);
      L.rect(px, py, 2, 2, P.white);
      L.set(px + pw - 1, py + pw, P.white);
    }
  }
  if (p.brow === 'mad') {
    L.line([ex - 5, ey - 9], [ex + 5, ey - 5], P.outline);
    L.line([ex - 5, ey - 8], [ex + 5, ey - 4], P.outline);
  } else if (p.brow === 'worried') {
    L.line([ex - 5, ey - 6], [ex + 4, ey - 9], P.outline);
  }

  // the mouth: from the tip of the beak back into the cheek, curving up (the dolphin's smile)
  const m = p.mouth ?? 'smile';
  if (m === 'open' || m === 'grin') {
    L.line([56, 38], [42, 40], P.outline);
    L.tri([43, 40.5], [54, 39.5], [45, 44], P.outline);
    L.rect(46, 41, 4, 1, P.tongue);
    L.line([42, 40], [39, 37], P.outline);
  } else {
    L.line([56, 38.5], [41, 39.5], P.outline);
    if (m === 'frown') L.line([41, 39.5], [38, 41], P.outline);
    else if (m === 'smile') L.line([41, 39.5], [38, 36.5], P.outline);
    else L.set(40, 39, P.outline);
  }
  if (p.blush) {
    L.rect(38, 30, 3, 1, P.pink);
    L.rect(39, 31, 2, 1, P.pink);
  }
  if (p.sweat) {
    L.set(18, 8, P.tear);
    L.rect(17, 9, 3, 2, P.tear);
  }
  if (p.goggles) {
    // the strap round the melon, a big lens over the eye
    for (let x = 9; x <= 30; x++) L.set(x, 14 + Math.round(((x - 20) / 12) ** 2 * 2), '#2b3a55');
    const G = new Layer(BW, BH);
    G.ellipse(ex, ey, 8.5, 8, '#3fb8d0');
    G.ellipse(ex, ey, 6.6, 6.2, null);
    G.outline(P.outline);
    L.over(G);
    for (let y = -5; y <= 5; y++)
      for (let x = -6; x <= 6; x++) {
        if ((x / 6.6) ** 2 + (y / 6.2) ** 2 > 1) continue;
        const c = L.get(ex + x, ey + y);
        // the glass tints what is under it
        if (c === P.white) L.set(ex + x, ey + y, '#d8f6ff');
        else if (c === P.body || c === P.light) L.set(ex + x, ey + y, '#ffb57a');
      }
    L.line([ex - 4, ey - 4], [ex - 2, ey - 5], '#ffffff');
  }
  cache.set(key, L);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return L;
}

/** A point of the bust in screen coordinates, wherever it sits and faces. */
function at(origin: Pt, local: Pt, flip = false): Pt {
  return [origin[0] + (flip ? BW - 1 - local[0] : local[0]), origin[1] + local[1]];
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

function glow(ctx: CanvasRenderingContext2D, c: string, alpha: number, x: number, y: number, w: number, h: number): void {
  ctx.globalAlpha = alpha;
  rect(ctx, c, x, y, w, h);
  ctx.globalAlpha = 1;
}

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

// -------------------------------------------------------------- the lab

/** The desk the companion sits at: its top, and how far down the bust goes behind it. */
const DESK_Y = 80;
/** Where the bust sits: its bottom edge hides behind the desk front. */
const BUST_Y = DESK_Y + 6 - BH;

const L_ = {
  wall: '#1e2244',
  wallDark: '#181b38',
  wallLine: '#262b55',
  shelf: '#4a3a52',
  shelfDark: '#33283a',
  desk: '#9a6239',
  deskLight: '#bf8150',
  deskFront: '#5c3922',
  deskFrontDark: '#4a2d1b',
  beige: '#e2d8bf',
  beigeDark: '#b7ab8f',
  screen: '#0b2420',
  code1: '#4de2ff',
  code2: '#ff6fae',
  code3: '#79d98a',
  code4: '#ffd447',
  lamp: '#ffcf5a',
  lampDark: '#2c3550',
  leaf: '#3fa45a',
  leafDark: '#2a7340',
  pot: '#b85c38',
  poster: '#ff6fae',
  box1: '#3f7fa8',
  box2: '#a8466e',
  box3: '#c9a14a',
  metal: '#aab3bd',
  metalDark: '#6e7782',
  pcb: '#2f8a4a',
  pcbDark: '#1f6334',
  chip: '#22262b',
  gold: '#e8c25a',
  brick: '#6a3b3b',
  brickDark: '#552d2e',
  night: '#152048',
  rain: '#5f86c9',
  cityLit: '#ffd86b',
  cable: '#21a9c4',
  device: '#f3efe6',
  deviceDark: '#c7c0b1',
  deviceScreen: '#ff9a3c',
  radio: '#3d4148',
  radioDark: '#2a2d33',
  check: '#79d98a',
  white: '#ffffff',
  mug: '#f2ede2',
} as const;

function lab(ctx: CanvasRenderingContext2D, t: number, opts: { lamp?: 'left' | 'right' | null; plants?: boolean; shelf?: boolean; poster?: number | null } = {}): void {
  rect(ctx, L_.wall, 0, 0, SCREEN_W, DESK_Y);
  for (let x = 0; x < SCREEN_W; x += 17) rect(ctx, L_.wallDark, x, 0, 1, DESK_Y);
  rect(ctx, L_.wallLine, 0, 48, SCREEN_W, 1);
  if (opts.shelf !== false) {
    // shelves with boxes and books, muted
    for (const sy of [14, 34]) {
      rect(ctx, L_.shelf, 0, sy, SCREEN_W, 2);
      rect(ctx, L_.shelfDark, 0, sy + 2, SCREEN_W, 1);
      for (let i = 0; i < 9; i++) {
        const x = 4 + i * 15 + Math.round(rnd(sy + i) * 4);
        const kind = Math.floor(rnd(i * 3 + sy) * 3);
        const h = 5 + Math.round(rnd(i + sy * 2) * 5);
        rect(ctx, [L_.box1, L_.box2, L_.box3][kind]!, x, sy - h, 4 + (kind === 2 ? 4 : 0), h);
        if (kind === 1) rect(ctx, L_.wallDark, x + 1, sy - h + 1, 2, 1);
      }
    }
  }
  if (opts.plants !== false) {
    for (const px of [8, 118]) {
      rect(ctx, L_.pot, px, 6, 8, 6);
      for (let k = 0; k < 5; k++) rect(ctx, k % 2 ? L_.leafDark : L_.leaf, px - 3 + k * 3, 1 + (k % 2) * 2 + Math.round(Math.sin(t / 1100 + k)), 2, 5);
    }
  }
  if (opts.poster != null) {
    const px = opts.poster;
    rect(ctx, L_.poster, px, 18, 10, 13);
    rect(ctx, L_.wall, px + 2, 20, 6, 1);
    rect(ctx, L_.wall, px + 2, 23, 4, 1);
    rect(ctx, L_.wall, px + 2, 26, 6, 1);
  }
  if (opts.lamp) {
    const lx = opts.lamp === 'left' ? 4 : 106;
    rect(ctx, L_.lampDark, lx + 18, 2, 2, 14);
    thing(ctx, lx + 8, 12, 24, 10, (l) => l.tri([1, 9], [22, 9], [12, 0], L_.lampDark));
    rect(ctx, L_.lamp, lx + 12, 20, 16, 2);
    glow(ctx, L_.lamp, 0.13, lx - 4, 22, 48, DESK_Y - 22);
  }
}

function deskTop(ctx: CanvasRenderingContext2D): void {
  rect(ctx, L_.desk, 0, DESK_Y, SCREEN_W, 4);
  rect(ctx, L_.deskLight, 0, DESK_Y, SCREEN_W, 1);
  rect(ctx, L_.deskFront, 0, DESK_Y + 4, SCREEN_W, SCREEN_H - DESK_Y - 4);
  for (let x = 20; x < SCREEN_W; x += 48) rect(ctx, L_.deskFrontDark, x, DESK_Y + 9, 28, 1);
}

/** The bust at x (left edge), facing right or left, behind the desk. `dy` lifts it. */
function sit(ctx: CanvasRenderingContext2D, x: number, pose: Pose, flip = false, dy = 0): Pt {
  const o: Pt = [Math.round(x), BUST_Y - Math.round(dy)];
  bust(pose).blit(ctx, o[0], o[1], flip);
  return o;
}

// ---------------------------------------------------------------- props

function crt(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, show: 'code' | 'dark' | 'check' | 'alert' | 'folder' | 'send' | 'boot' | 'bt' | 'uart' | 'dash'): void {
  thing(ctx, x, y, 38, 34, (l) => {
    l.rect(1, 1, 35, 28, L_.beige);
    l.rect(1, 25, 35, 4, L_.beigeDark);
    l.rect(12, 29, 13, 4, L_.beigeDark);
  });
  rect(ctx, L_.screen, x + 5, y + 5, 27, 18);
  const sx = x + 7;
  const sy = y + 7;
  if (show === 'code') {
    const scroll = tick(t, 220);
    for (let i = 0; i < 5; i++) {
      const n = scroll + i;
      const c = [L_.code1, L_.code2, L_.code3, L_.code4][Math.floor(rnd(n + 7) * 4)]!;
      rect(ctx, c, sx + (n % 3 === 0 ? 0 : 3), sy + i * 3, 4 + Math.round(rnd(n) * 14), 1);
    }
    if (tick(t, 400) % 2) rect(ctx, L_.white, sx + 2, sy + 14, 2, 2);
  } else if (show === 'check') {
    for (const [dx, dy] of [
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 8],
      [10, 7],
      [11, 6],
      [12, 5],
      [13, 4],
      [14, 3],
    ] as const)
      rect(ctx, L_.check, sx + dx, sy + dy, 3, 2);
  } else if (show === 'alert') {
    if (tick(t, 350) % 2 === 0) pixelText(ctx, '!', sx + 9, sy + 4, PALETTE.amber);
  } else if (show === 'folder') {
    rect(ctx, L_.code1, sx + 6, sy + 4, 6, 2);
    rect(ctx, L_.code1, sx + 6, sy + 6, 13, 8);
    rect(ctx, L_.screen, sx + 7, sy + 7, 11, 6);
  } else if (show === 'send') {
    for (let i = 0; i < 3; i++) rect(ctx, L_.code3, sx + 2, sy + 2 + i * 4, 6 + ((tick(t, 200) + i) % 3) * 4, 2);
  } else if (show === 'boot') {
    // the little dolphin of the boot screen, and its loading bar
    for (const [dx, dy, w] of [
      [9, 3, 2],
      [8, 4, 5],
      [7, 5, 8],
      [6, 6, 9],
      [5, 7, 3],
      [10, 7, 4],
      [13, 8, 2],
    ] as const)
      rect(ctx, L_.code1, sx + dx, sy + dy, w, 1);
    rect(ctx, L_.code1, sx + 1, sy + 11, 21, 1);
    rect(ctx, L_.code1, sx + 1, sy + 13, 21, 1);
    rect(ctx, L_.code1, sx + 2, sy + 12, Math.min(19, Math.round(((t % 2500) / 2500) * 19)), 1);
  } else if (show === 'bt') {
    // the Bluetooth rune, its waves going out
    const bx = sx + 11;
    const by = sy + 2;
    rect(ctx, L_.code1, bx, by, 1, 13);
    for (let i = 0; i < 4; i++) {
      rect(ctx, L_.code1, bx + i, by + i, 1, 1);
      rect(ctx, L_.code1, bx + 3 - i, by + 3 + i, 1, 1);
      rect(ctx, L_.code1, bx + i, by + 9 + i, 1, 1);
      rect(ctx, L_.code1, bx + 3 - i, by + 6 + i, 1, 1);
    }
    const wave = tick(t, 300) % 3;
    for (let k = 0; k <= wave; k++) {
      rect(ctx, L_.code1, bx - 4 - k * 2, by + 4 - k, 1, 5 + k * 2);
      rect(ctx, L_.code1, bx + 6 + k * 2, by + 4 - k, 1, 5 + k * 2);
    }
  } else if (show === 'uart') {
    // a terminal: prompt, sent line, answer, the cursor
    const lines = [
      [L_.code1, 4, 1],
      [L_.code4, 3, 14],
      [L_.code3, 3, 8],
      [L_.code1, 4, 1],
    ] as const;
    const shown = 1 + (tick(t, 500) % 4);
    lines.slice(0, shown).forEach(([c, a, b], i) => {
      rect(ctx, c, sx, sy + i * 4, a, 2);
      rect(ctx, c, sx + a + 1, sy + i * 4, b, 2);
    });
    if (tick(t, 300) % 2) rect(ctx, L_.white, sx + 7, sy + (shown - 1) * 4, 2, 2);
  } else if (show === 'dash') {
    rect(ctx, L_.white, sx + 8, sy + 8, 8, 1);
  }
  rect(ctx, PALETTE.green, x + 30, y + 26, 2, 1);
}

function keyboard(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 30, 6, (l) => l.rect(1, 1, 28, 4, L_.beige));
  for (let i = 0; i < 6; i++) rect(ctx, L_.beigeDark, x + 3 + i * 4, y + 2, 3, 1);
}

function mug(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, steam = true): void {
  thing(ctx, x, y, 11, 11, (l) => {
    l.rect(1, 1, 7, 9, L_.mug);
    l.rect(8, 3, 2, 4, L_.mug);
    l.rect(3, 4, 3, 3, PALETTE.body);
  });
  if (steam) for (let i = 0; i < 2; i++) rect(ctx, '#c9ced6', x + 3 + i * 2 + Math.round(Math.sin(t / 300 + i)), y - 2 - ((t / 110 + i * 3) % 6), 1, 2);
}

function plant(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  thing(ctx, x, y, 14, 18, (l) => {
    l.rect(3, 11, 8, 6, L_.pot);
    for (let k = 0; k < 4; k++) l.ellipse(3 + k * 2.6 + Math.sin(t / 1000 + k) * 0.6, 6 + (k % 2) * 2, 1.6, 4, k % 2 ? L_.leafDark : L_.leaf);
  });
}

/** The Flipper: a white device, an orange screen with a little dolphin, the orange d-pad. */
function flipperDevice(ctx: CanvasRenderingContext2D, x: number, y: number, on: boolean, t: number): void {
  thing(ctx, x, y, 40, 20, (l) => {
    l.ellipse(6, 10, 6, 9, L_.device);
    l.ellipse(33, 10, 6, 9, L_.device);
    l.rect(6, 1, 27, 18, L_.device);
    l.rect(3, 15, 34, 3, L_.deviceDark);
    l.ellipse(31, 9, 4.5, 4.5, PALETTE.body);
    l.ellipse(31, 9, 1.6, 1.6, '#c25a10');
  });
  rect(ctx, on ? L_.deviceScreen : '#4a3426', x + 8, y + 4, 15, 9);
  if (on) {
    rect(ctx, '#7a3d10', x + 12, y + 7, 6, 3);
    rect(ctx, '#7a3d10', x + 17, y + 6, 2, 1);
    rect(ctx, '#ffe2bf', x + 10 + (tick(t, 250) % 3), y + 5, 1, 1);
  }
  rect(ctx, '#2a1a12', x, y + 8, 2, 4); // the USB port
}

function pcb(ctx: CanvasRenderingContext2D, x: number, y: number, w = 44): void {
  thing(ctx, x, y, w, 10, (l) => {
    l.rect(1, 1, w - 2, 8, L_.pcb);
    l.rect(1, 7, w - 2, 2, L_.pcbDark);
  });
  rect(ctx, L_.chip, x + 6, y + 2, 9, 5);
  rect(ctx, L_.chip, x + 22, y + 3, 7, 4);
  for (let i = 0; i < w - 6; i += 3) rect(ctx, L_.gold, x + 3 + i, y + 8, 1, 1);
  for (let i = 0; i < 4; i++) rect(ctx, L_.metal, x + 7 + i * 2, y + 1, 1, 1);
}

function radio(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  thing(ctx, x, y, 50, 30, (l) => {
    l.rect(1, 1, 48, 28, L_.radio);
    l.rect(1, 25, 48, 4, L_.radioDark);
  });
  rect(ctx, '#06231e', x + 5, y + 4, 26, 15);
  // the spectrum: bars that move, a peak that wanders
  const peak = 4 + Math.round((Math.sin(t / 900) + 1) * 9);
  for (let i = 0; i < 12; i++) {
    const h = Math.min(13, 2 + Math.round(rnd(i + tick(t, 120) * 13) * 4 + Math.max(0, 9 - Math.abs(i * 2 - peak) * 2)));
    rect(ctx, h > 9 ? L_.code4 : L_.code3, x + 6 + i * 2, y + 18 - h, 1, h);
  }
  for (let i = 0; i < 3; i++) thing(ctx, x + 34 + (i % 2) * 7, y + 3 + Math.floor(i / 2) * 8, 7, 7, (l) => l.ellipse(3.5, 3.5, 2.8, 2.8, L_.metal));
  for (let i = 0; i < 4; i++) rect(ctx, L_.radioDark, x + 6 + i * 6, y + 22, 4, 2);
  rect(ctx, L_.metalDark, x + 44, y - 16, 1, 16); // antenna
}

function walkie(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 11, 22, (l) => {
    l.rect(1, 4, 9, 17, L_.beigeDark);
    l.rect(6, 0, 2, 5, L_.metalDark);
  });
  rect(ctx, L_.code3, x + 3, y + 7, 5, 4);
  for (let i = 0; i < 6; i++) rect(ctx, L_.radioDark, x + 3 + (i % 3) * 2, y + 13 + Math.floor(i / 3) * 2, 1, 1);
}

function cd(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 14, 6, (l) => {
    l.ellipse(7, 3, 6, 2.4, '#d9e6f2');
    l.ellipse(7, 3, 1.5, 0.8, L_.wall);
  });
  rect(ctx, '#ff9ad5', x + 3, y + 2, 2, 1);
}

function cableEnd(ctx: CanvasRenderingContext2D, x: number, y: number, kind: 'usb' | 'micro', flip = false): void {
  thing(
    ctx,
    x,
    y,
    9,
    8,
    (l) => {
      l.rect(1, 1, 5, 6, L_.cable);
      l.rect(6, 2, 2, 4, kind === 'usb' ? L_.metal : L_.metalDark);
    },
    flip,
  );
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, c: string, size = 2): void {
  rect(ctx, c, x - size, y, size * 2 + 1, 1);
  rect(ctx, c, x, y - size, 1, size * 2 + 1);
}

function zzz(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  for (let i = 0; i < 3; i++) {
    const p = (((t / 2400 + i / 3) % 1) + 1) % 1;
    pixelText(ctx, 'Z', x + p * 10 + i * 2, y - p * 16, p < 0.8 ? PALETTE.pink : L_.wallLine);
  }
}

function mark(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, c: string): void {
  pixelText(ctx, text, x, y, c, PALETTE.outline);
}

// --------------------------------------------------------------- scenes

function sceneCoding(ctx: CanvasRenderingContext2D, t: number): void {
  // Link up, nothing running: headphones on, it codes, nodding to the music.
  lab(ctx, t, { poster: 112 });
  crt(ctx, 10, 46, t, 'code');
  walkie(ctx, 2, 58);
  const nod = tick(t, 420) % 2;
  const type = tick(t, 130) % 2;
  sit(ctx, 66, { eye: blinking(t) ? 'blink' : 'focus', look: [1, 0.4], mouth: 'smile', headphones: true, front: [50, type ? 58 : 60], back: [36, type ? 61 : 59], frontElbow: [44, 54] }, true, nod);
  deskTop(ctx);
  keyboard(ctx, 36, 77);
  cd(ctx, 6, 79);
  cd(ctx, 18, 80);
}

function sceneScan(ctx: CanvasRenderingContext2D, t: number): void {
  // Analysing: at the radio scanner, a hand on the knob, eyes on the spectrum.
  lab(ctx, t, { poster: 76 });
  radio(ctx, 6, 50, t);
  const turn = tick(t, 600) % 2;
  sit(ctx, 68, { eye: blinking(t, 4000) ? 'blink' : 'focus', look: [1, 0.2], mouth: 'smile', front: [56, turn ? 58 : 60], frontElbow: [46, 56], back: [38, 64] }, true);
  deskTop(ctx);
  rect(ctx, PALETTE.red, 20, 81, 7, 2);
}

function sceneAnalyze(ctx: CanvasRenderingContext2D, t: number): void {
  // Reading: leaning over a board, a magnifier up to its eye.
  lab(ctx, t, { lamp: 'right', poster: 20 });
  plant(ctx, 92, 64, t);
  const lean = Math.sin(t / 900);
  const o = sit(ctx, 28 + lean * 3, { eye: 'wide', look: [1, 0.8], brow: 'worried', mouth: 'closed', front: [42, 40], frontElbow: [44, 56], back: [20, 62] }, false, -2);
  deskTop(ctx);
  pcb(ctx, 46, 76);
  // the magnifier in its hand, over the board
  const h = at(o, [42, 40]);
  const lx = h[0] + 6;
  const ly = h[1] - 4;
  for (let i = 0; i < 5; i++) rect(ctx, '#7d522c', h[0] - 1 + i, h[1] + 2 - i, 2, 2);
  thing(ctx, lx - 7, ly - 7, 15, 15, (l) => {
    l.ellipse(7.5, 7.5, 7, 7, L_.metal);
    l.ellipse(7.5, 7.5, 5.5, 5.5, '#9fe7ff');
  });
  rect(ctx, L_.white, lx - 3, ly - 3, 2, 1);
  rect(ctx, L_.white, lx - 3, ly - 2, 1, 1);
  // the soldering kit
  thing(ctx, 104, 74, 12, 8, (l) => {
    l.ellipse(6, 4, 5, 3, '#cf4a4a');
    l.ellipse(6, 4, 2, 1.2, L_.metal);
  });
  rect(ctx, '#c84a4a', 8, 82, 10, 2);
  rect(ctx, L_.metal, 18, 82, 6, 1);
}

function sceneConnect(ctx: CanvasRenderingContext2D, t: number): void {
  // Connecting: it pushes the cable into the Flipper's port.
  lab(ctx, t, { lamp: 'right', shelf: false });
  // pegboard with tools
  rect(ctx, '#2b3159', 52, 4, 44, 34);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++) rect(ctx, '#1d2244', 55 + i * 6, 7 + j * 6, 1, 1);
  rect(ctx, '#d84a6a', 60, 8, 2, 16);
  rect(ctx, L_.metal, 66, 8, 2, 12);
  rect(ctx, '#d84a6a', 76, 10, 6, 2);
  rect(ctx, '#d84a6a', 78, 12, 2, 12);
  plant(ctx, 6, 30, t);
  const cyc = t % 2400;
  const push = Math.min(1, cyc / 1300);
  const plugged = cyc > 1300;
  sit(ctx, 8 + push * 6, { eye: 'focus', look: [1, 0.6], mouth: plugged ? 'grin' : 'closed', front: [56, 54], frontElbow: [46, 58], back: [50, 58] }, false);
  deskTop(ctx);
  flipperDevice(ctx, 90, 62, plugged, t);
  // the cable, from the desk to its hand, the plug at the port
  const px = plugged ? 82 : 76 + push * 4;
  for (let i = 0; i < 18; i++) rect(ctx, L_.cable, 70 - i * 0.4, 72 + i * 0.5 + Math.sin(i / 3) * 1.5, 2, 1);
  cableEnd(ctx, px, 66, 'usb');
  if (plugged && cyc < 1700) {
    sparkle(ctx, 90, 64, PALETTE.amber);
    sparkle(ctx, 88, 72, L_.white, 1);
  }
}

function sceneTransfer(ctx: CanvasRenderingContext2D, t: number): void {
  // Transferring: from one computer to the other, blocks travel the wire.
  lab(ctx, t, { shelf: true, poster: 124 });
  crt(ctx, 98, 46, t, 'folder');
  crt(ctx, 58, 46, t, 'send');
  // the arrow of blocks between the screens, moving
  const off = tick(t, 110) % 3;
  for (let i = 0; i < 4; i++) rect(ctx, L_.code1, 95 + i * 3 - off, 40, 2, 3);
  rect(ctx, L_.code1, 107, 39, 1, 5);
  rect(ctx, L_.code1, 108, 40, 1, 3);
  sit(ctx, -6, { eye: blinking(t) ? 'blink' : 'open', look: [1, 0.5], mouth: 'smile', front: [56, 60], frontElbow: [46, 58], back: [48, 62] }, false);
  deskTop(ctx);
  keyboard(ctx, 50, 77);
  for (let i = 0; i < 18; i++) rect(ctx, L_.cable, 88 + i * 1.2, 82 + Math.sin(i / 3) * 1.2, 2, 1);
}

function sceneSuccess(ctx: CanvasRenderingContext2D, t: number): void {
  // It worked: arms up, eyes shut with joy, the screen says yes.
  lab(ctx, t, { poster: null });
  crt(ctx, 92, 46, t, 'check');
  const up = tick(t, 300) % 2;
  sit(ctx, 26, { eye: 'happy', mouth: 'open', blush: true, front: up ? [47, 3] : [48, 7], frontBehind: true, back: up ? [6, 3] : [5, 7] }, false, Math.abs(Math.sin((t / 600) * Math.PI)) * 4);
  deskTop(ctx);
  pcb(ctx, 30, 76, 38);
  rect(ctx, '#c84a4a', 6, 81, 10, 2);
  for (let i = 0; i < 4; i++) {
    const on = (tick(t, 250) + i) % 3 !== 0;
    if (on) sparkle(ctx, [16, 82, 24, 74][i]!, [30, 26, 54, 50][i]!, i % 2 ? PALETTE.amber : PALETTE.pink, 2);
  }
  mark(ctx, 20, 18 + (up ? 0 : 1), '!', PALETTE.pink);
  mark(ctx, 84, 16 + (up ? 1 : 0), '!', PALETTE.pink);
}

function sceneWarning(ctx: CanvasRenderingContext2D, t: number): void {
  // A warning: the screen blinks "!", it scratches its head, worried.
  lab(ctx, t, { poster: 112 });
  crt(ctx, 10, 46, t, 'alert');
  const scratch = tick(t, 180) % 2;
  sit(ctx, 66, { eye: 'open', look: [1, -0.4], brow: 'worried', mouth: 'frown', sweat: true, back: [6, scratch ? 4 : 7], backElbow: [2, 34] }, true);
  deskTop(ctx);
  keyboard(ctx, 36, 77);
  mark(ctx, 52, 22, '?', PALETTE.amber);
}

function sceneMad(ctx: CanvasRenderingContext2D, t: number): void {
  // An error: arms crossed, cross brows; outside, the rain.
  rect(ctx, L_.brick, 0, 0, SCREEN_W, DESK_Y);
  for (let y = 0; y < DESK_Y; y += 6) {
    rect(ctx, L_.brickDark, 0, y, SCREEN_W, 1);
    for (let x = (y / 6) % 2 ? 0 : 6; x < SCREEN_W; x += 12) rect(ctx, L_.brickDark, x, y, 1, 6);
  }
  // the window: night, rain, the city
  rect(ctx, '#3b2a2a', 84, 4, 48, 58);
  rect(ctx, L_.night, 87, 7, 42, 52);
  for (let i = 0; i < 6; i++) {
    const h = 12 + Math.round(rnd(i) * 22);
    rect(ctx, '#0d1430', 88 + i * 7, 59 - h, 6, h);
    for (let w = 0; w < 4; w++) if (rnd(i * 9 + w) > 0.5) rect(ctx, L_.cityLit, 89 + i * 7 + (w % 2) * 3, 59 - h + 3 + Math.floor(w / 2) * 4, 1, 1);
  }
  for (let i = 0; i < 14; i++) {
    const y = ((t / 18 + rnd(i) * 60) % 52) + 7;
    rect(ctx, L_.rain, 88 + rnd(i + 3) * 40, y, 1, 3);
  }
  rect(ctx, '#3b2a2a', 107, 4, 2, 58);
  plant(ctx, 92, 48, t);
  const huff = tick(t, 700) % 2;
  sit(ctx, 20, { eye: 'focus', look: [1, -0.2], brow: 'mad', mouth: 'frown', front: [40, 52], frontElbow: [48, 58], back: [44, 56], backElbow: [30, 60] }, false, huff);
  deskTop(ctx);
  mug(ctx, 68, 70, t, false);
  // the anger mark, pulsing
  if (tick(t, 300) % 2 === 0) {
    rect(ctx, PALETTE.pink, 12, 20, 5, 1);
    rect(ctx, PALETTE.pink, 14, 18, 1, 5);
    rect(ctx, PALETTE.pink, 10, 24, 1, 3);
    rect(ctx, PALETTE.pink, 18, 16, 1, 3);
  }
}

function sceneDisconnected(ctx: CanvasRenderingContext2D, t: number): void {
  // The link dropped: a cable end in each flipper, it looks from one to the other.
  lab(ctx, t, { poster: 92 });
  // the device poster: a little robot on a sheet
  rect(ctx, '#d9d2bf', 90, 18, 12, 14);
  rect(ctx, '#3d4a66', 94, 21, 4, 4);
  rect(ctx, '#3d4a66', 95, 25, 2, 4);
  const look = t % 3000 < 1500;
  const o = sit(ctx, 34, { eye: 'open', look: look ? [1, 1] : [-0.6, 1], brow: 'worried', mouth: 'frown', front: [52, 54], frontElbow: [48, 60], back: [10, 54], backElbow: [12, 62] }, false);
  deskTop(ctx);
  thing(ctx, 104, 70, 26, 12, (l) => l.rect(1, 1, 24, 10, '#3d4148'));
  const f = at(o, [52, 50]);
  const b = at(o, [10, 50]);
  cableEnd(ctx, f[0] - 2, f[1] - 2 + (tick(t, 500) % 2), 'micro');
  cableEnd(ctx, b[0] - 6, b[1] - 2, 'usb', true);
  for (let i = 0; i < 10; i++) {
    rect(ctx, L_.cable, f[0] + 1 - i * 0.2, f[1] + 5 + i * 1.6, 2, 1);
    rect(ctx, L_.cable, b[0] - 2 + i * 0.2, b[1] + 5 + i * 1.6, 2, 1);
  }
  mark(ctx, 92, 4 + (tick(t, 600) % 2), '?', PALETTE.pink);
}

function sceneAsleep(ctx: CanvasRenderingContext2D, t: number): void {
  // Nothing connected: its head on the desk, under the lamp, asleep.
  lab(ctx, t, { lamp: 'right', poster: null });
  crt(ctx, 8, 46, t, 'dark');
  const breathe = tick(t, 1500) % 2;
  // slumped down, its chin on its folded flippers
  sit(ctx, 60, { eye: 'closed', mouth: 'smile', front: [46, 46], frontElbow: [52, 50], back: [36, 47], backElbow: [28, 52] }, true, -14 + breathe);
  deskTop(ctx);
  keyboard(ctx, 12, 77);
  mug(ctx, 40, 70, t, true);
  zzz(ctx, 100, 36, t);
}


// ----------------------------------------------------- props for the tools

/** A small board with an antenna, held up: a BLE thing under study. */
function bleBoard(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  thing(ctx, x, y, 10, 9, (l) => l.rect(1, 2, 8, 6, L_.pcb));
  rect(ctx, L_.chip, x + 3, y + 4, 3, 2);
  rect(ctx, L_.gold, x + 7, y, 1, 3);
  const w = tick(t, 250) % 3;
  for (let k = 0; k <= w; k++) {
    rect(ctx, L_.code1, x + 10 + k * 2, y - 2 - k, 1, 3 + k * 2);
  }
}

function reader(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, on: boolean): void {
  thing(ctx, x, y, 30, 10, (l) => {
    l.rect(1, 2, 28, 7, '#2c3038');
    l.rect(3, 1, 24, 2, '#3a3f48');
  });
  // the antenna spiral, glowing when a card is near
  const c = on ? L_.code1 : '#2f6e7a';
  rect(ctx, c, x + 8, y + 3, 12, 1);
  rect(ctx, c, x + 8, y + 3, 1, 4);
  rect(ctx, c, x + 8, y + 6, 10, 1);
  rect(ctx, c, x + 17, y + 4, 1, 3);
  rect(ctx, c, x + 11, y + 4, 6, 1);
  rect(ctx, on && tick(t, 200) % 2 ? '#5cff7a' : '#1e5a2a', x + 24, y + 5, 2, 2);
}

function rfidCard(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 16, 11, (l) => l.rect(1, 1, 14, 9, '#fbf8f2'));
  // the lab's orange dolphin on the card
  rect(ctx, PALETTE.body, x + 6, y + 3, 5, 2);
  rect(ctx, PALETTE.body, x + 5, y + 5, 3, 2);
  rect(ctx, PALETTE.body, x + 9, y + 2, 2, 1);
}

function oldTv(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  thing(ctx, x, y, 40, 32, (l) => {
    l.rect(1, 1, 38, 27, '#6b6f78');
    l.rect(1, 25, 38, 3, '#4f535b');
    l.rect(8, 28, 4, 3, '#4f535b');
    l.rect(28, 28, 4, 3, '#4f535b');
  });
  // color bars, a roll of interference now and then
  const bars = ['#f2f0e9', '#f2d24a', '#4de2ff', '#79d98a', '#ff6fae', '#e85d4a', '#4a6ae8'];
  const roll = tick(t, 2400) % 3 === 0 ? (t % 2400) / 40 : -10;
  bars.forEach((c, i) => rect(ctx, c, x + 4 + i * 4, y + 4, 4, 19));
  if (roll >= 0) rect(ctx, '#ffffff', x + 4, y + 4 + (Math.round(roll) % 19), 28, 1);
  rect(ctx, '#2a2d33', x + 33, y + 6, 4, 4);
  rect(ctx, '#2a2d33', x + 33, y + 13, 4, 4);
}

function remote(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  thing(ctx, x, y, 16, 7, (l) => l.rect(1, 1, 14, 5, '#33363d'));
  rect(ctx, PALETTE.red, x + 13, y + 2, 2, 2);
  for (let i = 0; i < 4; i++) rect(ctx, '#8a8f99', x + 3 + i * 2, y + 3, 1, 1);
}

function printer(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): number {
  thing(ctx, x, y, 36, 20, (l) => {
    l.rect(1, 4, 34, 15, L_.beige);
    l.rect(4, 1, 28, 4, L_.beigeDark);
    l.rect(1, 15, 34, 4, L_.beigeDark);
  });
  rect(ctx, PALETTE.green, x + 28, y + 8, 3, 2);
  // the paper coming out, line by line
  const out = (t / 40) % 30;
  return out;
}

function printout(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  thing(ctx, x, y, w + 2, h + 2, (l) => l.rect(1, 1, w, h, '#fbf8f2'));
  for (let i = 0; i < 4; i++) rect(ctx, '#3d4a66', x + 4 + i * 3, y + 10 - i * 2, 2, 3 + i * 2);
  for (let i = 0; i < Math.floor((h - 14) / 3); i++) rect(ctx, '#9aa3b5', x + 3, y + 15 + i * 3, w - 6 - (i % 3) * 3, 1);
  rect(ctx, '#3d6ae8', x + w - 8, y + h - 9, 5, 5);
  rect(ctx, '#fbf8f2', x + w - 6, y + h - 9, 3, 2);
}

function floppyDisk(ctx: CanvasRenderingContext2D, x: number, y: number, c: string): void {
  thing(ctx, x, y, 12, 12, (l) => {
    l.rect(1, 1, 10, 10, c);
    l.rect(3, 1, 6, 3, L_.metal);
    l.rect(3, 6, 6, 5, '#fbf8f2');
  });
  rect(ctx, PALETTE.amber, x + 4, y + 8, 4, 1);
}

function floppyBox(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const cols = ['#e85d75', '#3d6ae8', '#f2d24a', '#79d98a', '#b48cff', '#4de2ff'];
  cols.forEach((c, i) => rect(ctx, c, x + 3 + i * 4, y - 4 - (i % 2), 3, 7));
  thing(ctx, x, y, 30, 14, (l) => l.rect(1, 1, 28, 12, '#d9b67a'));
  rect(ctx, '#fbf8f2', x + 8, y + 5, 14, 4);
  rect(ctx, PALETTE.amber, x + 10, y + 6, 10, 2);
}

function drive(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  thing(ctx, x, y, 36, 20, (l) => {
    l.rect(1, 1, 34, 18, L_.beige);
    l.rect(1, 15, 34, 4, L_.beigeDark);
  });
  rect(ctx, '#2a2d33', x + 6, y + 6, 18, 3);
  rect(ctx, tick(t, 180) % 2 ? PALETTE.red : '#5a2020', x + 28, y + 6, 3, 2);
}

function solderingIron(ctx: CanvasRenderingContext2D, x: number, y: number, flip = false): void {
  thing(
    ctx,
    x,
    y,
    18,
    8,
    (l) => {
      l.capsule([1.5, 4], [9, 4], 2, '#c84a4a');
      l.rect(10, 3, 5, 2, L_.metal);
      l.set(15, 4, '#ffb057');
      l.set(16, 4, '#ffb057');
    },
    flip,
  );
}

function wires(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, t: number): void {
  const cols = ['#e85d4a', '#f2d24a', '#4de2ff', '#79d98a'];
  cols.forEach((c, i) => {
    const h = 10 + i * 3 + Math.round(Math.sin(t / 900 + i) * 0.5);
    for (let k = 0; k <= 20; k++) {
      const u = k / 20;
      rect(ctx, c, x0 + i * 2 + (x1 - x0) * u, y - Math.sin(u * Math.PI) * h, 1, 1);
    }
  });
}

function smoke(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  for (let i = 0; i < 6; i++) {
    const p = (((t / 1400 + i / 6) % 1) + 1) % 1;
    rect(ctx, '#c9ced6', x + Math.round(Math.sin(p * 7 + i) * 2.5), y - p * 26, 1, 2);
  }
}

// --------------------------------------------------------- tool scenes

function sceneBoot(ctx: CanvasRenderingContext2D, t: number): void {
  // Switched on: arms up, the computer boots with the dolphin.
  lab(ctx, t, { lamp: 'right', poster: 32 });
  crt(ctx, 86, 44, t, 'boot');
  const up = tick(t, 320) % 2;
  sit(ctx, 6, { eye: 'happy', mouth: 'open', blush: true, front: up ? [47, 3] : [48, 7], frontBehind: true, back: up ? [6, 3] : [5, 7] }, false, t < 500 ? Math.sin((t / 500) * Math.PI) * 4 : 0);
  deskTop(ctx);
  keyboard(ctx, 60, 77);
  mug(ctx, 4, 70, t);
  if (tick(t, 260) % 2) {
    rect(ctx, PALETTE.pink, 60, 18, 1, 3);
    rect(ctx, PALETTE.pink, 64, 22, 3, 1);
    rect(ctx, PALETTE.pink, 56, 14, 2, 1);
  }
}

function sceneBluetooth(ctx: CanvasRenderingContext2D, t: number): void {
  // A BLE scan: headphones on, a small board held up to listen to, the screen shows the waves.
  lab(ctx, t, { poster: 112 });
  crt(ctx, 84, 42, t, 'bt');
  const o = sit(ctx, 8, { eye: blinking(t) ? 'blink' : 'focus', look: [1, 0.8], mouth: 'smile', headphones: true, front: [52, 50], frontElbow: [48, 58], back: [44, 54], backElbow: [32, 60] }, false);
  const h = at(o, [52, 50]);
  bleBoard(ctx, h[0] - 4, h[1] - 9, t);
  deskTop(ctx);
  rect(ctx, '#c84a6a', 4, 79, 14, 4);
  rect(ctx, L_.metal, 116, 81, 6, 2);
}

function sceneRfid(ctx: CanvasRenderingContext2D, t: number): void {
  // Reading an RFID / NFC / iButton capture: a card held over the reader.
  lab(ctx, t, { lamp: 'right', shelf: false });
  rect(ctx, '#2b3159', 60, 4, 40, 32);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) rect(ctx, '#1d2244', 63 + i * 6, 7 + j * 6, 1, 1);
  rect(ctx, '#d84a6a', 68, 8, 2, 16);
  rect(ctx, L_.metal, 74, 8, 2, 12);
  rect(ctx, '#d84a6a', 84, 10, 6, 2);
  plant(ctx, 4, 30, t);
  const hover = Math.round(Math.sin(t / 500) * 2);
  const o = sit(ctx, 10, { eye: 'focus', look: [1, 0.8], mouth: 'smile', front: [58, 50 + hover], frontElbow: [50, 58], back: [44, 58] }, false);
  deskTop(ctx);
  reader(ctx, 92, 72, t, true);
  const h = at(o, [58, 50 + hover]);
  rfidCard(ctx, h[0] - 2, h[1] - 8);
}

function sceneInfrared(ctx: CanvasRenderingContext2D, t: number): void {
  // Reading an IR capture: it points the remote at the old TV.
  lab(ctx, t, { poster: 50 });
  oldTv(ctx, 92, 42, t);
  const press = tick(t, 700) % 2;
  const o = sit(ctx, 2, { eye: 'open', look: [1, 0.2], mouth: 'smile', front: [56, 46 - press], frontElbow: [50, 56], back: [40, 62] }, false);
  deskTop(ctx);
  const h = at(o, [56, 46 - press]);
  remote(ctx, h[0] - 4, h[1] - 4);
  if (press) {
    for (let i = 0; i < 3; i++) rect(ctx, PALETTE.red, h[0] + 14 + i * 5, h[1] - 3 - i, 2, 1);
    sparkle(ctx, h[0] + 12, h[1] - 2, '#ff8a80', 1);
  }
  thing(ctx, 76, 74, 14, 8, (l) => l.rect(1, 1, 12, 6, '#7d522c'));
}

function sceneUart(ctx: CanvasRenderingContext2D, t: number): void {
  // GPIO / UART: wires from the board to the breakout, the terminal answers.
  lab(ctx, t, { poster: 92 });
  crt(ctx, 92, 42, t, 'uart');
  sit(ctx, 6, { eye: blinking(t, 3900) ? 'blink' : 'focus', look: [1, 1], mouth: 'smile', front: [50, 60], frontElbow: [46, 56], back: [36, 62] }, false, -2);
  deskTop(ctx);
  pcb(ctx, 30, 76, 40);
  wires(ctx, 52, 82, 77, t);
  thing(ctx, 80, 74, 12, 8, (l) => l.rect(1, 1, 10, 6, '#3d4148'));
  solderingIron(ctx, 10, 82);
  thing(ctx, 108, 76, 20, 7, (l) => l.rect(1, 1, 18, 5, '#2a2d33'));
}

function sceneBackup(ctx: CanvasRenderingContext2D, t: number): void {
  // Copying to the library: a floppy filed into the box, one after the other.
  lab(ctx, t, { poster: 120 });
  drive(ctx, 96, 60, t);
  const cyc = t % 1800;
  const down = Math.min(1, Math.max(0, (cyc - 900) / 600));
  const o = sit(ctx, 6, { eye: 'open', look: [1, 0.6], mouth: 'smile', front: [56, 44 + down * 14], frontElbow: [50, 56], back: [44, 58] }, false);
  deskTop(ctx);
  floppyBox(ctx, 62, 70);
  const h = at(o, [56, 44 + down * 14]);
  const colors = ['#3d6ae8', '#e85d75', '#79d98a'];
  if (cyc < 1500) floppyDisk(ctx, h[0] - 3, h[1] - 10, colors[tick(t, 1800) % 3]!);
}

function sceneRepair(ctx: CanvasRenderingContext2D, t: number): void {
  // Writing to the device, or trying a fix: goggles on, soldering the board.
  lab(ctx, t, { lamp: 'right', poster: 28 });
  const touch = tick(t, 500) % 2;
  const o = sit(ctx, 2, { eye: 'focus', look: [1, 1], mouth: 'closed', goggles: true, front: [52, 64 - touch], frontElbow: [48, 54], back: [36, 64] }, false, -2);
  deskTop(ctx);
  pcb(ctx, 30, 76, 54);
  const h = at(o, [52, 64 - touch]);
  solderingIron(ctx, h[0] - 4, h[1] - 6);
  if (touch) smoke(ctx, h[0] + 12, h[1] - 4, t);
  thing(ctx, 100, 70, 18, 12, (l) => {
    l.rect(1, 8, 16, 3, '#2c3038');
    l.capsule([4, 8], [14, 1], 1.4, L_.metal);
  });
  thing(ctx, 120, 74, 12, 8, (l) => {
    l.ellipse(6, 4, 5, 3, '#cf4a4a');
    l.ellipse(6, 4, 2, 1.2, L_.metal);
  });
}

function sceneReport(ctx: CanvasRenderingContext2D, t: number): void {
  // A report is out: the printout held up, the printer still going.
  lab(ctx, t, { poster: 30 });
  const out = printer(ctx, 96, 60, t);
  for (let i = 0; i < 3; i++) rect(ctx, '#fbf8f2', 102, 60 - out / 3 + i, 22, 1);
  sit(ctx, 2, { eye: 'happy', mouth: 'open', blush: true, front: [50, 44], frontElbow: [48, 58], back: [38, 50], backElbow: [28, 58] }, false);
  printout(ctx, 44, 30, 22, 50);
  deskTop(ctx);
  thing(ctx, 4, 76, 22, 6, (l) => l.rect(1, 1, 20, 4, '#fbf8f2'));
}

function sceneShutdown(ctx: CanvasRenderingContext2D, t: number): void {
  // Switching off: night outside, a wave to us, a flipper on the power button.
  lab(ctx, t, { shelf: false, plants: false });
  rect(ctx, '#3b2a2a', 4, 4, 44, 50);
  rect(ctx, L_.night, 6, 6, 40, 46);
  for (let i = 0; i < 5; i++) {
    const h = 10 + Math.round(rnd(i + 20) * 18);
    rect(ctx, '#0d1430', 7 + i * 8, 52 - h, 7, h);
    for (let w = 0; w < 3; w++) if (rnd(i * 7 + w) > 0.4) rect(ctx, L_.cityLit, 8 + i * 8 + w * 2, 52 - h + 3 + w * 3, 1, 1);
  }
  rect(ctx, '#fff3b0', 36, 10, 4, 4);
  rect(ctx, L_.night, 35, 9, 2, 2);
  for (let i = 0; i < 6; i++) rect(ctx, '#ffffff', 8 + rnd(i + 40) * 36, 8 + rnd(i + 50) * 10, 1, 1);
  plant(ctx, 50, 62, t);
  crt(ctx, 96, 44, t, 'dash');
  const wave = tick(t, 200) % 2;
  sit(ctx, 40, { eye: 'happy', mouth: 'open', front: [58, 58], frontElbow: [52, 60], back: wave ? [1, 12] : [3, 18], backElbow: [3, 38] }, false);
  deskTop(ctx);
  mug(ctx, 16, 70, t, false);
  rect(ctx, PALETTE.red, 99, 73, 3, 2);
}

/**
 * The scene for an animation. What it is about picks among the scenes:
 * an IR capture is read at the old TV, an NFC one at the card reader, a
 * BLE scan with the little board; a copy to the library is filed in the
 * floppy box; a report done is a printout.
 */
export function drawCompanionScene(ctx: CanvasRenderingContext2D, scene: SceneName, t: number, subject: Subject | null = null): void {
  const tool = subject?.tool ?? '';
  const topic = subject?.topic ?? '';
  switch (scene) {
    case 'none':
      return rect(ctx, '#000', 0, 0, SCREEN_W, SCREEN_H);
    case 'shutdown':
      return sceneShutdown(ctx, t);
    case 'idle':
      return sceneCoding(ctx, t);
    case 'wait':
      return sceneAsleep(ctx, t);
    case 'greet':
      return sceneBoot(ctx, t);
    case 'search':
      return tool.startsWith('ble.') ? sceneBluetooth(ctx, t) : sceneScan(ctx, t);
    case 'connect':
      return sceneConnect(ctx, t);
    case 'read':
      if (topic === 'ir') return sceneInfrared(ctx, t);
      if (topic === 'nfc' || topic === 'rfid' || topic === 'ibutton') return sceneRfid(ctx, t);
      if (topic === 'subghz') return sceneScan(ctx, t);
      if (tool === 'flipper.gpio') return sceneUart(ctx, t);
      return sceneAnalyze(ctx, t);
    case 'transfer':
      if (tool === 'flipper.copy') return sceneBackup(ctx, t);
      if (tool === 'flipper.write') return sceneRepair(ctx, t);
      return sceneTransfer(ctx, t);
    case 'success':
      return tool === 'lab.report' ? sceneReport(ctx, t) : sceneSuccess(ctx, t);
    case 'warning':
      return sceneWarning(ctx, t);
    case 'error':
      // cross first, then it tries a fix
      return t < 3500 ? sceneMad(ctx, t) : sceneRepair(ctx, t - 3500);
    case 'disconnect':
      return sceneDisconnected(ctx, t);
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

/** The companion of Flipper Lab: the little dolphin at its desk, and its scenes. */
export const COMPANION: SpriteSet = { id: 'flipper-lab-companion', drawScene: drawCompanionScene, drawSplash: drawCompanionSplash };
/** Older name, kept for imports. */
export const DOLPHIN = COMPANION;
