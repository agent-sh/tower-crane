---
description: Send a Tower Crane task back with its current failed review.
argument-hint: "ID"
---

Run `tower-crane rework --from-review $ARGUMENTS --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. The command fetches the full current review comment and copies every finding and its link into the brief. A failed fetch or changed review refuses without modifying the task. Report the result.
