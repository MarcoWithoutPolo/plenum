import { Clock, Hourglass, Play, Users, X } from 'lucide-react';
import type { StartCheck } from '@plenum/core';
import { Button } from './bits';
import { settle } from '@/lib/settle';

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * The start-up check: before a project starts, which AIs can't work right now and who takes
 * over. Start anyway is the default; Wait until… starts it when they're back.
 */
export function StartCheckNote({
  check,
  label,
  busy,
  onStart,
  onEditTeam,
  onClose,
}: {
  check: StartCheck;
  /** The start button's own word: Start, Resume or Keep improving. */
  label: string;
  busy: boolean;
  onStart: (at?: number) => Promise<void>;
  onEditTeam: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="group"
      aria-label="Before you start"
      className="mt-3 flex items-start gap-3 rounded-2xl border border-warn/30 bg-warn-soft/40 px-4 py-3"
    >
      <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-warn-soft text-warn">
        <Hourglass className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">Before you start</p>
        <ul className="mt-0.5 flex flex-col gap-1">
          {check.notes.map((n) => (
            <li key={n.provider} className="selectable text-[12.5px]">
              {n.text}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => settle(onStart())}>
            <Play className="size-3 fill-current" aria-hidden /> {label} anyway
          </Button>
          {check.waitUntil !== null && (
            <Button size="sm" disabled={busy} onClick={() => settle(onStart(check.waitUntil!))}>
              <Clock className="size-3.5" aria-hidden /> Wait until {clock(check.waitUntil)}
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={onEditTeam}>
            <Users className="size-3.5" aria-hidden /> Edit team
          </Button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="-mr-1 grid size-7 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
