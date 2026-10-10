# Prompt cache between agents and Bedrock

Measured on 2026-10-08 with Claude Code 2.1.293 and codex-cli 0.160.1.
Claude Opus 5.5 ran through the `global.anthropic.claude-opus-5-5` profile on
bedrock-runtime us-east-1. GPT-6.1 Sol (`openai.gpt-6.1-sol`) ran through
bedrock-mantle us-east-1. Each row is the median of three trials. Sources and
quotes are in [research/T38.json](../research/T38.json).

## Verdict

The KV cache lives on the provider. Anthropic and OpenAI keep it on their own
hardware ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching):
"Prompt caching may store encrypted key/value tensors in GPU-local storage as
application state"). No API exports or imports it, so a local checkpoint of a
hosted model's KV cache is impossible. A proxy cannot store a hit, serve one, or
keep an entry alive past the provider's TTL.

What a proxy can do is make the provider's own cache hit more often:

- **See where two requests diverge.** Anthropic's server-side cache diagnostics
  is "Claude API only: Not available on Amazon Bedrock or Google Cloud". On
  Bedrock a client-side diff is the only way to find the divergence, and it is
  how each cause below was found.
- **Place breakpoints where the next request will look.** Both providers read
  only at boundaries an earlier request wrote
  ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
  "It is looking for prior writes, not for stable content"). A harness that
  writes at the wrong place pays a full write every time.
- **Keep the OpenAI cache key shared.** `prompt_cache_key` "separates cache reuse
  between groups of requests". Codex gives every thread its own key, so a fork or
  a second reviewer never reads the first one's cache.
- **Move volatile content out of the shared prefix.** Working directory, memory
  path, git status and date break an exact-prefix match.
- **Price every request** from the usage fields, so a lever is judged in dollars.

