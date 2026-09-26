# Continue the claimed workflow

Before joining, save one run-owned checkpoint file outside the checkout. Pass its absolute path with `--checkpoint` to the applicable `submit` or `add` command. RepoQ stores the path and includes it in entry results and wakes; it does not copy or parse the contents. Keep that file available and update it at completed stage boundaries. Relative CLI paths resolve from `--cwd`. Registration fixes the locator: repeating registration may omit it or supply the same file, but cannot replace it.

Retain enough context to continue without reconstructing the task:

- Original PR, worktree and owner identity, authorized outcome and remaining human decisions. After registration, retain entry ID; keep the ownership token in the private conversation checkpoint.
- Last completed stage and next action, plus PR head, resolved target base and actual integration candidate commit/tree when known.
- Code-review run/database and report references tied to the current heads. Native submission requires completed review, security checks, local proof and required PR-head CI for every included PR. Record the explicit user queue instruction and its authorized scope. For a legacy local turn, record completed assessments and the remaining assigned phases; if impact is not yet assessed, make that assessment the next action. “Focused review needed” is not an assignment.
- Applicable validation/proof references and original tested identities, plus active command sessions or remote job IDs and their recovery locations. Distinguish completed checks from running work.

The file can be Markdown or structured data. Link the existing review and validation records rather than copying their policy or findings. For example, a **legacy local turn** after final integration may retain a pending assessment:

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

For that legacy continuation, once the code-review owner completes the assessment, the checkpoint can instead name its evidence and assignment: “Review the conflict resolution in authentication middleware and its session-expiry callers; reuse the unaffected credential-storage evidence referenced by assessment 18.” Preserve the previous and current candidates so the continuation can check that this assignment still applies.

A native checkpoint must instead identify a candidate ready for automatic submission: all included heads reviewed, required PR-head checks passed, security and local proof complete, and explicit user authority recorded. Re-read the included heads immediately before `submit`; a changed head needs its affected gates completed first. Native registration does not schedule a preparation wake. Keep the original authority and evidence when diagnosing an admission failure or ejection, and update the checkpoint with completed repairs and checks before `resume-native`.

On wake or resume, first follow the claim/verification rules in [RepoQ](../SKILL.md). Then compare the checkpoint's PR, owner, worktree and candidate with current facts. Recover running jobs before launching replacements. For a legacy turn after final target integration, or a native repair that changes the candidate, use the repository's code-review workflow to assess changed behavior and decide which evidence can be reused and which phases need focused or broader review. A queue claim or a saved assignment is not a clean code-review result. Do not restart all phases merely to reconstruct history, or reuse evidence without the review owner's applicability decision.

If the candidate changed after the assignment was made, obtain an assessment for the current candidate before using it. If the checkpoint or referenced evidence is missing, recover it from the original conversation and owning tools; if current state or coverage cannot be established, block with the specific missing evidence. Preserve completed results against the candidates they actually examined. An unavailable review capability does not authorize another policy or a new tool installation.

For legacy work, recheck candidate identity and repository delivery gates before merging, then save the merge outcome and outstanding jobs before `done`. For native work, finish those checks before submission or repair resume; GitHub confirms the merge and the runtime marks the entry done. Never use `done` to equate queue acceptance with merge. Waiting inside a claimed workflow does not gain a new wake subscription: retain its existing command/worker wait unless the harness guarantees a completion wake.
