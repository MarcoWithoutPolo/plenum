import { useEffect, useRef, type RefObject } from 'react';

/**
 * Every dialog, drawer and popover registers here while it's open. Escape and outside clicks go
 * to the top layer only, so Escape in a picker inside a dialog closes the picker and leaves the
 * dialog (and its edits) alone. A field that uses Escape itself calls `preventDefault()` in its
 * own keydown handler, and then nothing closes.
 */
interface Layer {
  /** Elements that count as inside: the panel, and the trigger that opened it. */
  inside: () => (HTMLElement | null)[];
  close: () => void;
  /** Tab stays inside it (dialogs and drawers). */
  modal: boolean;
}

const stack: Layer[] = [];
let listening = false;

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';

function onKey(e: KeyboardEvent) {
  const top = stack.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;
    e.preventDefault();
    top.close();
  } else if (e.key === 'Tab' && top.modal) {
    const panel = top.inside()[0];
    if (!panel) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!;
    const last = items.at(-1)!;
    const at = document.activeElement;
    if (!panel.contains(at)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && at === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function onDown(e: MouseEvent) {
  const top = stack.at(-1);
  if (!top || top.modal) return;
  const target = e.target as Node;
  if (top.inside().some((el) => el?.contains(target))) return;
  top.close();
}

function listen() {
  if (listening) return;
  listening = true;
  // Bubble phase: a field's own handler runs first and can keep the key.
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousedown', onDown, true);
}

/** Whether a layer is open above `panel` (so its own handlers should stay quiet). */
export function isTopLayer(panel: HTMLElement | null): boolean {
  return stack.at(-1)?.inside()[0] === panel;
}

/**
 * Register a layer while `open`. `close` may change on every render; the latest one is used.
 * Modal layers (dialogs, drawers) trap Tab and ignore outside clicks; popovers close on them.
 */
export function useLayer(
  open: boolean,
  close: () => void,
  refs: RefObject<HTMLElement | null>[],
  modal = false,
): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    listen();
    const layer: Layer = {
      inside: () => refs.map((r) => r.current),
      close: () => latest.current(),
      modal,
    };
    stack.push(layer);
    return () => {
      const at = stack.indexOf(layer);
      if (at >= 0) stack.splice(at, 1);
    };
    // refs are stable objects; only opening and closing matter.
  }, [open, modal]);
}
