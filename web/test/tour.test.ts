import { describe, expect, it } from 'vitest';
import { TOUR } from '../src/ui/Tour';

/**
 * The tour points at parts of the interface by CSS selector. A renamed
 * class would silently drop a stop: every selector must still name
 * something the interface renders.
 */
const ui = Object.values(import.meta.glob('../src/ui/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>).join('\n');

describe('the interface tour', () => {
  it('every stop points at something the interface renders', () => {
    for (const stop of TOUR) {
      for (const cls of stop.target.match(/\.[a-z][a-z-]*/g) ?? []) {
        expect(ui, `${stop.title}: ${cls}`).toMatch(new RegExp(`class(Name)?=["{\`][^"}\`]*\\b${cls.slice(1)}\\b`));
      }
      for (const [, panel] of stop.target.matchAll(/panel-([a-z-]+)/g)) {
        expect(ui, `${stop.title}: panel ${panel}`).toMatch(new RegExp(`title="${panel!.replace(/-/g, ' ').toUpperCase()}"`));
      }
    }
  });

  it('starts at the top and ends by saying how to play it again', () => {
    expect(TOUR[0]!.target).toBe('.head');
    expect(TOUR.at(-1)!.text).toMatch(/TOUR at the top plays it again/);
  });
});
