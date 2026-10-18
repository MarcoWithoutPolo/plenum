import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

// The whole project flow in demo mode: create → run → inspect a task → approve the merge.
const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots');
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

const git = (...args: string[]) =>
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
    {
      cwd: repo,
      encoding: 'utf8',
    },
  ).trim();

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'conclave-e2e-home-'));
  repo = mkdtempSync(join(tmpdir(), 'conclave-e2e-repo-'));
  mkdirSync(shots, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# greeter\n');
  writeFileSync(
    join(repo, 'check.js'),
    "const fs = require('fs');\nif (fs.existsSync('greet.js') && require('./greet.js')('Ada') !== 'Hello, Ada!') process.exit(1);\n",
  );
  writeFileSync(
    join(repo, 'package.json'),
    '{ "name": "greeter", "scripts": { "test": "node check.js" } }\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: { ...process.env, CONCLAVE_DEMO: '1', CONCLAVE_HOME: home, CONCLAVE_E2E_REPO: repo },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1320, height: 860 });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('creates a project from a repo, with the test command guessed', async () => {
  await page.getByRole('button', { name: /^Projects/ }).click();
  await expect(page.getByRole('heading', { name: 'Start your first project' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();

  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(dialog.getByLabel('Ready')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Test command' })).toHaveValue('npm test');

  // Validation: no goal yet.
  await dialog.getByRole('button', { name: 'Create and start' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Describe the goal');

  await dialog.getByRole('textbox', { name: 'Goal' }).fill('Add a greet() helper and document it.');
  await expect(dialog.getByText('Plans', { exact: true })).toBeVisible();
  await page.screenshot({ path: join(shots, '4-new-project.png') });
  await dialog.getByRole('button', { name: 'Create and start' }).click();
  await expect(dialog).toBeHidden();
});

test('runs on its own and asks before merging', async () => {
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/conclave-e2e-repo/);
  const banner = page.getByRole('region', { name: 'Ready to merge' });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText('Add a greet() helper');

  const tasks = page.getByRole('region', { name: 'Tasks' });
  await expect(tasks).toContainText('2 of 2 merged');
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity).toContainText('Tests passed');
  await expect(activity).toContainText(/Merged into conclave\/integration/);
  await page.screenshot({ path: join(shots, '5-project.png') });

  // Nothing reached the user's branch yet.
  expect(git('log', '--oneline', 'main')).not.toContain('conclave');
});

test('shows what a task changed', async () => {
  await page
    .getByRole('region', { name: 'Tasks' })
    .getByRole('button', { name: /Add a greet\(\) helper/ })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Add a greet() helper' });
  await expect(drawer).toContainText('Built by Codex');
  await expect(drawer).toContainText('Reviewed by Claude');
  await expect(drawer).toContainText('greet.js');
  await expect(drawer).toContainText('module.exports = (name) =>');
  await page.screenshot({ path: join(shots, '6-task.png') });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('approving merges the work into the base branch', async () => {
  await page
    .getByRole('region', { name: 'Ready to merge' })
    .getByRole('button', { name: 'Approve merge' })
    .click();
  await expect(page.getByRole('alert')).toContainText('Merged');
  await expect(page.getByRole('region', { name: 'Ready to merge' })).toBeHidden();
  expect(git('show', 'main:greet.js')).toContain('Hello, ${name}!');
  expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

  await page.getByRole('button', { name: /^Approvals/ }).click();
  await expect(page.getByRole('heading', { name: "You're all caught up" })).toBeVisible();
  await expect(page.getByText('Merged', { exact: false }).first()).toBeVisible();
});

test('usage shows every request the project made', async () => {
  await page.getByRole('button', { name: /^Usage/ }).click();
  await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
  const recent = page.getByRole('region', { name: 'Recent requests' });
  await expect(recent).toContainText('Project · build');
  await expect(recent).toContainText('Project · review');
  await expect(page.getByRole('region', { name: 'Codex usage' })).toContainText('Requests');
  await page.screenshot({ path: join(shots, '7-usage.png') });
});
