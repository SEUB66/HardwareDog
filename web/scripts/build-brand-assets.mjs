#!/usr/bin/env node
/**
 * HARDWARE DOG / BRAND ASSET PIPELINE
 *
 * Generates every derivative from the untouched originals in
 * assets/brand/source. Run with `npm run assets` from web/.
 *
 * Rules (docs/BRAND.md):
 *   - sources are read, never written
 *   - the dog is cropped and scaled, never redrawn
 *   - every output has an exact display size and a single job
 *
 * Outputs carry no metadata: sharp drops it unless asked to keep it.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const SRC = join(repo, 'assets/brand/source');
const WEB = join(repo, 'assets/brand/web');
const SOCIAL = join(repo, 'assets/brand/social');
const PUBLIC = join(repo, 'web/public');

const BG = { r: 11, g: 13, b: 15, alpha: 1 }; // --bg #0B0D0F

/** Official head artwork, 1254 x 1254, transparent. */
const HEAD = join(SRC, 'hd-official-head.png');

/**
 * Regions of hd-official-head.png, in source pixels.
 * ICON: the whole head + collar + USB cable, with breathing room.
 * MARK: head + collar only, for 16-32 px where the plug turns to noise.
 */
const ICON_BOX = { left: 55, top: 99, width: 1169, height: 1051 };
const MARK_BOX = { left: 95, top: 130, width: 940, height: 870 };
/** The USB plug and cable, removed from the MARK. Nothing is added. */
const USB_REGION = '880,640 1254,540 1254,1254 560,1254 560,965 650,945 880,905';
/**
 * HEAD: the dog's head alone (no collar, no cable), for the browser tab
 * and the header: the one shape that stays readable at 16 px.
 */
const HEAD_BOX = { left: 100, top: 165, width: 930, height: 620 };
const COLLAR_REGION = '0,600 140,640 560,780 640,860 700,1254 0,1254';

/**
 * FLIPPER LAB TV: the orange portable TV, seen from the front, 1536 x 1024.
 * The source already has an alpha cut-out (outside the body and the
 * screen opening); its edges carry noise (1-15) and a red fringe in the
 * transparent pixels, and the body tops out at 253. Nothing is keyed by
 * color: the black bezel and the black controls stay as drawn.
 *
 * Regions below are source pixels, written once here and normalized in
 * the profile the component reads (web/src/ui/lab/tvProfile.ts). A new
 * TV picture is a new source + new numbers here, never new code.
 */
const TV = join(SRC, 'hd-tv-orange-frame.png');
const TV_REGIONS = {
  /** A point inside the screen opening: the aperture is traced from it. */
  apertureSeed: { x: 625, y: 520 },
  /** Content runs this far under the bezel so no seam shows at any size. */
  apertureBleed: 6,
  power: { left: 1206, top: 457, width: 198, height: 118 },
  dial: { cx: 1305, cy: 312, r: 120 },
  /** The metal knob inside the dial: it turns with the view. */
  knob: { cx: 1306, cy: 312, r: 68 },
  handle: { left: 412, top: 12, width: 718, height: 60 },
  speaker: { left: 1183, top: 600, width: 246, height: 286 },
  logo: { left: 585, top: 906, width: 363, height: 63 },
};
/** Flipper Lab banner: pixel-art lab, the dog and the dolphin, 1983 x 793. */
const BANNER = join(SRC, 'hd-flipper-lab-banner.png');
/** Camera Sniffer banner: pixel-art living room seen through a lens, the dog with a camera, 1983 x 793. */
const CAMERA_BANNER = join(SRC, 'hd-camera-sniffer-banner.png');
// The owner's five Camera Sniffer posters (2400 x 3540), shown as a slideshow.
const POSTERS_SRC = join(repo, 'assets/illustrations');
const POSTERS_WEB = join(repo, 'assets/illustrations/web');
export const POSTERS = ['01-Power-Connections', '02-Clocks-Media', '03-Everyday-Objects', '04-Room-Outdoor', '05-Personal-Portable'];

const outputs = [];

async function save(file, pipeline) {
  await mkdir(dirname(file), { recursive: true });
  await pipeline.toFile(file);
  const { size } = await stat(file);
  outputs.push([relative(repo, file), size]);
}

/**
 * The background removal on the source left alpha noise (1-15) around
 * the art and 251-254 inside it. Snap both ends so edges stay crisp.
 */
