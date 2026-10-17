import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Square } from 'lucide-react';

export function Composer({
  onSend,
  onStop,
  running,
  disabled,
  placeholder,
  toolbar,
  autoFocus = true,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  running: boolean;
  disabled?: boolean;
  placeholder: string;
  toolbar?: ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus && !running) ref.current?.focus();
  }, [autoFocus, running]);

  const submit = () => {
    const value = text.trim();
    if (!value || running || disabled) return;
    onSend(value);
    setText('');
  };

  return (
    <div className="rounded-2xl border border-line-strong bg-panel shadow-card focus-within:border-accent/60">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-relaxed outline-none focus-visible:outline-none placeholder:text-faint disabled:opacity-60"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{toolbar}</div>
        <span className="hidden text-[11.5px] text-faint sm:inline">
          Shift+Enter for a new line
        </span>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="grid size-8 place-items-center rounded-full bg-ink text-bg hover:opacity-85"
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || disabled}
            aria-label="Send"
            title="Send (Enter)"
            className="grid size-8 place-items-center rounded-full bg-accent text-white transition hover:brightness-110 disabled:opacity-35"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
