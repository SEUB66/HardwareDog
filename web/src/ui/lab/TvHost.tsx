/**
 * HARDWARE DOG / WHERE THE TV LIVES
 *
 *   DOCKED     a permanent place in Flipper Lab
 *   FLOATING   moved by its handle, it follows across every section;
 *              minimized to a small tab, docked back, kept on screen,
 *              its place remembered in this browser
 *   DETACHED   its own always-on-top window, where the browser offers one
 *              (Document Picture-in-Picture, Chromium desktop). Same page,
 *              same companion, same Flipper session: detaching never opens
 *              a second connection. Where it is not offered, the button
 *              says so and floating stays the way.
 *
 * Moving the TV between places remounts it; its picture follows time and
 * the companion's state, so nothing restarts.
 */

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Companion } from '../../core/lab/companion';
import type { CommandRegistry } from '../../core/lab/registry';
import { RetroTv } from './RetroTv';
import { local, useRev } from './useRev';

export type TvMode = 'docked' | 'floating';

interface Placement {
  mode: TvMode;
  x: number;
  y: number;
  width: number;
  minimized: boolean;
  dev: boolean;
  sound: boolean;
  on: boolean;
}

const KEY = 'hwdog.tv';
const MIN_W = 220;
const MAX_W = 560;

type DocPip = { requestWindow(o: { width: number; height: number }): Promise<Window>; window: Window | null };
const docPip = (): DocPip | null => (globalThis as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture ?? null;

/** Whether this browser can give the TV its own always-on-top window. */
export const detachSupported = (): boolean => docPip() !== null;

export class TvPlacement {
  state: Placement;
  pip: Window | null = null;
  private listeners = new Set<() => void>();
  private rev = 0;

  constructor() {
    const saved = local.get<Partial<Placement>>(KEY, {});
    this.state = { mode: 'docked', x: 24, y: 96, width: 320, minimized: false, dev: false, sound: false, on: false, ...saved };
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('tvdev')) this.state.dev = true;
    this.state.width = Math.min(MAX_W, Math.max(MIN_W, this.state.width));
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  get revision(): number {
    return this.rev;
  }
  set(patch: Partial<Placement>, save = true): void {
    this.state = { ...this.state, ...patch };
    if (save) local.set(KEY, this.state);
    this.rev++;
    for (const l of [...this.listeners]) l();
  }
  /** Float in the bottom-right corner, out of the way of the menu and the content's start. */
  float(): void {
    const w = Math.min(this.state.width, typeof window === 'undefined' ? this.state.width : window.innerWidth - 16);
    const x = typeof window === 'undefined' ? 0 : window.innerWidth - w - 16;
    const y = typeof window === 'undefined' ? 0 : window.innerHeight - w * 0.68 - 90;
    this.set({ mode: 'floating', minimized: false, x, y });
    this.clamp();
  }

  /** Keep a floating TV inside the window, whatever its size became. */
  clamp(): void {
    if (typeof window === 'undefined') return;
    const h = this.state.width * 0.68 + 40;
    const x = Math.min(Math.max(0, this.state.x), Math.max(0, window.innerWidth - Math.min(this.state.width, window.innerWidth)));
    const y = Math.min(Math.max(0, this.state.y), Math.max(0, window.innerHeight - Math.min(h, window.innerHeight)));
    if (x !== this.state.x || y !== this.state.y) this.set({ x, y });
  }
}

interface HostProps {
  companion: Companion;
  registry: CommandRegistry;
  placement: TvPlacement;
  reducedMotion: boolean;
}

/** Remember POWER across visits; restore it once. */
export function useTvPower(companion: Companion, placement: TvPlacement): void {
  useEffect(() => {
    if (placement.state.on) companion.setPower(true);
    return companion.subscribe(() => {
      if (placement.state.on !== companion.heading) placement.set({ on: companion.heading });
    });
  }, [companion, placement]);
}

async function detach(props: HostProps): Promise<void> {
  const api = docPip();
  const { placement } = props;
  if (!api || placement.pip) return;
  const win = await api.requestWindow({ width: 520, height: 420 });
  // The same styles, copied: the window is part of this page, not a new app.
  for (const sheet of [...document.styleSheets]) {
    try {
      const style = win.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      win.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = win.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        win.document.head.appendChild(link);
      }
    }
  }
  win.document.documentElement.dataset['theme'] = document.documentElement.dataset['theme'] ?? 'dark';
  win.document.title = 'Hardware Dog TV';
  win.document.body.className = 'tv-pip-body';
  const root = win.document.createElement('div');
  root.className = 'tv-pip';
  win.document.body.appendChild(root);
  render(<PipTv {...props} />, root);
  win.addEventListener('pagehide', () => {
    render(null, root);
    placement.pip = null;
    placement.set({}, false);
  });
  placement.pip = win;
  placement.set({}, false);
}

function PipTv({ companion, registry, placement, reducedMotion }: HostProps) {
  useRev(placement);
  return <RetroTv companion={companion} registry={registry} dev={placement.state.dev} sound={placement.state.sound} reducedMotion={reducedMotion} />;
}

