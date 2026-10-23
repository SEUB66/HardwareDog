/**
 * HARDWARE DOG / RETRO TV
 *
 * The companion's TV, in four layers (the TV and who lives in it follow
 * the companion's profile: the turquoise TV and the dog, or Flipper Lab's
 * orange TV and its companion):
 *
 *   1  SCREEN CONTENT   the pixel scene on a canvas, or text (TOOL, EVENT views)
 *   2  CRT EFFECTS      scanlines, glow, vignette: inside the opening only
 *   3  FRAME            the TV picture, opaque body, transparent opening
 *   4  CONTROLS         POWER, the dial, the handle: real buttons on the
 *                       picture's controls, placed by the skin's profile
 *
 * POWER switches the TV, nothing else. The dial changes the view, nothing
 * else. The handle moves the TV (floating mode); POWER and the dial never
 * start a move.
 *
 * Drawing follows time, not mounts: the frame shown is a function of the
 * companion's state and the monotonic clock, so moving the TV to another
 * section or a detached window resumes it exactly. The canvas loop runs
 * only while the TV is on (or switching) and visible.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { DIAL_MODES, type Companion, type DialMode } from '../../core/lab/companion';
import type { LabEvent } from '../../core/lab/events';
import type { CommandRegistry } from '../../core/lab/registry';
import { DOG } from './dogSprites';
import { SCREEN_H, SCREEN_W, COMPANION, type SpriteSet } from './sprites';
import { ORANGE_TV, TURQUOISE_TV, boxStyle, ellipseStyle, screenClip, screenPath, skinFor, type TvSkin } from './tvSkin';
import { tvSound } from './tvSound';
import { useRev } from './useRev';
import { track, warmLater } from '../../core/net';

const DIAL_LABEL: Record<DialMode, string> = { COMPANION: 'CH 1 · COMPANION', TOOL: 'CH 2 · TOOL STATE', EVENT: 'CH 3 · LAST EVENT' };

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(2)} MiB`);

export function progressText(p: LabEvent['progress'] | null | undefined): string {
  if (!p) return 'working…';
  const v = (n: number) => (p.unit === 'bytes' ? fmtBytes(n) : `${n} ${p.unit}`);
  // No total from the device: no percentage, ever.
  if (p.total === null) return `${v(p.done)} so far (total unknown)`;
  return `${v(p.done)} / ${v(p.total)} (${p.total ? Math.floor((p.done / p.total) * 100) : 100} %)`;
}

/** Boot (~2 s) and shutdown drawn in the screen; the box never moves. */
function drawPower(ctx: CanvasRenderingContext2D, buffer: HTMLCanvasElement, c: Companion, sprites: SpriteSet, now: number, reduced: boolean): void {
  const tr = c.transition;
  const W = SCREEN_W;
  const H = SCREEN_H;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (!tr) return;
  const e = Math.max(0, now - tr.from);
  const b = buffer.getContext('2d')!;
  // The scene the screen opens on, and closes from: where the companion is.
  const rest = c.hardware === 'CONNECTED' ? 'idle' : 'wait';
  const stage = { section: c.focus.section, calm: false, code: null };
  if (c.power === 'BOOTING') {
    if (reduced) {
      sprites.drawScene(b, rest, now, null, stage);
      ctx.globalAlpha = Math.min(1, e / tr.ms);
      ctx.drawImage(buffer, 0, 0);
      ctx.globalAlpha = 1;
      return;
    }
    const cx = W / 2;
    const cy = H / 2;
    if (e < 150) {
      ctx.fillStyle = '#fffaf0';
      const r = 1 + e / 75;
      ctx.fillRect(Math.round(cx - r), Math.round(cy - r), Math.round(r * 2), Math.round(r * 2));
    } else if (e < 400) {
      const w = ((e - 150) / 250) * W;
      ctx.fillStyle = '#d8fbff';
      ctx.fillRect(Math.round(cx - w / 2), Math.round(cy - 1), Math.round(w), 2);
    } else if (e < 700) {
      sprites.drawSplash(b, 0);
      const h = Math.max(2, ((e - 400) / 300) * H);
      ctx.drawImage(buffer, 0, 0, W, H, 0, Math.round(cy - h / 2), W, Math.round(h));
    } else if (e < 1000) {
      // analog snow, a fresh field every frame
      const img = ctx.createImageData(W, H);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    } else if (e < 1650) {
      sprites.drawSplash(ctx, e - 1000);
    } else {
      sprites.drawSplash(ctx, 650);
      sprites.drawScene(b, rest, now, null, stage);
      ctx.globalAlpha = Math.min(1, (e - 1650) / 300);
      ctx.drawImage(buffer, 0, 0);
      ctx.globalAlpha = 1;
    }
    return;
  }
  // SHUTTING_DOWN: it waves goodbye and presses the power button; squeeze to a line, a dot, dark
  sprites.drawScene(b, 'shutdown', e + 600);
  const p = e / tr.ms;
  if (reduced) {
    ctx.globalAlpha = Math.max(0, 1 - p);
    ctx.drawImage(buffer, 0, 0);
    ctx.globalAlpha = 1;
    return;
  }
  if (p < 0.46) {
    const h = Math.max(2, (1 - p / 0.46) * H);
    ctx.drawImage(buffer, 0, 0, W, H, 0, Math.round(H / 2 - h / 2), W, Math.round(h));
    ctx.globalAlpha = p / 0.46;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, Math.round(H / 2 - h / 2), W, Math.round(h));
    ctx.globalAlpha = 1;
  } else if (p < 0.85) {
    const w = Math.max(2, (1 - (p - 0.46) / 0.39) * W);
    ctx.fillStyle = '#e8fdff';
    ctx.fillRect(Math.round(W / 2 - w / 2), Math.round(H / 2 - 1), Math.round(w), 2);
  } else {
    ctx.globalAlpha = Math.max(0, 1 - (p - 0.85) / 0.15);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(W / 2 - 1), Math.round(H / 2 - 1), 2, 2);
    ctx.globalAlpha = 1;
  }
}

