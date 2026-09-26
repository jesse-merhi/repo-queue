<p align="center"><img src="assets/repoq.svg" alt="RepoQ — One repository. One turn." width="720"></p>

# PR queues for coding agents

RepoQ submits authorized PRs to GitHub’s native merge queue and wakes their original agent when readiness or repair work is needed. GitHub owns queue order, combined validation and merge. Repositories without a native queue keep RepoQ’s local waiting line.

**Queue → yield → resume → claim → complete.**

It supports GitHub and Bitbucket Cloud PR URLs, Codex local desktop conversations, and local Claude Code sessions. Separate repositories progress independently. Clones and worktrees share the same queue when they use the same local state directory.

Your agent still owns review, security gates, conflict resolution and repair. An explicit native queue authorization covers its required validation and merge; it does not authorize unrelated changes.

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

## Submit authorized queue work

```sh
repo-queue submit https://github.com/example/project/pull/42 \
  --agent codex --task CONVERSATION_UUID --cwd /path/to/worktree --authorize-merge
```

`submit` reads the effective rules for the PR’s target branch, or its native stack’s base. A required GitHub merge queue uses the stack-aware asynchronous merge API with `merge_action=merge_queue` and the saved head SHA. Add `--stack` only when all lower unmerged PRs through the selected PR are authorized. API errors fail safely; they do not select a local merge. GitHub bases without a queue and Bitbucket use the existing local turn flow.

Save the returned entry and end the agent turn. `status` exposes native authorization, scope, asynchronous request and provider state. Acceptance stays `admission_pending`; queue presence becomes `enqueued` or `validating`; removal or failure wakes the original owner. Repair with that wake’s claim/verify commands, then `resume-native ID --token=TOKEN`. It preserves authorization, records the repaired head and returns a new token. GitHub confirmation alone marks the entry `merged`/`done`. The runtime monitors every 30 seconds without model polling. Native repair work does not hold a repository-wide lock.

`add` explicitly retains the legacy local queue. Existing entries never silently change mode. See [native operation and limitations](docs/operations.md#github-native-queues) and the [schema upgrade](docs/installation.md#upgrade-for-native-queues) before upgrading a live dispatcher.

## Give a PR its turn

```sh
repo-queue add https://github.com/example/project/pull/42 \
  --agent codex --task CONVERSATION_UUID --cwd /path/to/worktree

repo-queue add https://bitbucket.org/example/project/pull-requests/7 \
  --agent claude --task SESSION_UUID --cwd /path/to/worktree

repo-queue status
```

For a macOS Codex desktop task using the default `CODEX_HOME`, add `--desktop` to load that exact task after native queue acceptance. CLI owners and custom-home tasks omit this flag. For a prepared review/merge workflow, add `--checkpoint /absolute/path/to/continuation.md`. RepoQ retains that file's path across wakes and recovery. The file links the reviewed candidate, impact assessment or pending review assignment, validation evidence, running jobs and next action. The agent writes and maintains it; RepoQ does not decide what code needs review. See [continuation guidance](skills/repo-queue/references/continuation.md).

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

For an unclaimable reserved GitHub entry whose PR is already merged, `complete-merged ID --token=TOKEN --quiescent --reason TEXT` verifies the exact remote merge and records why the turn was administratively completed. It requires a failed or uncertain delivery, no active delivery attempt, and a confirmed idle owner; it never merges a PR. See [operations](docs/operations.md#complete-an-unclaimable-merged-turn).

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

- One reserved or claimed legacy turn per repository in a shared local database; native repair turns progress independently.
- Durable FIFO order, single-use claims and explicit recovery.
- Independent progress across repositories and bounded delivery concurrency.
- No provider credentials stored by RepoQ. Agent CLIs use their existing authentication.

The queue coordinates one OS account on one machine. It does not stop people or other machines acting outside it or provide distributed locking. Native submissions validate provider identity and rules; legacy registration does not validate PR existence. Tokens prevent stale operations; they do not isolate mutually untrusted programs running as the same OS user.

## Develop

```sh
npm ci
npm run validate
npm pack --dry-run
```

See [contributing](CONTRIBUTING.md), [verification](docs/verification.md), and [security](SECURITY.md). Licensed under [MIT](LICENSE).
