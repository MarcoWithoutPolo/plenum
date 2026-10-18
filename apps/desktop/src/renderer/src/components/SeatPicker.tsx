import { useState } from 'react';
import { Check, ChevronDown, Gauge, Plug, Plus } from 'lucide-react';
import type { ProviderId, Seat } from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import { providerName, useApp } from '@/lib/store';
import { ProviderDot } from './bits';
import { Popover, onListKeyDown, type PopoverTriggerProps } from './Popover';

/* ── Effort ───────────────────────────────────────────────────────────── */

const EFFORT_NOTES: Record<string, string> = {
  low: 'Fastest, and lightest on your plan',
  medium: 'Balanced speed and depth',
  high: 'Thinks longer before answering',
  xhigh: 'Thinks much longer',
  max: 'Deepest reasoning, slowest',
  ultra: 'Maximum reasoning; may split work into subtasks',
};

export function effortNote(level: string | undefined): string {
  return (level && EFFORT_NOTES[level]) || 'Uses the CLI setting';
}

/** Effort levels the seat's model accepts, plus what "Default" currently means. */
export function effortOptions(
  seat: Seat,
  providers: ProviderInfo[],
): { levels: string[]; defaultLevel?: string } {
  const info = providers.find((p) => p.provider === seat.provider);
  if (!info) return { levels: [] };
  const modelId = seat.model ?? info.defaultModel;
  const model = modelId ? info.models.find((m) => m.id === modelId) : undefined;
  const levels = model?.efforts?.length ? model.efforts : (info.efforts ?? []);
  // The CLI's configured effort applies to any model that supports it; otherwise the model's own default.
  const defaultLevel =
    info.defaultEffort && levels.includes(info.defaultEffort)
      ? info.defaultEffort
      : model?.defaultEffort;
  return { levels, ...(defaultLevel && { defaultLevel }) };
}

/** Drop an effort the newly picked model doesn't support. */
export function fitEffort(seat: Seat, providers: ProviderInfo[]): Seat {
  if (!seat.effort) return seat;
  if (effortOptions(seat, providers).levels.includes(seat.effort)) return seat;
  const { effort: _dropped, ...rest } = seat;
  return rest;
}

function withEffort(seat: Seat, effort: string | undefined): Seat {
  const { effort: _old, ...rest } = seat;
  return effort ? { ...rest, effort } : rest;
}

/* ── Labels ───────────────────────────────────────────────────────────── */

export function modelLabel(info: ProviderInfo | undefined, id: string | undefined): string {
  if (!id) return 'Default';
  const found = info?.models.find((m) => m.id === id)?.label;
  if (found) return found;
  // Claude's aliases read better capitalized: "opus" → "Opus".
  return /^[a-z]+$/.test(id) ? id[0]!.toUpperCase() + id.slice(1) : id;
}

/* ── Picker ───────────────────────────────────────────────────────────── */

/**
 * Who answers: provider, model and reasoning effort in one control.
 * `lockProvider` limits it to one provider (council member chips).
 */
export function SeatPicker({
  value,
  onChange,
  lockProvider,
  trigger,
  align = 'left',
  label = 'Choose model',
}: {
  value: Seat;
  onChange: (seat: Seat) => void;
  lockProvider?: ProviderId;
  trigger?: (props: PopoverTriggerProps & { seat: Seat }) => React.ReactNode;
  align?: 'left' | 'right';
  label?: string;
}) {
  const providers = useApp((s) => s.providers);
  const openScreen = useApp((s) => s.open);
  const groups = lockProvider ? providers.filter((p) => p.provider === lockProvider) : providers;
  const { levels, defaultLevel } = effortOptions(value, providers);

  const pickModel = (seat: Seat) => onChange(fitEffort(seat, providers));

  return (
    <Popover
      label={label}
      align={align}
      width={348}
      trigger={(props) =>
        trigger ? trigger({ ...props, seat: value }) : <SeatButton {...props} seat={value} />
      }
    >
      {(close) => (
        <>
          <div
            role="listbox"
            aria-label="Models"
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
          >
            {groups.map((info) => (
              <ProviderGroup
                key={info.provider}
                info={info}
                value={value}
                onPick={pickModel}
                showHeader={!lockProvider}
                onConnect={() => {
                  close();
                  openScreen({ name: 'accounts' });
                }}
              />
            ))}
          </div>
          {levels.length > 0 && (
            <EffortControl
              levels={levels}
              defaultLevel={defaultLevel}
              value={value.effort}
              onChange={(effort) => {
                onChange(withEffort(value, effort));
                close();
              }}
            />
          )}
        </>
      )}
    </Popover>
  );
}

