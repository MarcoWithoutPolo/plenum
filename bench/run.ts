/**
 * Conclave benchmark: the same goal, given to Claude Code, Codex and Antigravity on their own,
 * and to Conclave. Scored by hidden acceptance tests the agents never see.
 *
 *   npx tsx --conditions=development bench/run.ts --projects textkit,calc,inventory \
 *     --contenders claude,codex,antigravity,conclave --runs 1
 *
 * `reference` is a free contender that copies the reference solution (checks the pipeline).
 * Results go to bench/results/<timestamp>/ (one JSON per run plus summary.md).
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AntigravityAdapter,
  Brain,
  ClaudeAdapter,
  CodexAdapter,
  ChromeSnapshotter,
  findChrome,
  Engine,
  collect,
  createProject,
  runShell,
  silenceSqliteWarning,
  type Adapter,
  type RunPermissions,
} from '@conclave/core';
import type { ProviderId } from '@conclave/shared';

silenceSqliteWarning();
// Browser-based hidden tests (kanban) load Playwright and Electron from the repo.
process.env.BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    projects: { type: 'string', default: 'textkit,calc,inventory' },
    contenders: { type: 'string', default: 'claude,codex,antigravity,conclave' },
    /** Force Conclave's team, e.g. "builder:antigravity,reviewer:claude+codex". */
    team: { type: 'string' },
    /** Conclave's permission level (Antigravity can only build at 2 or 5). */
    level: { type: 'string', default: '3' },
    /** Screenshots and the free visual checks for web projects (needs Chrome or Edge). */
    shots: { type: 'string', default: 'on' },
    runs: { type: 'string', default: '1' },
    'timeout-min': { type: 'string', default: '40' },
    nudges: { type: 'string', default: '2' },
    parallel: { type: 'string', default: '2' },
  },
});
const projects = values.projects!.split(',');
const contenders = values.contenders!.split(',');
const runs = Number(values.runs);
const timeoutMs = Number(values['timeout-min']) * 60_000;
const maxNudges = Number(values.nudges);
const parallel = Number(values.parallel);
const team = values.team
  ? Object.fromEntries(
      values.team.split(',').map((part) => {
        const [role, providers] = part.split(':') as [string, string];
        return [
          role,
          providers.split('+').map((provider) => ({ provider: provider as ProviderId })),
        ];
      }),
    )
  : undefined;
/** Names this run's Conclave variant in results, e.g. conclave-b=antigravity-r=claude-2l. */
const variant = `${values.team ? `-${values.team.replace(/([a-z])[a-z]*:/g, '$1=').replace(/,/g, '-')}` : ''}${parallel > 1 ? `-${parallel}l` : ''}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(here, 'results', stamp);
mkdirSync(out, { recursive: true });

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Bench',
      '-c',
      'user.email=bench@localhost',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
    },
  ).trim();

/** Each tool in its strongest safe headless mode: edit files, run the tests, no network. */
const SINGLE: Record<string, { make: () => Adapter; permissions: RunPermissions; note: string }> = {
  claude: {
    make: () => new ClaudeAdapter(),
    permissions: { level: 3, network: false, commands: ['npm test', 'node --test'] },
    note: 'level 3: edits, may run npm test / node --test',
  },
  codex: {
    make: () => new CodexAdapter(),
    permissions: { level: 3, network: false },
    note: 'workspace-write sandbox: edits and commands in the folder, no network',
  },
  antigravity: {
    make: () => new AntigravityAdapter(),
    permissions: { level: 2, network: false },
    note: 'level 2: edits only (agy headless has no allow-listed commands)',
  },
};

function singlePrompt(goal: string): string {
  return `You are working alone on the repository in the current folder. Complete this goal fully, then stop.

${goal}

Work autonomously: don't ask questions; make reasonable choices and note them in your final summary. Write the code and the tests, run \`npm test\` to check your work if you can, and fix what fails. When the goal is fully met, reply with a short summary.`;
}

