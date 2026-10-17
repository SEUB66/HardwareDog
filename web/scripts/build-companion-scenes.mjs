#!/usr/bin/env node
/**
 * HARDWARE DOG / COMPANION SCENES
 *
 * The companion's scenes ARE the owner's drawings: the two sketch sheets in
 * assets/brand/source (hd-companion-sheet-1.png, hd-companion-sheet-2.png,
 * 3 x 3 scenes each) are cut cell by cell and brought to the TV screen's
 * pixel grid (136 x 100), nothing redrawn. Run with `npm run companion`.
 *
 * For each scene:
 *   - the cell, fitted to the full width (nothing of the drawing is cut);
 *     the wall continues above it and the desk front below it, from the
 *     cell's own edge colors, to fill the screen's 4:3
 *   - BASE      the scene as drawn
 *   - BREATH    its head and shoulders one pixel lower (the companion is
 *               found by its colors: the largest orange + cream shape, its
 *               outline and what it encloses), the hands and the rest of
 *               the picture untouched: alternating the two breathes
 *   - BLINK     its eye closed (the whole eye, found from its white), when
 *               the drawing has an open eye we may close
 *
 * Output: assets/brand/web/hd-companion-scenes.webp (3 frames per scene,
 * near-lossless) and hd-companion-scenes.json (where each frame is, the
 * art band, the eye). What moves on top of each drawing (code typed,
 * rain, steam, Zzz, LEDs...) is drawn by web/src/ui/lab/sprites.ts at the
 * drawing's own coordinates.
 */
import { writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SRC = join(repo, 'assets/brand/source');
const WEB = join(repo, 'assets/brand/web');

export const FW = 136;
export const FH = 100;

/** Inner rectangles of the 3 x 3 cells (inside the light frames), in sheet pixels. */
const CELL_X = [
  [18, 537],
  [572, 1092],
  [1126, 1647],
];
const CELL_Y = [
  [34, 289],
  [343, 582],
  [634, 884],
];
const INSET = 5;

/**
 * The scenes, by their name on the sheets, and where they are. `blink:
 * false` where the eye must stay as drawn: asleep, eyes shut with joy, the
 * angry stare, behind the goggles, too small to close cleanly.
 */
const SCENES = [
  { id: 'coding', sheet: 1, col: 0, row: 0 },
  { id: 'mad', blink: false, sheet: 1, col: 1, row: 0 },
  { id: 'connect', sheet: 1, col: 2, row: 0 },
  { id: 'scan', sheet: 1, col: 0, row: 1 },
  { id: 'analyze', sheet: 1, col: 1, row: 1 },
  { id: 'transfer', blink: false, sheet: 1, col: 2, row: 1 },
  { id: 'success', blink: false, sheet: 1, col: 0, row: 2 },
  { id: 'disconnected', sheet: 1, col: 1, row: 2 },
  { id: 'idle', blink: false, sheet: 1, col: 2, row: 2 },
  { id: 'boot', blink: false, sheet: 2, col: 0, row: 0 },
  { id: 'bluetooth', sheet: 2, col: 1, row: 0 },
  { id: 'rfid', sheet: 2, col: 2, row: 0 },
  { id: 'infrared', sheet: 2, col: 0, row: 1 },
  { id: 'uart', sheet: 2, col: 1, row: 1 },
  { id: 'backup', sheet: 2, col: 2, row: 1 },
  { id: 'repair', blink: false, sheet: 2, col: 0, row: 2 },
  { id: 'report', sheet: 2, col: 1, row: 2 },
  { id: 'shutdown', blink: false, sheet: 2, col: 2, row: 2 },
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

/** The companion's orange skin, and its cream throat and belly. */
const isOrange = (r, g, b) => {
  const [h, s, v] = hsv(r, g, b);
  return h >= 14 && h <= 42 && s > 0.45 && v > 0.55;
};
const isCream = (r, g, b) => {
  const [h, s, v] = hsv(r, g, b);
  return h >= 20 && h <= 55 && s > 0.12 && s <= 0.45 && v > 0.78;
};
const isWhite = (r, g, b) => r > 215 && g > 210 && b > 195;
const isDark = (r, g, b) => r + g + b < 170;

// --------------------------------------------------------------- frames

class Img {
  constructor(w, h, data) {
    this.w = w;
    this.h = h;
    this.d = data ?? Buffer.alloc(w * h * 4);
  }
  i(x, y) {
    return (y * this.w + x) * 4;
  }
  get(x, y) {
    const i = this.i(x, y);
    return [this.d[i], this.d[i + 1], this.d[i + 2]];
  }
  set(x, y, [r, g, b]) {
    const i = this.i(x, y);
    this.d[i] = r;
    this.d[i + 1] = g;
    this.d[i + 2] = b;
    this.d[i + 3] = 255;
  }
  clone() {
    return new Img(this.w, this.h, Buffer.from(this.d));
  }
}

const median = (cols) => {
  const k = cols.length;
  if (!k) return [24, 26, 48];
  const ch = [0, 1, 2].map((c) => cols.map((x) => x[c]).sort((a, b) => a - b)[k >> 1]);
  return ch;
};
const darken = ([r, g, b], f) => [Math.round(r * f), Math.round(g * f), Math.round(b * f)];

async function cell(sheet, col, row) {
  // a few sheet pixels in from the cell's light frame
  const x0 = CELL_X[col][0] + INSET;
  const x1 = CELL_X[col][1] - INSET;
  const y0 = CELL_Y[row][0] + INSET;
  const y1 = CELL_Y[row][1] - INSET;
  const w = x1 - x0;
  const h = y1 - y0;
  const artH = Math.round((FW * h) / w);
  const { data } = await sharp(join(SRC, `hd-companion-sheet-${sheet}.png`))
    .extract({ left: x0, top: y0, width: w, height: h })
    .resize(FW, artH, { kernel: 'mitchell' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const art = new Img(FW, artH, data);
  const out = new Img(FW, FH);
  const top = Math.floor((FH - artH) * 0.42);
  const bottom = FH - artH - top;
  for (let y = 0; y < artH; y++) for (let x = 0; x < FW; x++) out.set(x, top + y, art.get(x, y));
  // The wall continues above in one color, the drawing's own wall (the
  // median of its top rows, light shelves and plants ignored), a little
  // darker upward like a room's ceiling corner.
  const wallAll = [];
  for (let y = 0; y < 6; y++) for (let x = 0; x < FW; x++) wallAll.push(art.get(x, y));
  const dim = wallAll.filter(([r, g, b]) => r + g + b < 240);
  const wall = median(dim.length > FW ? dim : wallAll);
  for (let y = 0; y < top; y++) {
    const c = darken(wall, 0.62 + (0.33 * y) / Math.max(1, top));
    for (let x = 0; x < FW; x++) out.set(x, y, c);
  }
  // The desk front continues below in the drawing's own wood (the desk top
  // just above the cell's bottom edge), in shadow, darker downward, with
  // drawer panels and their handles.
  const woodAll = [];
  for (let y = artH - 12; y < artH - 2; y++)
    for (let x = 0; x < FW; x++) {
      const c = art.get(x, y);
      const [hh, ss, vv] = hsv(...c);
      if (hh >= 14 && hh <= 40 && ss > 0.35 && ss < 0.85 && vv > 0.4 && vv < 0.88) woodAll.push(c);
    }
  const desk = darken(woodAll.length > 20 ? median(woodAll) : [176, 104, 52], 0.62);
  const line = darken(desk, 0.55);
  const lit = [Math.min(255, desk[0] + 24), Math.min(255, desk[1] + 18), Math.min(255, desk[2] + 12)];
  for (let y = 0; y < bottom; y++) {
    const yy = top + artH + y;
    const base = darken(desk, 0.86 - (0.3 * y) / Math.max(1, bottom));
    for (let x = 0; x < FW; x++) {
      const px = x % 45;
      const panel = y >= 3 && y <= bottom - 3;
      let c = base;
      if (panel && (px === 4 || px === 40)) c = line;
      else if ((y === 3 || y === bottom - 3) && px >= 4 && px <= 40) c = line;
      else if (panel && y === Math.round(bottom / 2) && px >= 18 && px <= 26) c = lit;
      out.set(x, yy, c);
    }
  }
  return { img: out, top, artH };
}

/** The companion: the largest orange shape with the cream connected to it, and its outline. */
function companionMask(img) {
  const { w, h } = img;
  const skin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = img.get(x, y);
      skin[y * w + x] = isOrange(r, g, b) ? 1 : isCream(r, g, b) ? 2 : 0;
    }
  const seen = new Int32Array(w * h).fill(-1);
  let best = -1;
  let bestSize = 0;
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (skin[s] !== 1 || seen[s] !== -1) continue;
    const id = comps.length;
    const stack = [s];
    const members = [];
    seen[s] = id;
    while (stack.length) {
      const p = stack.pop();
      members.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (seen[q] === -1 && skin[q]) {
          seen[q] = id;
          stack.push(q);
        }
      }
    }
    comps.push(members);
    if (members.length > bestSize) {
      bestSize = members.length;
      best = id;
    }
  }
  const mask = new Uint8Array(w * h);
  if (best < 0) return mask;
  for (const p of comps[best]) mask[p] = 1;
  // the outline around it, and the small dark details inside (eye, mouth)
  for (let pass = 0; pass < 2; pass++) {
    const grow = mask.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;
        const n = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].filter(([dx, dy]) => mask[(y + dy) * w + x + dx]).length;
        const [r, g, b] = img.get(x, y);
        if (n >= (pass ? 3 : 1) && (isDark(r, g, b) || pass === 1 || isWhite(r, g, b))) grow[y * w + x] = 1;
      }
    mask.set(grow);
  }
  // what the outline encloses (the eye, the mouth) is the companion too
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

