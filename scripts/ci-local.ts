/**
 * Runs what .github/workflows/ci.yml runs, on this machine, so a push doesn't have to pay for it.
 *
 *   npm run ci:local -- [--only win22,win24,linux22,linux24] [--e2e-repeat 3] [--cores 4]
 *
 * - Each target starts from a fresh clone of the committed HEAD, as actions/checkout does, so a
 *   file that only exists in this folder can't make it pass.
 * - Windows uses portable Node from E:\ci-cache (or CI_NODE_DIR), limited to as many cores as
 *   GitHub's Windows runners have (4), where the e2e flakes show up.
 * - Linux runs in Docker on Ubuntu 24.04 like ubuntu-latest, 4 CPUs and 16 GB, and also runs the
 *   desktop e2e under a virtual display, which CI skips.
 * - macOS can't run here: the full matrix on GitHub covers it.
 *
 * Logs and a summary go to ci-local/<time>/.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    only: { type: 'string', default: 'win22,win24,linux22,linux24' },
    'e2e-repeat': { type: 'string', default: '1' },
    cores: { type: 'string', default: '4' },
  },
});
const NODE = { 22: 'v22.23.4', 24: 'v24.22.2' } as const;
const cacheDir = process.env.CI_NODE_DIR ?? 'E:\\ci-cache';
const repeat = Math.max(1, Number(values['e2e-repeat']));
const cores = Math.max(1, Number(values.cores));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(root, 'ci-local', stamp);
mkdirSync(out, { recursive: true });

/** The steps of ci.yml, in order; the last is the desktop e2e. */
const STEPS: [string, string][] = [
  ['install', 'npm ci'],
  ['lint', 'npm run lint'],
  ['format', 'npm run format:check'],
  ['typecheck', 'npm run typecheck'],
  ['unit', 'npm test'],
  ['build', 'npm run desktop:build'],
];
const E2E = 'npm run -w @conclave/desktop e2e';

type Step = { name: string; ok: boolean; seconds: number; note?: string };
type Result = { target: string; steps: Step[] };

const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) {
  console.log(`Note: uncommitted changes aren't tested, as on GitHub. Testing ${head}.`);
}

/** Which e2e tests failed, from Playwright's list output ("  1) e2e\x.spec.ts:12:3 › name"). */
function failedTests(log: string): string[] {
  const names = [...log.matchAll(/^\s+\d+\) (e2e[\\/][^\s]+) › (.+?)\s*$/gm)].map(
    (m) => `${m[1]!.replace(/\\/g, '/')} › ${m[2]!.replace(/[─\s]+$/, '')}`,
  );
  return [...new Set(names)];
}

