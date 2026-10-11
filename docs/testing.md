# Testing

The suite proves behavior through the real CLI on temporary git repositories. It stays small enough to run often without loading the machine. This page is how to run it, how to write for it, what it costs and how its accuracy is measured.

## Running

- `npm test` runs every file in `test/` and `test/gates/`. Every concurrency option, including repeated and space-separated values, is consumed before emitting one value. File workers are capped at 4 and at one below the machine's core count, since each file also starts CLI, git and stub processes.
- `npm test -- test/claim.test.js test/gates/tests.test.js` runs only those files. Pass node:test flags the same way: `npm test -- test/events.test.js --test-name-pattern="decision answer"`.
- Run only the files a change touches. The tests gate runs the full suite once at the submitted head, and CI runs it on Linux (Node 24 and 26) and on Windows in three shards.
- Set `TOWER_CRANE_TEST_TMP` to keep temporary repositories off `/tmp`.

For projects Tower Crane manages, expensive proof is the default: the orchestrator pins `--tests-cmd "npm test" --tests-expensive true --tests-proof-cmd "node --test {tests}"`. A submission then runs the full suite once and proves the change with its own test files.

## Writing tests

- One integration test per piece of functionality and one end-to-end test per full feature. A unit test is only for pure logic nothing else reaches.
- A table of variants over pure logic runs in process against the module, with one CLI test for the wiring: address ranges and markup in `test/sources.test.js`, build-file and policy tables in `test/gates/tests.test.js`, outage classification in `test/supervision.test.js`, broker authorization in `test/broker.test.js`.
- A fixture several tests share is built once per file with `cachedFixture(t, key, build)` from `test/helpers.js`. Each test gets a copy, with paths that name the template rewritten in its files, env and git config.
- Each test repository has its own `HOME`, so no test writes the developer's home: `spawn` keeps receipts under `~/.cache/tower-crane`.
- Readiness waits use `test/signals.js`: `fileWritten(file)` watches the parent directory so empty writes and atomic replacements count; `eventAppended(file, predicate)` reads only complete JSONL records; `childExit(child)` observes the child exit; `childClosed(child)` also waits for output pipes to drain; `portListening(port)` observes a successful connection. Every helper cleans up its watchers, listeners and timers, and accepts an AbortSignal. File probes recover from missed notifications and restricted recursive watchers; supply `check` when readiness requires particular contents, such as a nonempty PID. `waitOnRepo(h, check)` watches fixture changes, with probes for detached processes and other predicates without portable notifications. Browser predicates use `waitUntil(check)`. `runAsync` accepts `onSpawn` to expose the child when a test needs its exit before retained output closes.
- The runner's 300 s hung-test timeout is the only readiness backstop. Synchronous fixture interceptors use the same backstop because they cannot run watch callbacks while holding a caller. `npm run check:shared` scans all test JavaScript, including generated fixture scripts, for shorter clock deadlines, timer sleeps, elapsed-time assertions and wait-helper budgets, including multiline calls. A timing-contract test may retain a wait with `// wait-allow: reason` on that line; empty reasons and strings posing as comments do not count. Probe intervals have no readiness budget. Ordinary teardown waits for monitor termination; only deliberate teardown-failure tests shorten it with `cleanup({ monitorGraceMs })` and a timing reason.
- Assert the reason a command refuses, not only its exit code. A refusal for the wrong reason passes an exit-code check while the guarded code is gone.

The [T166 signal-wait measurements](testing-signal-waits.json) record five passing runs at the frozen code revision for 50 changed test files and three direct fixture consumers, with five baseline runs for each existing file. They include CPU load, source revisions, regression controls and all 73 planted mutation catches. The three UI guard mutations select their direct escaping, token and viewer-write tests so broken markup does not make later browser predicates hang. The opt-in live browser test stays skipped; nested publication of another task branch is skipped only in the worker sandbox.

## Tools

