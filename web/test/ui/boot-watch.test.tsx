// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = (import.meta.glob('../../public/boot-watch.js', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)['../../public/boot-watch.js']!;

function page() {
  document.body.innerHTML = '<main id="intro"><h1>Hardware Dog</h1></main><div id="app"></div>';
  new Function(source)();
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the static introduction while the interface downloads (public/boot-watch.js)', () => {
  it('a file that fails to download is said, with RELOAD', () => {
    page();
    const script = document.createElement('script');
    document.head.appendChild(script);
    script.dispatchEvent(new Event('error'));
    expect(document.querySelector('.boot-watch')?.textContent).toMatch(/could not be downloaded/);
    expect(document.querySelector('.boot-watch button')?.textContent).toBe('RELOAD');
    expect(document.querySelector('.boot-watch')?.getAttribute('role')).toBe('alert');
  });

  it('a slow download is said after 8 s; nothing is said once the interface is on the page', () => {
    vi.useFakeTimers();
    page();
    vi.advanceTimersByTime(8001);
    expect(document.querySelector('.boot-watch')?.textContent).toMatch(/still downloading/);
    document.body.innerHTML = '<main id="intro"></main><div id="app"><p>the interface</p></div>';
    new Function(source)();
    vi.advanceTimersByTime(8001);
    expect(document.querySelector('.boot-watch')).toBeNull();
  });
});