async function cleanAlpha(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    data[i] = a < 16 ? 0 : a > 240 ? 255 : a;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

/**
 * The TV frame as an overlay: alpha snapped (noise out, body fully
 * opaque), color zeroed where nothing shows (no red fringe can come back
 * through resampling), and the screen opening traced from inside.
 * Returns the cleaned PNG and the aperture outline in source pixels.
 */
async function tvOverlay() {
  const { data, info } = await sharp(TV).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    const snapped = a < 16 ? 0 : a > 236 ? 255 : a;
    data[i + 3] = snapped;
    if (snapped === 0) data[i] = data[i + 1] = data[i + 2] = 0;
  }
  const alpha = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 255 : data[(y * width + x) * 4 + 3]);
  const { x: sx, y: sy } = TV_REGIONS.apertureSeed;
  if (alpha(sx, sy) !== 0) throw new Error('TV aperture seed is not inside the transparent screen opening');
  // The opening is a rounded rectangle, star-shaped from its center: one
  // ray per step finds its edge, then the outline is pushed under the bezel.
  const points = [];
  const STEPS = 72;
  for (let n = 0; n < STEPS; n++) {
    const angle = (n / STEPS) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let r = 0;
    while (alpha(Math.round(sx + dx * (r + 1)), Math.round(sy + dy * (r + 1))) < 128 && r < Math.max(width, height)) r++;
    r += TV_REGIONS.apertureBleed;
    points.push([sx + dx * r, sy + dy * r]);
  }
  const png = await sharp(data, { raw: info }).png().toBuffer();
  return { png, width, height, points };
}

/** The mapping profile: everything normalized to 0..1 of the picture. */
function tvProfile({ width, height, points }) {
  const nx = (v) => +(v / width).toFixed(5);
  const ny = (v) => +(v / height).toFixed(5);
  const box = (b) => ({ x: nx(b.left), y: ny(b.top), w: nx(b.width), h: ny(b.height) });
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const { dial, knob } = TV_REGIONS;
  return {
    id: 'hd-tv-orange',
    version: 1,
    source: 'assets/brand/source/hd-tv-orange-frame.png',
    reference: { width, height, ratio: +(width / height).toFixed(5) },
    screen: {
      box: { x: nx(Math.min(...xs)), y: ny(Math.min(...ys)), w: nx(Math.max(...xs) - Math.min(...xs)), h: ny(Math.max(...ys) - Math.min(...ys)) },
      polygon: points.map(([x, y]) => [nx(x), ny(y)]),
    },
    power: box(TV_REGIONS.power),
    dial: { cx: nx(dial.cx), cy: ny(dial.cy), rx: nx(dial.r), ry: ny(dial.r) },
    knob: { cx: nx(knob.cx), cy: ny(knob.cy), rx: nx(knob.r), ry: ny(knob.r) },
    handle: box(TV_REGIONS.handle),
    speaker: box(TV_REGIONS.speaker),
    logo: box(TV_REGIONS.logo),
  };
}

