/**
 * HARDWARE DOG / THE DOG'S SCENES
 *
 * What plays inside the turquoise TV: Hardware Dog's robot dog, from the
 * owner's sheet (assets/brand/source/hd-companion-dog-sheet.png), cut and
 * brought to the 136 x 100 screen by web/scripts/build-dog-scenes.mjs,
 * nothing redrawn: cream panels, dark joints, cyan eyes and joints, the
 * collar and its USB tag, the workshop.
 *
 * The drawings come alive here:
 *   - the dog breathes (head and back one pixel lower, on a slow cycle),
 *     blinks, twitches an ear, from frames made from the drawing itself
 *   - what is around it moves: the terminal typed, the radio waves leaving
 *     the antenna, the router's LEDs and packets along the cable, a glint
 *     on the magnifier, the bars of the chart, the ? hopping, the play
 *     sign of the replay, the box's arrow...
 *   - at rest, the workshop monitor shows the section's sign (a terminal
 *     for SERIAL, a trident for USB...); now and then, when nothing runs
 *     and nothing serious is said, a value scrolls on it, or the dog lies
 *     down with a tune
 *
 * A section opened is a decor; an operation really started is an activity:
 * opening Bluetooth shows the Bluetooth sign on the monitor, only a scan
 * running shows the dog with its antenna. A success or an error plays
 * once (the engine holds it), then the scene at rest comes back.
 *
 * Every frame is a pure function of (scene, time): remounting the TV
 * resumes, it never restarts. Replacing the scenes is replacing this
 * SpriteSet; the engine stays.
 */

import type { Stage, Subject } from '../../core/lab/companion';
import atlasUrl from '../../../../assets/brand/web/hd-dog-scenes.webp';
import atlasJson from '../../../../assets/brand/web/hd-dog-scenes.json';
import { SCREEN_H, SCREEN_W, alpha, glint, led, pixelText, pixelTextWidth, pulse, rect, rnd, twinkle, type SceneName, type SpriteSet } from './sprites';

/** The dog's scenes, by their name on the sheet (the hero is the big scene in the TV). */
export const DOG_SCENE_IDS = ['hero', 'idle', 'usb', 'serial', 'bluetooth', 'network', 'camera', 'analyze', 'success', 'error', 'disconnected', 'replay', 'export'] as const;
export type DogSceneId = (typeof DOG_SCENE_IDS)[number];

interface AtlasScene {
  at: [number, number][];
  eyes: unknown[];
  ear: unknown;
}
const ATLAS = atlasJson as unknown as { frame: { w: number; h: number }; scenes: Record<DogSceneId, AtlasScene> };

export const DOG_PALETTE = {
  cream: '#f2e6d0',
  joint: '#1b1d22',
  cyan: '#04c8d8',
  magenta: '#ff3fa4',
  screen: '#022236',
  green: '#46e05a',
  amber: '#ffcc33',
} as const;

// ----------------------------------------------------------------- atlas

let atlas: HTMLImageElement | null = null;

function frames(): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  if (!atlas) {
    atlas = new Image();
    atlas.decoding = 'async';
    atlas.src = atlasUrl;
  }
  return atlas.complete && atlas.naturalWidth > 0 ? atlas : null;
}

export function preloadDog(): void {
  frames();
}

const BREATH = 1800;
const BLINK_EVERY = 3600;
const BLINK_MS = 140;
const EAR_EVERY = 5300;
const EAR_MS = 220;

/** The frame at time t: base and breath alternate; now and then a blink, more rarely an ear twitch (on a base phase only). */
export function dogFrameAt(id: DogSceneId, t: number): 0 | 1 | 2 | 3 {
  const s = ATLAS.scenes[id];
  const phase = (t + 600) % BREATH;
  const base = phase < BREATH / 2;
  if (base && s.eyes.length && t % BLINK_EVERY < BLINK_MS) return 2;
  if (base && s.ear && (t + 1900) % EAR_EVERY < EAR_MS) return 3;
  return base ? 0 : 1;
}

