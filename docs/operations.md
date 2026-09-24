# Operations

## Inspect first

`repo-queue status` returns JSON containing dispatcher status and each entry's PR, owner, state, delivery status and recovery token. Its `delivery_attempts` list identifies retained slots by entry ID, dispatcher PID and child PID; a null child PID means the process was not yet recorded. Status also reaps tracked attempts whose dispatcher and child are both known to have exited. Store the output privately. `repo-queue doctor --agent codex` or `--agent claude` checks executable availability.

A successful notification means the adapter accepted a queued message, completed a resume command, or received a successful native Claude `SendMessage` result. The owner must still claim its turn. A macOS Codex desktop owner using the default `CODEX_HOME` opts in with `repo-queue add ... --desktop`. After Codex accepts that owner's message, RepoQ asks LaunchServices to open `codex://threads/<original task UUID>` in the background. This loads the exact desktop task so it can consume the already queued message; it sends no second prompt and keeps the same reservation and token. `open -g` can still change the selected task in the desktop window. CLI owners, custom `CODEX_HOME` owners, and Linux retain native queue acceptance plus the unclaimed alert. Claude may hold or refuse a message under its inbound settings. Neither native acceptance nor a successful desktop activation request proves that the owner loaded or claimed. The reservation remains held until the owner acts or it is explicitly recovered.

If the macOS activation request fails after native acceptance, `status` immediately includes `codex_activation_request_failed` in `delivery_alerts`; the queued message and reservation remain intact. For a Codex reservation still unclaimed five minutes after native acceptance, `status` includes `codex_claim_overdue`; the dispatcher writes one warning per accepted wake to its private log during that run. Five minutes is an attention threshold, not a delivery guarantee. These alerts show a claim gap, not proof that the wake was lost. Inspect the exact original task through the Codex app. If it is `notLoaded`, send one follow-up to that same task and confirm that it claims the existing entry. Do not launch a second owner, rotate its token, or repeat native sends while an earlier wake may still run. The alert disappears as soon as the original task claims, blocks, or completes. RepoQ cannot send an app notification from its standalone dispatcher; check `status` or the private dispatcher log when a turn seems stuck.

## Recover a failed notification

If the original conversation already claimed its turn and lost its checkpoint after compaction, verify that existing claim instead of claiming again:

```sh
repo-queue verify-claim ENTRY_ID --token=TOKEN \
  --agent codex --task CURRENT_CONVERSATION_UUID --cwd /original/worktree
```

Use the actual current conversation identity (`--agent claude` for Claude). The read-only command succeeds only for the matching owner, token and claimed state. Continue the saved workflow and account for jobs already running. A duplicate wake does not cancel an existing claim. A blocked entry still needs explicit recovery; verification does not unblock it.

Resolve authentication, missing executables, moved directories or incompatible native Claude messaging, then use `retry ID --token=TOKEN`. For a live Claude session, inspect its inbound-message notices: it may hold or refuse messages from the sender's normal configured permission mode. Do not change global settings, terminate the session or repeatedly retry to force delivery. Retry applies only before claim and replaces the token. A delayed old notification must fail its claim.

When the owner has already claimed or blocked, use `recover ID --token=TOKEN --quiescent` only after establishing that the prior owner and its remote work have stopped. Recovery preserves the repository's place in line, replaces the token and allows a new notification. There is no automatic lease expiry or silent takeover.

If an agent is waiting for a human approval, it should `block` with a reason and end its turn. The queue does not grant approval or decide that the work is finished.

### Reconcile an orphaned delivery slot

The delivery ledger survives dispatcher restarts. A recorded live process retains its slot; a known exited process can be reaped automatically. A crash between spawning a command and recording its PID leaves an unknown process. That slot stays reserved until its work is confirmed stopped. Reused PIDs are treated conservatively as live.

Inspect `repo-queue status` and the original agent's process and work before asserting quiescence. For an orphaned attempt belonging to an entry you are authorized to manage, use its current queue token:

```sh
repo-queue reconcile-delivery ENTRY_ID --token=TOKEN --quiescent
```

This command refuses live tracked processes and only clears the orphaned delivery accounting. It does not change the entry's state or token, release its repository reservation, send a wake, or authorize a claim. It also works for completed entries. If a new notification is still needed, follow the separate retry or recovery procedure above. Do not remove the ledger database to free slots.


## Shutdown and restart

`stop` requests dispatcher shutdown and waits up to five seconds for its lock to be released. It reports an error if shutdown is not confirmed; a successful return permits an immediate `start`. `serve` also handles ordinary termination signals. Already started agent processes may keep running; stop never marks their work done. Keep their reservations and confirm their state before recovery.

On restart, an abandoned `sending` notification becomes `uncertain`. Check the original conversation before retrying. If it acted on the message, continue that work rather than starting another owner. Late callbacks with an obsolete token cannot update a recovered entry.

Logs live in the private state directory. Avoid sharing raw output: PR URLs, working paths and conversation IDs can be sensitive. RepoQ does not store complete agent transcripts.

## Resource use

One dispatcher serves the state directory. It checks durable work once per second. A persistent delivery ledger limits direct adapter commands to four and serializes each owning session, including across dispatcher restarts. A surviving delivery keeps its slot until its process exits. This does not limit the receiving agents, their subprocesses or remote jobs. Idle operation does not run agent CLI commands. SQLite stores history on disk; the dispatcher does not retain transcripts in memory. Agent processes have their own resource use and can outlive the dispatcher.

Exact memory use depends on the Node release and host. Measure the installed process if you have a constrained machine; this project does not claim a fixed memory bound or that TypeScript removes the native runtime's memory-safety risks.
