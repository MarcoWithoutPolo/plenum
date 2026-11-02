import { create } from 'zustand';
import type { Approval, BrainEvent, FailureKind, ProviderId } from '@conclave/shared';
import type { RetryOptions } from '@conclave/core';
import type {
  ApprovalItem,
  DecideOptions,
  NewProjectInput,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  UsageReport,
} from '../../../shared/api';
import { api } from './api';
import { errorText, useApp } from './store';
import { settle } from './settle';

interface ProjectsState {
  loaded: boolean;
  summaries: ProjectSummary[];
  details: Record<string, ProjectDetail>;
  approvals: ApprovalItem[];
  usage?: UsageReport;
  /** Project ids with a start/stop request in flight, for button spinners. */
  busy: Record<string, boolean>;

  init(): void;
  refresh(): Promise<void>;
  load(id: string): Promise<ProjectDetail | null>;
  create(input: NewProjectInput): Promise<string | null>;
  start(id: string, at?: number): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  refreshApprovals(): Promise<void>;
  decide(
    approvalId: string,
    decision: 'approved' | 'rejected',
    opts?: DecideOptions,
  ): Promise<boolean>;
  update(id: string, settings: ProjectSettings): Promise<boolean>;
  retry(projectId: string, taskId: string, opts?: RetryOptions): Promise<boolean>;
  skip(projectId: string, taskId: string): Promise<boolean>;
  retryFailed(
    projectId: string,
    filter: { provider?: ProviderId; kind?: FailureKind },
    opts?: RetryOptions,
  ): Promise<number>;
  keepDecision(projectId: string, id: string): Promise<void>;
  changeDecision(projectId: string, id: string, answer: string, addTask: boolean): Promise<void>;
  addDecision(projectId: string, question: string, answer: string): Promise<void>;
  loadUsage(): Promise<void>;
}

/** What to say after you act on an inbox item. */
function decidedText(kind: Approval['kind'] | undefined, decision: string, opts?: DecideOptions) {
  if (decision === 'rejected') return 'Declined.';
  switch (kind) {
    case 'question':
      return 'Answered. The task is back in the queue.';
    case 'install':
    case 'network':
      return 'Allowed. The task is back in the queue.';
    case 'create_repo':
      return 'Published to GitHub.';
    default:
      return opts?.via === 'pr'
        ? 'Pull request opened.'
        : opts?.via === 'merge_push'
          ? 'Merged here and pushed to GitHub.'
          : "Merged into your branch here. GitHub isn't changed.";
  }
}

let subscribed = false;
const pendingReload = new Map<string, number>();

