#!/usr/bin/env node
'use strict';

const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';
let outputPipeClosed = false;

for (const stream of [process.stdout, process.stderr]) {
  let broken = false;
  stream.on('error', (error) => {
    // libuv reports a pipe whose reader is gone as EPIPE, or EOF on Windows.
    if (['EPIPE', 'EOF'].includes(error.code)) {
      broken = true;
      stream.destroy();
      if (!outputPipeClosed) {
        outputPipeClosed = true;
        process.emit(OUTPUT_PIPE_CLOSED);
      }
      return;
    }
    if (!broken) throw error;
  });
}

const { TowerCraneError, usage, refuse, readStdin } = require('../lib/util');
const { isatty } = require('node:tty');
const S = require('../lib/state');
const P = require('../lib/project');
const T = require('../lib/tasks');
const D = require('../lib/decisions');
const R = require('../lib/render');

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

const GLOBAL = {
  state: str('DIR', 'state directory (default: TOWER_CRANE_STATE, then .tower-crane/ in the main checkout)'),
  agent: str('NAME', 'who is acting (default: TOWER_CRANE_AGENT; task processes cannot use owner; fallback needs an interactive terminal outside a task)'),
  json: bool('machine output on stdout'),
  help: bool('show help'),
};

const SETTINGS = {
  ...SPAWN_SETTINGS,
  name: str('N', 'project name'),
  goal: str('G', 'one-line goal'),
  repo: str('O/R', 'GitHub repository (default: from the origin remote)'),
  base: str('B', 'base branch for task branches (default: the current branch)'),
  workers: int('N', 'worker slots held by live leases, unclaimed spawns or interrupted supervisors still stopping (default 6)'),
  'lease-minutes': int('MIN', 'default claim lease (default 60)'),
  'tasks-max': int('N', 'operational (orchestrator or owner): processes/threads per agent or gate, descendants included; default sized from host, slice and role'),
  'memory-max-bytes': int('N', 'operational (orchestrator or owner): bytes per agent or gate, descendants included; default sized from host, slice and role'),
  paused: str('REASON', 'pause new claims and dispatches with a reason; empty resumes'),
  'budget-hours': { ...num('H|null', 'hours budget; null removes the limit'), nullable: true },
  'budget-tokens': { ...int('N|null', 'token budget; null removes the limit'), nullable: true },
  standards: str('S', '"default" or a path to a standards Markdown file'),
  'tests-cmd': str('CMD', 'operational (orchestrator or owner): pin the test command; null clears it'),
  'clean-cmd': str('CMD', 'operational (orchestrator or owner): pin the cleanup command prefix; null clears it'),
  'tests-proof-cmd': str('CMD', 'operational (orchestrator or owner): pin the scoped proof template with {tests}; null clears it'),
  executors: int('N', 'operational (orchestrator or owner): automation executors running gates at once on this host (default 2)'),
  'tests-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per test command (default 20); null restores default'),
  'clean-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per cleanup command (default 20); null restores default'),
  'host-probe-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per host probe (default 10); null restores default'),
  'rework-hold-min': str('MIN', 'operational (orchestrator or owner): minutes automatic refill waits after an automatic gate rework that gates retry --from-rework can still undo (default 5, 0 disables); null restores default'),
  'tmp-root': str('DIR', 'operational (orchestrator or owner): absolute directory where check tests, check ci and check clean build worktrees and scratch (default tc/g under the user cache directory, not the OS temp directory; TOWER_CRANE_TMP overrides it); null restores default'),
  'tests-paths': str('JSON', 'operational (orchestrator or owner): non-empty array of test path globs; null restores default layouts'),
  'tests-keep': str('JSON', 'operational (orchestrator or owner): extra build file globs to keep at submitted sha; [] or null restores defaults'),
  'tests-host-only': str('JSON', 'operational (orchestrator or owner): test file globs a sandboxed worker cannot run, listed in its brief; the tests gate runs them on the host; [] or null clears them'),
  'tests-host-env': str('JSON', 'operational (orchestrator or owner): environment names to string values applied only to host-only gate runs; {} or null clears them'),
  'tests-mode': str('MODE', 'operational (orchestrator or owner): prove, run-only or none; null restores prove'),
  'tests-by-kind': str('JSON', 'operational (orchestrator or owner): task kind to tests mode overrides; null clears overrides'),
  'tests-map': str('JSON', 'operational (orchestrator or owner): source path or glob to test file arrays; null clears the map'),
  'tests-expensive': str('JSON', 'operational (orchestrator or owner): true selects the head suites with scoped proof; false or null restores normal proof'),
  'ci-ignore-apps': str('JSON', 'array of GitHub app slugs to skip; [] or null clears the list'),
  'ci-required': str('JSON', 'array of required check-run names or prefixes; [] or null clears the list'),
  'ci-capped-review': str('JSON', 'array of {app, pattern}: a matching check run of that app is a nonblocking capped review; [] or null clears the list'),
  'ci-local': str('JSON', 'local CI {command: argv, timeout: seconds, by_kind?: overrides}; null restores hosted CI'),
  'ci-dispatch': str('JSON', 'ci dispatch {workflow?: file name or id, per_hour?: N}; null restores the PR workflow and 4 per hour'),
  'merge-keep-branch': str('JSON', 'true keeps remote merged task branches; false or null restores deletion; stale local worktrees and branches still retire'),
  'session-bus': str('JSON', 'owner-required: true lets claude worker sandboxes reach the user session bus, which lifts their confinement; false turns it off (docs/state.md#projectjson)'),
  'merge-admin': str('JSON', 'owner-required: true uses gh --admin for solely owned repos; false or null disables it'),
  'decision-delegation': str('JSON', 'owner only: {"orchestrator_technical": false} keeps technical decisions with the owner; the default is true; null clears'),
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
  fallbacks: str('JSON', 'personal ordered fallback routes in the user file; edit separately from primary fields'),
  clear: many('FIELD', 'remove a field from the rung (a cleared harness follows the default)'),
};

const run = (mod, fn) => (ctx) => require(mod)[fn](ctx);
const gate = (name) => (ctx) => require('../lib/check').runGate(ctx, name);

