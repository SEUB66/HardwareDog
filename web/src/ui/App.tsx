import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ArchiveWriter, SessionArchive, SessionMeta } from '../core/archive';
import { BUILD } from '../core/ascii';
import { caseFrom } from '../core/cases';
import { SCREENS, type CommandContext, type Screen } from '../core/commands';
import { duration, sessionId } from '../core/format';
import { buildReport, reportToText } from '../core/report';
import { reportToHtml, reportToPdf } from '../core/reportFormats';
import type { ReportFormat } from '../core/commands';
import { SimulatedDevice } from '../core/simulator';
import { SimulatedPack } from '../core/simpack';
import { PackBuilder } from '../core/packbuilder';
import { DEFAULT_SCENARIO, isScenarioId, type ScenarioId } from '../core/scenarios';
import { HDLOG_LIMITS, ReplayTransport, SessionRecorder, newHeader, parseHdlog, toHdlog, type Recording, type SessionHeader } from '../core/session';
import { System, browserStore } from '../core/system';
import { PackTransport, type Transport } from '../core/transport';
import type { Source, TransportKind } from '../core/types';
import { thresholdsOf } from '../core/types';
import { WebSerialTransport } from '../core/webserial';
import { connectDogd, dogdStore, viaDogd } from '../core/dogd';
import headSrc1x from '../../../assets/brand/web/hd-head-1x.webp';
import headSrc2x from '../../../assets/brand/web/hd-head-2x.webp';
import headSrc3x from '../../../assets/brand/web/hd-head-3x.webp';
import { Icon, SCREEN_PURPOSE } from './components/Icon';
import { Boot } from './Boot';
import { CommandPalette, type PaletteEntry } from './CommandPalette';
import { Hint } from './components/Hint';
import { IntegrityTag } from './components/IntegrityTag';
import { ConnectBanner } from './components/ConnectBanner';
import { SimBanner } from './components/SimBanner';
import { Tour } from './Tour';
import { Tag } from './components/Tag';
import { useClock, useSystem } from './hooks';
import { Bus } from './screens/Bus';
import { Help } from './screens/Help';
import { Net } from './screens/Net';
import { Power } from './screens/Power';
import { Probe } from './screens/Probe';
import { Report } from './screens/Report';
import { Serial } from './screens/Serial';
import { Setup } from './screens/Setup';
import { Status } from './screens/Status';
import { Trace } from './screens/Trace';
import { Usb } from './screens/Usb';
import { hideTip, installTips } from './tips';
import { explain } from '../core/glossary';

interface Session {
  system: System;
  /** Null: nothing connected yet (no demo starts on its own). */
  transport: Transport | null;
  key: number;
  /** Streams a live session to the archive. Null for a replay. */
  writer: ArchiveWriter | null;
}

/** Shown on phones; everything else sits behind MORE (spec 32). */
const PRIMARY: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'PROBE'];
const DIGIT_SCREENS: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'USB', 'SERIAL', 'BUS', 'NET'];

let sessionCounter = 0;
/**
 * The app opens NOT CONNECTED. The demo starts only when asked: the DEMO
 * MODE button, or a link that says so (`?demo`, `?scenario=HD-T004`).
 */
function requestedDemo(): ScenarioId | null {
  const params = new URLSearchParams(location.search);
  const q = params.get('scenario')?.toUpperCase() ?? '';
  if (isScenarioId(q)) return q;
  return params.has('demo') ? DEFAULT_SCENARIO : null;
}

/** How the data reaches this screen, in one short phrase for the header. */
function viaLabel(system: System): string {
  if (system.replayOf) return 'RECORDING';
  switch (system.transportKind) {
    case 'SIMULATOR':
      return 'SIMULATOR (DEMO)';
    case 'WEB SERIAL':
      return system.transportLabel;
    case 'DOGD':
      return system.origin === 'SIMULATED' ? 'DOGD (SIMULATED)' : `DOGD ${system.transportLabel}`;
    case 'PACK':
      return `PACK OF ${system.dogs.length}${system.origin === 'SIMULATED' ? ' (SIMULATED)' : ''}`;
    default:
      return 'NOT CONNECTED';
  }
}

