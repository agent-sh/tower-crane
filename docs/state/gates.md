# Gates

### Acceptance gates

Failed GitHub commands retain the child exit status, signal and startup error code and message in the gate evidence `summary`, including when stderr and stdout are empty.

`tower-crane accept` refuses unless the task's current revision has, at the submitted `sha`:

- `code` tasks: `tests` ok, `clean` ok, and `review` ok from an independent reviewer
- `research` tasks on any tier: `sources` ok and `review` ok from an independent reviewer
- other tasks: `review` ok from an independent reviewer
- any task with a PR, whatever its kind: `ci` ok as well

An independent reviewer is the owner, or a reviewer that `spawn` dispatched for that task at that sha and revision, never the submitter. Review evidence that does not count also does not hold back the review dispatch `accept` makes, does not raise the review rung and is not passed to a rework worker as a finding. The board keeps it in the ledger with a does-not-count reason; neither its pass nor its fail verdict sets the review gate indicator.

Tests modes change how `check tests` produces evidence, not which gates acceptance requires. A code task in mode `none` still needs audited tests evidence for its submitted sha, plus cleanup and independent review.

Successful tests evidence counts only when its audited `tests_mode` matches the mode currently resolved for the project and task kind. A mode change, a missing mode on older evidence or a malformed current policy needs a new tests check. The audit event must contain the same mode as the evidence; changing the mode in tasks.json alone cannot retarget evidence. Owner waivers still apply. Task views, board gate pips and evidence ledger (including accepted tasks), acceptance and merge use this same rule.

Before acceptance, `accept ID` runs missing or stale software gates in order: tests and clean for code, sources for research kind on every tier, then CI for every task with a PR. Tests and clean use the pinned commands. Without a test pin, missing tests in prove or run-only mode block acceptance. None mode records its audited tests result without a command. Optional `--cmd` and `--proof-cmd` must match the pins. Expensive prove uses the pinned template with the `{tests}` placeholder. Eligible current successful receipts are reused. Stale successful receipts, including local CI for an older submitted head or for a base that no longer contains its `base_sha`, run again through the same gate runner under the host governor. A local CI receipt whose base only moved forward is current and is reused. A voided gate (`voided: true`) checked nothing and runs again like a missing one. Other current failures or unaudited attempted receipts require an explicit `check` rerun. The progress message names the software gate being run and lists review separately. Results are recorded even if a later gate refuses acceptance. A head, revision or status change during a gate refuses the attempt. Review dispatch is guarded again under the state lock.

