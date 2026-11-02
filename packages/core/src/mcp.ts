import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { firstPreferred, type QuestionPayload } from '@conclave/shared';
import { z } from 'zod';
import { decideApproval } from './brain/manager.js';
import { parseSeat, type Engine } from './engine.js';

/**
 * Conclave as an MCP server (v1.0 F9): Claude Code, Codex or any MCP client can ask a council,
 * read projects and the Inbox, queue a task and answer a project's question. It only reads and
 * queues: merges, pull requests, pushes, installs and network access stay in the Inbox for you.
 *
 *   claude mcp add conclave -- "<Conclave.exe>" --mcp
 *   claude mcp add conclave -- npm --prefix <clone> run -s conclave -- mcp
 */
export function createMcpServer(engine: Engine, version: string): McpServer {
  const server = new McpServer({ name: 'conclave', version });
  const store = engine.store;
  const text = (value: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  });
  const refuse = (message: string) => ({ ...text(message), isError: true });
  const findProject = (id: string) => store.projects.find(id);

  server.registerTool(
    'ask_council',
    {
      title: 'Ask the council',
      description:
        'Ask several AIs the same question at once (each signed in through its own CLI) and get one merged answer, with where they agree and disagree, plus each answer.',
      inputSchema: {
        question: z.string().min(1),
        members: z
          .array(z.string())
          .optional()
          .describe(
            'Who answers, e.g. ["claude", "codex@low", "claude:opus@high"]. Default: every signed-in AI.',
          ),
        maxWaitSeconds: z
          .number()
          .int()
          .min(10)
          .max(1800)
          .optional()
          .describe('Members still answering after this long are skipped and the rest merged.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ question, members, maxWaitSeconds }, extra) => {
      let seats;
      try {
        seats = members?.length ? members.map(parseSeat) : await engine.readySeats();
      } catch (e) {
        return refuse((e as Error).message);
      }
      if (seats.length === 0)
        return refuse('No AI is signed in. Open Conclave → Accounts to connect one.');
      const result = await engine.council.ask(question, {
        members: seats,
        synthesizer: firstPreferred(seats)!,
        signal: extra.signal,
        ...(maxWaitSeconds && { maxWaitMs: maxWaitSeconds * 1000 }),
      });
      const answers = result.answers
        .map(
          (a) =>
            `### ${a.label}\n${a.message.ok ? a.message.content : `(${a.message.outcome ?? 'failed'}: ${a.message.error ?? 'no answer'})`}`,
        )
        .join('\n\n');
      const merged = result.merged.ok ? result.merged.content : `(${result.merged.error})`;
      return text(`## Merged answer\n${merged}\n\n## Each answer\n${answers}`);
    },
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Every Conclave project with its status and task counts.',
      annotations: { readOnlyHint: true },
    },
    () =>
      text(
        store.projects.list().map((p) => {
          const tasks = store.projects.listTasks(p.id);
          return {
            id: p.id,
            name: p.name,
            status: p.status,
            ...(p.statusReason && { reason: p.statusReason }),
            goal: p.goal,
            tasks: {
              total: tasks.length,
              merged: tasks.filter((t) => t.status === 'merged').length,
              queued: tasks.filter((t) => t.status === 'queued').length,
              failed: tasks.filter((t) => t.status === 'failed').length,
            },
            waitingForYou: store.projects.approvals(p.id, 'pending').length,
          };
        }),
      ),
  );

  server.registerTool(
    'project_status',
    {
      title: 'Project status',
      description: "A project's tasks, what waits for you, and its latest activity.",
      inputSchema: { project: z.string().describe('The project id, or the start of it.') },
      annotations: { readOnlyHint: true },
    },
    ({ project: id }) => {
      const p = findProject(id);
      if (!p) return refuse(`No project "${id}".`);
      return text({
        id: p.id,
        name: p.name,
        status: p.status,
        goal: p.goal,
        tasks: store.projects.listTasks(p.id).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          attempts: t.attempts,
        })),
        waitingForYou: store.projects
          .approvals(p.id, 'pending')
          .map((a) => ({ id: a.id, kind: a.kind, summary: a.summary })),
        latest: store.projects
          .events(p.id, { latest: 20 })
          .map((e) => `${new Date(e.at).toISOString()} ${e.kind}: ${e.message}`),
      });
    },
  );

  server.registerTool(
    'submit_task',
    {
      title: 'Queue a task',
      description:
        "Add a task to a project's queue. It's built, tested and reviewed like any other; it starts when the project runs.",
      inputSchema: {
        project: z.string().describe('The project id, or the start of it.'),
        title: z.string().min(3).max(200),
        spec: z.string().min(1).describe('What to build, and how to tell it is done.'),
      },
    },
    ({ project: id, title, spec }) => {
      const p = findProject(id);
      if (!p) return refuse(`No project "${id}".`);
      if (p.status === 'done' || p.status === 'stopped')
        return refuse(`"${p.name}" is ${p.status}. Open it in Conclave to start it again.`);
      const [task] = store.projects.addTasks(p.id, [{ title, spec }]);
      store.projects.log({
        projectId: p.id,
        taskId: task!.id,
        kind: 'task',
        message: `Task added through MCP: ${title}`,
      });
      return text(
        `Queued "${title}" (${task!.id}) in ${p.name}. ${p.status === 'running' ? 'The project is running and will reach it in turn.' : 'It starts when the project runs.'}`,
      );
    },
  );

  server.registerTool(
    'list_inbox',
    {
      title: 'List the Inbox',
      description:
        'What waits for you across projects: questions (which answer_question can answer) and approvals (which only you can decide, in Conclave).',
      annotations: { readOnlyHint: true },
    },
    () =>
      text(
        store.projects.approvals(undefined, 'pending').map((a) => {
          const project = store.projects.get(a.projectId);
          const q = a.kind === 'question' ? (a.payload as QuestionPayload | null) : null;
          return {
            id: a.id,
            project: project?.name ?? a.projectId,
            kind: a.kind,
            summary: a.summary,
            ...(q && {
              question: q.question,
              options: q.options,
              ...(q.recommended && { recommended: q.recommended }),
            }),
            answerable: a.kind === 'question',
          };
        }),
      ),
  );

  server.registerTool(
    'answer_question',
    {
      title: 'Answer a question',
      description:
        "Answer a project's question from the Inbox; the waiting task goes back in the queue. Approvals (merges, pull requests, installs, network) can't be answered here.",
      inputSchema: {
        id: z.string().describe('The Inbox item id, or the start of it.'),
        answer: z.string().min(1),
      },
    },
    async ({ id, answer }) => {
      const approval = store.projects.findApproval(id);
      if (!approval || approval.status !== 'pending') return refuse(`No open question "${id}".`);
      if (approval.kind !== 'question')
        return refuse(
          `That's a ${approval.kind.replace('_', ' ')} request: only you can decide it, in Conclave's Inbox.`,
        );
      const outcome = await decideApproval(engine, engine.home, approval.id, 'approved', answer);
      return outcome.ok
        ? text('Answered. The waiting task is back in the queue.')
        : refuse(outcome.error);
    },
  );

  return server;
}

/** Serve MCP over stdin and stdout until the client disconnects. */
export async function serveMcp(engine: Engine, version: string): Promise<void> {
  const server = createMcpServer(engine, version);
  const transport = new StdioServerTransport();
  // Done when the client closes the connection or its end of stdin.
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await server.connect(transport);
  await closed;
  await server.close();
}
