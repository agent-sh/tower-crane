# Containment and governor

### Resource containment

`resources.tasks_max` and `resources.memory_max_bytes` cap each spawned worker,
reviewer, small agent and orchestrator, and each tests, proof, clean or local CI
command. `init` records explicit overrides in `project.json`; unspecified fields
are resolved at launch. `project show` prints agent, reviewer, orchestrator and gate limits. Both settings
are operational: the orchestrator or owner can change them without a setting
approval. Changes apply to subsequent launches. There is no unlimited value.

Defaults read physical host memory and the smallest `memory.max` and `pids.max`
along the caller's cgroup v2 ancestry, including the shared slice. Tower Crane
attempt cgroups are excluded from sizing so nesting does not repeatedly divide
defaults; their limits still constrain descendants in the kernel. Each default
uses half the effective host budget. Agent defaults divide that half by
`ceil(availableParallelism / 4)`, at least one slot, allowing four logical CPUs
per activity. Gate defaults divide it by `gates.executors` (two when unset),
matching the gate queue's concurrency. Tests, proofs, clean commands, local CI
and merge-queue suites use that gate share. Defaults follow the role, because a
role that fans out holds its fleet in its own scope. A spawned orchestrator's
workers, reviewers and gate commands nest inside it, so its default is the whole
half the per-launch defaults split. A reviewer's default is one agent share plus
one gate share, for the test probes it runs, and never more than that half.
Workers, small agents and researchers get one agent share. Explicit resource
fields override every default unchanged. Values persisted by older versions
remain overrides.

Linux starts the task budget at the smaller of kernel `threads-max` and
`pid_max`, then takes the smallest ancestor `pids.max`. An unlimited ancestor
uses the kernel ceiling, including `pid_max` when `threads-max` cannot be read.
There is no fixed Linux task clamp. If neither a finite ancestor nor a kernel
ceiling can be read, resolving missing task limits fails with
`resource-monitor-failed`. Non-Linux watchdog defaults remain 256 processes.
On a 24 CPU host with a 40 GiB slice and no tighter ancestor, agent memory stays
floor(40 GiB / 12), about 3.33 GiB. With a 4,000-task, 14 GiB effective budget,
three gate executors give each command 666 tasks and about 2.33 GiB. The final
default-gate proof recorded 303 tasks and 1.196 GB under caps of 666 tasks and
2.5 GB (`~/.cache/tower-crane/tasks/9b27247cfd0b/T404/default-gate-proof.json`).
Measured peaks must stay at or below two thirds of each cap, leaving at least
one third headroom. These are containment defaults,
not admission control across activities, sessions or projects.

On Linux with cgroup v2 and a reachable systemd user manager, a launch uses a
named transient user scope (registered through D-Bus, or `systemd-run` when
optional scope properties are set) in the caller's slice with `TasksMax`, `MemoryMax`,
`MemorySwapMax=0`, `OOMPolicy=continue` and delegated memory/pids controllers.
The runner sets `memory.oom.group=1` for attempts, so a cgroup OOM stops the
whole attempt, and the supervisor reports `resource-memory-max` from local OOM
events. Orchestrator fleet scopes use `memory.oom.group=0`; an OOM in an attempt does not group-kill its healthy
siblings and orchestrator. The fleet monitor does not turn its local OOM
event into an aggregate kill. The kernel chooses the victim when the fleet
cap is reached; each attempt still has its own group-killing boundary.
`OOMPolicy=kill` is not used: systemd 255 counts an OOM anywhere below a
scope as the scope's own and stops the whole scope for a nested attempt's OOM.
The supervising process remains outside the attempt's scope so it can record a
failure. The scope's descendants include harness Task/sub-agents, MCP servers,
shells and tests even when they detach or change process groups. A nested Tower
Crane launch creates a delegated child cgroup within the inherited scope. Its
own cap and every ancestor's aggregate cap remain enforced by the kernel.
Optional owner `scope` properties apply to the outer scope; mandatory resource
properties take precedence, and `scope: {}` only clears optional properties.
An optional `Slice` property cannot override the caller's slice. A caller
outside its user manager, such as a hosted CI runner's system service, has no
slice that manager can place a scope in; the scope goes into the user
manager's slice of the same name and keeps its own caps. Setting
`TasksMax`, `MemoryMax`, `MemorySwapMax`, `OOMPolicy`, `Delegate` or `Slice`
through `init`, `project set` or `ladder set` prints a `warning:` line naming
the replaced keys; each command's JSON reply includes the same `warnings`
array when nonempty. The launched command and its descendants get
`TOWER_CRANE_SCOPED=1` once the scope or delegated child is ready.

A caller already inside a fence of its own, the innermost cgroup below its
slice with a finite `memory.max` or with `memory` and `pids` enabled in
`cgroup.subtree_control`, keeps its attempts inside that fence. When the fence
delegates those controllers, each attempt is a nested child cgroup as under a
Tower Crane scope; otherwise the attempt runs in place under the watchdog, and
the fence's own caps still hold in the kernel. Stderr and spawn containment
metadata name that fence and warn that the owner's scope properties were not
applied. A finite `pids.max` alone does
not mark a fence, since systemd's `DefaultTasksMax` puts one on every scope.
Inside a fence, optional owner `scope` properties do not apply; the fence's own
properties do. Start a fence through `lib/containment-runner.js`, as the test
scope below does, to delegate it.

A launch cleans up its unit in the user manager and its cache files. After the
attempt exits, the supervisor waits up to five seconds for its scope to settle
and resets it if the manager left it failed; `Result=oom-kill` is read before
that reset. The manager removes an emptied scope's cgroup at once, so the
supervisor and a keeper also watch the scope's `memory.events.local`. The kernel
notifies that file at most every 10 ms, so a cap event starts a 20 ms window in
which they read its counters every millisecond, finding the OOM the kernel
counts before it kills. A scope that stays at its cap opens at most one window
every 100 ms, and the reads stop once the scope is empty. When a keeper takes over the scope's retained
processes, the keeper reads `Result` and settles the scope when it ends, and the
supervisor leaves the scope alone. The supervisor keeps its own watch until the
keeper reports that its watch is in place, so an OOM while the keeper starts
still fails the attempt. Report directories are
`tower-crane-containment-<supervisor pid>-*` under `XDG_CACHE_HOME` (else
`~/.cache`), removed when the attempt closes. A supervisor killed before then
leaves both behind, so contained launches and the idle `wait` timer sweep once
per minute. They remove the
report directories and reset the failed `tower-crane-<pid>-*.scope` units
whose supervisor pid no longer exists and that no running keeper names.
Legacy `tower-crane-containment-XXXXXX` directories lack a pid and are removed
only when their modification time predates the current boot, proving that no
live supervisor can own them.
Failure to set up a scope or delegated child fails the launch with
`resource-scope-failed`; it never silently falls back after selecting cgroups.
Cleanup also removes empty delegated subgroups left by partial setup or a
launcher that exited before its delayed cleanup. A timeout or abort before the
runner's report remains `ETIMEDOUT` or `ABORT_ERR` in the gate receipt.

