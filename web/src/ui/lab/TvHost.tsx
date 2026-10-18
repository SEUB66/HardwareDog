/**
 * HARDWARE DOG / WHERE THE TV LIVES
 *
 *   DOCKED     its place in a page that has one (the home, Flipper Lab,
 *              Camera Sniffer); on a page without one, a small TV tab
 *              that brings it floating
 *   FLOATING   it follows across every section; dragged by its body
 *              (mouse, pen or finger: a tap on POWER or the dial stays a
 *              tap), minimized to a small tab, docked back, kept on screen
 *              and above the bottom menu, its place remembered in this
 *              browser. On a phone it is a small TV that snaps to the
 *              nearest side when let go.
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
/** The TV picture's height for its width (1536 x 1024), and the toolbar under a floating one. */
const TV_RATIO = 1024 / 1536;
const BAR_H = 34;
/** A phone: the floating TV is small, and snaps to a side. */
const PHONE_W = 600;
const MARGIN = 8;

const narrow = (): boolean => typeof window !== 'undefined' && window.innerWidth < PHONE_W;

/** Where the screen ends for a floating TV: above the bottom menu, or the footer bar, when there is one. */
function bottomLimit(): number {
  if (typeof window === 'undefined') return 0;
  let limit = window.innerHeight;
  for (const sel of ['nav.nav', 'footer.foot']) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.top > window.innerHeight / 2) limit = Math.min(limit, r.top);
  }
  return limit;
}

/** Where the minimized tab sits: above the bottom menu. */
export const tabBottom = (): number => (typeof window === 'undefined' ? 0 : window.innerHeight - bottomLimit()) + 12;

