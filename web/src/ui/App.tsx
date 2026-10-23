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
import { prepareForLibrary } from '../core/library';
import { DEFAULT_SCENARIO, isScenarioId, type ScenarioId } from '../core/scenarios';
import { HDLOG_LIMITS, ReplayTransport, SessionRecorder, newHeader, parseHdlog, toHdlog, type Recording, type SessionHeader } from '../core/session';
import { System, browserStore } from '../core/system';
import { PackTransport, type Transport } from '../core/transport';
import type { Source, TransportKind } from '../core/types';
import { thresholdsOf } from '../core/types';
import { WebSerialTransport } from '../core/webserial';
import { ConsoleTransport } from '../core/console';
import { DOGD_URL, DogdTransport, HOST_DEVICE, connectDogd, dogdStore, viaDogd } from '../core/dogd';
import headSrc1x from '../../../assets/brand/web/hd-head-1x.webp';
import headSrc2x from '../../../assets/brand/web/hd-head-2x.webp';
import headSrc3x from '../../../assets/brand/web/hd-head-3x.webp';
import { Icon, SCREEN_PURPOSE } from './components/Icon';
import { Boot } from './Boot';
import { CommandPalette, type PaletteEntry } from './CommandPalette';
import { Hint } from './components/Hint';
import { IntegrityTag } from './components/IntegrityTag';
import { ConnectStrip } from './components/ConnectBanner';
import { ErrorBlock } from './components/ErrorBlock';
import { Home } from './home/Home';
import { browserLang } from '../core/lab/rules';
import { SimBanner } from './components/SimBanner';
import { Tour } from './Tour';
import { WhatsNew } from './WhatsNew';
import { Boundary } from './components/Boundary';
import { CameraSniffer, type CameraTool } from './camera/CameraSniffer';
import { isNewScreen } from '../core/features';
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
import type { Lab } from '../core/lab/context';
import { instantOp } from '../core/lab/events';
import { BluetoothLab, type BleTool } from './lab/BluetoothLab';
import { FlipperLab, type FlipperTool } from './lab/FlipperLab';
import { TvDocked, TvFloating, TvPlacement, useTvPower } from './lab/TvHost';
import { deviceLink } from '../core/lab/device';
import { UpdateNote } from './Pwa';

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
      if (system.origin === 'SIMULATED') return 'DOGD (SIMULATED)';
      if (system.device.id === HOST_DEVICE) return 'THIS COMPUTER (DOGD)';
      return system.transportLabel.startsWith('DOGD') ? system.transportLabel : `DOGD ${system.transportLabel}`;
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
/** Space on these is theirs (press, open, scroll), not the trace's. */
const ownsSpace = (el: EventTarget | null) => el instanceof HTMLElement && el.matches('button, a, summary, [role="button"], [tabindex]');
/** A dialog above the screen (what's new, the tour, a poster full screen): the keyboard is its own. */
const dialogOpen = () => document.querySelector('[role="dialog"][aria-modal="true"]:not(.palette)') !== null;

/** hwdog-HD-20261001-011817.hdlog: the session id, down to the second. */
const hdlogName = (h: SessionHeader) => `hwdog-${h.id}${String(new Date(h.startedAt).getSeconds()).padStart(2, '0')}.hdlog`;