What it cannot do: share a cache across models, organizations or the provider's
TTL (5 minutes or 1 hour on Anthropic, 30 minutes on GPT-5.6 and later). It cannot
make concurrent requests share before the first one starts responding ("a cache
entry only becomes available after the first response begins"), avoid the first
write, or control which Region a `global.` profile picks. AWS notes that
cross-Region routing "may lead to increased cache writes" under load.

Measured levers, cost of the request that should reuse the cache:

| Case | Lever | Read | Write | Cost USD | Baseline cost |
|---|---|---:|---:|---:|---:|
| Claude `--resume` turn | `--turn-breakpoint` | 16,026 | 413 | 0.0054 | 0.0734 |
| Codex `exec fork` | `--inherit-cache-key` | 18,418 | 33 | 0.0021 | 0.0463 |
| Claude reviewer, prefix in system prompt | `--normalize` | 14,590 | 4,107 | 0.0252 | 0.0454 |
| Claude reviewer, prefix in user prompt | `--normalize --breakpoint` | 15,233 | 3,456 | 0.0204 | 0.0454 |
| Codex reviewer, prefix in user prompt | shared key, `--normalize --breakpoint` | 11,631 | 162 | 0.0017 | 0.0296 |
| Any codex spawn after the first | shared key, `--developer-breakpoint` | 9,754 | 2,036 | 0.0062 | 0.0296 |

A breakpoint after a reviewer prefix that already ends the system prompt is a
no-op: Claude Code already marks that block.

The results are positive and nothing measured argues against them. Turning them
on means running spawned agents behind the proxy, or getting the harnesses to do
the same natively. That is follow-up work outside this task. `--turn-breakpoint`
is the smallest change: it only adds a `cache_control` marker. `--normalize`
changes what the model reads (paths become `$CWD` with a note giving the real
value) and depends on the harness's current prompt layout.

## The proxy

`scripts/cache-proxy.js` is a Node script with no dependencies. It listens on
127.0.0.1 and forwards each request to Bedrock. Requests under `/model/` go to
bedrock-runtime (Claude, InvokeModel and InvokeModelWithResponseStream). Responses
API requests go to bedrock-mantle; pass `--mantle` the bedrock-runtime host to use
its `/openai/v1` path instead.

```sh
node scripts/cache-proxy.js --port 18790 --log ~/.cache/cache-proxy.jsonl [levers]
ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:18790 claude -p ...
codex exec -c 'model_providers.amazon-bedrock.base_url="http://127.0.0.1:18790/openai/v1"' ...
node scripts/cache-proxy.js report ~/.cache/cache-proxy.jsonl
```

Upstream HTTPS honors `HTTPS_PROXY` when `NODE_USE_ENV_PROXY=1` is set.

Each log line holds:

- `hash.static`: hash of tools plus system prompt or instructions.
- `hash.full`: hash of the whole prompt.
- `hash.breakpoints`: where each `cache_control` marker sits.
- `usage`: input, cache read, cache write (5-minute and 1-hour on Anthropic) and
  output tokens.
- `cost_usd`: cost at list price.
- `params`: known request settings with short values as sent; any other field,
  metadata included, as a hash.
- `divergence`: the closest of the last 64 requests, whether this one is
  identical to it, extends it, is a prefix of it (`prefix_of`) or diverged, and
  if it diverged the segment path and character offset.
- `analysis_error`: set when the body has a shape the proxy does not expect. The
  request then goes upstream as received.

A segment is one tool, one system block or one message content block, in
provider prefix order.

Prompt text stays in memory for the comparison and is never written. The
Authorization header is forwarded as received and never read. Bedrock API keys
are bearer tokens, so nothing is signed or stored. `--skeleton DIR` writes each
request's structure with every string over 24 characters replaced by its hash and
length.

Levers:

| Flag | Provider | Rewrite |
|---|---|---|
| `--turn-breakpoint` | Anthropic | marks the last block before trailing `role: system` messages |
| `--breakpoint MARKER` | both | splits the block holding MARKER after it and marks the head (`cache_control` or `prompt_cache_breakpoint`); on Anthropic, leaves the request unchanged (`breakpoint:over_limit`) when no earlier breakpoint can make room under the maximum of 4 |
| `--normalize` | both | Claude: moves date, cwd and git status lines out of the system prompt, writes `$CWD` and `$CWD_SLUG` for the working directory (whole paths only, never for `/`) with a note giving the real values, and puts the git status reminder after the prompt. Codex: moves `<environment_context>` after the prompt |
| `--cache-key KEY` | OpenAI | sets `prompt_cache_key` |
| `--inherit-cache-key` | OpenAI | a request that extends an earlier one (every segment, conversation included) under another key takes that key; sharing only codex's leading developer messages is not enough |
| `--developer-breakpoint` | OpenAI | marks the end of the leading developer messages |
| `--breakpoint-ttl 5m\|1h` | Anthropic | TTL of the breakpoints `--breakpoint` and `--turn-breakpoint` add. Anthropic rejects a 1-hour breakpoint that comes after a 5-minute one, so after an insertion every breakpoint before a 1-hour one becomes 1-hour (`ttl:promoted PATH`). Billing stays the same: 1-hour write tokens run up to the last 1-hour breakpoint |

Default prices, per million tokens: Opus 5.5 is $4 input, $20 output, $5 for a
5-minute write, $8 for a 1-hour write and $0.20 for a read. GPT-6.1 Sol is $2
input, $10 output, $2.50 for a write and $0.10 for a read (OpenAI's standard
short-context price; the Bedrock page renders its numbers client side and was not
checked). `--prices FILE` overrides them. In the validation pair the proxy's cost
equals Claude Code's `total_cost_usd`: 0.081953 for the fresh turn and 0.0873012
for the session after resume.

## Measurements

### Claude resume rewrites the conversation

The T36 review found that `claude --resume` writes about 19k tokens of cache
again. The cause is below. The fixture is the one in
[resume-cache.md](resume-cache.md): one fresh turn, then one resumed turn, with
tools off and opus at low effort.

| Proxy | Fresh read | Fresh write | Resume read | Resume write | Resume cost USD |
|---|---:|---:|---:|---:|---:|
| none | 1,852 | 14,524 | 1,852 | 14,588 | 0.0734 |
| `--turn-breakpoint` | 1,852 | 14,523 | 16,026 | 413 | 0.0054 |

The proxy showed that the resumed request extends the fresh one segment for
segment. The two requests had identical parameters, betas and breakpoint
positions. The read stopped at the end of the system prompt (1,852 tokens).

The skeleton shows why. In print mode Claude Code ends every request with a
`role: system` message (the environment section) and puts its last breakpoint on
it. On the next turn that message sits mid-conversation and a new trailing system
message carries the breakpoint. The entry written at the old trailing position is
never read back. Sending the old message as a block array instead of a string
changed nothing (one trial: 1,852 read, 14,591 written), so serialization is not
the cause.

Anthropic documents a mid-conversation system message as "itself cacheable" once
it is in the history. That did not happen for the entry written while the message
was last. Marking the user turn before the trailing system message gives the next
turn a prefix it matches. A validation pair agreed: 16,026 read, 411 written.

### Codex fork starts cold

Each trial ran three codex calls through one proxy: an unrelated one-line task,
then a fresh turn on the same fixture (the parent), then `codex exec fork
<thread>` with the rework prompt. The unrelated task shares codex's
instructions, tools and developer messages with the parent and diverges at the
user prompt.

| Proxy | Parent read | Parent write | Fork read | Fork write | Fork cost USD |
|---|---:|---:|---:|---:|---:|
| none | 0 | 18,419 | 0 | 18,452 | 0.0463 |
| `--inherit-cache-key` | 0 | 18,418 | 18,418 | 33 | 0.0021 |

The fork's request extends the parent's, but it carries a new
`prompt_cache_key`, and the key separates cache reuse. Giving it the parent's key
makes the whole parent prompt a hit. In every trial the unrelated task and the
parent kept their own keys, so the lever moved only the fork. A lever that also
moved the parent onto the unrelated task's key would be the shared-key lever
measured below, not a fork lever.

### Reviewer shared prefix

Reviewer A and reviewer B ran one after the other in two git worktrees with
different tasks. The shared prefix was the `tower-crane-review` skill plus
`standards/default.md` (8,231 characters). Each trial put a new UUID at the top of
the prefix, so reviewer A started cold for it. The rows show reviewer B.

T37 layout: the prefix in `--append-system-prompt`, the task in the user message.

| Variant | Read | Write | Cost USD | Diverged at |
|---|---:|---:|---:|---|
| none | 9,960 | 8,667 | 0.0454 | `system[2]` char 2,491 (memory path) |
| proxy `--normalize` | 14,590 | 4,107 | 0.0252 | `messages[0].content[3]` (task) |
| claude `--exclude-dynamic-system-prompt-sections` | 13,787 | 4,780 | 0.0276 | `messages[0].content[2]` (git status) |
| proxy `--breakpoint` after the prefix | 9,960 | 8,667 | 0.0465 | `system[2]` char 2,489; no-op, block already marked (cost differs by output tokens) |

The auto memory section names a directory derived from the working directory, so
a reviewer in another worktree diverges inside the system prompt. That happens
before the appended prefix starts.

Current layout: the prefix and the task in one user prompt.

| Harness | Variant | Read | Write | Cost USD |
|---|---|---:|---:|---:|
| Claude | none | 9,951 | 8,673 | 0.0454 |
| Claude | `--normalize` | 11,830 | 6,862 | 0.0368 |
| Claude | `--normalize --breakpoint` | 15,233 | 3,456 | 0.0204 |
| Codex | none | 0 | 11,791 | 0.0296 |
| Codex | shared `--cache-key` | 0 | 11,788 | 0.0296 |
| Codex | shared key, `--normalize` | 0 | 11,789 | 0.0296 |
| Codex | `--normalize --breakpoint`, own keys | 0 | 11,797 | 0.0296 |
| Codex | shared key, `--normalize --breakpoint` | 11,631 | 162 | 0.0017 |
| Codex | shared key, `--developer-breakpoint` | 9,754 | 2,036 | 0.0062 |

Codex writes only at its implicit breakpoint, the end of the latest user
message. Reviewer A's write covers its own task, so reviewer B reads nothing
until a breakpoint marks the shared end. That takes three changes together:

1. Move the environment message out of the way (`--normalize`).
2. Mark the shared end (`--breakpoint`).
3. Use the same key.

Without the shared key the write is in another partition. The developer-message
breakpoint alone shares codex's own instructions, tools and developer messages
(9.7k tokens) across every spawn that uses the key.

## Self-hosted path

On a model we serve ourselves the KV cache is ours, and a persisted prefix
cache is the local checkpoint that hosted APIs cannot offer. vLLM keys each KV
block by "the tokens in the block and the tokens in the prefix before the block".
LMCache moves KV "out of GPU memory into a tiered storage hierarchy spanning CPU
memory, local storage, and remote backends, enabling reuse across requests,
sessions, and engine instances". SGLang HiCache tiers it the same way, and
cross-instance reuse "needs --hicache-storage-backend". Persisted entries survive
a restart only with a reproducible block hash, such as vLLM's `sha256_cbor`.

This is a separate option. It applies only to agents running on an open model in
our own engine, not to Claude or GPT on Bedrock, and it was not measured here.
The exact-prefix rule is the same, so the proxy's divergence report and the
normalize and breakpoint findings carry over unchanged.

## Method

Each experiment script started the proxy and its clients in the same sandboxed
command. Claude and codex ran with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in
scratch directories under `~/.cache` and authenticated with the existing
`AWS_BEARER_TOKEN_BEDROCK`.

Claude commands: `claude -p <prompt> --model opus --effort low --output-format
json --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. The resume
experiments add `--tools ''` and `--resume <session_id>`; reviewers keep the
default tools.

Codex commands: `codex exec --json --skip-git-repo-check --disable memories
--disable plugins --disable apps` at low reasoning effort, plus
`codex exec fork <thread_id> <prompt>`.

Every prompt ended with "Reply exactly READY. Do not use any tools."

Limits:

- One day, one Region, one-turn fixtures. The fixtures are not a full Ginza task
  or a cost forecast.
- Costs are list prices. A Bedrock bill can differ, especially for Sol.
- Parallel reviewers do not share until the first one starts responding.
- The normalize patterns follow Claude Code 2.1.293 and codex-cli 0.160.1. A
  harness update can move volatile content somewhere they do not cover. The
  divergence log shows where it moved.
