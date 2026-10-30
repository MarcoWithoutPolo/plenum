# Benchmark results

Same goal, same seed repo, scored by hidden acceptance tests no agent ever sees (`projects/<name>/hidden/`).
Each contender works alone with no human: the single tools get one "do the whole goal" prompt (plus up to two
nudges if their own `npm test` is missing or failing), and Conclave runs its brain with decide-and-tell and
permission level 3.

```bash
npx tsx --conditions=development bench/run.ts --projects textkit,calc,inventory --contenders claude,codex,antigravity,conclave --runs 1
```

`bench/validate.sh` checks the hidden tests themselves: every project passes 7/7 on its reference solution and fails on its seed.

## Baseline: v0.6 (2026-10-23, one run each)

| Project                                    | Claude alone             | Codex alone               | Antigravity alone               | Conclave v0.6             |
| ------------------------------------------ | ------------------------ | ------------------------- | ------------------------------- | ------------------------- |
| textkit (small library + CLI)              | **7/7** · 1.0 min · 197k | **7/7** · 3.2 min · 121k  | **7/7** · 8.8 min · 1.2M        | **7/7** · 10.1 min · 1.4M |
| calc (parser + formatter + state machine)  | **7/7** · 1.2 min · 341k | **7/7** · 4.9 min · n/a ⚠ | 6/7 · 20.3 min · 3.1M · 1 nudge | **7/7** · 19.7 min · 2.6M |
| inventory (refactor + bug fixes + feature) | **7/7** · 1.0 min · 389k | not scored ⚠              | **7/7** · 7.1 min · 682k        | **7/7** · 12.6 min · 2.1M |

Each cell: hidden tests · wall time · tokens (input + output, cached context included). No contender asked a question or needed a human.

⚠ Codex hit the workspace spend cap during calc (the work finished, but its usage wasn't reported) and was turned
away before starting inventory. Conclave's Codex builder seat was turned away the same way on inventory, and the brain
fell back to Claude as designed.

### Who did what inside Conclave

| Project   | Planner        | Builder                 | Reviewer                 | Tasks    |
| --------- | -------------- | ----------------------- | ------------------------ | -------- |
| textkit   | Claude, 2 runs | Codex, 5 runs           | Claude, 5 runs           | 5 merged |
| calc      | Claude, 4 runs | Claude 6 + Codex 1      | Antigravity 6 + Claude 1 | 7 merged |
| inventory | Claude, 3 runs | Claude 7 (Codex capped) | Antigravity, 7 runs      | 6 merged |

## What this says

1. **Quality: there's no gap to win on these projects.** Every contender except Antigravity on calc got 7/7.
   Conclave never regressed and fixed what Antigravity alone missed, but Claude alone already solves goals of this size
   in one go.
2. **Speed and usage: Conclave v0.6 costs about 10× the time and 4–8× the tokens of Claude alone.** That cost goes to
   splitting a small goal into 5–7 tasks and paying a full build → test → cross-AI review cycle for each one, in
   series. When Claude builds, the reviewer must be another AI, so slow Antigravity reviews (~1 min each) sit on the
   critical path.
3. **Limits are real, and failover works.** Codex ran out mid-benchmark. The single-tool Codex run just stopped, while
   Conclave carried on with Claude without anyone stepping in. That is the clearest win for Conclave today.

## Changes to v0.7 because of this

- **Right-size the plan.** For a small goal, plan one or two tasks, not seven. Add a planner rule and a "small goal"
  fast path: one builder task, then one review of the whole diff.
- **Review proportionally.** Review the merged result once per batch rather than every task, and use a light
  review for small diffs. Prefer the fastest available reviewer when the diff is small.
- **Lanes (C1) and the merge queue (C2) stay**, but on these projects they aren't the biggest win: the brain makes
  fewer, cheaper round trips first, then runs them in parallel.
- **Harder benchmark projects.** Add multi-module goals that run past a single agent's context or attention (a
  service + client + migrations, or a large refactor), where planning and review should pay off. Without them the
  benchmark can only show Conclave's overhead, not its value.
- **Scoring tweaks.** Record which hidden tests fail, and report cached and fresh input tokens separately.

Re-run after v0.7 with `--runs 3` per cell to smooth out variance.