A gate that runs a command on this host (`tests`, `clean`, the [final review](#final-review), and `ci` with `ci.local` outside a hotfix) runs once per task, head and revision at a time. Before its command starts, it records a `gate run` event with `{type, sha, revision, source, phase: "running", deadline, pid, host, start_ticks, pidns}`, where `source` is `gate:<uuid>` and `deadline` is the start plus, for every timeout budget the run may use, the full timeout and one minute for the metadata queries around it (one minute when it plans none). A tests run in `prove` mode plans the head run, the scoped proof when `tests.expensive` is true, the reverted run and one shared base-step timeout budget; each of the first three adds one command per `tests.host_only` file tracked at the head, and each of those commands one [rerun](#gate-reruns). All selected base commands, worktree setup and cache waiting share the original full base command's timeout, so the lease counts that step once regardless of the number of test files, including generated files and the full-command fallback. When the host-only `git ls-tree` listing fails twice, its count falls back to the matching files in the checkout on disk under each glob's leading directories, skipping `.git` and `node_modules`. A `run-only` tests run plans the head run, its host-only commands, one rerun of each and the same shared base-step budget; `none` plans no test command. Each declared host probe adds one command at `gates.host_probe_timeout_min`, plus a metadata minute, in every mode. Head, proof and reverted commands each get `gates.tests_timeout_min`; selected base commands receive the remaining base-step budget. Clean plans one command at `gates.clean_timeout_min` and the final review one at `gates.final_review.timeout`. Local CI plans its command and its [rerun](ci.md#local-ci-reruns) on the same pinned merge (one command when `ci.local.rerun` is false), each at its resolved `timeout`. The same write that records its evidence records `phase: "done"` with `evidence_at`, the evidence's `at`, and `interrupted: true` when `wait` shutdown interrupted the run. A run that throws first records `phase: "error"` with `error`. When the orchestrator guard refuses that write because the orchestrator lease changed, the process records it as an engine write, or else with its next lease. `accept`, `check`, `gates retry` and automation reactions that reach the same gate while such a run is live join it instead of starting a second copy: they print `[TYPE] joining the TYPE run ...` naming its agent, pid, host and start, and, for a holder that cannot be observed, its deadline and the minutes left to it, follow the event log's tail for the lease's end, read its evidence and continue as if they had run it. `check --json` then carries the joined run as `joined: {source, agent, via, pid, host, at}`. A holder whose pid and Linux start ticks show it alive is waited for however long it runs, since a prove-mode tests gate runs several timed commands. A holder that cannot be observed (another host, macOS or Windows where no start ticks are recorded, no permission to signal it) is waited for until its deadline, so a healthy run of any length within its plan is joined, not run twice; past it, the caller prints that it treats the run as ended, runs the gate and records `replaces` with the old lease's source. A holder whose process has exited, a run that ended without evidence, and an interrupted run leave the gate to the caller. Hosted CI and `sources` read remote state and take no lease. `gate run` events are quiet bookkeeping: they wake no `wait` and do not count as stack state changes.

When software gates pass and no review has been attempted at the current head and revision, `accept` dispatches a reviewer and exits 0 with `review_pending: true` and its agent name in JSON; the task stays submitted. A repeated accept reuses a live review dispatch. Call accept again after review evidence arrives. A current independent FAIL makes `accept` exit 1 before software gates or another full review, returning `review_failed: true`, the failed `review` and the open local `inbox` item in JSON. The submitted task, head and revision stay unchanged. A new head, a new revision or `accept --retry-review` allows another review. The override is operational, requires an orchestrator or owner identity, and the reviewer's `spawn` event records `review_retry` with the failed review, head and revision. Review waivers cannot clear a current failed verdict with blocking findings, including PR-body false claims, even with `--retry-review`. The refusal is checked before and after software gates and under the acceptance lock before waiver evidence is appended. PR-body and title corrections use only the light path below. A real `spawn --role review` still runs `rework --from-review` and exits 1 for code failures. If the linked findings cannot be fetched or matched, they refuse and keep the submission unchanged. `spawn --role review` otherwise refuses until all software gates pass; `--dry-run` checks them for a submitted task without reworking it. For an unsubmitted task a dry run previews the fallback command only, and cannot dispatch a review.

Failed review evidence may include `findings`, a non-empty array listing every blocker as `{ "kind": "...", "path": "...", "claim": "..." }`, with non-blank strings and no other fields. A light check accepts false claims with `kind: "false-claim"` and `path: "PR body"`, `path: "CHANGELOG.md"` or a single Markdown fragment under `changelog.d/`. It also accepts incorrectly blocking findings at `PR title`, regardless of kind. PR title findings are follow-ups, never blockers or reasons for a full re-review. PR-body false claims remain blockers until verified; other metadata does not get the title exception. Every finding must qualify; mixed code blockers retain normal rework. The reviewer uses this kind only when a prose correction resolves the finding without changing behavior or a contract. Missing metadata, other kinds, other locations and mixed blockers keep the full review path. In particular, `docs/cli.md`, `docs/state.md` and `docs/state/` claims remain contract blockers.

When every finding is a PR-body false claim or a title finding, automation dispatches a worker restricted to editing the body and title. The base and other metadata stay fixed. The task stays submitted at the same revision and keeps its SHA and software evidence. False PR-body claims still block until fresh independent review evidence passes; the light reviewer treats unresolved title findings as follow-ups. `rework --from-review` refuses with correction instructions, without changing state. Submissions without a linked PR and recorded branch retain the explicit body edit and `accept` path.

PR-body repair uses the task worker rung and the supported worker session resume path. Its `spawn` event carries `body_fix` with the failed review snapshot, submitted head and revision, PR, branch, original body hash, `title` and `base`. It takes a worker reservation, not a claim, so the task stays submitted. Status shows `fixing PR body` while its repair or light check runs. The repair prompt replaces the ordinary worker workflow and carries its repair instructions once. The broker refuses commits pushed through it, claim and submit calls, and PR writes other than body and title edits. On exit, automation reads the current body, PR head, title and base and checks the local head and tracked checkout files before calling the light `accept` path. Untracked files, including a body file written for `gh pr edit --body-file`, do not block the repair. The base may match either the dispatch snapshot or the current expected target from `stack.targetBase`, allowing the engine or GitHub to retarget a dependent PR after its parent merges. This comparison uses state read after the GitHub request, so a concurrent parent merge counts. A moved head, changed tracked file or unexpected actual base branch enters normal rework, including for an unsandboxed harness.

Light checks use the ordinary reviewer exit policy. A retryable crash or outage, or a missing receipt after the monitor window expires, requests a replacement check at the same head without another body edit. A monitor that can still record its exit remains pending. A clean exit without a verdict or the three-crash reviewer cap holds dispatch and exposes `review_held`, even while the original body-only failure is the latest review evidence. Status stops showing `fixing PR body` for an exited, held reviewer. The item's `accept ID` action retries the corrected body's check after the cause is handled. Exits without a verdict do not count toward the two body-check failure limit.

The light reviewer spawn carries `body_recheck`, and its evidence records `body_recheck: true`. Two consecutive failed automatic body-only checks at the current head and revision stop further automatic repairs, leaving `review_body_stuck` in inbox with the latest summary, structured blockers and a `correction` hint to edit the body before running its `accept ID` action. The initial full review failure does not count, so two repair rounds fit. A fixer that makes no body or title edit also stops and supplies its reason, except an exit marked `availability_failure` gets one further repair dispatch with `body_fix.availability_retry: true`. Another exit without an edit stops; an outage after a successful edit still allows the light check. The `review body stuck` event preserves that stop across reaction replays and restarts. A passing verdict clears the stop for that submission. The orchestrator can correct the body and request another check with explicit `accept`; it can use ordinary `rework --reason` for code changes.

A prose-only failure that names `CHANGELOG.md` or a `changelog.d/` fragment needs a new head, so it goes through `rework --from-review` like any failure; the `rework` event records `from_review: true`. When the next revision is submitted with no eligible review yet, its review uses the latest eligible failed review of the previous revision, provided that `from_review` rework moved the task from it at the reviewed SHA. The light path then requires that the diff since that review changes only its named changelog fragments. A submitter may also resubmit a changelog-only head at the same revision before rework. The new head needs software gates as usual. Other changes, an unreadable correction diff, any other revision change, ineligible evidence and a later passing review restore full review. Prose-only failures do not escalate worker or reviewer rungs. Introduced security or data-loss defects still block.

Unfinished CI blocks dispatch without requiring rework. The orchestrator watches it through a gate runner, then re-runs `check ci` when it completes before accepting again. Reviewers judge code and acceptance; missing or unfinished CI evidence is reported to the orchestrator rather than recorded as a failed code review. Review policy and prices are operational: the orchestrator or the owner changes them, and a worker asks the orchestrator.

The reviewer receives the submitted diff, task acceptance, audited software gate results (including command receipts, sha, revision and tests mode) and only the brief's `## Reviewer` section. Claude and Codex put the role instructions, rule contents, standards and the repository's review contract sections in the system context; task JSON, brief, gates and diff stay in the user message. Claude writes it to `system.md` in its home and uses `--append-system-prompt-file` and `--exclude-dynamic-system-prompt-sections`; Codex uses its generated `AGENTS.md`. Repository rule labels are relative to the checkout, while external rule paths stay absolute, so moving to another worktree does not change unchanged contents. Every Claude spawn sets `FORCE_PROMPT_CACHING_5M=1`. See [ladder.md](../ladder.md#reviewer-cache) for the measurements and cost per million tokens.

For a task with a PR in a project with `repo`, review dispatch also reads the PR's inline review comments through `gh api repos/<repo>/pulls/<pr>/comments` and lists in a `## Revuto findings` section every top-level comment by a login named `revuto` or `revuto-<app>`, with or without `[bot]`, that GitHub still anchors to a line at the head: path, line, numeric inline comment id, body, marked `[P1]` or `[P2]` when the body carries that tag, and the id and resolution status of the latest reply by another login. A failed read refuses the dispatch. The reviewer's `spawn` event records them as `revuto: [{ "id", "path", "line", "severity", "commit", "url", "reply", "resolved", "changed" }]`, where `severity` is `P1`, `P2` or null and `commit` is the comment's original commit. `resolved` is true only when the latest non-revuto reply has `[resolved]` as its entire first line, case-insensitively; an explanation may follow on later lines. Ordinary discussion, quoted markers and later replies without the marker do not resolve the finding. `changed` records whether, at dispatch, `git --literal-pathspecs diff <commit> <sha> -- <path>` named the literal file for a `[P1]`/`[P2]` without such a resolution (false when it cannot be read). `evidence --type review --ok` at that sha and revision is refused, naming each comment, while a recorded `[P1]`/`[P2]` has neither `resolved: true` nor `changed: true`. The refusal tells the reviewer that the worker or the orchestrator resolves a finding with `ci resolve COMMENT_ID --reason TEXT`, which posts the `[resolved]` reply and records a `ci resolve` event `{ "comment", "pr", "reply", "sha", "revision" }`. Workers find COMMENT_ID next to path:line as `(comment ID)` in `ci checks`, submit reports and rework prompts. Rework worker dispatch, including dry runs and resumed attempts, reads current open inline findings before locking state and appends their ids, locations and bodies alongside the failed review evidence; a failed read refuses dispatch unless the agent's gh policy denies gh api, in which case the prompt reports that the findings are unavailable and dispatch continues. The saved dispatch snapshot retains the findings or their policy-denial notice when a fallback route rebuilds the worker prompt. Older snapshots without `resolved` cannot use a reply id alone to clear the finding. The check reads only the state, so brokered evidence, which runs no git, gets the same answer. `--fail` is always accepted.

Reviewers use the supplied tests, clean and CI results. They do not re-run the full suite unless they change something in a scratch checkout to probe a specific concern, and run only the affected tests for that probe. The submitted worktree stays read-only. Packets over 12,000 characters put the diff in a context file; the user prompt still carries task context, gate results and revuto findings. This bounds diff arguments, not the static system text or unusually large gate receipts. Software waivers requested in the same accept remain atomic with acceptance and cannot authorize a review spawn; use audited software gate evidence or an owner accept that also waives review.

Review packets include `## Review scope`. When the latest eligible independent verdict at the current revision failed, dispatch checks its blockers and supplies only the diff from its reviewed SHA. Rework can carry this scope across its revision bump: the latest rework event must end at the current revision, and the latest eligible review at its rejected `sha` and `previous_revision` must have failed. A brief, acceptance, dependency, needs or kind edit after the review resets the scope; rework without a matching failure stays full. The review evidence event must be present in the audit trail. Unrelated older reviews and ineligible verdicts cannot narrow dispatch.

The review `spawn` event adds `review_scope: {sha, revision, agent, summary, ref, reason, findings}`, with the prior review's identity and blockers, linked comment, rework request and recorded `findings` (`null` when the review recorded none), or `null` for full review. It also adds `review_floor: {sha, revision, agent, review_rung, review_level}`, the failed review that set the re-review's rung floor with that review's own recorded rung and level, or `null` when the review follows no failed review. A fallback full re-review has `review_scope: null` and a `review_floor`. The same scope appears in the packet and in short prompts referencing large packets. Scope changes during diff preparation refuse dispatch under the lock. The event also records `review_level`, the complexity level selection computed. The reviewed SHA must still exist, be an ancestor of the submitted head and contain the current merge base with the project base to narrow the diff. A missing reviewed SHA, rewritten history or base update gets a full review from the project base's merge base, excluding upstream changes. That fallback packet still names the failed review with its summary, comment, findings and rework request, and asks the reviewer to confirm each prior blocker. A narrowed review takes its risk and size from both the new diff and the whole change. Narrowed or fallback, a re-review runs at or above the failed review's `review_rung` and `review_level`, except that `min_rung: "review"` starts it on the `review` rung until a review fails at the current head and revision. It reports whether each prior blocker is fixed, then reviews the new diff. A defect the new diff causes blocks wherever it shows, including in unchanged code. Other newly noticed findings on already reviewed work are follow-ups unless they are security or data-loss defects introduced by the change. The current revision still requires fresh software gate evidence and an independent review at its submitted SHA; the prior verdict supplies context only.

A gate passes when the latest eligible evidence of its type for the current revision, at a sha matching the submitted one, is ok. Shas match when one is a prefix of the other and the shorter has at least 7 characters. For `tests`, `clean`, `sources` and `ci`, evidence needs the matching gate `source` and an events.jsonl entry with `cmd === source`, the same task id and agent, and matching `type`, `source`, exact evidence `sha`, `ok`, `revision`, `commands` and optional `confirmed_failure` in `detail`. An ok entry also needs a non-empty commands list. Manual, forged and older unmarked entries are ignored, including later entries that would otherwise override a genuine pass or failure. For `review`, an entry counts only when its agent is `owner` or has a `spawn` event with `role: reviewer` for the task, at a sha matching the entry's and at the entry's revision, and is not the submitter. Recording review evidence needs no role, so a name no review dispatch started counts for nothing; its entry is kept, `task show` marks it `(does not count)` and the review gate names its agent. A waiver counts when its agent is `owner`; when the orchestrator recorded an operational waiver (`waive.review` for a capped or down reviewer); or when the orchestrator recorded it with `approved_by` naming an escalation the owner approved ([Authority](decisions.md#authority)).

Local CI adds `receipt` to its evidence and event detail. Both copies must match exactly:

```json
{
  "variant": "default",
  "command": ["python3", "tools/check.py"],
  "timeout": 120,
  "exit": 0,
  "signal": null,
  "head_sha": "<full submitted commit SHA>",
  "base_sha": "<selected base commit SHA>",
  "tree_hash": "<Git tree object ID of base merged with head>",
  "source_digest": "<SHA-256 of git ls-tree -r -z TREE output>",
  "merge_sha": "<commit of tree_hash with parents base_sha and head_sha>",
  "duration_ms": 1000
}
```

`source_digest` is a SHA-256 restatement of the tree for consumers that do not trust SHA-1, computed from its tracked paths, modes and object IDs, including source blob IDs. It is fully determined by `tree_hash`. The runner computes both identities before execution and refuses tracked-source changes. The base it reads at the start pins the merged tree: a base that moves while the command runs leaves the result on that tree, so a check that takes hours completes on a busy base. The command runs in a temporary worktree checked out clean at `merge_sha`, a commit of the merged tree whose parents are `base_sha` and `head_sha`, so a check that requires a clean tree passes. Its author and committer are `Tower Crane <tower-crane@localhost>` at the newer parent's commit time, so the same base and head give the same commit. No ref names it and nothing is pushed. A failing execution still records its exit, signal and duration.

With `ci.local` configured, an ok CI gate needs a local receipt with exit 0, no signal, nonnegative duration, the resolved argv and timeout, and a matching successful command receipt. The receipt's `variant` is `default`, `kind:KIND` or `task:ID`, matching the selected default, kind mapping or task override. A different or missing variant fails even when argv and timeout are identical. The full head SHA must match the submitted head. The tree hash and source digest must match the head merged with the selected base, or with the receipt's `base_sha` while the selected base still contains it: a receipt stays valid on its pinned merged tree while the base moves forward. A selected base that no longer contains `base_sha`, such as a force-pushed one, invalidates it with a reason that names the checked base. The latest audited evidence is checked by acceptance, merge and task gate reports. A different head fails even if the tree is identical. A changed merge result at an unchanged head fails acceptance and task gate reports only when the selected base no longer contains `base_sha`; merge and the merge queue also require the base to equal `base_sha`, as below. A base move with the same merged tree and source digest preserves the receipt for acceptance and task gate reports too, including when a lower dependency lands with changes the checked head already contains. Reports keep each unmerged task's last pinned result in `local-ci-pin-cache.json` in the state directory, keyed by `base_sha`, the selected base and the head, all commit ids, so they run `merge-tree` and `ls-tree` for the pinned base once per base move; a cache that cannot be read or written, as in a sandbox, only means the next report computes it again. Changing the resolved variant, command or timeout, or switching CI modes, invalidates its earlier pass. Changing an unselected mapping has no effect. Invalid local policy or task overrides fail closed. Base selection follows dispatch using existing local and origin refs without fetching during `check ci`, acceptance or task reports; metadata queries each have a 60 s deadline. The origin/base pin is a separate merge precondition. Before merge validates a local receipt, it fetches origin's base with a 60 s timeout and requires that tip to equal the receipt's `base_sha`. Fetch failures and moved bases refuse before GitHub merge; a moved base needs `tower-crane check ci ID` again. Without origin, the base the receipt checks select must equal `base_sha` the same way, and merge reads it through its own git commands, so its command receipts show the read. Once the latest audited merge evidence for the current head and revision is successful, reports retain the recorded CI result without validating it against later base changes, and repeated merges skip the fetch. An unaudited merge marker cannot bypass validation. No hosted API is needed for local CI. The existing hosted CI rules apply when local CI is absent.

Resubmitting replaces `sha` without deleting evidence. It preserves `revision` unless the probe list changes at the same commit, when the revision advances to retire the old declaration and its gate runs. Evidence at the older head stays in the audit trail and no longer counts for the new head. Resubmitting the same sha preserves gates only within the same revision and, for tests, with the same declared probes; rework or a changed brief requires fresh evidence. The task remains `submitted`, with no claim lease; omitted branch and PR values stay unchanged. When `--branch` or `--pr` is supplied and the task already has a PR, `submit` reads its state and head branch with `gh pr view`. An open PR blocks a different PR number or a different submitted branch. If the old PR is closed or merged and the PR number changes, `submit` reads the new PR's head branch, uses it when `--branch` is omitted, and checks a supplied branch against it. Failed or unreadable lookups refuse without changing state. Accepted tasks must go through `rework` and a new claim before submission, and that claimant becomes the new `submitted_by` agent.

A submitted head can move at any time until acceptance or rework. Reviewers must pin `evidence --sha` to the commit they reviewed so a result recorded after a resubmission still belongs to the older head. After rework, a fresh worker needs a claim. A session resume through `spawn` restores the submitting worker's claim under the dispatch lock, keeping its agent and original `since` with a new default lease and `from: rework`. An existing live claim by that worker stays unchanged. If an isolated Codex session is missing while the prior worker holds the rework claim, `spawn` transfers the claim to the fresh worker with a new default lease and records `took_over_from` in the claim event. An expired claim must pass readiness and worker-limit checks before transfer. If preparation or launch fails before a child pid is created, `spawn` restores the prior claim and records `rollback: true` in a claim event. A worker spawn on Windows or a host without `/bin/sh` commits its lease before launch. When that launch fails, it restores a prior claim the same way; for a task with no prior claim it records a `release` event with `rollback: true` instead. Another claimant cannot inherit the session.

The `rework` event records `previous_revision`, the originating rejected revision, and `revision`, the new revision. `rework --from-review` also records `from_review: true`. A repeated stack refresh while rework is pending advances `revision` but keeps that same `previous_revision`, including when a worker has claimed the rework. A new submission ends the pending rework; a later rejection records that submission's revision. Worker rework prompts include failed independent reviews at the originating revision and the reworked sha, including when later brief or acceptance edits advance the task again. Those reviews remain ineligible for the new revision's gates.

A rework that automation made for a failed `tests`, `clean` or `ci` gate also records `gate`, the gate that failed, and `owner_held` when it waits out its hold for the task's waiting PR owner ([PR owners](tasks.md#pr-owners)). Only such a rework can be undone by `gates retry ID --from-rework`, which records a `restore` event with `sha`, `gate`, the `rework` event id, `from_revision` (the rework revision), `revision` (the restored one, the rework's `previous_revision`) and `rerun`, the `{type, at}` of each failed gate evidence it reruns. The task goes back to submitted at the revision it was submitted at. Gate evidence is keyed to head and revision because a revision is a round of judgment: acceptance, dependencies, brief or a rework verdict. An automatic gate rework at an unchanged head opened a round nobody worked, so restoring the earlier revision keeps all its evidence at that head (passing gates and any review) valid by the same key, without copying receipts. The restored revision's failed gates then run again. A rerun stopped before it records evidence (a governor stop, missing engine code) leaves the task submitted at the restored revision; a failure that `rerun` names stays due, not settled, until a new verdict replaces it, so no automatic rework bumps the revision or clears the other gates. `from_revision` is retired: every later bump (rework, acceptance, dependencies, needs, brief, stack refresh, quality climb, hotfix) takes the next number above both the current revision and every retired one, so evidence recorded at a retired revision never counts again. A light re-review treats the revision before the current one as the next unretired number down. A reviewer whose dispatch a later rework stopped counts neither as a held review nor toward `REVIEW_EXIT_CAP`: its revision returns only through a restore. A `task update --kind` after the rework does not bump the revision but changes which gates and review apply, so it also blocks the restore. Retired numbers hold only once every writer runs this version: a `wait` host or CLI started before it still bumps by one and can land on a retired number, where gate evidence recorded during the abandoned round (such as a `check ci` run to confirm the fix) would count again at the same head. Restart wait hosts after upgrading.

`merge` checks these gates again, for the current revision, before it merges.

The default method is squash. Commit text defaults to the task's `title` and `acceptance.join('\n')`; `merge ID --subject S --body B` overrides either independently without changing task state. Empty bodies and multiline text are preserved. Method `merge` uses the same text options; `rebase` omits them and refuses explicit text overrides. The command verifies the PR head matches the accepted SHA and always passes GitHub's full head SHA as `--match-head-commit`, including admin merges and merges that retain the branch. Merge command receipts record the selected text and options. When GitHub refuses `gh pr merge` for an unrecorded stack member, a squash or merge falls back to the asynchronous merge request (`merge_method` set to the squash or merge method, `expected_head_sha`, `commit_title` and `commit_message`); its receipts are the refused `gh pr merge` and the request, and the merge evidence records the merge commit. After confirmation the fallback deletes the head branch unless `merge.keep_branch` is set, and refuses when `merge.admin` is set, since the request has no admin option.

The ordinary merge gate refuses cross-repository PRs and a `baseRefName` different from the task's target base (`stack.base` or the project base). In unstacked fallback, every lower task must have merged before the project base becomes the target. Only a PR still targeting its recorded dependency branch may be retargeted, followed by a fresh state, head, repository and base check. Other wrong bases are refused without a PR write. Already-merged confirmation checks the base too, on the plain path and for every stack member, where the dependency branch or the project base is accepted. Summaries name GitHub's reported base; a merge confirmed into another base records failed evidence with the merge commit and asks for inspection of what landed.

For a stack member attempted in the current invocation, final confirmation requires the project base and a successful asynchronous result. The recorded dependency base is accepted only for members confirmed already merged before this invocation's attempts that have no prior audited asynchronous POST for the same repository, PR and accepted head. The gate reads command receipts from all merge events, including attempts recorded under a higher stack task. These receipts bind retries to the project base independently of stack sync. An asynchronous failure stays in the failed stack result; the member gets no successful merge evidence, while valid lower merges retain their own successful evidence.

The standards profile may add gates. `--waive TYPE --reason TEXT` records an owner waiver as evidence; only an explicit `--agent owner` or `TOWER_CRANE_AGENT=owner` can waive. A waiver satisfies its gate. If the accept is still refused, the waiver is not recorded.

A worker declares measurements or kernel checks its sandbox cannot run with repeatable `submit --host-probe CMD`. The task's `host_probes` is an ordered array of non-blank command strings without NUL bytes. Each submission replaces the array; omitting the flag clears previous probes. The submit event records that array, and `task show` lists it. Changing probes at the same commit advances `revision` with the existing retired-revision allocator. This invalidates all earlier gate evidence, including failures, and prevents a new check from joining an old probe run or automation from reworking the new declaration on its old verdict. An unchanged normalized list keeps the revision; a different sha already invalidates old runs and needs no extra revision. Commit probe scripts and say in the PR body which host results are pending; no decision is needed for these checks or cleanup. Leave cleanup to the clean gate.

After the head suite and host-only runs pass, the tests gate runs probes in order on the host, from the root of its detached scratch worktree at the submitted sha, before proof reversion. Probes take no input (stdin is closed), receive `tests.host_env` as host-only tests do, and run in gate containment scopes with the gate resource caps and a separate `gates.host_probe_timeout_min` budget each. None mode still runs declared probes, without a test command. Probes do not run at the base or during reverted proof. The first failed probe stops the remaining probes and reports its redacted output. Normal nonzero exits and timeouts fail the tests gate with `worker_failure: true`, returning through rework. Non-timeout signal kills, memory or PID cap interruptions and wait shutdown instead record `runner_crash: true`, including aborts without a reported signal on Windows. Automation retries signal kills and resource-cap interruptions once at the head before rework, as it does for an interrupted suite; resource-cap diagnostics are retained. A wait-shutdown interruption also records `voided: true`: it reruns without using that retry and never reworks. Timeout termination stops the process tree through the existing gate runner.

Tests evidence and its audit event include `receipt.host_probes`, also supplied in the reviewer prompt's gate results. Each executed probe records `{command, command_sha256, status, signal, timed_out, duration_ms, timeout_min, output_tail}`. Status is its exit code or null when signaled, duration is milliseconds including termination, and output is cleaned and redacted like test output before being bounded to the last 40 lines and 8192 characters. The command hash binds the receipt to the declared command without depending on its redacted display text. Declared probes that have not run leave an empty array in a failed head-suite receipt.

### Final review

An external review bot with a per-PR round cap, such as Revuto's two rounds, does not review a PR's later heads; the CI gate lets its capped check through (`ci.capped_review`), so the head that merges was often never reviewed by it. With `gates.final_review` set, `accept` asks that reviewer for one review of the head before accepting. It runs only for a task with a PR in a project with `repo`, never for a hotfix, and only once every other gate, review included, passes or is waived by this accept. It runs once per head and revision: final review evidence at the current sha and revision is reused, so a repeated `accept` does not ask again, while a new head or revision after rework runs the normal gates again and then, if that head is capped again, the final review again.

The step is a gate run with source `check final-review` (its audit event has that command), taking the same lease as tests and clean, so a second `accept` at the same head joins it. With `when: "capped"` it first reads the check runs at the head (`gh api repos/<repo>/commits/<sha>/check-runs`, newest run of each name) and looks for a completed run whose output title or summary matches `capped_pattern`. None matching records `skipped` and the step is done. Otherwise it runs the command with placeholders expanded, from a detached gate worktree at the commit under the gate temporary root, with the gate environment (the caller's environment, `TMPDIR`, `TMP` and `TEMP` at the gate's scratch directory beside the worktree, and the git config isolation the clean gate uses), no input, gate resource caps and `timeout`. It holds no state lock while the command runs.

How the command ends decides the outcome, recorded as `final_review.outcome` on the evidence and its event:

- exit 0: `pass`; acceptance continues.
- exit `concerns_exit`: `concerns`; the evidence has `ok: false`, and `accept` sends the task to rework and exits 1. The rework reason, which also goes to the brief's rework notes, is `final review FAIL at <sha>:` followed by the evidence summary: the command line, the last 40 lines of its output, the latest PR review left on the head (`pulls/<pr>/reviews`) and every top-level inline comment at the head (`pulls/<pr>/comments`, original commit equal to the head) with its path, line, comment id, author and body. A failed comment read is named in the summary instead.
- any other exit: `refused`; with a signal, a timeout, a missing command, or a check-run read, worktree or commit lookup that failed: `not_run`. Both have `ok: true`, do not block, and stay visible: the summary names the exit and quotes the output.
- a run that `wait` shutdown interrupted, whatever the command did: `not_run` with `interrupted: true` and `ok: false`, the summary `final-review gate interrupted by wait shutdown; retry with gates retry`. It is no verdict: `accept` neither reworks nor accepts, prints `T1: not accepted; the final review at abc1234 gave no verdict (...); retry accept` and exits 1, and the next `accept` asks the reviewer again.

The evidence entry is `{ "type": "final-review", "ok", "sha", "revision", "source": "check final-review", "commands", "summary", "final_review": { "outcome", "when", "capped", "exit", "signal", "timed_out" } }`, where `capped` names the matched check runs as `NAME (APP)`, and `exit`, `signal` and `timed_out` are present once the command ran. `commands` is the receipt: the GitHub reads, the git commands and the reviewer command with its expanded arguments, its working directory and how it ended. Acceptance under the state lock refuses while a configured final review has no evidence with an outcome at the head and revision (an interrupted run does not count), or has `concerns` there. The `accept` event carries `final_review: { "outcome", "at", "summary" }` with the first summary line, and accept's output ends its gate list with `final review OUTCOME`. `status` prints `final review: T1 refused at abc1234` for each unmerged submitted or accepted task whose current final review is not `skipped`, and its JSON lists every one, `skipped` included, in `final_reviews: [{ "id", "sha", "outcome", "summary", "at" }]`. The board's evidence ledger labels the entry with its outcome, and History shows the final review and an accept with `, final review OUTCOME` unless it passed.

## Automation and executors

`automation` events record `{source, phase}` keyed by the triggering event
ID, or a stable digest for older records without IDs.
`running` adds the reaction's `pid`, `host` and Linux `start_ticks` and `pidns`. `done`
deduplicates completed work. `executor` records a reaction that reached CPU
work while every executor was busy, or while an older reaction already waited
for one, with the gate as `kind` and the wait as `error`; its source stays
owed. `deferred` keeps unknown or moved heads,
unknown mergeability and failed merge attempts retryable; `error` records
an exception. Terminal receipts include `error`, null without an exception.
Startup can retry deferred or errored work without a new lifecycle event.
Missing engine modules, uninstalled gates and a missing containment runner
record `phase: "infrastructure"` with `infrastructure_failure: true` and the
error, plus `infrastructure: {root, until}` naming the failed code root and
a retry time in epoch milliseconds. Their source remains queued and owed
and releases its executor. That root takes no new reaction for five seconds,
using the governor retry interval, even across fresh reconcile sources or
CLI processes. A different runtime can drain the owed work immediately.
After the delay the same root can retry; another missing-code failure starts
a new delay. These failures record no gate verdict or
rework. The failing drain stops instead of immediately retrying its own
missing code. Every drain checks its runtime root before reserving a
reaction; a supervisor whose agent has exited and whose runtime is gone
leaves queued reactions untouched.
A reaction the host governor deferred or stopped records `deferred` with the
governor's message as `error` and `governor: {until, task, kind, reason, since, at}`.
`until` is the retry time in epoch milliseconds; `since` and `at` are ISO times.
Its source is queued even when the supervisor or CI feedback started it directly.
The deferred receipt leaves that source owed in its original drain order.
Older governor receipts with only the governor's error text are also owed,
using their event time for the retry interval, even without a queue entry.
Every drain reads the persistent queue, so a caller that cannot retry can exit
without retaining a pending list. Any trusted `wait` retries it once five seconds
have passed and the governor would admit the unit that deferred it; probes while
it is held take no executor and write no new reaction receipts
([Host resource governor](containment.md#host-resource-governor)). A held source keeps its place
in the owed queue but does not hold an executor or block later reactions whose
work can run. Once admissible, it takes its original turn among runnable sources.
Other kinds of deferral
still rely on startup reconciliation or a new lifecycle event.
A task has at most one observable reaction. Its running receipt holds the
task, not an executor: an exited reaction's start can be retried, while an
unobservable one remains busy. A reaction starts at once and takes an
executor only when it reaches CPU work: the tests gate with its host probes,
the clean gate, local CI, or the merge line's head check. It keeps that
executor across tests and clean and releases it before its next GitHub read
and at its end, so review dispatch, accept, CI reads and the merge itself
hold none. At most `gates.executors` executors are in use on one host across
every watcher and supervisor. `executor` events are their leases:
`{lease, phase: "running", kind, source, pid, host, start_ticks}` with `kind`
one of `tests`, `clean`, `ci` or `head check`, then `{lease, phase: "done"}`.
A lease that moves from tests to clean, or from one head check to the next,
records another `running` with its new `kind` and task. The done event releases
it, and its PID identity releases it when the process dies. Leases from other
hosts do not count against this host's cap. A reaction that finds the cap full,
or an older waiter ahead of it, still runs its hosted CI read, so a CI failure
sends the task back before its suite runs, then ends with `phase: "executor"`
and stays owed. One such waiter keeps a task's place: a later notification for
the same task that reaches the same CPU work ends `done`, since the waiting
reaction advances the task from its current state. A waiter is retried only
once a slot is free and no older waiter ranks ahead, so retries read nothing
from GitHub while the cap is full. A command run by hand (`merge --accepted`,
`gates retry --from-rework`) that reaches this CPU work waits for a free
executor instead; `check` and `gates retry` run their gate at once and take
none. Reactions in one process still run one after another; concurrency comes
from separate watchers, supervisors and CLI calls.
Rechecks of pending CI share one GitHub checks read per task per minute
across every process. `ci poll` events `{sha, revision, scheduled}` record
each read automation makes, with `scheduled` the time of the event that
scheduled it (the reconcile or notification), not the read. A recheck of
pending CI at the same head scheduled within a minute of the last read's
schedule skips its read, so one watcher's minute-apart rechecks always read
however late each reaction reaches its ci gate. A first read at a head and a
`ci completed` notification read at once.
SIGTERM or SIGINT to `wait` stops new reservations and gates while its active
gate finishes and records evidence. The interrupted reaction records
`phase: "deferred"` with an interruption reason, releasing its executor lease
before `wait` exits 0. The next startup reconciles the remaining work.
Signal shutdown prints a final notice containing the signal and the number
of gates that finished during the drain, distinct from a wake or timeout.
Conflict sweeps and asynchronous stack conflict processing stop between tasks
and before a probe requests rework or reserves generated repair. A cancelled
probe releases its temporary worktree and adds no conflict-error note.
Failure evidence from a draining gate is retained; automatic retry or rework
waits for a later reaction.
PR inspection and gate commands, including Git and GitHub queries, run
asynchronously so they do not block signal delivery. Forced cancellation
stops their process trees; temporary worktree removal and pruning still run
before the executor lease is released.
A second signal kills the active command tree immediately or cancels its
source-page fetch. An interrupted software gate records a failure without
`confirmed_failure`, so it does not trigger a quality climb. `gates retry`
can rerun that gate.
A second signal during the tests gate's base rerun kills that rerun, so the
failure records `base_rerun_killed` with signal `SIGKILL` and automation
retries it once at the same head instead of reworking.
Asynchronous stack merge polling and backoff also stop on the second signal,
recording failed merge evidence. The remote request may still be pending;
another merge invocation confirms its state.
Automatic stack maintenance (stack linking, post-merge stack refresh, its
base fetch and `gh stack sync`) runs its Git and GitHub commands
asynchronously. The first signal lets the running command finish and starts
no further stack step or task; the second kills it. A `gh stack sync` that
ran records its outcome either way, so moved heads still go to rework.
Stopped steps record no deferral; the next refresh retries them.
`automation queued` records a blocked notification's source, with
`executors` set to the cap when it waits for an executor rather than for
another reaction of the same task. Queued notifications for accepted, unmerged PR
tasks run first, in the order of their current `accept` events. This includes
older notifications that now run a merge and any merged-tree test the merge
needs. Running reactions are never preempted.
Submitted tasks follow in submission order, except that the queued
notifications of a prioritized task run first among submitted work.
Priority belongs to the task, so later notifications, rework and resubmission
keep it until acceptance, cancellation or an explicit clear. Priorities run
in first-request order by default. Repeating a request updates its reason
without changing its place. `--rank N` sets a nonnegative safe integer rank;
lower ranks run first, ties use first-request order. New priorities without
a rank append after existing ranks. An explicit request cannot move
submitted work ahead of accepted merges or change acceptance order.
While a higher-ranked reaction waits for an executor, a later one that reaches
CPU work waits behind it even if a slot is free. A queued reaction that died
running counts as waiting, so the slot it freed goes to its retry before later
work, even when a drain passed over it while it was alive.
`gates prioritize ID --reason R [--rank N]` is operational ([Authority](decisions.md#authority)); it
records a `gates prioritize` event with `reason`, optional `rank`, `sources` (the sources of
the task's queued notifications at that moment), `queued` (their count) and
`authority`. Sources and count are audit details; priority applies to the task's
future queued notifications too. Existing events without a rank acquire
first-request order when read. Setting priority is refused when the task is
accepted, whose merge already runs first, and when the
task has no queued notification. `gates prioritize ID --clear` records
`clear: true` and `authority`, removing priority even during rework with no
queued work. It needs no reason and refuses `--reason` or `--rank`.
Acceptance and cancellation retire earlier requests, so reopening a task
does not restore them. Hotfix cancellation (`hotfix rework`) and cancellation
of a superseded hotfix follow-up (`hotfix supersede`) also retire its priority.
A notification queued
behind the task's own running reaction counts, but the running reaction does
not: its receipt is running and its process is live, so it is no longer
queued. A dead reaction's notification stays queued for its retry. `status`
lists `gate executors: N of CAP in use: TASK KIND, ...` for this host's CPU
executors, then the gate queue: running tasks, then the queued tasks in the
order a free executor takes them, then the tasks whose notification waits
behind their own running reaction, marked as blocked. It lists apart the tasks
that hold no executor while they wait: `waiting on GitHub checks: TASKS` for
pending, unstalled CI at the head and revision, and `waiting on review: TASKS`
for submitted tasks whose software gates pass and whose review is missing.
`--json` carries these as `gate_executors: {cap, in_use: [{task, kind}]}` and
`waiting_on: {github, review}`. `--json` carries it as `gate_queue` with
`running`, `queued`, `blocked` and `deferred`, each queued, blocked or deferred task with its
`prioritized` request (`reason`, `agent`, `at`, resolved `rank`) or `null`. An accepted task shows `null`, since its
acceptance sets its place. `deferred` lists the owed tasks held by the governor,
including those still in their retry interval; the text gate queue line appends
`deferred by the governor: TASKS`. `inbox` carries the same `gate_queue`. Each reaction drains the queue when it ends, after releasing its executor; watchers
also retry their pending notifications on their next check. State locks cover only
reservation and receipts, never Git, GitHub, gates or model calls.
Changing the resolved tests or cleanup gate policy, an affected task's
effective tests mode, or CI policy with `project set` emits an `automation reconcile` request for each
accepted, unmerged PR task that requires an affected gate. The request carries
`sha`, `revision`, `gates` and `reason: "project gate policy changed"` and is
queued until its reaction finishes, even if a watcher starts after the setting
change. Setting an unchanged value queues nothing. The command's text names
the queued tasks and gates. Tests policy includes paths, keep, expensive,
host-only and host environment settings, the test map and its CI inputs;
mode changes are compared per task kind. An unrelated kind's override or a
global mode masked by the task's kind override queues nothing. Already merged tasks are excluded.
`status` also lists `merge blocked: TASK REASON` for accepted, unmerged PRs.
JSON carries `merge_blocked: [{id, reason}]`. It uses current gate evidence
first, then the recorded merge queue refusal; it makes no GitHub request.
Automatic state changes and evidence use `agent: orchestrator` and
`via: automation`. Reactions establish an explicit authorization context
only after verifying the caller's authority or entering from the trusted
supervisor. A supervisor runs in the dispatcher's environment, so its gates
and merges get the host `HOME`, `PATH`, caches and identity, never the
agent's home, shims, task cache, `TOWER_CRANE_SANDBOX` or agent variables,
and git there never reads a config the agent wrote in its home. When the
project sets `gates.tmp_root`, these gates run under it rather than the
dispatcher's `TOWER_CRANE_TMP`. Agent commands retain their restrictive Git
and GitHub shims. This provenance does not replace gate command receipts.
For an accepted task with an audited, successful, non-waived merge receipt
at its current head and revision, `merge ID` prints `already merged at <ref>`
and returns the recorded result locally. It makes no GitHub lookup, validates
no merge text or method, takes no reservation and writes no evidence or events.
If there is no such receipt at entry, `merge ID` takes the same reservation
with source `merge:<uuid>`, waits while a running executor is observable
and records `done`, or `error` when
it refuses, as its release. It drains reactions queued behind it, as an
executor does. If another executor records the merge while it waits, the
merge gate returns that receipt without a GitHub lookup or new merge evidence
or `merged` event; this call still records its reservation and release.
The merge queue takes the head of the line's reservation
with source `queue:<uuid>` around its merge, unless its own process
already holds it. Stack head checks ignore `automation`,
`automation queued`, `automation reconcile` and `gates prioritize` events,
which change no task state.
An accepted PR already merged remotely without a local merge receipt goes
through the merge gate's confirmation path. It records the matching
accepted head and the PR's merge
commit without merging again, including after an executor dies before
writing its receipt. A PR GitHub reports merged at the accepted head needs
no current gate evidence or CI receipt base, so tasks accepted before merge
evidence existed are confirmed rather than refused. Stack members follow the
same path: confirmation reads only the member's own PR, runs no merge, retarget
or stack sync, writes no receipts for other tasks, and an open lower PR does
not block it. A lower member's failing review or stale CI receipt does not
block it either.
For a merge without a recorded receipt, the confirmation lookup validates
merge text and method before calling GitHub. Failed current gates permit
this read-only lookup; an open PR still
requires passing gates. Confirmation evidence records the lookup that
proved the accepted head merged, without querying and merging it again.
Waiters retain automatic events even when their actor matches the waiter.
Reactions run before event output filters, and active PRs catch up at
watcher startup except a default zero-timeout cursor snapshot.
`automation reconcile` records a fresh startup request for every active
submitted or accepted PR, with `{sha, revision, startup}`; `startup` is a
unique identifier for that reconciliation request. It uses the same task reservation as
other reactions and queries current PR state regardless of earlier
completed receipts. A newly conflicting PR goes to rework even if its
base moved while no watcher ran. Matching gate evidence is reused rather
than rerun because of reconciliation. A submitted task's required software
gates run when evidence is absent at its head and revision, including when
an entry lacks a matching gate audit receipt or belongs to an earlier
revision or another sha. Historical passes, failures and waivers stay
recorded but cannot mark a current gate handled. Passing evidence staled by a
pinned command or tests policy change runs again. Completed reaction
receipts do not suppress those runs; only an audited configuration failure at the
current head and revision waits for an explicit `gates retry`. An idle startup writes no request.

## Merge queue

A busy state lock defers the request to the existing watch notification
or fallback tick without holding the wait timeout.
`merge queue` events have no task and record `{phase}`: `running` with the
executor `pid`, `host` and Linux `start_ticks` and `pidns`, `requested` from a reaction
that found a live executor, then `done`, or `error` with `error`. `done` and
`error` also record `blocked`: `null` when the line drained, or
`{task, reason}` naming the first head of the pass that did not merge, and
`skipped`: the `{task, reason}` heads passed over in the pass. A head
waiting on GitHub's mergeability stops the line. A head refused for any
other reason (a closed or unreadable PR, a moved or differently merged head,
remaining gate blockers, a refused merge or head check) is passed over for the rest of the
pass and the next entry takes the line; each later pass tries it again.
PR lookup refusals and unreadable GitHub responses use this skip path;
unexpected execution errors still abort the queue.
Stale and recorded failing tests, clean or CI gates go through `software()`
while the queue holds the task's reaction reservation. Stale receipts, including
receipts from older heads or revisions, rerun through the ordinary governed
gate runner. A recorded confirmed failure at the accepted head and revision
sends the task to rework and removes it from the line; it does not stay accepted
to be passed over on every drain. Infrastructure failures use the ordinary
retry rules before settlement. A missing command, pending CI or an
infrastructure failure shared by the base stays blocked with its reason.
Passing refreshes retain the independent review and acceptance and continue
to the current-base check and merge. Local CI fetches the base ref before
validating the merged result. A base move does not invalidate task reports
or acceptance while the base still contains the receipt's `base_sha`; when the
fetched base differs from `base_sha`, the queue reruns local CI on it, so what
lands was checked on the merged tree it lands as.
An explicit `merge --accepted` requests a busy queue once and waits for
its observable executor to release the reservation before taking its own
pass. The wait uses `gates.tests_timeout_min` (20 minutes by default);
an unobservable executor or an expired wait refuses with a queue reason.
Its entries use the same task reservation and merge gate as `merge ID`,
after the head checks above. Passing CI evidence under `ci.capped_review`
permits a `MERGEABLE` PR whose merge state is `UNSTABLE`.
The command reports each task's merge, confirmation or refusal from the
queue and its recorded evidence, without fetching inbox findings. JSON
contains `results: [{task, ok, summary}]` and `remaining: [{task, reason}]`.
A skipped stack entry's refusal reason is reported for every unmerged
member, including the lower task whose PR or gates blocked the entry.
`queue skipped` records `{sha, revision, reason}` on that task once per
sha and revision. A `requested` after the
executor's latest `running` makes it record another `running` and drain
again with a fresh skipped set. A successful CI completion during the
previous pass can therefore advance a skipped head before the executor
releases the queue, without another notification. The line holds one entry
per accepted, unmerged PR task with no
unmerged task below it, extended up its stack by the accepted, linked tasks
directly above it; entries are ordered by their bottom task's latest
`accept` event at the current sha and revision.
`head check` records the head-of-line suite run on the entry's top task:
`{sha, revision, base_sha, command, members, ok, summary, commands}`, plus
`head_mode: "crucial"` and `head_tests` when crucial mode selected the suites, where
`base_sha` is the `project.base` tip merged into the head, `members` lists
the entry's task ids bottom up and `commands` lists the Git and shell
executions with their status. An ok check at the same sha, revision,
`base_sha` and command is reused. It is a merge precondition, not gate
evidence; it never changes `evidence`.

A timed-out head check also records `infrastructure_failure: true` and the same `timeout` detail as gate evidence. It stops that queue entry with its timeout summary, keeps the task accepted and performs no merge or rework. The next queue pass reruns it once for the same task, head, revision, base tip, command and timeout budget. The queue reservation serializes concurrent requests; later queued reactions reuse the rerun's result, including another timeout. That rerun's `head check` records `rerun_of`, the first timeout's event source. Reuse records one `head check shared` event per result with `{sha, revision, base_sha, command, source, ok, summary}` and `infrastructure_failure: true` for a timed-out result; `source` names the rerun's event. A changed head, revision, base, command or timeout budget starts a fresh check. Successful checks remain reusable after a budget change.

## Gate events

Gate events have `{ "type", "ok", "sha", "ref", "revision", "source", "commands" }` in `detail`, plus optional `confirmed_failure` matching the evidence entry. Acceptance, merge, task views and the sketch match software evidence against these events; a missing or unreadable log supplies no gate proof, while malformed lines are skipped. Keep the log with tasks.json when copying or restoring state.

<a id="gate-reruns"></a>A test that fails once and passes on a second run is not evidence against the change, and a test that fails twice is. When a head, scoped proof or host-only command exits nonzero (not a timeout, a signal, a runner error or a missing command), the gate reruns that command's failing files once in the same checkout, before any base rerun, automatically and with no loop: each command reruns at most once. Relevance is not read from the diff, since a change can break a test in a file it never touches through shared code. Only a command that is pinned `gates.tests_proof_cmd` expanded over the files the gate chose (a mapped or crucial head, the scoped proof, the coverage run or a scoped reverted run) reruns just its failing files, which come from the failing output as for the base rerun, through the same template. `tests_proof_cmd` runs every file it names, so its first run reached each one. Any other command, such as a full `tests_cmd`, can stop at its first failing part (`a && b`, or a runner that bails), and the parts after it ran in neither run, so it reruns whole. A host-only command reruns as is. When the locations are unknown, the runner has no file selector, or the first run printed more than the gate keeps (its last 1,048,576 characters), so a failure before that window could go unnamed, the whole command reruns too. The summary says why a command reran whole. If the rerun passes, the gate goes on as if the first run had passed, and each test that failed on its own in the first run (a suite or parent that failed only through tests inside it is left out) is recorded as flaky. If it fails, the first failure stands with its output, the summary adds the rerun's result and the tests failing on the rerun, and the gate reworks as without the rerun. A rerun never hides a consistent failure: a test that fails again keeps the gate's verdict, only a rerun that passes at the same head in the same checkout rescues a command, and the first failure stays in the evidence. The receipt lists each rerun in `receipt.reruns: [{step, files, ok}]`, where `step` is `head`, `proof`, `host` (a host-only file of the head or scoped proof) or `reverted` (the reverted run or one of its host-only files) and `files` is empty for a whole-command rerun; a head command a rerun rescued counts as passed in the command check below, and the summary line of a rescued command gives its first run's end beside the rerun's, as in `exit 1, then exit 0 on its rerun`. The evidence and its `check tests` event carry `flaky: [{test, step, files?, native_crash?, first_failure: {command, status, signal, duration_ms, error, excerpt}, rerun: {command, status, signal, duration_ms}}]`. `test` is `FILE > NAME` when the failing output gives the test one file, else its name, or the rerun's files or command when no test was named. `error` is the first error line the failing output gives for the test, or null, and `excerpt` is what the reporter printed under the test, at most 20 lines and 2000 characters, redacted. The summary adds a `Rerun: ...` line for each rerun, naming its files and result and the flaky tests.

<a id="flake-ledger"></a>The `check tests` and `check ci` events' `flaky` records are the flake ledger: each has the test, the task (the event's `task`), the commit (`sha`) and the excerpt. A test flaky in two different tasks within 7 days is no one change's doing, so the gate that records the second one opens a task to fix it in the same write: `Fix flaky test TEST`, kind `code`, size `S`, with one acceptance item naming both tasks and a brief that holds both runs' commands, commits and excerpts. Its `task add` event carries `flake: TEST` and `seen: [{task, gate, sha, at}]`. A flake task opens once per test: while the test's last flake task (the last `task add` with that `flake`) is not `accepted` or `cancelled`, its flaky passes open no other task, however many tasks see them. Once it closes, only records after its last event, in event order, count toward the next one, so a flake that returns after its task is done needs two new tasks to open another.
