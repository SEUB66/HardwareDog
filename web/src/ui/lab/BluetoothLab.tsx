/**
 * HARDWARE DOG / BLUETOOTH LAB
 *
 * Hardware Dog's own BLE scanner: no nRF Connect, no Flipper needed.
 * Sources are what this computer really offers (checked live): dogd on
 * Linux (BlueZ), Web Bluetooth where the browser has it, the demo.
 *
 *   names       advertised and system names apart; a name proves no model
 *   ids         as observed, with their kind; never merged
 *   RSSI        dBm, a radio level, never a distance
 *   presence    estimated from the last time seen, and labeled so
 *   payloads    bytes as reported, decoded fields next to them with the
 *               decoder's id and version
 *   PAUSE       freezes the screen; capture continues. STOP ends capture.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { SUPPORT_MATRIX, detectCapabilities, type Capability } from '../../core/ble/capabilities';
import { decodePayload, knownServiceUuids, loadNumbers, names } from '../../core/ble/decode';
import type { GattCharView, WriteMode } from '../../core/ble/gatt';
import { BLE_LIMITS, displayName, presence, shortUuid, viewDevices, type BleDevice, type BleFilter, type BleSort } from '../../core/ble/model';
import { SAMPLE_MS } from '../../core/ble/service';
import { VALUE_FORMATS, formatValue, parseValue, toHex, type ValueFormat } from '../../core/ble/values';
import type { Lab } from '../../core/lab/context';
import { errorInfo } from '../../core/lab/events';
import type { LabSessionData } from '../../core/lab/session';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';
import { HexView } from './HexView';
import { LabLog } from './LabLog';
import { LabSessionsPanel } from './LabSessionsPanel';
import { SessionStrip } from './FlipperLab';
import { useRev } from './useRev';
import { useSettled } from './useSettled';

export const BLE_TOOLS = ['SCAN', 'INSPECT', 'GATT', 'LOG', 'SESSIONS'] as const;
export type BleTool = (typeof BLE_TOOLS)[number];

const TOOL_PURPOSE: Record<BleTool, string> = {
  SCAN: 'every advertiser, live',
  INSPECT: 'one device, byte by byte',
  GATT: 'connect, read, write, notify',
  LOG: 'every operation, with codes',
  SESSIONS: 'record, reopen, compare',
};

const CAP_STATUS: Record<Capability['state'], 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'> = {
  AVAILABLE: 'PASS',
  UNSUPPORTED: 'FAIL',
  PERMISSION_MISSING: 'WARN',
  NO_ADAPTER: 'WARN',
  TEMPORARY_ERROR: 'WARN',
  UNKNOWN: 'UNKNOWN',
};

const ago = (ms: number) => (ms < 1000 ? 'now' : ms < 60_000 ? `${Math.round(ms / 1000)} s ago` : `${Math.round(ms / 60_000)} min ago`);
const PALETTE = ['var(--cyan)', 'var(--pink)', 'var(--amber)', 'var(--green)', '#b48cff', '#ff8a1e'];

function Capabilities({ caps, onRefresh }: { caps: Capability[] | null; onRefresh: () => void }) {
  return (
    <details class="caps-box">
      <summary>WHAT THIS COMPUTER CAN DO (checked live)</summary>
      <table class="trace">
        <thead>
          <tr>
            <th>TRANSPORT</th>
            <th>FEATURE</th>
            <th>STATE</th>
            <th>DETAIL</th>
          </tr>
        </thead>
        <tbody>
          {(caps ?? []).map((c) => (
            <tr key={`${c.transport}${c.feature}`}>
              <td>{c.transport}</td>
              <td>{c.feature}</td>
              <td>
                <Tag status={CAP_STATUS[c.state]} label={c.state.replace('_', ' ')} />
              </td>
              <td>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button class="btn" onClick={onRefresh}>
        CHECK AGAIN
      </button>
      <p class="note dim">As documented by browser vendors when this was written; the live check above is what counts on this machine.</p>
      <table class="trace">
        <thead>
          <tr>
            <th>SYSTEM</th>
            <th>WEB BLUETOOTH GATT</th>
            <th>WEB BLUETOOTH SCAN</th>
            <th>DOGD SCAN</th>
          </tr>
        </thead>
        <tbody>
          {SUPPORT_MATRIX.map((m) => (
            <tr key={m.os}>
              <td>{m.os}</td>
              <td>{m.webGatt}</td>
              <td>{m.webScan}</td>
              <td>{m.dogdScan}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** RSSI over time for the picked devices. dBm as reported; no smoothing, no distance. */
