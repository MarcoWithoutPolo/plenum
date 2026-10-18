import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

const GAP = 6;
const MARGIN = 12;

export interface PopoverTriggerProps {
  ref: RefObject<HTMLButtonElement | null>;
  open: boolean;
  toggle: () => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'dialog';
  'aria-controls': string;
}

/**
 * Anchored floating panel used by every picker in the app: opens toward the
 * side with more room, never leaves the window, scrolls inside itself, and
 * closes on Escape or a click outside. Focus returns to the trigger.
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
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ up: false, maxHeight: 420 });

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const measure = () => {
      const r = button.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const up = below < 360 && above > below;
      setPlace({ up, maxHeight: Math.max(180, Math.min(560, up ? above : below)) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    // Move focus into the panel so arrow keys and Tab work from the start.
    requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>(
        '[aria-checked="true"], button, input',
      );
      first?.focus({ preventScroll: true });
    });
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div ref={root} className="no-drag relative">
      {trigger({
        ref: button,
        open,
        toggle: () => setOpen(!open),
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-controls': id,
      })}
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          style={{ maxHeight: place.maxHeight, width }}
          className={`pop-in absolute z-50 flex flex-col overflow-hidden rounded-2xl border border-line bg-elev text-left font-normal text-ink shadow-[0_12px_40px_-8px_rgb(0_0_0/0.25),0_2px_6px_rgb(0_0_0/0.06)] ${
            place.up ? 'bottom-full mb-1.5 origin-bottom' : 'top-full mt-1.5 origin-top'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

/** Up/Down move between the options of a list, like a native menu. */
export function onListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-option]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}
