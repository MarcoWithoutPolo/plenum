import { tmpdir } from 'node:os';
import type { ProviderStatus } from '@conclave/shared';
import { collect, createAdapters, type Adapter } from '@conclave/core';

/** Cheapest model per provider for the live check. */
const LIVE_MODEL: Partial<Record<string, string>> = { claude: 'haiku' };
const LIVE_PROMPT = 'Reply with exactly the word: pong';

export async function doctor(opts: { live?: boolean; json?: boolean } = {}): Promise<number> {
  const adapters = createAdapters();
  const statuses = await Promise.all(adapters.map((a) => a.detect()));

  const live = opts.live
    ? await Promise.all(
        adapters.map((a, i) =>
          statuses[i]?.auth === 'signed_in' ? liveCheck(a) : Promise.resolve(undefined),
        ),
      )
    : [];

  if (opts.json) {
    console.log(
      JSON.stringify(
        statuses.map((s, i) => ({ ...s, live: live[i] })),
        null,
        2,
      ),
    );
  } else {
    console.log('Conclave doctor\n');
    statuses.forEach((s, i) => console.log(formatRow(adapters[i]!, s, live[i])));
    const ready = statuses.filter((s) => s.auth === 'signed_in').length;
    console.log(`\n${ready} of ${statuses.length} providers ready.`);
    const missing = statuses.filter((s) => s.auth !== 'signed_in');
    if (missing.length) {
      console.log('\nTo connect the others:');
      for (const s of missing) {
        const adapter = adapters.find((a) => a.id === s.provider)!;
        const login = adapter.login();
        console.log(
          s.installed
            ? `  ${adapter.displayName}: run \`${[login.command, ...login.args].join(' ')}\`. ${login.hint}`
            : `  ${adapter.displayName}: ${s.detail ?? 'not installed'}`,
        );
      }
    }
  }

  const anyReady = statuses.some((s) => s.auth === 'signed_in');
  const liveFailed = live.some((r) => r && !r.ok);
  return anyReady && !liveFailed ? 0 : 1;
}

interface LiveResult {
  ok: boolean;
  ms: number;
  answer?: string;
  error?: string;
}

async function liveCheck(adapter: Adapter): Promise<LiveResult> {
  const model = LIVE_MODEL[adapter.id];
  const result = await collect(
    adapter.run({
      prompt: LIVE_PROMPT,
      cwd: tmpdir(),
      role: 'chat',
      timeoutMs: 120_000,
      ...(model && { model }),
    }),
  );
  const answer = result.text.trim();
  const error = result.errors[0] ?? result.rateLimited?.message;
  return {
    ok: result.ok && /pong/i.test(answer),
    ms: result.durationMs,
    ...(answer && { answer }),
    ...(error && { error }),
  };
}

function formatRow(adapter: Adapter, s: ProviderStatus, live?: LiveResult): string {
  const mark = s.auth === 'signed_in' ? 'ok ' : s.installed ? ' ! ' : ' x ';
  const state = !s.installed
    ? 'not installed'
    : s.auth === 'signed_in'
      ? 'signed in'
      : s.auth === 'signed_out'
        ? 'signed out'
        : 'not connected';
  const parts = [
    `[${mark}] ${adapter.displayName.padEnd(13)}`,
    (s.version ?? '-').padEnd(10),
    state.padEnd(14),
  ];
  if (s.detail) parts.push(s.detail);
  let row = parts.join(' ');
  if (live) {
    row += live.ok
      ? `\n       live check: answered "${live.answer}" in ${(live.ms / 1000).toFixed(1)}s`
      : `\n       live check FAILED: ${live.error ?? `unexpected answer "${live.answer ?? ''}"`}`;
  }
  return row;
}