/**
 * The head and shoulders one pixel lower (the top of the companion's shape,
 * down to `cut`), the hands where the drawing put them (on the keyboard, on
 * the cable): alternating with the base frame, it breathes. What it
 * uncovers at its top is the pixel above it.
 */
function breath(img, mask) {
  const out = img.clone();
  const { w, h } = img;
  const { minY, maxY } = extent(mask, w, h);
  const cut = Math.round(minY + (maxY - minY) * 0.55);
  for (let x = 0; x < w; x++) {
    for (let y = Math.min(cut, h - 1); y > 0; y--) {
      if (mask[(y - 1) * w + x] || mask[y * w + x]) out.set(x, y, img.get(x, y - 1));
    }
  }
  return out;
}

function extent(mask, w, h) {
  let minY = h;
  let maxY = 0;
  for (let p = 0; p < w * h; p++)
    if (mask[p]) {
      const y = (p / w) | 0;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { minY, maxY };
}

/** The white of the eye: the largest white blob inside the companion's upper part. Null when closed. */
function findEye(img, mask) {
  const { w, h } = img;
  const { minY, maxY } = extent(mask, w, h);
  const limit = minY + (maxY - minY) * 0.55;
  const seen = new Uint8Array(w * h);
  let best = null;
  for (let y = minY; y < limit; y++)
    for (let x = 0; x < w; x++) {
      const s = y * w + x;
      if (seen[s] || !mask[s] || !isWhite(...img.get(x, y))) continue;
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
          const q = (py + dy) * w + px + dx;
          if (px + dx < 0 || px + dx >= w || py + dy < 0 || py + dy >= h || seen[q]) continue;
          if (isWhite(...img.get(px + dx, py + dy)) && mask[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
      if (members.length >= 3 && members.length <= 60 && (!best || members.length > best.length)) best = members;
    }
  if (!best) return null;
  // the whole eye: from its white, everything that is not skin (the pupil,
  // the dark ring around it), up to the skin that surrounds it
  const eye = new Set(best);
  const stack = [...best];
  while (stack.length) {
    const p = stack.pop();
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
      const q = ny * w + nx;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h || eye.has(q) || !mask[q]) continue;
      const c = img.get(nx, ny);
      if (isOrange(...c) || isCream(...c)) continue;
      eye.add(q);
      stack.push(q);
    }
    if (eye.size > 140) return null; // it leaked into the outline: not an eye we can close
  }
  const xs = [...eye].map((p) => p % w);
  const ys = [...eye].map((p) => (p / w) | 0);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), px: [...eye] };
}

