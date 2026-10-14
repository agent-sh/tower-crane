# Changelog

## 0.1.0 (2026-10-14)

First release. Tower Crane is a CLI and a Claude Code plugin for handing software work to coding agents. An orchestrator plans the work into tasks, spawns a worker per task in its own worktree and sandbox, has each change reviewed by an agent that did not write it, and merges it once software gates pass. Install with `npm install -g @agent-sh/tower-crane`; Node 24 or newer.

### Plan and state

- The plan lives in plain files under `.tower-crane/` in the main checkout: `project.json`, `tasks.json`, `decisions.json`, `briefs/` and an append-only `events.jsonl`. Only the CLI writes them, under a state lock that waits up to 60 seconds. `validate` reports state that drifted from the log.
- `init`, `task add` (with `--brief FILE`), `plan import`, `brief set` and `task update` build the plan. A task is ready when its dependencies are accepted and no open decision blocks it.
- Every task has a tier: `easy`, `medium`, `hard` or `research`, picked from its kind and size or set with `--tier`. Only a size `S` docs task starts on `easy`; code, ops and design tasks start on `medium`, or `hard` at size `L`. A tier range starts low and climbs one rung, in a fresh session, after a confirmed failure; at the top of the range it stops for an owner decision.
- Rework and brief changes after the first submission start a new task revision, so earlier gate and review evidence stops counting.
- Settled gate output over 1 KiB moves to `evidence/<task>/`, which keeps `tasks.json` small and writes fast.
- State writes survive a crash or power loss. The event log is synced before a command returns, and a write logs its events before it renames the files they describe into place. The next lock holder finishes or discards a write whose process died, so a task change never lands without its event. `validate` also reports a `tasks.json` change whose event the log lacks.
- Reads such as `status` take no lock. Writes parse state before they wait for the lock, and rendering the board runs outside it. `TOWER_CRANE_LOCK_TRACE=FILE` records lock waits and holds.
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
- An infrastructure failure (a timeout, a killed runner, a cancelled CI run, a test that also fails on the base branch) runs the gate once more. Any other failure sends the task to rework with the failing test names and the output tail.
- Gate commands leave no processes behind on Linux, detached ones included, and never start a detached `git gc`. Host-only tests get a short `TMPDIR` when the gate scratch is too deep for socket paths.
- `gates.executors` caps concurrent gate runs on a host (default 2). Merges of accepted tasks take the next free executor ahead of submitted-task gates, in acceptance order. `gates prioritize` moves a submitted task ahead in the queue, and `gates retry` reruns failed gates at the same head. `gates.tests_timeout_min`, `gates.clean_timeout_min` and `gates.tmp_root` set budgets and the scratch location.

### Review

- Review evidence counts only from a reviewer `spawn` dispatched for that task, commit and revision, or from the owner. Other review records stay in the ledger marked as not counting.
- The reviewer gets the diff, the acceptance and the gate receipts in a fresh context. Selection starts at the task's tier and moves up for a large or risky diff. The review policy's `min_rung` sets the lowest reviewer rung.
- Open revuto inline findings marked `[P1]` or `[P2]` block an ok review until a reply marks them `[resolved]` or the file changes. `ci resolve` posts that reply. Findings count only from revuto's own logins.
- Reviews separate blocking findings from follow-ups. A re-review carries the failed review's blockers and reads only the change since that review, at no lower rung. A rewritten history or base update resets that scope.
- A false claim only in the PR body is corrected and checked without a new revision. A fix that touches only changelog fragments gets a light claim check.
- A reviewer that exits without a verdict does not trigger another at the same head. Review waits for a new head, revision or revuto thread, and the inbox lists a `review_held` item.
- `rework --from-review` sends a failed task back with the review's findings in its brief. Tasks that keep failing review show up in the inbox at `review.churn_after` (default 3).

### Automation, merge and stacks

- The orchestrator's `tower-crane wait` runs the software reactions itself: gates after a submit, review once gates pass, accept after a passing review, the merge queue and refilling free worker slots. Reactions keep running while the lease holder's process lives, even past a missed heartbeat.
- On SIGTERM or SIGINT, `wait` finishes its running gate, starts no new work and exits 0. A second signal stops the gate and any stack command at once. Interrupted reactions retry at the next start.
- In Claude Code, the plugin's mod wakes the orchestrator on new events. Spawned orchestrators on Claude Code and Codex get the same wakeups from their home hooks.
- `submit --pr` checks the PR's CI and revuto findings at the head before recording it. Workers read failing checks, job logs and code-scanning alerts with `ci checks`, `ci log` and `ci alerts`.
- `merge` squashes the PR at the accepted head. The merge queue lands accepted PRs in acceptance order and runs the full suite on the merge with the current base only when the head does not already contain it.
- `hotfix` records a PR already merged outside Tower Crane, runs the gates and review at its merge commit and accepts the task as `accepted (hotfix)`. A confirmed failure opens a follow-up task. `--review URL` counts a clean-context review already posted on the PR.
- A task can start on a submitted dependency before it merges. Its PR targets the dependency's branch, the chain is linked as a GitHub stack, and the merge lands it bottom up, pinning each accepted head. A stack link that races a task event retries from fresh state, so a worker's PR is linked before its monitor exits.
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

- The plugin adds the `tower-crane`, `tower-crane-work` and `tower-crane-review` skills, five agent files, five commands (`/tower-crane-inbox`, `/tower-crane-spawn-ready`, `/tower-crane-merge-accepted`, `/tower-crane-rework-from-review`, `/tower-crane-release-dead`), the `tower-crane` MCP server and the wakeup mod. It needs the CLI on `PATH`.
- `tower-crane --version` prints the installed version.
