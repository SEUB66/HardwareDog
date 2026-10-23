// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { failedModule, lazyScreen } from '../../src/ui/lazyScreen';
import { button, mount, unmountAll, wait } from './dom';

afterEach(unmountAll);

const Section = ({ label }: { label: string }) => <p class="section">{label}</p>;
const fail = (url: string) => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`));

describe('a section loaded when it is opened (audit: poor connection)', () => {
  it('names the file a failed import names', () => {
    expect(failedModule(new TypeError('Failed to fetch dynamically imported module: https://hardwaredog.org/assets/FlipperLab-x1.js'))).toBe('https://hardwaredog.org/assets/FlipperLab-x1.js');
    expect(failedModule(new TypeError('error loading dynamically imported module: http://127.0.0.1:4173/assets/B-2.js?retry=1'))).toBe('http://127.0.0.1:4173/assets/B-2.js');
    expect(failedModule(new TypeError('Importing a module script failed.'))).toBeNull();
  });

  it('a failed download is retried under a fresh address, never the plain import again', async () => {
    const asked: (string | undefined)[] = [];
    const lab = lazyScreen(
      'TEST LAB',
      (url?: string) => (asked.push(url), asked.length < 3 ? fail('http://x/assets/T-1.js') : Promise.resolve({ Section })),
      (m) => m.Section,
      async () => {},
    );
    const root = mount(<lab.Screen label="here" />);
    expect(root.textContent).toContain('LOADING TEST LAB');
    for (let n = 0; n < 20 && !root.querySelector('.section'); n++) await wait(20);
    expect(root.querySelector('.section')?.textContent).toBe('here');
    expect(asked).toEqual([undefined, 'http://x/assets/T-1.js?retry=1', 'http://x/assets/T-1.js?retry=2']);
  });

  it('after the automatic retries it says so, offers RETRY, and RETRY asks afresh again', async () => {
    let ok = false;
    const asked: (string | undefined)[] = [];
    const lab = lazyScreen('TEST LAB', (url?: string) => (asked.push(url), ok ? Promise.resolve({ Section }) : fail('http://x/assets/T-2.js')), (m) => m.Section, async () => {});
    const root = mount(<lab.Screen label="back" />);
    for (let n = 0; n < 20 && !root.querySelector('[role="alert"]'); n++) await wait(20);
    expect(root.textContent).toContain('TEST LAB could not be loaded');
    expect(asked).toHaveLength(3);
    ok = true;
    button(root, 'RETRY')!.click();
    for (let n = 0; n < 20 && !root.querySelector('.section'); n++) await wait(20);
    expect(root.querySelector('.section')?.textContent).toBe('back');
    expect(asked.at(-1)).toBe('http://x/assets/T-2.js?retry=3');
  });
});