/** The default trigger: "● Claude  Opus · ⚙ low  ⌄". */
function SeatButton({ seat, open, toggle, ref, ...aria }: PopoverTriggerProps & { seat: Seat }) {
  const providers = useApp((s) => s.providers);
  const info = providers.find((p) => p.provider === seat.provider);
  return (
    <button
      ref={ref}
      type="button"
      onClick={toggle}
      aria-label="Choose model"
      {...aria}
      className={`group inline-flex h-7.5 max-w-full items-center gap-2 rounded-full border px-2.5 text-[12.5px] font-medium transition ${
        open
          ? 'border-accent/50 bg-accent-soft text-accent-ink'
          : 'border-line-strong bg-panel hover:bg-sunken'
      }`}
    >
      <ProviderDot provider={seat.provider} />
      <span>{providerName(seat.provider)}</span>
      <span className={`truncate ${open ? 'text-accent-ink/80' : 'text-muted'}`}>
        {modelLabel(info, seat.model)}
      </span>
      {seat.effort && (
        <span
          className={`inline-flex items-center gap-1 border-l pl-2 ${open ? 'border-accent/30' : 'border-line'}`}
        >
          <Gauge className="size-3" aria-hidden />
          {seat.effort}
        </span>
      )}
      <ChevronDown className={`size-3.5 text-faint transition ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function ProviderGroup({
  info,
  value,
  onPick,
  onConnect,
  showHeader,
}: {
  info: ProviderInfo;
  value: Seat;
  onPick: (seat: Seat) => void;
  onConnect: () => void;
  showHeader: boolean;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const ready = info.auth === 'signed_in';
  const here = value.provider === info.provider;
  const effort = here ? value.effort : undefined;
  const pick = (model?: string) =>
    onPick({ provider: info.provider, ...(model && { model }), ...(effort && { effort }) });

  const defaultHint = info.defaultModel
    ? `Your ${providerName(info.provider)} setting · ${modelLabel(info, info.defaultModel)}`
    : `Whatever your ${providerName(info.provider)} CLI is set to`;
  const extra =
    here && value.model && !info.models.some((m) => m.id === value.model) ? value.model : undefined;

  return (
    <div className="pb-1 not-first:mt-1 not-first:border-t not-first:border-line not-first:pt-1.5">
      {showHeader && (
        <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5">
          <ProviderDot provider={info.provider} />
          <span className="text-[12px] font-semibold tracking-wide text-muted">
            {info.displayName}
          </span>
          {!ready && (
            <button
              type="button"
              onClick={onConnect}
              className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent-ink hover:brightness-95"
            >
              <Plug className="size-3" /> Connect
            </button>
          )}
        </div>
      )}
      {ready && (
        <>
          <Option
            selected={here && !value.model}
            title="Default"
            hint={defaultHint}
            onClick={() => pick()}
          />
          {info.models.map((m) => (
            <Option
              key={m.id}
              selected={here && value.model === m.id}
              title={m.label ?? modelLabel(info, m.id)}
              {...((m.description ?? (m.label && m.label !== m.id ? m.id : undefined)) && {
                hint: m.description ?? m.id,
              })}
              onClick={() => pick(m.id)}
            />
          ))}
          {extra && (
            <Option selected title={extra} hint="Custom model id" onClick={() => pick(extra)} />
          )}
          {custom === null ? (
            <button
              type="button"
              data-option
              onClick={() => setCustom('')}
              className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-muted outline-none hover:bg-sunken focus-visible:bg-sunken"
            >
              <Plus className="size-3.5" /> Other model id
            </button>
          ) : (
            <form
              className="px-1.5 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                const model = custom.trim();
                if (/^[\w.:/[\]-]+$/.test(model)) {
                  pick(model);
                  setCustom(null);
                }
              }}
            >
              <input
                autoFocus
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setCustom(null);
                  }
                }}
                placeholder={`${providerName(info.provider)} model id, then Enter`}
                aria-label={`Custom ${info.displayName} model`}
                className="h-8 w-full rounded-lg border border-line-strong bg-panel px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
              />
            </form>
          )}
        </>
      )}
    </div>
  );
}

function Option({
  selected,
  title,
  hint,
  onClick,
}: {
  selected: boolean;
  title: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      data-option
      aria-selected={selected}
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none transition ${
        selected ? 'bg-accent-soft' : 'hover:bg-sunken focus-visible:bg-sunken'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] font-medium ${selected ? 'text-accent-ink' : ''}`}>
          {title}
        </span>
        {hint && <span className="mt-0.5 block truncate text-[11.5px] text-faint">{hint}</span>}
      </span>
      <Check className={`mt-0.5 size-4 shrink-0 text-accent ${selected ? '' : 'invisible'}`} />
    </button>
  );
}

const SHORT_LEVEL: Record<string, string> = { xhigh: 'XHigh' };

function levelName(level: string): string {
  return SHORT_LEVEL[level] ?? level[0]!.toUpperCase() + level.slice(1);
}

function EffortControl({
  levels,
  defaultLevel,
  value,
  onChange,
}: {
  levels: string[];
  defaultLevel?: string | undefined;
  value: string | undefined;
  onChange: (effort: string | undefined) => void;
}) {
  const options = [undefined, ...levels];
  const note = value
    ? effortNote(value)
    : defaultLevel
      ? `Auto uses ${levelName(defaultLevel)}, your CLI setting`
      : 'Auto uses whatever the CLI is set to';
  return (
    <div className="shrink-0 border-t border-line bg-sunken/60 px-3 pt-2.5 pb-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Gauge className="size-3.5 text-muted" aria-hidden />
        <span id="effort-label" className="text-[12px] font-semibold text-muted">
          Reasoning effort
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="effort-label"
        className="flex rounded-xl border border-line bg-panel p-0.5"
      >
        {options.map((level) => {
          const selected = value === level;
          return (
            <button
              key={level ?? 'auto'}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={level ?? 'Auto'}
              title={level ? effortNote(level) : note}
              onClick={() => onChange(level)}
              className={`h-7 min-w-0 flex-auto rounded-[10px] px-2 text-[11.5px] font-medium whitespace-nowrap transition ${
                selected
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {level ? levelName(level) : 'Auto'}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 truncate text-[11.5px] text-faint">{note}</p>
    </div>
  );
}
