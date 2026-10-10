# Rework session cache measurement

Measured on 2026-10-06 with codex-cli 0.160.0 and Claude Code 2.1.292.
Each pair used a fresh session followed immediately by one resumed rework turn
in the same directory. Both turns returned `READY` without tool calls.
Three pairs ran per harness.

| Harness | Pair | Fresh cached input | Resumed cached input |
|---|---:|---:|---:|
| Codex, profile sol, low effort | 1 | 0 | 21,971 |
| Codex, profile sol, low effort | 2 | 0 | 21,973 |
| Codex, profile sol, low effort | 3 | 0 | 21,977 |
| Claude, opus, low effort | 1 | 544 | 2,167 |
| Claude, opus, low effort | 2 | 2,167 | 2,167 |
| Claude, opus, low effort | 3 | 2,167 | 2,167 |
| **Codex median** | | **0** | **21,973** |
| **Claude median** | | **2,167** | **2,167** |

The Codex result confirms cache reuse on the first rework turn. Claude kept
the same session id in all three pairs but showed no median cache-read gain
in this setup. Its resumed cache creation was about 19.2k tokens, so most of
the conversation was written again. Native rework therefore resumes Codex
and starts Claude fresh with the brief and review note. These counts describe
a synthetic one-turn fixture, not a full Ginza task or a cost forecast.

The independent T36 review repeated the Claude pair on 2026-10-06.
Fresh cache read was 544 tokens and cache creation was 20,710; resumed cache
read was 2,171 and cache creation was 19,185. This single validation pair
agrees with the three-pair measurement. Claude resume stays disabled until
a measurement shows it is cheaper for the configured route.
[prompt-cache.md](prompt-cache.md) traces the rewrite to the breakpoint Claude
Code puts on its trailing system message, and measures a proxy lever that makes
the resumed turn read the conversation from cache.

The task brief also reports a separate 2026-10-06 Codex observation: about
19.6k cached input tokens with `codex exec resume`, and 0 with `codex exec fork`.
That supplied observation is a single run, separate from the three-pair
measurement above. This implementation resumes directly and never forks.

A harmless validation pair during T36 rework on 2026-10-06 used the same
fixture and codex-cli 0.160.0. Fresh input was 22,027 tokens with 0 cached;
the resumed turn added 22,060 input tokens with 21,985 cached and 33 cache
writes. Both turns returned `READY`, used no tools and reported the same
thread id. This single validation pair agrees with the three-pair result
above; it does not replace that median.

## Method

Each fresh prompt began with `Fixture <random UUID>.`, then 250 lines:

```text
Requirement <n>: resume the worker session in its original worktree; preserve the claimant; attach failed review evidence; reject harness changes; keep receipts in the event log.
```

`<n>` ran from 0 to 249. The final instruction was
`Reply exactly READY. Do not use any tools.` A new UUID made each fresh prompt
distinct. The resumed prompt was
`Rework: the review requests an explicit worktree check. Reply exactly READY. Do not use any tools.`

Codex commands:

```sh
codex exec -p sol --json --skip-git-repo-check \
  -c model_reasoning_effort=low \
  --disable memories --disable plugins --disable apps "<fresh prompt>"
codex exec -p sol resume --json --skip-git-repo-check \
  -c model_reasoning_effort=low \
  --disable memories --disable plugins --disable apps "<thread_id>" "<rework prompt>"
```

Read the session from `thread.started.thread_id`. The first invocation's
`turn.completed.usage.cached_input_tokens` was 0 in all pairs. The resume
counters included the prior turn, so subtract the first invocation's counters
to get the resumed turn. Its cached-input delta was 21,971, 21,973 and 21,977.
Fresh total input was 22,013, 22,015 and 22,019 tokens.

Claude commands:

```sh
claude -p "<fresh prompt>" --model opus --effort low --output-format json \
  --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'
claude -p "<rework prompt>" --model opus --effort low --output-format json \
  --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --resume "<session_id>"
```

Read `session_id` from the JSON result and verify it stays the same on resume.
Use the first message's `usage.iterations[0].cache_read_input_tokens`.
`modelUsage` accumulates the session's costs and token counts on resume and is
not the first rework turn. Each result had one message iteration.
Fresh cache creation was 20,704, 19,077 and 19,081 tokens; resumed cache creation
was 19,183, 19,179 and 19,183. No `--fork-session` was used.
