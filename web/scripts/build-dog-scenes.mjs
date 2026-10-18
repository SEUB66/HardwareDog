#!/usr/bin/env node
/**
 * HARDWARE DOG / THE DOG'S SCENES
 *
 * Hardware Dog's companion is the robot dog of the owner's two sheets:
 * "HW DOG / COMPANION STATES" (assets/brand/source/hd-companion-dog-
 * states.png, ten states drawn to be read at a glance: the reference
 * where it has the state) and "HARDWARE DOG - COMPANION TV"
 * (hd-companion-dog-sheet.png: the workshop in the TV, and the scenes the
 * states sheet does not draw). Each is cut and brought to the TV screen's
 * pixel grid (136 x 100), nothing redrawn. Run with `npm run companion`
 * (it builds the Flipper Lab scenes too).
 *
 * The scenes are wide (2 to 2.6:1); the screen is 4:3. One window of the
 * same size per sheet is cut from every scene (so the dog keeps its
 * size), placed on the dog and what it works on; the room continues above
 * it (its own wall, darker upward) and the floor below it (its own floor,
 * its grid continued, in shadow).
 *
 * For each scene, four frames from the drawing itself:
 *   BASE      the scene as drawn
 *   BREATH    its head and back one pixel lower (the dog is found by its
 *             cream panels, its dark joints and the visor they hold): the
 *             paws stay where they are; alternating the two breathes
 *   BLINK     its cyan eyes shut to a line, where they are open in the
 *             drawing (not asleep, not smiling ^ ^)
 *   EAR       the ear (its pink inside) one pixel up: a twitch
 *
 * Output: assets/brand/web/hd-dog-scenes.webp (near-lossless) and
 * hd-dog-scenes.json (where each frame is, the art band, the dog, the
 * eyes, the ear). What moves around the dog (the terminal typed, the
 * radio waves, the router's LEDs, the ? hopping...) is drawn by
 * web/src/ui/lab/dogSprites.ts at the drawing's own coordinates.
 */
import { writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SHEET = join(repo, 'assets/brand/source/hd-companion-dog-sheet.png');
/** The owner's second sheet, "HW DOG / COMPANION STATES": ten states, drawn to be read at a glance. */
const STATES = join(repo, 'assets/brand/source/hd-companion-dog-states.png');
const WEB = join(repo, 'assets/brand/web');

export const FW = 136;
export const FH = 100;

/** The first sheet's numbered scenes: their row's picture band, in sheet pixels (inside the rounded frame). */
const ROW_Y = [492, 668, 845];
const CELL_H = 120;
/** One window size for every numbered scene: the dog keeps its size. */
const CELL_W = 240;

/** The states sheet: each picture's top (inside its frame), and one window size for all of them. */
const STATE_Y = [126, 441, 758, 1073, 1382];
const STATE_W = 330;
const STATE_H = 170;
const state = (row, x) => ({ file: STATES, box: { x, y: STATE_Y[row], w: STATE_W, h: STATE_H } });

/**
 * Each scene, where it is cut, and whether its eyes may blink. The states
 * sheet is the reference where it has the state (more readable at the
 * widget's size); the first sheet gives the workshop (the hero) and the
 * states the second one does not draw.
 */
const SCENES = [
  // first sheet: the workshop at rest, and what the states sheet has no picture for
  { id: 'hero', box: { x: 122, y: 104, w: 430, h: 272 } },
  { id: 'usb', row: 0, x: 466 },
  { id: 'analyze', row: 1, x: 848 },
  { id: 'success', row: 1, x: 1205, blink: false },
  { id: 'error', row: 2, x: 95 },
  { id: 'replay', row: 2, x: 850 },
  { id: 'export', row: 2, x: 1205 },
  // the states sheet
  { id: 'serial', ...state(0, 118) },
  { id: 'bluetooth', ...state(0, 520) },
  { id: 'network', ...state(1, 45) },
  { id: 'camera', ...state(1, 540) },
  { id: 'power', ...state(2, 110) },
  { id: 'saved', ...state(2, 560), blink: false },
  { id: 'disconnected', ...state(3, 80) },
  { id: 'permission', ...state(3, 540) },
  { id: 'timeout', ...state(4, 95) },
  { id: 'rest', ...state(4, 545), blink: false },
];

// ---------------------------------------------------------------- colors

function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}

