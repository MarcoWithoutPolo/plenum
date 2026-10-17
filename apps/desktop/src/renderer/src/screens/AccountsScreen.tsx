import { useEffect, useState } from 'react';
import { Download, ExternalLink, LogIn, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ProviderInfo, QuotaInfo } from '../../../shared/api';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import { Badge, Button, ProviderDot } from '@/components/bits';

export function AccountsScreen() {
  const providers = useApp((s) => s.providers);
  const quotas = useApp((s) => s.quotas);
  const refresh = useApp((s) => s.refreshProviders);
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    await refresh();
    setChecking(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight">Accounts</h1>
              <p className="mt-1 text-[13.5px] text-muted">
                Conclave works through the official command-line tools for each AI service, signed
                in to your own subscription.
              </p>
            </div>
            <Button onClick={recheck} disabled={checking}>
              <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
              Check again
            </Button>
          </div>

          <div className="mt-6 flex items-start gap-3 rounded-xl border border-line bg-sunken px-4 py-3 text-[13px] text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            <p>
              You sign in on each provider's own page. Conclave never sees or stores your passwords,
              API keys or tokens. Each CLI keeps its own credentials.
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-3">
            {providers.map((p) => (
              <ProviderCard
                key={p.provider}
                info={p}
                quotas={quotas.filter((q) => q.provider === p.provider)}
                onChanged={recheck}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  info,
  quotas,
  onChanged,
}: {
  info: ProviderInfo;
  quotas: QuotaInfo[];
  onChanged: () => Promise<void>;
}) {
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState<'signin' | 'install' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [log, setLog] = useState('');

  useEffect(
    () =>
      api().onInstallLog((l) => {
        if (l.provider === info.provider) setLog((prev) => (prev + l.text).slice(-6000));
      }),
    [info.provider],
  );

  const signedIn = info.auth === 'signed_in';
  const status = !info.installed
    ? { tone: 'neutral' as const, text: 'Not installed' }
    : signedIn
      ? { tone: 'ok' as const, text: 'Connected' }
      : info.auth === 'signed_out'
        ? { tone: 'warn' as const, text: 'Signed out' }
        : { tone: 'warn' as const, text: 'Not connected' };

  const signIn = async () => {
    setBusy('signin');
    const result = await api().accounts.signIn(info.provider);
    setBusy(null);
    if (result.opened) {
      setNote('A terminal window opened with the sign-in. Finish there, then press Check again.');
    } else {
      showToast('error', `Couldn't open a terminal: ${result.error ?? 'unknown error'}`);
    }
  };

  const install = async () => {
    setBusy('install');
    setLog('');
    const result = await api().accounts.install(info.provider);
    setBusy(null);
    if (result.cancelled) return;
    if (result.ok) {
      setNote('Installed. Now sign in.');
      await onChanged();
    } else {
      showToast('error', `Install failed: ${result.error ?? 'unknown error'}`);
    }
  };

  return (
    <section
      aria-label={info.displayName}
      className="rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <div className="flex items-start gap-3.5">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken">
          <ProviderDot provider={info.provider} size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">{info.displayName}</h2>
            <Badge tone={status.tone}>{status.text}</Badge>
            {info.version && <span className="text-[12px] text-faint">v{info.version}</span>}
          </div>
          <p className="selectable mt-0.5 text-[13px] text-muted">
            {info.detail ??
              (info.installed
                ? info.loginHint
                : `Install the official CLI to use ${info.displayName}.`)}
          </p>
          {signedIn && quotas.length > 0 && <QuotaBars quotas={quotas} />}
          {note && <p className="mt-2 text-[12.5px] text-accent-ink">{note}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!info.installed && info.installPackage && (
            <Button variant="primary" onClick={install} disabled={busy !== null}>
              <Download className="size-3.5" />
              {busy === 'install' ? 'Installing…' : 'Install'}
            </Button>
          )}
          {info.installed && (
            <Button
              variant={signedIn ? 'secondary' : 'primary'}
              onClick={signIn}
              disabled={busy !== null}
            >
              <LogIn className="size-3.5" />
              {signedIn ? 'Switch account' : 'Sign in'}
            </Button>
          )}
        </div>
      </div>
      {info.provider === 'gemini' && !signedIn && info.installed && (
        <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-muted">
          Google no longer accepts personal sign-ins from the Gemini CLI. Set{' '}
          <code>GEMINI_API_KEY</code> in your environment and restart Conclave.
          <button
            type="button"
            onClick={() => void api().openExternal('https://aistudio.google.com/apikey')}
            className="ml-1 inline-flex items-center gap-1 text-accent-ink hover:underline"
          >
            Get a key <ExternalLink className="size-3" />
          </button>
        </p>
      )}
      {log && (
        <pre className="selectable mt-3 max-h-40 overflow-auto rounded-lg border border-line bg-sunken p-2.5 font-mono text-[11.5px] text-muted">
          {log}
        </pre>
      )}
    </section>
  );
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly',
  limit: 'Limit reached',
};

function QuotaBars({ quotas }: { quotas: QuotaInfo[] }) {
  return (
    <div className="mt-3 grid max-w-md grid-cols-2 gap-3">
      {quotas.map((q) => {
        const pct = Math.round((q.utilization ?? 0) * 100);
        return (
          <div key={q.window}>
            <div className="flex justify-between text-[11.5px] text-muted">
              <span>{WINDOW_NAMES[q.window] ?? q.window}</span>
              <span>{pct}% used</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, background: pct > 85 ? 'var(--warn)' : 'var(--accent)' }}
              />
            </div>
            {q.resetsAt && (
              <div className="mt-0.5 text-[11px] text-faint">
                Resets{' '}
                {new Date(q.resetsAt).toLocaleString([], {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
