'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });
const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const audits = (h) => log(h).filter(e => e.cmd === 'setting');
const decisions = (h) => h.readState('decisions.json').decisions;
const user = (h) => JSON.parse(fs.readFileSync(h.userConfig, 'utf8'));

function setup(t) {
  return cachedFixture(t, 'control-rework', h => {
    h.init();
    h.env.TOWER_CRANE_STATE = h.state;
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Implement the change.\n' });
    h.env.CODEX_HOME = path.join(h.base, 'codex');
    h.env.CLAUDE_CONFIG_DIR = path.join(h.base, 'claude');
    fs.mkdirSync(h.env.CODEX_HOME);
    fs.mkdirSync(h.env.CLAUDE_CONFIG_DIR);
    fs.writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\n');
  });
}

test('a generated orchestrator consumes delegation approval once and audits its role', t => {
  const h = setup(t);
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap(field => ['--clear', field])]);
  const args = ['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait'];
  const { agent } = h.json(args);
  assert.match(agent, /^orchestrator-T1-\d+$/);
  const before = audits(h).length;
  assert.match(h.run(args, as(agent)).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args, as(agent));
  assert.equal(decisions(h)[0].applied?.by, agent);
  assert.deepEqual(audits(h).slice(before).map(e => [e.agent, e.detail.actor, e.detail.approved_by]), [
    [agent, 'orchestrator', 'D1'],
  ]);
  assert.match(h.run(args, as(agent)).stderr, /opened D2/, 'a second spawn needs another approval');
  assert.equal(audits(h).length, before + 1);
});

test('a combined waiver keeps operational review eligible alongside approved tests', t => {
  const h = setup(t);
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.reviewer('T1', 'reviewer-down');
  const args = ['accept', 'T1', '--waive', 'tests', '--waive', 'review', '--reason', 'test harness unavailable; reviewer exited'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  assert.deepEqual(decisions(h)[0].escalation.settings, ['waive.tests']);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args, as('orchestrator'));
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'accepted');
  assert.equal(task.gates.ok, true);
  assert.deepEqual(task.evidence.filter(e => e.waived).map(e => [e.type, e.approved_by]), [
    ['tests', 'D1'], ['review', undefined],
  ]);
  const changed = audits(h).filter(e => e.detail.settings['waive.tests']);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].detail.settings, { 'waive.tests': 'owner-required', 'waive.review': 'operational' });
});

test('both interruption commands audit once and a failed interruption audits nothing', t => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['claim', 'T2', '--agent', 'w-2']);
  h.ok(['interrupt', 'T1'], as('orchestrator'));
  h.ok(['task', 'update', 'T2', '--acceptance', 'new requirement', '--tier', 'hard', '--interrupt'], as('orchestrator'));
  assert.deepEqual(audits(h).map(e => [e.detail.command, e.detail.actor, e.detail.settings]), [
    ['interrupt', 'orchestrator', { 'task.interrupt': 'operational' }],
    ['task update', 'orchestrator', { 'task.tier': 'operational', 'task.interrupt': 'operational' }],
  ]);
  assert.ok(h.readState('tasks.json').tasks.every(t => t.claim === null));
  const before = log(h);
  assert.equal(h.run(['interrupt', 'T1'], as('orchestrator')).code, 1);
  assert.deepEqual(log(h), before);
});

test('per-decision delegation uses owner approval and the shared setting audit', t => {
  const h = setup(t);
  h.ok(['ask', '--question', 'Which implementation?', '--option', 'a', '--option', 'b']);
  h.ok(['decision', 'delegate', 'D1', '--answerers', '["worker-one"]']);
  assert.deepEqual(audits(h).at(-1)?.detail.settings, { 'decision.delegate': 'owner-required' });
  const args = ['decision', 'delegate', 'D1', '--answerers', '["worker-two"]', '--technical', 'true'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2/);
  assert.deepEqual(decisions(h)[0].answerers, ['worker-one']);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(args, as('orchestrator'));
  assert.deepEqual(decisions(h)[0].answerers, ['worker-two']);
  assert.equal(decisions(h)[0].technical, true);
  assert.equal(decisions(h)[1].applied.by, 'orchestrator');
  assert.deepEqual(audits(h).map(e => [e.detail.actor, e.detail.approved_by]), [
    ['owner', undefined], ['orchestrator', 'D2'],
  ]);
  h.ok(['answer', 'D1', '--choice', 'a'], as('worker-two'));
  const before = log(h);
  assert.equal(h.run(args, as('orchestrator')).code, 1);
  assert.deepEqual(log(h), before, 'a closed decision opens no approval and records no setting change');
});

test('fallback CLI edits preserve primary and unrelated user settings, including clearing', t => {
  const h = setup(t);
  const primary = h.readState('project.json');
  fs.writeFileSync(h.userConfig, JSON.stringify({
    extra: 'keep',
    ladder: { easy: { harness: 'claude', model: 'personal' }, hard: { fallbacks: [{ harness: 'codex', model: 'other' }] } },
  }));
  const routes = [{ harness: 'codex', model: 'backup' }];
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)], as('orchestrator'));
  assert.deepEqual(h.readState('project.json'), primary);
  assert.deepEqual(user(h), {
    extra: 'keep',
    ladder: { easy: { harness: 'claude', model: 'personal', fallbacks: routes }, hard: { fallbacks: [{ harness: 'codex', model: 'other' }] } },
  });
  const shown = h.json(['ladder', 'show']).ladder.easy;
  assert.deepEqual(shown.fallbacks, routes);
  assert.equal(shown.fallbacks_from, 'user');
  assert.equal(audits(h).at(-1).detail.settings['ladder.fallbacks'], 'operational');
  assert.equal(audits(h).at(-1).detail.actor, 'orchestrator');
  const before = fs.readFileSync(h.userConfig, 'utf8');
  assert.equal(h.run(['ladder', 'set', 'easy', '--fallbacks', '[]'], as('worker')).code, 1);
  assert.equal(fs.readFileSync(h.userConfig, 'utf8'), before);
  h.ok(['ladder', 'set', 'easy', '--fallbacks', '[]'], as('orchestrator'));
  assert.deepEqual(user(h).ladder.easy.fallbacks, []);
  h.ok(['ladder', 'set', 'easy', '--clear', 'fallbacks'], as('orchestrator'));
  assert.deepEqual(user(h).ladder.easy, { harness: 'claude', model: 'personal' });
  h.ok(['ladder', 'set', 'hard', '--clear', 'fallbacks'], as('orchestrator'));
  assert.equal(user(h).ladder.hard, undefined, 'clearing a fallback-only rung does not install an empty primary');
  assert.equal(decisions(h).length, 0);
});

