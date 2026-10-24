# Changelog

## 0.1.7 (2026-10-20)

### Upgrading

- The host governor now reserves what running work actually grows to together, not the sum of every unit's remaining peak. It learns from growth windows: once a minute it opens one with the units running then and follows their summed size for `growth_window_min` (60). After `growth_samples_min` (20) windows, the growth it reserves is the 99th percentile of those ratios times the running units' summed room, never below the largest unit's own room. Until then it keeps the sum. On this project's host the reservation for running work fell from about 20 GiB to under 6. `status` names the rule, the ratio and the sample count.
- Containment scopes use `OOMPolicy=continue`, and the runner sets `memory.oom.group=1` on each attempt. An attempt that hits its memory cap is stopped alone; its parent scope and siblings keep running. 0.1.6 used `OOMPolicy=kill`, which on systemd 255 stopped the parent scope too.
- Where the base branch has push CI, publishing or merging a release PR needs its latest completed run to be green. An owner approval or an empty publish policy does not bypass a red run. Neutral and skipped runs count as green; a cancelled run blocks while a newer push is pending. Projects without base push history publish as before.
- `accept` reruns missing gates and stale passing gates, including a local CI receipt for an older merged tree. Fresh passes are reused, failed gates still need an explicit rerun, and review stays separate.
- `ci.local.receipts` takes globs. A local CI gate copies the matching files into the hidden `ci-artifacts/` area before it removes its worktree, on pass or fail. Only the owner and the orchestrator can read the copies, capped at 8 MiB per file with a truncation notice. Agents see only a redacted summary of the failed steps.
- Repeating `inbox --ack ITEM` acknowledges several items in one atomic batch, and `inbox --ack-before TIME [--kind KIND]` acknowledges every match. Task messages and decision answers older than 24 hours drop out of the inbox once every task they concern is cancelled, or accepted and merged; their history stays.

### Host governor

- A reaction the governor defers stays owed in the persistent gate queue, also when a worker supervisor or CI feedback started it. Any trusted `wait` retries it in its turn once there is room. A held unit no longer blocks smaller or ungoverned reactions behind it.
- A window that grew past the reservation in force raises the ratio to at least its own for the next `growth_window_min`. Closed windows, with prediction, growth, ratio and peak, go to a rolling log, `HOST.windows.jsonl`, beside the registry.
- Use still counts anonymous, shared and kernel memory, never page cache, so a finished scope that still holds cached files counts for nothing.
- `status` and `inbox` mark governor-deferred work: the text line adds `deferred by the governor: TASKS`, JSON has `gate_queue.deferred`, and `governor_deferred` stays while the reaction is owed.

### Containment

- Agent tool snapshots are kept while a supervisor, keeper or controller still runs from them. A reaction whose runtime is missing stays owed as an infrastructure error. It records no failed gate and does not send the task to rework.
- A caller outside its systemd user manager, such as a hosted CI runner service, gets its scope in the manager's slice of the same name.
- On Windows, containment waits for a slow CIM process snapshot and stop as long as other snapshots do, instead of failing with `resource-monitor-failed` after 2 seconds. Children of a command that exits before its first snapshot are still found. The attempt finishes only after its stop does.
- A containment keeper runs from the filesystem root, so on Windows it no longer pins a worktree, tool copy, agent home or test fixture against removal.

### Gates

- A tests gate reruns only the failing files at the base, through the pinned test selector. Base results are redacted and shared across later and concurrent gates under the same environment. Logs and evidence record the selected files, cache hits and time.
- Queued merge reactions share one head-check rerun after a merged-head suite timeout. A change of head, revision, base, command or timeout budget starts a fresh check.
- A PR-body-only review failure dispatches a worker to correct the body, then runs the light claim check at the same head. Two failed automatic re-checks stop with `review_body_stuck`. Light checks reuse reviewer recovery for crashes and missing receipts; a clean exit with no verdict, or three crashes, surfaces `review_held`. `status` shows `fixing PR body` during a repair, and hides live-spend lines for accepted or cancelled tasks and readings older than a day; runaway monitoring still uses them.
- In tests, the gate scratch proof keeps nested gates on an isolated fake host; real host runs still use the governor. It reports a nested gate's exit code and stderr when the gate returns no JSON.

### Stacked tasks

- A stacked child is retired once its parent merges, also when it has no PR. Dispatch rechecks merged parents first. A child PR closed when its base branch was deleted is recovered through a matching open PR or a replacement against the project base, with a fresh revision; an accepted task goes back to submitted so gates and review run again. Retirement adds a task note to merge the project base and keeps the child's commits.

### Workers, reviews and status

- Rework prompts, `ci checks` and submit reports show each open revuto inline finding's comment id beside its path and line, so a worker can run `ci resolve` itself.
- Runaway alarms separate a task's total spend from the current worker's own spend, show the cached share, and compare against accepted tasks of the same tier and size. A single worker over the limit gets its own alarm.
- A failed local CI gate names its failed steps, exit and timeout details from the copied receipts.
- An orchestrator lease refusal says when the caller carries the holder's session id but runs outside its process tree, and how to run it instead.
- Main push CI failures at the current base head share one inbox item with the failing jobs and test names.

### CI

- Main push CI is green again on every Linux and Windows job. It had failed on every push since 2026-10-18.
- Windows runs four test shards, and each shard prints a line as every test file starts and ends. A shard still running at 36 minutes prints its process tree, stops and fails; `TC_TEST_SHARD_DEADLINE_MIN` overrides the limit.

## 0.1.6 (2026-10-19)

### Upgrading

- Every spawned worker, reviewer, small agent and orchestrator, and every tests, proof, clean or local CI command, now runs under a process cap and a memory cap that count every process it starts. The defaults take half the effective host budget: physical memory and the kernel task ceiling, lowered to the smallest `memory.max` and `pids.max` on the caller's cgroup ancestry. An agent gets that half divided by one slot per four logical CPUs. A gate command gets it divided by `gates.executors`, two when unset. A spawned orchestrator holds its workers, reviewers and gates in its own scope, so it gets the whole half. A reviewer gets one agent share plus one gate share for its test probes. On a 24 CPU host with a 40 GiB slice, each worker gets about 3.33 GiB. `project show` prints the resolved limits for each role.
- To raise the caps, run `project set --tasks-max N` or `project set --memory-max-bytes N`. They set `resources.tasks_max` and `resources.memory_max_bytes`, apply unchanged to agents and gates, and take effect at the next launch. Both are operational, so the orchestrator or owner sets them without an approval. There is no unlimited value.
- On Linux with cgroup v2 and a reachable systemd user manager, each launch runs in its own transient user scope in the caller's slice, with `MemorySwapMax=0` and `OOMPolicy=kill`. Elsewhere a watchdog samples process count and total RSS every 100 ms; off Linux its default is 256 processes. The watchdog is a sampled bound: a fork or an allocation can overshoot between samples.
- At a cap the whole attempt stops. A spawn records `blocked` with `resource-tasks-max` or `resource-memory-max`, and `status` and `inbox` show it. A gate puts the reason in its summary.
- A `MemoryMax` or `TasksMax` in the owner's `scope` setting is overridden by the resource caps, and a `Slice` there no longer moves the agent out of the caller's slice. Set the caps with `--tasks-max` and `--memory-max-bytes` instead. `init`, `project set` and `ladder set` warn when `scope` sets `TasksMax`, `MemoryMax`, `MemorySwapMax`, `OOMPolicy`, `Delegate` or `Slice`.
- Run a long-lived Tower Crane process, such as `wait --follow`, in a scope without `MemoryMax`. A caller inside a capped cgroup keeps every attempt inside that cap: nested when the cgroup delegates `memory` and `pids`, otherwise under the watchdog.
- When an agent exits normally, its own background processes are stopped. Supervisors it dispatched and its wait, check, accept and merge controllers keep running inside its caps until they end.
- A host governor now admits every agent dispatch, tests, clean and local CI gate, and merge-queue suite against one memory budget shared by all your Tower Crane projects on the host. Work that does not fit is deferred and exits 3 with `TASK: UNIT deferred by the host governor: REASON`. A gate the governor stops mid-run also exits 3 and records no evidence. `spawn --ready` stops its batch at the first deferral, marks it `governor_deferred` and exits 1. Exit 3 used to mean only a lock timeout. Past the stop line the governor stops Tower Crane's own running work. `project set --governor JSON` moves the lines; the defaults are `defer_at` 0.85 and `stop_at` 0.95 of the binding level.
- Tests evidence now binds `tests.host_only` and a SHA-256 of `tests.host_env`. A project with host settings must rerun its tests gate after upgrading: earlier proof is stale for acceptance and merge.
- `ask --kind credential` needs a `--setting` that grants a credential or loosens a sandbox: `env`, `env_file`, `sandbox`, `sandbox.session_bus`, `scope`, `ladder.reach` or `ladder.web_mcp`. A failing host or harness is `technical`.
- An open decision closes itself as moot once every task it waits on is closed. A worker's or reviewer's question that blocks a task whose latest tests failure also fails on main goes to the orchestrator, whatever kind it was given, unless it is `spend` or `crisis` or names an owner-required setting other than a gate waiver.