- `node scripts/test-cost.js [--before DIR] [files...]` measures CPU and wall seconds per file, median of three runs, four files at a time. With `--before`, it measures another checkout interleaved with this one.
- `node scripts/mutants.js` copies git-listed repository inputs, including workflow files, hooks and rules. It requires the named tests to pass without mutations. Before a full-suite fallback, it restores the original source and requires that same copy to pass the full suite too. A broken baseline aborts the run. `--root DIR` selects another checkout; `--only ID,ID --no-full` confines a rerun to selected bugs and their named files.
- `node scripts/test-coverage.js` uses node:test coverage, which follows the CLI processes a test starts. For each file it lists the lib lines it runs and how many no other file runs. A file with no unique lines is a candidate to merge or delete.

## Cost

`node scripts/test-cost.js --before <main checkout>`: each file alone, median of three runs, four files at a time, the two checkouts interleaved so both saw the same load. The before checkout is `origin/main` at e2f5277 with its own `HOME` per test repository; without that, 15 of its files failed early here and measured too low. The machine was at a load of 40 to 80 from other sessions throughout, so wall times run long; CPU seconds compare.

The shared Chrome originally exited without being reaped, so its CPU was absent from the after column. Chrome now closes in awaited file teardown. The two affected rows were remeasured on this machine, interleaved at two workers, median of three: `e2f5277` before and `e681590` after with the teardown fix. Each temporary repository gets its own `HOME`, and both Plan probes wait for the load frame before setting scroll. All twelve file runs passed. [Raw samples](testing-browser-cost.json) include the overlays and medians.

Summing the 53 unchanged historical rows with those two refreshed rows gives **1928.4 CPU s before and 1394.7 CPU s after, about 28% less**. Summed wall time is 5831.3 s before and 4285.6 s after. This is the historical 55-file comparison, with corrected browser rows; it is not a new whole-suite timing of the current branch. Files added since that comparison, including the tooling regressions, are excluded.

Reproduce the affected rows with `node scripts/test-cost.js --runs 3 --jobs 2 --before BEFORE --after AFTER --json browser-cost.json test/board.test.js test/settings.test.js`, applying the overlays recorded in the samples. CPU uses Linux `cutime`/`cstime`, which counts descendants their parents reaped; a timed-out or abandoned child is not a valid CPU sample.

