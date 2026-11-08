import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, GitMerge, Plus } from 'lucide-react';
import { firstPreferred, type Message, type ProviderId, type Seat } from '@plenum/shared';
import type { ProviderInfo } from '../../../shared/api';
import { Composer } from '@/components/Composer';
import { Markdown } from '@/components/Markdown';
import { SeatPicker, modelLabel } from '@/components/SeatPicker';
import { EffortTag, UsageMeta } from '@/components/UsageMeta';
import { Badge, ProviderDot, Thinking } from '@/components/bits';
import {
  NEW,
  councilRounds,
  labelSeats,
  providerName,
  readyProviders,
  seatOf,
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

  const remembered = useApp((s) => s.councilSeats[threadId ?? NEW]);
  const [members, setMembers] = useState<Seat[]>(() => remembered?.members ?? []);
  const [synth, setSynth] = useState<Seat | undefined>(() => remembered?.synthesizer);

  // Seats you picked for this thread win; otherwise rebuild them from the last round,
  // or start with every connected provider.
  useEffect(() => {
    if (remembered || members.length) return;
    const last = rounds.at(-1);
    if (last && last.answers.length) {
      setMembers(last.answers.map((a) => pickable(seatOf(a), providers)));
      if (last.merged?.provider) setSynth(pickable(seatOf(last.merged), providers));
    } else if (ready.length) {
      setMembers(ready.map((p) => ({ provider: p.provider })));
    }
  }, [remembered, members.length, rounds, ready, providers]);

  useEffect(() => {
    if (!synth && ready.length) {
      const pick = firstPreferred(ready)!;
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
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5">
          <MemberChips ready={ready} members={members} onChange={setMembers} />
          {synth && (
            <span className="flex items-center gap-1.5 text-[12px] text-faint">
              <GitMerge className="size-3.5" aria-hidden />
              <span>Merged by</span>
              <SeatPicker value={synth} onChange={setSynth} label="Choose who merges" />
            </span>
          )}
        </div>
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

/**
 * Stored answers record the model the CLI resolved (e.g. "claude-opus-5-5"),
 * not what was picked. Keep it only when it's one of the picker's options.
 */
function pickable(seat: Seat, providers: ProviderInfo[]): Seat {
  const info = providers.find((p) => p.provider === seat.provider);
  if (!seat.model || info?.models.some((m) => m.id === seat.model)) return seat;
  const { model: _resolved, ...rest } = seat;
  return rest;
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
  const update = (provider: ProviderId, seat: Seat | null) => {
    const others = members.filter((m) => m.provider !== provider);
    // Keep the chip order stable: members follow the provider order.
    const next = seat ? [...others, seat] : others;
    onChange(ready.flatMap((p) => next.filter((m) => m.provider === p.provider)));
  };

  return (
    <div role="group" aria-label="Council members" className="flex flex-wrap items-center gap-1.5">
      {ready.map((p) => {
        const seat = members.find((m) => m.provider === p.provider);
        return (
          <MemberChip
            key={p.provider}
            info={p}
            seat={seat}
            onToggle={() => update(p.provider, seat ? null : { provider: p.provider })}
            onChange={(next) => update(p.provider, next)}
          />
        );
      })}
    </div>
  );
}

function MemberChip({
  info,
  seat,
  onToggle,
  onChange,
}: {
  info: ProviderInfo;
  seat: Seat | undefined;
  onToggle: () => void;
  onChange: (seat: Seat) => void;
}) {
  const on = Boolean(seat);
  return (
    <span
      className={`inline-flex h-7.5 items-center rounded-full border text-[12.5px] font-medium transition ${
        on
          ? 'border-accent/40 bg-accent-soft text-accent-ink'
          : 'border-dashed border-line-strong text-muted'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? 'Remove' : 'Add'} ${info.displayName}`}
        title={
          on
            ? `Remove ${providerName(info.provider)} from the council`
            : `Add ${providerName(info.provider)}`
        }
        onClick={onToggle}
        className="grid size-7.5 shrink-0 place-items-center rounded-full outline-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-accent dark:hover:bg-white/5"
      >
        {on ? (
          <span className="grid size-4 place-items-center rounded-full bg-accent text-white">
            <Check className="size-2.5" strokeWidth={3} />
          </span>
        ) : (
          <Plus className="size-3.5" />
        )}
      </button>
      {on && seat ? (
        <SeatPicker
          value={seat}
          onChange={onChange}
          lockProvider={info.provider}
          label={`${info.displayName} model`}
          trigger={({ ref, toggle, open, seat: s, ...aria }) => (
            <button
              ref={ref}
              type="button"
              onClick={toggle}
              aria-label={`${providerName(info.provider)} ${modelLabel(info, s.model)}${s.effort ? ` · ${s.effort}` : ''}, ${info.displayName} model`}
              {...aria}
              className="inline-flex h-full items-center gap-1.5 rounded-r-full pr-2.5 pl-0.5 outline-none hover:brightness-95 focus-visible:underline"
            >
              <ProviderDot provider={info.provider} size={7} />
              {providerName(info.provider)}{' '}
              <span className="font-normal">{modelLabel(info, s.model)}</span>
              {s.effort && <span className="font-normal"> · {s.effort}</span>}
              <ChevronDown className={`size-3 opacity-60 transition ${open ? 'rotate-180' : ''}`} />
            </button>
          )}
        />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex h-full items-center gap-1.5 pr-3 pl-0.5"
        >
          <ProviderDot provider={info.provider} size={7} />
          {providerName(info.provider)}
        </button>
      )}
    </span>
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
  const seats = round.answers.map((a) => seatOf(a));
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
            status={a.outcome === 'skipped' ? 'skipped' : a.ok ? 'done' : 'failed'}
            text={a.ok || a.outcome === 'skipped' ? a.content : ''}
            error={a.error}
            effort={a.effort}
            durationMs={a.durationMs}
            usage={a.usage}
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
  const skipMember = useApp((s) => s.skipMember);
  const mergeNow = useApp((s) => s.mergeNow);
  const synthActive = live.synth.status !== 'waiting';
  const running = live.members.filter((m) => m.status === 'waiting' || m.status === 'thinking');
  const answered = live.members.filter((m) => m.status === 'done');
  // Merge now: once someone has answered while someone else still works (F4).
  const canMerge = !synthActive && answered.length > 0 && running.length > 0;
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
            error={m.skipped ?? null}
            effort={m.seat.effort ?? null}
            durationMs={m.durationMs ?? null}
            {...((m.status === 'waiting' || m.status === 'thinking') && {
              onSkip: () => skipMember(live.requestId, i),
            })}
          />
        ))}
      </AnswerGrid>
      <LiveMerge
        synth={live.synth}
        active={synthActive}
        waitingFor={running.length}
        {...(canMerge && { onMergeNow: () => mergeNow(live.requestId) })}
      />
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
  effort,
  durationMs,
  usage,
  onSkip,
}: {
  provider: ProviderId;
  label: string;
  model: string | null;
  status: LiveSeat['status'];
  text: string;
  error?: string | null;
  effort?: string | null;
  durationMs?: number | null;
  usage?: Message['usage'];
  /** While it works: stop it and leave it out of the merge (F4). */
  onSkip?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 700;
  if (status === 'skipped')
    return (
      <SkippedCard provider={provider} label={label} model={model} text={text} reason={error} />
    );
  return (
    <article
      aria-label={`${label} answer`}
      className="flex min-w-0 flex-col rounded-2xl border border-line bg-panel p-4 shadow-card"
    >
      <header className="mb-2 flex items-center gap-2 text-[12.5px]">
        <ProviderDot provider={provider} />
        <span className="shrink-0 font-semibold whitespace-nowrap">{label}</span>
        {model && (
          <span className="min-w-0 truncate text-faint" title={model}>
            {model}
          </span>
        )}
        <EffortTag effort={effort} />
        <span className="ml-auto shrink-0">
          {status === 'done' ? (
            <UsageMeta durationMs={durationMs} usage={usage} align="right" />
          ) : status === 'failed' ? (
            <Badge tone="danger">Failed</Badge>
          ) : status === 'thinking' ? (
            <Badge tone="accent">Answering</Badge>
          ) : (
            <Badge>Waiting</Badge>
          )}
        </span>
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            aria-label={`Skip ${label}`}
            title="Stop it and merge without it"
            className="shrink-0 rounded-lg border border-line-strong bg-panel px-2.5 py-1 text-[12px] font-medium hover:bg-sunken"
          >
            Skip
          </button>
        )}
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

/** A skipped member: said so, with what it had written folded away (F4). */
function SkippedCard({
  provider,
  label,
  model,
  text,
  reason,
}: {
  provider: ProviderId;
  label: string;
  model: string | null;
  text: string;
  reason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article
      aria-label={`${label} answer, skipped`}
      className="flex min-w-0 flex-col rounded-2xl border border-dashed border-line-strong bg-sunken/40 p-4"
    >
      <header className="mb-2 flex items-center gap-2 text-[12.5px]">
        <ProviderDot provider={provider} />
        <span className="shrink-0 font-semibold whitespace-nowrap">{label}</span>
        {model && (
          <span className="min-w-0 truncate text-faint" title={model}>
            {model}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <Badge>{reason ?? 'Skipped'}</Badge>
        </span>
      </header>
      <p className="text-[12.5px] text-muted">
        Left out of the merge. The tokens it used are counted.
      </p>
      {text.trim() && (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mt-2 inline-flex items-center gap-1 self-start text-[12.5px] font-medium text-accent-ink hover:underline"
          >
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {open ? 'Hide what it wrote' : 'Show what it wrote'}
          </button>
          {open && (
            <div className="mt-2 text-muted">
              <Markdown text={text} />
            </div>
          )}
        </>
      )}
    </article>
  );
}

function MergedCard({ message, answerCount }: { message: Message; answerCount: number }) {
  const by = message.provider ? seatText(seatOf(message)) : '';
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
          <span className="ml-auto text-[12px]">
            <UsageMeta durationMs={message.durationMs} usage={message.usage} align="right" />
          </span>
        </>
      }
    >
      {message.ok && message.error && (
        // A note on how it was merged: who stepped in, or who was skipped (F4).
        <p className="mb-2 text-[12.5px] text-muted">{message.error}</p>
      )}
      {message.ok ? (
        <Markdown text={message.content} />
      ) : (
        <ErrorBox text={message.error ?? 'No council answer'} />
      )}
    </MergedShell>
  );
}

function LiveMerge({
  synth,
  active,
  waitingFor,
  onMergeNow,
}: {
  synth: LiveSeat;
  active: boolean;
  waitingFor: number;
  onMergeNow?: () => void;
}) {
  return (
    <MergedShell
      title={
        <>
          <span className="font-semibold">Council answer</span>
          <span className="text-faint">
            {active
              ? `merging with ${seatText(synth.seat)}`
              : waitingFor > 0
                ? `waits for ${waitingFor} member${waitingFor === 1 ? '' : 's'}`
                : 'waits for the members'}
          </span>
          {onMergeNow && (
            <button
              type="button"
              onClick={onMergeNow}
              title="Skip the members still answering and merge what came back"
              className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white hover:brightness-110"
            >
              Merge now
            </button>
          )}
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
