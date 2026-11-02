import { describe, expect, it } from 'vitest';
import { ChatSendInput, Seat } from '../src/index.js';

describe('Seat (U26)', () => {
  it('takes ordinary model and effort ids', () => {
    expect(Seat.parse({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' })).toEqual({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    expect(Seat.safeParse({ provider: 'local', model: 'qwen2.5-coder:14b' }).success).toBe(true);
  });

  it('refuses ids that a CLI would read as options, or with spaces', () => {
    expect(Seat.safeParse({ provider: 'codex', model: '--yolo' }).success).toBe(false);
    expect(Seat.safeParse({ provider: 'codex', effort: '-x' }).success).toBe(false);
    expect(Seat.safeParse({ provider: 'codex', model: 'gpt 6' }).success).toBe(false);
  });

  it('checks what the window sends with a chat message', () => {
    const ok = { requestId: 'r1', threadId: 't_abc', text: 'hi', seat: { provider: 'claude' } };
    expect(ChatSendInput.safeParse(ok).success).toBe(true);
    expect(ChatSendInput.safeParse({ ...ok, threadId: '../x' }).success).toBe(false);
    expect(
      ChatSendInput.safeParse({ ...ok, seat: { provider: 'codex', model: '--x' } }).success,
    ).toBe(false);
  });
});
