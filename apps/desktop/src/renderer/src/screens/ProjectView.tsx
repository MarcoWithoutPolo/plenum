import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  FlaskConical,
  GitBranch,
  GitMerge,
  Hourglass,
  MoreHorizontal,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import {
  taskProgress,
  type Approval,
  type BrainEvent,
  type Project,
  type Task,
} from '@conclave/shared';
import { Dialog } from '@/components/Dialog';
import { Popover } from '@/components/Popover';
import { Button, ProviderDot } from '@/components/bits';
import {
  ACTIVE,
  EventIcon,
  RoleLine,
  StatusPill,
  TaskStatusIcon,
  clock,
  elapsed,
  eventLooksBad,
  folderName,
  taskVerb,
} from '@/components/project-bits';
import { relative } from '@/components/PlanUsage';
import { useProjects } from '@/lib/projects';
import { providerName, useApp } from '@/lib/store';
import { TaskDrawer } from './TaskDrawer';

export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [active, every]);
  return now;
}

export function ProjectView({ projectId }: { projectId: string }) {
  const detail = useProjects((s) => s.details[projectId]);
  const load = useProjects((s) => s.load);
  const open = useApp((s) => s.open);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void load(projectId).then((d) => {
      if (!d) open({ name: 'projects' });
    });
  }, [projectId, load, open]);

  if (!detail) {
    return <div className="grid flex-1 place-items-center text-muted">Loading…</div>;
  }
  const { project, tasks, events, approvals, running } = detail;
  const pending = approvals.find((a) => a.status === 'pending');
  const task = selected ? tasks.find((t) => t.id === selected) : undefined;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6">
        <button
          type="button"
          onClick={() => open({ name: 'projects' })}
          className="no-drag -ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-muted hover:bg-sunken hover:text-ink"
        >
          <ChevronLeft className="size-3.5" /> Projects
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 pt-2 pb-16">
          <Header project={project} running={running} />
          {pending && <ApprovalBanner approval={pending} project={project} running={running} />}
          <NowStrip project={project} running={running} tasks={tasks} events={events} />
          <div className="mt-6 grid grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] items-start gap-5">
            <TaskBoard tasks={tasks} onOpen={setSelected} selected={selected} />
            <Activity events={events} tasks={tasks} onOpenTask={setSelected} />
          </div>
        </div>
      </div>
      {task && (
        <TaskDrawer
          task={task}
          project={project}
          events={events}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ── Header ──────────────────────────────────────────────────────────── */

function Header({ project, running }: { project: Project; running: boolean }) {
  const start = useProjects((s) => s.start);
  const stop = useProjects((s) => s.stop);
  const busy = useProjects((s) => s.busy[project.id] ?? false);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const startLabel =
    project.status === 'idle' ? 'Start' : project.status === 'done' ? 'Keep improving' : 'Resume';

  return (
    <section>
      <div className="flex items-center gap-3">
        <h1 className="min-w-0 truncate text-[24px] font-semibold tracking-tight">
          {project.name}
        </h1>
        <StatusPill status={project.status} running={running} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {running ? (
            <Button onClick={() => void stop(project.id)} disabled={busy}>
              <Square className="size-3 fill-current" /> {busy ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void start(project.id)} disabled={busy}>
              {project.status === 'done' ? (
                <RotateCcw className="size-3.5" />
              ) : (
                <Play className="size-3.5 fill-current" />
              )}
              {busy ? 'Starting…' : startLabel}
            </Button>
          )}
          <Popover
            label="Project actions"
            align="right"
            width={220}
            trigger={({ ref, toggle, ...aria }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                {...aria}
                aria-label="Project actions"
                className="grid size-8.5 place-items-center rounded-lg border border-line-strong bg-panel text-muted hover:bg-sunken hover:text-ink"
              >
                <MoreHorizontal className="size-4" />
              </button>
            )}
          >
            {(close) => (
              <div className="p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setConfirmRemove(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium text-danger hover:bg-danger-soft"
                >
                  <Trash2 className="size-3.5" /> Remove project
                </button>
              </div>
            )}
          </Popover>
        </div>
      </div>

      {project.statusReason && project.status !== 'running' && (
        <p className="mt-1 text-[12.5px] text-muted">
          <span className="font-medium text-ink">
            {project.status === 'done'
              ? 'Goal met'
              : project.status === 'waiting'
                ? 'Waiting'
                : 'Why it stopped'}
            :
          </span>{' '}
          {project.statusReason}
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={`selectable mt-3 block max-w-4xl text-left text-[14px] leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}
      >
        {project.goal}
      </button>

      <div className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3 rounded-2xl border border-line bg-panel px-4 py-3.5 shadow-card">
        <div className="flex flex-col gap-2">
          <RoleLine label="Plans" seats={project.routing.planner} />
          <RoleLine label="Builds" seats={project.routing.builder} />
          <RoleLine label="Reviews" seats={project.routing.reviewer} />
        </div>
        <dl className="ml-auto grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-faint">Repository</dt>
          <dd className="selectable truncate font-medium" title={project.repoPath}>
            {folderName(project.repoPath)}
          </dd>
          <dt className="text-faint">Branches</dt>
          <dd className="flex items-center gap-1.5 font-mono text-[12px]">
            <GitBranch className="size-3 text-faint" aria-hidden />
            {project.integrationBranch}
            <span className="font-sans text-faint">→</span>
            {project.baseBranch}
          </dd>
          <dt className="text-faint">Tests</dt>
          <dd className="font-mono text-[12px]">
            {project.testCommand ?? <span className="font-sans text-faint">review only</span>}
          </dd>
          <dt className="text-faint">Retries</dt>
          <dd>{project.maxAttempts} per task</dd>
        </dl>
      </div>

      <RemoveDialog
        project={project}
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
      />
    </section>
  );
}

function RemoveDialog({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const remove = useProjects((s) => s.remove);
  const go = useApp((s) => s.open);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Remove ${project.name}?`}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              onClose();
              go({ name: 'projects' });
              void remove(project.id);
            }}
          >
            Remove project
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-muted">
        Conclave forgets this project's tasks and activity and deletes its worktrees. The{' '}
        <code className="rounded bg-sunken px-1 font-mono text-[12px]">
          {project.integrationBranch}
        </code>{' '}
        branch and your repository stay exactly as they are.
      </p>
    </Dialog>
  );
}

/* ── Approval banner ─────────────────────────────────────────────────── */

export function ApprovalBanner({
  approval,
  project,
  running,
}: {
  approval: Approval;
  project: Project;
  running: boolean;
}) {
  const decide = useProjects((s) => s.decide);
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const tasks = ((approval.payload as { tasks?: string[] } | null)?.tasks ?? []).slice(0, 6);
  const act = async (d: 'approved' | 'rejected') => {
    setBusy(d);
    await decide(approval.id, d);
    setBusy(null);
  };
  return (
    <section
      aria-label="Ready to merge"
      className="mt-5 flex items-start gap-4 rounded-2xl border border-accent/35 bg-accent-soft/60 px-5 py-4"
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-white">
        <GitMerge className="size-4.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-[14.5px] font-semibold">Ready to merge into {project.baseBranch}</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          {tasks.length} task{tasks.length === 1 ? '' : 's'} passed tests and review on{' '}
          {project.integrationBranch}.
          {running ? ' Stop the project to merge.' : ' Approving merges it into your branch now.'}
        </p>
        {tasks.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {tasks.map((t) => (
              <li key={t} className="rounded-full bg-panel px-2.5 py-0.5 text-[12px] text-muted">
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button onClick={() => void act('rejected')} disabled={busy !== null}>
          {busy === 'rejected' ? 'Declining…' : 'Not now'}
        </Button>
        <Button
          variant="primary"
          onClick={() => void act('approved')}
          disabled={busy !== null || running}
        >
          <GitMerge className="size-3.5" /> {busy === 'approved' ? 'Merging…' : 'Approve merge'}
        </Button>
      </div>
    </section>
  );
}

/* ── What's happening now ────────────────────────────────────────────── */

function NowStrip({
  project,
  running,
  tasks,
  events,
}: {
  project: Project;
  running: boolean;
  tasks: Task[];
  events: BrainEvent[];
}) {
  const now = useNow(running);
  const active = tasks.find((t) => ACTIVE.includes(t.status));
  const last = events.at(-1);

  let line: React.ReactNode = null;
  let icon: React.ReactNode = null;
  let since: number | undefined;

  if (project.status === 'waiting') {
    icon = <Hourglass className="size-4 text-warn" aria-hidden />;
    const until = (last?.data as { until?: number | null } | null)?.until;
    line = (
      <>
        <span className="font-medium">Waiting for usage to free up.</span>{' '}
        <span className="text-muted">
          {until ? `Resumes ${relative(until, 'future')}.` : 'Checks again shortly.'}
        </span>
      </>
    );
  } else if (running && active) {
    const who =
      active.status === 'reviewing'
        ? (active.reviewedBy ?? lastProvider(events, active.id))
        : active.builtBy;
    since = [...events]
      .reverse()
      .find((e) => e.taskId === active.id && ['task', 'verify', 'review'].includes(e.kind))?.at;
    icon = who ? (
      <ProviderDot provider={who} size={9} />
    ) : (
      <FlaskConical className="size-4 text-accent" aria-hidden />
    );
    const verb =
      active.status === 'verifying'
        ? 'Running tests for'
        : active.status === 'reviewing'
          ? 'reviewing'
          : 'building';
    line = (
      <>
        <span className="font-medium">
          {active.status === 'verifying'
            ? verb
            : `${who ? providerName(who) : 'An agent'} is ${verb}`}
        </span>{' '}
        <span className="text-muted">“{active.title}”</span>
      </>
    );
  } else if (running) {
    icon = <span className="live-dot size-2 rounded-full bg-ok" aria-hidden />;
    since = last?.at;
    line = (
      <span className="font-medium">
        {last?.kind === 'plan' ? last.message : 'Working out what to do next…'}
      </span>
    );
  }
  if (!line) return null;

  return (
    <div
      role="status"
      className={`relative mt-5 flex items-center gap-3 overflow-hidden rounded-2xl border border-line bg-panel px-4 py-3 text-[13.5px] shadow-card ${running ? 'sheen' : ''}`}
    >
      <span className="grid size-6 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{line}</span>
      {since && running && (
        <span className="shrink-0 text-[12px] text-faint tabular-nums">{elapsed(now - since)}</span>
      )}
    </div>
  );
}

function lastProvider(events: BrainEvent[], taskId: string) {
  return [...events].reverse().find((e) => e.taskId === taskId && e.provider)?.provider ?? null;
}

/* ── Tasks ───────────────────────────────────────────────────────────── */

const GROUPS: { title: string; match: (t: Task) => boolean; empty?: string }[] = [
  { title: 'In progress', match: (t) => ACTIVE.includes(t.status) },
  { title: 'Up next', match: (t) => t.status === 'queued' },
  { title: 'Merged', match: (t) => t.status === 'merged' },
  { title: 'Needs you', match: (t) => t.status === 'blocked' },
  { title: 'Failed', match: (t) => t.status === 'failed' },
  { title: 'Skipped', match: (t) => t.status === 'skipped' },
];

function TaskBoard({
  tasks,
  onOpen,
  selected,
}: {
  tasks: Task[];
  onOpen: (id: string) => void;
  selected: string | null;
}) {
  const { merged, total } = taskProgress(tasks);
  return (
    <section aria-label="Tasks" className="rounded-2xl border border-line bg-panel shadow-card">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="text-[13.5px] font-semibold">Tasks</h2>
        {tasks.length > 0 && (
          <>
            <span className="text-[12px] text-faint">
              {merged} of {total} merged
            </span>
            <span
              className="ml-auto flex h-1.5 w-32 overflow-hidden rounded-full bg-sunken"
              aria-hidden
            >
              <span
                className="h-full bg-ok transition-[width] duration-700"
                style={{ width: `${total ? (merged / total) * 100 : 0}%` }}
              />
            </span>
          </>
        )}
      </header>
      {tasks.length === 0 ? (
        <p className="px-4 py-10 text-center text-[13px] text-muted">
          No tasks yet. When the project starts, the planner breaks the goal into tasks here.
        </p>
      ) : (
        <div className="flex flex-col gap-4 p-3">
          {GROUPS.map((g) => {
            const items = tasks.filter(g.match);
            if (!items.length) return null;
            return (
              <div key={g.title}>
                <h3 className="px-1.5 pb-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                  {g.title} <span className="font-normal">· {items.length}</span>
                </h3>
                <ul className="flex flex-col gap-1">
                  {items.map((t) => (
                    <li key={t.id}>
                      <TaskRow task={t} selected={selected === t.id} onOpen={() => onOpen(t.id)} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TaskRow({
  task,
  selected,
  onOpen,
}: {
  task: Task;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition ${
        selected ? 'bg-accent-soft' : 'hover:bg-sunken'
      }`}
    >
      <span className="mt-0.5">
        <TaskStatusIcon task={task} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{task.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-faint">
          <span className={ACTIVE.includes(task.status) ? 'font-medium text-accent-ink' : ''}>
            {taskVerb(task)}
          </span>
          {task.builtBy && (
            <span className="inline-flex items-center gap-1">
              · <ProviderDot provider={task.builtBy} size={6} /> {providerName(task.builtBy)} built
            </span>
          )}
          {task.reviewedBy && (
            <span className="inline-flex items-center gap-1">
              · <ProviderDot provider={task.reviewedBy} size={6} /> {providerName(task.reviewedBy)}{' '}
              reviewed
            </span>
          )}
          {task.attempts > 0 && task.status !== 'failed' && (
            <span className="text-warn">
              · {task.attempts} retr{task.attempts === 1 ? 'y' : 'ies'}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/* ── Activity ────────────────────────────────────────────────────────── */

function Activity({
  events,
  tasks,
  onOpenTask,
}: {
  events: BrainEvent[];
  tasks: Task[];
  onOpenTask: (id: string) => void;
}) {
  const [steps, setSteps] = useState(false);
  const list = useMemo(
    () => (steps ? events : events.filter((e) => e.kind !== 'agent')),
    [events, steps],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [list.length]);
  const titles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);

  return (
    <section
      aria-label="Activity"
      className="sticky top-4 flex max-h-[calc(100vh-140px)] flex-col rounded-2xl border border-line bg-panel shadow-card"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[13.5px] font-semibold">Activity</h2>
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-[12px] text-muted select-none">
          <input
            type="checkbox"
            checked={steps}
            onChange={(e) => setSteps(e.target.checked)}
            className="peer sr-only"
          />
          <span className="relative h-4 w-7 rounded-full bg-line-strong transition peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-3" />
          Agent steps
        </label>
      </header>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        aria-live="polite"
      >
        {list.length === 0 ? (
          <p className="px-2 py-8 text-center text-[13px] text-muted">Nothing has happened yet.</p>
        ) : (
          <ol>
            {list.map((e, i) => {
              const showTask = e.taskId && e.taskId !== list[i - 1]?.taskId && titles.has(e.taskId);
              return (
                <li key={e.id}>
                  {showTask && (
                    <button
                      type="button"
                      onClick={() => onOpenTask(e.taskId!)}
                      className="mt-2 mb-0.5 block w-full truncate px-2 text-left text-[11.5px] font-semibold text-faint hover:text-accent-ink"
                    >
                      {titles.get(e.taskId!)}
                    </button>
                  )}
                  <EventRow event={e} />
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

export function EventRow({ event }: { event: BrainEvent }) {
  const minor = event.kind === 'agent';
  const bad = eventLooksBad(event) || event.kind === 'fail' || event.kind === 'error';
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 ${minor ? 'py-1' : ''} ${bad ? 'bg-danger-soft/40' : ''}`}
    >
      <span className="mt-0.5">
        <EventIcon event={event} />
      </span>
      <span
        className={`selectable min-w-0 flex-1 text-[12.5px] leading-snug ${minor ? 'font-mono text-[11.5px] text-muted' : ''}`}
      >
        <span className={minor ? 'break-all' : ''}>{event.message}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 pt-px text-[11px] text-faint tabular-nums">
        {event.provider && <ProviderDot provider={event.provider} size={6} />}
        {clock(event.at)}
      </span>
    </div>
  );
}
