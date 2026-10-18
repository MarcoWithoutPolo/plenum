import { create } from 'zustand';
import type { BrainEvent } from '@conclave/shared';
import type {
  ApprovalItem,
  NewProjectInput,
  ProjectDetail,
  ProjectSummary,
  UsageReport,
} from '../../../shared/api';
import { api } from './api';
import { errorText, useApp } from './store';

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
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  refreshApprovals(): Promise<void>;
  decide(approvalId: string, decision: 'approved' | 'rejected'): Promise<boolean>;
  loadUsage(): Promise<void>;
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
        void get().refresh();
        if (get().details[event.projectId]) void get().load(event.projectId);
        if (event.kind === 'approval' || event.kind === 'merge') void get().refreshApprovals();
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
      void Promise.all([get().refresh(), get().refreshApprovals()]).then(() =>
        set({ loaded: true }),
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

    async start(id) {
      set((s) => ({ busy: { ...s.busy, [id]: true } }));
      try {
        await api().projects.start(id);
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

    async decide(approvalId, decision) {
      try {
        const result = await api().approvals.decide(approvalId, decision);
        if (!result.ok) {
          toast(result.error ?? 'That did not work.');
          return false;
        }
        toast(
          decision === 'approved' ? 'Merged. The work is on your branch now.' : 'Declined.',
          'info',
        );
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
