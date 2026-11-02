import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, flip, hide, offset, shift, size, useFloating } from '@floating-ui/react-dom';
import { useLayer } from '@/lib/layers';

const GAP = 6;
/** Distance kept from the window's edges. */
const MARGIN = 8;
/** Below this much room on both sides, a dropdown can't show four rows: it opens as a sheet. */
const MIN_ROOM = 220;

export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  open: boolean;
  toggle: () => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'dialog';
  'aria-controls': string;
}

/**
 * Anchored floating panel used by every picker and menu in the app. It's drawn at the top of the
 * page (a portal), so no dialog or scroll area can cut it off. It opens toward the side with
 * more room, slides sideways to stay inside the window, shrinks to the space there is and
 * scrolls inside itself; with too little room either side it opens as a centered sheet. It
 * follows its trigger when the page scrolls and closes once the trigger scrolls out of view.
 * Escape and outside clicks close it (only it, when it's inside a dialog); focus returns to the
 * trigger.
 */
export function Popover({
  trigger,
  children,
  label,
  align = 'left',
  width = 340,
  open: controlled,
  onOpenChange,
}: {
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  label: string;
  align?: 'left' | 'right';
  width?: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setOwn(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState(false);
  const [room, setRoom] = useState({ width, height: 560 });

  const { refs, floatingStyles, middlewareData } = useFloating({
    open,
    strategy: 'fixed',
    placement: align === 'right' ? 'bottom-end' : 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP),
      flip({ padding: MARGIN, fallbackAxisSideDirection: 'none' }),
      shift({ padding: MARGIN }),
      size({
        padding: MARGIN,
        apply({ availableWidth, availableHeight }) {
          const next = {
            width: Math.min(width, Math.floor(availableWidth)),
            height: Math.min(560, Math.floor(availableHeight)),
          };
          setRoom((r) => (r.width === next.width && r.height === next.height ? r : next));
        },
      }),
      hide({ strategy: 'referenceHidden' }),
    ],
  });

  // Too little room above and below for four rows: a centered sheet instead of a dropdown.
  useEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    setSheet(Math.max(above, below) < MIN_ROOM);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, [setOpen]);
  useLayer(open, close, [panel, button]);

  // The trigger scrolled out of view: a menu left floating over other content closes.
  const hidden = middlewareData.hide?.referenceHidden === true;
  useEffect(() => {
    if (open && hidden && !sheet) setOpen(false);
  }, [open, hidden, sheet, setOpen]);

  // Move focus into the panel so arrow keys and Tab work from the start: the selected row if
  // there is one, else the first field or button.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>(
        '[autofocus], [aria-selected="true"], [aria-checked="true"], [aria-current="true"], input, button',
      );
      first?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const setReference = useCallback(
    (el: HTMLButtonElement | null) => {
      button.current = el;
      refs.setReference(el);
    },
    [refs],
  );
  const setFloating = useCallback(
    (el: HTMLDivElement | null) => {
      panel.current = el;
      refs.setFloating(el);
    },
    [refs],
  );

  const body = typeof children === 'function' ? children(close) : children;
  return (
    <div className="no-drag relative">
      {trigger({
        ref: setReference,
        open,
        toggle: () => setOpen(!open),
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-controls': id,
      })}
      {open &&
        createPortal(
          sheet ? (
            <div className="fade-in fixed inset-0 z-[70] grid place-items-center bg-black/20 p-4 dark:bg-black/40">
              <div
                ref={setFloating}
                id={id}
                role="dialog"
                aria-label={label}
                style={{ width: Math.min(width, window.innerWidth - 2 * MARGIN) }}
                className="pop-in flex max-h-[calc(100vh-16px)] flex-col overflow-y-auto overscroll-contain rounded-2xl border border-line bg-elev text-left font-normal text-ink shadow-[0_12px_40px_-8px_rgb(0_0_0/0.25)]"
              >
                {body}
              </div>
            </div>
          ) : (
            <div
              ref={setFloating}
              id={id}
              role="dialog"
              aria-label={label}
              data-popover
              style={{ ...floatingStyles, width: room.width, maxHeight: room.height }}
              className="pop-in z-[70] flex flex-col overflow-y-auto overscroll-contain rounded-2xl border border-line bg-elev text-left font-normal text-ink shadow-[0_12px_40px_-8px_rgb(0_0_0/0.25),0_2px_6px_rgb(0_0_0/0.06)]"
            >
              {body}
            </div>
          ),
          document.body,
        )}
    </div>
  );
}

/** Up/Down move between the options of a list, like a native menu; Home and End jump. */
export function onListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-option]')];
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'Home'
      ? items[0]
      : e.key === 'End'
        ? items.at(-1)
        : items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
