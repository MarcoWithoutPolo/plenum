import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  AppSettings,
  AppearanceSettings,
  LimitSettings,
  NotificationSettings,
  ProviderId,
  ProviderLimit,
  QuietHours,
} from '@conclave/shared';
import { PROVIDERS } from '@conclave/shared';
import { Button, ProviderDot } from '@/components/bits';
import { Segmented, inputClass } from '@/components/form';
import { api } from '@/lib/api';
import type { SettingsPatch } from '../../../shared/api';
import { providerName, useApp } from '@/lib/store';
import { settle } from '@/lib/settle';
import { SHOW_SHORTCUTS } from '@/lib/events';
import { applyLook } from '../../../shared/look';

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

/** The default lanes per AI, matching the engine's LANE_CAPS (both from the registry). */
const DEFAULT_LANES: Partial<Record<ProviderId, number>> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.laneCap]),
);
/** Only AIs that report plan usage can have some left for you. */
const REPORTS_USAGE: ProviderId[] = PROVIDERS.filter((p) => p.reportsUsage).map((p) => p.id);
/**
 * AI · lanes · leave for me · daily cap, aligned across rows. Where the four don't fit side by
 * side (a narrow window, large text), each AI's controls stack, each with its own caption.
 */
const LIMIT_GRID =
  'grid grid-cols-[8.5rem_8.5rem_12rem_1fr] items-center justify-items-start gap-x-5 px-4 @max-[46rem]:grid-cols-1 @max-[46rem]:gap-y-2';
/** A column's caption, shown next to its control only when the header row is hidden. */
const STACKED_CAPTION =
  'hidden text-[11px] font-medium tracking-wide text-faint uppercase @max-[46rem]:block';
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
  // The hidden checkbox sits inside the drawn switch, so its own spot is the switch itself.
  return (
    <span className="relative inline-flex shrink-0">
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
    </span>
  );
}

/** A setting with its label and hint on the left and its control on the right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="min-w-0 flex-1 basis-60">
        <span className="block text-[13.5px] font-medium">{label}</span>
        <span className="block text-[12px] text-faint">{hint}</span>
      </span>
      {children}
    </div>
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

/** The Ollama address, with a warning when it isn't this computer or a private network. */
function LocalHost({
  value,
  onSave,
}: {
  value: string | undefined;
  onSave: (host: string) => Promise<void>;
}) {
  const [text, setText] = useState(value ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value ?? ''), [value]);
  const host = text.trim().replace(/\/+$/, '');
  const open = /^https?:\/\/[\w.[\]:-]+(?::\d+)?$/.test(host) && !isPrivateAddress(host);
  return (
    <form
      className="flex flex-col gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        onSave(host).catch(() => setError("That isn't an address like http://127.0.0.1:11434."));
      }}
    >
      <label className="flex items-center gap-3">
        <span className="w-28 shrink-0 text-[13.5px] font-medium">Ollama address</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="http://127.0.0.1:11434"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-panel px-2.5 font-mono text-[12.5px] outline-none focus:border-accent"
        />
        <Button type="submit" disabled={!value || host === value}>
          Save
        </Button>
      </label>
      {open && (
        <p className="text-[12px] text-warn">
          This address isn't on your computer or a private network. Ollama has no sign-in, so anyone
          who can reach it can use it, and your prompts travel there.
        </p>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </form>
  );
}

/** Same rule as the engine's isPrivateHost: loopback, .local, bare names and private ranges. */
function isPrivateAddress(host: string): boolean {
  try {
    const { hostname } = new URL(host);
    if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return true;
    if (hostname.endsWith('.local') || !hostname.includes('.')) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      hostname,
    );
  } catch {
    return true;
  }
}

