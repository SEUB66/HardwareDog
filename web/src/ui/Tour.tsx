import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** One stop of the tour: a part of the screen and what it is for. */
export interface TourStop {
  /** CSS selector of the part shown. A stop whose part is not on screen is skipped. */
  target: string;
  title: string;
  text: string;
}

/** The interface, top to bottom, in the words an operator needs on day one. */
export const TOUR: readonly TourStop[] = [
  {
    target: '.head',
    title: 'THE HEADER',
    text: 'Which device you are reading (DEVICE), how it reaches you (VIA), how long the session has run and its id. On the right, the link: ONLINE, LINK LOST or OFFLINE. SIMULATOR in amber means the data is not from real hardware.',
  },
  {
    target: '.connect-banner',
    title: 'CHOOSE A SOURCE',
    text: 'Nothing is measured until you choose: a Hardware Dog on USB (Web Serial), the local daemon dogd, a recorded session (.hdlog), or the demo. The demo is always labeled SIMULATED.',
  },
  {
    target: '.sim-banner',
    title: 'THE DEMO',
    text: 'A simulated Hardware Dog plays a fault scenario. Everything it shows is SIMULATED. STOP DEMO goes back to NOT CONNECTED.',
  },
  {
    target: '.nav',
    title: 'SECTIONS',
    text: 'STATUS is the overview. TRACE is every event in order. POWER, USB, SERIAL, BUS (I2C) and NET are one signal each. PROBE runs active tests, REPORT writes what was found, SETUP holds sources and sessions. Keys 1 to 7 jump to them.',
  },
  {
    target: '.work .grid',
    title: 'ONE CARD PER SIGNAL',
    text: 'Each card is one signal, as measured now. "--" means not measured: never zero, never a guess. Every underlined word explains itself: hover it, or tap it on a phone.',
  },
  {
    target: '[aria-labelledby="panel-diagnosis"]',
    title: 'DIAGNOSIS',
    text: 'Fixed rules, no guessing: each finding says what was observed, how confident it is, the HDP frames that prove it, and what to check next. Nothing found is said as such.',
  },
  {
    target: '[aria-labelledby="panel-latest-events"]',
    title: 'LATEST EVENTS',
    text: 'The timeline, newest first. F2 opens the full trace; SPACE pauses it while you read.',
  },
  {
    target: '.foot',
    title: 'KEYS',
    text: 'F1 help, F2 trace, F3 probe, F4 report. CTRL+K opens the command line: type help to list every command.',
  },
  {
    target: '.nav .local',
    title: 'LOCAL ONLY',
    text: 'No cloud, no account, no telemetry. What is measured stays on this machine. That is the end of the tour: TOUR at the top plays it again.',
  },
];

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

/**
 * A guided tour of the interface: one part at a time is lit, the rest
 * dimmed, with a card saying what it is for. NEXT / BACK, the arrow keys,
 * ESC to leave. It only points at the screen: it changes nothing.
 */
export function Tour({ stops = TOUR, onEnd }: { stops?: readonly TourStop[]; onEnd: () => void }) {
  // Only the stops whose part is on screen now.
  const [shown] = useState(() => stops.filter((s) => visible(document.querySelector(s.target))));
  const [at, setAt] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const next = useRef<HTMLButtonElement>(null);
  const stop = shown[at];
  const last = at === shown.length - 1;

  useLayoutEffect(() => {
    if (!stop) return;
    const el = document.querySelector(stop.target);
    if (!visible(el)) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [stop]);

  useEffect(() => next.current?.focus(), [at]);

  useEffect(() => {
    // Captured first: while the tour is open, no other shortcut fires.
    const onKey = (e: KeyboardEvent) => {
      const keys: Record<string, () => void> = {
        Escape: onEnd,
        ArrowRight: () => (last ? onEnd() : setAt(at + 1)),
        ArrowLeft: () => setAt(Math.max(0, at - 1)),
      };
      const act = keys[e.key];
      if (act) {
        e.preventDefault();
        act();
      }
      if (e.key !== 'Tab' && e.key !== 'Enter' && e.key !== ' ') e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [at, last]);

  useEffect(() => {
    if (!stop) onEnd(); // nothing to show
  }, [stop]);
  if (!stop) return null;

  const pad = 4;
  const vh = window.innerHeight;
  const below = box ? box.top + box.height + pad + 12 : 0;
  const card =
    box === null || window.innerWidth < 640
      ? undefined // docked on a phone, away from the part shown (CSS)
      : below + 220 < vh
        ? { top: below, left: Math.min(Math.max(box.left, 12), window.innerWidth - 432) }
        : { bottom: Math.max(vh - box.top + pad + 12, 12), left: Math.min(Math.max(box.left, 12), window.innerWidth - 432) };

  return (
    <div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {box && (
        <div
          class="tour-light"
          aria-hidden="true"
          style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
        />
      )}
      <div class={`tour-card${card ? '' : box && box.top + box.height / 2 > vh / 2 ? ' docked top' : ' docked'}`} style={card}>
        <div class="tour-head">
          <b id="tour-title">{stop.title}</b>
          <span class="dim">{`${at + 1} / ${shown.length}`}</span>
        </div>
        <p>{stop.text}</p>
        <div class="tour-actions">
          <button class="btn" onClick={onEnd}>
            END TOUR
          </button>
          <span class="spacer" />
          <button class="btn" onClick={() => setAt(at - 1)} disabled={at === 0}>
            BACK
          </button>
          <button ref={next} class="btn active" onClick={() => (last ? onEnd() : setAt(at + 1))}>
            {last ? 'DONE' : 'NEXT'}
          </button>
        </div>
      </div>
    </div>
  );
}