/** The dog's cream panels (warm, light, little color). */
const isCream = (r, g, b) => {
  const [h, s, v] = hsv(r, g, b);
  return v > 0.66 && s < 0.38 && (h <= 60 || h >= 330 || s < 0.08);
};
/** Its eyes, joints and collar. */
const isCyan = (r, g, b) => {
  const [h, s, v] = hsv(r, g, b);
  return h >= 165 && h <= 205 && s > 0.45 && v > 0.5;
};
/** The pink inside its ears. */
const isPink = (r, g, b) => {
  const [h, s, v] = hsv(r, g, b);
  return (h >= 315 || h <= 8) && s > 0.3 && v > 0.45;
};
const isDark = (r, g, b) => r + g + b < 150;

// --------------------------------------------------------------- frames

class Img {
  constructor(w, h, data) {
    this.w = w;
    this.h = h;
    this.d = data ?? Buffer.alloc(w * h * 4);
  }
  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2]];
  }
  set(x, y, [r, g, b]) {
    const i = (y * this.w + x) * 4;
    this.d[i] = r;
    this.d[i + 1] = g;
    this.d[i + 2] = b;
    this.d[i + 3] = 255;
  }
  clone() {
    return new Img(this.w, this.h, Buffer.from(this.d));
  }
}

const darken = ([r, g, b], f) => [Math.round(r * f), Math.round(g * f), Math.round(b * f)];
const median = (cols) => {
  const k = cols.length;
  if (!k) return [8, 10, 14];
  return [0, 1, 2].map((c) => cols.map((x) => x[c]).sort((a, b) => a - b)[k >> 1]);
};

