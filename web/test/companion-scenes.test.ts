import { describe, expect, it } from 'vitest';
import atlasJson from '../../assets/brand/web/hd-companion-scenes.json';
import { SCENE_IDS, frameAt, sceneFor } from '../src/ui/lab/sprites';

const atlas = atlasJson as unknown as {
  frame: { w: number; h: number };
  frames: string[];
  scenes: Record<string, { at: [number, number][]; eye: unknown; source: string }>;
};

describe('companion scenes (the owner sketch sheets)', () => {
  it('has every drawn scene, three frames each, on the 136 x 100 grid', () => {
    expect(atlas.frame).toEqual({ w: 136, h: 100 });
    expect(atlas.frames).toEqual(['base', 'breath', 'blink']);
    expect(Object.keys(atlas.scenes).sort()).toEqual([...SCENE_IDS].sort());
    const seen = new Set<string>();
    for (const id of SCENE_IDS) {
      const s = atlas.scenes[id]!;
      expect(s.at).toHaveLength(3);
      expect(s.source).toMatch(/^hd-companion-sheet-[12]\.png cell [0-2],[0-2]$/);
      for (const [x, y] of s.at) {
        expect(x % 136).toBe(0);
        expect(y % 100).toBe(0);
        expect(seen.has(`${x},${y}`)).toBe(false);
        seen.add(`${x},${y}`);
      }
    }
  });

  it('picks the scene from what the tool is doing', () => {
    const at = (scene: Parameters<typeof sceneFor>[0], tool = '', topic: string | null = null, t = 0) => sceneFor(scene, t, { tool, topic })?.id;
    expect(sceneFor('none', 0)).toBeNull();
    expect(at('idle')).toBe('coding');
    expect(at('wait')).toBe('idle');
    expect(at('greet')).toBe('boot');
    expect(at('connect', 'flipper.link')).toBe('connect');
    expect(at('search', 'ble.scan')).toBe('bluetooth');
    expect(at('search', 'flipper.files')).toBe('scan');
    expect(at('read', 'flipper.files', 'ir')).toBe('infrared');
    expect(at('read', 'flipper.files', 'nfc')).toBe('rfid');
    expect(at('read', 'flipper.files', 'subghz')).toBe('scan');
    expect(at('read', 'flipper.gpio')).toBe('uart');
    expect(at('read', 'flipper.files', 'badusb')).toBe('analyze');
    expect(at('transfer', 'flipper.copy')).toBe('backup');
    expect(at('transfer', 'flipper.write')).toBe('transfer');
    expect(at('success', 'lab.report')).toBe('report');
    expect(at('success', 'flipper.files')).toBe('success');
    expect(at('disconnect')).toBe('disconnected');
    expect(at('shutdown')).toBe('shutdown');
  });

  it('is cross first at an error, then tries a fix, the fix starting from its own beginning', () => {
    expect(sceneFor('error', 1000)).toEqual({ id: 'mad', t: 1000 });
    expect(sceneFor('error', 4000)).toEqual({ id: 'repair', t: 500 });
  });

  it('breathes on a slow cycle and blinks only where the drawing has an open eye', () => {
    const frames = (id: (typeof SCENE_IDS)[number]) => new Set(Array.from({ length: 400 }, (_, i) => frameAt(id, i * 25)));
    for (const id of SCENE_IDS) {
      const f = frames(id);
      expect(f.has(0) && f.has(1)).toBe(true);
      expect(f.has(2)).toBe(atlas.scenes[id]!.eye !== null);
    }
    // a sleeping companion, a happy one with its eyes shut: no blink
    expect(atlas.scenes.idle!.eye).toBeNull();
    expect(atlas.scenes.success!.eye).toBeNull();
  });
});