### Resources

- A scope holds harness sub-agents, MCP servers, shells and tests, also when they detach or change process groups. A nested Tower Crane launch makes a delegated child cgroup inside the inherited scope, and the kernel enforces its cap and every ancestor's. The supervisor stays outside the scope so it can record the failure.
- `OOMPolicy=kill` sets `memory.oom.group=1`, so a cgroup OOM stops the whole attempt. An unrelated scope is left running.
- Containment metadata records `pids_peak`, `memory_peak_bytes` and `refused_forks`. Every launch in a containment scope gets `TOWER_CRANE_SCOPED=1`.
- Containment cleans up after itself. A scope left failed, as an OOM leaves it, is reset once it settles and its `Result` is read. A keeper resets its scope when it ends, so a late OOM is still reported. Report directories carry the supervisor's pid, and the first contained launch of each process removes the directories and failed scopes of supervisors that were killed.
- A setup failure fails the launch with `resource-scope-failed`. It never falls back silently once cgroups were chosen. A sampling failure stops the attempt with `resource-monitor-failed`.
- Controllers kept after a normal exit stay in the agent's cgroup under a small detached keeper. Without cgroups the keeper carries the original process and RSS bound. The agent's home, cache and TMPDIR stay in place, and home pruning waits until that work ends.

### Host governor

- It reads the cgroup chain up to the shared slice, host memory and swap, memory and CPU pressure, and load. Every level must fit. It keeps room for running units to grow and for other sessions to return to their peak of the last `others_window_min` minutes, 30 by default.
- A unit's expected size starts from `expected_mb` (worker 1536, reviewer 1024, tests 2048) and follows the kind's measured peaks once three exist.
- A deferral shows in `status` on a `host governor:` line, in `inbox` as `governor_deferred` and on the board. A `wait` retries it once there is room.
- Past the stop line it stops one unit at a time: gates and suites first, then reviewers and small agents, then workers, newest first. Orchestrators are never stopped. It signals only processes it started, matched by start time, so a reused pid is left alone.
- A stopped gate records no verdict and runs again. A stopped worker resumes in its kept worktree, and neither the respawn cap nor the reviewer cap counts the stop. `inbox` shows `governor_stopped`.

### Decisions and the owner

- A moot decision records `withdrawn_by: "engine"`, `moot: true` and a reason naming each task, in a `decision withdraw` event. A decision asked about tasks already closed, such as a publish request for an accepted release, stays open, and so does a crisis.
- `needs_owner_by` records who set a task's hold. Cancelling a hold the orchestrator or the engine set is the operational `task.cancel_hold`. A hold the owner or a worker set stays `task.cancel_needs_owner`, owner-required.
- `project set --publish-policy '{"conditions": [...]}'` sets a standing publish policy once (`publish.policy`, owner-required). The conditions are `review_clean`, `full_suite` and `main_ci_green`. While they hold for an accepted release task, the orchestrator's `ask --setting publish --change '{"task":"T<n>"}'` exits 0 without a decision. When one fails, the ask opens the owner's decision and names it. `full_suite` needs passing, non-skipped cases for every host-only file at the release head.
- `ask --kind crisis --crisis host|data|security|artifact` opens an owner decision and messages the owner at once. `status` and `inbox` end with `owner: nothing needed`, the open crisis, or what waits on the owner (JSON `owner`).

### Tasks and dispatch

- The `wait` host refills worker slots on its own path, so free slots fill while a gate reaction runs the full suite. Refill runs at startup, on every state change, on the fallback tick and after each reaction pass, one at a time per host. It skips a task whose own gate reaction is still live.
- A `gates.rework_hold_min` hold dispatches when it ends, on a timer, with no other event.
- `status` names why refill leaves each ready task undispatched, such as `not dispatched: T2 worker limit reached (3 of 3: T1, T4, T5)`, a rework hold, a running gate reaction, no brief, the dispatch lock's holder or a governor deferral. JSON has `not_dispatched`.

### Gates

- A 16 MiB log whose tokens an escape and a line break split stays scannable below 1 GiB in two streams. Before, it peaked at 1.17 GiB. 16 MiB carriage-return logs, spinner redraws included, also stay below 1 GiB. Ordinary logs keep their output.
- The search for environment values a control splits is one native expression again, reading each character about once. In 0.1.5 it read every control in JavaScript per value, which took seconds on a colored log. It finds the same spans.

### Development

- `node scripts/mutants.js --check` validates mutant targets without running the sample, and `check:shared` runs it. Stale targets are repaired.
- Mutation runs use a systemd user scope with 512 tasks and 4 GiB when available, and a process watchdog otherwise. A process or memory cap counts as a caught mutant, reported apart from test and timeout catches.

## 0.1.5 (2026-10-19)

### Upgrading

- Agents no longer inherit the dispatcher's `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_PRESERVE_SYMLINKS`, `NODE_PRESERVE_SYMLINKS_MAIN` or `NODE_COMPILE_CACHE`. If a harness needs one, such as a `--require` preload or a heap size in `NODE_OPTIONS`, set it in the project or rung `env` or `env_file`. `project set --env` replaces the whole project `env`, so pass the existing entries too.

### Gates

- A plain log whose lines share a secret's first characters stays scannable. Before, a 1 MiB joined log of lines like `ok 0123456789`, with a secret that starts `0123456789`, ran over the redaction work budget and kept only `[unscannable text: ...; content omitted]`. Shared leading characters no longer start a search. An exact value, or a matching prefix a control interrupts, still does.
- A header whose value is a configured secret split by a hidden escape no longer takes the next line with it. Before, `Authorization: ;l4m\r\x1bPuuBez...` with the secret `;l4mPuuBez...`, then a line break, LF or CRLF, kept the redacted header and dropped the line after it.
- Where an environment value sits beside a token across escapes, the redactor maps each cleaned character back to the raw text in order. Before, that map could run backwards there. The redacted output was the same.

### Agents and spawn

- Before, only the git and gh shims cleared the variables listed under Upgrading, so a preload set for the dispatcher reached every agent. The rule now holds on first launches, retries and fallback routes, and names are case-insensitive on Windows. The supervisor keeps its own Node settings for host commands.

## 0.1.4 (2026-10-18)

### Security

