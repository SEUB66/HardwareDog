/**
 * HARDWARE DOG / TV SPRITES — THE PIXEL DOLPHIN
 *
 * What plays inside the TV screen, drawn on a small canvas (136 x 100
 * pixels, scaled up without smoothing). The dolphin is built from simple
 * shapes and an outline pass, so every pose (tail up or down, fin raised,
 * mouth open, eyes shut) stays in one consistent style; props (USB plug,
 * magnifier, data blocks, check, cross) are tiny pixel grids.
 *
 * A SpriteSet is replaceable: a Hardware Dog TV with the dog would supply
 * its own `drawScene` and `drawSplash`, and nothing in the engine changes.
 * Every frame is a pure function of (animation, time): remounting the TV
 * (another section, a detached window) resumes, it never restarts.
 */

import type { Anim } from '../../core/lab/companion';

export const SCREEN_W = 136;
export const SCREEN_H = 100;

export const PALETTE = {
  bg: '#071015',
  bgLine: '#0d1d24',
  outline: '#1d0f07',
  body: '#ff8a1e',
  shade: '#d8600d',
  light: '#ffb862',
  belly: '#ffe5bd',
  eye: '#120804',
  white: '#fffaf0',
  pink: '#ff4fa3',
  cyan: '#00e5ff',
  cyanDim: '#0a6f7d',
  cream: '#f2f0e9',
  green: '#79d98a',
  amber: '#e4b04a',
  red: '#ff5f56',
  metal: '#b9bcbf',
} as const;

type Color = keyof typeof PALETTE;

export interface SpriteSet {
  id: string;
  drawScene(ctx: CanvasRenderingContext2D, anim: Anim, t: number): void;
  drawSplash(ctx: CanvasRenderingContext2D, t: number): void;
}

// ------------------------------------------------------------- dolphin

export interface Pose {
  /** -1 (flukes down) .. 1 (flukes up) */
  tail: number;
  mouth: boolean;
  fin: 'down' | 'up';
  blink: boolean;
  /** Head lowered, tail limp (error). */
  droop: boolean;
}

interface Sprite {
  w: number;
  h: number;
  px: (Color | null)[];
}

const DW = 38;
const DH = 26;

function inTriangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]): boolean {
  const s = (p: [number, number], q: [number, number], r: [number, number]) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p: [number, number] = [px + 0.5, py + 0.5];
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const cache = new Map<string, Sprite>();

/** The dolphin in a pose, as a pixel grid (cached). Facing right. */
export function dolphin(pose: Pose): Sprite {
  const key = `${pose.tail.toFixed(1)}|${pose.mouth}|${pose.fin}|${pose.blink}|${pose.droop}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const px: (Color | null)[] = new Array(DW * DH).fill(null);
  const set = (x: number, y: number, c: Color) => {
    if (x >= 0 && y >= 0 && x < DW && y < DH) px[y * DW + x] = c;
  };
  const get = (x: number, y: number) => (x >= 0 && y >= 0 && x < DW && y < DH ? px[y * DW + x] : null);

  const x0 = 6;
  const x1 = 32;
  const tailLift = pose.droop ? -1.5 : pose.tail * 2.2;
  const center = (u: number) => 14 - 1.4 * Math.sin(u * Math.PI) - (u < 0.32 ? tailLift * (1 - u / 0.32) : 0) + (pose.droop && u > 0.7 ? (u - 0.7) * 4 : 0);
  const half = (u: number) => {
    if (u < 0.3) return 4.4 * (0.22 + (u / 0.3) * 0.58);
    if (u < 0.8) return 4.4 * (0.8 + 0.2 * Math.sin(((u - 0.3) / 0.5) * (Math.PI / 2)));
    return 4.4 * Math.sqrt(Math.max(0.28, 1 - ((u - 0.8) / 0.2) ** 2 * 0.72));
  };
  const top = (u: number) => center(u) - half(u) * 1.05;
  const bot = (u: number) => center(u) + half(u) * 0.9;
  const uOf = (x: number) => (x - x0) / (x1 - x0);

  // body
  for (let x = x0; x <= x1; x++) {
    const u = uOf(x);
    for (let y = Math.round(top(u)); y <= Math.round(bot(u)); y++) {
      const belly = y > center(u) + 0.8 && u > 0.22;
      set(x, y, belly ? 'belly' : 'body');
    }
  }
  // rostrum (beak) and mouth
  const by = Math.round(center(1)) + 1;
  for (let x = x1 + 1; x <= x1 + 3; x++) set(x, by, 'body');
  for (let x = x1 + 1; x <= x1 + 2; x++) set(x, by + 1 + (pose.mouth ? 1 : 0), 'belly');
  // dorsal fin, leaning back
  const fu = uOf(17);
  const ft = Math.round(top(fu));
  const fin: [[number, number], [number, number], [number, number]] = [
    [15, ft + 1],
    [21, ft + 1],
    [14, ft - 5],
  ];
  for (let y = ft - 6; y <= ft + 1; y++) for (let x = 12; x <= 22; x++) if (inTriangle(x, y, ...fin)) set(x, y, 'body');
  // pectoral fin: down, or raised (the salute)
  const pu = uOf(22);
  const pb = Math.round(bot(pu));
  const pc = Math.round(center(pu));
  const pect: [[number, number], [number, number], [number, number]] =
    pose.fin === 'up'
      ? [
          [21, pc],
          [24, pc],
          [26, pc - 7],
        ]
      : [
          [20, pb - 1],
          [24, pb - 1],
          [18, pb + 3],
        ];
  for (let y = 0; y < DH; y++) for (let x = 14; x <= 30; x++) if (inTriangle(x, y, ...pect)) set(x, y, pose.fin === 'up' ? 'shade' : 'body');
  // flukes
  const ty = Math.round(center(0));
  const up: [[number, number], [number, number], [number, number]] = [
    [x0 + 1, ty],
    [x0 - 1, ty],
    [1, ty - 4 - Math.round(tailLift)],
  ];
  const down: [[number, number], [number, number], [number, number]] = [
    [x0 + 1, ty + 1],
    [x0 - 1, ty + 1],
    [1, ty + 4 - Math.round(tailLift)],
  ];
  for (let y = 0; y < DH; y++) for (let x = 0; x <= x0 + 1; x++) if (inTriangle(x, y, ...up) || inTriangle(x, y, ...down)) set(x, y, 'body');

  // highlight along the back, shade on the tail stock
  for (let x = x0 + 8; x <= x1 - 4; x++) {
    const u = uOf(x);
    const y = Math.round(top(u));
    if (get(x, y) === 'body') set(x, y + 1, 'light');
  }
  for (let x = x0; x <= x0 + 6; x++) {
    const y = Math.round(bot(uOf(x)));
    if (get(x, y) === 'body') set(x, y, 'shade');
  }

  // outline: every empty pixel touching the dolphin
  const filled = px.map((c) => c !== null);
  for (let y = 0; y < DH; y++)
    for (let x = 0; x < DW; x++) {
      if (filled[y * DW + x]) continue;
      const near = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const nx = x + dx!;
        const ny = y + dy!;
        return nx >= 0 && ny >= 0 && nx < DW && ny < DH && filled[ny * DW + nx];
      });
      if (near) px[y * DW + x] = 'outline';
    }

  // eye, cheek (brand pink), open mouth line
  const ex = Math.round(x0 + (x1 - x0) * 0.86);
  const ey = Math.round(center(0.86)) - 1;
  if (pose.blink) {
    set(ex, ey + 1, 'outline');
    set(ex + 1, ey + 1, 'outline');
  } else {
    set(ex, ey, 'eye');
    set(ex + 1, ey, 'eye');
    set(ex, ey + 1, 'eye');
    set(ex + 1, ey + 1, 'eye');
    set(ex, ey, 'white');
  }
  set(ex - 1, ey + 3, 'pink');
  if (pose.mouth) for (let x = x1 - 1; x <= x1 + 3; x++) set(x, by + 1, 'outline');

  const sprite = { w: DW, h: DH, px };
  cache.set(key, sprite);
  return sprite;
}

/** Draw a sprite, optionally rotated about its center and mirrored, pixel-exact; `k` canvas pixels per sprite pixel. */
export function drawSprite(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, angle = 0, flip = false, k = 1): void {
  const cx = s.w / 2;
  const cy = s.h / 2;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const reach = Math.ceil(Math.hypot(s.w, s.h) / 2);
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      const sx0 = dx * cos - dy * sin;
      const sy0 = dx * sin + dy * cos;
      const sx = Math.floor((flip ? -sx0 : sx0) + cx);
      const sy = Math.floor(sy0 + cy);
      if (sx < 0 || sy < 0 || sx >= s.w || sy >= s.h) continue;
      const c = s.px[sy * s.w + sx];
      if (!c) continue;
      ctx.fillStyle = PALETTE[c];
      ctx.fillRect(Math.round(x + cx + dx) * k, Math.round(y + cy + dy) * k, k, k);
    }
}

// --------------------------------------------------------------- props

const PROP_COLORS: Record<string, Color> = { k: 'outline', c: 'cyan', d: 'cyanDim', m: 'metal', g: 'green', r: 'red', a: 'amber', w: 'cream', p: 'pink', o: 'body', b: 'belly' };

function grid(rows: string[]): Sprite {
  const w = Math.max(...rows.map((r) => r.length));
  const px: (Color | null)[] = [];
  for (const r of rows) for (let x = 0; x < w; x++) px.push(PROP_COLORS[r[x] ?? '.'] ?? null);
  return { w, h: rows.length, px };
}

export const PROPS = {
  magnifier: grid(['..kkkk...', '.kcwwck..', 'kcw..dck.', 'kc....ck.', 'kc....ck.', '.kcddck..', '..kkkkk..', '......kmk', '.......km']),
  plug: grid(['kkkkkk....', 'kccccckmmm', 'kcdcdckm.m', 'kccccckmmm', 'kkkkkk....']),
  socket: grid(['kkkkkkk', 'kmmmmmk', 'km...mk', 'km...mk', 'kmmmmmk', 'kkkkkkk']),
  check: grid(['.......g', '......gg', 'g....gg.', 'gg..gg..', '.gggg...', '..gg....']),
  cross: grid(['r...r', '.r.r.', '..r..', '.r.r.', 'r...r']),
  bang: grid(['aa', 'aa', 'aa', 'aa', '..', 'aa']),
  question: grid(['.www.', 'w...w', '...w.', '..w..', '.....', '..w..']),
  sparkle: grid(['..w..', '..w..', 'ww.ww', '..w..', '..w..']),
  heart: grid(['.p.p.', 'ppppp', 'ppppp', '.ppp.', '..p..']),
};

// ---------------------------------------------------------------- font

/** 5 x 7 pixel letters, for the splash. */
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
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export function pixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, shadow?: string, scale = 1): number {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] ?? FONT[' ']!;
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (g[r]![c] !== '#') continue;
        if (shadow) {
          ctx.fillStyle = shadow;
          ctx.fillRect(cx + c * scale + scale, y + r * scale + scale, scale, scale);
        }
        ctx.fillStyle = color;
        ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
      }
    cx += 6 * scale;
  }
  return cx - x;
}

export const pixelTextWidth = (text: string, scale = 1) => text.length * 6 * scale - scale;

// --------------------------------------------------------------- scenes

/** Scenes are drawn in art pixels, K canvas pixels each: a 68 x 50 stage. */
const K = 2;
const AW = SCREEN_W / K;
const AH = SCREEN_H / K;

const tick = (t: number, ms: number) => Math.floor(t / ms);

/** One art pixel rectangle. */
function rect(ctx: CanvasRenderingContext2D, c: Color, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = PALETTE[c];
  ctx.fillRect(Math.round(x) * K, Math.round(y) * K, w * K, h * K);
}

const put = (ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, angle = 0) => drawSprite(ctx, s, x, y, angle, false, K);

function background(ctx: CanvasRenderingContext2D, t: number, tint: string | null = null): void {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // a slow drift of dots, at screen resolution: the picture is never still
  ctx.fillStyle = PALETTE.bgLine;
  const drift = tick(t, 220) % 8;
  for (let y = 6; y < SCREEN_H; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < SCREEN_W; x += 8) ctx.fillRect((x + drift) % SCREEN_W, y, 1, 1);
  rect(ctx, 'cyanDim', 0, AH - 5, AW, 1);
  if (tint) {
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
    ctx.globalAlpha = 1;
  }
}

function bubbles(ctx: CanvasRenderingContext2D, t: number, x: number, y: number): void {
  for (let i = 0; i < 3; i++) {
    const p = (((t / 1500 + i / 3) % 1) + 1) % 1;
    rect(ctx, 'cyanDim', x + Math.sin(p * 6 + i) * 1.5, y - p * 16);
  }
}

const blinkAt = (t: number) => t % 3800 < 140;
const bob = (t: number, amp = 1.5) => Math.round(Math.sin(t / 420) * amp);
const pose = (p: Partial<Pose>): Pose => ({ tail: 0, mouth: false, fin: 'down', blink: false, droop: false, ...p });

function dataBlocks(ctx: CanvasRenderingContext2D, x: number, y: number, n: number): void {
  const colors: Color[] = ['cyan', 'pink', 'cream'];
  for (let i = 0; i < n; i++) {
    const bx = x + (i % 3) * 4;
    const by = y - Math.floor(i / 3) * 4;
    rect(ctx, colors[i % 3]!, bx, by, 3, 3);
    rect(ctx, 'outline', bx, by + 3, 3, 1);
  }
}

export function drawDolphinScene(ctx: CanvasRenderingContext2D, anim: Anim, t: number): void {
  const DX = 8;
  const DY = 12;
  switch (anim) {
    case 'none':
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      return;
    case 'idle':
      background(ctx, t);
      bubbles(ctx, t, DX + 38, DY + 8);
      put(ctx, dolphin(pose({ tail: Math.sin(t / 260) * 0.9, blink: blinkAt(t) })), DX + Math.round(Math.sin(t / 1900) * 4), DY + bob(t));
      return;
    case 'greet': {
      // a hop, then the salute: the fin waves
      background(ctx, t);
      const hop = Math.max(0, Math.sin(Math.min(1, t / 700) * Math.PI)) * 7;
      const wave = t <= 700 || tick(t, 180) % 2 === 0;
      put(ctx, dolphin(pose({ tail: 0.6, mouth: true, fin: wave ? 'up' : 'down' })), DX + 6, DY - Math.round(hop), t < 700 ? -0.25 * Math.sin((t / 700) * Math.PI) : 0);
      put(ctx, PROPS.heart, DX + 46, DY - 1 - (tick(t, 300) % 2));
      return;
    }
    case 'connect': {
      // carrying the USB plug to the socket, again and again
      background(ctx, t);
      put(ctx, PROPS.socket, AW - 9, DY + 9);
      const p = (t % 1600) / 1600;
      const reach = Math.round(Math.min(1, p * 1.6) * 8);
      put(ctx, dolphin(pose({ tail: Math.sin(t / 180), blink: blinkAt(t) })), DX - 6 + reach, DY + bob(t, 1));
      const plugX = DX + 32 + reach;
      put(ctx, PROPS.plug, plugX, DY + 11);
      for (let x = 1; x < plugX; x += 2) rect(ctx, 'cyan', x, DY + 19 + Math.round(Math.sin(x / 5 + t / 300)));
      if (p > 0.62) put(ctx, PROPS.sparkle, AW - 8, DY + 2);
      return;
    }
    case 'search': {
      // the magnifier sweeps; the dolphin holds it up
      background(ctx, t);
      put(ctx, dolphin(pose({ tail: Math.sin(t / 300) * 0.5, fin: 'up', blink: blinkAt(t) })), DX - 4, DY + bob(t, 1));
      put(ctx, PROPS.magnifier, DX + 40 + Math.round(Math.sin(t / 500) * 8), DY + 1 + Math.round(Math.cos(t / 500) * 2));
      return;
    }
    case 'read':
      // bytes come out as blocks and stack up
      background(ctx, t);
      put(ctx, dolphin(pose({ tail: Math.sin(t / 240) * 0.6, mouth: tick(t, 400) % 2 === 0, blink: blinkAt(t) })), DX - 6, DY + bob(t, 1));
      dataBlocks(ctx, AW - 14, AH - 10, (tick(t, 220) % 12) + 1);
      return;
    case 'transfer':
      // blocks travel left to right, pushed along
      background(ctx, t);
      put(ctx, dolphin(pose({ tail: Math.sin(t / 160) })), DX - 10, DY + bob(t, 1));
      for (let i = 0; i < 4; i++) {
        const x = Math.round(((t / 40 + i * 14) % 56) + 12);
        rect(ctx, i % 2 ? 'pink' : 'cyan', x, DY + 16 + (i % 2), 3, 3);
        rect(ctx, 'outline', x, DY + 19 + (i % 2), 3, 1);
      }
      return;
    case 'success': {
      background(ctx, t);
      const u = Math.min(1, t / 900);
      put(ctx, dolphin(pose({ tail: 1, mouth: true, fin: 'up' })), DX + Math.round(u * 8), DY - Math.round(Math.sin(u * Math.PI) * 9), -0.5 + u * 0.5);
      put(ctx, PROPS.check, AW - 12, 4);
      if (tick(t, 150) % 2) put(ctx, PROPS.sparkle, AW - 20, 10);
      return;
    }
    case 'warning':
      background(ctx, t, PALETTE.amber);
      put(ctx, dolphin(pose({ blink: blinkAt(t) })), DX, DY);
      if (tick(t, 400) % 2 === 0) put(ctx, PROPS.bang, DX + 30, DY - 6);
      return;
    case 'error':
      background(ctx, t, t < 500 ? PALETTE.red : null);
      put(ctx, dolphin(pose({ tail: -1, blink: true, droop: true })), DX, DY + 3, 0.18);
      put(ctx, PROPS.cross, DX + 34, DY - 5);
      return;
    case 'disconnect':
      // the plug lies apart from its socket; the dolphin looks at it
      background(ctx, t);
      put(ctx, PROPS.socket, AW - 9, DY + 9);
      put(ctx, PROPS.plug, AW - 24, DY + 23 + (tick(t, 500) % 2));
      put(ctx, dolphin(pose({ tail: -0.4, blink: blinkAt(t) })), DX - 4, DY + bob(t, 1));
      put(ctx, PROPS.question, DX + 28, DY - 6);
      return;
  }
}

export function drawDolphinSplash(ctx: CanvasRenderingContext2D, t: number): void {
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  // two lines, big letters coming up one by one, inside the curve of the glass
  const lines = ['FLIPPER', 'LAB'];
  let shown = Math.floor(t / 55) + 1;
  lines.forEach((line, i) => {
    const part = line.slice(0, Math.max(0, Math.min(line.length, shown)));
    shown -= line.length;
    pixelText(ctx, part, Math.round((SCREEN_W - pixelTextWidth(line, 2)) / 2), 18 + i * 20, PALETTE.body, PALETTE.outline, 2);
  });
  const w = pixelTextWidth('FLIPPER', 2);
  ctx.fillStyle = PALETTE.cyan;
  ctx.fillRect(Math.round((SCREEN_W - w) / 2), 56, Math.round(w * Math.min(1, t / 500)), 1);
  pixelText(ctx, 'HW DOG', Math.round((SCREEN_W - pixelTextWidth('HW DOG')) / 2), 64, PALETTE.cream);
}

export const DOLPHIN: SpriteSet = { id: 'pixel-dolphin', drawScene: drawDolphinScene, drawSplash: drawDolphinSplash };
