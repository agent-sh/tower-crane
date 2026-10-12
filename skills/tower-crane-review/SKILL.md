---
name: tower-crane-review
description: "Use when Tower Crane needs an independent review of a submitted task: review the diff against its acceptance and the gate reports with a clean context, post the review on the PR, and record review evidence."
argument-hint: "<task id> [--agent NAME]"
---

# Tower Crane: review one task

You did not write this change and have not seen it being written. Keep it that way: work only from the task, the diff and the reports.

Arguments: `$ARGUMENTS`. Use `TOWER_CRANE_TASK` and `TOWER_CRANE_AGENT` when set; otherwise use the task id and agent name passed by the orchestrator. Pass `--agent <name>` on every tower-crane call. If `TOWER_CRANE_STATE` is absent, also pass `--state <dir>` with the supplied state directory.

1. Use the supplied task, acceptance, submitted sha, PR and software gate results. Read the named review context file when the prompt references one. If dispatched without that packet, `tower-crane task show <id> --agent <name>` gets the task and evidence. Code requires tests and clean gates; every task with a PR needs CI before review dispatch (`docs/state.md`). CI is the orchestrator's gate; reviewers judge the code and acceptance. Missing or unfinished CI evidence belongs in a message to the orchestrator, not a failed code review.
2. Read the supplied diff, the brief's `## Reviewer` section and the PR body. Without a supplied packet, get the review instructions with `tower-crane brief get <id> --agent <name>` and use `git diff $(git merge-base <base> <sha>) <sha>`. If the task has an earlier failed review at this revision, follow **Re-review** below before checking new findings. Read surrounding code where the diff depends on it; if worktree HEAD differs from the submitted sha, use `git show <sha>:<path>`. Use the recorded tests, clean and CI gate results. Do not re-run the full suite unless you change something in a scratch checkout to probe a specific concern; run only the affected tests for that probe. Keep the submitted worktree read-only.
3. Check, in this order, within the review scope. Classify each finding by **What blocks** and **Re-review** below:
   - each acceptance item is met; code changes have a test shown failing before and passing after, and other work has the verification its brief requires;
   - for a research task on any tier, read `research/<id>.json` at the submitted sha and the sources receipt. Check each claim maps to a cited source, its quote supports the claim, and no factual claim in the deliverable lacks a citation. Successful fetching and quote matching do not establish that a source is credible or that the claim follows from the quote;
   - claims in the PR body, docs, comments and changelog are true of the code (current models most often leave stale or overstated text, not broken syntax);
   - copies and contracts the change touched elsewhere still agree (docs, configs, other callers, other locales);
   - edge cases, error paths that fail silently, wrong conditions, races, and security boundaries the change crosses;
   - anything added that nothing uses, and anything the standards rule out;
   - files the packet's `## Scope` lists outside the paths the task names: each needs a reason in the task, or it is a finding.
4. Post one review on the PR as a comment, first line `Review (Tower Crane, clean context)`, followed by `SHA: <full submitted sha>` before the findings. Use separate `## Blocking findings` and `## Follow-ups` headings, writing `None` when a list is empty. Write findings as `file:line - what is wrong - why it matters`, most severe first. Include the reproduction for each blocking defect. State the blocking count explicitly. On a repository the project does not own, do not post; put the review in the evidence summary only, with the same headings.
5. Record it: `tower-crane evidence <id> --agent <name> --type review --ok|--fail --sha <sha> --revision <revision> --summary "<blocking count and the top blocking finding>"`, adding `--ref <comment URL>` when posted. `<revision>` is the task revision you reviewed: the `revision` in `tower-crane task show` when you started, not when you finish. A reviewer that `tower-crane spawn` did not start cannot record review evidence without it. Choose `--ok` when the blocking list is empty and `--fail` when it is not. Follow-ups do not affect that verdict.

## What blocks

Subject to the re-review rule below, these findings block:

- an unmet acceptance line;
- a defect on a line or path the diff adds or changes, shown by a reproduction: a test, probe or concrete input;
- a false claim in the PR body, docs or changelog;
- a contract or copy the change broke;
- any security or data-loss defect the change introduces.

Defects in code the diff did not touch, requirements beyond the acceptance, hardening ideas, style and P3s are follow-ups. List them under **Follow-ups** in the review. The orchestrator files them as separate tasks after a passing or failing review; the worker does not add them to this PR.

## Re-review

When the task has an earlier failed review at the current revision, read the latest such review's blocking findings and recorded sha, using its linked comment or evidence summary. First check each earlier blocking finding at the submitted sha and report whether it is fixed. An unresolved earlier blocker still blocks. Then review only the diff since that review's sha with `git diff <earlier-review-sha> <submitted-sha>`, using the checklist above.

A new finding on code the earlier reviewed diff already contained blocks only if it is a security or data-loss defect introduced by the change. Otherwise list it as a follow-up, even if it would have blocked the first review. A failed review from another task revision does not narrow the current review.

Run any probe, test run or PR check in the foreground with a bounded wait, `tower-crane wait --task <id> --agent <name> --timeout SEC` (exits 2 at the deadline), not in a background job: a headless run is not guaranteed to resume for a background job's notification.

Do not fix the code, push, or merge. Your last message is the review text.