function RssiChart({ devices, now }: { devices: BleDevice[]; now: number }) {
  const span = 120_000;
  const lo = -105;
  const hi = -25;
  const x = (mono: number) => 1000 - ((now - mono) / span) * 1000;
  const y = (r: number) => ((hi - Math.max(lo, Math.min(hi, r))) / (hi - lo)) * 200;
  return (
    <figure class="rssi-chart">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="RSSI history of the selected devices, last 2 minutes">
        {[-40, -60, -80, -100].map((l) => (
          <line key={l} x1="0" x2="1000" y1={y(l)} y2={y(l)} class="grid" />
        ))}
        {devices.map((d, i) => {
          const pts = d.rssiHistory.filter((p) => now - p.mono <= span);
          if (pts.length === 0) return null;
          return <polyline key={d.key} points={pts.map((p) => `${x(p.mono).toFixed(1)},${y(p.rssi).toFixed(1)}`).join(' ')} style={{ stroke: PALETTE[i % PALETTE.length] }} />;
        })}
      </svg>
      <figcaption>
        RSSI (dBm), last 2 min, -40 / -60 / -80 / -100 lines.{' '}
        {devices.map((d, i) => (
          <span key={d.key} style={{ color: PALETTE[i % PALETTE.length] }}>
            ■ {displayName(d) ?? d.id}{' '}
          </span>
        ))}
        A level as reported, not a distance.
      </figcaption>
    </figure>
  );
}

