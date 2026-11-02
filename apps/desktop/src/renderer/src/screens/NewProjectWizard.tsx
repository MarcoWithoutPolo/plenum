import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Lock,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_PERMISSIONS,
  type AskPolicy,
  type Permissions,
  type RetryStrategy,
  type Routing,
} from '@conclave/shared';
import type { ClarifyResult, FolderState, GhIssue, GhRepo, GitHubStatus } from '@conclave/core';
import type { PermissionGaps } from '../../../shared/api';
import { Dialog } from '@/components/Dialog';
import { Button, GitHubMark, Thinking } from '@/components/bits';
import {
  ASK_POLICIES,
  Field,
  AdaptiveTeam,
  GapNotes,
  PermissionPicker,
  ROLES,
  STRATEGIES,
  Segmented,
  TeamEditor,
  defaultRouting,
  inputClass,
  textareaClass,
  TestCommandField,
} from '@/components/form';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/projects';
import { errorText, readyProviders, useApp } from '@/lib/store';

type Step = 'where' | 'what' | 'clarify';
type Source = 'folder' | 'new' | 'clone';

interface Draft {
  title: string;
  spec: string;
  open?: boolean;
}

interface Answer {
  answer: string;
  assumed?: boolean;
  own?: boolean;
}

const STEPS: { key: Step; label: string }[] = [
  { key: 'where', label: 'Where' },
  { key: 'what', label: 'What' },
  { key: 'clarify', label: 'Clarify' },
];

/**
 * New project in three steps. Where: a folder, a new folder, or a GitHub clone, with git set
 * up on the spot. What: goal, team and rules. Clarify: one planner pass asks what only you
 * can decide and drafts the plan. Closing by accident keeps everything until you finish.
 */
