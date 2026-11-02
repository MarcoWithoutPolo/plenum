import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clock, Gauge, Plug, Plus, Search, Terminal } from 'lucide-react';
import { Popover, onListKeyDown, type PopoverTriggerProps } from './Popover';

/*
 * The model picker. Providers on the left, the chosen provider's models on the right, and that
 * provider's own effort levels under them. Data comes from each CLI's own model list (see
 * lib/picker.ts); nothing here knows a provider by name.
 */

export interface PickerEffort {
  id: string;
  label: string;
  /** One line in the provider's own words: what this level does. */
  note: string;
}

export interface PickerModel {
  id: string;
  label: string;
  note?: string;
  tags?: string[];
  efforts?: PickerEffort[];
  defaultEffort?: string;
  /** Section inside a provider that offers many makers' models (Cursor: Claude, GPT, Grok…). */
  group?: string;
  /** Older generations fold under "Older models". */
  older?: boolean;
  /** A faster, pricier variant exists (Cursor's "-fast" ids). */
  fast?: boolean;
}

export interface PickerProvider {
  id: string;
  name: string;
  connected: boolean;
  /** "Signed in", "At its limit until 4 PM", "$4.20 credits left". */
  status: string;
  tone?: 'ok' | 'warn' | 'off';
  billing?: string;
  /** What the provider calls effort ("Reasoning", "Mode"). */
  effortName?: string;
  /** Shown instead of an effort control when the provider has none. */
  effortHint?: string;
  defaultModel?: string;
  models: PickerModel[];
  /** For providers that aren't connected yet. */
  install?: { command: string; signIn: string; cost: string };
  /** Installed but signed out: sign-in is one click. */
  installed?: boolean;
}

export interface PickerActions {
  /** Open the Accounts screen. */
  onOpenAccounts?: () => void;
  /** Start the CLI's own sign-in in a terminal. */
  onSignIn?: (provider: string) => void;
}

export interface PickerValue {
  provider: string;
  model?: string;
  effort?: string;
  fast?: boolean;
}

const key = (v: PickerValue) => `${v.provider}/${v.model ?? ''}/${v.effort ?? ''}`;

export function ModelPicker({
  providers,
  value,
  onChange,
  recent = [],
  defaultOpen,
  trigger,
  align = 'left',
  label = 'Choose model',
  allowCustom = true,
  ...actions
}: {
  providers: PickerProvider[];
  value: PickerValue;
  onChange: (v: PickerValue) => void;
  recent?: PickerValue[];
  defaultOpen?: boolean;
  trigger?: (props: PopoverTriggerProps) => React.ReactNode;
  align?: 'left' | 'right';
  label?: string;
  /** Offer "Other model id" for ids the CLI accepts but doesn't list. */
  allowCustom?: boolean;
} & PickerActions) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  // One provider (a council member, a team seat): no provider column.
  const single = providers.length === 1;
  return (
    <Popover
      label={label}
      align={align}
      width={single ? 452 : 640}
      open={open}
      onOpenChange={setOpen}
      trigger={(props) =>
        trigger ? trigger(props) : <PickerButton {...props} value={value} providers={providers} />
      }
    >
      {(close) => (
        <PickerPanel
          providers={providers}
          value={value}
          onChange={onChange}
          recent={single ? [] : recent}
          single={single}
          allowCustom={allowCustom}
          close={close}
          {...actions}
        />
      )}
    </Popover>
  );
}

function modelOf(p: PickerProvider | undefined, id: string | undefined) {
  return p?.models.find((m) => m.id === (id ?? p.defaultModel));
}

/** Labels for a value: provider name, model label and effort label. */
export function describe(providers: PickerProvider[], v: PickerValue) {
  const p = providers.find((x) => x.id === v.provider);
  const m = v.model ? p?.models.find((x) => x.id === v.model) : undefined;
  const e = (m ?? modelOf(p, undefined))?.efforts?.find((x) => x.id === v.effort);
  return { p, model: m?.label ?? 'Default', effort: e?.label };
}

