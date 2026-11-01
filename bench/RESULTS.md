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

## v0.9 (2026-10-30, one run each)

The four new AIs alone, each at permission level 2 (edits only: the strongest level Conclave can enforce for all of
them), and Conclave with two new teams. All on free plans except Claude and Codex.

```bash
npx tsx --conditions=development bench/run.ts --projects textkit,calc,inventory,ledger,kanban --contenders cursor,copilot,grok,local
```

### Each new AI alone

| Project   | Copilot (Free)                 | Cursor (Hobby, Auto) | Grok Build (free) | Local: GPT-OSS 20B (RTX 4070 Ti SUPER) |
| --------- | ------------------------------ | -------------------- | ----------------- | -------------------------------------- |
| textkit   | **7/7** · 1.2 min              | **7/7** · 2.2 min    | 7/7 · 8.3 min ⚠   | 5/7 · 1.6 min · 2 nudges               |
| calc      | **7/7** · 1.2 min              | 7/7 · 8.6 min ⚠      | out of usage      | 0/7 · 3.4 min · 2 nudges               |
| inventory | **7/7** · 0.8 min              | out of usage         | out of usage      | 0/7 · 0.2 min                          |
| ledger    | 11/12 · 5.5 min · 1 nudge      | out of usage         | out of usage      | 0/12 · 0.7 min                         |
| kanban    | 11/12 · 1.5 min (touch target) | out of usage         | out of usage      | 0/12 · 2.0 min · 2 nudges              |

⚠ hit its free plan's limit during the run. "Out of usage": turned away at the first prompt ("You've hit your usage
limit", "You've reached your free Grok Build usage limit"). Copilot doesn't report tokens.

- **Copilot Free is the surprise:** the fastest contender in any v0.9 run, 7/7 on every small project, and one miss each
  on ledger and kanban (a button under 44 px on phones).
- **Cursor and Grok on free plans last about one project.** Cursor's Hobby plan finished textkit and calc, then
  refused; Grok's free allowance ran out during textkit. Their scores here say nothing about the models, only about
  how far a free plan goes.
- **A 20B local model can't do these goals alone.** It edits files, but its code fails most hidden tests, and its own
  tests fail too. It is free and private, not a builder you leave alone.

### Conclave with the new AIs

| Project   | Five-AI team¹        | Local model first in line² |
| --------- | -------------------- | -------------------------- |
| textkit   | **7/7** · 3.3 min    | **7/7** · 5.6 min          |
| calc      | **7/7** · 5.6 min    | **7/7** · 11.2 min³        |
| inventory | **7/7** · 3.3 min    | **7/7** · 7.8 min³         |
| ledger    | **12/12** · 13.9 min | **12/12** · 29.6 min       |
| kanban    | **12/12** · 6.8 min  | **12/12** · 9.3 min        |

1. Claude plans; Codex, Cursor, then Claude build; Claude, Antigravity, then Grok review. Level 3.
2. Claude plans; local GPT-OSS 20B, Codex, then Claude build; Claude, then Antigravity review. Level 2, where local
   models can build.
3. Re-run after the escalation fix below; the first run scored 4/7 and 0/7.

- **The five-AI team got every hidden test**, at v0.8's speed. But Cursor and Grok never ran in it. Cursor
  can't build at level 3 at all (it can't limit which commands run), so it was never a candidate; Grok was third in
  line to review and never reached, and both were out of free usage anyway. Codex and Claude built and Claude and
  Antigravity reviewed, as before. Codex then ran out during kanban, and Claude took over without anyone stepping in.
  (Corrected 2026-10-31: this first said only the free plans kept them out.)
- **A local builder costs time, not quality, once Conclave works around it.** Its attempts fail the tests, and the
  task moves on to the next builder. The first run found two bugs in that hand-off, both fixed in v0.9:
  - a builder turned away by a usage limit counted as "the one who failed", so escalation went back to the local
    model instead of on to Claude (calc and inventory first scored 4/7 and 0/7 this way, and 7/7 each after the fix);
  - a model the CLI doesn't have (a team naming a model since deleted from Ollama) was retried over and over; now
    it hands the task to the next builder without using an attempt.
- **What wasn't measured:** one run each, not two. The plan's comparison of local reviews through Ollama against
  OpenCode wasn't run separately (reviews always go through Ollama, which scenario 18 checked live). Grok and Cursor
  couldn't be measured inside a team on free plans.

