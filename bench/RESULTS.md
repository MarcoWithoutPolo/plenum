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
