# State storage profile

T182, measured 2026-10-11 around 00:45 Jerusalem time with Node 26.10.0 on Linux, on the shared host at load averages between 17 and 40. Each side ran on its own private copy of this project's live `project.json`, `tasks.json`, `decisions.json` and `events.jsonl`. "Before" is the T182 merge base, "after" is the T182 branch. Each figure is the median of three runs. The one exception is the locked prompt before the change, which ran once because it always takes the full 60 s lock bound.

## Where a write spends its time

A timed write is one `state.mutate` that adds a task note and its event, with broker provenance so that rendering is left out. It includes taking the lock, reading and validating all state, serializing, the atomic writes and fsync. Wrappers around `JSON.parse`, `JSON.stringify`, `fs.readFileSync` and `fs.fsyncSync` added up the time in each.

| Write | Before | After |
| --- | ---: | ---: |
| Total, ms | 1,027.7 | 415.1 |
| `JSON.stringify`, ms | 261.7 | 88.9 |
| `JSON.parse`, ms | 203.2 | 133.6 |
| File reads, ms | 112.5 | 90.4 |
| fsync, ms | 318.6 | 2.7 |
| Runs, ms | 951.3, 1,027.7, 1,158.3 | 619.7, 391.7, 415.1 |

Before the change, every write serialized and rewrote the full 33 MB `tasks.json`. The serialization and the sync of that file were half the cost, and parsing it and the event log was most of the rest.

## Sizes

| File | Before | After |
| --- | ---: | ---: |
| `tasks.json`, bytes | 33,269,730 | 9,421,220 |
| `events.jsonl`, bytes | 44,019,845 | unchanged |
| `events.jsonl`, rows | 67,613, of which 35,719 `hook progress` | unchanged; no new progress rows |
| `evidence/`, files and bytes | none | 1,766 files in 144 task folders, 8,283,544 bytes |

The first write after the upgrade moved settled evidence out in 6,951.5 ms, 5,764.1 ms of it fsyncing the 1,766 new files. That happens once. Later writes copy only receipts that have just settled. History is never rewritten, so the event log keeps its size and its byte cursors.

## Commands

| Command, wall time in ms | Before | After |
| --- | ---: | ---: |
| `status --json` | 1,230 | 886 |
| `hook tool` (progress) | 958 | 55 |
| `hook inbox` with nothing pending | 842 | 324 |
| `UserPromptSubmit` bridge while another process holds the lock | 60,098, exit 2 | 352, exit 0 |

Before the change, a prompt under a held lock waited the full 60 s lock bound and then failed the hook. That is the failure that stopped starting workers. Now a tool hook appends to the agent's own progress file without the lock. A prompt with nothing pending reads only the event log, and a prompt with messages pending tries the lock once and leaves the messages for the next hook.

## What still grows

Each settled receipt leaves a bounded entry in `tasks.json`: its references and fields under 1 KiB, whatever the size of its output. Task notes and spend rows grow with history, and so does the event log, which every write still parses. The event log is now the largest part of a write's read cost.
