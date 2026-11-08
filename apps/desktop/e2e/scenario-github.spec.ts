import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

// Private test, scenario 6: GitHub end to end on a PRIVATE scratch repo, with your OK.
// Publish a seed project (approved in the app) → open an issue → clone it in the wizard and
// start from the issue → finish with a pull request → follow CI (and Fix it if a check fails).
// Merging on GitHub is left to you. PLENUM_SCENARIO=6 and PLENUM_SCRATCH_REPO=<name>.
test.skip(process.env.PLENUM_SCENARIO !== '6', 'set PLENUM_SCENARIO=6 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-6');
const repoName = process.env.PLENUM_SCRATCH_REPO ?? 'plenum-scratch';
const sqlite = process.getBuiltinModule('node:sqlite');
const gh = (...a: string[]) => execFileSync('gh', a, { encoding: 'utf8' }).trim();

function project(name: string) {
  const db = new sqlite.DatabaseSync(join(homedir(), '.plenum', 'plenum.db'), {
    readOnly: true,
  });
  try {
    const p = db
      .prepare(
        'SELECT id, status, status_reason, repo_path, github FROM projects WHERE name = ? ORDER BY created_at DESC',
      )
      .get(name) as
      | {
          id: string;
          status: string;
          status_reason: string | null;
          repo_path: string;
          github: string | null;
        }
      | undefined;
    if (!p) return undefined;
    const tasks = db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
      .all(p.id) as { status: string; n: number }[];
    const pending = db
      .prepare("SELECT kind FROM approvals WHERE project_id = ? AND status = 'pending'")
      .all(p.id) as { kind: string }[];
    return {
      ...p,
      github: p.github ? (JSON.parse(p.github) as { repo: string; prUrl: string | null }) : null,
      tasks: Object.fromEntries(tasks.map((t) => [t.status, t.n])),
      pending: pending.map((a) => a.kind),
    };
  } finally {
    db.close();
  }
}