function base(ctx: CanvasRenderingContext2D, id: DogSceneId, t: number, still = false): boolean {
  const img = frames();
  if (!img) return false;
  const [sx, sy] = ATLAS.scenes[id].at[still ? 0 : dogFrameAt(id, t)]!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
  return true;
}

/** A piece of the drawing moved by dy (the ? hopping, the note bobbing). */
function hop(ctx: CanvasRenderingContext2D, id: DogSceneId, x: number, y: number, w: number, h: number, dy: number, fill: string): void {
  const img = frames();
  if (!img || !dy) return;
  const [sx, sy] = ATLAS.scenes[id].at[0]!;
  rect(ctx, fill, x, y, w, h);
  ctx.drawImage(img, sx + x, sy + y, w, h, x, y + dy, w, h);
}

// ------------------------------------------------------- the monitor at rest

/** The workshop monitor in the hero scene: where the section's sign is shown. */
const MON = { x: 108, y: 36, w: 24, h: 17 } as const;

/** Small signs, 1 = cyan. Each fits the monitor. */
const SIGNS: Record<string, string[]> = {
  USB: ['....#....', '...###...', '....#....', '.#..#..#.', '###.#.###', '.#..#..#.', '..#.#.#..', '...###...', '....#....', '...###...'],
  SERIAL: ['#.......', '.#......', '..#.....', '.#......', '#...####'],
  BLE: ['..##..', '..#.#.', '#.#..#', '.###.#', '..##..', '.###.#', '#.#..#', '..#.#.', '..##..'],
  NET: ['..####..', '.#.##.#.', '#..##..#', '########', '#..##..#', '.#.##.#.', '..####..'],
  CAMERA: ['..###.....', '##########', '#...##...#', '#..#..#..#', '#..#..#..#', '#...##...#', '##########'],
  POWER: ['....##', '...##.', '..##..', '.#####', '...##.', '..##..', '.##...'],
  BUS: ['.#.#.#.#.', '#########', '#.......#', '#..###..#', '#.......#', '#########', '.#.#.#.#.'],
  PROBE: ['...#...', '..###..', '.#.#.#.', '#######', '.#.#.#.', '..###..', '...#...'],
  REPORT: ['#####.', '#...##', '#.##.#', '#....#', '#.###.', '#....#', '######'],
  TRACE: ['#.#.###.#', '.........', '###.#.##.', '.........', '##.###.#.'],
  SETUP: ['..#.#..', '.#####.', '##...##', '.#.#.#.', '##...##', '.#####.', '..#.#..'],
  HELP: ['.###.', '#...#', '...#.', '..#..', '..#..', '.....', '..#..'],
  LOCK: ['.###.', '#...#', '#...#', '#####', '##.##', '##.##', '#####'],
  REPLAY: ['#....', '##...', '###..', '####.', '###..', '##...', '#....'],
};

function screenBg(ctx: CanvasRenderingContext2D): void {
  rect(ctx, DOG_PALETTE.screen, MON.x, MON.y, MON.w, MON.h);
}

/** A sign centered on the monitor, scaled 1 or 2 so it reads at the widget's real size. */
function sign(ctx: CanvasRenderingContext2D, name: string, color: string = DOG_PALETTE.cyan): void {
  const g = SIGNS[name];
  if (!g) return;
  screenBg(ctx);
  const gw = g[0]!.length;
  const gh = g.length;
  const k = gw * 2 <= MON.w - 2 && gh * 2 <= MON.h - 2 ? 2 : 1;
  const ox = MON.x + Math.floor((MON.w - gw * k) / 2);
  const oy = MON.y + Math.floor((MON.h - gh * k) / 2);
  for (let r = 0; r < gh; r++) for (let c = 0; c < gw; c++) if (g[r]![c] === '#') rect(ctx, color, ox + c * k, oy + r * k, k, k);
}

