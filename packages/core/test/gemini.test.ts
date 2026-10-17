import { describe, expect, it } from 'vitest';
import { GeminiParser } from '../src/index.js';

// No recorded Gemini output exists yet (see GeminiAdapter); these lock in the documented stream-json shape.
describe('GeminiParser (documented format, unverified)', () => {
  it('maps init, assistant messages and a successful result', () => {
    const parser = new GeminiParser();
    const events = [
      { type: 'init', session_id: 's1', model: 'gemini-x' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: 'po', delta: true },
      { type: 'message', role: 'assistant', content: 'ng', delta: true },
      { type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 } },
    ].flatMap((m) => parser.parse(m));

    expect(events).toEqual([
      { type: 'session', sessionId: 's1', model: 'gemini-x' },
      { type: 'message.delta', text: 'po' },
      { type: 'message.delta', text: 'ng' },
      { type: 'message.done', text: 'pong' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    expect(parser.failed).toBe(false);
  });

  it('marks errors as failures', () => {
    const parser = new GeminiParser();
    expect(parser.parse({ type: 'error', message: 'nope' })).toEqual([
      { type: 'error', message: 'nope' },
    ]);
    expect(parser.failed).toBe(true);
  });
});
