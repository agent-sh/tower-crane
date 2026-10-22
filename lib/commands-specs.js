'use strict';

const str = (arg, help) => ({ type: 'string', arg, help });
const int = (arg, help) => ({ type: 'int', arg, help });
const num = (arg, help) => ({ type: 'number', arg, help });
const many = (arg, help) => ({ type: 'multi', arg, help });
const bool = (help) => ({ type: 'bool', help });
const SPAWN_SETTINGS = {
  sandbox: str('JSON', 'owner-required: {write: extra writable paths, read: extra readable paths under the home}; project set accepts null to clear'),
  env: str('JSON', 'owner-required: extra environment variables; use env_file for secrets; project set accepts null to clear'),
  env_file: str('FILE', 'owner-required: systemd-quoted env file read only at spawn; project set accepts null to clear'),
  scope: str('JSON', 'owner-required: systemd user scope properties, e.g. {CPUQuota: "200%", IOWeight: "50"}; {} clears optional properties, mandatory resource caps remain; TasksMax, MemoryMax, MemorySwapMax, OOMPolicy, Delegate and Slice are replaced by containment, with a warning; project set accepts null to clear'),
};

const SETTINGS = {
  ...SPAWN_SETTINGS,
  name: str('N', 'project name'),
  goal: str('G', 'one-line goal'),
  repo: str('O/R', 'GitHub repository (default: from the origin remote)'),
  base: str('B', 'base branch for task branches (default: the current branch)'),
  workers: int('N', 'worker slots held by live leases, unclaimed spawns or interrupted supervisors still stopping (default 6)'),
  'lease-minutes': int('MIN', 'default claim lease (default 60)'),
  owners: int('N', 'operational (orchestrator or owner): spawned workers that may wait on their submitted task as its PR owner, apart from the worker slots (default twice the workers)'),
  'owner-idle-minutes': num('MIN', 'operational (orchestrator or owner): minutes without an event for its task after which a waiting PR owner exits (default 180)'),
  'tasks-max': int('N', 'operational (orchestrator or owner): processes/threads per agent or gate, descendants included; default sized from host, slice and role'),
  'memory-max-bytes': int('N', 'operational (orchestrator or owner): bytes per agent or gate, descendants included; default sized from host, slice and role'),
  paused: str('REASON', 'pause new claims and dispatches with a reason; empty resumes'),
  'budget-hours': { ...num('H|null', 'hours budget; null removes the limit'), nullable: true },
  'budget-tokens': { ...int('N|null', 'token budget; null removes the limit'), nullable: true },
  standards: str('S', '"default" or a path to a standards Markdown file'),
  'tests-cmd': str('CMD', 'operational (orchestrator or owner): pin the test command; null clears it'),
  'clean-cmd': str('CMD', 'operational (orchestrator or owner): pin the cleanup command prefix; null clears it'),
  'clean-paths': str('JSON', 'operational (orchestrator or owner): absolute or ~/ tool dependency paths bound read-only in worker sandboxes; [] or null clears them'),
  'tests-proof-cmd': str('CMD', 'operational (orchestrator or owner): pin the scoped proof template with {tests}; null clears it'),
  executors: int('N', 'operational (orchestrator or owner): automation executors running gates at once on this host (default 2)'),
  'tests-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per test command (default 20); null restores default'),
  'clean-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per cleanup command (default 20); null restores default'),
  'host-probe-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per host probe (default 10); null restores default'),
  'rework-hold-min': str('MIN', 'operational (orchestrator or owner): minutes automatic refill waits after an automatic gate rework that gates retry --from-rework can still undo (default 5, 0 disables); null restores default'),
  'tmp-root': str('DIR', 'operational (orchestrator or owner): absolute directory where check tests, check ci and check clean build worktrees and scratch (default tc/g under the user cache directory, not the OS temp directory; TOWER_CRANE_TMP overrides it); null restores default'),
  'final-review': str('JSON', 'operational (orchestrator or owner): {"command": ARGV with {repo}, {pr} and {sha}, "when": "capped" or "always", "capped_pattern": REGEX, "timeout": SEC (default 1200), "concerns_exit": N (default 2)}: the external reviewer accept asks once per head after every other gate passed; null turns it off'),
  'tests-paths': str('JSON', 'operational (orchestrator or owner): non-empty array of test path globs; null restores default layouts'),
  'tests-keep': str('JSON', 'operational (orchestrator or owner): extra build file globs to keep at submitted sha; [] or null restores defaults'),
  'tests-host-only': str('JSON', 'operational (orchestrator or owner): test file globs a sandboxed worker cannot run, listed in its brief; the tests gate runs them on the host; [] or null clears them'),
  'tests-host-env': str('JSON', 'operational (orchestrator or owner): environment names to string values applied only to host-only gate runs; {} or null clears them'),
  'tests-mode': str('MODE', 'operational (orchestrator or owner): prove, run-only or none; null restores prove'),
  'tests-by-kind': str('JSON', 'operational (orchestrator or owner): task kind to tests mode overrides; null clears overrides'),
  'tests-map': str('JSON', 'operational (orchestrator or owner): source path or glob to test file arrays; null clears the map'),
  'tests-crucial': str('JSON', 'operational (orchestrator or owner): test files every tests gate runs; with tests.expensive and tests.map they replace the full head suite; null clears them'),
  'tests-expensive': str('JSON', 'operational (orchestrator or owner): true selects the head suites with scoped proof; false or null restores normal proof'),
  'ci-ignore-apps': str('JSON', 'array of GitHub app slugs to skip; [] or null clears the list'),
  'ci-required': str('JSON', 'array of required check-run names or prefixes; [] or null clears the list'),
  'ci-capped-review': str('JSON', 'array of {app, pattern}: a matching check run of that app is a nonblocking capped review; [] or null clears the list'),
  'ci-local': str('JSON', 'local CI {command: argv, timeout: seconds, by_kind?: overrides}; null restores hosted CI'),
  'ci-dispatch': str('JSON', 'ci dispatch {workflow?: file name or id, per_hour?: N}; null restores the PR workflow and 4 per hour'),
  'merge-keep-branch': str('JSON', 'true keeps remote merged task branches; false or null restores deletion; stale local worktrees and branches still retire'),
  'session-bus': str('JSON', 'owner-required: true lets claude worker sandboxes reach the user session bus, which lifts their confinement; false turns it off (docs/state.md#projectjson)'),
  'merge-admin': str('JSON', 'owner-required: true uses gh --admin for solely owned repos; false or null disables it'),
  'decision-delegation': str('JSON', 'owner only: JSON booleans orchestrator_technical and orchestrator_escalated_questions (both default true); false keeps those answers with the owner; null clears'),
  'publish-policy': str('JSON', 'owner-required, set once: {"conditions": [review_clean, full_suite, main_ci_green]} under which the orchestrator publishes without a per-release ask; null clears'),
  'review-policy': str('JSON', 'operational (orchestrator or owner): review diff limits, minimum reviewer rung, churn threshold and canonical model prices; null clears the policy'),
  governor: str('JSON', 'operational (orchestrator or owner): host governor lines for this project\'s admissions {defer_at, stop_at, psi_memory_defer, psi_memory_stop, psi_cpu_defer, load_defer, others_window_min, growth_window_min, growth_samples_min, expected_mb}; null restores the defaults'),
  'research-min-sources': int('N', 'owner-required: minimum distinct cited pages for research (default 10)'),
};