for (const state of ['approved', 'open', 'unchanged']) {
  test(`an owner fallback replacement retires its ${state} request independently of the changed fields`, t => {
    const h = setup(t);
    const routes = [{ harness: 'codex', model: 'backup', env: { ROUTE: 'private' } }];
    const args = ['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)];
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
    if (state !== 'open') h.ok(['answer', 'D1', '--choice', 'approve']);
    h.ok(['ladder', 'set', 'hard', '--fallbacks', JSON.stringify(routes)]);
    assert.equal(decisions(h)[0].applied, undefined, 'another rung does not retire the request');
    h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ ...routes[0], model: 'intermediate' }])]);
    assert.equal(decisions(h)[0].applied, undefined, 'a different list does not retire the request');
    if (state === 'unchanged') {
      h.ok(args, as('orchestrator'));
      assert.equal(decisions(h)[0].applied, undefined, 'operational orchestrator tuning leaves the approval pending');
    }
    const count = audits(h).length;
    h.ok(args);
    assert.equal(decisions(h)[0].applied?.by, 'owner');
    assert.equal(decisions(h)[0].status, 'answered');
    assert.equal(audits(h).length, count + 1);
    assert.ok(Object.values(audits(h).at(-1).detail.settings).every(c => c === 'operational'));
    h.ok(['ladder', 'set', 'easy', '--clear', 'fallbacks']);
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
    assert.equal(user(h).ladder.easy?.fallbacks, undefined, 'the removed grant stays removed');
  });
}

test('fallback reach and environment grants require one-use approvals', t => {
  const h = setup(t);
  const routes = [{ harness: 'command', command: [process.execPath, '-e', '0'], env: { ROUTE: 'private' } }];
  const args = ['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(routes)];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  assert.deepEqual(new Set(decisions(h)[0].escalation.settings), new Set(['ladder.command', 'env', 'ladder.reach']));
  assert.equal(fs.existsSync(h.userConfig), false);
  assert.equal(audits(h).length, 0);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args, as('orchestrator'));
  assert.deepEqual(user(h).ladder.easy.fallbacks, routes);
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.equal(audits(h).at(-1).detail.approved_by, 'D1');
  assert.equal(audits(h).at(-1).detail.settings['ladder.reach'], 'owner-required');
  const changed = [{ ...routes[0], env: { ROUTE: 'different' } }];
  assert.match(h.run(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify(changed)], as('orchestrator')).stderr, /opened D2/);
  assert.deepEqual(user(h).ladder.easy.fallbacks, routes);
});

test('fallback validation and MCP checks refuse writes without an audit', t => {
  const h = setup(t);
  const before = log(h);
  for (const value of ['{}', '[{"fallbacks":[]}]', '[{"harness":"claude","profile":"wrong"}]']) {
    assert.notEqual(h.run(['ladder', 'set', 'easy', '--fallbacks', value]).code, 0);
  }
  const missing = h.run(['ladder', 'set', 'easy', '--fallbacks',
    '[{"harness":"codex","model":"backup","mcp":["missing"]}]'], as('orchestrator'));
  assert.match(missing.stderr, /does not define/);
  assert.equal(fs.existsSync(h.userConfig), false);
  assert.deepEqual(log(h), before);
  h.ok(['ladder', 'set', 'easy', '--fallbacks',
    '[{"harness":"codex","model":"backup","mcp":["docs"]}]'], as('orchestrator'));
  assert.equal(audits(h).length, 1);
  const snapshot = user(h);
  const count = audits(h).length;
  assert.equal(h.run(['ladder', 'set', 'easy', '--fallbacks', '[]', '--model', 'other']).code, 2);
  assert.deepEqual(user(h), snapshot);
  assert.equal(audits(h).length, count);
  const tools = h.run(['ladder', 'set', 'easy', '--fallbacks',
    '[{"harness":"codex","model":"backup","tools":["computer_use"]}]'], as('orchestrator'));
  assert.match(tools.stderr, /opened D1/);
  assert.deepEqual(decisions(h)[0].escalation.settings, ['ladder.reach']);
  assert.deepEqual(user(h), snapshot);
  assert.equal(audits(h).length, count);
});

test('fallback model tuning keeps existing grants without asking the owner again', t => {
  const h = setup(t);
  const route = { harness: 'codex', model: 'backup', env: { ROUTE: 'private' } };
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([route])]);
  h.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ ...route, model: 'updated' }])], as('orchestrator'));
  assert.equal(decisions(h).length, 0);
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'ladder.fallbacks': 'operational', 'ladder.model': 'operational' });
  assert.deepEqual(user(h).ladder.easy.fallbacks[0].env, route.env);
});
