import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, FolderGit2, GitBranch, Plus, X } from 'lucide-react';
import type { ProviderId, Routing, Seat } from '@conclave/shared';
import type { RepoInfo } from '../../../shared/api';
import { Dialog } from '@/components/Dialog';
import { SeatPicker, modelLabel } from '@/components/SeatPicker';
import { Popover } from '@/components/Popover';
import { Button, ProviderDot } from '@/components/bits';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/projects';
import { providerName, readyProviders, useApp } from '@/lib/store';

const PREFERENCE: Record<keyof Routing, ProviderId[]> = {
  planner: ['claude', 'antigravity', 'codex', 'gemini'],
  builder: ['codex', 'claude', 'antigravity', 'gemini'],
  reviewer: ['claude', 'antigravity', 'codex', 'gemini'],
};

const ROLES: { key: keyof Routing; label: string; hint: string }[] = [
  { key: 'planner', label: 'Plans', hint: 'Splits the goal into tasks' },
  { key: 'builder', label: 'Builds', hint: 'Writes each task in a worktree' },
  { key: 'reviewer', label: 'Reviews', hint: 'Checks each diff, never its own' },
];

export function NewProjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: (createdId?: string) => void;
}) {
  const providers = useApp((s) => s.providers);
  const create = useProjects((s) => s.create);
  const start = useProjects((s) => s.start);
  const ready = readyProviders(providers);

  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [goal, setGoal] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [test, setTest] = useState('');
  const [attempts, setAttempts] = useState(3);
  const [routing, setRouting] = useState<Routing>({ planner: [], builder: [], reviewer: [] });
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const order = (role: keyof Routing) =>
      PREFERENCE[role].flatMap((p) =>
        ready.some((r) => r.provider === p) ? [{ provider: p }] : [],
      );
    setRouting({
      planner: order('planner'),
      builder: order('builder'),
      reviewer: order('reviewer'),
    });
    setRepo(null);
    setGoal('');
    setDoneWhen('');
    setTest('');
    setAttempts(3);
    setTouched(false);
  }, [open]);

  const choose = async () => {
    const path = await api().projects.pickRepo();
    if (!path) return;
    setChecking(true);
    const info = await api().projects.inspectRepo(path);
    setChecking(false);
    setRepo(info);
    if (info.ok && info.suggestedTest && !test) setTest(info.suggestedTest);
  };

  const missingRole = ROLES.find((r) => routing[r.key].length === 0);
  const canCreate = repo?.ok && goal.trim().length > 0 && !missingRole && !saving;

  const submit = async (andStart: boolean) => {
    setTouched(true);
    if (!canCreate || !repo) return;
    setSaving(true);
    const id = await create({
      repoPath: repo.root ?? repo.path,
      goal: goal.trim(),
      ...(doneWhen.trim() && { doneWhen: doneWhen.trim() }),
      ...(test.trim() && { testCommand: test.trim() }),
      routing,
      maxAttempts: attempts,
    });
    setSaving(false);
    if (!id) return;
    if (andStart) void start(id);
    onClose(id);
  };

  return (
    <Dialog
      open={open}
      onClose={() => onClose()}
      title="New project"
      description="Give Conclave a repository and a goal. It plans, builds, tests and reviews on its own, on a separate branch."
      width={680}
      footer={
        <>
          <span className="mr-auto text-[12px] text-faint">
            Your branch and files are never touched until you approve the merge.
          </span>
          <Button onClick={() => void submit(false)} disabled={saving}>
            Create
          </Button>
          <Button variant="primary" onClick={() => void submit(true)} disabled={saving}>
            {saving ? 'Creating…' : 'Create and start'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Repository"
          error={touched && !repo?.ok ? (repo?.error ?? 'Choose a git repository') : undefined}
        >
          {repo ? (
            <div
              className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 ${
                repo.ok ? 'border-line bg-sunken/60' : 'border-danger/30 bg-danger-soft'
              }`}
            >
              <FolderGit2
                className={`size-5 shrink-0 ${repo.ok ? 'text-muted' : 'text-danger'}`}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium">
                  {repo.name ?? repo.path}
                  {repo.ok && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-panel px-1.5 text-[11.5px] font-medium text-muted">
                      <GitBranch className="size-3" aria-hidden />
                      {repo.branch}
                    </span>
                  )}
                </div>
                <div className={`truncate text-[12px] ${repo.ok ? 'text-faint' : 'text-danger'}`}>
                  {repo.ok ? repo.root : repo.error}
                </div>
              </div>
              {repo.ok ? (
                <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="Ready" />
              ) : (
                <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden />
              )}
              <Button size="sm" onClick={() => void choose()}>
                Change
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void choose()}
              disabled={checking}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong px-4 py-5 text-[13px] font-medium text-muted transition hover:border-accent/50 hover:bg-accent-soft/40 hover:text-accent-ink"
            >
              <FolderGit2 className="size-4" aria-hidden />
              {checking ? 'Checking…' : 'Choose a folder'}
            </button>
          )}
        </Field>

        <Field
          label="Goal"
          hint="What should exist when it's done? Be specific."
          error={touched && !goal.trim() ? 'Describe the goal' : undefined}
        >
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={4}
            placeholder="Add a slugify(text) helper with tests: lowercase, strip accents, collapse non-alphanumerics to single dashes."
            aria-label="Goal"
            className="w-full resize-none rounded-xl border border-line-strong bg-panel px-3.5 py-2.5 text-[13.5px] leading-relaxed outline-none placeholder:text-faint focus:border-accent"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Test command"
            hintBelow
            hint="Must pass after every task. Leave empty for review only."
          >
            <input
              value={test}
              onChange={(e) => setTest(e.target.value)}
              placeholder="npm test"
              aria-label="Test command"
              spellCheck={false}
              className="h-9.5 w-full rounded-xl border border-line-strong bg-panel px-3 font-mono text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
            />
          </Field>
          <Field label="Done when" optional hintBelow hint="How the planner knows the goal is met.">
            <input
              value={doneWhen}
              onChange={(e) => setDoneWhen(e.target.value)}
              placeholder="All tests pass and the README documents it"
              aria-label="Done when"
              className="h-9.5 w-full rounded-xl border border-line-strong bg-panel px-3 text-[13px] outline-none placeholder:text-faint focus:border-accent"
            />
          </Field>
        </div>

        <Field
          label="Team"
          hint="Who does each job, in order. If one is out of usage, the next one takes over."
          error={
            touched && missingRole
              ? `Pick at least one AI that ${missingRole.label.toLowerCase()}`
              : undefined
          }
        >
          <div className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {ROLES.map((role) => (
              <div key={role.key} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="w-36 shrink-0">
                  <div className="text-[13px] font-medium">{role.label}</div>
                  <div className="text-[11.5px] leading-snug text-faint">{role.hint}</div>
                </div>
                <SeatList
                  seats={routing[role.key]}
                  onChange={(seats) => setRouting((r) => ({ ...r, [role.key]: seats }))}
                />
              </div>
            ))}
          </div>
        </Field>

        <Field
          label="Retries per task"
          hint="Failed tests or review comments go back to the builder this many times."
        >
          <div
            role="radiogroup"
            aria-label="Retries per task"
            className="inline-flex rounded-xl border border-line bg-sunken/60 p-0.5"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={attempts === n}
                onClick={() => setAttempts(n)}
                className={`h-7.5 w-10 rounded-[10px] text-[12.5px] font-medium transition ${
                  attempts === n ? 'bg-accent text-white shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  hintBelow,
  error,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  /** Put the hint under the control (narrow fields). */
  hintBelow?: boolean;
  error?: string | undefined;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold whitespace-nowrap">{label}</span>
        {optional && <span className="text-[11.5px] text-faint">Optional</span>}
        {hint && !error && !hintBelow && (
          <span className="ml-auto truncate text-[11.5px] text-faint">{hint}</span>
        )}
        {error && (
          <span role="alert" className="ml-auto text-[11.5px] font-medium text-danger">
            {error}
          </span>
        )}
      </div>
      {children}
      {hint && hintBelow && <p className="mt-1.5 text-[11.5px] text-faint">{hint}</p>}
    </div>
  );
}

/** An ordered list of seats: each one editable with the seat picker, removable, and an Add button. */
function SeatList({ seats, onChange }: { seats: Seat[]; onChange: (seats: Seat[]) => void }) {
  const providers = useApp((s) => s.providers);
  const ready = readyProviders(providers);
  const unused = ready.filter((p) => !seats.some((s) => s.provider === p.provider));

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {seats.map((seat, i) => {
        const info = providers.find((p) => p.provider === seat.provider);
        return (
          <span key={seat.provider} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-[11px] text-faint">then</span>}
            <span className="inline-flex h-7.5 items-center rounded-full border border-line-strong bg-panel">
              <SeatPicker
                value={seat}
                lockProvider={seat.provider}
                onChange={(next) => onChange(seats.map((s, j) => (j === i ? next : s)))}
                label={`${info?.displayName ?? seat.provider} model`}
                trigger={({ ref, toggle, seat: s, open, ...aria }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={toggle}
                    {...aria}
                    className={`inline-flex h-full items-center gap-1.5 rounded-l-full pr-1.5 pl-2.5 text-[12.5px] font-medium ${open ? 'text-accent-ink' : ''}`}
                  >
                    <ProviderDot provider={s.provider} size={7} />
                    {providerName(s.provider)}
                    <span className="font-normal text-muted">{modelLabel(info, s.model)}</span>
                    {s.effort && <span className="font-normal text-faint">· {s.effort}</span>}
                  </button>
                )}
              />
              <button
                type="button"
                aria-label={`Remove ${providerName(seat.provider)}`}
                onClick={() => onChange(seats.filter((_, j) => j !== i))}
                className="mr-1 grid size-5.5 place-items-center rounded-full text-faint hover:bg-sunken hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </span>
          </span>
        );
      })}
      {unused.length > 0 && (
        <Popover
          label="Add an AI"
          width={220}
          trigger={({ ref, toggle, ...aria }) => (
            <button
              ref={ref}
              type="button"
              onClick={toggle}
              {...aria}
              aria-label="Add an AI"
              className="inline-flex h-7.5 items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 text-[12px] font-medium text-muted hover:border-accent/50 hover:text-accent-ink"
            >
              <Plus className="size-3.5" /> Add
            </button>
          )}
        >
          {(close) => (
            <div className="p-1.5">
              {unused.map((p) => (
                <button
                  key={p.provider}
                  type="button"
                  onClick={() => {
                    onChange([...seats, { provider: p.provider }]);
                    close();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken"
                >
                  <ProviderDot provider={p.provider} />
                  {p.displayName}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
