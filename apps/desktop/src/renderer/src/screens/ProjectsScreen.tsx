import { useEffect, useState } from 'react';
import { ArrowRight, FolderKanban, GitBranch, Plus } from 'lucide-react';
import type { ProjectSummary } from '../../../shared/api';
import { Button } from '@/components/bits';
import { EventIcon, StatusPill, folderName } from '@/components/project-bits';
import { relative } from '@/components/PlanUsage';
import { useProjects } from '@/lib/projects';
import { readyProviders, useApp } from '@/lib/store';
import { NewProjectWizard } from './NewProjectWizard';
import { ProjectView } from './ProjectView';
import { ConnectPrompt } from './ChatScreen';

export function ProjectsScreen({ projectId }: { projectId?: string }) {
  const init = useProjects((s) => s.init);
  useEffect(() => init(), [init]);
  return projectId ? <ProjectView key={projectId} projectId={projectId} /> : <ProjectList />;
}

function ProjectList() {
  const summaries = useProjects((s) => s.summaries);
  const loaded = useProjects((s) => s.loaded);
  const providers = useApp((s) => s.providers);
  const open = useApp((s) => s.open);
  const [creating, setCreating] = useState(false);
  const canCreate = readyProviders(providers).length > 0;

  const close = (createdId?: string) => {
    setCreating(false);
    if (createdId) open({ name: 'projects', projectId: createdId });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-8 pt-4 pb-16">
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <h1 className="text-[22px] font-semibold tracking-tight">Projects</h1>
              <p className="mt-1 text-[13.5px] text-muted">
                Give your AIs a goal and a repository. They plan, build, test and review each
                other's work until it's done.
              </p>
            </div>
            {summaries.length > 0 && (
              <Button variant="primary" onClick={() => setCreating(true)} disabled={!canCreate}>
                <Plus className="size-4" /> New project
              </Button>
            )}
          </div>

          {!canCreate && (
            <div className="mt-6">
              <ConnectPrompt onOpen={() => open({ name: 'accounts' })} />
            </div>
          )}

          {loaded && summaries.length === 0 ? (
            <EmptyState onCreate={() => setCreating(true)} disabled={!canCreate} />
          ) : (
            <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
              {summaries.map((s) => (
                <ProjectCard
                  key={s.project.id}
                  summary={s}
                  onOpen={() => open({ name: 'projects', projectId: s.project.id })}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <NewProjectWizard open={creating} onClose={close} />
    </div>
  );
}

function EmptyState({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  const steps = [
    ['Plan', 'One AI breaks your goal into small tasks'],
    ['Build', 'Another writes each one in its own git worktree'],
    ['Check', 'Your tests run, then a different AI reviews the diff'],
    ['Merge', 'Approved work lands on a branch you merge when ready'],
  ];
  return (
    <div className="mt-10 rounded-3xl border border-line bg-panel px-10 py-12 text-center shadow-card">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">
        <FolderKanban className="size-6" aria-hidden />
      </div>
      <h2 className="mt-4 text-[19px] font-semibold tracking-tight">Start your first project</h2>
      <p className="mx-auto mt-1.5 max-w-md text-[13.5px] text-muted">
        Point Conclave at a git repository and describe the goal. It works on its own, round after
        round, and waits for your approval before anything reaches your branch.
      </p>
      <ol className="mx-auto mt-7 grid max-w-3xl grid-cols-4 gap-3 text-left">
        {steps.map(([title, body], i) => (
          <li key={title} className="rounded-2xl border border-line bg-sunken/60 p-3.5">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-accent-ink">
              <span className="grid size-5 place-items-center rounded-full bg-accent text-[11px] text-white">
                {i + 1}
              </span>
              {title}
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-muted">{body}</p>
          </li>
        ))}
      </ol>
      <Button variant="primary" className="mt-7" onClick={onCreate} disabled={disabled}>
        <Plus className="size-4" /> New project
      </Button>
    </div>
  );
}

function ProjectCard({ summary, onOpen }: { summary: ProjectSummary; onOpen: () => void }) {
  const { project, counts, running, waiting, lastEvent } = summary;
  // What's waiting on you, most urgent first (U6).
  const needs = waiting.questions
    ? `${waiting.questions} question${waiting.questions === 1 ? '' : 's'} for you`
    : waiting.requests
      ? 'Asks your permission'
      : waiting.merges
        ? 'Ready to merge'
        : null;
  const pct = counts.total ? Math.round((counts.merged / counts.total) * 100) : 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col rounded-2xl border border-line bg-panel p-4.5 text-left shadow-card transition hover:-translate-y-px hover:border-line-strong"
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold" title={project.name}>
          {project.name}
        </h3>
        <StatusPill status={project.status} running={running} reason={project.statusReason} />
      </div>
      <p className="mt-1.5 line-clamp-2 min-h-[2.6em] text-[13px] leading-snug text-muted">
        {project.goal}
      </p>

      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
          <span className="text-muted">
            {counts.total ? `${counts.merged} of ${counts.total} tasks merged` : 'Not planned yet'}
          </span>
          {counts.failed > 0 && (
            <span className="font-medium text-danger">{counts.failed} failed</span>
          )}
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
          <span
            className="h-full bg-ok transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
          {counts.active > 0 && (
            <span
              className="h-full bg-accent/60"
              style={{ width: `${(counts.active / Math.max(1, counts.total)) * 100}%` }}
            />
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-3 text-[12px] text-faint">
        <GitBranch className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" title={project.repoPath}>
          {folderName(project.repoPath)}
        </span>
        {needs ? (
          <span className="ml-auto shrink-0 rounded-full bg-warn-soft px-2 py-0.5 font-medium whitespace-nowrap text-warn">
            {needs}
          </span>
        ) : lastEvent ? (
          <span className="ml-auto flex min-w-0 shrink items-center gap-1.5">
            <EventIcon event={lastEvent} />
            <span className="truncate">{relative(lastEvent.at, 'past')}</span>
          </span>
        ) : null}
        <ArrowRight
          className="size-3.5 shrink-0 opacity-0 transition group-hover:opacity-100"
          aria-hidden
        />
      </div>
    </button>
  );
}
