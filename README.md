<p align="center"><img src="assets/repoq.svg" alt="RepoQ — One repository. One turn." width="720"></p>

# Local PR turns for coding agents

RepoQ gives each repository a waiting line. Your agent registers a pull request, ends its turn, and resumes when it is time to finish its merge workflow.

**Queue → yield → resume → claim → complete.**

It supports GitHub and Bitbucket Cloud PR URLs, Codex local desktop conversations, and local Claude Code sessions. Separate repositories progress independently. Clones and worktrees share the same queue when they use the same local state directory.

RepoQ schedules turns. Your agent still owns review, approvals, conflict resolution, validation, merge and deployment verification.

## Install

Requires **Node.js 24.13 or newer**, macOS or Linux, and an authenticated supported agent CLI. RepoQ has no third-party runtime packages; Node supplies SQLite, process management and argument parsing. TypeScript is compiled to JavaScript before installation.

```sh
git clone https://github.com/jesse-merhi/repo-queue.git
cd repo-queue
npm ci
npm run validate
npm pack
npm install --global ./repoq-0.1.0.tgz
repo-queue doctor
repo-queue start
```

There is no published npm registry release yet. Install the package built from the repository rather than an unrelated package with a similar name. See [installation](docs/installation.md) for a user-local prefix, agent skills and background startup. Existing Python-preview users must follow the [upgrade instructions](docs/installation.md#upgrade-from-the-python-preview) before switching dispatchers.

## Give a PR its turn

```sh
repo-queue add https://github.com/example/project/pull/42 \
  --agent codex --task CONVERSATION_UUID --cwd /path/to/worktree

repo-queue add https://bitbucket.org/example/project/pull-requests/7 \
  --agent claude --task SESSION_UUID --cwd /path/to/worktree

repo-queue status
```

The agent saves the returned entry ID and token, then ends its turn. The dispatcher sends the original conversation a message containing concrete commands:

```sh
repo-queue claim ENTRY_ID --token=TOKEN
# Run the existing authorized merge workflow.
repo-queue done ENTRY_ID --token=TOKEN
```

A claim succeeds once. Duplicate or stale notifications cannot start a second owner. Completion moves the next PR forward. Queue membership grants no new merge, publication or CI-spending authority.

After compaction or a resumed conversation, `verify-claim` confirms an existing claim using its token and the original agent, conversation and worktree. It does not claim again or change queue state. See [recovery](docs/operations.md#recover-a-failed-notification).

## When work stops

```sh
repo-queue block ENTRY_ID --token=TOKEN --reason 'Waiting for approval'
repo-queue retry ENTRY_ID --token=TOKEN
repo-queue recover ENTRY_ID --token=TOKEN --quiescent
```

Blocking retains the turn. Use `retry` after fixing a notification failure before claim. Use `recover` only after confirming that the old owner and its remote jobs have stopped. Both replace the token, so delayed messages cannot take over using an old token. Nothing releases a reservation merely because time passed.

See [operations](docs/operations.md) for failure recovery, logs and shutdown.

## Supported agents

| Surface | Wake mechanism | Requirement |
| --- | --- | --- |
| Codex, local desktop conversation | `codex queue` | Desktop remains running. Delivery can be delayed. |
| Claude Code, exited local session | `claude -p --resume` | Original process has exited; history and original directory remain available. |
| Claude Code, running local session | Native `SendMessage` from a restricted sender | Compatible local inbox and inbound settings; uses an extra sender model turn. |
| Claude Desktop, Code tab | Local Claude Code inbox when exposed | Requires a discoverable local session; not verified for every Desktop version. |
| Codex cloud, general Claude Chat/Cowork, remote sessions | Unsupported | No adapter for these conversation surfaces. |

Live Claude delivery uses the normal configured sender permission mode. Claude may hold or refuse messages, including when a session overrides that mode. RepoQ does not change receiver settings or retry automatically. Native acceptance is not proof the owner acted; the successful queue claim establishes that.

The native sender is exercised with Claude Code 2.1.269. It uses the built-in [cross-session messaging tools](https://code.claude.com/docs/en/cross-session-messaging). Exact targeting also validates Claude's local session registry, an implementation detail that can change; incompatible or stale records fail safely.

Live adapter tests are opt-in and may consume account usage. Automated CI uses simulated executables and never calls a model, merges a PR or dispatches provider CI.

## What the queue guarantees

- One reserved or claimed turn per repository in a shared local database.
- Durable FIFO order, single-use claims and explicit recovery.
- Independent progress across repositories and bounded delivery concurrency.
- No provider credentials stored by RepoQ. Agent CLIs use their existing authentication.

The queue coordinates one OS account on one machine. It does not stop people or other machines merging outside it, validate PR existence, or provide distributed locking. Tokens prevent stale operations; they do not isolate mutually untrusted programs running as the same OS user.

## Develop

```sh
npm ci
npm run validate
npm pack --dry-run
```

See [contributing](CONTRIBUTING.md), [verification](docs/verification.md), and [security](SECURITY.md). Licensed under [MIT](LICENSE).
