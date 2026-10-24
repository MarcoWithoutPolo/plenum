import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  CircleStop,
  FileCode2,
  GitCommitHorizontal,
  GitMerge,
  Hourglass,
  ListPlus,
  MessageCircleQuestion,
  Play,
  RotateCcw,
  Scale,
  ScanEye,
  Sparkles,
  Terminal,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { BrainEvent, BrainEventKind, Project, Seat, Task } from '@conclave/shared';
import { providerName, useApp } from '@/lib/store';
import { ProviderDot } from './bits';
import { modelLabel } from './SeatPicker';

/* ── Project status ──────────────────────────────────────────────────── */

const STATUS: Record<Project['status'], { label: string; tone: string; dot: string }> = {
  draft: { label: 'Draft', tone: 'bg-sunken text-muted', dot: 'var(--faint)' },
  needs_you: { label: 'Needs you', tone: 'bg-warn-soft text-warn', dot: 'var(--warn)' },
  running: { label: 'Running', tone: 'bg-ok-soft text-ok', dot: 'var(--ok)' },
  waiting: { label: 'Waiting for usage', tone: 'bg-warn-soft text-warn', dot: 'var(--warn)' },
  paused: { label: 'Paused', tone: 'bg-warn-soft text-warn', dot: 'var(--warn)' },
  stopped: { label: 'Stopped', tone: 'bg-sunken text-muted', dot: 'var(--faint)' },
  idle: { label: 'Not started', tone: 'bg-sunken text-muted', dot: 'var(--faint)' },
  done: { label: 'Goal met', tone: 'bg-accent-soft text-accent-ink', dot: 'var(--accent)' },
};

export function StatusPill({
  status,
  running,
  reason,
}: {
  status: Project['status'];
  running: boolean;
  /** An idle project with a reason has run before and has new work: it can resume. */
  reason?: string | null;
}) {
  // The brain may still be finishing a step after a stop; trust the lock while it holds.
  const base = STATUS[running && status !== 'waiting' ? 'running' : status];
  // A start you scheduled from the start-up check ("Starts at 4:10 PM, when …").
  const scheduled = status === 'waiting' && reason?.startsWith('Starts at ');
  const s =
    !running && status === 'idle' && reason
      ? { ...base, label: 'Ready to resume' }
      : scheduled
        ? { ...base, label: 'Scheduled' }
        : base;
  return (
    <span
      className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium ${s.tone}`}
    >
      <span
        className={`size-1.5 rounded-full ${running && status !== 'waiting' ? 'live-dot' : ''}`}
        style={{ background: s.dot }}
        aria-hidden
      />
      {s.label}
    </span>
  );
}

/* ── Event icons ─────────────────────────────────────────────────────── */

const EVENT: Record<BrainEventKind, { icon: LucideIcon; color: string }> = {
  start: { icon: Play, color: 'var(--accent)' },
  plan: { icon: ListPlus, color: 'var(--accent)' },
  task: { icon: CircleDot, color: 'var(--accent)' },
  agent: { icon: Terminal, color: 'var(--faint)' },
  commit: { icon: GitCommitHorizontal, color: 'var(--muted)' },
  verify: { icon: CheckCircle2, color: 'var(--ok)' },
  review: { icon: ScanEye, color: 'var(--accent)' },
  merge: { icon: GitMerge, color: 'var(--ok)' },
  retry: { icon: RotateCcw, color: 'var(--warn)' },
  fail: { icon: XCircle, color: 'var(--danger)' },
  wait: { icon: Hourglass, color: 'var(--warn)' },
  done: { icon: Sparkles, color: 'var(--accent)' },
  stop: { icon: CircleStop, color: 'var(--muted)' },
  error: { icon: AlertTriangle, color: 'var(--danger)' },
  approval: { icon: Sparkles, color: 'var(--warn)' },
  question: { icon: MessageCircleQuestion, color: 'var(--warn)' },
  decision: { icon: Scale, color: 'var(--accent)' },
};

export function eventLooksBad(e: BrainEvent): boolean {
  return (
    (e.kind === 'verify' && /failed|timed out/i.test(e.message)) ||
    (e.kind === 'review' && /^Changes requested/.test(e.message))
  );
}

export function EventIcon({ event }: { event: BrainEvent }) {
  const bad = eventLooksBad(event);
  const { icon: Icon, color } = bad
    ? {
        icon: event.kind === 'verify' ? XCircle : RotateCcw,
        color: event.kind === 'verify' ? 'var(--danger)' : 'var(--warn)',
      }
    : event.kind === 'agent' && /^(Created|Edited) /.test(event.message)
      ? { icon: FileCode2, color: 'var(--faint)' }
      : EVENT[event.kind];
  return <Icon className="size-3.5 shrink-0" style={{ color }} aria-hidden />;
}

/* ── Roles ───────────────────────────────────────────────────────────── */

export function SeatChip({ seat }: { seat: Seat }) {
  const providers = useApp((s) => s.providers);
  const info = providers.find((p) => p.provider === seat.provider);
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-panel px-2 text-[12px] font-medium">
      <ProviderDot provider={seat.provider} size={7} />
      {providerName(seat.provider)}
      {seat.model && <span className="font-normal text-muted">{modelLabel(info, seat.model)}</span>}
      {seat.effort && <span className="font-normal text-faint">· {seat.effort}</span>}
    </span>
  );
}

export function RoleLine({ label, seats }: { label: string; seats: Seat[] }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-16 shrink-0 text-[11.5px] font-medium tracking-wide text-faint uppercase">
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {seats.map((s, i) => (
          <span key={`${s.provider}-${i}`} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-[11px] text-faint">then</span>}
            <SeatChip seat={s} />
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Tasks ───────────────────────────────────────────────────────────── */

export const ACTIVE: Task['status'][] = ['building', 'verifying', 'reviewing'];

export function taskVerb(task: Task): string {
  switch (task.status) {
    case 'building':
      return 'Building';
    case 'verifying':
      return 'Running tests';
    case 'reviewing':
      return 'In review';
    case 'merged':
      return 'Merged';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Needs you';
    case 'skipped':
      return 'Skipped';
    case 'replaced':
      return 'Replaced';
    default:
      return task.attempts ? 'Queued for retry' : 'Queued';
  }
}

export function TaskStatusIcon({ task }: { task: Task }) {
  if (task.status === 'merged')
    return <CheckCircle2 className="size-4 shrink-0 text-ok" aria-hidden />;
  if (task.status === 'failed')
    return <XCircle className="size-4 shrink-0 text-danger" aria-hidden />;
  if (ACTIVE.includes(task.status)) {
    return (
      <span className="relative grid size-4 shrink-0 place-items-center" aria-hidden>
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
      </span>
    );
  }
  return (
    <span
      className="block size-4 shrink-0 rounded-full border-2 border-dashed border-line-strong"
      aria-hidden
    />
  );
}

/* ── Time ────────────────────────────────────────────────────────────── */

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}