- The git and gh shims stop with exit 127 and `git shim loop: ...` or `gh shim loop: ...` when a program on PATH ahead of the real git or gh runs the shim again and that shim would run the same program. Before, such a wrapper inside an agent recursed without end, and its processes filled the host until it ran out of memory. A wrapper that drops its own directory from PATH and runs git by name still works. As a backstop, a shim nested inside 8 others refuses to run.
- On Linux, a shim read that times out kills every process it started, not only its direct child. The read stays in the agent's process group, so stopping the agent stops it too.
- An environment value is redacted under the splits that still showed part of it in 0.1.3. One is a value whose head a line-split token takes, split by a real two-character escape. The other is a value whose characters an escape would take: `ESC [` before a letter or digits, `ESC (` before `.` or `-`, or an OSC the value goes on in. The text path redacts the whole value, and a binary artifact holding one is not copied. Such a value yields to any other secret it meets, so one that runs on from another secret can still keep part of its text; docs/state.md says when.
- A binary artifact holding a token that a real two-character escape and a line break both split, such as `ghp_Ab3dEf\x1b(B6hIj9kLm2nO\np5q...`, is not copied. Before, no view of the bytes joined it.
- The text redactor redacts every character the 0.1.3 cleanup would, which reads escapes only as a terminal does, as well as what the new readings find. Where the two put back different text for one secret, the output shows no character either hides. A binary artifact is checked with both readings of an environment value.
- An `Authorization` header that an escape glues to a token or a word keeps its value redacted. Before, `z xoxa-ab\ncdefghij\x1b(B\x1b[1mAuthorization: Bearer x` showed `x`: the cleanup removed the escapes, the token's run took the header word, and no pattern found the header. Such a header is now read with a space before it, and the header word goes back from the token when the token stays whole without it. The value is redacted to its end however long it runs. A binary artifact with such a header value is not copied.
- Text redaction has a budget. Its work and time limits grow with the input: 262144 work units plus one per character, and 5 seconds plus one per MiB. Input over 32 Mi characters is not scanned. A CI log, gate diagnostic or local CI text artifact over it keeps only `[unscannable text: <reason>; content omitted]`, its tail included. Before, a log dense with escape-split values or glued headers could exhaust memory during the scan. Plain, colored and CRLF logs of any size within 32 Mi characters keep their full output.
- Output that holds the private-use characters the redactor marks secrets with is redacted as other text. Before, such characters could turn into a placeholder or leave a marker in place of one.

### Upgrading

- `task update ID --priority urgent` marks a task urgent. Only the orchestrator or owner may set it. `ready`, `spawn --ready` and automation refill take urgent tasks first. `--priority normal` removes the mark. State with an empty or non-string `priority` no longer loads.
- Two failed reviews with blocking findings in the same file area now hold the task. Claims, readiness and worker dispatch refuse it, and the inbox shows `review_redesign` in place of `rework_ready`. Reviews recorded before 0.1.4 count, so an open task that already has two such failures is held right after the upgrade. The orchestrator or owner clears the hold with `task note ID TEXT --kind scope-ruling` for a design change, or with `task update ID --acceptance A ... --closed-acceptance` to narrow acceptance to a closed list. An ordinary note or acceptance edit does not clear it.
- A CI log, gate diagnostic or local CI text artifact over the redaction budget is replaced whole by `[unscannable text: <reason>; content omitted]`. The command's exit verdict stays.
- A host-only test that the base branch fails with the same first error line no longer reworks the task. After one retry the task stays submitted, the inbox `gate_failed` item names the main failure and offers `check tests ID`, and automation reruns the tests gate when the base tip moves past the recorded base. Before, a task that was not a hotfix was retried once and then reworked.
- A git or gh wrapper on PATH that runs `git` or `gh` by name with its own directory still on PATH now makes the shim exit 127 with a `shim loop` message instead of recursing.
- `status` prints `home kept: AGENT by a stray process PID`, or `by stray processes P1, P2`, for an agent home a stray process keeps after the agent exited, such as a daemon that inherited the launch marker and left the harness's session. Its JSON adds `kept_homes`. A sandbox that denies reading `homes/` gets an empty list.

### Review

- Worker rework names each prior blocking finding's failure class and sibling cases, covers them with a table-driven regression test, and records that under `Rework coverage` in the pre-submit summary. The worker skill says how.
- Failed review evidence records `areas`, the normalized file paths of its blocking findings. They come from structured `findings[].path` when present and otherwise from the blocking finding entries. Earlier-blocker status, reproduction references, follow-ups and fenced examples supply no area, and neither does a location outside the tree such as `PR body`. Rework keeps the structured locations, and `rework --from-review` takes the areas from the complete fetched review.
- Failed verdicts at the same commit and revision count once per area, whichever reviewers recorded them. A scope ruling's event records `review_after` and the task revision, and only failures recorded after it, at that revision or later, can hold the task again.

### Tasks and dispatch

- Ready listings, `status`, the board, batch dispatch and automation refill order urgent tasks first, then by unblock count and task id. A priority change keeps the task revision and does not stop a live run. `task list` marks only open urgent tasks.

### Gates

- A host-only failure is the base's when the base fails each shared test name with the same first error line, normalized as CI main failures are. A host-only file the task changed counts only on a specific line, not a generic one such as a timeout. The tests evidence records `infrastructure_failure` with `main_failure`, and later software gates still run. A different error under the same name still retries once and reworks.
- A token piece whose line ends in a CR, an escape and then the LF, as a progress line clears itself (`\r\x1b[K\n`), keeps its line ending. Before, the other stream's next line was joined onto the piece's placeholder, so a `not ok` line could drop out of the failing test names.

### Agents and spawn

- Pruning reads every exited agent's launch markers in one `/proc` pass, not one pass per agent, and skips the read for an exited agent with no recorded launch marker.

## 0.1.3 (2026-10-17)

### Security

