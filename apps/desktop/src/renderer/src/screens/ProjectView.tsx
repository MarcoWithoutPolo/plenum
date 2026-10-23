import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ExternalLink,
  FlaskConical,
  GitBranch,
  Hourglass,
  MoreHorizontal,
  Pin,
  Play,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import {
  taskProgress,
  type BrainEvent,
  type Project,
  type ProjectDecision,
  type Task,
} from '@conclave/shared';
import { ApprovalCard } from '@/components/ApprovalCard';
import { Dialog } from '@/components/Dialog';
import { Popover } from '@/components/Popover';
import { Button, GitHubMark, ProviderDot } from '@/components/bits';
import { ASK_POLICIES, LEVEL_NAMES } from '@/components/form';
import {
  DecisionsPanel,
  DraftBanner,
  LimitBanner,
  NeedsYou,
  ProblemBanner,
  ProjectSettingsDialog,
  PublishDialog,
  PullRequestCard,
} from '@/components/project-panels';
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
import { api } from '@/lib/api';
import { QUESTION_KINDS, useProjects } from '@/lib/projects';
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
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    void load(projectId).then((d) => {
      if (!d) open({ name: 'projects' });
    });
  }, [projectId, load, open]);

  if (!detail) {
    return <div className="grid flex-1 place-items-center text-muted">Loading…</div>;
  }
  const { project, tasks, events, approvals, running, decisions, problems, limits } = detail;
  const pending = approvals.find((a) => a.status === 'pending' && !QUESTION_KINDS.has(a.kind));
  const questions = approvals
    .filter((a) => a.status === 'pending' && QUESTION_KINDS.has(a.kind))
    .sort((a, b) => a.createdAt - b.createdAt);
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
          <Header project={project} running={running} onSettings={() => setSettings(true)} />
          {project.status === 'draft' && <DraftBanner project={project} />}
          <NeedsYou questions={questions} tasks={tasks} />
          {pending && (
            <ApprovalCard approval={pending} project={project} running={running} variant="banner" />
          )}
          <LimitBanner project={project} limits={limits} />
          <ProblemBanner
            project={project}
            problems={problems}
            onChangeTeam={() => setSettings(true)}
          />
          <PullRequestCard project={project} />
          <NowStrip project={project} running={running} tasks={tasks} events={events} />
          <div className="mt-6 grid grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] items-start gap-5">
            <TaskBoard tasks={tasks} onOpen={setSelected} selected={selected} />
            <SidePanel
              project={project}
              events={events}
              tasks={tasks}
              decisions={decisions}
              onOpenTask={setSelected}
            />
          </div>
        </div>
      </div>
      {task && (
        <TaskDrawer
          task={task}
          project={project}
          events={events}
          tasks={tasks}
          approvals={approvals}
          onClose={() => setSelected(null)}
        />
      )}
      <ProjectSettingsDialog project={project} open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

/* ── Header ──────────────────────────────────────────────────────────── */

