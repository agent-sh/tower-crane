# Stacks

Tasks may carry `stack: { parent, base, parent_sha, repo, linked, synced_base }`. `parent` is the lower task id, `base` is the PR's current target branch, `parent_sha` is the dependency head used for dispatch or the last synchronization, `repo` is the same GitHub repository as the project, and `synced_base` is the last observed main commit. `linked` records successful `gh stack link`. One unmerged dependency chain forms one stack; outstanding sibling branches are not appended to that chain.

Before worker or reviewer dispatch, acceptance, or a software gate, a child
whose parent has resubmitted refreshes under the worktree lock, whether its
stack is linked or still prepared. The
engine merges the verified submitted parent head into a child with its own
commits in a detached scratch worktree,
with commit subject `Merge <parent>'s resubmitted head into <child>`. A clean
merge is pushed to the child branch before the local branch moves, then updates
`stack.parent_sha` and emits `stack sync` with the parent and child heads.
Existing child commits are preserved. A submitted or accepted child returns to
rework to submit the refreshed branch and rerun gates; its former submitted sha
stays recorded until then.
An untouched child adopts the parent head directly, including a rewritten
parent, so commits dropped by the parent are not restored. If the child head
exactly equals its old `parent_sha`, a rewritten parent can replace that head
on origin with `--force-with-lease=refs/heads/<child>:<old-head>` after a normal
push is rejected. The explicit lease rejects concurrent remote work. A failed
lease preserves the local branch and stack metadata, records a stable rework
note and stops refresh until the orchestrator reconciles the moved remote.

A child with its own commits is not merged across a parent history rewrite.
It records a restack note and keeps its branch and submitted head. Linked
stacks use the existing `gh stack sync` rebase and guarded publication while
idle; an unlinked recorded PR must be linked before `stack sync`. A child
without a PR requires the orchestrator to arrange its restack. The restacked
branch needs a new submission before gates can run at it. A parent refresh
that is inapplicable or has a recoverable failure falls through to ordinary
linked sync. A guarded-lease failure or an actual merge conflict stops that
pass instead.

A conflict aborts the scratch merge and leaves the child branch and checkout
unchanged. A rework note names the parent sha and conflicting files, and the
worker dispatches to resolve them. The `stack sync` conflict receipt permits
that dispatch only while the child head and submitted parent head are unchanged.
A gate waits until the child's submitted head contains the latest submitted
parent head. Gate freshness uses that head across parent rework and active
claims. Dispatch and merge still apply their lifecycle checks. Acceptance
checks freshness before reusing gate receipts, and reviewer dispatch checks
it before starting a model. Current independent FAIL recovery runs before
these parent checks and keeps `from_review: true`. A submitted dry-run review
checks ancestry without publishing; an unsubmitted review previews its fallback
command without an ancestry check. Acceptance and reviewer startup
compare the parent inputs again in their final state transactions.
Live workers and dirty checkouts defer parent refresh, with one
`stack sync deferred` event per parent head. A dirty child can dispatch its worker on the
unchanged branch and checkout; its brief names the parent head it must include
before resubmitting. A dirty submitted or accepted child returns to rework so
that worker can be scheduled. This recovery also runs when the same parent
head already has a deferral receipt; repeated checks while rework is pending
do not advance its revision again. Gates still wait for the parent head. A child
branch that already contains the parent head needs no merge, so a live worker or
dirty checkout does not defer it: refresh records the parent head in
`stack.parent_sha` and emits `stack sync` without touching the checkout, and a
submitted head that contains the parent keeps its status. Stopped Git operations
keep their worktree operation checks and prevent automatic refresh. Merged
parents take the completed-chain retirement path before any parent branch fetch.
Refresh only merges a newer submitted or accepted head from an unmerged parent
without a retirement reservation. Blocked-parent dispatch and merge-base
validation keep their existing lifecycle checks; a gate does not retire a
completed stack before validating its PR base.

