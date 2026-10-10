'use strict';

// Who may change what. The owner hands the run to an orchestrator, so the
// settings that run a project day to day are operational: the orchestrator
// changes them under its own identity. Settings that widen what an agent can
// reach, spend more, hand out orchestrator authority or publish outside the
// repository are owner-required: the orchestrator's attempt opens a decision
// for the owner instead. Workers and reviewers change neither; they ask the
// orchestrator. Some changes no identity may make, such as a kind change on a
// submitted task, are refused outright. docs/state.md#authority carries the same table.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { refuse, nowIso } = require('./util');

const OPERATIONAL = 'operational';
const OWNER = 'owner-required';
// For a refused setting the description is the refusal itself.
const REFUSED = 'refused';

const TABLE = {
  'gates.tests_cmd': [OPERATIONAL, 'project set --tests-cmd'],
  'gates.clean_cmd': [OPERATIONAL, 'project set --clean-cmd'],
  'gates.tests_proof_cmd': [OPERATIONAL, 'project set --tests-proof-cmd'],
  'gates.executors': [OPERATIONAL, 'project set --executors'],
  'gates.tests_timeout_min': [OPERATIONAL, 'project set --tests-timeout-min'],
  'gates.clean_timeout_min': [OPERATIONAL, 'project set --clean-timeout-min'],
  // Moves one task's already queued gate reactions ahead of older queued work.
  'gates.priority': [OPERATIONAL, 'gates prioritize ID --reason R'],
  'ci.required': [OPERATIONAL, 'project set --ci-required'],
  'ci.ignore_apps': [OPERATIONAL, 'project set --ci-ignore-apps'],
  'ci.capped_review': [OPERATIONAL, 'project set --ci-capped-review'],
  'ci.local': [OPERATIONAL, 'project set --ci-local, task update --ci-local'],
  'tests.paths': [OPERATIONAL, 'project set --tests-paths'],
  'tests.keep': [OPERATIONAL, 'project set --tests-keep'],
  'tests.mode': [OPERATIONAL, 'project set --tests-mode'],
  'tests.by_kind': [OPERATIONAL, 'project set --tests-by-kind'],
  'tests.expensive': [OPERATIONAL, 'project set --tests-expensive'],
  'tests.map': [OPERATIONAL, 'project set --tests-map'],
  'limits.workers': [OPERATIONAL, 'project set --workers'],
  'limits.lease_minutes': [OPERATIONAL, 'project set --lease-minutes'],
  'limits.paused': [OPERATIONAL, 'project set --paused'],
  'budget.lower': [OPERATIONAL, 'project set or task update --budget-hours, --budget-tokens to a lower limit'],
  // The supervisor acts for the orchestrator: a spawn whose live usage crosses
  // a project or task budget is stopped and the owner is asked to raise it.
  'budget.stop': [OPERATIONAL, 'stop a spawn whose live usage crosses a project or task budget'],
  'merge.keep_branch': [OPERATIONAL, 'project set --merge-keep-branch'],
  review: [OPERATIONAL, 'project set --review-policy'],
  // A harness or args that drop a rung's sandbox, on a primary or a personal
  // fallback route that follows it, is ladder.reach (lib/project.js unconfinedRoutes).
  'ladder.harness': [OPERATIONAL, 'ladder harness, ladder set --harness, among claude and codex for a sandboxed role'],
  'ladder.model': [OPERATIONAL, 'ladder set --model'],
  'ladder.profile': [OPERATIONAL, 'ladder set --profile'],
  'ladder.provider': [OPERATIONAL, 'ladder set --provider'],
  'ladder.effort': [OPERATIONAL, 'ladder set --effort'],
  'ladder.args': [OPERATIONAL, 'ladder set --args'],
  'ladder.supervision': [OPERATIONAL, 'ladder set --supervision'],
  // Tools and MCP servers are operational under two conditions lib/project.js
  // enforces; the owner can overrule them. An opted-in MCP server must
  // already be defined in the owner's own harness config, never a new
  // command. A tool must be a harness built-in that leaves the rung's sandbox
  // confinement (write paths, env, scope, network) unchanged; other tools are
  // ladder.reach.
  'ladder.tools': [OPERATIONAL, 'ladder set --tools, harness built-ins that keep the rung sandbox'],
  'ladder.mcp': [OPERATIONAL, "ladder set --mcp, servers the owner's harness config already defines"],
  // Saves only the default harness and rungs the project defines (lib/project.js ladderSaveUser).
  'ladder.save_user': [OPERATIONAL, 'ladder save-user, the default for new projects'],
  'ladder.fallbacks': [OPERATIONAL, 'ladder set --fallbacks, --clear fallbacks; route fields retain their individual authority classes'],
  'task.kind': [OPERATIONAL, 'task update --kind, other than leaving code (task.downgrade)'],
  // Leaving code drops the tests and clean gates, so only the owner does it.
  'task.downgrade': [OWNER, 'task update --kind from code to docs, research, design or ops'],
  // What a submitted or accepted task was reviewed as stays that kind until rework.
  'task.kind.submitted': [REFUSED, 'task update --kind on a submitted or accepted task is refused; rework the task first with tower-crane rework <id> --reason R'],
  'task.tier': [OPERATIONAL, 'task update --tier'],
  // Stops a live run; the claim and its worktree stay for the next dispatch.
  'task.interrupt': [OPERATIONAL, 'interrupt, task update --interrupt with a live claim whose requirements change'],
  'task.needs_owner': [OPERATIONAL, 'owner-done, task update --needs-owner clearing or replacing a reason'],
  // A task that waits on the owner is cancelled by the owner, or not at all.
  'task.cancel_needs_owner': [OWNER, 'task update --status cancelled on a task with an owner ask'],
  // lib/tasks.js checks the reviewer state at the submitted head: a capped
  // review run in its CI evidence, or a review spawn that exited without a verdict.
  'waive.review': [OPERATIONAL, 'accept --waive review, for a capped or down reviewer'],
  'waive.review_live': [OWNER, 'accept --waive review when no reviewer is capped or down at the submitted head'],
  'merge.admin': [OWNER, 'project set --merge-admin'],
  decision_delegation: [OWNER, 'project set --decision-delegation'],
  'decision.delegate': [OWNER, 'decision delegate --answerers, --technical'],
  'claim.release': [OWNER, "release of another agent's claim while its process may still run"],
  sandbox: [OWNER, 'project set or ladder set --sandbox'],
  env: [OWNER, 'project set or ladder set --env'],
  env_file: [OWNER, 'project set or ladder set --env_file'],
  scope: [OWNER, 'project set or ladder set --scope'],
  'ladder.command': [OWNER, 'ladder set --command, the program a rung runs'],
  'ladder.web_mcp': [OWNER, 'ladder set --web-mcp or --clear web_mcp, the explicit research web server command and tools'],
  'research.min_sources': [OWNER, 'project set --research-min-sources'],
  'ladder.reach': [OWNER, 'ladder set --tools opting in to a tool that is not a harness built-in or that changes the rung sandbox (claude Edit, Write, NotebookEdit; codex memories, plugins, apps, browser_use, computer_use; agy file edits and subagents; pi edit, write); ladder set or ladder harness moving a worker, reviewer or small rung, or a user-file fallback route that follows its harness, off claude and codex, which enforce a sandbox; args on a harness other than claude and codex'],
  'budget.raise': [OWNER, 'project set or task update --budget-hours, --budget-tokens to a higher or no limit'],
  delegation: [OWNER, 'spawn --role orchestrator, which hands orchestrator authority to a new agent'],
  'waive.tests': [OWNER, 'accept --waive tests'],
  'waive.clean': [OWNER, 'accept --waive clean'],
  'waive.sources': [OWNER, 'accept --waive sources'],
  'waive.ci': [OWNER, 'accept --waive ci'],
  browser_kit: [OWNER, 'browser-kit set, MCP servers given to browser tasks in every project'],
  publish: [OWNER, 'ask --setting publish: anything that publishes outside the repository, such as a release or a package; the orchestrator publishes once the owner approves'],
};

