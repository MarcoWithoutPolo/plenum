import type { ReactNode } from 'react';
import type { ProviderId, Usage } from '@conclave/shared';

export function ProviderDot({ provider, size = 8 }: { provider: ProviderId; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: `var(--${provider})` }}
    />
  );
}

export function Thinking({ label = 'Thinking' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted" role="status">
      <span className="thinking" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';
  children: ReactNode;
}) {
  const tones = {
    neutral: 'bg-sunken text-muted border-line',
    ok: 'bg-ok-soft text-ok border-transparent',
    warn: 'bg-warn-soft text-warn border-transparent',
    danger: 'bg-danger-soft text-danger border-transparent',
    accent: 'bg-accent-soft text-accent-ink border-transparent',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  const variants = {
    primary: 'bg-accent text-white hover:brightness-110 border-transparent',
    secondary: 'bg-panel text-ink border-line-strong hover:bg-sunken',
    ghost: 'bg-transparent text-muted border-transparent hover:bg-sunken hover:text-ink',
    danger: 'bg-transparent text-danger border-line-strong hover:bg-danger-soft',
  };
  const sizes = { sm: 'h-7 px-2 text-[12.5px] gap-1.5', md: 'h-8.5 px-3 text-[13px] gap-2' };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
    />
  );
}

export function formatStats(durationMs: number | null | undefined, usage?: Usage | null): string {
  const parts: string[] = [];
  if (durationMs) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens) parts.push(`${tokens.toLocaleString()} tokens`);
  return parts.join(' · ');
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
