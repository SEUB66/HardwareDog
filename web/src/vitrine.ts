/**
 * HARDWARE DOG / THE HOME PAGE (web/index.html)
 *
 * The page is whole without this script: the Companion TV changes channel
 * with radio buttons and CSS (:has), every text is in the HTML. This adds,
 * after the first paint:
 *   LANGUAGE   English for a browser that does not ask for French: the
 *              English sits next to the French (data-en, data-en-alt,
 *              data-en-label)
 *   TV         its dial (next channel) and its power button, the static
 *              between two channels, and a showroom loop that turns the
 *              channels until someone touches the TV
 *   DEPTH      the banner moves under a mouse, deeper than its frame
 * Nothing is stored, nothing is sent.
 */
import './styles/vitrine.css';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const language = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
if (language === 'en') {
  document.documentElement.lang = 'en';
  for (const el of document.querySelectorAll<HTMLElement>('[data-en]')) el.textContent = el.dataset.en!;
  for (const el of document.querySelectorAll<HTMLElement>('[data-en-alt]')) el.setAttribute('alt', el.dataset.enAlt!);
  for (const el of document.querySelectorAll<HTMLElement>('[data-en-label]')) el.setAttribute('aria-label', el.dataset.enLabel!);
  document.querySelector('meta[name="description"]')?.setAttribute('content', 'Local-first hardware diagnostic tool in your browser: hidden camera clues without a cloud app, a Bluetooth LE scanner, Flipper Zero over Web Serial. No account. No tracking.');
}

const showroom = document.getElementById('showroom');
if (showroom) companionTv(showroom);

const diorama = document.getElementById('diorama');
if (diorama && !reduced && matchMedia('(hover: hover) and (pointer: fine)').matches) depth(diorama);

/** The TV's physical controls. The channel itself is the checked radio: CSS shows it. */
function companionTv(root: HTMLElement) {
  const tv = root.querySelector<HTMLElement>('.tv')!;
  const dial = tv.querySelector<HTMLButtonElement>('.tv-dial')!;
  const power = tv.querySelector<HTMLButtonElement>('.tv-power')!;
  const channels = [...root.querySelectorAll<HTMLInputElement>('input[name="ch"]')];
  dial.hidden = power.hidden = false;
  root.querySelector<HTMLElement>('.tv-hint')!.hidden = false;

  let on = true;
  const static_ = () => {
    tv.classList.remove('tuning');
    void tv.offsetWidth; // restart the animation on a quick second change
    tv.classList.add('tuning');
  };
  const setPower = (next: boolean) => {
    if (next === on) return;
    on = next;
    tv.classList.toggle('is-off', !on);
    tv.classList.toggle('powering', on);
    power.setAttribute('aria-pressed', String(on));
  };
  tv.addEventListener('animationend', (event) => {
    if (event.animationName === 'tv-static') tv.classList.remove('tuning');
    if (event.animationName === 'crt-on') tv.classList.remove('powering');
  });
  const tune = (step: number) => {
    const at = channels.findIndex((c) => c.checked);
    channels[(at + step + channels.length) % channels.length]!.checked = true;
    static_();
  };

  // A channel chosen by hand turns the screen back on.
  root.addEventListener('change', () => {
    setPower(true);
    static_();
  });
  dial.addEventListener('click', () => {
    setPower(true);
    tune(1);
  });
  power.addEventListener('click', () => setPower(!on));

  // SHOWROOM: the channels turn by themselves while the TV is on screen,
  // until the first touch, click, key or focus inside it. Never with reduced motion.
  if (reduced || !('IntersectionObserver' in window)) return;
  let timer = 0;
  let visible = false;
  let touched = false;
  const run = () => {
    clearInterval(timer);
    timer = !touched && visible && on && !document.hidden ? window.setInterval(() => tune(1), 4200) : 0;
  };
  const stop = () => {
    touched = true;
    run();
  };
  for (const type of ['pointerdown', 'keydown', 'focusin'] as const) root.addEventListener(type, stop, { passive: true });
  document.addEventListener('visibilitychange', run);
  new IntersectionObserver(([entry]) => {
    visible = entry!.isIntersecting;
    run();
  }, { threshold: 0.4 }).observe(tv);
}

/** The banner sits deeper than its plate: under the pointer, the picture moves more than the frame. */
function depth(plate: HTMLElement) {
  let box = plate.getBoundingClientRect();
  let frame = 0;
  let x = 0;
  let y = 0;
  const paint = () => {
    frame = 0;
    plate.style.setProperty('--px', x.toFixed(3));
    plate.style.setProperty('--py', y.toFixed(3));
  };
  plate.addEventListener('pointerenter', () => (box = plate.getBoundingClientRect()));
  plate.addEventListener('pointermove', (event) => {
    x = Math.max(-0.5, Math.min(0.5, (event.clientX - box.left) / box.width - 0.5));
    y = Math.max(-0.5, Math.min(0.5, (event.clientY - box.top) / box.height - 0.5));
    frame ||= requestAnimationFrame(paint);
  });
  plate.addEventListener('pointerleave', () => {
    x = y = 0;
    frame ||= requestAnimationFrame(paint);
  });
}
