import { useEffect, useRef, useState } from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';
import { preferred, type ProviderId, type Routing } from '@plenum/shared';
import type { ProviderInfo } from '../../../shared/api';
import { api } from '@/lib/api';
import { errorText, readyProviders, useApp } from '@/lib/store';
import { Button, ProviderDot } from '@/components/bits';
import { settle } from '@/lib/settle';
import { AddRow, ChatDefault, Status } from './AccountsScreen';

/** How long one sign-in may take before Sign in to all moves on to the next AI. */
const SIGN_IN_WAIT_MS = 3 * 60_000;
const POLL_MS = 1500;

/** What each extra AI adds (F7): from one AI, enough to start, to a real majority at three. */
const CAPABILITIES: { need: number; text: string }[] = [
  { need: 1, text: 'Chat and projects' },
  { need: 2, text: 'Councils: several AIs answer, one merged answer' },
  { need: 2, text: 'Reviews by a different AI than the one that built' },
  { need: 2, text: 'Work moves to another AI when one hits its limit' },
  { need: 3, text: 'Councils with a real majority, and a backup at every role' },
];

export function progressLine(n: number): string {
  if (n === 0) return 'Connect at least one AI to continue.';
  if (n === 1)
    return '1 connected: enough to start. Add one more for councils, independent reviews and limit backup.';
  if (n === 2)
    return '2 connected: councils, independent reviews and limit backup all work. A third gives councils a real majority.';
  return `${n} connected: everything works, with a backup at every role.`;
}

/** The Fast team from what's connected: each role's order from the registry's preferences. */
function teamFrom(connected: ProviderId[]): Routing {
  const order = (role: keyof Routing) =>
    preferred(role)
      .filter((p): p is ProviderId => connected.includes(p as ProviderId))
      .map((provider) => ({ provider }));
  return { planner: order('planner'), builder: order('builder'), reviewer: order('reviewer') };
}

/**
 * The first run (v1.0 F7): connect your AIs (one is enough, two or more is better), choose
 * which one new chats start with, and see the team projects will use. Shown once, on a new
 * install; "Look around first" leaves it for now.
 */
