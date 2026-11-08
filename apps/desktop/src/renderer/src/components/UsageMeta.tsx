import { useId, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { Usage } from '@plenum/shared';

export function compactNumber(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function split(usage: Usage | null | undefined) {
  const cached = usage?.cachedInputTokens ?? 0;
  const freshIn = Math.max(0, (usage?.inputTokens ?? 0) - cached);
  const out = usage?.outputTokens ?? 0;
  return { cached, freshIn, out, total: cached + freshIn + out };
}

/** "4.6s · 2.1k tokens", with a card that breaks the tokens down on hover or focus. */
export function UsageMeta({
  durationMs,
  usage,
  align = 'left',
}: {
  durationMs: number | null | undefined;
  usage: Usage | null | undefined;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { cached, freshIn, out, total } = split(usage);
  const fresh = freshIn + out;
  const time = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';
  if (!time && !total) return null;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex cursor-default items-center gap-1.5 rounded-md px-1 text-faint outline-none hover:text-muted focus-visible:text-muted"
      >
        {time && <span>{time}</span>}
        {time && fresh > 0 && <span aria-hidden>·</span>}
        {fresh > 0 && <span>{compactNumber(fresh)} tokens</span>}
      </button>
      {open && total > 0 && (
        <span
          role="tooltip"
          id={id}
          className={`pop-in absolute top-full z-50 mt-1.5 w-64 origin-top rounded-xl border border-line bg-elev p-3 text-[12px] text-ink shadow-[0_12px_32px_-8px_rgb(0_0_0/0.25)] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <span className="mb-2 flex items-baseline justify-between">
            <span className="font-semibold">Token usage</span>
            <span className="text-faint">{total.toLocaleString()} total</span>
          </span>
          <span className="mb-2.5 flex h-1.5 overflow-hidden rounded-full bg-sunken">
            <Bar part={freshIn} total={total} color="var(--accent)" />
            <Bar part={out} total={total} color="var(--ok)" />
            <Bar part={cached} total={total} color="var(--border-strong)" />
          </span>
          {freshIn > 0 && <Row color="var(--accent)" label="New input" value={freshIn} />}
          {out > 0 && <Row color="var(--ok)" label="Output" value={out} />}
          {cached > 0 && (
            <Row color="var(--border-strong)" label="Read from cache" value={cached} />
          )}
          {cached > 0 && (
            <span className="mt-2 block border-t border-line pt-2 leading-snug text-muted">
              Cached tokens are mostly the CLI's own instructions, reused on every request. They
              count for much less against your plan.
            </span>
          )}
          {usage?.costUsd !== undefined && (
            <span className="mt-2 flex justify-between border-t border-line pt-2 text-muted">
              <span>API list-price equivalent</span>
              <span className="font-medium text-ink">${usage.costUsd.toFixed(4)}</span>
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function Bar({ part, total, color }: { part: number; total: number; color: string }) {
  if (!part) return null;
  return (
    <span className="h-full" style={{ width: `${(part / total) * 100}%`, background: color }} />
  );
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-2 py-0.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      <span className="flex-1 text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value.toLocaleString()}</span>
    </span>
  );
}

/** Small "⚙ low" tag shown on replies that used a non-default effort. */
export function EffortTag({ effort }: { effort: string | null | undefined }) {
  if (!effort) return null;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full border border-line bg-sunken px-1.5 text-[11px] font-medium text-muted">
      <Gauge className="size-3" aria-hidden />
      {effort}
    </span>
  );
}
