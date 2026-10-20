---
description: Send a Tower Crane task back with its current failed review.
argument-hint: "ID"
---

Run `tower-crane rework --from-review $ARGUMENTS --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. The command fetches the full current review comment and copies every finding and its link into the brief. A failed fetch or changed review refuses without modifying the task. Report the result.

If it refuses because every blocker is a false PR-body claim, automation dispatches a body-only worker. After the worker edits the body and exits without changing commits or checkout files, automation automatically requests a light reviewer check at the same head and revision. Leave the body alone while automatic repair is pending or running; status shows `fixing PR body`. After two consecutive failed light re-checks, automation stops with `review_body_stuck` in inbox and the latest findings; the initial full review failure does not count. For that item, correct the PR body before running `tower-crane accept ID --agent <name>`, using `gh pr edit --body-file` to fix every false claim. If correction requires code changes, run `tower-crane rework ID --reason R`. Without a recorded PR or branch, use this manual correction and accept path. Changelog claims are reworked normally; the next revision's review is a light check when only the named fragments change.
