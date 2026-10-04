/**
 * LVL 90.2: a pack is recorded (hdlog v3) and its replay is the session
 * again: same timeline, same clocks, same facts, same diagnosis.
 */
import { describe, expect, it } from 'vitest';
import { BUILD } from '../src/core/ascii';
import { HdlogError, ReplayTransport, SessionRecorder, newHeader, parseHdlog, recoverHdlog, toHdlog } from '../src/core/session';
import { SimulatedPack } from '../src/core/simpack';
import { System, memoryStore } from '../src/core/system';
import { PackTransport } from '../src/core/transport';
import { thresholdsOf } from '../src/core/types';
import type { ScenarioId } from '../src/core/scenarios';
import { FakeTransport, T0, diagnosisKeys } from './helpers';

const headerFor = (pack: PackTransport, sys: System, scenario: string | null) =>
  newHeader({
    id: 'HD-PACK',
    startedAt: T0,
    source: 'PACK',
    endpoint: pack.label,
    scenario,
    app: BUILD,
    thresholds: thresholdsOf(sys.settings),
    dogs: pack.links.map((l) => ({ id: l.dog, source: l.kind, endpoint: l.label, origin: l.origin })),
  });

async function recordPack(scenario: ScenarioId, seconds: number, seed = 3) {
  let now = T0;
  const sys = new System(memoryStore(), () => now);
  const pack = new SimulatedPack({ seed, manual: true, scenario });
  sys.recorder = new SessionRecorder(headerFor(pack, sys, scenario));
  await sys.boot(pack, () => {}, 0);
  for (let k = 0; k < seconds * 200; k++) pack.advance(5, (t) => (now = T0 + t));
  await sys.disconnect();
  sys.evaluate(now);
  return { sys, text: toHdlog(sys.recorder.recording) };
}

async function replay(text: string) {
  const r = new ReplayTransport(parseHdlog(text));
  const sys = new System(memoryStore(), () => r.clock);
  await sys.boot(r, () => {}, 0);
  return sys;
}

/** What the Dogs said, as the operator sees it: times included. */
const timeline = (sys: System) =>
  sys.trace
    .all()
    .filter((e) => e.source !== 'SYS' && e.source !== 'USER')
    .map((e) => `${e.t} ${e.source} ${e.severity} ${e.message} ${e.value ?? ''} #${e.seq ?? ''}`);

describe('hdlog v3: a pack recorded and replayed', () => {
  it('is written as v3: the Dogs in the header, one on every line', async () => {
    const { text } = await recordPack('HD-T001', 20);
    const r = parseHdlog(text);
    expect(r.integrity!.status).toBe('VERIFIED');
    expect(r.header.hdlog).toBe(3);
    expect(r.header.source).toBe('PACK');
    expect(r.header.origin).toBe('SIMULATED');
    expect(r.header.dogs!.map((d) => d.id)).toEqual(['D1', 'D2', 'D3']);
    for (const e of r.entries) if ('frame' in e || 'cmd' in e) expect(e.dog, JSON.stringify(e)).toMatch(/^D[123]$/);
    // the clock samples are in the evidence: when each was asked, and the answer
    expect(r.entries.filter((e) => 'cmd' in e && e.cmd.cmd === 'time').length).toBeGreaterThanOrEqual(6);
    expect(r.integrity!.footer!.dogs).toEqual({
      D1: { id: 'HD-P0WER', rev: 'SIM', fw: '0.1.0' },
      D2: { id: 'HD-TARGET', rev: 'SIM', fw: '0.1.0' },
      D3: { id: 'HD-NET', rev: 'SIM', fw: '0.1.0' },
    });
  });

  for (const scenario of ['HD-T001', 'HD-T016', 'HD-T014'] as ScenarioId[]) {
    it(`${scenario}: the replay is the session again, timeline, clocks, facts and diagnosis`, async () => {
      const live = await recordPack(scenario, 45);
      const sys = await replay(live.text);
      expect(sys.frameErrors).toBe(0);
      expect(timeline(sys)).toEqual(timeline(live.sys));
      expect(diagnosisKeys(sys)).toEqual(diagnosisKeys(live.sys));
      expect(sys.facts).toEqual(live.sys.facts);
      expect([...sys.owners]).toEqual([...live.sys.owners]);
      for (const dog of ['D1', 'D2', 'D3']) {
        expect(sys.pack!.clocks.get(dog)!.errAt(T0 + 40_000), dog).toBe(live.sys.pack!.clocks.get(dog)!.errAt(T0 + 40_000));
      }
      // exporting the replay gives the same bytes back
      expect(toHdlog(parseHdlog(live.text))).toBe(live.text);
    });
  }

  it('a time answer recorded right after its command still bounds the clock in the replay', async () => {
    // A Dog that answers inside send(): the answer must follow its command in the file.
    let now = T0;
    const sys = new System(memoryStore(), () => now);
    const a = new FakeTransport();
    const b = new FakeTransport();
    for (const [link, t0] of [
      [a, 0],
      [b, 5000],
    ] as const) {
      link.send = (cmd) => {
        link.sent.push(cmd);
        if (cmd.cmd === 'time') link.push({ type: 'time', t: now - T0 + t0, id: cmd.id });
      };
    }
    const pack = new PackTransport([
      { dog: 'D1', link: a },
      { dog: 'D2', link: b },
    ]);
    sys.recorder = new SessionRecorder(headerFor(pack, sys, null));
    await sys.connect(pack);
    a.push({ type: 'hello', t: 0, proto: 1, device: 'HD-A', rev: 'A', fw: '1', caps: ['power'] });
    b.push({ type: 'hello', t: 5000, proto: 1, device: 'HD-B', rev: 'A', fw: '1', caps: ['usb'] });
    now = T0 + 50;
    a.push({ type: 'power', t: 50, v: 4.2, i: 0.1 });
    b.push({ type: 'usb.detach', t: 5060 });
    await sys.disconnect();
    expect(sys.pack!.clocks.get('D2')!.synced).toBe(true);
    const text = toHdlog(sys.recorder.recording);
    const lines = text.split('\n').map((l) => (l ? JSON.parse(l) : null));
    const cmdAt = lines.findIndex((l) => l?.cmd?.cmd === 'time' && l.dog === 'D2');
    const answerAt = lines.findIndex((l) => l?.frame?.type === 'time' && l.dog === 'D2');
    expect(cmdAt).toBeGreaterThan(0);
    expect(answerAt).toBeGreaterThan(cmdAt);
    const replayed = await replay(text);
    expect(replayed.pack!.clocks.get('D2')!.synced).toBe(true);
    expect(replayed.facts).toEqual(sys.facts);
  });

  it('an unfinished pack recording is recovered, and stays a pack', async () => {
    const { text } = await recordPack('HD-T001', 10);
    const cut = text.slice(0, text.lastIndexOf('{"end"'));
    expect(parseHdlog(cut).integrity!.status).toBe('INCOMPLETE');
    const recovered = parseHdlog(recoverHdlog(cut)!);
    expect(recovered.integrity!.status).toBe('RECOVERED');
    expect(recovered.header.dogs!.length).toBe(3);
    expect(Object.keys(recovered.integrity!.footer!.dogs!)).toEqual(['D1', 'D2', 'D3']);
  });

  it('a Dog moved from one line to another is a MODIFIED file', async () => {
    const { text } = await recordPack('HD-T001', 5);
    const tampered = text.replace('"dog":"D1","frame":{"type":"power"', '"dog":"D3","frame":{"type":"power"');
    expect(tampered).not.toBe(text);
    expect(parseHdlog(tampered).integrity!.status).toBe('MODIFIED');
  });
});

