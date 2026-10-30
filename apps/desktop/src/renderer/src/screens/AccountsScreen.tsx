import { useEffect, useState } from 'react';
import { Download, ExternalLink, Hourglass, LogIn, RefreshCw, ShieldCheck } from 'lucide-react';
import type { GitHubStatus } from '@conclave/core';
import { providerEntry } from '@conclave/shared';
import type { ProviderInfo, QuotaInfo } from '../../../shared/api';
import { api } from '@/lib/api';
import { useApp } from '@/lib/store';
import { Badge, Button, GitHubMark, ProviderDot } from '@/components/bits';
import { PlanUsage, relative } from '@/components/PlanUsage';

export function AccountsScreen() {
  const providers = useApp((s) => s.providers);
  const quotas = useApp((s) => s.quotas);
  const refresh = useApp((s) => s.refreshProviders);
  const [checking, setChecking] = useState(false);
  const [github, setGithub] = useState<GitHubStatus | null>(null);

  const checkGithub = () =>
    api()
      .github.status()
      .then(setGithub)
      .catch(() => setGithub({ installed: false, signedIn: false, detail: 'gh did not start' }));
  useEffect(() => {
    void checkGithub();
    // Fresh status every visit: sign-ins and usage limits change while the app is open.
    void refresh();
  }, []);

  // Installed AIs first (connected before signed out), then the ones you could add.
  const yours = providers
    .filter((p) => p.installed)
    .sort((a, b) => Number(b.auth === 'signed_in') - Number(a.auth === 'signed_in'));
  const toAdd = providers.filter((p) => !p.installed);

  const recheck = async () => {
    setChecking(true);
    await Promise.all([refresh(), checkGithub()]);
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
            {yours.map((p) => (
              <ProviderCard
                key={p.provider}
                info={p}
                quotas={quotas.filter((q) => q.provider === p.provider)}
                onChanged={recheck}
              />
            ))}
          </div>

          {toAdd.length > 0 && (
            <>
              <h2 className="mt-8 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                AIs you can add
              </h2>
              <p className="mt-1 text-[12.5px] text-muted">
                Each one joins chats, councils and project teams once its CLI is installed and
                signed in to your account.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {toAdd.map((p) => (
                  <ProviderCard key={p.provider} info={p} quotas={[]} onChanged={recheck} />
                ))}
              </div>
            </>
          )}

          <h2 className="mt-8 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
            Code hosting
          </h2>
          <div className="mt-2">
            <GitHubCard status={github} />
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
  const entry = providerEntry(info.provider);
  const setup = entry?.install;
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
            {info.installed
              ? (info.detail ?? info.loginHint)
              : (entry?.blurb ?? `Install the official CLI to use ${info.displayName}.`)}
          </p>
          {!info.installed && entry && (
            <p className="mt-1 text-[12px] text-faint">{COST[entry.cost]}</p>
          )}
          {note && <p className="mt-2 text-[12.5px] text-accent-ink">{note}</p>}
          {signedIn && info.limit && (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-warn">
              <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="selectable">
                Out of usage since {relative(info.limit.at, 'past')}: {info.limit.message}
              </span>
            </p>
          )}
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
      {signedIn && <Facts info={info} />}
      {signedIn && quotas.length > 0 && <PlanUsage quotas={quotas} />}
      {!info.installed && setup?.script?.windows && !setup.npm && (
        <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-muted">
          Install it from PowerShell with{' '}
          <code className="selectable rounded bg-sunken px-1 font-mono text-[12px]">
            {setup.script.windows}
          </code>
          , then press Sign in.{setup.note && ` ${setup.note}`}
          {setup.docs && (
            <button
              type="button"
              onClick={() => void api().openExternal(setup.docs!)}
              className="ml-1 inline-flex items-center gap-1 text-accent-ink hover:underline"
            >
              Install guide <ExternalLink className="size-3" />
            </button>
          )}
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

const COST = {
  plan: 'Uses your own subscription with that company',
  credits: 'Pays per use, from credits you buy',
  'free-local': 'Free: runs on your own hardware',
} as const;

/** GitHub through the official gh CLI: optional, for cloning, issues and pull requests. */
function GitHubCard({ status }: { status: GitHubStatus | null }) {
  const showToast = useApp((s) => s.showToast);
  const [note, setNote] = useState<string | null>(null);
  const badge = !status
    ? { tone: 'neutral' as const, text: 'Checking…' }
    : status.signedIn
      ? { tone: 'ok' as const, text: 'Connected' }
      : status.installed
        ? { tone: 'warn' as const, text: 'Not connected' }
        : { tone: 'neutral' as const, text: 'Not installed' };
  return (
    <section
      aria-label="GitHub"
      className="rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <div className="flex items-start gap-3.5">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken">
          <GitHubMark className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">GitHub</h2>
            <Badge tone={badge.tone}>{badge.text}</Badge>
            {status?.version && (
              <span className="text-[12px] text-faint">gh v{status.version}</span>
            )}
          </div>
          <p className="selectable mt-0.5 text-[13px] text-muted">
            {status?.signedIn
              ? `${status.detail}. Clone repositories, start from issues and finish with pull requests.`
              : status?.installed
                ? 'Sign in to clone your repositories and open pull requests. Optional.'
                : 'Optional. Install the GitHub CLI (gh) to clone repositories and open pull requests.'}
          </p>
          {status?.signedIn && status.scopes && status.scopes.length > 0 && (
            <p className="mt-1 text-[12px] text-faint">Scopes: {status.scopes.join(', ')}</p>
          )}
          {note && <p className="mt-2 text-[12.5px] text-accent-ink">{note}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status && !status.installed && (
            <Button onClick={() => void api().openExternal('https://cli.github.com/')}>
              <ExternalLink className="size-3.5" /> Get gh
            </Button>
          )}
          {status?.installed && (
            <Button
              variant={status.signedIn ? 'secondary' : 'primary'}
              onClick={async () => {
                const r = await api().github.signIn();
                if (r.opened) {
                  setNote(
                    'A terminal window opened with the GitHub sign-in. Finish there, then press Check again.',
                  );
                } else {
                  showToast('error', `Couldn't open a terminal: ${r.error ?? 'unknown error'}`);
                }
              }}
            >
              <LogIn className="size-3.5" />
              {status.signedIn ? 'Switch account' : 'Sign in'}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function Facts({ info }: { info: ProviderInfo }) {
  const facts = [
    info.defaultModel && {
      label: 'Default model',
      value: info.models.find((m) => m.id === info.defaultModel)?.label ?? info.defaultModel,
    },
    info.defaultEffort && {
      label: 'Reasoning',
      value: info.defaultEffort[0]!.toUpperCase() + info.defaultEffort.slice(1),
    },
    info.models.length > 0 && {
      label: 'Models',
      value: `${info.models.length} available`,
    },
    (info.efforts?.length ?? 0) > 0 &&
      !info.defaultEffort && {
        label: 'Reasoning',
        value: `${info.efforts!.length} effort levels`,
      },
  ].filter(Boolean) as { label: string; value: string }[];
  if (facts.length === 0) return null;
  return (
    <dl className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
      {facts.map((f) => (
        <div key={f.label} className="rounded-xl border border-line bg-sunken/70 px-3 py-2">
          <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">{f.label}</dt>
          <dd className="mt-0.5 truncate text-[13px] font-medium">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