const COMMANDS = [
  { section: 'Run', name: 'accept', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD] [--waive TYPE --reason R]', summary: 'rework a current failed review unless its findings are all in the PR body; otherwise run missing or stale software gates, dispatch review when green and accept when all gates pass', flags: { cmd: str('CMD', 'must match the pinned gates.tests_cmd'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd'), waive: many('TYPE', 'waive tests, clean, sources, review or ci: review is operational (orchestrator or owner), the rest owner-required'), reason: str('R', 'why the waived gate does not apply') }, description: "a current independent failed review sends the task through `rework --from-review` and exits 1, unless every finding is a false claim in the PR body; otherwise run missing or stale software gates first. Tests and clean use pinned project commands. Optional `--cmd` and `--proof-cmd` must match their pins; none mode needs no test command. When they pass and review is missing, dispatch it and return `review_pending: true` while keeping the task submitted. For a PR-body-only failure, automation dispatches a worker restricted to editing the body, then requests a light claim check after verifying the body changed and the head stayed fixed. Two consecutive failed automatic light checks at that head stop the loop with `review_body_stuck` in inbox. Explicit `accept` can request another light check after correction. Call again after review evidence arrives to accept. Current successful receipts are reused; stale successful receipts run again under the host governor. Current failures or unaudited attempted receipts require an explicit gate rerun. Review is checked separately from software gates. A tests, clean or local CI run already live at the same head and revision, started by automation or another command, is joined: `accept` waits for its evidence instead of starting a second run. A gate the host governor defers or stops exits 3 with its reason, records no evidence and accepts nothing; run `accept` again once there is room. `--waive review` is operational when the reviewer is capped or down at the submitted head (a capped review run in its `check ci` evidence, or a review spawn that exited without a verdict) and owner-required otherwise; waiving tests, clean, sources or ci is owner-required", run: T.accept },

  { section: 'Decisions', name: 'answer', pos: ['DID'], usage: 'DID --choice C [--note T]', summary: 'answer under owner or owner-set delegation', flags: { choice: str('C', 'the chosen option'), note: str('T', 'context') }, required: ['choice'], description: "answer it as the owner with explicit identity, as an agent the owner named on the decision (`decision delegate --answerers`), or as the orchestrator for a technical decision unless the project's `decision-delegation` setting is false. Anyone else exits 1 naming who can answer. A decision that escalates an owner-required setting, carries `--owner-required`, or has a kind other than technical is answered by the owner only. One-use setting approvals offer `approve` and `decline`. The answer event records `answered_by` and `answer_rule` (`owner`, `owner-named-agent` or `owner-technical-delegation`). `C` must be one of the options when there are any; an answered decision stays answered", run: D.answer },

  { section: 'Decisions', name: 'ask', usage: '(--question Q --kind K [--crisis CLASS] --option A --option B [--recommend A] [--why W] [--blocks ID]... [--setting KEY]... [--owner-required REASON] | --setting S [--change JSON])', summary: 'open a question or a one-use setting approval; prints its id', flags: { question: str('Q', 'the question'), kind: str('K', 'technical, spend, credential, setting or crisis: what the question is; only technical goes to the orchestrator'), crisis: str('CLASS', 'with --kind crisis: host, data, security or artifact; the owner is told at once'), option: many('A', 'an allowed answer; repeat'), recommend: str('A', 'the recommended option'), why: str('W', 'the reasoning'), blocks: many('ID', 'a task that waits for the answer; repeat'), setting: many('KEY', 'authority-table setting: repeat to tag a question, or name one without --question to request approval'), 'owner-required': str('REASON', 'the owner must decide: another call only the owner makes'), change: str('JSON', 'without --question: what exactly would change, shown to the owner') }, description: "with `--question`, open a decision; prints its id. `--kind` is required and says what the question is: `technical` goes to the orchestrator unless the project's decision-delegation setting is false, while `spend`, `credential`, `setting` and `crisis` stay with the owner. A question also stays with the owner when it names an owner-required setting or carries `--owner-required REASON` (another call only the owner makes). The asker picks the kind; the question text is not read. `credential` needs a `--setting` that grants a credential or loosens a sandbox (`env`, `env_file`, `sandbox`, `sandbox.session_bus`, `scope`, `ladder.reach`, `ladder.web_mcp`). `crisis` needs `--crisis host|data|security|artifact` and sends the owner a message. A worker's or reviewer's question that blocks a task whose latest tests failure also fails on main goes to the orchestrator whatever its kind, unless it is `spend` or `crisis` or names an owner-required setting other than a gate waiver; the output names the route. With the owner's publish policy set, the orchestrator's `--setting publish --change '{\"task\":\"T<n>\"}'` exits 0 without a decision while the policy's conditions hold for that accepted task. `--setting KEY` tags the question; an owner-required tag makes it owner-only. Answering a tagged question never authorizes a setting command. Without `--question`, `--setting S [--change JSON]` requests a one-use approval for an owner-required change no command makes, such as `publish`: exit 1 opens or reuses its decision; after owner approval, the identical request applies it once, records the setting audit and exits 0. Command-changed settings must be requested through their command; operational settings need no approval. `--change` cannot be combined with `--question`", run: D.ask },

  { section: 'Plan', name: 'authority', summary: 'list every guarded setting, its class (operational, owner-required or refused) and the command that changes it', description: 'list every guarded setting with its class (`operational`, `owner-required` or `refused`) and the command that changes it; `--json` gives `[{ setting, class, how }]`, the list the board reads', run: run('../lib/authority', 'show') },

  { section: 'Views', name: 'bench gates', usage: '[--deslop-hits FILE] [--deslop-findings FILE] [--deslop-runs FILE] [--deslop-report FILE]', summary: 'label every software gate result from the event log and report precision and recall per gate, and per deslop check from its eval files', flags: { 'deslop-hits': str('FILE', 'JSONL of detector hits with hand verdicts'), 'deslop-findings': str('FILE', 'JSONL of reviewer-found defects with reviewed_commit and example'), 'deslop-runs': str('FILE', 'JSON of detector output keyed repo#pr@commit; needs --deslop-findings'), 'deslop-report': str('FILE', 'detector report JSON with confirmed findings and dismissed items') }, description: "label every tests, clean, sources, ci and merge gate run in the event log and report per gate: runs, distinct results (one per gate, sha and outcome), true and false positives and negatives, open results, noncode CI fails (no failed hosted check or confirmed local execution; scored as neither), precision, recall and recall against failed CI check runs only (`-` for ci and merge). Failed CI runs are split by reason and by failing check run, deduplicated per task, sha and check name across all polls. Local CI executions use their confirmed failure and exit receipts. The deslop flags add per-check precision and recall from the detector's eval files; `--deslop-runs` needs `--deslop-findings`. Tables normalize unambiguous SHA prefixes of at least seven characters to the longest recorded spelling for that task, ignoring case. JSON output includes every labeled run with its original SHA", run: run('../lib/bench-gates', 'benchGates') },

  { section: 'Views', name: 'bench tokens', usage: '[--prices FILE]', summary: 'tokens and priced cost per accepted task, by rung and by escalation path, from spend records', flags: { prices: str('FILE', 'model price table JSON, same shape as review.prices (default: the project review.prices)') }, description: "tokens per accepted task from spend entries: overall, by escalation path (the task's worker rungs in order, repeats collapsed) and by rung, as medians and means with fresh input, cache reads and output split. Missing category totals are null and excluded from that category median. USD uses recorded `cost_usd`, else `--prices` (the `review.prices` shape), else the project `review.prices`, matched first on the exact configured model id, then on the canonical model identity (the Claude provider prefix, 1M suffix and Bedrock version suffix dropped); a run on several models prices each model's own counts. Metered USD is the api-billed part (including Codex Bedrock providers resolved from profile/config), reported beside the list-price equivalent; unknown billing counts only toward list price; unpriced entries are listed by model. Tasks with unknown token entries, unfinalized live usage or spawned sessions missing usage are excluded from all medians and means; recorded live tokens still count in the overall spend total. JSON names missing sessions in `missing_spawns`", run: run('../lib/bench-tokens', 'benchTokens') },

  { section: 'Plan', name: 'brief get', pos: ['ID'], usage: 'ID [--role worker|reviewer]', summary: "print the full or role-filtered task brief", flags: { role: str('ROLE', 'select worker or reviewer text; otherwise infer from the agent name') }, description: "write or read the task's brief; `brief get` filters for the caller's worker or reviewer role, and `brief set` warns about a reviewer section without a worker section", run: T.briefGet },

  { section: 'Plan', name: 'brief set', pos: ['ID', '[-]'], usage: 'ID (--file F | -)', summary: "write the task's brief; warn when reviewer text has no worker section", flags: { file: str('F', 'read the brief from F') }, description: "write the task's brief; changing it after the first submission bumps `revision` and invalidates earlier evidence. An accepted task requires `rework` before its brief can change. Identical writes keep the revision. Warns about a reviewer section without a worker section", run: T.briefSet },

  { section: 'Plan', name: 'browser-kit set', usage: '--servers JSON', summary: 'owner-required: save the browser kit server list in the user configuration', flags: { servers: str('JSON', 'MCP server names; [] disables the kit') }, required: ['servers'], description: "owner-required: save the kit server list in the user file (`TOWER_CRANE_CONFIG`, else the original user's `~/.config/tower-crane/config.json`). Names are deduplicated; `[]` disables automatic server attachment. Other user settings are preserved", run: run('../lib/browser-kit', 'set') },

  { section: 'Plan', name: 'browser-kit show', summary: 'show the user browser kit MCP server list (default playwright)', description: "show the user's browser kit MCP server list, default `[\"playwright\"]`, and its config file", run: run('../lib/browser-kit', 'show') },

  { section: 'Gates', name: 'check ci', pos: ['ID'], usage: 'ID', summary: 'configured local CI on the merged tree, or GitHub checks on the submitted sha; records ci', description: "for a recorded hotfix, check successful push workflows on its recorded base at the merge commit; when its push run was cancelled or never ran, the first successful push, scheduled or manual run of the same workflows at that commit or a later base commit that contains it stands for it, and `hotfix_ci` names that commit and run. A failure there that an earlier base run had the same way (the same tests in the same job with the same first error line: `main_red`, recorded in `hotfix_ci.failure` with the parent run) waits the same way; any other failure is confirmed. Otherwise with `ci.local`, resolve task override, kind mapping or default, run its argv against the merged base and submitted head and record a local receipt, joining a live local CI run at the same head and revision instead of starting another; the host governor admits a local CI run first, and a deferral or a stop mid-run exits 3 and records no evidence ([Gates](#gates)); without local CI, verify the PR head and mergeability. Require `ci.required` runs to be present and successful on the submitted sha, require at least one run outside `ci.ignore_apps` and `ci.capped_review` exceptions and all remaining checks green; records `ci`", run: gate('ci') },

  { section: 'Gates', name: 'check clean', pos: ['ID'], usage: 'ID [--cmd CMD]', flags: { cmd: str('CMD', 'must match pinned gates.clean_cmd; omit to use it') }, summary: 'cleanup tool on the task branch against base reports no HIGH finding; records clean', description: "run pinned `gates.clean_cmd` at the submitted commit against `base` (the recorded first parent for hotfixes); records `clean`, ok when every check ran and none reported a HIGH finding in the change (a report without diff scope is cut to the changed lines); timeouts record infrastructure failure. A live clean run at the same head and revision is joined, not repeated. The host governor admits the run first: a deferral or a stop mid-run exits 3 and records no evidence ([Gates](#gates))", run: gate('clean') },

  { section: 'Gates', name: 'check sources', pos: ['ID'], usage: 'ID', summary: 'fetch distinct cited pages and verify every quoted claim in research/ID.json at submitted sha; records sources', description: "fetch the distinct cited pages from committed `research/ID.json` and verify every quote; records sources evidence; required for research kind on every tier", run: gate('sources') },

  { section: 'Gates', name: 'check tests', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD]', summary: 'check tests under the project and task kind mode; records tests', flags: { cmd: str('CMD', 'must match pinned gates.tests_cmd; omit to use it'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd for changed test paths') }, description: "use `tests.by_kind` over `tests.mode` (default `prove`); `prove` requires pinned `gates.tests_cmd` to pass at head and fail after reverting other changes, with T8 build-file keeps; expensive proof runs mapped head suites when `tests.map` and full-suite `ci.required` are pinned, falls back to CMD for unmapped sources, and uses a scoped `{tests}` command at head and after reversion; `run-only` requires the pinned command to pass once at head; `none` verifies the submitted commit without running CMD; records `tests`, resolved `tests_mode`, and failed test names plus a bounded output tail when its command fails; timeouts record infrastructure failure and interrupted files instead. A live tests run at the same head and revision is joined, not repeated. The host governor admits the run first: a deferral or a stop mid-run exits 3 and records no evidence ([Gates](#gates)). After the head suite passes, run declared `host_probes` at the submitted sha before proof reversion; none mode still runs probes. Record status, duration and a redacted output tail in `receipt.host_probes`, included in reviewer gate results. A normal nonzero exit or timed-out probe fails the gate as a worker failure. Other signal, resource-cap or wait-shutdown interruptions are runner crashes and get one automation retry before rework. Hotfix proof compares the merge commit with its recorded first parent", run: gate('tests') },

  { section: 'Views', name: 'ci alerts', usage: '[--task ID] [--json]', summary: "open code-scanning alerts on the task's PR head: number, rule, severity, path:line and message", description: "list the open code-scanning alerts on the task's submitted PR at `refs/pull/N/head`; `--task` defaults to TOWER_CRANE_TASK, so a worker reads its own PR through the state broker", flags: { task: str('ID', 'task (default TOWER_CRANE_TASK)') }, run: run('../lib/ci-feedback', 'alerts') },

  { section: 'Views', name: 'ci checks', pos: ['[ID]'], usage: '[ID] [--task ID] [--json]', summary: "non-green check output, annotations, open code-scanning alerts and revuto inline findings at the task's current PR head", flags: { task: str('ID', 'task (default TOWER_CRANE_TASK)') }, description: "resolve the task's current PR from its recorded number or branch, including before submit, and list every non-green check run with title, summary and annotations. Runs matching `ci.ignore_apps` or completed failed reviews matching `ci.capped_review` are marked nonblocking with the policy reason; superseded review rounds, reruns and replaced workflows stay visible as nonblocking using the CI gate's judgment. These exceptions do not satisfy `ci.required`. List open code-scanning alerts with rule, path:line and message on the PR head and its verified current merge commit, excluding stale analyses. Alert fetch errors are explicit and leave check output visible. List every open revuto inline finding with path:line, numeric comment id and body; JSON carries them in `findings`. A failed finding read is explicit as `findings_error`, with `findings: null`. Show the task's latest `ci dispatch` run with its jobs and, once it completed, each failing job's failing tests, parsed as the CI gate parses runner logs; dispatched runs are not listed among the PR checks. JSON carries it in `dispatch`, null without one, and a failed read as `dispatch_error`. ID or `--task` defaults to TOWER_CRANE_TASK. Workers use the state broker for their own task, without calling `gh api`", run: run('../lib/ci-feedback', 'checks') },

  { section: 'Run', name: 'ci completed', pos: ['ID'], usage: 'ID --sha SHA', summary: 'handle a CI completion notification; query CI again and advance green tasks', flags: { sha: str('SHA', 'completed submitted commit; stale heads are refused') }, required: ['sha'], description: "orchestrator or owner: deliver a CI completion hint for an active submitted head, rerun the CI gate and advance passing tasks", run: run('../lib/automation', 'ciCompleted') },

  { section: 'Run', name: 'ci dispatch', pos: ['[ID]'], usage: '[ID] [--task ID]', summary: "run the repository's CI workflow (workflow_dispatch) on the task's branch at its head and record the run; ci checks shows its jobs and failing tests", flags: { task: str('ID', 'task (default TOWER_CRANE_TASK)') }, description: "dispatch the CI workflow on the task's branch at its current GitHub head and record the run id in the task's `ci_dispatches`. The workflow is `ci.dispatch.workflow`, else the one workflow of the PR's `pull_request` runs. Refused while a dispatched run at the same head has not completed, and past `ci.dispatch.per_hour` dispatches (default 4) for the task in the last hour. Only the orchestrator, the owner, or the agent that claimed or submitted the task dispatches; a sandboxed worker dispatches its own task through the state broker. `ci checks` shows the latest dispatched run's jobs and, once it completes, each failing job's failing tests; the CI gate and submit set dispatched runs aside, so they never count for or against the PR's checks. ID or `--task` defaults to TOWER_CRANE_TASK", run: run('../lib/ci-dispatch', 'dispatch') },

  { section: 'Views', name: 'ci log', pos: ['JOB_ID'], usage: 'JOB_ID [--failed-tests] [--task ID]', summary: "one CI job's log from the task's PR head, written under the task scratch while the run is still going; --failed-tests names the failing tests", flags: { 'failed-tests': bool('also name each failing test and its first error line'), task: str('ID', 'task (default TOWER_CRANE_TASK)') }, description: "fetch the log of job JOB_ID with `gh api repos/R/actions/jobs/JOB_ID/logs` while its run is still going, strip ANSI escapes, write it to `ci-job-JOB_ID.log` in the task scratch and print the path. The job must run on the task's branch head, the PR head the worker pushes, so a job of another branch or an older head is refused. `--failed-tests` also prints each failing test name with its first error line, from node --test (TAP and spec), go test and pytest output. `--task` defaults to TOWER_CRANE_TASK, so a worker reads its own PR through the state broker instead of waiting for the run to finish", run: run('../lib/ci-feedback', 'log') },

  { section: 'Run', name: 'ci resolve', pos: ['COMMENT_ID'], usage: 'COMMENT_ID --reason TEXT [--task ID]', summary: "mark a revuto finding on the task's PR resolved with a [resolved] reply; find COMMENT_ID beside path:line in ci checks, rework prompts or submit reports", flags: { reason: str('TEXT', 'how the finding was fixed, or why it does not apply'), task: str('ID', 'task (default TOWER_CRANE_TASK)') }, required: ['reason'], description: "post a reply whose first line is `[resolved]` and whose next lines are `--reason` on revuto's open inline finding COMMENT_ID on the task's PR, then record `ci resolve`. Find COMMENT_ID next to path:line as `(comment ID)` in `ci checks ID`, the rework worker prompt or the submit report. The reason is at most 1000 characters; each `@` in it gets a zero-width joiner so it mentions no one, and the reply ends with `by worker AGENT`, or `by AGENT` for the orchestrator or the owner. The comment must be a top-level revuto finding GitHub still anchors to a line. The next review dispatch reads the reply, and a review held at the task's head is dispatched again. `--task` defaults to TOWER_CRANE_TASK, so a worker resolves a finding on its own PR through the state broker", run: run('../lib/ci-feedback', 'resolve') },

  { section: 'Run', name: 'ci webhook', pos: ['FILE'], usage: 'FILE', summary: 'handle completed GitHub check_run, check_suite or workflow_run JSON; - reads stdin', description: "orchestrator or owner: deliver completed GitHub `check_run`, `check_suite` or `workflow_run` JSON; `-` reads stdin. Repository must match. Stale heads and incomplete checks are ignored", run: run('../lib/automation', 'ciWebhook') },

  { section: 'Run', name: 'claim', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'take a ready task for --agent', flags: { lease: int('MIN', 'lease length (default limits.lease_minutes)') }, description: "take a ready task for `--agent`; repeating it as the live claimant renews the lease. Refused if another agent holds it, the task is not ready, a resource lock is held, or the workers limit is reached (live leases and unclaimed worker spawns); consumes that agent's reservation for this task", run: T.claim },

  { section: 'Decisions', name: 'decision delegate', pos: ['DID'], usage: 'DID [--answerers JSON] [--technical JSON]', summary: 'owner-required: set named answerers or mark a decision technical', flags: { answerers: str('JSON', 'owner-named agents; [] clears the list'), technical: str('JSON', 'true or false') }, description: "owner-required: set the agents that may answer the decision (`--answerers`, a JSON array; `[]` clears it) or mark it technical (`--technical true|false`). A technical decision is the orchestrator's to answer unless the project's `decision-delegation` setting is false; `--technical false` keeps one with the owner. `--technical true` also lifts a spend, credential or setting kind and an `--owner-required` reason; an escalated setting is never lifted, and a decision that keeps an owner-only kind or reason cannot name answerers. The orchestrator's request opens a one-use owner approval for that decision and those values; rerun after approval. Owner and approved orchestrator writes use the shared setting audit. At least one field is required; a closed decision cannot be delegated again", run: D.delegate },

  { section: 'Decisions', name: 'decision note', pos: ['DID', 'TEXT...'], usage: 'DID TEXT', summary: 'append a comment on a decision', description: "append a comment; an explicit owner comment wakes the orchestrator and tasks blocked by the decision", run: D.comment },

  { section: 'Decisions', name: 'decision withdraw', pos: ['DID'], usage: 'DID --reason R', summary: 'asker or owner: withdraw an unanswered decision as moot', flags: { reason: str('R', 'why it no longer needs an answer') }, required: ['reason'], description: "close an open decision that no longer needs an answer. The agent that opened it or the owner can withdraw it; no owner answer is needed. Refused once answered or withdrawn. The decision leaves the open list and stays in history; the event records the reason, and each task it blocked gets the reason in its notes", run: D.withdraw },

  { section: 'Decisions', name: 'decisions', usage: '[--open]', summary: 'list decisions', flags: { open: bool('only open ones') }, description: "list", run: D.list },

  { section: 'Run', name: 'event', pos: ['ID'], usage: 'ID', summary: 'print one event with its detail, as a wake line names it', run: run('../lib/events', 'show') },

  { section: 'Run', name: 'evidence', pos: ['ID'], usage: 'ID --type T (--ok | --fail) [--sha S] [--revision N] [--summary T] [--ref URL] [--findings JSON]', summary: 'record review or note evidence; review needs --sha, note defaults to the submitted sha', flags: { type: str('T', 'review or note; tests, clean, sources, ci and merge require gate commands'), ok: bool('it passed'), fail: bool('it failed'), sha: str('S', 'commit the evidence is about; required for review'), revision: int('N', 'task revision the evidence is about; required for review from a reviewer spawn did not start'), summary: str('T', 'one line'), ref: str('URL', 'link to the run, review or log'), findings: str('JSON', 'every blocking finding as {kind, path, claim}; failed reviews only') }, required: ['type'], description: "record `review` or `note` evidence; `review` requires `--sha`, while `note` defaults to the task's submitted sha. `--revision N` names the task revision the evidence is about and is refused above the current revision; review evidence from a reviewer that `spawn` did not start requires it, and a spawned reviewer's verdict keeps its dispatch revision. `--findings JSON` on a failed review records every blocker as `{kind, path, claim}`; only `false-claim` blockers confined to `PR body`, `CHANGELOG.md` or `changelog.d/*.md` get a light correction check without rework. Missing or mixed metadata keeps the full review path. Refuses `tests`, `clean`, `sources`, `ci` and `merge` for every agent and either verdict; use the gate commands", run: T.evidence },

  { section: 'Gates', name: 'gates prioritize', pos: ['ID'], usage: 'ID --reason R', summary: "prioritize a task's queued gate work after accepted merges", flags: { reason: str('R', 'why the task goes first; kept on the event and shown in status') }, required: ['reason'], description: "operational (orchestrator or owner): move the task's queued submitted gate reactions ahead of older submitted work. Accepted merges always run first in acceptance order, including their merged-tree tests; requests cannot change that order. Several requests run newest first among submitted work. Only the work queued when the request is made moves; a notification queued later keeps its place unless its task becomes accepted, and a running reaction is not queued work. Refused for an accepted task, whose merge already runs first, and when nothing is queued for the task. Logs a `gates prioritize` event with the reason; `status` and `inbox` show the gate queue", run: run('../lib/automation', 'prioritize') },

  { section: 'Gates', name: 'gates retry', pos: ['ID'], usage: 'ID [--from-rework]', summary: 'orchestrator or owner: rerun each failed software gate at the submitted head, at unchanged inputs; --from-rework undoes an automatic gate rework', flags: { 'from-rework': bool('restore a task that automation sent to rework for a failed tests, clean or ci gate, then rerun that gate') }, description: "orchestrator or owner: rerun each failed `tests`, `clean`, `sources` or `ci` gate of a submitted task at its current head and revision, with the same pinned commands and policy. Use it after a later fix removed the environment problem behind a failed gate, such as a pinned command the orchestrator has now set. Automation retries an infrastructure failure once, including a test that also fails on the base branch, and sends any other failed check to rework; a host-only test the base fails with the same error stays submitted after its retry and reruns when the base moves; a missing pinned command stays submitted until the orchestrator pins it, and this reruns the gate. Passing evidence whose inputs changed, such as the pinned command or tests policy, reruns on its own. A gate already running at the same head and revision is joined, not repeated. Refuses a task that is not submitted and one with no failed software gate. Exits 1 while a retried gate still fails. Run `accept` afterwards to continue. `--from-rework` takes a task that automation sent to rework for a failed `tests`, `clean` or `ci` gate, after the cause outside the code is fixed (such as `project set --tmp-root`): it returns the task to submitted at the revision it was submitted at, so that revision's evidence counts again and the rework revision is retired, then reruns the failed gates and settles them as automation would. A gate that still fails sends the task back to rework at a new revision and exits 1. It refuses when the rework came from a review or a person, the revision changed since (acceptance, dependencies or brief), the kind changed since, a worker claimed or submitted it since, a quality climb is pending, or the PR or local branch head moved; the head is checked again after it takes the task's reaction slot. Automatic refill waits `gates.rework_hold_min` minutes (default 5) after such a rework so this can run first", run: run('../lib/automation', 'gatesRetry') },

  { section: 'Run', name: 'hook', pos: ['ACTION'], usage: 'ACTION --binding FILE [--payload JSON|-]', summary: 'deliver harness messages and record activity under the home identity', flags: { binding: str('FILE', 'protected hook binding in the agent home'), payload: str('JSON|-', 'harness event data (- reads stdin)') }, required: ['binding'], run: run('../lib/harness-hooks', 'hook') },

  { section: 'Run', name: 'hotfix', pos: ['ID'], usage: 'ID --pr N [--sha SHA] [--review URL] [--reason R]', summary: 'record an already-merged PR for gates and independent review at its merge commit', flags: { pr: int('N', 'already-merged PR number'), sha: str('SHA', 'merge commit (default: the PR merge commit)'), review: str('URL', 'clean-context review already posted on the PR: comment URL or id'), reason: str('R', 'why a cancelled hotfix\'s follow-up was a false failure (re-record only)') }, required: ['pr'], description: "orchestrator or owner: verify the PR merged into the project base (at SHA when given, else its merge commit), record its merge and first parent (squash or merge-commit merges only; a multi-commit rebase merge is refused), and move the task (todo, rework, submitted or cancelled, without a claim) to submitted with a new revision. `--review` takes the exact PR comment URL or id of a review by an OWNER, MEMBER or COLLABORATOR, whose first line is `Review (native, clean context)` or `Review (Tower Crane, clean context)`, whose `SHA:` is the merged PR head, and whose `Verdict: pass|fail` line or `Blocking findings` section decides it; it is recorded as review evidence at the merge commit. Run `accept ID` to check tests, clean and push CI at that merge commit, dispatch independent review of the landed diff unless a posted review counts, accept, and confirm the merge as merge evidence without merging again. Every gate must pass, without waivers, except the owner's `--waive tests` for tests that also fail at the merge's first parent. Acceptance displays `accepted (hotfix)` and records that it merged before its gates. A confirmed software failure or failed review cancels the historical task and creates a separate rework task for a follow-up PR against the project base. When that failure was not the change's, recording the same PR again re-records the cancelled task: it returns to submitted at a new revision, and the follow-up is cancelled with `superseded_by` and `--reason` (owner-required when the follow-up has an owner ask). A follow-up that is claimed or has a branch, PR or commit is refused; one opened by a failed review needs the owner, and `--reason` on any other record is refused. Pending checks, infrastructure errors and tests whose every failing name also fails at the merge's first parent remain submitted for a gate retry with `check GATE ID`. An accepted hotfix refuses `rework`. Repeating the same record preserves receipts", run: run('../lib/hotfix', 'record') },

  { section: 'Views', name: 'inbox', usage: '[--ack ITEM]... [--ack-before TIME [--kind KIND]] [--json]', summary: 'actionable state and GitHub findings with resolving commands', flags: { ack: many('ITEM', 'acknowledge a handled inbox item; repeat for one atomic batch'), 'ack-before': str('TIME', 'acknowledge all matching items at or before this timestamp'), kind: str('KIND', 'with --ack-before: message, stall, decision_answer, owner_comment or review_exit_missing') }, description: "orchestrator or owner: read state once for current failed software gates and inspect PR heads, mergeability, uncapped revuto failures and inline comments, and open CodeQL alerts on the submitted head or its verified current PR merge commit. It also reads CI runs on the project base, at most once a minute: a failed or cancelled push, schedule or dispatch run that no later run of its workflow turned green is a `main_ci_failed` item with its failing jobs and test names, and a test that fails again after a green run is a `main_ci_flaky` item; both resolve by opening a task or naming the open one, and clear on a green run. A ready or rework task without a brief gets a `brief_missing` item, resolved by `brief set`, in place of its `ready` or `rework_ready` item. Work the host governor deferred or stopped is a `governor_deferred` or `governor_stopped` item with its reason; both clear on their own. Returns typed `items` with `action.command` and `action.argv`, plus live gate `executors`, the `gate_queue` in drain order, and `owner` with the closing owner line (`owner: nothing needed` unless a crisis is open or a decision or hold waits on the owner). Failed reviews include the full latest Tower Crane comment at the submitted SHA and `finding_count`; fetch errors remain explicit. Failed gates include their summary and test diagnostics; audited confirmed code failures resolve through rework, while pending checks and observation failures offer a gate rerun. Remotely merged accepted heads remain actionable with `merge --accepted` until their audited local merge receipt exists. Stale software gates on an open mergeable accepted PR resolve with `check GATE ID` before merge. GitHub failures are explicit items. `--ack ITEM` acknowledges a handled message, stall, decision answer, owner comment or missing review exit; repeat it to acknowledge several items in one locked write and one event. `--ack-before TIME` acknowledges every matching item at or before the timestamp, optionally filtered by `--kind`, in one locked write and one event with the count and cutoff. Task messages and decision answers older than 24 h disappear when their tasks are cancelled or accepted and merged; their history remains. Task and GitHub findings clear only when their condition clears", run: run('../lib/inbox', 'inbox') },

  { section: 'Plan', name: 'init', usage: '--name N --goal G [--repo O/R] [--base B] [settings]', summary: 'create the state directory and project.json with the default ladder', flags: SETTINGS, required: ['name', 'goal'], description: "create the state directory and `project.json` with the default harness and ladder (from the user file, else built in), and record its canonical `owner_config_dir`; takes the `project set` settings too. Only an explicit owner's init at a terminal records the user file's folder as `owner_config_dir`; any other init records the default `~/.config/tower-crane` under the account's home, where a headless owner's key must be. Only the explicit owner's init copies the rungs' owner-required parts (`sandbox`, `env`, `env_file`, `scope`, `command`, `web_mcp`, sandbox-changing tools, unsandboxed or command harnesses); any other init leaves them out with a `notice:` line each. Refused if the user file is invalid or the project already exists", run: P.init },

  { section: 'Run', name: 'interrupt', pos: ['ID'], usage: 'ID [--needs-owner REASON]', summary: 'owner or orchestrator: stop the supervisor and release the claim, keeping the revision and dirty worktree for resume', flags: { 'needs-owner': str('REASON', "also set the task's owner ask in the same write, so no dispatch resumes it until owner-done") }, description: "owner or orchestrator only: stop the live agent through its supervisor and release the claim to its prior `todo` or `rework`. The revision, branch, evidence and dirty worktree stay, so the next dispatch resumes the work (Codex warm resume, or a fresh Claude worker in the same worktree). `--needs-owner REASON` sets the owner ask in the write that releases the claim, so the task waits until `owner-done`; the event's `reason` and `needs_owner` carry REASON, and replacing a different ask is audited as `task.needs_owner`. The board's Stop sends it. Distinct from `rework`, which sends a submitted task back with a reason, and from a requirements edit, which bumps the revision", run: T.interrupt },

  { section: 'Plan', name: 'ladder harness', pos: ['HARNESS'], usage: 'HARNESS', summary: 'set the default harness every rung without its own runs on', description: "set the default harness; every rung without its own moves to it. Operational: the orchestrator or the owner; moving a worker, reviewer or small rung off a sandboxed harness is owner-required (`ladder.reach`). Refused, naming the rungs, if one of them cannot run there (a codex profile on pi, a missing model, a Claude model on codex without a custom provider, a tool the harness does not know). A personal fallback that follows a moved rung and names a model or tool the new harness cannot run gets a `notice:` line; spawn skips it", run: P.ladderHarness },

  { section: 'Plan', name: 'ladder save-user', summary: "write this project's ladder to the user file, the default for new projects", description: "write the project's default harness and primary rungs to the user file (`TOWER_CRANE_CONFIG`, else `~/.config/tower-crane/config.json`), preserving personal fallbacks and other keys; only what the project defines is written. Operational: the orchestrator or the owner, and the event records the orchestrator as `authority`. Refused while a primary rung cannot run. A user file that is not valid JSON or has the wrong shape refuses every command that has to resolve the ladder, including `ladder`, `spawn` and `init`, even when the project supplies every rung; the error names the file to fix or remove", run: P.ladderSaveUser },

  { section: 'Plan', name: 'ladder set', pos: ['RUNG'], usage: 'RUNG [--harness H] [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON] [--supervision JSON] [--tools JSON] [--mcp JSON] [--web-mcp JSON] [--fallbacks JSON] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON] [--clear FIELD]...', summary: 'change fields of one rung: orchestrator, easy, medium, hard, research, review or small', flags: RUNG_FLAGS, description: "change the named primary fields of one rung and keep the rest. `--fallbacks JSON` replaces its ordered personal routes in the user file; `[]` empties the list and `--clear fallbacks` removes the override. Edit fallbacks separately from project primary fields. Other personal settings and project primaries are preserved. Fallback edits use the same field, reach, tool and MCP authority checks as primary edits; owner approvals bind the user file, rung and full requested list. `--tools` (claude, codex, opencode, agy and pi) and `--mcp` (claude, codex and agy) opt the rung back in to tools and MCP servers its agent file leaves out. Pi refuses MCP opt-ins. Changes are operational, except `--command`, `--web-mcp`, `--sandbox`, `--env`, `--env_file` and `--scope`, which are owner-required ([Authority](state.md#authority)); so is moving a worker, reviewer or small rung off a sandboxed harness, or `--args` on an unsandboxed harness (`ladder.reach`). The orchestrator's `--tools` and `--mcp` take only harness built-ins that keep the sandbox and MCP servers the owner's harness config defines; `--args` on a claude, codex, opencode, agy or pi rung may hold only a short list of safe flags; `--web-mcp` sets the research Claude server as `{name, command, args}` without secrets; it cannot combine with `--mcp`. `--clear web_mcp` removes it. `--clear` removes a field (a cleared harness follows the default). Moving the rung to another harness drops the fields the edit does not name that do not fit there (a Claude model or alias on codex unless its codex route uses a custom provider, another vendor's model on claude, a profile, provider, effort, args, command, mcp or web_mcp the new harness does not take, and each tool name it does not know) and prints what it dropped; a field named in the same edit stays. A personal fallback that follows the rung and names a model or tool the new harness cannot run gets a `notice:` line; spawn skips it. A rung the project left out starts from the primary it fell back to. Refused if it leaves a primary unable to run that could run before (state.md lists the checks); rungs already broken do not block it", run: P.ladderSet },

  { section: 'Plan', name: 'ladder show', summary: 'print each rung as it resolves, and where it comes from (project, user file or built-in)', description: "print each rung as it resolves: harness (and whether it is the default), model, profile, provider, effort, args, and where the primary comes from (project, user file or built-in); print personal fallbacks and their user-file source (`fallbacks_from: \"user\"` under `--json`); also the default harness, its source, the user file path, and every rung or fallback that cannot run (`problems` under `--json`); unavailable fallbacks are marked skipped", run: P.ladderShow },

  { section: 'Run', name: 'mcp', summary: 'serve orchestrator inbox and actions as MCP tools over stdio', description: "start the newline-delimited JSON-RPC MCP server on stdin/stdout. Tools: `inbox` (optional `ack`), `spawn_ready`, `merge_accepted`, `rework_from_review` (`id`), and `release_dead`. Initialization and tool discovery work without a project; tool calls resolve the project and return missing-state or authorization errors as tool results. Calls retain the CLI process identity and state; there are no identity, state or shell overrides. Batch actions require the orchestrator or owner; all existing command checks and authority rules remain in force", run: run('../lib/mcp', 'serve') },

  { section: 'Gates', name: 'merge', pos: ['[ID]'], usage: '[ID | --accepted] [--subject S] [--body B] [--method M]', summary: "merge accepted PRs with passing gates; linked stacks use pinned merge commits and can complete partially", flags: { accepted: bool('drain the accepted merge queue through its current-base checks and stack gates'), subject: str('S', 'commit subject (default: task title)'), body: str('B', 'commit body (default: task acceptance lines; empty allowed)'), method: str('M', 'squash (ordinary default), merge or rebase; linked stacks use merge commits and rebase has no commit text options') }, description: "`--accepted` drains the accepted merge queue, refreshing stale tests, clean and CI through the governed gate runner before current-base head checks and linked stack gates; recorded tests, clean and CI failures are settled under automatic retry and rework rules; a confirmed failure at the accepted head and revision sends the task to rework instead of leaving it accepted for repeated skips; refused and pending entries are reported while independent mergeable entries continue. A head check's suite runs only once the host governor admits it: a deferral or a stop mid-run exits 3, records no head check and merges nothing, and a `wait` reaction retries it ([state](state.md#host-resource-governor)). An already merged PR at the accepted head is confirmed without rerunning gates or merging it again. Otherwise merge the task's PR with `--match-head-commit` when the task is accepted and its gates still pass for its current revision (refused otherwise). When GitHub refuses `gh pr merge` for a stack member no task records, a squash or merge retries through the asynchronous merge API at the accepted head with the same method and commit text, then deletes the head branch unless `merge.keep_branch` is set; with `merge.admin` set it refuses, since that API has no admin option. A rebase keeps the refusal. Linked stacks merge bottom up through GitHub's asynchronous merge API with merge commits, since GitHub refuses `gh pr merge` for a stack member; each request pins the accepted head with `expected_head_sha` and is polled until GitHub confirms it before the next member. If an upper member fails, the target reports `merge FAIL` while confirmed lower members retain successful merge evidence. Inspect each member with `task show ID` and check its PR state; fix the refusal or wait for queued merges to complete. Sync the idle remaining chain when needed with `stack sync ID`; changed heads need rework, a new submission, passing gates, review and acceptance. Refresh stale gates and retry `merge ID` on the target; confirmed lower members are skipped. Records `merge`; then retires the worktree and local branch, saving local commits and dirty work first. Running agents defer removal to their supervisor; failures remain stale in inbox ([state](state.md))", run: run('../lib/automation', 'merge') },

  { section: 'Run', name: 'msg', pos: ['TEXT...'], usage: '--to NAME [--task ID] [--steer] TEXT', summary: 'send a worker message through the event log', flags: { to: str('NAME', 'recipient, usually orchestrator'), task: str('ID', 'task (default TOWER_CRANE_TASK)'), steer: bool('deliver into the running turn where the harness can, not after it') }, required: ['to'], run: run('../lib/events', 'message') },

  { section: 'Run', name: 'orchestrator release', summary: 'release the calling orchestrator session lease', description: 'holding orchestrator session only: clear the lease so another session can write; refuses another session even when it uses the same agent name', run: run('../lib/orchestrator', 'release') },

  { section: 'Run', name: 'orchestrator takeover', summary: 'owner-only clear the orchestrator lease for a new session', description: 'owner only: explicitly clear the orchestrator lease; the next orchestrator write acquires it. Records the previous holder', run: run('../lib/orchestrator', 'takeover') },

  { section: 'Run', name: 'owner-done', pos: ['ID'], usage: 'ID [--note T]', summary: 'the owner did what needs_owner asked; clears it', flags: { note: str('T', 'what was done') }, description: "the owner did what `needs_owner` asked; clears it. Operational: the orchestrator or the owner", run: T.ownerDone },

  { section: 'Run', name: 'owner-key', summary: 'owner only: create the owner key that stands in for a terminal; prints its path, never the key', description: "the owner, explicitly and at a terminal or with the current key, creates the key under the project's recorded `owner_config_dir` and prints `created PATH` or `exists PATH`; never prints the key. An unbound project requires a terminal owner to record the directory first. `TOWER_CRANE_OWNER_KEY` with its contents stands in for a terminal ([Agent identity](state.md#agent-identity))", run: run('../lib/authority', 'ownerKey') },

  { section: 'Plan', name: 'plan import', pos: ['FILE'], usage: 'FILE', summary: 'add tasks from a JSON array (ids may be local names, resolved in order; - reads stdin)', description: "add tasks from a JSON array of task objects (ids may be local names, resolved in order; `-` reads stdin). Fields: `id`, `title`, `acceptance`, `kind`, `needs`, `size`, `tier`, `depends_on`, `needs_owner`, `locks`, `environment`; `needs_owner` is trimmed and blank values store null. A dependency names an earlier entry or an existing task. Any bad entry refuses the whole file", run: T.planImport },

  { section: 'Plan', name: 'project set', usage: '[--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--tasks-max N] [--memory-max-bytes N] [--paused REASON] [--budget-hours H|null] [--budget-tokens N|null] [--standards S] [--tests-cmd CMD] [--clean-cmd CMD] [--tests-proof-cmd CMD] [--executors N] [--tests-timeout-min MIN] [--clean-timeout-min MIN] [--host-probe-timeout-min MIN] [--tmp-root DIR] [--rework-hold-min MIN] [--tests-paths JSON] [--tests-keep JSON] [--tests-host-only JSON] [--tests-host-env JSON] [--tests-mode MODE] [--tests-by-kind JSON] [--tests-expensive JSON] [--tests-map JSON] [--ci-ignore-apps JSON] [--ci-required JSON] [--ci-capped-review JSON] [--ci-local JSON] [--ci-dispatch JSON] [--merge-keep-branch JSON] [--merge-admin JSON] [--publish-policy JSON] [--review-policy JSON] [--governor JSON] [--research-min-sources N] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON] [--session-bus JSON]', summary: 'change project settings, limits and budget', flags: SETTINGS, description: "change settings, limits and budget; `--budget-hours null` and `--budget-tokens null` remove a limit through the owner-required budget-raise path", run: P.projectSet },

  { section: 'Plan', name: 'project show', summary: 'print project settings and the ladder', description: "print settings, including resolved agent, reviewer, orchestrator and gate `resources.tasks_max` and `resources.memory_max_bytes`, `gates.tests_cmd`, `gates.clean_cmd`, `gates.tests_proof_cmd`, `gates.executors`, `gates.tests_timeout_min`, `gates.clean_timeout_min`, `gates.host_probe_timeout_min`, `gates.tmp_root`, `gates.rework_hold_min`, `tests.paths`, `tests.keep`, `tests.host_only`, `tests.host_env`, `tests.mode`, `tests.by_kind`, `tests.expensive`, `tests.map`, `ci.ignore_apps`, `ci.required`, `ci.local`, `ci.dispatch`, `merge.keep_branch`, `merge.admin`, `decision_delegation.orchestrator_technical` and `governor`, and the resolved ladder", run: P.projectShow },

  { section: 'Run', name: 'ready', usage: '[--all]', summary: 'ready tasks, urgent first then those that unblock the most; --all adds blocked ones with the reason', flags: { all: bool('also list blocked tasks and why') }, description: "ready tasks in priority order (urgent first, then the ones that unblock the most work, then task id), excluding tasks whose locks another task holds, plus claims whose spawned process exited without submit and their log tails; `--all` lists blocked ones with the reason. Ready JSON includes `priority`, `locks` and `environment`", run: T.ready },

  { section: 'Run', name: 'recover', pos: ['ID'], usage: 'ID', summary: 'recover a ranged task after quality failure; climb or ask the owner at the top', description: 'ranged quality recovery: climb after a failed latest review or confirmed tests, clean or CI gate failure; dispatch fresh, retry a pending climb, or open an owner decision at the range top; wait for verified worker process-group cleanup before dispatch', run: run('../lib/escalation', 'recover') },

  { section: 'Run', name: 'release', pos: ['[ID]'], usage: 'ID --reason R [--pr N] | --dead', summary: 'give a claimed task back; it returns to todo or rework', flags: { reason: str('R', 'why'), pr: int('N', 'open pull request the claim opened, linked to the task'), dead: bool('release every claim verified exited, rechecking under the lock') }, description: "`--dead` recovers every claim the shared process detector verifies exited; remote or unobservable processes stay claimed. The worker broker refuses this unscoped batch; workers use `release ID --reason R` on their own task. Otherwise give it back; status returns to its prior `todo` or `rework`. `--pr N` links an open PR, checked as `submit` checks it, so the next worker resumes that PR. Its head branch must be the task's branch, except that a task with no branch, or one moving from a closed or merged PR to N, takes N's head branch. Linking a PR other than the one the task recorded drops its submitted sha, so the next dispatch resumes N's head from origin. A task linked to another open PR keeps that PR and refuses the release until it closes. The branch and PR link stay when the claim is released. A task released while an open decision blocks it can be sent back with `rework` from `todo`. The claimant or the owner (owner-required: the orchestrator's attempt opens a decision); any agent may recover a spawned claim verified exited by the shared detector under the lock. Preserves only pid, log path, exit code and log size in a note and the release event", run: T.release },

  { section: 'Views', name: 'render', summary: 'write sketch.md and sketch.html (self-contained, no network)', description: "write `sketch.md` (Mermaid graph plus tables) and `sketch.html`, the board as a read-only snapshot, from the state as it stands when the command starts; a sketch another process already published from later state is kept (`--json` `published: false`)", run: R.render },

  { section: 'Run', name: 'renew', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'extend your lease; an expired one only while the workers limit has room', flags: { lease: int('MIN', 'new lease length from now') }, description: "extend the lease from now; only the claimant. An expired lease must pass the claim checks again (unmet dependency, owner blocker, open decision, resource lock, workers limit), so a refused renewal leaves it expired", run: T.renew },

  { section: 'Run', name: 'rework', pos: ['[ID]'], usage: 'ID --reason R | --from-review ID', summary: "send back; the reason goes into the brief's rework notes", flags: { reason: str('R', 'what to fix'), 'from-review': str('ID', 'use the latest failed review at the current head and revision') }, description: "`--from-review ID` refuses failed reviews whose findings are all PR-body false claims, with correction and light-check instructions, leaving the revision unchanged. For other failures it fetches all issue-comment pages for the linked PR and selects the last `Review (Tower Crane` body at the submitted SHA, preserving every finding and its comment link in the reason. Unposted reviews use their evidence summary. A linked review that cannot be fetched or matched refuses without changing state; the head, revision and latest failed evidence are rechecked under the lock after fetching. Otherwise send a submitted or accepted task back and bump `revision`, invalidating earlier evidence even at the same sha, and a todo task whose latest release came while a decision blocked it, answered or not, goes back the same way; the reason is appended under `## Rework notes` in its brief and as a task note", run: T.rework },

  { section: 'Views', name: 'serve', usage: '[--port P]', summary: 'serve the sketch and a Settings view for the ladder and task tiers on 127.0.0.1; pages reload when the state changes', flags: { port: int('P', 'port (default 4747; 0 picks a free one)') }, description: "serve the live board and a Settings view on 127.0.0.1 (default port 4747; 0 picks a free one) and update open pages over server-sent events when the state changes. Pages are rendered from the state on each request. As the owner it also prints a one-time link to open in the browser that will write (`--json` prints `{ url, state, open }`; `open` is `url` for other identities). Exits 1 if the port is in use", run: run('../lib/serve', 'serve') },

  { section: 'Agents and worktrees', name: 'spawn', usage: '(--task ID | --ready) [--role RUNG] [--dry-run] [--wait]', summary: "start a rung's harness in the task's worktree (the task's tier unless --role names a rung); prints the pid, or the command with --dry-run", flags: { ready: bool('dispatch ready todo and rework tasks without a live worker within the worker limit'), task: str('ID', 'task id'), role: str('RUNG', "ladder rung, such as review (default: the task's tier)"), 'dry-run': bool('print the command instead of running it'), wait: bool('run in the foreground and exit with its code') }, description: "`--ready` dispatches ready todo and rework tasks without a live worker, serially within the worker limit. Each dispatch rechecks readiness and worker identity under the existing spawn lock. A real `--role review` dispatch with a current independent failed review sends the task through `rework --from-review` and exits 1; dry-run previews do not change state. Otherwise start a rung's harness in the task's worktree with the brief and task as the prompt: the rung of the task's tier, or the rung `--role` names (`--role review` for a review); sets `TOWER_CRANE_STATE`, `TOWER_CRANE_TASK`, `TOWER_CRANE_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command. A claude, codex, opencode, agy or pi rung runs under its role's agent file in a config home of its own (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` or agy HOME); `--dry-run` prints a `#` line naming the agent file, the home, the MCP servers and the opted-in tools, and `--json` adds them as `home`. Every `--dry-run` also prints a `# rules:` line with the house rules files, how each reaches the agent and their size, and the prompt size; `--json` adds them as `startup`, the same record the `startup` event keeps. Claude/Codex reviewers receive the role skill, house-rule contents, standards and review contract sections in system context, with task JSON, review brief, gate receipts and diff in the user message. Claude writes it to `system.md` in its home and passes `--append-system-prompt-file` and `--exclude-dynamic-system-prompt-sections`; Codex writes its generated `AGENTS.md`. Every Claude spawn sets `FORCE_PROMPT_CACHING_5M=1`. Claude/Codex reviewer startup receipts add `system_bytes` and `system_tokens`. The rung is resolved again from the state read under the lock, so a tier or ladder change made while spawn created the worktree is the one that runs. The agent's environment drops the dispatcher's `TOWER_CRANE_VIA`, `TOWER_CRANE_AUTOMATION_KEY_FD` and its `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID` and `CODEX_SESSION_ID`. A worker spawn in a repository without an `origin` remote is refused before any worktree or harness starts, since the worker pushes its branch and opens its PR there. The host governor admits each dispatch before any stack read, fetch or worktree and again just before the supervisor starts: a deferral exits 3 with `TASK: UNIT deferred by the host governor: REASON` and records nothing, and `--ready` stops its batch at the first deferral, marks that result `governor_deferred` and exits 1 ([state](state.md#host-resource-governor))", run: run('../lib/spawn', 'spawn') },

  { section: 'Run', name: 'spend', pos: ['ID'], usage: 'ID [--minutes N] [--tokens N] [--input N] [--cached N] [--cache-write N] [--output N] [--rung R] [--harness H] [--model M] [--from-spawn AGENT]', summary: 'record usage or collect an exited spawn once', flags: { minutes: int('N', 'minutes spent'), tokens: int('N', 'total tokens, including cached input'), input: int('N', 'input tokens, including cached input'), cached: int('N', 'cache read tokens (subset of input)'), output: int('N', 'output tokens, including reasoning'), rung: str('R', 'ladder rung for native usage'), harness: str('H', 'actual harness (default: rung harness)'), model: str('M', 'actual model (default: rung model)'), 'cache-write': int('N', 'cache write input tokens, included in --input and separate from --cached'), 'from-spawn': str('AGENT', 'collect an exited spawn from its captured log and session, once'), }, description: "add spend, with optional native-agent usage breakdown and metadata; rung defaults the harness, model and profile from the current ladder. Model IDs are trimmed and case-folded; provider prefixes remain distinct. Collect an exited spawn's captured usage once per route and fresh retry invocation; resumed retries share their session's cumulative usage. Retry a failed monitor or enrich an unknown/partial entry when telemetry arrives. Refuses a live process or an unknown spawn; cannot be mixed with manual spend", run: T.spend },

  { section: 'Agents and worktrees', name: 'stack link', pos: ['ID'], usage: 'ID', summary: 'link submitted dependency PRs bottom to top (automatic after spawned submissions)', description: "link a submitted task's dependency chain on GitHub, bottom to top", run: run('../lib/stack', 'link') },

  { section: 'Agents and worktrees', name: 'stack sync', pos: ['ID'], usage: 'ID', summary: 'refresh an idle stack with gh stack sync; changed heads or conflicts require rework', description: "import remote tracking with `gh stack checkout <pr> --print-path`, then run `gh stack sync` from the task worktree, without prompts", run: run('../lib/stack', 'sync') },

  { section: 'Agents and worktrees', name: 'stack unstack', pos: ['ID'], usage: 'ID', summary: 'disable a stack for ordinary merges; lower tasks must land first', description: "remove the GitHub stack and local tracking, confirm no member remains stacked, then use ordinary merges in dependency order", run: run('../lib/stack', 'unstack') },

  { section: 'Agents and worktrees', name: 'stack webhook', pos: ['FILE'], usage: 'FILE', summary: 'record a pull_request webhook stack object; - reads stdin', description: "ingest a trusted `pull_request` webhook payload for this project's repository; `-` reads stdin. Record `pull_request.stack` or the payload's top-level `stack` without changing acceptance or merge evidence", run: run('../lib/stack', 'webhook') },

  { section: 'Views', name: 'status', summary: 'one screen: counts, ready tasks, gate queue, open decisions, owner tasks, spend, expired leases, exited spawned claims', description: "one screen: counts by status, ready tasks (marked `no brief` when they have none; JSON `ready[].brief`), why automatic refill leaves a ready task undispatched (`not dispatched: T2 worker limit reached (3 of 3: T1, T4, T5)`, also `no brief`, `its gate reaction is running`, `rework hold until T`, `waits behind higher-ranked tasks for the N free worker slots`, `dispatch lock held by pid P` and `host governor deferred workers since T: REASON`; JSON `not_dispatched[]` with `id`, `reason` and, for a hold, `until`), the gate queue (running tasks, then queued tasks in the order executors take them, with any `gates prioritize` reason, then tasks blocked behind their own running reaction), the gate temporary root and what chose it, the host governor's reading, budget and this project's deferred and stopped work (`host governor: ...`, `governor deferred: ...`, `governor stopped: ...`; JSON `governor`; docs/state.md#host-resource-governor), blocked required gates when their test or cleanup command is unpinned, open decisions, owner tasks, the owner line (`owner: nothing needed`, a crisis, or what waits on the owner when convenient; JSON `owner`), spend against budget, live spend of running agents with its freshness (`live`, `stale` or `unavailable`; JSON `spend.live`), expired leases, runaway flags (`runaway: T1: task spend`, `runaway: T1 agent: worker rule`; JSON `runaways` and `runaway_norms`), claims whose spawned process exited without submit and their log tails, agent homes a stray process keeps after the agent exited (`home kept: AGENT by a stray process PID`; JSON `kept_homes`), and red CI runs on the base that `inbox` last recorded with their failing jobs and test names (`BASE ci red: ...`; JSON `main_ci_red`)", run: R.status },

  { section: 'Run', name: 'submit', pos: ['ID'], usage: 'ID --sha S [--branch B] [--pr N] [--summary T] [--precheck R] [--host-probe CMD]', summary: 'mark submitted as the claimant or replace a submitted head as its submitter', flags: { sha: str('S', 'commit to review'), branch: str('B', 'branch holding it'), pr: int('N', 'pull request number'), summary: str('T', 'what changed'), precheck: str('R', 'pre-submit checklist result: pass, fail or skipped'), 'host-probe': many('CMD', 'measurement or host check; repeatable, no input, run at submitted sha by the tests gate') }, required: ['sha'], description: "mark submitted as the claimant or replace a submitted head as its submitter. `S` is 7 to 64 hex characters. Repeat `--host-probe CMD` for measurements or kernel checks the sandbox cannot run. Each submission replaces `host_probes` (omitting it clears them); changing the list at the same commit advances the revision, invalidating old gate leases and verdicts, including failures. Commands run from the scratch worktree root at `S`, with no input, gate resource caps, `tests.host_env`, and `gates.host_probe_timeout_min` (default 10 minutes each). Normal nonzero exits and timeouts fail the tests gate and return output through rework. Signal, resource-cap and wait-shutdown interruptions get one automation retry before rework. Declare pending host results in the PR body and leave cleanup to the clean gate. For a task with a recorded PR (`--pr`, or the one already recorded), the PR's checks at `S` are read: a failing check refuses with the failing jobs and the first failing lines of their logs and points to `ci checks ID` for check output, annotations and current code-scanning alerts. Checks still running do not refuse: the head is recorded, the output names them, a task note records them, and `check ci` waits for them on the host; a failure there returns as rework with the same job names and log lines. Revuto's open inline findings are printed either way; a `[P1]`/`[P2]` finding already on the PR with no change at its path since the comment and no `[resolved]` reply refuses, as review ok would, and submit does not wait for findings still to come. Capped reviews (`ci.capped_review`) do not block. Where the agent's gh policy refuses `gh api`, submit prints that the head was not checked and goes ahead. Local CI (`ci.local`) and a project without a repo skip the check. For a task with a recorded PR, an open PR blocks changing its PR number or head branch. After it is closed or merged, a new PR supplies its head branch unless `--branch` is given and matches it. `--precheck` records the submitter's own review result at this head on the `submit` event; it never refuses or gates the submission. A head whose commits add an empty file named like a claude sandbox placeholder (`.bashrc`, `.claude/settings.json` and the other protected names it binds over) refuses; a real file by that name needs content", run: T.submit },

  { section: 'Plan', name: 'task add', usage: '--title T --acceptance A [--acceptance A2] [--kind K] [--needs JSON] [--size S] [--tier T] [--dep ID] [--lock NAME]... [--environment LABEL] [--needs-owner REASON] [--brief FILE]', summary: 'add a task; prints its id', flags: { ...TASK_FIELDS, brief: str('FILE', 'write the brief from FILE in the same command') }, required: ['title', 'acceptance'], description: "add a task; prints its id. `--brief FILE` writes the brief in the same command, so the task needs no `brief set` before spawn. A `needs_owner` reason is trimmed; a blank value stores null. `T` is `easy`, `medium`, `hard`, `research` or an ascending range such as `easy..medium`; without it the tier comes from kind and size (state.md). `--needs '[\"browser\"]'` declares browser capability. Refused for an unknown dependency or capability. Repeat `--lock` for exclusive resources", run: T.taskAdd },

  { section: 'Plan', name: 'task list', usage: '[--status S]', summary: 'list tasks (S: a status, ready or blocked)', flags: { status: str('S', 'todo, in_progress, submitted, accepted, rework, cancelled, ready or blocked') }, description: "read; `S` is a status, `ready` or `blocked`", run: T.taskList },

  { section: 'Plan', name: 'task note', pos: ['ID', 'TEXT...'], usage: 'ID TEXT [--kind scope-ruling]', summary: 'append a note', description: 'append a note; a scope-ruling records a design change after repeated review failures and clears the dispatch gate. Only the orchestrator or owner may record it', flags: { kind: str('scope-ruling', 'operational (orchestrator or owner): record a design change and clear the repeated-review dispatch gate') }, run: T.taskNote },

  { section: 'Plan', name: 'task show', pos: ['ID'], usage: 'ID', summary: 'show one task with its gates, evidence and notes', description: "read; `S` is a status, `ready` or `blocked`", run: T.taskShow },

  { section: 'Plan', name: 'task update', pos: ['ID'], usage: 'ID [--title T] [--acceptance A]... [--closed-acceptance] [--dep ID]... [--lock NAME]... [--environment LABEL] [--size S] [--kind K] [--needs JSON] [--tier T] [--priority urgent|normal] [--needs-owner REASON] [--ci-local JSON] [--budget-hours H|null] [--budget-tokens N|null] [--interrupt] [--status cancelled | --superseded-by ID]', summary: "change a task; acceptance, dependency or capability changes bump its revision (--dep '' clears dependencies); live requirements changes need --interrupt; an accepted task's material settings wait for rework", flags: { ...TASK_FIELDS, priority: str('urgent|normal', 'operational (orchestrator or owner): urgent goes first in ready order; normal restores the default order'), acceptance: many('A', 'replaces all acceptance lines'), 'closed-acceptance': bool('operational (orchestrator or owner): changed acceptance is a closed list resolving repeated review failures'), dep: many('ID', "replaces all dependencies; '' clears them"), lock: many('NAME', "replaces all locks; '' clears them; changes require no live lease or reservation"), 'needs-owner': str('REASON', "what the owner has to do; '' clears it; clearing or replacing an existing request is operational (orchestrator or owner)"), 'ci-local': str('JSON', 'operational (orchestrator or owner): local CI override with command or args and optional timeout; null restores kind or default policy'), 'budget-hours': { ...SETTINGS['budget-hours'], help: "the task's hours budget; null removes the limit; lowering is operational, raising is owner-required" }, 'budget-tokens': { ...SETTINGS['budget-tokens'], help: "the task's token budget; null removes the limit; lowering is operational, raising is owner-required" }, 'superseded-by': str('ID', 'fold this task into another task and retire its worktree'), interrupt: bool('operational (orchestrator or owner): stop and release a live claim before changing requirements'), status: str('cancelled', 'cancel the task') }, description: "change a task; acceptance, dependency or capability changes bump `revision`. `--closed-acceptance` declares the changed acceptance a closed list and clears the repeated-review dispatch gate; only the orchestrator or owner may set it, and unchanged acceptance refuses it. A live claim refuses changes to acceptance, dependencies, `--needs`, kind or the local CI override unless `--interrupt` stops it first (see `interrupt`); notes, title, size, tier and priority never stop a run. `--priority urgent|normal` is operational (orchestrator or owner); urgent tasks go first in `ready`, `spawn --ready` and automation refill, before unblock count and task id. Missing priority means normal; setting normal removes the field and restores the default order. Priority changes do not bump `revision`. `--needs '[]'` clears capabilities, `--dep ''` clears dependencies, `--needs-owner ''` clears the owner ask. `--lock` replaces all resource locks; `--lock ''` clears them. Lock changes require no live lease or dispatch reservation. `--environment ''` clears the label. Changing `--tier`, and clearing or replacing an existing owner ask, are operational (the orchestrator or the owner); any agent may set a new ask or keep the same reason. Changing `--kind` is operational, except that leaving `code` is owner-required and a submitted or accepted task refuses any kind change until `rework` ([Authority](state.md#authority)). Cancelling a task that has an owner ask is operational when the orchestrator or the engine set it (`task.cancel_hold`) and owner-required when the owner or a worker did (`task.cancel_needs_owner`); `needs_owner_by` records who. `--ci-local` sets or clears an operational local CI override. Refused if it would form a cycle. An accepted task cannot be cancelled, and its acceptance, dependencies, capabilities, kind and local CI override change only after `rework`. `--budget-hours`, `--budget-tokens` set the task's budget, enforced on live usage like the project budget; `null` removes the limit. Lowering is operational; raising or removing a finite limit is owner-required. Cancelling or `--superseded-by ID` retires the worktree and local branch, saving local commits and dirty work under the state directory first. A running agent exits through its supervisor; failed removal remains stale in inbox", run: T.taskUpdate },

  { section: 'Plan', name: 'validate', summary: 'report plan and ladder errors (exit 1 if any); warn when an open task has no runnable reviewer, no harness on PATH can run a worker or reviewer, or gh auth status fails', description: "report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a `split:` note, oversize budgets (planned hours at S=1, M=4, L=8 over `budget.hours`, or spend over either budget); exit 1 if anything is reported. It takes the state lock to read, finishing any interrupted commit first, then reconciles tasks.json with `events.jsonl` and reports drift: tasks or task notes the log records that tasks.json lacks, a `next` the log has already used, and a tasks.json change whose event the log lacks. It also reports every ladder rung that cannot run, and warns per open task when no reviewer rung can run. Warnings about this machine follow: no harness program on PATH for any worker tier, or for an open task's tier, or for any reviewer rung; and a failing `gh auth status` (or no gh), since every worker opens a PR with gh. Warnings do not change the exit code", run: T.validate },

  { section: 'Run', name: 'wait', usage: '[--after CURSOR] [--for NAME] [--task ID] [--types TYPES] [--timeout SEC | --follow] [--observe] [--inbox]', summary: 'block until one matching event; print one JSON line (timeout exits 2); --follow prints an id-only line per event until interrupted', flags: { inbox: bool('refresh actionable inbox findings at startup and each minute; emit deduplicated wakeups'), after: str('CURSOR', 'a returned cursor (OFFSET:CUTS), event id or byte offset (default now)'), for: str('NAME', 'recipient (default orchestrator)'), task: str('ID', 'only this task or decisions blocking it'), types: str('TYPES', "comma-separated event types; 'all' adds renew, spend and other bookkeeping"), timeout: num('SEC', 'maximum wait in seconds'), follow: bool('keep running; one line of ids per event, no detail'), observe: bool('watch only; run no software reactions, startup reconciliation or worker dispatch') }, run: run('../lib/events', 'wait') },

  { section: 'Agents and worktrees', name: 'worktree', pos: ['ID...'], usage: 'ID [ID ...]', summary: 'prepare task worktrees serially from one fetched base before dispatch', description: "create (or print) a git worktree and branch `tower-crane/<id>-<slug>` from the freshest base for each task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`, with its git admin directory in `.git-admin/<id>-<slug>` beside it (linked from the repository's `worktrees/`, which sandboxed agents cannot write); records path, branch, base, creation time and last observed head on the task. With an `origin` remote and no upstream yet, the branch tracks its namesake on origin, so a plain `git push` publishes it: a sandboxed worker cannot write the config `git push -u` changes. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it", run: run('../lib/worktree', 'worktree') },

  { section: 'Agents and worktrees', name: 'worktree list', summary: 'list managed worktrees with task status, live/stale/orphan state, counts and paths', run: run('../lib/worktree', 'worktreeList') },

  { section: 'Agents and worktrees', name: 'worktree prune', usage: '[--dry-run] [--orphans]', summary: 'orchestrator or owner: remove stale worktrees and branches; list orphans unless --orphans opts in', flags: { 'dry-run': bool('print the removal plan without changes'), orphans: bool('also save and remove orphan worktrees under the managed root') }, run: run('../lib/worktree', 'worktreePrune') },
];

