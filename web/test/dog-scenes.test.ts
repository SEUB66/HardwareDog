import { describe, expect, it } from 'vitest';
import atlasJson from '../../assets/brand/web/hd-dog-scenes.json';
import { DOG_SCENE_IDS, dogFrameAt, dogSceneFor, type DogSceneId } from '../src/ui/lab/dogSprites';

const atlas = atlasJson as unknown as {
  frame: { w: number; h: number };
  frames: string[];
  source: string;
  scenes: Record<string, { at: [number, number][]; eyes: unknown[]; ear: unknown; dog: { x0: number; y0: number; x1: number; y1: number } }>;
};

describe("the dog's scenes (the owner's sheet)", () => {
  it('has every scene of the sheet, four frames each, on the 136 x 100 grid', () => {
    expect(atlas.frame).toEqual({ w: 136, h: 100 });
    expect(atlas.frames).toEqual(['base', 'breath', 'blink', 'ear']);
    expect(atlas.source).toBe('assets/brand/source/hd-companion-dog-sheet.png');
    expect(Object.keys(atlas.scenes).sort()).toEqual([...DOG_SCENE_IDS].sort());
    const seen = new Set<string>();
    for (const id of DOG_SCENE_IDS) {
      const s = atlas.scenes[id]!;
      expect(s.at).toHaveLength(4);
      // the dog was found in every scene, and is a dog-sized shape
      expect(s.dog.x1 - s.dog.x0, id).toBeGreaterThan(25);
      expect(s.dog.y1 - s.dog.y0, id).toBeGreaterThan(20);
      for (const [x, y] of s.at) {
        expect(x % 136).toBe(0);
        expect(y % 100).toBe(0);
        expect(seen.has(`${x},${y}`)).toBe(false);
        seen.add(`${x},${y}`);
      }
    }
  });

  it('breathes on a slow cycle, blinks only where the drawing has open eyes', () => {
    const frames = (id: DogSceneId) => new Set(Array.from({ length: 800 }, (_, i) => dogFrameAt(id, i * 25)));
    for (const id of DOG_SCENE_IDS) {
      const f = frames(id);
      expect(f.has(0) && f.has(1), id).toBe(true);
      expect(f.has(2), id).toBe(atlas.scenes[id]!.eyes.length > 0);
    }
    // asleep with a tune, eyes shut with joy: no blink
    expect(atlas.scenes.idle!.eyes).toEqual([]);
    expect(atlas.scenes.success!.eyes).toEqual([]);
  });
});

describe('which scene plays', () => {
  const at = (scene: Parameters<typeof dogSceneFor>[0], tool = '', calm = false, t = 0, section = 'STATUS') => dogSceneFor(scene, t, { tool, topic: null }, { section, calm });

  it('a section opened is a decor on the workshop monitor; an operation started is the activity', () => {
    expect(at('wait', '', false, 0, 'BLE')).toEqual({ id: 'hero', t: 0, monitor: { kind: 'decor' } });
    expect(at('search', 'ble.scan')?.id).toBe('bluetooth');
    expect(at('connect', 'device.connect')?.id).toBe('usb');
    expect(at('connect', 'device.console')?.id).toBe('serial');
    expect(at('search', 'camera.net')?.id).toBe('network');
    expect(at('search', 'net.watch')?.id).toBe('network');
    expect(at('read', 'camera.object')?.id).toBe('camera');
    expect(at('read', 'camera.inspect')?.id).toBe('analyze');
    expect(at('read', 'device.usb')?.id).toBe('usb');
    expect(at('read', 'device.serial')?.id).toBe('serial');
    expect(at('search', 'device.bus')?.monitor).toEqual({ kind: 'board' });
    expect(at('read', 'device.power')?.monitor).toEqual({ kind: 'meter' });
    expect(at('read', 'device.replay')?.id).toBe('replay');
    expect(at('transfer', 'lab.report')?.id).toBe('export');
    expect(at('success')?.id).toBe('success');
    expect(at('error')?.id).toBe('error');
    expect(at('disconnect')?.id).toBe('disconnected');
    expect(at('shutdown')?.id).toBe('idle');
    expect(dogSceneFor('none', 0)).toBeNull();
  });

  it('waiting, cancelled, unavailable: said without pretending to work', () => {
    expect(at('permission')?.monitor).toEqual({ kind: 'sign', name: 'LOCK', blink: true });
    expect(at('cancel', '', false, 100)?.monitor).toEqual({ kind: 'text', text: '--' });
    expect(at('cancel', '', false, 900)?.monitor).toEqual({ kind: 'decor' });
    const na = at('unavailable');
    expect(na).toEqual({ id: 'hero', t: 0, monitor: { kind: 'text', text: 'N/A' }, still: true });
  });

  it('values and the nap come only when calm: never over an operation, an error or a request', () => {
    const seen = (calm: boolean) => new Set(Array.from({ length: 200 }, (_, i) => JSON.stringify(at('wait', '', calm, i * 500))));
    const calm = [...seen(true)].join(' ');
    expect(calm).toContain('"kind":"text"');
    expect(calm).toContain('"id":"idle"');
    const busy = [...seen(false)];
    expect(busy).toHaveLength(200); // only the time changes
    expect(busy.every((s) => s.includes('"kind":"decor"'))).toBe(true);
  });
});
