import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plug } from 'lucide-react';
import type { Seat } from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import { providerName, useApp } from '@/lib/store';
import { ProviderDot } from './bits';

const GAP = 6;
const MARGIN = 12;

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
  const [place, setPlace] = useState<{ up: boolean; maxHeight: number }>({
    up: false,
    maxHeight: 400,
  });
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // Open toward the side with more room and never past the window edge.
  useLayoutEffect(() => {
    if (!show || !button.current) return;
    const measure = () => {
      const r = button.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - GAP - MARGIN;
      const above = r.top - GAP - MARGIN;
      const up = below < 320 && above > below;
      setPlace({ up, maxHeight: Math.max(160, up ? above : below) });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [show]);

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
  };

  const current = providers.find((p) => p.provider === value.provider);
  const label = value.model ? modelLabel(current, value.model) : 'default';

  return (
    <div ref={ref} className="relative no-drag">
      <button
        ref={button}
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
        <span className="max-w-40 truncate text-muted">{label}</span>
        <ChevronDown className="size-3.5 text-faint" />
      </button>

      {show && (
        <div
          role="menu"
          style={{ maxHeight: place.maxHeight }}
          className={`absolute z-40 w-80 overflow-y-auto overscroll-contain rounded-xl border border-line bg-elev p-1.5 shadow-card ${
            place.up ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {providers.map((p) => (
            <ProviderSection
              key={p.provider}
              info={p}
              value={value}
              onPick={pick}
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

function modelLabel(info: ProviderInfo | undefined, id: string): string {
  return info?.models.find((m) => m.id === id)?.label ?? id;
}

function ProviderSection({
  info,
  value,
  onPick,
  onConnect,
}: {
  info: ProviderInfo;
  value: Seat;
  onPick: (seat: Seat) => void;
  onConnect: () => void;
}) {
  const [custom, setCustom] = useState('');
  const ready = info.auth === 'signed_in';
  const defaultNote = [
    info.defaultModel && modelLabel(info, info.defaultModel),
    info.defaultEffort && `${info.defaultEffort} effort`,
  ]
    .filter(Boolean)
    .join(' · ');
  const options: { id?: string; label: string; note?: string }[] = [
    { label: 'Default', note: defaultNote || 'CLI setting' },
    ...info.models.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      ...(m.label && m.label !== m.id && { note: m.id }),
    })),
  ];
  // Keep a custom model that isn't in the list visible and selectable.
  if (
    value.provider === info.provider &&
    value.model &&
    !info.models.some((m) => m.id === value.model)
  ) {
    options.push({ id: value.model, label: value.model, note: 'custom' });
  }

  return (
    <div className="border-b border-line px-1 py-1.5 last:border-0">
      <div className="sticky -top-1.5 z-10 -mx-1 flex items-center gap-2 bg-elev px-3 py-1 text-[12px] font-semibold text-muted">
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
          {options.map((o) => {
            const selected = value.provider === info.provider && value.model === o.id;
            return (
              <button
                key={o.id ?? 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => onPick({ provider: info.provider, ...(o.id && { model: o.id }) })}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-sunken"
              >
                <span className="min-w-0 flex-1 truncate">
                  {o.label}
                  {o.note && <span className="ml-1.5 text-[12px] text-faint">{o.note}</span>}
                </span>
                {selected && <Check className="size-3.5 shrink-0 text-accent" />}
              </button>
            );
          })}
          <form
            className="px-1 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              const model = custom.trim();
              if (/^[\w.:/[\]-]+$/.test(model)) {
                onPick({ provider: info.provider, model });
                setCustom('');
              }
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
