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