function PickerButton({
  value,
  providers,
  open,
  toggle,
  ref,
  ...aria
}: PopoverTriggerProps & { value: PickerValue; providers: PickerProvider[] }) {
  const { p, model, effort } = describe(providers, value);
  return (
    <button
      ref={ref}
      type="button"
      onClick={toggle}
      // Starts with what it shows (a screen reader reads the current model), then what it does.
      aria-label={`${[p?.name, model, effort].filter(Boolean).join(' ')}, choose model`}
      {...aria}
      className={`group inline-flex h-7.5 max-w-full items-center gap-2 rounded-full border px-2.5 text-[12.5px] font-medium transition ${
        open
          ? 'border-accent/50 bg-accent-soft text-accent-ink'
          : 'border-line-strong bg-panel hover:bg-sunken'
      }`}
    >
      <Dot id={value.provider} />
      <span>{p?.name}</span>{' '}
      <span className={`min-w-0 truncate ${open ? 'text-accent-ink' : 'text-muted'}`} title={model}>
        {model}
      </span>
      {effort && ' '}
      {effort && (
        <span
          className={`inline-flex items-center gap-1 border-l pl-2 ${open ? 'border-accent/30' : 'border-line'}`}
        >
          <Gauge className="size-3" aria-hidden />
          {effort}
        </span>
      )}
      <ChevronDown className={`size-3.5 text-faint transition ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function Dot({ id, size = 8 }: { id: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: `var(--${id}, var(--fake))` }}
    />
  );
}

function PickerPanel({
  providers,
  value,
  onChange,
  recent,
  single,
  allowCustom,
  close,
  onOpenAccounts,
  onSignIn,
}: {
  providers: PickerProvider[];
  value: PickerValue;
  onChange: (v: PickerValue) => void;
  recent: PickerValue[];
  single: boolean;
  allowCustom: boolean;
  close: () => void;
} & PickerActions) {
  const [shown, setShown] = useState(value.provider);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const provider = providers.find((p) => p.id === shown) ?? providers[0]!;
  const here = value.provider === provider.id;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return providers.flatMap((p) =>
      p.connected
        ? p.models
            .filter((m) =>
              [m.label, m.id, m.note ?? '', ...(m.tags ?? []), p.name].some((t) =>
                t.toLowerCase().includes(q),
              ),
            )
            .map((m) => ({ p, m }))
        : [],
    );
  }, [providers, query]);

  const pickModel = (p: PickerProvider, m: PickerModel | undefined) => {
    const efforts = (m ?? modelOf(p, undefined))?.efforts ?? [];
    const keep = value.provider === p.id && efforts.some((e) => e.id === value.effort);
    onChange({
      provider: p.id,
      ...(m && { model: m.id }),
      ...(keep && value.effort && { effort: value.effort }),
    });
  };

  return (
    <div
      className={`flex flex-col ${single ? 'h-[440px] min-h-[380px]' : 'h-[500px] min-h-[410px]'}`}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Search className="size-4 text-faint" aria-hidden />
        <input
          ref={search}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            single ? `Search ${provider.name} models` : 'Search every model: sonnet, flash, local…'
          }
          aria-label="Search models"
          className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
        <kbd className="rounded border border-line px-1.5 text-[11px] text-faint">Esc</kbd>
      </div>

      {!query.trim() && recent.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-hidden border-b border-line px-3 py-2">
          <span className="shrink-0 text-[11px] font-semibold tracking-wide text-faint">
            Recent
          </span>
          {recent.slice(0, 3).map((r) => {
            const d = describe(providers, r);
            const on = key(r) === key(value);
            return (
              <button
                key={key(r)}
                type="button"
                onClick={() => {
                  onChange(r);
                  setShown(r.provider);
                }}
                className={`inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] whitespace-nowrap ${
                  on
                    ? 'border-accent/40 bg-accent-soft text-accent-ink'
                    : 'border-line hover:bg-sunken'
                }`}
              >
                <Dot id={r.provider} size={7} />
                <span className="truncate">
                  {d.model}
                  {d.effort && <span className="text-faint"> · {d.effort}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {query.trim() ? (
        <div
          role="listbox"
          aria-label="Matching models"
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {matches.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted">
              No model matches “{query.trim()}”.
            </p>
          ) : (
            matches.map(({ p, m }) => (
              <Row
                key={`${p.id}/${m.id}`}
                selected={value.provider === p.id && value.model === m.id}
                title={m.label}
                provider={p}
                hint={m.note}
                tags={m.tags}
                onClick={() => {
                  pickModel(p, m);
                  setShown(p.id);
                  setQuery('');
                }}
              />
            ))
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!single && (
            <nav
              aria-label="Providers"
              onKeyDown={onListKeyDown}
              className="flex w-[188px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-sunken/50 p-1.5"
            >
              {providers.map((p) => {
                const on = p.id === provider.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-option
                    aria-current={on ? 'true' : undefined}
                    aria-label={`${p.name}: ${p.status}`}
                    title={p.status}
                    onClick={() => setShown(p.id)}
                    className={`flex h-8 items-center gap-2.5 rounded-lg px-2 text-left outline-none transition ${
                      on ? 'bg-panel shadow-card' : 'hover:bg-panel/70 focus-visible:bg-panel/70'
                    }`}
                  >
                    <Dot id={p.id} size={9} />
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${on ? 'font-semibold' : 'font-medium'} ${p.connected ? '' : 'text-muted'}`}
                    >
                      {p.name}
                    </span>
                    {value.provider === p.id ? (
                      <Check className="size-3.5 shrink-0 text-accent" aria-hidden />
                    ) : p.tone === 'warn' ? (
                      <Clock className="size-3.5 shrink-0 text-warn" aria-hidden />
                    ) : !p.connected ? (
                      <Plug className="size-3.5 shrink-0 text-faint" aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </nav>
          )}

          <section aria-label={`${provider.name} models`} className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-baseline gap-2 px-4 pt-3 pb-1.5">
              <h3 className="text-[13.5px] font-semibold">{provider.name}</h3>
              <span
                className={`truncate text-[12px] ${provider.tone === 'warn' ? 'text-warn' : 'text-faint'}`}
              >
                {provider.status}
              </span>
              {provider.billing && (
                <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-muted">
                  {provider.billing}
                </span>
              )}
            </div>
            {provider.connected ? (
              <>
                <div
                  role="listbox"
                  aria-label={`${provider.name} models`}
                  onKeyDown={onListKeyDown}
                  className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"
                >
                  {!provider.models.some((m) => m.id === provider.defaultModel) && (
                    <Row
                      selected={here && !value.model}
                      title="Default"
                      hint={
                        provider.defaultModel
                          ? `Your ${provider.name} setting · ${modelOf(provider, undefined)?.label ?? provider.defaultModel}`
                          : `Whatever your ${provider.name} CLI is set to`
                      }
                      onClick={() => pickModel(provider, undefined)}
                    />
                  )}
                  <ModelRows
                    key={provider.id}
                    models={provider.models}
                    selected={here ? (value.model ?? provider.defaultModel) : undefined}
                    onPick={(m) => pickModel(provider, m)}
                  />
                  {here && value.model && !provider.models.some((m) => m.id === value.model) && (
                    <Row selected title={value.model} hint="Custom model id" onClick={() => {}} />
                  )}
                  {allowCustom && (
                    <CustomModel
                      provider={provider}
                      onPick={(id) => onChange({ provider: provider.id, model: id })}
                    />
                  )}
                </div>
                <Effort
                  provider={provider}
                  value={value}
                  here={here}
                  onChange={(v) => {
                    onChange(v);
                    close();
                  }}
                />
              </>
            ) : (
              <Connect
                provider={provider}
                onOpenAccounts={() => {
                  close();
                  onOpenAccounts?.();
                }}
                {...(onSignIn && {
                  onSignIn: () => {
                    close();
                    onSignIn(provider.id);
                  },
                })}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ModelRows({
  models,
  selected,
  onPick,
}: {
  models: PickerModel[];
  selected: string | undefined;
  onPick: (m: PickerModel) => void;
}) {
  const groups = [...new Set(models.map((m) => m.group ?? ''))];
  const start = models.find((m) => m.id === selected)?.group ?? groups[0] ?? '';
  const [group, setGroup] = useState(start);
  const [showOlder, setShowOlder] = useState(false);
  const inGroup = models.filter((m) => (m.group ?? '') === group);
  const current = inGroup.filter((m) => !m.older || m.id === selected);
  const older = inGroup.filter((m) => m.older && m.id !== selected);
  const row = (m: PickerModel) => (
    <Row
      key={m.id}
      selected={selected === m.id}
      title={m.label}
      hint={m.note}
      tags={m.tags}
      onClick={() => onPick(m)}
    />
  );
  return (
    <>
      {groups.length > 1 && (
        <div
          role="tablist"
          aria-label="Model makers"
          className="sticky top-0 z-10 flex flex-wrap gap-1 bg-elev px-1 pt-0.5 pb-1.5"
        >
          {groups.map((g) => {
            const on = g === group;
            const count = models.filter((m) => (m.group ?? '') === g && !m.older).length;
            return (
              <button
                key={g}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => {
                  setGroup(g);
                  setShowOlder(false);
                }}
                className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium transition ${
                  on ? 'bg-ink text-elev' : 'bg-sunken text-muted hover:text-ink'
                }`}
              >
                {g || 'All'}
                <span className={on ? '' : 'text-faint'}> {count}</span>
              </button>
            );
          })}
        </div>
      )}
      {current.map(row)}
      {older.length > 0 &&
        (showOlder ? (
          <>
            <div className="px-2.5 pt-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-faint">
              Older {group} models
            </div>
            {older.map(row)}
          </>
        ) : (
          <button
            type="button"
            data-option
            onClick={() => setShowOlder(true)}
            className="mt-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-muted outline-none hover:bg-sunken focus-visible:bg-sunken"
          >
            <ChevronDown className="size-3.5" aria-hidden /> Older models ({older.length})
          </button>
        ))}
    </>
  );
}
function CustomModel({
  provider,
  onPick,
}: {
  provider: PickerProvider;
  onPick: (id: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <button
        type="button"
        data-option
        onClick={() => setText('')}
        className="mt-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-muted outline-none hover:bg-sunken focus-visible:bg-sunken"
      >
        <Plus className="size-3.5" aria-hidden /> Other model id
      </button>
    );
  }
  return (
    <form
      className="px-1.5 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        const id = text.trim();
        // Never starting with "-": the id is passed to the CLI, where that would be an option.
        if (/^[\w.:/[\]][\w.:/[\]-]*$/.test(id)) {
          onPick(id);
          setText(null);
        }
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Keep the key: Escape here closes this field, not the picker around it.
            e.preventDefault();
            setText(null);
          }
        }}
        placeholder={`${provider.name} model id, then Enter`}
        aria-label={`Custom ${provider.name} model`}
        className="h-8 w-full rounded-lg border border-line-strong bg-panel px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
      />
    </form>
  );
}

function Row({
  selected,
  title,
  hint,
  tags,
  provider,
  onClick,
}: {
  selected: boolean;
  title: string;
  hint?: string | undefined;
  tags?: string[] | undefined;
  provider?: PickerProvider;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      data-option
      aria-selected={selected}
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-1.5 text-left outline-none transition ${
        selected ? 'bg-accent-soft' : 'hover:bg-sunken focus-visible:bg-sunken'
      }`}
    >
      {provider && (
        <span className="mt-1.5">
          <Dot id={provider.id} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`text-[13px] font-medium ${selected ? 'text-accent-ink' : ''}`}>
            {title}
          </span>
          {provider && <span className="text-[12px] text-faint">{provider.name}</span>}
          {tags?.map((t) => (
            <span
              key={t}
              className="rounded-full bg-sunken px-1.5 py-px text-[10.5px] font-medium text-muted"
            >
              {t}
            </span>
          ))}
        </span>
        {hint && <span className="mt-0.5 block truncate text-[11.5px] text-faint">{hint}</span>}
      </span>
      <Check className={`mt-0.5 size-4 shrink-0 text-accent ${selected ? '' : 'invisible'}`} />
    </button>
  );
}

function Effort({
  provider,
  value,
  here,
  onChange,
}: {
  provider: PickerProvider;
  value: PickerValue;
  here: boolean;
  onChange: (v: PickerValue) => void;
}) {
  const model = modelOf(provider, here ? value.model : undefined);
  const levels = model?.efforts ?? [];
  const name = provider.effortName ?? 'Effort';
  if (levels.length === 0) {
    return (
      <div className="shrink-0 border-t border-line bg-sunken/60 px-4 py-3 text-[12px] text-muted">
        {provider.effortHint ?? `${model?.label ?? 'This model'} has no effort setting.`}
      </div>
    );
  }
  const current = here ? value.effort : undefined;
  const auto = levels.find((l) => l.id === model?.defaultEffort);
  const note = current
    ? levels.find((l) => l.id === current)?.note
    : auto
      ? `Auto uses ${auto.label}, the ${model?.label} default`
      : `Auto uses your ${provider.name} setting`;
  const set = (effort: string | undefined, fast = here && value.fast) =>
    onChange({
      provider: provider.id,
      ...(here && value.model && { model: value.model }),
      ...(effort && { effort }),
      ...(fast && { fast: true }),
    });
  return (
    <div className="shrink-0 border-t border-line bg-sunken/60 px-4 pt-2.5 pb-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Gauge className="size-3.5 text-muted" aria-hidden />
        <span id="picker-effort" className="text-[12px] font-semibold text-muted">
          {name} for {model?.label ?? 'the default model'}
        </span>
        {model?.fast && (
          <label className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={Boolean(here && value.fast)}
              onChange={(e) => set(current, e.target.checked)}
              className="accent-[var(--accent)]"
            />
            Fast
            <span className="text-faint">· quicker, uses more</span>
          </label>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby="picker-effort"
        className="flex rounded-xl border border-line bg-panel p-0.5"
      >
        {[undefined, ...levels].map((l) => {
          const on = current === l?.id;
          return (
            <button
              key={l?.id ?? 'auto'}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={l?.label ?? 'Auto'}
              title={l?.note ?? note}
              onClick={() => set(l?.id)}
              className={`h-7 min-w-0 flex-auto rounded-[10px] px-2 text-[11.5px] font-medium whitespace-nowrap transition ${
                on ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {l?.label ?? 'Auto'}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 truncate text-[11.5px] text-faint">{note}</p>
    </div>
  );
}

function Connect({
  provider,
  onOpenAccounts,
  onSignIn,
}: {
  provider: PickerProvider;
  onOpenAccounts: () => void;
  onSignIn?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pt-1 pb-4 text-[13px]">
      <p className="text-muted">
        {provider.installed
          ? `${provider.name} is installed but not signed in. Sign in with your own account; Conclave never sees your password.`
          : `${provider.name} isn't connected. Install its CLI and sign in with your own account; Conclave never sees your password.`}
      </p>
      {provider.install && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[12.5px]">
          <dt className="text-faint">Install</dt>
          <dd>
            <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">
              {provider.install.command}
            </code>
          </dd>
          <dt className="text-faint">Sign in</dt>
          <dd>
            <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[11.5px]">
              {provider.install.signIn}
            </code>
          </dd>
          <dt className="text-faint">Cost</dt>
          <dd className="text-muted">{provider.install.cost}</dd>
        </dl>
      )}
      <div className="mt-auto flex gap-2">
        {provider.installed && onSignIn ? (
          <button
            type="button"
            onClick={onSignIn}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            <Terminal className="size-3.5" /> Sign in
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenAccounts}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            <Terminal className="size-3.5" /> Install and sign in
          </button>
        )}
        <button
          type="button"
          onClick={onOpenAccounts}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-[12.5px] font-medium"
        >
          <Plug className="size-3.5" /> Open Accounts
        </button>
      </div>
    </div>
  );
}
