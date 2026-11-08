import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Private test, scenario 5: a task that needs a package. The builder should ask to install it,
// you approve in the app, Plenum runs the exact command itself, and the task carries on.
// Real accounts and Plenum data; spends real usage (and runs npm install): PLENUM_SCENARIO=5.
test.skip(process.env.PLENUM_SCENARIO !== '5', 'set PLENUM_SCENARIO=5 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-5');
const sqlite = process.getBuiltinModule('node:sqlite');

function state(name: string) {
  const db = new sqlite.DatabaseSync(join(homedir(), '.plenum', 'plenum.db'), {
    readOnly: true,
  });
  try {
    const p = db
      .prepare(
        'SELECT id, status, status_reason, repo_path FROM projects WHERE name = ? ORDER BY created_at DESC',
      )
      .get(name) as
      { id: string; status: string; status_reason: string | null; repo_path: string } | undefined;
    if (!p) return undefined;
    const tasks = db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
      .all(p.id) as { status: string; n: number }[];
    const pending = db
      .prepare(
        "SELECT kind, summary, payload FROM approvals WHERE project_id = ? AND status = 'pending'",
      )
      .all(p.id) as { kind: string; summary: string; payload: string }[];
    return { ...p, tasks: Object.fromEntries(tasks.map((t) => [t.status, t.n])), pending };
  } finally {
    db.close();
  }
}

test('scenario 5: a task asks to install a package, you allow it, it carries on', async () => {
  test.setTimeout(55 * 60_000);
  mkdirSync(shots, { recursive: true });
  const name = `chime-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;
  const { PLENUM_DEMO: _d, PLENUM_HOME: _h, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: env as Record<string, string>,
  });
  let n = 0;
  const page = await app.firstWindow();
  const shot = (label: string) =>
    page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`) });
  try {
    await page.setViewportSize({ width: 1320, height: 860 });
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Projects/ })
      .click();
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    await dialog.getByRole('radio', { name: /Create a new folder/ }).click();
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill(name);
    await dialog.getByRole('button', { name: 'Create folder and continue' }).click();
    await dialog
      .getByRole('textbox', { name: 'Goal' })
      .fill(
        'A one-page site (index.html + chime.js) with a big button that plays a short chime when clicked. The sound playback must use the `howler` npm package (it is not installed yet; it needs `npm install howler`). Keep the logic that decides which note to play in notes.js as a pure function, with tests runnable by `node --test`, and a package.json whose test script is `node --test`.',
      );
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('button', { name: 'Skip questions' })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Wait for the install request (or anything that ends the run).
    let asked = false;
    const until = Date.now() + 45 * 60_000;
    let last = '';
    for (;;) {
      await page.waitForTimeout(15_000);
      const s = state(name);
      const line = `${s?.status} ${JSON.stringify(s?.tasks)} ${s?.status_reason ?? ''} pending=${JSON.stringify(s?.pending.map((p) => p.kind))}`;
      if (line !== last) {
        console.log(new Date().toLocaleTimeString(), line);
        last = line;
      }
      const install = s?.pending.find((p) => p.kind === 'install');
      if (install && !asked) {
        asked = true;
        console.log('INSTALL REQUEST', install.summary, install.payload);
        const card = page.getByRole('region', { name: 'Needs you' });
        await expect(card).toBeVisible({ timeout: 30_000 });
        await shot('install-request');
        await card.getByRole('button', { name: 'Allow install' }).click();
        await page.waitForTimeout(2_000);
        await shot('allowed');
        continue;
      }
      const other = s?.pending.find((p) => p.kind === 'question' || p.kind === 'network');
      if (other) {
        console.log('OTHER QUESTION (left for you):', other.kind, other.summary, other.payload);
        await shot('other-question');
        break;
      }
      if (!s || ['done', 'paused', 'stopped'].includes(s.status)) break;
      if (Date.now() > until) {
        console.log('Time is up.');
        break;
      }
    }
    await shot('final');
    const s = state(name)!;
    console.log('\nFINAL', s.status, JSON.stringify(s.tasks), s.status_reason);

    const git = (...a: string[]) =>
      execFileSync('git', a, { cwd: s.repo_path, encoding: 'utf8' }).trim();
    console.log('\n--- integration files ---');
    const files = git('ls-tree', '-r', '--name-only', 'plenum/integration').split('\n');
    console.log(
      files.filter((f) => !f.startsWith('node_modules/')).join('\n'),
      `\n(node_modules files committed: ${files.filter((f) => f.startsWith('node_modules/')).length})`,
    );
    console.log('\n--- package.json ---');
    try {
      console.log(git('show', 'plenum/integration:package.json'));
    } catch {
      console.log('(none)');
    }
    console.log('\n--- .gitignore ---');
    try {
      console.log(git('show', 'plenum/integration:.gitignore'));
    } catch {
      console.log('(none)');
    }
  } finally {
    await app.close();
  }
});
