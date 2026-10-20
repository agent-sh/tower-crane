---
description: Read actionable Tower Crane findings and their resolving commands.
argument-hint: "[--ack ITEM]... [--ack-before TIME [--kind KIND]]"
---

Run `tower-crane inbox $ARGUMENTS --json --agent <name>`, using `TOWER_CRANE_AGENT` or `orchestrator` as the identity. Pass `--state <dir>` if `TOWER_CRANE_STATE` is absent. Present the findings and use each item's resolving command. Acknowledge messages, stalls, decision answers and owner comments only after handling them. Do not reconstruct status from the event log.

Repeat `--ack ITEM` for an atomic batch, or use `--ack-before TIME [--kind KIND]` for handled items at or before a timestamp. Kinds are `message`, `stall`, `decision_answer`, `owner_comment` and `review_exit_missing`. Messages and decision answers older than 24 h for cancelled or accepted-and-merged tasks leave the view automatically; their history remains.