## P0.5 step 1: right-sized tasks (2026-10-23, one run each)

The planner now plans as few tasks as the work allows, and test setup rides along with the first task. Review stays
required on every change. Codex was still at its spend cap, so Claude built in every run (marked "limited").

| Project   | Conclave v0.6                   | Conclave, right-sized         | Change                         |
| --------- | ------------------------------- | ----------------------------- | ------------------------------ |
| textkit   | 7/7 · 10.1 min · 1.4M · 5 tasks | 7/7 · 4.6 min · 376k · 1 task | 2.2× faster, 3.7× fewer tokens |
| calc      | 7/7 · 19.7 min · 2.6M · 7 tasks | 7/7 · 6.1 min · 331k · 1 task | 3.2× faster, 7.9× fewer tokens |
| inventory | 7/7 · 12.6 min · 2.1M · 6 tasks | 7/7 · 3.4 min · 294k · 1 task | 3.7× faster, 7.0× fewer tokens |

Same hidden-test score, a quarter to a third of the time, and about a sixth of the tokens. Against Claude alone it is
now roughly 3–5× the time and about the same tokens, for a guaranteed cross-AI review.

Since this run, the brain also checks the planner's size estimates (folds tiny neighbours, sends oversized tasks back
to be split, calibrates against real diff sizes), lets the last task's reviewer confirm the whole goal (one fewer
planner round), and ranks seats by measured reliability, quota and review speed. The next run includes a large
multi-module project, where splitting should pay off.

## Ledger: a large multi-module project (2026-10-23, one run each)

Money, a journal, reports, a query language, a file parser and a CLI, scored by 12 hidden tests. Codex was at its spend
cap the whole time, so Conclave's builds fell back to Claude, and Claude-built work was reviewed by Antigravity.

| Contender                                | Hidden tests | Time     | Tokens | Tasks |
| ---------------------------------------- | ------------ | -------- | ------ | ----- |
| Claude alone                             | 12/12        | 3.3 min  | 472k   | n/a   |
| Codex alone                              | not scored ⚠ | n/a      | n/a    | n/a   |
| Antigravity alone                        | 12/12        | 40.1 min | 2.8M   | n/a   |
| Conclave, 1 lane (estimates, goal check) | 12/12        | 16.5 min | 2.5M   | 3     |
| Conclave, 2 lanes                        | 12/12        | 19.9 min | 2.8M   | 4     |

What this says:

1. **Quality holds on the large project too:** 12/12 every time. But Claude alone also gets 12/12, in a fifth of the
   time. On well-specified work of this size, one strong agent is enough.
2. **Reviews are now the cost.** Antigravity's reviews took several minutes and about 360–470k tokens each (it reads
   the whole project), over half of Conclave's tokens. The measured ranking that would move a slow reviewer back
   only kicks in after 5 runs of history; every benchmark run starts with an empty history, so it never kicked in.
3. **Lanes didn't help here.** With Codex capped, only Claude could build, every review went to Antigravity, and
   Antigravity's solo benchmark ran at the same time. Lanes can't beat a bottleneck shared by every lane. The runner
   now saves the brain's timeline per run, so the next run shows where every minute went.
4. **The goal check works:** one planner call per project instead of two to four.

Next: re-run with Codex back, with the timeline, and with `--runs 3`; give the reviewer a cheaper diff-first review
(read changed files first, the rest only when needed), and seed the ranking from earlier runs on the same machine.

## v0.7 (2026-10-23, one run each)

Everything in v0.7: right-sized plans checked by the brain, the goal check on the last review, AI ranking from
measured data seeded with benchmark priors, diff-first reviews, verified first tasks, decide-and-tell builds, lanes (2
by default) and the tested merge queue. Codex alone ran on a second, uncapped account; during Conclave's runs that
account hit its usage limit too, so Conclave's builds fell back to Claude (marked ⚠).