### Live scenarios 15–21 (in the real app, real CLIs)

| #   | Scenario                                                                   | Result                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | Each new AI chats, then joins a council with Claude, Codex and Antigravity | 12/12: seven AIs answered one council round and the answers merged                                                                                                                                                                                                |
| 16  | Cursor builds at level 2, a different AI reviews; no shell or network use  | passed (with 18 and 20: 7/7)                                                                                                                                                                                                                                      |
| 17  | A local model builds through OpenCode; never paused for usage              | 2/2                                                                                                                                                                                                                                                               |
| 18  | Local model chats and reviews through Ollama; a model too big says so      | passed                                                                                                                                                                                                                                                            |
| 19  | The picker's model and effort reach each CLI as flags                      | 5/5; a model Cursor's free plan refused is now hidden from the picker                                                                                                                                                                                             |
| 20  | "Merge here, then push"; a second run behind the remote is refused         | passed, against a bare local repository standing in for GitHub                                                                                                                                                                                                    |
| 21  | A new AI at its usage limit hands off and says when it's back              | 6/6 live (2026-10-31), with Cursor and Grok out of free usage: both were turned away, Claude built, Antigravity reviewed, no attempt used; the start-up check then said when each is tried again (Conclave's own back-off: neither CLI says when its limit lifts) |
| 11  | (again) A short review budget asks a backup reviewer and stops the loser   | 4/4, forced with a 20-second budget                                                                                                                                                                                                                               |

## v0.9 final (2026-10-31 to 11-01, the second run of each)

The runs v0.9 skipped, on paid plans for the X AIs: Cursor and Grok Build on The X Subscription (Premium), Grok
signed in again after its first runs still used the free account. Each new AI alone twice, Copilot and the local
model once more, and the teams v0.9 couldn't measure. This is the baseline v0.9.1 is compared against.

### Each new AI alone, two runs

| Project   | Cursor (Grok 4.7 High) | Grok Build             | Copilot Free (run 2) | Local GPT-OSS 20B (run 2) |
| --------- | ---------------------- | ---------------------- | -------------------- | ------------------------- |
| textkit   | **7/7** · 40.0¹, 11.6  | **7/7** · 14.5, 8.2    | **7/7** · 1.2        | 5/7 · 2.6                 |
| calc      | **7/7** · 27.5, 27.1   | **7/7** · 23.7, 18.3   | **7/7** · 1.4        | 3/7 · 1.8                 |
| inventory | **7/7** · 20.3, 33.0   | **7/7** · 9.0, 16.8    | **7/7** · 0.7        | 0/7 · 0.3                 |
| ledger    | **12/12** · 40.0¹ ×2   | **12/12** · 40.0¹ ×2   | **12/12** · 6.1      | 0/12 · 0.1                |
| kanban    | **12/12** · 20.8, 19.3 | **12/12** · 20.8, 14.3 | 11/12 · 1.5          | 0/12 · 0.2                |

Minutes per run. 1. Stopped at the 40-minute cap with the hidden tests already passing (its own tests still failing).

- **On a paid plan, Cursor and Grok get every hidden test**, but slowly: 10 to 40 minutes a project, where Copilot
  Free takes 1 to 6. Grok uses far more tokens (0.4 to 2.4M a run, Cursor 0.1 to 0.3M).
- **Copilot Free repeats its v0.9 result**, now with ledger 12/12 too; kanban misses the same touch-size test.
- **Grok's limit came from the account, not the plan.** After the upgrade its CLI still said "free Grok Build usage
  limit" until `grok logout` and `grok login` again; X Premium covers it once signed in with the subscribed account.

### Teams, two runs

| Project   | Cursor and Grok first¹     | Same, Grok 4.7 High Fast² | Local model builds³ (run 2) | Local reviews, Ollama⁴ | Local reviews, OpenCode⁴ |
| --------- | -------------------------- | ------------------------- | --------------------------- | ---------------------- | ------------------------ |
| textkit   | **7/7** · 6.8, 9.2         | **7/7** · 5.7             | **7/7** · 3.6               | **7/7** · 4.0, 5.4     | **7/7** · 2.6, 1.8       |
| calc      | **7/7** · 38.2, 21.2       | **7/7** · 10.5            | **7/7** · 7.9               | **7/7** · 7.9, 6.0     | **7/7** · 7.7, 6.3       |
| inventory | 0/7 · 40⁵, **7/7** 18.7    | 0/7 · 40⁵                 | **7/7** · 4.5               | **7/7** · 5.1, 27.8    | **7/7** · 3.8, 26.1      |
| ledger    | 0/12 · 40⁵ ×2              | 0/12 · 40⁵                | **12/12** · 19.2            | **12/12** · 20.6, 15.6 | **12/12** · 19.9, 18.1   |
| kanban    | 0/12 · 40⁵, **12/12** 31.9 | **12/12** · 10.3          | **12/12** · 5.5             | **12/12** · 6.2, 4.3   | **12/12** · 5.4, 6.3     |

