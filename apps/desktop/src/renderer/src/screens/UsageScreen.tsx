import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, Gauge, RefreshCw, XCircle } from 'lucide-react';
import { PROVIDERS, type ProviderId } from '@plenum/shared';
import type { AgentRun, DailyActivity, ProviderTotals } from '@plenum/core';
import type { QuotaInfo } from '../../../shared/api';
import { Button, ProviderDot } from '@/components/bits';
import { Meter } from '@/components/PlanUsage';
import { compactNumber } from '@/components/UsageMeta';
import { clock, elapsed } from '@/components/project-bits';
import { useProjects } from '@/lib/projects';
import { providerName, useApp } from '@/lib/store';
import { settle } from '@/lib/settle';

/** Fixed series order (the registry's), so a provider always keeps its color and place. */
const ORDER: ProviderId[] = PROVIDERS.filter((p) => p.id !== 'fake').map((p) => p.id);

export function UsageScreen() {
  const usage = useProjects((s) => s.usage);
  const loadUsage = useProjects((s) => s.loadUsage);
  const providers = useApp((s) => s.providers);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const [range, setRange] = useState<'day' | 'week'>('day');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadUsage(), refreshProviders()]);
    setRefreshing(false);
  };
  useEffect(() => {
    settle(loadUsage());
    const t = window.setInterval(() => settle(loadUsage()), 30_000);
    return () => window.clearInterval(t);
  }, [loadUsage]);

  const totals = usage ? (range === 'day' ? usage.day : usage.week) : [];
  const shown = ORDER.filter(
    (p) =>
      providers.some((x) => x.provider === p && x.auth === 'signed_in') ||
      usage?.week.some((t) => t.provider === p),
  );
  const chart = foldSeries(shown, usage?.daily ?? []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 pt-4 pb-16">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight">Usage</h1>
              <p className="mt-1 text-[13.5px] text-muted">
                How much of each subscription Plenum uses, and how close each one is to its limits.
              </p>
            </div>
            <div
              role="radiogroup"
              aria-label="Time range"
              className="inline-flex rounded-xl border border-line bg-sunken/60 p-0.5"
            >
              {(
                [
                  ['day', 'Last 24 hours'],
                  ['week', 'Last 7 days'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={range === key}
                  onClick={() => setRange(key)}
                  className={`h-7.5 rounded-[10px] px-3 text-[12.5px] font-medium transition ${
                    range === key ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              onClick={() => settle(refresh())}
              disabled={refreshing}
              aria-label="Refresh usage"
            >
              <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
            {shown.map((p) => (
              <ProviderUsage
                key={p}
                provider={p}
                totals={totals.find((t) => t.provider === p)}
                quotas={(usage?.quotas ?? []).filter(
                  (q) => q.provider === p && q.window !== 'limit',
                )}
                range={range}
              />
            ))}
          </div>

          {usage && usage.images[range].runs > 0 && (
            <p className="mt-4 flex items-center gap-2 text-[12.5px] text-muted">
              <Eye className="size-3.5 shrink-0 text-faint" aria-hidden />
              <span>
                Visual review: about {usage.images[range].tokens.toLocaleString()} tokens of
                screenshots in {usage.images[range].runs} review
                {usage.images[range].runs === 1 ? '' : 's'},{' '}
                {(usage.images[range].share * 100).toFixed(usage.images[range].share < 0.1 ? 1 : 0)}
                % of all input. Turn it off per project in its settings.
              </span>
            </p>
          )}

          <ActivityChart daily={chart.daily} series={chart.series} />
          <RecentRuns runs={usage?.recent ?? []} />
        </div>
      </div>
    </div>
  );
}

function ProviderUsage({
  provider,
  totals,
  quotas,
  range,
}: {
  provider: ProviderId;
  totals: ProviderTotals | undefined;
  quotas: QuotaInfo[];
  range: 'day' | 'week';
}) {
  const fresh = totals ? totals.inputTokens - totals.cachedTokens + totals.outputTokens : 0;
  const stats = [
    { label: 'Requests', value: totals ? String(totals.runs) : '0' },
    { label: 'New tokens', value: compactNumber(fresh) },
    { label: 'From cache', value: compactNumber(totals?.cachedTokens ?? 0) },
    { label: 'Busy time', value: totals?.durationMs ? elapsed(totals.durationMs) : '—' },
  ];
  return (
    <section
      aria-label={`${providerName(provider)} usage`}
      className="rounded-2xl border border-line bg-panel p-4.5 shadow-card"
    >
      <header className="flex items-center gap-2">
        <ProviderDot provider={provider} size={10} />
        <h2 className="text-[15px] font-semibold">{providerName(provider)}</h2>
        {totals && (totals.failed > 0 || totals.rateLimited > 0) && (
          <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-warn">
            <AlertTriangle className="size-3.5" aria-hidden />
            {totals.rateLimited > 0
              ? `${totals.rateLimited} hit a limit`
              : `${totals.failed} failed`}
          </span>
        )}
      </header>
      <dl className="mt-3.5 grid grid-cols-4 gap-2">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">
              {s.label}
            </dt>
            <dd className="mt-0.5 text-[17px] font-semibold tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-[11.5px] text-faint">
        {range === 'day' ? 'In the last 24 hours' : 'In the last 7 days'}
      </p>
      <div className="mt-4 border-t border-line pt-3.5">
        {quotas.length ? (
          <div className="grid grid-cols-2 gap-x-5 gap-y-3">
            {quotas.map((q) => (
              <Meter key={q.window} quota={q} />
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-[12.5px] text-muted">
            <Gauge className="size-3.5" aria-hidden />
            Plan limits show up after the first request.
          </p>
        )}
      </div>
    </section>
  );
}

/* ── Daily activity: stacked bars, one segment per provider ──────────── */

/**
 * No chart has more than six coloured series: past that, colour-blind readers can't tell them
 * apart. The five busiest AIs keep their colours; the rest fold into a grey "Other".
 */
const MAX_SERIES = 6;
const OTHER = 'other' as ProviderId;

export function foldSeries(
  series: ProviderId[],
  daily: DailyActivity[],
): { series: ProviderId[]; daily: DailyActivity[] } {
  if (series.length <= MAX_SERIES) return { series, daily };
  const runs = (p: ProviderId) =>
    daily.filter((r) => r.provider === p).reduce((n, r) => n + r.runs, 0);
  const busiest = new Set([...series].sort((a, b) => runs(b) - runs(a)).slice(0, MAX_SERIES - 1));
  const kept = series.filter((p) => busiest.has(p));
  const folded = new Map<string, DailyActivity>();
  for (const r of daily) {
    const provider = busiest.has(r.provider) ? r.provider : OTHER;
    const key = `${r.day}/${provider}`;
    const prev = folded.get(key);
    folded.set(key, {
      ...r,
      provider,
      runs: (prev?.runs ?? 0) + r.runs,
      tokens: (prev?.tokens ?? 0) + r.tokens,
    });
  }
  return { series: [...kept, OTHER], daily: [...folded.values()] };
}

const seriesName = (p: ProviderId) => (p === OTHER ? 'Other' : providerName(p));

function ActivityChart({ daily, series }: { daily: DailyActivity[]; series: ProviderId[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => {
    const out: { day: string; label: string; values: Record<string, number>; total: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const values: Record<string, number> = {};
      for (const row of daily.filter((r) => r.day === key)) values[row.provider] = row.runs;
      out.push({
        day: key,
        label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        values,
        total: Object.values(values).reduce((a, b) => a + b, 0),
      });
    }
    return out;
  }, [daily]);
  const max = Math.max(4, ...days.map((d) => d.total));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  return (
    <section
      aria-labelledby="activity-title"
      className="mt-6 rounded-2xl border border-line bg-panel p-5 shadow-card"
    >
      <header className="flex items-baseline gap-3">
        <h2 id="activity-title" className="text-[13.5px] font-semibold">
          Requests per day
        </h2>
        <span className="text-[12px] text-faint">Last 14 days</span>
        <ul
          className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1"
          aria-label="Legend"
        >
          {series.map((p) => (
            <li key={p} className="flex items-center gap-1.5 text-[12px] text-muted">
              <span
                className="size-2.5 rounded-[3px]"
                style={{ background: `var(--${p})` }}
                aria-hidden
              />
              {seriesName(p)}
            </li>
          ))}
        </ul>
      </header>

      <div className="mt-5 grid grid-cols-[28px_1fr] gap-x-2 pt-2" aria-hidden>
        <div className="relative h-44">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[10.5px] text-faint tabular-nums"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="relative h-44">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute inset-x-0 border-t border-line/70"
              style={{ bottom: `${(t / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[6px]">
            {days.map((d, i) => (
              <div
                key={d.day}
                className="relative flex h-full flex-1 cursor-default flex-col justify-end"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {hover === i && (
                  <span className="absolute inset-x-[-3px] inset-y-0 rounded-md bg-sunken" />
                )}
                <div
                  className="relative flex flex-col-reverse gap-[2px]"
                  style={{ height: `${(d.total / top) * 100}%` }}
                >
                  {series
                    .filter((p) => d.values[p])
                    .map((p, j, arr) => (
                      <span
                        key={p}
                        className={j === arr.length - 1 ? 'rounded-t-[4px]' : ''}
                        style={{
                          flexGrow: d.values[p],
                          flexBasis: 0,
                          background: `var(--${p})`,
                          minHeight: 2,
                        }}
                      />
                    ))}
                </div>
                {hover === i && (
                  <div
                    className={`pop-in pointer-events-none absolute bottom-full z-10 mb-2 w-40 rounded-xl border border-line bg-elev p-2.5 text-[12px] shadow-[0_12px_32px_-8px_rgb(0_0_0/0.25)] ${
                      i > 9 ? 'right-0' : i < 3 ? 'left-0' : 'left-1/2 -translate-x-1/2'
                    }`}
                  >
                    <div className="mb-1.5 flex justify-between font-semibold">
                      <span>{d.label}</span>
                      <span className="tabular-nums">{d.total}</span>
                    </div>
                    {series.map((p) => (
                      <div key={p} className="flex items-center gap-2 py-0.5 text-muted">
                        <span
                          className="size-2 rounded-[3px]"
                          style={{ background: `var(--${p})` }}
                        />
                        <span className="flex-1">{seriesName(p)}</span>
                        <span className="font-medium text-ink tabular-nums">
                          {d.values[p] ?? 0}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div />
        <div className="mt-1.5 flex gap-[6px]">
          {days.map((d, i) => (
            <span key={d.day} className="flex-1 text-center text-[10.5px] text-faint">
              {i % 2 === 1 || i === 13 ? d.label.replace(/^\w+ /, '') : ''}
            </span>
          ))}
        </div>
      </div>

      <table className="sr-only">
        <caption>Requests per day by provider</caption>
        <thead>
          <tr>
            <th>Day</th>
            {series.map((p) => (
              <th key={p}>{seriesName(p)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <td>{d.label}</td>
              {series.map((p) => (
                <td key={p}>{d.values[p] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function niceStep(max: number): number {
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
}

/* ── Recent runs ─────────────────────────────────────────────────────── */

const SOURCE: Record<AgentRun['source'], string> = {
  chat: 'Chat',
  council: 'Council',
  project: 'Project',
};
const ROLE: Record<string, string> = {
  chat: 'answer',
  synthesizer: 'merge',
  planner: 'plan',
  builder: 'build',
  reviewer: 'review',
  tester: 'test',
};

function RecentRuns({ runs }: { runs: AgentRun[] }) {
  return (
    <section
      aria-label="Recent requests"
      className="mt-6 overflow-hidden rounded-2xl border border-line bg-panel shadow-card"
    >
      <header className="border-b border-line px-5 py-3">
        <h2 className="text-[13.5px] font-semibold">Recent requests</h2>
      </header>
      {runs.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-muted">
          Nothing yet. Chats, councils and projects show up here.
        </p>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] tracking-wide text-faint uppercase">
              <th className="px-5 py-2 font-medium">When</th>
              <th className="py-2 font-medium">Who</th>
              <th className="py-2 font-medium">For</th>
              <th className="py-2 text-right font-medium">New tokens</th>
              <th className="py-2 text-right font-medium">Cached</th>
              <th className="py-2 text-right font-medium">Time</th>
              <th className="w-10 py-2 pr-5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-sunken/60">
                <td className="px-5 py-2 whitespace-nowrap text-muted tabular-nums">
                  {clock(r.at)}
                </td>
                <td className="py-2">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <ProviderDot provider={r.provider} size={7} />
                    {providerName(r.provider)}
                    {r.model && <span className="font-normal text-faint">{r.model}</span>}
                    {r.effort && <span className="font-normal text-faint">· {r.effort}</span>}
                  </span>
                </td>
                <td className="py-2 text-muted">
                  {SOURCE[r.source]} · {ROLE[r.role] ?? r.role}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {compactNumber(Math.max(0, r.inputTokens - r.cachedTokens) + r.outputTokens)}
                </td>
                <td className="py-2 text-right text-muted tabular-nums">
                  {compactNumber(r.cachedTokens)}
                </td>
                <td className="py-2 text-right text-muted tabular-nums">{elapsed(r.durationMs)}</td>
                <td className="py-2 pr-5 text-right">
                  {r.rateLimited ? (
                    <AlertTriangle
                      className="ml-auto size-3.5 text-warn"
                      aria-label="Hit a usage limit"
                    />
                  ) : r.ok ? (
                    <CheckCircle2 className="ml-auto size-3.5 text-ok" aria-label="Succeeded" />
                  ) : (
                    <XCircle className="ml-auto size-3.5 text-danger" aria-label="Failed" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