type DocPip = { requestWindow(o: { width: number; height: number }): Promise<Window>; window: Window | null };
const docPip = (): DocPip | null => (globalThis as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture ?? null;

/** Whether this browser can give the TV its own always-on-top window. */
export const detachSupported = (): boolean => docPip() !== null;

export class TvPlacement {
  state: Placement;
  pip: Window | null = null;
  /** A drag in progress (not saved): no snapping animation while the finger moves. */
  dragging = false;
  /** Places on the page the docked TV can sit in, mounted now. */
  docks = 0;
  /** Another view shows the TV right now (What's new): one TV visible, never two. */
  held = false;
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
  /** Another view takes the TV for a moment (true), then gives it back (false). */
  hold(on: boolean): void {
    this.held = on;
    this.set({}, false);
  }

  /** A page's place for the TV appeared (+1) or went (-1). */
  dock(n: 1 | -1): void {
    this.docks = Math.max(0, this.docks + n);
    this.set({}, false);
  }

  /** The floating TV's width: the chosen one, smaller on a phone so it never covers the page. */
  get floatWidth(): number {
    if (!narrow()) return this.state.width;
    return Math.round(Math.min(this.state.width, Math.max(150, Math.min(200, window.innerWidth * 0.46))));
  }

  get floatHeight(): number {
    return this.floatWidth * TV_RATIO + BAR_H;
  }

  /** Float in the bottom-right corner, above the bottom menu, out of the way of the content's start. */
  float(): void {
    if (typeof window === 'undefined') return this.set({ mode: 'floating', minimized: false });
    this.set({ mode: 'floating', minimized: false, width: narrow() ? Math.min(this.state.width, 170) : this.state.width });
    this.set({ x: window.innerWidth - this.floatWidth - MARGIN * 2, y: bottomLimit() - this.floatHeight - MARGIN * 2 });
    this.clamp();
  }

  /** Keep a floating TV inside the window and above the bottom menu, whatever its size became. */
  clamp(): void {
    if (typeof window === 'undefined') return;
    const w = Math.min(this.floatWidth, window.innerWidth);
    const x = Math.min(Math.max(0, this.state.x), Math.max(0, window.innerWidth - w));
    const y = Math.min(Math.max(0, this.state.y), Math.max(0, bottomLimit() - this.floatHeight));
    if (x !== this.state.x || y !== this.state.y) this.set({ x, y });
  }

  /** Without dragging: the next corner of the window (clockwise from the top left), above the bottom menu. */
  corner(): void {
    if (typeof window === 'undefined') return;
    const w = this.floatWidth;
    const h = this.floatHeight;
    const left = MARGIN;
    const right = window.innerWidth - w - MARGIN;
    const top = MARGIN + 64;
    const bottom = bottomLimit() - h - MARGIN;
    const corners: [number, number][] = [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ];
    // the corner nearest to where it is, then the next one
    let near = 0;
    corners.forEach(([x, y], i) => {
      const [nx, ny] = corners[near]!;
      if (Math.hypot(x - this.state.x, y - this.state.y) < Math.hypot(nx - this.state.x, ny - this.state.y)) near = i;
    });
    const [x, y] = corners[(near + 1) % 4]!;
    this.set({ x, y });
    this.clamp();
  }

  /** Let go on a phone: to the nearest side. */
  snap(): void {
    if (typeof window === 'undefined' || !narrow()) return;
    const w = this.floatWidth;
    this.set({ x: this.state.x + w / 2 < window.innerWidth / 2 ? MARGIN : window.innerWidth - w - MARGIN });
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
          <button class="btn" onClick={() => placement.set({ mode: 'docked', minimized: false })} title="Back to its place in the page">
            DOCK
          </button>
          <button class="btn" onClick={() => placement.corner()} title="Move the TV to the next corner (no dragging needed)" aria-label="Move the TV to the next corner">
            ⤢
          </button>
        </>
      ) : (
        <>
          <button class="btn" onClick={() => placement.set({ minimized: true })} title="Reduce to a small bar: the TV keeps watching">
            –
          </button>
          <button class="btn" onClick={() => placement.float()} title="Float: the TV follows you across sections (drag it by the handle)">
            FLOAT
          </button>
        </>
      )}
      <button
        class="btn tv-detach"
        disabled={!canDetach}
        onClick={() => void detach(props)}
        title={canDetach ? 'Its own always-on-top window (same session, no second connection)' : 'This browser offers no always-on-top window (Document Picture-in-Picture): use FLOAT'}
      >
        DETACH
      </button>
      <button class={`btn${s.sound ? ' active' : ''}`} aria-pressed={s.sound} onClick={() => placement.set({ sound: !s.sound })} title="TV sounds (off by default)">
        SOUND
      </button>
      <button class={`btn tv-zones${s.dev ? ' active' : ''}`} aria-pressed={s.dev} onClick={() => placement.set({ dev: !s.dev })} title="Developer: show the mapped zones">
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

/** What a press on the TV must leave alone: its buttons, the dial, the bubble's actions, the toolbar. */
const PRESSABLE = 'button, input, select, a, label, [role="button"], .tv-zone:not(.tv-handle)';

/**
 * Move the TV with a mouse, a pen or a finger. The move starts after a few
 * pixels, so a tap stays a tap. It follows the pointer on the window, not
 * on the element: a docked TV becomes a floating one mid-drag (a new
 * element), and the finger keeps it. `anywhere`: the whole TV is a handle
 * (floating), else only the handle (docked, so the page still scrolls).
 */
function useDrag(placement: TvPlacement, box: () => HTMLElement | null, anywhere: boolean) {
  return (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    const onHandle = !!target.closest('.tv-handle');
    if (!onHandle && (!anywhere || target.closest(PRESSABLE))) return;
    const el = box();
    if (!el) return;
    if (onHandle) e.preventDefault();
    const win = el.ownerDocument.defaultView ?? window;
    const start = el.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    let dx = sx - start.left;
    let dy = sy - start.top;
    let moving = false;
    const begin = () => {
      moving = true;
      placement.dragging = true;
      if (placement.state.mode === 'docked') {
        // Picked up from its place: a floating TV of a floating size, under the finger.
        placement.set({ mode: 'floating', minimized: false, width: Math.min(MAX_W, Math.max(MIN_W, start.width)) }, false);
        const w = placement.floatWidth;
        const k = w / start.width;
        dx *= k;
        dy *= k;
      }
    };
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId) return;
      if (!moving) {
        if (Math.hypot(m.clientX - sx, m.clientY - sy) < 6) return;
        begin();
      }
      m.preventDefault();
      placement.set({ x: m.clientX - dx, y: m.clientY - dy }, false);
      placement.clamp();
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== e.pointerId) return;
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', up);
      if (!moving) return;
      placement.dragging = false;
      if (u.pointerType !== 'mouse') placement.snap();
      placement.clamp();
      placement.set({});
    };
    win.addEventListener('pointermove', move, { passive: false });
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', up);
  };
}

