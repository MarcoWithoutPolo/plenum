import { useEffect, useState } from 'react';
import type { AppSettings, NotificationSettings } from '@conclave/shared';
import { api } from '@/lib/api';

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

export function SettingsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  useEffect(() => {
    void api().settings.get().then(setSettings);
  }, []);
  const setNotice = async (key: keyof NotificationSettings, on: boolean) => {
    setSettings((s) => s && { ...s, notifications: { ...s.notifications, [key]: on } });
    setSettings(await api().settings.update({ notifications: { [key]: on } }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-[13.5px] text-muted">How Conclave keeps you in the loop.</p>

          <section aria-labelledby="notifications-title" className="mt-8">
            <h2 id="notifications-title" className="text-[15px] font-semibold">
              Notifications
            </h2>
            <p className="mt-0.5 text-[12.5px] text-faint">
              Shown only while Conclave isn't the window you're using. Clicking one opens the
              project.
            </p>
            <div className="mt-3 flex flex-col divide-y divide-line rounded-2xl border border-line bg-panel shadow-card">
              {NOTICES.map((n) => (
                <label key={n.key} className="flex cursor-pointer items-center gap-4 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium">{n.label}</span>
                    <span className="block text-[12px] text-faint">{n.hint}</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={n.label}
                    disabled={!settings}
                    checked={settings?.notifications[n.key] ?? true}
                    onChange={(e) => void setNotice(n.key, e.target.checked)}
                    className="peer sr-only"
                  />
                  <span className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
                </label>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
