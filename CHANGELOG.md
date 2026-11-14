# Changelog

## 1.0.1

The first update: making sure updates work, plus fixes found in the first days of 1.0.

- **Your data from before the rename is back.** 1.0.0 kept your `~/.conclave` folder but opened a new, empty
  database in it, so earlier chats and projects seemed gone. Nothing was lost: 1.0.1 opens the old one.
- **Previews of JavaScript projects work.** Plenum's own copies of a project never had its packages, so a Vite or
  Next dev server couldn't start: no preview, no screenshots, and tests that need packages failed. Once you allow a
  project's preview, Plenum installs its packages there (`npm ci`, or the project's package manager) and every task
  uses them.
- **The preview asks early.** A web project whose preview you haven't allowed now asks on its page as soon as it has
  a dev command, instead of after everything is built.
- **Report a problem:** Settings → About saves the logs (keys and tokens removed) and opens a new GitHub issue with
  your Plenum version and system filled in. Nothing else goes in the link, and the log stays on your computer until
  you attach it yourself.
- **Windows: nothing left running.** A server an AI started in the background and forgot to stop used to keep
  running after its step (a known limit in 1.0). AI runs and test commands now run in a Windows job object, so
  whatever they start ends with them.
- **Long runs use less memory:** each step used to leave a little behind for as long as its project ran.
- Issue templates for bug reports, feature ideas and "an AI CLI changed".

The "Fast" and "Thorough" team presets promised for 1.0.1 are part of 1.1 instead, together with a third, "Balanced",
and a much shorter New project dialog.

## 1.0.0 (2026-11-08)

The first public release. Plenum runs the AI coding CLIs you already use and are signed in to (Claude Code, Codex,
Gemini/Antigravity, Copilot, Cursor and more) as one team: chat with any of them, ask several at once as a council,
or hand a project to the brain, which plans, builds, tests, reviews and merges on its own branch until the goal is met.
Plenum never asks for or stores your passwords or API keys; each CLI signs in with its own login.

Plenum was built under the working name Conclave. If you ran a preview, your projects and settings in
`~/.conclave` are picked up as they are; uninstall the old "Conclave" app by hand.

**New in 1.0**

- **First run:** finds the AIs installed on your computer, signs you in through each one's own CLI, and suggests a
  team.
- **A measured default team:** Claude plans and reviews, Codex builds, picked by benchmark runs rather than guesses
  (`bench/RESULTS.md`).
- **Review effort:** keep full reviews, use lighter reviewers, or **Tests only**, where a task whose tests pass merges
  without a review (the last task is still checked against the goal).
- **Accounts:** one card per AI with its default model and effort, and which AI new chats start with.
- **Council:** skip an AI that's taking too long and merge now, without losing the other answers.
- **Background mode and tray:** projects keep running with the window closed.
- **MCP server:** Claude Code or any MCP client can ask a council or hand a project a task.
- **Appearance and accessibility:** text size, high contrast, reduced motion, focus outlines, screen-reader
  announcements and keyboard shortcuts.
- **Shared plans:** Cursor and Grok are treated as one plan when they share a subscription.
- **Upgrades keep your data:** a backup before every database change, tested from every earlier version; Export logs
  for bug reports.
- **Installers** for Windows, macOS and Linux, with updates from this repository's releases.

**Reliability**

- Every P0 and P1 bug found while testing 1.0 is fixed with a test.
- A 24-hour soak: 11,250 tasks with simulated crashes, usage limits and slow answers, and the engine killed outright
  every 2 hours. Every restart recovered. The one task it lost and the leftover folders it found are fixed, and a
  confirmation soak passed 960 of 960 tasks across 11 kills.
- A run can no longer hang on a server an AI forgot to stop, and a scratch file in the system temp folder no longer
  stops a good build.

**Known limits**

- The installers aren't code-signed, so Windows and macOS warn on first run.
- Tested hands-on on Windows; the macOS and Linux builds come from the same code but haven't had the same run.
- Cursor builds at permission levels 1, 2 and 5 only.
- On Windows, a server an AI started and forgot to stop can outlive its run.

**Not yet:** "Fast" and "Thorough" team presets (1.0.1), code signing, a mobile or web client.