const SPAWNS = ['spawn', 'spawn retry', 'spawn fallback'];

function classOf(setting) {
  const row = TABLE[setting];
  if (!row) throw new Error(`no authority class for ${setting}`);
  return row[0];
}

// A native permission renderer can keep a role confined without OS isolation.
// Its capability comes from the harness adapter, not from the home opt-in list.
function unconfinedRoute(job, route) {
  const A = require('./agents');
  if (A.CAPABILITIES[route.harness]?.sandbox === true) return false;
  return A.load(job).sandbox || (route.args || []).length > 0;
}

// An agent name some spawn started is that spawn's role and no other: a name
// ever started as a worker or reviewer never becomes the orchestrator.
// Unspawned, only the name orchestrator is; the owner's own session acts as
// owner.
function isOrchestrator(agent, events = []) {
  const jobs = events.filter((e) => SPAWNS.includes(e.cmd) && e.detail?.agent === agent).map((e) => e.detail.role);
  if (jobs.length) return jobs.every((role) => role === 'orchestrator');
  return agent === 'orchestrator';
}

// The verified identity name or null. The CLI checks the owner credential,
// terminal and process identity before calling this. A task or broker process
// never gets owner here. Other identities must agree with TOWER_CRANE_AGENT.
// Task and broker commands must match their bound name, so --agent cannot
// replace the process identity. An owner session may select an orchestrator identity. A broker
// command is never the orchestrator.
function actor(ctx, events) {
  if (!ctx.agentExplicit || typeof ctx.agent !== 'string' || !ctx.agent.trim()) return null;
  const identity = ctx.agent.trim();
  const started = ctx.env?.TOWER_CRANE_AGENT?.trim();
  const broker = ctx.env?.TOWER_CRANE_VIA === 'broker';
  const taskBound = ctx.env?.TOWER_CRANE_TASK !== undefined || broker;
  if (identity === 'owner') return taskBound ? null : identity;
  if (taskBound && started !== identity) return null;
  if (started && started !== identity && !(started === 'owner' && isOrchestrator(identity, events))) return null;
  if (broker && isOrchestrator(identity, events)) return null;
  return identity;
}

