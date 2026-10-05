/**
 * HARDWARE DOG / BUILDING A PACK BY HAND
 *
 * Several boards on USB, each picked by the operator, one click per port
 * (the browser asks for a gesture every time). They become D1, D2... in
 * the order picked. dogd does the same from its --source list.
 */

import type { Transport } from './transport';
import { PackTransport } from './transport';

/** At most as many Dogs as dogd takes. */
export const MAX_DOGS = 8;

export class PackBuilder<T extends Transport> {
  private readonly picked: T[] = [];

  constructor(private readonly same: (a: T, b: T) => boolean) {}

  get links(): readonly T[] {
    return this.picked;
  }

  /** Add one Dog. Returns why not, or null. */
  add(link: T): string | null {
    const twice = this.picked.findIndex((p) => this.same(p, link));
    if (twice >= 0) return `this port is already D${twice + 1}: one board is one Dog`;
    if (this.picked.length >= MAX_DOGS) return `a pack is ${MAX_DOGS} Dogs at most`;
    this.picked.push(link);
    return null;
  }

  /** The pack, once there are two Dogs or more. */
  build(): PackTransport {
    if (this.picked.length < 2) throw new Error('a pack is two Dogs or more: add another port');
    return new PackTransport(this.picked.map((link, n) => ({ dog: `D${n + 1}`, link })));
  }
}
