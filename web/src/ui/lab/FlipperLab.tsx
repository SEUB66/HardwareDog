/**
 * HARDWARE DOG / FLIPPER LAB
 *
 * A permanent section for the Flipper Zero, an optional instrument:
 * Hardware Dog works without it. The banner, the link, the tools, the
 * workspace, the TV in its place, and the way to captures, sessions and
 * the log.
 *
 * Read-only by default. WRITE MODE is a deliberate switch; every write
 * checks for an existing file first, an overwrite needs a confirmation,
 * a delete needs one, a recursive delete needs two.
 */

import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { joinPath, parentOf } from '../../core/flipper/client';
import { compareParsed, parseFlipperFile, type ParsedFile } from '../../core/flipper/formats';
import { safeFileName, searchLibrary, type LibraryItem, type LibrarySort } from '../../core/flipper/library';
import { GPIO_PINS, type FlipperFile, type GpioPin } from '../../core/flipper/rpc';
import { describeDevice } from '../../core/flipper/service';
import type { Lab } from '../../core/lab/context';
import { errorInfo } from '../../core/lab/events';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';
import { FilePreview } from './FilePreview';
import { LabLog } from './LabLog';
import { LabSessionsPanel } from './LabSessionsPanel';
import { TvDocked, type TvPlacement } from './TvHost';
import { useRev } from './useRev';
import banner800 from '../../../../assets/brand/web/hd-flipper-lab-banner-800.webp';
import banner1600 from '../../../../assets/brand/web/hd-flipper-lab-banner-1600.webp';

export const FLIPPER_TOOLS = ['DEVICE', 'FILES', 'LIBRARY', 'COMPARE', 'GPIO', 'LOG', 'SESSIONS'] as const;
export type FlipperTool = (typeof FLIPPER_TOOLS)[number];

const TOOL_PURPOSE: Record<FlipperTool, string> = {
  DEVICE: 'who it is, what it reports',
  FILES: 'browse the SD card',
  LIBRARY: 'copies on this computer',
  COMPARE: 'two captures side by side',
  GPIO: 'read the pins',
  LOG: 'every operation, with codes',
  SESSIONS: 'record, mark, compare',
};

const bytes = (n: number | bigint) => {
  const v = Number(n);
  return v < 1024 ? `${v} B` : v < 1024 ** 2 ? `${(v / 1024).toFixed(1)} KiB` : v < 1024 ** 3 ? `${(v / 1024 ** 2).toFixed(1)} MiB` : `${(v / 1024 ** 3).toFixed(2)} GiB`;
};

