import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { SIM_RETENTION, SessionArchive, idbBackend, memoryBackend, type ArchiveBackend } from '../src/core/archive';
import { ReplayTransport, SessionRecorder, newHeader, toHdlog } from '../src/core/session';
import { System, memoryStore } from '../src/core/system';
import { T0, diagnosisKeys, recordSession } from './helpers';

const backends: [string, () => Promise<ArchiveBackend>][] = [
  ['memory', async () => memoryBackend()],
  ['indexeddb', async () => (await idbBackend(new IDBFactory()))!],
];

const header = (startedAt: number, source: 'SIMULATOR' | 'WEB SERIAL') =>
  newHeader({ id: `HD-${startedAt}`, startedAt, source, endpoint: 'x', scenario: null, app: 'test' });

/** Archive a session with `entries` marks in it. */
async function archived(archive: SessionArchive, startedAt: number, source: 'SIMULATOR' | 'WEB SERIAL', entries = 1) {
  const rec = new SessionRecorder(header(startedAt, source));
  const writer = archive.record(rec, undefined, { flushMs: null });
  for (let k = 0; k < entries; k++) rec.add({ at: startedAt + k, mark: `m${k}` });
  await writer.stop();
  return writer.meta.key;
}

describe.each(backends)('session archive (%s)', (_, backend) => {
  it('streams a live session to storage and exports it byte for byte', async () => {
    const archive = new SessionArchive(await backend());
    const live = await recordSession('HD-T005', 30);
    // Stream the session again, flushing as the app does while it runs.
    const rec = new SessionRecorder(live.recorder.header);
    const writer = archive.record(rec, () => diagnosisKeys(live.sys), { flushMs: null });
    live.recording.entries.forEach((e, n) => {
      rec.add(e);
      if (n % 400 === 0) void writer.flush();
    });
    await writer.stop();

    const text = await archive.text(writer.meta.key);
    expect(text).toBe(toHdlog(live.recording));
    const [meta] = await archive.list();
    expect(meta!.entries).toBe(live.recording.entries.length);
    expect(meta!.bytes).toBe(new TextEncoder().encode(text).length);
    expect(meta!.diagnoses).toEqual(diagnosisKeys(live.sys));
    expect(meta!.diagnoses.some((d) => d.startsWith('USB_INTERMITTENT'))).toBe(true);
  });

  it('replays an archived session to the same diagnosis', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'SIMULATOR'), { keep: false });
    const writer = archive.record(rec, undefined, { flushMs: null });
    const live = await recordSession('HD-T001', 30);
    for (const e of live.recording.entries) rec.add(e);
    await writer.stop();
    expect(rec.entries).toHaveLength(0); // keep: false leaves memory to the archive

    const r = new ReplayTransport(await archive.load(writer.meta.key));
    const sys = new System(memoryStore(), () => r.clock);
    await sys.boot(r, () => {}, 0);
    expect(diagnosisKeys(sys)).toEqual(diagnosisKeys(live.sys));
  });

  it('keeps chunks in order even when flushes overlap', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null });
    for (let k = 0; k < 50; k++) {
      rec.add({ at: T0 + k, mark: `m${k}` });
      void writer.flush(); // never awaited: the queue orders them
    }
    await writer.stop();
    expect(await archive.text(writer.meta.key)).toBe(toHdlog(rec.recording));
  });

  it('measures the file again when the endpoint label changes', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null });
    rec.header.endpoint = 'USB CDC 303A:1001'; // known only once the port is open
    rec.add({ at: T0, mark: 'a' });
    await writer.stop();
    const text = await archive.text(writer.meta.key);
    expect(text.startsWith(JSON.stringify(rec.header))).toBe(true);
    expect((await archive.list())[0]!.bytes).toBe(new TextEncoder().encode(text).length);
  });

  it('lists a session from its first second, before any entry', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null });
    await writer.flush();
    const [meta] = await archive.list();
    expect(meta!.key).toBe(writer.meta.key);
    expect(meta!.entries).toBe(0);
    await writer.stop();
  });

  it('prunes old simulator sessions, never hardware sessions with data', async () => {
    const archive = new SessionArchive(await backend());
    const sims: string[] = [];
    for (let k = 0; k < SIM_RETENTION + 3; k++) sims.push(await archived(archive, T0 + k * 1000, 'SIMULATOR'));
    const hw = await archived(archive, T0 - 10_000_000, 'WEB SERIAL', 3);
    const emptyHw = await archived(archive, T0 - 20_000_000, 'WEB SERIAL', 0);
    const active = sims[0]!; // oldest, but still being recorded

    const dropped = await archive.prune([active]);
    const left = (await archive.list()).map((m) => m.key);
    expect(left).toContain(hw);
    expect(left).toContain(active);
    expect(left).not.toContain(emptyHw);
    expect(left.filter((k) => sims.includes(k))).toHaveLength(SIM_RETENTION);
    expect(dropped).toHaveLength(4);
    // newest simulator sessions survive
    expect(left).toContain(sims.at(-1));
  });

  it('removes a session with all its chunks', async () => {
    const archive = new SessionArchive(await backend());
    const a = await archived(archive, T0, 'WEB SERIAL', 5);
    const b = await archived(archive, T0 + 1, 'WEB SERIAL', 5);
    await archive.remove(a);
    expect((await archive.list()).map((m) => m.key)).toEqual([b]);
    expect(await archive.backend.chunks(a)).toEqual([]);
    expect((await archive.text(b)).split('\n').filter(Boolean)).toHaveLength(6);
    await expect(archive.text(a)).rejects.toThrow(/no archived session/);
  });
});

describe('archive failures', () => {
  it('stops recording at the first failed write: no silent gap', async () => {
    const base = memoryBackend();
    let fail = false;
    const flaky: ArchiveBackend = { ...base, append: (m, s, t) => (fail ? Promise.reject(new Error('QuotaExceededError')) : base.append(m, s, t)) };
    const archive = new SessionArchive(flaky);
    const errors: string[] = [];
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null, onError: (e) => errors.push(e) });
    rec.add({ at: T0, mark: 'a' });
    await writer.flush();
    fail = true;
    rec.add({ at: T0 + 1, mark: 'b' });
    await writer.flush();
    fail = false;
    rec.add({ at: T0 + 2, mark: 'c' });
    await writer.stop();

    expect(writer.error).toMatch(/QuotaExceededError/);
    expect(errors).toHaveLength(1);
    const text = await archive.text(writer.meta.key);
    expect(text).toContain('"mark":"a"');
    expect(text).not.toContain('"mark":"c"');
  });

  it('falls back to memory when IndexedDB is not available', async () => {
    expect(await idbBackend(null)).toBeNull();
    const refusing = { open: () => { throw new DOMException('storage disabled', 'SecurityError'); } } as unknown as IDBFactory;
    expect(await idbBackend(refusing)).toBeNull();
    const archive = new SessionArchive(memoryBackend());
    expect(archive.persistent).toBe(false);
  });
});
