/**
 * HARDWARE DOG / A MODAL THAT BEHAVES AS ONE
 *
 * While a dialog is open: focus is inside it (its own first focus, or the
 * first control), Tab and Shift+Tab cycle inside it, and the rest of the
 * page is inert (no pointer, no keyboard, hidden from screen readers).
 * When it closes, focus goes back to what had it before.
 */

import { useEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const focusables = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]'));

/** `open`: for a dialog its component renders only some of the time. */
export function useModal(dialog: { current: HTMLElement | null }, open = true): void {
  // What had focus before the dialog: read while rendering, before any effect
  // of the dialog (an input focusing itself) moves it.
  const opener = useRef<HTMLElement | null>(null);
  if (!open || opener.current === null) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  useEffect(() => {
    const host = dialog.current;
    if (!open || !host) return;
    // Everything beside the dialog's branch, up to the body, is put out of reach.
    const made: Element[] = [];
    for (let n: Element = host; n.parentElement && n !== document.body; n = n.parentElement)
      for (const sibling of n.parentElement.children)
        if (sibling !== n && !sibling.hasAttribute('inert') && sibling.tagName !== 'SCRIPT') {
          sibling.setAttribute('inert', '');
          made.push(sibling);
        }
    if (!host.contains(document.activeElement)) {
      const first = focusables(host)[0];
      if (first) first.focus();
      else {
        if (!host.hasAttribute('tabindex')) host.setAttribute('tabindex', '-1');
        host.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables(host);
      const active = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (active === first || !host.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !host.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      for (const el of made) el.removeAttribute('inert');
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected && back !== document.body) back.focus();
    };
  }, [open]);
}
