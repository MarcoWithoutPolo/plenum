import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeAdapter,
  GitHub,
  Store,
  adapterMap,
  countFiles,
  createProject,
  createProjectFolder,
  decideApproval,
  fixFailingCheck,
  inspectFolder,
  pullRequestBody,
  pullRequestStatus,
  pushBranch,
  requestPublish,
  setUpGit,
  type CommandResult,
  type GhExec,
} from '../src/index.js';
import { fixturePath } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
const fixture = (name: string) => readFileSync(fixturePath(`gh/${name}`), 'utf8');
const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });

/** A fake gh that answers by subcommand and records every call. */
function fakeGh(
  answers: Record<string, CommandResult | ((args: string[], stdin?: string) => CommandResult)>,
) {
  const calls: { args: string[]; stdin?: string; cwd?: string }[] = [];
  const exec: GhExec = async (args, opts = {}) => {
    calls.push({
      args,
      ...(opts.stdin !== undefined && { stdin: opts.stdin }),
      ...(opts.cwd && { cwd: opts.cwd }),
    });
    const key = Object.keys(answers)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(' ').startsWith(k));
    const answer = key
      ? answers[key]!
      : { code: 1, stdout: '', stderr: `unexpected: gh ${args.join(' ')}` };
    return typeof answer === 'function' ? answer(args, opts.stdin) : answer;
  };
  return { gh: new GitHub({ command: 'gh', exec }), calls };
}

