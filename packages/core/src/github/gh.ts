import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isNotFound, runCommand, type CommandResult } from '../process.js';
import type { LoginCommand } from '../adapters/types.js';

/** Runs `gh` (injectable, so tests replay recorded output). */
export type GhExec = (
  args: string[],
  opts?: { cwd?: string; stdin?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export interface GitHubStatus {
  installed: boolean;
  version?: string;
  signedIn: boolean;
  login?: string;
  scopes?: string[];
  gitProtocol?: string;
  /** One line for the Accounts card. */
  detail: string;
}

export interface GhRepo {
  nameWithOwner: string;
  description: string;
  isPrivate: boolean;
  pushedAt: string | null;
  language: string | null;
  defaultBranch: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface GhCheck {
  name: string;
  state: string;
  bucket: CheckBucket;
  link: string;
  workflow: string;
}

export interface GhPullRequest {
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: string | null;
  isDraft: boolean;
}

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

export class GhError extends Error {
  constructor(
    message: string,
    readonly result?: CommandResult,
  ) {
    super(message);
  }
}

/**
 * GitHub through the official `gh` CLI. Conclave never sees a token: `gh` holds the
 * sign-in, and only `auth status --json` fields without secrets are read.
 */
export class GitHub {
  readonly command: string;
  private readonly exec: GhExec;

  constructor(opts: { command?: string; exec?: GhExec } = {}) {
    this.command = opts.command ?? defaultGh();
    this.exec =
      opts.exec ??
      ((args, o = {}) =>
        runCommand(this.command, args, {
          timeoutMs: o.timeoutMs ?? 60_000,
          ...(o.cwd && { cwd: o.cwd }),
          ...(o.stdin !== undefined && { stdin: o.stdin }),
          // Never prompt: a headless gh that wants input fails instead of hanging.
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        }));
  }

  private async run(args: string[], opts?: Parameters<GhExec>[1]): Promise<string> {
    const result = await this.exec(args, opts);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || result.error || '').trim().split('\n')[0];
      throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`, result);
    }
    return result.stdout;
  }

  private async json<T>(args: string[], opts?: Parameters<GhExec>[1]): Promise<T> {
    return JSON.parse(await this.run(args, opts)) as T;
  }

  async detect(): Promise<GitHubStatus> {
    const version = await this.exec(['--version'], { timeoutMs: 15_000 });
    if (version.code !== 0) {
      return {
        installed: false,
        signedIn: false,
        detail: isNotFound(version) ? 'GitHub CLI (gh) is not installed' : 'gh did not start',
      };
    }
    const v = /gh version ([\d.]+)/.exec(version.stdout)?.[1];
    const auth = await this.exec(['auth', 'status', '--json', 'hosts'], { timeoutMs: 15_000 });
    const hosts = safeJson(auth.stdout) as
      | {
          hosts?: Record<
            string,
            {
              state?: string;
              active?: boolean;
              login?: string;
              scopes?: string;
              gitProtocol?: string;
            }[]
          >;
        }
      | undefined;
    const account =
      hosts?.hosts?.['github.com']?.find((a) => a.active) ?? hosts?.hosts?.['github.com']?.[0];
    if (!account || account.state !== 'success') {
      return {
        installed: true,
        ...(v && { version: v }),
        signedIn: false,
        detail: account ? 'Signed out or the sign-in expired' : 'Not signed in',
      };
    }
    const scopes = (account.scopes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      installed: true,
      ...(v && { version: v }),
      signedIn: true,
      ...(account.login && { login: account.login }),
      scopes,
      ...(account.gitProtocol && { gitProtocol: account.gitProtocol }),
      detail: `Signed in as ${account.login ?? 'unknown'}`,
    };
  }

  login(): LoginCommand {
    return {
      command: this.command,
      args: ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'],
      hint: 'A browser opens to sign in to GitHub. Come back here when gh says you are logged in.',
    };
  }

  async listRepos(owner?: string): Promise<GhRepo[]> {
    if (owner && !/^[\w.-]+$/.test(owner)) throw new GhError('Invalid owner');
    const rows = await this.json<
      {
        nameWithOwner: string;
        description: string | null;
        isPrivate: boolean;
        pushedAt: string | null;
        primaryLanguage: { name: string } | null;
        defaultBranchRef: { name: string } | null;
      }[]
    >([
      'repo',
      'list',
      ...(owner ? [owner] : []),
      '--json',
      'nameWithOwner,description,isPrivate,pushedAt,primaryLanguage,defaultBranchRef',
      '--limit',
      '200',
    ]);
    return rows
      .map((r) => ({
        nameWithOwner: r.nameWithOwner,
        description: r.description ?? '',
        isPrivate: r.isPrivate,
        pushedAt: r.pushedAt,
        language: r.primaryLanguage?.name ?? null,
        defaultBranch: r.defaultBranchRef?.name ?? null,
      }))
      .sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  }

  async listOrgs(): Promise<string[]> {
    return (await this.run(['org', 'list', '--limit', '100']))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[\w.-]+$/.test(l));
  }

  /** Clone into `dest` (which must not exist yet). */
  async clone(repo: string, dest: string): Promise<void> {
    if (!REPO_NAME.test(repo)) throw new GhError(`Invalid repository name: ${repo}`);
    if (existsSync(dest)) throw new GhError(`${dest} already exists. Pick another folder.`);
    await this.run(['repo', 'clone', repo, dest, '--', '--quiet'], { timeoutMs: 15 * 60_000 });
  }

  /** The GitHub repository behind a local clone, if it has one. */
  async repoOf(cwd: string): Promise<string | undefined> {
    const result = await this.exec(['repo', 'view', '--json', 'nameWithOwner'], { cwd });
    if (result.code !== 0) return undefined;
    const name = (safeJson(result.stdout) as { nameWithOwner?: string } | undefined)?.nameWithOwner;
    return name && REPO_NAME.test(name) ? name : undefined;
  }

  async listIssues(cwd: string): Promise<GhIssue[]> {
    const rows = await this.json<
      { number: number; title: string; body: string; url: string; labels: { name: string }[] }[]
    >(
      [
        'issue',
        'list',
        '--state',
        'open',
        '--limit',
        '50',
        '--json',
        'number,title,body,url,labels',
      ],
      {
        cwd,
      },
    );
    return rows.map((r) => ({ ...r, body: r.body ?? '', labels: r.labels.map((l) => l.name) }));
  }

  async issueComments(cwd: string, issue: number): Promise<{ author: string; body: string }[]> {
    const data = await this.json<{
      comments: { author: { login: string } | null; body: string }[];
    }>(['issue', 'view', String(Math.trunc(issue)), '--json', 'comments'], { cwd });
    return data.comments.map((c) => ({ author: c.author?.login ?? 'someone', body: c.body }));
  }

  /** Open a pull request; returns its URL (gh prints it, there's no JSON for create). */
  async createPullRequest(input: {
    cwd: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<string> {
    const out = await this.run(
      [
        'pr',
        'create',
        '--base',
        input.base,
        '--head',
        input.head,
        '--title',
        input.title,
        '--body-file',
        '-',
        ...(input.draft ? ['--draft'] : []),
      ],
      { cwd: input.cwd, stdin: input.body, timeoutMs: 120_000 },
    );
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(out)?.[0];
    if (!url) throw new GhError(`gh pr create printed no URL: ${out.trim().slice(0, 200)}`);
    return url;
  }

  /** CI checks; `gh pr checks` exits non-zero while checks fail or run, so the JSON is read anyway. */
  async checks(cwd: string, url: string): Promise<GhCheck[]> {
    const result = await this.exec(
      ['pr', 'checks', url, '--json', 'name,state,bucket,link,workflow'],
      { cwd },
    );
    const rows = safeJson(result.stdout);
    if (!Array.isArray(rows)) {
      if (/no checks reported/i.test(`${result.stdout} ${result.stderr}`)) return [];
      throw new GhError(
        `gh pr checks failed: ${(result.stderr || result.stdout).trim().split('\n')[0]}`,
      );
    }
    return (rows as GhCheck[]).map((c) => ({
      name: c.name,
      state: c.state,
      bucket: c.bucket,
      link: c.link,
      workflow: c.workflow ?? '',
    }));
  }

  async pullRequest(cwd: string, url: string): Promise<GhPullRequest> {
    return this.json<GhPullRequest>(['pr', 'view', url, '--json', 'url,state,mergedAt,isDraft'], {
      cwd,
    });
  }

  /** Create a GitHub repository from a local one and push it. */
  async createRepo(input: { cwd: string; name: string; private: boolean }): Promise<string> {
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(input.name)) throw new GhError('Invalid repository name');
    const out = await this.run(
      [
        'repo',
        'create',
        input.name,
        input.private ? '--private' : '--public',
        '--source',
        input.cwd,
        '--remote',
        'origin',
        '--push',
      ],
      { cwd: input.cwd, timeoutMs: 10 * 60_000 },
    );
    return /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(out)?.[0] ?? '';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** gh's usual install spots, so the app finds it even when PATH is stale. */
function defaultGh(): string {
  if (process.platform === 'win32') {
    for (const dir of [
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    ]) {
      const exe = dir && join(dir, 'GitHub CLI', 'gh.exe');
      if (exe && existsSync(exe)) return exe;
    }
  }
  return 'gh';
}

/** Install command for gh per platform, shown behind a confirm dialog. */
export function ghInstallCommand(): { command: string; args: string[] } | undefined {
  if (process.platform === 'win32') {
    return {
      command: 'winget',
      args: ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget'],
    };
  }
  if (process.platform === 'darwin') return { command: 'brew', args: ['install', 'gh'] };
  return undefined;
}