export const useProjects = create<ProjectsState>((set, get) => {
  const toast = (text: string, kind: 'error' | 'info' = 'error') =>
    useApp.getState().showToast(kind, text);

  /** Live events append at once; the heavier refresh of tasks and status is batched. */
  const onEvent = (event: BrainEvent) => {
    set((s) => {
      const d = s.details[event.projectId];
      if (!d || d.events.some((e) => e.id === event.id)) return {};
      return {
        details: {
          ...s.details,
          [event.projectId]: { ...d, events: [...d.events, event].slice(-600) },
        },
      };
    });
    window.clearTimeout(pendingReload.get(event.projectId));
    pendingReload.set(
      event.projectId,
      window.setTimeout(() => {
        settle(get().refresh());
        if (get().details[event.projectId]) settle(get().load(event.projectId));
        if (['approval', 'merge', 'question', 'decision', 'done'].includes(event.kind))
          settle(get().refreshApprovals());
      }, 250),
    );
  };

  return {
    loaded: false,
    summaries: [],
    details: {},
    approvals: [],
    busy: {},

    init() {
      if (subscribed) return;
      subscribed = true;
      api().projects.onEvent(onEvent);
      settle(
        Promise.all([get().refresh(), get().refreshApprovals()]).then(() => set({ loaded: true })),
      );
    },

    async refresh() {
      try {
        set({ summaries: await api().projects.list() });
      } catch (err) {
        toast(errorText(err));
      }
    },

    async load(id) {
      const detail = await api().projects.get(id);
      set((s) => {
        if (detail) return { details: { ...s.details, [id]: detail } };
        const { [id]: _gone, ...rest } = s.details;
        return { details: rest };
      });
      return detail;
    },

    async create(input) {
      try {
        const project = await api().projects.create(input);
        await Promise.all([get().refresh(), get().load(project.id)]);
        return project.id;
      } catch (err) {
        toast(errorText(err));
        return null;
      }
    },

    async start(id, at) {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        await api().projects.start(id, at);
      } catch (err) {
        toast(errorText(err));
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
        await Promise.all([get().refresh(), get().load(id)]);
      }
    },

    async stop(id) {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        await api().projects.stop(id);
      } catch (err) {
        toast(errorText(err));
      } finally {
        set((s) => ({ busy: { ...s.busy, [id]: false } }));
        await Promise.all([get().refresh(), get().load(id)]);
      }
    },

    async remove(id) {
      try {
        await api().projects.remove(id);
        set((s) => {
          const { [id]: _gone, ...rest } = s.details;
          return { details: rest };
        });
        await Promise.all([get().refresh(), get().refreshApprovals()]);
      } catch (err) {
        toast(errorText(err));
      }
    },

    async refreshApprovals() {
      try {
        set({ approvals: await api().approvals.list() });
      } catch (err) {
        toast(errorText(err));
      }
    },

    async decide(approvalId, decision, opts) {
      const kind =
        get().approvals.find((a) => a.approval.id === approvalId)?.approval.kind ??
        Object.values(get().details)
          .flatMap((d) => d.approvals)
          .find((a) => a.id === approvalId)?.kind;
      try {
        const result = await api().approvals.decide(approvalId, decision, opts);
        if (!result.ok) {
          toast(result.error ?? 'That did not work.');
          return false;
        }
        if (result.pushError) {
          toast(`Merged here, but the push didn't go through: ${result.pushError}`);
          return true;
        }
        toast(decidedText(kind, decision, opts), 'info');
        return true;
      } catch (err) {
        toast(errorText(err));
        return false;
      } finally {
        const item = get().approvals.find((a) => a.approval.id === approvalId);
        await Promise.all([
          get().refreshApprovals(),
          get().refresh(),
          ...(item ? [get().load(item.project.id)] : []),
        ]);
      }
    },

    async update(id, settings) {
      try {
        await api().projects.update(id, settings);
        await Promise.all([get().refresh(), get().load(id)]);
        return true;
      } catch (err) {
        toast(errorText(err));
        return false;
      }
    },

    async retry(projectId, taskId, opts) {
      try {
        await api().projects.retry(taskId, opts);
        toast('Back in the queue. Resume the project to build it.', 'info');
        return true;
      } catch (err) {
        toast(errorText(err));
        return false;
      } finally {
        await Promise.all([get().refresh(), get().load(projectId)]);
      }
    },

    async skip(projectId, taskId) {
      try {
        await api().projects.skip(taskId);
        return true;
      } catch (err) {
        toast(errorText(err));
        return false;
      } finally {
        await Promise.all([get().refresh(), get().load(projectId)]);
      }
    },

    async retryFailed(projectId, filter, opts) {
      try {
        const tasks = await api().projects.retryFailed(projectId, filter, opts);
        toast(`${tasks.length} task${tasks.length === 1 ? '' : 's'} back in the queue.`, 'info');
        return tasks.length;
      } catch (err) {
        toast(errorText(err));
        return 0;
      } finally {
        await Promise.all([get().refresh(), get().load(projectId)]);
      }
    },

    async keepDecision(projectId, id) {
      try {
        await api().decisions.keep(id);
      } catch (err) {
        toast(errorText(err));
      } finally {
        await get().load(projectId);
      }
    },

    async changeDecision(projectId, id, answer, addTask) {
      try {
        await api().decisions.change(id, answer, addTask);
        if (addTask) toast('Changed, and a task to apply it is queued.', 'info');
      } catch (err) {
        toast(errorText(err));
      } finally {
        await Promise.all([get().refresh(), get().load(projectId)]);
      }
    },

    async addDecision(projectId, question, answer) {
      try {
        await api().decisions.add(projectId, question, answer);
      } catch (err) {
        toast(errorText(err));
      } finally {
        await get().load(projectId);
      }
    },

    async loadUsage() {
      try {
        set({ usage: await api().usage.report() });
      } catch (err) {
        toast(errorText(err));
      }
    },
  };
});

export function pendingApprovalCount(items: ApprovalItem[]): number {
  return items.filter((a) => a.approval.status === 'pending').length;
}

export const QUESTION_KINDS: ReadonlySet<Approval['kind']> = new Set([
  'question',
  'install',
  'network',
]);
