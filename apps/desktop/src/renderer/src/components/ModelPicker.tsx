import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plug } from 'lucide-react';
import type { Seat } from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import { providerName, useApp } from '@/lib/store';
import { ProviderDot } from './bits';

/** Who answers the next message: provider plus model (or the CLI's default). */
export function ModelPicker({
  value,
  onChange,
  align = 'left',
  compact = false,
}: {
  value: Seat;
  onChange: (seat: Seat) => void;
  align?: 'left' | 'right';
  compact?: boolean;
}) {
  const providers = useApp((s) => s.providers);
  const open = useApp((s) => s.open);
  const [show, setShow] = useState(false);
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!show) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      ) {
        setShow(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [show]);

  const pick = (seat: Seat) => {
    onChange(seat);
    setShow(false);
    setCustom('');
  };

  return (
    <div ref={ref} className="relative no-drag">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={show}
        aria-label="Choose model"
        onClick={() => setShow((v) => !v)}
        className={`inline-flex items-center gap-2 rounded-lg border border-line-strong bg-panel font-medium hover:bg-sunken ${
          compact ? 'h-7 px-2 text-[12.5px]' : 'h-8.5 px-3 text-[13px]'
        }`}
      >
        <ProviderDot provider={value.provider} />
        <span>{providerName(value.provider)}</span>
        <span className="text-muted">{value.model ?? 'default'}</span>
        <ChevronDown className="size-3.5 text-faint" />
      </button>

      {show && (
        <div
          role="menu"
          className={`absolute top-full z-40 mt-1.5 w-72 rounded-xl border border-line bg-elev p-1.5 shadow-card ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {providers.map((p) => (
            <ProviderSection
              key={p.provider}
              info={p}
              value={value}
              onPick={pick}
              custom={value.provider === p.provider ? custom : ''}
              setCustom={setCustom}
              onConnect={() => {
                setShow(false);
                open({ name: 'accounts' });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderSection({
  info,
  value,
  onPick,
  custom,
  setCustom,
  onConnect,
}: {
  info: ProviderInfo;
  value: Seat;
  onPick: (seat: Seat) => void;
  custom: string;
  setCustom: (v: string) => void;
  onConnect: () => void;
}) {
  const ready = info.auth === 'signed_in';
  const options: (string | undefined)[] = [undefined, ...info.models];
  return (
    <div className="border-b border-line px-1 py-1.5 last:border-0">
      <div className="flex items-center gap-2 px-2 pb-1 text-[12px] font-semibold text-muted">
        <ProviderDot provider={info.provider} />
        {info.displayName}
        {!ready && (
          <button
            type="button"
            onClick={onConnect}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-accent-ink hover:bg-accent-soft"
          >
            <Plug className="size-3" /> Connect
          </button>
        )}
      </div>
      {ready && (
        <>
          {options.map((model) => {
            const selected = value.provider === info.provider && value.model === model;
            return (
              <button
                key={model ?? 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => onPick({ provider: info.provider, ...(model && { model }) })}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-sunken"
              >
                <span className="flex-1">
                  {model ?? 'Default'}
                  {!model && <span className="ml-1.5 text-[12px] text-faint">CLI setting</span>}
                </span>
                {selected && <Check className="size-3.5 text-accent" />}
              </button>
            );
          })}
          <form
            className="px-1 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              const model = custom.trim();
              if (/^[\w.:/[\]-]+$/.test(model)) onPick({ provider: info.provider, model });
            }}
          >
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Other model id, then Enter"
              aria-label={`Custom ${info.displayName} model`}
              className="h-7 w-full rounded-md border border-line bg-panel px-2 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
            />
          </form>
        </>
      )}
    </div>
  );
}
