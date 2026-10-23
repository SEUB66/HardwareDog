// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { SessionArchive } from '../../src/core/archive';
import { createLab } from '../../src/core/lab/context';
import { button, key, mount, unmountAll, wait } from './dom';

/** The real interface, on memory storage, motion reduced: the boot screen is short. No dogd here. */
async function boot() {
  globalThis.fetch = async () => {
    throw new TypeError('no dogd in this test');
  };
  localStorage.setItem('hwdog.settings.v1', JSON.stringify({ reducedMotion: true }));
  const { App } = await import('../../src/ui/App');
  const archive = await SessionArchive.open(10);
  const lab = await createLab('test', () => true);
  const root = mount(<App archive={archive} lab={lab} />);
  for (let n = 0; n < 60 && !root.querySelector('.whatsnew'); n++) await wait(50);
  await wait(200); // effects run after paint
  return { root, lab };
}

afterEach(() => {
  unmountAll();
  localStorage.clear();
});

describe('the interface, rendered (audit 2026-10)', () => {
  it("What's New is a real modal: the page behind is inert, until it closes", async () => {
    const { root } = await boot();
    const dialog = root.querySelector<HTMLElement>('.whatsnew')!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const nav = root.querySelector('nav.nav')!;
    const main = root.querySelector('#workspace')!;
    expect(nav.closest('[inert]')).not.toBeNull();
    expect(main.closest('[inert]')).not.toBeNull();
    // Tab from the last control comes back to the first, never into the page
    const inside = [...dialog.querySelectorAll<HTMLElement>('button')];
    inside.at(-1)!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(inside[0]);
    await wait(500); // taps count after a moment (ghost clicks)
    key('Escape');
    await wait(50);
    expect(root.querySelector('.whatsnew')).toBeNull();
    expect(nav.closest('[inert]')).toBeNull();
    expect(main.closest('[inert]')).toBeNull();
  }, 30_000);

  it('the palette gives focus back where it was; a screen change is focused and said', async () => {
    const { root } = await boot();
    await wait(500);
    key('Escape');
    await wait(50);
    const trace = [...root.querySelectorAll<HTMLButtonElement>('nav.nav button')].find((b) => b.textContent?.includes('TRACE'))!;
    trace.focus();
    key('k', { ctrlKey: true });
    await wait(50);
    expect(root.querySelector('.palette')).not.toBeNull();
    expect(document.activeElement?.closest('.palette')).not.toBeNull();
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(50);
    expect(root.querySelector('.palette')).toBeNull();
    expect(document.activeElement).toBe(trace);

    key('3');
    await wait(50);
    const main = root.querySelector<HTMLElement>('#workspace')!;
    expect(document.activeElement).toBe(main);
    expect(main.querySelector('.sr-only[aria-live]')?.textContent).toBe('POWER: supply voltage and current');
    expect(button(root, 'POWER')?.getAttribute('aria-current')).toBe('page');
  }, 30_000);
});