export function SettingsScreen() {
  const providers = useApp((s) => s.providers);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    settle(api().settings.get().then(setSettings));
  }, []);

  // A change shows at once; if the engine refuses it, the screen goes back to what's saved and
  // the reason is shown (U8).
  const save = async (show: (s: AppSettings) => AppSettings, update: SettingsPatch) => {
    const before = settings;
    setSettings((s) => s && show(s));
    try {
      setSettings(await api().settings.update(update));
    } catch (err) {
      setSettings(before);
      throw err;
    }
  };
  const setNotice = (key: keyof NotificationSettings, on: boolean) =>
    save((s) => ({ ...s, notifications: { ...s.notifications, [key]: on } }), {
      notifications: { [key]: on },
    });
  const look = settings?.appearance;
  const setLook = (patch: Partial<AppearanceSettings>) =>
    save((s) => ({ ...s, appearance: { ...s.appearance, ...patch } }), { appearance: patch });
  // The page side of the look follows what's saved (theme and size are the window's).
  useEffect(() => {
    if (look) applyLook(document.documentElement, look);
  }, [look]);
  const setLimits = (patch: Partial<LimitSettings>) =>
    save((s) => ({ ...s, limits: { ...s.limits, ...patch } }), { limits: patch });
  const limits = settings?.limits;
  const limitOf = (p: ProviderId): ProviderLimit =>
    limits?.providers[p] ?? { leaveForMe: 0.1, dailyCap: null };
  const setProvider = (p: ProviderId, patch: Partial<ProviderLimit>) =>
    settle(setLimits({ providers: { ...limits?.providers, [p]: { ...limitOf(p), ...patch } } }));
  const setQuiet = (quietHours: QuietHours[]) => settle(setLimits({ quietHours }));

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
              onChange={(on) => settle(setLimits({ pauseAll: on }))}
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
            <div className="@container">
              {ready.length > 0 && (
                <div
                  aria-hidden
                  className={`${LIMIT_GRID} py-2 text-[11px] font-medium tracking-wide text-faint uppercase @max-[46rem]:hidden`}
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
                    <span aria-hidden className={STACKED_CAPTION}>
                      Lanes at once
                    </span>
                    <Segmented
                      size="sm"
                      label={`${providerName(p)} lanes`}
                      value={l.lanes ?? DEFAULT_LANES[p] ?? 1}
                      onChange={(lanes) => setProvider(p, { lanes })}
                      options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                    />
                    <span aria-hidden className={STACKED_CAPTION}>
                      Leave for me
                    </span>
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
                    <span aria-hidden className={STACKED_CAPTION}>
                      Daily cap
                    </span>
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
            </div>
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
            id="local"
            title="Local models"
            hint="Where Ollama runs. A powerful computer on your network can serve the models for this one."
          >
            <LocalHost
              value={settings?.local.host}
              onSave={async (host) => {
                setSettings(await api().settings.update({ local: { host } }));
                await refreshProviders();
              }}
            />
          </Section>

          <Section
            id="appearance"
            title="Appearance and accessibility"
            hint="How Conclave looks and reads. Each change applies at once and is kept."
          >
            <Row label="Theme" hint="Follows your system unless you pick one.">
              <Segmented
                label="Theme"
                value={look?.theme ?? 'system'}
                onChange={(theme) => settle(setLook({ theme }))}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </Row>
            <Row label="Text size" hint="Everything scales, menus and dialogs included.">
              <Segmented
                label="Text size"
                value={look?.textScale ?? 1}
                onChange={(textScale) => settle(setLook({ textScale }))}
                options={([0.9, 1, 1.15, 1.3] as const).map((n) => ({
                  value: n,
                  label: `${Math.round(n * 100)}%`,
                }))}
              />
            </Row>
            <Row label="Reduce motion" hint="Turns off animations and moving progress bars.">
              <Segmented
                label="Reduce motion"
                value={look?.motion ?? 'system'}
                onChange={(motion) => settle(setLook({ motion }))}
                options={[
                  { value: 'system', label: 'Follow system' },
                  { value: 'reduce', label: 'Always' },
                ]}
              />
            </Row>
            <label className="flex cursor-pointer items-center gap-4 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">Higher contrast</span>
                <span className="block text-[12px] text-faint">Stronger text and borders.</span>
              </span>
              <Switch
                label="Higher contrast"
                disabled={!look}
                checked={look?.contrast === 'high'}
                onChange={(on) => settle(setLook({ contrast: on ? 'high' : 'normal' }))}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-4 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">Always show focus outlines</span>
                <span className="block text-[12px] text-faint">
                  Even after clicking with the mouse, not only with the keyboard.
                </span>
              </span>
              <Switch
                label="Always show focus outlines"
                disabled={!look}
                checked={look?.focusAlways ?? false}
                onChange={(focusAlways) => settle(setLook({ focusAlways }))}
              />
            </label>
            <label className="flex cursor-pointer items-center gap-4 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">
                  Announce progress to screen readers
                </span>
                <span className="block text-[12px] text-faint">
                  A council answered, a project needs you, a merge landed.
                </span>
              </span>
              <Switch
                label="Announce progress to screen readers"
                disabled={!look}
                checked={look?.announce ?? true}
                onChange={(announce) => settle(setLook({ announce }))}
              />
            </label>
            <Row
              label="Keyboard shortcuts"
              hint="Every shortcut in one list. Also opens with Ctrl+/ or ?."
            >
              <Button onClick={() => window.dispatchEvent(new Event(SHOW_SHORTCUTS))}>
                Show shortcuts
              </Button>
            </Row>
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
                  onChange={(on) => settle(setNotice(n.key, on))}
                />
              </label>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