- Only the owner's `init` at a terminal records the user file's folder as `owner_config_dir`. Any other `init`, the orchestrator's included, records the default `~/.config/tower-crane` under the account's home directory, and a headless owner `init` checks the owner key there. `TOWER_CRANE_CONFIG` and a key planted beside it no longer let a non-owner choose where the owner key and the owner's records live. An account whose home is missing or `/` is refused.
- An `init` by anyone but the owner no longer copies owner-only parts of the user file's primary rungs into `project.json`: `sandbox`, `env`, `env_file`, `scope`, `command`, `web_mcp`, sandbox-changing tools and undefined MCP servers. A rung that would run as a command or outside its sandbox gets the built-in rung, unless its route already is the built-in one. Each withheld part is named in a `notice:` line and in the `init` event's `withheld`.
- A personal fallback route that carries authority (`sandbox`, `env`, `env_file`, `scope`, a harness without an OS sandbox, the `command` harness, `web_mcp`, `mcp` or a non-built-in tool) runs only as the owner's `ladder set --fallbacks` wrote it. That write pins a hash of each route by position in `owner/route-grants.json` under `owner_config_dir`, covering those fields, the harness the route resolves to and the `env_file` content. The supervisor checks the pin again when it reads the file. Spawn skips an unpinned route with a notice, and `ladder show` lists it with the command that approves it. Routes that only name a model, profile, provider or effort on a sandboxed harness work as before.
- Route pins key on the user file's canonical path, so a symlink, another case on a case-insensitive filesystem or a relative `TOWER_CRANE_CONFIG` reaches the pin the owner approved. A link moved to another file after the approval does not carry it. Pins written under the path as spelled still count for that spelling until the next owner write moves them to the canonical key, and a cleared pin does not come back through an old spelling.
- Engine helpers pass the automation key on the first line of their CLI child's stdin, named by `TOWER_CRANE_AUTOMATION_KEY_FD`, instead of in `TOWER_CRANE_AUTOMATION_KEY`. Before, Linux kept the key readable in `/proc/<pid>/environ` for as long as the orchestrator's Stop hold idled in `wait --inbox`. The CLI ignores the descriptor when it is a terminal and refuses a key line over 256 bytes with exit 1. A home build writes `automation.key` to a staged file and renames it into place, so a helper never reads it empty or half written.
- The worktree lock moved from the repository's git directory to `worktree/lock` in the state directory. A sandboxed worker can write the git directory, so it could hold the old lock to stall gates, dispatch and prune for a minute, or delete a held one. Spawn refuses a `sandbox.write` path inside the state directory or one that holds the state directory or the worktrees root, and refuses an agent file with `sandbox: true` and `writeOutside: worktrees`.
- A sandboxed claude agent gets `CLAUDE_CODE_TMPDIR` apart from its commands' `TMPDIR`, so its commands can read but not write the files claude keeps there (prompts, plugin staging, task output). Before, they shared one directory, and a command could plant files that claude read back.
- A binary local CI artifact, one with a NUL byte or invalid UTF-8, is redacted at the byte level and no longer decoded. Environment secrets, matched by their UTF-8 bytes, and token shapes become ASCII `[redacted:NAME]` markers, and every other byte stays as written. Before, a file with a NUL byte was kept unredacted, and one with invalid UTF-8 was decoded, its invalid bytes becoming U+FFFD.
- A binary artifact is not copied when a secret shows that exact byte matches cannot remove: in UTF-16 text read either way and at either byte alignment, once escapes and controls are removed, or across line breaks. Its skipped entry names the view.
- Token shapes (`ghp_`, `sk-`, AWS and Slack keys, `Authorization` values) are found by a scan that reads each character a bounded number of times, so a run of any length is redacted whole. Before, a prefix followed by about 8 MiB of token characters threw a RangeError, and the tests, clean and local CI gates crashed instead of redacting their output.
- A token glued to more word characters is redacted whole and the word after it stays. Before, `ghp_<token>_backup` kept the whole token. A carriage return or other control inside a glued token no longer splits it, while one at a token's end still ends it. An AWS key ends at its 20th character.
- Every token shape is searched in the same text and overlapping matches are redacted once. Before, `sk-authorization: s3cr3tvalue` kept `s3cr3tvalue`.
- A token that a stray ESC, `ESC (`, `ESC [` or an unterminated OSC takes part of while a second escape splits it, or that a line break splits, is redacted in the local CI log, its tail and text artifacts, and a binary artifact holding one is not copied unless a real two-character escape such as `ESC (B` splits it too. A line break may also split the token's prefix: `g` at a line's end and `hp_...` on the next line is redacted. Such a break joins only with at least two of the prefix's characters before it or three after it, so `0.3 s` then a line `K-long_async` stays text. docs/state.md lists the splits that still leave part of a token.
- An environment value is found with escapes, controls and line breaks between its characters, each escape read both as an escape and as text. Two splits still leave part of a value: a bare `ESC [` whose next character reads as the escape's final byte, and an escape inside a value that sits next to a token a line break splits. A token a line break splits, glued to an `Authorization` header by a two-character escape, also leaves the header's value. These leave text only in the local CI log and text artifacts; a binary artifact holding one is not copied. docs/state.md lists these and the other known misses.
- Local CI and the tests gate's failure tail, host-only commands included, also read stdout and stderr each on its own for secrets. Before, a token wrapped onto two stdout lines with a stderr line read between the halves was stored unredacted.
- Scanning a 64 MiB binary local CI artifact stays under 500 MiB, also when it is dense with overlapping matches, NUL-separated tokens or line-split tokens. The UTF-16 views run only when the file has a NUL byte or an environment value is not ASCII.
- A sandbox placeholder that a live sandbox binds over is no longer removed by the sweep before a claude spawn or the cleanup after an agent exits. Removing it detached the bind, and another agent of the task could then write `.bashrc` or another protected name. Each removal reads every process's mount table before and after it moves the name aside, and keeps the name when one has a mount there or a table cannot be read.
- A sandboxed spawn refuses a `TOWER_CRANE_PLUGIN_ROOT` that is the home, holds it, or has no `package.json` naming `@agent-sh/tower-crane`. Set to the home, it opened `~/bin`, `~/lib` and `~/package.json` to the agent.
- Closing a broker no longer deletes its broker directory recursively. A codex agent writes that directory, and a link it swapped in during the walk could lead the delete outside. The broker removes only the entries it wrote, without following links, and renames a directory with anything else in it to `brokers/.stale-<agent>-<random>`. Something an agent leaves at `broker.sock` is removed, renamed aside or unlinked without being walked, and no longer fails later spawns.
- A brokered agent's git shim sets `GIT_CONFIG_NOSYSTEM=1`, so the remote URLs it checks and the git it runs skip the system config.
- With `sandbox.session_bus` on, a codex agent whose runtime directory lies outside `/run` under a readable path, such as `/var/tmp`, sees only the bus socket there. Before, spawn hid the directory's other entries one by one, so a socket made there later was reachable. The listed entries leave out links and entries another user could swap for a link. Spawn refuses the setting when the list would push the codex profile past the 128 KiB codex can pass its sandbox. Before, codex failed with "Argument list too long". Spawn also refuses the setting for a codex worker whose runtime directory lies in a `sandbox.write` path, in its worktree, or under `/usr` or `/etc`.

### Upgrading

- Stop older Tower Crane processes after upgrading. A 0.1.2 supervisor still running passes the automation key in `TOWER_CRANE_AUTOMATION_KEY`, which the 0.1.3 CLI no longer reads.
- `submit --force-ci-pending` and the brief line `force-ci-pending: allowed` are removed. `submit --pr` accepts a head whose checks are still running, workers no longer wait for or poll CI, and `check ci` waits on the host.
- A personal fallback route that carries authority (`sandbox`, `env`, `env_file`, `scope`, a harness without an OS sandbox, the `command` harness, `web_mcp`, `mcp` or a non-built-in tool) is skipped until the owner approves it with `ladder set --fallbacks`. `ladder show` prints the command for each.
- Only the owner's `init` at a terminal records a custom `owner_config_dir`. Any other `init`, the orchestrator's included, records the default `~/.config/tower-crane`, and an `init` by anyone but the owner withholds the user file's grants.
- The `init` rules apply to new `init` runs. A project set up by a non-owner `init` before 0.1.3 keeps the `owner_config_dir` and rung grants it recorded. Check `owner_config_dir` and the primary rungs' `sandbox`, `env`, `env_file`, `scope` and `command` in its `project.json`.
- Spawn refuses some settings 0.1.2 ran. It refuses a `sandbox.write` path inside the state directory, or one that holds it or the worktrees root. It refuses an agent file with `sandbox: true` and `writeOutside: worktrees`. It refuses `sandbox.session_bus` for a codex worker whose runtime directory lies in a `sandbox.write` path, its worktree, `/usr` or `/etc`. Narrow them before upgrading.
- `wait` cursors are `OFFSET:CUTS`. Plain offsets and event ids still work as `--after`.
- Gate output and local CI logs turn a carriage return into a newline, CRLF into one, and drop other control characters, NUL included.
- A holder of the new worktree lock also takes the old path while it is free, so an older Tower Crane process still running waits for it. A lock already at the old path is not waited for; each process that finds it prints a notice naming it. Remove it once older processes have stopped.
- A sandboxed spawn needs `TOWER_CRANE_PLUGIN_ROOT`, when set, to be a Tower Crane runtime: a directory whose `package.json` names `@agent-sh/tower-crane`, not the home or a directory that holds it. Point it at a checkout or the installed package, or unset it.
- A broker's `/tmp/tower-crane-XXXXXX` socket directory now holds `owner.json` with the monitor's pid, host and start time. A broker start removes this user's `/tmp/tower-crane-XXXXXX` directories older than a minute whose owner on this host has exited or whose pid names a later process. A directory a 0.1.2 broker made has no record and goes only when it holds nothing but a socket that refuses connections, so a broker still running keeps its own.
- Commit manifests keep `ino` and add `ino_exact`, the exact inode as a string. Recovery compares `ino_exact` when it is there, so 0.1.2 and 0.1.3 finish each other's torn commits.
- Shims from 0.1.0 through 0.1.2 frame their packs as 0.1.3 does.
- Off Windows, `spawn` and `spawn phase` events record `run_mark`, the agent's launch marker.

### CI and submit

- `submit --pr` records a head whose checks are still running. It prints the running checks with a line telling the worker not to wait for CI, and notes them on the task; `check ci` waits for them on the host. A failing check still refuses the submit while others run, and so does a failing revuto check that no `ci.capped_review` rule matches. The worker skill and the worker and researcher roles say to submit without waiting for CI or revuto.
- Submit refuses a revuto `[P1]` or `[P2]` finding already on the PR when its path has not changed since the comment and it has no `[resolved]` reply, the rule `review ok` applies. It does not wait for findings still to come. When git cannot read the commit a finding was left on, the refusal says to fetch or to use `ci resolve`.
- A hosted `check ci` failure prints the first failing lines of the first three failing job logs and the command that reads each other one, and the rework reason carries them to the worker. The excerpts are redacted as gate output is. A required run that was skipped or neutral prints no log.
- A check queued past GitHub's 24-hour queue limit plus 30 minutes, or in progress past its 6-hour job limit plus 30 minutes, stalls and shows in the inbox, as CI with nothing queued or running does after 30 minutes. A job's queue time counts from the later of its workflow run's `created_at` and `run_started_at`, so a re-run on an old head starts a new window. Before, such a check was rechecked every minute with no end. A self-hosted job allowed to run longer than 6 hours shows as stalled. A stall only flags the inbox and fails nothing.

