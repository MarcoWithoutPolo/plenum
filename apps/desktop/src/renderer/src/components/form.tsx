import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import type {
  AskPolicy,
  PermissionLevel,
  Permissions,
  ProviderId,
  RetryStrategy,
  Routing,
  Seat,
} from '@conclave/shared';
import type { PermissionGaps, ProviderInfo, TeamInsights } from '../../../shared/api';
import { Popover } from './Popover';
import { SeatPicker, modelLabel } from './SeatPicker';
import { ProviderDot } from './bits';
import { api } from '@/lib/api';
import { providerName, readyProviders, useApp } from '@/lib/store';

/* ── Field ───────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  hintBelow,
  error,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the hint under the control (narrow fields). */
  hintBelow?: boolean;
  error?: string | undefined;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold whitespace-nowrap">{label}</span>
        {optional && <span className="text-[11.5px] text-faint">Optional</span>}
        {hint && !error && !hintBelow && (
          <span className="ml-auto truncate text-[11.5px] text-faint">{hint}</span>
        )}
        {error && (
          <span role="alert" className="ml-auto text-[11.5px] font-medium text-danger">
            {error}
          </span>
        )}
      </div>
      {children}
      {hint && hintBelow && <p className="mt-1.5 text-[11.5px] text-faint">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'h-9.5 w-full rounded-xl border border-line-strong bg-panel px-3 text-[13px] outline-none placeholder:text-faint focus:border-accent';
export const textareaClass =
  'w-full resize-none rounded-xl border border-line-strong bg-panel px-3.5 py-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-faint focus:border-accent';

/* ── Segmented control ───────────────────────────────────────────────── */

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = 'md',
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string; tone?: 'danger' }[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex flex-wrap rounded-xl border border-line bg-sunken/60 p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                onChange(options[(i + 1) % options.length]!.value);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                onChange(options[(i - 1 + options.length) % options.length]!.value);
              }
            }}
            tabIndex={on ? 0 : -1}
            className={`rounded-[10px] px-3 font-medium whitespace-nowrap transition ${
              size === 'sm' ? 'h-7 text-[12px]' : 'h-7.5 text-[12.5px]'
            } ${
              on
                ? o.tone === 'danger'
                  ? 'bg-danger text-white shadow-sm'
                  : 'bg-accent text-white shadow-sm'
                : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Team ────────────────────────────────────────────────────────────── */

const PREFERENCE: Record<keyof Routing, ProviderId[]> = {
  planner: ['claude', 'antigravity', 'codex', 'gemini'],
  builder: ['codex', 'claude', 'antigravity', 'gemini'],
  reviewer: ['claude', 'antigravity', 'codex', 'gemini'],
};

export const ROLES: { key: keyof Routing; label: string; hint: string }[] = [
  { key: 'planner', label: 'Plans', hint: 'Splits the goal into tasks' },
  { key: 'builder', label: 'Builds', hint: 'Writes each task in a worktree' },
  { key: 'reviewer', label: 'Reviews', hint: 'Checks each diff, never its own' },
];

export function defaultRouting(ready: ProviderInfo[]): Routing {
  const order = (role: keyof Routing) =>
    PREFERENCE[role].flatMap((p) => (ready.some((r) => r.provider === p) ? [{ provider: p }] : []));
  return { planner: order('planner'), builder: order('builder'), reviewer: order('reviewer') };
}

export function TeamEditor({
  routing,
  onChange,
  gaps,
}: {
  routing: Routing;
  onChange: (routing: Routing) => void;
  /** Builders that can't work at the chosen permission level, and why. */
  gaps?: PermissionGaps;
}) {
  return (
    <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
      {ROLES.map((role) => (
        <div key={role.key} className="flex items-center gap-3 px-3.5 py-2.5">
          <div className="w-36 shrink-0">
            <div className="text-[13px] font-medium">{role.label}</div>
            <div className="text-[11.5px] leading-snug text-faint">{role.hint}</div>
          </div>
          <SeatList
            seats={routing[role.key]}
            onChange={(seats) => onChange({ ...routing, [role.key]: seats })}
            {...(role.key === 'builder' && gaps && { gaps })}
          />
        </div>
      ))}
    </div>
  );
}

/** An ordered list of seats: each one editable with the seat picker, removable, and an Add button. */
export function SeatList({
  seats,
  onChange,
  gaps,
}: {
  seats: Seat[];
  onChange: (seats: Seat[]) => void;
  gaps?: PermissionGaps;
}) {
  const providers = useApp((s) => s.providers);
  const ready = readyProviders(providers);
  const unused = ready.filter((p) => !seats.some((s) => s.provider === p.provider));

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {seats.map((seat, i) => {
        const info = providers.find((p) => p.provider === seat.provider);
        const gap = gaps?.[seat.provider];
        return (
          <span key={seat.provider} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-[11px] text-faint">then</span>}
            <span
              title={gap}
              className={`inline-flex h-7.5 items-center rounded-full border bg-panel ${gap ? 'border-warn/50 opacity-70' : 'border-line-strong'}`}
            >
              <SeatPicker
                value={seat}
                lockProvider={seat.provider}
                onChange={(next) => onChange(seats.map((s, j) => (j === i ? next : s)))}
                label={`${info?.displayName ?? seat.provider} model`}
                trigger={({ ref, toggle, seat: s, open, ...aria }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={toggle}
                    {...aria}
                    className={`inline-flex h-full items-center gap-1.5 rounded-l-full pr-1.5 pl-2.5 text-[12.5px] font-medium ${open ? 'text-accent-ink' : ''}`}
                  >
                    {gap ? (
                      <AlertTriangle
                        className="size-3 text-warn"
                        aria-label="Unavailable at this level"
                      />
                    ) : (
                      <ProviderDot provider={s.provider} size={7} />
                    )}
                    {providerName(s.provider)}
                    <span className="font-normal text-muted">{modelLabel(info, s.model)}</span>
                    {s.effort && <span className="font-normal text-faint">· {s.effort}</span>}
                  </button>
                )}
              />
              <button
                type="button"
                aria-label={`Remove ${providerName(seat.provider)}`}
                onClick={() => onChange(seats.filter((_, j) => j !== i))}
                className="mr-1 grid size-5.5 place-items-center rounded-full text-faint hover:bg-sunken hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </span>
          </span>
        );
      })}
      {unused.length > 0 && (
        <Popover
          label="Add an AI"
          width={220}
          trigger={({ ref, toggle, ...aria }) => (
            <button
              ref={ref}
              type="button"
              onClick={toggle}
              {...aria}
              aria-label="Add an AI"
              className="inline-flex h-7.5 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12px] font-medium text-muted hover:border-accent/50 hover:text-accent-ink"
            >
              <Plus className="size-3.5" /> Add
            </button>
          )}
        >
          {(close) => (
            <div className="p-1.5">
              {unused.map((p) => (
                <button
                  key={p.provider}
                  type="button"
                  onClick={() => {
                    onChange([...seats, { provider: p.provider }]);
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken"
                >
                  <ProviderDot provider={p.provider} />
                  {p.displayName}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

/* ── Policies ────────────────────────────────────────────────────────── */

export const ASK_POLICIES: { value: AskPolicy; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask me', hint: 'The task waits in your Inbox; other work goes on.' },
  {
    value: 'decide',
    label: 'Decide and tell me',
    hint: 'The agent takes its recommended option and notes the assumption.',
  },
  {
    value: 'council',
    label: 'Council decides',
    hint: 'The reviewers vote; the result is noted as an assumption.',
  },
];

export const STRATEGIES: { value: RetryStrategy; label: string; hint: string }[] = [
  {
    value: 'escalate',
    label: 'Escalate',
    hint: 'Attempt 2 thinks harder; attempt 3 hands the task to the next builder.',
  },
  { value: 'same', label: 'Same team', hint: 'Every attempt uses the team in order.' },
];

/* ── Permissions ─────────────────────────────────────────────────────── */

export const LEVELS: { level: PermissionLevel; label: string; text: string }[] = [
  { level: 1, label: '1', text: 'Read only. Builders can look but not change anything.' },
  {
    level: 2,
    label: '2',
    text: 'Edit files inside the task’s worktree, offline; Conclave runs your tests. Codex can still run commands, but only inside its sandbox.',
  },
  {
    level: 3,
    label: '3',
    text: 'Edit files and run the project’s checks (tests, lint, build). Nothing else, no network.',
  },
  {
    level: 4,
    label: '4',
    text: 'Edit files and run any command inside the worktree’s sandbox. Offline unless you allow network.',
  },
  {
    level: 5,
    label: '5',
    text: 'Full access: commands and network, no sandbox. Turns itself off after 24 hours.',
  },
];

export const LEVEL_NAMES: Record<PermissionLevel, string> = {
  1: 'Read only',
  2: 'Edit files',
  3: 'Edit and run checks',
  4: 'Run anything, offline',
  5: 'Full access',
};

/** The level picker with its two switches. Level 5 needs the project name typed to confirm. */
export function PermissionPicker({
  value,
  onChange,
  projectName,
  onGaps,
}: {
  value: Permissions;
  onChange: (value: Permissions) => void;
  projectName: string;
  onGaps?: (gaps: PermissionGaps) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const level = LEVELS.find((l) => l.level === value.level)!;

  useEffect(() => {
    let live = true;
    void api()
      .projects.permissionGaps(value)
      .then((gaps) => live && onGaps?.(gaps))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [value.level, value.network]);

  const pick = (l: PermissionLevel) => {
    if (l === 5 && value.level !== 5) {
      setConfirming(true);
      setTyped('');
      return;
    }
    setConfirming(false);
    onChange({
      ...value,
      level: l,
      network: l < 4 && value.network === 'allow' ? 'never' : value.network,
      expiresAt: null,
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Permission level"
          value={value.level}
          options={LEVELS.map((l) => ({
            value: l.level,
            label: l.label,
            title: LEVEL_NAMES[l.level],
            ...(l.level === 5 && { tone: 'danger' as const }),
          }))}
          onChange={pick}
        />
        <span
          className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${value.level === 5 ? 'text-danger' : 'text-ink'}`}
        >
          {value.level === 5 ? (
            <ShieldAlert className="size-3.5" aria-hidden />
          ) : (
            <ShieldCheck className="size-3.5 text-ok" aria-hidden />
          )}
          {LEVEL_NAMES[value.level]}
        </span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted">{level.text}</p>

      {confirming && (
        <div className="rounded-xl border border-danger/30 bg-danger-soft/60 px-3.5 py-3">
          <p className="text-[12.5px] font-medium text-danger">
            Full access lets agents run any command and reach the network with no sandbox.
          </p>
          <label className="mt-2 block text-[12px] text-muted">
            Type{' '}
            <span className="font-mono font-semibold text-ink">
              {projectName || 'the project name'}
            </span>{' '}
            to turn it on for 24 hours:
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="Type the project name to confirm full access"
              className={`${inputClass} mt-1.5 h-8.5`}
            />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-7 rounded-lg px-2.5 text-[12.5px] font-medium text-muted hover:bg-sunken"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!projectName || typed.trim() !== projectName.trim()}
              onClick={() => {
                setConfirming(false);
                onChange({ ...value, level: 5, network: 'allow', expiresAt: null });
              }}
              className="h-7 rounded-lg bg-danger px-2.5 text-[12.5px] font-medium text-white disabled:opacity-40"
            >
              Turn on full access
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
        <div>
          <div className="mb-1.5 text-[12px] font-medium">Network</div>
          <Segmented
            size="sm"
            label="Network"
            value={value.network}
            options={[
              { value: 'never', label: 'Never' },
              { value: 'ask', label: 'Ask each time' },
              ...(value.level >= 4 ? [{ value: 'allow' as const, label: 'Allow' }] : []),
            ]}
            onChange={(network) => onChange({ ...value, network })}
          />
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium">Installing packages</div>
          <Segmented
            size="sm"
            label="Installing packages"
            value={value.installs}
            options={[
              { value: 'ask', label: 'Ask each time' },
              { value: 'allow', label: 'Allow' },
              { value: 'never', label: 'Never' },
            ]}
            onChange={(installs) => onChange({ ...value, installs })}
          />
        </div>
      </div>
      <p className="text-[11.5px] text-faint">
        Pushing, pull requests, new repositories and merging into your branch always wait for you in
        the Inbox.
      </p>
    </div>
  );
}