/** The canvas: scenes and the power sequence, ~15 frames a second, only when needed. */
function TvCanvas({ companion, sprites, reduced }: { companion: Companion; sprites: SpriteSet; reduced: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    sprites.preload?.();
    const buffer = canvas.ownerDocument.createElement('canvas');
    buffer.width = SCREEN_W;
    buffer.height = SCREEN_H;
    const win = canvas.ownerDocument.defaultView ?? window;
    let frame = 0;
    let last = -1e9;
    let visible = true;
    const io = 'IntersectionObserver' in win ? new win.IntersectionObserver((es) => (visible = es.some((x) => x.isIntersecting))) : null;
    io?.observe(canvas);
    const draw = (now: number) => {
      if (companion.power === 'OFF') {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
        return;
      }
      if (companion.power !== 'ON') drawPower(ctx, buffer, companion, sprites, now, reduced);
      // Reduced motion: the same scene, held still on a representative moment.
      else sprites.drawScene(ctx, companion.scene, reduced ? 1200 : now - companion.animSince, companion.subject, reduced ? { ...companion.stage, calm: false } : companion.stage);
    };
    const loop = (now: number) => {
      frame = 0;
      const running = companion.power !== 'OFF' && visible && canvas.ownerDocument.visibilityState !== 'hidden';
      if (running && now - last >= 66) {
        last = now;
        draw(now);
      }
      if (companion.power !== 'OFF') frame = win.requestAnimationFrame(loop);
    };
    const kick = () => {
      if (frame === 0) {
        draw(performance.now());
        if (companion.power !== 'OFF') frame = win.requestAnimationFrame(loop);
      }
    };
    kick();
    const unsubscribe = companion.subscribe(kick);
    return () => {
      unsubscribe();
      io?.disconnect();
      if (frame !== 0) win.cancelAnimationFrame(frame);
    };
  }, [companion, sprites, reduced]);
  return <canvas ref={ref} class="tv-canvas" width={SCREEN_W} height={SCREEN_H} aria-hidden="true" />;
}

const hhmmss = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

function ToolView({ companion }: { companion: Companion }) {
  // The tool looked at first: its link, its operations; the others after.
  const ops = companion.operations;
  const f = companion.focus;
  return (
    <div class="tv-text">
      <div class="tv-text-title">TOOL · {f.section}</div>
      {f.unavailable ? (
        <div class="sev-WARN">{f.unavailable}</div>
      ) : (
        <>
          <div>
            {f.source ?? 'LINK'} <b class={`hw-${companion.hardware}`}>{companion.hardware}</b>
          </div>
          {companion.hardwareDetail && <div class="tv-dim">{companion.hardwareDetail}</div>}
        </>
      )}
      {[...companion.links].filter(([src]) => src !== f.source).map(([src, line]) => (
        <div key={src} class="tv-dim">
          {src}: {line}
        </div>
      ))}
      {ops.length === 0 ? (
        <div>NO OPERATION RUNNING</div>
      ) : (
        ops.slice(0, 3).map((o) => (
          <div key={o.id}>
            ▸ {o.source !== f.source ? `${o.source} · ` : ''}
            {o.message}
            <div class="tv-dim">{o.waiting ? 'waiting for you' : progressText(o.progress)}</div>
          </div>
        ))
      )}
      {companion.op !== 'IDLE' && <div>RESULT {companion.op}</div>}
    </div>
  );
}