function Header({
  project,
  running,
  onSettings,
}: {
  project: Project;
  running: boolean;
  onSettings: () => void;
}) {
  const start = useProjects((s) => s.start);
  const stop = useProjects((s) => s.stop);
  const busy = useProjects((s) => s.busy[project.id] ?? false);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const startLabel =
    project.status === 'idle' ? 'Start' : project.status === 'done' ? 'Keep improving' : 'Resume';
  const level = project.permissions.level;

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
            <Button
              // Answering resumes a project that stopped for you; this is only a fallback.
              variant={project.status === 'needs_you' ? 'secondary' : 'primary'}
              onClick={() => void start(project.id)}
              disabled={busy || project.status === 'draft'}
            >
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
                    onSettings();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken"
                >
                  <Settings2 className="size-3.5" /> Team and settings…
                </button>
                {project.github?.prUrl ? (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      void api().openExternal(project.github!.prUrl!);
                    }}
                    className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken"
                  >
                    <ExternalLink className="size-3.5" /> Pull request on GitHub
                  </button>
                ) : (
                  !project.github && (
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        setPublishing(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken"
                    >
                      <GitHubMark className="size-3.5" /> Publish to GitHub…
                    </button>
                  )
                )}
                <div className="my-1 h-px bg-line" />
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

      {project.statusReason && project.status !== 'running' && project.status !== 'needs_you' && (
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
        className={`selectable mt-3 block max-w-4xl text-left text-[14px] leading-relaxed whitespace-pre-line ${expanded ? '' : 'line-clamp-2'}`}
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
            {project.testCommand ??
              (project.proposedTestCommand ? (
                <span title="Adopted once it passes">
                  {project.proposedTestCommand}{' '}
                  <span className="font-sans text-faint">(proposed)</span>
                </span>
              ) : (
                <span className="font-sans text-faint">review only</span>
              ))}
          </dd>
          <dt className="text-faint">Lanes</dt>
          <dd>
            {project.maxParallel === 1 ? 'One task at a time' : `${project.maxParallel} at once`}
          </dd>
          <dt className="text-faint">Attempts</dt>
          <dd>
            {project.maxAttempts} per task
            <span className="text-faint">
              {' '}
              · {project.retryStrategy === 'escalate' ? 'escalating' : 'same team'}
            </span>
          </dd>
          <dt className="text-faint">Permissions</dt>
          <dd
            className={`inline-flex items-center gap-1 ${level === 5 ? 'font-medium text-danger' : ''}`}
          >
            {level === 5 ? (
              <ShieldAlert className="size-3" aria-hidden />
            ) : (
              <ShieldCheck className="size-3 text-ok" aria-hidden />
            )}
            {level} · {LEVEL_NAMES[level]}
            {level === 5 && project.permissions.expiresAt && (
              <span className="font-normal text-faint">
                {' '}
                until{' '}
                {new Date(project.permissions.expiresAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            )}
          </dd>
          <dt className="text-faint">Questions</dt>
          <dd>{ASK_POLICIES.find((p) => p.value === project.askPolicy)?.label}</dd>
        </dl>
      </div>
      <PublishDialog project={project} open={publishing} onClose={() => setPublishing(false)} />

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
  const inFlight = tasks.filter((t) => ACTIVE.includes(t.status));
  if (running && project.maxParallel > 1 && project.status !== 'waiting' && inFlight.length > 0) {
    return <LanesStrip lanes={project.maxParallel} tasks={inFlight} events={events} now={now} />;
  }

  let line: React.ReactNode = null;
  let icon: React.ReactNode = null;
  let since: number | undefined;

  if (project.status === 'needs_you' && !running) {
    // The Needs you cards above say it all.
    return null;
  } else if (project.status === 'waiting') {
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
    ({ icon, line, since } = laneLine(active, events));
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

/** Who is doing what on one task in flight, and since when. */
function laneLine(task: Task, events: BrainEvent[]) {
  const who =
    task.status === 'reviewing' ? (task.reviewedBy ?? lastProvider(events, task.id)) : task.builtBy;
  const since = [...events]
    .reverse()
    .find((e) => e.taskId === task.id && ['task', 'verify', 'review'].includes(e.kind))?.at;
  const icon = who ? (
    <ProviderDot provider={who} size={9} />
  ) : (
    <FlaskConical className="size-4 text-accent" aria-hidden />
  );
  const verb =
    task.status === 'verifying'
      ? 'Running tests for'
      : task.status === 'reviewing'
        ? 'reviewing'
        : 'building';
  const line = (
    <>
      <span className="font-medium">
        {task.status === 'verifying' ? verb : `${who ? providerName(who) : 'An agent'} is ${verb}`}
      </span>{' '}
      <span className="text-muted">“{task.title}”</span>
    </>
  );
  return { icon, line, since };
}

/** Lanes: one live card per task in flight, and a dashed slot for each free lane. */
function LanesStrip({
  lanes,
  tasks,
  events,
  now,
}: {
  lanes: number;
  tasks: Task[];
  events: BrainEvent[];
  now: number;
}) {
  const free = Math.max(0, lanes - tasks.length);
  return (
    <section aria-label={`Lanes: ${tasks.length} of ${lanes} busy`} className="mt-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[12px] font-medium tracking-wide text-faint uppercase">Lanes</h2>
        <span className="text-[12px] text-faint tabular-nums">
          {tasks.length} of {lanes} busy
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => {
          const { icon, line, since } = laneLine(task, events);
          return (
            <li
              key={task.id}
              role="status"
              className="sheen relative flex items-center gap-3 overflow-hidden rounded-2xl border border-line bg-panel px-4 py-3 text-[13.5px] shadow-card"
            >
              <span className="grid size-6 shrink-0 place-items-center">{icon}</span>
              <span className="min-w-0 flex-1 truncate">{line}</span>
              {since && (
                <span className="shrink-0 text-[12px] text-faint tabular-nums">
                  {elapsed(now - since)}
                </span>
              )}
            </li>
          );
        })}
        {Array.from({ length: free }, (_, i) => (
          <li
            key={`free-${i}`}
            className="flex items-center gap-3 rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-faint"
          >
            <span className="grid size-6 shrink-0 place-items-center">
              <span className="size-2 rounded-full border border-line" aria-hidden />
            </span>
            Free lane: starts the next task that's ready and doesn't touch the same files
          </li>
        ))}
      </ul>
    </section>
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
          {task.attempts > 0 && task.status !== 'failed' && task.status !== 'merged' && (
            <span className="text-warn">· attempt {task.attempts + 1}</span>
          )}
          {task.status === 'failed' && task.lastFailure && (
            <span className="truncate text-danger">· {task.lastFailure.summary}</span>
          )}
          {task.pinnedSeat && task.status !== 'merged' && (
            <span className="inline-flex items-center gap-1">
              · <Pin className="size-3" aria-hidden /> {providerName(task.pinnedSeat.provider)}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/* ── Activity and decisions ──────────────────────────────────────────── */

function SidePanel({
  project,
  events,
  tasks,
  decisions,
  onOpenTask,
}: {
  project: Project;
  events: BrainEvent[];
  tasks: Task[];
  decisions: ProjectDecision[];
  onOpenTask: (id: string) => void;
}) {
  const [tab, setTab] = useState<'activity' | 'decisions'>('activity');
  const [steps, setSteps] = useState(false);
  const active = decisions.filter((d) => d.status === 'active').length;
  const tabClass = (on: boolean) =>
    `relative h-10 text-[13.5px] font-semibold transition ${on ? 'text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent' : 'text-faint hover:text-muted'}`;
  return (
    <section
      aria-label={tab === 'activity' ? 'Activity' : 'Decisions'}
      className="sticky top-4 flex max-h-[calc(100vh-140px)] flex-col rounded-2xl border border-line bg-panel shadow-card"
    >
      <header className="flex items-center gap-4 border-b border-line px-4">
        <div role="tablist" aria-label="Project panels" className="flex gap-4">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'activity'}
            onClick={() => setTab('activity')}
            className={tabClass(tab === 'activity')}
          >
            Activity
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'decisions'}
            onClick={() => setTab('decisions')}
            className={tabClass(tab === 'decisions')}
          >
            Decisions
            {active > 0 && <span className="ml-1 font-normal text-faint">{active}</span>}
          </button>
        </div>
        {tab === 'activity' && (
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
        )}
      </header>
      {tab === 'activity' ? (
        <Activity events={events} tasks={tasks} onOpenTask={onOpenTask} steps={steps} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DecisionsPanel project={project} decisions={decisions} />
        </div>
      )}
    </section>
  );
}

function Activity({
  events,
  tasks,
  onOpenTask,
  steps,
}: {
  events: BrainEvent[];
  tasks: Task[];
  onOpenTask: (id: string) => void;
  steps: boolean;
}) {
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
    <>
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
    </>
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
