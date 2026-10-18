import type { QuotaInfo } from '../../../shared/api';

const WINDOWS: Record<string, { label: string; hint: string }> = {
  five_hour: { label: '5-hour window', hint: 'Short-term limit that refills every five hours' },
  seven_day: { label: 'Weekly', hint: 'Total usage across the week' },
  limit: { label: 'Limit reached', hint: 'The provider refused a request' },
};

export function PlanUsage({ quotas }: { quotas: QuotaInfo[] }) {
  const updated = Math.max(...quotas.map((q) => q.at));
  return (
    <div className="mt-4 rounded-xl border border-line px-4 pt-3 pb-3.5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">Plan usage</h3>
        <span className="text-[11.5px] text-faint">Updated {relative(updated, 'past')}</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-6 gap-y-4">
        {quotas.map((q) => (
          <Meter key={q.window} quota={q} />
        ))}
      </div>
    </div>
  );
}

export function Meter({ quota }: { quota: QuotaInfo }) {
  const pct = Math.min(100, Math.round((quota.utilization ?? 0) * 100));
  const tone = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  const meta = WINDOWS[quota.window] ?? { label: quota.window.replace(/_/g, ' '), hint: '' };
  return (
    <div title={meta.hint}>
      <div className="flex items-baseline justify-between">
        <span className="text-[12.5px] font-medium">{meta.label}</span>
        <span
          className="text-[18px] font-semibold tabular-nums"
          style={{ color: pct >= 70 ? tone : undefined }}
        >
          {pct}
          <span className="ml-0.5 text-[12px] font-medium text-faint">%</span>
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${meta.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${Math.max(pct, 2)}%`, background: tone }}
        />
      </div>
      {quota.resetsAt && (
        <div className="mt-1.5 text-[11.5px] text-faint">
          Resets {relative(quota.resetsAt, 'future')} ·{' '}
          {new Date(quota.resetsAt).toLocaleString([], {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </div>
      )}
    </div>
  );
}

/** "in 2h 14m", "3m ago", "just now". */
export function relative(at: number, direction: 'past' | 'future'): string {
  const ms = direction === 'future' ? at - Date.now() : Date.now() - at;
  if (ms < 60_000) return direction === 'future' ? 'in a moment' : 'just now';
  const m = Math.round(ms / 60_000);
  const text =
    m < 60
      ? `${m}m`
      : m < 48 * 60
        ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
        : `${Math.round(m / 1440)} days`;
  return direction === 'future' ? `in ${text}` : `${text} ago`;
}