export function NewProjectWizard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: (createdId?: string) => void;
}) {
  const providers = useApp((s) => s.providers);
  const toast = useApp((s) => s.showToast);
  const refresh = useProjects((s) => s.refresh);
  const load = useProjects((s) => s.load);
  const startProject = useProjects((s) => s.start);
  const ready = readyProviders(providers);

  const [step, setStep] = useState<Step>('where');
  const [busy, setBusy] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Where
  const [source, setSource] = useState<Source>('folder');
  const [folder, setFolder] = useState<FolderState | null>(null);
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [newName, setNewName] = useState('');
  const [parent, setParent] = useState('');
  const [gh, setGh] = useState<GitHubStatus | null>(null);
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState<string | null>(null);
  const [issues, setIssues] = useState<GhIssue[]>([]);
  const [issue, setIssue] = useState<GhIssue | null>(null);

  // What
  const [goal, setGoal] = useState('');
  const [design, setDesign] = useState('');
  const [showDesign, setShowDesign] = useState(false);
  const [test, setTest] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [routing, setRouting] = useState<Routing>({ planner: [], builder: [], reviewer: [] });
  const [attempts, setAttempts] = useState(3);
  const [parallel, setParallel] = useState(2);
  const [adaptive, setAdaptive] = useState(true);
  const [askPolicy, setAskPolicy] = useState<AskPolicy>('ask');
  const [strategy, setStrategy] = useState<RetryStrategy>('escalate');
  const [permissions, setPermissions] = useState<Permissions>(DEFAULT_PERMISSIONS);
  const [gaps, setGaps] = useState<PermissionGaps>({});

  // Clarify
  const [projectId, setProjectId] = useState<string | null>(null);
  const [clarify, setClarify] = useState<ClarifyResult | null>(null);
  const [clarifyError, setClarifyError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [plan, setPlan] = useState<Draft[]>([]);
  const [useTest, setUseTest] = useState(true);
  const [skipped, setSkipped] = useState(false);
  /** The answers the current draft plan was made with. */
  const [plannedWith, setPlannedWith] = useState('');
  const skippedNow = useRef(false);

  const reset = () => {
    setStep('where');
    setTouched(false);
    setSource('folder');
    setFolder(null);
    setConfirmLarge(false);
    setNewName('');
    setRepo(null);
    setIssue(null);
    setIssues([]);
    setGoal('');
    setDesign('');
    setShowDesign(false);
    setTest('');
    setDoneWhen('');
    setAttempts(3);
    setParallel(2);
    setAdaptive(true);
    setAskPolicy('ask');
    setStrategy('escalate');
    setPermissions(DEFAULT_PERMISSIONS);
    setProjectId(null);
    setClarify(null);
    setClarifyError(null);
    setAnswers({});
    setPlan([]);
    setUseTest(true);
    setSkipped(false);
    setRouting(defaultRouting(ready));
  };

  useEffect(() => {
    if (!open) return;
    if (!parent) void api().projects.defaultFolder().then(setParent);
    // A fresh wizard gets the current team; one closed by accident keeps its choices.
    if (routing.planner.length + routing.builder.length + routing.reviewer.length === 0) {
      setRouting(defaultRouting(ready));
    }
  }, [open]);

  useEffect(() => {
    if (source !== 'clone' || gh) return;
    void api()
      .github.status()
      .then((s) => {
        setGh(s);
        if (s.signedIn) void api().github.repos().then(setRepos);
      })
      .catch(() => setGh({ installed: false, signedIn: false, detail: 'gh did not start' }));
  }, [source, gh]);

  const readyFolder = folder?.kind === 'ready' ? folder : null;
  const projectName = readyFolder?.name ?? newName;

  /* ── Where ── */

  const inspect = async (path: string) => {
    setBusy('inspect');
    try {
      const state = await api().projects.inspectFolder(path);
      setFolder(state);
      setConfirmLarge(false);
      if (state.kind === 'ready' && state.suggestedTest && !test) setTest(state.suggestedTest);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const choose = async () => {
    const path = await api().projects.pickRepo();
    if (path) await inspect(path);
  };

  const setUpGit = async () => {
    if (!folder || folder.kind === 'missing' || folder.kind === 'ready') return;
    setBusy('git');
    try {
      const done = await api().projects.setUpGit(
        folder.kind === 'nested' ? folder.root : folder.path,
        confirmLarge,
      );
      await inspect(done.root);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const createFolder = async (): Promise<boolean> => {
    setBusy('create');
    try {
      const path = await api().projects.createFolder(newName.trim(), parent || undefined);
      await api().projects.setUpGit(path);
      await inspect(path);
      return true;
    } catch (err) {
      toast('error', errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const cloneRepo = async (): Promise<boolean> => {
    if (!repo) return false;
    setBusy('clone');
    try {
      const path = await api().github.clone(repo, parent || undefined);
      await inspect(path);
      void api()
        .github.issues(path)
        .then(setIssues)
        .catch(() => setIssues([]));
      return true;
    } catch (err) {
      toast('error', errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const nextFromWhere = async () => {
    setTouched(true);
    if (source === 'new' && !readyFolder) {
      if (!newName.trim()) return;
      if (!(await createFolder())) return;
    } else if (source === 'clone' && !readyFolder) {
      if (!(await cloneRepo())) return;
    } else if (!readyFolder) {
      return;
    }
    setTouched(false);
    setStep('what');
  };

  /* ── What ── */

  const missingRole = ROLES.find((r) => routing[r.key].length === 0);
  const noBuilder = routing.builder.length > 0 && routing.builder.every((s) => gaps[s.provider]);

  const nextFromWhat = async () => {
    setTouched(true);
    if (!readyFolder || !goal.trim() || missingRole || noBuilder) return;
    setTouched(false);
    setBusy('save');
    try {
      let id = projectId;
      if (!id) {
        const project = await api().projects.create({
          repoPath: readyFolder.root,
          goal: goal.trim(),
          ...(doneWhen.trim() && { doneWhen: doneWhen.trim() }),
          ...(test.trim() && { testCommand: test.trim() }),
          ...(design.trim() && { designDirection: design.trim() }),
          routing,
          maxAttempts: attempts,
          maxParallel: parallel,
          adaptiveTeam: adaptive,
          askPolicy,
          retryStrategy: strategy,
          permissions,
          draft: true,
          ...(issue &&
            repo && {
              github: {
                repo,
                prBranch: null,
                prUrl: null,
                prState: null,
                issue: { number: issue.number, title: issue.title, url: issue.url },
              },
            }),
        });
        id = project.id;
        setProjectId(id);
      } else {
        await api().projects.update(id, {
          goal: goal.trim(),
          doneWhen: doneWhen.trim() || null,
          testCommand: test.trim() || null,
          designDirection: design.trim() || null,
          routing,
          maxAttempts: attempts,
          maxParallel: parallel,
          adaptiveTeam: adaptive,
          askPolicy,
          retryStrategy: strategy,
          permissions,
        });
      }
      setStep('clarify');
      void runClarify(id);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const runClarify = async (id: string) => {
    setClarify(null);
    setClarifyError(null);
    setSkipped(false);
    skippedNow.current = false;
    try {
      const result = await api().projects.clarify(id);
      if (skippedNow.current) return;
      setClarify(result);
      setPlan(result.tasks.map((t) => ({ ...t })));
      const initial: Record<string, Answer> = Object.fromEntries(
        result.questions.flatMap((q) => (q.recommended ? [[q.id, { answer: q.recommended }]] : [])),
      );
      setAnswers(initial);
      setPlannedWith(answerKey(result.questions, initial));
    } catch (err) {
      setClarifyError(errorText(err));
    }
  };

  /** The answers as the planner would read them. */
  const answerList = (questions: ClarifyResult['questions'], given: Record<string, Answer>) =>
    questions.flatMap((q) => {
      const a = given[q.id]?.answer.trim();
      return a ? [{ question: q.question, answer: a }] : [];
    });
  const answerKey = (questions: ClarifyResult['questions'], given: Record<string, Answer>) =>
    JSON.stringify(answerList(questions, given));

  /** "Re-plan with my answers": the draft plan redone around what you picked. */
  const replan = async () => {
    if (!projectId || !clarify) return;
    setBusy('replan');
    try {
      const result = await api().projects.clarify(
        projectId,
        answerList(clarify.questions, answers),
      );
      setPlan(result.tasks.map((t) => ({ ...t })));
      setPlannedWith(answerKey(clarify.questions, answers));
      if (result.testCommand) setClarify({ ...clarify, testCommand: result.testCommand });
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const answersChanged =
    clarify !== null &&
    clarify.questions.length > 0 &&
    answerKey(clarify.questions, answers) !== plannedWith;

  /* ── Start ── */

  const finish = async (andStart: boolean) => {
    if (!projectId) return;
    setBusy(andStart ? 'start' : 'saveonly');
    try {
      const questions = clarify?.questions ?? [];
      await api().projects.startDraft(projectId, {
        answers: questions.flatMap((q) => {
          const a = answers[q.id];
          return a?.answer.trim()
            ? [
                {
                  question: q.question,
                  answer: a.answer.trim(),
                  ...(a.assumed && { assumed: true }),
                },
              ]
            : [];
        }),
        tasks: plan.filter((t) => t.title.trim() && t.spec.trim()),
        testCommand: useTest ? (clarify?.testCommand ?? null) : null,
      });
      await Promise.all([refresh(), load(projectId)]);
      if (andStart) void startProject(projectId);
      const id = projectId;
      reset();
      onClose(id);
    } catch (err) {
      toast('error', errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const index = STEPS.findIndex((s) => s.key === step);
  const footer =
    step === 'where' ? (
      <>
        <span className="mr-auto text-[12px] text-faint">
          Your branch and files are never touched until you approve.
        </span>
        <Button variant="primary" onClick={() => void nextFromWhere()} disabled={busy !== null}>
          {busy === 'create'
            ? 'Creating…'
            : busy === 'clone'
              ? 'Cloning…'
              : source === 'new' && !readyFolder
                ? 'Create folder and continue'
                : source === 'clone' && !readyFolder
                  ? 'Clone and continue'
                  : 'Next'}
        </Button>
      </>
    ) : step === 'what' ? (
      <>
        <Button onClick={() => setStep('where')} disabled={busy !== null || projectId !== null}>
          Back
        </Button>
        <span className="mr-auto" />
        <Button variant="primary" onClick={() => void nextFromWhat()} disabled={busy !== null}>
          {busy === 'save' ? 'Saving…' : 'Next'}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={() => setStep('what')} disabled={busy !== null}>
          Back
        </Button>
        <span className="mr-auto" />
        <Button onClick={() => void finish(false)} disabled={busy !== null}>
          {busy === 'saveonly' ? 'Saving…' : 'Save without starting'}
        </Button>
        <Button variant="primary" onClick={() => void finish(true)} disabled={busy !== null}>
          {busy === 'start' ? 'Starting…' : 'Start'}
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={() => onClose()}
      title="New project"
      description="Conclave plans, builds, tests and reviews on its own, on a separate branch."
      width={760}
      footer={footer}
    >
      <ol aria-label="Steps" className="mb-5 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-line-strong" aria-hidden />}
            <span
              aria-current={s.key === step ? 'step' : undefined}
              className={`inline-flex items-center gap-1.5 text-[12.5px] font-medium ${
                i === index ? 'text-ink' : i < index ? 'text-ok' : 'text-faint'
              }`}
            >
              <span
                className={`grid size-5 place-items-center rounded-full text-[11px] ${
                  i === index
                    ? 'bg-accent text-white'
                    : i < index
                      ? 'bg-ok-soft text-ok'
                      : 'bg-sunken text-faint'
                }`}
              >
                {i < index ? <Check className="size-3" /> : i + 1}
              </span>
              {s.label}
            </span>
          </li>
        ))}
      </ol>

      {step === 'where' && (
        <section aria-labelledby="where-heading" className="flex flex-col gap-4">
          <h3 id="where-heading" className="sr-only">
            Where the project lives
          </h3>
          <div role="radiogroup" aria-label="Where" className="grid grid-cols-3 gap-2.5">
            {(
              [
                {
                  key: 'folder',
                  icon: FolderGit2,
                  title: 'Use a folder',
                  text: 'A project you already have',
                },
                {
                  key: 'new',
                  icon: FolderPlus,
                  title: 'Create a new folder',
                  text: 'Start from nothing',
                },
                {
                  key: 'clone',
                  icon: GitHubMark,
                  title: 'Clone from GitHub',
                  text: 'One of your repositories',
                },
              ] as const
            ).map((o) => (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={source === o.key}
                onClick={() => {
                  setSource(o.key);
                  setFolder(null);
                  setTouched(false);
                }}
                className={`flex flex-col items-start gap-1.5 rounded-xl border px-3.5 py-3 text-left transition ${
                  source === o.key
                    ? 'border-accent bg-accent-soft/60'
                    : 'border-line hover:border-line-strong hover:bg-sunken/60'
                }`}
              >
                <o.icon className={`size-4.5 ${source === o.key ? 'text-accent' : 'text-muted'}`} />
                <span className="text-[13px] font-semibold">{o.title}</span>
                <span className="text-[12px] text-faint">{o.text}</span>
              </button>
            ))}
          </div>

          {source === 'folder' && (
            <Field
              label="Folder"
              error={touched && !readyFolder ? 'Choose a folder and set it up first' : undefined}
            >
              {folder ? (
                <FolderRow
                  folder={folder}
                  busy={busy}
                  confirmLarge={confirmLarge}
                  onConfirmLarge={setConfirmLarge}
                  onChange={() => void choose()}
                  onSetUp={() => void setUpGit()}
                  onUseRoot={(root) => void inspect(root)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void choose()}
                  disabled={busy !== null}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-5 text-[13px] font-medium text-muted transition hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent-ink"
                >
                  <FolderGit2 className="size-4" aria-hidden />
                  {busy === 'inspect' ? 'Checking…' : 'Choose a folder'}
                </button>
              )}
            </Field>
          )}

          {source === 'new' && (
            <div className="grid grid-cols-[1fr_1.3fr] gap-4">
              <Field
                label="Name"
                error={touched && !newName.trim() ? 'Name the folder' : undefined}
              >
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="calculator"
                  aria-label="Folder name"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field label="Location" hintBelow hint="Conclave makes the folder and sets up git.">
                <div className="flex items-center gap-2">
                  <input
                    value={parent}
                    onChange={(e) => setParent(e.target.value)}
                    aria-label="Location"
                    spellCheck={false}
                    className={`${inputClass} font-mono text-[12px]`}
                  />
                  <Button
                    onClick={async () => {
                      const p = await api().projects.pickRepo();
                      if (p) setParent(p);
                    }}
                  >
                    Change
                  </Button>
                </div>
              </Field>
              {readyFolder && (
                <div className="col-span-2">
                  <FolderRow folder={readyFolder} busy={busy} />
                </div>
              )}
            </div>
          )}

          {source === 'clone' && (
            <CloneList
              gh={gh}
              repos={repos}
              query={query}
              onQuery={setQuery}
              selected={repo}
              onSelect={(r) => {
                setRepo(r);
                setFolder(null);
              }}
              error={touched && !repo ? 'Pick a repository' : undefined}
              cloned={readyFolder}
              busy={busy}
            />
          )}
        </section>
      )}

      {step === 'what' && (
        <section aria-labelledby="what-heading" className="flex flex-col gap-5">
          <h3 id="what-heading" className="sr-only">
            What to build
          </h3>
          {issues.length > 0 && (
            <Field label="Start from an issue" optional>
              <div className="flex flex-wrap gap-1.5">
                {issues.slice(0, 8).map((i) => (
                  <button
                    key={i.number}
                    type="button"
                    aria-pressed={issue?.number === i.number}
                    onClick={() => {
                      setIssue(i);
                      setGoal(`${i.title}\n\n${i.body}`.trim());
                    }}
                    className={`inline-flex h-7.5 max-w-full items-center gap-1.5 truncate rounded-full border px-2.5 text-[12.5px] ${
                      issue?.number === i.number
                        ? 'border-accent bg-accent-soft text-accent-ink'
                        : 'border-line-strong hover:bg-sunken'
                    }`}
                  >
                    <span className="text-faint">#{i.number}</span> {i.title}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field
            label="Goal"
            hint="What should exist when it's done? Be specific."
            error={touched && !goal.trim() ? 'Describe the goal' : undefined}
          >
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={4}
              placeholder="A calculator website in plain HTML/CSS/JS with keyboard support and a playful animation on every press."
              aria-label="Goal"
              className={textareaClass}
            />
          </Field>

          <div>
            <button
              type="button"
              aria-expanded={showDesign}
              onClick={() => setShowDesign((v) => !v)}
              className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-muted hover:text-ink"
            >
              <ChevronDown
                className={`size-3.5 transition ${showDesign ? '' : '-rotate-90'}`}
                aria-hidden
              />
              Design direction <span className="font-normal text-faint">Optional</span>
            </button>
            {showDesign && (
              <input
                value={design}
                onChange={(e) => setDesign(e.target.value)}
                placeholder="playful, neon, arcade"
                aria-label="Design direction"
                className={`${inputClass} mt-1.5`}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <TestCommandField
              value={test}
              onChange={setTest}
              {...(folder?.kind === 'ready' && { folder: folder.root })}
              {...(folder?.kind === 'ready' &&
                folder.suggestedTestSource &&
                test === folder.suggestedTest && { source: folder.suggestedTestSource })}
            />
            <Field
              label="Done when"
              optional
              hintBelow
              hint="How the planner knows the goal is met."
            >
              <input
                value={doneWhen}
                onChange={(e) => setDoneWhen(e.target.value)}
                placeholder="All tests pass and the README documents it"
                aria-label="Done when"
                className={inputClass}
              />
            </Field>
          </div>

          <Field
            label="Team"
            hint="Who does each job, in order. If one is out of usage, the next takes over."
            error={
              touched && missingRole
                ? `Pick at least one AI that ${missingRole.label.toLowerCase()}`
                : undefined
            }
          >
            <TeamEditor routing={routing} onChange={setRouting} gaps={gaps} />
            <GapNotes routing={routing} gaps={gaps} />
            <AdaptiveTeam routing={routing} value={adaptive} onChange={setAdaptive} />
          </Field>

          <Field label="Permissions" hint="What builders may do. Planners and reviewers only read.">
            <PermissionPicker
              value={permissions}
              onChange={setPermissions}
              projectName={projectName}
              onGaps={setGaps}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="When agents need a decision">
              <Segmented
                size="sm"
                label="When agents need a decision"
                value={askPolicy}
                onChange={setAskPolicy}
                options={ASK_POLICIES.map((p) => ({ value: p.value, label: p.label }))}
              />
              <p className="mt-1.5 text-[11.5px] text-faint">
                {ASK_POLICIES.find((p) => p.value === askPolicy)?.hint}
              </p>
            </Field>
            <div className="flex flex-col gap-4">
              <Field
                label="Parallel tasks"
                hintBelow
                hint="Independent tasks build at once, each AI within its lane cap. Merges stay one at a time and are re-tested."
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
                label="Attempts per task"
                hintBelow
                hint="3 = first try + 2 retries. Usage limits don't use one up."
              >
                <Segmented
                  size="sm"
                  label="Attempts per task"
                  value={attempts}
                  onChange={setAttempts}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))}
                />
              </Field>
              <Field
                label="Retries"
                hintBelow
                hint={STRATEGIES.find((s) => s.value === strategy)?.hint}
              >
                <Segmented
                  size="sm"
                  label="Retry strategy"
                  value={strategy}
                  onChange={setStrategy}
                  options={STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
                />
              </Field>
            </div>
          </div>
        </section>
      )}

      {step === 'clarify' && (
        <section aria-labelledby="clarify-heading" className="flex flex-col gap-5">
          <h3 id="clarify-heading" className="sr-only">
            Questions and the first plan
          </h3>
          {!clarify && !clarifyError && !skipped ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <div className="flex items-center gap-3">
                <Thinking label="Reading the repository and your goal…" />
                <button
                  type="button"
                  onClick={() => {
                    skippedNow.current = true;
                    setSkipped(true);
                  }}
                  className="ml-auto text-[12.5px] font-medium text-accent-ink hover:underline"
                >
                  Skip questions
                </button>
              </div>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-2xl bg-sunken/70" />
              ))}
            </div>
          ) : (
            <>
              {clarifyError && (
                <div
                  role="status"
                  className="flex items-start gap-2.5 rounded-xl bg-sunken px-3.5 py-3 text-[12.5px] text-muted"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="flex-1">
                    Couldn't prepare questions; you can start anyway and the planner will plan as
                    usual. <span className="text-faint">({clarifyError})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => projectId && void runClarify(projectId)}
                    className="shrink-0 font-medium text-accent-ink hover:underline"
                  >
                    Try again
                  </button>
                </div>
              )}
              {clarify && clarify.questions.length > 0 && (
                <div className="flex flex-col gap-3">
                  <h4 className="text-[12.5px] font-semibold">
                    A few questions{' '}
                    <span className="font-normal text-faint">
                      · the answers become decisions every agent follows
                    </span>
                  </h4>
                  {clarify.questions.map((q) => (
                    <ClarifyQuestionCard
                      key={q.id}
                      question={q}
                      value={answers[q.id]}
                      onChange={(a) => setAnswers((s) => ({ ...s, [q.id]: a }))}
                    />
                  ))}
                </div>
              )}
              {answersChanged && (
                <div
                  role="status"
                  className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-3.5 py-2.5 text-[12.5px]"
                >
                  <span className="min-w-0 flex-1 text-muted">
                    Your answers changed since this plan was drafted.
                  </span>
                  <Button size="sm" onClick={() => void replan()} disabled={busy !== null}>
                    {busy === 'replan' ? 'Re-planning…' : 'Re-plan with my answers'}
                  </Button>
                </div>
              )}
              {(clarify || skipped) && (
                <div
                  aria-busy={busy === 'replan'}
                  className={busy === 'replan' ? 'opacity-50' : ''}
                >
                  <PlanEditor tasks={plan} onChange={setPlan} />
                </div>
              )}
              {clarify?.testCommand && !test.trim() && (
                <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
                  <Sparkles className="size-4 shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1 text-[13px]">
                    Proposed test command{' '}
                    <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px]">
                      {clarify.testCommand}
                    </code>
                    <span className="block text-[11.5px] text-faint">
                      Adopted after the first task that makes it pass.
                    </span>
                  </span>
                  <Segmented
                    size="sm"
                    label="Proposed test command"
                    value={useTest ? 'use' : 'ignore'}
                    onChange={(v) => setUseTest(v === 'use')}
                    options={[
                      { value: 'use', label: 'Use it' },
                      { value: 'ignore', label: 'Ignore' },
                    ]}
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}
    </Dialog>
  );
}

/* ── Where: folder state ─────────────────────────────────────────────── */

function FolderRow({
  folder,
  busy,
  confirmLarge,
  onConfirmLarge,
  onChange,
  onSetUp,
  onUseRoot,
}: {
  folder: FolderState;
  busy: string | null;
  confirmLarge?: boolean;
  onConfirmLarge?: (v: boolean) => void;
  onChange?: () => void;
  onSetUp?: () => void;
  onUseRoot?: (root: string) => void;
}) {
  const ok = folder.kind === 'ready';
  const name = 'name' in folder ? folder.name : folder.path;
  const line =
    folder.kind === 'ready'
      ? folder.root
      : folder.kind === 'missing'
        ? 'That folder does not exist.'
        : folder.kind === 'not_git'
          ? `Not a git repository yet · ${folder.files.toLocaleString()}${folder.files > 20_000 ? '+' : ''} files`
          : folder.kind === 'no_commits'
            ? 'A git repository with no commits yet.'
            : `This folder is inside ${folder.root}. Projects use the whole repository.`;
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${
        ok ? 'border-line bg-sunken/60' : 'border-warn/35 bg-warn-soft/50'
      }`}
    >
      <div className="flex items-center gap-3">
        <FolderGit2 className={`size-5 shrink-0 ${ok ? 'text-muted' : 'text-warn'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            {name}
            {(folder.kind === 'ready' || folder.kind === 'nested') && (
              <span className="inline-flex items-center gap-1 rounded-md bg-panel px-1.5 text-[11.5px] font-medium text-muted">
                <GitBranch className="size-3" aria-hidden />
                {folder.branch}
              </span>
            )}
          </div>
          <div className={`truncate text-[12px] ${ok ? 'text-faint' : 'text-warn'}`} title={line}>
            {line}
          </div>
        </div>
        {ok ? (
          <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="Ready" />
        ) : folder.kind === 'nested' ? (
          <Button size="sm" variant="primary" onClick={() => onUseRoot?.(folder.root)}>
            Use {folder.name}
          </Button>
        ) : folder.kind === 'not_git' || folder.kind === 'no_commits' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={onSetUp}
            disabled={busy !== null || (folder.large && !confirmLarge)}
          >
            {busy === 'git'
              ? 'Setting up…'
              : folder.kind === 'not_git'
                ? 'Set up git here'
                : 'Make the first commit'}
          </Button>
        ) : null}
        {onChange && (
          <Button size="sm" onClick={onChange}>
            Change
          </Button>
        )}
      </div>
      {(folder.kind === 'not_git' || folder.kind === 'no_commits') && (
        <div className="mt-2 pl-8 text-[11.5px] text-muted">
          Adds a .gitignore for the project's stack (never replacing yours), then commits everything
          as "Start".
          {folder.large && (
            <label className="mt-1.5 flex items-center gap-1.5 font-medium text-warn">
              <input
                type="checkbox"
                checked={confirmLarge ?? false}
                onChange={(e) => onConfirmLarge?.(e.target.checked)}
              />
              More than 20,000 files. Add them all anyway.
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Where: GitHub ───────────────────────────────────────────────────── */

function CloneList({
  gh,
  repos,
  query,
  onQuery,
  selected,
  onSelect,
  error,
  cloned,
  busy,
}: {
  gh: GitHubStatus | null;
  repos: GhRepo[] | null;
  query: string;
  onQuery: (q: string) => void;
  selected: string | null;
  onSelect: (repo: string) => void;
  error?: string | undefined;
  cloned: FolderState | null;
  busy: string | null;
}) {
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter(
      (r) =>
        !q || r.nameWithOwner.toLowerCase().includes(q) || r.description.toLowerCase().includes(q),
    );
  }, [repos, query]);

  if (!gh) return <Thinking label="Checking GitHub" />;
  if (!gh.signedIn) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
        <GitHubMark className="size-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="font-medium">
            {gh.installed ? 'Sign in to GitHub first' : 'GitHub CLI needed'}
          </div>
          <div className="text-[12px] text-faint">
            {gh.installed
              ? 'Conclave uses the official gh CLI; it never sees your token.'
              : 'Install gh from cli.github.com, then sign in from Accounts.'}
          </div>
        </div>
        {gh.installed && (
          <Button size="sm" variant="primary" onClick={() => void api().github.signIn()}>
            Sign in
          </Button>
        )}
      </div>
    );
  }
  if (cloned) return <FolderRow folder={cloned} busy={busy} />;
  return (
    <Field label={`Repository · ${gh.login}`} error={error}>
      <div className="rounded-xl border border-line">
        <label className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-3.5 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search your repositories"
            aria-label="Search repositories"
            className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </label>
        <div role="listbox" aria-label="Repositories" className="max-h-56 overflow-y-auto p-1">
          {repos === null ? (
            <div className="p-3">
              <Thinking label="Loading repositories" />
            </div>
          ) : shown.length === 0 ? (
            <p className="p-3 text-[12.5px] text-muted">No repositories match.</p>
          ) : (
            shown.map((r) => (
              <button
                key={r.nameWithOwner}
                type="button"
                role="option"
                aria-selected={selected === r.nameWithOwner}
                onClick={() => onSelect(r.nameWithOwner)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${
                  selected === r.nameWithOwner ? 'bg-accent-soft' : 'hover:bg-sunken'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {r.nameWithOwner}
                    {r.isPrivate && <Lock className="size-3 text-faint" aria-label="Private" />}
                  </span>
                  {r.description && (
                    <span
                      className="block truncate text-[12px] text-faint"
                      title={r.description ?? undefined}
                    >
                      {r.description}
                    </span>
                  )}
                </span>
                {r.language && <span className="text-[11.5px] text-faint">{r.language}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </Field>
  );
}

/* ── Clarify ─────────────────────────────────────────────────────────── */

function ClarifyQuestionCard({
  question,
  value,
  onChange,
}: {
  question: ClarifyResult['questions'][number];
  value: Answer | undefined;
  onChange: (a: Answer) => void;
}) {
  return (
    <div className="rounded-2xl border border-line px-4 py-3.5">
      <div className="text-[13.5px] font-semibold">{question.question}</div>
      {question.why && <div className="mt-0.5 text-[12px] text-faint">{question.why}</div>}
      <div
        role="radiogroup"
        aria-label={question.question}
        className="mt-2.5 flex flex-wrap gap-1.5"
      >
        {question.options.map((o) => {
          const on = !value?.own && !value?.assumed && value?.answer === o;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange({ answer: o })}
              className={`inline-flex h-7.5 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition ${
                on
                  ? 'border-accent bg-accent text-white'
                  : 'border-line-strong hover:border-accent/50 hover:bg-accent-soft/50'
              }`}
            >
              {o === question.recommended && (
                <Star
                  className={`size-3 ${on ? 'fill-white' : 'fill-warn text-warn'}`}
                  aria-label="Recommended"
                />
              )}
              {o}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={value?.own ?? false}
          onClick={() => onChange({ answer: '', own: true })}
          className={`inline-flex h-7.5 items-center rounded-full border border-dashed px-3 text-[12.5px] font-medium ${
            value?.own
              ? 'border-accent text-accent-ink'
              : 'border-line-strong text-muted hover:text-ink'
          }`}
        >
          Write my own
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value?.assumed ?? false}
          onClick={() =>
            onChange({
              answer: question.recommended ?? question.options[0] ?? '',
              assumed: true,
            })
          }
          className={`inline-flex h-7.5 items-center rounded-full border border-dashed px-3 text-[12.5px] font-medium ${
            value?.assumed
              ? 'border-accent text-accent-ink'
              : 'border-line-strong text-muted hover:text-ink'
          }`}
        >
          Decide for me
        </button>
      </div>
      {value?.own && (
        <input
          autoFocus
          value={value.answer}
          onChange={(e) => onChange({ answer: e.target.value, own: true })}
          aria-label={`Your answer: ${question.question}`}
          placeholder="Your answer"
          className={`${inputClass} mt-2.5`}
        />
      )}
    </div>
  );
}

function PlanEditor({ tasks, onChange }: { tasks: Draft[]; onChange: (tasks: Draft[]) => void }) {
  const [announce, setAnnounce] = useState('');
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= tasks.length) return;
    const next = [...tasks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
    setAnnounce(`${next[j]!.title} moved to position ${j + 1} of ${next.length}`);
  };
  const edit = (i: number, patch: Partial<Draft>) =>
    onChange(tasks.map((t, k) => (k === i ? { ...t, ...patch } : t)));

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <h4 className="text-[12.5px] font-semibold">First plan</h4>
        <span className="text-[11.5px] text-faint">
          Edit, reorder or remove. The planner adds more as it goes.
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <ol className="flex flex-col gap-1.5">
        {tasks.map((t, i) => (
          <li key={i} className="rounded-xl border border-line">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="w-5 text-center text-[12px] text-faint tabular-nums">{i + 1}</span>
              <input
                value={t.title}
                onChange={(e) => edit(i, { title: e.target.value })}
                aria-label={`Task ${i + 1} title`}
                className="h-8 min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
              />
              <button
                type="button"
                aria-expanded={t.open ?? false}
                aria-label={`Edit what task ${i + 1} should do`}
                onClick={() => edit(i, { open: !t.open })}
                className="grid size-7 place-items-center rounded-md text-faint hover:bg-sunken hover:text-ink"
              >
                <ChevronDown className={`size-3.5 transition ${t.open ? '' : '-rotate-90'}`} />
              </button>
              <button
                type="button"
                aria-label={`Move task ${i + 1} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className="grid size-7 place-items-center rounded-md text-faint hover:bg-sunken hover:text-ink disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move task ${i + 1} down`}
                disabled={i === tasks.length - 1}
                onClick={() => move(i, 1)}
                className="grid size-7 place-items-center rounded-md text-faint hover:bg-sunken hover:text-ink disabled:opacity-30"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove task ${i + 1}`}
                onClick={() => onChange(tasks.filter((_, k) => k !== i))}
                className="grid size-7 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            {t.open && (
              <textarea
                value={t.spec}
                onChange={(e) => edit(i, { spec: e.target.value })}
                rows={3}
                aria-label={`What task ${i + 1} should do`}
                className={`${textareaClass} rounded-t-none border-x-0 border-b-0 text-[12.5px]`}
              />
            )}
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange([...tasks, { title: '', spec: '', open: true }])}
        className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-ink hover:underline"
      >
        <Plus className="size-3.5" /> Add a task
      </button>
    </div>
  );
}
