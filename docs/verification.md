# Verification

`npm run validate` typechecks, compiles and runs the automated suite. Tests use temporary state directories and simulated agent executables; no real account access or PR merge is needed.

The suite covers provider URL parsing, shared queue identity, FIFO order across repositories, concurrent clients, token fencing, duplicate claims, read-only claim verification, blocked recovery, failed notification, dispatcher restart and the packaged command. Migration fixtures exercise the existing SQLite schema rather than copying production state.

The TypeScript implementation passed all 47 tests on Node 24.15. The package test installs the tarball into an isolated prefix and runs `repo-queue --version` outside the checkout. No Python runtime is required, including for the legacy SQLite migration fixture. Real-process regressions hold a shared status read during startup and verify that one dispatcher acquires its lease and delivers the turn. Concurrent starts run alongside eight status clients. A stop generation fences pending launches across lease release; tests require both competing processes to exit and invoke the actual CLI stop while a reader blocks acquisition, proving that the pending launch cannot start afterward. An immediate CLI stop/start then delivers newly queued work. Generated wake commands claim, verify and complete a turn with a leading-dash token; Claude discovery uses the owner directory independently of the dispatcher launch directory. Claude resume fixtures accept ordinary result objects and verbose event arrays while rejecting incorrect session identities or ambiguous results. A separate synthetic version-0 migration check preserved a mixed queue containing every state, existing tokens and order; interrupted sending became uncertain without releasing ownership.

The recovery test follows claim → rejected second claim → successful read-only verification by the same owner. Verification rejects stale tokens, different conversations, different worktrees and entries outside the claimed state. It leaves queue state unchanged.

A live Codex desktop exercise using the TypeScript dispatcher also completed registration → original-conversation wake → claim → done. The fixture entry ended in `done` with delivery `sent` and no error.

The TypeScript dispatcher also resumed an exited Claude Code fixture under its exact original session identity. Claude executed the generated Node-based claim and done commands; the entry ended in `done` with delivery `sent`. Both fixture dispatchers were stopped afterward.

A native Claude Code 2.1.269 exercise kept the original process open throughout registration → native `SendMessage` wake → claim → done. The queue independently recorded the original UUID and worktree with `done`/`sent`. The restricted sender used the normal configured permission mode. Linux identity fixtures use Claude's machine-ID and PID-namespace format and reject mismatched machines or namespaces. A separate mode-mismatch probe was held by Claude even though SendMessage reported success, confirming that native acceptance cannot be treated as owner action. All synthetic Claude processes and fixture dispatchers were stopped afterward.

An idle dispatcher sample on macOS with Node 24.15 reported 55,552 KiB resident memory and 0.0% CPU through `ps`. This is one observation, not a benchmark or resource guarantee; agent processes have their own resource use.

## Live adapter exercise

Run live tests only with an account whose usage you are authorized to consume. Use a dedicated local directory and a separate `--state` path. Never use real PRs for the test.

1. Start a dedicated conversation with a harmless marker. Allow only the local fixture queue commands. For live Claude, leave the session running after its turn; exercise exited-session resume separately.
2. Register a synthetic PR URL with that original conversation UUID and directory.
3. Ask the test conversation to execute only the supplied claim and done commands on wake. Do not let it contact a Git provider, run CI or merge.
4. Verify the original session received the wake and changed the fixture entry to `done`. For live Claude, verify the original process stayed running and the native peer message reached that session. Adapter acceptance alone is insufficient proof.
5. Stop the fixture dispatcher. Keep the live queue separate.

The original adapters were exercised successfully with Codex CLI 0.154.0 and Claude Code 2.1.269. Codex resumed an ended local desktop task. Claude resumed an exited local process under the same session identity. The live native exercise above verifies a still-open local Claude process separately. Neither test establishes support for a provider's cloud conversation surface.

Sources: [Codex app server](https://learn.chatgpt.com/docs/app-server), the installed `codex queue --help`, [Claude sessions](https://code.claude.com/docs/en/sessions), [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), and the installed `claude --help` / `claude agents --help`.