| file | covers | before CPU s | before wall s | after CPU s | after wall s |
| --- | --- | ---: | ---: | ---: | ---: |
| `test/isolation.test.js` | spawned agent homes: no user secrets or hooks, sandbox rules, git and gh shims, broker-only state writes | 167.9 | 361.4 (3/3 failed) | 146.6 | 320.8 (3/3 failed) |
| `test/sources.test.js` | sources gate: fetch, visible text, public addresses and redirects, citations, research tiers | 155.6 | 411.4 | 46.4 | 142.5 |
| `test/reviewer.test.js` | reviewer choice by tier, diff and price history; review packet; accept dispatch | 151.7 | 594.5 | 93.2 | 401.0 |
| `test/local-ci.test.js` | ci.local: merged-tree runs, receipts, base movement, variants, overrides | 149.2 | 589.9 | 116.0 | 436.0 |
| `test/board.test.js` | board snapshot and live serve: escaping, offline load, forms, live updates keep focus and scroll, viewer limits | 73.0 | 95.6 | 47.9 | 65.9 |
| `test/gates.test.js` | CLI gate wiring: audited tests mode, policy at accept and merge, missing gate modules, gate context | 107.6 | 270.9 | 19.1 | 48.2 |
| `test/supervision.test.js` | supervised retries, outage classification, stalls, monitor teardown | 83.7 | 228.9 | 62.3 | 187.1 |
| `test/spawn-resume.test.js` | rework resumes the recorded session or starts fresh | 71.8 | 179.1 | 72.1 | 176.5 |
| `test/fallback.test.js` | fallback routes after outages and refusals, retry budgets, personal fallbacks | 66.4 | 180.1 | 66.8 | 169.5 (1/3 failed) |
| `test/spawn.test.js` | spawn command building per harness, prompts, detached runs, refusals | 62.7 | 175.6 | 50.6 | 141.6 |
| `test/evidence.test.js` | software evidence counts only with its audit event; hand-written or forged receipts never do | 60.1 | 200.1 | 27.0 | 99.6 |
| `test/events.test.js` | wait: each event type wakes waiters, cursors, stalls, worker exits, serve comments | 54.7 | 201.3 (1/3 failed) | 41.8 | 167.9 |
| `test/worktree.test.js` | task worktrees from the freshest base, fetch failures, interrupted adds | 53.9 | 217.7 (2/3 failed) | 39.7 | 175.1 (3/3 failed) |
| `test/stack.test.js` | stacked dispatch from a dependency head and PR linking | 46.8 | 114.5 | 47.1 | 112.6 |
| `test/worker-slots.test.js` | worker slot reservations across dispatch, retries and exits | 42.1 | 139.3 | 28.4 | 76.2 |
| `test/gate-commands.test.js` | pinned gate commands: who sets them, stale receipts after a change, no caller payloads | 41.3 | 106.1 | 28.1 | 72.5 |
| `test/harness-hooks.test.js` | harness home hooks deliver messages and publish progress per harness | 40.5 | 91.0 | 35.8 | 77.0 |
| `test/stack-merge.test.js` | stacked PR merge: lower acceptance, rechecks, admin refusal, fallbacks | 38.7 | 102.3 | 38.6 | 101.6 |
| `test/accept.test.js` | accept needs gate evidence at the head and revision, review by another agent, waivers by the owner, rework | 36.4 | 108.1 | 27.7 | 80.3 |
| `test/usage.test.js` | usage capture per harness and accounting monitors | 34.2 | 104.7 | 24.2 | 73.2 |
| `test/sandbox-extensions.test.js` | rung sandbox, env, env_file and scope settings reach only the agent | 33.0 | 113.1 | 29.1 | 97.1 |
| `test/ci-policy.test.js` | CI policy changes invalidate hosted CI evidence at accept and merge | 31.0 | 94.5 | 12.3 | 38.2 |
| `test/authority.test.js` | operational vs owner-required settings, orchestrator identity, escalation decisions, detected gate pins | 28.5 | 96.0 | 20.5 | 67.0 |
| `test/project.test.js` | project settings flags, lists, tests policy, authority on init and project set | 27.8 | 140.9 | 28.0 | 138.0 |
| `test/submit.test.js` | resubmission rules, PR and branch changes | 25.5 | 61.9 | 25.5 | 58.5 |
| `test/merge-options.test.js` | merge subject and body, admin policy, keep_branch | 22.6 | 117.1 | 22.7 | 110.5 |
| `test/ladder.test.js` | ladder defaults, user file, fallbacks, validation, tiers | 21.5 | 53.6 | 21.1 | 56.2 |
| `test/task-locks.test.js` | resource locks across claims and dispatch | 21.4 | 49.5 | 15.5 | 40.4 |
| `test/spawn-exit.test.js` | exited spawned claimants are reported and released | 19.9 | 85.1 | 16.0 | 65.6 |
| `test/ci-required.test.js` | ci.required jobs, mergeability and conflicts in the CI gate | 19.1 | 55.7 | 11.2 | 33.5 |
| `test/stack-sync.test.js` | stack sync after lower merges and base moves | 18.9 | 41.1 | 19.2 | 47.9 |
| `test/ci-capped-review.test.js` | ci.capped_review: a capped review app passes only its own linked failure | 17.4 | 58.6 | 8.7 | 27.0 |
| `test/identity.test.js` | agent identity resolution, terminal owner fallback limits | 16.8 | 41.9 | 10.3 | 27.9 |
| `test/rules.test.js` | house rules chain and startup receipt per harness; scope gate | 11.3 | 69.6 | 11.3 | 49.0 |
| `test/gates/tests.test.js` | tests gate in process: prove, revert, build-file keeps, modes, expensive proof, layouts, timeouts | 10.0 | 31.4 | 18.9 | 53.1 (1/3 failed) |
| `test/plan.test.js` | task add and update, plan import, validate, briefs | 8.7 | 43.0 | 8.8 | 44.7 |
| `test/claim.test.js` | claims, leases, renewals, worker limit and release rules | 8.6 | 21.9 | 8.6 | 19.6 |
| `test/lock.test.js` | state lock: wait, stale breaking, pid namespaces, id continuity | 8.3 | 51.9 (1/3 failed) | 8.4 | 58.0 (1/3 failed) |
| `test/settings.test.js` | Settings view edits ladder and tiers through the CLI with the page token | 4.9 | 7.1 | 4.3 | 6.8 |
| `test/ready.test.js` | ready ordering and status summary | 5.7 | 32.1 | 5.7 | 30.6 |
| `test/browser-kit.test.js` | browser kit user setting, needs round trip, rework before capability change | 5.0 | 19.3 | 5.0 | 14.9 |
| `test/broker.test.js` | state broker authorization: role commands, own identity, own task, token, no git, shutdown | 4.5 | 13.7 | 4.6 | 15.7 |
| `test/render.test.js` | sketch render on every write, render lock, serve reload | 4.2 | 14.8 | 4.2 | 18.5 |
| `test/json.test.js` | --json output parses for every command | 4.0 | 10.1 | 4.0 | 10.7 |
| `test/gates/clean.test.js` | cleanup gate: HIGH findings, incomplete scans, unpinned tool | 3.1 | 8.3 | 3.1 | 8.7 |
| `test/package.test.js` | the npm package ships the plugin and loads pi skills | 2.2 | 11.1 | 2.1 | 6.7 |
| `test/init.test.js` | init, state discovery, --state override, help | 2.0 | 5.2 | 2.0 | 5.9 |
| `test/epipe.test.js` | closed stdout and stderr pipes keep state writes and exit codes | 1.6 | 4.1 | 1.6 | 3.6 |
| `test/commands.test.js` | a subprocess inside a state mutation refuses the whole write | 1.5 | 3.4 | 1.5 | 3.8 |
| `test/browser-startup.test.js` | Chrome launcher for board tests: spawn errors, sandbox file isolation | 0.3 | 1.2 | 0.3 | 1.1 |
| `test/gates/ci.test.js` | CI gate on fake gh output: conclusions, suites, ignored apps, moved head | 0.1 | 0.3 | 0.1 | 0.4 |
| `test/live-browser.test.js` | live: a real sandboxed browser worker (skipped unless TOWER_CRANE_LIVE_BROWSER=1) | 0.1 | 0.2 | 0.2 | 0.2 |
| `test/gates/merge.test.js` | merge gate: accepted only, head match, admin policy, merge queue, already merged | 0.1 | 0.3 | 0.1 | 0.4 |
| `test/live-rules.test.js` | live: a real worker reads the rules chain (skipped unless its TOWER_CRANE_LIVE_* flag is set) | 0.1 | 0.2 | 0.1 | 0.2 |
| `test/live-sandbox.test.js` | live: real claude and codex sandboxes refuse forged state edits (skipped unless TOWER_CRANE_LIVE_CLAUDE=1 or its codex flag) | 0.1 | 0.3 | 0.1 | 0.4 |
| **total** | 55 files | **1928.4** | **5831.3** | **1394.7** | **4285.6** |

