import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, GitMerge, X } from 'lucide-react';
import type { Message, ProviderId, Seat } from '@conclave/shared';
import type { ProviderInfo } from '../../../shared/api';
import { Composer } from '@/components/Composer';
import { Markdown } from '@/components/Markdown';
import { ModelPicker } from '@/components/ModelPicker';
import { Badge, ProviderDot, Thinking, formatStats, usageTitle } from '@/components/bits';
import {
  NEW,
  councilRounds,
  labelSeats,
  providerName,
  readyProviders,
  seatText,
  useApp,
  type LiveCouncil,
  type LiveSeat,
  type Round,
} from '@/lib/store';
import { ConnectPrompt, ErrorBox } from './ChatScreen';

export function CouncilScreen({ threadId }: { threadId?: string }) {
  const providers = useApp((s) => s.providers);
  const detail = useApp((s) => (threadId ? s.details[threadId] : undefined));
  const live = useApp((s) => s.liveCouncils[threadId ?? NEW]);
  const askCouncil = useApp((s) => s.askCouncil);
  const cancel = useApp((s) => s.cancel);
  const open = useApp((s) => s.open);

  const ready = readyProviders(providers);
  const rounds = useMemo(() => councilRounds(detail?.messages ?? []), [detail?.messages]);

  const [members, setMembers] = useState<Seat[]>([]);
  const [synth, setSynth] = useState<Seat | undefined>();

  // Start from the last round's seats, or from every connected provider.
  useEffect(() => {
    const last = rounds.at(-1);
    if (last && last.answers.length) {
      setMembers(
        last.answers.map((a) => ({ provider: a.provider!, ...(a.model && { model: a.model }) })),
      );
      if (last.merged?.provider) {
        setSynth({
          provider: last.merged.provider,
          ...(last.merged.model && { model: last.merged.model }),
        });
      }
    } else if (members.length === 0 && ready.length) {
      setMembers(ready.map((p) => ({ provider: p.provider })));
    }
  }, [detail?.thread.id, rounds.length, ready.length]); // re-run when the thread or providers change

  useEffect(() => {
    if (!synth && ready.length) {
      const pick = ready.find((p) => p.provider === 'claude') ?? ready[0]!;
      setSynth({ provider: pick.provider });
    }
  }, [ready.length, synth]);

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rounds.length, Boolean(live)]);

  const usable = members.filter((m) => ready.some((p) => p.provider === m.provider));
  const canAsk = usable.length > 0 && synth !== undefined;
  const isEmpty = rounds.length === 0 && !live;

  const composer = (
    <Composer
      running={Boolean(live)}
      disabled={!canAsk}
      onSend={(q) => synth && void askCouncil(threadId, q, usable, synth)}
      onStop={() => live && cancel(live.requestId)}
      placeholder={
        ready.length === 0
          ? 'Connect an AI account first'
          : isEmpty
            ? 'Ask a question for every model to answer…'
            : 'Ask a follow-up…'
      }
      toolbar={
        <>
          <MemberChips ready={ready} members={members} onChange={setMembers} />
          {synth && (
            <span className="ml-1 flex items-center gap-1.5 text-[12px] text-faint">
              <GitMerge className="size-3.5" />
              merged by
              <ModelPicker value={synth} onChange={setSynth} compact />
            </span>
          )}
        </>
      }
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6">
        <h1 className="truncate text-[13.5px] font-medium text-muted">
          {detail?.thread.title ?? ''}
        </h1>
      </header>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-24">
          <div className="w-full max-w-2xl">
            <h2 className="text-center text-[26px] font-semibold tracking-tight">
              Ask the council
            </h2>
            <p className="mt-2 mb-7 text-center text-[14px] text-muted">
              Every model answers on its own. Then one of them merges the answers, citing who said
              what and showing where they disagree.
            </p>
            {ready.length === 0 && <ConnectPrompt onOpen={() => open({ name: 'accounts' })} />}
            {composer}
          </div>
        </div>
      ) : (
        <>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-5xl flex-col gap-12 px-8 pt-4 pb-10">
              {rounds.map((r) => (
                <StoredRound key={r.groupId} round={r} />
              ))}
              {live && <LiveRound live={live} />}
            </div>
          </div>
          <div className="mx-auto w-full max-w-3xl px-8 pb-5">{composer}</div>
        </>
      )}
    </div>
  );
}

