# Verification

`npm run validate` typechecks, compiles and runs the automated suite. Tests use temporary state directories and simulated agent executables; no real account access or PR merge is needed.

The suite covers provider URL parsing, shared queue identity, FIFO order across repositories, concurrent clients, token fencing, duplicate claims, blocked recovery, failed notification, dispatcher restart and the packaged command. Migration fixtures exercise the existing SQLite schema rather than copying production state.

The TypeScript implementation passed all 31 tests on Node 24.15. The package test installs the tarball into an isolated prefix and runs `repo-queue --version` outside the checkout. No Python runtime is required, including for the legacy SQLite migration fixture. A real-process regression holds a shared status read during startup and verifies that the dispatcher still acquires its lease and delivers the turn; concurrent starts also run alongside eight status clients.

A live Codex desktop exercise using the TypeScript dispatcher also completed registration → original-conversation wake → claim → done. The fixture entry ended in `done` with delivery `sent` and no error.

The TypeScript dispatcher also resumed an exited Claude Code fixture under its exact original session identity. Claude executed the generated Node-based claim and done commands; the entry ended in `done` with delivery `sent`. Both fixture dispatchers were stopped afterward.

An idle dispatcher sample on macOS with Node 24.15 reported 55,552 KiB resident memory and 0.0% CPU through `ps`. This is one observation, not a benchmark or resource guarantee; agent processes have their own resource use.

## Live adapter exercise

Run live tests only with an account whose usage you are authorized to consume. Use a dedicated local directory and a separate `--state` path. Never use real PRs for the test.

1. Start a dedicated conversation with a harmless marker and ask it to end its turn. For Claude, allow only the local fixture queue commands and wait for the process to exit.
2. Register a synthetic PR URL with that original conversation UUID and directory.
3. Ask the test conversation to execute only the supplied claim and done commands on wake. Do not let it contact a Git provider, run CI or merge.
4. Verify the same session resumed, recalled the marker and changed the fixture entry to `done`, with successful delivery.
5. Stop the fixture dispatcher. Keep the live queue separate.

The original adapters were exercised successfully with Codex CLI 0.154.0 and Claude Code 2.1.269. Codex resumed an ended local desktop task. Claude resumed an exited local process under the same session identity. These results do not establish support for Claude's still-open interactive process or either provider's cloud conversation surface.

Sources: [Codex app server](https://learn.chatgpt.com/docs/app-server), the installed `codex queue --help`, [Claude sessions](https://code.claude.com/docs/en/sessions), and the installed `claude --help` / `claude agents --help`.
