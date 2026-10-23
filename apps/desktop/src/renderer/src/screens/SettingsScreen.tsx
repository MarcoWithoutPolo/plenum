import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  AppSettings,
  LimitSettings,
  NotificationSettings,
  ProviderId,
  ProviderLimit,
  QuietHours,
} from '@conclave/shared';
import { Button, ProviderDot } from '@/components/bits';
import { Segmented, inputClass } from '@/components/form';
import { api } from '@/lib/api';
import { providerName, useApp } from '@/lib/store';

const NOTICES: { key: keyof NotificationSettings; label: string; hint: string }[] = [
  {
    key: 'needsYou',
    label: 'Needs you',
    hint: 'An agent asks a question or a permission. On Windows the taskbar icon flashes too.',
  },
  {
    key: 'approval',
    label: 'Ready to merge',
    hint: 'Work waits for your OK to merge or open a PR.',
  },
  { key: 'done', label: 'Goal met', hint: 'A project finished what you asked for.' },
  { key: 'paused', label: 'Paused after failures', hint: 'Several tasks failed in a row.' },
  { key: 'limit', label: 'Out of usage', hint: 'An AI hit its limit. At most once per AI a day.' },
];

/** The default lanes per AI, matching the engine's LANE_CAPS. */
const DEFAULT_LANES: Partial<Record<ProviderId, number>> = {
  claude: 2,
  codex: 2,
  antigravity: 1,
  gemini: 1,
};
/** Only Claude and Codex report plan usage, so "leave for me" only applies to them. */
const REPORTS_USAGE: ProviderId[] = ['claude', 'codex'];
/** AI · lanes · leave for me · daily cap, aligned across rows. */
const LIMIT_GRID =
  'grid grid-cols-[8.5rem_8.5rem_12rem_1fr] items-center justify-items-start gap-x-5 px-4';
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        disabled={disabled}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
    </>
  );
}

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="mt-8">
      <h2 id={`${id}-title`} className="text-[15px] font-semibold">
        {title}
      </h2>
      <p className="mt-0.5 text-[12.5px] text-faint">{hint}</p>
      <div className="mt-3 flex flex-col divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
        {children}
      </div>
    </section>
  );
}

