#!/usr/bin/env node
'use strict';

const OUTPUT_PIPE_CLOSED = 'tower-crane:output-pipe-closed';
let outputPipeClosed = false;

for (const stream of [process.stdout, process.stderr]) {
  let broken = false;
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
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
  sandbox: str('JSON', 'owner-required: {write: extra writable paths}; project set accepts null to clear'),
  env: str('JSON', 'owner-required: extra environment variables; use env_file for secrets; project set accepts null to clear'),
  env_file: str('FILE', 'owner-required: systemd-quoted env file read only at spawn; project set accepts null to clear'),
  scope: str('JSON', 'owner-required: systemd user scope properties, e.g. {CPUQuota: "200%", MemoryMax: "8G"}; {} disables, project set accepts null to clear'),
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
  'budget-hours': { ...num('H|null', 'hours budget; null removes the limit'), nullable: true },
  'budget-tokens': { ...int('N|null', 'token budget; null removes the limit'), nullable: true },
  standards: str('S', '"default" or a path to a standards Markdown file'),
  'tests-cmd': str('CMD', 'operational (orchestrator or owner): pin the test command; null clears it'),
  'clean-cmd': str('CMD', 'operational (orchestrator or owner): pin the cleanup command prefix; null clears it'),
  'tests-proof-cmd': str('CMD', 'operational (orchestrator or owner): pin the scoped proof template with {tests}; null clears it'),
  executors: int('N', 'operational (orchestrator or owner): automation executors running gates at once on this host (default 2)'),
  'tests-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per test command (default 20); null restores default'),
  'clean-timeout-min': str('MIN', 'operational (orchestrator or owner): positive minutes per cleanup command (default 20); null restores default'),
  'tests-paths': str('JSON', 'operational (orchestrator or owner): non-empty array of test path globs; null restores default layouts'),
  'tests-keep': str('JSON', 'operational (orchestrator or owner): extra build file globs to keep at submitted sha; [] or null restores defaults'),
  'tests-host-only': str('JSON', 'operational (orchestrator or owner): test file globs a sandboxed worker cannot run, listed in its brief; the tests gate runs them on the host; [] or null clears them'),
  'tests-mode': str('MODE', 'operational (orchestrator or owner): prove, run-only or none; null restores prove'),
  'tests-by-kind': str('JSON', 'operational (orchestrator or owner): task kind to tests mode overrides; null clears overrides'),
  'tests-map': str('JSON', 'operational (orchestrator or owner): source path or glob to test file arrays; null clears the map'),
  'tests-expensive': str('JSON', 'operational (orchestrator or owner): true selects the head suites with scoped proof; false or null restores normal proof'),
  'ci-ignore-apps': str('JSON', 'array of GitHub app slugs to skip; [] or null clears the list'),
  'ci-required': str('JSON', 'array of required check-run names or prefixes; [] or null clears the list'),
  'ci-capped-review': str('JSON', 'array of {app, pattern}: a matching check run of that app is a nonblocking capped review; [] or null clears the list'),
  'ci-local': str('JSON', 'local CI {command: argv, timeout: seconds, by_kind?: overrides}; null restores hosted CI'),
  'merge-keep-branch': str('JSON', 'true keeps merged task branches for retained worktrees; false or null restores deletion'),
  'merge-admin': str('JSON', 'owner-required: true uses gh --admin for solely owned repos; false or null disables it'),
  'decision-delegation': str('JSON', 'owner only: allow the orchestrator to answer technical decisions; null clears'),
  'review-policy': str('JSON', 'operational (orchestrator or owner): review diff limits and canonical model prices; null clears the policy'),
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
  tier: str('T', 'easy, medium, hard, research or an ascending range (easy..medium): the ladder rung that does it (default: research for kind research, else S easy, M medium, L hard)'),
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
  { section: 'Run', name: 'accept', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD] [--waive TYPE --reason R]', summary: 'run missing software gates, dispatch review when green, accept when all gates pass', flags: { cmd: str('CMD', 'must match the pinned gates.tests_cmd'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd'), waive: many('TYPE', 'waive tests, clean, sources, review or ci: review is operational (orchestrator or owner), the rest owner-required'), reason: str('R', 'why the waived gate does not apply') }, description: "run unattempted software gates first; tests and clean use pinned project commands. Optional `--cmd` and `--proof-cmd` must match their pins; none mode needs no test command. When they pass and review is missing, dispatch it and return `review_pending: true` while keeping the task submitted. Call again after review evidence arrives to accept. Existing successful receipts are reused; attempted failures or invalid receipts require an explicit gate rerun. `--waive review` is operational when the reviewer is capped or down at the submitted head (a capped review run in its `check ci` evidence, or a review spawn that exited without a verdict) and owner-required otherwise; waiving tests, clean, sources or ci is owner-required", run: T.accept },

  { section: 'Decisions', name: 'answer', pos: ['DID'], usage: 'DID --choice C [--note T]', summary: 'answer under owner or owner-set delegation', flags: { choice: str('C', 'the chosen option'), note: str('T', 'context') }, required: ['choice'], description: "answer it as the owner with explicit identity, as an agent the owner named on the decision (`decision delegate --answerers`), or as the orchestrator for a technical decision when the project's `decision-delegation` setting allows it. Anyone else exits 1 naming who can answer. A decision that escalates an owner-required setting is answered by the owner only. One-use setting approvals offer `approve` and `decline`. The answer event records `answered_by` and `answer_rule` (`owner`, `owner-named-agent` or `owner-technical-delegation`). `C` must be one of the options when there are any; an answered decision stays answered", run: D.answer },

  { section: 'Decisions', name: 'ask', usage: '(--question Q --option A --option B [--recommend A] [--why W] [--blocks ID]... [--setting KEY]... | --setting S [--change JSON])', summary: 'open a question or a one-use setting approval; prints its id', flags: { question: str('Q', 'the question'), option: many('A', 'an allowed answer; repeat'), recommend: str('A', 'the recommended option'), why: str('W', 'the reasoning'), blocks: many('ID', 'a task that waits for the answer; repeat'), setting: many('KEY', 'authority-table setting: repeat to tag a question, or name one without --question to request approval'), change: str('JSON', 'without --question: what exactly would change, shown to the owner') }, description: "with `--question`, open a decision; prints its id. A worker or reviewer question is technical, so the orchestrator can answer when the project's decision-delegation setting allows. `--setting KEY` tags the question; an owner-required tag makes it owner-only. Answering a tagged question never authorizes a setting command. Without `--question`, `--setting S [--change JSON]` requests a one-use approval for an owner-required change no command makes, such as `publish`: exit 1 opens or reuses its decision; after owner approval, the identical request applies it once, records the setting audit and exits 0. Command-changed settings must be requested through their command; operational settings need no approval. `--change` cannot be combined with `--question`", run: D.ask },

  { section: 'Plan', name: 'authority', summary: 'list every guarded setting, its class (operational, owner-required or refused) and the command that changes it', description: 'list every guarded setting with its class (`operational`, `owner-required` or `refused`) and the command that changes it; `--json` gives `[{ setting, class, how }]`, the list the board reads', run: run('../lib/authority', 'show') },

  { section: 'Views', name: 'bench gates', usage: '[--deslop-hits FILE] [--deslop-findings FILE] [--deslop-runs FILE] [--deslop-report FILE]', summary: 'label every software gate result from the event log and report precision and recall per gate, and per deslop check from its eval files', flags: { 'deslop-hits': str('FILE', 'JSONL of detector hits with hand verdicts'), 'deslop-findings': str('FILE', 'JSONL of reviewer-found defects with reviewed_commit and example'), 'deslop-runs': str('FILE', 'JSON of detector output keyed repo#pr@commit; needs --deslop-findings'), 'deslop-report': str('FILE', 'detector report JSON with confirmed findings and dismissed items') }, description: "label every tests, clean, sources, ci and merge gate run in the event log and report per gate: runs, distinct results (one per gate, sha and outcome), true and false positives and negatives, open results, noncode CI fails (no failed hosted check or confirmed local execution; scored as neither), precision, recall and recall against failed CI check runs only (`-` for ci and merge). Failed CI runs are split by reason and by failing check run, deduplicated per task, sha and check name across all polls. Local CI executions use their confirmed failure and exit receipts. The deslop flags add per-check precision and recall from the detector's eval files; `--deslop-runs` needs `--deslop-findings`. Tables normalize unambiguous SHA prefixes of at least seven characters to the longest recorded spelling for that task, ignoring case. JSON output includes every labeled run with its original SHA", run: run('../lib/bench-gates', 'benchGates') },

  { section: 'Views', name: 'bench tokens', usage: '[--prices FILE]', summary: 'tokens and priced cost per accepted task, by rung and by escalation path, from spend records', flags: { prices: str('FILE', 'model price table JSON, same shape as review.prices (default: the project review.prices)') }, description: "tokens per accepted task from spend entries: overall, by escalation path (the task's worker rungs in order, repeats collapsed) and by rung, as medians and means with fresh input, cache reads and output split. Missing category totals are null and excluded from that category median. USD uses recorded `cost_usd`, else `--prices` (the `review.prices` shape), else the project `review.prices`, matched on the exact model id; unpriced entries are listed by model. Tasks with unknown token entries, unfinalized live usage or spawned sessions missing usage are excluded from all medians and means; recorded live tokens still count in the overall spend total. JSON names missing sessions in `missing_spawns`", run: run('../lib/bench-tokens', 'benchTokens') },

  { section: 'Plan', name: 'brief get', pos: ['ID'], usage: 'ID [--role worker|reviewer]', summary: "print the full or role-filtered task brief", flags: { role: str('ROLE', 'select worker or reviewer text; otherwise infer from the agent name') }, description: "write or read the task's brief; `brief get` filters for the caller's worker or reviewer role, and `brief set` warns about a reviewer section without a worker section", run: T.briefGet },

  { section: 'Plan', name: 'brief set', pos: ['ID', '[-]'], usage: 'ID (--file F | -)', summary: "write the task's brief; warn when reviewer text has no worker section", flags: { file: str('F', 'read the brief from F') }, description: "write the task's brief; changing it after the first submission bumps `revision` and invalidates earlier evidence. An accepted task requires `rework` before its brief can change. Identical writes keep the revision. Warns about a reviewer section without a worker section", run: T.briefSet },

  { section: 'Plan', name: 'browser-kit set', usage: '--servers JSON', summary: 'owner-required: save the browser kit server list in the user configuration', flags: { servers: str('JSON', 'MCP server names; [] disables the kit') }, required: ['servers'], description: "owner-required: save the kit server list in the user file (`TOWER_CRANE_CONFIG`, else the original user's `~/.config/tower-crane/config.json`). Names are deduplicated; `[]` disables automatic server attachment. Other user settings are preserved", run: run('../lib/browser-kit', 'set') },

  { section: 'Plan', name: 'browser-kit show', summary: 'show the user browser kit MCP server list (default playwright)', description: "show the user's browser kit MCP server list, default `[\"playwright\"]`, and its config file", run: run('../lib/browser-kit', 'show') },

  { section: 'Gates', name: 'check ci', pos: ['ID'], usage: 'ID', summary: 'configured local CI on the merged tree, or GitHub checks on the submitted sha; records ci', description: "with `ci.local`, resolve task override, kind mapping or default, run its argv against the merged base and submitted head and record a local receipt; otherwise verify the PR head and mergeability, require `ci.required` runs to be present and successful on the submitted sha, require at least one run outside `ci.ignore_apps` and `ci.capped_review` exceptions and all remaining checks green; records `ci`", run: gate('ci') },

  { section: 'Gates', name: 'check clean', pos: ['ID'], usage: 'ID [--cmd CMD]', flags: { cmd: str('CMD', 'must match pinned gates.clean_cmd; omit to use it') }, summary: 'cleanup tool on the task branch against base reports no HIGH finding; records clean', description: "run pinned `gates.clean_cmd` on the task branch against `base`; records `clean`, ok when every check ran and none reported a HIGH finding; timeouts record infrastructure failure", run: gate('clean') },

  { section: 'Gates', name: 'check sources', pos: ['ID'], usage: 'ID', summary: 'fetch distinct cited pages and verify every quoted claim in research/ID.json at submitted sha; records sources', description: "fetch the distinct cited pages from committed `research/ID.json` and verify every quote; records sources evidence; required for research kind on every tier", run: gate('sources') },

  { section: 'Gates', name: 'check tests', pos: ['ID'], usage: 'ID [--cmd CMD] [--proof-cmd CMD]', summary: 'check tests under the project and task kind mode; records tests', flags: { cmd: str('CMD', 'must match pinned gates.tests_cmd; omit to use it'), 'proof-cmd': str('CMD', 'must match pinned gates.tests_proof_cmd for changed test paths') }, description: "use `tests.by_kind` over `tests.mode` (default `prove`); `prove` requires pinned `gates.tests_cmd` to pass at head and fail after reverting other changes, with T8 build-file keeps; expensive proof runs mapped head suites when `tests.map` and full-suite `ci.required` are pinned, falls back to CMD for unmapped sources, and uses a scoped `{tests}` command at head and after reversion; `run-only` requires the pinned command to pass once at head; `none` verifies the submitted commit without running CMD; records `tests`, resolved `tests_mode`, and failed test names plus a bounded output tail when its command fails; timeouts record infrastructure failure and interrupted files instead", run: gate('tests') },

  { section: 'Run', name: 'ci completed', pos: ['ID'], usage: 'ID --sha SHA', summary: 'handle a CI completion notification; query CI again and advance green tasks', flags: { sha: str('SHA', 'completed submitted commit; stale heads are refused') }, required: ['sha'], description: "orchestrator or owner: deliver a CI completion hint for an active submitted head, rerun the CI gate and advance passing tasks", run: run('../lib/automation', 'ciCompleted') },

  { section: 'Run', name: 'ci webhook', pos: ['FILE'], usage: 'FILE', summary: 'handle completed GitHub check_run, check_suite or workflow_run JSON; - reads stdin', description: "orchestrator or owner: deliver completed GitHub `check_run`, `check_suite` or `workflow_run` JSON; `-` reads stdin. Repository must match. Stale heads and incomplete checks are ignored", run: run('../lib/automation', 'ciWebhook') },

  { section: 'Run', name: 'claim', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'take a ready task for --agent', flags: { lease: int('MIN', 'lease length (default limits.lease_minutes)') }, description: "take a ready task for `--agent`; repeating it as the live claimant renews the lease. Refused if another agent holds it, the task is not ready, a resource lock is held, or the workers limit is reached (live leases and unclaimed worker spawns); consumes that agent's reservation for this task", run: T.claim },

  { section: 'Decisions', name: 'decision delegate', pos: ['DID'], usage: 'DID [--answerers JSON] [--technical JSON]', summary: 'owner-required: set named answerers or mark a decision technical', flags: { answerers: str('JSON', 'owner-named agents; [] clears the list'), technical: str('JSON', 'true or false') }, description: "owner-required: set the agents that may answer the decision (`--answerers`, a JSON array; `[]` clears it) or mark it technical (`--technical true|false`), which lets the orchestrator answer it when the project's `decision-delegation` setting allows. The orchestrator's request opens a one-use owner approval for that decision and those values; rerun after approval. Owner and approved orchestrator writes use the shared setting audit. At least one field is required; a closed decision cannot be delegated again", run: D.delegate },

  { section: 'Decisions', name: 'decision note', pos: ['DID', 'TEXT...'], usage: 'DID TEXT', summary: 'append a comment on a decision', description: "append a comment; an explicit owner comment wakes the orchestrator and tasks blocked by the decision", run: D.comment },

  { section: 'Decisions', name: 'decision withdraw', pos: ['DID'], usage: 'DID --reason R', summary: 'asker or owner: withdraw an unanswered decision as moot', flags: { reason: str('R', 'why it no longer needs an answer') }, required: ['reason'], description: "close an open decision that no longer needs an answer. The agent that opened it or the owner can withdraw it; no owner answer is needed. Refused once answered or withdrawn. The decision leaves the open list and stays in history; the event records the reason, and each task it blocked gets the reason in its notes", run: D.withdraw },

  { section: 'Decisions', name: 'decisions', usage: '[--open]', summary: 'list decisions', flags: { open: bool('only open ones') }, description: "list", run: D.list },

  { section: 'Run', name: 'event', pos: ['ID'], usage: 'ID', summary: 'print one event with its detail, as a wake line names it', run: run('../lib/events', 'show') },

  { section: 'Run', name: 'evidence', pos: ['ID'], usage: 'ID --type T (--ok | --fail) [--sha S] [--revision N] [--summary T] [--ref URL]', summary: 'record review or note evidence; review needs --sha, note defaults to the submitted sha', flags: { type: str('T', 'review or note; tests, clean, sources, ci and merge require gate commands'), ok: bool('it passed'), fail: bool('it failed'), sha: str('S', 'commit the evidence is about; required for review'), revision: int('N', 'task revision the evidence is about; required for review from a reviewer spawn did not start'), summary: str('T', 'one line'), ref: str('URL', 'link to the run, review or log') }, required: ['type'], description: "record `review` or `note` evidence; `review` requires `--sha`, while `note` defaults to the task's submitted sha. `--revision N` names the task revision the evidence is about and is refused above the current revision; review evidence from a reviewer that `spawn` did not start requires it, and a spawned reviewer's verdict keeps its dispatch revision. Refuses `tests`, `clean`, `sources`, `ci` and `merge` for every agent and either verdict; use the gate commands", run: T.evidence },

  { section: 'Gates', name: 'gates prioritize', pos: ['ID'], usage: 'ID --reason R', summary: "move a task's queued gate work to the front of the executor queue", flags: { reason: str('R', 'why the task goes first; kept on the event and shown in status') }, required: ['reason'], description: "operational (orchestrator or owner): move the task's queued automation reactions, such as its submission gates or merge, ahead of older queued work, so the next free executor takes them first. Several requests run newest first. Only the work queued when the request is made moves; a notification queued later keeps its place, and a running reaction is not queued work. Refused when nothing is queued for the task. Logs a `gates prioritize` event with the reason; `status` and `inbox` show the gate queue", run: run('../lib/automation', 'prioritize') },

  { section: 'Gates', name: 'gates retry', pos: ['ID'], usage: 'ID', summary: 'orchestrator or owner: rerun each failed software gate at the submitted head, at unchanged inputs', description: "orchestrator or owner: rerun each failed `tests`, `clean`, `sources` or `ci` gate of a submitted task at its current head and revision, with the same pinned commands and policy. Use it when a failure was caused by infrastructure that a later fix removed, such as a timeout. Automation never retries a failure at unchanged inputs; passing evidence whose inputs changed, such as the pinned command or tests policy, reruns on its own. Refuses a task that is not submitted and one with no failed software gate. Exits 1 while a retried gate still fails. Run `accept` afterwards to continue", run: run('../lib/automation', 'gatesRetry') },

  { section: 'Run', name: 'hook', pos: ['ACTION'], usage: 'ACTION --binding FILE [--payload JSON|-]', summary: 'deliver harness messages and record activity under the home identity', flags: { binding: str('FILE', 'protected hook binding in the agent home'), payload: str('JSON|-', 'harness event data (- reads stdin)') }, required: ['binding'], run: run('../lib/harness-hooks', 'hook') },

  { section: 'Views', name: 'inbox', usage: '[--ack ITEM] [--json]', summary: 'actionable state and GitHub findings with resolving commands', flags: { ack: str('ITEM', 'acknowledge a handled message, stall, decision answer or owner comment') }, description: "orchestrator or owner: read state once for current failed software gates and inspect PR heads, mergeability, uncapped revuto failures and inline comments, and open CodeQL alerts on the submitted head or its verified current PR merge commit. Returns typed `items` with `action.command` and `action.argv`, plus live gate `executors` and the `gate_queue` in drain order. Failed reviews include the full latest Tower Crane comment at the submitted SHA and `finding_count`; fetch errors remain explicit. Failed gates include their summary and test diagnostics; audited confirmed code failures resolve through rework, while pending checks and observation failures offer a gate rerun. Remotely merged accepted heads remain actionable with `merge --accepted` until their audited local merge receipt exists. Stale software gates on an open mergeable accepted PR resolve with `check GATE ID` before merge. GitHub failures are explicit items. `--ack ITEM` acknowledges a message, stall, decision answer or owner comment after handling it; task and GitHub findings clear only when their condition clears", run: run('../lib/inbox', 'inbox') },

  { section: 'Plan', name: 'init', usage: '--name N --goal G [--repo O/R] [--base B] [settings]', summary: 'create the state directory and project.json with the default ladder', flags: SETTINGS, required: ['name', 'goal'], description: "create the state directory and `project.json` with the default harness and ladder (from the user file, else built in), and record its canonical `owner_config_dir`; takes the `project set` settings too. Refused if the user file is invalid or the project already exists", run: P.init },

  { section: 'Run', name: 'interrupt', pos: ['ID'], usage: 'ID', summary: 'owner or orchestrator: stop the supervisor and release the claim, keeping the revision and dirty worktree for resume', description: "owner or orchestrator only: stop the live agent through its supervisor and release the claim to its prior `todo` or `rework`. The revision, branch, evidence and dirty worktree stay, so the next dispatch resumes the work (Codex warm resume, or a fresh Claude worker in the same worktree). Distinct from `rework`, which sends a submitted task back with a reason, and from a requirements edit, which bumps the revision", run: T.interrupt },

  { section: 'Plan', name: 'ladder harness', pos: ['HARNESS'], usage: 'HARNESS', summary: 'set the default harness every rung without its own runs on', description: "set the default harness; every rung without its own moves to it. Operational: the orchestrator or the owner; moving a worker, reviewer or small rung off claude and codex is owner-required (`ladder.reach`). Refused, naming the rungs, if one of them cannot run there (a codex profile on pi, a missing model)", run: P.ladderHarness },

  { section: 'Plan', name: 'ladder save-user', summary: "write this project's ladder to the user file, the default for new projects", description: "write the project's default harness and primary rungs to the user file (`TOWER_CRANE_CONFIG`, else `~/.config/tower-crane/config.json`), preserving personal fallbacks and other keys; only what the project defines is written. Operational: the orchestrator or the owner, and the event records the orchestrator as `authority`. Refused while a primary rung cannot run. A user file that is not valid JSON or has the wrong shape refuses every command that has to resolve the ladder, including `ladder`, `spawn` and `init`, even when the project supplies every rung; the error names the file to fix or remove", run: P.ladderSaveUser },

  { section: 'Plan', name: 'ladder set', pos: ['RUNG'], usage: 'RUNG [--harness H] [--model M] [--profile P] [--provider P] [--effort E] [--args JSON] [--command JSON] [--supervision JSON] [--tools JSON] [--mcp JSON] [--web-mcp JSON] [--fallbacks JSON] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON] [--clear FIELD]...', summary: 'change fields of one rung: orchestrator, easy, medium, hard, research, review or small', flags: RUNG_FLAGS, description: "change the named primary fields of one rung and keep the rest. `--fallbacks JSON` replaces its ordered personal routes in the user file; `[]` empties the list and `--clear fallbacks` removes the override. Edit fallbacks separately from project primary fields. Other personal settings and project primaries are preserved. Fallback edits use the same field, reach, tool and MCP authority checks as primary edits; owner approvals bind the user file, rung and full requested list. `--tools` (claude, codex, agy and pi) and `--mcp` (claude, codex and agy) opt the rung back in to tools and MCP servers its agent file leaves out. Pi refuses MCP opt-ins. Changes are operational, except `--command`, `--web-mcp`, `--sandbox`, `--env`, `--env_file` and `--scope`, which are owner-required ([Authority](state.md#authority)); so is moving a worker, reviewer or small rung off claude and codex, or `--args` on another harness, including agy (`ladder.reach`). The orchestrator's `--tools` and `--mcp` take only harness built-ins that keep the sandbox and MCP servers the owner's harness config defines; `--args` on a claude, codex, agy or pi rung may hold only a short list of safe flags; `--web-mcp` sets the research Claude server as `{name, command, args}` without secrets; it cannot combine with `--mcp`. `--clear web_mcp` removes it. `--clear` removes a field (a cleared harness follows the default). A rung the project left out starts from the primary it fell back to. Refused if it leaves a primary unable to run that could run before (state.md lists the checks); rungs already broken do not block it", run: P.ladderSet },

  { section: 'Plan', name: 'ladder show', summary: 'print each rung as it resolves, and where it comes from (project, user file or built-in)', description: "print each rung as it resolves: harness (and whether it is the default), model, profile, provider, effort, args, and where the primary comes from (project, user file or built-in); print personal fallbacks and their user-file source (`fallbacks_from: \"user\"` under `--json`); also the default harness, its source, the user file path, and every rung or fallback that cannot run (`problems` under `--json`); unavailable fallbacks are marked skipped", run: P.ladderShow },

  { section: 'Run', name: 'mcp', summary: 'serve orchestrator inbox and actions as MCP tools over stdio', description: "start the newline-delimited JSON-RPC MCP server on stdin/stdout. Tools: `inbox` (optional `ack`), `spawn_ready`, `merge_accepted`, `rework_from_review` (`id`), and `release_dead`. Initialization and tool discovery work without a project; tool calls resolve the project and return missing-state or authorization errors as tool results. Calls retain the CLI process identity and state; there are no identity, state or shell overrides. Batch actions require the orchestrator or owner; all existing command checks and authority rules remain in force", run: run('../lib/mcp', 'serve') },

  { section: 'Gates', name: 'merge', pos: ['[ID]'], usage: '[ID | --accepted] [--subject S] [--body B] [--method M]', summary: "merge accepted PRs with passing gates; linked stacks use pinned merge commits and can complete partially", flags: { accepted: bool('drain the accepted merge queue through its current-base checks and stack gates'), subject: str('S', 'commit subject (default: task title)'), body: str('B', 'commit body (default: task acceptance lines; empty allowed)'), method: str('M', 'squash (ordinary default), merge or rebase; linked stacks use merge commits and rebase has no commit text options') }, description: "`--accepted` drains the accepted merge queue, with current-base head checks and linked stack gates; refused and pending entries are reported while independent mergeable entries continue. An already merged PR at the accepted head is confirmed without rerunning gates or merging it again. Otherwise merge the task's PR with `--match-head-commit` when the task is accepted and its gates still pass for its current revision (refused otherwise). When GitHub refuses `gh pr merge` for a stack member no task records, a squash or merge retries through the asynchronous merge API at the accepted head with the same method and commit text, then deletes the head branch unless `merge.keep_branch` is set; with `merge.admin` set it refuses, since that API has no admin option. A rebase keeps the refusal. Linked stacks merge bottom up through GitHub's asynchronous merge API with merge commits, since GitHub refuses `gh pr merge` for a stack member; each request pins the accepted head with `expected_head_sha` and is polled until GitHub confirms it before the next member. If an upper member fails, the target reports `merge FAIL` while confirmed lower members retain successful merge evidence. Inspect each member with `task show ID` and check its PR state; fix the refusal or wait for queued merges to complete. Sync the idle remaining chain when needed with `stack sync ID`; changed heads need rework, a new submission, passing gates, review and acceptance. Refresh stale gates and retry `merge ID` on the target; confirmed lower members are skipped. Records `merge`; then removes the task's worktree unless it has uncommitted changes, a worker or reviewer still running, or `merge.keep_branch` is set ([state](state.md))", run: run('../lib/automation', 'merge') },

  { section: 'Run', name: 'msg', pos: ['TEXT...'], usage: '--to NAME [--task ID] [--steer] TEXT', summary: 'send a worker message through the event log', flags: { to: str('NAME', 'recipient, usually orchestrator'), task: str('ID', 'task (default TOWER_CRANE_TASK)'), steer: bool('deliver into the running turn where the harness can, not after it') }, required: ['to'], run: run('../lib/events', 'message') },

  { section: 'Run', name: 'owner-done', pos: ['ID'], usage: 'ID [--note T]', summary: 'the owner did what needs_owner asked; clears it', flags: { note: str('T', 'what was done') }, description: "the owner did what `needs_owner` asked; clears it. Operational: the orchestrator or the owner", run: T.ownerDone },

  { section: 'Run', name: 'owner-key', summary: 'owner only: create the owner key that stands in for a terminal; prints its path, never the key', description: "the owner, explicitly and at a terminal or with the current key, creates the key under the project's recorded `owner_config_dir` and prints `created PATH` or `exists PATH`; never prints the key. An unbound project requires a terminal owner to record the directory first. `TOWER_CRANE_OWNER_KEY` with its contents stands in for a terminal ([Agent identity](state.md#agent-identity))", run: run('../lib/authority', 'ownerKey') },

  { section: 'Plan', name: 'plan import', pos: ['FILE'], usage: 'FILE', summary: 'add tasks from a JSON array (ids may be local names, resolved in order; - reads stdin)', description: "add tasks from a JSON array of task objects (ids may be local names, resolved in order; `-` reads stdin). Fields: `id`, `title`, `acceptance`, `kind`, `needs`, `size`, `tier`, `depends_on`, `needs_owner`, `locks`, `environment`; `needs_owner` is trimmed and blank values store null. A dependency names an earlier entry or an existing task. Any bad entry refuses the whole file", run: T.planImport },

  { section: 'Plan', name: 'project set', usage: '[--name N] [--goal G] [--repo O/R] [--base B] [--workers N] [--lease-minutes MIN] [--budget-hours H|null] [--budget-tokens N|null] [--standards S] [--tests-cmd CMD] [--clean-cmd CMD] [--tests-proof-cmd CMD] [--executors N] [--tests-timeout-min MIN] [--clean-timeout-min MIN] [--tests-paths JSON] [--tests-keep JSON] [--tests-host-only JSON] [--tests-mode MODE] [--tests-by-kind JSON] [--tests-expensive JSON] [--tests-map JSON] [--ci-ignore-apps JSON] [--ci-required JSON] [--ci-capped-review JSON] [--ci-local JSON] [--merge-keep-branch JSON] [--merge-admin JSON] [--review-policy JSON] [--research-min-sources N] [--sandbox JSON] [--env JSON] [--env_file FILE] [--scope JSON]', summary: 'change project settings, limits and budget', flags: SETTINGS, description: "change settings, limits and budget; `--budget-hours null` and `--budget-tokens null` remove a limit through the owner-required budget-raise path", run: P.projectSet },

  { section: 'Plan', name: 'project show', summary: 'print project settings and the ladder', description: "print settings, including `gates.tests_cmd`, `gates.clean_cmd`, `gates.tests_proof_cmd`, `gates.executors`, `gates.tests_timeout_min`, `gates.clean_timeout_min`, `tests.paths`, `tests.keep`, `tests.host_only`, `tests.mode`, `tests.by_kind`, `tests.expensive`, `tests.map`, `ci.ignore_apps`, `ci.required`, `ci.local`, `merge.keep_branch`, `merge.admin` and `decision_delegation.orchestrator_technical`, and the resolved ladder", run: P.projectShow },

  { section: 'Run', name: 'ready', usage: '[--all]', summary: 'ready tasks, those that unblock the most first; --all adds blocked ones with the reason', flags: { all: bool('also list blocked tasks and why') }, description: "ready tasks in priority order (the ones that unblock the most work first), excluding tasks whose locks another task holds, plus claims whose spawned process exited without submit and their log tails; `--all` lists blocked ones with the reason. Ready JSON includes `locks` and `environment`", run: T.ready },

  { section: 'Run', name: 'recover', pos: ['ID'], usage: 'ID', summary: 'recover a ranged task after quality failure; climb or ask the owner at the top', description: 'ranged quality recovery: climb after a failed latest review or confirmed tests, clean or CI gate failure; dispatch fresh, retry a pending climb, or open an owner decision at the range top; wait for verified worker process-group cleanup before dispatch', run: run('../lib/escalation', 'recover') },

  { section: 'Run', name: 'release', pos: ['[ID]'], usage: 'ID --reason R | --dead', summary: 'give a claimed task back; it returns to todo or rework', flags: { reason: str('R', 'why'), dead: bool('release every claim verified exited, rechecking under the lock') }, description: "`--dead` recovers every claim the shared process detector verifies exited; remote or unobservable processes stay claimed. The worker broker refuses this unscoped batch; workers use `release ID --reason R` on their own task. Otherwise give it back; status returns to its prior `todo` or `rework`. The claimant or the owner (owner-required: the orchestrator's attempt opens a decision); any agent may recover a spawned claim verified exited by the shared detector under the lock. Preserves only pid, log path, exit code and log size in a note and the release event", run: T.release },

  { section: 'Views', name: 'render', summary: 'write sketch.md and sketch.html (self-contained, no network)', description: "write `sketch.md` (Mermaid graph plus tables) and `sketch.html`, the board as a read-only snapshot, from the state as it stands under the lock", run: R.render },

  { section: 'Run', name: 'renew', pos: ['ID'], usage: 'ID [--lease MIN]', summary: 'extend your lease; an expired one only while the workers limit has room', flags: { lease: int('MIN', 'new lease length from now') }, description: "extend the lease from now; only the claimant. An expired lease must pass the claim checks again (unmet dependency, owner blocker, open decision, resource lock, workers limit), so a refused renewal leaves it expired", run: T.renew },

  { section: 'Run', name: 'rework', pos: ['[ID]'], usage: 'ID --reason R | --from-review ID', summary: "send back; the reason goes into the brief's rework notes", flags: { reason: str('R', 'what to fix'), 'from-review': str('ID', 'use the latest failed review at the current head and revision') }, description: "`--from-review ID` fetches all issue-comment pages for the linked PR and selects the last `Review (Tower Crane` body at the submitted SHA, preserving every finding and its comment link in the reason. Unposted reviews use their evidence summary. A linked review that cannot be fetched or matched refuses without changing state; the head, revision and latest failed evidence are rechecked under the lock after fetching. Otherwise send a submitted or accepted task back and bump `revision`, invalidating earlier evidence even at the same sha; the reason is appended under `## Rework notes` in its brief and as a task note", run: T.rework },

  { section: 'Views', name: 'serve', usage: '[--port P]', summary: 'serve the sketch and a Settings view for the ladder and task tiers on 127.0.0.1; pages reload when the state changes', flags: { port: int('P', 'port (default 4747; 0 picks a free one)') }, description: "serve the live board and a Settings view on 127.0.0.1 (default port 4747; 0 picks a free one) and update open pages over server-sent events when the state changes. Pages are rendered from the state on each request. As the owner it also prints a one-time link to open in the browser that will write (`--json` prints `{ url, state, open }`; `open` is `url` for other identities). Exits 1 if the port is in use", run: run('../lib/serve', 'serve') },

  { section: 'Agents and worktrees', name: 'spawn', usage: '(--task ID | --ready) [--role RUNG] [--dry-run] [--wait]', summary: "start a rung's harness in the task's worktree (the task's tier unless --role names a rung); prints the pid, or the command with --dry-run", flags: { ready: bool('dispatch ready todo and rework tasks without a live worker within the worker limit'), task: str('ID', 'task id'), role: str('RUNG', "ladder rung, such as review (default: the task's tier)"), 'dry-run': bool('print the command instead of running it'), wait: bool('run in the foreground and exit with its code') }, description: "`--ready` dispatches ready todo and rework tasks without a live worker, serially within the worker limit. Each dispatch rechecks readiness and worker identity under the existing spawn lock. Otherwise start a rung's harness in the task's worktree with the brief and task as the prompt: the rung of the task's tier, or the rung `--role` names (`--role review` for a review); sets `TOWER_CRANE_STATE`, `TOWER_CRANE_TASK`, `TOWER_CRANE_AGENT`; logs to the state directory; prints the pid or, with `--dry-run`, the command. A claude, codex, agy or pi rung runs under its role's agent file in a config home of its own (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR` or agy HOME); `--dry-run` prints a `#` line naming the agent file, the home, the MCP servers and the opted-in tools, and `--json` adds them as `home`. Every `--dry-run` also prints a `# rules:` line with the house rules files, how each reaches the agent and their size, and the prompt size; `--json` adds them as `startup`, the same record the `startup` event keeps. Claude/Codex reviewers receive the role skill, house-rule contents, standards and review contract sections in system context, with task JSON, review brief, gate receipts and diff in the user message. Claude writes it to `system.md` in its home and passes `--append-system-prompt-file` and `--exclude-dynamic-system-prompt-sections`; Codex writes its generated `AGENTS.md`. Every Claude spawn sets `FORCE_PROMPT_CACHING_5M=1`. Claude/Codex reviewer startup receipts add `system_bytes` and `system_tokens`. The rung is resolved again from the state read under the lock, so a tier or ladder change made while spawn created the worktree is the one that runs", run: run('../lib/spawn', 'spawn') },

  { section: 'Run', name: 'spend', pos: ['ID'], usage: 'ID [--minutes N] [--tokens N] [--input N] [--cached N] [--cache-write N] [--output N] [--rung R] [--harness H] [--model M] [--from-spawn AGENT]', summary: 'record usage or collect an exited spawn once', flags: { minutes: int('N', 'minutes spent'), tokens: int('N', 'total tokens, including cached input'), input: int('N', 'input tokens, including cached input'), cached: int('N', 'cache read tokens (subset of input)'), output: int('N', 'output tokens, including reasoning'), rung: str('R', 'ladder rung for native usage'), harness: str('H', 'actual harness (default: rung harness)'), model: str('M', 'actual model (default: rung model)'), 'cache-write': int('N', 'cache write input tokens, included in --input and separate from --cached'), 'from-spawn': str('AGENT', 'collect an exited spawn from its captured log and session, once'), }, description: "add spend, with optional native-agent usage breakdown and metadata; rung defaults the harness, model and profile from the current ladder. Model IDs are trimmed and case-folded; provider prefixes remain distinct. Collect an exited spawn's captured usage once per route and fresh retry invocation; resumed retries share their session's cumulative usage. Retry a failed monitor or enrich an unknown/partial entry when telemetry arrives. Refuses a live process or an unknown spawn; cannot be mixed with manual spend", run: T.spend },

  { section: 'Agents and worktrees', name: 'stack link', pos: ['ID'], usage: 'ID', summary: 'link submitted dependency PRs bottom to top (automatic after spawned submissions)', description: "link a submitted task's dependency chain on GitHub, bottom to top", run: run('../lib/stack', 'link') },

  { section: 'Agents and worktrees', name: 'stack sync', pos: ['ID'], usage: 'ID', summary: 'refresh an idle stack with gh stack sync; changed heads or conflicts require rework', description: "import remote tracking with `gh stack checkout <pr> --print-path`, then run `gh stack sync` from the task worktree, without prompts", run: run('../lib/stack', 'sync') },

  { section: 'Agents and worktrees', name: 'stack unstack', pos: ['ID'], usage: 'ID', summary: 'disable a stack for ordinary merges; lower tasks must land first', description: "remove the GitHub stack and local tracking, confirm no member remains stacked, then use ordinary merges in dependency order", run: run('../lib/stack', 'unstack') },

  { section: 'Agents and worktrees', name: 'stack webhook', pos: ['FILE'], usage: 'FILE', summary: 'record a pull_request webhook stack object; - reads stdin', description: "ingest a trusted `pull_request` webhook payload for this project's repository; `-` reads stdin. Record `pull_request.stack` or the payload's top-level `stack` without changing acceptance or merge evidence", run: run('../lib/stack', 'webhook') },

  { section: 'Views', name: 'status', summary: 'one screen: counts, ready tasks, gate queue, open decisions, owner tasks, spend, expired leases, exited spawned claims', description: "one screen: counts by status, ready tasks, the gate queue (running tasks, then queued tasks in the order executors take them, with any `gates prioritize` reason, then tasks blocked behind their own running reaction), blocked required gates when their test or cleanup command is unpinned, open decisions, owner tasks, spend against budget, live spend of running agents with its freshness (`live`, `stale` or `unavailable`; JSON `spend.live`), expired leases, claims whose spawned process exited without submit and their log tails", run: R.status },

  { section: 'Run', name: 'submit', pos: ['ID'], usage: 'ID --sha S [--branch B] [--pr N] [--summary T]', summary: 'mark submitted as the claimant or replace a submitted head as its submitter', flags: { sha: str('S', 'commit to review'), branch: str('B', 'branch holding it'), pr: int('N', 'pull request number'), summary: str('T', 'what changed') }, required: ['sha'], description: "mark submitted as the claimant or replace a submitted head as its submitter. `S` is 7 to 64 hex characters. For a task with a recorded PR, an open PR blocks changing its PR number or head branch. After it is closed or merged, a new PR supplies its head branch unless `--branch` is given and matches it", run: T.submit },

  { section: 'Plan', name: 'task add', usage: '--title T --acceptance A [--acceptance A2] [--kind K] [--needs JSON] [--size S] [--tier T] [--dep ID] [--lock NAME]... [--environment LABEL] [--needs-owner REASON]', summary: 'add a task; prints its id', flags: TASK_FIELDS, required: ['title', 'acceptance'], description: "add a task; prints its id. A `needs_owner` reason is trimmed; a blank value stores null. `T` is `easy`, `medium`, `hard`, `research` or an ascending range such as `easy..medium`; without it the tier comes from kind and size (state.md). `--needs '[\"browser\"]'` declares browser capability. Refused for an unknown dependency or capability. Repeat `--lock` for exclusive resources", run: T.taskAdd },

  { section: 'Plan', name: 'task list', usage: '[--status S]', summary: 'list tasks (S: a status, ready or blocked)', flags: { status: str('S', 'todo, in_progress, submitted, accepted, rework, cancelled, ready or blocked') }, description: "read; `S` is a status, `ready` or `blocked`", run: T.taskList },

  { section: 'Plan', name: 'task note', pos: ['ID', 'TEXT...'], usage: 'ID TEXT', summary: 'append a note', run: T.taskNote },

  { section: 'Plan', name: 'task show', pos: ['ID'], usage: 'ID', summary: 'show one task with its gates, evidence and notes', description: "read; `S` is a status, `ready` or `blocked`", run: T.taskShow },

  { section: 'Plan', name: 'task update', pos: ['ID'], usage: 'ID [--title T] [--acceptance A]... [--dep ID]... [--lock NAME]... [--environment LABEL] [--size S] [--kind K] [--needs JSON] [--tier T] [--needs-owner REASON] [--ci-local JSON] [--budget-hours H|null] [--budget-tokens N|null] [--interrupt] [--status cancelled]', summary: "change a task; acceptance, dependency or capability changes bump its revision (--dep '' clears dependencies); live requirements changes need --interrupt; an accepted task's material settings wait for rework", flags: { ...TASK_FIELDS, acceptance: many('A', 'replaces all acceptance lines'), dep: many('ID', "replaces all dependencies; '' clears them"), lock: many('NAME', "replaces all locks; '' clears them; changes require no live lease or reservation"), 'needs-owner': str('REASON', "what the owner has to do; '' clears it; clearing or replacing an existing request is operational (orchestrator or owner)"), 'ci-local': str('JSON', 'operational (orchestrator or owner): local CI override with command or args and optional timeout; null restores kind or default policy'), 'budget-hours': { ...SETTINGS['budget-hours'], help: "the task's hours budget; null removes the limit; lowering is operational, raising is owner-required" }, 'budget-tokens': { ...SETTINGS['budget-tokens'], help: "the task's token budget; null removes the limit; lowering is operational, raising is owner-required" }, interrupt: bool('operational (orchestrator or owner): stop and release a live claim before changing requirements'), status: str('cancelled', 'cancel the task') }, description: "change a task; acceptance, dependency or capability changes bump `revision`. A live claim refuses changes to acceptance, dependencies, `--needs`, kind or the local CI override unless `--interrupt` stops it first (see `interrupt`); notes, title, size, tier and priority never stop a run. `--needs '[]'` clears capabilities, `--dep ''` clears dependencies, `--needs-owner ''` clears the owner ask. `--lock` replaces all resource locks; `--lock ''` clears them. Lock changes require no live lease or dispatch reservation. `--environment ''` clears the label. Changing `--tier`, and clearing or replacing an existing owner ask, are operational (the orchestrator or the owner); any agent may set a new ask or keep the same reason. Changing `--kind` is operational, except that leaving `code` is owner-required and a submitted or accepted task refuses any kind change until `rework` ([Authority](state.md#authority)). Cancelling a task that has an owner ask is owner-required. `--ci-local` sets or clears an operational local CI override. Refused if it would form a cycle. An accepted task cannot be cancelled, and its acceptance, dependencies, capabilities, kind and local CI override change only after `rework`. `--budget-hours`, `--budget-tokens` set the task's budget, enforced on live usage like the project budget; `null` removes the limit. Lowering is operational; raising or removing a finite limit is owner-required. Cancelling removes the task's worktree as `merge` does, keeping it when it has uncommitted changes, a worker or reviewer still running, or `merge.keep_branch` is set", run: T.taskUpdate },

  { section: 'Plan', name: 'validate', summary: 'report plan and ladder errors (exit 1 if any); warn when an open task has no runnable reviewer', description: "report cycles, unknown dependencies, tasks without acceptance, `L` tasks without a `split:` note, oversize budgets (planned hours at S=1, M=4, L=8 over `budget.hours`, or spend over either budget); exit 1 if anything is reported. It reconciles tasks.json with `events.jsonl` and reports drift: tasks or task notes the log records that tasks.json lacks, and a `next` the log has already used. It also reports every ladder rung that cannot run, and warns per open task when no reviewer rung can run", run: T.validate },

  { section: 'Run', name: 'wait', usage: '[--after CURSOR] [--for NAME] [--task ID] [--types TYPES] [--timeout SEC | --follow] [--observe] [--inbox]', summary: 'block until one matching event; print one JSON line (timeout exits 2); --follow prints an id-only line per event until interrupted', flags: { inbox: bool('refresh actionable inbox findings at startup and each minute; emit deduplicated wakeups'), after: str('CURSOR', 'event id or byte offset (default now)'), for: str('NAME', 'recipient (default orchestrator)'), task: str('ID', 'only this task or decisions blocking it'), types: str('TYPES', "comma-separated event types; 'all' adds renew, spend and other bookkeeping"), timeout: num('SEC', 'maximum wait in seconds'), follow: bool('keep running; one line of ids per event, no detail'), observe: bool('watch only; run no software reactions or startup reconciliation') }, run: run('../lib/events', 'wait') },

  { section: 'Agents and worktrees', name: 'worktree', pos: ['ID...'], usage: 'ID [ID ...]', summary: 'prepare task worktrees serially from one fetched base before dispatch', description: "create (or print) a git worktree and branch `tower-crane/<id>-<slug>` from the freshest base for each task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`; records the branch on the task. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it", run: run('../lib/worktree', 'worktree') },
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
  lines.push('run tower-crane <command> --help for its options; docs/cli.md and docs/state.md hold the contract');
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
  const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  let resolved;
  let jsonOut = argv.includes('--json');
  try {
    resolved = resolveCommand(argv);
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
    const authority = require('../lib/authority');
    const ownerConfigDir = identity === 'owner'
      ? authority.checkOwner(process.env, ownerCredential, ownerTerminal, () => authority.ownerProject(locate()), cmd.name === 'init')
      : undefined;
    // Check the resolved identity before forwarding; the broker separately
    // verifies requests against the identity it spawned.
    if (process.env.TOWER_CRANE_BROKER && !require('../lib/broker').READS.has(cmd.name)) {
      const input = argv.includes('-') ? readStdin() : undefined;
      const res = await require('../lib/broker').forward(process.env.TOWER_CRANE_BROKER, argv, locate(), input);
      if (res) {
        process.stdout.write(res.stdout || '');
        process.stderr.write(res.stderr || '');
        return res.code;
      }
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
      stateDir: cmd.name === 'mcp' ? undefined : locate(),
      ...(cmd.name === 'mcp' ? { resolveStateDir: locate } : {}),
    };
    const res = await cmd.run(ctx);
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    return Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
  });
}

module.exports = { main, COMMANDS, GLOBAL, resolveCommand, parseOptions };
