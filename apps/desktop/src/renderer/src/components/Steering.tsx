import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  MoreHorizontal,
  Pencil,
  Plus,
  SendHorizontal,
  SkipForward,
} from 'lucide-react';
import {
  IN_FLIGHT,
  type Project,
  type SteeringAction,
  type SteeringMessage,
  type Task,
} from '@conclave/shared';
import { Button, ProviderDot } from './bits';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { inputClass, textareaClass } from './form';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/projects';
import { errorText, providerName, useApp } from '@/lib/store';
import { settle } from '@/lib/settle';

const WAITING: Task['status'][] = ['queued', 'blocked'];
const menuItem =
  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium hover:bg-sunken disabled:opacity-40 disabled:hover:bg-transparent';

/* ── Board actions ───────────────────────────────────────────────────── */

/**
 * ⋯ on a task row: move it, edit it or skip it. Moving is for tasks that haven't started; a
 * running task can be edited (for its next attempt) or stopped and skipped, unless it's merging.
 */
export function TaskMenu({
  task,
  tasks,
  projectId,
}: {
  task: Task;
  tasks: Task[];
  projectId: string;
}) {
  const load = useProjects((s) => s.load);
  const showToast = useApp((s) => s.showToast);
  const toast = (text: string) => showToast('error', text);
  const [editing, setEditing] = useState(false);
  const waiting = tasks.filter((t) => WAITING.includes(t.status));
  const at = waiting.findIndex((t) => t.id === task.id);
  const canMove = at >= 0;
  const canEdit = !['merged', 'skipped', 'replaced'].includes(task.status);
  const live = IN_FLIGHT.includes(task.status);
  const canSkip =
    ['queued', 'blocked', 'failed'].includes(task.status) || (live && task.status !== 'merging');
  if (!canEdit) return null;
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (err) {
      toast(errorText(err));
    } finally {
      await load(projectId);
    }
  };
  return (
    <>
      <Popover
        label={`Actions for ${task.title}`}
        align="right"
        width={200}
        trigger={({ ref, toggle, ...aria }) => (
          <button
            ref={ref}
            type="button"
            onClick={toggle}
            {...aria}
            aria-label={`Actions for ${task.title}`}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-faint opacity-0 group-hover:opacity-100 hover:bg-sunken hover:text-ink focus-visible:opacity-100 aria-expanded:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        )}
      >
        {(close) => (
          <div className="p-1.5">
            <button
              type="button"
              disabled={!canMove || at === 0}
              onClick={() => {
                close();
                settle(run(() => api().projects.moveTask(task.id, 'up')));
              }}
              className={menuItem}
            >
              <ArrowUp className="size-3.5" /> Move up
            </button>
            <button
              type="button"
              disabled={!canMove || at === waiting.length - 1}
              onClick={() => {
                close();
                settle(run(() => api().projects.moveTask(task.id, 'down')));
              }}
              className={menuItem}
            >
              <ArrowDown className="size-3.5" /> Move down
            </button>
            <button
              type="button"
              onClick={() => {
                close();
                setEditing(true);
              }}
              className={menuItem}
            >
              <Pencil className="size-3.5" /> Edit…
            </button>
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              disabled={!canSkip}
              title={
                task.status === 'merging'
                  ? 'It’s merging right now; revert it once it lands.'
                  : live
                    ? 'Stops its agent now and discards the work in progress. Earlier merged work stays.'
                    : undefined
              }
              onClick={() => {
                close();
                settle(run(() => api().projects.skip(task.id)));
              }}
              className={menuItem}
            >
              <SkipForward className="size-3.5" /> {live ? 'Stop and skip' : 'Skip'}
            </button>
          </div>
        )}
      </Popover>
      <TaskDialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Edit task"
        description={
          IN_FLIGHT.includes(task.status)
            ? 'It’s running now; the change applies from its next attempt.'
            : undefined
        }
        initial={{ title: task.title, spec: task.spec }}
        submit="Save"
        onSubmit={async (v) => {
          try {
            await api().projects.editTask(task.id, v);
          } finally {
            await load(projectId);
          }
        }}
      />
    </>
  );
}

