---
description: Recover Tower Crane claims whose spawned processes exited.
---

Run `tower-crane release --dead --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator`. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. Report recovered claims. The command verifies process identity under the lock; do not release live or unobservable workers.