const GROUPS = new Set(COMMANDS.filter((c) => c.name.includes(' ')).map((c) => c.name.split(' ')[0]));
const SECTIONS = ['Plan', 'Run', 'Decisions', 'Views', 'Agents and worktrees', 'Gates'];

function flagLine(name, spec) {
  const left = `  --${name}${spec.arg ? ` ${spec.arg}` : ''}`;
  return `${left.padEnd(26)} ${spec.help}${spec.type === 'multi' ? ' (repeatable)' : ''}`;
}

function generalHelp() {
  const lines = ['tower-crane: plan, dispatch, review and merge agent work, with state in plain files', '', 'usage: tower-crane <command> [args] [--state DIR] [--agent NAME] [--json]'];
  for (const section of SECTIONS) {
    lines.push('', `${section}:`);
    for (const c of COMMANDS.filter((x) => x.section === section)) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  }
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  lines.push('', `exit status: 0 done, 1 refused (reason on stderr), 2 usage error, 3 lock not acquired within ${S.LOCK_WAIT_MS / 1000} s`);
  lines.push('run tower-crane <command> --help for its options, tower-crane --version for the version; docs/cli.md and docs/state.md hold the contract');
  return lines.join('\n');
}

function commandHelp(c) {
  const lines = [`usage: tower-crane ${c.name}${c.usage ? ` ${c.usage}` : ''}`, '', c.summary];
  const flags = Object.entries(c.flags || {});
  if (flags.length) lines.push('', 'options:', ...flags.map(([n, s]) => flagLine(n, s)));
  lines.push('', 'global options:', ...Object.entries(GLOBAL).map(([n, s]) => flagLine(n, s)));
  return lines.join('\n');
}

