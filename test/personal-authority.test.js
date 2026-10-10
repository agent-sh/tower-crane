'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, makeRepo } = require('./helpers');
const L = require('../lib/ladder');
const Authority = require('../lib/authority');

const asOrchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };
const decisions = h => h.readState('decisions.json').decisions;
const audits = h => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.cmd === 'setting');
const config = h => fs.existsSync(h.userConfig) ? fs.readFileSync(h.userConfig, 'utf8') : null;

function setup(t) {
  return cachedFixture(t, 'personal-authority', h => {
    h.init(['--budget-hours', '10', '--budget-tokens', '100']);
    h.env.TOWER_CRANE_STATE = h.state;
    h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'primary', '--clear', 'profile']);
  });
}

function secondProject(t, first) {
  const h = makeRepo(t);
  h.init();
  h.env.TOWER_CRANE_STATE = h.state;
  h.ok(['ladder', 'set', 'easy', '--harness', 'codex', '--model', 'second-primary', '--clear', 'profile']);
  h.env.TOWER_CRANE_CONFIG = first.userConfig;
  return h;
}

const fallback = h => L.routes(h.json(['ladder', 'show']).ladder.easy)[1];

for (const grant of ['tools', 'harness']) {
  test(`a project-local ${grant} grant cannot authorize a new personal fallback`, t => {
    const a = setup(t);
    const b = secondProject(t, a);
    if (grant === 'tools') a.ok(['ladder', 'set', 'easy', '--tools', '["computer_use"]']);
    else a.ok(['ladder', 'set', 'easy', '--harness', 'agy']);
    const route = grant === 'tools'
      ? { harness: 'codex', model: 'backup', tools: ['computer_use'] }
      : { harness: 'agy', model: 'backup' };
    const args = ['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([route])];
    const before = config(a);
    const count = audits(a).length;
    const asked = a.run(args, asOrchestrator);
    assert.equal(asked.code, 1, asked.stderr);
    assert.match(asked.stderr, /opened D1/);
    assert.deepEqual(decisions(a)[0].escalation.settings, ['ladder.reach']);
    assert.equal(config(a), before);
    assert.equal(audits(a).length, count);
    assert.equal(fallback(b), undefined, 'the other project gains no fallback before approval');
    a.ok(['answer', 'D1', '--choice', 'approve']);
    a.ok(args, asOrchestrator);
    assert.deepEqual(fallback(b), route);
    assert.equal(b.json(['ladder', 'show']).ladder.easy.harness, 'codex');
    a.ok(['ladder', 'set', 'easy', '--fallbacks', JSON.stringify([{ ...route, model: 'tuned' }])], asOrchestrator);
    assert.equal(decisions(a).length, 1, 'existing personal grants permit operational model tuning');
    assert.ok(Object.values(audits(a).at(-1).detail.settings).every(value => value === 'operational'));
  });
}

test('an inherited personal route does not authorize forcing its harness in other projects', t => {
  const a = setup(t);
  const b = secondProject(t, a);
  a.ok(['ladder', 'set', 'easy', '--harness', 'agy']);
  a.ok(['ladder', 'set', 'easy', '--fallbacks', '[{"model":"backup"}]']);
  assert.equal(fallback(b).harness, 'codex');
  const before = config(a);
  const args = ['ladder', 'set', 'easy', '--fallbacks', '[{"harness":"agy","model":"backup"}]'];
  assert.match(a.run(args, asOrchestrator).stderr, /opened D1/);
  assert.equal(config(a), before);
  assert.equal(fallback(b).harness, 'codex');
});

test('inherited personal tools are checked beyond the invoking project harness', t => {
  const a = setup(t);
  const b = secondProject(t, a);
  a.ok(['ladder', 'set', 'easy', '--harness', 'claude', '--tools', '["Read"]']);
  const args = ['ladder', 'set', 'easy', '--fallbacks', '[{"model":"backup","tools":["Read"]}]'];
  assert.match(a.run(args, asOrchestrator).stderr, /opened D1/);
  assert.deepEqual(decisions(a)[0].escalation.settings, ['ladder.reach']);
  assert.equal(fallback(b), undefined);
});

for (const scope of ['project', 'task']) for (const field of ['hours', 'tokens']) {
  test(`the CLI clears the ${scope} ${field} budget through owner approval or a direct owner write`, t => {
    const h = setup(t);
    const prefix = scope === 'project' ? ['project', 'set'] : ['task', 'update', 'T1'];
    if (scope === 'task') {
      h.ok(['task', 'add', '--title', 'Budgeted', '--acceptance', 'works']);
      h.ok([...prefix, '--budget-hours', '10', '--budget-tokens', '100']);
    }
    const budget = () => scope === 'project' ? h.readState('project.json').budget : h.readState('tasks.json').tasks[0].budget;
    const flag = `--budget-${field}`;
    const args = [...prefix, flag, 'null'];
    const before = budget()[field];
    const asked = h.run(args, asOrchestrator);
    assert.equal(asked.code, 1, asked.stderr);
    assert.match(asked.stderr, /opened D1/);
    assert.deepEqual(decisions(h)[0].escalation, {
      settings: ['budget.raise'], change: { ...(scope === 'task' ? { task: 'T1' } : {}), [flag.slice(2)]: null },
    });
    assert.equal(budget()[field], before);
    assert.equal(h.run(args, { env: { TOWER_CRANE_AGENT: 'worker' } }).code, 1);
    h.ok(['answer', 'D1', '--choice', 'approve']);
    h.ok(args, asOrchestrator);
    assert.equal(budget()[field], null);
    assert.equal(audits(h).at(-1).detail.approved_by, 'D1');
    h.ok([...prefix, flag, '5'], asOrchestrator);
    assert.equal(decisions(h).length, 1, 'lowering an unlimited budget stays operational');
    h.ok(args);
    assert.equal(budget()[field], null);
    assert.equal(audits(h).at(-1).detail.actor, 'owner');
  });
}

test('task and project budget approvals retain separate targets', t => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Budgeted', '--acceptance', 'works']);
  h.ok(['task', 'update', 'T1', '--budget-hours', '5']);
  const project = ['project', 'set', '--budget-hours', '20'];
  const task = ['task', 'update', 'T1', '--budget-hours', '20'];
  assert.match(h.run(project, asOrchestrator).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  assert.match(h.run(task, asOrchestrator).stderr, /opened D2/);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(task);
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(decisions(h)[1].applied?.by, 'owner');
  assert.equal(h.readState('project.json').budget.hours, 10);
  h.ok(project);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
});

test('owner task-budget decreases retire matching raise approvals', t => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Budgeted', '--acceptance', 'works']);
  h.ok(['task', 'update', 'T1', '--budget-hours', '5']);
  const args = ['task', 'update', 'T1', '--budget-hours', '10'];
  assert.match(h.run(args, asOrchestrator).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['task', 'update', 'T1', '--budget-hours', '20']);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  h.ok(['task', 'update', 'T1', '--budget-hours', '5']);
  assert.match(h.run(args, asOrchestrator).stderr, /opened D2/);
  assert.equal(h.readState('tasks.json').tasks[0].budget.hours, 5);
});