describe('GitHub through gh', () => {
  it('reads the signed-in account without touching tokens', async () => {
    const { gh, calls } = fakeGh({
      '--version': ok(fixture('version.txt')),
      'auth status': ok(fixture('auth-status.json')),
    });
    expect(await gh.detect()).toMatchObject({
      installed: true,
      version: '2.96.0',
      signedIn: true,
      login: 'octocat',
      scopes: ['gist', 'read:org', 'repo', 'workflow'],
      detail: 'Signed in as octocat',
    });
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain('token');
  });

  it('reports a missing or signed-out gh', async () => {
    const missing = fakeGh({
      '--version': { code: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' },
    });
    expect(await missing.gh.detect()).toMatchObject({ installed: false, signedIn: false });
    const out = fakeGh({
      '--version': ok(fixture('version.txt')),
      'auth status': { code: 1, stdout: '{"hosts":{}}', stderr: '' },
    });
    expect(await out.gh.detect()).toMatchObject({
      installed: true,
      signedIn: false,
      detail: 'Not signed in',
    });
  });

  it('lists repositories, most recently pushed first', async () => {
    const { gh } = fakeGh({ 'repo list': ok(fixture('repo-list.json')) });
    const repos = await gh.listRepos();
    expect(repos.map((r) => [r.nameWithOwner, r.isPrivate, r.language])).toEqual([
      ['octocat/calculator', true, null],
      ['octocat/landing', false, 'HTML'],
    ]);
  });

  it('reads failing checks even though gh exits non-zero', async () => {
    const { gh } = fakeGh({
      'pr checks': { code: 1, stdout: fixture('pr-checks.json'), stderr: '' },
    });
    const checks = await gh.checks('.', 'https://github.com/octocat/calculator/pull/7');
    expect(checks.map((c) => [c.name, c.bucket])).toEqual([
      ['test (ubuntu-latest)', 'fail'],
      ['lint', 'pass'],
    ]);
  });

  it('refuses unsafe repository names before calling gh', async () => {
    const { gh, calls } = fakeGh({});
    await expect(gh.clone('octocat/x; rm -rf /', join(tmpdir(), 'nope'))).rejects.toThrow(
      /Invalid/,
    );
    expect(calls).toEqual([]);
  });
});

describe('Folder and git setup', () => {
  it('tells a ready repo, a plain folder, a nested folder and a repo without commits apart', async () => {
    const plain = temp('conclave-plain-');
    writeFileSync(join(plain, 'index.html'), '<h1>hi</h1>');
    expect(await inspectFolder(plain)).toMatchObject({ kind: 'not_git', files: 1, large: false });
    expect(await inspectFolder(join(plain, 'missing'))).toMatchObject({ kind: 'missing' });

    const empty = temp('conclave-empty-');
    git(empty, 'init', '-q', '-b', 'main');
    expect(await inspectFolder(empty)).toMatchObject({ kind: 'no_commits' });

    const repo = temp('conclave-ready-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"vitest"}}');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    expect(await inspectFolder(repo)).toMatchObject({
      kind: 'ready',
      branch: 'main',
      suggestedTest: 'npm test',
    });
    mkdirSync(join(repo, 'src'));
    expect(await inspectFolder(join(repo, 'src'))).toMatchObject({
      kind: 'nested',
      branch: 'main',
    });
  });

  it('sets up git with a stack .gitignore and a first commit', async () => {
    const dir = temp('conclave-setup-');
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const setup = await setUpGit(dir);
    expect(setup.branch).toBe('main');
    expect(setup.ignored).toEqual(
      expect.arrayContaining(['node_modules/', 'dist/', '.env', '.env.*']),
    );
    expect(git(dir, 'log', '--oneline')).toContain('Start');
    expect(git(dir, 'ls-files')).not.toContain('.env\n');
    expect(git(dir, 'ls-files').split('\n')).toEqual(['.gitignore', 'package.json']);
    await expect(setUpGit(dir)).rejects.toThrow(/already has git/);
  });

  it('never touches an existing .gitignore and commits an empty repo', async () => {
    const dir = temp('conclave-keep-');
    writeFileSync(join(dir, '.gitignore'), 'mine\n');
    git(dir, 'init', '-q', '-b', 'main');
    const setup = await setUpGit(dir);
    expect(setup.ignored).toEqual([]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('creates new folders but refuses one that exists and has files', () => {
    const parent = temp('conclave-parent-');
    const made = createProjectFolder(parent, 'Calculator');
    writeFileSync(join(made, 'x'), '1');
    expect(() => createProjectFolder(parent, 'Calculator')).toThrow(/isn't empty/);
    expect(() => createProjectFolder(parent, 'a/b')).toThrow(/folder name/);
  });

  it('stops counting files just past the limit', () => {
    const dir = temp('conclave-count-');
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `f${i}`), '');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'skip'), '');
    expect(countFiles(dir)).toBe(12);
    expect(countFiles(dir, 5)).toBe(5);
  });
});

describe('Pull requests', () => {
  async function finishedProject() {
    const remote = temp('conclave-remote-');
    git(remote, 'init', '-q', '--bare', '-b', 'main');
    const repo = temp('conclave-pr-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'branch', 'conclave/integration');
    git(repo, 'checkout', '-q', 'conclave/integration');
    writeFileSync(join(repo, 'sum.js'), 'module.exports = (a, b) => a + b;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'sum');
    git(repo, 'checkout', '-q', 'main');

    const home = temp('conclave-pr-home-');
    const store = new Store(':memory:');
    const ctx = {
      store,
      adapters: adapterMap([new FakeAdapter({ reply: 'x' }, { id: 'claude' })]),
      cwd: home,
    };
    const project = await createProject(store, [{ provider: 'claude' }], {
      repoPath: repo,
      name: 'Calculator App',
      goal: 'Ship a working sum function',
    });
    const [task] = store.projects.addTasks(project.id, [{ title: 'Add sum', spec: 'x' }]);
    store.projects.updateTask(task!.id, {
      status: 'merged',
      builtBy: 'codex',
      reviewedBy: 'claude',
    });
    store.decisions.add({
      projectId: project.id,
      kind: 'decision',
      question: 'Strings',
      answer: 'No',
      source: 'you',
    });
    const approval = store.projects.requestApproval({
      projectId: project.id,
      kind: 'push',
      summary: 'Merge',
    });
    return { remote, repo, home, store, ctx, project, approval };
  }

  it('pushes the work to its own branch and opens a pull request once you approve', async () => {
    const { remote, home, store, ctx, project, approval } = await finishedProject();
    const url = 'https://github.com/octocat/calculator/pull/7';
    const { gh, calls } = fakeGh({
      'repo view': ok('{"nameWithOwner":"octocat/calculator"}'),
      'pr create': ok(`${url}\n`),
    });
    const outcome = await decideApproval(ctx, home, approval.id, 'approved', undefined, {
      via: 'pr',
      github: gh,
    });
    expect(outcome).toMatchObject({ ok: true, url });
    expect(git(remote, 'branch', '--list')).toContain('conclave/calculator-app');
    expect(git(remote, 'log', '--oneline', 'main')).not.toContain('sum');

    const create = calls.find((c) => c.args[0] === 'pr')!;
    expect(create.args).toEqual(
      expect.arrayContaining([
        '--base',
        'main',
        '--head',
        'conclave/calculator-app',
        '--body-file',
        '-',
      ]),
    );
    expect(create.stdin).toContain('- Strings: No');
    expect(create.stdin).toContain('- [x] Add sum (built by codex, reviewed by claude)');
    expect(create.stdin).not.toContain(project.repoPath);
    expect(store.projects.get(project.id)?.github).toMatchObject({
      repo: 'octocat/calculator',
      prBranch: 'conclave/calculator-app',
      prUrl: url,
      prState: 'open',
    });
  });

  it('never overwrites a remote branch that diverged; it picks the next name', async () => {
    const { remote, repo } = await finishedProject();
    const other = temp('conclave-other-');
    git(other, 'clone', '-q', remote, '.');
    git(other, 'checkout', '-q', '-b', 'conclave/x');
    writeFileSync(join(other, 'theirs.txt'), 'theirs');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'theirs');
    git(other, 'push', '-q', 'origin', 'conclave/x');

    expect(await pushBranch(repo, 'conclave/integration', 'conclave/x')).toEqual({
      ok: true,
      branch: 'conclave/x-2',
    });
    expect(
      await pushBranch(repo, 'conclave/integration', 'conclave/x', { exact: true }),
    ).toMatchObject({ ok: false });
    expect(
      await pushBranch(repo, 'conclave/integration', 'main', { protect: 'main' }),
    ).toMatchObject({ ok: false });
  });

  it('follows the PR: merged on GitHub, and a failing check becomes a task', async () => {
    const { ctx, store, project } = await finishedProject();
    const url = 'https://github.com/octocat/calculator/pull/7';
    store.projects.update(project.id, {
      github: {
        repo: 'octocat/calculator',
        prBranch: 'conclave/calculator-app',
        prUrl: url,
        prState: 'open',
        issue: null,
      },
    });
    const open = fakeGh({
      'pr view': ok(JSON.stringify({ url, state: 'OPEN', mergedAt: null, isDraft: false })),
      'pr checks': { code: 1, stdout: fixture('pr-checks.json'), stderr: '' },
    });
    const status = await pullRequestStatus(ctx, open.gh, project.id);
    expect(status?.failing.map((c) => c.name)).toEqual(['test (ubuntu-latest)']);
    const fix = fixFailingCheck(ctx, project.id, status!.failing[0]!);
    expect(fix.title).toBe('Fix the failing CI check: test (ubuntu-latest)');
    expect(fix.spec).toContain('actions/runs/1/job/2');

    const merged = fakeGh({
      'pr view': ok(
        JSON.stringify({ url, state: 'MERGED', mergedAt: '2026-10-23T10:00:00Z', isDraft: false }),
      ),
      'pr checks': ok('[]'),
    });
    await pullRequestStatus(ctx, merged.gh, project.id);
    expect(store.projects.get(project.id)?.github?.prState).toBe('merged');
    expect(store.projects.events(project.id).some((e) => e.message === 'Merged on GitHub')).toBe(
      true,
    );
  });

  it('publishes a local project only after you approve the exact command', async () => {
    const { ctx, store, project, home } = await finishedProject();
    const approval = requestPublish(ctx, project.id, { name: 'calculator', private: true });
    expect((approval.payload as { command: string }).command).toBe(
      'gh repo create calculator --private --source . --remote origin --push',
    );
    const { gh, calls } = fakeGh({
      'repo create': ok('https://github.com/octocat/calculator\n'),
      'repo view': ok('{"nameWithOwner":"octocat/calculator"}'),
    });
    const outcome = await decideApproval(ctx, home, approval.id, 'approved', undefined, {
      github: gh,
    });
    expect(outcome).toMatchObject({ ok: true, url: 'https://github.com/octocat/calculator' });
    expect(calls[0]?.args).toEqual([
      'repo',
      'create',
      'calculator',
      '--private',
      '--source',
      project.repoPath,
      '--remote',
      'origin',
      '--push',
    ]);
    expect(store.projects.get(project.id)?.github?.repo).toBe('octocat/calculator');
    expect(pullRequestBody(ctx, store.projects.get(project.id)!)).toContain('Opened by Conclave.');
  });
});