function EventView({ companion, registry }: { companion: Companion; registry: CommandRegistry }) {
  const e = companion.lastEvent;
  const why = registry.blocked('lab.log', e ? { source: e.source } : undefined);
  return (
    <div class="tv-text">
      <div class="tv-text-title">LAST EVENT</div>
      {e ? (
        <>
          <div>
            #{e.seq} {hhmmss(e.at)} {e.source}
          </div>
          <div class="tv-dim">
            {e.tool} · {e.type}
          </div>
          <div class={`sev-${e.severity}`}>{e.severity}</div>
          <div class="tv-msg">{e.message}</div>
          {e.code && <div>CODE {e.code}</div>}
          {e.origin !== 'PHYSICAL' && <div class="tv-dim">{e.origin === 'SIMULATED' ? 'DEMO DATA' : 'REPLAY'}</div>}
          <button class="tv-act" disabled={!!why} title={why ?? 'The full log of this tool'} onClick={() => void registry.run('lab.log', { source: e.source })}>
            DETAILS
          </button>
        </>
      ) : (
        <div>NOTHING YET</div>
      )}
    </div>
  );
}

export interface RetroTvProps {
  companion: Companion;
  registry: CommandRegistry;
  skin?: TvSkin;
  sprites?: SpriteSet;
  dev?: boolean;
  sound?: boolean;
  reducedMotion?: boolean;
  /** Pointer down on the handle: the host moves the TV. */
  onHandleDown?: (e: PointerEvent) => void;
  handleLabel?: string;
}

/** How wide the TV frame is shown: its srcset picks the picture from this. */
const FRAME_SIZES = '(max-width: 600px) 90vw, 560px';

/** Ask for a TV frame at the size this screen will show it (the same srcset choice as the TV itself). */
function warmFrame(skin: TvSkin): HTMLImageElement {
  const img = new Image();
  img.sizes = FRAME_SIZES;
  img.srcset = skin.frame.srcset;
  img.src = skin.frame.src;
  return img;
}

/**
 * The TV of a profile, asked for before it is shown (during the boot
 * screen, when the network has nothing else to do): its frame and scenes.
 */
export function preloadTv(profile: Companion['profile']): void {
  if (typeof Image === 'undefined') return;
  track(warmFrame(skinFor(profile)));
  (profile === 'flipper' ? COMPANION : DOG).preload?.();
}

