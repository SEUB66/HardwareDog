import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BUILD } from '../core/ascii';
import { SCREENS, type CommandContext, type Screen } from '../core/commands';
import { duration, sessionId } from '../core/format';
import { buildReport, reportToText } from '../core/report';
import { SimulatedDevice } from '../core/simulator';
import { System, browserStore } from '../core/system';
import type { Transport } from '../core/transport';
import type { Source, TransportKind } from '../core/types';
import { WebSerialTransport } from '../core/webserial';
import markSrc1x from '../../../assets/brand/web/hd-mark-1x.webp';
import markSrc2x from '../../../assets/brand/web/hd-mark-2x.webp';
import markSrc3x from '../../../assets/brand/web/hd-mark-3x.webp';
import { Boot } from './Boot';
import { CommandPalette, type PaletteEntry } from './CommandPalette';
import { Tag } from './components/Tag';
import { useNow, useSystem } from './hooks';
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
}

/** Shown on phones; everything else sits behind MORE (spec 32). */
const PRIMARY: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'PROBE'];
const DIGIT_SCREENS: readonly Screen[] = ['STATUS', 'TRACE', 'POWER', 'USB', 'SERIAL', 'BUS', 'NET'];

let sessionCounter = 0;
const newSession = (transport: Transport): Session => ({
  system: new System(browserStore()),
  transport,
  key: ++sessionCounter,
});

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

export function App() {
  const [session, setSession] = useState<Session>(() => newSession(new SimulatedDevice({ seed: Date.now() & 0xffff })));
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>('STATUS');
  const [traceOnly, setTraceOnly] = useState<Source[] | null>(null);
  const [palette, setPaletteState] = useState(false);
  // The keyboard handler must see open/close immediately, not after the
  // next render, or fast keystrokes leak into global shortcuts.
  const paletteOpen = useRef(false);
  const setPalette = (open: boolean) => {
    paletteOpen.current = open;
    setPaletteState(open);
  };
  const [paletteLog, setPaletteLog] = useState<PaletteEntry[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const previous = useRef<Screen[]>([]);
  const { system } = session;
  useSystem(system);
  const now = useNow();

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

  const switchTransport = async (kind: TransportKind) => {
    let transport: Transport;
    if (kind === 'WEB SERIAL') {
      try {
        transport = await WebSerialTransport.pick();
      } catch (e) {
        system.mark(`web serial: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else {
      transport = new SimulatedDevice({ seed: Date.now() & 0xffff });
    }
    await system.disconnect();
    setSession(newSession(transport));
    setScreen('STATUS');
    setBooting(true);
  };

  const context: CommandContext = useMemo(
    () => ({ system, navigate: (s) => navigate(s), exportReport }),
    // navigate reads the current screen through state setters only.
    [system, screen],
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
      if (paletteOpen.current) return;
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

  const linkTag =
    system.link === 'ONLINE' ? <Tag status="PASS" label="ONLINE" /> : system.link === 'LOST' ? <Tag status="FAIL" label="LINK LOST" /> : <Tag status="UNKNOWN" label={system.link} />;

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
        return <Report system={system} onExport={exportReport} />;
      case 'SETUP':
        return <Setup system={system} onSwitch={(k) => void switchTransport(k)} />;
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
          <span class="v">{sessionId(system.startedAt)}</span>
        </span>
        <span class="spacer" />
        {system.trace.paused && <Tag status="WARN" label="TRACE PAUSED" />}
        {system.transportKind === 'SIMULATOR' && <Tag status="WARN" label="SIMULATOR" />}
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
          context={context}
          log={paletteLog}
          onLog={(entry) => setPaletteLog((l) => [...l.slice(-49), entry])}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}
