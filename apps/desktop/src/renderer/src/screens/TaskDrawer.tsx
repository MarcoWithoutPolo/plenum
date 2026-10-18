import { useEffect, useState } from 'react';
import { MessageSquareWarning, RefreshCw, X } from 'lucide-react';
import type { BrainEvent, Project, Task } from '@conclave/shared';
import { DiffView } from '@/components/DiffView';
import { Markdown } from '@/components/Markdown';
import { ProviderDot, Thinking } from '@/components/bits';
import { ACTIVE, TaskStatusIcon, taskVerb } from '@/components/project-bits';
import { api } from '@/lib/api';
import { providerName } from '@/lib/store';
import { EventRow } from './ProjectView';

export function TaskDrawer({
  task,
  project,
  events,
  onClose,
}: {
  task: Task;
  project: Project;
  events: BrainEvent[];
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mine = events.filter((e) => e.taskId === task.id);

  const loadDiff = async () => {
    setLoading(true);
    try {
      setDiff(await api().projects.taskChanges(task.id));
    } finally {
      setLoading(false);
    }
  };

  // Refetch when the task moves on (a commit, a merge) so the diff is never stale.
  useEffect(() => {
    void loadDiff();
  }, [task.id, task.status, task.mergeCommit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-x-0 top-10 bottom-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close task"
        onClick={onClose}
        className="fade-in flex-1 cursor-default bg-black/10 dark:bg-black/30"
      />
      <aside
        role="dialog"
        aria-label={task.title}
        className="slide-in flex h-full w-[min(560px,90%)] flex-col border-l border-line bg-panel shadow-[-24px_0_60px_-24px_rgb(0_0_0/0.25)]"
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
              {task.mergeCommit && (
                <span className="font-mono">{task.mergeCommit.slice(0, 8)}</span>
              )}
            </div>
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
          <Section title="What it should do">
            <div className="rounded-xl bg-sunken/60 px-3.5 py-2.5">
              <Markdown text={task.spec} />
            </div>
          </Section>

          {task.feedback && (
            <Section title={task.status === 'failed' ? 'Why it failed' : 'Sent back because'}>
              <div className="rounded-xl border border-warn/30 bg-warn-soft/50">
                <div className="flex items-center gap-2 px-3.5 pt-2.5 text-[12.5px] font-medium text-warn">
                  <MessageSquareWarning className="size-3.5" aria-hidden />
                  {task.feedback.split('\n')[0]}
                </div>
                {task.feedback.includes('\n') && (
                  <pre className="selectable max-h-64 overflow-auto px-3.5 pt-1.5 pb-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
                    {task.feedback.split('\n').slice(1).join('\n').trim()}
                  </pre>
                )}
              </div>
            </Section>
          )}

          <Section
            title={task.mergeCommit ? 'What it changed' : 'Changes so far'}
            action={
              <button
                type="button"
                onClick={() => void loadDiff()}
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
                  ? 'Not built yet.'
                  : task.status === 'failed'
                    ? 'The last attempt was discarded.'
                    : 'No changes yet.'}
              </p>
            )}
          </Section>

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
