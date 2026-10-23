# Review

## Review dispatch

Trusted watchers and dispatch supervisors consume lifecycle events as
software reactions. They run submission gates, dispatch review after the
tracked worker exits or while it waits as the PR's owner, accept independent passing review, merge accepted
PRs with green gates, and detect conflicting outstanding PRs after merges.
Conflict rework names the hand-written files. Generated-file repair can
advance the worker branch or leave a mixed merge prepared. Native
workers without an exit record need explicit review dispatch.
A supervisor whose agent exited and whose exit is recorded leaves its own
reactions (its agent's `submit`, review evidence and `spawn exit`) to a live
`wait --follow` on the same host that runs reactions, found by its controller
record: it queues each one still owed as `automation queued` with
`handed_to`, the host's pid, and exits. The queue entry wakes that host and
outlives both processes, so any later trusted `wait` drains it. With no such
host the supervisor drains them itself, in a child process in the
dispatcher's environment, and exits when the drain ends.
A reviewer whose `spawn exit` receipt shows code 0, no signal and no
availability failure, with no review evidence at the current head and
revision, holds automatic review dispatch there: the next reviewer would read
the same inputs and stop the same way. A crash, a stop or an outage is
replaced as before, since retries, fallbacks and the harness health pause
cover those. Crashes are capped: once 3 reviewers dispatched at the current
head and revision have exited with a nonzero code or a signal and no review
evidence there, the last one holds dispatch the same way. Exits marked
`availability_failure` and reviewers stopped by an `interrupt` or a
`budget stop` do not count. A supervisor failure does count: its `spawn exit`
carries `supervisor_failed: true` beside `availability_failure`, since the
tool failed, not the provider. So does a dispatch with no receipt whose
monitor is no longer running; one whose monitor still runs is skipped, since
its receipt decides. At the cap a missing receipt is still reported with
`review exit missing`, and dispatch is then held. While the reviewer's process is gone, its
monitor is observed running and no receipt exists, no reviewer is dispatched;
the reaction to the receipt decides. That wait ends when the dispatch has not
been seen for the rung's `supervision.max_backoff_ms` plus 7 s of group
cleanup and a 1 min drain, or as soon as the monitor is not observed running.
The reviewer is then replaced and automation records one
`review exit missing` event, `{ "agent", "sha", "revision", "monitor",
"monitor_pid", "reason" }` with reason `reviewer monitor did not record its
exit`. The dispatch was last seen at the latest event of that agent on the
task: its spawn, retries, usage samples, hooks and notes. Dispatch resumes when the head or
revision changes, when the PR's revuto threads differ from the held
dispatch's `revuto` snapshot (a new finding or a new reply, checked on each
later reaction and on a `ci resolve` event), or when the orchestrator runs
`accept`. Automation records one `review held` event per held reviewer,
`{ "agent", "sha", "revision", "reason", "revuto", "exit" }`, where `reason`
is the reviewer's last report, note or message (null when it left none),
`revuto` names the blocking findings its dispatch recorded and `exit` holds
the receipt's code and signal. A hold at the crash cap adds `failures`
(the count), `cap` and `agents`, and its `reason` names the count, the held
reviewer (the one that ended last), how it ended and its log, and says that
`accept ID` dispatches the next reviewer. The event wakes the orchestrator.
Tests, cleanup and source verification run when the submitted PR head
matches, even with unknown mergeability. CI, review dispatch and merging
retain their mergeability guards.

## Review inbox findings

Review findings use the latest eligible failed evidence at the current head and revision. `review_failed.findings` contains the last `Review (Tower Crane` issue comment whose header names that SHA, read from all pages of the linked PR's comments. `finding_count` uses the finding lines or declared count and is null when an unposted summary has no count. `findings_source` names `comment` or `evidence`. A failed linked-comment fetch leaves `findings_complete: false`, the evidence summary and an explicit `github_error`. Unposted reviews without a matching comment retain their full evidence summary. Rework items include the engine reason and readiness blockers. Process observations use the shared PID, host and start identity detector; unknown processes stay live. Accepted PR items include GitHub state, mergeability and the refusal reason. A PR already merged at its accepted head remains an `accepted_unmerged` item with `confirmation: true` and `merge --accepted` until the audited local merge receipt exists. Its obsolete gate and review findings are replaced by that confirmation action. Reading the inbox does not record a merge, and a remotely merged different head still requires rework. Submitted PRs include uncapped, nonignored revuto failures and its inline comments at that head, and open CodeQL alerts from `refs/pull/N/head` and `refs/pull/N/merge`. The PR API resolves the current head, base and synthetic merge commit; both merge parents must match the submitted head and current base before merge-ref alerts count. Alert instances must match the resolved ref and commit. Stale merge parents produce an explicit GitHub error. Duplicate alerts across refs appear once. List endpoints paginate. GitHub errors are explicit findings, never empty success. A moved PR head returns to rework so a worker verifies and resubmits it through the existing claim ownership path.