`isolation.test.js` fails 3 of 3 in both trees, only inside a Tower Crane worker sandbox: its nested `git push` of another task's branch meets the parent sandbox's git shim. `worktree.test.js` fails its 30-second dispatch bound above a load of about 70, in both trees. `fallback`, `events` and `lock` each failed one run of three under load.

What is left is mostly the CLI's own cost: every call starts Node and loads the CLI (about 80 ms of CPU for `task show`, against 29 ms for an empty `node -e 0`), runs `git rev-parse`, and a write re-renders the board. Skipping the render in tests that never read it saved only 8% on three CLI-heavy files, so the suite keeps rendering. Loading the CLI's modules lazily would cut every test's process cost; that is a change to the CLI, not to the tests.

## What each file uniquely covers

`node scripts/test-coverage.js` on the lean suite: 13699 lib lines run in all. Three files run no line some other file does not: `test/ci-capped-review.test.js`, `test/claim.test.js` and `test/identity.test.js`. None was deleted on that alone. Line coverage does not see assertions. `identity` is the only file that catches `terminal-fallback-is-owner`, and `claim` catches `workers-limit-off-by-one`. `ci-capped-review` is the only file that asserts a capped review cannot hide another failure. The most unique lines are in `test/sources.test.js` (302, the source gate and public HTTP), then `harness-hooks`, `sandbox-extensions`, `isolation` and `stack-merge` (74 to 80 each).

