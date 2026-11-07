import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TypedEventParser,
  WholeTextParser,
  detectVersion,
  limitResetsAt,
  looksLikeLimit,
  failure,
  locateCli,
  outside,
  recordingExec,
  runCli,
  scrubLine,
  tokenUsage,
  type EventBody,
  type Exec,
  type ProcessChunk,
} from '../src/index.js';

function lines(out: string[], exitCode = 0, stderr = ''): Exec {
  return async function* (): AsyncGenerator<ProcessChunk> {
    for (const line of out) yield { kind: 'line', line };
    if (stderr) yield { kind: 'stderr', text: stderr };
    yield { kind: 'exit', code: exitCode };
  };
}

async function collect(exec: Exec, parser: Parameters<typeof runCli>[3]) {
  const events = [];
  for await (const e of runCli('fake', exec, { command: 'x', args: [] }, parser)) events.push(e);
  return events;
}

class SampleParser extends TypedEventParser {
  protected on(type: string, message: Record<string, unknown>): EventBody[] {
    if (type === 'text') return this.delta(String(message.data));
    if (type === 'error') return this.fail(String(message.message));
    if (type === 'end') return [this.usage(tokenUsage({ input: 3, output: 1 })), this.done()];
    return [];
  }
}

describe('adapter kit', () => {
  it('builds typed-event parsers from a handler per type, ignoring unknown types', async () => {
    const events = await collect(
      lines([
        '{"type":"text","data":"po"}',
        '{"type":"other"}',
        '{"type":"text","data":"ng"}',
        '{"type":"end"}',
      ]),
      new SampleParser(),
    );
    expect(events.map((e) => e.type)).toEqual([
      'message.delta',
      'message.delta',
      'usage',
      'message.done',
      'done',
    ]);
    expect(events.find((e) => e.type === 'message.done')).toMatchObject({ text: 'pong' });
    expect(events.at(-1)).toMatchObject({ ok: true });
  });

  it('a reported failure makes the run fail without a second error', async () => {
    const events = await collect(
      lines(['{"type":"error","message":"Usage limit reached, try again in 2 hours"}']),
      new SampleParser(),
    );
    expect(events.map((e) => e.type)).toEqual(['rate_limit', 'done']);
    expect(events[0]).toMatchObject({ resetsAt: expect.any(Number) });
    expect(events.at(-1)).toMatchObject({ ok: false });
  });

  it('reads a plain-text CLI as one answer', async () => {
    const events = await collect(lines(['Hello', 'world']), new WholeTextParser());
    expect(events.find((e) => e.type === 'message.done')).toMatchObject({ text: 'Hello\nworld' });
    const failed = await collect(lines(['partial'], 1, 'boom\n'), new WholeTextParser());
    expect(failed.map((e) => e.type)).toEqual(['message.delta', 'error', 'done']);
  });

  it('turns limit messages into rate_limit events and the rest into errors', () => {
    expect(failure('Too many requests')).toMatchObject({ type: 'rate_limit' });
    expect(failure('Model not found')).toEqual({ type: 'error', message: 'Model not found' });
  });

  it('leaves out token counts a CLI did not report', () => {
    expect(tokenUsage({ input: 10, cached: undefined, output: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it('scrubs paths, the account name and emails from recordings', () => {
    const line = JSON.stringify({
      cwd: 'C:\\Users\\sam\\AppData\\Local\\Temp\\run-1',
      file: 'C:/Users/sam/notes.md',
      who: 'sam@example.org signed in as sam',
    });
    const out = scrubLine(line, {
      cwd: 'C:\\Users\\sam\\AppData\\Local\\Temp\\run-1',
      home: 'C:\\Users\\sam',
      user: 'sam',
    });
    expect(out).not.toMatch(/sam/);
    expect(JSON.parse(out)).toEqual({
      cwd: '<cwd>',
      file: '<home>/notes.md',
      who: 'user@example.com signed in as user',
    });
  });

  it('records what a run printed, scrubbed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-kit-'));
    try {
      const file = join(dir, 'out', 'run.jsonl');
      const exec = recordingExec(lines([`{"cwd":${JSON.stringify(dir)}}`]), file, dir);
      await collect(exec, new WholeTextParser());
      expect(readFileSync(file, 'utf8')).toBe('{"cwd":"<cwd>"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing CLI and finds installer locations before PATH', async () => {
    const found = await detectVersion('fake', 'conclave-no-such-cli', { missing: 'Not here' });
    expect(found).toMatchObject({ installed: false, status: { detail: 'Not here' } });
    expect(locateCli('mycli', { windows: [], unix: [] })).toBe('mycli');
    const here = process.execPath;
    expect(locateCli('node', { windows: [here], unix: [here] })).toBe(here);
  });
});

describe('edits outside the working folder', () => {
  it('fail the run with a clear error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conclave-out-'));
    try {
      class EditParser extends TypedEventParser {
        protected on(_type: string, message: Record<string, unknown>): EventBody[] {
          return [{ type: 'file.edit', path: String(message.path), kind: 'update' }];
        }
      }
      const inside = join(dir, 'a.txt');
      const elsewhere = join(homedir(), 'conclave-somewhere-else.txt');
      // A throwaway check script in the system temp folder is allowed.
      const scratch = join(tmpdir(), 'conclave-check.mjs');
      const events = [];
      for await (const e of runCli(
        'fake',
        lines([
          JSON.stringify({ type: 'e', path: inside }),
          JSON.stringify({ type: 'e', path: scratch }),
          JSON.stringify({ type: 'e', path: elsewhere }),
        ]),
        { command: 'x', args: [], cwd: dir },
        new EditParser(),
      ))
        events.push(e);
      expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
      expect(events.find((e) => e.type === 'error')).toMatchObject({
        message: expect.stringContaining(`outside its working folder: ${elsewhere}`),
      });
      expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
      expect(outside('relative/path.txt', dir)).toBe(false);
      expect(outside(inside, dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCli stops a run that edits outside its folder (E8)', () => {
  it('aborts the process at once instead of letting it run on', async () => {
    let aborted = false;
    // A CLI that reports an edit outside its folder, then would run until stopped.
    const exec: Exec = async function* (opts) {
      yield { kind: 'line', line: JSON.stringify({ edit: '/etc/elsewhere.txt' }) };
      await new Promise<void>((ok) => {
        if (opts.signal?.aborted) return ok();
        opts.signal?.addEventListener('abort', () => ok(), { once: true });
        setTimeout(ok, 20_000).unref();
      });
      aborted = opts.signal?.aborted === true;
      yield { kind: 'exit', code: null, error: 'Cancelled' };
    };
    const parser = {
      failed: false,
      parse: (m: unknown): EventBody[] => [
        { type: 'file.edit', path: (m as { edit: string }).edit } as EventBody,
      ],
    };
    const started = Date.now();
    const events = [];
    for await (const e of runCli('codex', exec, { command: 'x', args: [], cwd: tmpdir() }, parser))
      events.push(e);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(
      events.some((e) => e.type === 'error' && /outside its working folder/.test(e.message)),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', ok: false });
  }, 30_000);
});

describe('Usage limits are read from what the CLIs say, not from any word (E9)', () => {
  const limits = [
    'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit settings.',
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase it.',
    'Rate limit exceeded (429). Try again in 2 hours.',
    'Quota exceeded. Try later.',
    'Usage limit reached, try again in 2 hours',
    'Too many requests',
    'HTTP 429 Too Many Requests',
    'You have exceeded your current quota, please check your billing details.',
    'Your credit balance is too low to access the API.',
    'You’ve reached your weekly limit.',
  ];
  const ordinary = [
    "Error: Cannot find module './billing'",
    'TypeError in src/quota-tracker.ts at line 429',
    'Failed to compile src/features/billing/invoice.tsx',
    'expected 429 to equal 430',
    'Test failed: quota.spec.ts',
    'ENOENT: no such file or directory, open "credits.json"',
  ];
  it.each(limits)('a limit: %s', (m) => expect(looksLikeLimit(m)).toBe(true));
  it.each(ordinary)('not a limit: %s', (m) => expect(looksLikeLimit(m)).toBe(false));

  it('reads "try again at" as local time, or UTC when it says so', () => {
    const now = new Date(Date.UTC(2026, 10, 2, 10, 0));
    const utc = limitResetsAt('Try again at 5:00 PM UTC.', now)!;
    expect(new Date(utc).getUTCHours()).toBe(17);
    const local = limitResetsAt('Try again at 5:00 PM.', now)!;
    expect(new Date(local).getHours()).toBe(17);
  });
});