| Project   | Claude alone           | Codex alone            | Antigravity alone       | Conclave v0.6         | Conclave v0.7                 |
| --------- | ---------------------- | ---------------------- | ----------------------- | --------------------- | ----------------------------- |
| textkit   | 7/7 · 1.0 min · 197k   | 7/7 · 3.0 min · 134k   | 7/7 · 8.8 min · 1.2M    | 7/7 · 10.1 min · 1.4M | **7/7 · 3.0 min · 422k**      |
| calc      | 7/7 · 1.2 min · 341k   | 7/7 · 4.2 min · 178k   | 6/7 · 20.3 min · 3.1M   | 7/7 · 19.7 min · 2.6M | **7/7 · 5.4 min · 435k** ⚠    |
| inventory | 7/7 · 1.0 min · 389k   | 7/7 · 2.5 min · 126k   | 7/7 · 7.1 min · 682k    | 7/7 · 12.6 min · 2.1M | **7/7 · 3.0 min · 365k**      |
| ledger    | 12/12 · 3.3 min · 472k | 11/12 · 9.4 min · 355k | 12/12 · 40.1 min · 2.8M | n/a                   | **12/12 · 15.2 min · 2.4M** ⚠ |

### Where the time goes now

| Project (v0.7) | Planning | Building              | Reviewing                                | Brain (git, tests, merge) |
| -------------- | -------- | --------------------- | ---------------------------------------- | ------------------------- |
| textkit        | 0.3 min  | 2.4 (Codex)           | 0.2 (Claude)                             | 0.1                       |
| inventory      | 0.4 min  | 2.4 (Codex)           | 0.2 (Claude)                             | 0.0                       |
| calc ⚠         | 0.4 min  | 1.1 (Claude)          | 3.5 Antigravity, no verdict → 0.3 Claude | 0.1                       |
| ledger ⚠       | 1.0 min  | 5.3 (Claude, 2 lanes) | 12.7 (Antigravity, 2 lanes)              | 0.2                       |

### What this says

1. **Quality held everywhere:** 7/7 and 12/12 on every project. Codex alone missed one hidden test on ledger,
   Antigravity alone one on calc; Conclave missed none.
2. **Small projects are 3–4× faster than v0.6** and now match Codex alone (3.0 vs 3.0 and 2.5 min), with a cross-AI
   review. When Codex builds and Claude reviews, a review takes about 15 seconds.
3. **Ledger: 15.2 min, lanes working.** Two tasks built at once and their reviews ran side by side; it was 21.3 min
   before limit retries stopped parking a lane. It is still about 4.5× Claude alone.
4. **The remaining bottleneck is who's left to review.** With Codex at its limit, Claude builds, and the only other
   reviewer is Antigravity, whose reviews take 3–4 minutes each and once gave no verdict at all. Ranking can't fix an
   empty bench: the fix is a fast second reviewer (Codex with headroom) or a reviewer time limit.
5. **Decide-and-tell works:** builders record their choices (13 on ledger) instead of stopping, and every one shows up
   in the Decisions tab.

### Next

- A review time budget: if a slow reviewer hasn't answered in ~2 minutes and a faster one is free, ask the faster one.
- When an AI is at its limit, say so before a project starts ("Codex is at its limit until 4 PM; reviews will use
  Antigravity, which is slower").
- Re-run with `--runs 3` once Codex has headroom for a whole run.

## v0.7 final (2026-10-24, two runs each)

Conclave and Claude alone: two runs per project, averaged. Codex's account hit its usage limit early in this run,
so Codex alone is yesterday's uncapped single run (textkit: today's two runs). Antigravity alone is the average of
yesterday's and today's runs. During Conclave's runs Codex was mostly at its limit too, so Claude built and
Antigravity reviewed much of the time: the slowest pairing.

| Project   | Conclave v0.6         | Conclave v0.7                  | Claude alone    | Codex alone         | Antigravity alone              |
| --------- | --------------------- | ------------------------------ | --------------- | ------------------- | ------------------------------ |
| textkit   | 7/7 · 10.1 min · 1.4M | **7/7 ×2 · 2.7 min · 412k**    | 7/7 · 1.1 min   | 7/7 · 2.7 min       | 7/7 · 7.8 min                  |
| inventory | 7/7 · 12.6 min · 2.1M | **7/7 ×2 · 3.3 min · 383k**    | 7/7 · 1.3 min   | 7/7 · 2.5 min       | 7/7 · 6.7 min                  |
| calc      | 7/7 · 19.7 min · 2.6M | **7/7 ×2 · 6.3 min · 433k**    | 7/7 · 1.5 min   | 7/7 · 4.2 min       | 6/7 and 7/7 · 16.8 min         |
| ledger    | n/a                   | **12/12 ×2 · 15.3 min · 2.7M** | 12/12 · 2.8 min | **11/12** · 9.4 min | 12/12 · 36.0 min · up to 19.9M |

