import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  FileQuestion,
  FlaskConical,
  Eye,
  GitMerge,
  Hourglass,
  MessageCircleQuestion,
  Pencil,
  RotateCcw,
  ScanEye,
  SkipForward,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import type { RetryOptions } from '@conclave/core';
import type { FailureKind, Project, Seat, Task } from '@conclave/shared';
import { Dialog } from './Dialog';
import { SeatPicker, modelLabel } from './SeatPicker';
import { strongerModel } from '@/lib/models';
import { Button, ProviderDot } from './bits';
import { Field, textareaClass } from './form';
import { VisualIssues, parseVisualIssues } from './Shots';
import { useProjects } from '@/lib/projects';
import { providerName, readyProviders, useApp } from '@/lib/store';

const KINDS: Record<FailureKind, { icon: LucideIcon; title: string; whose: string }> = {
  limit: {
    icon: Hourglass,
    title: 'Out of usage',
    whose: "The AI account's limit, not the task's fault.",
  },
  tests: { icon: FlaskConical, title: 'Tests failed', whose: 'The change broke the test command.' },
  review: { icon: ScanEye, title: 'Changes requested', whose: 'The reviewer found problems.' },
  no_changes: {
    icon: FileQuestion,
    title: 'Nothing was changed',
    whose: 'The builder finished without editing any files.',
  },
  conflict: {
    icon: GitMerge,
    title: 'Merge conflict',
    whose: 'Newer work changed the same lines. Rebuilds are free.',
  },
  visual: {
    icon: Eye,
    title: 'Looks wrong',
    whose: 'The screenshots showed problems this change introduced. The task goes back with them.',
  },
  combined_tests: {
    icon: GitMerge,
    title: 'Fails with newer work',
    whose: 'It passed on its own, but not combined with work merged meanwhile. Rebuilds are free.',
  },
  crash: {
    icon: AlertTriangle,
    title: 'The AI tool stopped',
    whose: 'The CLI errored or timed out. The first one is retried for free.',
  },
  stall: {
    icon: Hourglass,
    title: 'The AI tool went quiet',
    whose: 'It stopped showing any progress, so it was stopped and the task handed on.',
  },
  question: {
    icon: MessageCircleQuestion,
    title: 'Waiting for a decision',
    whose: 'The agent needs your answer.',
  },
};

/**
 * Why the last attempt didn't make it, in plain words, with the fixes that fit: retry with
 * the team, another AI, more effort, an edited spec, or skip it.
 */
