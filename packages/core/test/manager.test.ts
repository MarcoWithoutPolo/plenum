import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId, RunRequest } from '../src/index.js';
import {
  BrainManager,
  FakeAdapter,
  ProjectBusyError,
  Store,
  acquireLock,
  adapterMap,
  createProject,
  decideApproval,
  isProjectRunning,
  taskChanges,
} from '../src/index.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();

function repo(): string {
  const r = temp('conclave-repo-');
  git(r, 'init', '-q', '-b', 'main');
  writeFileSync(join(r, 'README.md'), '# demo\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  return r;
}

const PLAN = '{"done": false, "tasks": [{"title": "Add hello", "spec": "Create hello.txt"}]}';
const DONE = '{"done": true, "reason": "hello.txt exists"}';
const APPROVE = '{"approve": true, "issues": [], "summary": "ok"}';
const writeHello = (req: RunRequest) => writeFileSync(join(req.cwd, 'hello.txt'), 'hello\n');

async function setup(
  builder: ConstructorParameters<typeof FakeAdapter>[0] = { reply: 'done', act: writeHello },
) {
  const r = repo();
  const home = temp('conclave-home-');
  const store = new Store(':memory:');
  let plans = 0;
  const claude = new FakeAdapter(
    { reply: (req) => (req.role === 'planner' ? (plans++ === 0 ? PLAN : DONE) : APPROVE) },
    { id: 'claude' },
  );
  const codex = new FakeAdapter(builder, { id: 'codex' });
  const ctx = { store, adapters: adapterMap([claude, codex]), cwd: home };
  const ready: { provider: ProviderId }[] = [{ provider: 'claude' }, { provider: 'codex' }];
  const project = await createProject(store, ready, { repoPath: r, goal: 'Add hello.txt' });
  return { repo: r, home, store, ctx, project, manager: new BrainManager(ctx, home) };
}

async function until(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('BrainManager', () => {
  it('runs a project in the background, streams events, and finishes', async () => {
    const { store, project, manager, home } = await setup();
    const kinds: string[] = [];
    manager.onEvent((e) => kinds.push(e.kind));
    manager.start(project.id);
    expect(manager.isRunning(project.id)).toBe(true);
    await until(() => store.projects.get(project.id)?.status === 'done');
    await until(() => !manager.isRunning(project.id));
    expect(kinds).toEqual(expect.arrayContaining(['start', 'plan', 'merge', 'done', 'approval']));
    expect(isProjectRunning(home, project.id)).toBe(false); // lock released
  });

  it('stops mid-build and puts the task back untouched', async () => {
    const { store, project, manager } = await setup({
      reply: 'working '.repeat(400),
      delayMs: 20,
      act: writeHello,
    });
    manager.start(project.id);
    await until(() => store.projects.listTasks(project.id)[0]?.status === 'building');
    await manager.stop(project.id);

    const [task] = store.projects.listTasks(project.id);
    expect(task?.status).toBe('queued');
    expect(task?.attempts).toBe(0);
    expect(store.projects.get(project.id)?.status).toBe('stopped');
    expect(manager.isRunning(project.id)).toBe(false);
  });

  it('pauses projects a closed app left running', async () => {
    const { store, project, manager } = await setup();
    store.projects.setStatus(project.id, 'running');
    expect(manager.recoverOrphans().map((p) => p.id)).toEqual([project.id]);
    expect(store.projects.get(project.id)?.status).toBe('paused');
  });

  it('records each agent run in the usage history', async () => {
    const { store, project, manager } = await setup();
    manager.start(project.id);
    await until(() => store.projects.get(project.id)?.status === 'done');
    await until(() => !manager.isRunning(project.id));
    const runs = store.usage.recent();
    expect(runs.map((r) => [r.provider, r.role, r.source])).toEqual([
      ['claude', 'planner', 'project'],
      ['claude', 'reviewer', 'project'],
      ['codex', 'builder', 'project'],
      ['claude', 'planner', 'project'],
    ]);
    expect(store.usage.totals(0).find((t) => t.provider === 'claude')?.runs).toBe(3);
    expect(store.usage.daily(7).reduce((n, d) => n + d.runs, 0)).toBe(4);
  });
});

describe('run lock', () => {
  it('lets one brain hold a project and takes over stale locks', () => {
    const path = join(temp('conclave-lock-'), 'run.lock');
    const lock = acquireLock(path);
    expect(() => acquireLock(path)).toThrow(ProjectBusyError);
    lock.release();
    writeFileSync(path, '999999999'); // a process that no longer exists
    acquireLock(path).release();
  });
});

describe('approving the merge', () => {
  async function finished() {
    const s = await setup();
    s.manager.start(s.project.id);
    await until(() => s.store.projects.get(s.project.id)?.status === 'done');
    await until(() => !s.manager.isRunning(s.project.id));
    const [approval] = s.store.projects.approvals(s.project.id, 'pending');
    return { ...s, approval: approval! };
  }

  it('merges the integration branch into the checked-out base branch', async () => {
    const { ctx, home, repo: r, approval, store, project } = await finished();
    const result = await decideApproval(ctx, home, approval.id, 'approved');
    expect(result.ok).toBe(true);
    expect(git(r, 'show', 'main:hello.txt')).toBe('hello');
    expect(git(r, 'log', '--oneline', '-1')).toContain('Merge conclave/integration');
    expect(store.projects.approvals(project.id, 'pending')).toEqual([]);
    expect(store.projects.events(project.id).at(-1)?.message).toMatch(
      /^You approved: merged into main/,
    );
  });

  it('refuses while the base branch has uncommitted changes, changing nothing', async () => {
    const { ctx, home, repo: r, approval } = await finished();
    writeFileSync(join(r, 'README.md'), '# edited, not committed\n');
    const result = await decideApproval(ctx, home, approval.id, 'approved');
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('uncommitted changes'),
    });
    expect(git(r, 'log', '--oneline')).not.toContain('Merge');
    // Still waiting, so it can be approved once the work is committed.
    git(r, 'commit', '-qam', 'my edit');
    expect((await decideApproval(ctx, home, approval.id, 'approved')).ok).toBe(true);
  });

  it('merges in a temporary worktree when the base branch is not checked out', async () => {
    const { ctx, home, repo: r, approval } = await finished();
    git(r, 'switch', '-q', '-c', 'my-feature');
    expect((await decideApproval(ctx, home, approval.id, 'approved')).ok).toBe(true);
    expect(git(r, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('my-feature');
    expect(git(r, 'show', 'main:hello.txt')).toBe('hello');
  });

  it('records a rejection without touching the repo', async () => {
    const { ctx, home, repo: r, approval } = await finished();
    const result = await decideApproval(ctx, home, approval.id, 'rejected');
    expect(result).toMatchObject({ ok: true, approval: { status: 'rejected' } });
    expect(git(r, 'log', '--oneline')).not.toContain('Merge');
    expect(await decideApproval(ctx, home, approval.id, 'approved')).toMatchObject({ ok: false });
  });

  it('shows what a merged task changed', async () => {
    const { ctx, home, store, project } = await finished();
    const [task] = store.projects.listTasks(project.id);
    expect(await taskChanges(ctx, home, task!.id)).toContain('+hello');
  });
});
