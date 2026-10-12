# Captured usage

Captured on 2026-10-06 from installed harnesses or existing session records. Prompts, responses, project paths and unrelated events are removed. Message and part ids are shortened where needed. No credential files were opened.

| Fixture | Source |
|---|---|
| `codex.log`, `codex-session.jsonl`, `codex-cache-session.jsonl`, `codex-stream.jsonl` | Codex 0.160.0, `exec -p sol -c model_reasoning_effort=low`, one prompt asking for `OK`. Session is the exact id printed by that run. A second run with `--json` captured `thread.started` and `turn.completed` usage. The cache fixture is a trimmed cumulative record from an existing Sol session with nonzero cache reads. |
| `claude.jsonl`, `claude-result.json` | Existing Claude assistant session record with nonzero cache reads, plus the zero-usage JSON result from a failed bare print probe. Claude 2.1.291 help confirms print JSON; the bare probe reported no login, and a Bedrock probe hit its 90 s deadline. |
| `codex-cache-write-session.jsonl` | A current Sol session's cumulative token count with cache writes and reasoning. Only the counters and model are retained. Cache writes are part of input; reasoning is part of output. |
| `claude-print-result.json` | A completed Claude print dispatch's JSON result, retaining only numeric token usage and model names. It includes nonzero cache reads and writes. |
| `opencode.jsonl`, `opencode-cache.jsonl`, `opencode-reasoning.jsonl` | Stored step-finish records selected from its session database, projected to the JSON event shape, including cache reads, cache writes and reasoning. Installed 1.18.29 help confirms `run --format json`. A pure run against a listed free model hit its 100 s deadline without output. |
| `agy.json` | Successful `agy -p ... --model gemini-3.8-flash-low --output-format json`, one prompt asking for `OK`. Result includes no model field. |
| `pi.jsonl` | Existing assistant session record with nonzero cache-write usage. Installed 0.83.0 help confirms `--mode json`. Live local and Bedrock probes emitted assistant error records with zero usage; those do not prove successful inference. |

CLI integration tests replay these captured counts with an offline stand-in. They do not call providers or read developer sessions.

Model and profile names in these captures are replaced with fictional fixture IDs. Token counters, event shapes and ordering are preserved.
