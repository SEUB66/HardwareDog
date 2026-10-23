/**
 * HARDWARE DOG / CAMERA SNIFFER
 *
 * Spot the clues, inspect the devices: the local network (through dogd),
 * Bluetooth (Bluetooth Lab's scanner), USB (dogd), an offline catalog of
 * objects and a guided physical inspection, on one lab timeline. It helps
 * to investigate; it never certifies that a room has no camera. A camera
 * recording to a card, off the network or switched off can escape every
 * scan: said once at the top, and in the report.
 *
 * No fake radar, no camera counter built from unknown devices.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { BannerCarousel } from '../brand/BannerCarousel';
import { CAMERA_SLIDES } from '../brand/slides';
import { CATALOG } from '../../core/camera/catalog';
import { BLE_SIGNATURES_VERSION, bleClues, bleLabel, USB_EMPTY_NOTE, USB_FUNCTION_LABEL, usbClues, type UsbClue } from '../../core/camera/clues';
import { classify, namesOf, NOT_ESTABLISHED, STATE_LABEL, STATE_ORDER, type NetDevice, type NetState } from '../../core/camera/model';
import { DOGD_HOWTO, LAN_METHODS, METHOD_LABEL, type LanMethod } from '../../core/camera/net';
import { useSettled } from '../lab/useSettled';
import { PosterSlider } from './PosterSlider';
import { LIMITS } from '../../core/camera/report';
import { dogdUsb } from '../../core/dogd';
import { loadNumbers } from '../../core/ble/decode';
import type { Lab } from '../../core/lab/context';
import { errorInfo } from '../../core/lab/events';
import { browserLang } from '../../core/lab/rules';
import { Panel } from '../components/Panel';
import { Tag } from '../components/Tag';
import { SessionStrip } from '../lab/SessionStrip';
import { TvDocked, type TvPlacement } from '../lab/TvHost';
import { useRev } from '../lab/useRev';
import { CameraObjects } from './CameraObjects';
import { CameraReport } from './CameraReport';

export const CAMERA_TOOLS = ['OVERVIEW', 'NETWORK', 'BLE · USB', 'OBJECTS', 'REPORT'] as const;
export type CameraTool = (typeof CAMERA_TOOLS)[number];

const TOOL_PURPOSE: Record<CameraTool, string> = {
  OVERVIEW: 'tools, scope, what is left',
  NETWORK: 'what devices announce',
  'BLE · USB': 'Bluetooth and USB clues',
  OBJECTS: 'catalog and guided inspection',
  REPORT: 'facts, interpretations, export',
};

const SUBTITLE = { en: 'Spot the clues. Inspect the devices.', fr: 'Repérer les indices. Inspecter les appareils.' };
const LIMIT_LINE = {
  en: 'It helps identify clues and devices; it never certifies that a place is free of cameras. A camera off the network, switched off or recording to an SD card may not appear.',
  fr: 'Il aide à repérer des indices et des appareils ; il ne certifie jamais qu’un lieu est exempt de caméras. Une caméra hors réseau, éteinte ou qui enregistre sur carte SD peut ne pas apparaître.',
};

const STATE_TAG: Record<NetState, 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN' | 'LIVE'> = {
  DISCOVERED: 'UNKNOWN',
  MEDIA_SERVICE: 'UNKNOWN',
  VIDEO_COMPATIBLE: 'WARN',
  MODEL_IDENTIFIED: 'WARN',
  CONFIRMED: 'FAIL',
  UNDETERMINED: 'UNKNOWN',
};

/** A service as people read it: "_googlecast._tcp.local" -> "googlecast", "urn:...:device:MediaServer:1" -> "UPnP MediaServer:1". */
export function shortService(s: string | null): string {
  if (!s) return '';
  const urn = /^urn:[^:]+:(device|service):(.+)$/.exec(s);
  if (urn) return `UPnP ${urn[2]}`;
  if (s.startsWith('_')) return s.replace(/^_/, '').replace(/\._(tcp|udp)\.local$/, '');
  return s.replace(/\bdn:NetworkVideoTransmitter\b/, 'ONVIF NetworkVideoTransmitter').replace(/\btds:Device\b/, 'ONVIF Device');
}

/** USB is read on demand: the last reading, shared by the views. */
export interface UsbReading {
  at: number;
  supported: boolean;
  clues: UsbClue[];
  error: string | null;
}