const simulator = (scenario: ScenarioId) => new SimulatedDevice({ seed: Date.now() & 0xffff, scenario });
/** Three simulated Dogs (supply, target, network) around one simulated incident. */
const simulatedPack = (scenario: ScenarioId) => new SimulatedPack({ seed: Date.now() & 0xffff, scenario });

/** The scenario a demo plays (one device or a pack); null for real hardware. */
const demoOf = (t: Transport | null) => (t instanceof SimulatedDevice || t instanceof SimulatedPack ? t.scenario : null);

/** Nothing connected: a system with no source, nothing recorded. */
const idleSession = (): Session => ({ system: new System(browserStore()), transport: null, key: ++sessionCounter, writer: null });

/** A replay runs on the recording's clock; a live session is recorded. */
function newSession(transport: Transport | null, archive: SessionArchive): Session {
  if (transport === null) return idleSession();
  if (transport instanceof ReplayTransport) {
    return { system: new System(browserStore(), () => transport.clock), transport, key: ++sessionCounter, writer: null };
  }
  const system = new System(browserStore());
  const recorder = new SessionRecorder(
    newHeader({
      id: sessionId(system.startedAt),
      startedAt: system.startedAt,
      source: transport.kind as SessionHeader['source'],
      origin: transport.origin,
      endpoint: transport.label,
      scenario: demoOf(transport)?.id ?? null,
      app: BUILD,
      thresholds: thresholdsOf(system.settings),
      // A pack is recorded as hdlog v3: its Dogs in the header, one on every line.
      ...(transport instanceof PackTransport
        ? { dogs: transport.links.map((l) => ({ id: l.dog, source: l.kind, endpoint: l.label, origin: l.origin })) }
        : {}),
    }),
    { keep: false }, // the archive holds it; memory stays flat on long sessions
  );
  system.recorder = recorder;
  const writer = archive.record(recorder, () => system.diagnoses.map((d) => `${d.id}:${d.confidence}`), {
    onError: (reason) => system.recordingStopped(reason),
  });
  return { system, transport, key: ++sessionCounter, writer };
}