### Gates

- Local CI, the tests gate and its timeout report, the clean gate's failure summary and local CI text artifacts share one terminal-escape stripper, which runs before redaction. The tests gate now removes OSC hyperlinks and other escapes, not only CSI sequences. The stripper also removes the 8-bit C1 forms, ends a string at the 8-bit ST, and removes a lone ESC, DEL and other stray controls.
- A carriage return ends a line, and CRLF becomes one newline. Other controls are removed, so ASCII text a Windows tool prints in UTF-16 reads as plain text. A control run inside a token shape or a redacted environment value is removed, so `ghp_ABCD\x1b\x7fEFGH...` is still redacted, and a run at a token's edge becomes a space, so the token keeps the word boundary its pattern needs.
- An OSC, DCS, SOS, PM or APC string without its terminator ends at the next newline or ESC. Before, local CI scanned to the next BEL or ST, which could remove real output between them and took quadratic time over many such strings.
- Restoring redaction markers takes one pass. Before, a text with many `[redacted:...]` placeholders took quadratic time: 1 MiB of them took minutes.
- A gate run's lease deadline covers every timed command the run may start, with a minute for the metadata queries around each. A prove-mode tests run counts its head run, the scoped proof under `tests.expensive`, the reverted run, a base rerun and one command per host-only file. Before, the deadline allowed one command timeout and a minute, so on macOS and Windows a second caller treated a healthy long run as ended and ran the gate again. A caller that joins a run it cannot observe prints the holder's deadline and the minutes left.

### Review

- A re-review after a failed review runs at or above that review's rung also when it falls back to a full review: after an amended or rebased rework, or when the reviewed commit is gone. Before, an amended rework after a hard failure could get an easy reviewer. With `min_rung: "review"` a re-review after rework still starts on the review rung.
- A fallback full re-review packet names the failed review with its summary, comment, findings and rework request, and asks the reviewer to confirm each prior blocker. Both packet kinds list the failed review's recorded findings.
- The review `spawn` event records `review_floor`, the failed review's SHA, revision, agent, rung and level that set the rung floor, and `review_scope` lists the prior findings as `findings`.

### Ladder and routes

- A rung moved to another harness drops each tool name the new harness does not know and keeps the rest. A claude rung with `tools: ["WebFetch"]` moved to codex no longer starts codex with `--enable WebFetch`, which codex refuses. `ladder harness` refuses a rung that follows the default when one of its tools is unknown there.
- A personal fallback that follows its rung's harness is checked when the rung moves. `ladder set` and `ladder harness` print a `notice:` for a route left naming a model or tool the new harness cannot run, `ladder show` lists it as unable to run instead of asking for an approval, and spawn skips it. The user file is not edited. A route that names its own harness is not judged, and one that may use a proxy (an `env_file`, or `OPENAI_BASE_URL` or an `ANTHROPIC_*BASE_URL` in `env`) has only its tools judged.
- The model check reads `opus[1m]` and other aliases with a context suffix as Claude aliases. An opaque Bedrock ARN (an application inference profile, a provisioned or custom model) has no vendor, while a foundation-model or inference-profile ARN keeps its model's vendor. An id such as `o3k2abc` no longer reads as an OpenAI model, and a Claude or Gemini model on a codex route with a custom provider (OpenRouter, LiteLLM) is kept.
- The Settings page lists every drop and notice of a save under the form, refreshes its last-change line, and names each rung of the newest save with what it dropped.

### Agents and spawn

- A `spawn` event records `startup_ms`, the duration of each startup phase: the dispatch's handshake and receipt windows and the supervisor's boot, setup, lease wait and launch. A kept `-startup-failed-` log ends with the same phases, and a start that runs out of time keeps its log even when the supervisor wrote nothing.
- Startup-failed logs no longer pile up. Each kept or moved-aside one removes the task's older ones beyond the newest 5.
- A spawn inside another agent no longer runs that agent's git shim for its supervisor's config scan, which could make the start miss its 10 s window. Empty PATH entries are skipped, and a PATH with nothing left refuses the start instead of finding git in the agent's worktree.
- Where there is no `/proc`, as on macOS, dispatch asks `ps` every 100 ms whether a supervisor that has not reported has exited, instead of waiting out the 10 s.
- The codex config escapes DEL (U+007F) in strings and keys. A path holding it made codex reject the whole config.
- `spawn --dry-run` no longer reads a claude rung's `env_file`. With a short cache root, as a user's own `~/.cache` is, a missing or unreadable file failed the preview.
- A dead agent's home and broker directory are removed only once its monitor, its harness and every process left in the harness's process group have exited. Before, a process the agent left behind could still write the tree while it was deleted. `brokers/.stale-<agent>-<random>` directories go once their agent is gone.
- On Linux, a dead agent's home and broker directory stay while a process carrying one of the agent's launch markers runs, so a process that left the harness's group with `setsid` can no longer write the tree while it is deleted.
- On Linux, a process group whose leader's pid now names a process that started later reads as exited. A dead agent's home and broker directory, and a dead worker's reservation, no longer stay behind when the pid is given out again.
- A broker start removes the `/tmp/tower-crane-XXXXXX` socket directories that killed spawn monitors left behind. A start that cannot listen removes the directories it made, and a failed cleanup no longer hides the error that caused it. A FIFO planted as a broker's `owner.json` no longer blocks later broker starts.
- An agent that hung up while the broker checked or pushed its commit is seen when the last pack frame and the end frame arrive in one read. Before, the push still ran.
- The spawn sweep no longer warns at every spawn about a symlink by a sandbox placeholder name. The submit refusal for an empty placeholder-named file says that a real file by that name needs content.

### Locks and dispatch

- The worker dispatch lock keeps a live holder on the same host and pid namespace whatever its age, also on macOS and Windows. Before, a dispatch that ran past 60 s there could lose the lock to a second one, which then took a slot ranked for another task. A holder elsewhere counts as gone 60 s after its marker last changed; holders touch it every 10 s, also while they wait for the worktree or state lock.
- The `wait` host no longer waits for the dispatch lock, a refill or a climb its recovery dispatches. A held lock defers the work to the next pass, so the host keeps handling events instead of freezing for up to 140 s per pass. A climb stays pending until then or until `recover`. A CLI `spawn` and a supervisor still wait up to 140 s for the lock, without blocking the event loop.
- A dispatch lock whose gone holder's marker cannot be removed is reported once per wait, not on every pass. `TOWER_CRANE_LOCK_TRACE` records dispatch lock holdings again, labelled `dispatch`.
- The worktree lock holds its holder's marker, as the state lock does. The next process that wants a killed holder's lock clears it. A live holder on the same host and pid namespace keeps it whatever its age; a holder elsewhere counts as gone 60 s after its marker last changed, and gates under automation refresh theirs every 10 s. The lock is per state directory, so two projects on one repository do not exclude each other.
- Removing a task worktree (cancel, retirement, `worktree prune`) and each prune run under the worktree lock, so a relink no longer writes into an admin directory git is emptying. Preparing a worktree that a retirement is removing is refused at once.
- The orchestrator lease recognizes more session ancestors. A macOS login shell that `ps` names `-zsh` counts as a session shell, and so does `fish -i -C 'source x'`. `gemini`, `aider`, `goose` and `cursor-agent` count as harnesses, including Node and Python entrypoints. Other agent CLIs share their terminal shell's lease.

### Stacks

