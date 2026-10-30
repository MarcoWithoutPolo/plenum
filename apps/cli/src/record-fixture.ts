// Records one real CLI run as a test fixture: npm run record-fixture -- <provider> <name> [options]
//   --prompt "..."   what to send (default: "Reply with exactly: pong")
//   --role <role>    chat (default), planner, builder or reviewer
//   --model <id>     a model id the CLI accepts
//   --effort <e>     an effort level
//   --level <1-5>    permission level for a builder (default 2)
// The run happens in a fresh temp folder; the file lands in test/fixtures/<provider>/<name>.jsonl
// with paths, the account name and emails scrubbed. Read it before committing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTER_FACTORIES, defaultExec, recordingExec } from '@conclave/core';
import type { Role } from '@conclave/shared';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: 'string', default: 'Reply with exactly: pong' },
    role: { type: 'string', default: 'chat' },
    model: { type: 'string' },
    effort: { type: 'string' },
    level: { type: 'string', default: '2' },
  },
});
const [provider, name] = positionals;
const make = provider ? ADAPTER_FACTORIES[provider] : undefined;
if (!make || !name || !/^[\w-]+$/.test(name)) {
  console.error(
    `Usage: npm run record-fixture -- <${Object.keys(ADAPTER_FACTORIES).join('|')}> <name> [--prompt ...]`,
  );
  process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), 'conclave-record-'));
writeFileSync(join(cwd, 'README.md'), '# Sample\n\nA scratch folder for a recorded run.\n');
const file = join(process.cwd(), 'test', 'fixtures', provider!, `${name}.jsonl`);
const adapter = make({ exec: recordingExec(defaultExec, file, cwd) });
const role = values.role as Role;
try {
  for await (const event of adapter.run({
    prompt: values.prompt!,
    cwd,
    role,
    readOnly: role !== 'builder',
    permissions: { level: Number(values.level) as 1 | 2 | 3 | 4 | 5, network: false },
    ...(values.model && { model: values.model }),
    ...(values.effort && { effort: values.effort }),
    timeoutMs: 300_000,
  })) {
    const { type } = event;
    const detail =
      event.type === 'message.delta' ? JSON.stringify(event.text) : JSON.stringify(event);
    console.log(type.padEnd(14), detail.slice(0, 160));
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
console.log(`\nSaved ${file}`);