export function CameraSniffer({ lab, placement, reducedMotion, tool, onTool }: { lab: Lab; placement: TvPlacement; reducedMotion: boolean; tool: CameraTool; onTool: (t: CameraTool) => void }) {
  useRev(lab.camera.net);
  useRev(lab.camera.inspections);
  useRev(lab.ble);
  useRev(lab.companion);
  const lang = browserLang();
  const [usb, setUsb] = useState<UsbReading | null>(null);
  const [reportSeen, setReportSeen] = useState(false);
  useEffect(() => {
    void loadNumbers().catch(() => {});
    if (lab.camera.net.available === null && !lab.camera.net.error) void lab.camera.net.refresh();
  }, [lab]);
  useEffect(() => {
    if (tool === 'REPORT') setReportSeen(true);
  }, [tool]);
  const msg = lab.companion.message;
  const cameraMsg = msg && msg.key.startsWith('CAMERA:') ? msg : null;

  return (
    <div class="lab camera-lab">
      <div class="camera-top">
        {/* Brand pictures, never results; still while a scan or an inspection runs. */}
        <BannerCarousel
          slides={CAMERA_SLIDES}
          label={lang === 'fr' ? 'Camera Sniffer : bannières' : 'Camera Sniffer banners'}
          lang={lang}
          reducedMotion={reducedMotion}
          busy={lab.camera.net.busy || (lab.camera.inspections.current.rooms.length > 0 && !lab.camera.inspections.current.finished)}
          sizes="(max-width: 1099px) 100vw, 52vw"
          class="camera-banners"
        />
        <div class="camera-intro">
          <p class="camera-subtitle">{SUBTITLE[lang]}</p>
          <p class="note dim">{LIMIT_LINE[lang]}</p>
          {cameraMsg && (
            <p class={`camera-msg sev-${cameraMsg.severity}`} role="status">
              {cameraMsg.text}
            </p>
          )}
        </div>
      </div>
      <div class="lab-body">
        <div class="lab-main">
          <nav class="lab-tools" aria-label="Camera Sniffer views">
            {CAMERA_TOOLS.map((t) => (
              <button key={t} aria-current={tool === t ? 'page' : undefined} onClick={() => onTool(t)} title={TOOL_PURPOSE[t]}>
                <span class="lab-tool-name">{t}</span>
                <span class="lab-tool-purpose">{TOOL_PURPOSE[t]}</span>
              </button>
            ))}
          </nav>
          <div class="lab-workspace">
            {tool === 'OVERVIEW' && <Overview lab={lab} usb={usb} reportSeen={reportSeen} onTool={onTool} />}
            {tool === 'NETWORK' && <Network lab={lab} />}
            {tool === 'BLE · USB' && <BleUsb lab={lab} usb={usb} onUsb={setUsb} />}
            {tool === 'OBJECTS' && <CameraObjects lab={lab} />}
            {tool === 'REPORT' && <CameraReport lab={lab} usb={usb} />}
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

// ---------------------------------------------------------------- overview

function Overview({ lab, usb, reportSeen, onTool }: { lab: Lab; usb: UsbReading | null; reportSeen: boolean; onTool: (t: CameraTool) => void }) {
  const net = lab.camera.net;
  const insp = lab.camera.inspections.current;
  const devices = [...net.model.devices.values()];
  const states = devices.map((d) => classify(d, net.note(d.key)).state);
  const items = insp.rooms.flatMap((r) => r.items);
  const ble = bleClues(lab.ble.model.devices.values());
  const cameraApi = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const iface = net.interfaces.find((i) => i.name === net.iface);
  const toExamine = [
    states.filter((s) => s === 'VIDEO_COMPATIBLE' || s === 'MODEL_IDENTIFIED').length && `${states.filter((s) => s === 'VIDEO_COMPATIBLE' || s === 'MODEL_IDENTIFIED').length} network device(s) with clues compatible with video equipment`,
    states.filter((s) => s === 'MEDIA_SERVICE').length && `${states.filter((s) => s === 'MEDIA_SERVICE').length} network device(s) with a media service`,
    states.filter((s) => s === 'UNDETERMINED').length && `${states.filter((s) => s === 'UNDETERMINED').length} network device(s) undetermined`,
    items.filter((i) => i.status === 'NEEDS_CHECK').length && `${items.filter((i) => i.status === 'NEEDS_CHECK').length} object(s) needing a further check`,
    items.filter((i) => i.status === 'TO_EXAMINE').length && `${items.filter((i) => i.status === 'TO_EXAMINE').length} object(s) not examined yet`,
    usb?.clues.some((u) => u.video) && 'a USB device declaring a video interface',
  ].filter(Boolean) as string[];
  const steps: [string, boolean][] = [
    ['Network scanned', net.state === 'DONE' || net.state === 'CANCELLED' || devices.length > 0],
    ['Bluetooth observed', ble.length > 0],
    ['USB read', !!usb],
    ['Rooms added', insp.rooms.length > 0],
    ['Objects examined', items.some((i) => i.status !== 'TO_EXAMINE')],
    ['Inspection finished', !!insp.finished],
    ['Report viewed', reportSeen],
  ];
  return (
    <>
      <div class="actions camera-actions">
        <button class="btn primary" onClick={() => onTool('OBJECTS')}>
          START AN INSPECTION
        </button>
        <button class="btn" onClick={() => onTool('NETWORK')}>
          SCAN THE NETWORK
        </button>
        <button class="btn" onClick={() => onTool('OBJECTS')}>
          EXAMINE AN OBJECT
        </button>
        <button class="btn" onClick={() => onTool('REPORT')}>
          SEE THE REPORT
        </button>
      </div>
      <Panel title="SNIFF THE SNIFFER · 5 POSTERS" info="Anti-sniffer documentation by Seub: 80 hidden-camera products as their sellers sell them, in five sheets. A matching shell does not prove a camera. Arrows, keys or a swipe to change poster; click for full screen, click again to read the small print.">
        <PosterSlider />
      </Panel>
      <Panel title="TOOLS AVAILABLE" info="What this computer and this browser can really do now. Nothing is assumed: a tool that is missing says how to get it.">
        <div class="camera-scroll">
          <table class="trace camera-tools">
          <tbody>
            <tr>
              <td>Network discovery</td>
              <td>{net.available ? <Tag status="PASS" label="DOGD" /> : net.available === false ? <Tag status="UNKNOWN" label="UNSUPPORTED" /> : <Tag status="UNKNOWN" label="NO DOGD" />}</td>
              <td class="msg">{net.available ? `${net.interfaces.length} network(s) listed${net.source === 'DEMO' ? ' (DEMO)' : ''}` : net.available === false ? net.detail : DOGD_HOWTO}</td>
            </tr>
            <tr>
              <td>Bluetooth</td>
              <td>{lab.ble.scanning ? <Tag status="LIVE" label="SCANNING" /> : <Tag status="UNKNOWN" label={ble.length ? 'OBSERVED' : 'IDLE'} />}</td>
              <td class="msg">Bluetooth Lab's scanner (Web Bluetooth, dogd on Linux, or the demo). Signatures: {BLE_SIGNATURES_VERSION}.</td>
            </tr>
            <tr>
              <td>USB</td>
              <td>{usb ? <Tag status={usb.supported ? 'PASS' : 'UNKNOWN'} label={usb.supported ? 'READ' : 'NOT READ'} /> : <Tag status="UNKNOWN" label="ON DEMAND" />}</td>
              <td class="msg">Interfaces declared by devices plugged into the computer dogd runs on.</td>
            </tr>
            <tr>
              <td>Camera</td>
              <td>{cameraApi ? <Tag status="PASS" label="AVAILABLE" /> : <Tag status="UNKNOWN" label="NOT HERE" />}</td>
              <td class="msg">{cameraApi ? 'Photos for the inspection, kept in this browser. The torch is offered only if the camera says it has one.' : 'This browser offers no camera: notes still work, and photos can be added from files.'}</td>
            </tr>
            <tr>
              <td>Catalog</td>
              <td>
                <Tag status="PASS" label="OFFLINE" />
              </td>
              <td class="msg">
                {CATALOG.families.length} object families, version {CATALOG.version}, bundled with the interface.
              </td>
            </tr>
          </tbody>
        </table>
          </div>
      </Panel>
      <Panel title="SELECTED NETWORK" info="The one network a scan may look at: chosen by you, private, never wider than a /16.">
        <p>{iface ? `${iface.name} · ${iface.network}${net.source === 'DEMO' ? ' · DEMO (SIMULATED)' : ''}` : 'No network selected.'}</p>
      </Panel>
      <Panel title="TO EXAMINE" info="Observations that deserve a look. Not a count of cameras: a list of things to check.">
        {toExamine.length ? (
          <ul class="camera-list">
            {toExamine.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : (
          <p class="note dim">Nothing to examine yet.</p>
        )}
      </Panel>
      <Panel title="STEPS DONE" info="What this inspection has covered so far.">
        <ul class="camera-steps">
          {steps.map(([label, done]) => (
            <li key={label} class={done ? 'done' : ''}>
              <span aria-hidden="true">{done ? '■' : '□'}</span> {label}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="COVERAGE LIMITS" info="What these methods cannot see. Repeated in the report.">
        <ul class="camera-list">
          {LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- network

function Network({ lab }: { lab: Lab }) {
  const net = lab.camera.net;
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const netSettled = useSettled();
  const run = (fn: () => Promise<void>) => void fn().catch((e) => setError(errorInfo(e).message));
  const rows = useMemo(
    () =>
      [...net.model.devices.values()]
        .map((d) => ({ d, c: classify(d, net.note(d.key)) }))
        .sort((a, b) => STATE_ORDER[a.c.state] - STATE_ORDER[b.c.state] || a.d.ip.localeCompare(b.d.ip, undefined, { numeric: true })),
    [net.revision],
  );
  const s = net.status;
  const focused = focus ? net.model.devices.get(focus) : undefined;
  const toggle = (m: LanMethod) => net.setMethods(net.methods.includes(m) ? net.methods.filter((x) => x !== m) : [...net.methods, m]);
  return (
    <>
      <Panel title="NETWORK DISCOVERY" info="dogd asks the chosen network what devices announce (neighbor table, mDNS, SSDP, ONVIF WS-Discovery), then checks a short list of ports on the hosts that showed themselves. No port scan, no password, no video stream opened. Service discovery is not traffic capture.">
        <div class="actions">
          <button class={`btn${net.source === 'DOGD' ? ' active' : ''}`} aria-pressed={net.source === 'DOGD'} disabled={net.busy} onClick={() => run(() => net.refresh('DOGD'))}>
            DOGD (THIS COMPUTER)
          </button>
          <button class={`btn${net.source === 'DEMO' ? ' active' : ''}`} aria-pressed={net.source === 'DEMO'} disabled={net.busy} onClick={() => run(() => net.refresh('DEMO'))}>
            DEMO NETWORK (SIMULATED)
          </button>
          <button class="btn" disabled={net.busy} onClick={() => run(() => net.refresh())}>
            RELOAD NETWORKS
          </button>
        </div>
        {net.error?.code === 'DOGD_ABSENT' && <p class="note warn">{DOGD_HOWTO}</p>}
        {net.available === false && <p class="note warn">{net.detail}</p>}
        {net.interfaces.length > 0 && (
          <div class="camera-ifaces" role="radiogroup" aria-label="Network to scan">
            {net.interfaces.map((i) => (
              <label key={i.name} class={`camera-iface${i.refused ? ' refused' : ''}`}>
                <input type="radio" name="iface" disabled={!!i.refused || net.busy} checked={net.iface === i.name} onChange={() => net.choose(i.name)} />
                <span>
                  <b>{i.name}</b> {i.network}
                  {i.refused && <span class="dim"> · refused: {i.refused}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <fieldset class="camera-methods" disabled={net.busy}>
          <legend>Methods</legend>
          {LAN_METHODS.map((m) => (
            <label key={m} class="check">
              <input type="checkbox" checked={net.methods.includes(m)} onChange={() => toggle(m)} /> {METHOD_LABEL[m]}
            </label>
          ))}
        </fieldset>
        <div class="actions">
          {net.scanning ? (
            <button class="btn" onClick={() => netSettled.settled() && (netSettled.mark(), run(() => net.stop()))}>
              STOP
            </button>
          ) : (
            <button class="btn primary" disabled={net.starting || !net.iface || !net.methods.length} onClick={() => netSettled.settled() && (netSettled.mark(), run(() => net.start()))}>
              SCAN THE SELECTED NETWORK
            </button>
          )}
          {!net.busy && rows.length > 0 && (
            <button class="btn" onClick={() => net.clear()}>
              CLEAR RESULTS
            </button>
          )}
        </div>
        {s && (
          <p class="dim">
            {net.state}
            {s.step ? ` · ${s.step}` : ''}
            {s.total ? ` · ${s.done} / ${s.total} checks` : ''} · {s.detail}
            {net.source === 'DEMO' && ' · SIMULATED'}
          </p>
        )}
        {(net.error && net.error.code !== 'DOGD_ABSENT') || error ? <p class="note warn">{error ?? `[${net.error!.code}] ${net.error!.message}`}</p> : null}
        <p class="note dim">A manufacturer is an origin, not an identification. RTSP can belong to something other than a camera. An ONVIF answer can come from a recorder. No answer excludes nothing; a guest network can isolate devices.</p>
      </Panel>
      <Panel title="DEVICES SEEN" info="One row per address, as observed. Ordered by what deserves a look first; never a probability. Select a row for the reasons and the raw answers.">
        {rows.length === 0 ? (
          <p class="note dim">No device yet.</p>
        ) : (
          <div class="camera-scroll">
          <table class="trace camera-devices">
            <thead>
              <tr>
                <th>STATE</th>
                <th>ADDRESS</th>
                <th>NAMES</th>
                <th>SERVICES</th>
                <th>MAC / PREFIX OWNER</th>
                <th>SEEN</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ d, c }) => (
                <tr key={d.key} class={focus === d.key ? 'selected' : ''} onClick={() => setFocus(focus === d.key ? null : d.key)}>
                  <td data-label="STATE">
                    <Tag status={STATE_TAG[c.state]} label={STATE_LABEL[c.state].toUpperCase()} />
                    {net.note(d.key).known && <span class="dim"> · KNOWN</span>}
                  </td>
                  <td data-label="ADDRESS">
                    <button class="linkish" onClick={(e) => (e.stopPropagation(), setFocus(focus === d.key ? null : d.key))}>
                      {d.ip}
                    </button>
                    {d.origin === 'SIMULATED' && <span class="dim"> DEMO</span>}
                  </td>
                  <td data-label="NAMES">{namesOf(d).map((n) => n.value).join(', ') || <span class="dim">none announced</span>}</td>
                  <td data-label="SERVICES" class="msg">{[...new Set(d.evidence.filter((e) => e.service || e.port).map((e) => (e.port ? `${shortService(e.service) || 'tcp'}:${e.port}` : shortService(e.service))))].join(' · ') || <span class="dim">none observed</span>}</td>
                  <td data-label="MAC / PREFIX OWNER" class="msg">
                    {d.mac ?? '?'}
                    {d.vendor ? ` · ${d.vendor.name}` : d.macLocal ? ' · random (local)' : ''}
                  </td>
                  <td data-label="SEEN">{new Date(d.lastSeen).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {net.model.notes.length > 0 && (
          <ul class="camera-list dim">
            {net.model.notes.map((n) => (
              <li key={n.id}>
                {n.method}: {n.summary}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {focused && <DeviceDetail key={focused.key} lab={lab} d={focused} />}
    </>
  );
}

function DeviceDetail({ lab, d }: { lab: Lab; d: NetDevice }) {
  const net = lab.camera.net;
  const note = net.note(d.key);
  const c = classify(d, note);
  const [label, setLabel] = useState(note.label);
  const [confirmation, setConfirmation] = useState(note.confirmation);
  const [linkKey, setLinkKey] = useState('');
  const ble = bleClues(lab.ble.model.devices.values());
  return (
    <Panel title="DEVICE DETAIL" info="Why this device is in this state, each reason with the answer it rests on. What you say about it is kept apart and never changes the observations.">
      <p>
        <b>{d.ip}</b> on {d.iface} · <Tag status={STATE_TAG[c.state]} label={STATE_LABEL[c.state].toUpperCase()} />
        {c.model && <span> · model as reported: {c.model}</span>}
      </p>
      <p class="dim">
        First seen {new Date(d.firstSeen).toLocaleString()} · last seen {new Date(d.lastSeen).toLocaleString()} · methods: {d.methods.join(', ')}
        {d.vendor && ` · MAC prefix owner from ${d.vendor.source ?? 'an OUI file'}`}
      </p>
      <p class={`note ${c.state === 'CONFIRMED' ? 'dim' : 'warn'}`}>
        <b>Not established:</b> {NOT_ESTABLISHED[c.state]}
      </p>
      <h3 class="camera-h3">WHY</h3>
      <ul class="camera-reasons">
        {c.reasons.map((r, i) => {
          const ev = d.evidence.find((e) => e.id === r.evidence);
          return (
            <li key={i} class={`role-${r.role}`}>
              <span class="tag-mini">{r.role === 'STATE' ? 'STATE' : r.role === 'HINT' ? 'HINT' : 'YOU'}</span> {r.text}
              {ev && (
                <details>
                  <summary>
                    source: {ev.method} · {ev.summary}
                    {ev.labSeq ? ` · event #${ev.labSeq}` : ''}
                  </summary>
                  {Object.keys(ev.fields).length > 0 && (
                    <table class="trace">
                      <tbody>
                        {Object.entries(ev.fields).map(([k, v]) => (
                          <tr key={k}>
                            <td>{k}</td>
                            <td class="msg">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {ev.raw && <pre class="camera-raw">{ev.raw}</pre>}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <h3 class="camera-h3">WHAT YOU KNOW</h3>
      <div class="actions">
        <label class="check">
          <input type="checkbox" checked={note.known} onChange={(e) => net.setNote(d.key, { known: (e.target as HTMLInputElement).checked, label })} /> Known device
        </label>
        <input class="input" placeholder="label: router, TV, my phone…" value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} onBlur={() => note.known && label !== note.label && net.setNote(d.key, { label })} aria-label="Label of the known device" />
      </div>
      <label class="camera-field">
        Documented verification (only after you saw it: what, where, how)
        <textarea class="input" rows={2} value={confirmation} onInput={(e) => setConfirmation((e.target as HTMLTextAreaElement).value)} aria-label="Documented verification" />
      </label>
      <div class="actions">
        <button class="btn" disabled={confirmation.trim() === note.confirmation.trim()} onClick={() => net.setNote(d.key, { confirmation })}>
          SAVE VERIFICATION
        </button>
      </div>
      <h3 class="camera-h3">LINK TO A BLUETOOTH DEVICE (BY HAND)</h3>
      <p class="note dim">Wi-Fi and Bluetooth observations are never merged on their own. A link you make is shown as yours.</p>
      <div class="actions">
        <select class="input" value={linkKey} onChange={(e) => setLinkKey((e.target as HTMLSelectElement).value)} aria-label="Bluetooth device to link">
          <option value="">choose a Bluetooth device…</option>
          {ble.map((b) => (
            <option key={b.key} value={b.key}>
              {b.advName ?? b.systemName ?? b.id} · {bleLabel(b)}
            </option>
          ))}
        </select>
        <button class="btn" disabled={!linkKey || note.ble.includes(linkKey)} onClick={() => net.setNote(d.key, { ble: [...note.ble, linkKey] })}>
          LINK
        </button>
        {note.ble.length > 0 && (
          <button class="btn" onClick={() => net.setNote(d.key, { ble: [] })}>
            REMOVE LINKS ({note.ble.length})
          </button>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- BLE / USB

function BleUsb({ lab, usb, onUsb }: { lab: Lab; usb: UsbReading | null; onUsb: (u: UsbReading) => void }) {
  const ble = bleClues(lab.ble.model.devices.values());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readUsb = async () => {
    setBusy(true);
    try {
      const r = await dogdUsb();
      onUsb({ at: Date.now(), supported: r.supported, clues: usbClues(r.devices), error: null });
    } catch (e) {
      onUsb({ at: Date.now(), supported: false, clues: [], error: `${errorInfo(e).message}. ${DOGD_HOWTO}` });
    } finally {
      setBusy(false);
    }
  };
  const { mark, settled } = useSettled();
  const start = (kind: 'WEB BLUETOOTH' | 'DOGD' | 'DEMO') => settled() && (mark(), void lab.ble.start(kind).catch((e) => setError(errorInfo(e).message)));
  return (
    <>
      <Panel title="BLUETOOTH CLUES" info="Bluetooth Lab's observations, read for this inspection. An unidentified Bluetooth device, or a tracker, is not counted as a camera clue, and not excluded either. The only signatures name trackers, from documented sources.">
        <div class="actions">
          {lab.ble.scanning ? (
            <button class="btn" onClick={() => settled() && (mark(), void lab.ble.stop())}>
              STOP BLUETOOTH SCAN
            </button>
          ) : (
            <>
              <button class="btn" onClick={() => start('WEB BLUETOOTH')}>
                WEB BLUETOOTH
              </button>
              <button class="btn" onClick={() => start('DOGD')}>
                DOGD (LINUX)
              </button>
              <button class="btn" onClick={() => start('DEMO')}>
                DEMO (SIMULATED)
              </button>
            </>
          )}
          <span class="dim">
            {lab.ble.sourceKind ? `source: ${lab.ble.sourceKind}` : 'no source yet'}
            {lab.ble.origin === 'SIMULATED' ? ' · SIMULATED' : ''}
          </span>
        </div>
        {(error || lab.ble.error) && <p class="note warn">{error ?? `[${lab.ble.error!.code}] ${lab.ble.error!.message}`}</p>}
        {ble.length === 0 ? (
          <p class="note dim">No Bluetooth observation yet.</p>
        ) : (
          <div class="camera-scroll">
          <table class="trace camera-ble">
            <thead>
              <tr>
                <th>READING</th>
                <th>NAMES</th>
                <th>SERVICES / COMPANIES</th>
                <th>RSSI</th>
                <th>LAST SEEN</th>
              </tr>
            </thead>
            <tbody>
              {ble.slice(0, 200).map((b) => (
                <tr key={b.key}>
                  <td data-label="READING">
                    {b.signature ? <Tag status="UNKNOWN" label="TRACKER" /> : <Tag status="UNKNOWN" label="NOT IDENTIFIED" />} <span class="dim">{bleLabel(b)}</span>
                  </td>
                  <td data-label="NAMES">
                    {b.advName ?? <span class="dim">no advertised name</span>}
                    {b.systemName && b.systemName !== b.advName ? <span class="dim"> · system: {b.systemName}</span> : null}
                    <div class="dim">
                      {b.id} ({b.source})
                    </div>
                  </td>
                  <td data-label="SERVICES / COMPANIES" class="msg">{[...b.services, ...b.companies].join(' · ') || <span class="dim">none</span>}</td>
                  <td data-label="RSSI">{b.rssi ?? '?'} dBm</td>
                  <td data-label="LAST SEEN">{new Date(b.lastSeen).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p class="note dim">Signatures: {BLE_SIGNATURES_VERSION}. RSSI is a level, never a distance. Full history and payloads: Bluetooth Lab.</p>
      </Panel>
      <Panel title="USB CLUES" info="The interfaces a plugged device declares, read by dogd from the operating system. A video interface is a technical clue; it proves neither recording nor concealment.">
        <p class="note warn">Never plug in an electrical object that looks suspicious or damaged to continue this guide.</p>
        <div class="actions">
          <button class="btn" disabled={busy} onClick={() => void readUsb()}>
            {usb ? 'READ AGAIN' : 'READ USB DEVICES'}
          </button>
          {usb && <span class="dim">read {new Date(usb.at).toLocaleTimeString()}</span>}
        </div>
        {usb?.error && <p class="note warn">{usb.error}</p>}
        {usb && !usb.error && !usb.supported && <p class="note warn">dogd does not read USB on this system yet.</p>}
        {usb && usb.supported && usb.clues.length === 0 && <p class="note dim">{USB_EMPTY_NOTE}</p>}
        {usb && usb.clues.length > 0 && (
          <div class="camera-scroll">
          <table class="trace camera-usb">
            <thead>
              <tr>
                <th>DEVICE</th>
                <th>FUNCTIONS</th>
                <th>INTERFACES (RAW)</th>
                <th>READING</th>
              </tr>
            </thead>
            <tbody>
              {usb.clues.map((u) => (
                <tr key={u.port}>
                  <td data-label="DEVICE">
                    {u.name}
                    <div class="dim">
                      {u.id} · port {u.port}
                    </div>
                  </td>
                  <td data-label="FUNCTIONS">{u.functions.map((f) => USB_FUNCTION_LABEL[f]).join(', ')}</td>
                  <td data-label="INTERFACES (RAW)" class="msg">{u.interfaces.join(', ')}</td>
                  <td data-label="READING" class="msg">{u.video ? <Tag status="WARN" label="VIDEO INTERFACE" /> : null} {u.reading}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Panel>
    </>
  );
}
