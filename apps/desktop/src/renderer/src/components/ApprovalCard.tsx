import { useState } from 'react';
import { ArrowRight, CheckCircle2, GitMerge, GitPullRequest, UploadCloud } from 'lucide-react';
import type { Approval, Project } from '@conclave/shared';
import { Button } from './bits';
import { Segmented } from './form';
import { relative } from './PlanUsage';
import { useProjects } from '@/lib/projects';
import { useApp } from '@/lib/store';

/**
 * A finished project's work (merge here, or open/update a pull request) or a request to
 * publish to GitHub. The exact effect is spelled out before you approve.
 */
export function ApprovalCard({
  approval,
  project,
  running,
  variant = 'card',
}: {
  approval: Approval;
  project: Project;
  running: boolean;
  /** "banner" sits on the project page; "card" in the Inbox. */
  variant?: 'card' | 'banner';
}) {
  const decide = useProjects((s) => s.decide);
  const open = useApp((s) => s.open);
  const prOpen = project.github?.prState === 'open';
  const canPr = Boolean(project.github?.repo);
  const [via, setVia] = useState<'merge' | 'pr'>(prOpen ? 'pr' : 'merge');
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);

  const act = async (d: 'approved' | 'rejected') => {
    setBusy(d);
    await decide(approval.id, d, approval.kind === 'push' ? { via, ...(draft && { draft }) } : {});
    setBusy(null);
  };

  const tasks = ((approval.payload as { tasks?: string[] } | null)?.tasks ?? []).slice(0, 8);
  const publish = approval.kind === 'create_repo';
  const command = (approval.payload as { command?: string } | null)?.command;
  const Icon = publish ? UploadCloud : via === 'pr' ? GitPullRequest : GitMerge;

  const title = publish
    ? 'Publish to GitHub'
    : prOpen
      ? 'New work for the pull request'
      : via === 'pr'
        ? 'Ready for a pull request'
        : `Ready to merge into ${project.baseBranch}`;
  const what = publish
    ? approval.summary
    : via === 'pr'
      ? prOpen
        ? `Pushes ${project.integrationBranch} to ${project.github?.prBranch} on GitHub. Nothing else changes.`
        : `Pushes ${project.integrationBranch} to its own branch on ${project.github?.repo} and opens a pull request into ${project.baseBranch}. Never force-pushes.`
      : `Merges ${project.integrationBranch} into your ${project.baseBranch} branch here. Nothing is pushed.`;
  const primary = publish
    ? 'Publish'
    : via === 'pr'
      ? prOpen
        ? 'Push to the pull request'
        : 'Open pull request'
      : 'Approve merge';
  const working = publish ? 'Publishing…' : via === 'pr' ? 'Pushing…' : 'Merging…';

  const banner = variant === 'banner';
  return (
    <article
      aria-label={banner ? title : `${project.name}: ${approval.summary}`}
      className={
        banner
          ? 'mt-5 rounded-2xl border border-accent/35 bg-accent-soft/60 px-5 py-4'
          : 'rounded-2xl border border-line bg-panel p-5 shadow-card'
      }
    >
      <div className="flex items-start gap-3.5">
        <div
          className={`grid size-9 shrink-0 place-items-center rounded-xl ${banner ? 'bg-accent text-white' : 'bg-accent-soft text-accent'}`}
        >
          <Icon className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="truncate text-[14.5px] font-semibold">
              {banner ? title : project.name}
            </h2>
            {!banner && (
              <span className="shrink-0 text-[12px] text-faint">
                {relative(approval.createdAt, 'past')}
              </span>
            )}
          </div>
          {!banner && <p className="text-[13px] font-medium">{title}</p>}
          <p className="mt-0.5 text-[13px] text-muted">{what}</p>
          {command && (
            <code className="selectable mt-2 block rounded-lg bg-sunken px-2.5 py-1.5 font-mono text-[12px]">
              {command}
            </code>
          )}
          {!publish && canPr && !prOpen && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Segmented
                size="sm"
                label="How to finish"
                value={via}
                onChange={setVia}
                options={[
                  { value: 'merge', label: 'Merge here' },
                  { value: 'pr', label: 'Open a pull request' },
                ]}
              />
              {via === 'pr' && (
                <label className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
                  <input
                    type="checkbox"
                    checked={draft}
                    onChange={(e) => setDraft(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  Draft
                </label>
              )}
            </div>
          )}
          {tasks.length > 0 && (
            <ul className={`mt-3 flex ${banner ? 'flex-wrap gap-1.5' : 'flex-col gap-1'}`}>
              {tasks.map((t) =>
                banner ? (
                  <li
                    key={t}
                    className="rounded-full bg-panel px-2.5 py-0.5 text-[12px] text-muted"
                  >
                    {t}
                  </li>
                ) : (
                  <li key={t} className="flex items-center gap-2 text-[13px]">
                    <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-hidden /> {t}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </div>
      <div
        className={`mt-4 flex items-center gap-2 ${banner ? '' : 'border-t border-line pt-3.5'}`}
      >
        {!banner && (
          <button
            type="button"
            onClick={() => open({ name: 'projects', projectId: project.id })}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-ink hover:underline"
          >
            Review the work <ArrowRight className="size-3.5" />
          </button>
        )}
        {running && !publish && (
          <span className="text-[12px] text-warn">Stop the project first</span>
        )}
        <span className="ml-auto flex gap-2">
          <Button onClick={() => void act('rejected')} disabled={busy !== null}>
            {busy === 'rejected' ? 'Declining…' : banner ? 'Not now' : 'Decline'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void act('approved')}
            disabled={busy !== null || (running && !publish)}
          >
            <Icon className="size-3.5" /> {busy === 'approved' ? working : primary}
          </Button>
        </span>
      </div>
    </article>
  );
}
