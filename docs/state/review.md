# Review

## Review dispatch

Trusted watchers and dispatch supervisors consume lifecycle events as
software reactions. They run submission gates, dispatch review after the
tracked worker exits or while it waits as the PR's owner, run the tests gate
after passing review in the [gate order](gates.md#gate-order), accept independent
passing review, merge accepted
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
matches (tests after review, in the [gate order](gates.md#gate-order)), even with unknown mergeability. CI, review dispatch and merging
retain their mergeability guards.

## Review inbox findings

Review findings use the latest eligible failed evidence at the current head and revision. `review_failed.findings` contains the last `Review (Tower Crane` issue comment whose header names that SHA, read from all pages of the linked PR's comments. `finding_count` uses the finding lines or declared count and is null when an unposted summary has no count. `findings_source` names `comment` or `evidence`. A failed linked-comment fetch leaves `findings_complete: false`, the evidence summary and an explicit `github_error`. Unposted reviews without a matching comment retain their full evidence summary. Rework items include the engine reason and readiness blockers. Process observations use the shared PID, host and start identity detector; unknown processes stay live. Accepted PR items include GitHub state, mergeability and the refusal reason. A PR already merged at its accepted head remains an `accepted_unmerged` item with `confirmation: true` and `merge --accepted` until the audited local merge receipt exists. Its obsolete gate and review findings are replaced by that confirmation action. Reading the inbox does not record a merge, and a remotely merged different head still requires rework. Submitted PRs include uncapped, nonignored revuto failures and its inline comments at that head, and open CodeQL alerts from `refs/pull/N/head` and `refs/pull/N/merge`. The PR API resolves the current head, base and synthetic merge commit; both merge parents must match the submitted head and current base before merge-ref alerts count. Alert instances must match the resolved ref and commit. Stale merge parents produce an explicit GitHub error. Duplicate alerts across refs appear once. List endpoints paginate. GitHub errors are explicit findings, never empty success. A moved PR head returns to rework so a worker verifies and resubmits it through the existing claim ownership path.

`review_held` surfaces while automation holds review dispatch for a submitted task after a reviewer exited without a verdict at its head and revision. It carries the `review held` event's fields, with a default `reason` when the reviewer left none, and offers `accept ID`, which dispatches the next reviewer. A new head, revision, revuto thread change or review evidence clears it.

`review_exit_missing` shows each `review exit missing` event until `inbox --ack ITEM` acknowledges it.

`review_churn` surfaces when an active task has at least `review.churn_after` eligible failed reviews under its unchanged acceptance scope. It includes `count`, `churn_after`, the current task `revision`, `reviews` in evidence order and the task's full recorded `spend` so far. Each review keeps its SHA, revision, reviewer, timestamp, ref and one-line `findings`. Counts span heads and consecutive one-step revision increments recorded by `rework`; another revision bump, including an acceptance change, resets the count without deleting evidence. Stack refreshes preserve that reset even when their `previous_revision` points to a rejected review before the acceptance change: that field carries review context, not the actual prior task revision. Passing, waived, self and unspawned review evidence do not add to the count. Accepted and cancelled tasks have no churn inbox item. Rework and claiming still proceed unless the repeated-area gate below requires a scope ruling; the churn item then names that hold. The item asks the orchestrator to bound scope, split the task or change tier; its command opens `task show` for that decision.

History compares explicit one-based acceptance references (`Acceptance item 1`, `Acceptance line #1`, `AC 1`) and file:line finding locations in evidence summaries. `acceptance_lines` and `finding_locations` keep those references; `new_acceptance_lines` and `new_finding_locations` show references absent from earlier failed reviews. `scope_change` is `first`, `same_acceptance_lines`, `added_acceptance_lines`, `same_finding_locations`, `added_finding_locations` or `unknown`. Acceptance comparisons take precedence when both successive reviews name acceptance lines. Locations are hints about added cases, not proof that scope changed; free text without comparable references remains `unknown`. The inbox does not infer acceptance coverage from prose or fetch historical comments.

`status` text lists the churn count for every task; JSON adds `review_churn: [{id, revision, count}]`. The board shows the same count on rows for active agents and submitted work, ready and blocked rows and each task sheet, including zero after a reset. The Markdown sketch lists counts in its Review churn table. Counts are derived from evidence and rework events; no counter is stored in `tasks.json`.

## Repeated review failures

Two independent failed reviews with blocking findings in the same file area block claims, readiness and worker dispatch, including dry runs and explicit worker rungs. The area is a normalized finding file path: line numbers do not matter, `./` is removed and backslashes become slashes. A finding whose location is not a file path, such as `PR body`, adds no area. Failures accumulate across rework and requirement revisions. Failed verdicts at the same SHA and revision count once per area, whichever reviewers recorded them; multiple findings in one file in one review also count once. Passing reviews, follow-up-only verdicts (including old entries with stored areas), software gate failures and untrusted review evidence do not add failures. Follow-up-only verdicts also add no review churn, escalation or failed-review routing. A summary without a finding path supplies no area; use `rework --from-review` to retain the complete blocking findings.

The inbox shows `review_redesign` to the orchestrator (`addressed_to: "orchestrator"`) with `areas`, `reason`, `reviews` (each counted failure's `sha`, `revision`, `at` and first blocking `finding` in a held area), `since` (when the second failure in a held area was recorded), `priority`, `dependents` (open tasks that wait on it through dependencies), both clearing `commands` and a scope-ruling action, and holds the task out of `rework_ready`. `status` lists the held tasks on one `needs orchestrator:` line, urgent first and then longest waiting: `needs orchestrator: T3 [urgent] lib/inbox.js, waiting 2h; T1 lib/render.js, waiting 40m, blocks T2`. Its JSON `needs_orchestrator[]` has `id`, `title`, `priority`, `areas`, `reviews`, `since`, `waited_ms`, `dependents` and `commands`. The item and the line go away when the hold clears. The orchestrator or owner clears the hold by either narrowing acceptance to a closed list with `task update ID --acceptance A ... --closed-acceptance`, or recording a design change with `task note ID TEXT --kind scope-ruling`. Closed acceptance requires an actual acceptance change. Ordinary notes, acceptance changes without that declaration, brief edits and title changes do not clear the hold.

These actions audit the operational `task.scope_ruling` setting. Their task events carry `review_after`, the evidence-array length when the ruling is written; a closed-list update also carries `closed_acceptance: true`, and a design note carries `kind: "scope-ruling"`. Ruling events also record the task revision. Only failures recorded after that cutoff at that revision or later can trigger the next hold; late verdicts from older revisions cannot re-block the new design. The original evidence and rework notes stay in the audit history.

### Docs and small fix rounds

Submission compares the latest eligible independent review's head with the new
head. Automation repeats this preparation before software gates when a brokered
submit could not read repository metadata; carryover therefore precedes any suite
or local CI rerun. A passing or `followups_only: true` verdict carries across docs-only
changes. A failed verdict also carries when every blocker is explicitly a
`nit`, `doc-fix`, `title-body-fix`, or a disputed finding whose path is unchanged.
False claims confined to the PR title or body are clerical findings. Each code
hunk must fit a finding's named `path`, positive `line` and optional `end_line`.
Every undisputed code finding must have a hunk inside its own range; every
undisputed docs finding must name a changed file. Title/body findings require
verified correction through the automatic body fixer or the privileged metadata
flag, even when a round also changes docs or code. Unchanged findings need an
explicit dispute and reason.
A substantive docs finding, any unclassified blocker, a wider code hunk, a
binary or mode-only code change, or an instruction change keeps ordinary review.
A whole docs-only diff skips the tests suite even when its review needs another
round.

The default `review.docs_paths` is `["docs/**", "**/*.md", "changelog.d/**"]`.
A configured array replaces it; `[]` disables docs classification.
`review.docs_exclude` excludes matching paths, so a project can keep pinned
contract documents on its normal tests path. Directories named `prompts`, `agents`, `skills`, `commands` or `standards`
at any depth, including hidden harness directories, are always excluded.
House-rule files `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` and
`CLAUDE.local.md` at any depth are also excluded, even by custom docs rules.
These instruction path checks are case-insensitive and also forbid named-fix
carryover or attestation for instruction edits. Renames count both old and new paths. Missing commits,
unreadable diffs and rewritten history fail closed. An acceptance, dependency,
needs, kind or brief edit after the review prevents carryover; rework alone does
not. The reviewed commit must be an ancestor of the submitted head.

Each carried review is an ok entry for the new SHA and revision, with
`source: "review carry"`. `carried_from: {type, sha, revision, agent, at}` names
its source evidence; `reviewed_head` retains the original reviewed commit across
repeated rounds. `receipt` records `reason` (`docs only`, `title or body only`,
`fix round` or `attestation`), `files`, `docs_paths`, `docs_exclude` and
`diff_sha256`. A `review carry` event records the same entry. Eligibility requires
that matching event and eligible source evidence. An attestation also requires
the orchestrator or owner as its event author. Waivers do not carry.

Passing tests and CI used by that review carry as entries with
`source: "gate carry"`, the previous command receipts, `carried_from`,
`reviewed_head` and `carry_reason`, plus matching `gate carry` events. Their
command policy must still match. Acceptance queues no tests, CI or review rerun,
and the merge queue skips its test suite for carried tests or a docs-only tests
receipt. Cleanup still runs for the new head.

`check tests` independently reads the whole diff against the task's selected
base. If every path is docs, it records a `docs only` pass and
`receipt.docs_only: {base, full, files, docs_paths, docs_exclude}` without running
a suite. It runs the optional `gates.docs_cmd` instead, recording `docs_cmd` in
its receipt. `project set --docs-cmd CMD` sets that operational pin; `null` clears
it. When configured, docs-only submissions require the separate `docs` gate (`check docs`), whose
receipt records `docs_cmd` and whose audited commands prove the configured cheap
link or lint check ran. A failed docs check blocks acceptance. With no command,
the docs gate verifies the submitted commit and records that no optional command
was configured. Its runner uses the standard gate lease and timeout.

`evidence --fail --followups-only` records a review with no blocking findings;
it cannot be combined with `--findings`. Structured blockers accept optional
`line` and `end_line`. `submit` and `accept` accept `--disputes JSON`, an array of
`{finding, reason}` with unique positive, one-based finding numbers and nonblank
reasons. The disputed paths must stay unchanged. Carried review receipts keep
those reasons, and the orchestrator inbox exposes `review_dispute` as information
with an acknowledgement id, without blocking acceptance.

`accept --attest-fix REVIEW_SHA --reason R` is operational, restricted to the
orchestrator and owner. It attests exactly the latest review's named code fixes
and records `{from, by, reason}` in `receipt.attestation`, bound to the target
head and diff digest. An extra path, a hunk beyond its named range, or an
instruction edit refuses the attestation. `accept --metadata-fixed --reason R`
has the same authority for corrected PR title or body findings at the submitted
head. Other changes in that round must independently satisfy the named-fix checks. The automatic body fixer verifies its edit and unchanged checkout before
using the same carry path. Neither path dispatches a new reviewer.

## Runaway cost

A `spend` flag also opens one orchestrator decision for its task, the first time the wait host's refill pass sees it ([decisions.json](decisions.md#decisionsjson)). The question carries the flag's text (task total, worker count and the median it compares with), the task's revision and the main cause of its reworks: conflict reworks (cause `conflict_base` or `conflict_parent`, including a stack parent's conflicts and a CI CONFLICTING state, [Conflict hotspots](#conflict-hotspots)), review rounds (cause `review`) or gate failures (a `gate` rework, or cause `tests`, `clean`, `ci`, `head_check`, `coverage_gap` or `base_failure`), with every count. A rework of none of these kinds counts as other and is never the main cause. The decision blocks the task: the running worker keeps its claim and can submit, but no new round is claimed or handed back until someone answers it. A task gets one cost decision; answering it does not reopen one when spend keeps growing, and the status line keeps showing the flag.

## Conflict hotspots

A conflict rework records the files automation found conflicting as `conflicts` on its `rework` event: the merge line's head check, the conflict sweep after a merge and a mixed generated-file repair (the hand-written files left). A rework is a conflict rework when its recorded `cause` is `conflict_base` or `conflict_parent` ([rework causes](tasks.md)); a `manual` rework, or one recorded before causes existed, is classified from its reason the way `tower-crane metrics` does it, since the orchestrator often relays a conflict by hand. Without `conflicts`, the files come from the reason text (`PR #N conflicts with BASE: FILES. Merge the base...`, `... The merge is prepared ...`, or a stack sync's `Merge T1's resubmitted head SHA into T2; resolve conflicts in: FILES. Preserve the child commits...`); a conflict that names no file, such as a CI CONFLICTING state, counts toward the main cause but toward no file. A stack sync that sends a child back for conflicts with its parent's resubmitted head checks the threshold in the same write, as an automation conflict rework does.

For each task, every conflict rework since its last hotspot decision adds one to each file it names. When the rework being written takes a file past the threshold and the task has no open hotspot decision, the same write opens one ([decisions.json](decisions.md#decisionsjson)). The task still goes to `rework`, since its PR cannot merge, but the decision blocks it: refill does not dispatch a worker and a waiting owner is not handed it back ([PR owners](tasks.md#pr-owners)). The orchestrator answers:

- `merge pause`: set `merge pause ID --minutes N --reason R` and answer; the next round's submit holds other merges ([Merge pause](gates.md#merge-pause)).
- `split`: split the work so the hot files land in a smaller task, and cancel or narrow this one.
- `keep reworking`: the count starts again from the decision, so another threshold's worth of conflicts opens the next one.

The threshold is the nearest-rank 90th percentile, over every task with a conflict rework in the event log, of the count of the file that task conflicted on most. With fewer than 10 such tasks it is 3. On 2026-10-23 this project's log held 380 conflict reworks over 136 tasks: the worst file came back once for 82 tasks, twice for 26, three times for 19, and four times or more for 9, T499 among them with docs/state.md 18 times. The 90th percentile was 3, so a task trips on its fourth conflict on the same file, where 93% of tasks had stopped.

`status` lists `hot files: FILE (TASK N conflict reworks, DID open); ...` for tasks not yet accepted or cancelled, from each one's latest hotspot decision; JSON `conflict_hotspots: [{file, tasks: [{id, count, decision, status}]}]`.