/** The eye closed: the whole eye painted with the skin around it, a dark lid curve across it. */
function blink(img, mask, eye) {
  const out = img.clone();
  if (!eye) return out;
  const { w } = img;
  const skin = [];
  for (let y = eye.y0 - 3; y <= eye.y1 + 3; y++)
    for (let x = eye.x0 - 3; x <= eye.x1 + 3; x++) {
      const [r, g, b] = img.get(x, y);
      if (isOrange(r, g, b)) skin.push([r, g, b]);
    }
  const lid = median(skin);
  const line = [42, 26, 18];
  const eyeSet = new Set(eye.px);
  for (const p of eye.px) out.set(p % w, (p / w) | 0, lid);
  // the soft edge of the ring (half dark, half skin) goes too
  const dist = ([r, g, b]) => Math.abs(r - lid[0]) + Math.abs(g - lid[1]) + Math.abs(b - lid[2]);
  for (let y = eye.y0 - 1; y <= eye.y1 + 1; y++)
    for (let x = eye.x0 - 1; x <= eye.x1 + 1; x++) {
      const p = y * w + x;
      if (eyeSet.has(p) || !mask[p]) continue;
      if (![p - 1, p + 1, p - w, p + w].some((q) => eyeSet.has(q))) continue;
      const c = img.get(x, y);
      if (dist(c) > 45 && !isCream(...c)) out.set(x, y, lid);
    }
  const mid = Math.round(eye.y0 + (eye.y1 - eye.y0) * 0.6);
  for (let x = eye.x0; x <= eye.x1; x++) out.set(x, mid - (x === eye.x0 || x === eye.x1 ? 1 : 0), line);
  return out;
}

async function main() {
  const COLS = 9; // 3 scenes x 3 frames per row
  const sheetW = FW * COLS;
  const sheetH = FH * Math.ceil((SCENES.length * 3) / COLS);
  const atlas = new Img(sheetW, sheetH);
  const meta = { frame: { w: FW, h: FH }, frames: ['base', 'breath', 'blink'], scenes: {} };
  for (const [n, s] of SCENES.entries()) {
    const { img, top, artH } = await cell(s.sheet, s.col, s.row);
    const mask = companionMask(img);
    const eye = s.blink === false ? null : findEye(img, mask);
    const frames = [img, breath(img, mask), blink(img, mask, eye)];
    const at = [];
    frames.forEach((f, k) => {
      const idx = n * 3 + k;
      const ox = (idx % COLS) * FW;
      const oy = Math.floor(idx / COLS) * FH;
      for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) atlas.set(ox + x, oy + y, f.get(x, y));
      at.push([ox, oy]);
    });
    meta.scenes[s.id] = { at, art: { top, height: artH }, eye: eye && { x0: eye.x0, y0: eye.y0, x1: eye.x1, y1: eye.y1 }, source: `hd-companion-sheet-${s.sheet}.png cell ${s.col},${s.row}` };
  }
  const file = join(WEB, 'hd-companion-scenes.webp');
  await sharp(atlas.d, { raw: { width: sheetW, height: sheetH, channels: 4 } })
    .removeAlpha()
    .webp({ nearLossless: true, quality: 60, effort: 6 }) // at most 2 levels off per channel: invisible, 40 % smaller
    .toFile(file);
  const json = join(WEB, 'hd-companion-scenes.json');
  await writeFile(json, JSON.stringify(meta, null, 1) + '\n');
  console.log(`[ OK ] ${file} ${((await stat(file)).size / 1024).toFixed(1)} KB, ${SCENES.length} scenes x 3 frames`);
  for (const [id, m] of Object.entries(meta.scenes)) console.log(`       ${id.padEnd(13)} eye ${m.eye ? `${m.eye.x0},${m.eye.y0}-${m.eye.x1},${m.eye.y1}` : 'closed'}`);
}

main().catch((e) => {
  console.error('[FAIL]', e instanceof Error ? e.message : e);
  process.exit(1);
});
