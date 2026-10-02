/*
 * One info bubble for the whole interface.
 *
 * Any element with data-tip shows it: on mouse hover (after a short delay),
 * on keyboard focus, and on tap (touch screens have no hover). A single
 * bubble, positioned in the viewport, so it is never clipped by a panel and
 * never runs off a phone screen. Screen readers get the same text through
 * aria-describedby on the element (see Hint), not through this bubble.
 */
const DELAY_MS = 350;
const MARGIN = 8;

let bubble: HTMLDivElement | null = null;
let current: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Until then, the next label shows at once: the user is reading along. */
let warmUntil = 0;

const tipOf = (t: EventTarget | null): HTMLElement | null => (t instanceof Element ? t.closest<HTMLElement>('[data-tip]') : null);

function show(el: HTMLElement): void {
  clearTimeout(timer);
  const text = el.dataset.tip;
  if (!text) return;
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'tip';
    bubble.setAttribute('aria-hidden', 'true');
    document.body.append(bubble);
  }
  current = el;
  const term = el.dataset.tipTerm ?? '';
  bubble.replaceChildren();
  if (term) {
    const head = document.createElement('div');
    head.className = 'tip-term';
    head.textContent = term;
    bubble.append(head);
  }
  bubble.append(text);
  bubble.style.display = 'block';
  // Below the element, inside the viewport; above it when there is no room.
  const r = el.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - b.width - MARGIN));
  let top = r.bottom + 6;
  if (top + b.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, r.top - b.height - 6);
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

export function hideTip(): void {
  clearTimeout(timer);
  if (current) warmUntil = Date.now() + 600;
  current = null;
  if (bubble) bubble.style.display = 'none';
}

/** Install once. Returns the uninstall function. */
export function installTips(root: Document = document): () => void {
  const over = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const el = tipOf(e.target);
    if (!el || el === current) return;
    clearTimeout(timer);
    // Moving from one label to the next: no delay, the user is reading.
    if (current || Date.now() < warmUntil) show(el);
    else timer = setTimeout(() => show(el), DELAY_MS);
  };
  const out = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const from = tipOf(e.target);
    if (from && from.contains(e.relatedTarget as Node | null)) return;
    if (from && root.activeElement === from) return;
    clearTimeout(timer);
    if (from === current) hideTip();
  };
  const down = (e: PointerEvent) => {
    const el = tipOf(e.target);
    if (e.pointerType === 'mouse') {
      if (!el) hideTip();
      return;
    }
    // Touch and pen: a tap opens, a second tap on the same label closes.
    if (el && el !== current) show(el);
    else hideTip();
  };
  const focusIn = (e: FocusEvent) => {
    const el = tipOf(e.target);
    if (el && el === e.target) show(el);
  };
  const focusOut = (e: FocusEvent) => {
    if (current && e.target === current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hideTip();
  };
  const key = (e: KeyboardEvent) => {
    // Escape closes the bubble first, and only the bubble (not the screen).
    if (e.key === 'Escape' && current) {
      hideTip();
      e.stopPropagation();
    }
  };
  const away = () => current && hideTip();

  root.addEventListener('pointerover', over);
  root.addEventListener('pointerout', out);
  root.addEventListener('pointerdown', down);
  root.addEventListener('focusin', focusIn);
  root.addEventListener('focusout', focusOut);
  root.addEventListener('keydown', key);
  window.addEventListener('scroll', away, true);
  window.addEventListener('resize', away);
  return () => {
    hideTip();
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerout', out);
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('focusin', focusIn);
    root.removeEventListener('focusout', focusOut);
    root.removeEventListener('keydown', key);
    window.removeEventListener('scroll', away, true);
    window.removeEventListener('resize', away);
  };
}