function Toolbar({ placement, props, onDrag }: { placement: TvPlacement; props: HostProps; onDrag?: boolean }) {
  const s = placement.state;
  const canDetach = detachSupported();
  return (
    <div class="tv-toolbar" role="toolbar" aria-label="TV">
      {s.mode === 'floating' ? (
        <>
          <button class="btn" onClick={() => placement.set({ minimized: true })} title="Minimize to a small tab">
            –
          </button>
          <button class="btn" onClick={() => placement.set({ mode: 'docked', minimized: false })} title="Back to its place in Flipper Lab">
            DOCK
          </button>
        </>
      ) : (
        <button class="btn" onClick={() => placement.float()} title="Float: the TV follows you across sections (drag it by the handle)">
          FLOAT
        </button>
      )}
      <button
        class="btn"
        disabled={!canDetach}
        onClick={() => void detach(props)}
        title={canDetach ? 'Its own always-on-top window (same session, no second connection)' : 'This browser offers no always-on-top window (Document Picture-in-Picture): use FLOAT'}
      >
        DETACH
      </button>
      <button class={`btn${s.sound ? ' active' : ''}`} aria-pressed={s.sound} onClick={() => placement.set({ sound: !s.sound })} title="TV sounds (off by default)">
        SOUND
      </button>
      <button class={`btn${s.dev ? ' active' : ''}`} aria-pressed={s.dev} onClick={() => placement.set({ dev: !s.dev })} title="Developer: show the mapped zones">
        ZONES
      </button>
      {onDrag && s.mode === 'floating' && (
        <label class="tv-size">
          SIZE
          <input type="range" min={MIN_W} max={MAX_W} step={20} value={s.width} onInput={(e) => placement.set({ width: Number((e.target as HTMLInputElement).value) })} />
        </label>
      )}
    </div>
  );
}

/** Start dragging from the handle; a docked TV becomes a floating one where it stands. */
function useDrag(placement: TvPlacement, box: () => HTMLElement | null) {
  return (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = box();
    if (!el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    if (placement.state.mode === 'docked') placement.set({ mode: 'floating', x: r.left, y: r.top, width: Math.min(MAX_W, Math.max(MIN_W, r.width)), minimized: false });
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const target = e.target as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const move = (m: PointerEvent) => {
      placement.set({ x: m.clientX - dx, y: m.clientY - dy }, false);
      placement.clamp();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      placement.clamp();
      placement.set({});
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
}

/** The docked TV: rendered by Flipper Lab, in its place. */
export function TvDocked(props: HostProps) {
  const { placement } = props;
  useRev(placement);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDrag(placement, () => ref.current);
  const s = placement.state;
  if (placement.pip) return <TvAway placement={placement} />;
  if (s.mode !== 'docked')
    return (
      <div class="tv-docked tv-away">
        <p class="note">The TV is floating: it follows you across sections.</p>
        <button class="btn" onClick={() => placement.set({ mode: 'docked', minimized: false })}>
          BRING IT BACK HERE
        </button>
      </div>
    );
  return (
    <div class="tv-docked" ref={ref}>
      <RetroTv companion={props.companion} registry={props.registry} dev={s.dev} sound={s.sound} reducedMotion={props.reducedMotion} onHandleDown={drag} handleLabel="Drag the handle: the TV floats and follows you" />
      <Toolbar placement={placement} props={props} />
    </div>
  );
}

function TvAway({ placement }: { placement: TvPlacement }) {
  return (
    <div class="tv-docked tv-away">
      <p class="note">The TV is in its own window (same session, no second connection).</p>
      <button class="btn" onClick={() => placement.pip?.close()}>
        BRING IT BACK
      </button>
    </div>
  );
}

/** The floating TV: rendered by the app shell, above every section. */
export function TvFloating(props: HostProps) {
  const { placement, companion } = props;
  useRev(placement);
  useRev(companion);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDrag(placement, () => ref.current);
  const [, force] = useState(0);
  useEffect(() => {
    const onResize = () => {
      placement.clamp();
      force((n) => n + 1);
    };
    window.addEventListener('resize', onResize);
    placement.clamp();
    return () => window.removeEventListener('resize', onResize);
  }, [placement]);
  const s = placement.state;
  if (s.mode !== 'floating' || placement.pip) return null;
  if (s.minimized)
    return (
      <button class={`tv-tab hw-${companion.hardware}`} onClick={() => placement.set({ minimized: false })} title="Show the TV">
        <span class={`tv-tab-light power-${companion.power}`} aria-hidden="true" />
        TV · {companion.hardware}
        {companion.message ? ` · ${companion.message.severity}` : ''}
      </button>
    );
  return (
    <div class="tv-floating" ref={ref} style={{ left: `${s.x}px`, top: `${s.y}px`, width: `${s.width}px` }}>
      <RetroTv companion={companion} registry={props.registry} dev={s.dev} sound={s.sound} reducedMotion={props.reducedMotion} onHandleDown={drag} />
      <Toolbar placement={placement} props={props} onDrag />
    </div>
  );
}