function groupHelp(group) {
  const lines = [`usage: tower-crane ${group} <subcommand> ...`, ''];
  for (const c of COMMANDS.filter((x) => x.name.startsWith(`${group} `))) lines.push(`  ${c.name.padEnd(16)} ${c.summary}`);
  return lines.join('\n');
}

function convert(name, spec, raw) {
  if (spec.nullable && raw === 'null') return null;
  if (spec.type === 'int') {
    if (!/^-?\d+$/.test(raw)) throw usage(`--${name} needs a whole number, got "${raw}"`);
    return parseInt(raw, 10);
  }
  if (spec.type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw usage(`--${name} needs a number, got "${raw}"`);
    return n;
  }
  return raw;
}

// Options take their value from the next token even if it starts with "-",
// so "--minutes -5" reaches validation instead of becoming an unknown flag.
// spans name the token indexes each option took, for the state broker.
// Option names come from the command line, which the state broker takes from
// a sandboxed agent, so only a command's own option names are looked up and
// values collect in a Map; no name can reach Object.prototype.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

function parseOptions(tokens, specs, where) {
  const flags = new Map();
  const pos = [];
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') {
      pos.push(...tokens.slice(i + 1));
      break;
    }
    if (tok === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!tok.startsWith('--')) {
      pos.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const spec = !RESERVED.has(name) && Object.hasOwn(specs, name) ? specs[name] : null;
    if (!spec) throw usage(`unknown option --${name}${where ? ` for ${where}` : ''}; see tower-crane ${where ? `${where} ` : ''}--help`);
    if (spec.type === 'bool') {
      if (eq !== -1) throw usage(`--${name} takes no value`);
      flags.set(name, true);
      spans.push({ name, from: i, to: i });
      continue;
    }
    const from = i;
    let raw;
    if (eq !== -1) raw = tok.slice(eq + 1);
    else {
      if (i + 1 >= tokens.length) throw usage(`--${name} needs a value (${spec.arg})`);
      raw = tokens[++i];
    }
    spans.push({ name, from, to: i });
    const value = convert(name, spec, raw);
    if (spec.type === 'multi') flags.set(name, [...(flags.get(name) || []), value]);
    else if (flags.has(name)) throw usage(`--${name} was given twice`);
    else flags.set(name, value);
  }
  return { flags: Object.fromEntries(flags), pos, spans };
}

