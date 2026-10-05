/**
 * LVL 90.4: what the interface shows of a pack, and how a pack of boards
 * on USB is built by hand.
 */
import { describe, expect, it } from 'vitest';
import { MAX_DOGS, PackBuilder } from '../src/core/packbuilder';
import { System, memoryStore } from '../src/core/system';
import { PackTransport } from '../src/core/transport';
import { clockText } from '../src/core/format';
import { FakeTransport, T0 } from './helpers';

async function twoDogs() {
  let now = T0;
  const sys = new System(memoryStore(), () => now);
  const a = new FakeTransport();
  const b = new FakeTransport();
  for (const [link, t0] of [
    [a, 0],
    [b, 9000],
  ] as const) {
    link.send = (cmd) => {
      link.sent.push(cmd);
      if (cmd.cmd === 'time') link.push({ type: 'time', t: now - T0 + t0, id: cmd.id });
    };
  }
  await sys.connect(
    new PackTransport([
      { dog: 'D1', link: a },
      { dog: 'D2', link: b },
    ]),
  );
  return { sys, a, b, at: (t: number) => (now = T0 + t) };
}

describe('the pack as the interface shows it', () => {
  it('one device: no pack to show', () => {
    expect(new System(memoryStore()).packView()).toEqual([]);
  });

  it('every Dog: its link, what it observes or was refused, its clock', async () => {
    const { sys, a, b, at } = await twoDogs();
    // before any hello: waiting, nothing observed, no clock
    expect(sys.packView().map((d) => [d.id, d.link, d.clock.state])).toEqual([
      ['D1', 'WAITING', 'NONE'],
      ['D2', 'WAITING', 'NONE'],
    ]);
    b.send = (cmd) => b.sent.push(cmd); // D2 never answers a time sample
    a.push({ type: 'hello', t: 0, proto: 1, device: 'HD-A', rev: 'A', fw: '1', caps: ['power', 'usb'] });
    b.push({ type: 'hello', t: 9000, proto: 1, device: 'HD-B', rev: 'B', fw: '2', caps: ['usb', 'net'] });
    at(10);
    const [d1, d2] = sys.packView();
    expect(d1).toMatchObject({ link: 'ONLINE', observes: ['power', 'usb'], refused: [], clock: { state: 'ALIGNED' } });
    expect(d1!.clock.errMs!).toBeLessThan(1);
    expect(d1!.device!.id).toBe('HD-A');
    // D2 claimed usb too: refused, and its clock is still the hello's (unbounded)
    expect(d2).toMatchObject({ link: 'ONLINE', observes: ['net'], refused: ['usb'], clock: { state: 'UNBOUNDED', errMs: null } });
    a.sink!.lost('cable pulled');
    expect(sys.packView()[0]!.link).toBe('LOST');
  });

  it('a clock is said as it is known', () => {
    expect(clockText({ state: 'NONE', errMs: null })).toBe('--');
    expect(clockText({ state: 'UNBOUNDED', errMs: null })).toBe('UNBOUNDED');
    expect(clockText({ state: 'ALIGNED', errMs: 2.345 })).toBe('+-2.3 ms');
    expect(clockText({ state: 'ALIGNED', errMs: 175.4 })).toBe('+-175 ms');
  });
});

describe('a pack of boards on USB, one port per click', () => {
  const same = (x: FakeTransport, y: FakeTransport) => x === y;

  it('D1, D2... in the order picked; one board is never two Dogs', () => {
    const b = new PackBuilder(same);
    const p1 = new FakeTransport();
    const p2 = new FakeTransport();
    expect(b.add(p1)).toBeNull();
    expect(() => b.build()).toThrow(/two Dogs or more/);
    expect(b.add(p1)).toMatch(/already D1/);
    expect(b.add(p2)).toBeNull();
    const pack = b.build();
    expect(pack.dogs).toEqual(['D1', 'D2']);
  });

  it(`stops at ${MAX_DOGS} Dogs, like dogd`, () => {
    const b = new PackBuilder(same);
    for (let k = 0; k < MAX_DOGS; k++) expect(b.add(new FakeTransport())).toBeNull();
    expect(b.add(new FakeTransport())).toMatch(/at most/);
    expect(b.build().dogs).toHaveLength(MAX_DOGS);
  });
});

describe('the report of a pack', () => {
  it('says it was a pack: every Dog, what it observed, its clock', async () => {
    const { SimulatedPack } = await import('../src/core/simpack');
    const { buildReport, reportToText } = await import('../src/core/report');
    let now = T0;
    const sys = new System(memoryStore(), () => now);
    const pack = new SimulatedPack({ seed: 7, manual: true, scenario: 'HD-T001' });
    await sys.boot(pack, () => {}, 0);
    for (let k = 0; k < 30_000 / 5; k++) pack.advance(5, (t) => (now = T0 + t));
    const r = buildReport(sys, now);
    expect(r.device).toBe('PACK OF 3 (HD-P0WER HD-TARGET HD-NET)');
    const section = r.sections.find((s) => s.title === 'PACK')!;
    expect(section.rows.map(([k]) => k)).toEqual(['D1', 'D2', 'D3']);
    expect(section.rows[1]![1]).toMatch(/^HD-TARGET rev SIM fw 0\.1\.0 \/ observes usb uart i2c \/ clock \+-\d+(\.\d)? ms \/ ONLINE$/);
    expect(section.result).toBe('PASS');
    expect(reportToText(r)).toMatch(/PACK[\s\S]*D2\s+HD-TARGET/);
  });
});