## Accuracy: the mutation sample

`scripts/mutants.js` holds 31 planted bugs across the areas where a silent regression costs the most. Each is a one-line change: a check removed, a bound moved by one, a guard always true.

| area | bugs | examples |
| --- | ---: | --- |
| gates | 8 | tests pass without the change, a deleted test counts, a cancelled CI run is green, a HIGH finding passes clean, loopback is a public source, evidence counts without its audit event, the submitter's own review counts, evidence from an old revision counts |
| authority | 4 | any spawned agent is the orchestrator, a brokered command keeps its identity's authority, the orchestrator makes owner-required changes, the terminal fallback acts as owner |
| broker | 3 | any command, another task, a request without the token |
| spawn and supervisor | 4 | a permanent exit retries, one retry too many, CPU activity ignored for stalls, the workers limit off by one |
| state lock | 3 | a live holder's lock is broken, the pid namespace is ignored, a stale lock never ages out |
| merge and stacks | 4 | merge with a moved head, an unaccepted lower task, an untracked lower PR, admin on a stack |
| secrets | 2 | the codex config keeps credentials, an env_file error echoes its contents |
| board | 3 | unescaped `<`, Settings writes without the page token, any serve acts as owner |

The original 31/31 before and after claims included invalid fallback results: the scratch copy omitted inputs that the full suite reads, and that baseline was never run unmutated. The historical before run establishes **26/31 scoped catches**; its five fallback results are unverified. The reviewer independently confirmed **30/31 scoped catches at beacafc**. These replace the original scores.

With the repaired fixtures, the complete fixed sample catches **31/31 with `--no-full`**, after a green unmodified scoped baseline. The command is `node scripts/mutants.js --jobs 2 --no-full --skip "publish its task branch"`. The skip is limited to the nested worker publishing another task's branch; no full-suite fallback contributes to the score.

After merging main at `4b9c3d2`, the changed supervision and stack paths were checked again: **4/4 caught**, with a green unmodified baseline, using `node scripts/mutants.js --jobs 2 --no-full --only supervisor-retries-permanent-exit,supervisor-extra-retry,supervisor-ignores-cpu,stack-merge-unaccepted-lower`. The quiet sampler test holds its worker until a stable interval has been observed; a control that forces state reloads every tick fails that test.

The subsequent main refresh at `d29d4e5` changed merge confirmation. Its queue, CI-policy and merge-option checks passed 47/47, and `--only merge-moved-head,stack-merge-unaccepted-lower,stack-merge-untracked-lower,stack-merge-admin --jobs 2 --no-full` caught **4/4** after a green unmodified baseline.