/** Text across the monitor, scrolling when longer than it. */
function marquee(ctx: CanvasRenderingContext2D, text: string, t: number, color: string = DOG_PALETTE.cyan): void {
  screenBg(ctx);
  const w = pixelTextWidth(text);
  ctx.save();
  ctx.beginPath();
  ctx.rect(MON.x, MON.y, MON.w, MON.h);
  ctx.clip();
  const x = w <= MON.w - 2 ? MON.x + Math.floor((MON.w - w) / 2) : MON.x + MON.w - (Math.floor(t / 70) % (w + MON.w));
  pixelText(ctx, text, x, MON.y + 5, color);
  ctx.restore();
}

/** Values, now and then on the monitor at rest. */
const VALUES = ['NO COOKIES.', 'NO LEASH.', 'LOCAL ONLY.', 'NO ACCOUNT.', 'YOUR RULES.'];

/** The section's sign; STATUS and the home keep the drawing's own face on the monitor. */
function decor(ctx: CanvasRenderingContext2D, section: string, t: number): void {
  if (section === 'SERIAL') {
    sign(ctx, 'SERIAL');
    if (pulse(t, 900, 450)) rect(ctx, DOG_PALETTE.cyan, MON.x + 18, MON.y + 11, 3, 2);
    return;
  }
  if (section === 'TRACE') {
    screenBg(ctx);
    // lines scroll up like a timeline
    for (let r = 0; r < 5; r++) {
      const line = Math.floor(t / 600) + r;
      const w = 6 + Math.floor(rnd(line) * 14);
      rect(ctx, r === 4 ? DOG_PALETTE.magenta : DOG_PALETTE.cyan, MON.x + 2, MON.y + 2 + r * 3, w, 1);
    }
    return;
  }
  if (SIGNS[section]) sign(ctx, section);
}

// -------------------------------------------------------------- overlays

type Overlay = (ctx: CanvasRenderingContext2D, t: number) => void;

/** Lines typed on a terminal, the last one growing. */
function terminal(ctx: CanvasRenderingContext2D, t: number, x: number, y: number, w: number, rows: number, bg: string): void {
  const LINE = 900;
  const n = Math.floor(t / LINE);
  rect(ctx, bg, x, y, w, rows * 3);
  for (let r = 0; r < rows; r++) {
    const line = n - (rows - 1) + r;
    const full = 5 + Math.floor(rnd(line) * (w - 8));
    const len = r === rows - 1 ? Math.min(full, Math.floor(((t % LINE) / LINE) * full * 1.5)) : full;
    rect(ctx, r === rows - 1 ? '#7ff5ff' : DOG_PALETTE.cyan, x + 1, y + r * 3 + 1, len, 1);
    if (r === rows - 1 && pulse(t, 500, 260)) rect(ctx, '#7ff5ff', x + 2 + len, y + r * 3, 1, 3);
  }
}

/** The drawn arcs, revealed one by one: a signal leaving the antenna. */
function emit(ctx: CanvasRenderingContext2D, t: number, arcs: [number, number, number, number][], bg: string): void {
  const k = Math.floor(t / 320) % (arcs.length + 2);
  arcs.forEach(([x, y, w, h], i) => {
    if (i >= k) alpha(ctx, 0.82, bg, x, y, w, h);
  });
}

/** Something travelling along a path of points: packets on a cable. */
function along(ctx: CanvasRenderingContext2D, t: number, path: [number, number][], color: string, every = 1400, count = 3): void {
  for (let i = 0; i < count; i++) {
    const p = ((t + (i * every) / count) % every) / every;
    const f = p * (path.length - 1);
    const a = path[Math.floor(f)]!;
    const b = path[Math.min(path.length - 1, Math.floor(f) + 1)]!;
    const x = a[0] + (b[0] - a[0]) * (f % 1);
    const y = a[1] + (b[1] - a[1]) * (f % 1);
    alpha(ctx, 0.45, color, x - 1, y - 1, 3, 3);
    rect(ctx, color, x, y, 1, 1);
  }
}

