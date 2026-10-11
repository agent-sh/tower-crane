---
description: Read actionable Tower Crane findings and their resolving commands.
argument-hint: "[--ack ITEM]"
---

Run `tower-crane inbox $ARGUMENTS --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator` as the identity. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. Present the findings and use each item's resolving command. Acknowledge messages, stalls, decision answers and owner comments only after handling them. Do not reconstruct status from the event log.
