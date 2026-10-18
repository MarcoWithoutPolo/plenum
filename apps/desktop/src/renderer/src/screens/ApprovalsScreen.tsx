import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, GitMerge, Inbox, XCircle } from 'lucide-react';
import type { ApprovalItem } from '../../../shared/api';
import { Button } from '@/components/bits';
import { relative } from '@/components/PlanUsage';
import { useProjects } from '@/lib/projects';
import { useApp } from '@/lib/store';

export function ApprovalsScreen() {
  const init = useProjects((s) => s.init);
  const approvals = useProjects((s) => s.approvals);
  const summaries = useProjects((s) => s.summaries);
  const refresh = useProjects((s) => s.refreshApprovals);
  useEffect(() => {
    init();
    void refresh();
  }, [init, refresh]);

  const pending = approvals.filter((a) => a.approval.status === 'pending');
  const decided = approvals.filter((a) => a.approval.status !== 'pending').slice(0, 20);
  const running = new Set(summaries.filter((s) => s.running).map((s) => s.project.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <h1 className="text-[22px] font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            Anything that changes your own branches waits here for you. Projects never merge on
            their own.
          </p>

          {pending.length === 0 ? (
            <div className="mt-8 rounded-3xl border border-line bg-panel px-8 py-12 text-center shadow-card">
              <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-sunken text-muted">
                <Inbox className="size-5" aria-hidden />
              </div>
              <h2 className="mt-3.5 text-[16px] font-semibold">You're all caught up</h2>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">
                When a project meets its goal, its work shows up here for you to merge.
              </p>
            </div>
          ) : (
            <ul className="mt-6 flex flex-col gap-3">
              {pending.map((item) => (
                <li key={item.approval.id}>
                  <PendingCard item={item} running={running.has(item.project.id)} />
                </li>
              ))}
            </ul>
          )}

          {decided.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                Earlier
              </h2>
              <ul className="divide-y divide-line rounded-2xl border border-line bg-panel">
                {decided.map(({ approval, project }) => (
                  <li key={approval.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    {approval.status === 'approved' ? (
                      <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="Approved" />
                    ) : (
                      <XCircle className="size-4 shrink-0 text-faint" aria-label="Declined" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{project.name}</span>
                      <span className="text-muted"> · {approval.summary}</span>
                    </span>
                    <span className="shrink-0 text-[12px] text-faint">
                      {approval.status === 'approved' ? 'Merged' : 'Declined'}{' '}
                      {relative(approval.decidedAt ?? approval.createdAt, 'past')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PendingCard({ item, running }: { item: ApprovalItem; running: boolean }) {
  const decide = useProjects((s) => s.decide);
  const open = useApp((s) => s.open);
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const { approval, project } = item;
  const tasks = (approval.payload as { tasks?: string[] } | null)?.tasks ?? [];
  const act = async (d: 'approved' | 'rejected') => {
    setBusy(d);
    await decide(approval.id, d);
    setBusy(null);
  };

  return (
    <article
      aria-label={`${project.name}: ${approval.summary}`}
      className="rounded-2xl border border-line bg-panel p-5 shadow-card"
    >
      <div className="flex items-start gap-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <GitMerge className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-[14.5px] font-semibold">{project.name}</h2>
            <span className="shrink-0 text-[12px] text-faint">
              {relative(approval.createdAt, 'past')}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            Merge{' '}
            <code className="rounded bg-sunken px-1 font-mono text-[12px]">
              {project.integrationBranch}
            </code>{' '}
            into{' '}
            <code className="rounded bg-sunken px-1 font-mono text-[12px]">
              {project.baseBranch}
            </code>
            : {tasks.length} task{tasks.length === 1 ? '' : 's'} that passed tests and review.
          </p>
          {tasks.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {tasks.map((t) => (
                <li key={t} className="flex items-center gap-2 text-[13px]">
                  <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 border-t border-line pt-3.5">
        <button
          type="button"
          onClick={() => open({ name: 'projects', projectId: project.id })}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-ink hover:underline"
        >
          Review the work <ArrowRight className="size-3.5" />
        </button>
        {running && <span className="text-[12px] text-warn">Stop the project to merge</span>}
        <span className="ml-auto flex gap-2">
          <Button onClick={() => void act('rejected')} disabled={busy !== null}>
            {busy === 'rejected' ? 'Declining…' : 'Decline'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void act('approved')}
            disabled={busy !== null || running}
          >
            <GitMerge className="size-3.5" /> {busy === 'approved' ? 'Merging…' : 'Approve merge'}
          </Button>
        </span>
      </div>
    </article>
  );
}
