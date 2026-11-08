import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Engine, FakeAdapter, Store, createMcpServer, createProject } from '../src/index.js';

/** v1.0 F9: the MCP tools against a store with fakes; it reads and queues, never decides approvals. */
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
};

async function setup() {
  const repo = temp('plenum-mcp-repo-');
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...a],
      {
        cwd: repo,
      },
    );
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const synth = (prompt: string) => prompt.includes('You are the synthesizer');
  const engine = new Engine({
    home: temp('plenum-mcp-home-'),
    store: new Store(':memory:'),
    adapters: [
      new FakeAdapter(
        { reply: (r) => (synth(r.prompt) ? 'Merged: use SQLite.' : 'Claude: SQLite.') },
        { id: 'claude' },
      ),
      new FakeAdapter({ reply: 'Codex: SQLite too.' }, { id: 'codex' }),
    ],
  });
  const project = await createProject(
    engine.store,
    [{ provider: 'claude' }, { provider: 'codex' }],
    {
      repoPath: repo,
      goal: 'Add hello.txt',
    },
  );
  const [client, server] = InMemoryTransport.createLinkedPair();
  await createMcpServer(engine, '1.0.0').connect(server);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { text: r.content[0]!.text, error: Boolean(r.isError) };
  };
  return { engine, project, mcp, call };
}

describe('MCP server (F9)', () => {
  it('lists its six tools', async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'answer_question',
      'ask_council',
      'list_inbox',
      'list_projects',
      'project_status',
      'submit_task',
    ]);
  });

  it('asks a council and returns the merged answer and each answer', async () => {
    const { call } = await setup();
    const r = await call('ask_council', { question: 'Which database?' });
    expect(r.error).toBe(false);
    expect(r.text).toContain('Merged: use SQLite.');
    expect(r.text).toContain('Codex: SQLite too.');
  });

  it('refuses an unknown council member', async () => {
    const { call } = await setup();
    const r = await call('ask_council', { question: 'Hi', members: ['nobody'] });
    expect(r.error).toBe(true);
    expect(r.text).toContain('Unknown provider');
  });

  it('lists projects and their status, and queues a task', async () => {
    const { call, engine, project } = await setup();
    expect(JSON.parse((await call('list_projects')).text)[0]).toMatchObject({
      id: project.id,
      goal: 'Add hello.txt',
    });
    const queued = await call('submit_task', {
      project: project.id.slice(0, 6),
      title: 'Add a goodbye file',
      spec: 'Create goodbye.txt',
    });
    expect(queued.error).toBe(false);
    const tasks = engine.store.projects.listTasks(project.id);
    expect(tasks.find((t) => t.title === 'Add a goodbye file')?.status).toBe('queued');
    const status = JSON.parse((await call('project_status', { project: project.id })).text);
    expect(status.tasks.some((t: { title: string }) => t.title === 'Add a goodbye file')).toBe(
      true,
    );
    expect(status.latest.join('\n')).toContain('Task added through MCP');
    expect((await call('project_status', { project: 'nope' })).error).toBe(true);
  });

  it('answers a question, but leaves approvals to you', async () => {
    const { call, engine, project } = await setup();
    const question = engine.store.projects.requestApproval({
      projectId: project.id,
      kind: 'question',
      summary: 'Which port?',
      payload: {
        question: 'Which port?',
        options: ['3000', '8080'],
        stage: 'build',
        provider: 'codex',
      },
    });
    const merge = engine.store.projects.requestApproval({
      projectId: project.id,
      kind: 'merge_base',
      summary: 'Merge the finished work into main',
    });
    const inbox = JSON.parse((await call('list_inbox')).text) as {
      id: string;
      answerable: boolean;
      options?: string[];
    }[];
    expect(inbox.find((i) => i.id === question.id)).toMatchObject({
      answerable: true,
      options: ['3000', '8080'],
    });
    expect(inbox.find((i) => i.id === merge.id)?.answerable).toBe(false);

    const refused = await call('answer_question', { id: merge.id, answer: 'yes' });
    expect(refused.error).toBe(true);
    expect(engine.store.projects.getApproval(merge.id)?.status).toBe('pending');

    const answered = await call('answer_question', { id: question.id, answer: '8080' });
    expect(answered.error).toBe(false);
    expect(engine.store.projects.getApproval(question.id)).toMatchObject({
      status: 'approved',
      answer: '8080',
    });
  });
});
