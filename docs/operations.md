# Operations

## Inspect first

`repo-queue status` returns JSON containing dispatcher status and each entry's PR, owner, state, delivery status and recovery token. Store the output privately. `repo-queue doctor --agent codex` or `--agent claude` checks executable availability.

A successful notification only means the adapter accepted or completed the resume command. The owner must still claim its turn. Codex may accept a queued message while the desktop is unavailable to act on it; the reservation remains held.

## Recover a failed notification

Resolve authentication, missing executables, moved directories or the still-running Claude process, then use `retry ID --token TOKEN`. Retry applies only before claim and replaces the token. A delayed old notification must fail its claim.

When the owner has already claimed or blocked, use `recover ID --token TOKEN --quiescent` only after establishing that the prior owner and its remote work have stopped. Recovery preserves the repository's place in line, replaces the token and allows a new notification. There is no automatic lease expiry or silent takeover.

If an agent is waiting for a human approval, it should `block` with a reason and end its turn. The queue does not grant approval or decide that the work is finished.

## Shutdown and restart

`stop` requests dispatcher shutdown. `serve` also handles ordinary termination signals. Already started agent processes may keep running; stop never marks their work done. Keep their reservations and confirm their state before recovery.

On restart, an abandoned `sending` notification becomes `uncertain`. Check the original conversation before retrying. If it acted on the message, continue that work rather than starting another owner. Late callbacks with an obsolete token cannot update a recovered entry.

Logs live in the private state directory. Avoid sharing raw output: PR URLs, working paths and conversation IDs can be sensitive. RepoQ does not store complete agent transcripts.

## Resource use

One dispatcher serves the state directory. It checks durable work once per second and limits simultaneous delivery processes. Idle operation does not run agent CLI commands. SQLite stores history on disk; the dispatcher does not retain transcripts in memory. Claude model processes have their own resource use and can outlive the dispatcher.

Exact memory use depends on the Node release and host. Measure the installed process if you have a constrained machine; this project does not claim a fixed memory bound or that TypeScript removes the native runtime's memory-safety risks.
