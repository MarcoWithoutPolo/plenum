import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useLayer } from '@/lib/layers';

/** Where focus goes when a dialog opens: a field marked autofocus, the first field, a button. */
const FIRST_FIELD = '[autofocus], input:not([type="hidden"]), textarea, select';

/**
 * Modal dialog: dims the app, traps Tab inside, closes on Escape (when nothing above it is open)
 * or the close button, and returns focus to whatever opened it. Focus moves only when it opens,
 * never on a re-render, so typing is never interrupted however often the content updates.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 640,
  side = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** A drawer on the right instead of a centered dialog (the task drawer). */
  side?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useLayer(open, onClose, [panel], true);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const root = panel.current;
      if (!root || root.contains(document.activeElement)) return;
      const field = root.querySelector<HTMLElement>(FIRST_FIELD);
      // No field: the footer's main action (its last button), else the panel itself.
      const action = root.querySelector<HTMLElement>('footer button:last-of-type');
      (field ?? action ?? root).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      opener?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  const close = (
    <button
      type="button"
      aria-label="Close"
      onClick={onClose}
      className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
    >
      <X className="size-4" />
    </button>
  );
  const header = (
    <header className="flex items-start gap-3 border-b border-line px-6 pt-5 pb-4">
      <div className="min-w-0 flex-1">
        <h2
          id={titleId}
          className="text-[17px] font-semibold tracking-tight [overflow-wrap:anywhere]"
        >
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-1 text-[13px] text-muted">
            {description}
          </p>
        )}
      </div>
      {close}
    </header>
  );
  const foot = footer && (
    <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-sunken/50 px-6 py-3.5">
      {footer}
    </footer>
  );
  const aria = {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    ...(description && { 'aria-describedby': descId }),
    tabIndex: -1,
  } as const;

  if (side)
    return (
      <div className="fixed inset-0 z-[60] flex justify-end">
        <button
          type="button"
          aria-label="Close"
          tabIndex={-1}
          onClick={onClose}
          className="fade-in flex-1 cursor-default bg-black/10 dark:bg-black/30"
        />
        <div
          ref={panel}
          {...aria}
          style={{ width: `min(${width}px, 92vw)` }}
          className="slide-in flex h-full flex-col border-l border-line bg-panel shadow-[-24px_0_60px_-24px_rgb(0_0_0/0.25)] outline-none"
        >
          {header}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {foot}
        </div>
      </div>
    );

  return (
    <div className="fade-in fixed inset-0 z-[60] grid place-items-center bg-black/35 p-4 backdrop-blur-[2px] sm:p-6 dark:bg-black/55">
      <div
        ref={panel}
        {...aria}
        style={{ maxWidth: width }}
        className="pop-in flex max-h-[min(88vh,820px)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_80px_-12px_rgb(0_0_0/0.35)] outline-none"
      >
        {header}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {foot}
      </div>
    </div>
  );
}