function MemberChips({
  ready,
  members,
  onChange,
}: {
  ready: ProviderInfo[];
  members: Seat[];
  onChange: (m: Seat[]) => void;
}) {
  const toggle = (provider: ProviderId) => {
    const has = members.some((m) => m.provider === provider);
    onChange(has ? members.filter((m) => m.provider !== provider) : [...members, { provider }]);
  };
  const setModel = (provider: ProviderId, model: string) =>
    onChange(
      members.map((m) => (m.provider === provider ? { provider, ...(model && { model }) } : m)),
    );

  return (
    <div role="group" aria-label="Council members" className="flex flex-wrap items-center gap-1.5">
      {ready.map((p) => {
        const seat = members.find((m) => m.provider === p.provider);
        const on = Boolean(seat);
        return (
          <span
            key={p.provider}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg border pr-1 pl-2 text-[12.5px] font-medium ${
              on
                ? 'border-accent/40 bg-accent-soft text-accent-ink'
                : 'border-line-strong text-muted'
            }`}
          >
            <button
              type="button"
              aria-pressed={on}
              onClick={() => toggle(p.provider)}
              className="inline-flex items-center gap-1.5"
            >
              {on ? <Check className="size-3" /> : <X className="size-3 opacity-50" />}
              <ProviderDot provider={p.provider} size={7} />
              {providerName(p.provider)}
            </button>
            {on && (p.models.length > 0 || seat?.model) && (
              <select
                aria-label={`${p.displayName} model`}
                value={seat?.model ?? ''}
                onChange={(e) => setModel(p.provider, e.target.value)}
                className="h-5 rounded border-0 bg-transparent text-[12px] text-accent-ink outline-none"
              >
                <option value="">default</option>
                {seat?.model && !p.models.some((m) => m.id === seat.model) && (
                  <option value={seat.model}>{seat.model}</option>
                )}
                {p.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ?? m.id}
                  </option>
                ))}
              </select>
            )}
          </span>
        );
      })}
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <h2 className="selectable text-[19px] leading-snug font-semibold tracking-tight whitespace-pre-wrap">
      {text}
    </h2>
  );
}

function StoredRound({ round }: { round: Round }) {
  const seats = round.answers.map((a) => ({
    provider: a.provider!,
    ...(a.model && { model: a.model }),
  }));
  const labels = labelSeats(seats);
  return (
    <section className="flex flex-col gap-4">
      {round.question && <Question text={round.question.content} />}
      <AnswerGrid>
        {round.answers.map((a, i) => (
          <AnswerCard
            key={a.id}
            provider={a.provider!}
            label={labels[i]!}
            model={a.model}
            status={a.ok ? 'done' : 'failed'}
            text={a.ok ? a.content : ''}
            error={a.error}
            meta={formatStats(a.durationMs, a.usage)}
            metaTitle={usageTitle(a.usage)}
          />
        ))}
      </AnswerGrid>
      {round.merged && (
        <MergedCard message={round.merged} answerCount={round.answers.filter((a) => a.ok).length} />
      )}
    </section>
  );
}

function LiveRound({ live }: { live: LiveCouncil }) {
  const synthActive = live.synth.status !== 'waiting';
  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <Question text={live.question} />
      <AnswerGrid>
        {live.members.map((m, i) => (
          <AnswerCard
            key={i}
            provider={m.seat.provider}
            label={m.label}
            model={m.seat.model ?? null}
            status={m.status}
            text={m.text}
            meta={m.durationMs ? `${(m.durationMs / 1000).toFixed(1)}s` : ''}
          />
        ))}
      </AnswerGrid>
      <LiveMerge synth={live.synth} active={synthActive} />
    </section>
  );
}

function AnswerGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">{children}</div>
  );
}

function AnswerCard({
  provider,
  label,
  model,
  status,
  text,
  error,
  meta,
  metaTitle,
}: {
  provider: ProviderId;
  label: string;
  model: string | null;
  status: LiveSeat['status'];
  text: string;
  error?: string | null;
  meta?: string;
  metaTitle?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 700;
  return (
    <article
      aria-label={`${label} answer`}
      className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <header className="mb-2 flex items-center gap-2 text-[12.5px]">
        <ProviderDot provider={provider} />
        <span className="font-semibold">{label}</span>
        {model && <span className="truncate text-faint">{model}</span>}
        <span className="ml-auto shrink-0">
          {status === 'done' ? (
            <span className="cursor-default text-faint" title={metaTitle}>
              {meta}
            </span>
          ) : status === 'failed' ? (
            <Badge tone="danger">Failed</Badge>
          ) : status === 'thinking' ? (
            <Badge tone="accent">Answering</Badge>
          ) : (
            <Badge>Waiting</Badge>
          )}
        </span>
      </header>
      {status === 'failed' && !text ? (
        <ErrorBox text={error ?? 'No answer'} />
      ) : text ? (
        <div className={`relative ${long && !expanded ? 'max-h-72 overflow-hidden' : ''}`}>
          <Markdown text={text} streaming={status === 'thinking'} />
          {long && !expanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-panel" />
          )}
        </div>
      ) : (
        <Thinking label={status === 'waiting' ? 'Starting' : 'Thinking'} />
      )}
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex items-center gap-1 self-start text-[12.5px] font-medium text-accent-ink hover:underline"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </article>
  );
}

function MergedShell({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <article
      aria-label="Council answer"
      className="rounded-2xl border-2 border-accent/45 bg-panel p-5 shadow-card"
    >
      <header className="mb-3 flex items-center gap-2 text-[13px]">
        <GitMerge className="size-4 text-accent" />
        {title}
      </header>
      {children}
    </article>
  );
}

function MergedCard({ message, answerCount }: { message: Message; answerCount: number }) {
  const by = message.provider
    ? seatText({ provider: message.provider, ...(message.model && { model: message.model }) })
    : '';
  return (
    <MergedShell
      title={
        <>
          <span className="font-semibold">Council answer</span>
          <span className="text-faint">
            {answerCount > 1
              ? `merged by ${by}`
              : answerCount === 1
                ? 'only one member answered'
                : ''}
          </span>
          <span className="ml-auto text-[12px] text-faint">
            <span className="cursor-default" title={usageTitle(message.usage)}>
              {formatStats(message.durationMs, message.usage)}
            </span>
          </span>
        </>
      }
    >
      {message.ok ? (
        <Markdown text={message.content} />
      ) : (
        <ErrorBox text={message.error ?? 'No council answer'} />
      )}
    </MergedShell>
  );
}

function LiveMerge({ synth, active }: { synth: LiveSeat; active: boolean }) {
  return (
    <MergedShell
      title={
        <>
          <span className="font-semibold">Council answer</span>
          <span className="text-faint">
            {active ? `merging with ${seatText(synth.seat)}` : 'waits for the members'}
          </span>
        </>
      }
    >
      {synth.text ? (
        <Markdown text={synth.text} streaming={synth.status === 'thinking'} />
      ) : (
        <Thinking label={active ? 'Merging answers' : 'Waiting for answers'} />
      )}
    </MergedShell>
  );
}