`stack_disabled: true` records an unavailable stacks capability, explicit `stack unstack`, or a replacement middle PR awaiting confirmation of its new chain. It selects ordinary merges, which wait for lower merge evidence before retargeting an existing upper PR. An accepted dependency can still use the ordinary main-based dispatch flow when the repository cannot stack; a submitted dependency requires an available chain.

A successful `stack link` clears fallback markers for its linked members and restores the stack merge gate, including its refusal of admin merges.

When claim or worker spawn readiness depends on an existing stack PR, Tower Crane queries `gh api repos/OWNER/REPO/stacks` outside the state lock and applies linked-state changes only if the affected task snapshot is unchanged. The query runs only when a chain holds two or more unmerged PRs, so a merged dependency needs no check. A spawned worker's gh is limited by its agent file and cannot call that endpoint: spawn runs the query for its task before dispatch, and that worker's claim reads the recorded result. Any other claim queries it itself. A confirmed remote chain clears stale disabled markers; a missing remote link is recorded as unlinked for that member's own chain only. An outage marks only members that have a stack record and a PR, so a dependent without a stack record carries no flag; one left by an earlier outage is cleared once its submitted dependency's chain is confirmed. Transient GitHub errors refuse the readiness check without disabling stacks.

When every lower member has audited successful merge evidence, gates use the project base. Once no unmerged member remains above the task, it is treated as an ordinary PR even if its recorded stack is still linked. Task show, status and the board omit that completed dependency chain. Automatic refresh and explicit `stack sync` retire it without calling `gh stack sync`. A middle task with a PR stays tracked while an upper task is open, so its merged lower PRs remain known to sync and merge. Retirement validates the PR head, branch, repository and base, retargets it to the project base, removes `stack` and `stack_disabled`, and emits `stack complete` with the former parent, new base and PR number. Its sha is unchanged. `stack unstack` uses the same retirement when all other members are merged, without asking GitHub to unstack merged PRs. A remaining GitHub stack membership uses the ordinary single-PR merge fallback through the asynchronous API. Rework notes append only to an existing brief; a brief removed during the append is treated as absent.

A child without a PR retires as soon as every lower member has merged, including an unlinked, disabled or running child. The merge refresh or next observation removes its stack metadata and emits `stack complete` with `pr: null`. Worker dispatch rechecks lower PRs before worktree preparation and readiness. A remote merge at each recorded lower head, branch, repository and dependency or project base authorizes retirement before spawn even when its local merge receipt has not arrived. It does not create merge evidence. The parent observations and retirement use the same input snapshot, so a changed chain refuses dispatch. Squash and merge parents use this path even when GitHub has deleted their branches.

The automatic retirement note lives in `task.notes`. It does not emit a `task note` event or create an `owner-comment` notification when the owner triggers retirement.

A middle member with an open task above keeps its stack lineage, but moves its PR and stored `stack.base` to the project base once every lower member has merged. It uses the same PR validation and closed-PR replacement as retirement, including when the stack is disabled or unlinked. `stack base` records `{parent, previous_base, base, pr}` and adds the automatic merge-base note when the base or PR changes. A replacement marks the retained member and its upper members unlinked until their new PR chain is confirmed; the retained member selects ordinary merge fallback in the meantime. The upper members keep their parent task ids and dependency branches.

Dispatch applies this base change after a verified remote merge even before local merge evidence arrives. Its completed lower chain needs no dispatch-time `gh stack sync`; a sync must not restore the former dependency base. A missing task checkout resumes from its own head and preserves retained lineage on the project base.

A failed PR retarget keeps the stack record and fallback flag for retry. While that record remains and every lower task has merged, the ordinary merge fallback may retarget the recorded dependency base to the project base. After retirement removes the record, only the project base is valid; moving the PR back to the former dependency branch is refused without a PR write.