function splitGlobals(flags) {
  const globals = {};
  const own = {};
  for (const [k, v] of Object.entries(flags)) (k in GLOBAL ? globals : own)[k] = v;
  return { globals, own };
}

function resolveCommand(argv) {
  // Global options may come before the command word.
  let i = 0;
  const lead = [];
  while (i < argv.length && argv[i].startsWith('-')) {
    const tok = argv[i];
    const name = tok.replace(/^--?/, '').split('=')[0];
    if (tok === '--version') return { version: true };
    if (tok === '-h' || name === 'help' || name === 'json') {
      lead.push(tok);
      i += 1;
    } else if ((name === 'state' || name === 'agent') && tok.startsWith('--')) {
      lead.push(tok);
      if (!tok.includes('=')) lead.push(argv[i + 1]);
      i += tok.includes('=') ? 1 : 2;
    } else {
      throw usage(`unknown option ${tok}; put command options after the command`);
    }
  }
  const word = argv[i];
  if (word === undefined || word === 'help') {
    const topic = word === 'help' ? argv.slice(i + 1).join(' ') : '';
    return { help: topic || true, lead };
  }
  if (GROUPS.has(word)) {
    const sub = argv[i + 1];
    const cmd = sub && !sub.startsWith('-') ? COMMANDS.find((c) => c.name === `${word} ${sub}`) : null;
    if (!cmd) {
      const parent = COMMANDS.find((c) => c.name === word);
      if (parent) return { cmd: parent, rest: argv.slice(i + 1), lead };
      const rest = argv.slice(i + 1);
      if (rest.includes('--help') || rest.includes('-h') || sub === undefined) return { groupHelp: word, lead, bare: sub === undefined };
      throw usage(`unknown command "${word} ${sub}"; run tower-crane ${word} --help`);
    }
    return { cmd, rest: argv.slice(i + 2), lead };
  }
  const cmd = COMMANDS.find((c) => c.name === word);
  if (!cmd) throw usage(`unknown command "${word}"; run tower-crane --help`);
  return { cmd, rest: argv.slice(i + 1), lead };
}