- **Quality:** Conclave got every hidden test in all 8 runs. Codex alone missed one on ledger and Antigravity alone one
  on calc. Claude alone was perfect too, and remains the fastest single tool on well-specified work.
- **Speed:** 3–4× faster than v0.6, with tokens down 3–6×. The two runs agree closely (2.6/2.7, 5.6/6.9, 3.9/2.7,
  15.9/14.6 min).
- **Against one AI alone:** on par with Codex alone on small projects, 2.5–5× Claude alone. The gap is the second
  AI's review, and most of it is Antigravity reviewing when Codex is out of usage. With Codex building and Claude
  reviewing, a small project took 2.6 minutes.
- **Limits:** Codex ran out mid-benchmark. Codex alone stopped; Conclave carried on with Claude and lost nothing.

## v0.8 P0: kanban baseline (2026-10-24)

A static web app with 12 hidden checks run in a real browser (Electron's Chromium, through Playwright): 7 for behavior
and 5 for how it looks. The goal asks in plain words for a clean layout on phones and desktops, dark mode and "common
accessibility guidelines". It doesn't give numbers. The checks use widely accepted ones: WCAG AA text contrast (4.5:1)
in both themes, 44 × 44 px touch targets, no sideways scrolling at 390 px, no console errors.

| Contender         | Runs | Hidden checks   | Missed                       | Time    |
| ----------------- | ---- | --------------- | ---------------------------- | ------- |
| Conclave v0.7     | 2    | 11/12 and 12/12 | text contrast (once)         | 5.5 min |
| Claude alone      | 2    | 12/12 and 11/12 | text contrast (once)         | 1.7 min |
| Codex alone       | 1    | 12/12           | none                         | 4.9 min |
| Antigravity alone | 1    | 10/12           | text contrast, touch targets | 7.7 min |

- **Behavior is solved; looks are where everyone slips.** Text contrast was missed by Conclave, Claude and
  Antigravity. No one missed a behavior check.
- A first version of the goal spelled out the numbers (4.5:1, 44 px, 390 px). Then every contender passed everything,
  so the goal now asks the way a person would.
- Antigravity first scored 1/12 because the hidden checks found the text field by its label and its page labelled
  the form "New card" too. The checks now find the text field by its role; re-scored, 10/12. Nobody else's score
  changed.
- **Change to the v0.8 plan:** contrast and touch-target checks join the free visual checks (C4). They're measured
  from the page, cost no tokens, and send work back like failing tests. The AI visual review stays for what can't be
  measured.

> **Correction (2026-10-30).** The contrast misses above, except Antigravity's, were the hidden check's fault, not the
> contenders'. It switched the page from light to dark and measured at once, while pages with a colour transition on
> their buttons (a 120 ms fade, common) were still mid-fade: one "failed" build measured 1.12:1 right after the switch
> and nothing below 4.5:1 half a second later. The check now waits for the page's transitions to finish (it still fails
> a page with truly unreadable text). Re-scored on the code still on disk:
>
> | Contender         | Was             | Now                                           |
> | ----------------- | --------------- | --------------------------------------------- |
> | Conclave v0.7     | 11/12 and 12/12 | 12/12 and 12/12                               |
> | Claude alone      | 12/12 and 11/12 | 12/12 and 12/12                               |
> | Codex alone       | 12/12           | 12/12                                         |
> | Antigravity alone | 10/12           | 10/12 (contrast and touch targets, both real) |
>
> So "looks are where everyone slips" was wrong: only Antigravity slips here. The free checks still earn their place
> (they cost nothing and catch what Antigravity misses), but this project can't show one tool beating another on
> looks. See v0.8 below for what it does show.

## v0.8 (2026-10-25 to 2026-10-30)

### The CLI projects: no slower for the new features

Two runs each, 2026-10-25. Codex was at its usage limit for most of it (⚠ in the raw results), so Claude and
Antigravity did most of the building and reviewing: the slowest pairing, as in v0.7's final runs.

