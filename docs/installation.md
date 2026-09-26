# Installation and upgrades

## Build and install

Use a supported Node release (24.13+) on macOS or Linux. From a checkout:

```sh
npm ci
npm run validate
npm pack
npm install --global --prefix "$HOME/.local" ./repoq-0.1.0.tgz
```

Add `$HOME/.local/bin` to your PATH if needed. `repo-queue doctor` checks the runtime and agent executables without calling a model. At least the adapter you intend to use must be authenticated and available on the dispatcher's PATH.

The tarball contains compiled JavaScript and the agent skill. Once installed from the tarball, the command does not depend on the development checkout. Do not use a symlink to a disposable worktree for a permanent background service.

## Install the agent skill

Copy the complete `skills/repo-queue` directory to the appropriate directory, preserving other skills:

- Codex: `~/.codex/skills/repo-queue`
- Claude Code: `~/.claude/skills/repo-queue`

Inspect an existing destination before changing it. Preserve local modifications or another owner's skill, including stronger explicit-user queue authority; reconcile those changes into the chosen profile before replacing the installed entrypoint. The source has complete variants for GPT-5.6, GPT-6 Astra, Claude Fable 5.1 and Claude Opus 5. Select the matching `variants/*.md` file as the installed `SKILL.md`; do not change your model. `BASE.md` is the shared source for maintainers.

Materialize that selection by copying the chosen variant to the destination `SKILL.md`. If the destination `SKILL.md` is a verified RepoQ symlink, unlink it first so copying does not overwrite its target. npm tarballs omit the source symlink, so copying the extracted directory alone is not a complete skill installation.

New sessions discover the skill. For consistent automatic use, add this to your own global agent instructions:

> For authorized GitHub or Bitbucket Cloud PR merges, use the repo-queue skill even when I do not mention the queue. Finish native pre-submission gates before submitting; acquire a legacy local turn before final update, validation and merge. A request to implement or review alone does not authorize a merge or require a turn.

Do not replace your existing global instructions with this paragraph. Already-running conversations may retain older instructions. Local Claude Code sessions can remain open. RepoQ uses a short-lived native sender restricted to messaging tools, with the normal configured permission mode and no interactive permission prompts. This consumes an extra sender model turn; the receiving session's work also consumes usage. Exited sessions use the standalone resume adapter. Receiver inbound settings and per-session permission-mode overrides can hold or refuse a live wake; installation does not change them.

## Background operation

```sh
repo-queue start
repo-queue status
repo-queue stop
```

`start` detaches from your terminal. Run it again after login or reboot; repeated starts are safe. The skill calls it before registration. `serve` runs in the foreground for a process supervisor, which should run it as the same OS user with the same PATH and state directory as your agents.

State defaults to `~/.local/state/repo-queue`. Set `REPO_QUEUE_STATE` or pass `--state` for another location. All participants must use the same directory. Keep it on a local filesystem, never a network share. It contains conversation IDs, paths, PR URLs and tokens; do not commit or share it.

Register each PR from its original harness environment. New entries retain that owner's configuration directory (`CODEX_HOME` or `CLAUDE_CONFIG_DIR`, including the default when unset). Claude entries also retain whether `CLAUDE_CONFIG_DIR` was explicit. Relative roots resolve against the original worktree. One dispatcher can serve separate harness installations. Delivery uses the saved directory and, for Claude, its saved environment mode; it does not copy credentials or change global settings. This distinction matters because Claude keys macOS Keychain credentials by `CLAUDE_CONFIG_DIR`, even when an explicit value resolves to `~/.claude`. Legacy entries keep their previous behavior because the saved path alone cannot prove whether the variable was explicit. Existing Python entries lacking owner configuration metadata continue using the dispatcher's configuration until completed.

## Upgrade for native queues

Native support advances the queue database to schema 4. It adds native authorization and observation records without rewriting existing entries, ownership tokens, sequence, reservation states or owner configuration. All existing entries remain legacy, including waiting, reserved and claimed work. Duplicate `submit` cannot convert them. Let their original owners finish the legacy flow; do not cancel active owners to accelerate a cutover. Unrelated native work is independent of those local reservations; overlapping PR scopes retain their existing owner.