/** A scene on the 136 x 100 screen: the window, fitted to the width, the room continued above and below. */
async function scene(s) {
  const box = s.box ?? { x: s.x, y: ROW_Y[s.row], w: CELL_W, h: CELL_H };
  const artH = Math.round((FW * box.h) / box.w);
  const { data } = await sharp(s.file ?? SHEET)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .resize(FW, artH, { kernel: 'mitchell' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const art = new Img(FW, artH, data);
  const out = new Img(FW, FH);
  const top = Math.ceil((FH - artH) * 0.55);
  const bottom = FH - artH - top;
  for (let y = 0; y < artH; y++) for (let x = 0; x < FW; x++) out.set(x, top + y, art.get(x, y));
  // the wall above: the drawing's own wall (the median of its top rows,
  // lamps ignored), darker toward the ceiling
  const wallAll = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < FW; x++) wallAll.push(art.get(x, y));
  const dim = wallAll.filter(([r, g, b]) => r + g + b < 200);
  const wall = median(dim.length > FW ? dim : wallAll);
  for (let y = 0; y < top; y++) {
    const c = darken(wall, 0.5 + (0.45 * y) / Math.max(1, top));
    for (let x = 0; x < FW; x++) out.set(x, y, c);
  }
  // the floor below: the drawing's own mat (its bottom rows, the dog
  // ignored), in shadow toward us, its grid continued
  const matAll = [];
  for (let y = artH - 3; y < artH; y++)
    for (let x = 0; x < FW; x++) {
      const c = art.get(x, y);
      if (!isCream(...c)) matAll.push(c);
    }
  const mat = median(matAll);
  const line = darken(mat, 0.62);
  for (let y = 0; y < bottom; y++) {
    const f = 0.82 - (0.42 * y) / Math.max(1, bottom);
    const yy = top + artH + y;
    for (let x = 0; x < FW; x++) {
      // the grid spreads toward us: wider cells lower down
      const cell = 6 + y;
      const vx = Math.round((x - FW / 2) * (1 + y * 0.06) + FW * 8);
      const grid = vx % cell === 0 || y % 4 === 3;
      out.set(x, yy, darken(grid ? line : mat, f));
    }
  }
  return { img: out, top, artH, box };
}

/** Pixels of a kind, grouped: connected components (4-neighbors) inside a region. */
function blobs(img, test, region = null) {
  const { w, h } = img;
  const seen = new Uint8Array(w * h);
  const out = [];
  const x0 = region?.x0 ?? 0;
  const x1 = region?.x1 ?? w - 1;
  const y0 = region?.y0 ?? 0;
  const y1 = region?.y1 ?? h - 1;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const s = y * w + x;
      if (seen[s] || !test(x, y)) continue;
      const stack = [s];
      const members = [];
      seen[s] = 1;
      while (stack.length) {
        const p = stack.pop();
        members.push(p);
        const px = p % w;
        const py = (p / w) | 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
          const q = ny * w + nx;
          if (!seen[q] && test(nx, ny)) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      out.push(members);
    }
  return out.sort((a, b) => b.length - a.length);
}

const bboxOf = (members, w) => {
  const xs = members.map((p) => p % w);
  const ys = members.map((p) => (p / w) | 0);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

/**
 * The dog: its largest cream shape, then what its panels hold within a few
 * pixels (the dark joints and outline, the visor, the cyan eyes and
 * joints, the pink ears), then what that encloses.
 */
function dogMask(img, top, artH) {
  const { w, h } = img;
  const region = { x0: 0, x1: w - 1, y0: top, y1: top + artH - 1 };
  // its panels are cut by dark seams: close them (2 px out, 2 px back in) before looking for the largest shape
  let creamMap = new Uint8Array(w * h);
  for (let y = region.y0; y <= region.y1; y++) for (let x = 0; x < w; x++) creamMap[y * w + x] = isCream(...img.get(x, y)) ? 1 : 0;
  const morph = (m, on) => {
    const out = new Uint8Array(w * h);
    for (let y = region.y0; y <= region.y1; y++)
      for (let x = 0; x < w; x++) {
        let any = false;
        let all = true;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            const v = nx >= 0 && nx < w && ny >= region.y0 && ny <= region.y1 ? m[ny * w + nx] : 0;
            any ||= v === 1;
            all &&= v === 1;
          }
        out[y * w + x] = (on ? any : all) ? 1 : 0;
      }
    return out;
  };
  const closed = morph(morph(morph(morph(creamMap, true), true), false), false);
  // the largest shape, and the others touching its box (the head and the body are often apart)
  const shapes = blobs(img, (x, y) => closed[y * w + x] === 1, region);
  const first = shapes[0] ?? [];
  const fb = first.length ? bboxOf(first, w) : { x0: 0, x1: 0, y0: 0, y1: 0 };
  const cream = shapes
    .filter((m) => {
      if (m === first) return true;
      if (m.length < 40) return false;
      const b = bboxOf(m, w);
      return b.x0 <= fb.x1 + 8 && b.x1 >= fb.x0 - 8 && b.y0 <= fb.y1 + 8 && b.y1 >= fb.y0 - 8;
    })
    .flat();
  const mask = new Uint8Array(w * h);
  for (const p of cream) mask[p] = 1;
  creamMap = mask;
  const bb = bboxOf(cream, w);
  // grow, step by step, into its own colors near it
  for (let step = 0; step < 5; step++) {
    const grow = mask.slice();
    for (let y = Math.max(top, bb.y0 - 6); y <= Math.min(top + artH - 1, bb.y1 + 2); y++)
      for (let x = Math.max(0, bb.x0 - 6); x <= Math.min(w - 1, bb.x1 + 6); x++) {
        const p = y * w + x;
        if (mask[p]) continue;
        const near = (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || mask[p - w] || mask[p + w];
        if (!near) continue;
        const c = img.get(x, y);
        if (isDark(...c) || isCyan(...c) || isPink(...c) || isCream(...c)) grow[p] = 1;
      }
    mask.set(grow);
  }
  // what the dog encloses (an eye, a gap in the visor) is the dog too
  const outside = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (outside[p] || mask[p]) continue;
    outside[p] = 1;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  for (let p = 0; p < w * h; p++) if (!outside[p] && !mask[p]) mask[p] = 1;
  return mask;
}

function extent(mask, w, h) {
  let x0 = w;
  let x1 = 0;
  let y0 = h;
  let y1 = 0;
  for (let p = 0; p < w * h; p++)
    if (mask[p]) {
      const x = p % w;
      const y = (p / w) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  return { x0, x1, y0, y1 };
}

/** Head and back one pixel lower, down to 55 % of its height: the paws stay. */
function breath(img, mask) {
  const out = img.clone();
  const { w, h } = img;
  const { y0, y1 } = extent(mask, w, h);
  const cut = Math.round(y0 + (y1 - y0) * 0.55);
  for (let x = 0; x < w; x++) for (let y = Math.min(cut, h - 1); y > 0; y--) if (mask[(y - 1) * w + x] || mask[y * w + x]) out.set(x, y, img.get(x, y - 1));
  return out;
}

/** Its open eyes: small cyan shapes in the upper half of the dog, set in the dark visor. */
function findEyes(img, mask) {
  const { w, h } = img;
  const e = extent(mask, w, h);
  const limit = Math.round(e.y0 + (e.y1 - e.y0) * 0.5);
  const found = blobs(img, (x, y) => isCyan(...img.get(x, y)), { x0: e.x0, x1: e.x1, y0: e.y0, y1: limit }).filter((m) => {
    if (m.length < 2 || m.length > 30) return false;
    // set in the visor: most of what is around it is dark
    const set = new Set(m);
    let dark = 0;
    let all = 0;
    for (const p of m)
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (set.has(q) || q < 0 || q >= w * h) continue;
        all++;
        if (isDark(...img.get(q % w, (q / w) | 0))) dark++;
      }
    return all > 0 && dark / all > 0.6;
  });
  return found.slice(0, 2).map((m) => ({ ...bboxOf(m, w), px: m }));
}

/** The eyes shut: painted with the visor, a cyan line across where each was. */
function blink(img, eyes) {
  const out = img.clone();
  if (!eyes.length) return out;
  const { w } = img;
  for (const eye of eyes) {
    const visor = [];
    for (let y = eye.y0 - 2; y <= eye.y1 + 2; y++)
      for (let x = eye.x0 - 2; x <= eye.x1 + 2; x++) {
        const c = img.get(x, y);
        if (isDark(...c)) visor.push(c);
      }
    const lid = median(visor);
    for (const p of eye.px) out.set(p % w, (p / w) | 0, lid);
    const mid = Math.round(eye.y0 + (eye.y1 - eye.y0) * 0.6);
    const line = img.get(eye.px[0] % w, (eye.px[0] / w) | 0);
    for (let x = eye.x0; x <= eye.x1; x++) out.set(x, mid, line);
  }
  return out;
}

/** The ear: the largest pink shape in the upper part of the dog, with the panel around it. */
function findEar(img, mask) {
  const { w, h } = img;
  const e = extent(mask, w, h);
  const limit = Math.round(e.y0 + (e.y1 - e.y0) * 0.45);
  const pink = blobs(img, (x, y) => mask[y * w + x] === 1 && isPink(...img.get(x, y)), { x0: e.x0, x1: e.x1, y0: e.y0, y1: limit })[0];
  if (!pink || pink.length < 3) return null;
  const b = bboxOf(pink, w);
  return { x0: Math.max(0, b.x0 - 2), x1: Math.min(w - 1, b.x1 + 2), y0: Math.max(e.y0, b.y0 - 2), y1: b.y1 + 1 };
}

/** The ear one pixel up; what it uncovers at its base is the pixel below. */
function earUp(img, mask, ear) {
  const out = img.clone();
  if (!ear) return out;
  const { w } = img;
  for (let x = ear.x0; x <= ear.x1; x++) for (let y = Math.max(1, ear.y0); y <= ear.y1; y++) if (mask[y * w + x]) out.set(x, y - 1, img.get(x, y));
  return out;
}

async function main() {
  const COLS = 8; // 2 scenes x 4 frames per row
  const N = 4;
  const sheetW = FW * COLS;
  const sheetH = FH * Math.ceil((SCENES.length * N) / COLS);
  const atlas = new Img(sheetW, sheetH);
  const meta = {
    frame: { w: FW, h: FH },
    frames: ['base', 'breath', 'blink', 'ear'],
    sources: ['assets/brand/source/hd-companion-dog-sheet.png', 'assets/brand/source/hd-companion-dog-states.png'],
    scenes: {},
  };
  for (const [n, s] of SCENES.entries()) {
    const { img, top, artH, box } = await scene(s);
    const mask = dogMask(img, top, artH);
    const dog = extent(mask, img.w, img.h);
    const eyes = s.blink === false ? [] : findEyes(img, mask);
    const ear = findEar(img, mask);
    const frames = [img, breath(img, mask), blink(img, eyes), earUp(img, mask, ear)];
    if (process.env.DOG_DEBUG) {
      // the mask in red, the eyes in green: to check what was found
      const dbg = img.clone();
      for (let p = 0; p < FW * FH; p++)
        if (mask[p])
          dbg.set(
            p % FW,
            (p / FW) | 0,
            darken(img.get(p % FW, (p / FW) | 0), 0.5).map((v, i) => (i === 0 ? Math.min(255, v + 120) : v)),
          );
      for (const e of eyes) for (const p of e.px) dbg.set(p % FW, (p / FW) | 0, [0, 255, 0]);
      await sharp(dbg.d, { raw: { width: FW, height: FH, channels: 4 } })
        .resize(FW * 4, FH * 4, { kernel: 'nearest' })
        .png()
        .toFile(join(process.env.DOG_DEBUG, `${s.id}.png`));
    }
    const at = [];
    frames.forEach((f, k) => {
      const idx = n * N + k;
      const ox = (idx % COLS) * FW;
      const oy = Math.floor(idx / COLS) * FH;
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) atlas.set(ox + x, oy + y, f.get(x, y));
      at.push([ox, oy]);
    });
    meta.scenes[s.id] = {
      at,
      art: { top, height: artH },
      dog,
      eyes: eyes.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 })),
      ear,
      sheet: s.file ? 'states' : 'first',
      window: box,
    };
  }
  const file = join(WEB, 'hd-dog-scenes.webp');
  await sharp(atlas.d, { raw: { width: sheetW, height: sheetH, channels: 4 } })
    .removeAlpha()
    .webp({ nearLossless: true, quality: 60, effort: 6 })
    .toFile(file);
  const json = join(WEB, 'hd-dog-scenes.json');
  await writeFile(json, JSON.stringify(meta, null, 1) + '\n');
  console.log(`[ OK ] ${file} ${((await stat(file)).size / 1024).toFixed(1)} KB, ${SCENES.length} scenes x ${N} frames`);
  for (const [id, m] of Object.entries(meta.scenes))
    console.log(`       ${id.padEnd(13)} dog ${m.dog.x0},${m.dog.y0}-${m.dog.x1},${m.dog.y1}  eyes ${m.eyes.length}  ear ${m.ear ? `${m.ear.x0},${m.ear.y0}-${m.ear.x1},${m.ear.y1}` : '-'}`);
}

main().catch((e) => {
  console.error('[FAIL]', e instanceof Error ? e.message : e);
  process.exit(1);
});
