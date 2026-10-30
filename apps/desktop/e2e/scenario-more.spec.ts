import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  checker,
  events,
  launch,
  pkg,
  query,
  repo,
  settled,
  stamp,
  status,
  tasks,
  waitFor,
  openProject,
} from './scenario-kit.js';

// Private tests, scenarios 15–20 (v0.9), on your real accounts and Conclave data. They spend real
// usage (Copilot Free counts premium requests). Pick them: CONCLAVE_SCENARIO=15,16,17,18,19,20.
// Scenario 21 (a new AI at its usage limit) is covered by recorded messages in unit tests: none
// of the new AIs can be pushed to its limit on purpose.
const which = (process.env.CONCLAVE_SCENARIO ?? '').split(',').map((s) => s.trim());

type Reply = {
  reply: {
    ok: boolean;
    content: string;
    error: string | null;
    model: string | null;
    effort: string | null;
  };
};

/** One chat message to a seat through the app, the way the Chat screen sends it. */
async function ask(
  api: <T>(fn: string, ...args: unknown[]) => Promise<T>,
  seat: { provider: string; model?: string; effort?: string },
  text: string,
) {
  const thread = await api<{ id: string }>('chat.create', seat);
  return api<Reply>('chat.send', {
    requestId: `s-${Math.random()}`,
    threadId: thread.id,
    text,
    seat,
  });
}

const PONG = 'Reply with exactly the word: pong';