Before **any new CLI command opens live state**, pause registration, save a private status snapshot with the old executable, stop the old dispatcher, and verify it stopped. Confirm outstanding adapter processes and preserve their delivery ledger. Back up the stopped state directory, build and validate the new package, install its tarball and matching skill, then start once and compare IDs, tokens, order, states and owner metadata against the snapshot. `start` alone does not replace a running dispatcher. This upgrade does not grant authority to interrupt owners or remote jobs.

Old commands reject schema 4 instead of processing native work as legacy turns. An already-running old process has already opened its database, so it **must** be stopped before upgrading. Do not run mixed versions. Rollback is not a database downgrade: restoring the pre-upgrade backup is safe only before any post-upgrade registrations, delivery, claims or provider submissions. Otherwise retain schema 4 and reconcile all post-upgrade work first; restoring a stale backup could duplicate a live queue request or lose an owner. Never delete native records or lower `user_version` to force an old binary to run.

Native GitHub operation requires authenticated `gh` on the dispatcher PATH, PR and GraphQL access to the actual target branch’s native queue, and Contents write permission for the asynchronous merge API. The shipped adapter targets github.com, including Enterprise Cloud; Enterprise Server hosts are not supported. It never changes branch rules or CI configuration. Deploy required `merge_group` validation before enabling a repository’s native queue.

Previously accepted, unclaimed desktop wakes are not reactivated by an upgrade. The saved desktop flag and original task remain unchanged; inspect that task before intervening. Do not rotate tokens or resend accepted messages solely because the dispatcher changed. If a wake still contains an old executable path, first inspect the original entry, delivery and claim state. Then use the current installed CLI with the same original owner and token: `claim` only an unclaimed reservation, or `verify-claim` for an existing claim. Never rotate the token or claim twice merely because the executable path changed. Do not run a schema-3 command against schema 4.

## Upgrade from the Python preview

The current TypeScript version migrates existing SQLite state to schema 4 without changing IDs, order or tokens. The schema-4 compatibility and rollback boundaries above also apply here. Its dispatcher lock differs, so never run both dispatchers on one state directory.

1. Ask participating agents to pause new registrations during the upgrade. Use the **old** command to save status, including every unfinished entry's ID and token. Let claimed work finish or explicitly resolve it; do not release reservations while work is still running. A delivered message may still be waiting in a conversation's inbox.
2. Run the old `repo-queue stop`, then use the old `repo-queue status` to verify `dispatcher_running` is false. Stopping the dispatcher does not terminate agents it already launched.
3. Back up the state directory after writers have stopped. Record the resolved path of the old executable and retain that checkout. If the install destination is a verified RepoQ Python symlink, move that link to an unused backup name before npm installs its replacement. Do not remove its target or overwrite a foreign command.
4. Rename the old `dispatcher.lock` file within that state directory to `dispatcher.python-stopped.lock`. The new dispatcher refuses to start while the old filename exists. Rename only after verifying that the old service has stopped.
5. Install the new tarball and matching skills, then run `repo-queue start` and `repo-queue status`. Compare the saved IDs, tokens, order and reservations. Pending entries can be delivered; previously sent entries keep their existing wake message.
6. Inspect any `uncertain` or failed delivery in the original conversation. A successful claim/done remains authoritative even if delivery bookkeeping was interrupted. For an unclaimed reservation, resolve the delivery cause and use `retry` with its current token; for claimed or blocked work, establish that the old owner and remote jobs have stopped before `recover --quiescent`. These operations replace the token so delayed messages cannot claim an old turn. Never retry merely because delivery is taking time.
7. Resume registrations after reconciliation. Retire the old executable only when every unfinished entry from the saved snapshot has completed or been recovered with a new token, and no old agent process or queued wake still needs its absolute path. Otherwise keep it available.

The new dispatcher uses a separate SQLite lock database. A crash releases the process lock while PR reservations remain durable. Notifications left in flight become uncertain and need explicit recovery; the new dispatcher does not automatically resend them.
