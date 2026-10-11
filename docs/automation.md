# Orchestration automation

The 2026-10-07 dogfood audit uses `events.jsonl` and task notes in the
project state. At 19:40Z the orchestrator had run 171 tests gates, 169 clean
gates, 156 CI gates, 43 accepts, 45 merges and 106 rework commands. These
are commands recorded in the log, not estimates of model turns.

| Manual step observed in the log or notes | Decision layer | Reason |
| --- | --- | --- |
| Run tests and cleanup after worker submission | software | Pinned commands, the submitted commit and gate receipts decide the result. |
| Wait for CI, check its completion, retry the CI gate after a rerun | software | GitHub check runs and suites at the exact submitted head decide the result. A completion notification can trigger the existing gate. |
| Dispatch review once software gates pass | software | The gate report, PR head and worker exit decide readiness. The reviewer still judges the code. |
| Inspect open PRs after another task merges | software | Mergeability and a trial merge identify conflicts. Git can list the conflicting files without interpreting their contents. |
| Resolve union conflicts in CHANGELOG lines, adjacent imports and doc rows | agent judgment | Even apparently independent additions may change order or meaning. Software sends the files to rework instead of resolving them. T86 removes shared changelog contention. |
| Resolve semantic conflicts and explain how to keep both behaviors | agent judgment | Requires understanding the code and acceptance. T90 notes name four conflicting files and the behavior to preserve. |
| Accept a passing review and merge a task with green gates | software | Existing acceptance and merge guards enforce revision, independent review, exact head and CI policy. |
| Re-read and resubmit a dependent stack head after GitHub rebases it | software | T94 owns stack reconciliation. A new head needs fresh gates and review; old evidence cannot be transferred blindly. |
| Run gates outside a worker sandbox | software | The trusted orchestrator command or supervisor executes gates. The broker remains unable to run worker-controlled commands. |
| Post an independent review when a reviewer cannot comment | software | Transport and authorization can be checked mechanically; producing the review is agent judgment. |
| Distinguish task changes from files changed only on main | software | A diff from the newest merge base provides the scope; T95 owns the reported scope defect. |
| Claim, renew, release, detect an exited worker, collect usage and link a stack | software | Lease, process identity, usage receipts and dependency records determine these operations. Existing supervisor and stack commands own them. |
| Retry transient harness/provider failures or change to a configured fallback | software | Structured error envelopes, retry limits and the ladder decide it. No interpretation of a quoted tool error is needed. |
| Detect a stall and choose whether to retry, re-tier or split the task | agent judgment | Detection is software. Recovery depends on the work attempted and why it stalled. |
| Select review rung from tier, diff risk and finalized usage samples | software | Existing review policy applies reproducible rules. A live usage sample must not influence the cost median; T93 owns that defect. |
| Review code, investigate revuto findings and decide whether they block | agent judgment | T59, T83, T90 and T93 notes describe correctness findings and false positives needing reproduction and code understanding. |
| Classify a short progress message or summarize an already established failure | small model | A bounded summary can save orchestrator context, but cannot waive a gate or infer a successful result. |
| Read owner input, edit acceptance and plan dependencies | agent judgment | Product intent, task boundaries and priorities come from the owner. Software validates the graph and records revisions. |
| Set model defaults, budgets, sandbox rules, permissions and gate waivers | agent judgment | These are owner or operational decisions under the authority table. Software enforces that table and records approvals. |
| Answer a blocked worker, deliver rework notes and update its brief | agent judgment | The answer may change product behavior. Message delivery and brief persistence are software. |
| Fetch main, merge a clean base update, push and refresh a PR | not needed | Evidence binds to the PR's diff and GitHub's `pull_request` run tests the merge ref, so a clean base update adds nothing. The merge queue checks the head of the line against the current base. A conflict returns to agent judgment. |
| Rerun a flaky CI job | agent judgment | Completion handling is software. Deciding that a failure is flaky requires evidence; automation does not conceal a failing job. |
| Remove finished runner/review worktrees and remote branches | software | Verified process exit, merge state and retention policy determine cleanup. Existing worktree and merge commands own it. |
| Inspect the board, capture UI evidence and assess usability | agent judgment | Browser transport is software, but appearance and interaction quality need inspection. |
| Release and publish | agent judgment | The owner approves publication. Packaging checks and executing the approved release are software. |

## Event reactions

T34 implements submission gates, CI refresh, conflict rework and automatic
merge through existing CLI commands and the event watcher. It adds no
daemon or polling loop. CI completion is delivered to the CLI by an
external notification; its payload is a hint to query GitHub, never gate
evidence.

The trusted `wait` watcher consumes submissions and catches up active PRs
on startup through fresh reconciliation requests. Completed reaction
receipts do not suppress checking current mergeability, so conflicts
after a missed merge sweep still go to rework. Tests, cleanup and source
verification run at a matching submitted head while mergeability is
unknown; CI, review and merge retain their guards. Before any of them run,
an UNKNOWN read is repeated for a few seconds. A PR that GitHub then reports
CONFLICTING goes to rework with its files and runs no suite.
The dispatch supervisor handles submission and review after
agent exit even without a waiter. Native workers without an exit receipt
use explicit `accept` for review dispatch. `ci completed ID --sha SHA` and
`ci webhook FILE` receive host completion notifications. A host integration
must deliver those notifications; Tower Crane does not install a webhook
listener. Concurrent consumers serialize reactions per task using audited
event receipts and drain queued notifications. The orchestrator can move a
task's queued gate work to the front with `gates prioritize` ([state](state.md#eventsjsonl)).
Supervisors use the dispatcher's command PATH and an explicit trusted
authorization context. Unknown mergeability and transport errors remain
retryable at startup. A remote merge completed before its local receipt
is recovered through the merge gate's accepted-head confirmation.

Software gates run again when their passing evidence no longer matches its
inputs, such as the pinned command or tests policy. A failed `tests`, `clean`
or `ci` gate at a submitted head does not wait. A timeout, a runner killed by a
signal or a CI run that timed out runs the gate once more at the same head. Any
other failure of a gate that ran, and a retry that fails too, sends the task to
rework with the gate's summary, which names the failing tests and their output
tail. A failure of a confirmed quality check on a task with a tier range is
escalation's: it sends the task back with a climb, as before. A gate that could
not run, such as a missing pinned command or a change with no test, stays
submitted for the owner to fix or waive.

Failures remain visible in gate receipts and task notes. Conflicting PRs
return to rework with a file list. Unknown mergeability, failed transport,
pending CI, moved heads and missing review never authorize a merge.
Stack-head reconciliation, scope calculation and changelog fragments stay
with T94, T95 and T86 respectively. Reconciliation preserves existing
evidence at an unchanged, mergeable head.

## Merge queue

After T85 merged, the orchestrator merged main into 15 open PRs. Each merge
made a new head, which reset every gate and ran 15 full suites, although
only the next PR to merge needed one. Evidence now belongs to the PR's own
diff at its submitted sha, and a base move alone keeps it. Accepted PRs
merge in acceptance order. Only the head of the line runs the full suite,
once, on its merge with the current base, and only when its head does not
already contain that base. A conflicting head goes to rework with its files.
The rest of the line waits without running anything.
A stack is one entry ordered by its lowest task, and its check runs on the
whole chain merged with current main. The executor fetches main again after
the check; only the seconds between that fetch and the merge call remain
unguarded. A head that is replaced, or an entry or setting that changes,
while the suite runs gets a new check before any merge or rework.
