import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitPullRequest,
  Hourglass,
  Pencil,
  Plus,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import type {
  Approval,
  Permissions,
  Project,
  ProjectDecision,
  RetryStrategy,
  AskPolicy,
  Routing,
  Task,
} from '@conclave/shared';
import type { PullRequestStatus } from '@conclave/core';
import type { LimitNotice, PermissionGaps, ProviderProblem } from '../../../shared/api';
import { Dialog } from './Dialog';
import { QuestionCard } from './QuestionCard';
import { Button, GitHubMark, ProviderDot, Thinking } from './bits';
import {
  ASK_POLICIES,
  Field,
  AdaptiveTeam,
  GapNotes,
  PermissionPicker,
  STRATEGIES,
  Segmented,
  TeamEditor,
  inputClass,
  textareaClass,
  TestCommandField,
} from './form';
import { relative } from './PlanUsage';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/projects';
import { errorText, providerName, readyProviders, useApp } from '@/lib/store';
import { settle } from '@/lib/settle';

/* ── Needs you ───────────────────────────────────────────────────────── */

export function NeedsYou({ questions, tasks }: { questions: Approval[]; tasks: Task[] }) {
  if (!questions.length) return null;
  return (
    <section aria-label="Needs you" className="mt-5">
      <h2 className="mb-2 flex items-baseline gap-2">
        <span className="text-[11.5px] font-semibold tracking-wide text-warn uppercase">
          Needs you · {questions.length}
        </span>
        <span className="text-[12px] text-faint">
          Other work goes on; the project carries on by itself once you answer.
        </span>
      </h2>
      <ul className="flex flex-col gap-2.5">
        {questions.map((q) => {
          const title = q.taskId ? tasks.find((t) => t.id === q.taskId)?.title : undefined;
          return (
            <li key={q.id}>
              <QuestionCard approval={q} compact {...(title && { taskTitle: title })} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ── One AI causing trouble ──────────────────────────────────────────── */

export function ProblemBanner({
  project,
  problems,
  onChangeTeam,
}: {
  project: Project;
  problems: ProviderProblem[];
  onChangeTeam: () => void;
}) {
  const retryFailed = useProjects((s) => s.retryFailed);
  const providers = useApp((s) => s.providers);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const shown = problems.filter((p) => !dismissed.includes(`${p.provider}:${p.kind}`));
  if (!shown.length) return null;
  return (
    <>
      {shown.map((p) => {
        const other = readyProviders(providers).find((r) => r.provider !== p.provider);
        const n = p.taskIds.length;
        return (
          <section
            key={`${p.provider}:${p.kind}`}
            aria-label={`${providerName(p.provider)} problem`}
            className="mt-5 flex items-start gap-3.5 rounded-2xl border border-danger/30 bg-danger-soft/50 px-5 py-3.5"
          >
            <AlertTriangle className="mt-0.5 size-4.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-[13.5px] font-semibold">
                {providerName(p.provider)} caused {n} failed task{n === 1 ? '' : 's'}
              </h2>
              <p className="selectable mt-0.5 text-[12.5px] text-muted">{p.summary}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {other && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    await retryFailed(
                      project.id,
                      { provider: p.provider, kind: p.kind },
                      { seat: { provider: other.provider } },
                    );
                    setBusy(false);
                  }}
                >
                  <ProviderDot provider={other.provider} size={7} /> Retry all {n} with{' '}
                  {providerName(other.provider)}
                </Button>
              )}
              <Button size="sm" onClick={onChangeTeam}>
                Change team
              </Button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setDismissed((d) => [...d, `${p.provider}:${p.kind}`])}
                className="grid size-7 place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}

/* ── An AI out of usage ──────────────────────────────────────────────── */

/**
 * A limit never fails a task (the work moves to the next AI), so this banner is how you learn
 * one of the team is out, and can take it off the team until its plan resets.
 */
export function LimitBanner({ project, limits }: { project: Project; limits: LimitNotice[] }) {
  const update = useProjects((s) => s.update);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const shown = limits.filter((l) => !dismissed.includes(`${l.provider}:${l.at}`));
  if (!shown.length) return null;
  return (
    <>
      {shown.map((l) => {
        const others = (role: keyof Routing) =>
          project.routing[role].filter((s) => s.provider !== l.provider);
        const next = others('builder')[0];
        const canRemove = (['planner', 'builder', 'reviewer'] as const).every(
          (r) => others(r).length > 0,
        );
        return (
          <section
            key={`${l.provider}:${l.at}`}
            aria-label={`${providerName(l.provider)} is out of usage`}
            className="mt-5 flex items-start gap-3.5 rounded-2xl border border-warn/35 bg-warn-soft/50 px-5 py-3.5"
          >
            <Hourglass className="mt-0.5 size-4.5 shrink-0 text-warn" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-[13.5px] font-semibold">
                {providerName(l.provider)} is out of usage
                <span className="font-normal text-faint"> · since {relative(l.at, 'past')}</span>
              </h2>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {next
                  ? `Its work goes to ${providerName(next.provider)}; no attempts are used.`
                  : 'Its work waits until it has usage again; no attempts are used.'}
              </p>
              <p className="selectable mt-1 text-[12px] text-faint">“{l.message}”</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canRemove && (
                <Button
                  size="sm"
                  onClick={() =>
                    settle(
                      update(project.id, {
                        routing: {
                          planner: others('planner'),
                          builder: others('builder'),
                          reviewer: others('reviewer'),
                        },
                      }),
                    )
                  }
                >
                  Remove {providerName(l.provider)} from the team
                </Button>
              )}
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setDismissed((d) => [...d, `${l.provider}:${l.at}`])}
                className="grid size-7 place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </section>
        );
      })}
    </>
  );
}

/* ── Draft ───────────────────────────────────────────────────────────── */

export function DraftBanner({ project }: { project: Project }) {
  const load = useProjects((s) => s.load);
  const refresh = useProjects((s) => s.refresh);
  const toast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  return (
    <section className="mt-5 flex items-center gap-3.5 rounded-2xl border border-line bg-panel px-5 py-3.5 shadow-card">
      <CircleDashed className="size-4.5 shrink-0 text-muted" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] text-muted">
        <span className="font-medium text-ink">Setup isn't finished.</span> The questions were never
        answered. Finish now and the planner plans the work as usual.
      </p>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api().projects.startDraft(project.id, { answers: [], tasks: [] });
            await Promise.all([refresh(), load(project.id)]);
          } catch (err) {
            toast('error', errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        Finish setup
      </Button>
    </section>
  );
}

/* ── Pull request ────────────────────────────────────────────────────── */

export function PullRequestCard({ project }: { project: Project }) {
  const link = project.github;
  const toast = useApp((s) => s.showToast);
  const load = useProjects((s) => s.load);
  const [status, setStatus] = useState<PullRequestStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);

  useEffect(() => {
    if (!link?.prUrl) return;
    let live = true;
    const poll = () =>
      void api()
        .github.prStatus(project.id)
        .then((s) => {
          if (!live) return;
          setStatus(s);
          setError(null);
        })
        .catch((err: unknown) => live && setError(errorText(err)));
    poll();
    // Polled while the project is on screen, like the plan says: once a minute.
    const t = window.setInterval(poll, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [project.id, link?.prUrl]);

  if (!link?.prUrl) return null;
  const state = status?.pr.state ?? (link.prState === 'merged' ? 'MERGED' : 'OPEN');
  const merged = state === 'MERGED';
  return (
    <section
      aria-label="Pull request"
      className="mt-5 rounded-2xl border border-line bg-panel px-5 py-3.5 shadow-card"
    >
      <div className="flex items-center gap-3">
        <GitPullRequest
          className={`size-4.5 shrink-0 ${merged ? 'text-accent' : state === 'CLOSED' ? 'text-faint' : 'text-ok'}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-[13.5px] font-semibold">
            {merged
              ? 'Merged on GitHub'
              : state === 'CLOSED'
                ? 'Pull request closed'
                : status?.pr.isDraft
                  ? 'Draft pull request'
                  : 'Pull request open'}
          </h2>
          <p className="truncate font-mono text-[12px] text-faint">
            {link.repo} · {link.prBranch}
          </p>
        </div>
        <Button size="sm" onClick={() => settle(api().openExternal(link.prUrl!))}>
          <ExternalLink className="size-3.5" /> Open on GitHub
        </Button>
      </div>
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
      {!status && !error && (
        <div className="mt-2">
          <Thinking label="Checking CI" />
        </div>
      )}
      {status && status.checks.length > 0 && !merged && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2.5">
          {status.checks.map((c) => (
            <li
              key={`${c.workflow}:${c.name}:${c.event ?? ''}`}
              className="flex items-center gap-2 text-[12.5px]"
            >
              {c.bucket === 'pass' ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-label="Passed" />
              ) : c.bucket === 'fail' ? (
                <XCircle className="size-3.5 shrink-0 text-danger" aria-label="Failed" />
              ) : (
                <Hourglass className="size-3.5 shrink-0 text-faint" aria-label={c.bucket} />
              )}
              <span className="min-w-0 flex-1 truncate">
                {c.bucket === 'fail' ? `CI failed: ${c.name}` : c.name}
                {status.checks.filter((o) => o.name === c.name).length > 1 && c.event && (
                  <span className="text-faint">
                    {' '}
                    · {c.event === 'pull_request' ? 'pull request' : c.event}
                  </span>
                )}
              </span>
              {c.bucket === 'fail' && (
                <Button
                  size="sm"
                  disabled={fixing !== null}
                  onClick={async () => {
                    setFixing(c.name);
                    try {
                      await api().github.fixCheck(project.id, c);
                      toast('info', 'A fix is queued. Resume the project to build it.');
                      await load(project.id);
                    } catch (err) {
                      toast('error', errorText(err));
                    } finally {
                      setFixing(null);
                    }
                  }}
                >
                  <Wrench className="size-3.5" /> {fixing === c.name ? 'Queuing…' : 'Fix it'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Decisions ───────────────────────────────────────────────────────── */

export function DecisionsPanel({
  project,
  decisions,
}: {
  project: Project;
  decisions: ProjectDecision[];
}) {
  const keep = useProjects((s) => s.keepDecision);
  const change = useProjects((s) => s.changeDecision);
  const add = useProjects((s) => s.addDecision);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [addTask, setAddTask] = useState(true);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const active = decisions.filter((d) => d.status === 'active');
  const groups = [
    { title: 'Decisions', items: active.filter((d) => d.kind === 'decision') },
    { title: 'Assumptions', items: active.filter((d) => d.kind === 'assumption') },
  ];
  const overturned = decisions.filter((d) => d.status === 'overturned');

  return (
    <div className="px-3 py-3">
      {active.length === 0 && !adding && (
        <p className="px-1 py-6 text-center text-[13px] text-muted">
          Nothing decided yet. Answers to questions and the agents' assumptions land here, and every
          agent follows them.
        </p>
      )}
      {groups.map(
        (g) =>
          g.items.length > 0 && (
            <div key={g.title} className="mb-4">
              <h3 className="px-1 pb-1.5 text-[11.5px] font-semibold tracking-wide text-faint uppercase">
                {g.title} <span className="font-normal">· {g.items.length}</span>
              </h3>
              <ul className="flex flex-col gap-1.5">
                {g.items.map((d) => (
                  <li key={d.id} className="rounded-xl border border-line px-3 py-2.5">
                    <div className="text-[12px] text-faint">{d.question}</div>
                    {editing === d.id ? (
                      <div className="mt-1.5">
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          aria-label={`New answer: ${d.question}`}
                          className={`${inputClass} h-8.5`}
                        />
                        <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted">
                          <input
                            type="checkbox"
                            checked={addTask}
                            onChange={(e) => setAddTask(e.target.checked)}
                          />
                          Add a task to apply this
                        </label>
                        <div className="mt-2 flex justify-end gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!draft.trim() || draft.trim() === d.answer}
                            onClick={() => {
                              setEditing(null);
                              settle(change(project.id, d.id, draft.trim(), addTask));
                            }}
                          >
                            Change
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <span className="selectable min-w-0 flex-1 text-[13px] font-medium">
                          {d.answer}
                        </span>
                        {d.kind === 'assumption' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => settle(keep(project.id, d.id))}
                          >
                            Keep
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Change: ${d.question}`}
                          onClick={() => {
                            setEditing(d.id);
                            setDraft(d.answer);
                            setAddTask(true);
                          }}
                        >
                          <Pencil className="size-3" /> Change…
                        </Button>
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                      {d.provider && <ProviderDot provider={d.provider} size={5} />}
                      {sourceText(d)} · {relative(d.updatedAt, 'past')}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ),
      )}
      {adding ? (
        <div className="rounded-xl border border-line px-3 py-2.5">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Topic, e.g. Framework"
            aria-label="Decision topic"
            className={`${inputClass} h-8.5`}
          />
          <input
            value={a}
            onChange={(e) => setA(e.target.value)}
            placeholder="Decision, e.g. Plain HTML, no build step"
            aria-label="Decision"
            className={`${inputClass} mt-1.5 h-8.5`}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!q.trim() || !a.trim()}
              onClick={() => {
                settle(add(project.id, q.trim(), a.trim()));
                setAdding(false);
                setQ('');
                setA('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 px-1 text-[12.5px] font-medium text-accent-ink hover:underline"
        >
          <Plus className="size-3.5" /> Add a decision
        </button>
      )}
      {overturned.length > 0 && (
        <details className="mt-4 px-1 text-[12px] text-faint">
          <summary className="cursor-pointer">Changed earlier · {overturned.length}</summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {overturned.map((d) => (
              <li key={d.id}>
                <span className="line-through">
                  {d.question}: {d.answer}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function sourceText(d: ProjectDecision): string {
  switch (d.source) {
    case 'you':
      return 'You';
    case 'clarify':
      return 'Before the start';
    case 'council':
      return 'The council';
    case 'agent':
      return d.provider ? `${providerName(d.provider)} assumed` : 'Assumed';
  }
}

/* ── Settings ────────────────────────────────────────────────────────── */

export function ProjectSettingsDialog({
  project,
  web,
  open,
  onClose,
}: {
  project: Project;
  /** A web project: show the screenshot settings. */
  web: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const update = useProjects((s) => s.update);
  const [goal, setGoal] = useState(project.goal);
  const [test, setTest] = useState(project.testCommand ?? '');
  const [doneWhen, setDoneWhen] = useState(project.doneWhen ?? '');
  const [design, setDesign] = useState(project.designDirection ?? '');
  const [routing, setRouting] = useState<Routing>(project.routing);
  const [attempts, setAttempts] = useState(project.maxAttempts);
  const [parallel, setParallel] = useState(project.maxParallel);
  const [adaptive, setAdaptive] = useState(project.adaptiveTeam);
  const [strategy, setStrategy] = useState<RetryStrategy>(project.retryStrategy);
  const [askPolicy, setAskPolicy] = useState<AskPolicy>(project.askPolicy);
  const [permissions, setPermissions] = useState<Permissions>(project.permissions);
  const [visual, setVisual] = useState(project.visualReview);
  const [reviewEffort, setReviewEffort] = useState(project.reviewEffort);
  const [pages, setPages] = useState(project.pages.join(' '));
  const [gaps, setGaps] = useState<PermissionGaps>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGoal(project.goal);
    setTest(project.testCommand ?? '');
    setDoneWhen(project.doneWhen ?? '');
    setDesign(project.designDirection ?? '');
    setRouting(project.routing);
    setAttempts(project.maxAttempts);
    setParallel(project.maxParallel);
    setAdaptive(project.adaptiveTeam);
    setStrategy(project.retryStrategy);
    setAskPolicy(project.askPolicy);
    setPermissions(project.permissions);
    setVisual(project.visualReview);
    setReviewEffort(project.reviewEffort);
    setPages(project.pages.join(' '));
  }, [open]);
  const pageList = pages.split(/[\s,]+/).filter(Boolean);
  const badPage = pageList.find((p) => !p.startsWith('/'));

  const missing = (['planner', 'builder', 'reviewer'] as const).find((r) => !routing[r].length);
  const save = async () => {
    if (missing || !goal.trim() || badPage) return;
    setSaving(true);
    const ok = await update(project.id, {
      goal: goal.trim(),
      testCommand: test.trim() || null,
      doneWhen: doneWhen.trim() || null,
      designDirection: design.trim() || null,
      routing,
      maxAttempts: attempts,
      maxParallel: parallel,
      adaptiveTeam: adaptive,
      retryStrategy: strategy,
      askPolicy,
      permissions,
      reviewEffort,
      ...(web && { visualReview: visual, pages: pageList.length ? pageList : ['/'] }),
    });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Project settings"
      description="Changes apply from the next step; a step already running finishes as it started."
      width={800}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={saving || Boolean(missing) || !goal.trim() || Boolean(badPage)}
            onClick={() => settle(save())}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Goal">
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            aria-label="Goal"
            className={textareaClass}
          />
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <TestCommandField
            value={test}
            onChange={setTest}
            folder={project.repoPath}
            placeholder={project.proposedTestCommand ?? 'npm test'}
          />
          <Field label="Done when" optional>
            <input
              value={doneWhen}
              onChange={(e) => setDoneWhen(e.target.value)}
              aria-label="Done when"
              className={inputClass}
            />
          </Field>
          <Field label="Design direction" optional>
            <input
              value={design}
              onChange={(e) => setDesign(e.target.value)}
              aria-label="Design direction"
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Team" error={missing ? `Pick at least one AI for every job` : undefined}>
          <TeamEditor routing={routing} onChange={setRouting} gaps={gaps} />
          <GapNotes routing={routing} gaps={gaps} />
          <AdaptiveTeam routing={routing} value={adaptive} onChange={setAdaptive} />
        </Field>
        <Field label="Permissions">
          <PermissionPicker
            value={permissions}
            onChange={setPermissions}
            projectName={project.name}
            onGaps={setGaps}
          />
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Agents need a decision">
            <Segmented
              size="sm"
              label="When agents need a decision"
              value={askPolicy}
              onChange={setAskPolicy}
              options={ASK_POLICIES.map((p) => ({ value: p.value, label: p.label.split(' ')[0]! }))}
            />
            <p className="mt-1.5 text-[11.5px] text-faint">
              {ASK_POLICIES.find((p) => p.value === askPolicy)?.hint}
            </p>
          </Field>
          <Field label="Attempts per task">
            <Segmented
              size="sm"
              label="Attempts per task"
              value={attempts}
              onChange={setAttempts}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))}
            />
          </Field>
          <Field label="Retries">
            <Segmented
              size="sm"
              label="Retry strategy"
              value={strategy}
              onChange={setStrategy}
              options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Parallel tasks"
            hint="Independent tasks build at once, each AI within its lane cap. Merges stay one at a time and are re-tested. Applies the next time the project starts."
          >
            <Segmented
              size="sm"
              label="Parallel tasks"
              value={parallel}
              onChange={setParallel}
              options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
            />
          </Field>
          <Field
            label="Review effort"
            hint={
              reviewEffort === 'light'
                ? 'Reviewers think at their lightest level, or use their fast model: quicker, and lighter on your plan.'
                : 'Reviewers run at the model and effort set in the team.'
            }
          >
            <Segmented
              size="sm"
              label="Review effort"
              value={reviewEffort}
              onChange={setReviewEffort}
              options={[
                { value: 'same' as const, label: 'As in the team' },
                { value: 'light' as const, label: 'Light' },
              ]}
            />
          </Field>
        </div>
        {web && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Screenshots">
              <label className="flex items-start gap-2.5 rounded-xl border border-line px-3 py-2.5 text-[12.5px]">
                <input
                  type="checkbox"
                  checked={visual}
                  onChange={(e) => setVisual(e.target.checked)}
                  aria-label="Visual review"
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span>
                  <span className="font-medium">Visual review</span>
                  <span className="block text-[11.5px] text-faint">
                    A reviewer that can see also looks at up to four screenshots of each change.
                    About 1 to 3% more tokens per task. Screenshots and the free checks (contrast,
                    touch targets, overflow, console errors) run either way.
                  </span>
                </span>
              </label>
            </Field>
            <Field
              label="Pages to check"
              hint="Up to five paths, separated by spaces. Each is shot at desktop and phone width, light and dark."
              error={badPage ? `Paths start with "/": ${badPage}` : undefined}
            >
              <input
                value={pages}
                onChange={(e) => setPages(e.target.value)}
                placeholder="/"
                aria-label="Pages to check"
                spellCheck={false}
                className={`${inputClass} font-mono text-[12.5px]`}
              />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ── Publish ─────────────────────────────────────────────────────────── */

export function PublishDialog({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const load = useProjects((s) => s.load);
  const refreshApprovals = useProjects((s) => s.refreshApprovals);
  const toast = useApp((s) => s.showToast);
  const [name, setName] = useState(slug(project.name));
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const valid = /^[\w.-]+$/.test(name);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish to GitHub"
      description="Creates a new repository from this project and pushes its current branch. It waits in the Inbox for your approval first."
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true);
              try {
                await api().github.publish(project.id, { name, private: isPrivate });
                await Promise.all([load(project.id), refreshApprovals()]);
                onClose();
              } catch (err) {
                toast('error', errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <GitHubMark className="size-3.5" /> Ask for approval
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Repository name" error={valid ? undefined : 'Letters, numbers, . - _ only'}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Repository name"
            spellCheck={false}
            className={`${inputClass} font-mono text-[12.5px]`}
          />
        </Field>
        <Field label="Visibility">
          <Segmented
            label="Visibility"
            value={isPrivate ? 'private' : 'public'}
            onChange={(v) => setPrivate(v === 'private')}
            options={[
              { value: 'private', label: 'Private' },
              { value: 'public', label: 'Public' },
            ]}
          />
        </Field>
        <code className="rounded-lg bg-sunken px-3 py-2 font-mono text-[12px] text-muted">
          gh repo create {name || '…'} {isPrivate ? '--private' : '--public'} --source . --remote
          origin --push
        </code>
      </div>
    </Dialog>
  );
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}