export function App({ archive, lab }: { archive: SessionArchive; lab: Lab }) {
  const [session, setSession] = useState<Session>(() => {
    const demo = requestedDemo();
    return newSession(demo ? simulator(demo) : null, archive);
  });
  const [archived, setArchived] = useState<SessionMeta[]>([]);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  // The signature start plays when the interface opens, connected or not.
  const [booting, setBooting] = useState(true);
  // The terminal intro plays once, when the interface opens; a new source only runs the checks.
  const introPlayed = useRef(false);
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

  // The lab: one TV placement, remembered; the tool open in each lab section.
  const placement = useMemo(() => new TvPlacement(), []);
  useTvPower(lab.companion, placement);
  const [flipperTool, setFlipperTool] = useState<FlipperTool>('FILES');
  const [bleTool, setBleTool] = useState<BleTool>('SCAN');
  const [cameraTool, setCameraTool] = useState<CameraTool>('OVERVIEW');
  // What's new: shown every time the interface opens, after the intro.
  const [whatsNew, setWhatsNew] = useState(true);
  const reducedMotion = system.settings.reducedMotion || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // What the companion's messages can offer: commands, run once at a time by the registry.
  useEffect(() => {
    const off = [
      lab.registry.register('flipper.connect', () => {
        setScreen('FLIPPER');
        return lab.flipper.connect(lab.flipper.lastMode).catch(() => {});
      }),
      lab.registry.register('lab.log', (args) => {
        // the log of the tool the message is about; without one, of the latest event's tool
        const source = args?.['source'] ?? lab.bus.recent((e) => e.type !== 'observe').at(-1)?.source;
        if (source === 'BLE') {
          setScreen('BLE');
          setBleTool('LOG');
        } else if (source === 'CAMERA') {
          setScreen('CAMERA');
          setCameraTool('REPORT');
        } else if (source === 'FLIPPER') {
          setScreen('FLIPPER');
          setFlipperTool('LOG');
        } else setScreen('TRACE');
      }),
      lab.registry.register('lab.open', (args) => {
        const to: Record<string, Screen> = { FLIPPER: 'FLIPPER', BLE: 'BLE', CAMERA: 'CAMERA', DEVICE: 'STATUS' };
        const s = to[args?.['source'] ?? ''];
        if (s) setScreen(s);
      }),
      lab.registry.register('ble.start', () => {
        setScreen('BLE');
        setBleTool('SCAN');
      }),
    ];
    return () => off.forEach((f) => f());
  }, [lab]);

  // Commands that start something on the session: their preconditions are checked at the click.
  const actions = useRef({ pick: () => {}, dogd: () => {} });
  useEffect(() => {
    const off = [
      lab.registry.register(
        'device.connect',
        () => actions.current.pick(),
        () => (typeof navigator !== 'undefined' && 'serial' in navigator ? null : 'this browser has no Web Serial'),
      ),
      lab.registry.register('device.dogd', () => actions.current.dogd()),
    ];
    return () => off.forEach((f) => f());
  }, [lab]);

  // A lab marker is also a mark on the live hardware timeline (same clock, one more place to read it).
  useEffect(
    () =>
      lab.bus.subscribe((e) => {
        if (e.type === 'marker' && session.transport && !system.replayOf) system.mark(`lab marker: ${e.message}`);
      }),
    [lab, session],
  );

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
    root.dataset['theme'] = system.settings.theme;
    root.dataset['field'] = system.settings.fieldMode ? 'on' : 'off';
    root.dataset['motion'] = system.settings.reducedMotion ? 'reduced' : 'full';
    const color = system.settings.fieldMode ? '#F4F1E8' : system.settings.theme === 'light' ? '#E6E8EB' : '#101112';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }, [system.settings.theme, system.settings.fieldMode, system.settings.reducedMotion]);

  // A new screen opens at its top: it never looks like the one before.
  useEffect(() => {
    const work = document.getElementById('workspace');
    if (work) work.scrollTop = 0;
  }, [screen]);

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
    instantOp(lab.bus, { source: 'LAB', tool: 'lab.report', message: `report exported (${format})`, kind: 'write', origin: system.origin === 'SIMULATED' ? 'SIMULATED' : 'PHYSICAL' });
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
      // the browser's port chooser: the companion waits with the person, nothing pretended
      const op = lab.device.begin('device.connect', 'connect', 'choosing a USB port', 'PHYSICAL', true);
      try {
        transport = await WebSerialTransport.pick();
        lab.device.end(op, 'device.connect', { severity: 'PASS', message: 'port chosen', origin: 'PHYSICAL' });
      } catch (e) {
        lab.device.failed(op, 'device.connect', e, 'PHYSICAL');
        system.mark(`web serial: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else if (kind === 'DOGD') {
      const op = lab.device.begin('device.dogd', 'connect', 'reaching dogd on this computer', 'PHYSICAL');
      try {
        // One source: one device. Several: a pack, one Dog per source.
        transport = await connectDogd();
        lab.device.end(op, 'device.dogd', { severity: 'PASS', message: 'dogd reached', origin: 'PHYSICAL' });
      } catch (e) {
        lab.device.end(op, 'device.dogd', { severity: 'FAIL', message: e instanceof Error ? e.message : String(e), origin: 'PHYSICAL', code: 'DOGD_UNREACHABLE' });
        system.sourceFailed('DOGD NOT REACHED', DOGD_URL.replace(/^https?:\/\//, ''), e instanceof Error ? e.message : String(e));
        navigate('STATUS');
        return;
      }
    } else {
      transport = simulator(scenario);
    }
    await start(transport);
  };

  /**
   * This computer's network, through dogd --source host. Choosing it is
   * asking for the checks: the watch starts (ACTIVE, said on the timeline),
   * and NET is the screen to read.
   */
  const wantNetwork = useRef(false);
  const openNetwork = async () => {
    wantNetwork.current = true;
    await switchTransport('DOGD');
  };
  // The link opens during the start: the watch begins once it is online.
  useEffect(() => {
    if (booting || !wantNetwork.current) return;
    wantNetwork.current = false;
    if (system.link !== 'ONLINE' || !system.observes('net')) return;
    if (!system.netWatch) system.watchNet(10, 'example.com', 'example.com');
    setScreen('NET');
  }, [booting]);

  /** Any board's serial console, read by this browser: no probe needed. Its console is the screen to watch. */
  const openConsole = async () => {
    let transport: ConsoleTransport;
    const op = lab.device.begin('device.console', 'connect', 'choosing a serial port', 'PHYSICAL', true);
    try {
      transport = await ConsoleTransport.pick();
      lab.device.end(op, 'device.console', { severity: 'PASS', message: 'port chosen', origin: 'PHYSICAL' });
    } catch (e) {
      lab.device.failed(op, 'device.console', e, 'PHYSICAL');
      system.mark(`serial console: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await start(transport);
    setScreen('SERIAL');
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

  /** The replayed incident for the community library: anonymized, its case drafted. */
  const saveForLibrary = async () => {
    const t = session.transport;
    if (!(t instanceof ReplayTransport) || caseBlocker) return;
    try {
      const p = await prepareForLibrary(toHdlog(t.recording));
      download(`${p.file}.case.json`, 'application/json', JSON.stringify(p.case, null, 2) + '\n');
      download(`${p.file}.hdlog`, 'application/x-ndjson', p.hdlog);
      const kinds = Object.entries(p.summary.replaced).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to replace';
      system.mark(`for the library: ${p.file} (${p.case.category}), anonymized: ${kinds}; ${p.summary.textLines} text line(s) changed, read them`);
    } catch (e) {
      system.mark(`library: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  actions.current = { pick: () => switchTransport('WEB SERIAL'), dogd: () => switchTransport('DOGD') };

  // The companion follows the section: its decor, the tool that comes first, who lives in the TV.
  useEffect(() => {
    const source = screen === 'FLIPPER' || screen === 'BLE' || screen === 'CAMERA' ? screen : 'DEVICE';
    const noSerial = typeof navigator === 'undefined' || !('serial' in navigator);
    const unavailable = screen === 'SERIAL' && !session.transport && noSerial ? 'NO WEB SERIAL IN THIS BROWSER: CHROME, EDGE OR OPERA ON A COMPUTER, OR DOGD' : null;
    lab.companion.setFocus({ section: screen, source, profile: screen === 'FLIPPER' ? 'flipper' : 'hwdog', unavailable });
  }, [lab, screen, session]);

  // The session on the lab bus: its link, and what runs until stopped. Facts the app has; nothing invented.
  const origin = system.replayOf ? 'REPLAY' : system.origin === 'SIMULATED' ? 'SIMULATED' : 'PHYSICAL';
  const linkState = deviceLink(session.transport !== null, system.link);
  useEffect(() => {
    const what = session.transport ? viaLabel(system) : 'no device chosen';
    lab.device.link(linkState, `${linkState === 'ABSENT' ? 'no device' : system.device.id} · ${what}`, origin);
  }, [lab, linkState, origin, session]);
  useEffect(() => {
    lab.device.watch('device.replay', session.transport instanceof ReplayTransport, 'read', 'replaying a recording', 'REPLAY');
    return () => lab.device.watch('device.replay', false, 'read', 'replaying a recording', 'REPLAY');
  }, [lab, session]);
  const netOn = !!system.netWatch && system.link === 'ONLINE';
  const busOn = system.bus.watchMs > 0 && system.link === 'ONLINE';
  useEffect(() => lab.device.watch('net.watch', netOn, 'search', 'network checks', origin), [lab, netOn, origin]);
  useEffect(() => lab.device.watch('device.bus', busOn, 'search', 'I2C watch', origin), [lab, busOn, origin]);

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
      if (e.defaultPrevented) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const dialog = dialogOpen();
      if (ctrl && key === 'k' && !dialog) {
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
      if (dialog) return;
      if (e.key === 'Escape') {
        if (isTyping(e.target)) (e.target as HTMLElement).blur();
        else back();
        return;
      }
      // Typing: the keys are the field's (Ctrl+L, Ctrl+E and digits included).
      if (isTyping(e.target)) return;
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
      if (ctrl || e.altKey) return;
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
      if (e.key === ' ' && !ownsSpace(e.target)) {
        e.preventDefault();
        system.toggleTrace();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (booting) {
    const intro = !introPlayed.current;
    return (
      <Boot
        key={session.key}
        system={system}
        transport={session.transport}
        intro={intro}
        onReady={() => {
          introPlayed.current = true;
          setBooting(false);
        }}
      />
    );
  }

  const linkTag = system.replayOf ? (
    <Tag status="UNKNOWN" label={system.link === 'CONNECTING' ? 'PLAYING' : 'RECORDED'} />
  ) : system.link === 'ONLINE' ? (
    <Tag status="PASS" label="ONLINE" />
  ) : system.link === 'LOST' ? (
    <Tag status="FAIL" label="LINK LOST" />
  ) : (
    // No device, a source gone quiet, or a link opening: never one ambiguous "OFFLINE".
    <Tag status="UNKNOWN" label={system.link === 'OFFLINE' ? (session.transport ? 'DEVICE OFFLINE' : 'NO DEVICE') : system.link} />
  );
  /** Nothing connected, on STATUS: the home, in place of empty cards. */
  const home = session.transport === null && screen === 'STATUS';

  const body = (() => {
    switch (screen) {
      case 'STATUS':
        return <Status system={system} />;
      case 'TRACE':
        return <Trace key={traceOnly?.join() ?? 'all'} system={system} only={traceOnly} />;
      case 'POWER':
        return <Power system={system} />;
      case 'USB':
        return (
          <Usb
            system={system}
            dogdBase={session.transport instanceof DogdTransport ? session.transport.base : null}
            onTrace={(only) => navigate('TRACE', only)}
            onExport={exportDescriptors}
          />
        );
      case 'SERIAL':
        return <Serial system={system} />;
      case 'BUS':
        return <Bus system={system} />;
      case 'NET':
        return <Net system={system} />;
      case 'PROBE':
        return <Probe system={system} />;
      case 'REPORT':
        return <Report system={system} onExport={exportReport} onExportSession={exportSession} onSaveCase={saveCase} onSaveForLibrary={() => void saveForLibrary()} caseBlocker={caseBlocker} />;
      case 'SETUP':
        return (
          <Setup
            system={system}
            scenario={demoOf(session.transport)?.id ?? null}
            demoPack={session.transport instanceof SimulatedPack}
            onSwitch={(k, id) => void switchTransport(k, id)}
            onConsole={() => void openConsole()}
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
      case 'FLIPPER':
        return <FlipperLab lab={lab} placement={placement} reducedMotion={reducedMotion} tool={flipperTool} onTool={setFlipperTool} />;
      case 'BLE':
        return <BluetoothLab lab={lab} tool={bleTool} onTool={setBleTool} />;
      case 'CAMERA':
        return <CameraSniffer lab={lab} placement={placement} reducedMotion={reducedMotion} tool={cameraTool} onTool={setCameraTool} />;
      case 'HELP':
        return <Help />;
    }
  })();
  const labScreen = screen === 'FLIPPER' || screen === 'BLE' || screen === 'CAMERA';

  return (
    <div class={`shell${moreOpen ? ' menu-open' : ''}`}>
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
        <button
          class="btn theme-btn"
          onClick={() => system.updateSettings({ theme: system.settings.theme === 'light' ? 'dark' : 'light' })}
          title={system.settings.theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
          aria-label={system.settings.theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
        >
          <Icon name={system.settings.theme === 'light' ? 'MOON' : 'SUN'} size={15} />
        </button>
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
                    <span class="nav-name">
                      {s}
                      {isNewScreen(s) && <span class="nav-new">NEW</span>}
                    </span>
                    <span class="nav-purpose">{SCREEN_PURPOSE[s]}</span>
                  </span>
                  <span class="key">{digit >= 0 ? digit + 1 : ''}</span>
                </button>
              </li>
            );
          })}
          {/* The open MORE menu on a phone: its last row carries the mark. */}
          <li class="nav-plate" aria-hidden="true">
            <img src={headSrc1x} srcset={`${headSrc1x} 1x, ${headSrc2x} 2x, ${headSrc3x} 3x`} width={34} height={34} alt="" />
            <span>
              <b>
                HARDWARE <i>DOG</i>
              </b>
              <small>LOCAL · NO CLOUD · NO TELEMETRY</small>
            </span>
          </li>
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
        <UpdateNote lab={lab} recording={session.transport !== null && !(session.transport instanceof ReplayTransport) && !!session.writer && !session.writer.error} />
        {session.transport === null && screen !== 'STATUS' && !labScreen && <ConnectStrip onChoose={() => navigate('STATUS')} onDemo={() => void switchTransport('SIMULATOR')} />}
        {home && (
          <Home
            lang={browserLang()}
            reducedMotion={reducedMotion}
            sessions={archived.length}
            onConsole={() => void openConsole()}
            onProbe={() => void switchTransport('WEB SERIAL')}
            onDogd={() => void switchTransport('DOGD')}
            onNetwork={() => void openNetwork()}
            onOpen={(file) => void openFile(file)}
            onDemo={() => void switchTransport('SIMULATOR')}
            onTour={startTour}
            onGo={(s) => navigate(s)}
            tv={<TvDocked companion={lab.companion} registry={lab.registry} placement={placement} reducedMotion={reducedMotion} />}
          >
            {/* A source that just failed is said before anything else. */}
            {system.lastError && <ErrorBlock error={system.lastError} />}
            {sessionMessage && <p class="note warn">{sessionMessage}</p>}
          </Home>
        )}
        {!labScreen && <SimBanner
          system={system}
          scenario={demoOf(session.transport)}
          onConnect={() => navigate('SETUP')}
          onStop={demoOf(session.transport) ? () => void start(null) : null}
        />}
        {!home && (
          <Boundary key={screen} where={screen} onError={(detail) => system.uiFailed(screen, detail)}>
            {body}
          </Boundary>
        )}
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

      {/* One TV: floating, it follows every section; docked, it sits in the page's place for it (home, Flipper Lab, Camera Sniffer), elsewhere a small tab. */}
      <Boundary where="TV" quiet onError={(detail) => system.uiFailed('TV', detail)}>
        <TvFloating companion={lab.companion} registry={lab.registry} placement={placement} reducedMotion={reducedMotion} />
      </Boundary>

      {touring && <Tour onEnd={() => setTouring(false)} />}
      {whatsNew && !touring && (
        <Boundary where="WHAT'S NEW" quiet onError={(detail) => system.uiFailed("WHAT'S NEW", detail)}>
          <WhatsNew
            lab={lab}
            placement={placement}
            reducedMotion={reducedMotion}
            onClose={() => setWhatsNew(false)}
            onGo={(s) => {
              setWhatsNew(false);
              navigate(s);
            }}
          />
        </Boundary>
      )}

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
