import { describe, expect, it } from 'vitest';
import { Trace } from '../src/core/trace';

describe('Trace', () => {
  it('keeps the timeline sorted when events arrive out of order', () => {
    const t = new Trace();
    t.append(100, 'USB', 'INFO', 'a');
    t.append(300, 'USB', 'INFO', 'c');
    t.append(200, 'POWER', 'WARN', 'b');
    expect(t.all().map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('keeps recording while the view is paused', () => {
    const t = new Trace();
    t.append(1, 'SYS', 'INFO', 'before');
    t.pause();
    t.append(2, 'SYS', 'INFO', 'during 1');
    t.append(3, 'SYS', 'INFO', 'during 2');
    expect(t.visible().map((e) => e.message)).toEqual(['before']);
    expect(t.buffered).toBe(2);
    expect(t.size).toBe(3);
    t.resume();
    expect(t.visible()).toHaveLength(3);
    expect(t.buffered).toBe(0);
  });

  it('enforces its capacity by dropping the oldest events', () => {
    const t = new Trace(3);
    for (let n = 0; n < 5; n++) t.append(n, 'SYS', 'INFO', String(n));
    expect(t.all().map((e) => e.message)).toEqual(['2', '3', '4']);
  });

  it('finds the latest matching event before a time', () => {
    const t = new Trace();
    t.append(10, 'POWER', 'WARN', 'drop 1');
    t.append(20, 'USB', 'WARN', 'detach');
    t.append(30, 'POWER', 'WARN', 'drop 2');
    expect(t.lastBefore(25, (e) => e.source === 'POWER')?.message).toBe('drop 1');
  });
});
