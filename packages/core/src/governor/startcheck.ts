import type { Project, ProviderId, Routing, Seat } from '@plenum/shared';
import { seatLabel } from '../chat/transcript.js';
import type { Availability } from './governor.js';
import { RANK, type SeatStats } from './rank.js';

/** Something about the team right now that changes who does what, said before a start. */
export interface StartNote {
  /** The AI that can't work right now. */
  provider: ProviderId;
  /** One or two sentences: what's wrong, until when, and who takes over. */
  text: string;
  /** When it can work again, if known. */
  until: number | null;
}

export interface StartCheck {
  notes: StartNote[];
  /** When everyone on the team is back, for "Wait until…" (null when a time is unknown). */
  waitUntil: number | null;
}

const ROLE_WORD: Record<keyof Routing, string> = {
  planner: 'Planning',
  builder: 'Building',
  reviewer: 'Reviews',
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const name = (provider: ProviderId) => seatLabel({ provider });

/** "is at its usage limit until 4:10 PM", from the governor's reason. */
function state(a: Extract<Availability, { ok: false }>): string {
  // The limit is another AI's on the same plan (F12): say so after the state.
  const shared = / \(on (.+), which shares its plan\)$/.exec(a.reason);
  if (shared) {
    const own = state({ ...a, reason: a.reason.slice(0, shared.index) });
    return `${own}: it shares one plan with ${shared[1]}`;
  }
  const until = a.until !== null ? ` until ${clock(a.until)}` : '';
  if (/^quiet hours/.test(a.reason)) return `is in quiet hours${until}`;
  if (/^daily cap/.test(a.reason)) return `has used its daily cap${until}`;
  // "leaving 10% for you, 5-hour window at 92%"
  const kept = /^leaving (\d+)% for you, (.+)$/.exec(a.reason);
  if (kept) return `is close to its limit (${kept[2]}, with ${kept[1]}% kept for you)${until}`;
  if (/limit|cap|credits|quota/i.test(a.reason)) return `is at its usage limit${until}`;
  return `can't work right now (${a.reason})${until}`;
}

/**
 * The start-up check (v0.8 C6): before a project starts, which AIs on its team can't work right
 * now and what that changes: who plans, builds and reviews instead, and when a much slower
 * reviewer ends up on the critical path. Pure: availability and stats are passed in.
 */
export function teamCheck(
  project: Pick<Project, 'routing'>,
  availability: (provider: ProviderId) => Availability,
  stats: Map<ProviderId, SeatStats>,
): StartCheck {
  const { routing } = project;
  const team = [
    ...new Set(
      [...routing.planner, ...routing.builder, ...routing.reviewer].map((s) => s.provider),
    ),
  ];
  const out = new Map(
    team
      .map((p) => [p, availability(p)] as const)
      .filter((e): e is [ProviderId, Extract<Availability, { ok: false }>] => !e[1].ok),
  );
  if (!out.size) return { notes: [], waitUntil: null };
  const paused = [...out.values()].find((a) => a.reason === 'you paused everything');
  if (paused) {
    return {
      notes: [
        {
          provider: [...out.keys()][0]!,
          text: 'Everything is paused in Settings. Nothing runs until you turn Pause everything off.',
          until: null,
        },
      ],
      waitUntil: null,
    };
  }

  const ok = (s: Seat) => !out.has(s.provider);
  const firstFree = (seats: Seat[], not?: ProviderId) =>
    seats.find((s) => ok(s) && s.provider !== not);
  const median = (p: ProviderId) => stats.get(p)?.medianMs ?? NaN;
  /** ", which is about 10× slower here" when the data says so. */
  const slower = (now: ProviderId, usual: ProviderId | undefined) => {
    if (!usual || now === usual) return '';
    const ratio = median(now) / median(usual);
    return Number.isFinite(ratio) && ratio >= RANK.slow
      ? `, which is about ${Math.round(ratio)}× slower here`
      : '';
  };

  const notes: StartNote[] = [];
  for (const [provider, a] of out) {
    const moves: string[] = [];
    for (const role of ['planner', 'builder', 'reviewer'] as const) {
      // Only a role this AI leads changes; as a backup it's simply skipped.
      if (routing[role][0]?.provider !== provider) continue;
      const next = firstFree(routing[role]);
      if (!next) {
        moves.push(`Nobody else on the team can do ${ROLE_WORD[role].toLowerCase()}, so it waits`);
        continue;
      }
      if (role === 'builder') {
        // Who reviews now, against who would have reviewed the usual builder's work.
        const reviewer = firstFree(routing.reviewer, next.provider);
        const usual = firstFree(routing.reviewer, provider);
        const reviews =
          reviewer && reviewer.provider !== usual?.provider
            ? `, so reviews of ${name(next.provider)}'s work go to ${name(reviewer.provider)}${slower(reviewer.provider, usual?.provider)}`
            : '';
        moves.push(`Building moves to ${name(next.provider)}${reviews}`);
      } else {
        moves.push(
          `${ROLE_WORD[role]} move${role === 'reviewer' ? '' : 's'} to ${name(next.provider)}${role === 'reviewer' ? slower(next.provider, provider) : ''}`,
        );
      }
    }
    if (!moves.length) continue;
    notes.push({
      provider,
      text: `${name(provider)} ${state(a)}. ${moves.join('. ')}.`,
      until: a.until,
    });
  }
  const untils = notes.map((n) => n.until);
  return {
    notes,
    waitUntil:
      notes.length && untils.every((u): u is number => u !== null) ? Math.max(...untils) : null,
  };
}