/** Runs a shell command (or a program with its arguments), streaming it into the target's log. */
function run(
  command: string | string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; log: string },
) {
  return new Promise<{ code: number; text: string }>((resolve) => {
    const file = createWriteStream(opts.log, { flags: 'a' });
    file.write(`\n$ ${typeof command === 'string' ? command : command.slice(0, -1).join(' ')}\n`);
    const child =
      typeof command === 'string'
        ? spawn(command, { cwd: opts.cwd, env: opts.env, shell: true })
        : spawn(command[0]!, command.slice(1), { cwd: opts.cwd, env: opts.env });
    let text = '';
    const take = (d: Buffer) => {
      text += d.toString();
      file.write(d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => {
      file.end();
      resolve({ code: code ?? 1, text });
    });
  });
}

async function windows(major: 22 | 24): Promise<Result> {
  const target = `win${major}`;
  const nodeDir = join(cacheDir, `node-${NODE[major]}-win-x64`);
  if (!existsSync(nodeDir)) {
    return { target, steps: [{ name: 'setup', ok: false, seconds: 0, note: `no ${nodeDir}` }] };
  }
  const work = mkdtempSync(join(tmpdir(), `ci-${target}-`));
  execFileSync('git', ['clone', '-q', '--no-local', root, work]);
  const env = { ...process.env, PATH: `${nodeDir};${process.env.PATH}`, CI: 'true' };
  const log = join(out, `${target}.log`);
  // Children inherit the affinity, so the app under test gets the same cores as a runner.
  // `start /b /wait` drops the exit code, so the command leaves it in a file.
  const mask = ((1 << cores) - 1).toString(16).toUpperCase();
  const exitFile = join(work, 'ci-exit.txt');
  const limited = (command: string) =>
    `start "" /b /wait /affinity ${mask} cmd /d /v:on /c "${command} & echo !errorlevel!> ci-exit.txt"`;
  const steps: Step[] = [];
  for (const [name, command] of [
    ...STEPS,
    ...Array.from(
      { length: repeat },
      (_, i) => [`e2e${repeat > 1 ? ` ${i + 1}` : ''}`, E2E] as [string, string],
    ),
  ]) {
    const t = Date.now();
    const e2e = name.startsWith('e2e');
    rmSync(exitFile, { force: true });
    const r = await run(e2e ? limited(command) : command, { cwd: work, env, log });
    if (e2e) r.code = existsSync(exitFile) ? Number(readFileSync(exitFile, 'utf8').trim()) : 1;
    const failed = name.startsWith('e2e') ? failedTests(r.text) : [];
    steps.push({
      name,
      ok: r.code === 0,
      seconds: Math.round((Date.now() - t) / 1000),
      ...(failed.length && { note: failed.join('; ') }),
    });
    console.log(
      `${target}  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${name}  ${steps.at(-1)!.seconds}s${failed.length ? `  (${failed.join('; ')})` : ''}`,
    );
    // Like CI, a failed step ends the job; a failed e2e repeat still lets the others run.
    if (r.code !== 0 && !name.startsWith('e2e')) break;
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  return { target, steps };
}

const DOCKERFILE = (version: string) => `FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git xz-utils xvfb xauth \\
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgtk-3-0 libgbm1 libasound2t64 libxss1 libxtst6 \\
    libxrandr2 libxcomposite1 libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 libsecret-1-0 \\
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLO https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.xz \\
    && curl -fsSL https://nodejs.org/dist/${version}/SHASUMS256.txt | grep " node-${version}-linux-x64.tar.xz$" | sha256sum -c - \\
    && tar -xJf node-${version}-linux-x64.tar.xz -C /usr/local --strip-components=1 && rm node-${version}-linux-x64.tar.xz
RUN useradd -m ci && git config --system --add safe.directory '*'
USER ci
WORKDIR /home/ci
`;

async function linux(major: 22 | 24): Promise<Result> {
  const target = `linux${major}`;
  const image = `conclave-ci:node${major}`;
  const log = join(out, `${target}.log`);
  const ctx = mkdtempSync(join(tmpdir(), 'ci-docker-'));
  writeFileSync(join(ctx, 'Dockerfile'), DOCKERFILE(NODE[major]));
  const built = await run(`docker build -q -t ${image} "${ctx}"`, {
    cwd: ctx,
    env: process.env,
    log,
  });
  rmSync(ctx, { recursive: true, force: true });
  if (built.code !== 0) {
    return {
      target,
      steps: [{ name: 'image', ok: false, seconds: 0, note: 'docker build failed' }],
    };
  }
  // One script in the container; "@@" lines mark each step's end for the summary.
  const lines = [
    'git clone -q /repo work && cd work',
    ...[
      ...STEPS,
      ...Array.from(
        { length: repeat },
        (_, i) => [`e2e${repeat > 1 ? ` ${i + 1}` : ''}`, `xvfb-run -a ${E2E}`] as [string, string],
      ),
    ].map(
      ([name, command]) =>
        `s=$(date +%s); ${command}; c=$?; echo "@@ ${name} $c $(( $(date +%s) - s ))"; ${name.startsWith('e2e') ? '' : '[ $c -eq 0 ] || exit 1'}`,
    ),
  ];
  const script = lines.join('\n');
  // An argument list, not a shell line: cmd.exe would split the script at its spaces.
  const r = await run(
    [
      'docker',
      'run',
      '--rm',
      '--cpus',
      String(cores),
      '--memory',
      '16g',
      '--shm-size',
      '2g',
      '-e',
      'CI=true',
      '-e',
      'ELECTRON_DISABLE_SANDBOX=1',
      '-v',
      `${root}:/repo:ro`,
      image,
      'bash',
      '-c',
      script,
    ],
    { cwd: root, env: process.env, log },
  );
  const steps: Step[] = [];
  // Each e2e repeat's own output sits between the previous "@@" line and its own.
  const chunks = r.text.split(/^@@ .*$/m);
  let i = 0;
  for (const m of r.text.matchAll(/^@@ (.+) (\d+) (\d+)$/gm)) {
    const name = m[1]!;
    const failed = name.startsWith('e2e') ? failedTests(chunks[i] ?? '') : [];
    steps.push({
      name,
      ok: m[2] === '0',
      seconds: Number(m[3]),
      ...(failed.length && { note: failed.join('; ') }),
    });
    console.log(
      `${target}  ${m[2] === '0' ? 'PASS' : 'FAIL'}  ${name}  ${m[3]}s${failed.length ? `  (${failed.join('; ')})` : ''}`,
    );
    i++;
  }
  if (!steps.length) steps.push({ name: 'clone', ok: false, seconds: 0, note: `exit ${r.code}` });
  return { target, steps };
}

const wanted = values.only!.split(',').map((s) => s.trim());
const results: Result[] = [];
for (const t of wanted) {
  const major = Number(t.replace(/\D/g, '')) as 22 | 24;
  if (!(major in NODE)) continue;
  console.log(`\n▶ ${t} (${head})`);
  results.push(t.startsWith('win') ? await windows(major) : await linux(major));
}

const ok = results.every((r) => r.steps.every((s) => s.ok));
const summary = [
  `# Local CI ${stamp} (${head})`,
  '',
  '| Target | Step | Result | Time | Failed tests |',
  '| --- | --- | --- | --- | --- |',
  ...results.flatMap((r) =>
    r.steps.map(
      (s) =>
        `| ${r.target} | ${s.name} | ${s.ok ? 'pass' : '**fail**'} | ${s.seconds}s | ${s.note ?? ''} |`,
    ),
  ),
  '',
  `macOS isn't covered here: run the full matrix on GitHub for it.`,
].join('\n');
writeFileSync(join(out, 'summary.md'), `${summary}\n`);
console.log(`\n${ok ? 'All green' : 'Something failed'}. Summary: ${join(out, 'summary.md')}`);
process.exit(ok ? 0 : 1);
