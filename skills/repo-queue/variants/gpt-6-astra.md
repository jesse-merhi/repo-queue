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

On the wake message, run its exact `claim` command before any merge work. Only a successful claim permits work. If it fails, treat the message as duplicate or stale and end the turn. Complete the existing authorized repository workflow. If additional approval is required, report the blocker instead of treating the notification as approval.

After the workflow succeeds and associated remote work has finished, run the wake message's `done` command. If blocked, run its `block` command with a concrete reason, explain what is needed and end the turn. A blocked entry retains the repository reservation.

For delivery failure before claim, inspect `repo-queue status` and use `retry <id> --token <token>` after resolving the cause. Retry returns a replacement token. If the owner was interrupted after claim or blocked, establish that the old owner and its remote jobs have stopped before `recover <id> --token <token> --quiescent`. Recovery invalidates the old token and sends a new wake. Never claim twice, release a turn because time passed, or report completion while remote work may still be running.