function checkPositionals(cmd, pos) {
  const spec = cmd.pos || [];
  const required = spec.filter((p) => !p.startsWith('[')).length;
  const variadic = spec.some((p) => p.endsWith('...'));
  if (pos.length < required) throw usage(`${cmd.name} needs ${spec.filter((p) => !p.startsWith('[')).join(' ')}; usage: tower-crane ${cmd.name} ${cmd.usage || ''}`.trim());
  if (!variadic && pos.length > spec.length) throw usage(`unexpected argument "${pos[spec.length]}" for ${cmd.name}`);
}

async function main(argv) {
  // State discovery can start Git before authentication; children get no key.
  const ownerCredential = process.env.TOWER_CRANE_OWNER_KEY;
  delete process.env.TOWER_CRANE_OWNER_KEY;
  const AutomationKey = require('../lib/automation-key');
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  let resolved;
  let jsonOut = argv.includes('--json');
  let automationCredential;
  try {
    // A helper writes its key on stdin before any input the command reads.
    automationCredential = AutomationKey.take(process.env);
    resolved = resolveCommand(argv);
    if (resolved.version) {
      out(require('../package.json').version);
      return 0;
    }
    if (resolved.help) {
      if (resolved.help === true) {
        if (argv.length) {
          out(generalHelp());
          return 0;
        }
        process.stderr.write(`${generalHelp()}\n`);
        return 2;
      }
      const c = COMMANDS.find((x) => x.name === resolved.help);
      if (c) out(commandHelp(c));
      else if (GROUPS.has(resolved.help)) out(groupHelp(resolved.help));
      else throw usage(`no help for "${resolved.help}"; run tower-crane --help`);
      return 0;
    }
    if (resolved.groupHelp) {
      if (!resolved.bare) {
        out(groupHelp(resolved.groupHelp));
        return 0;
      }
      process.stderr.write(`${groupHelp(resolved.groupHelp)}\n`);
      return 2;
    }
    const { cmd } = resolved;
    const parsed = parseOptions([...resolved.lead, ...resolved.rest], { ...(cmd.flags || {}), ...GLOBAL }, cmd.name);
    const { globals, own } = splitGlobals(parsed.flags);
    jsonOut = !!globals.json;
    if (globals.help) {
      out(commandHelp(cmd));
      return 0;
    }
    checkPositionals(cmd, parsed.pos);
    for (const r of cmd.required || []) {
      if (own[r] === undefined) throw usage(`${cmd.name} needs --${r}; usage: tower-crane ${cmd.name} ${cmd.usage}`);
    }
    let agent = globals.agent ?? process.env.TOWER_CRANE_AGENT;
    // Inspect descriptors without initializing stdin and changing pipe flags.
    const ownerTerminal = isatty(0) && isatty(1);
    // Terminal fallback identifies ordinary actions; owner powers need a named identity.
    const agentExplicit = agent !== undefined;
    if (agent === undefined) {
      if (ownerTerminal && process.env.TOWER_CRANE_TASK === undefined) agent = 'owner';
      else throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    }
    if (!agent.trim()) throw usage('no agent: pass --agent NAME or set TOWER_CRANE_AGENT');
    const identity = agent.trim();
    let stateDir;
    const locate = () => stateDir ??= S.locateStateDir(globals.state, process.env, process.cwd());
    // A wait at "now" starts at the log's end as of this point. Orchestrator
    // discovery below takes seconds on a cold Windows host, and events written
    // meanwhile must reach the waiter.
    const startCursor = cmd.name === 'wait' && (own.after === undefined || own.after === 'now')
      ? require('../lib/events').startCursor(locate()) : undefined;
    const authority = require('../lib/authority');
    const ownerConfigDir = identity === 'owner'
      ? authority.checkOwner(process.env, ownerCredential, ownerTerminal, () => authority.ownerProject(locate()), cmd.name === 'init')
      : undefined;
    // Check the resolved identity before forwarding; the broker separately
    // verifies requests against the identity it spawned.
    if (process.env.TOWER_CRANE_BROKER && !require('../lib/broker').READS.has(cmd.name)) {
      const input = argv.includes('-') ? readStdin() : undefined;
      let forwarded = argv;
      if (cmd.name === 'submit') {
        const sha = T.resolveSubmitSha({ cwd: process.cwd(), env: process.env, stateDir: locate(),
          pos: parsed.pos, flags: own }, own.sha);
        const tokens = [...resolved.lead, ...resolved.rest];
        const span = parsed.spans.find((s) => s.name === 'sha');
        tokens.splice(span.from, span.to - span.from + 1, '--sha', sha);
        forwarded = ['submit', ...tokens];
      }
      const res = await require('../lib/broker').forward(process.env.TOWER_CRANE_BROKER, forwarded, locate(), input);
      if (res) {
        process.stdout.write(res.stdout || '');
        process.stderr.write(res.stderr || '');
        return res.code;
      }
    }
    if (process.env.TOWER_CRANE_BROKER && cmd.name === 'wait' && require('../lib/broker').serves(process.env.TOWER_CRANE_BROKER, locate())) {
      require('../lib/broker').scopeWait(own, identity, process.env);
    }
    const ctx = {
      cwd: process.cwd(),
      env: process.env,
      agent: identity,
      agentExplicit,
      ownerTerminal,
      ownerConfigDir,
      json: !!globals.json,
      flags: own,
      pos: parsed.pos,
      request: { command: cmd.name, flags: own, pos: parsed.pos },
      stateDir: cmd.name === 'mcp' ? undefined : locate(),
      ...(cmd.name === 'mcp' ? { resolveStateDir: locate } : {}),
      ...(startCursor === undefined ? {} : { startCursor }),
    };
    // Engine provenance comes from the helper's key, never from TOWER_CRANE_VIA alone.
    ctx.automation = AutomationKey.verify(process.env, automationCredential, ctx.stateDir, identity);
    // A command reads the event log several times: the first read parses it
    // and later ones only what was appended since.
    const releaseEvents = ctx.stateDir ? S.retainEvents(ctx.stateDir) : () => {};
    let res;
    let releaseController;
    try {
      require('../lib/orchestrator').command(ctx, cmd.name);
      releaseController = await require('../lib/containment').registerController(ctx, cmd.name);
      res = await cmd.run(ctx);
    } finally {
      releaseController?.();
      releaseEvents();
    }
    if (res && !res.printed) {
      if (ctx.json) out(JSON.stringify(res.data, null, 2));
      else if (res.text !== undefined) out(res.text);
    }
    return (res && res.code) || 0;
  } catch (e) {
    if (e instanceof TowerCraneError) {
      process.stderr.write(`tower-crane: ${e.message}\n`);
      return e.code;
    }
    process.stderr.write(`tower-crane: ${jsonOut ? e.message : e.stack || e.message}\n`);
    return 1;
  }
}

// A queued no-op write completes after prior bytes, so natural exit waits for healthy output.
function flushStream(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('close', done);
      resolve();
    };
    stream.once('close', done);
    stream.write('', done);
  });
}

if (require.main === module) {
  if (!process.env.TOWER_CRANE_BROKER) {
    const releaseRuntime = require('../lib/runtime').hold();
    process.once('exit', releaseRuntime);
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  });
}

module.exports = { main, COMMANDS, GLOBAL, resolveCommand, parseOptions };
