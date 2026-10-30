import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LocalAdapter,
  collect,
  fitOf,
  isPrivateHost,
  localEngine,
  openCodeArgs,
  openCodeConfig,
  prettyName,
  type ProcessOptions,
} from '../src/index.js';
import { fixturePath, replay } from './helpers.js';

const gpu = { gpu: 'RTX', gpuMemoryGb: 16, ramGb: 32, local: true };

/** A fetch that answers Ollama's API from canned bodies, and records what was asked. */
function fakeOllama(routes: Record<string, () => Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[path];
    return route ? route() : new Response('{"error":"not here"}', { status: 404 });
  }) as typeof fetch;
  return Object.assign(http, { calls });
}

const json = (value: unknown) => () => Response.json(value);
const stream = (file: string) => () =>
  new Response(readFileSync(fixturePath(file), 'utf8'), {
    headers: { 'content-type': 'application/x-ndjson' },
  });

describe('Local models', () => {
  it('answers through Ollama with a context sized to the job, and counts tokens', async () => {
    const http = fakeOllama({ '/api/chat': stream('local/ollama-pong.jsonl') });
    const adapter = new LocalAdapter({ fetch: http, hardware: () => gpu });
    const result = await collect(
      adapter.run({ prompt: 'Reply with exactly: pong', cwd: '.', model: 'llama3.2:1b' }),
    );
    expect(result.text).toBe('Pong');
    expect(result.ok).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    const body = http.calls[0]!.body as { options: { num_ctx: number }; keep_alive: string };
    expect(body.options.num_ctx).toBe(8192);
    expect(body.keep_alive).toBe('30m');
  });

  it("explains a model that isn't downloaded", async () => {
    const http = fakeOllama({
      '/api/chat': () => new Response('{"error":"model \'big:70b\' not found"}', { status: 404 }),
    });
    const result = await collect(
      new LocalAdapter({ fetch: http, hardware: () => gpu }).run({
        prompt: 'x',
        cwd: '.',
        model: 'big:70b',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/isn't downloaded in Ollama/);
  });

  it('lists models with size, fit and context, hiding its own context aliases', async () => {
    const http = fakeOllama({
      '/api/tags': json({
        models: [
          {
            name: 'gpt-oss:20b',
            size: 13.8e9,
            details: {
              parameter_size: '20.9B',
              quantization_level: 'MXFP4',
              context_length: 131072,
            },
          },
          { name: 'llama4:scout', size: 67e9, details: { parameter_size: '109B' } },
          { name: 'conclave/gpt-oss:20b-32k', size: 13.8e9 },
        ],
      }),
      '/api/show': json({
        capabilities: ['completion', 'tools'],
        model_info: { 'llama.context_length': 10485760 },
      }),
    });
    const list = await new LocalAdapter({ fetch: http, hardware: () => gpu }).models();
    expect(list.models.map((m) => m.id)).toEqual(['gpt-oss:20b', 'llama4:scout']);
    // Default: the biggest model that fits in GPU memory.
    expect(list.defaultModel).toBe('gpt-oss:20b');
    expect(list.models[0]!.tags).toEqual(['14 GB', 'fits', '128k context']);
    expect(list.models[1]!.tags).toContain('too big');
    expect(list.models[0]!.description).toContain('uses tools');
  });

  it('builds through OpenCode in the worktree, never wherever it was started from', async () => {
    const exec = replay('local/opencode-edit.jsonl');
    const http = fakeOllama({
      '/api/show': json({ model_info: { 'gptoss.context_length': 131072 } }),
      '/api/create': json({ status: 'success' }),
    });
    const adapter = new LocalAdapter({ fetch: http, exec, hardware: () => gpu });
    const result = await collect(
      adapter.run({
        prompt: 'Add a line',
        cwd: '/work/tree',
        model: 'gpt-oss:20b',
        role: 'builder',
        readOnly: false,
      }),
    );
    const call = exec.calls[0] as ProcessOptions;
    // An inherited PWD once sent OpenCode to the wrong folder: both point at the worktree.
    expect(call.env?.PWD).toBe('/work/tree');
    expect(call.args).toEqual(expect.arrayContaining(['--dir', '/work/tree']));
    expect(call.args).toEqual(expect.arrayContaining(['-m', 'ollama/conclave/gpt-oss:20b-32k']));
    expect(call.stdin).toBe('');
    expect(http.calls.find((c) => c.url.endsWith('/api/create'))?.body).toMatchObject({
      from: 'gpt-oss:20b',
      parameters: { num_ctx: 32768 },
    });
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', tool: 'edit' }),
    );
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });

  it('denies shell and web below level 5 in the OpenCode config', () => {
    expect(openCodeConfig('http://127.0.0.1:11434', 'm').permission).toEqual({
      edit: 'allow',
      bash: 'deny',
      webfetch: 'deny',
    });
    expect(openCodeConfig('http://h:1', 'm', { level: 5, network: true }).permission.bash).toBe(
      'allow',
    );
    expect(openCodeArgs('m', 'brief.md', '/w')[1]).toMatch(/^Follow/);
  });

  it('picks the engine by job, and says when OpenCode is missing for building', async () => {
    expect(localEngine('chat', true)).toBe('ollama');
    expect(localEngine('reviewer', true)).toBe('ollama');
    expect(localEngine('builder', false)).toBe('opencode');
    expect(localEngine('builder', false, 1)).toBe('ollama');
  });

  it('names models the way their makers write them', () => {
    expect(prettyName('gpt-oss:20b')).toBe('GPT-OSS 20B');
    expect(prettyName('llama3.2:1b')).toBe('Llama 3.2 1B');
    expect(prettyName('qwen2.5-coder:14b')).toBe('Qwen2.5 Coder 14B');
    expect(prettyName('mistral:latest')).toBe('Mistral');
  });

  it('tells whether a model fits this machine', () => {
    expect(fitOf(9, gpu)).toBe('gpu');
    expect(fitOf(19, gpu)).toBe('partial');
    expect(fitOf(67, gpu)).toBe('no');
    expect(fitOf(9, { ramGb: 32, local: false })).toBeUndefined();
  });

  it('warns about Ollama addresses outside a private network', () => {
    expect(isPrivateHost('http://127.0.0.1:11434')).toBe(true);
    expect(isPrivateHost('http://gpu-box:11434')).toBe(true);
    expect(isPrivateHost('http://192.168.1.20:11434')).toBe(true);
    expect(isPrivateHost('http://ollama.example.com:11434')).toBe(false);
  });
});