export function download(name: string, type: string, content: BlobPart) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Runs an action, keeps its error for the screen (the log and the TV get it from the bus). */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const { message, code } = errorInfo(e);
      if (code !== 'NotFoundError') setError(code ? `[${code}] ${message}` : message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

function Device({ lab }: { lab: Lab }) {
  const v = lab.flipper.view;
  const d = describeDevice(v.info);
  const { run, error, busy } = useAction();
  if (v.link !== 'CONNECTED') return <p class="note">Connect a Flipper (or the demo) to read what it reports about itself.</p>;
  return (
    <>
      <Panel title="DEVICE INFORMATION" info="Exactly what the Flipper reported over RPC (system device info), key by key, unchanged. Hardware Dog adds nothing to it.">
        <div class="actions">
          <button class="btn" disabled={busy} onClick={() => void run(() => lab.flipper.refreshInfo())}>
            READ AGAIN
          </button>
          {v.origin === 'SIMULATED' && <Tag status="WARN" label="DEMO DEVICE" />}
        </div>
        {error && <p class="note warn">{error}</p>}
        <dl class="kv">
          <dt>NAME</dt>
          <dd>{d.name ?? '--'}</dd>
          <dt>MODEL</dt>
          <dd>{d.model ?? '--'}</dd>
          <dt>FIRMWARE</dt>
          <dd>{d.firmware ?? '--'}</dd>
          <dt>RPC PROTOBUF</dt>
          <dd>{v.protobuf ? `${v.protobuf.major}.${v.protobuf.minor}` : 'not reported'}</dd>
          <dt>SD CARD</dt>
          <dd>{v.storage.ext ? `${bytes(v.storage.ext.free)} free of ${bytes(v.storage.ext.total)}` : 'not reported (no card?)'}</dd>
          <dt>INTERNAL</dt>
          <dd>{v.storage.int ? `${bytes(v.storage.int.free)} free of ${bytes(v.storage.int.total)}` : 'not reported'}</dd>
        </dl>
        <details>
          <summary>ALL {v.info.length} KEYS AS REPORTED</summary>
          <table class="trace">
            <tbody>
              {v.info.map(([k, val]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td class="mono">{val}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </Panel>
      <Panel title="WHAT HARDWARE DOG CAN DRIVE" info="Functions really exposed over the Flipper RPC and implemented here. A function on the Flipper's own screen is not necessarily reachable from a computer.">
        <table class="trace caps">
          <tbody>
            <tr>
              <td>Storage: list, stat, read, copy</td>
              <td>
                <Tag status="PASS" label="YES" />
              </td>
              <td>read-only, always</td>
            </tr>
            <tr>
              <td>Storage: write, folder, rename, delete</td>
              <td>
                <Tag status="PASS" label="YES" />
              </td>
              <td>WRITE MODE only; overwrite and delete confirmed</td>
            </tr>
            <tr>
              <td>GPIO: read pin mode and level</td>
              <td>
                <Tag status="PASS" label="YES" />
              </td>
              <td>never changes a pin</td>
            </tr>
            <tr>
              <td>UART</td>
              <td>
                <Tag status="INFO" label="VIA APP" />
              </td>
              <td>the Flipper's USB-UART Bridge app makes it a serial adapter: read it in SERIAL (no RPC needed)</td>
            </tr>
            <tr>
              <td>IR / Sub-GHz transmit, NFC / RFID emulate</td>
              <td>
                <Tag status="UNKNOWN" label="NOT HERE" />
              </td>
              <td>not driven by Hardware Dog: captures are inspected, not replayed</td>
            </tr>
            <tr>
              <td>Firmware update, reboot, factory reset</td>
              <td>
                <Tag status="UNKNOWN" label="NEVER" />
              </td>
              <td>Hardware Dog never changes a device's firmware</td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function Files({ lab, onPreview, preview }: { lab: Lab; onPreview: (p: { name: string; path: string; data: Uint8Array } | null) => void; preview: { name: string; path: string; data: Uint8Array } | null }) {
  const v = lab.flipper.view;
  const { run, error, busy } = useAction();
  const [writeMode, setWriteMode] = useState(false);
  const [path, setPath] = useState(v.cwd);
  useEffect(() => setPath(v.cwd), [v.cwd]);
  if (v.link !== 'CONNECTED') return <p class="note">Connect a Flipper (or the demo) to browse its storage.</p>;
  const crumbs = v.cwd.split('/').filter(Boolean);
  const open = (f: FlipperFile) => {
    const p = joinPath(v.cwd, f.name);
    if (f.type === 'DIR') void run(() => lab.flipper.list(p));
    else void run(async () => onPreview({ name: f.name, path: p, data: await lab.flipper.read(p) }));
  };
  const upload = (file: File) =>
    void run(async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      const target = joinPath(v.cwd, file.name);
      const exists = v.entries?.some((e) => e.name === file.name);
      if (exists && !confirm(`${target} already exists on the Flipper.\n\nOVERWRITE it with ${file.name} (${data.length} bytes)? Its current content will be lost.`)) return;
      await lab.flipper.write(target, data, !!exists);
      await lab.flipper.list(v.cwd);
    });
  return (
    <Panel title="FILES" info="The Flipper's storage, read over RPC. Opening a file reads it into this page only; COPY keeps it in this computer's library. Nothing is written unless WRITE MODE is on.">
      <div class="actions files-bar">
        <span class="crumbs">
          <button class="btn" disabled={busy} onClick={() => void run(() => lab.flipper.list('/ext'))}>
            /ext
          </button>
          <button class="btn" disabled={busy} onClick={() => void run(() => lab.flipper.list('/int'))}>
            /int
          </button>
          <button class="btn" disabled={busy || crumbs.length <= 1} onClick={() => void run(() => lab.flipper.list(parentOf(v.cwd)))} title="Up one folder">
            ↑ UP
          </button>
        </span>
        <form
          class="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => lab.flipper.list(path));
          }}
        >
          <input class="input" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} aria-label="Path on the Flipper" spellcheck={false} />
          <button class="btn" type="submit" disabled={busy}>
            GO
          </button>
        </form>
        <label class={`check write-toggle${writeMode ? ' on' : ''}`}>
          <input type="checkbox" checked={writeMode} onChange={(e) => setWriteMode((e.target as HTMLInputElement).checked)} />
          WRITE MODE
        </label>
      </div>
      {writeMode && (
        <div class="actions write-bar">
          <span class="note warn">WRITE MODE: changes the Flipper's storage. Existing files are never replaced without asking.</span>
          <button
            class="btn"
            disabled={busy}
            onClick={() => {
              const n = prompt('New folder name');
              if (n) void run(async () => (await lab.flipper.mkdir(joinPath(v.cwd, n.trim())), lab.flipper.list(v.cwd)));
            }}
          >
            NEW FOLDER
          </button>
          <label class="btn file-btn">
            UPLOAD FILE…
            <input type="file" hidden onChange={(e) => (e.target as HTMLInputElement).files?.[0] && upload((e.target as HTMLInputElement).files![0]!)} />
          </label>
        </div>
      )}
      {error && <p class="note warn">{error}</p>}
      <div class="files-split">
        <table class="trace files">
          <thead>
            <tr>
              <th>NAME</th>
              <th>SIZE</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(v.entries ?? []).length === 0 && (
              <tr>
                <td colSpan={3} class="dim">
                  (empty folder)
                </td>
              </tr>
            )}
            {(v.entries ?? []).map((f) => {
              const p = joinPath(v.cwd, f.name);
              return (
                <tr key={f.name} class={preview?.path === p ? 'selected' : undefined}>
                  <td>
                    <button class="link" onClick={() => open(f)} disabled={busy}>
                      {f.type === 'DIR' ? '▸ ' : ''}
                      {f.name}
                      {f.type === 'DIR' ? '/' : ''}
                    </button>
                  </td>
                  <td class="num">{f.type === 'DIR' ? '' : bytes(f.size)}</td>
                  <td class="row-actions">
                    {f.type === 'FILE' && (
                      <button class="btn" disabled={busy} title="Copy to this computer's library" onClick={() => void run(() => lab.flipper.copyToLibrary(p))}>
                        COPY
                      </button>
                    )}
                    {writeMode && (
                      <>
                        <button
                          class="btn"
                          disabled={busy}
                          onClick={() => {
                            const n = prompt(`Rename ${f.name} to`, f.name);
                            if (n && n !== f.name) void run(async () => (await lab.flipper.rename(p, joinPath(v.cwd, n.trim())), lab.flipper.list(v.cwd)));
                          }}
                        >
                          RENAME
                        </button>
                        <button
                          class="btn danger"
                          disabled={busy}
                          onClick={() => {
                            if (!confirm(`DELETE ${p} on the Flipper?\n\nThis cannot be undone.`)) return;
                            const recursive = f.type === 'DIR' && confirm(`${p} is a folder. Delete EVERYTHING inside it too?\n\nCancel: delete it only if it is empty.`);
                            void run(async () => (await lab.flipper.remove(p, recursive), lab.flipper.list(v.cwd)));
                          }}
                        >
                          DELETE
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div class="files-preview">
          {preview ? (
            <>
              <div class="actions">
                <button class="btn" disabled={busy} onClick={() => void run(() => lab.flipper.copyToLibrary(preview.path))}>
                  COPY TO LIBRARY
                </button>
                <button class="btn" onClick={() => download(preview.name, 'application/octet-stream', preview.data.slice())}>
                  SAVE AS…
                </button>
                <button class="btn" onClick={() => onPreview(null)}>
                  CLOSE
                </button>
              </div>
              <FilePreview name={preview.path} data={preview.data} />
            </>
          ) : (
            <p class="note">Open a file to preview it. Recognized: .ir, .sub, .nfc, .rfid, .ibtn; anything else is shown as bytes.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Library({ lab, picked, onPick }: { lab: Lab; picked: string[]; onPick: (ids: string[]) => void }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('newest');
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => void lab.flipper.library.list().then(setItems, () => {});
  useEffect(() => {
    reload();
    return lab.bus.subscribe((e) => e.tool === 'flipper.copy' && e.type === 'op.end' && reload());
  }, [lab]);
  const shown = useMemo(() => searchLibrary(items, query, sort), [items, query, sort]);
  const item = items.find((i) => i.id === open) ?? null;
  const toggle = (id: string) => onPick(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked.slice(-1), id]);
  return (
    <Panel title="LIBRARY" info="Files copied from a Flipper, kept in this browser with their source path, device, origin (real or demo), time and SHA-256. Notes and tags are local. Nothing is uploaded.">
      <div class="actions">
        <input class="input" placeholder="search: words, tag:x, kind:ir" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search the library" />
        <select class="input" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as LibrarySort)} aria-label="Sort">
          <option value="newest">newest first</option>
          <option value="oldest">oldest first</option>
          <option value="name">name</option>
          <option value="kind">kind</option>
          <option value="size">size</option>
        </select>
        <span class="dim">
          {shown.length} of {items.length}
          {lab.flipper.library.persistent ? '' : ' · memory only (this browser refused storage)'}
        </span>
      </div>
      <table class="trace library">
        <thead>
          <tr>
            <th title="Pick two to compare">CMP</th>
            <th>NAME</th>
            <th>KIND</th>
            <th>FROM</th>
            <th>COPIED</th>
            <th>TAGS</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr>
              <td colSpan={6} class="dim">
                Nothing here yet: FILES → COPY keeps a file on this computer.
              </td>
            </tr>
          )}
          {shown.map((i) => (
            <tr key={i.id} class={open === i.id ? 'selected' : undefined}>
              <td>
                <input type="checkbox" checked={picked.includes(i.id)} onChange={() => toggle(i.id)} aria-label={`compare ${i.name}`} />
              </td>
              <td>
                <button class="link" onClick={() => setOpen(open === i.id ? null : i.id)}>
                  {i.name}
                </button>
              </td>
              <td>{i.kind}</td>
              <td title={i.path}>
                {i.device}
                {i.origin === 'SIMULATED' ? ' (DEMO)' : ''}
              </td>
              <td>{new Date(i.copiedAt).toLocaleString()}</td>
              <td>{i.tags.join(' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {item && <LibraryItemView lab={lab} item={item} onChange={reload} />}
    </Panel>
  );
}

function LibraryItemView({ lab, item, onChange }: { lab: Lab; item: LibraryItem; onChange: () => void }) {
  const [notes, setNotes] = useState(item.notes);
  const [tags, setTags] = useState(item.tags.join(' '));
  useEffect(() => {
    setNotes(item.notes);
    setTags(item.tags.join(' '));
  }, [item.id]);
  const save = () => void lab.flipper.library.annotate(item.id, { notes, tags: tags.split(/[\s,]+/) }).then(onChange);
  return (
    <div class="library-item">
      <dl class="kv">
        <dt>PATH</dt>
        <dd class="mono">{item.path}</dd>
        <dt>SHA-256</dt>
        <dd class="mono small">{item.sha256}</dd>
        <dt>SIZE</dt>
        <dd>{bytes(item.size)}</dd>
        <dt>ORIGIN</dt>
        <dd>{item.origin === 'SIMULATED' ? 'DEMO device (not a capture)' : 'a real Flipper'}</dd>
      </dl>
      <label class="field-col">
        NOTES
        <textarea class="input" rows={3} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} />
      </label>
      <label class="field-col">
        TAGS (space separated)
        <input class="input" value={tags} onInput={(e) => setTags((e.target as HTMLInputElement).value)} />
      </label>
      <div class="actions">
        <button class="btn primary" onClick={save}>
          SAVE NOTES
        </button>
        <button class="btn" onClick={() => download(item.name, 'application/octet-stream', item.data.slice())}>
          SAVE FILE AS…
        </button>
        <button
          class="btn danger"
          onClick={() => {
            if (confirm(`Remove ${item.name} from this computer's library? (The Flipper is not touched.)`)) void lab.flipper.library.remove(item.id).then(onChange);
          }}
        >
          REMOVE COPY
        </button>
      </div>
      <FilePreview name={item.name} data={item.data} />
    </div>
  );
}

function Compare({ lab, picked }: { lab: Lab; picked: string[] }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  useEffect(() => void lab.flipper.library.list().then(setItems, () => {}), [lab, picked.join()]);
  const [a, b] = picked.map((id) => items.find((i) => i.id === id)).filter((x): x is LibraryItem => !!x);
  if (!a || !b) return <p class="note">Pick two captures in LIBRARY (the CMP column): they are compared here, field by field.</p>;
  let pa: ParsedFile | null = null;
  let pb: ParsedFile | null = null;
  let err: string | null = null;
  try {
    pa = parseFlipperFile(a.data);
    pb = parseFlipperFile(b.data);
  } catch (e) {
    err = errorInfo(e).message;
  }
  const result = pa && pb ? compareParsed(pa, pb) : null;
  return (
    <Panel title="COMPARE" info="Two captures of the same kind, field by field: what differs, nothing else. No cause is inferred.">
      <p class="note">
        A: <b>{a.name}</b> ({a.device}) · B: <b>{b.name}</b> ({b.device})
      </p>
      {err && <p class="note warn">Not comparable: {err}</p>}
      {result && !result.comparable && <p class="note warn">{result.reason}</p>}
      {result?.comparable && result.diffs.length === 0 && <p class="note">No difference in the fields Hardware Dog reads.</p>}
      {result?.comparable && result.diffs.length > 0 && (
        <table class="trace">
          <thead>
            <tr>
              <th>WHERE</th>
              <th>A</th>
              <th>B</th>
            </tr>
          </thead>
          <tbody>
            {result.diffs.map((d) => (
              <tr key={d.where}>
                <td>{d.where}</td>
                <td class="mono">{d.a}</td>
                <td class="mono diff">{d.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Gpio({ lab }: { lab: Lab }) {
  const { run, error, busy } = useAction();
  const [reads, setReads] = useState<Partial<Record<GpioPin, { mode: string; value: number; at: number }>>>({});
  if (lab.flipper.view.link !== 'CONNECTED') return <p class="note">Connect a Flipper to read its GPIO pins.</p>;
  return (
    <Panel title="GPIO" info="Reads the mode and level of the Flipper's GPIO pins over RPC. Reading never changes a pin; Hardware Dog sets no pin mode and writes no level.">
      {error && <p class="note warn">{error}</p>}
      <table class="trace">
        <thead>
          <tr>
            <th>PIN</th>
            <th>MODE</th>
            <th>LEVEL</th>
            <th>READ AT</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {GPIO_PINS.map((pin) => {
            const r = reads[pin];
            return (
              <tr key={pin}>
                <td>{pin}</td>
                <td>{r?.mode ?? '--'}</td>
                <td>{r ? (r.value ? 'HIGH (1)' : 'LOW (0)') : '--'}</td>
                <td>{r ? new Date(r.at).toLocaleTimeString() : '--'}</td>
                <td>
                  <button class="btn" disabled={busy} onClick={() => void run(async () => setReads({ ...reads, [pin]: { ...(await lab.flipper.gpioRead(pin)), at: Date.now() } }))}>
                    READ
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p class="note dim">A level read on a pin configured as an output is the level the Flipper drives, not a measurement of the line.</p>
    </Panel>
  );
}

export function FlipperLab({ lab, placement, reducedMotion, tool, onTool }: { lab: Lab; placement: TvPlacement; reducedMotion: boolean; tool: FlipperTool; onTool: (t: FlipperTool) => void }) {
  useRev(lab.flipper);
  const v = lab.flipper.view;
  const d = describeDevice(v.info);
  const { run, error, busy } = useAction();
  const [preview, setPreview] = useState<{ name: string; path: string; data: Uint8Array } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const linkTag =
    v.link === 'CONNECTED' ? <Tag status="PASS" label="CONNECTED" /> : v.link === 'CONNECTING' ? <Tag status="UNKNOWN" label="CONNECTING" /> : v.link === 'DISCONNECTED' && v.reason === 'lost' ? <Tag status="FAIL" label="LINK LOST" /> : <Tag status="UNKNOWN" label={v.link === 'UNKNOWN' ? 'NOT CONNECTED' : v.link} />;
  const serial = typeof navigator !== 'undefined' && 'serial' in navigator;
  return (
    <div class="lab flipper-lab">
      <header class="lab-banner">
        <img src={banner800} srcset={`${banner800} 800w, ${banner1600} 1600w`} sizes="(max-width: 900px) 100vw, 900px" alt="Flipper Lab: the Hardware Dog robot dog and the Flipper dolphin in a retro electronics lab" width={800} height={320} decoding="async" />
        <div class="lab-banner-state">
          <span class={`light ${v.link === 'CONNECTED' ? 'ONLINE' : v.link === 'CONNECTING' ? 'CONNECTING' : v.reason === 'lost' ? 'LOST' : 'OFFLINE'}`} aria-hidden="true" />
          FLIPPER {linkTag}
        </div>
      </header>

      <div class="lab-connect">
        <div class="lab-connect-state">
          {linkTag}
          <span>{v.link === 'CONNECTED' ? `${d.name ?? 'Flipper'} · firmware ${d.firmware ?? '?'} · ${v.label}` : (v.label ?? 'No Flipper connected. Hardware Dog works without one.')}</span>
          {v.origin === 'SIMULATED' && <Tag status="WARN" label="DEMO" />}
          {v.busy && <span class="dim">· {v.busy}</span>}
        </div>
        <div class="actions">
          {v.link !== 'CONNECTED' ? (
            serial ? (
              <>
                <button class="btn primary" disabled={busy || v.link === 'CONNECTING'} title="Pick the Flipper in the browser port chooser (USB)" onClick={() => void run(() => lab.flipper.connect('serial'))}>
                  CONNECT FLIPPER (USB)
                </button>
                <button class="btn" disabled={busy || v.link === 'CONNECTING'} title="A simulated Flipper: everything it shows is labeled DEMO" onClick={() => void run(() => lab.flipper.connect('demo'))}>
                  DEMO FLIPPER
                </button>
              </>
            ) : (
              // No Web Serial here (a phone, Safari, Firefox): the demo is the way in, USB says where it works.
              <>
                <button class="btn primary" disabled={busy || v.link === 'CONNECTING'} title="A simulated Flipper: everything it shows is labeled DEMO" onClick={() => void run(() => lab.flipper.connect('demo'))}>
                  DEMO FLIPPER
                </button>
                <button class="btn usb-off" disabled title="Web Serial is not available in this browser: Chrome, Edge or Opera on a computer">
                  USB · COMPUTER ONLY
                </button>
              </>
            )
          ) : (
            <>
              <button class="btn" disabled={busy} onClick={() => void run(() => lab.flipper.disconnect())}>
                DISCONNECT
              </button>
              {v.origin === 'SIMULATED' && (
                <button class="btn" title="Demo only: pull the virtual cable, to see what happens when a link drops" onClick={() => lab.flipper.demo?.unplug()}>
                  PULL DEMO CABLE
                </button>
              )}
            </>
          )}
        </div>
        {!serial && <p class="note warn">This browser has no Web Serial: a real Flipper needs Chrome, Edge or Opera on a computer. The demo works everywhere.</p>}
        {error && <p class="note warn">{error}</p>}
        {v.error && v.error.code !== 'NotFoundError' && (
          <p class="note warn">
            Last failure: [{v.error.code}] {v.error.message}
          </p>
        )}
      </div>

      <div class="lab-body">
        <div class="lab-main">
          <nav class="lab-tools" aria-label="Flipper Lab tools">
            {FLIPPER_TOOLS.map((t) => (
              <button key={t} aria-current={tool === t ? 'page' : undefined} onClick={() => onTool(t)} title={TOOL_PURPOSE[t]}>
                <span class="lab-tool-name">{t}</span>
                <span class="lab-tool-purpose">{TOOL_PURPOSE[t]}</span>
              </button>
            ))}
          </nav>
          <div class="lab-workspace">
            {tool === 'DEVICE' && <Device lab={lab} />}
            {tool === 'FILES' && <Files lab={lab} preview={preview} onPreview={setPreview} />}
            {tool === 'LIBRARY' && <Library lab={lab} picked={picked} onPick={setPicked} />}
            {tool === 'COMPARE' && <Compare lab={lab} picked={picked} />}
            {tool === 'GPIO' && <Gpio lab={lab} />}
            {tool === 'LOG' && <LabLog lab={lab} only="FLIPPER" />}
            {tool === 'SESSIONS' && <LabSessionsPanel lab={lab} />}
          </div>
        </div>
        <aside class="lab-side" aria-label="Companion TV">
          <TvDocked companion={lab.companion} registry={lab.registry} placement={placement} reducedMotion={reducedMotion} />
          <SessionStrip lab={lab} />
        </aside>
      </div>
    </div>
  );
}

/** The recording, always in reach: REC, a marker, a note. */
export function SessionStrip({ lab }: { lab: Lab }) {
  useRev(lab.sessions);
  const [text, setText] = useState('');
  const r = lab.sessions.recorder;
  const rec = r?.recording ?? false;
  return (
    <div class="session-strip">
      <div class="actions">
        {rec ? (
          <button class="btn rec on" onClick={() => void lab.sessions.stop()} title="Stop and keep the lab session in this browser">
            ■ STOP · {r!.events.length} ev{r!.lost ? ` · ${r!.lost} LOST` : ''}
          </button>
        ) : (
          <button class="btn rec" onClick={() => lab.sessions.start('')} title="Record every lab event (Flipper, BLE, markers) on one timeline">
            ● REC LAB SESSION
          </button>
        )}
      </div>
      <form
        class="actions"
        onSubmit={(e) => {
          e.preventDefault();
          if (lab.sessions.mark(text)) setText('');
        }}
      >
        <input class="input" placeholder="marker: button pressed, cable plugged…" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="Marker text" />
        <button class="btn" type="submit">
          MARK
        </button>
      </form>
      <div class="quick-marks">
        {['button pressed', 'cable plugged', 'cable unplugged', 'power cycled'].map((m) => (
          <Fragment key={m}>
            <button class="btn small" onClick={() => lab.sessions.mark(m)}>
              {m}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
