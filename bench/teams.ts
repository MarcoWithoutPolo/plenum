/**
 * The team finder (v1.0 F5): which team should Plenum start projects with? Each candidate team
 * builds the same projects, interleaved run by run (so usage limits and the time of day hit them
 * all alike), through bench/run.ts. The winner passes every hidden test in every run a usage
 * limit didn't cut off, then is fastest by the median of its project medians; within 10%, the one
 * that used fewer tokens wins.
 *
 *   npx tsx --conditions=development bench/teams.ts --stage 1
 *   npx tsx --conditions=development bench/teams.ts --stage 2 --teams A,B
 *   npx tsx --conditions=development bench/teams.ts --stage 1 --resume teams-<stamp>
 *
 * Results: bench/results/teams-<stamp>/ (one bench run per team, project and run) and a
 * summary.md there.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));

/** Planner, builders and reviewers, best first; a seat is provider[@model][~effort]. */
export const CANDIDATES: Record<string, { why: string; team: string; reviewEffort?: string }> = {
  A: {
    why: 'Today’s default: Claude plans; Codex, then Claude build; Claude, then Antigravity review',
    team: 'planner:claude,builder:codex+claude,reviewer:claude+antigravity',
  },
  B: {
    why: 'Faster models throughout: Sonnet plans at low effort; Codex at medium builds; Gemini Flash reviews',
    team: 'planner:claude@sonnet~low,builder:codex~medium+claude@sonnet,reviewer:antigravity@gemini-3.8-flash-low+claude@sonnet',
  },
  C: {
    why: 'Claude builds: Opus plans; Sonnet, then Codex build; Codex at low effort reviews',
    team: 'planner:claude,builder:claude@sonnet+codex,reviewer:codex~low+antigravity',
  },
  D: {
    why: 'Codex plans and builds; Sonnet reviews',
    team: 'planner:codex,builder:codex~medium+claude@sonnet,reviewer:claude@sonnet+antigravity',
  },
  E: {
    why: 'Copilot builds first, when you have it',
    team: 'planner:claude@sonnet,builder:copilot+codex,reviewer:claude@sonnet+antigravity',
  },
  F: {
    why: 'Today’s default with light reviews',
    team: 'planner:claude,builder:codex+claude,reviewer:claude+antigravity',
    reviewEffort: 'light',
  },
};

const STAGES: Record<string, { projects: string[]; runs: number }> = {
  // Screening: every candidate on four projects, two runs each.
  '1': { projects: ['calc', 'inventory', 'kanban', 'site'], runs: 2 },
  // The best two on every project, three runs each.
  '2': {
    projects: [
      'textkit',
      'calc',
      'inventory',
      'ledger',
      'kanban',
      'site',
      'recipes',
      'dashboard',
      'game',
      'photos',
      'kanban-plus',
    ],
    runs: 3,
  },
};

const { values } = parseArgs({
  options: {
    stage: { type: 'string', default: '1' },
    teams: { type: 'string', default: Object.keys(CANDIDATES).join(',') },
    projects: { type: 'string' },
    runs: { type: 'string' },
    /** Carry on an interrupted run: its results folder under bench/results. */
    resume: { type: 'string' },
    /** Print what would run, and run nothing. */
    'dry-run': { type: 'boolean', default: false },
  },
});

const stage = STAGES[values.stage!];
if (!stage) throw new Error(`No stage ${values.stage}`);
const teams = values.teams!.split(',');
for (const t of teams) if (!CANDIDATES[t]) throw new Error(`No candidate team ${t}`);
const projects = values.projects?.split(',') ?? stage.projects;
const runs = values.runs ? Number(values.runs) : stage.runs;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(here, 'results', values.resume ?? `teams-${stamp}`);
mkdirSync(out, { recursive: true });

interface Row {
  team: string;
  project: string;
  run: number;
  pass: number;
  total: number;
  limited: boolean;
  minutes: number;
  tokens: number;
}
const rows: Row[] = values.resume
  ? (JSON.parse(readFileSync(join(out, 'rows.json'), 'utf8')) as Row[])
  : [];

