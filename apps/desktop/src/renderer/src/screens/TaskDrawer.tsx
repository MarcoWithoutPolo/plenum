import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleDot, Eye, Pin, RefreshCw, RotateCcw, X, XCircle } from 'lucide-react';
import type { Approval, BrainEvent, Project, Seat, Task } from '@conclave/shared';
import { DiffView } from '@/components/DiffView';
import { FailureCard } from '@/components/FailureCard';
import { Markdown } from '@/components/Markdown';
import { QuestionCard } from '@/components/QuestionCard';
import { TaskScreenshots } from '@/components/Shots';
import { Button, ProviderDot, Thinking } from '@/components/bits';
import { ACTIVE, TaskStatusIcon, taskVerb } from '@/components/project-bits';
import { api } from '@/lib/api';
import { useLayer } from '@/lib/layers';
import { providerName } from '@/lib/store';
import { EventRow } from './ProjectView';
import { settle } from '@/lib/settle';

export function TaskDrawer({
  task,
  project,
  events,
  tasks,
  approvals,
  onClose,
  onPreview,
}: {
  task: Task;
  project: Project;
  events: BrainEvent[];
  tasks: Task[];
  approvals: Approval[];
  onClose: () => void;
  /** Set when the project can be previewed: opens this task's change in the preview. */
  onPreview?: () => void;
}) {
  const earlier = tasks.filter((t) => t.replacedBy === task.id);
  const question = task.blockedBy
    ? approvals.find((a) => a.id === task.blockedBy && a.status === 'pending')
    : undefined;
  const history = useMemo(() => attemptHistory(events, task.id), [events, task.id]);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mine = events.filter((e) => e.taskId === task.id);

  // A slower answer for an older task never replaces the current one (U21).
  const latest = useRef(task.id);
  latest.current = task.id;
  const loadDiff = async () => {
    const id = task.id;
    setLoading(true);
    try {
      const changes = await api().projects.taskChanges(id);
      if (latest.current === id) setDiff(changes);
    } catch {
      if (latest.current === id) setDiff(null);
    } finally {
      if (latest.current === id) setLoading(false);
    }
  };

  // Refetch when the task moves on (a commit, a merge) so the diff is never stale.
  useEffect(() => {
    settle(loadDiff());
  }, [task.id, task.status, task.mergeCommit]);

  // A modal layer: Tab stays inside, Escape closes it unless something above it is open.
  const panel = useRef<HTMLElement>(null);
  useLayer(true, onClose, [panel], true);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  return (
    <div className="absolute inset-x-0 top-10 bottom-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close task"
        tabIndex={-1}
        onClick={onClose}
        className="fade-in flex-1 cursor-default bg-black/10 dark:bg-black/30"
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        tabIndex={-1}
        className="slide-in outline-none flex h-full w-[min(560px,90%)] flex-col border-l border-line bg-panel shadow-[-24px_0_60px_-24px_rgb(0_0_0/0.25)]"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3.5">
          <span className="mt-1">
            <TaskStatusIcon task={task} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] leading-snug font-semibold">{task.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
              <span className={ACTIVE.includes(task.status) ? 'font-medium text-accent-ink' : ''}>
                {taskVerb(task)}
              </span>
              {task.builtBy && (
                <span className="inline-flex items-center gap-1.5">
                  <ProviderDot provider={task.builtBy} size={7} /> Built by{' '}
                  {providerName(task.builtBy)}
                </span>
              )}
              {task.reviewedBy && (
                <span className="inline-flex items-center gap-1.5">
                  <ProviderDot provider={task.reviewedBy} size={7} /> Reviewed by{' '}
                  {providerName(task.reviewedBy)}
                </span>
              )}
              {task.attempts > 0 && (
                <span>
                  Attempt{' '}
                  {Math.min(
                    task.attempts + (task.status === 'failed' ? 0 : 1),
                    project.maxAttempts,
                  )}{' '}
                  of {project.maxAttempts}
                </span>
              )}
              {task.pinnedSeat && task.status !== 'merged' && (
                <span className="inline-flex items-center gap-1">
                  <Pin className="size-3" aria-hidden /> {seatText(task.pinnedSeat)} only
                </span>
              )}
              {task.mergeCommit && (
                <span className="font-mono">{task.mergeCommit.slice(0, 8)}</span>
              )}
            </div>
            {onPreview && ACTIVE.includes(task.status) && (
              <Button size="sm" className="mt-2.5" onClick={onPreview}>
                <Eye className="size-3.5" /> Preview this change
              </Button>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1.5 grid size-8 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {question && (
            <div className="mb-6">
              <QuestionCard approval={question} compact />
            </div>
          )}
          {(task.status === 'failed' || (task.lastFailure && task.status === 'queued')) && (
            <div className="mb-6">
              <FailureCard task={task} project={project} />
            </div>
          )}
          <Section title="What it should do">
            <div className="rounded-xl bg-sunken/60 px-3.5 py-2.5">
              <Markdown text={task.spec} />
            </div>
          </Section>

          {history.length > 1 && (
            <Section title="Attempts">
              <ol className="flex flex-col gap-1">
                {history.map((h, i) => {
                  const outcome =
                    h.outcome === 'merged'
                      ? 'merged'
                      : h.outcome === 'running'
                        ? 'in progress'
                        : `${h.summary}${h.counted ? '' : ' (not counted)'}`;
                  return (
                    <li key={i} className="flex items-center gap-2.5 text-[12.5px]">
                      {h.outcome === 'merged' ? (
                        <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden />
                      ) : h.outcome === 'running' ? (
                        <CircleDot className="size-3.5 shrink-0 text-accent" aria-hidden />
                      ) : h.counted ? (
                        <XCircle className="size-3.5 shrink-0 text-danger" aria-hidden />
                      ) : (
                        <RotateCcw className="size-3.5 shrink-0 text-faint" aria-hidden />
                      )}
                      <span className="w-16 shrink-0 text-faint">
                        {h.n ? `Attempt ${h.n}` : 'Retry'}
                      </span>
                      {h.seat && (
                        <span className="inline-flex shrink-0 items-center gap-1 font-medium">
                          <ProviderDot provider={h.seat.provider} size={6} />
                          {seatText(h.seat)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-muted" title={outcome}>
                        {outcome}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Section>
          )}

          {earlier.length > 0 && (
            <Section title="Earlier attempts at this work">
              <ul className="flex flex-col gap-1.5">
                {earlier.map((t) => (
                  <li key={t.id} className="rounded-xl bg-sunken/60 px-3 py-2 text-[12.5px]">
                    <span className="font-medium">{t.title}</span>
                    <span className="block text-faint">
                      Failed
                      {t.lastFailure
                        ? `: ${t.lastFailure.summary}`
                        : t.feedback
                          ? `: ${t.feedback.split('\n')[0]}`
                          : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title={task.mergeCommit ? 'What it changed' : 'Changes so far'}
            action={
              <button
                type="button"
                onClick={() => settle(loadDiff())}
                aria-label="Refresh changes"
                className="grid size-6 place-items-center rounded-md text-faint hover:bg-sunken hover:text-ink"
              >
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            }
          >
            {diff === null ? (
              <Thinking label="Loading changes" />
            ) : diff ? (
              <DiffView diff={diff} />
            ) : (
              <p className="text-[13px] text-muted">
                {task.status === 'queued'
                  ? task.kept
                    ? 'The last attempt is kept; the next one continues from it.'
                    : 'Not built yet.'
                  : task.status === 'failed'
                    ? 'The last attempt was discarded.'
                    : 'No changes yet.'}
              </p>
            )}
          </Section>

          <ScreenshotsSection projectId={project.id} taskId={task.id} refresh={task.status} />

          <Section title="Activity">
            {mine.length ? (
              <ol>
                {mine.map((e) => (
                  <li key={e.id}>
                    <EventRow event={e} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-muted">Nothing yet.</p>
            )}
          </Section>
        </div>
      </aside>
    </div>
  );
}

function seatText(seat: Seat): string {
  return [providerName(seat.provider), seat.model, seat.effort && `${seat.effort} effort`]
    .filter(Boolean)
    .join(' · ');
}

interface AttemptRow {
  n: number;
  seat?: Seat;
  outcome: 'merged' | 'failed' | 'running';
  summary: string;
  counted: boolean;
}

/** One row per attempt, from the activity log: who built it and how it ended. */
function attemptHistory(events: BrainEvent[], taskId: string): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (const e of events) {
    if (e.taskId !== taskId) continue;
    const data = (e.data ?? {}) as {
      attempt?: number;
      seat?: Seat;
      kind?: string;
      counted?: boolean;
    };
    if (e.kind === 'task' && data.seat) {
      rows.push({
        n: rows.length + 1,
        seat: data.seat,
        outcome: 'running',
        summary: '',
        counted: true,
      });
      continue;
    }
    const last = rows.at(-1);
    if (!last || last.outcome !== 'running') continue;
    if (e.kind === 'merge' && /^Merged/.test(e.message)) {
      last.outcome = 'merged';
    } else if (e.kind === 'retry' || e.kind === 'fail') {
      last.outcome = 'failed';
      last.counted = data.counted !== false;
      last.summary = e.message
        .replace(/^Sent back \(\d+\/\d+\): /, '')
        .replace(/^Trying again, not counted as an attempt: /, '')
        // "attempt(s)" is how messages logged before 1.0.0 put it.
        .replace(/^Gave up after \d+ attempt(?:s|\(s\))?: [^.]*\. /, '');
    } else if (e.kind === 'wait' || e.kind === 'question') {
      last.outcome = 'failed';
      last.counted = false;
      last.summary = e.kind === 'wait' ? 'hit a usage limit' : 'asked a question';
    }
  }
  // Numbered like the header's "Attempt N of M": only attempts that count get a number.
  let n = 0;
  for (const r of rows) r.n = r.counted ? ++n : 0;
  return rows;
}

function ScreenshotsSection(props: { projectId: string; taskId: string; refresh: unknown }) {
  // TaskScreenshots renders nothing for a task without screenshots, and so does the section.
  return (
    <section aria-label="Screenshots" className="mb-6 last:mb-0 has-[>div:empty]:hidden">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11.5px] font-semibold tracking-wide text-faint uppercase">
          Screenshots
        </h3>
      </div>
      <div>
        <TaskScreenshots {...props} />
      </div>
    </section>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11.5px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}
