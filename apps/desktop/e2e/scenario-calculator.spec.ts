import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Private test, scenario 1: a new calculator project from an empty folder, Ask me on, on your
// real accounts and your real Conclave data. Spends real usage: CONCLAVE_SCENARIO=1 only.
// It runs until the project needs you, meets its goal, pauses, or 50 minutes pass, and leaves
// the project in your app. It never answers the agents' mid-run questions for you.
test.skip(process.env.CONCLAVE_SCENARIO !== '1', 'set CONCLAVE_SCENARIO=1 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-1');
const sqlite = process.getBuiltinModule('node:sqlite');

function projectState(name: string) {
  const db = new sqlite.DatabaseSync(join(homedir(), '.conclave', 'conclave.db'), {
    readOnly: true,
  });
  try {
    const p = db
      .prepare(
        'SELECT id, status, status_reason FROM projects WHERE name = ? ORDER BY created_at DESC',
      )
      .get(name) as { id: string; status: string; status_reason: string | null } | undefined;
    if (!p) return undefined;
    const tasks = db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
      .all(p.id) as { status: string; n: number }[];
    return { ...p, tasks: Object.fromEntries(tasks.map((t) => [t.status, t.n])) };
  } finally {
    db.close();
  }
}

test('scenario 1: calculator from an empty folder, Ask me on', async () => {
  test.setTimeout(55 * 60_000);
  mkdirSync(shots, { recursive: true });
  const name = `calculator-${new Date().toISOString().slice(0, 10)}`;
  const { CONCLAVE_DEMO: _d, CONCLAVE_HOME: _h, ...env } = process.env;
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

    // Where: a brand-new folder; Conclave creates it and sets up git.
    await dialog.getByRole('radio', { name: /Create a new folder/ }).click();
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill(name);
    await shot('where');
    await dialog.getByRole('button', { name: 'Create folder and continue' }).click();

    // What: the goal; no test command yet, so the first task sets one up.
    await dialog
      .getByRole('textbox', { name: 'Goal' })
      .fill(
        'A calculator website in plain HTML, CSS and JavaScript (no build step, no dependencies): basic operations with correct operator precedence, decimals, clear and backspace, full keyboard support, and a playful, game-like animation on every button press. Open index.html to use it. Logic lives in calc.js with tests runnable by `node --test`.',
      );
    await expect(dialog.getByRole('radio', { name: 'Ask me' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await shot('what');
    await dialog.getByRole('button', { name: 'Next' }).click();

    // Clarify: one real planner run.
    await expect(
      dialog.getByText(/A few questions|First plan|Couldn't prepare questions/).first(),
    ).toBeVisible({ timeout: 5 * 60_000 });
    await shot('clarify');
    await page.waitForTimeout(500);
    const clarifyText = await dialog.innerText();
    console.log('\n--- CLARIFY ---\n' + clarifyText.slice(0, 4000));
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await shot('started');

    // Watch until it needs you, finishes, pauses or time runs out.
    const until = Date.now() + 50 * 60_000;
    let last = '';
    for (;;) {
      await page.waitForTimeout(30_000);
      const s = projectState(name);
      const line = `${s?.status} ${JSON.stringify(s?.tasks)} ${s?.status_reason ?? ''}`;
      if (line !== last) {
        console.log(new Date().toLocaleTimeString(), line);
        last = line;
        await shot(s?.status ?? 'unknown');
      }
      if (!s || ['needs_you', 'done', 'paused', 'stopped'].includes(s.status)) break;
      if (Date.now() > until) {
        console.log('Time is up; stopping the run.');
        break;
      }
    }
    await shot('final');
    console.log('\n--- PAGE ---\n' + (await page.locator('main').innerText()).slice(0, 6000));
  } finally {
    await app.close();
  }
});
