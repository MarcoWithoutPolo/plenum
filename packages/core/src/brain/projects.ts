import { basename, resolve } from 'node:path';
import type {
  AskPolicy,
  Permissions,
  Project,
  ProviderId,
  RetryStrategy,
  Routing,
  Seat,
} from '@conclave/shared';
import type { Store } from '../store/store.js';
import { currentBranch, isRepo, repoRoot } from '../workspace/git.js';

/** Which provider does each job by default, best first. Only signed-in providers are kept. */
const PREFERENCE: Record<keyof Routing, ProviderId[]> = {
  // Planning and review lean on judgment; building on fast, careful edits.
  planner: ['claude', 'antigravity', 'codex', 'gemini'],
  builder: ['codex', 'claude', 'antigravity', 'gemini'],
  reviewer: ['claude', 'antigravity', 'codex', 'gemini'],
};

export function defaultRouting(ready: Seat[]): Routing {
  const order = (role: keyof Routing) =>
    PREFERENCE[role].flatMap((p) => ready.filter((s) => s.provider === p));
  return { planner: order('planner'), builder: order('builder'), reviewer: order('reviewer') };
}

export interface CreateProjectInput {
  repoPath: string;
  goal: string;
  name?: string;
  doneWhen?: string;
  testCommand?: string;
  routing?: Partial<Routing>;
  maxAttempts?: number;
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
  designDirection?: string;
  draft?: boolean;
}

/** Validate the repo and register a project. The repo's own checkout is left alone. */
export async function createProject(
  store: Store,
  ready: Seat[],
  input: CreateProjectInput,
): Promise<Project> {
  const path = resolve(input.repoPath);
  if (!(await isRepo(path))) {
    throw new Error(`${path} is not a git repository. Run "git init" there and commit once first.`);
  }
  const root = await repoRoot(path);
  const base = await currentBranch(root);
  if (base === 'HEAD')
    throw new Error('The repository has no commits yet (or a detached HEAD). Commit once first.');
  if (!input.goal.trim()) throw new Error('A project needs a goal.');

  const routing = { ...defaultRouting(ready), ...input.routing };
  for (const role of ['planner', 'builder', 'reviewer'] as const) {
    if (routing[role].length === 0)
      throw new Error(`No signed-in provider can be the ${role}. Run: conclave doctor`);
  }
  return store.projects.create({
    name: input.name?.trim() || basename(root),
    repoPath: root,
    goal: input.goal.trim(),
    doneWhen: input.doneWhen?.trim() || null,
    testCommand: input.testCommand?.trim() || null,
    baseBranch: base,
    routing,
    ...(input.maxAttempts !== undefined && { maxAttempts: input.maxAttempts }),
    ...(input.retryStrategy && { retryStrategy: input.retryStrategy }),
    ...(input.askPolicy && { askPolicy: input.askPolicy }),
    ...(input.permissions && { permissions: input.permissions }),
    ...(input.designDirection?.trim() && { designDirection: input.designDirection.trim() }),
    ...(input.draft && { draft: true }),
  });
}