`review_held` surfaces while automation holds review dispatch for a submitted task after a reviewer exited without a verdict at its head and revision. It carries the `review held` event's fields, with a default `reason` when the reviewer left none, and offers `accept ID`, which dispatches the next reviewer. A new head, revision, revuto thread change or review evidence clears it.

`review_exit_missing` shows each `review exit missing` event until `inbox --ack ITEM` acknowledges it.

`review_churn` surfaces when an active task has at least `review.churn_after` eligible failed reviews under its unchanged acceptance scope. It includes `count`, `churn_after`, the current task `revision`, `reviews` in evidence order and the task's full recorded `spend` so far. Each review keeps its SHA, revision, reviewer, timestamp, ref and one-line `findings`. Counts span heads and consecutive one-step revision increments recorded by `rework`; another revision bump, including an acceptance change, resets the count without deleting evidence. Stack refreshes preserve that reset even when their `previous_revision` points to a rejected review before the acceptance change: that field carries review context, not the actual prior task revision. Passing, waived, self and unspawned review evidence do not add to the count. Accepted and cancelled tasks have no churn inbox item. Rework and claiming still proceed unless the repeated-area gate below requires a scope ruling; the churn item then names that hold. The item asks the orchestrator to bound scope, split the task or change tier; its command opens `task show` for that decision.

History compares explicit one-based acceptance references (`Acceptance item 1`, `Acceptance line #1`, `AC 1`) and file:line finding locations in evidence summaries. `acceptance_lines` and `finding_locations` keep those references; `new_acceptance_lines` and `new_finding_locations` show references absent from earlier failed reviews. `scope_change` is `first`, `same_acceptance_lines`, `added_acceptance_lines`, `same_finding_locations`, `added_finding_locations` or `unknown`. Acceptance comparisons take precedence when both successive reviews name acceptance lines. Locations are hints about added cases, not proof that scope changed; free text without comparable references remains `unknown`. The inbox does not infer acceptance coverage from prose or fetch historical comments.

`status` text lists the churn count for every task; JSON adds `review_churn: [{id, revision, count}]`. The board shows the same count on rows for active agents and submitted work, ready and blocked rows and each task sheet, including zero after a reset. The Markdown sketch lists counts in its Review churn table. Counts are derived from evidence and rework events; no counter is stored in `tasks.json`.

## Repeated review failures

Two independent failed reviews with blocking findings in the same file area block claims, readiness and worker dispatch, including dry runs and explicit worker rungs. The area is a normalized finding file path: line numbers do not matter, `./` is removed and backslashes become slashes. A finding whose location is not a file path, such as `PR body`, adds no area. Failures accumulate across rework and requirement revisions. Failed verdicts at the same SHA and revision count once per area, whichever reviewers recorded them; multiple findings in one file in one review also count once. Passing reviews, software gate failures and untrusted review evidence do not add failures. A summary without a finding path supplies no area; use `rework --from-review` to retain the complete blocking findings.

The inbox shows `review_redesign` with `areas`, `reason` and a scope-ruling command, and holds the task out of `rework_ready`. The orchestrator or owner clears the hold by either narrowing acceptance to a closed list with `task update ID --acceptance A ... --closed-acceptance`, or recording a design change with `task note ID TEXT --kind scope-ruling`. Closed acceptance requires an actual acceptance change. Ordinary notes, acceptance changes without that declaration, brief edits and title changes do not clear the hold.

These actions audit the operational `task.scope_ruling` setting. Their task events carry `review_after`, the evidence-array length when the ruling is written; a closed-list update also carries `closed_acceptance: true`, and a design note carries `kind: "scope-ruling"`. Ruling events also record the task revision. Only failures recorded after that cutoff at that revision or later can trigger the next hold; late verdicts from older revisions cannot re-block the new design. The original evidence and rework notes stay in the audit history.
