/**
 * Component tests: the real components rendered into happy-dom (files
 * marked `@vitest-environment happy-dom`). Nothing here is a mock of the
 * interface; only the device side is faked, as in the engine tests.
 */
import { render, type ComponentChild } from 'preact';

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mounted: HTMLElement[] = [];

/** Render into a fresh element of the document body. */
export function mount(node: ComponentChild): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(node, root);
  mounted.push(root);
  return root;
}

/** Unmount everything mounted (effects cleaned up), for afterEach. */
export function unmountAll(): void {
  for (const root of mounted.splice(0)) {
    render(null, root);
    root.remove();
  }
}

/** The first button whose text contains `text`. */
export const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

export const key = (k: string, extra: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
