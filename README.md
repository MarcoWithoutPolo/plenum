# Conclave

A desktop command center that runs the AI coding tools you already use (Claude Code, OpenAI Codex and Gemini CLI) together on one project.

- **Chat** with any of them, and pick or switch the model for each conversation.
- **Council**: ask all of them at once, see their answers side by side, and get one merged answer that shows where they agree and disagree.
- **Projects**: an autonomous "brain" that plans, builds, tests and reviews a repo for days. It splits work by role and model and paces itself against each subscription's usage limits.

> Status: early development. M2 is done: chat with Claude or Codex from the terminal (switch models mid-chat without losing context) and ask both at once with `conclave ask`. Gemini is detected but needs `GEMINI_API_KEY`, because Google no longer accepts individual sign-ins from its CLI.

## Bring your own CLI

Conclave never asks for your passwords, API keys or tokens. It drives the official CLIs that you install and sign in to yourself, so every request runs under your own account and each provider's own terms:

| Provider     | Install                              | Sign in                 |
| ------------ | ------------------------------------ | ----------------------- |
| Claude       | `npm i -g @anthropic-ai/claude-code` | `claude`, then `/login` |
| OpenAI Codex | `npm i -g @openai/codex`             | `codex login`           |
| Gemini       | `npm i -g @google/gemini-cli`        | set `GEMINI_API_KEY`    |

## Try it

```bash
npm install
npm run conclave -- doctor --live                 # which AIs are connected
npm run conclave -- chat                          # interactive chat; /use codex switches mid-chat
npm run conclave -- chat --use claude:opus "..."  # one-shot message
npm run conclave -- ask "..."                     # council: everyone answers, one merged result
npm run conclave -- threads                       # history, stored in ~/.conclave/conclave.db
```

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
apps/desktop      the Electron app (coming in M3)
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
