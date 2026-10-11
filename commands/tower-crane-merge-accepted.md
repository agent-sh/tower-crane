---
description: Merge accepted Tower Crane PRs through the queue and stack gates.
---

Run `tower-crane merge --accepted --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. Report confirmed merges and remaining refusals. Preserve the queue's current-base checks and the stack path.