The monitor observes `pids.events` and `memory.events`, using local event files
where available so a child's smaller cap does not fail its healthy parent.
Older kernels without local event files may propagate a child cap failure to
its parent attempt. A denied fork fails the
attempt with `resource-tasks-max`, even if its harness ignores the fork error.
A cgroup OOM fails it with `resource-memory-max`. Spawn phase events store the
blocked reason and containment settings; status and the inbox show that reason.
Gate command failures put the reason in their summary and receipt/event where
applicable. The whole attempt is stopped; an unrelated scope is left running.
Normal agent exit has a different ownership boundary. Independently dispatched
supervisors, their agents, and registered orchestrator wait/check/accept/merge controllers keep working;
the agent's ordinary background processes are stopped. This applies to zero,
nonzero and signal exits without a containment failure. The retained work stays
inside the original cgroup and its aggregate limits. A small detached engine
keeper watches retained work until it ends; without cgroups it carries the
original process-count/RSS bound after the launcher exits. A cap or monitoring
failure still stops the whole retained attempt. With cgroups, fleet memory pressure retains
the per-attempt boundary, including after a keeper takes over.
Gate commands own everything
they start, including nested supervisors, and retain their complete cleanup.
In cgroup mode the keeper polls `cgroup.events` for population and reads
`cgroup.procs` in that group and its nested groups. It does not scan `/proc`
on each tick.
The spawn API's `containmentDone` promise resolves once normal-exit cleanup
and any keeper handoff finish.
Retained controllers still count as users of the original agent's home, cache,
broker directory and TMPDIR. Cleanup spares them, but home pruning waits until
their run-marked processes finish. Supervisor subtrees own a different agent's
files and remain excluded from the original home's liveness check.
On Windows, cleanup with retained identities stops each identified non-kept
process individually. It does not tree-kill an ancestor of retained work.
Full containment cleanup without retained identities still uses `taskkill /T /F`.
Retention requires recorded dispatch or controller pid/start identities.
Verified orchestrator CLI commands register `{pid, start, host, pidns, role, command}`
under `controllers/<pid>-<nonce>.json` in their state directory and remove the
record when they return. `pidns` is the command's pid namespace on Linux; a
reader in another one keeps the record, since it cannot see that process. A command started before its spawn is recorded registers
once the record appears ([agent identity](decisions.md#agent-identity)), before the command
runs. Linux uses process start ticks; macOS and Windows use
the process snapshot's start time. A background orchestrator `wait --inbox`
therefore survives the harness exit with its existing home and bounds.
A worker's fixtures named `tower-crane wait` or `spawn-monitor.js`, and forged
environment markers, grant no retention.
Containment metadata retains sampled `pids_peak`, `memory_peak_bytes` and
`refused_forks` from the scope's peak and local event files. Refused forks
count that scope's cap violations where local events are available.

On macOS, Windows, Linux without cgroup v2, Linux without a reachable user
manager, or an inherited scope without writable delegated controllers,
the executable launches directly with a watchdog. An existing parent cgroup
continues to enforce its aggregate cap. The launcher never creates a sibling
scope to escape an inherited scope that cannot delegate.
Explicit outer `scope` properties require a reachable user manager and cgroup
v2; an unavailable manager fails the configured launch with
`resource-scope-failed`. Nested launches retain the outer scope's properties.

Fixture CLI environments (`TC_ACCOUNT_HOME`) and Node test workers preserve
fixture preloads, process ids, shell invocation and caller spawn options.
Explicit owner scope wrappers still apply; automatic containment is bypassed.
Dedicated containment tests set
`TOWER_CRANE_TEST_CONTAINMENT=1` to exercise real enforcement explicitly.
The independent capped test scope remains their safety fence.

The fallback watchdog polls process count and total RSS on a 100 ms cadence,
skipping overlapping snapshots. macOS `ps` snapshots have a two-second
deadline. Linux reads `/proc`. Windows keeps one PowerShell process per
watchdog and requests CIM snapshots over its standard input, with a 60-second
deadline per request to allow cold CIM startup. A dead or timed-out sampler
is stopped and replaced on the next request.
Linux cleanup checks a monotonic 100 ms deadline between freeze snapshots.
It does not retry a rejected stop for the same process identity, then proceeds
to best-effort killing of the matched processes.
It tracks the process group/tree and previously observed descendants across
detachment, pruning exited or reused process identities after each successful
snapshot. A cap stops the attempt immediately. Three consecutive failed
snapshots stop it with `resource-monitor-failed`; a successful snapshot resets
the failure count. A single slow or failed snapshot leaves the attempt running.
The same rule applies to watchdog keepers and the final cleanup snapshot.
Three timed-out snapshots take about six seconds on macOS or three minutes
on Windows, plus scheduling delays. Invalid containment reports still fail
immediately. This fallback is a sampled bound: forks and memory
allocations can overshoot between samples. It cannot contain a descendant that
detaches and loses its parent before the first snapshot, enforce kernel thread
counts, account for page cache or shared memory like cgroups, or prevent a
same-user process from deliberately escaping. On Windows there is no POSIX
process group; the watchdog tracks parent relationships and creation times.
Windows keeps an exited parent's pid on its children and gives that pid to
new processes, so a process counts as a child only if it started no earlier
than the parent it names: an earlier process's orphans, such as a detached
supervisor whose dispatch exited, stay out of the tree, its caps and its stop.
Hard fork-storm isolation requires the Linux cgroup backend.

Containment tests use finite fake harnesses: at most twelve child processes and
192 MiB of allocated buffers, all with their own three second lifetime. Run
their real systemd probes inside an independent test scope:

```sh
systemd-run --user --scope --slice="$(node -p 'require("./lib/containment").callerSlice()')" \
  -p TasksMax=200 -p MemoryMax=1G -p MemorySwapMax=0 -p OOMPolicy=continue -p Delegate=yes \
  node lib/containment-runner.js '{"tasks_max":200,"memory_max_bytes":1073741824}' '' safety \
  node test/run.js --test-concurrency=1 test/containment.test.js
```

This outer scope remains a safety bound even if the launch code under test
loses a cap.

## Host resource governor

Several projects on one host can use Tower Crane at once, beside agent sessions Tower Crane does not run. Every Tower Crane process on the host asks one governor (`lib/governor.js`) before it starts heavy work, and all of them share one budget through one registry per user and host. The governor admits a unit only within that budget, defers it otherwise with a reason status, inbox and the board show, and past a higher line stops Tower Crane's own running work before the kernel throttles or kills.

### Units

A unit is one piece of work the governor admits and measures:

| Kind | Admitted by | Held by | Stopped how |
| --- | --- | --- | --- |
| `worker`, `reviewer`, `small`, `orchestrator` | `spawn` (also `spawn --ready`, automatic refill, review dispatch), before the supervisor starts | the agent's supervisor, from its launch until its harness has exited; the supervisor then removes the unit before it records the exit and runs the gate reactions, which take places of their own | SIGTERM to the supervisor, which stops its harness and records the exit; the orchestrator is never stopped |
| `tests`, `clean`, `ci` (local CI only) | `check tests`, `check clean`, `check ci` with `ci.local`, and the reactions and `accept` that run them | the process running the gate | its own process aborts the gate on its next probe; SIGTERM to the gate's command groups when it has not ended ten seconds after the stop and the stop line is still crossed |
| `suite` | the merge queue's merged-head suite, once the suite will run | the process running the queue | as a gate |

Hosted CI polling, the sources gate, merges and every other command stay outside the budget: they read the network and write state, but run no project command. Test runs hold test-thread leases from a CPU budget of their own ([Test threads](#test-threads)), inside the gate or agent unit that started them.

### Readings

On each admission and tick the governor reads, on Linux:

- the cgroup v2 chain of its own process (`/proc/self/cgroup`) up to the root: each level's `memory.current`, `memory.max`, `memory.high`, `memory.stat` and `memory.events` (`oom_kill`). A level's limit is the lower of `memory.high`, where the kernel starts throttling, and `memory.max`, where it kills. Its use is `memory.current` less its file pages (`active_file` and `inactive_file`), which the kernel reclaims first: what is left is anonymous memory, shared memory (shmem and tmpfs pages sit on the anonymous lists, not the file lists) and kernel memory. Page cache never counts, so a finished scope that still holds cached files adds nothing to anyone's use.
- the host: `MemTotal` and `MemAvailable` (use is their difference), `SwapTotal` and `SwapFree`, from `/proc/meminfo`.
- pressure stall information: `/proc/pressure/memory` (`some` and `full` avg10) and `/proc/pressure/cpu` (`some` avg10).
- load: the 1-minute load average and the available cores.

Every limited cgroup level and the host is a level, and each must fit. The binding level is the one with the least headroom; on this machine it is the agents slice shared by every agent session (`user@1000.service/agents.slice`, `memory.high` 36 GiB, `memory.max` 40 GiB). Processes in different scopes see different chains: a spawned orchestrator in a capped scope of its own has that scope as a level, and a `wait` in a terminal's scope does not.

A unit's size is the anonymous resident memory (`RssAnon`) of its root processes and their descendants, each process counted once, for the unit whose root is its nearest ancestor: what a cgroup charges and cannot reclaim without swap. A contained unit uses the full attempt scope passed by containment once its report is ready, excluding its page cache. It includes detached grandchildren and nested child groups. Its processes outside the scope add their anonymous memory: an agent's supervisor, the state broker it runs and the commands the broker runs for the agent, such as its waits, sit beside the harness scope, and left out they were sampled as other sessions, whose room then kept them after the unit ended. Scopes overlap, so each byte counts once, in the innermost unit scope that holds it: a process inside any unit's scope, such as a worker's supervisor in a contained orchestrator's scope, counts in that scope's reading only; a unit's scope counts without the unit scopes nested in it; and units that share a scope count it in the first of them. Queued registry writes keep that scope path and do not substitute the runner leaf. Uncontained units use the PID-tree measurement. Each unit keeps its `expected` size, its last `measured` size and its `peak`.

A unit counts in a level when its memory is charged there: the host holds every unit, and a cgroup level holds a unit whose attempt scope, or else the cgroup of the process that admitted it (`admitted_in`), is that level or lies below it. A unit recorded with neither counts in every level.

### The budget

For every level, a unit that needs `need` bytes is admitted only while

`use + growth + others_room + need <= defer_at * limit`

with `growth` and `others_room` computed for that level alone:

- `growth`: the room the running units in the level may still grow into together: `ratio * room`, and never less than the largest single unit's room. A unit's room is `expected - measured` when positive; `room` is the sum over every running unit in the level. Until `growth_samples_min` [growth windows](#growth-windows) exist, `ratio` is 1, so `growth` is every unit's own remaining peak, as if all of them reached it at once. Once they exist, `ratio` is the 99th percentile of the windows' ratios (nearest rank, so below 100 windows the largest), also when that is more than 1. For `growth_window_min` after a window crossed its reservation, the units of that window's set still running have at least that window's ratio on their room; every other unit keeps the ratio above. The crossing measured that set: a unit admitted since, from this project or another, was not in it, and the crossed ratio times every unit's room reserved growth no window saw. Through the floor, a unit admitted a moment ago and not yet measured always has at least its whole room reserved. A unit marked `waiting`, an owner waiting on its submitted head ([PR owners](tasks.md#pr-owners)), has no room: its supervisor sets the mark when the wait starts and clears it when a handback wakes the owner, which then counts as a worker again.
- `others_room`: room kept for sessions Tower Crane cannot throttle. Their use in a level is the level's use less the measured size of every unit in it, sampled for each level the ticking process reads once a minute (the minute's largest), and each sample names its level. A tick reads the levels before it takes the registry lock, and a unit that ends meanwhile leaves the registry while its memory is still in that reading, so a sample takes each level's use as the lower of that reading and one taken once the units were measured: Tower Crane's own ended work is not sampled as another session's. A sample's room is its excess over the others' current use in the same level, also when the level's own use did not fall: running units may have grown into the memory those sessions let go of, and the sessions may take it back while the units keep it. A unit's processes start after its admission, so no unit admitted since a sample holds memory that sample counted as another session's. Tower Crane memory a sample can still count includes a process its unit has not recorded yet, such as a supervisor whose bind write is still queued; its processes outside its scope and a unit that ended during the tick are kept out by the measurement and the lower reading above. That room counts in full when the sample is new and fades linearly to nothing over `others_window_min`; the largest counts. A session that just let go of memory may take it back; one that let go long ago is less likely to. A sample taken against one level keeps no room in another, so a `wait` in one scope cannot defer a dispatch from another scope by the difference between two levels' use; a sample without a level, from before samples named theirs, counts nowhere.
- `need`: the unit kind's expected size: the largest of the kind's last 20 measured peaks on this host, this project's when it has any and every project's otherwise, once three exist; before that, the larger of `expected_mb` and the peaks there are.

### Growth windows

Running units rarely reach their peaks at the same moment, so the governor measures how much of their room they grow into together. While units run, a window opens once a minute with the units running then: the binding level's use, their summed measured size and room, the largest unit's room, and the growth the budget reserved for them with its ratio, rule and sample count. Every measurement raises the window's total to the most their summed size has reached; its growth is that total less the size it opened with. A unit that ended gave its memory back. A unit admitted later is not in the set, since its own room is reserved when it is admitted; other sessions keep their own `others_room`. The window follows the level it opened on, whichever level binds later. After `growth_window_min`, or once every unit in it ended, the window closes and its ratio, its growth over its room, becomes a sample, whatever kinds its units were: the registry keeps the last 200 from the last seven days. A window whose units had no room left has no ratio; their own peaks raise their kinds' expected sizes instead.

Each closed window is appended to `HOST.windows.jsonl` beside the registry, which keeps the last 10080 (a week of minutes): `at` and `end`, `level`, `limit`, `units`, `used` and `base` (the level's use and the set's size when it opened), `sum` and `largest` (the set's room and its largest unit's), `reserved`, `reserved_ratio`, `rule` and `samples` (the growth reserved and why), `total`, `grew`, `ratio` (`grew / sum`, null with no room), `predicted` (`used + reserved`), `actual` (`used + grew`), `slice_peak` (the level's highest use while it was open, later admissions and other sessions included) and `crossed` (`grew` over `reserved`). A crossed window with room grew more than the reservation in force, so the ratio in force was below its own: for the next `growth_window_min` the ratio on the room of that window's units is at least the window's, under the sum rule as under measured growth, and the same room is reserved above what that set grew into. The raise (`raised`) names those units; a window that crosses while a raise is in force adds its units to it and keeps the higher ratio. A raise recorded before raises named their units covers every unit, and so does a raise that extends it. Windows are recorded only where the governor measures units (Linux); elsewhere `growth` stays the sum.

Pressure defers as well: memory `some` avg10 at or over `psi_memory_defer`, CPU `some` avg10 at or over `psi_cpu_defer`, or load at or over `load_defer` times the cores. Admission and the registry write that records the unit are one locked step, so two projects cannot both take the last room.

#### Live-window replay, 2026-10-21 (T451)

The first day's log does not call for tightening the p99 rule or its largest-unit floor. Of 1338 closed windows, 25 grew past their reservation (1.87%). The highest `actual` among those crossings was 20.712 GiB, 57.53% of the limit; their highest `slice_peak`, including later admissions and other sessions, was 21.702 GiB, 60.28%. These leave 13.488 and 12.498 GiB to the 95% stop line. No crossing reached 90% of the limit, the threshold five percentage points below that line. None reached 95% of the stop line either (90.25% of the limit).

The orchestrator supplied a snapshot of `avifenesh.windows.jsonl` from the live host cache, SHA-256 `f6017f7cb6cb3418081250c9024f74d67150150b0d735f9f13c5c59eb6545290`. Its windows cover 2026-10-20 13:57:26.523 through 2026-10-21 14:07:02.286 Jerusalem time (UTC+03:00), 24 h 9 min 35.763 s from first opening to last close. The last closed window opened at 13:07:01.684 on October 21; windows still open at snapshot time are absent. All rows followed `agents.slice` with a 36 GiB limit, a 30.6 GiB default defer line and a 34.2 GiB default stop line. The replay used the shipped defaults: 60-minute windows, 20 samples before measured growth, nearest-rank p99 over the last 200 closed ratios, a largest-unit floor, and a 60-minute raise after a crossing.

Replaying closes before openings at the same timestamp through `observe` and `reserve` in `lib/governor.js` at commit 2d67a90c, before a raise covered only its own set (T525), reproduced every logged reservation, ratio, rule and sample count, with zero mismatches. There were 76 sum-rule, 1048 measured-rule and 214 raised-rule openings. All 1338 windows had room and a non-null ratio. Their nearest-rank p50 was **0.06144242** and p99 **0.26344686** (`grew / sum`, ranks 669 and 1325). These are full-log descriptive percentiles; the live reservation uses only ratios already closed at an opening. Overlapping windows are correlated observations.

The admission comparison below asks whether one hypothetical candidate fits at each logged opening: `used + reserved + need <= 0.85 * limit`, versus `used + sum + need <= 0.85 * limit`. It sets `others_room` to zero and checks only the logged binding level, with no PSI or load deferral. The log has no dispatch attempts, learned candidate sizes, other-session peak history, pressure or other levels, so these are memory-only opportunities on the recorded workload, not counts of actual dispatches or a simulation of the workload after extra admissions. Candidate sizes 1, 1.5 and 2 GiB are the configured defaults for reviewers, workers and tests; 4 and 8 GiB show sensitivity to larger learned sizes.

| Candidate `need` (GiB) | Ratio rule admits / 1338 | Plain sum admits / 1338 |
| --- | --- | --- |
| 0 (running-work budget only) | 1290 | 229 |
| 1 | 1271 | 166 |
| 1.5 | 1270 | 151 |
| 2 | 1267 | 135 |
| 4 | 1241 | 80 |
| 8 | 968 | 2 |

The worst logged `predicted` (`used + reserved`, before candidate and other-session room) was **33.753 GiB**, 93.76% of the limit, leaving **0.447 GiB** to the stop line. It opened on October 20 at 14:40:39.184 Jerusalem time under the startup sum rule, exceeded the defer line, and did not cross its reservation. With the hypothetical 2 GiB candidate, the worst projection was 35.753 GiB, 1.553 GiB above the stop line, and was rejected by the defer check. The highest projection that admitted that candidate was 30.599 GiB, leaving 3.601 GiB to the stop line. Across all windows, the highest `actual` was 23.777 GiB (66.05%) and highest `slice_peak` 23.514 GiB (65.32%). `actual` holds other use at its opening value and adds the original set's peak growth; `slice_peak` measures the level over time, so either can be larger.

Every reservation crossing is listed below by opening time in Jerusalem (UTC+03:00). Reservation and growth are GiB; `actual` and `slice_peak` are percentages of the 36 GiB limit. Adjacent rows can follow much of the same set.

| Opened | Reserved | Grew | Actual / limit | Slice peak / limit |
| --- | --- | --- | --- | --- |
| 2026-10-20 20:35:45.460 | 5.756 | 6.101 | 45.67% | 50.60% |
| 2026-10-20 20:37:07.441 | 5.811 | 5.936 | 45.77% | 50.60% |
| 2026-10-20 20:38:12.325 | 5.759 | 6.026 | 46.13% | 50.60% |
| 2026-10-20 20:39:12.846 | 5.622 | 6.016 | 46.03% | 50.60% |
| 2026-10-20 20:41:15.875 | 5.708 | 5.753 | 46.02% | 50.60% |
| 2026-10-20 20:42:16.705 | 5.786 | 5.900 | 46.31% | 50.60% |
| 2026-10-20 20:59:45.127 | 4.928 | 5.566 | 52.41% | 50.60% |
| 2026-10-21 01:30:10.318 | 5.713 | 6.202 | 43.80% | 49.15% |
| 2026-10-21 01:31:10.331 | 5.770 | 6.306 | 44.51% | 49.15% |
| 2026-10-21 01:33:10.363 | 5.673 | 6.550 | 43.20% | 49.15% |
| 2026-10-21 01:34:11.381 | 5.653 | 6.622 | 43.17% | 49.15% |
| 2026-10-21 01:35:13.266 | 5.650 | 6.174 | 42.99% | 49.15% |
| 2026-10-21 01:36:15.171 | 5.723 | 5.837 | 43.19% | 49.15% |
| 2026-10-21 01:37:15.193 | 5.810 | 6.328 | 44.53% | 49.15% |
| 2026-10-21 01:38:17.064 | 5.796 | 5.851 | 43.26% | 49.15% |
| 2026-10-21 04:15:26.330 | 7.778 | 9.542 | 57.40% | 60.28% |
| 2026-10-21 04:17:27.629 | 7.768 | 7.816 | 57.23% | 60.28% |
| 2026-10-21 04:19:30.682 | 6.808 | 7.827 | 57.39% | 60.28% |
| 2026-10-21 04:20:30.827 | 6.805 | 7.816 | 57.53% | 60.28% |
| 2026-10-21 04:23:34.261 | 7.448 | 7.807 | 53.23% | 60.28% |
| 2026-10-21 12:39:33.797 | 2.937 | 3.925 | 44.06% | 57.23% |
| 2026-10-21 12:40:33.812 | 2.987 | 3.239 | 45.34% | 57.23% |
| 2026-10-21 12:41:35.206 | 3.005 | 4.132 | 44.54% | 57.23% |
| 2026-10-21 12:42:36.661 | 2.975 | 4.296 | 48.67% | 57.23% |
| 2026-10-21 12:45:38.741 | 2.986 | 3.267 | 51.47% | 57.23% |

To reproduce from this snapshot, run the following from the repository root, replacing `SNAPSHOT` with its path. Synthetic units partition each logged `sum` into rooms no larger than `largest`; `reserve` needs only their sum and maximum. Closed windows feed their recorded totals through `observe`. This snapshot starts with zero samples and lasts less than the seven-day sample expiry.

```sh
node - SNAPSHOT <<'NODE'
const fs = require('node:fs'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), G = require('./lib/governor');
const text = fs.readFileSync(process.argv[2], 'utf8');
const rows = text.trim().split('\n').map(JSON.parse), s = G.settings({});
const reg = { units: [], windows: [], growth: [], raised: null };
const events = rows.flatMap((w, i) => [[Date.parse(w.at), 1, i, w], [Date.parse(w.end), 0, i, w]])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
for (const [now, opening, , w] of events) {
  reg.units = [];
  if (!opening) {
    reg.windows = [{ ...w }];
    G.observe(reg, { binding: w.level, levels: [{ name: w.level, limit: w.limit, used: w.used }] }, s, now);
    continue;
  }
  for (let left = w.sum; left > 0;) {
    assert(w.largest > 0);
    const room = Math.min(left, w.largest);
    reg.units.push({ expected: room, measured: 0 });
    left -= room;
  }
  const r = G.reserve(reg, s, now);
  assert.deepEqual([r.bytes, r.ratio, r.samples, r.rule],
    [w.reserved, w.reserved_ratio, w.samples, w.rule]);
}
const ratios = rows.map(w => w.ratio).filter(r => r !== null).sort((a, b) => a - b);
const percentile = p => ratios[Math.ceil(p * ratios.length) - 1];
console.log({ sha256: crypto.createHash('sha256').update(text).digest('hex'), windows: rows.length,
  hours: (Math.max(...rows.map(w => Date.parse(w.end))) - Math.min(...rows.map(w => Date.parse(w.at)))) / 3600000,
  p50: percentile(.5), p99: percentile(.99) });
console.table([0, 1, 1.5, 2, 4, 8].map(need => ({ need,
  ratio: rows.filter(w => w.used + w.reserved + need * 2 ** 30 <= s.defer_at * w.limit).length,
  sum: rows.filter(w => w.used + w.sum + need * 2 ** 30 <= s.defer_at * w.limit).length })));
console.table(rows.filter(w => w.crossed).map(w => ({ at: w.at, reserved: w.reserved / 2 ** 30,
  grew: w.grew / 2 ** 30, actual_pct: 100 * w.actual / w.limit, peak_pct: 100 * w.slice_peak / w.limit })));
console.log(Object.fromEntries(['predicted', 'actual', 'slice_peak'].map(key =>
  [key, Math.max(...rows.map(w => w[key])) / 2 ** 30])));
NODE
```

#### Replay of 2026-10-22's deferrals (T525)

On 2026-10-22 ginza deferred its T21 local CI gate and T73 tests gate at every attempt from 11:51Z to 13:01Z while `agents.slice` held 15.9 to 20.5 GiB of 36. Its reasons projected 35.4 to 41.2 GiB: growth 8.3 to 10.2 GiB and other sessions' room 7.9 to 12.2 GiB. Tower Crane deferred its own gates and suites from 11:10Z to 11:34Z the same way at its 85% line, then raised it to 92%.

Inputs, supplied by the orchestrator from the live host: the registry `avifenesh.json` at 14:04:16Z (SHA-256 `b2882946fdd6b0dd4ec0e56cf490b2bad0fe156bf2254deee2479fee7662c850`; other-session samples from 12:04Z), the window log `avifenesh.windows.jsonl` (`acd0cc00faaaed1ef02dc22ba076ed6a1eace87f68badebe2b4b1a5ade56ae0b`; 2929 windows from 2026-10-20 10:57Z to 2026-10-22 14:04Z, all on `agents.slice`), ginza's 64 event lines of the day that name the host governor, as `ginza-2026-10-22-governor.jsonl` (`6b4e9baa0269fee0261cd5173c802df0effd26fbc004a0901481ed137538073e`), and Tower Crane's own, as `tc-defers.jsonl` (`grep '"at":"2026-10-22' events.jsonl | grep -E 'deferred by the host governor|over the [0-9]+% line'`, `bef3cc79fae4f12927bab4ab2f56cf6b41a7947af17a180b27094a2c4dd06bd2`). That gives 186 readings with a projection: 52 of ginza's and 134 of Tower Crane's.

The replay rebuilds the registry at each reading. Growth samples and raises come from feeding the window log through `observe` and `reserve`, as the T451 replay does. That reproduces every logged reservation under the governor before T525, with no mismatch. The units running at a reading are those of the last window opened before it, with its logged room (the largest unit's on its first unit, the rest shared evenly) and its measured total. Other-session samples are the registry's own from 12:04Z, plus one per window opening (its use less its units' size): one per minute where the live ones take the minute's largest. On Tower Crane's 134 readings, logged by main's governor, the replayed growth is within 1.0 GiB of the logged growth, and the replayed room runs from 0.7 GiB over to 2.0 GiB under the logged room. Each reading is projected with the reading's own use and need against the 85% line.

| Readings | Sum of the logged terms | Before T525 | T525 |
| --- | --- | --- | --- |
| ginza T21 and T73, 11:51Z to 13:01Z (28) | 35.4 to 41.2 GiB, all deferred | 25.0 to 30.4 GiB, all admitted | 24.9 to 30.2 GiB, all admitted |
| a Tower Crane tests gate (1.9 GiB) at the same readings (28) | | | 24.9 to 29.3 GiB, all admitted |
| Tower Crane at 28.0 to 32.0 GiB in use, 11:13Z to 11:17Z (37) | 34.3 to 38.4 GiB | 34.4 to 37.8 GiB, all deferred | 34.3 to 37.6 GiB, all deferred |
| all 186 | | 57 admitted | 61 admitted |

Most of ginza's hour came from the release it ran, 0.1.7, which predates the per-level budget (9b99f2d3). Its `assess` counts every other-session sample whatever level it was taken on, so the host's samples, where other use was 19 to 24 GiB, set room in `agents.slice`. Recomputed with 0.1.7's `assess` over the registry's samples, its room at the readings from 12:08Z is within 0.9 GiB of ginza's logged room. Its `reserve` also has no room exemption for owners waiting on their heads. Main's per-level room at the same readings is 0.1 to 6.3 GiB, and its growth 3.2 to 6.9 GiB. T525 removes up to 0.3 GiB more growth at those readings and admits 4 more of Tower Crane's 11:24Z to 11:34Z attempts.

Tower Crane's 11:22Z to 11:24Z attempts stay deferred: the slice fell from 31 to 17 GiB from 11:16Z, and the room kept for that fall is the design. The replay cannot show two of T525's changes: a sample taking the lower of the two readings, and a unit counting its processes outside its scope, change what is measured, not what was logged. A raise naming its units shows only roughly, since the log keeps each window's summed room and not each unit's; it moves growth by no more than the raise above the 99th percentile (0.283 against 0.259 to 0.262 from 11:55Z to 12:10Z) times the room outside its set. Registry windows open each minute and record the binding level's use, so a replayed sample is one tick a minute and the room a lower bound; the Tower Crane comparison above bounds the gap.

To reproduce, put the four inputs in `DIR` and run the following from the repository root, with `BEFORE` the `lib/governor.js` of a checkout at d87be869:

```sh
node - DIR BEFORE lib/governor.js <<'NODE'
const fs = require('node:fs'), path = require('node:path');
const [dir, before, after] = process.argv.slice(2), GiB = 2 ** 30, line = 0.85 * 36 * GiB;
const LEVEL = '/user.slice/user-1000.slice/user@1000.service/agents.slice';
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
const rows = read('avifenesh.windows.jsonl').map(JSON.parse), reg0 = JSON.parse(read('avifenesh.json').join('\n'));
const opens = [...rows, ...reg0.windows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const openAt = (t) => opens.findLast((w) => Date.parse(w.at) <= t);
const unitsOf = (w) => w.units.map((id, i) => ({ id, expected: i ? (w.sum - w.largest) / Math.max(1, w.units.length - 1) : w.largest, measured: 0 }));
function timeline(G) {
  const s = G.settings({}), reg = { units: [], windows: [], growth: [], raised: null }, reserved = [], states = [];
  const events = rows.flatMap((w, i) => [[Date.parse(w.at), 1, i, w], [Date.parse(w.end), 0, i, w]]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [now, opening, i, w] of events) {
    if (opening) { reg.units = unitsOf(w); reserved[i] = G.reserve(reg, s, now).bytes; continue; }
    reg.units = [];
    reg.windows = [{ ...w, reserved: reserved[i] }];
    G.observe(reg, { binding: w.level, levels: [{ name: w.level, limit: w.limit, used: w.used }] }, s, now);
    states.push({ at: now, growth: [...reg.growth], raised: reg.raised && { ...reg.raised } });
  }
  return { s, at: (t) => states.findLast((x) => x.at <= t) || { growth: [], raised: null } };
}
const minute = new Map();
const add = (at, bytes) => { const k = Math.floor(Date.parse(at) / 60000); if (!(minute.get(k)?.bytes >= bytes)) minute.set(k, { at, level: LEVEL, bytes }); };
for (const w of opens) add(w.at, Math.max(0, w.used - w.base));
for (const o of reg0.others.filter((o) => o.level === LEVEL)) add(o.at, o.bytes);
const others = [...minute.values()];
const RE = /has ([\d.]+) GiB of 36\.0 GiB in use.*? needs ([\d.]+) GiB;/;
const readings = [['ginza-2026-10-22-governor.jsonl', 'gate run'], ['tc-defers.jsonl', 'automation']].flatMap(([f, cmd]) => read(f).map(JSON.parse)
  .filter((e) => e.cmd === cmd).map((e) => [e, RE.exec(JSON.stringify(e.detail))]).filter(([, m]) => m)
  .map(([e, m]) => ({ at: Date.parse(e.at), file: f, task: e.task, used: +m[1] * GiB, need: +m[2] * GiB })));
const project = (G, tl, r) => {
  const w = openAt(r.at), state = tl.at(r.at);
  const reg = { units: [...unitsOf(w), { id: 'measured', expected: 0, measured: w.base }], others: others.filter((o) => Date.parse(o.at) <= r.at), growth: state.growth, raised: state.raised, history: [] };
  const b = G.assess({ levels: [{ name: LEVEL, used: r.used, limit: 36 * GiB }], binding: LEVEL, pressure: {}, load: 0, cores: 24 }, reg, tl.s, r.need, null, r.at).budget;
  return r.used + b.growth + b.others_room + r.need;
};
const [B, A] = [before, after].map((f) => { const G = require(path.resolve(f)); return [G, timeline(G)]; });
console.table(readings.map((r) => ({ at: new Date(r.at).toISOString().slice(11, 19), file: r.file.slice(0, 5), task: r.task, used: +(r.used / GiB).toFixed(1),
  before: +(project(...B, r) / GiB).toFixed(1), after: +(project(...A, r) / GiB).toFixed(1), admits: project(...A, r) <= line })));
NODE
```

### Test threads

Memory admits a tests gate; CPU decides how many test files it runs at once. No gate, worker or reviewer chooses its own test concurrency: the governor keeps one host-wide budget of test threads (file workers), shared by every project on the host through the same registry, and every test run inside Tower Crane takes a lease from it. A run asks for N threads, the `--test-concurrency` its command passes (`npm test` passes 4, a worker or a gate command may pass more), and is granted G <= N. It holds the lease until it exits; a lease whose holder has exited is dropped, as a unit is.

The budget is the cores less the cores other work uses now, and never more than `cores - 1`: the core kept back covers up to one core of other work (the runner, the gate's own CLI, processes tests detach from their trees), and other work past that comes off the budget. On Linux that is the busy cores among the CPUs the run may use (`Cpus_allowed_list`), from `/proc/stat` between samples at least a second apart, less the CPU the runs' own process trees used over the same interval: each lease holder and its descendants, with the time of children they reaped. Measuring the runs, rather than counting their grants as busy, keeps a change of grant out of the figure, since runs that grow raise the busy cores and their own use together. Each new figure is averaged with the last. Before the first interval (the first lease after a quiet minute) the 1-minute load stands in whole; a host without `/proc/stat` has only the load, less the threads the runs hold. CPU `some` avg10 at or over `psi_cpu_defer`, or load at or over `load_defer` times the cores, the lines that defer new units, stop growth and step the budget down by the overshoot: the threads the runs hold times line / reading (the larger cut of the two), at most once every 30 seconds so the averages can follow, and never below one thread per run. The runs' own load counts as much as other work's. Each run gets one thread whatever the budget, so every run makes progress; past that, the budget goes one thread at a time to each run still under its request, oldest first. Every recheck by any run recomputes every run's grant under the registry lock, and each run reads its own at its next recheck. Other work that wants every core, such as a CPU-bound load on all of them, takes CPU from the runs, so their measured share falls, other work's rises, and the runs shrink to one thread each.

`test/run.js` runs each test file in a `node --test` runner of its own, through a pool it sizes itself: longest measured file first (`test/durations.json`), with the hung-test timeout, the guards, the private runtime directory and the exit codes it had. Inside Tower Crane the pool's size is the grant, rechecked every `test_grant` interval (3 s, `TOWER_CRANE_INTERVALS`). A grant that falls starts no new file until fewer run than the grant; one that rises starts more at once. The runner logs the grant to stderr when it starts and once per change: `tower-crane: test threads: granted G of N (host budget B of CAP on C cores, T granted to R runs)`, then `grew to` or `shrank to`. Each file's output is printed whole when it ends, so files that ran side by side never mix their lines; the run's totals (`ℹ tests`, `ℹ pass`, `ℹ fail` and the rest, or `#` under TAP) and every failing file's `✖ failing tests:` details come again at the end. A reporter destination other than stdout or stderr is refused, since every file's runner would rewrite the file. Outside Tower Crane (plain `npm test`, CI) the pool's size is the request, capped at one below the cores, as before.

Tower Crane marks the runs it governs with `TOWER_CRANE_TEST_GRANT`, a JSON label of the state directory (`project`), `task`, `agent` and `kind`: every gate command's scratch environment carries one (`kind` `gate`, or `suite` for the merge queue's head check), and so does every spawned agent (`kind` its job). A runner removes the label from its test files' environment, so a run a test starts asks for nothing unless the test labels it. A run on the host holds its lease in the registry itself. A sandboxed agent cannot write the registry, so its run sends `{"tests": {"request": N}}` to its state broker (`TOWER_CRANE_BROKER`) and keeps the connection open: the spawn monitor holds the lease, as the agent's task and name, answers recheck lines with the grant then, and releases the lease when the connection closes, so a run that dies frees its threads at once. The agent controls that connection, so the monitor holds one lease per agent at a time (a second run beside the first is refused with `held: true` and runs one thread), refreshes the registry at most once per `test_grant` interval (rechecks that come sooner share the next answer), and ends a connection whose unfinished line outgrows a request (1 MiB). A run that cannot get a grant (a busy registry, a monitor from before test-thread leases, a copy of the runner without `lib/`) prints `no grant from the host governor (REASON); running N at once` and keeps its request.

`status` shows the budget and every holder on the host: `test threads: budget B of CAP on C cores, other work X cores busy` (or `load X` when the load stood in) `; R runs hold G of N requested`, then one line per run with its task, agent or kind, project, grant and request, holder pid and start. `status --json` carries the same under `governor.tests`: `budget`, `cap`, `cores`, `source` (`cpu` or `load`), `others`, `load`, `cpu_some`, `reasons`, `runs`, `requested`, `granted` and `leases` (`id`, `project`, `name`, `task`, `agent`, `kind`, `pid`, `requested`, `granted`, `started_at`, `changed_at`). The registry keeps the leases as `tests` (each with its tree's CPU ticks at the last sample), the last budget as `test_budget` and the last CPU sample as `cpu`.

### Stopping

Past the stop line, Tower Crane stops its own work: any level's use at or over `stop_at * limit`, or memory `full` avg10 at or over `psi_memory_stop`. It stops one unit at a time: the next only once no stopped unit is left in the registry (its holder exited and released it), or five seconds after the stop, while the line is still crossed. The order is gates and suites first, then reviewers and small agents, then workers, the newest started first within each: a gate reruns from its inputs, a reviewer or small agent starts its job again, and a worker loses its session's context, so the newest of a class loses the least. Orchestrators are never stopped: they run the loop that resumes the rest.

The governor signals only processes the registry recorded when Tower Crane started them, and only while their start time (Linux `start_ticks`) or, on Windows, their creation time still matches, so a reused pid is left alone, and on Linux only from the pid namespace that recorded them (`pidns`); every other process on the host, and every session in the slice, is never touched. Windows gives a freed pid to a new process within seconds and its signal check cannot tell the two apart. There a unit's own process is recorded with its creation time (`created`, UTC epoch ms, read once per process), and every other process with the time it was seen running (`seen`, epoch ms): reading another process's creation time costs a PowerShell call of about a second, and these records are made under the state, dispatch or registry lock. A process created later than `seen` (with 100 ms for clock rounding) took the pid after the recorded one ended. Before each stop, and before it takes the registry lock, the governor reads the creation times of the pids it would signal: a recorded command that exited and whose pid another process took is skipped, a unit that started before that read and whose holders all show as reused is removed as one whose holders exited, and a Windows pid recorded with neither time is never signalled. A read that fails proves nothing: it removes no unit and sends no signal. An agent whose harness has exited is never a victim, even before its supervisor's removal of the unit lands: the stop would free nothing and would kill the supervisor's gate reactions. A stopped worker or reviewer records `spawn phase` `blocked` with reason `supervisor stopped by the host governor: REASON` and a `spawn exit` marked `availability_failure`, so neither the respawn cap nor the reviewer cap counts it. Its claim is released as a dead claim and its worktree kept; the next dispatch, by `spawn` or a wait's refill once there is room, resumes the task there. A stopped gate or suite records no verdict: its command reports `TASK: tests gate stopped by the host governor: REASON; it runs again once there is room`, and its reaction is deferred and retried.

### Deferral and resumption

`review dispatch deferred` events persist a governor-deferred reviewer dispatch
with `sha`, `revision`, `reason`, `since` and the original `body_recheck` context
when it is an automatic light check. Refill restores that context on the reviewer
spawn, preserving the automatic marker in its evidence and the two-failure stop.
If an automatic check replaces an outstanding explicit request, a
`review dispatch context` event records its `sha`, `revision` and `body_recheck`
without adding another debt. An unchanged context emits nothing, and a context
event cannot revive debt a matching spawn has already settled.
The trusted wait host retries these
on every refill pass alongside ready workers, in urgent-first order followed by
descending unblock count and task id. Reviewer retries do not use worker slots.
A governor deferral holds only its unit kind: workers and reviewers have
independent memory reservations, and an admitted kind continues in priority
order while the deferred kind waits for the next pass. This applies to the
per-kind prechecks and to a refusal during dispatch. A dispatch lock still
stops the whole batch.
A live task reaction postpones its retry. Dispatch debt clears when a matching
reviewer spawn is recorded, the submitted head or revision changes, the task
leaves submitted status, or a current eligible review verdict arrives. A failed
PR-body verdict keeps a deferred light review eligible. An outstanding debt is
written once per task, head and revision, even when load, pressure or memory
readings change its reason. A matching spawn settles that debt; a later review
attempt can record its own debt and context. `status` lists the task, first
deferral time and reason in `deferred reviewers`, with the persisted entries in
JSON `deferred_reviewers`. It reads the latest matching reviewer reason from the
governor registry without writing state, and falls back to the saved reason after
the registry hint expires.
Paused projects and missing or stale software gates add a `waiting` explanation
to the deferred reviewer in text and JSON. Its governor `reason` is retained,
so the original resource deferral and the current retry blocker remain visible.

A deferred dispatch or gate refuses with code 3: `TASK: UNIT deferred by the host governor: REASON`. `spawn` asks before any stack read, fetch or worktree; `spawn --ready` stops at the first worker deferral, and automatic refill skips the remaining tasks of the deferred kind. A wait's refill rechecks each kind on every pass and reports a precheck deferral once when it starts. A deferred reaction stays owed in the persistent automation queue, whichever process deferred it; any trusted `wait` retries it in its original turn once five seconds have passed and the governor would admit its unit, as described under [events.jsonl](storage.md#eventsjsonl). The registry keeps each deferral's reason, first time and latest time, and drops it when the unit is admitted or after ten minutes without a retry; a stop is kept for an hour. An owed reaction remains in the gate queue and keeps its `governor_deferred` inbox item after that registry hint expires, until its receipt settles or its source no longer matches an active submitted or accepted head.

Where it shows:

- `status`: a `host governor:` line with the state (`open`, `deferring` while not even the smallest unit this project starts would fit, `stopping` past the stop line), the binding level's use and limit, the lines, Tower Crane's measured use, unit count, project count and growth with its rule (`sum of unit peaks; N of M windows before measured growth`, `p99 ratio R of N windows times ROOM of unit room` or `ratio R after a crossed window, until AT, times ROOM of its units' room and ratio B times REST of the rest`, each measured one ending `, at least the largest unit's ROOM` when the floor applies), the other sessions' use and the room kept for them, and memory and CPU pressure and load; then the reasons while it is not open, `governor deferred: TASK UNIT since AT: REASON` and `governor stopped: TASK UNIT (AGENT) at AT: REASON` lines for this project, and `host governor degraded: ...` with what it cannot read. JSON `governor` has the same fields.
- `inbox`: `governor_deferred` and `governor_stopped` items.
- the board: a Host governor item in Needs you while the governor defers or stops work or holds this project's, Now when it stopped something.

### Settings

`project set --governor JSON` (operational). Each project's settings decide its own admissions; the stop line is the one the process that ticks reads.

| Key | Default | Why |
| --- | --- | --- |
| `defer_at` | 0.85 | keeps 15% of the binding level (5.4 GiB of a 36 GiB slice) for what the budget does not see: page cache that must be read back, kernel memory, and growth inside a unit between ticks |
| `stop_at` | 0.95 | the last 5% (1.8 GiB of 36 GiB) is the room a stopped unit has to exit in before the kernel throttles at `memory.high` or kills at `memory.max` |
| `psi_memory_defer` | 10 | some task waited on memory 10% of the last 10 s: reclaim is already slowing work |
| `psi_memory_stop` | 10 | every task stalled on memory 10% of the last 10 s: the thrashing that comes before an out-of-memory kill and freezes the desktop |
| `psi_cpu_defer` | 60 | runnable tasks waited for a CPU 60% of the time; this host idles at 2 to 8% |
| `load_defer` | 2 | twice as many runnable or blocked tasks as cores; the fork storms of 2026-10-17 reached 16 to 24 times the cores |
| `growth_window_min` | 60 | how long a growth window follows its units, and how long a crossed window's raise lasts: a tests gate, the unit most often deferred, ran a median 55 minutes (p90 78) from `gate run` `running` to `done` over the 65 runs that started in the day to 2026-10-20 07:30 UTC, so a set's growth is measured over about as long as the unit admitted beside it runs |
| `growth_samples_min` | 20 | windows before measured growth replaces the sum: the count unit sizes learn from (the largest of a kind's last 20 peaks). Below 100 windows the ratio is the largest seen, so it is the worst of at least 20 minutes of running work |
| `others_window_min` | 30 | other sessions' test runs and builds repeat within minutes; on 2026-10-17 two of them peaked near 11 GiB and came back |
| `expected_mb` | `worker` 1536, `reviewer` 1024, `small` 1024, `orchestrator` 1024, `tests` 2560, `clean` 1024, `ci` 2048, `suite` 2560 | starting sizes, replaced by measured peaks once three exist: on 2026-10-17 the scope holding an orchestrator, two workers and their tools used 3.0 GiB (peak 3.5 GiB); on 2026-10-20 Tower Crane's own full suite at 12 file workers, the tests gate's planned setting on its 24-core host, peaked at 2.5 GiB (2458 MiB anonymous) over its scope's idle use |

### Registry

One JSON file per user and host, `tower-crane/governor/HOST.json` under the user's cache directory (`XDG_CACHE_HOME`, else `~/.cache`; `%LOCALAPPDATA%` on Windows), the user's own also when the CLI runs inside an agent's home. Only the CLI writes it: under a marked lock beside it (`HOST.lock`, the state lock's scheme, so a dead holder's lock is cleared), replaced atomically, with a file that does not parse set aside as `HOST.json.corrupt` and the budget started again from live readings. It holds the running `units` (project state directory and name, task, kind, agent, holders and roots with their start times or, on Windows, their creation times or the times they were seen running, cgroup, the admitting process's cgroup `admitted_in`, expected, measured and peak sizes, start time, `waiting` while an owner waits, and any stop), `deferred`, `stops`, the last 200 finished units' peaks (`history`), the other sessions' samples (`others`, `{at, level, bytes}`, two hours), the open growth windows (`windows`), the sampled window ratios (`growth`), a crossed window's raise with its end and the units it covers (`raised`, `{ratio, at, until, units}`), the number of lines in the window log, which is cut back to the last 10080 once it passes 12600 (`logged`) and the tick and stop times. A unit whose holders have all exited is removed on the next pass and its peak joins `history`.

Every `wait` that runs reactions, every supervisor and every process running a gate or suite probes every 500 ms. Each probe aborts the process's own units the registry marks stopped. The measuring, sampling and stopping run once per two seconds across the host, by whichever process comes first, and at every probe while the stop line is crossed: memory can grow by gigabytes between two measurements. The registry records a stop before it sends the signal, so the stopped supervisor records why.

### Degraded

- No per-unit scopes (T404 not in place): units are measured from `/proc` as above. A process that leaves its unit's process tree (a daemon that reparents itself) is not counted in its unit, but still counts in the level's use, as other sessions' use.
- No cgroup v2 membership, or no memory limit on the chain: the host is the only memory level, and the other sessions are everything else on the host.
- No pressure stall information (kernels without PSI): pressure does not defer or stop; memory and load still do.
- macOS: the kernel reports no available-memory figure, so only load defers work, and nothing is stopped; Windows: the host level uses free memory and nothing is measured per process, so every unit counts at its expected size.
- `TOWER_CRANE_HOST_ROOT=DIR` reads the host's `/proc` files and `/sys/fs/cgroup` under DIR, and keeps the registry under `DIR/tower-crane-governor`: a fake host is another machine. Tests and `scripts/governor-stress.js` use it; per-process measurement still reads the real `/proc`.

### Worker-written code and config outside the sandbox

The tests and clean gates run code the worker wrote. The tests gate's pinned command runs the submitted commit's tests, build files and scripts; its declared host probes run worker-written commands at the same trust level. The clean gate's pinned cleanup tool is the owner's, but it reads the submitted checkout, and a tool that loads config or plugins from it (a linter config, for one) runs the worker's code. Both run outside any sandbox, as the user who ran `check` or `accept` (for a reaction in a dispatch supervisor, the dispatcher), with that process's environment (`HOME`, `PATH`, `GH_TOKEN` and any other credentials it holds), in a temporary detached worktree of the commit under `TOWER_CRANE_TMP`, then `gates.tmp_root`, then `tc/g` under the user's cache directory. The only changes to that environment are `TMPDIR`, `TMP` and `TEMP`, which point at a scratch directory beside the worktree, and a set `NODE_COMPILE_CACHE`, which moves into that directory. The cleanup tool also gets the git environment below, so the git it runs in that worktree takes no command from the repository's config. The tests command gets no git environment, since it runs the worker's code anyway. Local CI runs its command the same way as the tests gate. Review what a task changes before running its gates where that environment matters.

A sandboxed worker may write the repository's git directory (`writeOutside: git`), which holds its config, hooks and `info/attributes`. Every git command the CLI and gates start themselves (worktree, spawn preparation, submit scope, the gates' checkouts, diffs and fetches), every git that `gh` starts for them (`gh stack sync`, `checkout`, `link` and `merge`, `gh pr` calls) and every git the pinned cleanup tool starts takes command-running settings only from the system, global and command scopes, through `GIT_CONFIG_COUNT` entries appended after any the caller already set:

- `core.hooksPath` is the trusted value when it is absolute or starts with `~/`, otherwise the null device, so the repository's `hooks/` directory and a hooks path the repository names never run.
- `core.fsmonitor` is `false`. `core.sshCommand`, `core.askPass`, `core.alternateRefsCommand`, `diff.external` and origin's `uploadpack` and `receivepack` take their trusted value, or a default that names no repository command (`ssh`, `git-upload-pack`, `git-receive-pack`, empty). Git reads `GIT_SSH` and `SSH_ASKPASS` only when `core.sshCommand` and `core.askPass` are unset, so the defaults carry them: `core.sshCommand` defaults to the caller's `GIT_SSH`, shell-quoted, when it is set, and `core.askPass` to the caller's `SSH_ASKPASS`. `core.pager` takes its trusted value, or the caller's `PAGER`, or `less`, which is the order git reads them in after the caller's `GIT_PAGER`. `protocol.ext.allow` and `protocol.fd.allow` are `never`; fetches do not recurse into submodules. `maintenance.auto` is `false` whatever its scope, since the `gc --auto` that fetch, commit, merge and rebase start runs prune and repack, which run `gc.recentObjectsHook`.
- `GIT_NO_REPLACE_OBJECTS` is `1`, so replace refs in the common directory a worker writes do not change the history and objects these commands see.
- `GIT_PROTOCOL_FROM_USER` is `0`, since no URL these commands use is typed by the user, so a protocol git allows only for a typed URL (any remote helper beyond `http`, `https`, `git` and `ssh`) is refused unless trusted config allows it. `protocol.file.allow` is the trusted value, or the trusted `protocol.allow`, or `always`, so local remotes keep working as before; git makes `file` user-only for the submodules a clone recurses into, and these fetches recurse into none.
- `GIT_PROXY_COMMAND` is the caller's value or empty, which overrides all `core.gitProxy` entries. Git proxy commands must come from that environment variable because config uses the first matching entry.
- The credential helper list is cleared, then refilled with the trusted `credential.helper` and `credential.<url>.helper` entries in their order.
- Each filter (`clean`, `smudge`, `process`), diff driver (`command`, `textconv`), merge driver, `remote.<name>.uploadpack` or `receivepack`, `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`, `alias.<name>` and `pager.<cmd>` key the repository's own config files set takes the trusted value, or is emptied so git refuses to run it (an empty `pager.<cmd>` is false); such a filter is not `required`. A trusted filter reads the same config, so git-lfs's command keys are treated the same way: `lfs.customtransfer.<name>.path` and `args`, `lfs.standalonetransferagent` and `lfs.<url>.standalonetransferagent`, and `lfs.extension.<name>.clean` and `smudge`, matched without regard to case. A transfer or extension the repository adds then fails instead of running; `.lfsconfig` honors none of these keys. A `protocol.<name>.allow` or `protocol.allow` the repository sets takes the trusted value, or the policy git would apply without it: the trusted `protocol.allow`, then `always` for `http`, `https`, `git`, `ssh` and `file` and `user` for any other. Aliases are covered because git runs `alias.remote-<name>` for a `<name>::` URL or `remote.<r>.vcs` when no `git-remote-<name>` program exists. Those files are the shared `config`, the `config.worktree` of the worktree git runs in and every file they include through `include.path` or `includeIf`, whatever its condition, so a `gitdir:`, `onbranch:` or `hasconfig:` include that matches only in a task or gate worktree is covered too.

Git calls that read config and refs but no object, index or hook run without the scan: `git rev-parse` asking only where the repository is (`--git-dir`, `--git-common-dir`, `--absolute-git-dir`, `--show-toplevel`, `--is-inside-work-tree`, `--is-bare-repository`, `--path-format`), `git worktree list`, `prune`, `lock` and `unlock`, and `git remote get-url`.

Git clears the command scope for a push to a repository on this machine, so that repository's own config and hooks run. The CLI's one push, the generated-file repair, goes to `origin` by name after its push URL is checked against the PR (see `generated merge` below), so a repository `pushInsteadOf` cannot send it elsewhere. The pushes `gh stack sync` makes go to whatever origin URL the repository config names, and nothing here checks that URL.

A process reuses a scan for the same checkout and caller environment while every file it read holds the same bytes, and each directory it checked keeps its mode: the checkout's `.git`, the git directory's `HEAD`, `commondir`, `objects` and `refs`, the shared `config`, `config.worktree`, each included file and the trusted config files the scan took entries from. They are read again before each command, and any change to them scans again. A file with no include that is empty, or that git's own listing for the checkout already read, takes its keys from that listing; any other file is parsed from the recorded bytes, one git process each. A checkout with no `.git` of its own, one git resolves elsewhere, or an environment that sets `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE` or `GIT_OBJECT_DIRECTORY` is scanned for every command.

Git and gh also refuse to start while the common directory of the repository they run in holds a `commondir` file, which git never writes there and which would point git, and Tower Crane's state lookup, at another repository ([ladder.md](../ladder.md#the-common-directorys-commondir)). The check finds the git directory as git does (`GIT_DIR`, else the nearest `.git` or bare repository) and covers the calls that skip the scan. Only a worktree admin directory, one holding `gitdir` and no `objects/`, may name a common directory, and only one that holds it at `worktrees/<id>` (directly, or as `.git-admin/<name>` through a link there); any other `commondir` is refused. Spawn refuses a worktree whose `.git` file names a git directory that is not such an admin directory of the repository, whose `commondir` names its common directory, before granting it to a sandbox. Where git's answer decides a path (`--git-common-dir` for the state directory and the gates' worktree lock, `--git-dir` for a spawn's git directories), it must match that location, so a file that appears between the check and git's lookup is refused too. The supervisor removes a `commondir` in the common directory and records at most one `commondir removed` event per sample interval, with `agent`, `pid`, `path`, `named` (what the file last named) and `count`.

The config scan must complete successfully before git or gh starts. An error, timeout or output buffer overflow refuses the command rather than using a partial driver list, and so does a repository include whose path starts with `~user/` or `%(prefix)/`, which the scan does not resolve. Named driver keys are checked against the config files just before each command, so a key a worker adds between that read and git's own can still run. The fixed keys above have no such gap. Claude Code's sandbox mounts the git directory's `config`, `config.worktree` and `hooks/` read-only, which closes the gap for claude workers. The codex sandbox rules grant the whole git directory, so a codex worker can still add a key. The worker's own git and gh, through their shims, keep the repository's config.

### What the git and gh shims guard

Every spawned agent finds its `git` and `gh` shims first on `PATH`: claude, opencode, agy, pi and `command` agents in `homes/<agent>/bin/`, a sandboxed codex agent in `homes/<agent>/home/.tower-crane-shims/bin/`, which its sandbox shows read-only ([ladder.md](../ladder.md#agent-files-and-homes)). Until 2026-10-14 a sandboxed codex agent's sandbox hid its shims, so `git` and `gh` were the host's and none of the shim policy applied to codex agents.

The shims hold an agent that runs `git` and `gh` by name, and the tools that look them up on `PATH`, to its role's push and gh policy. They do not hold an agent that means to get past them: `/usr/bin/git` and `/usr/bin/gh` are readable and run in both sandboxes. What holds such an agent is that it has nothing to push or call GitHub with.

**A sandboxed agent holds no GitHub credential.** Claude and codex agents whose agent file says `sandbox: true` (worker, researcher, reviewer, small) get no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`: spawn does not ask the keyring for them, and the supervisor removes them from the agent's environment on every launch, retry and fallback, whether the dispatcher's environment, the project or rung `env` or an `env_file` sets them. The rendered git config clears every credential helper and adds none ([ladder.md: git config](../ladder.md#home-reads)). The sandbox hides the user's home (the gh config, `~/.git-credentials`, `~/.ssh`) and `/run` (the keyring's session bus, the SSH agent). `test/live-sandbox.test.js` checks this in the real claude and codex sandboxes, spawned by a user whose gh is logged in: no token variable; no file the agent can read (its `HOME`, the state directory, its git config, every `/proc/<pid>/environ` it sees) holds the user's token; `git credential fill` answers nothing for GitHub; `/usr/bin/git push` over https fails for lack of credentials; the SSH agent socket does not connect.

**Pushes, fetches from origin and gh go through the broker.** The agent's shims send them to its [state broker](../ladder.md#state-broker), which runs outside the sandbox, checks them again there, and runs them with the user's own login (`lib/github-broker.js`).

- `git push` of the task branch to `origin`, from the task's repository, sends only the commit the agent names. The broker loads the role's agent file and refuses a role without `gitPush: branch`. The destination is always `refs/heads/<task branch>`, never the project's base branch, and the request has no field that could name another. The URL is `origin`'s, read from the repository's config file without includes or URL rewriting, and it must be the project's recorded GitHub repository (https or ssh), or a path on this machine for a project that records none. The broker opens nothing in the task repository's object store: the agent can write it, git does not re-hash a loose object when it reads one, and an alternates entry or a link there would point the broker, which reads with the user's permissions, at a repository the sandbox hides. Instead the broker's own bare repository, `push/cache.git` in the state directory, fetches the remote's branches, and the broker sends the shim the remote's branch heads (`{need: {have}}`). The shim builds a thin pack of the commit in the sandbox (`git pack-objects --revs --thin`, bounded by the heads it holds) and sends it on the same connection in length-prefixed frames, ended by an empty frame, and the broker indexes it with `index-pack --strict --fix-thin`, which computes each object's id from its content, then requires every object of the commit the remote lacks to be present. A commit the cache already holds whole needs no pack. The pack goes into a quarantine object directory beside the cache, as receive-pack does, and moves into the cache only after every check passes, so a refused push leaves nothing. A pack over 2 GiB (GitHub's push limit) is refused, and so is one that stalls for 10 minutes; pack-objects writes nothing while it searches for deltas, which takes minutes on a large history. When the broker answers before it read the whole pack, the shim stops its pack-objects and exits with the answer. The shim never ends its side of the connection to mark the end of the pack, since a Windows named pipe has no half close; any end of the agent's side is a hang-up, and the broker stops what it runs for that agent, including its checks and its push after the whole pack arrived. Every release frames the pack, and a spawn's shims and broker run one copy of the tool (`homes/<agent>/tool/`), so an upgrade during a run does not split them. A shim from a snapshot before framed packs (T291) sends a bare pack: the broker sees its `PACK` signature where the first frame's length belongs, refuses the push and says the shim and broker come from different snapshots. The cache takes the remote's object format (from `ls-remote`, or the commit id's length for an empty remote) and is made again when its format differs. One push at a time uses it, under the `push/cache.lock` directory, which holds one marker per holder; a dead holder's marker is removed by name, so two waiters never both take the lock. Lock files and temporary packs a killed git left, and quarantines a killed broker left, are removed before each push. The broker refuses the push when a commit the remote lacks changes a file under `.github/workflows/` or `.github/actions/`, or the `action.yml` or `action.yaml` of a local action a workflow in the pushed commit runs (`uses: ./path`), that the task's title, acceptance or brief does not name (a merge counts only the files it changed against every parent). These checks and the push read only the cache. git runs without the dispatcher's `GIT_TRACE*` and `GIT_CURL_VERBOSE` variables, since the push's stderr reaches the agent. It then pushes without force (`--no-verify`, no tags, no submodules), so a rewritten history is refused as a non-fast-forward. Output streams back as it comes, with git's progress. The broker's `ls-remote`, fetch and push talk to the remote under the cache lock, so each runs with `--progress` where git has it and is stopped, with the ssh or remote helper it started, after 10 minutes without output or an hour in all, the limits of the agent's pack. A moving transfer prints about once a second; the 10 minutes cover the remote's checks of a push and the connectivity check and gc a fetch runs. A remote that stops answering, as over a network that drops without a reset, then fails the push or fetch with the reason and frees the lock for the project's other agents. The shim refuses a force, deletion, wildcard or other-branch refspec before it asks, and after a push records `refs/remotes/origin/<branch>` (and the upstream with `-u`, where the config is writable).
- `git fetch origin` (and `git fetch` whose current branch fetches from origin) from the task's repository goes to the broker when origin's one URL, read from the config without URL rewriting, is the project's recorded GitHub repository (https or ssh). git fetches any other origin, a path on this machine included, in the sandbox as before. Inside the sandbox it cannot work: there is no credential, the SSH agent's socket is under the hidden `/run`, and in a user namespace ssh refuses `/etc/ssh/ssh_config.d/*` because root-owned files appear owned by nobody (`Bad owner or permissions`). The broker checks origin's URL again, from the repository's config file without includes or URL rewriting, and fetches only from the recorded GitHub repository: a project that records none, or a local path, gets no brokered fetch, since the broker reads with the user's permissions and a path could name a repository the sandbox hides. The broker brings `push/cache.git` up to date under the cache lock, as for a push, and answers with the branches the task may fetch: the project base, the base its pull request targets when stacked, and the task branch, or those of them the agent names; any other branch is refused. It sends their heads (`{refs}`, null for a branch origin lacks), then a thin pack of their commits (`pack-objects --revs --thin`) bounded by the commits the agent says it holds that the cache has, as base64 `{pack}` lines that wait for the connection to drain. An agent that reads none of it for 10 minutes, or has not read it all after an hour, ends the fetch and frees the cache lock; a push's pack has the same hour cap, and the broker's own fetch from the remote the limits above. The shim indexes the pack into the task repository with `index-pack --stdin --fix-thin`, where git hashes every object, checks that each head arrived whole, and updates `refs/remotes/origin/<branch>` and `FETCH_HEAD`. When index-pack fails (a read-only git directory, a full disk), the shim drops the rest of the pack, waits for the broker's answer and exits 1 with index-pack's error, leaving origin's branches as they were. It takes branch names, `refs/heads/B` and `+refs/heads/B:refs/remotes/origin/B`, and `-q`, `-v`, `-p` (prunes a fetchable branch origin lacks), `-n`/`--no-tags`, `--[no-]progress` and `--no-write-fetch-head`; it refuses other refspecs and options, such as tags, `--unshallow` or `--all`. `git pull` from such an origin is refused with the way that works: fetch, then merge `origin/<branch>`. The same request runs over every broker transport: a Unix socket for claude, loopback TCP for codex, a named pipe on Windows. macOS and Windows have no user-namespace owner remapping, but the agent holds no credential there either, so fetch goes through the broker on every platform.
- A push to a path on this machine, such as a test fixture's bare repository, still runs in the sandbox, which decides what it can write. A push from elsewhere to another machine is refused: the agent has no credential for it.
- `gh` runs on the host in the project's recorded repository (the broker refuses gh for a project that records none), with no local repository for gh to read and an environment of only what gh needs: `PATH`, `HOME`, the locale, the XDG and gh config directories, the session bus its keyring answers on and the proxy settings. gh's config directory (`GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`) must not resolve inside the state directory (which holds the agent homes), the agent's worktree or the task repository's git directory; the broker refuses gh otherwise. A token the dispatcher's environment holds goes in too, and then `--jq` is refused, since gh's jq reads the environment. The broker parses the arguments with gh's own flag table (`lib/gh-flags.json`, regenerated by `node scripts/gh-flags.js`; a flag it does not list is refused) and checks the role's gh policy; `gh search` and `gh status`, which read across every repository the user sees, are not brokered. It refuses flags that act on the host (`--web`, `--editor`, `--recover`, `--attach`, `auth status --show-token`) and any flag that reads a file by path, except `--body-file`, whose file the shim reads in the sandbox and sends as stdin. `-R` must name the project's repository and a URL argument is refused. `pr create` comes from the task branch only. A command that changes a pull request (`pr edit`, `pr comment`, `pr review`, `pr ready`, `pr close`, `pr reopen`, `pr merge`, as the role allows) acts only on a pull request whose head is the task branch in the same repository; without a number it is the task branch's. When the agent hangs up, as `timeout ... gh pr checks --watch` does, the broker stops the gh it started.

**Agents without an OS sandbox.** opencode, agy, pi and `command` agents run as the user, without a sandbox, so they can read whatever the user can: the gh config, the keyring through the session bus, `~/.ssh`. Spawn still hands them `GH_TOKEN` and their shims run `git` and `gh` directly. No token guarantee holds for them; it needs an OS sandbox. That is one reason a worker, reviewer or small rung on one of them is owner-required (`ladder.reach`, [Authority](decisions.md#authority)).

**On GitHub.** The broker uses the user's own login, so what it can do is bounded by the checks above, not by the token's scopes. Keep a ruleset on the default branch as well, so a mistake in the broker or a human slip cannot reach it: require a pull request, allow only the merge method the project uses, and block force pushes and deletion, with no bypass actors. `agent-sh/tower-crane` has one since 2026-10-14 (ruleset `main: PRs only, no force push or deletion`, active on `~DEFAULT_BRANCH`: pull request required with squash merges only, `non_fast_forward` and `deletion` rules, no bypass actors; `gh api repos/agent-sh/tower-crane/rules/branches/main` lists the three rules). GitHub cannot scope a token to one branch, so the task-branch rule lives in the broker.

### Broker verbs

Some tasks need a host action a sandbox cannot give: a lab rehearsal that drives containers, or a GPU job behind a lease. A worker never gets the socket for it (docker, rootless docker or the session bus), since each one escapes the sandbox's file limits. The project declares the action instead as a broker verb, and the worker asks its [state broker](../ladder.md#state-broker) to run it (`lib/verbs.js`).

`project set --broker-verbs JSON` replaces the whole map in `project.json`, `broker: { verbs: { NAME: verb } }`, and `null` removes it. It is `broker.verbs`, owner-required ([Authority](decisions.md#authority)). A verb:

```json
{
  "rehearse": {
    "argv": ["python3", "tools/lab/campaigns/reuse/rehearse_closure.py", "image", "--campaigns", "{param.campaigns}", "--store", "{mount.store}", "--receipt", "{out}/receipt.json"],
    "source": { "commit": "<full sha on the base branch>", "paths": ["tools/lab"], "digest": "<written by project set>" },
    "mounts": { "store": "/srv/lab/store" },
    "resources": { "tasks_max": 512, "memory_max_bytes": 8589934592 },
    "timeout_sec": 1800,
    "outputs": ["receipt.json"],
    "params": { "campaigns": { "type": "string", "pattern": "[a-z0-9_]+(,[a-z0-9_]+)*" } },
    "delegate": true
  }
}
```

- `argv`: the program and its arguments, no shell. Placeholders fill whole or part of one element: `{param.NAME}` a declared parameter, `{mount.NAME}` a declared mount, `{source}` the source directory and `{out}` the run's output directory. The program, `argv[0]`, takes no parameter. Every placeholder must be declared, and every declared parameter used.
- `source`: where the program and its scripts come from, exactly one of:
  - `{commit, paths?}`: a full commit hash on the project's base branch (`origin/BASE` when the repository has it, else `BASE`). `project set` copies the files at that commit, or under `paths`, into `verbs/sources/<digest>/tree/` in the state directory, and records `digest`, the SHA-256 of the copy's manifest of file paths, modes and SHA-256s. It reads every commit, tree and blob with `git cat-file` and checks each against its own name, so an object rewritten in the shared git directory is refused. A symbolic link is refused; a submodule is left out. The verb runs with this copy as its working directory.
  - `{path}`: an absolute directory the owner keeps, used as the working directory.
- `mounts`: names to fixed absolute host paths the verb works on, such as a store.
- `resources`: `tasks_max` and `memory_max_bytes` for the verb's contained scope, as in [resource containment](#resource-containment); a missing key takes the gate's cap.
- `timeout_sec`: required, whole seconds. At the deadline the verb gets `SIGTERM`, and `SIGKILL` 5 seconds later, with whatever it started.
- `outputs`: file names the verb may write into `{out}`.
- `params`: names to `{type, pattern}`. `type` is `string` or `integer` (an optional minus and digits), and the whole value must match `pattern`, a JavaScript regular expression. A worker passes each declared parameter once, and nothing else.
- `delegate`: true lets the orchestrator grant the verb; otherwise each grant is the owner's.

`project set` refuses a `source.path`, a mount or a literal absolute path in an argument inside a directory an agent writes. An argument's paths are its pieces between `=`, `,` and the path list separator (`:`, or `;` on Windows), so `--config=/x` and a search path count; a piece with a placeholder counts as the directory its literal text before the first placeholder ends in, so `/repo/tools/{param.step}.sh` reaches `/repo/tools`. The directories an agent writes are the state directory, the repository and its git directory, the worktrees root, the agent and task caches (`tower-crane` under the cache root), each task's recorded worktree and scratch, and `sandbox.write`. `tower-crane verb` checks again before each run with what it knows without git: the same list less the repository, for which it takes the state directory's parent when that is `.tower-crane`. It then checks every piece of the filled argv, with parameter values in place, a relative piece resolved from the working directory and `..` resolved, and refuses one in a directory an agent writes unless it is under `{source}` (the working directory) or `{out}`.

A task runs only the verbs `broker_verbs` names ([tasks.json](tasks.md#tasksjson)). `tower-crane verb NAME --param KEY=VALUE` runs one for the task's claimant, or the orchestrator or the owner; a sandboxed worker's call goes through its broker, which runs it on the host under the worker's identity, for its own task only. Before the program starts, the run checks the grant, the claim and every parameter, and verifies each file of a commit source's copy against its manifest; a missing or changed file refuses the run. Running `project set --broker-verbs` again with the same verbs repairs the copy: the pin is named by its content, and a copy that fails the check gives way to the one just built from hash-checked objects. When two runs pin the same copy at once, the second keeps the first one's copy once it verifies. The verb runs in a contained scope with its caps and timeout, in the environment of the CLI that runs it (for a brokered call, the spawn monitor's), less the `TOWER_CRANE_` identity, state, task and broker variables and the owner key, plus `TOWER_CRANE_VERB` (its name) and `TOWER_CRANE_VERB_OUT` (`{out}`). `{out}` is `verbs/runs/<task>-<verb>-<stamp>` in the state directory, which no sandbox writes, so a link a worker plants cannot steer the verb's writes. After the verb exits, each declared output it wrote is copied into the task scratch as `verb-<verb>-<stamp>-<output>` with an exclusive create, which refuses a name already there, a link included, and `{out}` is removed. A task without a recorded scratch cannot run a verb that declares outputs. The command prints the verb's stdout, then its result and each output's path and SHA-256, writes the verb's stderr to stderr, redacting credential-shaped environment values in both, and exits with the verb's code, or 1 for a timeout, signal or cap, even when the verb exits with a code of its own as it stops.

Each run appends `verb` evidence to the task and a `verb` event: `{ name, params, exit_code, signal, timed_out, resource_reason?, duration_ms, outputs: [{ name, path, sha256, bytes } or { name, missing: true } or { name, sha256, bytes, refused }], source }`, with `ok` when the verb exited 0 within its caps and timeout. `refused` names the scratch path and the error when the exclusive copy failed, such as a name already there or a scratch the CLI cannot write; the digest is of the output the verb wrote, which is removed with `{out}`. A missing or refused output does not change `ok`: the verb decides its result, and the reader checks each output it needs. A refused request records nothing. The evidence feeds no gate; the reviewer reads it in `task show`.

The threat model: a verb runs outside the worker's sandbox, as the user. If its program or any script it runs came from the task's own commit or worktree, the worker would edit the script and run anything on the host. So the source is the owner's: the base branch commit the owner approved, held in the state directory, or a path outside every directory an agent writes. A worker's edit to its worktree, a commit on its branch, a move of the base branch and a rewritten git object change nothing that runs; an approved verb changes only through the owner. What the worker controls is the parameter values, each bounded by its pattern, so the owner writes patterns that cannot name another path or option (no `/`, `..` or leading `-` unless the verb wants one). A verb that must run task code is the wrong tool: that code runs in the sandbox, as the tests do. Data a verb reads from a mount or a parameter is the owner's to judge.

## Shim policy

`homes/<agent>/policy.json` holds the shim permissions, the task's recorded `branch` and the project's recorded `repo` at dispatch, and `masks`, true for a claude sandboxed role. With `masks`, a `git merge` or `git checkout` that brings in a path claude's sandbox masks is built with plumbing instead of checkout. The placeholder cleanup and Git shim share the classified root mount list, including the protected `.claude` configuration files and directories. Protected names match case-insensitively through the default three-component scan; read-only protected directories also protect their descendants. Every root name on that list counts as mounted whether or not it exists at spawn, since Claude mounts absent names too. The shim checks read-only paths and ancestors before moving the worktree, so a path inside a read-only directory is held, and newly added nested names without a mask are written normally. With `gitPush: branch`, a push to another machine must use `origin` in that GitHub repository, and every destination must resolve to `refs/heads/<branch>`. Origin's configured fetch URL must match `repo`; configured push URLs must equal the fetch URL, and all resolved push URLs must equal the resolved fetch URL after rewriting. The current checkout and environment cannot replace the recorded branch or repository. See [CLI](../cli.md) for push restrictions and the local test repository exception.
