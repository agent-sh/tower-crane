'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

// Built once per process and copied for each test.
function fixture(t) {
  return cachedFixture(t, 'reviewed', (h) => {
    h.init(['--repo', 'acme/app']);
    h.sha = gateFixture(h);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--pr', '7']);
    gateEvidence(h, 'tests', 'checker');
    gateEvidence(h, 'clean', 'checker');
    h.reviewer('T1', 'reviewer', h.sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    return { sha: h.sha };
  });
}

const latest = (h) => h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
const ciGate = (h) => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const EMPTY = { required: [], ignore_apps: [], capped_review: [] };

test('setting required jobs invalidates a hosted pass until CI is checked again', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  assert.equal(ciGate(h).ok, true);
  const before = h.readState('tasks.json').tasks[0].evidence.length;
  h.ok(['project', 'set', '--ci-required', '["fixture"]']);
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /hosted CI.*policy.*(changed|matches)/);
  assert.match(refused.stderr, /tower-crane check ci T1/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, before, 'stale evidence needs an explicit check');
  assert.equal(ciGate(h).ok, false);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['accept', 'T1']);
  assert.deepEqual(latest(h).ci_policy, { ...EMPTY, required: ['fixture'] });
});

test('a changed required policy permits a confirmation lookup but blocks an open PR merge', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['accept', 'T1']);
  h.ok(['project', 'set', '--ci-required', '["fixture"]']);
  const log = path.join(h.base, 'gh-log.jsonl');
  h.env.FIXTURE_GH_LOG = log;
  const refused = h.run(['merge', 'T1']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /hosted CI.*policy.*(changed|matches)/);
  assert.match(refused.stderr, /tower-crane check ci T1/);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['pr', 'view']], 'stale policy allows only the confirmation lookup');
  gateEvidence(h, 'ci', 'checker');
  assert.equal(ciGate(h).ok, true);
});

test('hosted evidence and its audit event record the effective required, ignored and capped policy', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--ci-required', '["fixture"]', '--ci-ignore-apps', '["claude"]']);
  const project = h.readState('project.json');
  const rules = [{ app: 'revuto-review', pattern: 'review limit', extra: 'not a policy field' }];
  h.writeState('project.json', { ...project, ci: { ...project.ci, capped_review: rules } });
  gateEvidence(h, 'ci', 'checker');
  const expected = { required: ['fixture'], ignore_apps: ['claude'], capped_review: [{ app: 'revuto-review', pattern: 'review limit' }] };
  assert.deepEqual(latest(h).ci_policy, expected);
  assert.deepEqual(events(h).findLast((e) => e.cmd === 'check ci').detail.ci_policy, expected);
  const refused = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_GATE_OK: '0' } });
  assert.equal(refused.code, 1);
  assert.deepEqual(latest(h).ci_policy, expected, 'failures also record the policy used');
});

test('ignored apps and capped review changes also invalidate a hosted pass', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['project', 'set', '--ci-ignore-apps', '["claude"]']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
  gateEvidence(h, 'ci', 'checker');
  const project = h.readState('project.json');
  h.writeState('project.json', { ...project, ci: { ...project.ci, capped_review: [{ app: 'revuto-review', pattern: 'review limit' }] } });
  assert.equal(h.run(['accept', 'T1']).code, 1);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['accept', 'T1']);
});

test('empty lists and omitted policies have the same defaults, and unrelated fields do not invalidate a pass', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  assert.deepEqual(latest(h).ci_policy, EMPTY);
  h.ok(['project', 'set', '--ci-required', '[]', '--ci-ignore-apps', '[]']);
  const project = h.readState('project.json');
  h.writeState('project.json', { ...project, ci: { ...project.ci, capped_review: null, extra: 'not a policy field' } });
  assert.equal(ciGate(h).ok, true);
  h.ok(['accept', 'T1']);
});

test('old hosted evidence without a recorded policy is stale even with a matching audit event', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  const doc = h.readState('tasks.json');
  const audit = events(h);
  delete doc.tasks[0].evidence.at(-1).ci_policy;
  delete audit.findLast((e) => e.cmd === 'check ci').detail.ci_policy;
  h.writeState('tasks.json', doc);
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), audit.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /hosted CI.*policy.*(missing|unrecorded)/);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['accept', 'T1']);
});

test('editing only the evidence policy cannot reuse its audited hosted pass', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  h.ok(['project', 'set', '--ci-required', '["fixture"]']);
  const doc = h.readState('tasks.json');
  doc.tasks[0].evidence.at(-1).ci_policy = { ...EMPTY, required: ['fixture'] };
  h.writeState('tasks.json', doc);
  assert.equal(ciGate(h).ok, false);
  assert.match(ciGate(h).reason, /no ci evidence/);
  assert.equal(h.run(['accept', 'T1']).code, 1);
});

test('a malformed hosted policy cannot reuse a previous successful check', (t) => {
  const h = fixture(t);
  gateEvidence(h, 'ci', 'checker');
  for (const ci of [
    { required: 'fixture' }, { ignore_apps: [null] },
    { capped_review: [{ app: 'revuto-review', pattern: '[' }] },
  ]) {
    const project = h.readState('project.json');
    h.writeState('project.json', { ...project, ci });
    assert.equal(ciGate(h).ok, false);
    assert.equal(h.run(['accept', 'T1']).code, 1);
  }
});