test('nullable budget flags preserve numeric validation and work at init', t => {
  const h = makeRepo(t);
  h.init(['--budget-hours', 'null', '--budget-tokens', 'null']);
  assert.deepEqual(h.readState('project.json').budget, { hours: null, tokens: null });
  h.ok(['project', 'set', '--budget-hours', '1.5', '--budget-tokens', '0']);
  const before = h.readState('project.json');
  for (const [flag, value] of [
    ['--budget-hours', 'NaN'], ['--budget-hours', '-1'],
    ['--budget-tokens', '1.5'], ['--budget-tokens', '-1'],
    ['--workers', 'null'], ['--lease-minutes', 'null'],
  ]) {
    assert.equal(h.run(['project', 'set', flag, value]).code, 2, `${flag} ${value}`);
    assert.deepEqual(h.readState('project.json'), before);
  }
});

test('budget alert questions cannot reuse setting-approval decisions', () => {
  const escalation = { settings: ['budget.raise'], change: { scope: 'project', what: 'tokens', limit: 10 } };
  const st = { decisions: { next: 2, decisions: [{ id: 'D1', status: 'open', approval_request: true, escalation }] } };
  const emitted = [];
  const emit = (task, detail, cmd) => emitted.push({ task, detail, cmd });
  const opened = Authority.escalateQuestion('worker', st, emit, escalation, 'Budget crossed', 'Choose a limit', ['T1']);
  assert.equal(opened.decision.id, 'D2');
  assert.equal(opened.opened, true);
  assert.equal(opened.decision.approval_request, undefined);
  assert.deepEqual(opened.decision.blocks, ['T1']);
  const repeated = Authority.escalateQuestion('worker', st, emit, escalation, 'Budget crossed', 'Choose a limit', ['T1']);
  assert.equal(repeated.decision.id, 'D2');
  assert.equal(repeated.opened, false);
  assert.equal(emitted.length, 1);
});
