#!/usr/bin/env node
/**
 * HARDWARE DOG / THE HOME PAGE'S COMPANION TV
 *
 * The home page (web/index.html) plays the dog in the turquoise TV with
 * CSS: one row per channel, the four frames of the dog's atlas side by
 * side (BASE BREATH BLINK EAR), stepped by a keyframe animation. This
 * script copies those rows, pixel for pixel, out of
 * assets/brand/web/hd-dog-scenes.webp (built by build-dog-scenes.mjs from
 * the owner's sheets): nothing redrawn, nothing rescaled. Brought to 256
 * colors (light dithering: no difference at 4x, a third of the bytes), then
 * lossless, so the pixels stay square when the page scales them up.
 *
 * Output: assets/brand/web/hd-home-scenes.webp, 544 x 1300.
 * The row order is the CSS contract (web/src/styles/vitrine.css, .ch-*).
 * Run with `npm run companion`, after the dog's atlas.
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(resolve(here, '../..'), 'assets/brand/web');

/**
 * Rows, top to bottom: the TV's channels. 01 to 12 are the numbered scenes
 * of the owner's "COMPANION TV" sheet, in its order (IDLE is the states
 * sheet's IDLE / READY, the drawing the atlas has for it); 13 is POWER, the
 * last number on the TV's dial.
 */
export const HOME_CHANNELS = ['rest', 'usb', 'serial', 'bluetooth', 'network', 'camera', 'analyze', 'success', 'error', 'disconnected', 'replay', 'export', 'power'];

const atlas = JSON.parse(await readFile(join(WEB, 'hd-dog-scenes.json'), 'utf8'));
const { w: FW, h: FH } = atlas.frame;
const FRAMES = atlas.frames.length;
const source = sharp(join(WEB, 'hd-dog-scenes.webp'));

const rows = [];
for (const [row, id] of HOME_CHANNELS.entries()) {
  const at = atlas.scenes[id]?.at;
  if (!at || at.length !== FRAMES) throw new Error(`hd-dog-scenes.json: no ${FRAMES} frames for ${id}`);
  for (const [frame, [x, y]] of at.entries()) {
    const input = await source.clone().extract({ left: x, top: y, width: FW, height: FH }).png().toBuffer();
    rows.push({ input, left: frame * FW, top: row * FH });
  }
}

const file = join(WEB, 'hd-home-scenes.webp');
const sheet = await sharp({ create: { width: FW * FRAMES, height: FH * HOME_CHANNELS.length, channels: 3, background: '#000000' } })
  .composite(rows)
  .png({ palette: true, colors: 256, dither: 0.5, effort: 10 })
  .toBuffer();
const out = await sharp(sheet).webp({ lossless: true, effort: 6 }).toBuffer();
await writeFile(file, out);
console.log(`hd-home-scenes.webp  ${FW * FRAMES}x${FH * HOME_CHANNELS.length}  ${((await stat(file)).size / 1024).toFixed(1)} KB  ${HOME_CHANNELS.join(' ')}`);
