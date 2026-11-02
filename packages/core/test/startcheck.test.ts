import { describe, expect, it } from 'vitest';
import {
  PRIORS,
  teamCheck,
  withPriors,
  type Availability,
  type ProviderId,
  type Routing,
} from '../src/index.js';

const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const seats = (...p: ProviderId[]) => p.map((provider) => ({ provider }));
// The benchmark defaults only: Claude reviews in about 18 s, Antigravity in about 170 s.
const stats = withPriors('reviewer', new Map());

const routing: Routing = {
  planner: seats('claude', 'antigravity', 'codex'),
  builder: seats('codex', 'claude', 'antigravity'),
  reviewer: seats('claude', 'antigravity', 'codex'),
};
const outs =
  (out: Partial<Record<ProviderId, { reason: string; until: number | null }>>) =>
  (p: ProviderId): Availability => {
    const o = out[p];
    return o ? { ok: false, ...o } : { ok: true };
  };

describe('Start-up check', () => {
  it('says nothing when the whole team can work', () => {
    expect(teamCheck({ routing }, outs({}), stats)).toEqual({ notes: [], waitUntil: null });
  });

  it('explains a limited builder: who builds instead, and the slower reviewer that follows', () => {
    const until = at(16, 10);
    const check = teamCheck(
      { routing },
      outs({ codex: { reason: 'usage limit reached', until } }),
      stats,
    );
    const ratio = Math.round(
      PRIORS.reviewer!.antigravity!.medianMs / PRIORS.reviewer!.claude!.medianMs,
    );
    expect(check).toEqual({
      notes: [
        {
          provider: 'codex',
          text: `Codex is at its usage limit until ${clock(until)}. Building moves to Claude, so reviews of Claude's work go to Antigravity, which is about ${ratio}× slower here.`,
          until,
        },
      ],
      waitUntil: until,
    });
  });

  it('explains quiet hours for the planner and lead reviewer', () => {
    const until = at(17);
    const { notes } = teamCheck(
      { routing },
      outs({ claude: { reason: `quiet hours until ${clock(until)}`, until } }),
      stats,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe(
      `Claude is in quiet hours until ${clock(until)}. Planning moves to Antigravity. Reviews move to Antigravity, which is about 9× slower here.`,
    );
  });

  it('keeps quiet about an AI that is only a backup', () => {
    const check = teamCheck(
      { routing },
      outs({ antigravity: { reason: 'usage limit reached', until: at(18) } }),
      stats,
    );
    expect(check.notes).toEqual([]);
  });

  it('says when nobody else can do a job, and waits for the last one back', () => {
    const solo: Routing = {
      planner: seats('claude'),
      builder: seats('codex'),
      reviewer: seats('claude'),
    };
    const check = teamCheck(
      { routing: solo },
      outs({
        codex: { reason: 'usage limit reached', until: at(16) },
        claude: { reason: 'daily cap reached (40 runs), resumes at midnight', until: at(24) },
      }),
      stats,
    );
    expect(check.notes.map((n) => n.text)).toEqual([
      `Claude has used its daily cap until ${clock(at(24))}. Nobody else on the team can do planning, so it waits. Nobody else on the team can do reviews, so it waits.`,
      `Codex is at its usage limit until ${clock(at(16))}. Nobody else on the team can do building, so it waits.`,
    ]);
    expect(check.waitUntil).toBe(at(24));
  });

  it('offers no time to wait for when one comes back at an unknown time', () => {
    const check = teamCheck(
      { routing },
      outs({ codex: { reason: 'leaving 10% for you, 5-hour window at 92%', until: null } }),
      stats,
    );
    expect(check.notes[0]!.text).toMatch(
      /^Codex is close to its limit \(5-hour window at 92%, with 10% kept for you\)\. Building moves to Claude/,
    );
    expect(check.waitUntil).toBeNull();
  });

  it('says Pause everything, and nothing else, when it is on', () => {
    const check = teamCheck(
      { routing },
      outs({
        claude: { reason: 'you paused everything', until: null },
        codex: { reason: 'you paused everything', until: null },
      }),
      stats,
    );
    expect(check.notes.map((n) => n.text)).toEqual([
      'Everything is paused in Settings. Nothing runs until you turn Pause everything off.',
    ]);
  });

  it('says when the limit is on another AI that shares the plan (F12)', () => {
    const until = at(16, 10);
    const { notes } = teamCheck(
      { routing: { ...routing, builder: seats('cursor', 'codex') } },
      outs({
        cursor: { reason: 'usage limit reached (on Grok, which shares its plan)', until },
      }),
      stats,
    );
    expect(notes[0]!.text).toBe(
      `Cursor is at its usage limit until ${clock(until)}: it shares one plan with Grok. Building moves to Codex.`,
    );
  });
});
