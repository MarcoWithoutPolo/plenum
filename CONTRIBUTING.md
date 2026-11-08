# Contributing to Plenum

Thanks for helping. Bug reports, fixes and new CLI adapters are all welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. **Settings → About → Export logs** saves a
text report (versions, each AI's state, recent events; no prompts or answers) with anything that looks like a key or
token and your user folder removed; read it, then attach it if you're happy to. Please don't paste
anything from your CLIs' own credential files.

For a security problem, don't open an issue: see [SECURITY.md](SECURITY.md).

## Setting up

You need Node.js 22.13 or later and git.

```bash
npm ci
npm run check        # lint, format, typecheck and unit tests
npm run e2e          # builds the app, then drives it in demo mode with Playwright
npm run -w @plenum/desktop dev   # the app with live reload
```

Demo mode (`PLENUM_DEMO=1`) uses fake AIs, so you can work on the app without any CLI installed or signed in.

## Ground rules

- **Never handle credentials.** Plenum drives the official CLIs that users sign in to themselves. No code may read,
  store or forward passwords, API keys or tokens, or read a CLI's credential files.
- **Adapters stop at the event format.** Each CLI's output is mapped onto `AgentEvent` in
  `packages/shared/src/events.ts`; nothing above the adapter layer may depend on one CLI's output. See
  [docs/ADAPTERS.md](docs/ADAPTERS.md) for adding one.
- **Tests don't call real AIs.** Use `FakeAdapter`, or record a CLI's output into `test/fixtures/<provider>/` (with
  paths, names and ids replaced by placeholders). Live tests must skip themselves when the CLI is missing.
- **`npm run check` passes** before you open a pull request. A UI change should keep the e2e suite green too.
- TypeScript ESM throughout; relative imports end in `.js`.

## Pull requests

Keep each one to one change, say why it's needed, and add a test that fails without it. By contributing you agree
that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of Plenum.
