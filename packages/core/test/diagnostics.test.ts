import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine, FakeAdapter, redact, Store, diagnosticsReport } from '../src/index.js';

describe('Export logs (C9)', () => {
  it('removes keys, tokens and the home folder', () => {
    const text = [
      `Opened ${join(homedir(), 'projects', 'shop')}`,
      'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
      'api_key: AIzaSyA-abcdefghijklmnopqrstuvwxyz012',
      'A normal line about merging task 3',
    ].join('\n');
    const out = redact(text);
    expect(out).not.toContain(homedir());
    expect(out).not.toMatch(/sk-ant-api03|ghp_abc|AIzaSyA/);
    expect(out).toContain('A normal line about merging task 3');
  });

  it('reports versions, AIs, projects and settings', async () => {
    const engine = new Engine({
      store: new Store(':memory:'),
      home: process.cwd(),
      adapters: [new FakeAdapter({ reply: 'hi' }, { id: 'claude' })],
    });
    const report = await diagnosticsReport(engine, {
      version: '1.0.0',
      platform: 'win32',
      arch: 'x64',
    });
    expect(report).toMatch(/^Conclave 1\.0\.0 diagnostics/);
    expect(report).toContain('== AIs ==');
    expect(report).toContain('claude: installed');
    expect(report).toContain('== Settings ==');
  });
});
