import { describe, expect, it } from 'vitest';
import {
  Council,
  FakeAdapter,
  Store,
  adapterMap,
  seatLabels,
  type CouncilUpdate,
} from '../src/index.js';

function setup(adapters: FakeAdapter[]) {
  const store = new Store(':memory:');
  return { store, council: new Council({ store, adapters: adapterMap(adapters), cwd: '.' }) };
}

describe('Council', () => {
  it('asks every member in parallel and has the synthesizer merge the answers', async () => {
    const claude = new FakeAdapter(
      {
        reply: (req) =>
          req.prompt.includes('synthesizer') ? 'Use CRDTs [Claude, Codex].' : 'Use CRDTs.',
      },
      { id: 'claude' },
    );
    const codex = new FakeAdapter({ reply: 'CRDTs, or Litestream for backups.' }, { id: 'codex' });
    const { store, council } = setup([claude, codex]);
    const updates: CouncilUpdate[] = [];

    const result = await council.ask('How do I sync SQLite?', {
      members: [{ provider: 'claude' }, { provider: 'codex' }],
      synthesizer: { provider: 'claude', model: 'opus' },
      onEvent: (u) => updates.push(u),
    });

    expect(result.mergedBy).toBe('synthesizer');
    expect(result.merged.content).toBe('Use CRDTs [Claude, Codex].');
    expect(result.answers.map((a) => [a.label, a.message.content])).toEqual([
      ['Claude', 'Use CRDTs.'],
      ['Codex', 'CRDTs, or Litestream for backups.'],
    ]);

    const synthPrompt = claude.requests[1]!;
    expect(synthPrompt.model).toBe('opus');
    expect(synthPrompt.prompt).toContain('=== Codex ===\nCRDTs, or Litestream for backups.');
    expect(synthPrompt.prompt).toContain('Where they differ');

    expect(updates.some((u) => u.phase === 'member' && u.label === 'Codex')).toBe(true);
    expect(updates.some((u) => u.phase === 'synthesis')).toBe(true);

    const stored = store.listMessages(result.thread.id);
    expect(stored.map((m) => m.kind)).toEqual([
      'message',
      'council_answer',
      'council_answer',
      'council_merged',
    ]);
    expect(new Set(stored.map((m) => m.groupId))).toEqual(new Set([result.groupId]));
    expect(result.thread.mode).toBe('council');
  });

  it('uses the only good answer when the other members fail', async () => {
    const claude = new FakeAdapter({ reply: '', fail: 'limit' }, { id: 'claude' });
    const codex = new FakeAdapter({ reply: 'Only me.' }, { id: 'codex' });
    const { council } = setup([claude, codex]);
    const result = await council.ask('q', {
      members: [{ provider: 'claude' }, { provider: 'codex' }],
    });

    expect(result.mergedBy).toBe('single-answer');
    expect(result.merged.content).toBe('Only me.');
    expect(result.answers[0]?.message.error).toBe('limit');
    expect(claude.requests).toHaveLength(1); // no synthesis call
  });

  it('reports when nobody answers', async () => {
    const claude = new FakeAdapter({ reply: '', fail: 'down' }, { id: 'claude' });
    const { council } = setup([claude]);
    const result = await council.ask('q', { members: [{ provider: 'claude' }] });
    expect(result.mergedBy).toBe('none');
    expect(result.merged.ok).toBe(false);
  });

  it('gives follow-up rounds the earlier questions and merged answers as context', async () => {
    const claude = new FakeAdapter({ reply: 'A' }, { id: 'claude' });
    const codex = new FakeAdapter({ reply: 'B' }, { id: 'codex' });
    const { council } = setup([claude, codex]);
    const members = [{ provider: 'claude' as const }, { provider: 'codex' as const }];
    const first = await council.ask('First question', { members });
    await council.ask('Follow-up', { members, threadId: first.thread.id });

    const followUp = codex.requests[1]!.prompt;
    expect(followUp).toContain('First question');
    expect(followUp).toContain('Council (merged by Claude (fake-1)):\nA');
    expect(followUp).not.toContain('Council member'); // individual answers stay out
    expect(followUp.trimEnd().endsWith('Follow-up')).toBe(true);
  });

  it('labels repeated providers by model', () => {
    expect(
      seatLabels([
        { provider: 'claude', model: 'opus' },
        { provider: 'claude', model: 'sonnet' },
        { provider: 'codex' },
      ]),
    ).toEqual(['Claude (opus)', 'Claude (sonnet)', 'Codex']);
  });

  it('refuses unavailable providers before asking anyone', async () => {
    const claude = new FakeAdapter({ reply: 'x' }, { id: 'claude' });
    const { council } = setup([claude]);
    await expect(
      council.ask('q', { members: [{ provider: 'claude' }, { provider: 'gemini' }] }),
    ).rejects.toThrow(/not available: gemini/);
    expect(claude.requests).toHaveLength(0);
  });
});