1. Claude plans; Cursor (Grok 4.7 High), Codex, then Claude build; Grok, Claude, then Antigravity review. Level 2.
   Grok was still on the free account for these: its reviews were turned away and Claude reviewed.
2. The same team with Cursor on `grok-4.7-high-fast`, one run, Grok signed in properly.
3. Claude plans; local GPT-OSS 20B, Codex, then Claude build; Claude, then Antigravity review. Level 2.
4. Claude plans; Codex, then Claude build; local GPT-OSS 20B, then Antigravity review. Level 2. Codex was at its
   own usage limit for most of these, so Claude built.
5. Stopped at the 40-minute cap with work unmerged.

- **Every team that doesn't put Cursor first gets every hidden test**, local models included, and the local-first
  team's second run was faster than its first (3.6 to 19.2 min against 5.6 to 29.6).
- **Cursor first is too slow for the cap on bigger projects.** Not the loop: it takes 5 to 20 minutes per task on
  Grok 4.7 High, about half that on High Fast (calc 10.5 min against 38.2). One inventory run also shows a gap
  at level 2: the task needed a file deleted, Cursor can't run commands there, and it spent about 20 minutes
  trying `rm` and `git rm` before the cap.
- **Local reviews through Ollama and through OpenCode score the same.** OpenCode reviewers read the files around
  the diff: about 3× the local tokens (1.2M against 0.36M over ten runs, all free on the GPU), in about the same
  time. Ollama stays the default.
- **The loop wastes work** (inventory with a local reviewer: 27.8 and 26.1 min, about 30 agent runs, for a project
  that takes 4 min when the review passes): each send-back rebuilds from nothing. That is what v0.9.1 fixes; its
  before/after comparison follows.

## v0.9.1: before and after (2026-10-31 to 11-01)

**Before** is v0.9.0 (`fd23568`); **after** is v0.9.1 (`419c879`). Each suite ran two runs of each project on each
version, interleaved so usage limits and the time of day hit both alike. 18 runs that a usage limit cut off at the
40-minute cap (most used under 35k tokens, waiting the whole time) were run again; "(cap)" marks the few reruns that
the cap cut off again. Medians leave capped runs out.

### Verdict

- **Nothing broke.** Every run that wasn't cut off by a usage limit or the cap passed every hidden test, on both
  versions, except one before run (T3 inventory, 0/7) and one light-review run (T5 ledger, 11/12).
- **Faster where the loop does work.** Summing each suite's per-project medians: T2 −12%, T3 −25% (without ledger,
  which is capped on both), T5 (light reviews) −36% against T2 after. T1 +6% and T4 +5% are runs whose steps were
  identical in both versions (one build, one review): AI response time, not Conclave.
- **Kept work pays off.** 22 of 24 send-backs continued from the kept attempt; the fixes took 0.5 to 5 minutes
  instead of a full rebuild. Parking, planner failover, stalls and second opinions never triggered in the
  benchmark (no limit hit during a review, no planner failed, nothing hung); scenarios 22–23 and the unit tests
  cover them.
- **The ship rule, strictly read, fails on six project cells** (T1 textkit +19%, T1 ledger +11%, T2 inventory +28%,
  T2 kanban +13%, T3 textkit +40%, T4 inventory). Five of them took the same steps on both versions; with two runs a
  cell, one slow AI reply moves the median by more than 10%. The sixth was a real flaw, fixed below.

#### T1: Default team, level 3

| Project   | Before: hidden | Before: median min | After: hidden | After: median min | Change |
| --------- | -------------- | ------------------ | ------------- | ----------------- | ------ |
| textkit   | 7/7, 7/7       | 2.8                | 7/7, 7/7      | 3.4               | +19%   |
| calc      | 7/7, 7/7       | 5.8                | 7/7, 7/7      | 6.5               | +10%   |
| inventory | 7/7, 7/7       | 3.0                | 7/7, 7/7      | 2.7               | -11%   |
| ledger    | 12/12, 12/12   | 16.6               | 12/12, 12/12  | 18.4              | +11%   |
| kanban    | 12/12, 12/12   | 11.1               | 12/12, 12/12  | 10.8              | -2%    |

