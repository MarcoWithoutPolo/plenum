import type { Approval, GitHubLink, Project, Task } from '@plenum/shared';
import type { EngineContext } from '../chat/service.js';
import { pushBranch } from '../workspace/git.js';
import type { GhCheck, GhPullRequest, GitHub } from './gh.js';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

/** The pull request body: goal, decisions and who did each task. No local paths. */
export function pullRequestBody(ctx: EngineContext, project: Project): string {
  const tasks = ctx.store.projects.listTasks(project.id).filter((t) => t.status === 'merged');
  const decisions = ctx.store.decisions
    .list(project.id, { status: 'active' })
    .map((d) => `- ${d.question}: ${d.answer}${d.kind === 'assumption' ? ' _(assumed)_' : ''}`);
  const runs = ctx.store.usage.recent(10_000).filter((r) => r.refId === project.id);
  const byProvider = new Map<string, number>();
  for (const r of runs) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
  const usage = [...byProvider].map(([p, n]) => `${p} ${n} run${n === 1 ? '' : 's'}`).join(', ');
  const who = (t: Task) =>
    [t.builtBy && `built by ${t.builtBy}`, t.reviewedBy && `reviewed by ${t.reviewedBy}`]
      .filter(Boolean)
      .join(', ');
  return [
    `## Goal\n\n${project.goal}`,
    project.doneWhen && `**Done when:** ${project.doneWhen}`,
    decisions.length && `## Decisions\n\n${decisions.join('\n')}`,
    `## Tasks\n\n${tasks.map((t) => `- [x] ${t.title}${who(t) ? ` (${who(t)})` : ''}`).join('\n') || '- none'}`,
    project.testCommand &&
      `Every task passed \`${project.testCommand}\` and a review by a different AI.`,
    usage && `<sub>Agent runs: ${usage}</sub>`,
    project.github?.issue && `Closes #${project.github.issue.number}`,
    '---\nOpened by Plenum.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type PullRequestOutcome =
  { ok: true; url: string; branch: string; updated: boolean } | { ok: false; error: string };

/**
 * Push the integration branch and open a pull request, or push new work to the open one.
 * Called only after you approved it in the inbox.
 */
export async function openPullRequest(
  ctx: EngineContext,
  gh: GitHub,
  projectId: string,
  opts: { draft?: boolean } = {},
): Promise<PullRequestOutcome> {
  const project = ctx.store.projects.get(projectId);
  if (!project) return { ok: false, error: 'The project no longer exists.' };
  const link = project.github ?? (await linkRepo(ctx, gh, project));
  if (!link) {
    return {
      ok: false,
      error: 'This repository has no GitHub remote. Publish it to GitHub first.',
    };
  }
  const open = link.prUrl && link.prState === 'open' && link.prBranch;
  const pushed = await pushBranch(
    project.repoPath,
    project.integrationBranch,
    open ? link.prBranch! : `plenum/${slugify(project.name)}`,
    { protect: project.baseBranch, exact: Boolean(open) },
  );
  if (!pushed.ok) return pushed;
  if (open) {
    ctx.store.projects.log({
      projectId,
      kind: 'merge',
      message: `Pushed the new work to the pull request (${pushed.branch})`,
      data: { url: link.prUrl },
    });
    return { ok: true, url: link.prUrl!, branch: pushed.branch, updated: true };
  }
  let url: string;
  try {
    url = await gh.createPullRequest({
      cwd: project.repoPath,
      base: project.baseBranch,
      head: pushed.branch,
      title: titleFor(project),
      body: pullRequestBody(ctx, project),
      ...(opts.draft && { draft: true }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  ctx.store.projects.update(projectId, {
    github: { ...link, prBranch: pushed.branch, prUrl: url, prState: 'open' },
  });
  ctx.store.projects.log({
    projectId,
    kind: 'merge',
    message: `Opened a pull request: ${url}`,
    data: { url, branch: pushed.branch },
  });
  return { ok: true, url, branch: pushed.branch, updated: false };
}

function titleFor(project: Project): string {
  const firstLine = project.goal.split('\n')[0]!.trim();
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

/** Record the GitHub repo behind a local clone, if there is one. */
export async function linkRepo(
  ctx: EngineContext,
  gh: GitHub,
  project: Project,
): Promise<GitHubLink | undefined> {
  const repo = await gh.repoOf(project.repoPath).catch(() => undefined);
  if (!repo) return undefined;
  const link: GitHubLink = { repo, prBranch: null, prUrl: null, prState: null, issue: null };
  ctx.store.projects.update(project.id, { github: link });
  return link;
}

export interface PullRequestStatus {
  pr: GhPullRequest;
  checks: GhCheck[];
  failing: GhCheck[];
  pending: number;
}

/** Read the PR and its checks; records when it was merged or closed on GitHub. */
export async function pullRequestStatus(
  ctx: EngineContext,
  gh: GitHub,
  projectId: string,
): Promise<PullRequestStatus | undefined> {
  const project = ctx.store.projects.get(projectId);
  const url = project?.github?.prUrl;
  if (!project?.github || !url) return undefined;
  const [pr, checks] = await Promise.all([
    gh.pullRequest(project.repoPath, url),
    gh.checks(project.repoPath, url).catch(() => [] as GhCheck[]),
  ]);
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
  if (state !== project.github.prState) {
    ctx.store.projects.update(projectId, { github: { ...project.github, prState: state } });
    if (state !== 'open') {
      ctx.store.projects.log({
        projectId,
        kind: state === 'merged' ? 'done' : 'stop',
        message: state === 'merged' ? 'Merged on GitHub' : 'The pull request was closed on GitHub',
        data: { url },
      });
    }
  }
  return {
    pr,
    checks,
    failing: checks.filter((c) => c.bucket === 'fail'),
    pending: checks.filter((c) => c.bucket === 'pending').length,
  };
}

/** "Fix it": a task carrying the failing check, built and reviewed as usual, then pushed to the PR. */
export function fixFailingCheck(ctx: EngineContext, projectId: string, check: GhCheck): Task {
  const projects = ctx.store.projects;
  const [task] = projects.addTasks(projectId, [
    {
      title: `Fix the failing CI check: ${check.name}`.slice(0, 200),
      spec: `The pull request's CI check "${check.name}"${check.workflow ? ` (workflow ${check.workflow})` : ''} fails. Find out why from the code and the workflow files, and fix the cause so it passes. Check details: ${check.link}`,
    },
  ]);
  const project = projects.get(projectId);
  if (project && ['done', 'paused', 'stopped'].includes(project.status)) {
    projects.setStatus(projectId, 'idle', 'A CI fix is queued');
  }
  projects.log({
    projectId,
    taskId: task!.id,
    kind: 'plan',
    message: `You asked for a fix for the failing check ${check.name}`,
    data: { link: check.link },
  });
  return task!;
}

/** Ask to publish a local project as a new GitHub repository (runs only once you approve). */
export function requestPublish(
  ctx: EngineContext,
  projectId: string,
  input: { name: string; private: boolean },
): Approval {
  const project = ctx.store.projects.get(projectId);
  if (!project) throw new Error(`No such project: ${projectId}`);
  if (!/^[\w.-]+$/.test(input.name))
    throw new Error('Use letters, numbers, dots, dashes or underscores.');
  const approval = ctx.store.projects.requestApproval({
    projectId,
    kind: 'create_repo',
    summary: `Create the ${input.private ? 'private' : 'public'} GitHub repository ${input.name} and push ${project.baseBranch}`,
    payload: {
      name: input.name,
      private: input.private,
      command: `gh repo create ${input.name} ${input.private ? '--private' : '--public'} --source . --remote origin --push`,
    },
  });
  ctx.store.projects.log({
    projectId,
    kind: 'approval',
    message: `Waiting for you: ${approval.summary}`,
  });
  return approval;
}

export async function publishRepo(
  ctx: EngineContext,
  gh: GitHub,
  approval: Approval,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const project = ctx.store.projects.get(approval.projectId);
  if (!project) return { ok: false, error: 'The project no longer exists.' };
  const { name, private: isPrivate } = approval.payload as { name: string; private: boolean };
  try {
    const url = await gh.createRepo({ cwd: project.repoPath, name, private: isPrivate });
    const repo = (await gh.repoOf(project.repoPath)) ?? name;
    ctx.store.projects.update(project.id, {
      github: {
        repo,
        prBranch: null,
        prUrl: null,
        prState: null,
        issue: project.github?.issue ?? null,
      },
    });
    ctx.store.projects.log({
      projectId: project.id,
      kind: 'approval',
      message: `Published to GitHub: ${url || repo}`,
    });
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