/** "Codex can't…" lines for builders that the chosen level rules out. */
const ROLE_NOUN = { planner: 'Planning', builder: 'Building', reviewer: 'Reviews' } as const;

/**
 * "Adjust from measured data": the brain may reorder the team by measured speed,
 * reliability and quota. Shows what it would change and why, so nothing happens silently.
 */
export function AdaptiveTeam({
  routing,
  value,
  onChange,
}: {
  routing: Routing;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const [insights, setInsights] = useState<TeamInsights | null>(null);
  useEffect(() => {
    let live = true;
    void api()
      .projects.teamInsights(routing)
      .then((i) => live && setInsights(i))
      .catch(() => live && setInsights(null));
    return () => {
      live = false;
    };
  }, [JSON.stringify(routing)]);
  const notes = insights
    ? (Object.keys(ROLE_NOUN) as (keyof typeof ROLE_NOUN)[]).flatMap((role) =>
        insights[role].reasons.map((r) => ({ role, text: r })),
      )
    : [];
  return (
    <div className="mt-2 rounded-xl border border-line px-3 py-2.5">
      <label className="flex items-start gap-2.5 text-[12.5px]">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          aria-label="Adjust the team from measured speed and limits"
          className="mt-0.5 accent-[var(--color-accent)]"
        />
        <span>
          <span className="font-medium">Adjust the order from measured speed and limits</span>
          <span className="block text-[11.5px] text-faint">
            Slow or unreliable AIs, and ones close to their limit, move back. Reviews always go to a
            different AI than the builder.
          </span>
        </span>
      </label>
      {notes.length > 0 && (
        <ul
          className={`mt-2 flex flex-col gap-1 text-[12px] leading-relaxed ${value ? 'text-muted' : 'text-faint line-through'}`}
        >
          {notes.map((n) => (
            <li key={n.role + n.text}>
              <span className="font-medium">{ROLE_NOUN[n.role]}:</span> {n.text}.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GapNotes({ routing, gaps }: { routing: Routing; gaps: PermissionGaps }) {
  const hit = routing.builder.filter((s) => gaps[s.provider]);
  if (!hit.length) return null;
  const none = hit.length === routing.builder.length;
  return (
    <div
      role="note"
      className={`mt-2 rounded-xl px-3 py-2 text-[12px] leading-relaxed ${none ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn'}`}
    >
      {none && <p className="font-medium">No builder on the team can work at this level.</p>}
      {hit.map((s) => (
        <p key={s.provider}>{gaps[s.provider]}</p>
      ))}
    </div>
  );
}