function Scan({ lab, selected, onSelect, focus, onFocus }: { lab: Lab; selected: string[]; onSelect: (k: string[]) => void; focus: string | null; onFocus: (k: string) => void }) {
  const ble = lab.ble;
  useRev(ble.model);
  const [caps, setCaps] = useState<Capability[] | null>(null);
  const [filter, setFilter] = useState<BleFilter>({ text: '', minRssi: null, namedOnly: false, connectableOnly: false });
  const [sort, setSort] = useState<BleSort>('rssi');
  const [error, setError] = useState<string | null>(null);
  const frozen = useRef<BleDevice[] | null>(null);
  const refresh = () => void detectCapabilities().then(setCaps, () => {});
  useEffect(refresh, []);
  const now = performance.now();
  const live = viewDevices(ble.model.devices.values(), filter, sort, names.company);
  // PAUSE: the rows on screen stay as they were; the model keeps filling underneath.
  if (!ble.paused) frozen.current = null;
  else frozen.current ??= live.map((d) => ({ ...d, rssiHistory: [...d.rssiHistory] }));
  const rows = frozen.current ?? live;
  const { mark, settled } = useSettled();
  const start = (kind: 'WEB BLUETOOTH' | 'DOGD' | 'DEMO') => {
    if (!settled()) return;
    mark();
    setError(null);
    ble.start(kind).catch((e: unknown) => {
      const { message, code } = errorInfo(e);
      setError(code ? `[${code}] ${message}` : message);
      refresh();
    });
  };
  const capOf = (t: Capability['transport'], f: Capability['feature']) => caps?.find((c) => c.transport === t && c.feature === f);
  const toggle = (k: string) => onSelect(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k].slice(-6));
  const picked = [...ble.model.devices.values()].filter((d) => selected.includes(d.key));
  return (
    <>
      <Panel title="BLE SCAN" info="Advertisements as this computer's Bluetooth API reports them, not a radio capture. Every id is shown as observed; changing random addresses are new rows, never merged.">
        <div class="actions">
          {ble.scanning ? (
            <>
              <Tag status="LIVE" label={`SCANNING · ${ble.sourceKind}`} />
              <button class={`btn${ble.paused ? ' active' : ''}`} aria-pressed={ble.paused} onClick={() => settled() && ble.setPaused(!ble.paused)} title="Freeze the screen; the capture continues">
                {ble.paused ? 'RESUME VIEW' : 'PAUSE VIEW'}
              </button>
              <button class="btn primary" onClick={() => settled() && (mark(), void ble.stop())}>
                STOP SCAN
              </button>
            </>
          ) : (
            <>
              <button class="btn primary" disabled={capOf('DOGD', 'scan')?.state === 'UNSUPPORTED'} title={capOf('DOGD', 'scan')?.detail} onClick={() => start('DOGD')}>
                SCAN WITH DOGD
              </button>
              <button class="btn" disabled={capOf('WEB BLUETOOTH', 'scan')?.state === 'UNSUPPORTED'} title={capOf('WEB BLUETOOTH', 'scan')?.detail} onClick={() => start('WEB BLUETOOTH')}>
                SCAN WITH THIS BROWSER
              </button>
              <button class="btn" title="Simulated advertisers, labeled DEMO" onClick={() => start('DEMO')}>
                DEMO SCAN
              </button>
            </>
          )}
          {ble.origin === 'SIMULATED' && <Tag status="WARN" label="DEMO DATA" />}
          {ble.state === 'REPLAY' && <Tag status="INFO" label={`REPLAY · ${ble.replayOf}`} />}
          {ble.state === 'REPLAY' && ble.replayIntegrity && <Tag status={ble.replayIntegrity === 'VERIFIED' ? 'PASS' : 'WARN'} label={ble.replayIntegrity} />}
          {ble.state === 'REPLAY' && ble.replaySimulated && <Tag status="WARN" label="SIMULATED" />}
          {ble.state === 'REPLAY' && ble.replaySkipped > 0 && <Tag status="WARN" label={`${ble.replaySkipped} UNREADABLE`} />}
        </div>
        {(error || ble.error) && <p class="note warn">{error ?? `[${ble.error!.code}] ${ble.error!.message}`}</p>}
        <div class="counters">
          <span>{ble.model.devices.size} id(s)</span>
          <span>{ble.model.observations} observation(s)</span>
          <span>{ble.model.rate(now)}/s</span>
          <span class={ble.model.sourceLost ? 'amber' : undefined}>{ble.model.sourceLost} lost by the source</span>
          <span class={ble.model.refused ? 'amber' : undefined}>{ble.model.refused} refused (table full)</span>
          <span title={`A lab session writes a device's observation when its payload changes, else at most every ${SAMPLE_MS / 1000} s; the ones between are counted`}>{ble.sampledOut} sampled out of the session</span>
        </div>
        <Capabilities caps={caps} onRefresh={refresh} />
        <div class="actions filters">
          <input class="input" placeholder="filter: name, id, company, service" value={filter.text} onInput={(e) => setFilter({ ...filter, text: (e.target as HTMLInputElement).value })} aria-label="Filter devices" />
          <label class="check">
            min RSSI
            <input class="input narrow" type="number" min={-120} max={0} value={filter.minRssi ?? ''} onInput={(e) => setFilter({ ...filter, minRssi: (e.target as HTMLInputElement).value === '' ? null : Number((e.target as HTMLInputElement).value) })} aria-label="Minimum RSSI (dBm)" />
          </label>
          <label class="check">
            <input type="checkbox" checked={filter.namedOnly} onChange={(e) => setFilter({ ...filter, namedOnly: (e.target as HTMLInputElement).checked })} />
            named
          </label>
          <label class="check">
            <input type="checkbox" checked={filter.connectableOnly} onChange={(e) => setFilter({ ...filter, connectableOnly: (e.target as HTMLInputElement).checked })} />
            connectable (known)
          </label>
          <select class="input" value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as BleSort)} aria-label="Sort">
            <option value="rssi">RSSI (strongest)</option>
            <option value="name">name</option>
            <option value="lastSeen">last seen</option>
            <option value="firstSeen">first seen</option>
            <option value="count">observations</option>
          </select>
        </div>
        <div class="table-scroll">
          <table class="trace ble-table">
            <thead>
              <tr>
                <th title="Select up to 6 for the RSSI chart">SEL</th>
                <th>ADVERTISED NAME</th>
                <th>SYSTEM NAME</th>
                <th>ID (KIND)</th>
                <th>RSSI</th>
                <th>PRESENCE (est.)</th>
                <th>FIRST / LAST</th>
                <th>OBS</th>
                <th>DATA</th>
                <th>SOURCE</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} class="dim">
                    {ble.scanning ? 'Listening… nothing heard yet.' : 'Start a scan, or reopen a lab session.'}
                  </td>
                </tr>
              )}
              {rows.slice(0, 500).map((d) => {
                const p = ble.state === 'REPLAY' ? null : presence(d, now);
                return (
                  <tr key={d.key} class={focus === d.key ? 'selected' : undefined}>
                    <td>
                      <input type="checkbox" checked={selected.includes(d.key)} onChange={() => toggle(d.key)} aria-label={`chart ${d.id}`} />
                    </td>
                    <td>
                      <button class="link" onClick={() => onFocus(d.key)}>
                        {d.advName ?? <span class="dim">--</span>}
                      </button>
                    </td>
                    <td>{d.systemName ?? <span class="dim">--</span>}</td>
                    <td class="mono small" title={`${d.idKind}${d.address ? ` · address ${d.address} (${d.addressType ?? 'type unknown'})` : ' · address not exposed'}`}>
                      {d.id} <span class="dim">({d.idKind})</span>
                    </td>
                    <td class="num">{d.rssi === null ? '--' : `${d.rssi} dBm`}</td>
                    <td>{p ?? 'replay'}</td>
                    <td class="small">
                      {new Date(d.firstSeen).toLocaleTimeString()} / {ble.state === 'REPLAY' ? new Date(d.lastSeen).toLocaleTimeString() : ago(now - d.lastMono)}
                    </td>
                    <td class="num">{d.count}</td>
                    <td class="small">
                      {[...d.manufacturer.keys()].map((c) => names.company(c) ?? `0x${shortUuid(c)}`).join(', ')}
                      {d.serviceData.size ? ` · svc ${[...d.serviceData.keys()].join(' ')}` : ''}
                      {d.services.length ? ` · uuids ${d.services.length}` : ''}
                    </td>
                    <td class="small">{d.adapter}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 500 && <p class="note dim">First 500 rows shown: filter to narrow.</p>}
      </Panel>
      {picked.length > 0 && (
        <Panel title="RSSI HISTORY" info="Received signal strength of the selected ids, in dBm, as reported. RSSI varies with antennas, obstacles and orientation: it is not a distance.">
          {/* A replay's times are the recording page's clock: its chart ends at its last report. */}
          <RssiChart devices={picked} now={ble.state === 'REPLAY' ? Math.max(0, ...picked.flatMap((d) => d.rssiHistory.map((p) => p.mono))) : now} />
        </Panel>
      )}
    </>
  );
}

function PayloadBlock({ title, kind, keyId, data, previous }: { title: string; kind: 'manufacturer' | 'service'; keyId: number | string; data: Uint8Array; previous: Uint8Array | undefined }) {
  const dec = decodePayload(kind, keyId, data);
  return (
    <div class="payload">
      <div class="payload-head">
        <b>{title}</b> <span class="prov">AS REPORTED BY THE API</span>
      </div>
      <HexView bytes={data} compare={previous ?? null} label={title} />
      {dec ? (
        <div class="decoded">
          <span class="prov">
            DECODED by {dec.decoder} v{dec.version}
          </span>
          <table class="trace">
            <tbody>
              {dec.fields.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td class="mono">
                    {f.value}
                    {f.unit ? ` ${f.unit}` : ''}
                  </td>
                  <td class="dim small">
                    bytes {f.bytes[0]}–{f.bytes[1] - 1}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="note dim">No decoder claims this payload: shown raw, not guessed.</p>
      )}
    </div>
  );
}

function Inspect({ lab, focus }: { lab: Lab; focus: string | null }) {
  useRev(lab.ble.model);
  const d = focus ? lab.ble.device(focus) : undefined;
  if (!d) return <p class="note">Pick a device in SCAN (click its name) to inspect it here.</p>;
  return (
    <Panel title="INSPECTOR" info="One observed id, with the provenance of every field. Bytes are kept raw next to decoded fields; a changed payload is compared with the one before it, byte by byte.">
      <dl class="kv">
        <dt>ADVERTISED NAME</dt>
        <dd>{d.advName ?? '-- (none advertised)'}</dd>
        <dt>SYSTEM NAME</dt>
        <dd>{d.systemName ?? '-- (the OS keeps none)'}</dd>
        <dt>OBSERVED ID</dt>
        <dd class="mono">
          {d.id} <span class="dim">({d.idKind}: {d.idKind === 'web-bluetooth-id' ? 'random per site and browser, not the radio address' : d.idKind === 'bluez-address' ? 'radio address as BlueZ reports it' : d.idKind})</span>
        </dd>
        <dt>ADDRESS</dt>
        <dd>{d.address ? `${d.address} (${d.addressType ?? 'type not reported'})` : 'not exposed by this API'}</dd>
        <dt>RSSI</dt>
        <dd>{d.rssi === null ? '--' : `${d.rssi} dBm (a level, not a distance)`}</dd>
        <dt>TX POWER</dt>
        <dd>{d.txPower === null ? 'not advertised' : `${d.txPower} dBm (as advertised)`}</dd>
        <dt>CONNECTABLE</dt>
        <dd>{d.connectable === null ? 'not reported by this API' : d.connectable ? 'yes' : 'no'}</dd>
        <dt>SERVICES ADVERTISED</dt>
        <dd>
          {d.services.length ? d.services.map((u) => `${u}${names.service(u) ? ` (${names.service(u)})` : ''}`).join(', ') : 'none'}
          {d.truncated > 0 && <span class="dim">{` · ${d.truncated} more advertised entr${d.truncated > 1 ? 'ies' : 'y'} not kept (limit ${BLE_LIMITS.maxEntries} per kind)`}</span>}
        </dd>
        <dt>OBSERVATIONS</dt>
        <dd>
          {d.count} · payload changed {d.payloadChanges} time(s) · first {new Date(d.firstSeen).toLocaleTimeString()} · last {new Date(d.lastSeen).toLocaleTimeString()}
        </dd>
        <dt>SOURCE</dt>
        <dd>
          {d.source} · adapter {d.adapter}
        </dd>
      </dl>
      <p class="note dim">Advertised services are what the device announces; they are not a GATT exploration (GATT tab, after a connection).</p>
      {[...d.manufacturer].map(([c, data]) => (
        <PayloadBlock key={`m${c}`} kind="manufacturer" keyId={c} title={`MANUFACTURER DATA · 0x${shortUuid(c)} ${names.company(c) ?? '(company not in the dictionary)'}`} data={data} previous={d.previous.get(`m:${c}`)} />
      ))}
      {[...d.serviceData].map(([u, data]) => (
        <PayloadBlock key={`s${u}`} kind="service" keyId={u} title={`SERVICE DATA · ${u} ${names.service(u) ?? ''}`} data={data} previous={d.previous.get(`s:${u}`)} />
      ))}
      {d.manufacturer.size === 0 && d.serviceData.size === 0 && <p class="note">No manufacturer or service data in its advertisements.</p>}
    </Panel>
  );
}

function CharRow({ lab, c }: { lab: Lab; c: GattCharView }) {
  const g = lab.ble.gatt!;
  const modes = g.writeModes(c);
  const [fmt, setFmt] = useState<ValueFormat>('hex');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<WriteMode>(modes[0] ?? 'with-response');
  const [err, setErr] = useState<string | null>(null);
  let preview: Uint8Array | null = null;
  let parseErr: string | null = null;
  if (input.trim())
    try {
      preview = parseValue(input, fmt);
    } catch (e) {
      parseErr = (e as Error).message;
    }
  // A float is sent as the nearest f32: say what the device will read, not what was typed.
  const stored = preview && fmt.startsWith('f32') ? ` = ${formatValue(preview, fmt)} as sent` : '';
  const run = (fn: () => Promise<unknown>) => {
    setErr(null);
    fn().catch((e: unknown) => {
      const { message, code } = errorInfo(e);
      setErr(code ? `[${code}] ${message}` : message);
    });
  };
  return (
    <div class="gatt-char">
      <div>
        <b class="mono">{c.uuid}</b> {names.characteristic(c.uuid) ?? ''} <span class="dim">[{c.props.join(', ')}]</span>
      </div>
      <div class="actions">
        {c.props.includes('read') && (
          <button class="btn" onClick={() => run(() => g.read(c))}>
            READ
          </button>
        )}
        {(c.props.includes('notify') || c.props.includes('indicate')) && (
          <button class={`btn${c.notifying ? ' active' : ''}`} onClick={() => run(() => g.notify(c, !c.notifying))}>
            {c.notifying ? 'STOP' : 'START'} {c.props.includes('notify') ? 'NOTIFY' : 'INDICATE'}
          </button>
        )}
        <select class="input" value={fmt} onChange={(e) => setFmt((e.target as HTMLSelectElement).value as ValueFormat)} aria-label="Value format (byte order explicit)">
          {VALUE_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      {c.value && (
        <div class="mono small">
          value: {toHex(c.value)} → {fmt}: {formatValue(c.value, fmt)}
        </div>
      )}
      {modes.length > 0 && (
        <form
          class="actions write-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!preview) return;
            if (!confirm(`Write ${preview.length} byte(s) to ${c.uuid} (${mode})?\n\n${toHex(preview)}${stored}\n\nSent once. Accepted by the API does not prove the device acted.`)) return;
            const bytes = preview;
            run(() => g.write(c, bytes, mode));
          }}
        >
          <input class="input" placeholder={`value to write (${fmt})`} value={input} onInput={(e) => setInput((e.target as HTMLInputElement).value)} aria-label="Value to write" />
          <select class="input" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as WriteMode)} aria-label="Write mode">
            {modes.map((m) => (
              <option key={m} value={m}>
                {m === 'with-response' ? 'write (with response)' : 'write without response'}
              </option>
            ))}
          </select>
          <button class="btn" type="submit" disabled={!preview}>
            WRITE…
          </button>
          <span class="mono small">{parseErr ? <span class="amber">{parseErr}</span> : preview ? `bytes: ${toHex(preview)}${stored}` : ''}</span>
        </form>
      )}
      {c.descriptors.length > 0 && (
        <div class="small">
          descriptors:{' '}
          {c.descriptors.map((d) => (
            <button key={d.key} class="link" onClick={() => run(() => g.readDescriptor(c, d))} title="Read this descriptor">
              {d.uuid} {names.descriptor(d.uuid) ?? ''} {d.value ? `= ${toHex(d.value)}` : ''} {d.error ? `(${d.error})` : ''}
            </button>
          ))}
        </div>
      )}
      {err && <p class="note warn">{err}</p>}
    </div>
  );
}

