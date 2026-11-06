import { expect, test, type Page } from '@playwright/test';
import { launch } from './integrity/kit';

/**
 * The first run (v1.0 F7): one AI required, two or more recommended, never forced. With 0, 1, 2
 * and 4 AIs connected: the button, the progress line and the team. Sign in to all goes one AI at
 * a time, and Look around first leaves it until next time.
 */
const welcome = (page: Page) => page.getByRole('dialog', { name: /Connect your AIs/ });

async function open(connected: number, env: Record<string, string> = {}) {
  const run = await launch('empty', 'light', {
    CONCLAVE_DEMO_FIRST_RUN: '1',
    CONCLAVE_DEMO_CONNECTED: String(connected),
    // Installed: Claude, Codex, Antigravity, and the v0.9 AIs.
    CONCLAVE_DEMO_TEAM: '9',
    ...env,
  });
  await run.page.setViewportSize({ width: 1320, height: 860 });
  return run;
}

test('no AI connected: Continue waits for one, and Look around first closes it', async () => {
  const run = await open(0);
  try {
    const page = run.page;
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByText('Connect at least one AI to continue.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByRole('button', { name: 'Look around first' }).click();
    await expect(welcome(page)).toBeHidden();
    await expect(page.getByRole('button', { name: /^Accounts/ })).toBeVisible();
  } finally {
    await run.close();
  }
});

test('one AI: Continue with 1 AI, a free second AI pointed out, reviews of its own work', async () => {
  const run = await open(1);
  try {
    const page = run.page;
    await expect(page.getByText(/^1 connected: enough to start/)).toBeVisible();
    await expect(page.getByText(/A free second AI/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue with 1 AI' }).click();
    await expect(page.getByRole('heading', { name: 'New chats' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    const team = page.getByRole('list', { name: 'Team' });
    await expect(team).toContainText('(only one AI, so it reviews its own work)');
    await page.getByRole('button', { name: 'Start using Conclave' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    // Done for good: the next launch goes straight in (checked through the setting).
    const settings = await page.evaluate(() =>
      (
        window as unknown as { conclave: { settings: { get(): Promise<unknown> } } }
      ).conclave.settings.get(),
    );
    expect(settings).toMatchObject({ firstRun: { done: true } });
  } finally {
    await run.close();
  }
});

test('two AIs: councils and reviews work; Sign in to all goes one at a time', async () => {
  const run = await open(2);
  try {
    const page = run.page;
    await expect(page.getByText(/^2 connected: councils/)).toBeVisible();
    const list = page.getByRole('region', { name: 'Your AIs' });
    const signInAll = list.getByRole('button', { name: 'Sign in to all' });
    await signInAll.click();
    // One sign-in runs; the other buttons wait for it.
    await expect(
      page.getByRole('status').filter({ hasText: 'A terminal window opened' }),
    ).toBeVisible();
    await expect(list.getByRole('button', { name: 'Signing in…' })).toHaveCount(1);
    // The demo finishes each sign-in by itself: every card turns green in turn.
    await expect(list.getByText('Connected', { exact: true })).toHaveCount(
      await list.getByRole('listitem').count(),
      { timeout: 30_000 },
    );
    await expect(page.getByText(/connected: everything works/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Team' })).not.toContainText('reviews its own');
  } finally {
    await run.close();
  }
});

test('four AIs: everything works, with a backup at every role', async () => {
  const run = await open(4);
  try {
    const page = run.page;
    await expect(
      page.getByText('4 connected: everything works, with a backup at every role.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const team = page.getByRole('list', { name: 'Team' });
    for (const role of ['Planning', 'Building', 'Reviews'])
      await expect(team.getByText(new RegExp(`^${role}: .+, then `))).toBeVisible();
  } finally {
    await run.close();
  }
});

test('a computer without Node.js is told what to do, not shown an npm error', async () => {
  const run = await launch('empty', 'light', {
    CONCLAVE_DEMO_FIRST_RUN: '1',
    CONCLAVE_DEMO_NO_NPM: '1',
  });
  try {
    const page = run.page;
    await page.setViewportSize({ width: 1320, height: 860 });
    const add = page.getByRole('region', { name: 'AIs you can add' });
    await expect(add.getByRole('button', { name: 'Get Node.js for Claude Code' })).toBeVisible();
    await expect(add.getByText(/isn't on this computer yet/).first()).toBeVisible();
    // Claude Code and Codex install through npm, so they don't offer Install yet.
    await expect(add.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
    // Once Node.js is there, Check again brings Install back.
    await run.app.evaluate(() => {
      delete process.env.CONCLAVE_DEMO_NO_NPM;
    });
    await add.getByRole('button', { name: 'Check again' }).first().click();
    await expect(add.getByRole('button', { name: 'Install', exact: true }).first()).toBeVisible();
    expect(run.errors).toEqual([]);
  } finally {
    await run.close();
  }
});