- Stack sync and refresh defer, with a reason naming it, when a member worktree has a rebase, merge, cherry-pick, revert, `git am` or `git bisect` in progress. A `gh stack sync` killed by a second signal or its timeout could leave a rebase that `git status` does not show, and the worker got that state. A spawn of such a task refuses with the same reason instead of git's "already used by worktree" error.
- A drain during a spawn's stack refresh inside `wait` starts no agent and stops the rest of the refill batch. The spawn records `stack sync deferred`, and the next `wait` refreshes the stack and dispatches it. A drain that reaches a climb dispatch in recovery leaves the climb pending, and `wait` still exits 0.

### State and events

- Lock recovery records each cut it makes to `events.jsonl` in `events.cuts.jsonl`. Tailing readers (`wait`, `serve`, the wait host's history) go back to a recorded cut instead of resuming mid-line, so no event appended after it is skipped, even when the log grew past where they stopped. Recovery writes `cut.<id>.json` before it cuts, so a holder that dies between a cut and its record leaves the record for the next holder, and keys each record by the last event id of the commit it cut. When a tool through 0.1.2 finishes a recovery that a newer holder left cut but unrecorded, the next holder records the cut as `late`.
- `wait`, `GET /api/messages`, the Claude Code event watch and the orchestrator's Stop hold hand out cursors that carry the length of `events.cuts.jsonl`. `wait` prints `cursor` (`OFFSET:CUTS`) beside every `offset` and takes it back with `--after`; the API returns `cuts` beside `cursor` and takes it back as `?cuts=`. Such a cursor resolves exactly across a cut, including a cursor from before the cut at an offset where a new line also ends, which a plain offset misses. Plain offsets keep working, and a cursor handed out after a cut never moves. An orchestrator home's `hook.json` keeps `after` as a plain offset and adds `cuts`.
- `wait` and the board's SSE stream no longer replay restored history when a restore takes more than one read, such as `cp backup events.jsonl` or moving the log away and copying it back. Readers tell restored records by event id. Any other record wakes, including one from a writer whose clock is behind. Only an older backup without the start line falls back to records written no later than the reader's start.
- Sketch stamps compare the cut count before the log size, so a render that stamped torn bytes no longer keeps later writes' sketches out.
- The lock-free read fast path checks the filesystem on macOS and Windows too. On macOS it runs only when the state directory's filesystem has the same statfs type number as `/`; a state directory on any other filesystem type compares the log's last line. On Windows a state directory whose real path is a UNC path compares.
- A write or the wait host keeps parsed state files only for the event log it read them with, so a file that reuses a replaced one's inode, size and times can no longer show state behind the events.
- Lock holders delete temp files that dead writers left in the state directory. Recovery refuses, without touching them, staged commits under a newer `schema_version`.

### Windows

- A recovery that Windows stops because another process holds a staged commit file open counts as a busy lock: writers retry until their deadline and exit 3, and try-locks exit 3 at once.
- The dispatch and worktree locks are freed when their holder was killed and Windows gave its pid to a new process, as long as the holder's creation time can be read. The lock marker records when Windows created the holder, and a live pid created at another time no longer counts as the holder. A marker written by 0.1.2, which has no creation time, behaves as before. Before, such a lock stayed held for as long as the unrelated process ran.
- A resume after a failed start moves the earlier attempt log aside once the recorded spawn exited, even when Windows gave its pid to a new process. Before, the resume was refused with `EEXIST: log already exists` until that process exited.
- `status` and `ready` count a claim as exited once its supervisor records the attempt inactive, before any pid probe, so a reused harness pid no longer makes them disagree.
- Releasing output holders compares each process's creation time with the snapshot exactly, from one CIM reading on both sides taken while the stop holds every target's handle, instead of matching .NET's StartTime within 1 ms. A target that exits after its creation time is read is reported `gone`, not `stopped`.
- A process whose own lock marker could not be deleted on release, while a scanner holds it, retries the deletion at its next look instead of keeping the lock for as long as it runs.
- Lock-free readers notice a log replaced while they read. They compared file ids as Numbers, which round past 2^53, so a replaced log could pass for the one they read. Git lock and sandbox placeholder cleanup, the board's reload signature and the spawn monitor's state signature compare exact file ids too.
- The orchestrator lease reads Windows command lines as CommandLineToArgvW does for runs of quotes: `"a""b"` is `a"b`.

## 0.1.2 (2026-10-15)

### Agents and sandboxes

- `spawn --wait` and the supervisor no longer wait forever when a process the agent started, such as a dev server or a watcher, keeps the harness output open after the harness exits. Five seconds after the harness and its group stop, the supervisor stops the processes it can trace to that harness on Linux and Windows, keeps the output it read, records them as `output_held` in the `spawn exit` event, and finishes. Elsewhere it closes the output without stopping them. It never stops a Tower Crane supervisor or anything under one, so tasks an agent dispatched keep running.
- The CLI and the supervisor treat a Windows `EOF` write error like `EPIPE`, so a command whose output reader is gone no longer crashes.
- On Windows, spawn no longer fails when the freshly copied skill store cannot be renamed for a moment (EPERM while a scanner or the indexer holds the new files). The rename is retried for up to 2 s, as state writes are. The same retry covers the rename that keeps a failed start's log and the broker's move of an agent's pack into its push cache. A log that still cannot be renamed stays under the agent's log name, and spawn reports the startup failure and that path instead of EPERM.
- A failed start's log no longer blocks later spawns of the task with `EEXIST: log already exists`. When no running spawn can own it, spawn moves it to a `-startup-failed-<time>.log` name, says so on stderr, and starts.

### State

- On Windows, state reads and existence checks wait out a sharing refusal (EPERM, EACCES or EBUSY) for up to 2 s, as state writes already did. Before, a CLI read without the lock failed outright, a refused existence check looked like a removed state directory, and a supervisor whose periodic read met a rename in progress failed with `supervisor failed: EPERM` and stopped its worker mid-edit. Other platforms still fail at once.

## 0.1.1 (2026-10-15)

### Agents and sandboxes

- A sandboxed agent can fetch from an ssh or private https origin. Its `git fetch origin` goes through its state broker, which fetches with your login on the host and returns the base, the stacked base and the task branch. `git pull` from such an origin is refused with the fetch-then-merge steps that work.
- A sandboxed worker or reviewer can run `tower-crane wait` again, as the role skills tell it to. The wait is scoped to its own task and bounded by `--timeout`; `--follow`, `--observe` and `--inbox` stay the orchestrator's.
- The broker's own fetches and pushes stop after 10 minutes without output or an hour in all, so a remote that stops answering no longer holds the project's cache lock.
- Every skill path an agent is given names a copy in the state directory's skill store, which never goes away and which claude and codex sandboxes can read. A reviewer dispatched from a worker's monitor no longer gets a path that vanished when the worker exited. A prompt that names a missing role skill warns.
- Worker dispatches take slots one at a time under a dispatch lock, so concurrent refills keep the readiness order.
- `ladder set` and the Settings page drop the fields a rung's old harness chose when the rung moves to another harness, and print what they dropped. `ladder harness` refuses a rung that follows the default when its model cannot run on the new harness.

### Gates

- `check clean` judges only the change. When the cleanup tool's report has no diff scope, findings outside the lines the change touches are listed as out of scope and fail nothing, with a note naming the diff-scoped deslop.
- A tests, clean or local CI gate runs once per task, head and revision. A manual `accept`, `check` or `gates retry` that reaches a gate already running joins that run and uses its evidence instead of starting a second copy.
- Local CI and the merge line's head check run on a clean checkout of a commit that merges the head with the base, so scripts that require a clean tree pass.
- A local CI run keeps its full output in `logs/` under the state directory, redacted, and a failure records the last 200 lines. `ci.local.artifacts` and `ci.local.artifact_pattern` name files, such as a check receipt, that a failed run copies out of the gate worktree.
- Gate output joins stdout and stderr by whole lines. Before, a chunk of one stream could land inside a line of the other, so a secret cut in two escaped redaction in `output.log`, tails and summaries. A line longer than the kept tail is replaced by `[overlong line omitted]`, and the clean gate redacts its tool's output before cutting its failure summary.
- Gate worktrees and scratch default to `tc/g` under your cache directory instead of the system temp directory, which is often RAM-backed. Gates remove leftover directories whose owner is gone.
- `gates retry ID --from-rework` undoes an automatic rework of a failed `tests`, `clean` or `ci` gate once a cause outside the code is fixed. The task returns to its submitted revision, its passing evidence and review count again, and only the failed gates rerun. Automatic refill holds such a rework for `gates.rework_hold_min` minutes (default 5) before it dispatches a worker.

### Hotfix

- Hotfix CI no longer confirms a failure the base already had at the merge commit. It is `main_red`, and CI waits for a later green run that contains the merge.
- When the merge commit's push run was cancelled or never ran, hotfix CI accepts the first green run of the same workflows at a later main commit that contains it. A required job the workflow skips for that event no longer fails it.
- A hotfix tests failure that also fails at the merge's first parent is infrastructure: the hotfix stays submitted and opens no follow-up. The owner can accept it with `--waive tests`.
- `hotfix ID --pr N --reason R` re-records a hotfix cancelled by a failure that was not the change's, and cancels its follow-up.
- The tests gate lists each changed host-only test file's ran and skipped counts and skip reasons. A hotfix whose host-only tests only skipped waits on `tests.host_env` in the inbox.

### State and board

- A reader without the lock also checks that the event log still ends with the line it read, so it never returns a write's files without its events.
- A Controls save on the board gives up its data reload after 10 seconds and frees the form, and a failed reload no longer reads as a failed save.

## 0.1.0 (2026-10-14)

First release. Tower Crane is a CLI and a Claude Code plugin for handing software work to coding agents. An orchestrator plans the work into tasks, spawns a worker per task in its own worktree and sandbox, has each change reviewed by an agent that did not write it, and merges it once software gates pass. Install with `npm install -g @agent-sh/tower-crane`; Node 24 or newer.

### Plan and state

- The plan lives in plain files under `.tower-crane/` in the main checkout: `project.json`, `tasks.json`, `decisions.json`, `briefs/` and an append-only `events.jsonl`. Only the CLI writes them, under a state lock that waits up to 60 seconds. `validate` reports state that drifted from the log.
- `init`, `task add` (with `--brief FILE`), `plan import`, `brief set` and `task update` build the plan. A task is ready when its dependencies are accepted and no open decision blocks it.
- Every task has a tier: `easy`, `medium`, `hard` or `research`, picked from its kind and size or set with `--tier`. Only a size `S` docs task starts on `easy`; code, ops and design tasks start on `medium`, or `hard` at size `L`. A tier range starts low and climbs one rung, in a fresh session, after a confirmed failure; at the top of the range it stops for an owner decision.
- Rework and brief changes after the first submission start a new task revision, so earlier gate and review evidence stops counting.
- Settled gate output over 1 KiB moves to `evidence/<task>/`, which keeps `tasks.json` small and writes fast.
- State writes survive a crash or power loss. The event log is synced before a command returns, and a write logs its events before it renames the files they describe into place. The next lock holder finishes or discards a write whose process died, so a task change never lands without its event. `validate` also reports a `tasks.json` change whose event the log lacks.
- Reads such as `status` take no lock and see a write as soon as its events are in the log. Writes parse state before they wait for the lock, and rendering the board runs outside it. `TOWER_CRANE_LOCK_TRACE=FILE` records lock waits and holds.
- A corrupt state file names the fix: repair it by hand from `events.jsonl` or restore a backup of the state directory.
- Older tools keep newer task values, fields and events they do not know. A breaking state change refuses new spawns instead of corrupting state.

### Agents and harnesses

- `spawn` runs workers, researchers, reviewers, small checks and orchestrators on Claude Code, Codex, OpenCode, Antigravity and pi. A `command` rung runs any other CLI with `{prompt}`, `{brief}`, `{task}` and `{cwd}` substituted.
- Each spawned agent gets a fresh config home and a role file. Your memories, plugins, hooks, MCP servers and approved commands do not load there. The agent gets your global rules and the repository's AGENTS.md and CLAUDE.md chain by path, and its prompt opens with the project goal. `spawn --dry-run` prints the agent file, the rules and the exact command.
- The model ladder maps each tier and the orchestrator, review and small jobs to a harness, model and effort. Built-in defaults: Claude Opus for the orchestrator, hard and research tasks, Codex profile `sol` for medium, Claude Haiku 5.5 for easy tasks, review and small checks. Change rungs with `ladder set` and `ladder harness`, and keep your own defaults with `ladder save-user`.
- Claude rungs can use Anthropic or Amazon Bedrock. A rung can name fallback routes: after bounded retries of a provider outage or a harness policy refusal, the agent continues on the next route in a fresh session.
- A harness login failure, such as an expired Claude session, pauses that harness and routes new work around it, with one notice telling you the re-login command.
- A claim is a lease that the supervisor renews while the agent makes progress; an expired lease frees the task. Worker spawns reserve a slot, so a full worker limit refuses dispatch before launch.
- `interrupt` stops a worker and keeps its uncommitted work for the next dispatch. `release --pr N` hands the task back with its open PR, so the next worker resumes that PR.
- A resumed worker that overflows its context starts one fresh session on the same route and keeps its claim and worktree.
- A task whose workers exit 3 times without submitting at one revision is parked for the owner instead of relaunched. Outages, login failures, interrupts and budget stops do not count, and `owner-done` restarts the count. `task show` prints the last worker's log tail.
- Worker spawn refuses a repository without an `origin` remote. A spawn whose supervisor fails to start says why and keeps its log. A spawn monitor whose state directory is removed stops its agent.
- `validate` warns when no installed harness can run a worker or reviewer, when an open task's tier cannot start, and when gh is missing or not logged in.
- Spawn sweeps the homes and broker directories of dead agents, keeping any with an unexpired claim or a live process. Temporary spawn briefs go in your cache directory, not the system temp directory.
- Design tasks and tasks with `needs: ["browser"]` get your browser MCP kit (`browser-kit set`, playwright by default).

### Isolation and security

- On Claude Code and Codex, workers run in a sandbox that writes only their worktree, a cache of their own and what commits and fetches need in the repository's git directory. The git directory's config, hooks and worktree admin files stay read-only, so a worker cannot plant a command that later runs on the host. Reviewers and small checks cannot write the worktree.
- Under your home, agents read only the paths they need, and a file made there after spawn stays hidden. Credential stores such as `~/.config/gh`, `~/.aws` and harness logins stay hidden, and agents read only the code of the Tower Crane install they run from, not its state. `sandbox.read` adds paths, with your approval. A `sandbox.read` or `sandbox.write` path that would expose agent homes, broker tokens, the owner key or the whole home is refused.
- Each sandboxed agent gets a temp directory of its own as `TMPDIR`. Codex agents cannot reach your `TMPDIR` or the host's `/tmp`. Both sandboxes hide `/run` except the DNS resolver, so agents cannot reach the system bus, docker or other host sockets; `sandbox.session_bus` (owner-required) grants the session bus.
- Claude agents reach only GitHub and `registry.npmjs.org` by default. `sandbox.domains` (owner-required) adds hosts, and `*` allows every host. Spawn names each git remote host the list leaves out.
- A sandboxed agent holds no GitHub credential. Its `git push` and `gh` commands go through its state broker, which runs them on the host with your login. The pack travels in length-prefixed frames, so brokered pushes work over Windows named pipes too. A push lands only on the task branch on `origin`, never with force, and is refused when it changes a workflow or action the task does not name. gh writes reach only the task's own pull request. OpenCode, Antigravity, pi and `command` rungs are not sandboxed and get no such guarantee.
- A sandboxed agent cannot write the state directory. A broker outside the sandbox, holding a token made for that spawn, runs only its role's commands on its own task and never runs the agent's code.
- `git` and `gh` shims, on Claude Code and Codex alike, allow a list of commands per role and clear `NODE_OPTIONS` and the other Node preload variables. A sandboxed agent's `msg` reaches only the orchestrator or the owner.
- Git started by the CLI, the gates and a spawned agent's harness process ignores commands from repository config that a worker could write: hooks, drivers, helpers, aliases, pagers and proxies come only from your own system or global config. It also ignores replace refs and refuses to run while a planted `commondir` file redirects the repository; the supervisor removes such a file as soon as it appears.
- Gates, merges and broker commands run with your environment. The agent's `HOME`, shims and identity apply only to the harness process.
- Owner actions need a process you run: `--agent owner` works at a terminal or with the key from `tower-crane owner-key`, which every sandbox hides. Setting `TOWER_CRANE_VIA=automation` does not let a session write under another session's lease, and spawned agents do not inherit it or the dispatcher's harness session ids.
- Rung and project `env` values stay out of events, receipts and process arguments; only variable names are recorded.
- The board's write token reaches only the browser you open from the one-time link `serve --agent owner` prints.

### Gates

- `accept` runs the software gates the task's kind needs on the submitted commit and records each command receipt as evidence. Only evidence with a matching audit event counts.
- **tests**: in `prove` mode the pinned test command passes at the submitted head and fails with the change reverted. Test-only diffs run once at the head. Host-only tests (`tests.host_only`), test maps and an expensive mode with a scoped proof command are supported.
- **clean**: the pinned cleanup tool reads the change against the base and reports no HIGH finding.
- **sources**: every quote in a research task's `research/<id>.json` is found on its cited page.
- **ci**: the PR head is the submitted commit, GitHub reports it mergeable, and the latest run of each required check passed on it. Superseded runs do not block. Pending CI is rechecked once a minute; CI with nothing queued or running for 30 minutes is stalled and goes to the inbox. Status and the board tell failed, stalled, pending and missing gates apart.
- **merge**: the PR head still matches the accepted commit, and the gates still pass, when it merges.
- Gate commands are pinned in project settings, and receipts from other commands or test settings do not count. A missing pin waits as configuration instead of failing the task.
- An infrastructure failure (a timeout, a killed runner, a cancelled CI run, a test that also fails on the base branch, a base rerun that was killed or timed out) runs the gate once more. Any other failure sends the task to rework with the failing test names and the output tail.
- Gate commands leave no processes behind on Linux, detached ones included, and never start a detached `git gc`. Host-only tests get a short `TMPDIR` when the gate scratch is too deep for socket paths.
- `gates.executors` caps concurrent gate runs on a host (default 2). Merges of accepted tasks take the next free executor ahead of submitted-task gates, in acceptance order. `gates prioritize` moves a submitted task ahead in the queue, and `gates retry` reruns failed gates at the same head. `gates.tests_timeout_min`, `gates.clean_timeout_min` and `gates.tmp_root` set budgets and the scratch location.

### Review

- Review evidence counts only from a reviewer `spawn` dispatched for that task, commit and revision, or from the owner. Other review records stay in the ledger marked as not counting.
- The reviewer gets the diff, the acceptance and the gate receipts in a fresh context. Selection starts at the task's tier and moves up for a large or risky diff. The review policy's `min_rung` sets the lowest reviewer rung.
- revuto is optional; agents skip its steps on a PR without revuto comments or checks. Open revuto inline findings marked `[P1]` or `[P2]` block an ok review until a reply marks them `[resolved]` or the file changes. `ci resolve` posts that reply. Findings count only from revuto's own logins.
- Reviews separate blocking findings from follow-ups. A re-review carries the failed review's blockers and reads only the change since that review, at no lower rung. A rewritten history or base update resets that scope.
- A false claim only in the PR body is corrected and checked without a new revision. A fix that touches only changelog fragments gets a light claim check.
- A reviewer that exits without a verdict does not trigger another at the same head, and after 3 reviewer crashes at one head and revision automation stops replacing them. Review waits for a new head, revision or revuto thread, or for `accept`, and the inbox lists a `review_held` item.
- `rework --from-review` sends a failed task back with the review's findings in its brief. Tasks that keep failing review show up in the inbox at `review.churn_after` (default 3).

### Automation, merge and stacks

- The orchestrator's `tower-crane wait` runs the software reactions itself: gates after a submit, review once gates pass, accept after a passing review, the merge queue and refilling free worker slots. Reactions keep running while the lease holder's process lives, even past a missed heartbeat.
- On SIGTERM or SIGINT, `wait` finishes its running gate, starts no new work and exits 0. A second signal stops the gate and any stack command at once. Interrupted reactions retry at the next start.
- In Claude Code, the plugin's mod wakes the orchestrator on new events. Spawned orchestrators on Claude Code and Codex get the same wakeups from their home hooks.
- `submit --pr` checks the PR's CI and revuto findings at the head before recording it. Workers read failing checks, job logs and code-scanning alerts with `ci checks`, `ci log` and `ci alerts`.
- `merge` squashes the PR at the accepted head. The merge queue lands accepted PRs in acceptance order and runs the full suite on the merge with the current base only when the head does not already contain it.
- `hotfix` records a PR already merged outside Tower Crane, runs the gates and review at its merge commit and accepts the task as `accepted (hotfix)`. A confirmed failure opens a follow-up task. `--review URL` counts a clean-context review already posted on the PR.
- A task can start on a submitted dependency before it merges. Its PR targets the dependency's branch, the chain is linked as a GitHub stack, and the merge lands it bottom up, pinning each accepted head. A stack link is refused only when the chain it read changed, and then retries from fresh state, so a worker's PR is linked before its monitor exits.
- PR conflicts confined to declared generated files (`tower-crane.generated` in package.json) are regenerated and pushed without a rework round.
- Task worktrees are tracked and removed on merge or cancel, with uncommitted work saved first. `worktree list` and `worktree prune` show and clean live, stale and orphan worktrees. Moving the project directory keeps them working, and a task branch tracks its namesake on `origin`.

### Decisions and authority

- `ask` opens a decision that blocks only the tasks it names; everything else keeps moving. Decisions have a kind: `technical`, `spend`, `credential` or `setting`. Technical decisions are the orchestrator's to answer by default; the others stay with you.
- `decision withdraw` closes a decision that became moot, and `decision delegate` changes who may answer.
- One authority table classifies every guarded setting as operational or owner-required (`tower-crane authority` lists it). An orchestrator's owner-required change opens a decision with `approve` and `decline`; once approved, the orchestrator's repeat of the same command applies it once.
- One orchestrator session writes at a time, under a lease. Scripts its harness launches share the lease; in-process subagents need `--agent` to act as someone else. `orchestrator release` hands it off and `orchestrator takeover` lets the owner take it.

### Board, inbox and spend

- `tower-crane serve` shows the board on `127.0.0.1:4747`, live over server-sent events, in light and dark themes. It leads with whether work is moving and what needs you, with rooms for review, plan, spend, history, settings and controls. As the owner you can answer decisions, message or stop an agent, pause and resume dispatch, edit settings and accept a task with gate waivers there; an owner-required waiver opens a decision first. It never merges. `render` writes the same board as a static `sketch.html`.
- `inbox` lists what needs the orchestrator, each item with the command that resolves it. The `tower-crane` MCP server exposes the inbox and batch tools.
- `inbox` and `wait --inbox` also watch CI on the project base. A red push, schedule or dispatch run is a `main_ci_failed` item, and a test that fails again after a green run is a `main_ci_flaky` item; each opens a fix task or names the open one. `status` prints the red runs.
- The supervisor reads each running agent's token usage from the harness's own session data. Project and per-task budgets stop an agent that crosses them and ask you to raise the budget. Spend records price Bedrock and 1M-context model ids and mark API or subscription billing.
- `bench tokens` reports tokens and cost per accepted task by rung. `bench gates` scores each gate's precision and recall from the event log.

### Claude Code plugin

- The plugin adds the `tower-crane`, `tower-crane-work` and `tower-crane-review` skills, five agent files, six commands (`/tower-crane-inbox`, `/tower-crane-spawn-ready`, `/tower-crane-merge-accepted`, `/tower-crane-rework-from-review`, `/tower-crane-release-dead`, and `/tower-crane-watch` from the mod), the `tower-crane` MCP server and the wakeup mod. Agent prompts name the role skills by their path in the installed package. It needs the CLI on `PATH`.
- `tower-crane --version` prints the installed version.