| Project   | Conclave v0.7    | Conclave v0.8                |
| --------- | ---------------- | ---------------------------- |
| textkit   | 7/7 · 2.7 min    | 7/7 ×2 · 3.1 and 2.9 min     |
| calc      | 7/7 · 6.3 min    | 7/7 ×2 · 3.2 and 5.5 min     |
| inventory | 7/7 · 3.3 min    | 7/7 ×2 · 2.5 and 5.3 min     |
| ledger    | 12/12 · 15.3 min | 12/12 ×2 · 21.4 and 29.0 min |

Every hidden test passed. Nothing here is a web page, so no screenshots were taken; the time differences come from
who had usage left, not from v0.8. Ledger was slow because Antigravity reviewed most of it while Codex was out.

### Kanban: all 12/12 with the corrected check

| Team                                  | Screenshots, free checks | Visual review | Runs | Hidden checks | Time                |
| ------------------------------------- | ------------------------ | ------------- | ---- | ------------- | ------------------- |
| Usual team, Codex at its limit        | on                       | on            | 2    | 12/12 ×2      | 6.4 and 8.8 min     |
| Usual team, Codex at its limit        | on                       | off           | 2    | 12/12 ×2      | 7.5 and 6.4 min     |
| Codex on GPT-6-Luna (a lighter model) | on                       | on            | 2    | 12/12 ×2      | 3.9 and 6.1 min     |
| Codex on GPT-6-Luna                   | on                       | off           | 2    | 12/12 ×2      | 6.6 min (one timed) |
| Antigravity builds, Claude reviews    | on                       | on            | 2    | 12/12 ×2      | 13.8 and 30.7 min   |
| Antigravity builds, Claude reviews    | off (as v0.7)            | off           | 2    | 12/12 ×2      | 13.4 and 15.6 min   |

(The first four rows scored 11/12 three times on the old check; re-scored, all 12/12. See the correction above.)

- **The free checks caught a real problem once.** In the Antigravity run that took 30.7 minutes, the tests passed on
  the second attempt, but the free checks found 2 problems in its screenshots and sent it back. That attempt scores
  11/12 on the hidden checks (text contrast below 4.5:1); the fixed one scores 12/12. Without the checks, Conclave
  would have merged it. This is what v0.8 is for, and it cost no tokens: just a 7-minute third attempt.
- **Antigravity inside Conclave doesn't repeat its solo mistakes.** Alone it scored 10/12. Inside Conclave, with
  Claude planning and reviewing, all 4 runs got 12/12, screenshots or not. The plan and the review already ask for
  the things it forgot alone; the checks are the safety net for when it still gets them wrong.
- **Visual review is cheap:** about 3,000–3,700 image tokens per project, 0.1–0.8% of the input tokens. It found
  nothing the free checks hadn't.
- **What this can't show:** that v0.8 beats v0.7 on this project. Most teams get kanban right without screenshots.
  One catch in 10 runs with screenshots on is real evidence the checks work, not evidence of how often they matter.
  A project whose looks are harder to get right is needed for that.

### Live scenarios 9–14 (in the real app, real CLIs)

| #   | Scenario                                                      | Result                                                                                                                                                                                    |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Live preview of a web project while it's built                | 6/6 (on the re-run)                                                                                                                                                                       |
| 10  | Screenshots and free checks send a broken page back           | 5/5                                                                                                                                                                                       |
| 11  | A slow reviewer: a backup is asked after the time budget      | not triggered in its own runs; it fired live during scenario 9 ("Antigravity hasn't answered in 98 seconds; asking Codex too", then "Antigravity approved first; stopped Codex's review") |
| 12  | Visual review by an AI that sees images                       | 2/2                                                                                                                                                                                       |
| 13  | Start-up check when an AI is at its limit; "wait until" start | 6/6                                                                                                                                                                                       |
| 14  | Stop and skip one task while others carry on                  | 4/4                                                                                                                                                                                       |

### Done when

v0.8's plan said it's done when a web project's looks are checked before merging, at little cost, without slowing
non-web projects. It is: the free checks caught and fixed a real contrast failure that would otherwise have merged,
visual review costs under 1% of tokens, and the CLI projects score as before. The benchmark doesn't show v0.8 beating
v0.7 on kanban because, once the hidden check was fixed, almost everyone already gets kanban right.
