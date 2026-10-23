/**
 * HARDWARE DOG / CAMERA SNIFFER / POSTERS
 *
 * The owner's five posters ("sniff the sniffer"), one at a time: arrows,
 * keys and a finger swipe go back and forth; a click opens the poster full
 * screen, where a second click shows it at full width to read the small
 * print. Only the poster on screen is loaded (and the next one, quietly).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import p1s from '../../../../assets/illustrations/web/camera-sniffer-01-power-connections-1200.webp';
import p1l from '../../../../assets/illustrations/web/camera-sniffer-01-power-connections-2400.webp';
import p2s from '../../../../assets/illustrations/web/camera-sniffer-02-clocks-media-1200.webp';
import p2l from '../../../../assets/illustrations/web/camera-sniffer-02-clocks-media-2400.webp';
import p3s from '../../../../assets/illustrations/web/camera-sniffer-03-everyday-objects-1200.webp';
import p3l from '../../../../assets/illustrations/web/camera-sniffer-03-everyday-objects-2400.webp';
import p4s from '../../../../assets/illustrations/web/camera-sniffer-04-room-outdoor-1200.webp';
import p4l from '../../../../assets/illustrations/web/camera-sniffer-04-room-outdoor-2400.webp';
import p5s from '../../../../assets/illustrations/web/camera-sniffer-05-personal-portable-1200.webp';
import p5l from '../../../../assets/illustrations/web/camera-sniffer-05-personal-portable-2400.webp';
import { useModal } from '../useModal';

export interface Poster {
  title: string;
  /** The objects numbered on it. */
  range: [number, number];
  small: string;
  large: string;
}

export const POSTERS: Poster[] = [
  { title: 'Power & connections', range: [1, 16], small: p1s, large: p1l },
  { title: 'Clocks & media', range: [17, 32], small: p2s, large: p2l },
  { title: 'Everyday objects', range: [33, 48], small: p3s, large: p3l },
  { title: 'Room & outdoor', range: [49, 64], small: p4s, large: p4l },
  { title: 'Personal & portable', range: [65, 80], small: p5s, large: p5l },
];

const pad = (n: number) => String(n).padStart(2, '0');
const alt = (p: Poster, i: number) => `Camera Sniffer poster ${i + 1} of ${POSTERS.length}, ${p.title}: hidden-camera products ${pad(p.range[0])} to ${pad(p.range[1])}, each with its seller, description and reference`;

/** The next index, wrapping around. */
export const step = (i: number, by: number, n = POSTERS.length) => (((i + by) % n) + n) % n;

export function PosterSlider() {
  const [i, setI] = useState(0);
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(false);
  const overlay = useRef<HTMLDivElement>(null);
  useModal(overlay, full);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const p = POSTERS[i]!;
  const go = (by: number) => {
    setI((x) => step(x, by));
    setZoom(false);
  };

  // the next poster, fetched quietly so that NEXT shows it at once
  useEffect(() => {
    const n = POSTERS[step(i, 1)]!;
    const img = new Image();
    img.src = full ? n.large : n.small;
  }, [i, full]);

  // full screen: keys, the page held still, the browser's own full screen where it has one
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    // leaving the browser's full screen (its own Escape, a gesture) closes the view too
    const onChange = () => !document.fullscreenElement && setFull(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = overlay.current;
    // iPhone Safari has no element full screen: the fixed overlay covers the page instead
    if (el?.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    el?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      document.body.style.overflow = overflow;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [full]);

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (!s || !t || zoom) return;
    const dx = t.clientX - s.x;
    // a clear sideways swipe only: a scroll or a tap stays what it is
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(t.clientY - s.y)) go(dx < 0 ? 1 : -1);
  };

  const caption = (
    <span>
      SHEET {pad(i + 1)} / {pad(POSTERS.length)} · {p.title.toUpperCase()} · objects {pad(p.range[0])}–{pad(p.range[1])}
    </span>
  );

  return (
    <div class="poster-slider">
      <div class="poster-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <button class="poster-arrow prev" onClick={() => go(-1)} aria-label="Previous poster">
          ‹
        </button>
        <button class="poster-open" onClick={() => setFull(true)} aria-label={`Open full screen: ${alt(p, i)}`}>
          <img src={p.small} srcset={`${p.small} 1200w, ${p.large} 2400w`} sizes="(max-width: 700px) 92vw, 520px" width={1200} height={1770} alt={alt(p, i)} decoding="async" />
        </button>
        <button class="poster-arrow next" onClick={() => go(1)} aria-label="Next poster">
          ›
        </button>
      </div>
      <div class="poster-bar">
        <button class="btn small" onClick={() => go(-1)}>
          ‹ BACK
        </button>
        <p class="poster-caption" aria-live="polite">
          {caption}
        </p>
        <button class="btn small" onClick={() => go(1)}>
          NEXT ›
        </button>
      </div>
      <div class="poster-dots" role="group" aria-label="Posters">
        {POSTERS.map((x, k) => (
          <button key={x.title} class={k === i ? 'on' : ''} aria-current={k === i ? 'true' : undefined} aria-label={`Poster ${k + 1}: ${x.title}`} onClick={() => (setI(k), setZoom(false))} />
        ))}
      </div>
      {full && (
        <div ref={overlay} class={`poster-full${zoom ? ' zoom' : ''}`} role="dialog" aria-modal="true" aria-label={alt(p, i)} tabIndex={-1} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div class="poster-full-scroll">
            <img src={p.large} alt={alt(p, i)} onClick={() => setZoom((z) => !z)} title={zoom ? 'Fit to the screen' : 'Full width, to read the small print'} decoding="async" />
          </div>
          <button class="poster-arrow prev" onClick={() => go(-1)} aria-label="Previous poster">
            ‹
          </button>
          <button class="poster-arrow next" onClick={() => go(1)} aria-label="Next poster">
            ›
          </button>
          <div class="poster-full-bar">
            <p class="poster-caption">{caption}</p>
            <button class="btn small" onClick={() => setZoom((z) => !z)}>
              {zoom ? 'FIT' : 'ZOOM'}
            </button>
            <button class="btn small" onClick={() => setFull(false)} aria-label="Close full screen">
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