/** A one-line TV: its light, its state, a tap brings it back. */
function TvBar({ companion, onShow, title }: { companion: Companion; onShow: () => void; title: string }) {
  useRev(companion);
  return (
    <button class={`tv-bar hw-${companion.hardware}`} onClick={onShow} title={title}>
      <span class={`tv-tab-light power-${companion.power}`} aria-hidden="true" />
      TV · {companion.focus.section} · {companion.hardware}
      {companion.badge ? ` · ${companion.badge}` : ''}
      {companion.message ? ` · ${companion.message.severity}` : ''}
    </button>
  );
}

/** The docked TV: rendered by a page that has a place for it (the home, Flipper Lab, Camera Sniffer). */
export function TvDocked(props: HostProps) {
  const { placement } = props;
  useRev(placement);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useDrag(placement, () => ref.current, false);
  useEffect(() => {
    placement.dock(1);
    return () => placement.dock(-1);
  }, [placement]);
  const s = placement.state;
  if (placement.pip) return <TvAway placement={placement} />;
  // shown elsewhere for a moment: its place is kept, empty
  if (placement.held && s.mode === 'docked') return <div class="tv-docked tv-held" aria-hidden="true" />;
  if (s.mode === 'docked' && s.minimized) return <TvBar companion={props.companion} onShow={() => placement.set({ minimized: false })} title="Show the TV" />;
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
  const drag = useDrag(placement, () => ref.current, true);
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
  if (placement.pip || placement.held) return null;
  // Docked, on a page with no place for it: a small tab, never nothing; a tap brings it floating.
  if (s.mode === 'docked') {
    if (placement.docks > 0) return null;
    return (
      <button class={`tv-tab hw-${companion.hardware}`} style={{ bottom: `${tabBottom()}px` }} onClick={() => placement.float()} title="Bring the TV: it floats and follows you">
        <span class={`tv-tab-light power-${companion.power}`} aria-hidden="true" />
        TV{companion.message ? ` · ${companion.message.severity}` : ''}
      </button>
    );
  }
  if (s.minimized)
    return (
      <button class={`tv-tab hw-${companion.hardware}`} style={{ bottom: `${tabBottom()}px` }} onClick={() => placement.set({ minimized: false })} title="Show the TV">
        <span class={`tv-tab-light power-${companion.power}`} aria-hidden="true" />
        TV · {companion.hardware}
        {companion.message ? ` · ${companion.message.severity}` : ''}
      </button>
    );
  return (
    <div
      class={`tv-floating${placement.dragging ? ' dragging' : ''}`}
      ref={ref}
      style={{ left: `${s.x}px`, top: `${s.y}px`, width: `${placement.floatWidth}px` }}
      onPointerDown={(e) => drag(e as unknown as PointerEvent)}
    >
      <RetroTv companion={companion} registry={props.registry} dev={s.dev} sound={s.sound} reducedMotion={props.reducedMotion} />
      <Toolbar placement={placement} props={props} onDrag />
    </div>
  );
}