Retirement preserves the child branch and commits. A task note tells the worker to merge the project base before continuing work or opening its PR and to resolve conflicts while preserving its commits. If GitHub closed the dependent PR while deleting its recorded base, retirement finds an open PR from the same branch against the project base or creates one with the closed PR's title and body. The replacement must match the submitted head, branch and repository and have auto-merge disabled. The task records its new PR number in the same write as `stack complete`; a separate `stack pr replaced` event records the former PR, replacement PR, sha and new revision. Replacement bumps the revision and returns an accepted task to submitted, so gates and review must run for the new PR. A closed PR against an unrelated base, a moved head or a failed GitHub call leaves the stack intact for inspection or retry.

The shared generated-conflict preflight runs before automatic refresh from
merge, worktree preparation and spawn. It can also retire a linked dependent
whose lower members all have confirmed merge evidence. It uses the same
snapshot and PR validation as ordinary completed-chain retirement, emitting
`stack complete` before generated repair. This prevents synchronization from
requesting worker rework first. Generated-only conflicts receive a new
submitted head; mixed conflicts retain a prepared merge; unconfirmed remote
conflicts wait. Other stacks keep their existing automatic sync behavior.

`github_stack` holds the unmodified `pull_request.stack` object (or the payload's top-level `stack`) from a trusted payload passed to `stack webhook`, or null when the payload has no stack. The repository and PR number must match a known task. Task show and board sheets expose this metadata separately from Tower Crane's local dependency chain. Webhook metadata does not satisfy a gate, change a submitted head, accept a task or prove a merge.

Stack merges record ordinary `merge` evidence and matching gate audit events for each confirmed task at its own submitted sha and revision. Their command receipts include the remote membership query, every PR head check, bottom-up asynchronous merge requests (`gh api repos/{owner}/{repo}/pulls/{n}/merge-async --method POST` with `merge_method=merge` and `expected_head_sha`) and their status polls, upper PR retargeting and the confirmations. Merge commits keep every accepted head as an ancestor of the project base; the submitted shas remain unchanged. A refused or queued member stops later merges; confirmed accepted lower members retain successful evidence even when the target fails. Terminal POST or job failures retain their reason across status and PR read errors. Unless the PR is confirmed merged at its accepted head, the failure is reported when the PR is read open or when the confirmation deadline expires. Branches are retained while merging a linked chain. Sync emits `stack sync` events for the affected tasks with `ok`, `head`, the parsed abort `reason`, and `failure` (`conflict`, `tool`, or null on success). A moved branch or an explicit conflict report emits rework and appends its reason to the task's brief. A tooling or transport failure preserves unchanged submissions, claims, briefs, gate evidence and stack metadata; the next refresh retries it. A branch moved before a failed push still requires rework. Refresh deferred for a live worker, a dirty worktree or a member worktree with a stopped rebase, am, merge, cherry-pick, revert or bisect emits `stack sync deferred`; it does not change the claim. A worktree that such an operation detached is found through the branch it started from, and dispatch of that branch's task refuses with the same reason. A spawn inside `wait` whose stack refresh a drain stopped also emits `stack sync deferred` for its task and starts no agent, and the rest of that refill batch waits; the next wait dispatches them. PR linking uses `stack dispatch`, `stack link`, `stack readiness`, `stack unavailable` and `stack link failed` events. A link applies only when what it read is unchanged under the lock: the project settings and, for each member of the chain, its status, head, branch, PR, stack record, `stack_disabled` flag and merge state. Other writes to the members, such as gate evidence, notes, usage samples and reviewer dispatches and exits, do not refuse it. A link refused because its inputs changed during its GitHub calls is retried from fresh state up to five times in the same observer pass; only then is `stack link failed` recorded, and the next observer pass retries. An open PR whose head GitHub moved after a lower stack merge, the requested task or a dependent above it, records a `stack head` event with its old and new sha and returns to submitted.

Sync holds the state lock only for its initial read and final compare-and-apply. Its gh commands and branch reads, fetches and pushes run unlocked. Application compares project configuration, stack membership, complete member task records and member events against the snapshot, leaving out hook, startup and spawn session receipts, automation reservation receipts and the orchestrator notice a hook stop writes. A difference refuses application without writing sync events, briefs or task records. Writes to unrelated tasks are preserved by applying to freshly read state.

Linking, completed-chain retirement and unstacking use the same snapshot, unlocked commands and compare-and-apply rule. Automatic linking runs after exit collection commits, outside that mutation. A stale link or unstack result cannot clear a new claim or replace member metadata. Remote PR changes may already have completed when application is refused; inspect them before retrying.

The shared command runner rejects Git and gh calls inside state mutation transactions. Spawn prepares repository directories and credentials before its write; acceptance and review dispatch prepare local CI inputs and snapshots before their writes and reject changed inputs. View rendering starts after the mutation releases its lock and reads current state.

Hosted CI runs on every stack member at its own base. `ci.yml` has no base filter on pull requests, so a stacked task's PR runs the `ci.yml` jobs on any task branch, and its required runs report before its base merges; pushes to `main` run them too.

Tests, cleanup, review diffs and local CI use the dependency branch as the base for stacks with unmerged lower members. Once all lower members have merge evidence, those checks use the project base. Old head evidence cannot count after the worker resubmits a refreshed head. Stack merge checks all lower heads first, then pins each member's accepted full head with the asynchronous merge API because GitHub's stack merge command has no head-match option; see cli.md for partial completion and the ordinary admin fallback.

## Generated conflict repair

Generated outputs are declared by the fetched base's `package.json`
`tower-crane.generated` mapping, from exact relative file paths to npm script
names or `{script, blocks}`. Blocks use paired HTML `NAME:start` and
`NAME:end` comments; only their bodies are generated. Whole-file add/add
outputs require only the two branch versions. Partially generated documents
require an ancestor version to preserve hand-written text. See docs/cli.md for
the merge and regeneration contract. A matching GitHub conflict authorizes
the trusted automation executor to merge into an idle, clean task checkout
outside worker sandboxes and push without force. Other executors, live
workers, dirty checkouts and moved local or remote heads defer repair.
Trial conflicts involving generated outputs also defer when GitHub has not
confirmed a conflict at the matching submitted head, including stale clean
or unknown mergeability. Queue head checks wait without a merge gate or head
suite; post-merge sweeps leave the task unchanged. Subsequent reactions retry,
and mixed conflicts receive generated pre-resolution only after confirmation.

`generated merge` records `phase: prepared` before a generated-only push,
with `{previous_sha, sha, revision, base_sha, branch, path, generated, commands}`.
It also records `destination_sha`, a SHA-256 digest of the verified origin push
URL. The URL itself is not stored. The PR head repository must match the project;
the push destination must resolve to that same PR. Every push re-verifies it
in the worktree it pushes from and matches the digest, then pushes to `origin`
by name, so git uses the verified URL and does not apply `pushInsteadOf` again.
`commands` records generation command strings, exit statuses and summaries.
A prepared receipt retries the same commit after a failed push, or confirms
it after a push whose executor stopped before updating state.
The following automatic `submit` changes the sha and returns an accepted
task to `submitted`, preserving `submitted_by`, revision and historical
evidence. Its event adds `generated` and `base_sha`, and `owner` with the name of an
owner waiting on the old head, which keeps the PR ([PR owners](tasks.md#pr-owners));
gates and review at the old sha no longer count. `generated merge` then records `phase: pushed`.
Mixed conflicts produce rework, handed back to a waiting owner as any rework is, and a `phase: mixed` receipt with
`{sha, revision, base_sha, branch, path, generated, remaining, regenerated, commands}`.
Its `revision` is the new revision returned by rework; the executor refuses
the receipt if the task changes again before that receipt is recorded.
The checkout retains `MERGE_HEAD`, generated resolutions are staged and
`remaining` names the hand-written conflicts. `regenerated: false` means
source conflicts prevented generation; the worker must rerun the scripts
after resolving them. A generator failure in a generated-only merge aborts
the merge, restores the clean checkout and retains the submitted head.
Generators cannot change hand-written text outside declared blocks.
