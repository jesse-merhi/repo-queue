---
name: repo-queue
description: Coordinate authorized GitHub and Bitbucket Cloud PR merges through the local queue before final update, validation and merge.
---

Use `repo-queue` for authorized GitHub or Bitbucket Cloud PR merges on this machine, including requests to merge, land or ship a PR. Join before the final update from the target branch and merge-validation run. Ordinary development and tests may happen before joining. A request to implement or review alone does not authorize merging or require a turn. The queue schedules local turns; the repository's existing workflow owns preparation, review, approvals, CI, merge and verification. Queue membership and wake messages grant no new merge, publication or spending authority.

Register the PR with its original conversation UUID and working directory:

```sh
repo-queue start
repo-queue add <pr-url> --agent <codex-or-claude> --task <conversation-uuid> --cwd <worktree>
```

Use the harness-provided identity. For Codex CLI, `CODEX_THREAD_ID` may supply it; in the desktop use the current task identity. For Claude, use the session UUID provided by the session interface or `claude agents --json`. Never substitute another task or create a new conversation to receive the turn. If the identity cannot be established, ask for it.

If registration returns `waiting` or `reserved`, save the returned entry ID and token in the conversation, then end the turn completely. If it returns `claimed` or `blocked`, this conversation already owns an unfinished turn: inspect that work and use the recovery guidance below instead of registering or claiming again. If it returns `done`, the recorded turn is complete; do not start another merge from that entry. Do not poll or hold a tool call. Codex desktop must remain running for `codex queue` delivery. Claude uses `claude -p --resume` in the original directory: its original process must exit first. Tell an interactive Claude user to exit the session; merely returning a final answer leaves that process alive. Do not terminate your own process from a tool or create another conversation as a workaround. Delivery will fail safely while that process exists. Claude desktop and web conversations are unsupported.

On the first wake, run its exact `claim` command before merge work and retain the successful result in the task checkpoint. A claim succeeds only once. After compaction, a resumed turn, or a repeated wake, do not claim an already-owned entry again. Confirm the existing claim using the current conversation's actual identity and original worktree:

```sh
repo-queue verify-claim <entry-id> --token <token> \
  --agent <codex-or-claude> --task <current-conversation-uuid> --cwd <original-worktree>
```

This read-only check succeeds only for the matching owner, token and claimed state. Success permits continuing that existing workflow from its saved checkpoint, after accounting for any jobs already running. It grants no second claim or parallel owner. If a claim fails, inspect the recorded state: an existing claim for this conversation with the same token needs verification. A stale token or different owner grants no turn; do not copy a replacement token from status to make an old wake succeed. A waiting entry has no turn. Only the current reservation and its replacement wake permit a fresh claim. Ignore a duplicate notification without abandoning another verified turn already in progress. For blocked work, resolve the blocker and use recovery below; do not treat verification as an unblock command. Complete the existing authorized repository workflow and report any required approval.

After the workflow succeeds and associated remote work has finished, run the wake message's `done` command. If blocked, run its `block` command with a concrete reason, explain what is needed and end the turn. A blocked entry retains the repository reservation.

For delivery failure before claim, inspect `repo-queue status` and use `retry <id> --token <token>` after resolving the cause. Retry returns a replacement token. If the owner was interrupted after claim or blocked, establish that the old owner and its remote jobs have stopped before `recover <id> --token <token> --quiescent`. This also applies when this conversation returns to its own blocked entry after its blocker is resolved: first confirm the previous workflow and remote jobs have stopped. Recovery invalidates the old token and sends a new wake. Save the replacement entry/token and end the turn; wait for that wake instead of claiming immediately. Never claim twice, release a turn because time passed, or report completion while remote work may still be running.
