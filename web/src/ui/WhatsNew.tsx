/**
 * HARDWARE DOG / WHAT'S NEW SCREEN
 *
 * Shown every time the interface opens (after the intro): the newest
 * feature's banner, the companion TV switching on, and the recent
 * features, each one tap away. Closed with the button, Escape or a tap
 * outside; it never blocks the instrument.
 */

import { useEffect, useRef } from 'preact/hooks';
import cameraBanner800 from '../../../assets/brand/web/hd-camera-sniffer-banner-800.webp';
import cameraBanner1600 from '../../../assets/brand/web/hd-camera-sniffer-banner-1600.webp';
import type { Screen } from '../core/commands';
import { FEATURES } from '../core/features';
import type { Lab } from '../core/lab/context';
import { browserLang } from '../core/lab/rules';
import { RetroTv } from './lab/RetroTv';
import type { TvPlacement } from './lab/TvHost';

export function WhatsNew({ lab, placement, reducedMotion, onGo, onClose }: { lab: Lab; placement: TvPlacement; reducedMotion: boolean; onGo: (s: Screen) => void; onClose: () => void }) {
  const lang = browserLang();
  const close = useRef<HTMLButtonElement>(null);
  const [first, ...rest] = FEATURES;
  // The tap that skipped the boot screen must not land on this screen as a
  // click (a ghost click on a phone): taps count after a short moment.
  const opened = useRef(performance.now());
  const settled = () => performance.now() - opened.current > 450;
  const go = (s: Screen) => settled() && onGo(s);
  useEffect(() => {
    close.current?.focus();
    // The CRT comes on with the screen, as asked: a TV left off is switched on once here.
    if (!lab.companion.heading) lab.companion.setPower(true);
    // the TV is here for now: the page's own stays empty meanwhile (one TV visible)
    placement.hold(true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      placement.hold(false);
    };
  }, []);
  if (!first) return null;
  return (
    <div class="whatsnew-backdrop" onClick={(e) => e.target === e.currentTarget && settled() && onClose()}>
      <div class="whatsnew" role="dialog" aria-modal="true" aria-labelledby="whatsnew-title">
        <header class="whatsnew-head">
          <h2 id="whatsnew-title">{lang === 'fr' ? 'NOUVEAUTÉS' : 'WHAT’S NEW'}</h2>
          <button class="btn" ref={close} onClick={() => settled() && onClose()} aria-label={lang === 'fr' ? 'Fermer les nouveautés' : 'Close what’s new'}>
            ✕
          </button>
        </header>
        <button class="whatsnew-hero" onClick={() => go(first.screen)} aria-label={`${first.name}: ${first.pitch[lang]}`}>
          <img src={cameraBanner800} srcset={`${cameraBanner800} 800w, ${cameraBanner1600} 1600w`} sizes="(max-width: 700px) 100vw, 680px" width={800} height={320} alt="" decoding="async" />
          <span class="whatsnew-new">NEW</span>
        </button>
        <div class="whatsnew-body">
          <div class="whatsnew-tv">
            <RetroTv companion={lab.companion} registry={lab.registry} reducedMotion={reducedMotion} />
          </div>
          <div class="whatsnew-list">
            <p class="whatsnew-pitch">
              <b>{first.name}</b> {first.pitch[lang]}
            </p>
            <button class="btn primary" onClick={() => go(first.screen)}>
              {lang === 'fr' ? 'OUVRIR CAMERA SNIFFER' : 'OPEN CAMERA SNIFFER'}
            </button>
            <ul>
              {rest.map((f) => (
                <li key={f.id}>
                  <button class="whatsnew-item" onClick={() => go(f.screen)}>
                    <b>{f.name}</b>
                    <span>{f.pitch[lang]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