interface Usage {
  provider: string;
  role: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** Time spent in this provider's agent runs in this role. */
  ms: number;
}

interface Result {
  project: string;
  contender: string;
  run: number;
  ok: boolean;
  wallMs: number;
  hidden: { pass: number; fail: number; total: number; failed?: string[] };
  ownTests: 'pass' | 'fail' | 'none';
  interventions: number;
  /** A usage limit cut the run short (single tool) or forced a fallback (Conclave). */
  limited: boolean;
  usage: Usage[];
  notes: string[];
  /** Conclave only: the brain's activity, minutes from the start, to see where time went. */
  timeline?: string[];
}

function seedRepo(project: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bench-${project}-`));
  cpSync(join(here, 'projects', project, 'seed'), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

async function ownTests(dir: string): Promise<'pass' | 'fail' | 'none'> {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return 'none';
  const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> })
    .scripts;
  if (!scripts?.test || /no test specified/.test(scripts.test)) return 'none';
  const r = await runShell('npm test', { cwd: dir, timeoutMs: 5 * 60_000 });
  return r.code === 0 ? 'pass' : 'fail';
}

/** Copy the result (without .git) next to the hidden tests and run them. */
async function score(project: string, codeDir: string): Promise<Result['hidden']> {
  const dir = mkdtempSync(join(tmpdir(), `bench-score-${project}-`));
  for (const name of readdirSync(codeDir)) {
    if (name === '.git' || name === 'node_modules') continue;
    cpSync(join(codeDir, name), join(dir, name), { recursive: true });
  }
  mkdirSync(join(dir, '.hidden'));
  const hiddenDir = join(here, 'projects', project, 'hidden');
  for (const f of readdirSync(hiddenDir)) cpSync(join(hiddenDir, f), join(dir, '.hidden', f));
  // Only *.test.cjs files are tests; others are helpers (kanban's Electron window).
  const files = readdirSync(hiddenDir).filter((f) => f.endsWith('.test.cjs'));
  const r = await runShell(`node --test ${files.map((f) => `.hidden/${f}`).join(' ')}`, {
    cwd: dir,
    timeoutMs: 5 * 60_000,
  });
  const pass = Number(/ℹ pass (\d+)/.exec(r.output)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(r.output)?.[1] ?? 0);
  const total = files.reduce((n, f) => n + countTests(join(hiddenDir, f)), 0);
  // Which hidden checks failed, by name: "✖ name (12ms)" in node:test's spec output.
  const failed = [
    ...new Set(
      [...r.output.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)]
        .map((m) => m[1]!.trim())
        .filter((name) => name !== 'failing tests:'),
    ),
  ];
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return { pass, fail, total, ...(failed.length && { failed }) };
}

function countTests(file: string): number {
  return (readFileSync(file, 'utf8').match(/^test\(/gm) ?? []).length;
}

async function runSingle(
  project: string,
  contender: string,
  goal: string,
  dir: string,
): Promise<Partial<Result>> {
  const spec = SINGLE[contender]!;
  const adapter = spec.make();
  const status = await adapter.detect();
  if (status.auth !== 'signed_in') throw new Error(`${contender} is not signed in`);
  const usage: Usage = {
    provider: contender,
    role: 'solo',
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
  };
  const notes = [spec.note];
  let sessionId: string | undefined;
  let prompt = singlePrompt(goal);
  let interventions = 0;
  let ok = false;
  let limited = false;
  const deadline = Date.now() + timeoutMs;
  for (let turn = 0; turn <= maxNudges; turn++) {
    const result = await collect(
      adapter.run({
        prompt,
        cwd: dir,
        role: 'builder',
        readOnly: false,
        permissions: spec.permissions,
        timeoutMs: Math.max(60_000, deadline - Date.now()),
        ...(sessionId && adapter.capabilities.resume && { sessionId }),
      }),
    );
    usage.runs++;
    usage.inputTokens += result.usage?.inputTokens ?? 0;
    usage.outputTokens += result.usage?.outputTokens ?? 0;
    usage.ms += result.durationMs;
    sessionId = result.sessionId ?? sessionId;
    ok = result.ok;
    if (!result.ok)
      notes.push(
        `turn ${turn + 1}: ${result.rateLimited?.message ?? result.errors[0] ?? 'failed'}`,
      );
    if (result.rateLimited) limited = true;
    if (result.rateLimited || Date.now() > deadline) break;
    // Nudge like a person would: only when its own tests are missing or failing.
    const own = await ownTests(dir);
    if (own === 'pass' || turn === maxNudges) break;
    interventions++;
    prompt = `The goal isn't finished yet: ${own === 'none' ? 'there is no working `npm test` yet' : '`npm test` fails'}. Keep going until the goal is fully met, without asking questions.\n\nThe goal again:\n\n${goal}`;
  }
  return { ok, limited, usage: [usage], interventions, notes };
}

