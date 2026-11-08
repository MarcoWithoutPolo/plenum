import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  ExternalLink,
  Hourglass,
  LogIn,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { GitHubStatus } from '@plenum/core';
import {
  LOCAL_LIBRARY,
  providerEntry,
  type AppSettings,
  type ProviderId,
  type Seat,
} from '@plenum/shared';
import type { ProviderInfo, QuotaInfo } from '../../../shared/api';
import { api } from '@/lib/api';
import { errorText, readyProviders, useApp } from '@/lib/store';
import { Badge, Button, GitHubMark, ProviderDot } from '@/components/bits';
import { PlanUsage, relative } from '@/components/PlanUsage';
import { Popover } from '@/components/Popover';
import { SeatPicker, modelLabel } from '@/components/SeatPicker';
import { Switch } from '@/components/form';
import { progressLine } from './FirstRun';
import { settle } from '@/lib/settle';

/** How often the screen refreshes plan usage while you look at it. */
const REFRESH_MS = 60_000;
/** After a sign-in starts: check every few seconds until it lands (or give up after two minutes). */
const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_WAIT_MS = 120_000;

/**
 * Accounts (v1.0 F1): one card per AI, always the same sections in the same order, kept fresh
 * while you look at it, with that AI's default model and effort on it (F2).
 */
