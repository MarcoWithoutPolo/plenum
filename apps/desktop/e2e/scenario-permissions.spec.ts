import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test } from '@playwright/test';

// Private test, scenario 4: a project with a build step starts at permission level 2 (edit
// files only), then switches to level 3 (edit and run the project's checks) mid-run in
// Team and settings. Real accounts and Conclave data; spends real usage: CONCLAVE_SCENARIO=4.
test.skip(process.env.CONCLAVE_SCENARIO !== '4', 'set CONCLAVE_SCENARIO=4 to run');

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, 'screenshots', 'scenario-4');
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

const projectOf = (name: string) =>
  read(
    (db) =>
      db
        .prepare(
          'SELECT id, status, status_reason FROM projects WHERE name = ? ORDER BY created_at DESC',
        )
        .get(name) as { id: string; status: string; status_reason: string | null } | undefined,
  );

const countsOf = (id: string) =>
  read((db) =>
    Object.fromEntries(
      (
        db
          .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
          .all(id) as { status: string; n: number }[]
      ).map((r) => [r.status, r.n]),
    ),
  );

test('scenario 4: level 2, then 3 mid-run; checks run only at 3', async () => {
  test.setTimeout(60 * 60_000);
  mkdirSync(shots, { recursive: true });
  const name = `buildstep-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;

  // A seed repo with a test and a build step.
  const repo = join(mkdtempSync(join(tmpdir(), 'conclave-perm-')), name);
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'buildstep', private: true, scripts: { test: 'node --test', build: 'node build.js' } }, null, 2)}\n`,
  );
  writeFileSync(join(repo, 'src', 'greet.js'), 'exports.greet = (name) => `Hello, ${name}!`;\n');
  writeFileSync(
    join(repo, 'build.js'),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "const files = fs.readdirSync('src').filter((f) => f.endsWith('.js')).sort();",
      "fs.mkdirSync('dist', { recursive: true });",
      "const parts = files.map((f) => `// ${f}\\n(function (exports) {\\n${fs.readFileSync(path.join('src', f), 'utf8')}\\n})(module.exports);`);",
      "fs.writeFileSync('dist/bundle.js', parts.join('\\n'));",
      "const bundle = require(path.resolve('dist/bundle.js'));",
      "console.log('built dist/bundle.js with', Object.keys(bundle).join(', '));",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(repo, 'test', 'greet.test.js'),
    "const test = require('node:test');\nconst assert = require('node:assert');\nconst { greet } = require('../src/greet.js');\ntest('greet', () => assert.strictEqual(greet('Ada'), 'Hello, Ada!'));\n",
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Conclave Test', '-c', 'user.email=test@localhost', ...a],
      {
        cwd: repo,
      },
    );
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Seed with a build step');

  const { CONCLAVE_DEMO: _d, CONCLAVE_HOME: _h, ...env } = process.env;
  const app = await electron.launch({
    args: [join(here, '../out/main/index.js')],
    env: { ...env, CONCLAVE_E2E_REPO: repo } as Record<string, string>,
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
    await dialog.getByRole('button', { name: 'Choose a folder' }).click();
    await expect(dialog.getByLabel('Ready')).toBeVisible();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('textbox', { name: 'Goal' })
      .fill(
        'Three separate changes, one task each: (1) add src/farewell.js exporting farewell(name) that returns "Goodbye, <name>!", with a test; (2) add src/shout.js exporting shout(text) that upper-cases text and adds "!", with a test; (3) add a README.md that explains `npm test` and `npm run build` and lists every function in dist/bundle.js. `npm run build` must keep working after every change.',
      );
    await expect(
      dialog
        .getByRole('radiogroup', { name: 'Permission level' })
        .getByRole('radio', { name: '2' }),
    ).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog
      .getByRole('button', { name: 'Skip questions' })
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Level 2 until the first task is merged.
    const until = Date.now() + 50 * 60_000;
    let switched = false;
    let last = '';
    for (;;) {
      await page.waitForTimeout(10_000);
      const p = projectOf(name)!;
      const c = countsOf(p.id);
      const line = `${p.status} ${JSON.stringify(c)}`;
      if (line !== last) {
        console.log(new Date().toLocaleTimeString(), line);
        last = line;
      }
      if (!switched && (c.merged ?? 0) >= 1) {
        // Switch to level 3 in Team and settings; it applies from the next step.
        await page.getByRole('button', { name: 'Project actions' }).click();
        await page.getByRole('button', { name: /Team and settings/ }).click();
        const settings = page.getByRole('dialog', { name: 'Project settings' });
        await settings
          .getByRole('radiogroup', { name: 'Permission level' })
          .getByRole('radio', { name: '3' })
          .click();
        await settings
          .getByRole('radiogroup', { name: 'Permission level' })
          .scrollIntoViewIfNeeded();
        await page.waitForTimeout(800);
        await shot('settings-level-3');
        console.log(
          'SETTINGS NOTE',
          (await settings.getByRole('note').allInnerTexts()).join(' | '),
        );
        await settings.getByRole('button', { name: 'Save' }).click();
        await expect(settings).toBeHidden();
        switched = true;
        console.log(new Date().toLocaleTimeString(), 'SWITCHED to level 3');
      }
      if (
        p.status === 'needs_you' ||
        p.status === 'done' ||
        p.status === 'paused' ||
        p.status === 'stopped'
      )
        break;
      if (Date.now() > until) {
        console.log('Time is up.');
        break;
      }
    }
    await shot('final');
    const p = projectOf(name)!;
    console.log('\nFINAL', p.status, JSON.stringify(countsOf(p.id)), p.status_reason ?? '');
    console.log('\n--- BUILDS AND COMMANDS ---');
    const events = read(
      (db) =>
        db
          .prepare(
            "SELECT kind, provider, message, data FROM brain_events WHERE project_id = ? AND (kind = 'task' OR (kind = 'agent' AND message LIKE 'Ran %') OR kind = 'commit' OR kind = 'merge' OR kind = 'retry') ORDER BY id",
          )
          .all(p.id) as {
          kind: string;
          provider: string | null;
          message: string;
          data: string | null;
        }[],
    );
    for (const e of events) {
      const summary =
        e.kind === 'commit' && e.data
          ? `\n      summary: ${String((JSON.parse(e.data) as { summary?: string }).summary ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 300)}`
          : '';
      console.log(
        `${e.kind.padEnd(6)} ${(e.provider ?? '').padEnd(11)} ${e.message.slice(0, 220)}${summary}`,
      );
    }
  } finally {
    await app.close();
  }
});