async function runConclave(
  project: string,
  goal: string,
  dir: string,
): Promise<Partial<Result> & { codeDir: string }> {
  const home = mkdtempSync(join(tmpdir(), 'bench-conclave-home-'));
  const engine = new Engine({ home });
  const ready = await engine.readySeats();
  const projectRow = await createProject(engine.store, ready, {
    repoPath: dir,
    goal,
    askPolicy: 'decide',
    maxParallel: parallel,
    ...(team && { routing: team }),
    permissions: {
      level: Number(values.level) as 1 | 2 | 3 | 4 | 5,
      network: 'never',
      installs: 'never',
      expiresAt: null,
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const notes = [
    `team: plans ${projectRow.routing.planner.map((s) => s.provider).join('>')}, builds ${projectRow.routing.builder.map((s) => s.provider).join('>')}, reviews ${projectRow.routing.reviewer.map((s) => s.provider).join('>')}`,
    `level ${values.level}, decide-and-tell (no human), installs never, ${projectRow.maxParallel} lane(s)`,
  ];
  let ok = false;
  let snapshotter: ChromeSnapshotter | undefined;
  try {
    const chrome = values.shots === 'off' ? null : findChrome();
    snapshotter = chrome ? new ChromeSnapshotter(chrome) : undefined;
    notes.push(snapshotter ? 'screenshots and visual checks on' : 'screenshots off');
    const brain = new Brain(engine, projectRow.id, { home, ...(snapshotter && { snapshotter }) });
    const outcome = await brain.run({ signal: controller.signal, maxRounds: 400 });
    ok = outcome.kind === 'done';
    notes.push(
      `outcome: ${outcome.kind}${'reason' in outcome ? `: ${outcome.reason.slice(0, 200)}` : ''}`,
    );
  } finally {
    clearTimeout(timer);
    await snapshotter?.close();
  }
  const tasks = engine.store.projects.listTasks(projectRow.id);
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  notes.push(`tasks: ${count('merged')} merged, ${count('failed')} failed, ${tasks.length} total`);
  const db = engine.store.db;
  const rows = db
    .prepare(
      `SELECT provider, role, COUNT(*) AS runs, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
         SUM(duration_ms) AS ms
       FROM agent_runs GROUP BY provider, role ORDER BY provider, role`,
    )
    .all() as {
    provider: string;
    role: string;
    runs: number;
    inp: number;
    outp: number;
    ms: number;
  }[];
  const questions = engine.store.projects
    .approvals(projectRow.id)
    .filter((a) => a.kind === 'question').length;
  const events = engine.store.projects.events(projectRow.id);
  const t0 = events[0]?.at ?? Date.now();
  const timeline = events.map(
    (e) =>
      `${((e.at - t0) / 60_000).toFixed(1).padStart(5)}  ${e.provider ?? '-'}  ${e.message.slice(0, 160)}`,
  );
  engine.close();
  // Export what landed on the integration branch.
  const codeDir = mkdtempSync(join(tmpdir(), `bench-${project}-conclave-out-`));
  execFileSync('git', ['--work-tree', codeDir, 'checkout', 'conclave/integration', '--', '.'], {
    cwd: dir,
  });
  git(dir, 'reset', '-q', '--hard');
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  return {
    ok,
    codeDir,
    interventions: questions,
    // A seat that ran but used no tokens was turned away by its limit and the brain fell back.
    limited: rows.some((r) => r.runs > 0 && !r.inp && !r.outp),
    usage: rows.map((r) => ({
      provider: r.provider,
      role: r.role,
      runs: r.runs,
      inputTokens: r.inp ?? 0,
      outputTokens: r.outp ?? 0,
      ms: r.ms ?? 0,
    })),
    notes,
    timeline,
  };
}

const results: Result[] = [];
for (const project of projects) {
  const goal = readFileSync(join(here, 'projects', project, 'goal.md'), 'utf8');
  for (const contender of contenders) {
    for (let run = 1; run <= runs; run++) {
      const dir = seedRepo(project);
      const started = Date.now();
      console.log(`\n▶ ${project} · ${contender} · run ${run}  (${dir})`);
      let partial: Partial<Result> & { codeDir?: string } = {};
      try {
        if (contender === 'reference') {
          cpSync(join(here, 'projects', project, 'reference'), dir, { recursive: true });
          partial = { ok: true, usage: [], interventions: 0, notes: ['reference solution'] };
        } else if (contender === 'conclave') {
          partial = await runConclave(project, goal, dir);
        } else if (SINGLE[contender]) {
          partial = await runSingle(project, contender, goal, dir);
        } else {
          throw new Error(`Unknown contender: ${contender}`);
        }
      } catch (err) {
        partial = {
          ok: false,
          usage: [],
          interventions: 0,
          notes: [`crashed: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
      const wallMs = Date.now() - started;
      const codeDir = partial.codeDir ?? dir;
      const result: Result = {
        project,
        contender: contender === 'conclave' ? `conclave${variant}` : contender,
        run,
        ok: partial.ok ?? false,
        wallMs,
        hidden: await score(project, codeDir),
        ownTests: await ownTests(codeDir),
        interventions: partial.interventions ?? 0,
        limited: partial.limited ?? false,
        usage: partial.usage ?? [],
        notes: partial.notes ?? [],
        ...(partial.timeline && { timeline: partial.timeline }),
      };
      results.push(result);
      writeFileSync(
        join(out, `${project}-${result.contender}-${run}.json`),
        JSON.stringify(result, null, 2),
      );
      const tokens = result.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
      console.log(
        `  hidden ${result.hidden.pass}/${result.hidden.total}${result.limited ? ' (limited)' : ''} · own tests ${result.ownTests} · ${(wallMs / 60_000).toFixed(1)} min · ${tokens.toLocaleString()} tokens · interventions ${result.interventions}`,
      );
      for (const n of result.notes) console.log(`  · ${n}`);
      for (const f of result.hidden.failed ?? []) console.log(`  ✗ ${f}`);
    }
  }
}

const lines = [
  `# Benchmark ${stamp}`,
  '',
  '| Project | Contender | Run | Hidden tests | Own tests | Wall time | Tokens (in+out) | Agent runs | Interventions |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => {
    const tokens = r.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0);
    const agentRuns = r.usage.reduce((n, u) => n + u.runs, 0);
    return `| ${r.project} | ${r.contender} | ${r.run} | ${r.hidden.pass}/${r.hidden.total}${r.limited ? ' ⚠ limit' : ''} | ${r.ownTests} | ${(r.wallMs / 60_000).toFixed(1)} min | ${tokens.toLocaleString()} | ${agentRuns} | ${r.interventions} |`;
  }),
  '',
  '## Usage by provider',
  '',
  ...results.flatMap((r) => [
    `- **${r.project} · ${r.contender} · ${r.run}:** ${r.usage.map((u) => `${u.provider}/${u.role} ${u.runs} runs, ${(u.inputTokens + u.outputTokens).toLocaleString()} tokens`).join('; ') || 'none'}`,
  ]),
];
writeFileSync(join(out, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`\nSummary: ${join(out, 'summary.md')}`);
