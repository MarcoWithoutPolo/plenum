import { basename, resolve } from 'node:path';
import type {
  AskPolicy,
  GitHubLink,
  Permissions,
  Project,
  RetryStrategy,
  Routing,
  Seat,
} from '@conclave/shared';
import { preferred } from '@conclave/shared';
import type { Store } from '../store/store.js';
import { currentBranch, isRepo, repoRoot } from '../workspace/git.js';

/**
 * Which provider does each job by default, best first (the registry's preference). Only
 * signed-in providers are kept. The brain adjusts this order from measured reliability, quota
 * and speed (governor/rank.ts).
 */
export function defaultRouting(ready: Seat[]): Routing {
  const order = (role: keyof Routing) =>
    preferred(role).flatMap((p) => ready.filter((s) => s.provider === p));
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
  /** Lanes: how many tasks may build at once (1 to 4). */
  maxParallel?: number;
  /** An AI that can see reviews the screenshots too (web projects). On unless set to false. */
  visualReview?: boolean;
  /** Reorder the team from measured speed, reliability and quota. On unless set to false. */
  adaptiveTeam?: boolean;
  retryStrategy?: RetryStrategy;
  askPolicy?: AskPolicy;
  permissions?: Permissions;
  designDirection?: string;
  draft?: boolean;
  github?: GitHubLink | null;
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
    ...(input.maxParallel !== undefined && { maxParallel: input.maxParallel }),
    ...(input.visualReview !== undefined && { visualReview: input.visualReview }),
    ...(input.adaptiveTeam !== undefined && { adaptiveTeam: input.adaptiveTeam }),
    ...(input.retryStrategy && { retryStrategy: input.retryStrategy }),
    ...(input.askPolicy && { askPolicy: input.askPolicy }),
    ...(input.permissions && { permissions: input.permissions }),
    ...(input.designDirection?.trim() && { designDirection: input.designDirection.trim() }),
    ...(input.draft && { draft: true }),
    ...(input.github && { github: input.github }),
  });
}