// The side of the table the verified identity acts on: owner, orchestrator or
// null for workers, reviewers, broker commands and anything unverified.
function role(ctx, events = []) {
  const identity = actor(ctx, events);
  if (identity === 'owner') return 'owner';
  return identity && isOrchestrator(identity, events) ? 'orchestrator' : null;
}

// Opens one decision for the owner per identical escalation, inside S.mutate.
function escalateQuestion(agent, st, emit, escalation, question, why, blocks = []) {
  const same = (d) => d.approval_request !== true && d.status === 'open' && d.escalation && JSON.stringify(d.escalation) === JSON.stringify(escalation);
  const found = st.decisions.decisions.find(same);
  if (found) return { decision: found, opened: false };
  const d = {
    id: `D${st.decisions.next}`, question, options: [], recommendation: null, why,
    blocks, status: 'open', answer: null, note: null, asked_by: agent, asked_at: nowIso(),
    answerers: [], technical: false, answered_by: null, answered_at: null, answer_rule: null, escalation,
  };
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  emit(null, { decision: d.id, question, blocks, escalation }, 'ask');
  return { decision: d, opened: true };
}

const RULE = 'owner identity needs a process the owner runs (docs/state.md#agent-identity)';

// Resolve the user's config directory only when establishing a project's
// binding. Later callers cannot select the credential that authenticates them.
function resolveOwnerConfigDir(env) {
  const dir = path.dirname(require('./ladder').userFile(env));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(dir);
}

function ownerProject(stateDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(stateDir, 'project.json'), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw);
}

function ownerKeyFile(project) {
  const dir = project?.owner_config_dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) {
    throw refuse(`${RULE}: project.json has no valid owner_config_dir; the owner must run tower-crane owner-key at a terminal`);
  }
  return path.join(dir, 'owner', 'key');
}

