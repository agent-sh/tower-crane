# State storage profile

T182, 2026-10-10, Node 26.10.0 on Linux. The shared host had load averages
around 50 and 37 GiB available memory. Measurements used a private copy of
project, tasks, decisions and events from the live project. No production state
was migrated by this measurement.

The initial inspection found 65,108 audit rows, including 34,510 hook-progress
rows. Evidence held 11.45 MB of compact gate policies, 3.83 MB of command
receipts and 1.65 MB of summaries, before tasks.json indentation.

Each timed transaction used `state.mutate` to append one task note and its
event, with broker provenance to exclude rendering. It includes lock
acquisition, state reads, validation, serialization, atomic writes and sync.
Wrappers around `JSON.parse`, `JSON.stringify`, `fs.readFileSync` and
`fs.fsyncSync` accumulated wall time for each operation. CLI startup, broker
transport and rendering are excluded. The baseline was commit `b311105`.
After measurements ran after the one-time evidence migration.

| Measurement | Before | After |
| --- | ---: | ---: |
| tasks.json bytes | 32,613,309 | 12,499,401 |
| events.jsonl bytes | 42,688,704 | 43,419,120 |
| Write median, ms | 1,646.9 | 1,231.2 |
| Write min to max, ms | 1,076.4 to 1,914.9 | 949.1 to 2,418.3 |
| JSON parse median, ms | 679.3 | 324.2 |
| JSON stringify median, ms | 344.5 | 146.5 |
| File read median, ms | 179.5 | 193.5 |
| File sync median, ms | 20.3 | 307.3 |

The three baseline write samples were 1646.9, 1076.4 and 1914.9 ms; the three
after samples were 2418.3, 1231.2 and 949.1 ms. Disk sync varied under shared
host load, so the overlapping wall-time ranges do not establish a fixed
speedup. The task file shrank 61.7%, and JSON serialization time fell 57.5%.
The audit log grew by compact migration receipts and measurement notes.
Its historical bytes were retained to preserve pinned readers' event cursors.

New progress writes touch only progress.jsonl and never load those files.
Integration coverage holds the state lock while invoking the real
UserPromptSubmit bridge and tool hook, and asserts both complete before the
lock is released. Evidence tests check migration, complete output retrieval,
missing and corrupt artifacts, pinned-reader failure verdicts, and preservation
of unknown fields.