| bug | area | historical before: scoped evidence | repaired after: caught by |
| --- | --- | --- | --- |
| `tests-pass-without-change` | gates | test/gates/tests.test.js | test/gates/tests.test.js |
| `tests-deleted-test-counts` | gates | test/gates/tests.test.js | test/gates/tests.test.js |
| `ci-cancelled-is-green` | gates | test/gates/ci.test.js | test/gates/ci.test.js |
| `clean-high-passes` | gates | test/gates/clean.test.js | test/gates/clean.test.js |
| `sources-loopback-public` | gates | test/sources.test.js | test/sources.test.js |
| `evidence-without-audit` | gates | test/evidence.test.js | test/evidence.test.js |
| `review-by-submitter` | gates | test/accept.test.js | test/accept.test.js |
| `evidence-old-revision` | gates | test/accept.test.js | test/accept.test.js |
| `spawned-agent-is-orchestrator` | authority | test/authority.test.js | test/authority.test.js |
| `brokered-command-has-authority` | authority | unverified fallback | test/authority.test.js, test/broker.test.js |
| `orchestrator-makes-owner-changes` | authority | test/authority.test.js | test/authority.test.js |
| `terminal-fallback-is-owner` | authority | test/identity.test.js | test/identity.test.js |
| `broker-any-command` | broker | test/broker.test.js | test/broker.test.js |
| `broker-other-task` | broker | unverified fallback | test/broker.test.js |
| `broker-no-token` | broker | unverified fallback | test/broker.test.js |
| `supervisor-retries-permanent-exit` | spawn/supervisor | test/supervision.test.js | test/supervision.test.js |
| `supervisor-extra-retry` | spawn/supervisor | test/supervision.test.js | test/supervision.test.js |
| `supervisor-ignores-cpu` | spawn/supervisor | unverified fallback | test/supervision.test.js |
| `workers-limit-off-by-one` | spawn/supervisor | test/claim.test.js, test/worker-slots.test.js | test/claim.test.js, test/worker-slots.test.js |
| `lock-breaks-live-holder` | state lock | test/lock.test.js | test/lock.test.js |
| `lock-ignores-pid-namespace` | state lock | test/lock.test.js | test/lock.test.js |
| `lock-never-ages-out` | state lock | test/lock.test.js | test/lock.test.js |
| `merge-moved-head` | merge/stacks | test/gates/merge.test.js | test/gates/merge.test.js |
| `stack-merge-unaccepted-lower` | merge/stacks | unverified fallback | test/stack-merge.test.js |
| `stack-merge-untracked-lower` | merge/stacks | test/stack-merge.test.js | test/stack-merge.test.js |
| `stack-merge-admin` | merge/stacks | test/stack-merge.test.js | test/stack-merge.test.js |
| `codex-config-keeps-secrets` | secrets | test/isolation.test.js | test/isolation.test.js |
| `env-file-error-echoes` | secrets | test/sandbox-extensions.test.js | test/sandbox-extensions.test.js |
| `board-unescaped-lt` | board | test/board.test.js | test/board.test.js |
| `serve-no-page-token` | board | test/settings.test.js | test/settings.test.js |
| `serve-anyone-owner` | board | test/events.test.js | test/events.test.js |

The before run is `origin/main` at e2f5277 with two additions so it could run here: each test repository's own `HOME` (spawn writes receipts under the home cache) and this branch's `test/run.js`; the repaired after run uses this branch with full-suite fallback disabled. Both ran inside a Tower Crane worker sandbox. There the parent's git shim refuses a nested push of another task's branch, so the before run passed `--skip "publish its task branch"` for the one isolation test that makes such a push.

Working through the sample found one test that passed for the wrong reason and two checks that only a slow or timing-bound test made:

- The brokered-authority check in `test/authority.test.js` exited 1 because the command found no repository, never reaching the authority check. It now passes `--state` and asserts the refusal.
- Broker refusals for another task's id and for a missing token were only proven through a full sandboxed spawn in `test/isolation.test.js`. `test/broker.test.js` now checks both directly, in milliseconds.
- The CPU stall test in `test/supervision.test.js` looked for a stall after 1.4 s, while the supervisor samples once a second. On a loaded machine its second sample came late, so a supervisor that ignored CPU passed. The window now covers two samples.

`stack-merge-unaccepted-lower` survived the scoped run at beacafc. Its fixture now gives the submitted lower task passing CI and review receipts, then checks that merge refuses it before contacting GitHub. This separates acceptance from passing gates. The manifest fixture also modifies existing npm manifests and `Cargo.lock`, alongside added manifests; restoring kept files must not create a false proof failure.

## node:test options

Measured on this machine, which other sessions kept at a load of 30 to 80 for the whole work. CPU seconds are the stable figure; wall times under that load are noisy. Medians of three unless noted.