#### T2: Antigravity reviews

| Project   | Before: hidden | Before: median min | After: hidden     | After: median min | Change |
| --------- | -------------- | ------------------ | ----------------- | ----------------- | ------ |
| textkit   | 7/7, 7/7       | 7.0                | 7/7, 7/7          | 4.4               | -36%   |
| calc      | 7/7, 7/7       | 7.2                | 7/7, 7/7          | 4.9               | -31%   |
| inventory | 7/7, 7/7       | 2.8                | 7/7, 7/7          | 3.6               | +28%   |
| ledger    | 12/12, 12/12   | 26.3               | 12/12, 4/12 (cap) | 22.9              | -13%   |
| kanban    | 12/12, 12/12   | 9.9                | 12/12, 12/12      | 11.2              | +13%   |

#### T3: X team (Cursor grok-high-fast first)

| Project   | Before: hidden | Before: median min | After: hidden          | After: median min | Change |
| --------- | -------------- | ------------------ | ---------------------- | ----------------- | ------ |
| textkit   | 7/7, 7/7       | 5.5                | 7/7, 7/7               | 7.8               | +40%   |
| calc      | 7/7, 7/7       | 14.8               | 7/7, 7/7               | 9.4               | -36%   |
| inventory | 7/7, 0/7       | 38.2               | 7/7, 7/7               | 29.8              | -22%   |
| ledger    | 12/12, 12/12   | 37.5               | 5/12 (cap), 6/12 (cap) | capped            |        |
| kanban    | 12/12, 12/12   | 21.3               | 12/12, 12/12           | 12.8              | -40%   |

#### T4: Local reviewer (gpt-oss:20b)

| Project   | Before: hidden | Before: median min | After: hidden                       | After: median min | Change              |
| --------- | -------------- | ------------------ | ----------------------------------- | ----------------- | ------------------- |
| textkit   | 7/7, 7/7       | 4.8                | 7/7, 7/7                            | 4.3               | -9%                 |
| calc      | 7/7, 7/7       | 8.7                | 7/7, 7/7                            | 9.6               | +10%                |
| inventory | 7/7, 7/7       | 3.8                | 7/7, 7/7 (rerun on f1b1a32: 7/7 ×3) | 14.3 (rerun: 5.6) | +281% (rerun: +47%) |
| ledger    | 12/12, 12/12   | 29.7               | 12/12, 12/12                        | 26.5              | -11%                |
| kanban    | 12/12, 12/12   | 12.2               | 12/12, 12/12                        | 7.3               | -40%                |

#### T5: light reviews against T2 after (same team, full reviews)

| Project   | T2 after: median min | T5: hidden   | T5: median min | Change |
| --------- | -------------------- | ------------ | -------------- | ------ |
| textkit   | 4.4                  | 7/7, 7/7     | 2.6            | −41%   |
| calc      | 4.9                  | 7/7, 7/7     | 3.8            | −22%   |
| inventory | 3.6                  | 7/7, 7/7     | 2.7            | −25%   |
| ledger    | 22.9                 | 11/12, 12/12 | 14.6           | −36%   |
| kanban    | 11.2                 | 12/12, 12/12 | 6.2            | −45%   |

#### v0.9.1 loop events (after runs)

| Suite | Builds | Reviews | Send-backs | Continued from kept work | Parked | Planner failovers | Stalls | Second opinions |
| ----- | ------ | ------- | ---------- | ------------------------ | ------ | ----------------- | ------ | --------------- |
| T1    | 25     | 17      | 0          | 0                        | 0      | 0                 | 0      | 0               |
| T2    | 25     | 20      | 3          | 3                        | 0      | 0                 | 0      | 0               |
| T3    | 27     | 20      | 5          | 6                        | 0      | 0                 | 0      | 0               |
| T4    | 37     | 31      | 11         | 8                        | 0      | 0                 | 0      | 0               |
| T5    | 22     | 18      | 5          | 5                        | 0      | 0                 | 0      | 0               |

### What got worse, and what was done

