---
description: Dispatch ready Tower Crane tasks within the worker limit.
---

Run `tower-crane spawn --ready --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. Report dispatches and refusals. The command checks workers and slots; do not script those checks.