describe('hdlog v3 from anyone', () => {
  const good = async () => (await recordPack('HD-T000', 2)).text;
  const withHeader = (text: string, patch: (h: Record<string, unknown>) => void) => {
    const [first, ...rest] = text.split('\n');
    const h = JSON.parse(first!) as Record<string, unknown>;
    patch(h);
    return [JSON.stringify(h), ...rest].join('\n');
  };
  const refuses = (text: string, why: RegExp) => {
    expect(() => parseHdlog(text)).toThrow(HdlogError);
    expect(() => parseHdlog(text)).toThrow(why);
  };

  it('refuses a header that does not describe a real pack', async () => {
    const t = await good();
    refuses(
      withHeader(t, (h) => delete h['dogs']),
      /lists 2 to 16 Dogs/,
    );
    refuses(
      withHeader(t, (h) => (h['source'] = 'SIMULATOR')),
      /source must be PACK/,
    );
    refuses(
      withHeader(t, (h) => ((h['dogs'] as { id: string }[])[1]!.id = 'D1')),
      /listed twice/,
    );
    refuses(
      withHeader(t, (h) => (h['origin'] = 'PHYSICAL')),
      /PHYSICAL only if every Dog is/,
    );
    refuses(
      withHeader(t, (h) => ((h['dogs'] as { origin: string }[])[0]!.origin = 'PHYSICAL')),
      /origin contradicts its source/,
    );
    refuses(
      withHeader(t, (h) => ((h['dogs'] as { id: string }[])[0]!.id = 'X1')),
      /id D1, D2/,
    );
  });

  it('refuses a line that names no Dog of the pack, or a mark that names one', async () => {
    const t = await good();
    refuses(t.replace('"dog":"D2","frame"', '"dog":"D9","frame"'), /names no Dog of the pack/);
    refuses(t.replace(/,"dog":"D2","frame"/, ',"frame"'), /names no Dog of the pack/);
    const [first, second, ...rest] = t.split('\n');
    const at = (JSON.parse(second!) as { at: number }).at;
    refuses([first, JSON.stringify({ at, dog: 'D1', mark: 'x' }), ...rest].join('\n'), /belongs to the pack, not to a Dog/);
  });

  it('one device is still written as v2, byte for byte as before', () => {
    const h = newHeader({ id: 'X', startedAt: T0, source: 'SIMULATOR', endpoint: 'sim', scenario: null, app: BUILD });
    expect(h.hdlog).toBe(2);
    expect('dogs' in h).toBe(false);
  });
});
