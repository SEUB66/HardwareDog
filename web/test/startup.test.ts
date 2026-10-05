import { describe, expect, it } from 'vitest';
import { System, memoryStore } from '../src/core/system';

/** The interface opens on the boot screen with nothing connected: only real checks. */
describe('the start with no device', () => {
  it('reports what it can check, says it is not connected, and invents no device service', async () => {
    const sys = new System(memoryStore());
    const steps = await sys.start(() => {}, 0);
    expect(steps.map((s) => `${s.label}:${s.status}`)).toEqual([
      'EVENT BUS:OK',
      'LOCAL STORAGE:OK',
      'TRACE ENGINE:OK',
      'DIAGNOSTIC RULES:OK',
      'HARDWARE INTERFACE:WARN',
    ]);
    expect(steps.at(-1)!.detail).toMatch(/not connected/);
    // nothing measured, nothing on the timeline, no link
    expect(sys.trace.all()).toEqual([]);
    expect(sys.link).not.toBe('ONLINE');
  });
});