/** "Add a task" under the board. */
export function AddTask({ projectId, tasks }: { projectId: string; tasks: Task[] }) {
  const load = useProjects((s) => s.load);
  const refresh = useProjects((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const waiting = tasks.filter((t) => [...WAITING, ...IN_FLIGHT].includes(t.status));
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-[13px] font-medium text-muted hover:bg-sunken hover:text-ink"
      >
        <Plus className="size-4" aria-hidden /> Add a task
      </button>
      <TaskDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add a task"
        description="It goes to the end of the queue and is built, tested and reviewed like any other."
        initial={{ title: '', spec: '' }}
        waitFor={waiting}
        submit="Add task"
        onSubmit={async (v) => {
          try {
            await api().projects.addTask(projectId, v);
          } finally {
            await Promise.all([load(projectId), refresh()]);
          }
        }}
      />
    </>
  );
}

function TaskDialog({
  open,
  onClose,
  title,
  description,
  initial,
  waitFor,
  submit,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  initial: { title: string; spec: string };
  waitFor?: Task[];
  submit: string;
  onSubmit: (v: { title: string; spec: string; after?: string[] }) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial.title);
  const [spec, setSpec] = useState(initial.spec);
  const [after, setAfter] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(initial.title);
    setSpec(initial.spec);
    setAfter('');
    setProblem(null);
  }, [open]);
  // It closes only once the task is saved; a failure stays here with the edit (U12).
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit({
        title: name.trim(),
        spec: spec.trim() || name.trim(),
        ...(waitFor && { after: after ? [after] : [] }),
      });
      onClose();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      {...(description && { description })}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => settle(save())}>
            {busy ? 'Saving…' : submit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
            Not saved: {problem}
          </p>
        )}
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          Title
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Short and imperative, like “Add keyboard support”"
            className={inputClass}
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          What to do and how it’s checked
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={5}
            className={textareaClass}
          />
        </label>
        {waitFor && waitFor.length > 0 && (
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Wait for
            <select value={after} onChange={(e) => setAfter(e.target.value)} className={inputClass}>
              <option value="">Nothing: it can start as soon as a lane is free</option>
              {waitFor.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Dialog>
  );
}

/* ── Tell the project ────────────────────────────────────────────────── */

function describe(action: SteeringAction, tasks: Task[]): string {
  const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? 'a task';
  switch (action.type) {
    case 'add_task':
      return `Add “${action.title}”${action.after.length ? `, after ${action.after.map(title).join(', ')}` : ''}`;
    case 'edit_task':
      return `Edit “${title(action.id)}”${action.title ? ` → “${action.title}”` : ''}`;
    case 'skip_task':
      return `Skip “${title(action.id)}”`;
    case 'move_task':
      return action.before
        ? `Move “${title(action.id)}” before “${title(action.before)}”`
        : `Move “${title(action.id)}” to the end`;
    case 'decision':
      return `Decision: ${action.question} → ${action.answer}`;
    case 'pause':
      return 'Pause the project (running steps finish)';
  }
}

function ProposalCard({
  message,
  tasks,
  onSettled,
}: {
  message: SteeringMessage;
  tasks: Task[];
  onSettled: (m: SteeringMessage) => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const toast = (text: string) => showToast('error', text);
  const [picked, setPicked] = useState(() => message.actions.map((_, i) => i));
  const [busy, setBusy] = useState(false);
  if (!message.actions.length) return null;
  if (message.applied) {
    return (
      <ul className="mt-2 flex flex-col gap-1 rounded-xl border border-line bg-sunken/50 px-3 py-2 text-[12.5px]">
        {message.applied.length === 0 && (
          <li className="text-faint">Dismissed; nothing changed.</li>
        )}
        {message.outcome?.map((o, i) => (
          <li key={i} className={o.startsWith('Not done') ? 'text-warn' : 'text-muted'}>
            {o}
          </li>
        ))}
      </ul>
    );
  }
  const act = async (indexes: number[] | null) => {
    setBusy(true);
    try {
      onSettled(
        indexes
          ? await api().projects.applySteering(message.id, indexes)
          : await api().projects.dismissSteering(message.id),
      );
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="mt-2 rounded-xl border border-line bg-panel"
      role="group"
      aria-label="Proposed changes"
    >
      <ul className="flex flex-col gap-0.5 p-1.5">
        {message.actions.map((a, i) => (
          <li key={i}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-sunken">
              <input
                type="checkbox"
                checked={picked.includes(i)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, i].sort() : p.filter((x) => x !== i)))
                }
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              {describe(a, tasks)}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 border-t border-line px-2.5 py-2">
        <Button size="sm" disabled={busy} onClick={() => settle(act(null))}>
          Dismiss
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || picked.length === 0}
          onClick={() => settle(act(picked))}
        >
          {picked.length === 1 ? 'Apply 1 change' : `Apply ${picked.length} changes`}
        </Button>
      </div>
    </div>
  );
}

/** The Chat tab: tell a project what to change in plain words; its planner proposes, you apply. */
export function SteeringPanel({ project, tasks }: { project: Project; tasks: Task[] }) {
  const load = useProjects((s) => s.load);
  const refresh = useProjects((s) => s.refresh);
  const showToast = useApp((s) => s.showToast);
  const toast = (text: string) => showToast('error', text);
  const [messages, setMessages] = useState<SteeringMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const planner = project.routing.planner[0]?.provider;

  useEffect(() => {
    settle(api().projects.steering(project.id).then(setMessages));
  }, [project.id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, thinking]);

  const send = async () => {
    const text = draft.trim();
    if (!text || thinking) return;
    setDraft('');
    setThinking(true);
    try {
      const { you, planner: reply } = await api().projects.steer(project.id, text);
      setMessages((m) => [...m, you, reply]);
    } catch (err) {
      toast(errorText(err));
      setDraft(text);
    } finally {
      setThinking(false);
    }
  };
  const settled = (m: SteeringMessage) => {
    setMessages((all) => all.map((x) => (x.id === m.id ? m : x)));
    settle(Promise.all([load(project.id), refresh()]));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && !thinking && (
          <div className="py-6 text-center text-[13px] text-muted">
            <p className="font-medium text-ink">Tell the project what to change</p>
            <p className="mt-1 text-faint">
              “Make the buttons bigger and drop the combo counter”, “What’s left?”, “Pause after the
              current tasks”. The planner proposes; nothing changes until you apply it.
            </p>
          </div>
        )}
        <ol className="flex flex-col gap-3">
          {messages.map((m) =>
            m.role === 'you' ? (
              <li
                key={m.id}
                className="ml-8 self-end rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13px] text-ink"
              >
                {m.text}
              </li>
            ) : (
              <li key={m.id} className="mr-4 text-[13px]">
                <span className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-faint">
                  {m.provider && <ProviderDot provider={m.provider} size={6} />}
                  {m.provider ? providerName(m.provider) : 'Planner'}
                </span>
                <p className="leading-relaxed">{m.text}</p>
                <ProposalCard message={m} tasks={tasks} onSettled={settled} />
              </li>
            ),
          )}
          {thinking && (
            <li className="flex items-center gap-2 text-[12.5px] text-faint">
              <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden />
              {planner ? providerName(planner) : 'The planner'} is reading the project…
            </li>
          )}
        </ol>
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          settle(send());
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              settle(send());
            }
          }}
          rows={2}
          aria-label="Message to the project"
          placeholder="Tell the project what to change…"
          className={`${textareaClass} text-[13px]`}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!draft.trim() || thinking}
          aria-label="Send"
        >
          <SendHorizontal className="size-4" />
        </Button>
      </form>
    </div>
  );
}