- **A review the builder can't satisfy burned attempts** (T4 inventory, 26 min, 6 send-backs). The local reviewer
  asked for `inventory.js` to be deleted; at level 2 the builder can't delete files, so it changed nothing, which
  counted as a failed attempt and hid the review from the second-opinion check. **Fixed in `f1b1a32`:** a build
  left unchanged goes back to review with the builder's answer, no attempt spent; a repeated rejection gets a second
  opinion. Rerun three times: 7/7 each, 5.4–5.7 min. The rest of the gap to before (3.8 min) is the local model
  replying empty and Antigravity stepping in, which happens in about 40% of local reviews on both versions.
- **A parked build re-ran its tests on every wake-up** while no reviewer was free (scenario 23). **Fixed in
  `d7ef86e`:** it stays parked until a reviewer has headroom.
- **Light reviews let one bug through** (T5 ledger, 11/12): Antigravity's flash-low approved each task in about 6
  seconds. Light stays opt-in; the default stays "As in the team".
- **T3 ledger is capped on both versions** (before 36.4 and 38.3 min; after cut off three times). After lost its
  time to Cursor's first builds failing tests (fixed from kept work in 4.6 and 0.6 min) and an 11-minute rebuild
  after a merge conflict.

### Found along the way (proposals, not in v0.9.1)

- **Resolve merge conflicts on kept work.** A conflict still throws the build away and rebuilds (11 min in T3
  ledger). The builder could continue from its commit with the newer work merged in and resolve the conflict.
- **Let builders delete files at level 2.** Cursor spent 20 minutes trying `rm` in v0.9's runs, and the T4 churn
  above started there. Deleting inside the task's own worktree is undone by git like any edit.
- **Drop a reviewer that keeps replying empty.** GPT-OSS 20B gave no verdict in about 40% of reviews, costing 1–2
  minutes each before Antigravity stepped in.
- **Limits shape these numbers more than the code.** Codex was at its limit for most of both runs; 18 of 90 runs
  had to be redone.

## v0.9.2: live check (2026-11-01, three runs each)

v0.9.2 (`05062e2`) with the default team (T1) and the local reviewer (T4), on inventory and ledger. This check only
had to show nothing breaks with real AIs; the before/after comparison is v0.9.1's above. Each run now splits its
time into AI, waiting for limits, and Conclave's own steps (tests, git, the loop).

| Suite | Project   | Hidden                      | Minutes          | Median | v0.9.1 median | AI / waiting / Conclave (median run) |
| ----- | --------- | --------------------------- | ---------------- | ------ | ------------- | ------------------------------------ |
| T1    | inventory | 7/7, 7/7, 7/7               | 4.0, 2.6, 2.1    | 2.6    | 2.7           | 2.5 / 0 / 0.0                        |
| T1    | ledger    | 12/12, 12/12, 5/12 (limits) | 18.8, 24.0, 60.1 | 21.4   | 18.4          | 18.6–23.9 / 0 / 0.1                  |
| T4    | inventory | 7/7, 7/7, 7/7               | 4.0, 2.2, 2.9    | 2.9    | 5.6 (rerun)   | 2.7 / 0 / 0.0                        |
| T4    | ledger    | 12/12, 12/12, 4/12 (limits) | 23.7, 20.5, 60.1 | 22.1   | 26.5          | 20.3–23.5 / 0 / 0.1–0.2              |

- **Nothing broke.** Every run that a limit didn't cut off passed every hidden test.
- **Conclave's own time is 0.0–0.2 minutes a run.** Everything else is the AIs working or waiting, so differences
  between runs and versions here are AI response time. T1 ledger's 18.8 vs 24.0 minutes took the same steps.
- **Deleting files works.** All six inventory runs deleted `inventory.js` with a `DELETE:` line (the T4 churn in
  v0.9.1 started there); T4 inventory is back under v0.9.0's 3.8 minutes.
- **Quiet reviewers move back.** In all three T4 ledger runs GPT-OSS 20B gave no verdict twice and reviewed
  last from then on.
- **Real limits, not a fault.** Both third ledger runs ran out of builders: T1 used 12.9 minutes of AI and waited 47,
  T4 used 16.5 and waited 43. Codex was out of usage and Claude was at 90–91% of its weekly allowance, past the 10%
  Conclave leaves for you. With no other builder in the team they waited, as designed, until the 60-minute cap. Conflicts on kept work, stalls and second opinions didn't come up live; the trouble
  suite forces each of them in CI.
