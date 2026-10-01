import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ArchiveWriter, SessionArchive, SessionMeta } from '../core/archive';
import { BUILD } from '../core/ascii';
import { caseFrom } from '../core/cases';
import { SCREENS, type CommandContext, type Screen } from '../core/commands';
import { duration, sessionId } from '../core/format';
import { buildReport, reportToText } from '../core/report';
import { SimulatedDevice } from '../core/simulator';
import { DEFAULT_SCENARIO, isScenarioId, type ScenarioId } from '../core/scenarios';
import { ReplayTransport, SessionRecorder, newHeader, parseHdlog, toHdlog, type Recording, type SessionHeader } from '../core/session';
import { System, browserStore } from '../core/system';
import type { Transport } from '../core/transport';
import type { Source, TransportKind } from '../core/types';
import { thresholdsOf } from '../core/types';
import { WebSerialTransport } from '../core/webserial';
import markSrc1x from '../../../assets/brand/web/hd-mark-1x.webp';
import markSrc2x from '../../../assets/brand/web/hd-mark-2x.webp';
import markSrc3x from '../../../assets/brand/web/hd-mark-3x.webp';
import { Boot } from './Boot';
import { CommandPalette, type PaletteEntry } from './CommandPalette';
import { IntegrityTag } from './components/IntegrityTag';
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

interface Session {
  system: System;
  transport: Transport;
  key: number;
  /** Streams a live session to the archive. Null for a replay. */
  writer: ArchiveWriter | null;
}

/** Shown on phones; everything else sits behind MORE (spec 32). */
const PRIMARY: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'PROBE'];
const DIGIT_SCREENS: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'USB', 'SERIAL', 'BUS', 'NET'];

let sessionCounter = 0;
/** `?scenario=HD-T004` opens the simulator on a given fault scenario. */
function initialScenario(): ScenarioId {
  const q = new URLSearchParams(location.search).get('scenario')?.toUpperCase() ?? '';
  return isScenarioId(q) ? q : DEFAULT_SCENARIO;
}

const simulator = (scenario: ScenarioId) => new SimulatedDevice({ seed: Date.now() & 0xffff, scenario });

/** A replay runs on the recording's clock; a live session is recorded. */
function newSession(transport: Transport, archive: SessionArchive): Session {
  if (transport instanceof ReplayTransport) {
    return { system: new System(browserStore(), () => transport.clock), transport, key: ++sessionCounter, writer: null };
  }
  const system = new System(browserStore());
  const recorder = new SessionRecorder(
    newHeader({
      id: sessionId(system.startedAt),
      startedAt: system.startedAt,
      source: transport.kind as SessionHeader['source'],
      endpoint: transport.label,
      scenario: transport instanceof SimulatedDevice ? transport.scenario.id : null,
      app: BUILD,
      thresholds: thresholdsOf(system.settings),
    }),
    { keep: false }, // the archive holds it; memory stays flat on long sessions
  );
  system.recorder = recorder;
  const writer = archive.record(recorder, () => system.diagnoses.map((d) => `${d.id}:${d.confidence}`), {
    onError: (reason) => system.recordingStopped(reason),
  });
  return { system, transport, key: ++sessionCounter, writer };
}

function download(name: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
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
  const [session, setSession] = useState<Session>(() => newSession(simulator(initialScenario()), archive));
  const [archived, setArchived] = useState<SessionMeta[]>([]);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>('STATUS');
  const [traceOnly, setTraceOnly] = useState<Source[] | null>(null);
  const [palette, setPaletteState] = useState(false);
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

  const exportReport = (format: 'txt' | 'json') => {
    const report = buildReport(system);
    const name = `hwdog-${report.session}`;
    if (format === 'txt') download(`${name}.txt`, 'text/plain', reportToText(report));
    else download(`${name}.json`, 'application/json', JSON.stringify({ report, trace: system.trace.all() }, null, 2));
    system.mark(`report exported (${format})`);
  };

  const exportDescriptors = () => {
    const d = system.usb.descriptor;
    if (!d) return;
    download(`hwdog-usb-${d.vid.toString(16)}-${d.pid.toString(16)}.json`, 'application/json', JSON.stringify(d, null, 2));
  };

  /** Every source change is a new session: data never mixes. */
  const start = async (transport: Transport) => {
    await system.disconnect();
    await session.writer?.stop();
    setPalette(false);
    const next = newSession(transport, archive);
    setSession(next);
    setScreen(transport instanceof ReplayTransport ? 'TRACE' : 'STATUS');
    setTraceOnly(null);
    setBooting(true);
    void archive.prune(next.writer ? [next.writer.meta.key] : []).then(refreshSessions, () => {});
  };

  const switchTransport = async (kind: Exclude<TransportKind, 'REPLAY'>, scenario: ScenarioId = DEFAULT_SCENARIO) => {
    let transport: Transport;
    if (kind === 'WEB SERIAL') {
      try {
        transport = await WebSerialTransport.pick();
      } catch (e) {
        system.mark(`web serial: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else {
      transport = simulator(scenario);
    }
    await start(transport);
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
            scenario={session.transport instanceof SimulatedDevice ? session.transport.scenario.id : null}
            onSwitch={(k, id) => void switchTransport(k, id)}
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
            src={markSrc1x}
            srcset={`${markSrc1x} 1x, ${markSrc2x} 2x, ${markSrc3x} 3x`}
            width={22}
            height={22}
            alt=""
            decoding="sync"
          />
          HW <b>DOG</b>
          <span class="ver">v{BUILD}</span>
        </span>
        <span class="field">
          <span class="k">DEVICE</span>
          <span class="v">{system.device.id}</span>
        </span>
        <span class="field opt">
          <span class="k">SESSION</span>
          <span class="v">{duration(now - system.startedAt)}</span>
        </span>
        <span class="field opt wide">
          <span class="k">SESSION ID</span>
          <span class="v">{system.replayOf?.id ?? sessionId(system.startedAt)}</span>
        </span>
        <span class="spacer" />
        {system.trace.paused && <Tag status="WARN" label="TRACE PAUSED" />}
        {system.replayOf && <Tag status="INFO" label="REPLAY" />}
        {system.replayIntegrity && <IntegrityTag status={system.replayIntegrity.status} />}
        {(system.transportKind === 'SIMULATOR' || system.replayOf?.origin === 'SIMULATED') && <Tag status="WARN" label="SIMULATOR" />}
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
                <button aria-current={screen === s ? 'page' : undefined} onClick={() => navigate(s)}>
                  {s}
                  <span class="key">{digit >= 0 ? digit + 1 : ''}</span>
                </button>
              </li>
            );
          })}
          <li class="nav-more">
            <button aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
              {moreOpen ? 'LESS' : 'MORE'}
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