/** A needle swinging on a dial: a measuring instrument read (no value invented). */
function meter(ctx: CanvasRenderingContext2D, t: number): void {
  screenBg(ctx);
  const cx = MON.x + 12;
  const cy = MON.y + 14;
  for (let a = -1.1; a <= 1.1; a += 0.22) rect(ctx, DOG_PALETTE.cyan, cx + Math.sin(a) * 9, cy - Math.cos(a) * 9, 1, 1);
  const ang = Math.sin(t / 700) * 0.8;
  for (let r = 0; r < 8; r++) rect(ctx, DOG_PALETTE.amber, cx + Math.sin(ang) * r, cy - Math.cos(ang) * r, 1, 1);
  rect(ctx, DOG_PALETTE.cyan, cx - 1, cy - 1, 3, 2);
}

/** A little board with its two lines (SDA, SCL) blinking: I2C watched. */
function board(ctx: CanvasRenderingContext2D, t: number): void {
  sign(ctx, 'BUS');
  const bit = Math.floor(t / 150);
  for (let i = 0; i < 4; i++) {
    if (rnd(bit * 7 + i) > 0.5) rect(ctx, DOG_PALETTE.green, MON.x + 3 + i * 5, MON.y + 1, 2, 1);
    if ((bit + i) % 2) rect(ctx, DOG_PALETTE.magenta, MON.x + 3 + i * 5, MON.y + MON.h - 2, 2, 1);
  }
}

const OVERLAYS: Record<DogSceneId, Overlay> = {
  hero: () => {},
  idle: (ctx, t) => {
    hop(ctx, 'idle', 83, 50, 9, 13, pulse(t, 1200, 600) ? -1 : 0, '#44342b');
  },
  usb: (ctx, t) => {
    if (!pulse(t, 700, 380)) alpha(ctx, 0.75, '#1e1c23', 91, 50, 11, 11);
    twinkle(ctx, t, 97, 71, '#fff6b0', 0);
  },
  serial: (ctx, t) => {
    terminal(ctx, t, 80, 30, 26, 8, '#121c20');
  },
  bluetooth: (ctx, t) => {
    emit(
      ctx,
      t,
      [
        [92, 30, 5, 12],
        [97, 25, 6, 21],
        [103, 20, 9, 31],
      ],
      '#25282f',
    );
    led(ctx, t, 86, 34, DOG_PALETTE.cyan, 640, 320);
  },
  network: (ctx, t) => {
    for (let i = 0; i < 5; i++) if (rnd(Math.floor(t / 180) * 5 + i) < 0.35) rect(ctx, '#1d3a1f', 117 + i * 3, 62, 2, 2);
    along(
      ctx,
      t,
      [
        [56, 76],
        [64, 74],
        [72, 71],
        [80, 67],
        [88, 62],
        [96, 59],
        [104, 58],
      ],
      '#7ff5ff',
    );
  },
  camera: (ctx, t) => {
    glint(ctx, t, 75, 57, 5);
    if (!pulse(t, 800, 420)) alpha(ctx, 0.75, '#1a1e28', 92, 48, 12, 13);
    led(ctx, t, 119, 61, '#ff4040', 1000, 300);
  },
  analyze: (ctx, t) => {
    // the chart's bars move like a live reading; no number is shown
    rect(ctx, '#003540', 86, 49, 19, 18);
    for (let i = 0; i < 3; i++) {
      const v = 0.45 + 0.4 * Math.sin(t / 380 + i * 1.7) * Math.sin(t / 900 + i);
      const h = Math.max(2, Math.round(v * 16));
      rect(ctx, '#21e0e8', 88 + i * 6, 66 - h, 3, h);
    }
  },
  success: (ctx, t) => {
    twinkle(ctx, t, 92, 40, DOG_PALETTE.green, 0);
    twinkle(ctx, t, 100, 26, DOG_PALETTE.green, 300);
    twinkle(ctx, t, 128, 24, DOG_PALETTE.green, 600);
    twinkle(ctx, t, 96, 57, DOG_PALETTE.green, 900);
  },
  error: (ctx, t) => {
    hop(ctx, 'error', 71, 21, 18, 27, pulse(t, 800, 400) ? -1 : 0, '#172235');
    if (!pulse(t, 500, 300)) alpha(ctx, 0.6, '#1a2234', 97, 46, 26, 26);
  },
  disconnected: (ctx, t) => {
    if (!pulse(t, 900, 450)) alpha(ctx, 0.75, '#20202c', 79, 42, 11, 17);
    twinkle(ctx, t, 63, 50, '#fff6b0', 200);
  },
  replay: (ctx, t) => {
    if (!pulse(t, 1000, 600)) alpha(ctx, 0.7, '#002a3f', 89, 36, 12, 13);
    const band = 32 + ((t / 40) % 24);
    alpha(ctx, 0.25, '#7ff5ff', 78, band, 39, 1);
  },
  export: (ctx, t) => {
    hop(ctx, 'export', 72, 65, 18, 18, pulse(t, 900, 450) ? -1 : 0, '#996379');
  },
};

