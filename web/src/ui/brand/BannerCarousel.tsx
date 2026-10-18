/**
 * HARDWARE DOG / BANNER CAROUSEL
 *
 * One component for the home banners and Camera Sniffer's. The picture is
 * always whole (its own 2.5:1 box, reserved before it loads); its caption
 * is HTML under it, readable on a phone where the lettering in the picture
 * is small. Previous, next, one button per slide, pause and play: real
 * buttons. It turns by itself every 8 s (core/carousel.ts); a slide chosen
 * by hand gets its full 8 s, then the turning carries on; keyboard focus,
 * a hidden tab, the carousel off screen or a running scan hold it; pause
 * stops it; reduced motion never turns it. A hidden slide is inert, so the
 * keyboard and screen readers only meet the one shown, and the turns are
 * not announced (only while paused is a slide chosen by hand announced).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { carousel, go, hold, next, pause, play, prev, ROTATE_MS, swipe, turns, type CarouselState, type HoldReason } from '../../core/carousel';
import type { Lang } from '../../core/lab/rules';
import { BANNER_H, BANNER_W, type BannerSlide } from './slides';

const WORDS: Record<Lang, { prev: string; next: string; pause: string; play: string; slide: (i: number, n: number, t: string) => string }> = {
  en: { prev: 'Previous banner', next: 'Next banner', pause: 'Pause the banners', play: 'Play the banners', slide: (i, n, t) => `Banner ${i} of ${n}: ${t}` },
  fr: { prev: 'Bannière précédente', next: 'Bannière suivante', pause: 'Mettre les bannières en pause', play: 'Reprendre les bannières', slide: (i, n, t) => `Bannière ${i} sur ${n} : ${t}` },
};

/** Keyboard focus holds the carousel; the focus a click or a tap leaves on a button does not. */
const focusVisible = (t: EventTarget | null) => {
  try {
    return t instanceof Element && t.matches(':focus-visible');
  } catch {
    return true;
  }
};

export interface BannerCarouselProps {
  slides: BannerSlide[];
  /** The carousel's accessible name. */
  label: string;
  lang: Lang;
  reducedMotion: boolean;
  /** A scan or an inspection running: the banners hold still. */
  busy?: boolean;
  /** The first picture of the page: loaded first, at high priority. */
  priority?: boolean;
  /** Sizes for srcset: how wide the picture is shown. */
  sizes?: string;
  class?: string;
}