export function RetroTv({ companion, registry, skin: skinProp, sprites: spritesProp, dev = false, sound = false, reducedMotion = false, onHandleDown, handleLabel }: RetroTvProps) {
  useRev(companion);
  // Who lives in the TV follows the section: the dog, or Flipper Lab's companion. Same companion, same power.
  const skin = skinProp ?? skinFor(companion.profile);
  const sprites = spritesProp ?? (companion.profile === 'flipper' ? COMPANION : DOG);
  const p = skin.profile;
  // The other TV's picture and scenes, warmed once the page has what it needs
  // (never on a frugal connection): a section change never shows an empty frame.
  // The frame is warmed at the size this screen would show (srcset, sizes), not twice.
  useEffect(() => {
    if (typeof Image === 'undefined') return;
    const other = companion.profile === 'flipper' ? { tv: TURQUOISE_TV, scenes: DOG } : { tv: ORANGE_TV, scenes: COMPANION };
    warmLater(() => {
      warmFrame(other.tv);
      other.scenes.preload?.();
    });
  }, []);
  // The knob is cut from the frame the browser chose (its currentSrc): one picture downloaded, not two sizes.
  const [chosen, setChosen] = useState<{ of: string; src: string } | null>(null);
  const frameSrc = chosen?.of === skin.frame.src ? chosen.src : null;
  const [osd, setOsd] = useState<number>(0);
  const lastDial = useRef(companion.dial);
  // Runs on a dial change only: the re-render it causes must not cancel its own timer.
  useEffect(() => {
    if (lastDial.current === companion.dial) return;
    lastDial.current = companion.dial;
    setOsd((n) => n + 1);
    const t = setTimeout(() => setOsd(0), 1600);
    return () => clearTimeout(t);
  }, [companion.dial]);

  const on = companion.power === 'ON';
  const msg = companion.message;
  const angle = skin.dialAngles[DIAL_MODES.indexOf(companion.dial)] ?? 0;
  const power = () => {
    const willBeOn = !companion.heading;
    companion.pressPower();
    if (sound) tvSound(willBeOn ? 'on' : 'off');
  };
  const dialKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') companion.turnDial(1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') companion.turnDial(-1);
    else return;
    e.preventDefault();
  };
  const stop = (e: Event) => e.stopPropagation();
  const knob = ellipseStyle(p.knob);

  return (
    <div class={`tv power-${companion.power}${dev ? ' tv-dev' : ''}`} style={{ aspectRatio: `${p.reference.width} / ${p.reference.height}` }}>
      <div class={`tv-screen${on && companion.badge ? ' has-badge' : ''}`} style={{ ...boxStyle(p.screen.box), clipPath: screenClip(p) }}>
        <TvCanvas companion={companion} sprites={sprites} reduced={reducedMotion} />
        {on && companion.dial === 'TOOL' && <ToolView companion={companion} />}
        {on && companion.dial === 'EVENT' && <EventView companion={companion} registry={registry} />}
        {on && companion.badge && <div class={`tv-badge tv-badge-${companion.badge}`}>{companion.badge}</div>}
        {on && companion.dial === 'COMPANION' && msg && (
          <div class={`tv-bubble sev-${msg.severity}`} role="status">
            <div class="tv-bubble-text">
              {msg.text}
              {msg.count > 1 && <span class="tv-count"> ×{msg.count}</span>}
            </div>
            {msg.code && <div class="tv-code">CODE {msg.code}</div>}
            <div class="tv-bubble-actions">
              {msg.actions?.map((a) => {
                // checked at the moment it is shown and again at the click: never a stale RETRY
                const why = registry.blocked(a.command, a.args);
                return (
                  <button key={a.command} class="tv-act" disabled={!!why} title={why ?? undefined} onClick={() => void registry.run(a.command, a.args)}>
                    {a.label}
                  </button>
                );
              })}
              <button class="tv-act" onClick={() => companion.messages.dismiss()} aria-label="Dismiss message">
                OK
              </button>
            </div>
          </div>
        )}
        {on && osd > 0 && <div class="tv-osd">{DIAL_LABEL[companion.dial]}</div>}
        <div class="tv-crt" aria-hidden="true" />
      </div>

      <img class="tv-frame" src={skin.frame.src} srcset={skin.frame.srcset} sizes={FRAME_SIZES} alt="" draggable={false} decoding="async" onLoad={(e) => setChosen({ of: skin.frame.src, src: (e.currentTarget as HTMLImageElement).currentSrc || skin.frame.src })} />
      {/* The knob of the dial, cut from the same picture, turns with the view. */}
      <div
        class="tv-knob"
        aria-hidden="true"
        style={{
          ...knob,
          backgroundImage: frameSrc ? `url(${frameSrc})` : 'none',
          backgroundSize: `${(1 / (p.knob.rx * 2)) * 100}% ${(1 / (p.knob.ry * 2)) * 100}%`,
          backgroundPosition: `${((p.knob.cx - p.knob.rx) / (1 - p.knob.rx * 2)) * 100}% ${((p.knob.cy - p.knob.ry) / (1 - p.knob.ry * 2)) * 100}%`,
          transform: `rotate(${angle}deg)`,
        }}
      />

      <button
        class="tv-zone tv-power"
        style={boxStyle(p.power)}
        aria-pressed={companion.heading}
        aria-label={`Power: the TV is ${companion.power.toLowerCase().replace('_', ' ')}. Switches the companion screen only, never a device, a scan or a recording.`}
        title="POWER: the companion screen only"
        onPointerDown={stop}
        onClick={power}
      />
      <button
        class="tv-zone tv-dial"
        style={ellipseStyle(p.dial)}
        aria-label={`Dial: ${DIAL_LABEL[companion.dial]}. Changes the view only. Arrow keys turn it.`}
        title={`DIAL: ${DIAL_LABEL[companion.dial]} (view only)`}
        onPointerDown={stop}
        onClick={() => companion.turnDial(1)}
        onKeyDown={dialKey}
        onWheel={(e) => {
          e.preventDefault();
          companion.turnDial(e.deltaY > 0 ? 1 : -1);
        }}
      />
      {onHandleDown && (
        <div class="tv-zone tv-handle" style={boxStyle(p.handle)} title={handleLabel ?? 'Drag the handle to move the TV'} aria-hidden="true" onPointerDown={(e) => onHandleDown(e as unknown as PointerEvent)} />
      )}
      {dev && (
        <svg class="tv-devmap" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <path d={screenPath(p)} />
          {[p.power, p.handle, p.speaker, p.logo].map((b, i) => (
            <rect key={i} x={b.x * 1000} y={b.y * 1000} width={b.w * 1000} height={b.h * 1000} />
          ))}
          <ellipse cx={p.dial.cx * 1000} cy={p.dial.cy * 1000} rx={p.dial.rx * 1000} ry={p.dial.ry * 1000} />
          <ellipse cx={p.knob.cx * 1000} cy={p.knob.cy * 1000} rx={p.knob.rx * 1000} ry={p.knob.ry * 1000} />
        </svg>
      )}
      <div class="sr-only" aria-live="polite">
        {`TV ${companion.power}. Hardware ${companion.hardware}. Operation ${companion.op}.`}
        {msg ? ` ${msg.text}${msg.code ? ` Code ${msg.code}.` : ''}` : ''}
      </div>
    </div>
  );
}