// ---------------------------------------------------------------- scenes

/** What the hero's monitor shows in a scene drawn on the hero. */
type Monitor = { kind: 'decor' } | { kind: 'sign'; name: string; blink?: boolean } | { kind: 'text'; text: string } | { kind: 'meter' } | { kind: 'board' };

export interface DogScene {
  id: DogSceneId;
  t: number;
  /** For the hero: what its monitor shows. */
  monitor?: Monitor;
  /** No breathing frames swapped: the dog stays as drawn (reduced motion, a limitation said). */
  still?: boolean;
}

/** The rest cycle: the section's decor, then (when calm) a value, then the dog lying down with a tune. */
const REST = { decor: 24_000, value: 10_000, nap: 9_000 } as const;
const REST_CYCLE = REST.decor + REST.value + REST.nap;

function rest(t: number, stage: Stage | null): DogScene {
  if (!stage?.calm) return { id: 'hero', t, monitor: { kind: 'decor' } };
  const p = t % REST_CYCLE;
  if (p < REST.decor) return { id: 'hero', t, monitor: { kind: 'decor' } };
  if (p < REST.decor + REST.value) return { id: 'hero', t, monitor: { kind: 'text', text: VALUES[Math.floor(t / REST_CYCLE) % VALUES.length]! } };
  return { id: 'idle', t: p - REST.decor - REST.value };
}

/**
 * The scene for an animation. The section is the decor; what the running
 * operation is about picks the activity: a BLE scan with the antenna, a
 * network scan along the cable, an object examined with the magnifier, a
 * serial console at the keyboard, a USB device sniffed, I2C on a board,
 * power on a meter, a replay on the little screen, an export filed in the
 * box.
 */
