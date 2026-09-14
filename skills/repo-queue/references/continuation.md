# Continue the claimed workflow

Before joining, save one run-owned checkpoint file outside the checkout. Pass its absolute path to `repo-queue add --checkpoint`. RepoQ stores the path and includes it in entry results and wakes; it does not copy or parse the contents. Keep that file available and update it at completed stage boundaries. Relative CLI paths resolve from `--cwd`. Registration fixes the locator: repeating `add` may omit it or supply the same file, but cannot replace it.

Retain enough context to continue without reconstructing the task:

- Original PR, worktree and owner identity, authorized outcome and remaining human decisions. After registration, retain entry ID; keep the ownership token in the private conversation checkpoint.
- Last completed stage and next action, plus PR head, resolved target base and actual integration candidate commit/tree when known.
- Code-review run/database and report references. If impact was already assessed, record the candidate assessed, decision evidence, reusable evidence, affected entry points/assumptions and scope assigned to each pending phase. If it was not assessed, make that assessment the next action; “focused review needed” is not an assignment.
- Applicable validation/proof references and original tested identities, plus active command sessions or remote job IDs and their recovery locations. Distinguish completed checks from running work.

The file can be Markdown or structured data. Link the existing review and validation records rather than copying their policy or findings. For example, after final integration:

```yaml
stage: integration-complete
candidate:
  head: <integrated-commit>
  base: <resolved-target-commit>
review:
  run: <existing-review-run>
  evidence: /runs/pr-42/review-report.json
  assessment: pending
jobs:
  - id: <existing-ci-run>
    candidate: <commit-tested-by-that-run>
    status: running
next_action: Assess integration changes against the previous reviewed candidate.
```

Once the code-review owner completes the assessment, the checkpoint can instead name its evidence and assignment: “Review the conflict resolution in authentication middleware and its session-expiry callers; reuse the unaffected credential-storage evidence referenced by assessment 18.” Preserve the previous and current candidates so the continuation can check that this assignment still applies.

On wake or resume, first follow the claim/verification rules in [RepoQ](../SKILL.md). Then compare the checkpoint's PR, owner, worktree and candidate with current facts. Recover running jobs before launching replacements. After the final target integration, use the repository's code-review workflow to assess changed behavior and decide which evidence can be reused and which phases need focused or broader review. A queue claim or a saved assignment is not a clean code-review result. Do not restart all phases merely to reconstruct history, or reuse evidence without the review owner's applicability decision.

If the candidate changed after the assignment was made, obtain an assessment for the current candidate before using it. If the checkpoint or referenced evidence is missing, recover it from the original conversation and owning tools; if current state or coverage cannot be established, block with the specific missing evidence. Preserve completed results against the candidates they actually examined. An unavailable review capability does not authorize another policy or a new tool installation.

Recheck candidate identity and existing repository delivery gates before merge. Save merge outcome and outstanding remote jobs before completion; use `done` only under RepoQ's normal completion rules. Waiting inside a claimed workflow does not gain a new wake subscription: retain its existing command/worker wait unless the harness guarantees a completion wake.
