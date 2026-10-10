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
function request(ctx) {
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
  for (const k of ['question', 'option', 'recommend', 'why', 'blocks', 'owner-required']) if (f[k] !== undefined) throw usage(`ask --setting writes its own decision; drop --${k}`);
  let change = null;
  if (f.change !== undefined) {
    try {
      change = JSON.parse(f.change);
    } catch (e) {
      throw usage(`--change must be JSON describing the change (${e.message})`);
    }
  }
  const d = S.mutate(ctx, 'ask', (st, emit, commit) => {
    if (A.actor(ctx, st.events) === 'owner') throw refuse(`the owner makes ${setting} changes directly; nothing to ask`);
    const approved = A.approval(st, [setting], change);
    A.enforce(ctx, st, [setting], { change, emit, commit });
    return approved;
  });
  return { data: d, text: `${setting}: the owner approved ${d.id}; go ahead` };
}

// Money and secrets stay with the owner even when the asker does not mark them.
// A match only routes a question to the owner, so a broad pattern costs an
// owner look; a miss would let the orchestrator spend or hand out a credential.
// Lookarounds stop a match inside a longer word (payload, current) while still
// matching inside names such as MY_API_KEY and HF_TOKEN.
const OWNER_TOPICS = [
  [/\$\s?\d|(?<![a-z])(spend|spending|spent|pay|paying|pays|payment|paid|purchase|buy|buying|rent|renting|rental|billing|invoice|price|pricing|budget|subscribe|subscription|fund|funding)(?![a-z])/i, 'asks for spend'],
  [/(?<![a-z])(credentials?|passwords?|secrets?|(api|access|auth|bearer|oauth|github|hf|service)[ _-]?(keys?|tokens?)|private[ _-]?keys?|ssh[ _-]?keys?)(?![a-z])/i, 'asks for credentials'],
];

// What the orchestrator would answer: the question, its reason and its options.
function askedText({ question, why, options = [] }) {
  return [question, why ?? '', ...options].join(' ');
}

// The reason the owner must answer a question about spend or credentials, or null.
function topicReason(text) {
  const hit = OWNER_TOPICS.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : null;
}

function create(st, emit, agent, fields) {
  const { question, options = [], blocks = [] } = fields;
  const ownerReason = fields.owner_required ?? topicReason(askedText({ question, why: fields.why, options }));
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
    technical: fields.technical ?? !(fields.escalation || ownerReason),
    answered_by: null,
    answered_at: null,
    answer_rule: null,
    // Stored even when null, so a decision opened before topics were stored
    // (no key at all) is told apart from one the owner has cleared.
    owner_required: ownerReason,
  };
  if (fields.escalation) d.escalation = fields.escalation;
  st.decisions.next += 1;
  st.decisions.decisions.push(d);
  const detail = { decision: d.id, question, blocks: d.blocks };
  if (d.escalation) detail.escalation = d.escalation;
  emit(null, detail, 'ask');
  return d;
}

function ask(ctx) {
  const f = ctx.flags;
  if (f.setting !== undefined && f.question === undefined) return request(ctx);
  if (f.change !== undefined) throw usage('--change goes with a setting request without --question');
  const question = (f.question || '').trim();
  if (!question) throw usage('ask needs --question');
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
  const decision = S.mutate(ctx, 'ask', (st, emit) => {
    const blocks = asList(f.blocks).map((id) => T.getTask(st, id).id);
    // A question that names an owner-required setting, that the asker marks
    // owner-required with a reason, or that asks for spend or credentials stays
    // with the owner. Every other question is technical, so the orchestrator
    // answers it while the project's decision-delegation setting allows; create()
    // sets that flag and the owner-only reason.
    const escalation = owner.length ? { settings: owner, change: null } : null;
    return create(st, emit, ctx.agent, {
      question, options, blocks, recommendation: f.recommend, why: f.why, escalation, owner_required: ownerRequired,
    });
  });
  return { data: decision, text: decision.id };
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
      // The owner's technical call clears a reason the asker or a spend or
      // credential match gave. An escalation is cleared by its setting instead.
      if (technical) d.owner_required = null;
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

// Why only the owner answers a decision, or null. A decision opened before
// topics were stored has no owner_required key, so its text is checked here
// too; a null key means the reason was never set or the owner cleared it.
function ownerOnlyWhy(decision) {
  if (decision.escalation) return `escalates ${decision.escalation.settings.join(', ')} to the owner`;
  const reason = decision.owner_required !== undefined ? decision.owner_required : topicReason(askedText(decision));
  return reason ? `is owner-required (${reason})` : null;
}

function answerRule(st, decision, ctx) {
  const identity = Authority.actor(ctx, st.events);
  const owner = identity === 'owner';
  const orchestrator = Authority.isOrchestrator(identity, st.events);
  const ownerOnly = ownerOnlyWhy(decision);
  if (ownerOnly && !owner) throw refuse(`${decision.id} ${ownerOnly}; only the owner answers it`);
  if (owner) return 'owner';
  // Technical delegation is on unless the project sets orchestrator_technical to false.
  const technicalDelegation = decision.technical === true
    && st.project.decision_delegation?.orchestrator_technical !== false;
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

module.exports = { create, ask, answer, answerRule, delegate, withdraw, list, comment, getDecision, line };
