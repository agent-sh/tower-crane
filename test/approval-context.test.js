'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const Authority = require('../lib/authority');

const as = agent => ({ env: { TOWER_CRANE_AGENT: agent } });
const decisions = h => h.readState('decisions.json').decisions;
const events = h => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const audits = h => events(h).filter(e => e.cmd === 'setting');

function removeBinding(h, id, key) {
  const doc = h.readState('decisions.json');
  delete doc.decisions.find(d => d.id === id).escalation.change[key];
  h.writeState('decisions.json', doc);
  const log = events(h);
  for (const event of log) {
    if (event.cmd === 'ask' && event.detail.decision === id) delete event.detail.escalation.change[key];
  }
  fs.writeFileSync(path.join(h.state, 'events.jsonl'), log.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function setup(t) {
  return cachedFixture(t, 'approval-context', h => {
    h.init();
    h.env.TOWER_CRANE_STATE = h.state;
    h.ok(['task', 'add', '--title', 'Change', '--kind', 'code', '--acceptance', 'works']);
    h.ok(['ladder', 'set', 'easy', '--harness', 'codex']);
  });
}

test('stateful authority checks require an audit emitter or explicit quiet mode', () => {
  const ctx = { agent: 'orchestrator', agentExplicit: true, env: {} };
  const st = { events: [] };
  assert.throws(() => Authority.enforce(ctx, st, ['gates.executors']), /audit emitter/);
  assert.equal(Authority.enforce(ctx, st, ['gates.executors'], { quiet: true, keep: true }), 'orchestrator');
});

test('owner primary-tool writes retire approvals before a removed grant can be restored', t => {
  const h = setup(t);
  const args = ['ladder', 'set', 'easy', '--tools', '["computer_use"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['ladder', 'set', 'easy', '--tools', '["computer_use","plugins"]']);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  h.ok(['ladder', 'set', 'easy', '--clear', 'tools']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.equal(h.readState('project.json').ladder.easy.tools, undefined);
});

test('owner primary writes retire combined reach requests even when the grant already exists', t => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'easy', '--tools', '["plugins"]']);
  const args = ['ladder', 'set', 'easy', '--tools', '["plugins","computer_use"]', '--env', '{"MODE":"wanted"}'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['ladder', 'set', 'easy', '--tools', '["plugins","computer_use"]', '--env', '{"MODE":"intermediate"}']);
  assert.equal(decisions(h)[0].applied, undefined);
  h.ok(['ladder', 'set', 'easy', '--model', 'unrelated']);
  assert.equal(decisions(h)[0].applied, undefined, 'unwritten fields do not satisfy the request');
  const before = audits(h).length;
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.deepEqual(audits(h).slice(before).map(e => e.detail.settings), [{
    'ladder.tools': 'operational', env: 'owner-required',
  }]);
  h.ok(['ladder', 'set', 'easy', '--clear', 'tools', '--clear', 'env']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
});

test('owner primary args retire a reach approval already represented by a fallback route', t => {
  const h = setup(t);
  const command = [process.execPath, '-e', '0'];
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify(command),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap(field => ['--clear', field])]);
  const args = ['ladder', 'set', 'easy', '--args', '["requested"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ harness: 'command', command, args: ['requested'] }])]);
  assert.equal(decisions(h)[0].applied, undefined, 'writing another route does not settle the primary request');
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'ladder.args': 'operational' });
  h.ok(['ladder', 'set', 'easy', '--clear', 'args']);
  h.ok(['ladder', 'set', 'easy', '--clear', 'fallbacks']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
});

test('owner default-harness writes retire reach approvals independently of current route differences', t => {
  const h = setup(t);
  for (const name of require('../lib/ladder').RUNGS) h.ok(['ladder', 'set', name, '--harness', 'codex']);
  h.ok(['ladder', 'harness', 'codex']);
  h.ok(['ladder', 'set', 'easy', '--clear', 'harness', '--clear', 'profile', '--model', 'fixture']);
  const args = ['ladder', 'harness', 'agy'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['ladder', 'set', 'easy', '--fallbacks', '[{"harness":"agy","model":"fixture"}]']);
  assert.equal(decisions(h)[0].applied, undefined);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'ladder.harness': 'operational' });
  h.ok(['ladder', 'harness', 'codex']);
  h.ok(['ladder', 'set', 'easy', '--clear', 'fallbacks']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
});

for (const unchanged of [false, true]) {
  test(`owner task-kind ${unchanged ? 'unchanged' : 'operational'} writes retire downgrade approvals`, t => {
    const h = setup(t);
    const args = ['task', 'update', 'T1', '--kind', 'docs'];
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
    h.ok(['answer', 'D1', '--choice', 'approve']);
    h.ok(['task', 'update', 'T1', '--kind', 'research']);
    assert.equal(decisions(h)[0].applied, undefined);
    if (unchanged) h.ok(args, as('orchestrator'));
    assert.notEqual(h.run([...args, '--dep', 'T999']).code, 0);
    assert.equal(decisions(h)[0].applied, undefined, 'a failed write does not settle the request');
    h.ok(args);
    assert.equal(decisions(h)[0].applied?.by, 'owner');
    h.ok(['task', 'update', 'T1', '--kind', 'code']);
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
    assert.equal(h.readState('tasks.json').tasks[0].kind, 'code');
  });
}

test('owner cancellation retires approval after the owner blocker is cleared', t => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'owner action']);
  const args = ['task', 'update', 'T1', '--status', 'cancelled'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['owner-done', 'T1']);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'cancelled');
});