// ── 15: each new AI chats, then joins a council with Claude, Codex and Antigravity ───────────
test('scenario 15: the new AIs chat and join a council', async () => {
  test.skip(!which.includes('15'), 'set CONCLAVE_SCENARIO=15 to run');
  test.setTimeout(20 * 60_000);
  const { checks, check } = checker();
  const { app, api } = await launch('15');
  try {
    const seats = [
      { provider: 'copilot' },
      { provider: 'cursor' },
      { provider: 'grok' },
      // 1B models miss exact instructions ("bubble" for pong); a 14B one follows them.
      { provider: 'local', model: 'qwen2.5-coder:14b' },
    ];
    for (const seat of seats) {
      const { reply } = await ask(api, seat, PONG);
      check(
        `${seat.provider} answers in chat`,
        reply.ok && /pong/i.test(reply.content),
        reply.error ?? reply.content.slice(0, 80),
      );
    }
    const round = await api<{
      answers: { seat: { provider: string }; message: { ok: boolean; error: string | null } }[];
      merged: { ok: boolean; content: string };
    }>('council.ask', {
      requestId: `council-${stamp}`,
      question:
        'In one sentence: what is the safest way to store a small JSON settings file in a desktop app?',
      members: [
        { provider: 'claude', model: 'haiku' },
        { provider: 'codex' },
        { provider: 'antigravity' },
        ...seats,
      ],
      synthesizer: { provider: 'claude', model: 'haiku' },
    });
    for (const a of round.answers) {
      check(`${a.seat.provider} answered the council`, a.message.ok, a.message.error ?? '');
    }
    check(
      'the council merged seven answers',
      round.merged.ok && round.answers.length === 7,
      `${round.answers.length} answers`,
    );
  } finally {
    console.log(`\nSCENARIO 15: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 19: the picker's model and effort reach each CLI exactly ─────────────────────────────────
test('scenario 19: the picker sets model and effort per provider', async () => {
  test.skip(!which.includes('19'), 'set CONCLAVE_SCENARIO=19 to run');
  test.setTimeout(15 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot } = await launch('19');
  const pick = async (provider: string, model: RegExp, effort?: string, maker?: string) => {
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('button', { name: 'Choose model' }).click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await picker
      .getByRole('navigation', { name: 'Providers' })
      .getByRole('button', { name: new RegExp(`^${provider}:`) })
      .click();
    // Long lists of many makers' models (Cursor's) show one maker at a time.
    const chips = picker.getByRole('tablist', { name: 'Model makers' });
    if (maker && (await chips.count()))
      await chips.getByRole('tab', { name: new RegExp(`^${maker}`) }).click();
    await picker.getByRole('option', { name: model }).first().click();
    if (effort) await picker.getByRole('radio', { name: effort, exact: true }).click();
    else await page.keyboard.press('Escape');
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill(PONG);
    await box.press('Enter');
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 300_000 });
    await shot(provider.toLowerCase());
  };
  const last = () =>
    query<{
      provider: string;
      model: string | null;
      effort: string | null;
      ok: number;
      content: string;
    }>(
      "SELECT provider, model, effort, ok, content FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1",
    )[0]!;
  try {
    await pick('Codex', /^GPT-6-Luna/, 'Low');
    let m = last();
    check(
      'Codex ran GPT-6-Luna at low',
      m.ok === 1 && m.model === 'gpt-6-luna' && m.effort === 'low',
      JSON.stringify(m).slice(0, 160),
    );
    // Cursor's free plan includes Grok 4.7: its effort is part of the id.
    await pick('Cursor', /^Grok 4\.7/, 'High', 'Grok');
    m = last();
    check(
      'Cursor ran Grok 4.7 High (its effort is in the id) on the free plan',
      m.ok === 1 && /grok.?4\.7/i.test(m.model ?? '') && !m.effort,
      JSON.stringify(m).slice(0, 160),
    );
    await pick('Grok', /^Grok 4\.7/, 'Extra High');
    m = last();
    check(
      'Grok Build ran at xhigh',
      m.ok === 1 && m.effort === 'xhigh',
      JSON.stringify(m).slice(0, 160),
    );
    await pick('Claude', /^Haiku/, 'Low');
    m = last();
    check(
      'Claude ran Haiku at low',
      m.ok === 1 && /haiku/i.test(m.model ?? '') && m.effort === 'low',
      JSON.stringify(m).slice(0, 160),
    );
  } finally {
    console.log(`\nSCENARIO 19: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

/** A small Node project for the build scenarios. */
function mathRepo(scenario: string, name: string) {
  return repo(scenario, name, {
    'package.json': pkg(name),
    'README.md': `# ${name}\n`,
  });
}

async function runProject(
  page: Page,
  api: <T>(fn: string, ...args: unknown[]) => Promise<T>,
  input: Record<string, unknown>,
  minutes: number,
) {
  const p = await api<{ id: string }>('projects.create', input);
  await api('projects.start', p.id);
  await openProject(page, String(input.name));
  await waitFor(
    page,
    () =>
      status(p.id).status === 'done' ||
      (settled(p.id) && tasks(p.id).some((t) => t.status === 'merged')),
    minutes * 60_000,
  );
  return p.id;
}

// ── 16 + 18: Cursor builds at level 2; a local model reviews through Ollama ──────────────────
// ── 20: finish with "Merge here, then push"; a later push behind the remote is refused ──────
test('scenarios 16, 18 and 20: Cursor builds, a local model reviews, merge and push', async () => {
  test.skip(!['16', '18', '20'].some((s) => which.includes(s)), 'set CONCLAVE_SCENARIO=16,18,20');
  test.setTimeout(60 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('16');
  try {
    const name = `strings-${stamp}`;
    const dir = mathRepo('16', name);
    // A bare repo stands in for GitHub: creating a real GitHub repo needs your go-ahead.
    const remote = mkdtempSync(join(tmpdir(), 'scenario-20-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: remote });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir });
    const id = await runProject(
      page,
      api,
      {
        repoPath: dir,
        name,
        goal: 'A tiny string helpers module: strings.js exporting capitalize(s) and slugify(s) (lowercase, words joined by hyphens, punctuation dropped), with node:test tests in test/strings.test.js covering empty strings, spaces and punctuation. npm test runs node --test. Keep it to those two functions.',
        routing: {
          planner: [{ provider: 'claude', model: 'haiku' }],
          builder: [{ provider: 'cursor' }],
          reviewer: [
            { provider: 'local', model: 'gpt-oss:20b' },
            { provider: 'claude', model: 'haiku' },
          ],
        },
        adaptiveTeam: false,
        maxAttempts: 2,
        askPolicy: 'decide',
      },
      40,
    );
    await shot('done');
    const t = tasks(id);
    const merged = t.filter((x) => x.status === 'merged');
    check(
      '16: Cursor built the merged work',
      merged.length > 0 && merged.every((x) => x.built_by === 'cursor'),
      t.map((x) => `${x.title}: ${x.status} by ${x.built_by}`).join('; '),
    );
    check(
      '16: a different AI reviewed it',
      merged.every((x) => x.reviewed_by && x.reviewed_by !== 'cursor'),
      merged.map((x) => x.reviewed_by).join(', '),
    );
    const outside = events(id).filter((e) => /outside its working folder/.test(e.message));
    check(
      '16: nothing written outside the worktree',
      outside.length === 0,
      outside[0]?.message ?? '',
    );
    check(
      '18: the local model reviewed through Ollama',
      merged.some((x) => x.reviewed_by === 'local'),
      merged.map((x) => x.reviewed_by).join(', '),
    );
    const tooBig = await ask(api, { provider: 'local', model: 'no-such-model:70b' }, PONG);
    check(
      '18: a model Ollama does not have says so',
      !tooBig.reply.ok && /isn't downloaded in Ollama/.test(tooBig.reply.error ?? ''),
      tooBig.reply.error ?? '',
    );

    // 20: finish with merge and push, then a push behind the remote is refused.
    const approvals =
      await api<{ approval: { id: string; kind: string; projectId: string } }[]>('approvals.list');
    const finish = approvals.find(
      (a) => a.approval.projectId === id && a.approval.kind === 'merge_base',
    );
    if (finish) {
      const result = await api<{ ok: boolean; error?: string; pushError?: string }>(
        'approvals.decide',
        finish.approval.id,
        'approved',
        { via: 'merge_push' },
      );
      const onRemote = execFileSync('git', ['log', '--oneline', '-1', 'main'], {
        cwd: remote,
        encoding: 'utf8',
      });
      check(
        '20: merged here and pushed',
        result.ok && !result.pushError && /Merge conclave\/integration/.test(onRemote),
        result.error ?? result.pushError ?? onRemote,
      );
      const other = mkdtempSync(join(tmpdir(), 'scenario-20-other-'));
      execFileSync('git', ['clone', '-q', remote, '.'], { cwd: other });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=O',
          '-c',
          'user.email=o@localhost',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'theirs',
        ],
        { cwd: other },
      );
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=S',
          '-c',
          'user.email=s@localhost',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'mine',
        ],
        { cwd: dir },
      );
      const sync = await api<{ ahead: number; behind: number }>('projects.syncState', id);
      check(
        '20: the folder knows GitHub is ahead',
        sync.behind === 1 && sync.ahead === 1,
        JSON.stringify(sync),
      );
    } else {
      check('20: a finish approval was waiting', false, 'no merge_base approval');
    }
    await api('projects.stop', id);
  } finally {
    console.log(
      `\nSCENARIOS 16/18/20: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`,
    );
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});

// ── 17: a local model builds through OpenCode; the governor never pauses it for usage ────────
test('scenario 17: a local model builds through OpenCode', async () => {
  test.skip(!which.includes('17'), 'set CONCLAVE_SCENARIO=17 to run');
  test.setTimeout(60 * 60_000);
  const { checks, check } = checker();
  const { app, page, shot, api } = await launch('17');
  try {
    const name = `clamp-${stamp}`;
    const id = await runProject(
      page,
      api,
      {
        repoPath: mathRepo('17', name),
        name,
        goal: 'A clamp module: clamp.js exporting clamp(value, min, max) that throws a RangeError when min > max, with node:test tests in test/clamp.test.js. npm test runs node --test. Only that one function.',
        routing: {
          planner: [{ provider: 'claude', model: 'haiku' }],
          builder: [{ provider: 'local', model: 'gpt-oss:20b' }, { provider: 'codex' }],
          reviewer: [{ provider: 'claude', model: 'haiku' }],
        },
        adaptiveTeam: false,
        maxAttempts: 2,
        askPolicy: 'decide',
      },
      45,
    );
    await shot('done');
    const t = tasks(id);
    check(
      'a local model built merged work',
      t.some((x) => x.status === 'merged' && x.built_by === 'local'),
      t.map((x) => `${x.title}: ${x.status} by ${x.built_by}`).join('; '),
    );
    const limited = events(id).filter(
      (e) =>
        e.provider === 'local' &&
        /usage|limit/i.test(e.message) &&
        /pause|wait|out of/i.test(e.message),
    );
    check('never paused for usage', limited.length === 0, limited[0]?.message ?? '');
    const runs = query<{ engine: string | null; n: number }>(
      "SELECT engine, COUNT(*) AS n FROM agent_runs WHERE provider = 'local' AND ref_id = ? GROUP BY engine",
      id,
    );
    console.log(`INFO  local runs: ${JSON.stringify(runs)}`);
    await api('projects.stop', id);
  } finally {
    console.log(`\nSCENARIO 17: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
    await app.close();
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
});
