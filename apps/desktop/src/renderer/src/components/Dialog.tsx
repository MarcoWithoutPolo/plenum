import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Modal dialog: dims the app, traps Tab inside, closes on Escape or the
 * close button, and returns focus to whatever opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 640,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>(
        '[autofocus], input, textarea, button',
      );
      first?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && panel.current) {
        const items = [
          ...panel.current.querySelectorAll<HTMLElement>(
            'button, input, textarea, select, [tabindex="0"]',
          ),
        ].filter((el) => !el.hasAttribute('disabled'));
        const first = items[0];
        const last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fade-in fixed inset-0 z-[60] grid place-items-center bg-black/35 p-6 backdrop-blur-[2px] dark:bg-black/55">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description && { 'aria-describedby': descId })}
        style={{ maxWidth: width }}
        className="pop-in flex max-h-[min(88vh,820px)] w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_24px_80px_-12px_rgb(0_0_0/0.35)]"
      >
        <header className="flex items-start gap-3 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[13px] text-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1.5 grid size-8 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-line bg-sunken/50 px-6 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
