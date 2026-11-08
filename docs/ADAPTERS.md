# Writing an adapter

An adapter puts one AI's official CLI behind Plenum's `Adapter` interface (`packages/core/src/adapters/types.ts`). Everything above the adapter layer sees only `AgentEvent`s (`packages/shared/src/events.ts`), never a CLI's own output. Plenum never handles credentials: the adapter drives the CLI the user installed and signed in to.

## The kit (`packages/core/src/adapters/kit/`)

| Piece                                         | What it does                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runCli(provider, exec, process, parser)`     | Spawns (or replays), feeds each line to the parser, turns a failure with no reported error into an error or usage-limit event, ends with `done`. |
| `ClaudeStreamParser`                          | Base for Claude Code-style stream-json (Claude Code, Cursor): session from `system/init`, answer and failure from `result`.                      |
| `TypedEventParser`                            | Base for one-JSON-object-per-line CLIs with a type field (Grok Build, Copilot, OpenCode). Handle the types you need in `on()`.                   |
| `WholeTextParser`                             | For a CLI with no JSON output: all of stdout is the answer.                                                                                      |
| `failure(message)`                            | An `error`, or a `rate_limit` with `resetsAt` when the message reads like a usage limit.                                                         |
| `tokenUsage({input, cached, output})`         | Token counts in Plenum's convention: `inputTokens` is every input token, cache reads included.                                                   |
| `detectVersion`, `locateCli`                  | "Installed?" and where installers put the CLI, since PATH changes only reach new terminals.                                                      |
| `assertSafeModel/Effort/Session`, `safeImage` | Everything that goes on a command line is checked first.                                                                                         |
| `recordingExec`, `scrubLine`                  | Record a real run as a fixture, with paths, the account name and emails taken out.                                                               |

## Checklist

1. **Registry entry** in `packages/shared/src/registry.ts`: id, name, colour (run the palette validator), cost, install, lane cap, team preference. Add the CSS variable in `styles.css`.
2. **Detect:** installed and version (`detectVersion`), then signed in, by the cheapest command that needs an account (a status command, or a model list). Never read the CLI's credential files.
3. **Sign in:** `login()` returns the CLI's own login command; the app runs it in the built-in terminal.
4. **Run:** build the arguments in an exported `xxxArgs(request)` function so tests can check them. Prompt on stdin when the CLI allows it; on the command line otherwise, with a length limit.
5. **Events:** a parser on the kit. Emit `session` (for resume), `message.delta`, exactly one `message.done` on success, `tool.call` for each tool, `file.edit` for each file written, `usage`, and `error` or `rate_limit` on failure.
6. **Models and efforts:** `models()` from the CLI itself, never a list written into the app. Say what each effort level means if the CLI does.
7. **Permissions per level:** read-only for chat, planner and reviewer; level 2 edits files with no shell and no network; levels 3–5 as far as the CLI can enforce them. Anything it can't enforce goes in `permissionGap()`, with a sentence the team editor can show.
8. **Limits:** the CLI's usage-limit messages become `rate_limit` (check `looksLikeLimit` matches them), with `resetsAt` when the message says.
9. **Images:** `vision: 'native'` (attached to the prompt), `'files'` (it opens image paths named in the prompt; add their folders), or `'none'`.
10. **Resume:** `capabilities.resume` and `sessionId` handling, if the CLI can.
11. **Fixtures:** record real runs, at least a plain answer, an unknown model and a builder edit:
    ```bash
    npm run record-fixture -- <provider> pong
    npm run record-fixture -- <provider> unknown-model --model no-such-model
    npm run record-fixture -- <provider> edit --role builder --prompt "Add a line to README.md"
    ```
    Read each file before committing it. Parser tests replay them with `replay()` from `packages/core/test/helpers.ts`.
12. **Live smoke test** in `packages/core/test/live.test.ts`, skipped when the CLI is missing.
