# Storage evaluation: files vs SQLite vs a local service vs Valkey (T255)

Measured 2026-10-13/14 on the local rig (24 cores, NVMe on LVM), at equal durability: every option syncs to disk before it acknowledges a write.

## Decision

Move Tower Crane state to SQLite (B): WAL, `synchronous=FULL`, one row per task, an events table indexed by sequence, id and task, and an inbox table with a partial index over undelivered messages. Each command opens the database itself; no server.

Do not adopt Valkey. Do not build the persistent service (C) now.

Why, from the numbers below:

1. Files do not scale, even after T254. Every command still parses the whole log and the 10 MB `tasks.json`. With the T254 CLI, a hook takes 506 ms at p50 on the 91 MB live log and 955 ms at 200 MB. A mutation takes 2.5 s at p95 on live and 4.0 s at 200 MB. B, C and D stay flat as the log grows.
2. B, C and D tie end to end. Hook p50 is 29 to 33 ms and mutation p50 31 to 34 ms on every log size. Nearly all of that is process start: B's hook takes 29 ms end to end and 0.6 ms in storage. On storage alone, B's write is 3.6 ms, D's 1.8 ms and C's 0.6 to 1.1 ms (single run, live log). All are noise next to process start.
3. The guarantee is the same. strace shows a sync before every acknowledgement in A-proto, B, C and D. 270 random `kill -9` (45 per option) lost no acknowledged write. They left B, C and D consistent. Killing the writer at its commit write leaves A with a task change that has no event. B, C and D stay consistent at every crash point.
4. B has no server. Nothing has to be started, supervised, restarted or ported. C needs 50 to 545 ms to restart and D 100 to 312 ms, and both grow with the data in C-files and D. There is no new dependency: `node:sqlite` is built into Node 24 and later (checked on 24.21.0 and 26.10.0). It runs on Windows, where Valkey has no official build. The whole state is one file.
5. B loses in one place. Its mutation p95 is 52 ms under 6 concurrent writers; C and D sit at 36 to 42 ms. That comes from SQLite's single writer lock and from the WAL checkpoint each process runs when it closes the last connection. B is still within budget, and C over B (group commit) removes the gap if it ever matters.

## What B asks of the product

The prototypes read through indexes. Today the product derives state from the full event list (`st.events.filter` and `findLast` in the inbox, hooks, claims and review churn). Reading every event from SQLite costs about what parsing the file does: 209 ms against 348 ms on live. So the gain arrives only where a hot path queries instead. Move the hook (inbox table), mutations (task row plus per-task events) and `wait` (sequence cursor) first. Then move the status and inbox views. A local service over B would let the current in-memory logic run unchanged. That is C's real advantage: a cheaper migration, paid for with a daemon.

## When Valkey, or another server, would be adopted

Adopt a networked store when one of these is an established requirement, not before:

- Multi-host state: workers or automation on more than one machine write the same project. SQLite must not sit on a network file system, and a local service serves one host. Then compare Valkey (`appendfsync always`) with Postgres on that topology. On one host, Valkey measured equal to B.
- Write rate: sustained acknowledged writes near what one SQLite writer gives. Here B carried about 100 mutations/s from 6 writers, bound by process start. Storage alone allows about 270 sequential writes/s (3.6 ms each). Past that, group commit in a local service (C-sqlite, 1.1 ms per write) comes before a server.
- A cache shared across hosts, such as gate results keyed by tree, where eviction matters and durability does not. Valkey fits that cache. It is separate from state.

Push delivery, dependencies, claims, conflict detection, checkpointing and recovery are not reasons. All of them ran on B, or on a local process, in these prototypes.

## Results

Each run contributes its own p50 or p95, and the tables below show the median of the 3 runs. The min..max across runs for every cell is in `results/summary.md`; every operation is in `results/raw/`.

Concurrent hooks (8 agents polling back to back, plus a message every 500 ms), p50 / p95 ms:

| option | 50 MiB | live 91 MB | 200 MiB | CPU ms per op (live) |
|---|---|---|---|---|
| A-cli (T254 CLI) | 357 / 408 | 506 / 669 | 955 / 1151 | 751 |
| A-proto (files, storage only) | 335 / 362 | 476 / 504 | 901 / 957 | 699 |
| B SQLite | 29 / 33 | 29 / 33 | 29 / 33 | 27 |
| C-files (service over A's files) | 33 / 40 | 32 / 39 | 32 / 37 | 30 |
| C-sqlite (service over B) | 31 / 35 | 31 / 35 | 31 / 35 | 28 |
| D Valkey | 31 / 35 | 31 / 35 | 31 / 36 | 29 |

Task transitions (6 writers cycling claim, submit and evidence, automation sending each back with rework, 6 hooks paced at 1/s), mutation p50 / p95 ms and mutations/s:

| option | 50 MiB | live 91 MB | 200 MiB |
|---|---|---|---|
| A-cli | 1599 / 2055, 2.4/s | 1915 / 2516, 2.0/s | 2716 / 3979, 1.4/s |
| A-proto | 899 / 2084, 3.9/s | 1415 / 3366, 2.7/s | 3159 / 7743, 1.2/s |
| B | 34 / 52, 104/s | 33 / 52, 102/s | 33 / 52, 102/s |
| C-files | 33 / 39, 115/s | 33 / 40, 113/s | 34 / 42, 111/s |
| C-sqlite | 31 / 36, 124/s | 31 / 36, 124/s | 31 / 36, 124/s |
| D | 33 / 37, 118/s | 32 / 37, 119/s | 34 / 42, 112/s |

Event replay, fresh reader, ms from offset 0 / from the last 1000 events: A 247 / 38, 348 / 39 and 671 / 40; B 147 / 31, 209 / 31 and 410 / 30; D 294 / 36, 481 / 34 and 887 / 33 (50 MiB, live, 200 MiB). Replay in C reads the backend directly, so it matches A or B. D's replay includes the minimal RESP client in `stores/resp.js`; replay does not decide anything here.

Storage alone (`results/microbench.json`: a single run of 200 sequential operations in one process, no process start), live log, p50 / p95 ms:

| option | empty hook poll | note write (task + event, synced) |
|---|---|---|
| A-proto | 289 / 329 | 326 / 396 |
| B | 0.6 / 0.8 | 3.6 / 7.0 |
| C-files | 0.1 / 1.0 | 0.6 / 2.6 |
| C-sqlite | 0.1 / 1.0 | 1.1 / 3.7 |
| D | 0.5 / 1.1 | 1.8 / 3.7 |

Between 50 MiB and 200 MiB, B, C and D change by less than 1 ms at p50 and by up to 1.4 ms at p95 (C-sqlite note p95 3.7 to 5.1 ms). A-proto goes from 159 to 620 ms for a hook.

Crash recovery, 5 random `kill -9` per run (same kill points for every option; for C and D the owner process is killed too):

| option | acked writes checked (9 runs) | acked lost | task change without event | restart ms (50 MiB / live / 200 MiB) | first write after crash, ms (live) |
|---|---|---|---|---|---|
| A-cli | 222 | 0 | 0 | none | 1510 |
| A-proto | 288 | 0 | 0 | none | 469 |
| B | 17068 | 0 | 0 | none | 39 |
| C-files | 20858 | 0 | 0 | 199 / 298 / 545 | 331 |
| C-sqlite | 21398 | 0 | 0 | 50 / 53 / 52 | 94 |
| D | 20859 | 0 | 0 | 102 / 157 / 312 | 194 |

Deterministic crash points (`results/crash-points.json`): strace kills the writer (or the owner process) at its first write, or first sync, to the commit file. A-cli and A-proto killed at the event append leave the note in `tasks.json` with no event. B, C-files, C-sqlite and D are consistent at both points, and the next write succeeds.

Syncs per acknowledged write (`results/fsync.json`, strace): A-proto 1.5, B 5 (the WAL checkpoint on close), C-files 1, C-sqlite 1.1, D 1 (`fdatasync`). A-cli 2.05, but none of them is on `events.jsonl`.

## Findings for T254 (PR #240)

- `appendEvents` never syncs `events.jsonl`. A `msg` syncs only the `tasks.json` temp file, so an acknowledged event-only write (a message, a hook delivery) can be lost on power loss.
- `tasks.json` is written before the events are appended. A crash in between leaves a task change without its event, and `validate` reports drift only in the other direction.
- The directory is not synced after the `tasks.json` rename. A-proto keeps that gap, as main does, so its durability is slightly weaker than B, C and D and its numbers slightly favour A.

## Method

- A-cli is the T254 tree at `7828330a`, run through its real CLI. A-proto, B, C-files, C-sqlite and D are storage prototypes in `stores/`. They share one transition model (`stores/model.js`) and run each operation in a fresh Node process, as a command or hook does (`op.js`).
- Datasets: a copy of the live state taken 2026-10-13 22:47: a 91 MB log of 103,861 lines (66,695 state events) and a 10 MB `tasks.json` with 262 tasks. `s50` is the newest 50 MiB of that log. `s200` is the live log after 113 MiB of copies of finished-task events with new ids. B and D hold state events only; the legacy tool-progress lines that A's readers skip are not migrated. Benchmark-only edits: the pause is lifted, the live orchestrator lease is dropped, and the 8 bench tasks lose their PR numbers, so `submit` does not query GitHub.
- 54 runs: 3 runs × 3 datasets × 6 options. A-cli, A-proto, B, C-sqlite and D were interleaved inside each run, at load 6.7 to 28.6 (median 12.6) on 24 cores. All 9 C-files runs were redone afterwards as a separate block, after a fix to its first checkpoint, at load 16.9 to 26.0 (median 17.7). Every run restores a fresh copy. The machine was shared. Runs were niced. CPU is client plus server CPU from `/proc`.
- A-cli runs `validate` after the last crash of each run, and it exits 1 in all 9 runs. The cause is plan findings already in the live state before any bench write: L-size tasks without a `split:` note (T91, T92, T98, T166). No run reported drift. `validate` checks only for events that `tasks.json` lacks, so it cannot see a task change written before its event (the gap T266 covers).
- `kill -9` covers process crashes. Power-loss durability rests on the measured syncs, not on a power cut.

## Reproduce

```sh
cp -r <state dir> ~/.cache/t255/live-copy
git -C <repo> archive 7828330a | tar -x -C ~/.cache/t255/a-tree
node prepare.js --src ~/.cache/t255/live-copy --out ~/.cache/t255/datasets
./run-all.sh ~/.cache/t255/datasets ~/.cache/t255/runs ~/.cache/t255/a-tree
node fsync-check.js --datasets ~/.cache/t255/datasets --work ~/.cache/t255/runs --a-tree ~/.cache/t255/a-tree --out results/fsync.json
node crash-points.js --datasets ~/.cache/t255/datasets --work ~/.cache/t255/runs --a-tree ~/.cache/t255/a-tree --out results/crash-points.json
node microbench.js --datasets ~/.cache/t255/datasets --work ~/.cache/t255/runs --a-tree ~/.cache/t255/a-tree --out results/microbench.json
node summarize.js results/raw results
```

Valkey 9.0.4 (`valkey-server` on port 6390, `appendonly yes`, `appendfsync always`, no RDB saves) and Node 26.10.0 were used. strace is needed for the sync and crash-point checks.
