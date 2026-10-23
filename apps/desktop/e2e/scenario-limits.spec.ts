import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Private test, scenario 2: Codex is at its workspace spend cap. Its work must move to the next
// AI without using attempts, the project and Accounts must say Codex is out, and "Remove Codex
// from the team" must stop further tries. Real accounts and data: CONCLAVE_SCENARIO=2.
test.skip(process.env.CONCLAVE_SCENARIO !== '2', 'set CONCLAVE_SCENARIO=2 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-2');
const sqlite = process.getBuiltinModule('node:sqlite');

function read<T>(fn: (db: InstanceType<typeof sqlite.DatabaseSync>) => T): T {
  const db = new sqlite.DatabaseSync(join(homedir(), '.conclave', 'conclave.db'), {
    readOnly: true,
  });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test('scenario 2: Codex at its cap hands off, says so, and can leave the team', async () => {
  test.setTimeout(45 * 60_000);
  mkdirSync(shots, { recursive: true });
  const name = `limits-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;
  const { CONCLAVE_DEMO: _d, CONCLAVE_HOME: _h, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: env as Record<string, string>,
  });
  let n = 0;
  const page = await app.firstWindow();
  const shot = (label: string) =>
    page.screenshot({ path: join(shots, `${String(++n).padStart(2, '0')}-${label}.png`) });
  const project = () =>
    read(
      (db) =>
        db
          .prepare(
            'SELECT id, status, routing FROM projects WHERE name = ? ORDER BY created_at DESC',
          )
          .get(name) as { id: string; status: string; routing: string } | undefined,
    );
  const tasks = (id: string) =>
    read(
      (db) =>
        db
          .prepare(
            'SELECT title, status, attempts, built_by FROM tasks WHERE project_id = ? ORDER BY priority',
          )
          .all(id) as {
          title: string;
          status: string;
          attempts: number;
          built_by: string | null;
        }[],
    );
  const codexBuilds = (id: string) =>
    read(
      (db) =>
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_runs WHERE ref_id = ? AND provider = 'codex' AND role = 'builder'",
            )
            .get(id) as { n: number }
        ).n,
    );
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
        'Three small tasks, one each: (1) a package.json whose test script is `node --test` and a math.js exporting add(a, b) with a test; (2) subtract(a, b) in math.js with a test; (3) multiply(a, b) in math.js with a test.',
      );
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('button', { name: 'Skip questions' })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Codex is first in Builds by default; at its cap, the first build moves on.
    const banner = page.getByRole('region', { name: 'Codex is out of usage' });
    await expect(banner).toBeVisible({ timeout: 10 * 60_000 });
    await shot('banner');
    const p = project()!;
    console.log('BANNER', (await banner.innerText()).replace(/\s+/g, ' '));
    console.log('CODEX BUILD TRIES so far', codexBuilds(p.id));

    // Take Codex off this project's team; later tasks must not try it.
    await banner.getByRole('button', { name: 'Remove Codex from the team' }).click();
    await expect(banner).toBeHidden({ timeout: 15_000 });
    const routing = JSON.parse(project()!.routing) as Record<string, { provider: string }[]>;
    console.log('TEAM NOW', JSON.stringify(routing));
    expect(
      Object.values(routing)
        .flat()
        .some((s) => s.provider === 'codex'),
    ).toBe(false);
    const triesAtRemoval = codexBuilds(p.id);

    // Accounts says the same, from any screen.
    await page.getByRole('button', { name: /^Accounts/ }).click();
    const codexCard = page.getByRole('region', { name: 'OpenAI Codex' });
    await expect(codexCard.getByText(/Out of usage since/)).toBeVisible({ timeout: 30_000 });
    await shot('accounts');

    // Let it finish.
    const end = Date.now() + 35 * 60_000;
    let last = '';
    for (;;) {
      await page.waitForTimeout(15_000);
      const s = project()!;
      const line = `${s.status} ${JSON.stringify(tasks(s.id).map((t) => `${t.status}/${t.built_by}/${t.attempts}`))}`;
      if (line !== last) {
        console.log(new Date().toLocaleTimeString(), line);
        last = line;
      }
      if (['done', 'paused', 'stopped', 'needs_you'].includes(s.status) || Date.now() > end) break;
    }
    const final = tasks(p.id);
    console.log('\nFINAL', project()!.status);
    for (const t of final) console.log(JSON.stringify(t));
    console.log('CODEX BUILD TRIES at removal', triesAtRemoval, 'at the end', codexBuilds(p.id));
    expect(final.every((t) => t.attempts === 0 || t.built_by !== 'codex')).toBe(true);
    expect(codexBuilds(p.id)).toBe(triesAtRemoval);
  } finally {
    await app.close();
  }
});