export function FirstRun({ onClose }: { onClose: () => void }) {
  const providers = useApp((s) => s.providers);
  const refresh = useApp((s) => s.refreshProviders);
  const chatDefault = useApp((s) => s.chatDefault);
  const setChatDefault = useApp((s) => s.setChatDefault);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  /** The AI being signed in to now, and the ones Sign in to all still has to do. */
  const [signing, setSigning] = useState<{ now: ProviderId; queue: ProviderId[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const installed = providers.filter((p) => p.installed);
  const toAdd = providers.filter((p) => !p.installed);
  const connected = readyProviders(providers);
  const ids = connected.map((p) => p.provider);
  const name = (id: ProviderId) => providers.find((p) => p.provider === id)?.displayName ?? id;

  useEffect(() => heading.current?.focus(), [step]);

  // Fresh state while the welcome is open, and quickly while a sign-in runs.
  useEffect(() => {
    settle(refresh());
    const t = window.setInterval(() => settle(refresh()), signing ? POLL_MS : 10_000);
    return () => window.clearInterval(t);
  }, [refresh, signing]);

  const startSignIn = async (provider: ProviderId, queue: ProviderId[]) => {
    setProblem(null);
    setSigning({ now: provider, queue });
    started.current = Date.now();
    try {
      const r = await api().accounts.signIn(provider);
      if (!r.opened) throw new Error(r.error ?? 'No terminal app found');
    } catch (err) {
      setProblem(`Couldn't open ${name(provider)}'s sign-in: ${errorText(err)}`);
      next(queue);
    }
  };
  const next = (queue: ProviderId[]) => {
    const [head, ...rest] = queue;
    if (head) settle(startSignIn(head, rest));
    else setSigning(null);
  };

  // One sign-in at a time: the next starts when this one connects, or after a while.
  useEffect(() => {
    if (!signing) return;
    const done = connected.some((p) => p.provider === signing.now);
    if (done || Date.now() - started.current > SIGN_IN_WAIT_MS) next(signing.queue);
  });

  const waiting = installed.filter((p) => p.auth !== 'signed_in').map((p) => p.provider);
  const finish = () =>
    settle(
      api()
        .settings.update({ firstRun: { done: true, at: Date.now(), seen: true } })
        .then(onClose),
    );
  const lookAround = () =>
    settle(
      api()
        .settings.update({ firstRun: { seen: true } })
        .then(onClose),
    );

  const team = teamFrom(ids);
  const roleLine = (role: keyof Routing, word: string) => {
    const seats = team[role];
    if (!seats.length) return `${word}: nobody yet`;
    const [lead, ...backups] = seats.map((s) => name(s.provider));
    if (role === 'reviewer' && seats.length === 1)
      return `${word}: ${lead} (only one AI, so it reviews its own work)`;
    return `${word}: ${lead}${backups.length ? `, then ${backups.join(', then ')}` : ' (no backup)'}`;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-title"
      className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg"
    >
      <header className="drag h-10 shrink-0" />
      <div className="mx-auto w-full max-w-2xl px-6 pt-4 pb-12">
        <p className="text-[12.5px] text-faint">Step {step} of 3</p>
        {step === 1 && (
          <>
            <h1
              id="first-run-title"
              ref={heading}
              tabIndex={-1}
              className="mt-1 text-[24px] font-semibold tracking-tight outline-none"
            >
              Welcome to Plenum. Connect your AIs
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">
              Plenum works with the AI tools you already use, through their own command-line apps.
              You sign in on each one's own page; Plenum never sees your passwords or keys. One AI
              is enough to start; two or more from different companies is much better.
            </p>

            {installed.length > 0 && (
              <section aria-label="Your AIs" className="mt-6">
                <div className="flex items-center gap-3">
                  <h2 className="flex-1 text-[12px] font-semibold tracking-wide text-muted uppercase">
                    On this computer
                  </h2>
                  {waiting.length > 1 && (
                    <Button disabled={signing !== null} onClick={() => next(waiting)}>
                      Sign in to all
                    </Button>
                  )}
                </div>
                <ul className="mt-2 flex flex-col rounded-2xl border border-line bg-panel">
                  {installed.map((p) => (
                    <InstalledRow
                      key={p.provider}
                      info={p}
                      busy={signing?.now === p.provider}
                      disabled={signing !== null && signing.now !== p.provider}
                      onSignIn={() => settle(startSignIn(p.provider, []))}
                    />
                  ))}
                </ul>
                {signing && (
                  <p role="status" className="mt-2 text-[12.5px] text-muted">
                    A terminal window opened with {name(signing.now)}'s sign-in. This updates when
                    it's done
                    {signing.queue.length > 0 &&
                      `; then ${signing.queue.map(name).join(', then ')}`}
                    .{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => next(signing.queue)}
                    >
                      {signing.queue.length ? 'Skip to the next' : 'Stop waiting'}
                    </button>
                  </p>
                )}
                {problem && (
                  <p role="alert" className="mt-2 text-[12.5px] text-danger">
                    {problem}
                  </p>
                )}
              </section>
            )}

            <section
              aria-label="What you can do"
              className="mt-5 rounded-2xl border border-line bg-panel px-4 py-3"
            >
              <p className="text-[13.5px] font-medium" aria-live="polite">
                {progressLine(connected.length)}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {CAPABILITIES.map((c) => {
                  const has = connected.length >= c.need;
                  return (
                    <li key={c.text} className="flex items-center gap-2 text-[13px]">
                      {has ? (
                        <Check className="size-4 text-ok" aria-label="Yes" />
                      ) : (
                        <Circle className="size-4 text-faint" aria-label="Not yet" />
                      )}
                      <span className={has ? '' : 'text-muted'}>{c.text}</span>
                    </li>
                  );
                })}
              </ul>
              {connected.length === 1 && (
                <p className="mt-3 text-[12.5px] text-muted">
                  A free second AI: GitHub Copilot's free plan comes with every GitHub account, and
                  local models run on your own computer if it has a recent graphics card.
                </p>
              )}
            </section>

            {toAdd.length > 0 && (
              <section aria-label="AIs you can add" className="mt-6">
                <h2 className="text-[12px] font-semibold tracking-wide text-muted uppercase">
                  {installed.length ? 'More you can add' : 'Install one to begin'}
                </h2>
                <ul className="mt-2 flex flex-col rounded-2xl border border-line bg-panel">
                  {toAdd.map((p) => (
                    <AddRow key={p.provider} info={p} onChanged={refresh} />
                  ))}
                </ul>
              </section>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                disabled={connected.length === 0}
                onClick={() => setStep(2)}
              >
                {connected.length === 1 ? 'Continue with 1 AI' : 'Continue'}
              </Button>
              {connected.length === 0 && <Button onClick={lookAround}>Look around first</Button>}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1
              id="first-run-title"
              ref={heading}
              tabIndex={-1}
              className="mt-1 text-[24px] font-semibold tracking-tight outline-none"
            >
              New chats
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">
              Which AI should new chats start with? You can switch in any chat, and change this
              later in Accounts.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
              <span className="text-[13.5px] font-medium">Start new chats with</span>
              <ChatDefault
                connected={connected}
                value={chatDefault ?? ids[0] ?? null}
                onChange={(p) => settle(setChatDefault(p))}
              />
            </div>
            <div className="mt-6 flex gap-3">
              <Button onClick={() => setStep(1)}>Back</Button>
              <Button
                variant="primary"
                onClick={() => {
                  // The first AI that connected, unless you picked another.
                  if (chatDefault === null && ids[0]) settle(setChatDefault(ids[0]));
                  setStep(3);
                }}
              >
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1
              id="first-run-title"
              ref={heading}
              tabIndex={-1}
              className="mt-1 text-[24px] font-semibold tracking-tight outline-none"
            >
              Your team
            </h1>
            <p className="mt-2 text-[13.5px] text-muted">
              New projects start with this team, from the AIs you connected: the first one in each
              role does the work, and the next takes over when it hits a limit. You can change it
              for each project.
            </p>
            <ul
              aria-label="Team"
              className="mt-5 flex flex-col gap-2 rounded-2xl border border-line bg-panel px-4 py-3 text-[13.5px]"
            >
              <li>{roleLine('planner', 'Planning')}</li>
              <li>{roleLine('builder', 'Building')}</li>
              <li>{roleLine('reviewer', 'Reviews')}</li>
            </ul>
            <div className="mt-6 flex gap-3">
              <Button onClick={() => setStep(2)}>Back</Button>
              <Button variant="primary" onClick={finish}>
                Start using Plenum
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InstalledRow({
  info,
  busy,
  disabled,
  onSignIn,
}: {
  info: ProviderInfo;
  busy: boolean;
  disabled: boolean;
  onSignIn: () => void;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
      <ProviderDot provider={info.provider} />
      <span className="min-w-0 flex-1 text-[13.5px] font-medium">{info.displayName}</span>
      <Status info={info} />
      {info.auth !== 'signed_in' && (
        <Button disabled={disabled || busy} onClick={onSignIn}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {busy ? 'Signing in…' : `Sign in to ${info.displayName}`}
        </Button>
      )}
    </li>
  );
}
