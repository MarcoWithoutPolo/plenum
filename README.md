# Conclave

A desktop command center that runs the AI coding tools you already use (Claude Code, OpenAI Codex and Gemini CLI) together on one project.

- **Chat** with any of them, and pick or switch the model for each conversation.
- **Council**: ask all of them at once, see their answers side by side, and get one merged answer that shows where they agree and disagree.
- **Projects**: an autonomous "brain" that plans, builds, tests and reviews a repo for days. It splits work by role and model and paces itself against each subscription's usage limits.

> Status: early development. M4 is done: autonomous projects run from the terminal (plan, build in isolated git worktrees, test, cross-review, merge), on top of the desktop app's Accounts, Chat with a model and effort picker, and Council. Gemini is detected but needs `GEMINI_API_KEY`.

## Bring your own CLI

Conclave never asks for your passwords, API keys or tokens. It drives the official CLIs that you install and sign in to yourself, so every request runs under your own account and each provider's own terms:

| Provider     | Install                              | Sign in                 |
| ------------ | ------------------------------------ | ----------------------- |
| Claude       | `npm i -g @anthropic-ai/claude-code` | `claude`, then `/login` |
| OpenAI Codex | `npm i -g @openai/codex`             | `codex login`           |
| Gemini       | `npm i -g @google/gemini-cli`        | set `GEMINI_API_KEY`    |

## Desktop app

```bash
npm install
npm run desktop                  # opens the app (dev mode with hot reload)
CONCLAVE_DEMO=1 npm run desktop  # offline demo with fake providers, costs nothing
npm run e2e                      # build, then drive the real app with Playwright
```

## Terminal

```bash
npm install
npm run conclave -- doctor --live                 # which AIs are connected
npm run conclave -- chat                          # interactive chat; /use codex switches mid-chat
npm run conclave -- chat --use claude:opus "..."  # one-shot message
npm run conclave -- ask "..."                     # council: everyone answers, one merged result
npm run conclave -- threads                       # history, stored in ~/.conclave/conclave.db
```

## Autonomous projects

Give Conclave a git repo, a goal and a test command. It works until the goal is met:

```bash
conclave project new ~/code/my-lib --goal "Add a slugify function with tests" --test "npm test"
conclave project run <id>        # plan → build → test → review → merge, round after round
conclave project status <id>     # tasks, approvals and recent activity
```

Each round, one AI plans small tasks, another builds each task in its own git worktree, your test command must pass, and a _different_ AI reviews the diff before it merges into `conclave/integration`. Failed tests and review comments go back to the builder as feedback. Your own branch and files are never touched. When the goal is met, the work waits for you to merge it.

The governor reads each subscription's usage and moves work to another provider, or sleeps until a limit resets, so a project can run for hours or days. Every step is recorded, so a run that is interrupted resumes where it stopped. Choose who does each job with `--planner`, `--builder` and `--reviewer` (for example `--builder codex@low,claude:sonnet`).

## Development

Requires Node.js 22.13 or newer (for the built-in `node:sqlite`).

```bash
npm install
npm run check      # lint, format check, build, tests
npm run conclave -- --help
```

## Layout

```
packages/shared   event and provider schemas (zod), shared by everything
packages/core     the engine: adapters, chat, council, brain, governor, store
apps/cli          the `conclave` command
apps/desktop      the Electron app (main process runs the engine; React UI)
docs/             architecture and plan
```

## Roadmap

| Milestone | Delivers                                                           |
| --------- | ------------------------------------------------------------------ |
| M0        | Monorepo scaffold, CI                                              |
| M1        | Claude, Codex and Gemini adapters; `conclave doctor`               |
| M2        | Store, chat and council from the terminal                          |
| M3        | Desktop app: accounts and sign-in, chat with model picker, council |
| M4        | Worktrees, governor, guardrails, autonomous brain loop             |
| M5        | Projects, approvals and usage screens                              |
| M6        | MCP server, API-key mode, installers, first release                |

See [docs/PLAN.md](docs/PLAN.md) for the full design.

## License

MIT
