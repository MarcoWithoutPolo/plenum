import { describe, expect, it } from 'vitest';
import {
  Council,
  CouncilControl,
  FakeAdapter,
  Store,
  adapterMap,
  type CouncilUpdate,
} from '../src/index.js';

/** v1.0 F4: skip a council member, merge now, the merger falling back, and Stop (C1, C2). */

const SLOW = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
const MERGED = 'Merged answer [Claude, Codex].';

function setup(opts: { mergerFails?: boolean } = {}) {
  const store = new Store(':memory:');
  const synth = (prompt: string) => prompt.includes('You are the synthesizer');
  const claude = new FakeAdapter(
    {
      reply: (req) => (synth(req.prompt) ? MERGED : 'Claude says: use SQLite.'),
      failWhen: (req) =>
        opts.mergerFails && synth(req.prompt) ? 'Claude is at its usage limit' : undefined,
    },
    { id: 'claude' },
  );
  const codex = new FakeAdapter(
    { reply: (req) => (synth(req.prompt) ? 'Codex merged it.' : 'Codex says: use Postgres.') },
    { id: 'codex' },
  );
  // Gemini is slow: 200 words, 15 ms each.
  const gemini = new FakeAdapter({ reply: SLOW, delayMs: 15 }, { id: 'gemini' });
  const council = new Council({ store, adapters: adapterMap([claude, codex, gemini]), cwd: '.' });
  return { store, council, claude, codex, gemini };
}

const members = [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'gemini' }];
/** Skip `index` once it has streamed a few words. */
const skipWhenStreaming = (control: CouncilControl, index: number) => {
  let words = 0;
  return (u: CouncilUpdate) => {
    if (u.phase === 'member' && u.index === index && u.event.type === 'message.delta')
      if (++words === 5) control.skip(index);
  };
};

describe('Council: skip and merge now (F4)', () => {
  it('skipping a member while it answers stops it, keeps what it wrote, merges the rest', async () => {
    const { store, council, gemini } = setup();
    const control = new CouncilControl();
    const started = Date.now();
    const r = await council.ask('Which database?', {
      members,
      control,
      onEvent: skipWhenStreaming(control, 2),
    });
    expect(Date.now() - started).toBeLessThan(2_000); // not the slow member's 3 s
    expect(r.answers.map((a) => a.outcome)).toEqual(['answered', 'answered', 'skipped']);
    const skipped = r.answers[2]!.message;
    expect(skipped.content.startsWith('word0')).toBe(true); // what it wrote so far
    expect(skipped.content.length).toBeLessThan(SLOW.length);
    expect(skipped.error).toBe('Skipped by you');
    expect(r.mergedBy).toBe('synthesizer');
    expect(r.merged.content).toBe(MERGED);
    // The merge only cites who answered.
    const synthPrompt = gemini.requests.find((q) => q.prompt.includes('synthesizer'));
    expect(synthPrompt).toBeUndefined();
    // Its tokens and the run are recorded.
    expect(store.usage.runsSince('gemini', 0)).toBe(1);
    // Stored as skipped, read back the same.
    const stored = store.listMessages(r.thread.id).find((m) => m.id === skipped.id)!;
    expect(stored.outcome).toBe('skipped');
  });

  it('a member skipped before it starts never answers', async () => {
    const { council } = setup();
    const control = new CouncilControl();
    control.skip(2);
    const r = await council.ask('Which database?', { members, control });
    expect(r.answers[2]!.outcome).toBe('skipped');
    expect(r.answers[2]!.message.content).toBe('');
  });

  it('a skip that arrives after the member finished is ignored', async () => {
    const { council } = setup();
    const control = new CouncilControl();
    const r = await council.ask('Which database?', {
      members: members.slice(0, 2),
      control,
      onEvent: (u) => {
        if (u.phase === 'member' && u.index === 0 && u.event.type === 'done') control.skip(0);
      },
    });
    expect(r.answers.map((a) => a.outcome)).toEqual(['answered', 'answered']);
  });

  it('Merge now skips everyone still answering and merges what came back', async () => {
    const { council } = setup();
    const control = new CouncilControl();
    let done = 0;
    const r = await council.ask('Which database?', {
      members,
      control,
      onEvent: (u) => {
        if (u.phase === 'member' && u.event.type === 'done' && ++done === 2) control.mergeNow();
      },
    });
    expect(r.answers.map((a) => a.outcome)).toEqual(['answered', 'answered', 'skipped']);
    expect(r.mergedBy).toBe('synthesizer');
  });

  it('with one answer left, that answer is the council answer, with a note', async () => {
    const { council } = setup();
    const control = new CouncilControl();
    control.skip(1);
    control.skip(2);
    const r = await council.ask('Which database?', { members, control });
    expect(r.mergedBy).toBe('single-answer');
    expect(r.merged.content).toBe('Claude says: use SQLite.');
    expect(r.merged.error).toMatch(/^Only .+ answered; skipped: /);
  });

  it('everyone skipped: no merge, and it says so', async () => {
    const { council } = setup();
    const control = new CouncilControl();
    [0, 1, 2].forEach((i) => control.skip(i));
    const r = await council.ask('Which database?', { members, control });
    expect(r.mergedBy).toBe('none');
    expect(r.merged.error).toMatch(/every one was skipped/);
  });

  it('members still answering after the wait limit are skipped automatically', async () => {
    const { council } = setup();
    const r = await council.ask('Which database?', { members, maxWaitMs: 300 });
    expect(r.answers[2]!.outcome).toBe('skipped');
    expect(r.answers[2]!.message.error).toMatch(/^Skipped after/);
    expect(r.mergedBy).toBe('synthesizer');
  });

  it('Stop keeps the answers that came back and merges nothing (C1)', async () => {
    const { council } = setup();
    const stop = new AbortController();
    let done = 0;
    const r = await council.ask('Which database?', {
      members,
      signal: stop.signal,
      onEvent: (u) => {
        if (u.phase === 'member' && u.event.type === 'done' && ++done === 2) stop.abort();
      },
    });
    expect(r.answers.map((a) => a.outcome)).toEqual(['answered', 'answered', 'stopped']);
    expect(r.answers[0]!.message.content).toBe('Claude says: use SQLite.');
    expect(r.merged.error).toBe('Stopped before merging');
  });

  it('when the merger fails, the next member that answered merges instead (C2)', async () => {
    const { council } = setup({ mergerFails: true });
    const r = await council.ask('Which database?', {
      members: members.slice(0, 2),
      synthesizer: { provider: 'claude' },
    });
    expect(r.merged.ok).toBe(true);
    expect(r.merged.provider).toBe('codex');
    expect(r.merged.content).toBe('Codex merged it.');
    expect(r.merged.error).toMatch(/the chosen merger couldn/);
  });
});