/** Pad a region to a square, transparent, so art never stretches. Regions listed are cut out first. */
async function square(buffer, box, removed = []) {
  let img = sharp(buffer);
  if (removed.length) {
    const meta = await sharp(buffer).metadata();
    const mask = Buffer.from(
      `<svg width="${meta.width}" height="${meta.height}">${removed.map((r) => `<polygon points="${r}" fill="#000"/>`).join('')}</svg>`,
    );
    img = sharp(await img.composite([{ input: mask, blend: 'dest-out' }]).png().toBuffer());
  }
  const cropped = await img.extract(box).png().toBuffer();
  const side = Math.max(box.width, box.height);
  return sharp(cropped)
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** Art on the instrument background with a margin, for OS icons. */
function onBackground(art, size, margin) {
  const inner = Math.round(size * (1 - 2 * margin));
  return sharp(art)
    .resize(inner, inner, { kernel: 'lanczos3' })
    .extend({
      top: Math.floor((size - inner) / 2),
      bottom: Math.ceil((size - inner) / 2),
      left: Math.floor((size - inner) / 2),
      right: Math.ceil((size - inner) / 2),
      background: BG,
    })
    .flatten({ background: BG });
}

/** Minimal ICO container holding PNG images (supported by every browser). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  const head = await cleanAlpha(HEAD);
  const iconArt = await square(head, ICON_BOX);
  const markArt = await square(head, MARK_BOX, [USB_REGION]);
  const headArt = await square(head, HEAD_BOX, [USB_REGION, COLLAR_REGION]);

  // FAVICON: the head alone, transparent: just the dog in the tab.
  const favicons = [];
  for (const size of [16, 32, 48]) {
    const data = await sharp(headArt).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toBuffer();
    favicons.push({ size, data });
    if (size !== 48) await save(join(PUBLIC, `favicon-${size}.png`), sharp(data));
  }
  await mkdir(PUBLIC, { recursive: true });
  await writeFile(join(PUBLIC, 'favicon.ico'), ico(favicons));
  outputs.push([relative(repo, join(PUBLIC, 'favicon.ico')), (await stat(join(PUBLIC, 'favicon.ico'))).size]);

  // APP ICON: head + collar + USB, no text, no frame.
  await save(join(PUBLIC, 'apple-touch-icon.png'), onBackground(iconArt, 180, 0.06).png({ compressionLevel: 9 }));
  await save(join(PUBLIC, 'icon-192.png'), onBackground(iconArt, 192, 0.06).png({ compressionLevel: 9 }));
  await save(join(PUBLIC, 'icon-512.png'), onBackground(iconArt, 512, 0.06).png({ compressionLevel: 9 }));
  // Maskable: art inside the 80 % safe zone.
  await save(join(PUBLIC, 'icon-maskable-512.png'), onBackground(iconArt, 512, 0.14).png({ compressionLevel: 9 }));
  await save(join(WEB, 'hd-app-icon-512.webp'), sharp(iconArt).resize(512, 512).webp({ nearLossless: true, quality: 80 }));

  // HEADER MARK: transparent head + collar at exact display sizes (1x, 2x, 3x of 22 px).
  for (const [scale, px] of [
    [1, 22],
    [2, 44],
    [3, 66],
  ]) {
    await save(join(WEB, `hd-mark-${scale}x.webp`), sharp(markArt).resize(px, px, { kernel: 'lanczos3' }).webp({ lossless: true }));
  }
  // APP HEADER: the head alone, 44 px (1x, 2x, 3x).
  for (const [scale, px] of [
    [1, 44],
    [2, 88],
    [3, 132],
  ]) {
    await save(join(WEB, `hd-head-${scale}x.webp`), sharp(headArt).resize(px, px, { kernel: 'lanczos3' }).webp({ lossless: true }));
  }
  // BOOT: the whole official art (head, collar, USB), 160 px at 2x.
  await save(join(WEB, 'hd-boot-320.webp'), sharp(iconArt).resize(320, 320, { kernel: 'lanczos3' }).webp({ quality: 92, alphaQuality: 100 }));

  // README / DOCS: full art and horizontal lockup, 2x of their display width.
  await save(join(WEB, 'hd-official-full-art-840.webp'), sharp(join(SRC, 'hd-official-full-art.png')).resize(840).webp({ quality: 90, smartSubsample: true }));
  await save(join(WEB, 'hd-lockup-horizontal-1200.webp'), sharp(await cleanAlpha(join(SRC, 'hd-lockup-horizontal.png'))).trim().resize(1200).webp({ quality: 92, alphaQuality: 100 }));

  // SOCIAL / OG: 1200 x 630 from the official banner (same aspect ratio).
  const banner = sharp(join(SRC, 'hd-social-banner.png')).resize(1200, 630, { fit: 'cover', kernel: 'lanczos3' });
  await save(join(SOCIAL, 'hd-og-1200x630.jpg'), banner.clone().jpeg({ quality: 90, mozjpeg: true }));
  await save(join(SOCIAL, 'hd-og-1200x630.webp'), banner.clone().webp({ quality: 90 }));

  // FLIPPER LAB TV: the overlay at 2x and 1x of its 560 px display width.
  // The screen opening and everything outside the body are transparent.
  const tv = await tvOverlay();
  for (const w of [1120, 560]) {
    await save(join(WEB, `hd-tv-orange-${w}.webp`), sharp(tv.png).resize(w, null, { kernel: 'lanczos3' }).webp({ quality: 88, alphaQuality: 100, effort: 6 }));
  }
  const profile = join(WEB, 'hd-tv-orange.profile.json');
  await writeFile(profile, JSON.stringify(tvProfile(tv), null, 2) + '\n');
  outputs.push([relative(repo, profile), (await stat(profile)).size]);

  // FLIPPER LAB BANNER: the full scene at 2x and 1x of its 800 px display width.
  for (const w of [1600, 800]) {
    await save(join(WEB, `hd-flipper-lab-banner-${w}.webp`), sharp(BANNER).resize(w, null, { kernel: 'lanczos3' }).webp({ quality: 82, smartSubsample: true, effort: 6 }));
  }

  // CAMERA SNIFFER BANNER: same sizes as the Flipper Lab banner.
  for (const w of [1600, 800]) {
    await save(join(WEB, `hd-camera-sniffer-banner-${w}.webp`), sharp(CAMERA_BANNER).resize(w, null, { kernel: 'lanczos3' }).webp({ quality: 82, smartSubsample: true, effort: 6 }));
  }

  // Posters: small print on them, so a near-lossless WebP; 1200 for the page, 2400 for full screen.
  for (const name of POSTERS) {
    for (const w of [1200, 2400]) {
      await save(join(POSTERS_WEB, `camera-sniffer-${name.toLowerCase()}-${w}.webp`), sharp(join(POSTERS_SRC, `Camera-Sniffer-${name}.png`)).resize(w, null, { kernel: 'lanczos3' }).webp({ quality: 86, smartSubsample: true, effort: 6 }));
    }
  }

  const width = Math.max(...outputs.map(([f]) => f.length));
  console.log('HARDWARE DOG / BRAND ASSETS\n');
  for (const [file, size] of outputs) console.log(`[ OK ] ${file.padEnd(width)}  ${(size / 1024).toFixed(1).padStart(7)} KB`);
}

main().catch((e) => {
  console.error('[FAIL]', e instanceof Error ? e.message : e);
  process.exit(1);
});