export function AccountsScreen() {
  const providers = useApp((s) => s.providers);
  const quotas = useApp((s) => s.quotas);
  const refresh = useApp((s) => s.refreshProviders);
  const chatDefault = useApp((s) => s.chatDefault);
  const setChatDefault = useApp((s) => s.setChatDefault);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(Date.now());
  const [github, setGithub] = useState<GitHubStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [announce, setAnnounce] = useState('');
  const [, tick] = useState(0);

  const checkGithub = () =>
    api()
      .github.status()
      .then(setGithub)
      .catch(() => setGithub({ installed: false, signedIn: false, detail: 'gh did not start' }));

  const recheck = async () => {
    setChecking(true);
    try {
      await Promise.all([refresh(), checkGithub()]);
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    // Fresh status every visit, and plan usage every minute while the screen is open.
    settle(recheck());
    settle(api().settings.get().then(setSettings));
    const every = window.setInterval(() => settle(recheck()), REFRESH_MS);
    // "Checked 20 s ago" keeps counting.
    const clock = window.setInterval(() => tick((n) => n + 1), 5_000);
    return () => {
      window.clearInterval(every);
      window.clearInterval(clock);
    };
  }, []);

  // Say it out loud when an AI connects or drops out (screen readers).
  const seen = useRef(new Map<ProviderId, string>());
  useEffect(() => {
    const changes: string[] = [];
    for (const p of providers) {
      const was = seen.current.get(p.provider);
      if (was && was !== p.auth)
        changes.push(`${p.displayName} ${p.auth === 'signed_in' ? 'connected' : 'signed out'}`);
      seen.current.set(p.provider, p.auth);
    }
    if (changes.length) setAnnounce(changes.join('. '));
  }, [providers]);

  const yours = providers
    .filter((p) => p.installed)
    .sort((a, b) => Number(b.auth === 'signed_in') - Number(a.auth === 'signed_in'));
  const toAdd = providers.filter((p) => !p.installed);
  const connected = readyProviders(providers);
  const signedOut = yours.length - connected.length;
  const summary = [
    `${connected.length} connected`,
    signedOut > 0 && `${signedOut} signed out`,
    toAdd.length > 0 && `${toAdd.length} you can add`,
  ]
    .filter(Boolean)
    .join(' · ');

  const saveDefault = async (provider: ProviderId, seat: Seat | null) => {
    const next = await api().settings.update({
      defaults: {
        providers: {
          ...settings?.defaults.providers,
          [provider]: seat
            ? {
                ...(seat.model && { model: seat.model }),
                ...(seat.effort && { effort: seat.effort }),
              }
            : {},
        },
      },
    });
    setSettings(next);
  };

  const sharedPlan = Boolean(
    settings?.limits.sharedPlans.some((g) => g.includes('cursor') && g.includes('grok')),
  );
  /** F12: one plan for Cursor and Grok; Cursor then defaults to a Grok model (I5). */
  const saveSharedPlan = async (on: boolean) => {
    const others = (settings?.limits.sharedPlans ?? []).filter(
      (g) => !(g.includes('cursor') && g.includes('grok')),
    );
    const cursor = providers.find((p) => p.provider === 'cursor');
    const grokModel = cursor?.models.find((m) => /grok/i.test(m.id))?.id;
    const own = settings?.defaults.providers.cursor;
    const next = await api().settings.update({
      limits: { sharedPlans: on ? [...others, ['cursor', 'grok']] : others },
      ...(on &&
        grokModel &&
        !own?.model && {
          defaults: {
            providers: { ...settings?.defaults.providers, cursor: { ...own, model: grokModel } },
          },
        }),
    });
    setSettings(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight">Accounts</h1>
              <p className="mt-1 text-[13.5px] text-muted">{summary}</p>
              {connected.length === 1 && (
                <p className="mt-1 text-[12.5px] text-muted">{progressLine(1)}</p>
              )}
            </div>
            <span className="text-[12.5px] text-faint" aria-live="off">
              {checking ? 'Checking…' : `Checked ${relative(checkedAt, 'past')}`}
            </span>
            <Button onClick={() => settle(recheck())} disabled={checking}>
              <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
              Check all
            </Button>
          </div>

          <p className="sr-only" aria-live="polite">
            {announce}
          </p>

          {connected.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
              <span className="text-[13.5px] font-medium">Start new chats with</span>
              <ChatDefault
                connected={connected}
                value={chatDefault}
                onChange={(p) => settle(setChatDefault(p))}
              />
              <span className="text-[12.5px] text-faint">
                Councils start with every connected AI.
              </span>
            </div>
          )}

          <div className="mt-4 flex items-start gap-3 rounded-xl border border-line bg-sunken px-4 py-3 text-[13px] text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
            <p>
              You sign in on each provider's own page. Plenum never sees or stores your passwords,
              API keys or tokens. Each CLI keeps its own credentials.
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-3">
            {yours.map((p) => (
              <ProviderCard
                key={p.provider}
                info={p}
                quotas={quotas.filter((q) => q.provider === p.provider)}
                own={settings?.defaults.providers[p.provider]}
                onDefault={(seat) => saveDefault(p.provider, seat)}
                onChanged={recheck}
              />
            ))}
          </div>

          {yours.some((p) => p.provider === 'cursor') &&
            yours.some((p) => p.provider === 'grok') && (
              <label className="mt-3 flex cursor-pointer items-center gap-4 rounded-2xl border border-line bg-panel px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium">
                    Cursor and Grok share one plan
                  </span>
                  <span className="block text-[12px] text-faint">
                    Turn this on if both come with The X Subscription. A usage limit on one then
                    pauses both, and Cursor uses a Grok model unless you choose another. Cursor's
                    Claude and GPT models are billed per use.
                  </span>
                </span>
                <Switch
                  label="Cursor and Grok share one plan"
                  disabled={!settings}
                  checked={sharedPlan}
                  onChange={(on) => settle(saveSharedPlan(on))}
                />
              </label>
            )}

          {toAdd.length > 0 && (
            <>
              <h2 className="mt-8 text-[12px] font-semibold tracking-wide text-muted uppercase">
                AIs you can add
              </h2>
              <p className="mt-1 text-[12.5px] text-muted">
                Each one joins chats, councils and project teams once its CLI is installed and
                signed in to your account.
              </p>
              <ul className="mt-3 flex flex-col rounded-2xl border border-line bg-panel">
                {toAdd.map((p) => (
                  <AddRow key={p.provider} info={p} onChanged={recheck} />
                ))}
              </ul>
            </>
          )}

          <h2 className="mt-8 text-[12px] font-semibold tracking-wide text-muted uppercase">
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

/** Which AI new chats start with: one of the connected ones, or the last one you used. */
export function ChatDefault({
  connected,
  value,
  onChange,
}: {
  connected: ProviderInfo[];
  value: ProviderId | null;
  onChange: (p: ProviderId | null) => void;
}) {
  const current = connected.find((p) => p.provider === value);
  const options: { id: ProviderId | null; label: string }[] = [
    { id: null, label: 'The one I used last' },
    ...connected.map((p) => ({ id: p.provider, label: p.displayName })),
  ];
  return (
    <Popover
      label="Start new chats with"
      width={260}
      trigger={({ ref, toggle, open, ...aria }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          {...aria}
          aria-label={`${current?.displayName ?? 'The one I used last'}, the AI chats start with`}
          className={`inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] font-medium ${
            open
              ? 'border-accent/50 bg-accent-soft text-accent-ink'
              : 'border-line-strong bg-panel hover:bg-sunken'
          }`}
        >
          {current && <ProviderDot provider={current.provider} />}
          {current?.displayName ?? 'The one I used last'}
        </button>
      )}
    >
      {(close) => (
        <ul role="listbox" aria-label="Start new chats with" className="flex flex-col p-1.5">
          {options.map((o) => (
            <li key={o.id ?? 'last'}>
              <button
                type="button"
                role="option"
                aria-selected={o.id === value}
                onClick={() => {
                  onChange(o.id);
                  close();
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
                  o.id === value ? 'bg-accent-soft font-medium text-accent-ink' : 'hover:bg-sunken'
                }`}
              >
                {o.id && <ProviderDot provider={o.id} />}
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

/** A status says it in words and an icon, never by color alone. */
export function Status({ info }: { info: ProviderInfo }) {
  if (info.auth === 'signed_in' && info.limit)
    return (
      <Badge tone="warn">
        <Hourglass className="size-3" aria-hidden /> Out of usage
      </Badge>
    );
  if (info.auth === 'signed_in')
    return (
      <Badge tone="ok">
        <CheckCircle2 className="size-3" aria-hidden /> Connected
      </Badge>
    );
  if (info.auth === 'signed_out')
    return (
      <Badge tone="warn">
        <AlertTriangle className="size-3" aria-hidden /> Signed out
      </Badge>
    );
  return (
    <Badge tone="warn">
      <CircleDashed className="size-3" aria-hidden /> Not connected
    </Badge>
  );
}

/**
 * One installed AI. The same sections, in the same order, for every AI: who it is and its
 * state; its defaults; plan usage; then the actions.
 */
function ProviderCard({
  info,
  quotas,
  own,
  onDefault,
  onChanged,
}: {
  info: ProviderInfo;
  quotas: QuotaInfo[];
  own: { model?: string; effort?: string } | undefined;
  onDefault: (seat: Seat | null) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const refresh = useApp((s) => s.refreshProviders);
  const [busy, setBusy] = useState<'signin' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const signedIn = info.auth === 'signed_in';
  const entry = providerEntry(info.provider);
  const docs = entry?.install?.docs;
  const name = `account-${info.provider}`;

  // While a sign-in runs in the terminal, look every few seconds so the card turns green by
  // itself when it's done.
  const polling = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(polling.current), []);
  useEffect(() => {
    if (signedIn && polling.current) {
      window.clearInterval(polling.current);
      polling.current = undefined;
      setNote(null);
    }
  }, [signedIn]);

  // Every outcome is shown on the card, and the buttons always work again (U7).
  const signIn = async () => {
    setBusy('signin');
    setProblem(null);
    try {
      const result = await api().accounts.signIn(info.provider);
      if (result.opened) {
        setNote('A terminal window opened with the sign-in. This card updates when it’s done.');
        const started = Date.now();
        window.clearInterval(polling.current);
        polling.current = window.setInterval(() => {
          if (Date.now() - started > SIGN_IN_WAIT_MS) {
            window.clearInterval(polling.current);
            polling.current = undefined;
            setNote('Finished signing in? Press Check to update this card.');
          } else settle(refresh());
        }, SIGN_IN_POLL_MS);
      } else {
        setProblem(`Couldn't open a terminal: ${result.error ?? 'unknown error'}`);
      }
    } catch (err) {
      setProblem(`Couldn't start the sign-in: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const seat: Seat = {
    provider: info.provider,
    ...(own?.model && { model: own.model }),
    ...(own?.effort && { effort: own.effort }),
  };
  const hasDefault = Boolean(own?.model || own?.effort);
  const ownModelGone =
    own?.model && info.models.length > 0 && !info.models.some((m) => m.id === own.model);

  return (
    <section
      aria-labelledby={name}
      className="rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <div className="flex items-start gap-3.5">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken">
          <ProviderDot provider={info.provider} size={12} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={name} className="text-[15px] font-semibold">
              {info.displayName}
            </h2>
            <Status info={info} />
            {info.version && <span className="text-[12px] text-faint">v{info.version}</span>}
          </div>
          <p className="selectable mt-0.5 text-[13px] text-muted">
            {signedIn
              ? [info.detail, info.models.length > 0 && `${info.models.length} models`]
                  .filter(Boolean)
                  .join(' · ')
              : (info.loginHint ?? 'Sign in with your own account to use it.')}
          </p>
          {signedIn && info.limit && (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-warn">
              <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="selectable">
                Out of usage since {relative(info.limit.at, 'past')}: {info.limit.message}
              </span>
            </p>
          )}
        </div>
      </div>

      {signedIn && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-4 py-3">
          <span className="text-[12px] font-semibold tracking-wide text-muted uppercase">
            Default model
          </span>
          <SeatPicker
            value={seat}
            lockProvider={info.provider}
            label={`${info.displayName} default model`}
            onChange={(s) => settle(onDefault(s))}
            trigger={({ ref, toggle, open, seat: s, ...aria }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                {...aria}
                aria-label={`${hasDefault ? modelLabel(info, s.model) : 'Uses the CLI’s own setting'}${s.effort ? ` · ${s.effort}` : ''}, ${info.displayName} default model`}
                className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium ${
                  open
                    ? 'border-accent/50 bg-accent-soft text-accent-ink'
                    : 'border-line-strong bg-panel hover:bg-sunken'
                }`}
              >
                <span className="truncate">
                  {hasDefault ? modelLabel(info, s.model) : 'Uses the CLI’s own setting'}
                </span>
                {s.effort && <span className="font-normal"> · {s.effort}</span>}
              </button>
            )}
          />
          {hasDefault && (
            <Button size="sm" onClick={() => settle(onDefault(null))}>
              <RotateCcw className="size-3.5" /> Use the CLI’s setting
            </Button>
          )}
          <p className="w-full text-[12px] text-muted">
            {ownModelGone
              ? `${own?.model} isn’t in ${info.displayName}’s list any more; its own setting is used until you choose another.`
              : 'Used wherever a chat, council or team seat is left on “Default”.'}
          </p>
        </div>
      )}

      {signedIn &&
        (quotas.length > 0 ? (
          <PlanUsage quotas={quotas} />
        ) : (
          <p className="mt-3 rounded-xl border border-line px-4 py-3 text-[12.5px] text-muted">
            Plan usage: {info.displayName} doesn’t report it. Set a daily cap in Settings if you
            want a limit.
          </p>
        ))}

      {signedIn && entry?.cost === 'free-local' && (
        <ModelLibrary have={info.models.map((m) => m.id)} onPulled={onChanged} />
      )}

      {note && <p className="mt-3 text-[12.5px] text-accent-ink">{note}</p>}
      {problem && (
        <p role="alert" className="mt-3 text-[12.5px] text-danger">
          {problem}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant={signedIn ? 'secondary' : 'primary'}
          onClick={() => settle(signIn())}
          disabled={busy !== null}
        >
          <LogIn className="size-3.5" />
          {busy === 'signin' ? 'Opening…' : signedIn ? 'Switch account' : 'Sign in'}
        </Button>
        <Button onClick={() => settle(onChanged())}>
          <RefreshCw className="size-3.5" /> Check
        </Button>
        {docs && (
          <Button onClick={() => settle(api().openExternal(docs))}>
            <ExternalLink className="size-3.5" /> Docs
          </Button>
        )}
      </div>
    </section>
  );
}

/** An AI you could add: what it costs, how to install it on this computer, and Install. */
const NODE_DOWNLOAD = 'https://nodejs.org/en/download';

export function AddRow({
  info,
  onChanged,
}: {
  info: ProviderInfo;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const npmReady = useApp((s) => s.npmReady);
  const checkNpm = useApp((s) => s.checkNpm);
  const [checkingNpm, setCheckingNpm] = useState(false);
  const entry = providerEntry(info.provider);
  const needsNode = Boolean(info.installPackage) && npmReady === false;
  const setup = entry?.install;
  const script = api().platform === 'win32' ? setup?.script?.windows : setup?.script?.unix;

  useEffect(() => {
    if (info.installPackage && npmReady === null) settle(checkNpm());
  }, [info.installPackage, npmReady, checkNpm]);

  const checkAgain = async () => {
    setCheckingNpm(true);
    try {
      await checkNpm();
    } finally {
      setCheckingNpm(false);
    }
  };

  useEffect(
    () =>
      api().onInstallLog((l) => {
        if (l.provider === info.provider) setLog((prev) => (prev + l.text).slice(-6000));
      }),
    [info.provider],
  );

  const install = async () => {
    setBusy(true);
    setProblem(null);
    setLog('');
    try {
      const result = await api().accounts.install(info.provider);
      if (result.cancelled) return;
      if (result.ok) await onChanged();
      else setProblem(`Install failed: ${result.error ?? 'unknown error'}`);
    } catch (err) {
      setProblem(`Install failed: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ProviderDot provider={info.provider} />
        <span className="text-[14px] font-semibold">{info.displayName}</span>
        <span className="min-w-0 flex-1 text-[12.5px] text-muted">
          {entry ? COST[entry.cost] : ''}
        </span>
        {needsNode ? (
          <>
            <Button size="sm" onClick={() => settle(checkAgain())} disabled={checkingNpm}>
              {checkingNpm ? 'Checking…' : 'Check again'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              aria-label={`Get Node.js for ${info.displayName}`}
              onClick={() => settle(api().openExternal(NODE_DOWNLOAD))}
            >
              <ExternalLink className="size-3.5" /> Get Node.js
            </Button>
          </>
        ) : info.installPackage ? (
          <Button size="sm" variant="primary" onClick={() => settle(install())} disabled={busy}>
            <Download className="size-3.5" />
            {busy ? 'Installing…' : 'Install'}
          </Button>
        ) : (
          setup?.docs && (
            <Button size="sm" onClick={() => settle(api().openExternal(setup.docs!))}>
              <ExternalLink className="size-3.5" /> Install guide
            </Button>
          )
        )}
      </div>
      {entry?.blurb && <p className="mt-1 text-[12.5px] text-muted">{entry.blurb}</p>}
      {needsNode && (
        <p className="mt-1.5 text-[12.5px] text-muted">
          This one installs with Node.js, which isn't on this computer yet. It's free: install the
          LTS version, then come back here.
        </p>
      )}
      {!info.installPackage && script && (
        <p className="mt-1.5 text-[12.5px] text-muted">
          Install it with{' '}
          <code className="selectable rounded bg-sunken px-1 font-mono text-[12px]">{script}</code>,
          then sign in.{setup?.note && ` ${setup.note}`}
        </p>
      )}
      {problem && (
        <p role="alert" className="mt-1.5 text-[12.5px] text-danger">
          {problem}
        </p>
      )}
      {log && (
        <pre
          data-scroll-x
          className="selectable mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-sunken p-2.5 font-mono text-[11.5px] text-muted"
        >
          {log}
        </pre>
      )}
    </li>
  );
}

/** "Get more models": a few downloads, each through your confirmation. */
function ModelLibrary({ have, onPulled }: { have: string[]; onPulled: () => Promise<void> }) {
  const showToast = useApp((s) => s.showToast);
  const [pulling, setPulling] = useState<string | null>(null);
  const pull = async (id: string) => {
    setPulling(id);
    const result = await api().local.pull(id);
    setPulling(null);
    if (result.cancelled) return;
    if (result.ok) {
      showToast('info', `${id} is ready.`);
      await onPulled();
    } else showToast('error', result.error ?? `Couldn't download ${id}`);
  };
  return (
    <div className="mt-3 border-t border-line pt-3">
      <h3 className="text-[12.5px] font-semibold text-muted">Get more models</h3>
      <ul className="mt-1.5 flex flex-col">
        {LOCAL_LIBRARY.map((m) => {
          const got = have.includes(m.id);
          return (
            <li key={m.id} className="flex items-center gap-3 py-1.5 text-[12.5px]">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{m.label}</span>
                <span className="text-faint"> · {m.sizeGb} GB</span>
                <span className="block truncate text-[12px] text-muted" title={m.use}>
                  {m.use}
                </span>
              </span>
              {got ? (
                <Badge tone="ok">Downloaded</Badge>
              ) : (
                <Button size="sm" onClick={() => settle(pull(m.id))} disabled={pulling !== null}>
                  <Download className="size-3.5" />
                  {pulling === m.id ? 'Downloading…' : 'Download'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {pulling && (
        <p className="mt-1 text-[12px] text-faint">
          Ollama's progress shows below. You can keep using Plenum meanwhile.
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {pulling ? `Downloading ${pulling}` : ''}
      </span>
    </div>
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
            <Button onClick={() => settle(api().openExternal('https://cli.github.com/'))}>
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
