'use strict';

// The owner's standing publish policy, project.json publish_policy:
// { "conditions": [...] }. The owner sets it once (publish.policy is
// owner-required); while every condition holds for the release task the
// orchestrator names, `ask --setting publish` goes ahead without a decision.
// When one fails, the ask opens the owner's decision as before and says which.

const S = require('./state');
const T = require('./tasks');
const { usage } = require('./util');
const { isDeepStrictEqual } = require('node:util');

function hostInputs(st, task) {
  return { sha: task.sha, policy: require('./gate-commands').resolve(st.project, 'tests').policy };
}

function prepareHostTests(st, task, cwd) {
  const inputs = hostInputs(st, task);
  const failure = (error) => ({ inputs, error });
  const globs = st.project.tests?.host_only;
  if (globs == null || (Array.isArray(globs) && !globs.length)) return null;
  if (!Array.isArray(globs) || !globs.every((g) => typeof g === 'string' && g.trim())) return failure('host-only test patterns are invalid');
  const gate = require('./gates/tests');
  const matcher = gate.hostTestMatcher(st.project);
  if (matcher.error) return failure(matcher.error);
  const repo = S.findRepo(st.dir, cwd);
  if (!repo) return failure('host-only test files could not be read at the release head');
  const listing = require('./commands').spawnSync('git', ['-C', repo.root, 'ls-tree', '-r', '--name-only', '-z', task.sha], {
    encoding: 'utf8', maxBuffer: Infinity, timeout: 60000, windowsHide: true,
  });
  if (listing.status !== 0) return failure('host-only test files could not be read at the release head');
  const patterns = globs.map(gate.globToRegExp);
  const files = listing.stdout.split('\0').filter((f) => f && matcher.match(f) && patterns.some((p) => p.test(f)));
  return { inputs, files };
}

function hostProofFailure(st, task, tests, read) {
  const globs = st.project.tests?.host_only;
  if (globs == null || (Array.isArray(globs) && !globs.length)) return null;
  const prepared = read?.host_tests;
  if (!prepared || !isDeepStrictEqual(prepared.inputs, hostInputs(st, task))) {
    return 'host-only test policy or release head changed; retry the publish request';
  }
  if (prepared.error) return prepared.error;
  const files = prepared.files;
  if (!files.length) return 'no configured host-only test files match the release head';
  const host = tests.receipt?.host_only;
  if (!host || !Array.isArray(host.results) || !Array.isArray(host.run)
    || !Array.isArray(host.skipped) || !Array.isArray(host.unreported)
    || host.skipped.length || host.unreported.length) return 'host-only tests were skipped or lack reported passing cases';
  const results = new Map(host.results.map((r) => [r?.file, r]));
  if (results.size !== host.results.length || results.size !== files.length
    || new Set(host.run).size !== files.length) return 'host-only receipts do not cover the configured release-head files';
  for (const file of files) {
    const result = results.get(file);
    if (!host.run.includes(file) || !Number.isInteger(result?.ran) || result.ran < 1 || result.skipped !== 0) {
      return `host-only test ${file} has no passing, non-skipped release-head cases`;
    }
  }
  return null;
}

const CONDITIONS = {
  review_clean: 'the release task passed independent review at its head: a reviewer spawned for it, in a clean context, or the owner',
  full_suite: 'the release task passed the full suite at its head under current test settings, including passing host-only cases without skips, and no waiver',
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

// Prepare Git and CI reads outside the state lock. The write compares host
// inputs again; a reading younger than a minute is reused for main CI.
async function prepare(ctx, change) {
  const st = S.loadState(ctx.stateDir);
  const policy = st.project.publish_policy;
  if (!policy) return null;
  const read = {};
  if (policy.conditions.includes('full_suite')) {
    const id = change && typeof change === 'object' ? change.task : undefined;
    const task = typeof id === 'string' ? st.tasks.tasks.find((t) => t.id === T.normId(id, 'T')) : null;
    if (task) read.host_tests = prepareHostTests(st, task, ctx.cwd || process.cwd());
  }
  if (!policy.conditions.includes('main_ci_green')) return read;
  read.main_inputs = { repo: st.project.repo, base: st.project.base };
  if (!st.project.repo || !st.project.base) return { ...read, error: 'the project records no repository and base to read CI from' };
  try {
    await require('./main-ci').refresh(ctx, st);
    return { ...read, ok: true };
  } catch (e) {
    return { ...read, error: e.message };
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
    const policyReason = T.gatePolicyMismatch(task, tests, st);
    if (policyReason) return policyReason;
    if (tests.tests_mode === 'none') return 'the tests gate ran no tests';
    if (tests.receipt?.head_mode === 'mapped') return 'the tests gate ran mapped suites, not the full suite';
    if (tests.receipt?.head_mode === 'crucial') return 'the tests gate ran crucial and mapped suites, not the full suite';
    if (tests.receipt?.head_mode === 'incremental') return 'the tests gate ran incremental suites, not the full suite';
    return hostProofFailure(st, task, tests, read);
  }
  if (!read?.ok || read.error) return `main CI could not be read: ${read?.error || 'no reading'}`;
  if (!isDeepStrictEqual(read.main_inputs, { repo: st.project.repo, base: st.project.base })) {
    return 'main CI repository or base changed; retry the publish request';
  }
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

module.exports = { CONDITIONS, errors, parse, prepare, judge, failedText, audit };