async function until<T>(what: string, fn: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function goToProject(page: Page, name: string) {
  await page
    .getByRole('complementary')
    .getByRole('button', { name: /^Projects/ })
    .click();
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
}

/** Wait until the PR's checks settle; returns gh's check list. */
async function settledChecks(url: string) {
  return until(
    'CI checks to finish',
    () => {
      let out = '[]';
      try {
        out = execFileSync('gh', ['pr', 'checks', url, '--json', 'name,bucket,link'], {
          encoding: 'utf8',
        });
      } catch (err) {
        out = (err as { stdout?: string }).stdout ?? '[]';
      }
      const checks = JSON.parse(out || '[]') as { name: string; bucket: string; link: string }[];
      console.log(
        new Date().toLocaleTimeString(),
        'checks',
        JSON.stringify(checks.map((c) => `${c.name}:${c.bucket}`)),
      );
      return checks.length > 0 && checks.every((c) => c.bucket !== 'pending') ? checks : undefined;
    },
    15 * 60_000,
  );
}

test('scenario 6: publish, issue, clone, pull request, CI', async () => {
  test.setTimeout(80 * 60_000);
  mkdirSync(shots, { recursive: true });
  const login = (
    JSON.parse(gh('auth', 'status', '--json', 'hosts')) as {
      hosts: Record<string, { login: string; active: boolean }[]>;
    }
  ).hosts['github.com']!.find((a) => a.active)!.login;
  const full = `${login}/${repoName}`;

  // A small seed project with CI.
  const seed = join(mkdtempSync(join(tmpdir(), 'plenum-seed-')), repoName);
  mkdirSync(join(seed, 'test'), { recursive: true });
  mkdirSync(join(seed, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(seed, 'package.json'),
    `${JSON.stringify({ name: repoName, private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(seed, 'text.js'),
    "module.exports = { reverse: (s) => [...s].reverse().join('') };\n",
  );
  writeFileSync(
    join(seed, 'test', 'text.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { reverse } = require('../text.js');\n\ntest('reverse', () => assert.strictEqual(reverse('abc'), 'cba'));\n",
  );
  writeFileSync(
    join(seed, '.github', 'workflows', 'ci.yml'),
    'name: CI\non: [push, pull_request]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm test\n',
  );
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=Plenum Test', '-c', 'user.email=test@localhost', ...a], {
      cwd: seed,
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Seed with CI');

  const { PLENUM_DEMO: _d, PLENUM_HOME: _h, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: { ...env, PLENUM_E2E_REPO: seed } as Record<string, string>,
  });
  let n = 0;
  const page = await app.firstWindow();
  const shot = (label: string) =>
    page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`) });
  try {
    await page.setViewportSize({ width: 1320, height: 860 });

    // 1. Publish the seed through the app: a create_repo approval you approve.
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Projects/ })
      .click();
    await page.getByRole('button', { name: 'New project' }).click();
    let dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(dialog.getByLabel('Ready')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('textbox', { name: 'Goal' })
      .fill('Seed repository for the GitHub test.');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('button', { name: 'Skip questions' })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Save without starting' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(repoName);
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('button', { name: /Publish to GitHub/ }).click();
    const publish = page.getByRole('dialog', { name: 'Publish to GitHub' });
    await expect(publish.getByRole('textbox', { name: 'Repository name' })).toHaveValue(repoName);
    await expect(publish.getByRole('radio', { name: 'Private' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await shot('publish-dialog');
    await publish.getByRole('button', { name: 'Ask for approval' }).click();
    const approval = page.getByRole('article', { name: 'Publish to GitHub' });
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await shot('publish-approval');
    await approval.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('alert')).toContainText('Published to GitHub', {
      timeout: 120_000,
    });
    const visibility = JSON.parse(
      gh('repo', 'view', full, '--json', 'visibility,nameWithOwner'),
    ) as {
      visibility: string;
    };
    console.log('PUBLISHED', full, visibility.visibility);
    expect(visibility.visibility).toBe('PRIVATE');

    // 2. An issue to start from.
    const issueUrl = gh(
      'issue',
      'create',
      '--repo',
      full,
      '--title',
      'Add a capitalize() helper',
      '--body',
      'text.js should also export capitalize(word): the first character upper-cased, the rest unchanged; an empty string stays empty. Add tests in test/ next to the reverse() test.',
    );
    console.log('ISSUE', issueUrl);

    // 3. Clone it in the wizard and start from the issue.
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Projects/ })
      .click();
    await page.getByRole('button', { name: 'New project' }).click();
    dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('radio', { name: /Clone from GitHub/ }).click();
    await dialog.getByRole('textbox', { name: 'Search repositories' }).fill(repoName);
    await dialog.getByRole('option', { name: new RegExp(`${login}/${repoName}`) }).click();
    await shot('clone-pick');
    await dialog.getByRole('button', { name: 'Clone and continue' }).click();
    const issueChip = dialog.getByRole('button', { name: /Add a capitalize\(\) helper/ });
    await expect(issueChip).toBeVisible({ timeout: 60_000 });
    await issueChip.click();
    await expect(dialog.getByRole('textbox', { name: 'Test command' })).toHaveValue('npm test');
    await shot('from-issue');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('button', { name: 'Skip questions' })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // The clone is the second project with this folder name; the newest one is ours.
    const cloned = await until(
      'the cloned project',
      () => {
        const p = project(repoName);
        return p && p.repo_path !== seed.replace(/\\/g, '/') && p.github ? p : undefined;
      },
      60_000,
    );
    console.log('CLONED', cloned.repo_path, JSON.stringify(cloned.github));

    // 4. Let it work until the final approval.
    let last = '';
    const done = await until(
      'the project to finish',
      () => {
        const p = project(repoName)!;
        const line = `${p.status} ${JSON.stringify(p.tasks)} pending=${JSON.stringify(p.pending)}`;
        if (line !== last) {
          console.log(new Date().toLocaleTimeString(), line);
          last = line;
        }
        if (p.pending.some((k) => k === 'question' || k === 'install' || k === 'network')) {
          throw new Error(`An agent asked something; answer it in the app: ${line}`);
        }
        return ['done', 'paused', 'stopped'].includes(p.status) ? p : undefined;
      },
      40 * 60_000,
    );
    expect(done.status).toBe('done');

    // 5. Finish with a pull request.
    await goToProject(page, repoName);
    const finish = page.getByRole('article', { name: /Ready to merge|Ready for a pull request/ });
    await expect(finish).toBeVisible({ timeout: 30_000 });
    await finish.getByRole('radio', { name: 'Open a pull request' }).click();
    await shot('finish-choice');
    await finish.getByRole('button', { name: 'Open pull request' }).click();
    await expect(page.getByRole('alert')).toContainText('Pull request opened', {
      timeout: 120_000,
    });
    const prUrl = project(repoName)!.github!.prUrl!;
    console.log('PR', prUrl);
    const body = JSON.parse(
      gh('pr', 'view', prUrl, '--json', 'title,body,headRefName,baseRefName'),
    ) as {
      title: string;
      body: string;
      headRefName: string;
      baseRefName: string;
    };
    console.log('PR TITLE', body.title, '|', body.headRefName, '→', body.baseRefName);
    console.log('PR BODY\n' + body.body);

    // 6. Follow CI.
    const checks = await settledChecks(prUrl);
    await goToProject(page, repoName);
    await expect(page.getByRole('region', { name: 'Pull request' })).toBeVisible();
    await page.waitForTimeout(5_000);
    await shot('pr-card');
    const failing = checks.filter((c) => c.bucket === 'fail');
    console.log(
      'CI RESULT',
      failing.length ? `failing: ${failing.map((c) => c.name).join(', ')}` : 'all passing',
    );
    console.log('\nLeft for you: review and merge the pull request on GitHub:', prUrl);
  } finally {
    await app.close();
  }
});
