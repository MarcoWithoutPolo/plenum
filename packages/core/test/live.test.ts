import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  AntigravityAdapter,
  ClaudeAdapter,
  CodexAdapter,
  collect,
  type Adapter,
} from '../src/index.js';

// Spends real subscription usage, so it only runs when asked: PLENUM_LIVE=1 npm test
const enabled = process.env.PLENUM_LIVE === '1';

const cases: [Adapter, string | undefined][] = [
  [new ClaudeAdapter(), 'haiku'],
  [new CodexAdapter(), undefined],
  [new AntigravityAdapter(), 'gemini-3.8-flash-low'],
];

describe.skipIf(!enabled)('live CLIs', () => {
  for (const [adapter, model] of cases) {
    it(`${adapter.displayName} answers a prompt`, { timeout: 180_000 }, async (ctx) => {
      const status = await adapter.detect();
      if (status.auth !== 'signed_in') ctx.skip();
      const result = await collect(
        adapter.run({
          prompt: 'Reply with exactly the word: pong',
          cwd: tmpdir(),
          role: 'chat',
          ...(model && { model }),
        }),
      );
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.text.toLowerCase()).toContain('pong');
      expect(result.sessionId).toBeTruthy();
    });
  }
});
