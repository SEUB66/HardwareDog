import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import profileJson from '../../assets/brand/web/hd-tv-orange.profile.json';
import { checkProfile, type Box, type TvProfile } from '../src/ui/lab/tvSkin';

const root = decodeURIComponent(new URL('../../assets/brand/web/', import.meta.url).pathname);
const profile = checkProfile(profileJson as unknown as TvProfile);

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const dialBox = (p: TvProfile): Box => ({ x: p.dial.cx - p.dial.rx, y: p.dial.cy - p.dial.ry, w: p.dial.rx * 2, h: p.dial.ry * 2 });

describe('TV mapping profile', () => {
  it('zones are inside the picture and never overlap: POWER, the dial and the handle are separate', () => {
    expect(overlap(profile.power, dialBox(profile))).toBe(false);
    expect(overlap(profile.power, profile.handle)).toBe(false);
    expect(overlap(profile.power, profile.screen.box)).toBe(false);
    expect(overlap(dialBox(profile), profile.screen.box)).toBe(false);
  });

  it('the overlay is transparent outside the body and in the whole screen opening, opaque on the controls', async () => {
    for (const file of ['hd-tv-orange-560.webp', 'hd-tv-orange-1120.webp']) {
      const { data, info } = await sharp(`${root}${file}`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alpha = (nx: number, ny: number) => data[(Math.floor(ny * info.height) * info.width + Math.floor(nx * info.width)) * 4 + 3]!;
      expect(info.width / info.height).toBeCloseTo(profile.reference.ratio, 2);
      // outside the body
      expect(alpha(0.005, 0.5)).toBe(0);
      expect(alpha(0.5, 0.004)).toBe(0);
      // inside the opening, center and near its corners (inside the bleed)
      const b = profile.screen.box;
      for (const [x, y] of [
        [0.5, 0.5],
        [0.12, 0.12],
        [0.88, 0.12],
        [0.12, 0.88],
        [0.88, 0.88],
      ])
        expect(alpha(b.x + b.w * x, b.y + b.h * y), `${file} screen ${x},${y}`).toBe(0);
      // the body, the POWER button, the dial, the logo: opaque
      for (const z of [profile.power, profile.logo, dialBox(profile)]) expect(alpha(z.x + z.w / 2, z.y + z.h / 2)).toBe(255);
      expect(alpha(0.06, 0.5)).toBe(255);
    }
  });

  it('normalized coordinates map to the same picture point at any size', () => {
    for (const width of [220, 320, 560, 1120, 2240]) {
      const height = width / profile.reference.ratio;
      const px = (profile.power.x + profile.power.w / 2) * width;
      const py = (profile.power.y + profile.power.h / 2) * height;
      const ref = { x: (px / width) * profile.reference.width, y: (py / height) * profile.reference.height };
      // the POWER button's center in the source picture, whatever the display size
      expect(ref.x).toBeCloseTo(1305, 0);
      expect(ref.y).toBeCloseTo(516, 0);
    }
  });
});