export function SettingsScreen() {
  const providers = useApp((s) => s.providers);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    void api().settings.get().then(setSettings);
  }, []);

  const setNotice = async (key: keyof NotificationSettings, on: boolean) => {
    setSettings((s) => s && { ...s, notifications: { ...s.notifications, [key]: on } });
    setSettings(await api().settings.update({ notifications: { [key]: on } }));
  };
  const setLimits = async (patch: Partial<LimitSettings>) => {
    setSettings((s) => s && { ...s, limits: { ...s.limits, ...patch } });
    setSettings(await api().settings.update({ limits: patch }));
  };
  const limits = settings?.limits;
  const limitOf = (p: ProviderId): ProviderLimit =>
    limits?.providers[p] ?? { leaveForMe: 0.1, dailyCap: null };
  const setProvider = (p: ProviderId, patch: Partial<ProviderLimit>) =>
    void setLimits({ providers: { ...limits?.providers, [p]: { ...limitOf(p), ...patch } } });
  const setQuiet = (quietHours: QuietHours[]) => void setLimits({ quietHours });

  const ready = providers.filter((p) => p.auth === 'signed_in').map((p) => p.provider);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            How much of each subscription Conclave may use, and how it keeps you in the loop. These
            apply to every project.
          </p>

          <label
            className={`mt-6 flex cursor-pointer items-center gap-4 rounded-2xl border px-4 py-3.5 shadow-card ${limits?.pauseAll ? 'border-warn/40 bg-warn-soft' : 'border-line bg-panel'}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold">Pause everything</span>
              <span className="block text-[12px] text-faint">
                {limits?.pauseAll
                  ? 'Paused. No project starts new steps until you turn this off.'
                  : 'Stops every project from starting new steps, for when you need your quota now. Running steps finish.'}
              </span>
            </span>
            <Switch
              label="Pause everything"
              disabled={!settings}
              checked={limits?.pauseAll ?? false}
              onChange={(on) => void setLimits({ pauseAll: on })}
            />
          </label>

          <Section
            id="limits"
            title="Usage and limits"
            hint="Shared by every project. Lanes are how many tasks may build on an AI at once."
          >
            {ready.length === 0 && (
              <p className="px-4 py-3 text-[13px] text-faint">
                Sign in to an AI in Accounts first.
              </p>
            )}
            {ready.length > 0 && (
              <div
                aria-hidden
                className={`${LIMIT_GRID} py-2 text-[11px] font-medium tracking-wide text-faint uppercase`}
              >
                <span>AI</span>
                <span>Lanes at once</span>
                <span>Leave for me</span>
                <span>Daily cap</span>
              </div>
            )}
            {ready.map((p) => {
              const l = limitOf(p);
              return (
                <div key={p} className={`${LIMIT_GRID} py-2.5`}>
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    <ProviderDot provider={p} size={8} />
                    {providerName(p)}
                  </span>
                  <Segmented
                    size="sm"
                    label={`${providerName(p)} lanes`}
                    value={l.lanes ?? DEFAULT_LANES[p] ?? 1}
                    onChange={(lanes) => setProvider(p, { lanes })}
                    options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                  />
                  {REPORTS_USAGE.includes(p) ? (
                    <Segmented
                      size="sm"
                      label={`${providerName(p)}: share left for you`}
                      value={Math.round(l.leaveForMe * 100)}
                      onChange={(pct) => setProvider(p, { leaveForMe: pct / 100 })}
                      options={[0, 10, 20, 30].map((n) => ({ value: n, label: `${n}%` }))}
                    />
                  ) : (
                    <span
                      className="text-[12px] text-faint"
                      title="This CLI doesn't report plan usage"
                    >
                      Not reported; use a daily cap
                    </span>
                  )}
                  <span className="flex items-center gap-2 text-[12px] whitespace-nowrap text-faint">
                    <input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      aria-label={`${providerName(p)} daily cap (runs)`}
                      placeholder="None"
                      defaultValue={l.dailyCap ?? ''}
                      onBlur={(e) => {
                        const n = Math.floor(Number(e.target.value));
                        setProvider(p, { dailyCap: e.target.value && n > 0 ? n : null });
                      }}
                      className="h-8 w-20 rounded-xl border border-line-strong bg-panel px-2.5 text-[12.5px] tabular-nums outline-none placeholder:text-faint focus:border-accent"
                    />
                    runs a day
                  </span>
                </div>
              );
            })}
          </Section>

          <Section
            id="quiet"
            title="Quiet hours"
            hint="Nothing new starts on these AIs during these times; work moves to the rest of the team, or waits."
          >
            {(limits?.quietHours ?? []).map((rule, i) => {
              const set = (patch: Partial<QuietHours>) =>
                setQuiet(limits!.quietHours.map((r, j) => (j === i ? { ...r, ...patch } : r)));
              const all = rule.providers === null;
              return (
                <div
                  key={i}
                  role="group"
                  aria-label={`Quiet hours ${i + 1}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                >
                  <span className="flex gap-1" role="group" aria-label="Days">
                    {DAYS.map((d, day) => {
                      const on = rule.days.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={on}
                          aria-label={DAY_NAMES[day]}
                          onClick={() => {
                            const days = on
                              ? rule.days.filter((x) => x !== day)
                              : [...rule.days, day].sort();
                            if (days.length) set({ days });
                          }}
                          className={`grid size-7 place-items-center rounded-full text-[11.5px] font-medium transition ${on ? 'bg-accent text-white' : 'bg-sunken text-muted hover:text-ink'}`}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    <input
                      type="time"
                      aria-label="From"
                      value={rule.from}
                      onChange={(e) => e.target.value && set({ from: e.target.value })}
                      className={`${inputClass} h-8 w-[6.5rem] text-[12.5px]`}
                    />
                    to
                    <input
                      type="time"
                      aria-label="To"
                      value={rule.to}
                      onChange={(e) => e.target.value && set({ to: e.target.value })}
                      className={`${inputClass} h-8 w-[6.5rem] text-[12.5px]`}
                    />
                  </span>
                  <span className="flex flex-wrap gap-1" role="group" aria-label="Which AIs">
                    <button
                      type="button"
                      aria-pressed={all}
                      onClick={() => set({ providers: null })}
                      className={`rounded-full px-2.5 py-1 text-[12px] ${all ? 'bg-accent text-white' : 'bg-sunken text-muted hover:text-ink'}`}
                    >
                      All AIs
                    </button>
                    {ready.map((p) => {
                      const on = !all && rule.providers!.includes(p);
                      return (
                        <button
                          key={p}
                          type="button"
                          aria-pressed={on}
                          onClick={() => {
                            const list = all ? [] : rule.providers!;
                            const next = on ? list.filter((x) => x !== p) : [...list, p];
                            set({ providers: next.length ? next : null });
                          }}
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] ${on ? 'bg-accent text-white' : 'bg-sunken text-muted hover:text-ink'}`}
                        >
                          <ProviderDot provider={p} size={6} />
                          {providerName(p)}
                        </button>
                      );
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label="Remove these quiet hours"
                    onClick={() => setQuiet(limits!.quietHours.filter((_, j) => j !== i))}
                    className="ml-auto grid size-7 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-ink"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              );
            })}
            <div className="px-4 py-3">
              <Button
                size="sm"
                disabled={!settings}
                onClick={() =>
                  setQuiet([
                    ...(limits?.quietHours ?? []),
                    { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00', providers: null },
                  ])
                }
              >
                <Plus className="size-3.5" aria-hidden /> Add quiet hours
              </Button>
            </div>
          </Section>

          <Section
            id="notifications"
            title="Notifications"
            hint="Shown only while Conclave isn't the window you're using. Clicking one opens the project."
          >
            {NOTICES.map((n) => (
              <label key={n.key} className="flex cursor-pointer items-center gap-4 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">{n.label}</span>
                  <span className="block text-[12px] text-faint">{n.hint}</span>
                </span>
                <Switch
                  label={n.label}
                  disabled={!settings}
                  checked={settings?.notifications[n.key] ?? true}
                  onChange={(on) => void setNotice(n.key, on)}
                />
              </label>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