export function dogSceneFor(scene: SceneName, t: number, subject: Subject | null = null, stage: Stage | null = null): DogScene | null {
  const tool = subject?.tool ?? '';
  switch (scene) {
    case 'none':
      return null;
    case 'shutdown':
      return { id: 'idle', t };
    case 'idle':
    case 'wait':
      return rest(t, stage);
    case 'greet':
      return { id: 'hero', t, monitor: { kind: 'text', text: 'HI!' } };
    case 'connect':
      if (tool.startsWith('ble.')) return { id: 'bluetooth', t };
      if (tool === 'device.console' || tool === 'device.serial') return { id: 'serial', t };
      return { id: 'usb', t };
    case 'search':
      if (tool.startsWith('ble.')) return { id: 'bluetooth', t };
      if (tool === 'camera.net' || tool.startsWith('net.') || tool === 'device.dogd') return { id: 'network', t };
      if (tool.startsWith('camera.')) return { id: 'camera', t };
      if (tool === 'device.bus') return { id: 'hero', t, monitor: { kind: 'board' } };
      return { id: 'network', t };
    case 'read':
      if (tool === 'device.replay') return { id: 'replay', t };
      if (tool === 'camera.compare' || tool === 'camera.inspect') return { id: 'analyze', t };
      if (tool.startsWith('camera.')) return { id: 'camera', t };
      if (tool === 'device.usb') return { id: 'usb', t };
      if (tool === 'device.serial' || tool === 'device.console') return { id: 'serial', t };
      if (tool === 'device.bus') return { id: 'hero', t, monitor: { kind: 'board' } };
      if (tool === 'device.power') return { id: 'hero', t, monitor: { kind: 'meter' } };
      if (tool.startsWith('ble.')) return { id: 'bluetooth', t };
      return { id: 'analyze', t };
    case 'transfer':
      return { id: tool === 'device.replay' ? 'replay' : 'export', t };
    case 'success':
      return { id: 'success', t };
    case 'warning':
      return { id: 'analyze', t };
    case 'error':
      return { id: 'error', t };
    case 'disconnect':
      return { id: 'disconnected', t };
    case 'permission':
      return { id: 'hero', t, monitor: { kind: 'sign', name: 'LOCK', blink: true } };
    case 'cancel':
      // the tool put down: the section's decor, the monitor quiet a moment
      return { id: 'hero', t, monitor: t < 700 ? { kind: 'text', text: '--' } : { kind: 'decor' } };
    case 'unavailable':
      return { id: 'hero', t, monitor: { kind: 'text', text: 'N/A' }, still: true };
  }
}

function drawMonitor(ctx: CanvasRenderingContext2D, m: Monitor, t: number, section: string): void {
  switch (m.kind) {
    case 'decor':
      return decor(ctx, section, t);
    case 'sign':
      if (!m.blink || pulse(t, 1000, 640)) sign(ctx, m.name);
      else screenBg(ctx);
      return;
    case 'text':
      return marquee(ctx, m.text, t);
    case 'meter':
      return meter(ctx, t);
    case 'board':
      return board(ctx, t);
  }
}

export function drawDogScene(ctx: CanvasRenderingContext2D, scene: SceneName, t: number, subject: Subject | null = null, stage: Stage | null = null): void {
  const s = dogSceneFor(scene, t, subject, stage);
  if (!s) return rect(ctx, '#000', 0, 0, SCREEN_W, SCREEN_H);
  if (!base(ctx, s.id, s.t, s.still)) {
    // the frames are still loading: a quiet screen, never a broken one
    rect(ctx, '#071417', 0, 0, SCREEN_W, SCREEN_H);
    if (pulse(t, 600, 300)) rect(ctx, DOG_PALETTE.cyan, SCREEN_W / 2 - 1, SCREEN_H / 2 - 1, 2, 2);
    return;
  }
  if (s.monitor) drawMonitor(ctx, s.monitor, s.t, stage?.section ?? '');
  else OVERLAYS[s.id](ctx, s.t);
}

export function drawDogSplash(ctx: CanvasRenderingContext2D, t: number): void {
  frames();
  rect(ctx, '#071417', 0, 0, SCREEN_W, SCREEN_H);
  const lines = ['HW', 'DOG'];
  let shown = Math.floor(t / 70) + 1;
  lines.forEach((line, i) => {
    const part = line.slice(0, Math.max(0, Math.min(line.length, shown)));
    shown -= line.length;
    pixelText(ctx, part, Math.round((SCREEN_W - pixelTextWidth(line, 3)) / 2), 14 + i * 26, i ? DOG_PALETTE.magenta : DOG_PALETTE.cream, '#000', 3);
  });
  const w = pixelTextWidth('DOG', 3);
  rect(ctx, DOG_PALETTE.cyan, (SCREEN_W - w) / 2, 64, w * Math.min(1, t / 500), 1);
  pixelText(ctx, 'COMPANION', Math.round((SCREEN_W - pixelTextWidth('COMPANION')) / 2), 70, DOG_PALETTE.cyan);
}

/** Hardware Dog's companion: the dog of the owner's sheet, alive. */
export const DOG: SpriteSet = { id: 'hardware-dog', drawScene: drawDogScene, drawSplash: drawDogSplash, preload: preloadDog };