function Gatt({ lab }: { lab: Lab }) {
  useRev(lab.ble);
  const g = lab.ble.gatt;
  useRev(g);
  const [extra, setExtra] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const pick = async () => {
    setErr(null);
    try {
      const known = await knownServiceUuids();
      const custom = extra
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((u) => (/^[0-9a-fA-F]{4}$/.test(u) ? `0000${u.toLowerCase()}-0000-1000-8000-00805f9b34fb` : u.toLowerCase()));
      await lab.ble.pickGatt([...known, ...custom]);
    } catch (e) {
      const { message, code } = errorInfo(e);
      if (code !== 'NotFoundError') setErr(code ? `[${code}] ${message}` : message);
    }
  };
  const act = (fn: () => Promise<unknown>) => {
    setErr(null);
    fn().catch((e: unknown) => {
      const { message, code } = errorInfo(e);
      setErr(code ? `[${code}] ${message}` : message);
    });
  };
  return (
    <Panel title="GATT" info="After an explicit connection to one device picked in the browser chooser. Only the services listed before the chooser opened are reachable (a Web Bluetooth rule), and the browser hides some (blocklist): this is what the API allows, not everything the device has.">
      <div class="actions">
        <input class="input" placeholder="extra service UUIDs (optional)" value={extra} onInput={(e) => setExtra((e.target as HTMLInputElement).value)} aria-label="Extra service UUIDs" />
        <button class="btn primary" onClick={() => void pick()}>
          PICK A DEVICE…
        </button>
        {g && (
          <>
            <span>
              {g.label} <Tag status={g.state === 'CONNECTED' ? 'PASS' : g.state === 'DISCONNECTED' ? 'WARN' : 'UNKNOWN'} label={g.state} />
            </span>
            {g.state !== 'CONNECTED' ? (
              <button class="btn" onClick={() => act(() => g.connect())}>
                CONNECT
              </button>
            ) : (
              <>
                <button class="btn" onClick={() => act(() => g.explore())}>
                  DISCOVER AGAIN
                </button>
                <button class="btn" onClick={() => void g.disconnect()}>
                  DISCONNECT
                </button>
              </>
            )}
          </>
        )}
      </div>
      {err && <p class="note warn">{err}</p>}
      {g?.state === 'DISCONNECTED' && <p class="note warn">Disconnected. Nothing is resent on its own: CONNECT again, then act again if you mean to.</p>}
      {g?.services.map((s) => (
        <div class="gatt-service" key={s.key}>
          <div class="gatt-service-head">
            SERVICE <b class="mono">{s.uuid}</b> {names.service(s.uuid) ?? ''}
            {s.error && <span class="amber"> · {s.error}</span>}
          </div>
          {s.chars.map((c) => (
            <CharRow key={c.key} lab={lab} c={c} />
          ))}
        </div>
      ))}
      {g && g.history.length > 0 && (
        <details open>
          <summary>HISTORY ({g.history.length})</summary>
          <table class="trace">
            <tbody>
              {g.history
                .slice(-200)
                .reverse()
                .map((h, i) => (
                  <tr key={i} class={h.kind === 'error' ? 'sev-FAIL' : undefined}>
                    <td class="mono small">{new Date(h.at).toLocaleTimeString([], { hour12: false })}</td>
                    <td>{h.kind}</td>
                    <td class="mono">{h.uuid ?? ''}</td>
                    <td class="mono small">{h.bytes ? toHex(h.bytes) : ''}</td>
                    <td class="small">{h.text}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      )}
      {!g && <p class="note">GATT needs Web Bluetooth (Chromium browsers). dogd does not connect to devices.</p>}
    </Panel>
  );
}

export function BluetoothLab({ lab, tool, onTool }: { lab: Lab; tool: BleTool; onTool: (t: BleTool) => void }) {
  useRev(lab.ble);
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [, setLoaded] = useState(false);
  useEffect(() => void loadNumbers().then(() => setLoaded(true), () => {}), []);
  // The screen ticks for "seen N s ago" and presence, a few times a second, only while visible here.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const replay = (data: LabSessionData) => {
    void lab.ble.replay(data);
    onTool('SCAN');
  };
  const source = names.source;
  return (
    <div class="lab ble-lab">
      <header class="lab-title">
        <h1>
          BLUETOOTH <b>LAB</b>
        </h1>
        <p>Our own BLE scanner: local, offline, no account. No nRF Connect, no Flipper needed.</p>
      </header>
      <div class="lab-body">
        <div class="lab-main">
          <nav class="lab-tools" aria-label="Bluetooth Lab tools">
            {BLE_TOOLS.map((t) => (
              <button key={t} aria-current={tool === t ? 'page' : undefined} onClick={() => onTool(t)} title={TOOL_PURPOSE[t]}>
                <span class="lab-tool-name">{t}</span>
                <span class="lab-tool-purpose">{TOOL_PURPOSE[t]}</span>
              </button>
            ))}
          </nav>
          <div class="lab-workspace">
            {tool === 'SCAN' && <Scan lab={lab} selected={selected} onSelect={setSelected} focus={focus} onFocus={(k) => (setFocus(k), onTool('INSPECT'))} />}
            {tool === 'INSPECT' && <Inspect lab={lab} focus={focus} />}
            {tool === 'GATT' && <Gatt lab={lab} />}
            {tool === 'LOG' && <LabLog lab={lab} only="BLE" />}
            {tool === 'SESSIONS' && <LabSessionsPanel lab={lab} onReplayBle={replay} />}
          </div>
        </div>
        <aside class="lab-side">
          <SessionStrip lab={lab} />
          {source && (
            <p class="note dim small">
              Names from the Bluetooth numbers database ({source.repository}, {source.commit.slice(0, 7)}, {source.license}), bundled: looked up offline.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
