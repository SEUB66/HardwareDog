import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { SIM_RETENTION, SessionArchive, idbBackend, memoryBackend, type ArchiveBackend } from '../src/core/archive';
import { ReplayTransport, SessionRecorder, newHeader, parseHdlog } from '../src/core/session';
import { sha256 } from '../src/core/sha256';
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
  it('streams a live session to storage, sealed, and finalizes it on stop', async () => {
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
    const file = parseHdlog(text);
    expect(file.integrity!.status).toBe('VERIFIED');
    expect(file.integrity!.footer!.seals).toBeGreaterThanOrEqual(4); // one per flush with data
    expect(file.entries).toEqual(live.recording.entries);
    const [meta] = await archive.list();
    expect(meta!.entries).toBe(live.recording.entries.length);
    expect(meta!.bytes).toBe(new TextEncoder().encode(text).length);
    expect(meta!.closed).toBe('NORMAL');
    expect(meta!.fileSha256).toBe(sha256(text));
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
    const file = parseHdlog(await archive.text(writer.meta.key));
    expect(file.integrity!.status).toBe('VERIFIED');
    expect(file.entries).toEqual(rec.entries);
  });

  it('recovers a session that was never closed, keeping only sealed lines', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null });
    for (let k = 0; k < 10; k++) rec.add({ at: T0 + k, mark: `m${k}` });
    await writer.flush();
    rec.add({ at: T0 + 99, mark: 'never sealed' }); // the tab closes here
    const before = await archive.text(writer.meta.key);
    expect(parseHdlog(before).integrity!.status).toBe('INCOMPLETE');

    expect(await archive.recover([writer.meta.key])).toEqual([]); // still recording: untouched
    expect(await archive.recover()).toEqual([writer.meta.key]);
    const text = await archive.text(writer.meta.key);
    const file = parseHdlog(text);
    expect(file.integrity!.status).toBe('RECOVERED');
    expect(file.entries).toHaveLength(10);
    expect(text.startsWith(before)).toBe(true); // sealed bytes untouched
    const [meta] = await archive.list();
    expect(meta!.closed).toBe('RECOVERED');
    expect(meta!.fileSha256).toBe(sha256(text));
    expect(await archive.recover()).toEqual([]); // once
  });

  it('exports a live session as a verifiable SNAPSHOT while it keeps recording', async () => {
    const archive = new SessionArchive(await backend());
    const rec = new SessionRecorder(header(T0, 'WEB SERIAL'));
    const writer = archive.record(rec, undefined, { flushMs: null });
    for (let k = 0; k < 6; k++) rec.add({ at: T0 + k, mark: `m${k}` });
    await writer.flush();
    rec.add({ at: T0 + 6, mark: 'pending at export time' });
    const snap = parseHdlog(await archive.snapshotText(writer));
    expect(snap.integrity!.status).toBe('VERIFIED');
    expect(snap.integrity!.footer!.closed).toBe('SNAPSHOT');
    expect(snap.entries).toHaveLength(7);
    for (let k = 7; k < 12; k++) rec.add({ at: T0 + k, mark: `m${k}` });
    await writer.stop();
    const full = parseHdlog(await archive.text(writer.meta.key));
    expect(full.integrity!.status).toBe('VERIFIED');
    expect(full.integrity!.footer!.closed).toBe('NORMAL');
    expect(full.entries).toHaveLength(12);
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
    expect(parseHdlog(await archive.text(b)).entries).toHaveLength(5);
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
