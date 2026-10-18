'use strict';

// The owner's standing publish policy, project.json publish_policy:
// { "conditions": [...] }. The owner sets it once (publish.policy is
// owner-required); while every condition holds for the release task the
// orchestrator names, `ask --setting publish` goes ahead without a decision.
// When one fails, the ask opens the owner's decision as before and says which.

const S = require('./state');
const T = require('./tasks');
const { usage } = require('./util');

const CONDITIONS = {
  review_clean: 'the release task passed independent review at its head: a reviewer spawned for it, in a clean context, or the owner',
  full_suite: 'the release task passed the tests gate at its head with the full suite, not mapped suites, and no waiver',
  main_ci_green: 'a fresh read of the base finds the newest concluded run of every workflow green',
};

const MESSAGE = `--publish-policy must be {"conditions": [...]} naming any of ${Object.keys(CONDITIONS).join(', ')}, or null`;

function errors(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return [MESSAGE];
  const keys = Object.keys(policy);
  const { conditions } = policy;
  if (keys.some((k) => k !== 'conditions') || !Array.isArray(conditions)
    || !conditions.every((c) => Object.hasOwn(CONDITIONS, c)) || new Set(conditions).size !== conditions.length) return [MESSAGE];
  return [];
}

function parse(text) {
  let policy;
  try { policy = JSON.parse(text); } catch { throw usage(MESSAGE); }
  if (policy !== null && errors(policy).length) throw usage(MESSAGE);
  return policy;
}

// Reads the base's runs when the policy asks for green main CI. This is the
// read inbox makes, so a reading younger than a minute is reused.
async function readMain(ctx) {
  const st = S.loadState(ctx.stateDir);
  if (!st.project.publish_policy?.conditions.includes('main_ci_green')) return null;
  if (!st.project.repo || !st.project.base) return { error: 'the project records no repository and base to read CI from' };
  try {
    await require('./main-ci').refresh(ctx, st);
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

function check(st, task, name, read) {
  if (name === 'review_clean') {
    const review = T.latestGateEvidence(task, 'review', st.events);
    if (!review?.ok || review.waived) return `no independent review passed at ${task.sha?.slice(0, 7)}`;
    return null;
  }
  if (name === 'full_suite') {
    const tests = T.latestGateEvidence(task, 'tests', st.events);
    if (!tests?.ok) return `no passing tests gate at ${task.sha?.slice(0, 7)}`;
    if (tests.waived) return 'the tests gate was waived';
    if (tests.receipt?.head_mode === 'mapped') return 'the tests gate ran mapped suites, not the full suite';
    return null;
  }
  if (!read || read.error) return `main CI could not be read: ${read?.error || 'no reading'}`;
  const red = require('./main-ci').red(st);
  return red.length ? `${st.project.base} CI is red: ${red.map((r) => `${r.workflow} run ${r.id}`).join(', ')}` : null;
}

// Null without a policy, so the ask behaves as before. Otherwise every
// condition with its result, and ok when the named task is accepted and every
// condition holds.
function judge(st, change, read) {
  const policy = st.project.publish_policy;
  if (!policy) return null;
  const id = change && typeof change === 'object' ? change.task : undefined;
  const task = typeof id === 'string' ? st.tasks.tasks.find((t) => t.id === T.normId(id, 'T')) : null;
  if (!task) return { ok: false, task: null, conditions: [], failed: [`--change names no release task: pass {"task":"T<n>", ...}`] };
  const conditions = policy.conditions.map((name) => ({ name, failed: check(st, task, name, read) }));
  const failed = [
    ...(task.status === 'accepted' ? [] : [`${task.id} is ${task.status}, not accepted`]),
    ...conditions.filter((c) => c.failed).map((c) => `${c.name}: ${c.failed}`),
  ];
  return { ok: !failed.length, task: task.id, sha: task.sha, conditions: conditions.map((c) => ({ name: c.name, ok: !c.failed })), failed };
}

function failedText(result) {
  return result.failed.join('; ');
}

// The setting audit for a publish the policy allowed, in place of an approval.
function audit(ctx, st, emit, change, result) {
  emit(result.task, {
    command: emit.cmd || null, actor: 'orchestrator', mode: require('./authority').modeOf(ctx),
    settings: { publish: require('./authority').classOf('publish') },
    policy: { conditions: result.conditions, sha: result.sha }, change,
  }, 'setting');
}

module.exports = { CONDITIONS, errors, parse, readMain, judge, failedText, audit };
