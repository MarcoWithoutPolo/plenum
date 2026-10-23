import { useEffect } from 'react';
import { CheckCircle2, Inbox, MessageCircleQuestion, XCircle } from 'lucide-react';
import type { Approval } from '@conclave/shared';
import { ApprovalCard } from '@/components/ApprovalCard';
import { relative } from '@/components/PlanUsage';
import { QuestionCard } from '@/components/QuestionCard';
import { QUESTION_KINDS, useProjects } from '@/lib/projects';

/** Everything waiting for you: agents' questions first, then work to merge or publish. */
export function InboxScreen() {
  const init = useProjects((s) => s.init);
  const approvals = useProjects((s) => s.approvals);
  const summaries = useProjects((s) => s.summaries);
  const details = useProjects((s) => s.details);
  const refresh = useProjects((s) => s.refreshApprovals);
  useEffect(() => {
    init();
    void refresh();
  }, [init, refresh]);

  const pending = approvals.filter((a) => a.approval.status === 'pending');
  const questions = pending
    .filter((a) => QUESTION_KINDS.has(a.approval.kind))
    .sort((a, b) => a.approval.createdAt - b.approval.createdAt);
  const others = pending.filter((a) => !QUESTION_KINDS.has(a.approval.kind));
  const decided = approvals.filter((a) => a.approval.status !== 'pending').slice(0, 20);
  const running = new Set(summaries.filter((s) => s.running).map((s) => s.project.id));
  const taskTitle = (a: Approval) =>
    a.taskId ? details[a.projectId]?.tasks.find((t) => t.id === a.taskId)?.title : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-10 shrink-0 items-center px-6" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pt-4 pb-16">
          <h1 className="text-[22px] font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            Questions from the agents, and anything that changes your branches or reaches GitHub.
            Nothing here happens without you.
          </p>

          {pending.length === 0 ? (
            <div className="mt-8 rounded-3xl border border-line bg-panel px-8 py-12 text-center shadow-card">
              <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-sunken text-muted">
                <Inbox className="size-5" aria-hidden />
              </div>
              <h2 className="mt-3.5 text-[16px] font-semibold">You're all caught up</h2>
              <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted">
                When an agent needs a decision, or a project's work is ready, it shows up here.
              </p>
            </div>
          ) : (
            <>
              {questions.length > 0 && (
                <section aria-label="Questions" className="mt-6">
                  <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                    <MessageCircleQuestion className="size-3.5" aria-hidden /> Questions ·{' '}
                    {questions.length}
                  </h2>
                  <ul className="flex flex-col gap-3">
                    {questions.map((item) => (
                      <li key={item.approval.id}>
                        <QuestionCard
                          approval={item.approval}
                          projectName={item.project.name}
                          {...(taskTitle(item.approval) && { taskTitle: taskTitle(item.approval) })}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {others.length > 0 && (
                <section aria-label="Approvals" className="mt-8">
                  <h2 className="mb-2 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                    Approvals · {others.length}
                  </h2>
                  <ul className="flex flex-col gap-3">
                    {others.map((item) => (
                      <li key={item.approval.id}>
                        <ApprovalCard
                          approval={item.approval}
                          project={item.project}
                          running={running.has(item.project.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
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
                      {approval.answer && approval.kind === 'question' && (
                        <span className="text-ink"> → {approval.answer}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[12px] text-faint">
                      {outcome(approval)}{' '}
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

function outcome(a: Approval): string {
  if (a.status === 'rejected') return 'Declined';
  switch (a.kind) {
    case 'question':
      return 'Answered';
    case 'install':
    case 'network':
      return 'Allowed';
    case 'create_repo':
      return 'Published';
    default:
      return a.answer?.startsWith('https://') ? 'PR opened' : 'Merged';
  }
}
