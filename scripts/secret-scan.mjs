// Scans every commit in the repository's history for things that look like credentials, before
// the repository goes public (v1.0 F10). Prints where each match is and what kind it is, never
// the value itself. Exit code 1 when anything is found.
//   node scripts/secret-scan.mjs
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI key', /sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ['Google key', /AIza[0-9A-Za-z_-]{35}/],
  ['Google OAuth token', /ya29\.[0-9A-Za-z_-]{20,}/],
  ['Slack token', /xox[abpr]-[0-9A-Za-z-]{10,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'Assigned secret',
    /\b(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  ],
];
// Test fixtures and docs use obvious fakes; these words mark a match as one.
const FAKE =
  /abcdefghij|example|dummy|fake|placeholder|redact|xxxx|test[-_]?(?:key|token)|\[removed\]|<[a-z-]+>/i;

const log = execFileSync(
  'git',
  ['log', '--all', '-p', '--no-color', '--unified=0', '--format=commit %H'],
  {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  },
);
let commit = '';
let file = '';
const found = new Map();
for (const line of log.split('\n')) {
  if (line.startsWith('commit ')) commit = line.slice(7, 15);
  else if (line.startsWith('+++ b/')) file = line.slice(6);
  else if (line.startsWith('+') && !line.startsWith('+++')) {
    for (const [kind, re] of PATTERNS) {
      const m = re.exec(line);
      if (!m || FAKE.test(line)) continue;
      const key = `${kind} in ${file}`;
      if (!found.has(key)) found.set(key, { kind, file, commit, length: m[0].length });
    }
  }
}
const commits = execFileSync('git', ['rev-list', '--all', '--count'], { encoding: 'utf8' }).trim();
if (found.size === 0) {
  console.log(`No credentials found in ${commits} commits.`);
} else {
  console.log(`${found.size} possible credential(s) in ${commits} commits (values not shown):`);
  for (const f of found.values())
    console.log(`  ${f.kind}: ${f.file} (first in ${f.commit}, ${f.length} characters)`);
  process.exitCode = 1;
}
