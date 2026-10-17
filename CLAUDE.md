# Conclave: notes for AI agents working in this repo

- Design and milestones live in `docs/PLAN.md`. Build milestones in order; each one ends with `npm run check` green.
- TypeScript ESM monorepo (npm workspaces). Relative imports use `.js` extensions (NodeNext).
- Workspace packages export `src/*.ts` under the `development` condition (used by Vitest, tsx and `tsc` via `customConditions`), and `dist/` otherwise.
- Every adapter maps its CLI output onto `AgentEvent` in `packages/shared/src/events.ts`. Nothing above the adapter layer may depend on a specific CLI's output format.
- Never handle user credentials. Adapters drive the official signed-in CLIs; sign-in runs the CLI's own login flow.
- Tests use `FakeAdapter` or recorded fixtures in `test/fixtures/<provider>/`. Live CLI tests must skip themselves when the CLI is missing.
- Run `npm run check` before committing.