function download(name: string, type: string, content: string | Uint8Array) {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** hwdog-HD-20261001-011817.hdlog: the session id, down to the second. */
const hdlogName = (h: SessionHeader) => `hwdog-${h.id}${String(new Date(h.startedAt).getSeconds()).padStart(2, '0')}.hdlog`;

export function App({ archive }: { archive: SessionArchive }) {
  const [session, setSession] = useState<Session>(() => {
    const demo = requestedDemo();
    return newSession(demo ? simulator(demo) : null, archive);
  });
  const [archived, setArchived] = useState<SessionMeta[]>([]);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  // The signature start plays when the interface opens, connected or not.
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>('STATUS');
  const [traceOnly, setTraceOnly] = useState<Source[] | null>(null);
  const [palette, setPaletteState] = useState(false);
  const [touring, setTouring] = useState(false);
  // The keyboard handler must see open/close immediately, not after the
  // next render, or fast keystrokes leak into global shortcuts.
  const paletteOpen = useRef(false);
  /** Keys typed between CTRL+K and the palette input taking focus. */
  const typeAhead = useRef('');
  const setPalette = (open: boolean) => {
    paletteOpen.current = open;
    typeAhead.current = '';
    setPaletteState(open);
  };
  const [paletteLog, setPaletteLog] = useState<PaletteEntry[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const previous = useRef<Screen[]>([]);
  const { system } = session;
  useSystem(system);
  const now = useClock(system);

  const refreshSessions = () => void archive.list().then(setArchived, () => {});
  // The list shows the live session growing; metas are small.
  useEffect(() => {
    const first = session.writer ? [session.writer.meta.key] : [];
    // Close what the last visit left open (tab closed, crash), then prune.
    void archive
      .recover(first)
      .then(() => archive.prune(first))
      .then(refreshSessions, refreshSessions);
    const id = setInterval(refreshSessions, 3000);
    return () => clearInterval(id);
  }, [archive]);

  // Write what is pending when the page goes away or into the background.
  useEffect(() => {
    const flush = () => void session.writer?.flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [session]);

  // Every label with a glossary entry explains itself on hover, focus or tap.
  useEffect(() => installTips(), []);
  useEffect(() => hideTip(), [screen]);

  // Theme and motion are system settings, applied to the document root.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset['field'] = system.settings.fieldMode ? 'on' : 'off';
    root.dataset['motion'] = system.settings.reducedMotion ? 'reduced' : 'full';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', system.settings.fieldMode ? '#F4F1E8' : '#0B0D0F');
  }, [system.settings.fieldMode, system.settings.reducedMotion]);

  const navigate = (next: Screen, only: Source[] | null = null) => {
    setTraceOnly(next === 'TRACE' ? only : null);
    if (next !== screen) previous.current = [...previous.current.slice(-19), screen];
    setScreen(next);
    setMoreOpen(false);
  };

  const back = () => {
    const prev = previous.current.pop();
    if (prev) {
      setScreen(prev);
      setTraceOnly(null);
    }
  };

  const exportReport = (format: ReportFormat) => {
    const report = buildReport(system);
    const name = `hwdog-${report.session}`;
    if (format === 'txt') download(`${name}.txt`, 'text/plain', reportToText(report));
    else if (format === 'html') download(`${name}.html`, 'text/html', reportToHtml(report));
    else if (format === 'pdf') download(`${name}.pdf`, 'application/pdf', reportToPdf(report));
    else download(`${name}.json`, 'application/json', JSON.stringify({ report, trace: system.trace.all() }, null, 2));
    system.mark(`report exported (${format})`);
  };

  const exportDescriptors = () => {
    const d = system.usb.descriptor;
    if (!d) return;
    download(`hwdog-usb-${d.vid.toString(16)}-${d.pid.toString(16)}.json`, 'application/json', JSON.stringify(d, null, 2));
  };

  /** Every source change is a new session: data never mixes. Null: back to NOT CONNECTED. */
  const start = async (transport: Transport | null) => {
    await system.disconnect();
    await session.writer?.stop();
    // Through dogd, the finished recording also goes to dogd's local store.
    if (viaDogd(session.transport) && session.writer && !session.writer.error) {
      const w = session.writer;
      void archive
        .text(w.meta.key)
        .then((text) => dogdStore(w.meta.header.recording, text))
        .catch((e: unknown) => system.mark(`dogd store: ${e instanceof Error ? e.message : String(e)}`));
    }
    setPalette(false);
    const next = newSession(transport, archive);
    setSession(next);
    setScreen(transport instanceof ReplayTransport ? 'TRACE' : 'STATUS');
    setTraceOnly(null);
    setBooting(transport !== null);
    void archive.prune(next.writer ? [next.writer.meta.key] : []).then(refreshSessions, () => {});
  };

  const switchTransport = async (kind: Exclude<TransportKind, 'REPLAY' | 'PACK'>, scenario: ScenarioId = DEFAULT_SCENARIO) => {
    let transport: Transport;
    if (kind === 'WEB SERIAL') {
      try {
        transport = await WebSerialTransport.pick();
      } catch (e) {
        system.mark(`web serial: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else if (kind === 'DOGD') {
      try {
        // One source: one device. Several: a pack, one Dog per source.
        transport = await connectDogd();
      } catch (e) {
        system.mark(`dogd: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else {
      transport = simulator(scenario);
    }
    await start(transport);
  };

  /** A pack of boards on USB, one port per click: D1, D2... in the order picked. */
  const [building, setBuilding] = useState<PackBuilder<WebSerialTransport> | null>(null);
  const [buildMessage, setBuildMessage] = useState<string | null>(null);
  const addSerialDog = async () => {
    const b = building ?? new PackBuilder<WebSerialTransport>((x, y) => x.samePort(y));
    try {
      setBuildMessage(b.add(await WebSerialTransport.pick()));
    } catch (e) {
      setBuildMessage(`web serial: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBuilding(b);
  };
  const startSerialPack = async () => {
    if (!building) return;
    try {
      const pack = building.build();
      setBuilding(null);
      setBuildMessage(null);
      await start(pack);
    } catch (e) {
      setBuildMessage(e instanceof Error ? e.message : String(e));
    }
  };

  /** The tour starts from STATUS, where every part it shows is on screen. */
  const startTour = () => {
    setPalette(false);
    setMoreOpen(false);
    navigate('STATUS');
    setTouring(true);
  };

  const replay = (recording: Recording) => {
    setSessionMessage(null);
    void start(new ReplayTransport(recording));
  };

  const replayArchived = async (key: string) => {
    try {
      replay(await archive.load(key));
    } catch (e) {
      setSessionMessage(`replay: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const openFile = async (file: File) => {
    try {
      // Refuse an oversized file before reading it into memory.
      if (file.size > HDLOG_LIMITS.maxBytes) throw new Error(`larger than ${HDLOG_LIMITS.maxBytes / 1024 / 1024} MiB`);
      replay(parseHdlog(await file.text()));
    } catch (e) {
      setSessionMessage(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const saveArchived = async (key: string) => {
    try {
      // The live session is saved as a SNAPSHOT: finalized, verifiable, still recording.
      const text = key === session.writer?.meta.key ? await archive.snapshotText(session.writer) : await archive.text(key);
      const meta = archived.find((m) => m.key === key);
      download(meta ? hdlogName(meta.header) : `hwdog-${key}.hdlog`, 'application/x-ndjson', text);
    } catch (e) {
      setSessionMessage(`save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const removeArchived = async (key: string) => {
    await archive.remove(key).catch(() => {});
    refreshSessions();
  };

  /** This session as .hdlog: the archive copy, or the recording being replayed. */
  const exportSession = () => {
    const t = session.transport;
    if (t instanceof ReplayTransport) {
      download(hdlogName(t.recording.header), 'application/x-ndjson', toHdlog(t.recording));
      return;
    }
    if (session.writer) void saveArchived(session.writer.meta.key);
  };

  /** Why this session cannot become a case, or null when it can. */
  const caseBlocker = (() => {
    const t = session.transport;
    if (!(t instanceof ReplayTransport)) return 'A case is made from a replayed recording: save this session, then replay it.';
    const status = t.recording.integrity?.status;
    if (status !== 'VERIFIED' && status !== 'RECOVERED') return `This recording is ${status ?? 'not from a file'}: a case needs an intact, finalized file.`;
    return null;
  })();

  /** The replayed incident as a regression case: case.json + the untouched .hdlog. */
  const saveCase = () => {
    const t = session.transport;
    if (!(t instanceof ReplayTransport) || caseBlocker) return;
    const h = t.recording.header;
    const id = `HD-C-${h.recording.slice(0, 8)}`;
    const title = `${system.diagnoses[0]?.title ?? 'No finding'} (${h.origin.toLowerCase()})`;
    const c = caseFrom(system, t.recording, { id, title, file: `${id}.hdlog` });
    download(`${id}.case.json`, 'application/json', JSON.stringify(c, null, 2) + '\n');
    download(`${id}.hdlog`, 'application/x-ndjson', toHdlog(t.recording));
    system.mark(`case saved: ${id}`);
  };

  const context: CommandContext = useMemo(
    () => ({
      system,
      navigate: (s) => navigate(s),
      exportReport,
      simulate: (id) => void switchTransport('SIMULATOR', id),
      sessions: () => archived,
      exportSession,
      replaySession: (key) => void replayArchived(key),
    }),
    // navigate reads the current screen through state setters only.
    [system, screen, archived],
  );

  useEffect(() => {
    if (booting) return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'k') {
        e.preventDefault();
        setPalette(!paletteOpen.current);
        return;
      }
      if (paletteOpen.current) {
        // The palette is opening but its input is not focused yet: keep the
        // keystrokes instead of losing them (or firing global shortcuts).
        if (!isTyping(e.target) && !ctrl && !e.altKey && (e.key.length === 1 || e.key === 'Enter')) {
          e.preventDefault();
          typeAhead.current += e.key === 'Enter' ? '\n' : e.key;
        }
        return;
      }
      if (e.key === 'Escape') {
        if (isTyping(e.target)) (e.target as HTMLElement).blur();
        else back();
        return;
      }
      if (ctrl && key === 'e') {
        e.preventDefault();
        exportReport('txt');
        return;
      }
      if (ctrl && key === 'l') {
        e.preventDefault();
        system.clearTrace();
        return;
      }
      if (isTyping(e.target) || ctrl || e.altKey) return;
      const fn: Record<string, Screen> = { F1: 'HELP', F2: 'TRACE', F3: 'PROBE', F4: 'REPORT' };
      if (fn[e.key]) {
        e.preventDefault();
        navigate(fn[e.key]!);
        return;
      }
      if (/^[1-7]$/.test(e.key)) {
        navigate(DIGIT_SCREENS[Number(e.key) - 1]!);
        return;
      }
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        system.toggleTrace();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (booting) {
    return <Boot key={session.key} system={system} transport={session.transport} onReady={() => setBooting(false)} />;
  }

  const linkTag = system.replayOf ? (
    <Tag status="UNKNOWN" label={system.link === 'CONNECTING' ? 'PLAYING' : 'RECORDED'} />
  ) : system.link === 'ONLINE' ? (
    <Tag status="PASS" label="ONLINE" />
  ) : system.link === 'LOST' ? (
    <Tag status="FAIL" label="LINK LOST" />
  ) : (
    <Tag status="UNKNOWN" label={system.link} />
  );

  const body = (() => {
    switch (screen) {
      case 'STATUS':
        return <Status system={system} />;
      case 'TRACE':
        return <Trace key={traceOnly?.join() ?? 'all'} system={system} only={traceOnly} />;
      case 'POWER':
        return <Power system={system} />;
      case 'USB':
        return <Usb system={system} onTrace={(only) => navigate('TRACE', only)} onExport={exportDescriptors} />;
      case 'SERIAL':
        return <Serial system={system} />;
      case 'BUS':
        return <Bus system={system} />;
      case 'NET':
        return <Net system={system} />;
      case 'PROBE':
        return <Probe system={system} />;
      case 'REPORT':
        return <Report system={system} onExport={exportReport} onExportSession={exportSession} onSaveCase={saveCase} caseBlocker={caseBlocker} />;
      case 'SETUP':
        return (
          <Setup
            system={system}
            scenario={demoOf(session.transport)?.id ?? null}
            demoPack={session.transport instanceof SimulatedPack}
            onSwitch={(k, id) => void switchTransport(k, id)}
            onDemoPack={(id) => void start(simulatedPack(id ?? demoOf(session.transport)?.id ?? DEFAULT_SCENARIO))}
            packBuilder={{
              picked: building?.links.map((l) => l.label) ?? [],
              message: buildMessage,
              onAdd: () => void addSerialDog(),
              onStart: () => void startSerialPack(),
              onCancel: () => {
                setBuilding(null);
                setBuildMessage(null);
              },
            }}
            onDisconnect={session.transport ? () => void start(null) : null}
            recording={session.writer ? { entries: session.writer.meta.entries, bytes: session.writer.meta.bytes } : null}
            sessions={{
              list: archived,
              activeKey: session.writer?.error ? null : (session.writer?.meta.key ?? null),
              persistent: archive.persistent,
              message: sessionMessage,
              onReplay: (key) => void replayArchived(key),
              onSave: (key) => void saveArchived(key),
              onRemove: (key) => void removeArchived(key),
              onOpen: (file) => void openFile(file),
            }}
          />
        );
      case 'HELP':
        return <Help />;
    }
  })();

  return (
    <div class="shell">
      <header class="head">
        <span class="brand">
          <img
            class="mark"
            src={headSrc1x}
            srcset={`${headSrc1x} 1x, ${headSrc2x} 2x, ${headSrc3x} 3x`}
            width={44}
            height={44}
            alt=""
            decoding="sync"
          />
          <span class="wordmark">
            HARDWARE <b>DOG</b>
          </span>
          <span class="ver">v{BUILD}</span>
        </span>
        <span class="field">
          <Hint text={explain('DEVICE', 'HEADER')} class="k">
            DEVICE
          </Hint>
          <span class="v">{system.pack ? `${system.dogs.length} DOGS` : system.device.id}</span>
        </span>
        <span class="field opt via">
          <Hint text={explain('VIA', 'HEADER')} class="k">
            VIA
          </Hint>
          <span class={`v${system.origin === 'SIMULATED' ? ' warn' : ''}`}>{viaLabel(system)}</span>
        </span>
        <span class="field opt">
          <Hint text={explain('SESSION', 'HEADER')} class="k">
            SESSION
          </Hint>
          <span class="v">{session.transport ? duration(now - system.startedAt) : '--'}</span>
        </span>
        <span class="field opt wide">
          <Hint text={explain('SESSION ID', 'HEADER')} class="k">
            SESSION ID
          </Hint>
          <span class="v">{system.replayOf?.id ?? (session.transport ? sessionId(system.startedAt) : '--')}</span>
        </span>
        <span class="spacer" />
        {system.trace.paused && <Tag status="WARN" label="TRACE PAUSED" />}
        {system.replayOf && <Tag status="INFO" label="REPLAY" />}
        {system.replayIntegrity && <IntegrityTag status={system.replayIntegrity.status} />}
        {/* On a phone VIA is hidden: these two words say it instead. */}
        <span class="narrow-only">
          {system.transportKind === 'DOGD' && <Tag status="INFO" label="DOGD" />}
          {system.origin === 'SIMULATED' && <Tag status="WARN" label="SIMULATOR" />}
        </span>
        <button class="btn tour-btn" onClick={startTour} title="A guided tour of the interface: what each part is for">
          <Icon name="TOUR" size={15} />
          <span>TOUR</span>
        </button>
        <span class="state">
          <span class={`light ${system.link}`} aria-hidden="true" />
          {linkTag}
        </span>
      </header>

      <nav class={`nav${moreOpen ? ' more-open' : ''}`} aria-label="Sections">
        <ul>
          {SCREENS.map((s) => {
            const digit = DIGIT_SCREENS.indexOf(s);
            return (
              <li key={s} class={PRIMARY.includes(s) ? undefined : 'secondary'}>
                <button aria-current={screen === s ? 'page' : undefined} onClick={() => navigate(s)} title={SCREEN_PURPOSE[s]}>
                  <Icon name={s} />
                  <span class="nav-label">
                    <span class="nav-name">{s}</span>
                    <span class="nav-purpose">{SCREEN_PURPOSE[s]}</span>
                  </span>
                  <span class="key">{digit >= 0 ? digit + 1 : ''}</span>
                </button>
              </li>
            );
          })}
          <li class="nav-more">
            <button aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
              <Icon name="MORE" />
              <span class="nav-label">
                <span class="nav-name">{moreOpen ? 'LESS' : 'MORE'}</span>
              </span>
            </button>
          </li>
        </ul>
        <div class="sep" />
        <div class="local">
          MODE LOCAL
          <br />
          CLOUD DISABLED
          <br />
          DATA LOCAL ONLY
        </div>
      </nav>

      <main class="work" id="workspace">
        {session.transport === null && (
          <ConnectBanner
            onSerial={() => void switchTransport('WEB SERIAL')}
            onDogd={() => void switchTransport('DOGD')}
            onOpen={(file) => void openFile(file)}
            onDemo={() => void switchTransport('SIMULATOR')}
            onTour={startTour}
          />
        )}
        <SimBanner
          system={system}
          scenario={demoOf(session.transport)}
          onConnect={() => navigate('SETUP')}
          onStop={demoOf(session.transport) ? () => void start(null) : null}
        />
        {body}
      </main>

      <footer class="foot">
        <span>
          <kbd>F1</kbd>HELP
        </span>
        <span>
          <kbd>F2</kbd>TRACE
        </span>
        <span>
          <kbd>F3</kbd>PROBE
        </span>
        <span>
          <kbd>F4</kbd>REPORT
        </span>
        <span class="spacer" />
        <span>{system.trace.size} EVENTS</span>
        <span>
          <kbd>CTRL+K</kbd>CMD
        </span>
      </footer>

      {touring && <Tour onEnd={() => setTouring(false)} />}

      {palette && (
        <CommandPalette
          typeAhead={typeAhead}
          context={context}
          log={paletteLog}
          onLog={(entry) => setPaletteLog((l) => [...l.slice(-49), entry])}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}