export function BannerCarousel({ slides, label, lang, reducedMotion, busy = false, priority = false, sizes = '(max-width: 760px) 100vw, 1100px', class: extra }: BannerCarouselProps) {
  const [s, setS] = useState<CarouselState>(() => carousel(slides.length));
  // Pictures fetched so far: the one shown and the next; never all at once.
  const [fetched, setFetched] = useState<number[]>([0]);
  const root = useRef<HTMLElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const w = WORDS[lang];
  const update = (f: (x: CarouselState) => CarouselState) => setS((x) => f(x));
  const holdBy = (r: HoldReason, on: boolean) => update((x) => hold(x, r, on));

  useEffect(() => holdBy('busy', busy), [busy]);

  // tab hidden, carousel off screen: it holds still
  useEffect(() => {
    const vis = () => holdBy('hidden', document.hidden);
    vis();
    document.addEventListener('visibilitychange', vis);
    let io: IntersectionObserver | null = null;
    if (root.current && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver(([e]) => e && holdBy('offscreen', !e.isIntersecting), { threshold: 0.25 });
      io.observe(root.current);
    }
    return () => {
      document.removeEventListener('visibilitychange', vis);
      io?.disconnect();
    };
  }, []);

  const rotating = turns(s, reducedMotion);
  useEffect(() => {
    if (!rotating) return;
    const t = setTimeout(() => update((x) => next(x)), ROTATE_MS);
    return () => clearTimeout(t);
  }, [rotating, s.moves]);

  // the slide shown is fetched; the next one too, once the shown one is in
  useEffect(() => {
    setFetched((f) => (f.includes(s.index) ? f : [...f, s.index]));
  }, [s.index]);
  const warmNext = (i: number) => {
    if (i !== s.index) return;
    const n = (i + 1) % slides.length;
    setFetched((f) => (f.includes(n) ? f : [...f, n]));
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') update((x) => next(x));
    else if (e.key === 'ArrowLeft') update((x) => prev(x));
    else return;
    e.preventDefault();
  };
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const a = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (!a || !t) return;
    const dir = swipe(t.clientX - a.x, t.clientY - a.y);
    if (dir) update((x) => go(x, x.index + dir));
  };

  const current = slides[s.index]!;
  const showPlay = !reducedMotion && slides.length > 1;
  return (
    <section
      ref={root}
      class={`banner-carousel${reducedMotion ? ' still' : ''}${extra ? ` ${extra}` : ''}`}
      aria-roledescription="carousel"
      aria-label={label}
      onFocusIn={(e) => holdBy('focus', focusVisible(e.target))}
      onFocusOut={(e) => !root.current?.contains(e.relatedTarget as Node | null) && holdBy('focus', false)}
      onKeyDown={onKey}
    >
      <div class="bc-viewport" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {slides.map((slide, i) => {
          const shown = i === s.index;
          return (
            <figure
              key={slide.id}
              class={`bc-slide${shown ? ' shown' : ''}`}
              role="group"
              aria-roledescription="slide"
              aria-label={w.slide(i + 1, slides.length, slide.title)}
              aria-hidden={shown ? undefined : 'true'}
              {...(shown ? {} : { inert: true })}
            >
              {fetched.includes(i) && (
                <img
                  src={slide.src['1200']}
                  srcset={`${slide.src['800']} 800w, ${slide.src['1200']} 1200w, ${slide.src['1983']} 1983w`}
                  sizes={sizes}
                  width={BANNER_W}
                  height={BANNER_H}
                  alt={slide.alt}
                  decoding="async"
                  {...(i === 0 && priority ? { fetchpriority: 'high', loading: 'eager' } : { loading: 'lazy' })}
                  onLoad={() => warmNext(i)}
                />
              )}
            </figure>
          );
        })}
      </div>
      <div class="bc-bar">
        {/* Every caption takes the same cell: the bar is as tall as the longest, on every slide. */}
        <div class="bc-captions" aria-hidden="true">
          {slides.map((slide, i) => (
            <p key={slide.id} class={`bc-caption${i === s.index ? ' shown' : ''}`}>
              <span class="bc-count">
                {i + 1}/{slides.length}
              </span>{' '}
              {slide.caption[lang]}
            </p>
          ))}
        </div>
        {/* What a screen reader reads: the caption shown; announced only when chosen by hand. */}
        <p class="sr-only" aria-live={s.stopped ? 'polite' : 'off'}>
          {current.caption[lang]}
        </p>
        <div class="bc-controls">
          <button class="bc-btn" onClick={() => update((x) => prev(x))} aria-label={w.prev}>
            <span aria-hidden="true">‹</span>
          </button>
          <div class="bc-dots" role="group" aria-label={label}>
            {slides.map((slide, i) => (
              <button
                key={slide.id}
                class={`bc-dot${i === s.index ? ' on' : ''}`}
                aria-current={i === s.index ? 'true' : undefined}
                aria-label={w.slide(i + 1, slides.length, slide.title)}
                onClick={() => update((x) => go(x, i))}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </div>
          {showPlay && (
            <button class="bc-btn" onClick={() => update((x) => (x.stopped ? play(x) : pause(x)))} aria-label={s.stopped ? w.play : w.pause}>
              <span aria-hidden="true">{s.stopped ? '▶' : '❚❚'}</span>
            </button>
          )}
          <button class="bc-btn" onClick={() => update((x) => next(x))} aria-label={w.next}>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </section>
  );
}
