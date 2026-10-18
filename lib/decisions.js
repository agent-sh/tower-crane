'use strict';

const { refuse, usage, nowIso, byId } = require('./util');
const S = require('./state');
const T = require('./tasks');
const Authority = require('./authority');

function asList(v) {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

function getDecision(st, id) {
  const did = T.normId(id, 'D');
  const d = st.decisions.decisions.find((x) => x.id === did);
  if (!d) throw refuse(`no decision ${id}; tower-crane decisions lists them`);
  return d;
}

function line(d) {
  const opts = d.options.length ? ` [${d.options.map((o) => (o === d.recommendation ? `${o}*` : o)).join(' | ')}]` : '';
  const blocks = d.blocks.length ? ` blocks ${d.blocks.join(', ')}` : '';
  const ans = d.status === 'answered' ? ` -> ${d.answer}` : d.status === 'withdrawn' ? ` withdrawn: ${d.withdraw_reason}` : '';
  return `${d.id.padEnd(4)} ${d.status.padEnd(9)} ${d.question}${opts}${blocks}${ans}`;
}

// ask --setting: the orchestrator's request for an owner-required change no
// other command makes, such as publish. It opens the same escalation a
// guarded command opens; once the owner approves, asking again applies the
// approval and the orchestrator goes ahead.
async function request(ctx) {
  const A = require('./authority');
  const f = ctx.flags;
  const settings = asList(f.setting);
  if (settings.length !== 1) throw usage('ask without --question needs exactly one --setting');
  const [setting] = settings;
  if (!Object.hasOwn(A.TABLE, setting)) throw usage(`unknown setting "${setting}"; tower-crane authority lists them`);
  if (A.classOf(setting) !== A.OWNER) throw refuse(`${setting} is operational: the orchestrator makes it with ${A.TABLE[setting][1]}`);
  // An approval asked for here is used up here, so a setting some command
  // changes is asked for by running that command.
  if (!A.TABLE[setting][1].startsWith('ask --setting')) throw refuse(`${setting} is changed by ${A.TABLE[setting][1]}; run that command, which opens the decision and applies the owner's approval`);
  for (const k of ['question', 'kind', 'crisis', 'option', 'recommend', 'why', 'blocks', 'owner-required']) if (f[k] !== undefined) throw usage(`ask --setting writes its own decision; drop --${k}`);
  let change = null;
  if (f.change !== undefined) {
    try {
      change = JSON.parse(f.change);
    } catch (e) {
      throw usage(`--change must be JSON describing the change (${e.message})`);
    }
  }
  // The publish policy's main CI condition reads the base's runs before the
  // write, as inbox does; the write judges every condition from that reading.
  const read = setting === 'publish' ? await require('./publish-policy').readMain(ctx) : null;
  let board = false;
  let policy = null;
  const d = S.mutate(ctx, 'ask', (st, emit, commit) => {
    const owner = A.actor(ctx, st.events) === 'owner';
    if (owner && !ctx.requestApproval) throw refuse(`the owner makes ${setting} changes directly; nothing to ask`);
    const approved = A.approval(st, [setting], change);
    // The owner's request from the board only approves; the orchestrator
    // makes the change, and its repeat of this ask uses the approval.
    board = owner && !!approved;
    if (board) return approved;
    const Policy = require('./publish-policy');
    policy = setting === 'publish' && !approved && A.role(ctx, st.events) === 'orchestrator' ? Policy.judge(st, change, read) : null;
    if (policy?.ok) {
      Policy.audit(ctx, st, emit, change, policy);
      return null;
    }
    const note = policy ? `the owner's publish policy did not hold: ${Policy.failedText(policy)}` : null;
    try {
      A.enforce(ctx, st, [setting], { change, emit, commit, note });
    } catch (e) {
      if (note) e.message = `${e.message}; ${note}`;
      throw e;
    }
    return approved;
  });
  if (board) return { data: d, text: `${setting}: you approved ${d.id}; the orchestrator uses it when it asks with the same details` };
  if (policy?.ok) return { data: { policy: policy.conditions, task: policy.task }, text: `${setting}: the owner's publish policy holds for ${policy.task} (${policy.conditions.map((c) => c.name).join(', ') || 'no conditions'}); go ahead` };
  return { data: d, text: `${setting}: the owner approved ${d.id}; go ahead` };
}

// The kind is what the asker says the question is. The orchestrator answers a
// technical one; spend, credential and setting questions are the owner's. The
// text of a question is never read, so a question is routed by its kind alone.
function create(st, emit, agent, fields) {
  const { question, options = [], blocks = [], kind = null } = fields;
  const ownerReason = fields.owner_required ?? null;
  const d = {
    id: `D${st.decisions.next}`,
    question,
    options,
    recommendation: fields.recommendation ?? null,
    why: fields.why ?? null,
    blocks: [...new Set(blocks)],
    status: 'open',
    answer: null,
    note: null,
    asked_by: agent,
    asked_at: nowIso(),
    answerers: [],
    kind,
    technical: fields.technical ?? (kind === 'technical' && !(fields.escalation || ownerReason)),
    answered_by: null,
    answered_at: null,
    answer_rule: null,
    owner_required: ownerReason,
  };
  if (fields.escalation) d.escalation = fields.escalation;
  if (fields.routed) d.routed = fields.routed;
  if (fields.crisis) d.crisis = fields.crisis;
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  const detail = { decision: d.id, question, blocks: d.blocks };
  if (d.escalation) detail.escalation = d.escalation;
  if (d.routed) detail.routed = d.routed;
  if (d.crisis) detail.crisis = d.crisis;
  emit(null, detail, 'ask');
  // A crisis is the one thing the engine tells the owner about unasked.
  if (d.crisis) emit(null, { to: 'owner', text: `crisis (${CRISES[d.crisis]}): ${question} (${d.id})` }, 'msg');
  return d;
}

// What the owner is told about: host stability, data, security and a broken
// published artifact. Everything else goes through policy, the orchestrator
// or automation.
const CRISES = {
  host: 'host stability: OOM, fork storm, disk full',
  data: 'data loss or state corruption',
  security: 'security: a leaked secret, a sandbox escape',
  artifact: 'a published artifact is broken',
};

// A credential question asks for one of these: a grant of a secret or access,
// or a looser sandbox. A host that misbehaves is not one.
const CREDENTIAL_GRANTS = ['env', 'env_file', 'sandbox', 'sandbox.session_bus', 'scope', 'ladder.reach', 'ladder.web_mcp'];

// The tests failure main shares that holds a task (T407): its latest tests
// evidence, at any revision, failed and every failing name also fails on the
// base. No change of the task's fixes it and no owner grant does either.
function sharedHostFailure(task) {
  const latest = task.evidence.findLast((e) => e.type === 'tests');
  return latest && !latest.ok && latest.main_failure ? latest.main_failure : null;
}

// A worker's or reviewer's question about a failure main shares is the
// orchestrator's: it waits for main's fix or a gate retry. Money, a crisis
// and a grant other than a gate waiver stay with the owner.
function hostRoute(st, ctx, blocks, kind, owner) {
  if (Authority.role(ctx, st.events) || ['spend', 'crisis'].includes(kind) || owner.some((k) => !k.startsWith('waive.'))) return null;
  for (const id of blocks) {
    const shared = sharedHostFailure(T.getTask(st, id));
    if (shared) return { to: 'orchestrator', task: id, base: shared.base, names: [...shared.names], asked_kind: kind, ...(owner.length ? { dropped: owner } : {}) };
  }
  return null;
}

function ask(ctx) {
  const f = ctx.flags;
  if (f.setting !== undefined && f.question === undefined) return request(ctx);
  if (f.change !== undefined) throw usage('--change goes with a setting request without --question');
  const question = (f.question || '').trim();
  if (!question) throw usage('ask needs --question');
  const kind = (f.kind || '').trim();
  if (!S.DECISION_KINDS.includes(kind)) {
    throw usage(`ask needs --kind ${S.DECISION_KINDS.join(', ')}; only technical is the orchestrator's to answer, the others are the owner's`);
  }
  const options = asList(f.option);
  if (new Set(options).size !== options.length) throw usage('--option values must be distinct');
  if (f.recommend !== undefined && options.length && !options.includes(f.recommend)) {
    throw usage(`--recommend must be one of the options (${options.join(', ')})`);
  }
  const settings = asList(f.setting);
  const unknown = settings.filter((key) => !Object.hasOwn(Authority.TABLE, key));
  if (unknown.length) throw usage(`--setting names no setting in lib/authority.js: ${unknown.join(', ')}`);
  const owner = settings.filter((key) => Authority.classOf(key) === Authority.OWNER);
  const ownerRequired = f['owner-required'] === undefined ? null : f['owner-required'].trim();
  if (ownerRequired === '') throw usage('--owner-required needs the reason the owner must decide');
  const crisis = f.crisis === undefined ? null : f.crisis.trim();
  if ((kind === 'crisis') !== (crisis !== null)) throw usage('--kind crisis and --crisis CLASS go together');
  if (crisis !== null && !Object.hasOwn(CRISES, crisis)) {
    throw usage(`--crisis must be one of ${Object.entries(CRISES).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }
  const decision = S.mutate(ctx, 'ask', (st, emit) => {
    const blocks = asList(f.blocks).map((id) => T.getTask(st, id).id);
    const routed = hostRoute(st, ctx, blocks, kind, owner);
    if (routed) {
      return create(st, emit, ctx.agent, {
        question, options, blocks, kind: 'technical', recommendation: f.recommend, why: f.why, routed: { ...routed, ...(ownerRequired ? { owner_required: ownerRequired } : {}) },
      });
    }
    if (kind === 'credential' && !settings.some((k) => CREDENTIAL_GRANTS.includes(k))) {
      throw usage(`--kind credential is for a request that grants a credential or loosens a sandbox: name it with --setting ${CREDENTIAL_GRANTS.join(', ')}; a host or harness that fails is technical, for the orchestrator`);
    }
    // A question that names an owner-required setting, that the asker marks
    // owner-required with a reason, or whose kind is not technical stays with
    // the owner. A technical question is answered by the orchestrator while the
    // project's decision-delegation setting allows; create() sets that flag.
    const escalation = owner.length ? { settings: owner, change: null } : null;
    return create(st, emit, ctx.agent, {
      question, options, blocks, kind, recommendation: f.recommend, why: f.why, escalation, owner_required: ownerRequired, crisis,
    });
  });
  const routed = decision.routed;
  return { data: decision, text: routed ? `${decision.id} (routed to the orchestrator: ${routed.task}'s tests failure also fails on main at ${routed.base})` : decision.id };
}

const CLOSED = ['accepted', 'cancelled'];

// The tasks a decision waits on: the ones it blocks, and the one an approval
// request would change. A re-record of a cancelled hotfix acts on tasks that
// are already cancelled, so its request names none.
function waitsOn(d) {
  const change = d.approval_request === true && !d.escalation.settings.includes('task.rerecord_review') ? d.escalation.change : null;
  const named = change && typeof change === 'object' ? [change.task, change.accept, change.release] : [];
  return [...new Set([...d.blocks, ...named.filter((id) => typeof id === 'string')])];
}

// An open decision whose every task is accepted or cancelled can change
// nothing any more. It closes in the write that closed the last of them,
// whoever made it, with the reason in its event; nobody has to withdraw it.
function closeMoot(st, emit) {
  for (const d of st.decisions.decisions) {
    if (d.status !== 'open') continue;
    const ids = waitsOn(d);
    const tasks = ids.map((id) => st.tasks.tasks.find((t) => t.id === id));
    if (!ids.length || tasks.some((t) => !t || !CLOSED.includes(t.status))) continue;
    const reason = `moot: ${tasks.map((t) => `${t.id} ${t.superseded_by ? `superseded by ${t.superseded_by}` : t.status}`).join(', ')}`;
    Object.assign(d, { status: 'withdrawn', withdraw_reason: reason, withdrawn_by: 'engine', withdrawn_at: nowIso(), moot: true });
    emit(null, { decision: d.id, reason, blocks: d.blocks, withdrawn_by: 'engine', moot: true }, 'decision withdraw');
  }
}

function answerersArg(text) {
  let answerers;
  try {
    answerers = JSON.parse(text);
  } catch {
    throw usage('--answerers must be a JSON array of distinct agent names');
  }
  if (!Array.isArray(answerers) || !answerers.every((agent) => typeof agent === 'string' && agent.trim())) {
    throw usage('--answerers must be a JSON array of distinct agent names');
  }
  answerers = answerers.map((agent) => agent.trim());
  if (new Set(answerers).size !== answerers.length) throw usage('--answerers must contain distinct agent names');
  if (answerers.some((agent) => ['owner', 'orchestrator'].includes(agent))) {
    throw usage('--answerers cannot include owner or orchestrator; they have separate answer rules');
  }
  return answerers;
}

function technicalArg(text) {
  let technical;
  try {
    technical = JSON.parse(text);
  } catch {
    throw usage('--technical must be true or false');
  }
  if (typeof technical !== 'boolean') throw usage('--technical must be true or false');
  return technical;
}

function delegate(ctx) {
  const f = ctx.flags;
  if (f.answerers === undefined && f.technical === undefined) {
    throw usage('decision delegate needs --answerers or --technical');
  }
  const answerers = f.answerers === undefined ? undefined : answerersArg(f.answerers);
  const technical = f.technical === undefined ? undefined : technicalArg(f.technical);
  const decision = S.mutate(ctx, 'decision delegate', (st, emit, commit) => {
    const d = getDecision(st, ctx.pos[0]);
    if (d.status !== 'open') throw refuse(`${d.id} is no longer open (${d.status}); delegation cannot be changed`);
    const change = { decision: d.id, ...(answerers !== undefined ? { answerers } : {}), ...(technical !== undefined ? { technical } : {}) };
    Authority.enforce(ctx, st, ['decision.delegate'], { change, emit, commit });
    if (technical !== undefined) {
      d.technical = technical;
      // The owner's technical call clears the asker's --owner-required reason and
      // lifts a spend, credential or setting kind. An escalation is cleared by its setting instead.
      if (technical) d.owner_required = null;
      // A decision with no kind has no flag that keeps it with the owner, so the keep is stored as a reason.
      if (!technical && !d.kind) d.owner_required = d.owner_required ?? 'the owner keeps it with the owner';
    }
    if (answerers !== undefined && answerers.length && ownerOnlyWhy(d)) {
      throw refuse(`${d.id} ${ownerOnlyWhy(d)}; only the owner answers it, so it cannot name answerers`);
    }
    if (answerers !== undefined) d.answerers = answerers;
    emit(null, { decision: d.id, answerers: d.answerers, technical: d.technical });
    return d;
  });
  return { data: decision, text: `${decision.id} answer delegation updated` };
}

function joinNames(names) {
  if (names.length < 2) return names[0] || '';
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

// Why only the owner answers a decision, or null. The owner's technical call
// lifts a kind and a reason; a decision with no kind is not held by its flag.
function ownerOnlyWhy(decision) {
  if (decision.escalation) return `escalates ${decision.escalation.settings.join(', ')} to the owner`;
  if (decision.owner_required) return `is owner-required (${decision.owner_required})`;
  if (decision.kind && decision.kind !== 'technical' && decision.technical !== true) return `is a ${decision.kind} decision`;
  return null;
}

// A decision with a kind is technical when its stored flag says so. One with no
// kind (opened before kinds were stored) is technical unless an escalation or a
// reason keeps it with the owner, which ownerOnlyWhy checks before this.
function isTechnical(decision) {
  return decision.kind ? decision.technical === true : true;
}

// Technical delegation is on unless the project sets orchestrator_technical to false.
function delegatesTechnical(st, decision) {
  return isTechnical(decision) && st.project.decision_delegation?.orchestrator_technical !== false;
}

// Whether the orchestrator may answer a decision now: no owner-only reason and technical delegation.
function orchestratorAnswers(st, decision) {
  return !ownerOnlyWhy(decision) && delegatesTechnical(st, decision);
}

function answerRule(st, decision, ctx) {
  const identity = Authority.actor(ctx, st.events);
  const owner = identity === 'owner';
  const orchestrator = Authority.isOrchestrator(identity, st.events);
  const ownerOnly = ownerOnlyWhy(decision);
  if (ownerOnly && !owner) throw refuse(`${decision.id} ${ownerOnly}; only the owner answers it`);
  if (owner) return 'owner';
  const technicalDelegation = delegatesTechnical(st, decision);
  if (orchestrator) {
    if (technicalDelegation) return 'owner-technical-delegation';
  } else if (identity && decision.answerers.includes(identity)) {
    return 'owner-named-agent';
  }

  const named = decision.answerers.filter((agent) => !Authority.isOrchestrator(agent, st.events));
  const allowed = ['the owner with explicit identity', ...named.map((agent) => `agent ${agent}`)];
  if (technicalDelegation) allowed.push('the orchestrator under technical delegation');
  throw refuse(`only ${joinNames(allowed)} can answer ${decision.id}`);
}

function answer(ctx) {
  const choice = (ctx.flags.choice || '').trim();
  if (!choice) throw usage('answer needs --choice');
  const decision = S.mutate(ctx, 'answer', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    const rule = answerRule(st, d, ctx);
    if (d.status !== 'open') throw refuse(`${d.id} is already ${d.status === 'answered' ? `answered (${d.answer})` : 'withdrawn'}; open a new decision with tower-crane ask to change course`);
    if (d.options.length && !d.options.includes(choice)) {
      throw refuse(`--choice must be one of ${d.options.join(', ')} for ${d.id}`);
    }
    d.status = 'answered';
    d.answer = choice;
    d.note = ctx.flags.note !== undefined ? ctx.flags.note : null;
    d.answered_by = ctx.agent;
    d.answered_at = nowIso();
    d.answer_rule = rule;
    // Workers read task notes, so the answer travels with each task it unblocks.
    for (const id of d.blocks) {
      const t = st.tasks.tasks.find((x) => x.id === id);
      if (t) t.notes.push({ at: d.answered_at, agent: ctx.agent, text: `decision ${d.id} answered: ${choice}${d.note ? ` (${d.note})` : ''}` });
    }
    emit(null, {
      decision: d.id, choice, note: d.note, blocks: d.blocks,
      answered_by: d.answered_by, answer_rule: d.answer_rule,
    });
    return d;
  });
  return { data: decision, text: `${decision.id} answered: ${decision.answer}` };
}

// The asker withdraws an open decision it no longer needs; the owner may too.
// Only an unanswered decision can be withdrawn, and the event keeps the reason.
function withdraw(ctx) {
  const reason = (ctx.flags.reason || '').trim();
  if (!reason) throw usage('decision withdraw needs --reason');
  const decision = S.mutate(ctx, 'decision withdraw', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    // The verified identity decides, as for answers: a raw --agent naming the asker is not enough.
    const identity = Authority.actor(ctx, st.events);
    if (identity !== 'owner' && identity !== d.asked_by) {
      throw refuse(`only the agent that opened ${d.id} (${d.asked_by}) or the owner can withdraw it`);
    }
    if (d.status !== 'open') throw refuse(`${d.id} is already ${d.status === 'answered' ? `answered (${d.answer})` : 'withdrawn'}; only an open decision can be withdrawn`);
    d.status = 'withdrawn';
    d.withdraw_reason = reason;
    d.withdrawn_by = identity;
    d.withdrawn_at = nowIso();
    // As with an answer, the blocked tasks read the outcome in their notes.
    for (const id of d.blocks) {
      const t = st.tasks.tasks.find((x) => x.id === id);
      if (t) t.notes.push({ at: d.withdrawn_at, agent: ctx.agent, text: `decision ${d.id} withdrawn: ${reason}` });
    }
    emit(null, { decision: d.id, reason, blocks: d.blocks, withdrawn_by: d.withdrawn_by });
    return d;
  });
  return { data: decision, text: `${decision.id} withdrawn` };
}

// What the owner has to do, for status and the inbox: an open crisis first;
// otherwise decisions only the owner answers and holds only the owner drops,
// which wait until the owner gets to them; otherwise nothing.
function ownerSummary(st) {
  const open = st.decisions.decisions.filter((d) => d.status === 'open');
  const crises = open.filter((d) => d.kind === 'crisis');
  const waiting = [
    ...open.filter((d) => d.kind !== 'crisis' && !orchestratorAnswers(st, d)).map((d) => d.id),
    ...st.tasks.tasks.filter((t) => t.needs_owner && !CLOSED.includes(t.status)
      && Authority.classOf(Authority.holdSetting(st, t)) === Authority.OWNER).map((t) => t.id),
  ];
  const line = crises.length ? `owner: crisis ${crises.map((d) => `${d.id} (${d.crisis}): ${d.question}`).join('; ')}`
    : waiting.length ? `owner: no crisis; waiting when convenient: ${waiting.join(', ')}`
      : 'owner: nothing needed';
  return { line, crisis: crises.map((d) => ({ id: d.id, crisis: d.crisis, question: d.question })), waiting };
}

function list(ctx) {
  const st = S.loadState(ctx.stateDir);
  const rows = [...st.decisions.decisions].sort(byId).filter((d) => !ctx.flags.open || d.status === 'open');
  return { data: rows, text: rows.length ? rows.map(line).join('\n') : ctx.flags.open ? 'no open decisions' : 'no decisions' };
}

function comment(ctx) {
  const text = ctx.pos.slice(1).join(' ').trim();
  if (!text) throw usage('decision note needs DID TEXT');
  const data = S.mutate(ctx, 'decision note', (st, emit) => {
    const d = getDecision(st, ctx.pos[0]);
    const entry = { at: nowIso(), agent: ctx.agent, text };
    (d.notes = d.notes || []).push(entry);
    emit(null, { decision: d.id, text, blocks: d.blocks });
    return entry;
  });
  return { data, text: `noted on ${ctx.pos[0]}` };
}

module.exports = { CRISES, CREDENTIAL_GRANTS, closeMoot, ownerSummary, sharedHostFailure, create, ask, answer, answerRule, orchestratorAnswers, delegate, withdraw, list, comment, getDecision, line };