| option | measurement | taken | why |
| --- | --- | --- | --- |
| `--test-concurrency` | the owner's report: unbounded runs loaded the machine | yes | `npm test` passes 4, and `test/run.js` caps it at one below the core count. Each file also starts its own CLI and git processes, so the cap is on file workers, not cores. |
| `--test-isolation=none` | 12 light files, 3 runs: 61.1 CPU s with process isolation, 58.5 s with none; wall 51 s against 148 s | no | It saves 4% CPU and loses file parallelism, so a run takes three times longer. Every file then shares one `process.env` and module cache, and files set git identity and gate variables in the environment. |
| `--test-global-setup` | the seed is six small files: no measurable CPU | yes | `test/global-setup.js` builds the clean git seed once per run and hands it to every file through the environment. It replaces the wrapper's own seed handling and also covers scoped runs. |
| `--test-shard` | three touched files: 5.83 CPU s / 7.724 wall s unsharded; 6.17 CPU s / 11.067 wall s in three shards, at the same two-worker limit | CI only | Local sharding adds setup and a second batch, so local runs keep file scheduling. The existing three Windows CI jobs remain separate jobs with their own time budgets. This Linux probe does not measure Windows latency. |
| `mock.timers` | 24 callbacks at 50 ms each: real 0.09 CPU s / 1.316 wall s; mocked 0.08 CPU s / 0.104 wall s | no suite conversion | Advancing an in-process clock removes its waits. The remaining integration waits are on CLI, supervisor and git-hook processes; mocking the parent clock does not advance those. Existing child preloads already control those clocks. |
| `t.mock`, `--experimental-test-module-mocks` | 24 local stub calls: manual, `t.mock.method` and CommonJS module mock each 0.08 CPU s; wall 0.106, 0.094 and 0.097 s respectively | no | No measured CPU saving over existing injection points. A module-mock flag adds no benefit to `fetchPublic`, `errorReader` or `authorize`, which already accept direct calls or injected dependencies. |
| `describe` or `test` concurrency inside a file | evidence and accept, 3 runs: 54.0 CPU s sequential, 53.9 s with four tests at once; wall 92 s against 62 s | no | It saves no CPU, and it multiplies the processes a run starts past the file cap the owner asked for. |
| `--test-rerun-failures` | tried on a fixture: after one green rerun, the next run with the same state file ran no test and reported a pass | no, for `npm test` and the gate | A gate retry could then accept a head no test ran on. For a local loop, `npm test -- FILE --test-rerun-failures=$TOWER_CRANE_TEST_TMP/rerun.json`, and delete the file once it passes. |
| `--experimental-test-coverage` | coverage follows the CLI processes a test starts: `test/claim.test.js` alone runs 37% of `lib/tasks.js` | yes, as a tool | `scripts/test-coverage.js` maps the lib lines each file runs and how many no other file runs, to find files to merge before deleting any. |
| `--test-name-pattern` | 20 cases: 0.11 CPU s / 0.627 wall s; selecting one: 0.09 CPU s / 0.119 wall s | yes, local loops | Verified exactly one case executed. For one case: `npm test -- test/events.test.js --test-name-pattern="decision answer"`. The proof gate still selects complete files. |
| `--experimental-test-tag-filter` | selecting the same case by tag: 0.09 CPU s / 0.140 wall s, against 0.09 / 0.119 by name | no | The probe verifies the same one case executed. Tags save no CPU over names and require a separate maintained classification; files already define proof scopes. |
| `--test-timeout`, `--test-force-exit` | slowest test seen: 107 s, on a machine at load 68 | yes | 300 s per test, about three times that, so a hung test fails in minutes instead of holding CI to its job timeout. Force exit ends a run that a stray handle would keep open. |
| `NODE_COMPILE_CACHE` | evidence and accept, 3 runs: 50.1 CPU s without, 50.0 s with; 60 CLI calls: 8.4 s against 8.0 s | no | No measurable gain on the suite. A CLI call's cost is its git subprocess and the board render on every write, not compiling. |
| `--v8-pool-size=0`, `--jitless` | 60 CLI calls, 2 runs: 8.4 CPU s plain, 8.9 s and 9.9 s | no | Both are slower. |

The sharding, mock and filter comparisons above come from `TOWER_CRANE_TEST_TMP=CACHE node scripts/test-options.js --json options.json` on Node 26.10.0/Linux. [All three samples, min/max ranges and commands](testing-options.json) are recorded. The shard probe runs `test/browser-startup.test.js`, `test/gates/tests.test.js` and `test/test-tools.test.js`, with two total file workers in either layout; three shards run in two batches. Timer, stub and filter probes are controlled fixtures generated by the script. Their assertion counts are checked, and every measured run must pass. They measure the native mechanisms, not a projected saving for the full suite.