test('ordinary owner-required writes still retire approvals without supplemental metadata', t => {
  const h = setup(t);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which implementation?', '--option', 'a', '--option', 'b']);
  const args = ['decision', 'delegate', 'D1', '--answerers', '["named-worker"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok([...args, '--technical', 'true']);
  assert.equal(decisions(h)[1].applied?.by, 'owner');
  h.ok(['decision', 'delegate', 'D1', '--answerers', '[]']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D3/);
  assert.deepEqual(decisions(h)[0].answerers, []);
});

test('owner acceptance retires approval after a live-review waiver becomes operational', t => {
  const h = setup(t);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  const args = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--reason', 'owner exception'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.reviewer('T1', 'reviewer-down');
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.equal(audits(h).at(-1).detail.settings['waive.review'], 'operational');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});

test('changed requirements need a new waiver approval at the same commit', t => {
  const h = setup(t);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  const args = ['accept', 'T1', '--waive', 'tests', '--waive', 'clean', '--waive', 'review', '--reason', 'owner exception'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'new requirements']);
  assert.equal(h.readState('tasks.json').tasks[0].revision, 2);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(decisions(h)[1].escalation.change.revision, 2);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.filter(e => e.waived).length, 0);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(args, as('orchestrator'));
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const tasks = h.readState('tasks.json');
  for (const entry of tasks.tasks[0].evidence.filter(e => e.waived)) {
    assert.equal(entry.revision, 2);
    assert.equal(entry.approved_by, 'D2');
    entry.approved_by = 'D1';
  }
  h.writeState('tasks.json', tasks);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false, 'a prior-revision approval cannot back relabeled evidence');
});

test('waiver proof requires the exact positive revision, including legacy records', () => {
  const change = { accept: 'T1', sha: 'abcdef1234567', revision: 1 };
  const log = [
    { cmd: 'ask', detail: { decision: 'D1', approval_request: true, escalation: { settings: ['waive.tests'], change } } },
    { cmd: 'answer', agent: 'owner', detail: { decision: 'D1', choice: 'approve' } },
  ];
  assert.equal(Authority.approvedIn(log, 'D1', 'waive.tests', 'T1', change.sha, 1), true);
  for (const revision of [2, undefined, null, 0, '1']) {
    assert.equal(Authority.approvedIn(log, 'D1', 'waive.tests', 'T1', change.sha, revision), false);
  }
  delete change.revision;
  assert.equal(Authority.approvedIn(log, 'D1', 'waive.tests', 'T1', change.sha, 1), false);
});

test('release approvals bind the claim instance while allowing renewal of that instance', t => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker-one']);
  const original = h.readState('tasks.json').tasks[0].claim;
  const args = ['release', 'T1', '--reason', 'owner requested release'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['interrupt', 'T1']);
  h.ok(['claim', 'T1', '--agent', 'worker-one']);
  const replacement = h.readState('tasks.json').tasks[0].claim;
  assert.notEqual(replacement.since, original.since);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].claim, replacement);
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(decisions(h)[1].escalation.change.claim_since, replacement.since);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(['renew', 'T1', '--agent', 'worker-one', '--lease', '90']);
  assert.equal(h.readState('tasks.json').tasks[0].claim.since, replacement.since);
  h.ok(args, as('orchestrator'));
  assert.equal(h.readState('tasks.json').tasks[0].claim, null);
  assert.equal(audits(h).at(-1).detail.approved_by, 'D2');
});

test('release rejects an approved legacy request without a claim binding', t => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker-one']);
  const claim = h.readState('tasks.json').tasks[0].claim;
  const args = ['release', 'T1', '--reason', 'owner requested release'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  removeBinding(h, 'D1', 'claim_since');
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].claim, claim);
  assert.equal(decisions(h)[0].applied, undefined);
});

test('browser-kit approvals authorize only their resolved personal file', t => {
  const h = setup(t);
  const other = path.join(h.base, 'other-config.json');
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(h.userConfig, JSON.stringify({ keep: 'first', browser_kit: ['old'] }));
  fs.writeFileSync(other, JSON.stringify({ keep: 'second', browser_kit: ['other'] }));
  const args = ['browser-kit', 'set', '--servers', '["new-server"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  const redirected = { env: { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: other } };
  assert.match(h.run(args, redirected).stderr, /opened D2/);
  assert.deepEqual(read(h.userConfig), { keep: 'first', browser_kit: ['old'] });
  assert.deepEqual(read(other), { keep: 'second', browser_kit: ['other'] });
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(decisions(h)[0].escalation.change.user_file, h.userConfig);
  h.ok(args, { env: { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: path.relative(h.repo, h.userConfig) } });
  assert.deepEqual(read(h.userConfig), { keep: 'first', browser_kit: ['new-server'] });
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(args, redirected);
  assert.deepEqual(read(other), { keep: 'second', browser_kit: ['new-server'] });
  assert.deepEqual(decisions(h).map(d => d.applied.by), ['orchestrator', 'orchestrator']);
});

test('browser-kit owner writes retire only requests for the file they write', t => {
  const h = setup(t);
  const other = path.join(h.base, 'other-config.json');
  const args = ['browser-kit', 'set', '--servers', '["new-server"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args, { env: { TOWER_CRANE_CONFIG: other } });
  assert.equal(decisions(h)[0].applied, undefined);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
});

test('browser-kit rejects legacy approvals without a file binding', t => {
  const h = setup(t);
  const args = ['browser-kit', 'set', '--servers', '["new-server"]'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  removeBinding(h, 'D1', 'user_file');
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.equal(fs.existsSync(h.userConfig), false);
  assert.equal(decisions(h)[0].applied, undefined);
});