export function FailureCard({ task, project }: { task: Task; project: Project }) {
  const failure = task.lastFailure;
  const retry = useProjects((s) => s.retry);
  const skip = useProjects((s) => s.skip);
  const addDecision = useProjects((s) => s.addDecision);
  const providers = useApp((s) => s.providers);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState<number[]>([]);
  const failed = task.status === 'failed';
  const kind = failure ? KINDS[failure.kind] : KINDS.crash;
  const Icon = kind.icon;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  // The next ready builder that isn't the one that just failed.
  const other = readyProviders(providers).find(
    (p) => p.provider !== failure?.provider && p.provider !== task.builtBy,
  );
  const base: Seat = task.pinnedSeat ??
    // Whoever built it; for a review failure, failure.provider is the reviewer.
    project.routing.builder.find((s) => s.provider === task.builtBy) ??
    project.routing.builder[0] ?? { provider: 'claude' };

  const baseInfo = providers.find((p) => p.provider === base.provider);
  const builtThis = failure?.kind !== 'review' && failure?.provider === base.provider;
  const tried = builtThis ? (failure.model ?? base.model) : base.model;
  const stronger = strongerModel(baseInfo, tried ?? undefined);

  const summary = failure?.summary ?? task.feedback?.split('\n')[0] ?? 'The last attempt failed.';
  const detail = failure?.detail ?? task.feedback?.split('\n').slice(1).join('\n').trim();

  // Review issues as a checklist: untick the ones you disagree with before retrying.
  const visual = failure?.kind === 'visual' ? parseVisualIssues(failure.detail ?? '') : [];
  const issues =
    failure?.kind === 'review'
      ? (failure.detail ?? '')
          .split('\n')
          .filter((l) => l.startsWith('- '))
          .map((l) => l.slice(2).trim())
          .filter(Boolean)
      : // A reviewer's issues (they name screenshots). The free checks name none, and run
        // again on every attempt anyway, so there is nothing to untick.
        visual.some((v) => v.shot)
        ? visual.map((v) => v.line)
        : [];
  // What a visual issue says, without the screenshot reference the builder still gets.
  const said = (i: number) => visual[i]?.issue ?? issues[i]!;

  /** Retry, sending only the issues you kept; each one you untick is saved as a decision. */
  const retryWith = async (opts: RetryOptions = {}) => {
    if (!issues.length) return retry(project.id, task.id, opts);
    const kept = issues.filter((_, i) => !declined.includes(i));
    for (const i of declined) {
      await addDecision(
        project.id,
        `Reviewer's request: ${said(i)}`,
        "Declined by you; don't ask for it.",
      );
    }
    const reviewer = failure?.provider ? providerName(failure.provider) : 'The reviewer';
    return retry(project.id, task.id, {
      ...opts,
      feedback: kept.length
        ? `${reviewer} asked for changes:\n${kept.map((k) => `- ${k}`).join('\n')}`
        : null,
    });
  };

  return (
    <div
      className={`rounded-2xl border ${failed ? 'border-danger/30 bg-danger-soft/40' : 'border-warn/30 bg-warn-soft/40'}`}
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <div
          className={`grid size-8 shrink-0 place-items-center rounded-xl ${failed ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn'}`}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold">
            {failed ? kind.title : `Last attempt: ${kind.title.toLowerCase()}`}
            {failure?.provider && (
              <span className="inline-flex items-center gap-1 text-[12px] font-normal text-muted">
                <ProviderDot provider={failure.provider} size={6} />
                {providerName(failure.provider)}
              </span>
            )}
          </div>
          <p className="selectable mt-0.5 text-[12.5px]">{summary}</p>
          <p className="text-[12px] text-faint">
            {kind.whose}
            {!failed && ' It will try again.'}
          </p>
        </div>
      </div>
      {failed && issues.length > 0 && (
        <fieldset className="px-4 pt-2.5">
          <legend className="text-[12px] font-medium text-muted">
            The next attempt fixes the ticked issues. Untick any you disagree with.
          </legend>
          <ul className="mt-1.5 flex flex-col gap-1">
            {issues.map((issue, i) => {
              const on = !declined.includes(i);
              return (
                <li key={i}>
                  <label className="flex cursor-pointer items-start gap-2 text-[12.5px]">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setDeclined((d) => (on ? [...d, i] : d.filter((x) => x !== i)))
                      }
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    <span className={`selectable ${on ? '' : 'text-faint line-through'}`}>
                      {said(i)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {declined.length > 0 && (
            <p className="mt-1.5 text-[11.5px] text-faint">
              Unticked issues are saved as decisions, so reviewers won't ask for them again.
            </p>
          )}
        </fieldset>
      )}
      {visual.length > 0 && (
        <div className="px-4 pt-3">
          <VisualIssues issues={visual} withText={!(failed && issues.length > 0)} />
        </div>
      )}
      {detail && !(failed && issues.length > 0) && (
        <div className="px-4 pt-2">
          <button
            type="button"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-ink"
          >
            <ChevronDown className={`size-3.5 transition ${details ? '' : '-rotate-90'}`} />
            {failure?.kind === 'tests'
              ? 'Test output'
              : failure?.kind === 'review' || failure?.kind === 'visual'
                ? 'Issues'
                : 'Details'}
          </button>
          {details && (
            <pre className="selectable mt-1.5 max-h-64 overflow-auto rounded-lg bg-panel/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
              {detail}
            </pre>
          )}
        </div>
      )}
      {failed ? (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3 pb-3.5">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => void run(() => retryWith())}
          >
            <RotateCcw className="size-3.5" /> Retry
          </Button>
          {failure?.kind === 'limit' && other && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => retryWith({ seat: { provider: other.provider } }))}
            >
              <ProviderDot provider={other.provider} size={7} /> Retry with{' '}
              {providerName(other.provider)}
            </Button>
          )}
          <SeatPicker
            value={base}
            label="Retry with"
            onChange={(seat) => void run(() => retryWith({ seat }))}
            trigger={({ ref, toggle, open, ...aria }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                {...aria}
                disabled={busy}
                className={`inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-panel px-2 text-[12.5px] font-medium hover:bg-sunken ${open ? 'text-accent-ink' : ''}`}
              >
                Retry with…
              </button>
            )}
          />
          <Button
            size="sm"
            disabled={busy}
            title="Same AI, one reasoning level up"
            onClick={() => void run(() => retryWith({ effortUp: true }))}
          >
            <TrendingUp className="size-3.5" /> More effort
          </Button>
          {stronger && (
            <Button
              size="sm"
              disabled={busy}
              title={`${providerName(base.provider)}'s stronger model, for this task only`}
              onClick={() => void run(() => retryWith({ seat: { ...base, model: stronger } }))}
            >
              <Sparkles className="size-3.5" /> Retry with {modelLabel(baseInfo, stronger)}
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" /> Edit and retry
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="ml-auto"
            onClick={() => void run(() => skip(project.id, task.id))}
          >
            <SkipForward className="size-3.5" /> Skip
          </Button>
        </div>
      ) : (
        <div className="pb-3.5" />
      )}
      <EditRetryDialog
        open={editing}
        task={task}
        onClose={() => setEditing(false)}
        onSave={(spec, feedback) =>
          void run(async () => {
            setEditing(false);
            await retry(project.id, task.id, { spec, feedback: feedback.trim() || null });
          })
        }
      />
    </div>
  );
}

function EditRetryDialog({
  open,
  task,
  onClose,
  onSave,
}: {
  open: boolean;
  task: Task;
  onClose: () => void;
  onSave: (spec: string, feedback: string) => void;
}) {
  const [spec, setSpec] = useState(task.spec);
  const [feedback, setFeedback] = useState(task.feedback ?? '');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit and retry"
      description="The next attempt starts fresh with this spec and the notes below. Attempts reset."
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!spec.trim()} onClick={() => onSave(spec, feedback)}>
            Retry
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What it should do">
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={7}
            aria-label="What it should do"
            className={textareaClass}
          />
        </Field>
        <Field label="Notes for the next attempt" optional hint="What went wrong last time">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={5}
            aria-label="Notes for the next attempt"
            className={`${textareaClass} font-mono text-[12px]`}
          />
        </Field>
      </div>
    </Dialog>
  );
}
