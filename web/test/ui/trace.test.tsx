// @vitest-environment happy-dom
import { options, render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { System, memoryStore } from '../../src/core/system';
import { Trace } from '../../src/ui/screens/Trace';
import { mount, unmountAll, wait } from './dom';

afterEach(unmountAll);

describe('TRACE (audit 2026-10)', () => {
  it('a new event redraws its row, not the rows already on screen', async () => {
    const system = new System(memoryStore());
    for (let i = 0; i < 300; i++) system.mark(`event ${i}`);
    const root = mount(<Trace system={system} />);
    await wait(30);
    const before = root.querySelectorAll('tbody tr').length;
    expect(before).toBeGreaterThan(299);
    // count the table rows preact diffs on the next render
    let rows = 0;
    const diffed = options.diffed;
    options.diffed = (vnode) => {
      if (vnode.type === 'tr') rows++;
      diffed?.(vnode);
    };
    try {
      system.mark('one more');
      render(<Trace system={system} />, root);
      await wait(30);
    } finally {
      options.diffed = diffed;
    }
    expect(root.querySelectorAll('tbody tr').length).toBe(before + 1);
    expect(rows).toBeLessThan(5);
  });
});