// Interleaved: run 1 of every team on every project, then run 2, and so on.
for (let run = 1; run <= runs; run++) {
  for (const project of projects) {
    for (const t of teams) {
      const c = CANDIDATES[t]!;
      const args = [
        '--conditions=development',
        '--import',
        'tsx',
        join(here, 'run.ts'),
        '--projects',
        project,
        '--contenders',
        'plenum',
        '--team',
        c.team,
        '--runs',
        '1',
        ...(c.reviewEffort ? ['--review-effort', c.reviewEffort] : []),
      ];
      if (rows.some((r) => r.team === t && r.project === project && r.run === run)) continue;
      console.log(`▶ team ${t} · ${project} · run ${run}`);
      if (values['dry-run']) {
        console.log(`  node ${args.join(' ')}`);
        continue;
      }
      const before = new Set(readdirSync(join(here, 'results')));
      const r = spawnSync(process.execPath, args, { cwd: join(here, '..'), stdio: 'inherit' });
      if (r.status !== 0) console.log(`  (bench exited ${r.status})`);
      // The bench writes one results folder per call: read its JSON.
      const made = readdirSync(join(here, 'results')).filter(
        (d) => !before.has(d) && !d.startsWith('teams-') && !d.startsWith('soak-'),
      );
      for (const dir of made) {
        for (const f of readdirSync(join(here, 'results', dir)).filter((x) =>
          x.endsWith('.json'),
        )) {
          const j = JSON.parse(readFileSync(join(here, 'results', dir, f), 'utf8')) as {
            hidden: { pass: number; total: number };
            limited?: boolean;
            wallMs: number;
            usage?: { inputTokens?: number; outputTokens?: number }[];
          };
          rows.push({
            team: t,
            project,
            run,
            pass: j.hidden.pass,
            total: j.hidden.total,
            limited: Boolean(j.limited),
            minutes: j.wallMs / 60_000,
            tokens: (j.usage ?? []).reduce(
              (n, u) => n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
              0,
            ),
          });
        }
      }
      writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 2));
    }
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]!
      : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
    : NaN;
};
const summary = teams.map((t) => {
  const mine = rows.filter((r) => r.team === t);
  const counted = mine.filter((r) => !r.limited);
  const allPass = counted.every((r) => r.pass === r.total);
  const perProject = projects.map((p) =>
    median(counted.filter((r) => r.project === p).map((r) => r.minutes)),
  );
  return {
    team: t,
    allPass,
    failed: counted.filter((r) => r.pass < r.total).map((r) => `${r.project} ${r.pass}/${r.total}`),
    limited: mine.filter((r) => r.limited).length,
    minutes: median(perProject.filter((m) => !Number.isNaN(m))),
    tokens: median(counted.map((r) => r.tokens)),
  };
});
const ranked = summary
  .filter((s) => s.allPass && !Number.isNaN(s.minutes))
  .sort((a, b) => a.minutes - b.minutes);
// Within 10% of the fastest, fewer tokens wins.
const fastest = ranked[0];
const close = fastest ? ranked.filter((s) => s.minutes <= fastest.minutes * 1.1) : [];
const winner = close.sort((a, b) => a.tokens - b.tokens)[0];
const md = [
  `# Team finder, stage ${values.stage} (${stamp})`,
  '',
  `Projects: ${projects.join(', ')} · ${runs} run(s) each · interleaved.`,
  '',
  '| Team | What | All hidden tests | Median minutes | Median tokens | Cut off by limits |',
  '| ---- | ---- | ---------------- | -------------- | ------------- | ----------------- |',
  ...summary.map(
    (s) =>
      `| ${s.team} | ${CANDIDATES[s.team]!.why} | ${s.allPass ? 'yes' : `no (${s.failed.join('; ')})`} | ${s.minutes.toFixed(1)} | ${Math.round(s.tokens).toLocaleString()} | ${s.limited} |`,
  ),
  '',
  winner
    ? `**Winner: ${winner.team}** — ${CANDIDATES[winner.team]!.team}`
    : 'No team passed every test.',
  '',
].join('\n');
writeFileSync(join(out, 'summary.md'), md);
console.log(md);