const TASK_FIELDS = {
  title: str('T', 'what the task is'),
  acceptance: many('A', 'how to tell it is done; repeat for more lines'),
  kind: str('K', 'code, docs, research, design or ops (default code)'),
  needs: str('JSON', 'task capabilities as a JSON array: ["browser"]; [] clears'),
  size: str('S', 'S (under an hour), M (a few hours) or L (a day); default M'),
  dep: many('ID', 'a task this one depends on; repeat for more'),
  lock: many('NAME', 'exclusive resource name; repeat for several'),
  environment: str('LABEL', "environment label; '' clears it"),
  tier: str('T', 'easy, medium, hard, research or an ascending range (easy..medium): the ladder rung that does it (default: research for kind research, easy for S docs, hard for L, else medium)'),
  'needs-owner': str('REASON', 'what the owner has to do first'),
};

const RUNG_FLAGS = {
  ...SPAWN_SETTINGS,
  harness: str('H', 'claude, codex, opencode, agy, pi or command (default: the ladder\'s default harness); moving a worker, reviewer or small rung off claude and codex is owner-required'),
  model: str('M', 'model id'),
  profile: str('P', 'codex profile'),
  provider: str('P', 'pi provider'),
  effort: str('E', 'reasoning effort, in the harness\'s own terms'),
  args: str('JSON', 'extra arguments appended to the harness command, as a JSON array; owner-required on a harness other than claude and codex'),
  command: str('JSON', 'owner-required: for the command harness: argv array; {task} {brief} {prompt} {cwd} are substituted'),
  supervision: str('JSON', 'retry, backoff, stall and progress path settings as a JSON object'),
  tools: str('JSON', 'claude or codex: tools the agent file denies that this rung opts back in to (claude tool names, codex features), as a JSON array; operational for harness built-ins that keep the rung sandbox, other tools owner-required'),
  mcp: str('JSON', 'claude or codex: MCP servers from your harness config this rung opts in to, by name, as a JSON array; the orchestrator names only servers the owner already defines'),
  'web-mcp': str('JSON', 'owner-required: research Claude web MCP {name, command, args}, without secrets'),
  credential: str('NAME', 'owner-required: the OS-store credential the harness authenticates with (claude with provider bedrock or anthropic, codex); store it with tower-crane credentials set NAME'),
  fallbacks: str('JSON', 'personal ordered fallback routes in the user file; edit separately from primary fields'),
  clear: many('FIELD', 'remove a field from the rung (a cleared harness follows the default)'),
};

const run = (mod, fn) => (ctx) => require(mod)[fn](ctx);
const gate = (name) => (ctx) => require('./check').runGate(ctx, name);

module.exports = { str, int, num, many, bool, SPAWN_SETTINGS, SETTINGS, TASK_FIELDS, RUNG_FLAGS, run, gate };