// Refuses resolving the identity owner unless the owner runs this process:
// never one started for a task or under another name, and only from an
// interactive terminal or with the owner key in TOWER_CRANE_OWNER_KEY.
function checkOwner(env, given, terminal, getProject, initializing = false) {
  if (env.TOWER_CRANE_TASK !== undefined) throw refuse(`${RULE}: TOWER_CRANE_TASK is set, and a task process never acts as owner`);
  const started = env.TOWER_CRANE_AGENT?.trim();
  if (started && started !== 'owner') throw refuse(`${RULE}: TOWER_CRANE_AGENT names ${started}, and a process started as another identity never acts as owner`);
  if (terminal) return;
  let project = getProject();
  let initialConfigDir;
  // First init establishes trust for new state only. init checks again under
  // the state lock and never replaces an existing project's binding.
  if (project === null && initializing) {
    initialConfigDir = resolveOwnerConfigDir(env);
    project = { owner_config_dir: initialConfigDir };
  }
  const file = ownerKeyFile(project);
  if (!given) throw refuse(`${RULE}: stdin and stdout are not a terminal and TOWER_CRANE_OWNER_KEY is unset; run it at a terminal, or present the key in ${file}`);
  let key;
  try { key = fs.readFileSync(file, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') throw refuse(`${RULE}: TOWER_CRANE_OWNER_KEY is set but ${file} does not exist; create it with tower-crane owner-key at a terminal`);
    throw e;
  }
  const a = crypto.createHash('sha256').update(given.trim()).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  if (!key || !crypto.timingSafeEqual(a, b)) throw refuse(`${RULE}: TOWER_CRANE_OWNER_KEY does not match the key in ${file}`);
  return initialConfigDir;
}

// Creates the owner key when none exists; prints where it is, never the key.
function ownerKey(ctx) {
  if (actor(ctx, []) !== 'owner') throw refuse('only the owner with an explicit identity creates the owner key; run tower-crane owner-key --agent owner at a terminal');
  const S = require('./state');
  let project = S.readJson(path.join(ctx.stateDir, 'project.json'));
  if (project.owner_config_dir === undefined) {
    if (!ctx.ownerTerminal) throw refuse(`${RULE}: only a terminal owner can establish owner_config_dir`);
    project = S.mutate(ctx, 'owner-key', (st, emit) => {
      if (st.project.owner_config_dir === undefined) {
        st.project.owner_config_dir = resolveOwnerConfigDir(ctx.env);
        emit(null, { owner_config_dir: st.project.owner_config_dir });
      }
      return st.project;
    });
  }
  const file = ownerKeyFile(project);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    created = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { data: { file, created }, text: `${created ? 'created' : 'exists'} ${file}` };
}

const list = (keys) => `${keys.join(', ')} ${keys.length > 1 ? 'are' : 'is'}`;

const APPROVE = 'approve';
const DECLINE = 'decline';

// The board and the CLI reach the same check; mode says which one the owner
// or orchestrator used.
const modeOf = (ctx) => (ctx.mode === 'board' ? 'board' : 'cli');

// One audit event per allowed change of guarded settings, whatever command or
// surface made it.
function audit(ctx, who, keys, emit, approved) {
  if (!emit || !keys.length) return;
  emit(null, {
    command: emit.cmd || null, actor: who, mode: modeOf(ctx),
    settings: Object.fromEntries(keys.map((k) => [k, classOf(k)])),
    ...(approved ? { approved_by: approved.id } : {}),
  }, 'setting');
}

const sameRequest = (escalation, settings, change) => JSON.stringify(escalation.settings) === JSON.stringify(settings)
  && JSON.stringify(escalation.change ?? null) === JSON.stringify(change ?? null);

// An escalation the owner approved and nobody has applied yet, for exactly
// this request: the owner's answer stands in for the owner making the change.
// A tagged question also escalates, but its answer authorizes no command.
function approval(st, settings, change) {
  return st.decisions.decisions.find((d) => d.approval_request === true && d.escalation && d.status === 'answered' && d.answer === APPROVE
    && d.answered_by === 'owner' && !d.applied && sameRequest(d.escalation, settings, change)) || null;
}

// Requests name fields; an owner may write additional fields in the same
// command. Ladder and rung objects group fields. Field values, including
// environment maps and fallback lists, are replacements and must match whole.
function matchesOwnerChange(requested, written, container = 'change', project = false) {
  if (!requested || !written || typeof requested !== 'object' || typeof written !== 'object'
    || Array.isArray(requested) || Array.isArray(written)) return isDeepStrictEqual(requested, written);
  if (container === 'change' && Object.hasOwn(requested, 'task') !== Object.hasOwn(written, 'task')) return false;
  return Object.entries(requested).every(([key, value]) => {
    if (!Object.hasOwn(written, key)) return false;
    if (container === 'change' && key === 'ladder') return matchesOwnerChange(value, written[key], 'ladder');
    if (container === 'ladder') return matchesOwnerChange(value, written[key], 'rung');
    // Reach requests list newly granted capabilities, not replacement fields.
    if (container === 'rung' && ['tools', 'unconfined'].includes(key)) {
      return Array.isArray(value) && Array.isArray(written[key])
        && value.every(grant => written[key].some(actual => isDeepStrictEqual(grant, actual)));
    }
    // Project owner fields encode JSON in CLI flags, except env_file's path.
    // Formatting that JSON differently still writes the same value.
    if (project && key !== 'env_file') {
      const decode = v => {
        if (typeof v !== 'string') return v;
        try { return JSON.parse(v); } catch { return v; }
      };
      return isDeepStrictEqual(decode(value), decode(written[key]));
    }
    return isDeepStrictEqual(value, written[key]);
  });
}

// Making the requested change settles it too. Keep this in the successful
// write, so a failed command cannot retire an approval the owner still needs.
function applyOwner(ctx, st, settings, change, emit) {
  const owner = [...new Set(settings)].filter((k) => classOf(k) === OWNER);
  if (!st || !owner.length) return;
  for (const d of st.decisions.decisions) {
    if (d.approval_request !== true || !d.escalation || d.applied) continue;
    if (!d.escalation.settings.every(key => owner.includes(key))
      || !matchesOwnerChange(d.escalation.change, change, 'change', emit?.cmd === 'project set')) continue;
    if (d.status !== 'open' && !(d.status === 'answered' && d.answer === APPROVE && d.answered_by === 'owner')) continue;
    if (d.status === 'open') {
      Object.assign(d, {
        status: 'answered', answer: APPROVE, note: 'The owner made the requested change.',
        answered_by: 'owner', answered_at: nowIso(), answer_rule: 'owner',
      });
      emit(null, { decision: d.id, choice: d.answer, note: d.note, blocks: d.blocks, answered_by: d.answered_by, answer_rule: d.answer_rule }, 'answer');
    }
    apply(ctx, d);
  }
}

// Whether an approved escalation for this task, sha and revision backs a
// recorded waiver, read from the event log as gate evidence is.
function approvedIn(events, id, setting, task, sha, revision) {
  const asked = events.find((e) => e.cmd === 'ask' && e.detail?.decision === id && e.detail.escalation);
  const change = asked?.detail.escalation.change;
  return !!asked && asked.detail.approval_request === true && asked.detail.escalation.settings.includes(setting)
    && change?.accept === task && change.sha === sha
    && Number.isInteger(revision) && revision > 0 && change.revision === revision
    && events.some((e) => e.cmd === 'answer' && e.agent === 'owner' && e.detail?.decision === id && e.detail.choice === APPROVE);
}

// Opens the owner's decision for an owner-required request, or returns the
// open one already asking for it.
function escalate(ctx, st, settings, change, emit) {
  const escalation = { settings, change };
  let d = st.decisions.decisions.find((x) => x.approval_request === true && x.status === 'open' && x.escalation && sameRequest(x.escalation, settings, change));
  if (d) return { decision: d, opened: false };
  const question = `${ctx.agent} asks the owner to change ${settings.join(', ')}${change ? `: ${JSON.stringify(change)}` : ''}`;
  d = {
    id: `D${st.decisions.next}`, question, options: [APPROVE, DECLINE], recommendation: null,
    why: `owner-required (docs/state.md#authority): ${APPROVE} lets the orchestrator make exactly this change once; ${DECLINE} or making it yourself also answers it`,
    blocks: [], status: 'open', answer: null, note: null, asked_by: ctx.agent, asked_at: nowIso(),
    answerers: [], technical: false, answered_by: null, answered_at: null, answer_rule: null, escalation, approval_request: true,
    ...(ctx.request ? { request: ctx.request } : {}),
  };
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  emit(null, { decision: d.id, question, blocks: [], escalation, approval_request: true }, 'ask');
  return { decision: d, opened: true };
}

// The settings a task update that sets kind needs. Changing kind of a task
// already submitted or accepted is refused, whoever asks. Leaving code is
// owner-required at any other status.
function kindSettings(task, kind) {
  if (kind === task.kind) return [];
  if (task.status === 'submitted' || task.status === 'accepted') return ['task.kind.submitted'];
  return [task.kind === 'code' ? 'task.downgrade' : 'task.kind'];
}

// Refuses who may not act; returns who did. Inside S.mutate, pass emit and
// commit: an allowed change is audited, and an orchestrator asking for an
// owner-required change either applies the owner's approval of that exact
// request, once, or opens a decision (once per identical request) and is
// refused, so nothing changes until the owner approves or makes it. change
// describes the request for the owner. keep leaves an approval unapplied for a
// command that marks it itself when its change lands; quiet leaves the audit to
// that command's later write. ownerWrite adds values for retiring requests
// when an owner's write has a different class now, such as a budget decrease.
// Stateful checks require an emitter unless quiet mode is explicit. A board
// request (ctx.requestApproval) from the owner goes through the same decision:
// the owner's approval of it is the change.
function enforce(ctx, st, settings, { change = null, ownerWrite = null, emit = null, commit = null, keep = false, quiet = false } = {}) {
  const keys = [...new Set(settings)];
  const who = role(ctx, st ? st.events : []);
  const refused = keys.find((k) => classOf(k) === REFUSED);
  if (refused) throw refuse(TABLE[refused][1]);
  if (st && (keys.length || ownerWrite) && !emit && !quiet) {
    throw new Error('stateful authority checks need an audit emitter or explicit quiet mode');
  }
  const owner = keys.filter((k) => classOf(k) === OWNER);
  if (who === 'owner' && owner.length && ctx.requestApproval) {
    const approved = approval(st, owner, change);
    if (approved) {
      if (!keep) apply(ctx, approved);
      if (!quiet) audit(ctx, who, keys, emit, approved);
      return who;
    }
    const { decision, opened } = escalate(ctx, st, owner, change, emit);
    if (opened) commit();
    const error = refuse(`Review ${decision.id} to approve or decline this change`);
    error.decision = decision.id;
    throw error;
  }
  if (who === 'owner' || (who === 'orchestrator' && !owner.length)) {
    if (who === 'owner' && !keep) {
      applyOwner(ctx, st, owner, change, emit);
      if (ownerWrite) applyOwner(ctx, st, ownerWrite.settings, ownerWrite.change, emit);
    }
    if (!quiet) audit(ctx, who, keys, emit);
    return who;
  }
  if (!keys.length) return who;
  if (who === 'orchestrator') {
    // Only init passes no state: nothing exists to hold a decision yet.
    if (!st) throw refuse(`${list(owner)} owner-required; init without ${owner.length > 1 ? 'them' : 'it'}, then the owner sets ${owner.length > 1 ? 'them' : 'it'} (tower-crane ask opens the decision once the project exists)`);
    if (!emit || !commit) throw refuse(`${list(owner)} owner-required; open a decision for the owner with tower-crane ask and wait for the answer`);
    const approved = approval(st, owner, change);
    if (approved) {
      if (!keep) apply(ctx, approved);
      if (!quiet) audit(ctx, who, keys, emit, approved);
      return who;
    }
    const { decision: d, opened } = escalate(ctx, st, owner, change, emit);
    // The owner's own Controls request for the same change is now this
    // orchestrator's to repeat, so the board leaves its approval for that
    // repeat instead of using it first (lib/board-controls.js).
    const joined = !opened && d.asked_by !== ctx.agent && !d.repeat_by;
    if (joined) d.repeat_by = ctx.agent;
    if (opened || joined) commit();
    throw refuse(`${list(owner)} owner-required; opened ${d.id} for the owner (escalation: ${owner.join(', ')}); wait for the answer with tower-crane wait --types decision-answer, then run the same command again once it is ${APPROVE}d`);
  }
  if (owner.length) {
    throw refuse(`only the owner with an explicit identity can change ${owner.join(', ')}; an agent requests this with tower-crane ask --setting ${owner.join(' --setting ')} --question Q, or a task note`);
  }
  throw refuse(`${list(keys)} operational: only the orchestrator or the owner changes ${keys.length > 1 ? 'them' : 'it'}; a worker or reviewer asks the orchestrator with tower-crane msg --to orchestrator or a task note`);
}

// An approval is used up by the change it allowed.
function apply(ctx, d) {
  d.applied = { at: nowIso(), by: ctx.agent };
}

// The table as data, for tower-crane authority and the board.
function rows() {
  return Object.entries(TABLE).map(([setting, [cls, how]]) => ({ setting, class: cls, how }));
}

function show() {
  const data = rows();
  const width = Math.max(...data.map((r) => r.setting.length));
  return { data, text: data.map((r) => `${r.setting.padEnd(width)}  ${r.class.padEnd(14)}  ${r.how}`).join('\n') };
}

module.exports = { TABLE, OPERATIONAL, OWNER, REFUSED, APPROVE, DECLINE, classOf, isOrchestrator, actor, role, kindSettings, enforce, escalate, escalateQuestion, approval, approvedIn, apply, applyOwner, matchesOwnerChange, audit, modeOf, rows, show, unconfinedRoute, resolveOwnerConfigDir, ownerProject, ownerKeyFile, checkOwner, ownerKey };
