'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, runPty, PTY_AVAILABLE } = require('./helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('only the owner or a named agent can answer, and the answer event records its rule', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Named answerer task', '--acceptance', 'the named answerer can unblock it']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--agent', 'worker-ask']);

  const before = events(h);
  const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-other']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /owner/);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.deepEqual(events(h), before, 'a refused answer writes no event');

  const delegateDenied = h.run([
    'decision', 'delegate', 'D1', '--answerers', '["worker-allowed"]', '--agent', 'worker-allowed',
  ]);
  assert.equal(delegateDenied.code, 1, delegateDenied.stderr);
  assert.match(delegateDenied.stderr, /only the owner/);
  assert.deepEqual(events(h), before, 'a worker cannot name itself');

  h.ok(['decision', 'delegate', 'D1', '--answerers', '["worker-allowed"]', '--agent', 'owner']);
  for (const startedAs of ['worker-other', 'orchestrator']) {
    const beforeSpoof = events(h);
    const spoofed = h.run(
      ['answer', 'D1', '--choice', 'redis', '--agent', 'worker-allowed'],
      { env: { TOWER_CRANE_AGENT: startedAs, TOWER_CRANE_TASK: 'T1' } },
    );
    assert.equal(spoofed.code, 1, `${startedAs}: ${spoofed.stderr}`);
    assert.match(spoofed.stderr, /worker-allowed/);
    assert.deepEqual(events(h), beforeSpoof, `${startedAs} cannot impersonate the named answerer`);
  }
  const stillDenied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-other']);
  assert.equal(stillDenied.code, 1, stillDenied.stderr);
  assert.match(stillDenied.stderr, /worker-allowed/);
  assert.match(stillDenied.stderr, /owner/);

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-allowed'], {
    env: { TOWER_CRANE_AGENT: 'worker-allowed', TOWER_CRANE_TASK: 'T1' },
  });
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.status, decision.answer, decision.answered_by, decision.answer_rule], [
    'answered', 'redis', 'worker-allowed', 'owner-named-agent',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.equal(answerEvent.agent, 'worker-allowed');
  assert.deepEqual(
    [answerEvent.detail.answered_by, answerEvent.detail.answer_rule],
    ['worker-allowed', 'owner-named-agent'],
  );
});

test('the orchestrator answers only owner-marked technical decisions when project policy allows it', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);

  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  const unmarked = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(unmarked.code, 1, unmarked.stderr);
  assert.match(unmarked.stderr, /owner/);

  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.technical, decision.answered_by, decision.answer_rule], [
    true, 'orchestrator', 'owner-technical-delegation',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.deepEqual(
    [answerEvent.agent, answerEvent.detail.answer_rule],
    ['orchestrator', 'owner-technical-delegation'],
  );
});

test('owner commands reject another process identity with or without a task binding', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);

  const shell = { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } };
  const originalProject = h.readState('project.json');
  const originalEvents = events(h);
  for (const args of [
    ['project', 'set', '--merge-admin', 'true', '--agent', 'owner'],
    ['answer', 'D1', '--choice', 'redis', '--agent', 'owner'],
  ]) {
    const refused = h.run(args, shell);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /TOWER_CRANE_AGENT names worker-T1-1/);
  }
  assert.deepEqual(h.readState('project.json'), originalProject);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.deepEqual(events(h), originalEvents);
  h.ok(['project', 'set', '--merge-admin', 'true', '--agent', 'owner']);
  assert.equal(h.readState('project.json').merge.admin, true);
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'owner']);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.answered_by, decision.answer_rule], ['owner', 'owner']);

  h.ok(['ask', '--question', 'Which cache?', '--option', 'memory', '--option', 'disk']);
  const before = events(h);
  const task = { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } };
  const refused = h.run(['answer', 'D2', '--choice', 'memory', '--agent', 'owner'], task);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /a task process never acts as owner/);
  assert.equal(h.readState('decisions.json').decisions[1].status, 'open');
  assert.deepEqual(events(h), before, 'a task process refused as owner writes no event');
});

test('a worker cannot answer under a forged orchestrator identity', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Answer a technical decision', '--acceptance', 'answer is authorized']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const before = events(h);
  const forged = h.run(
    ['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } },
  );
  assert.equal(forged.code, 1, forged.stderr);
  assert.match(forged.stderr, /only the owner.*can answer D1/);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.deepEqual(events(h), before, 'a worker cannot use a selected identity to authorize an answer');
});

test('a worker cannot delegate by passing the owner identity', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);

  const before = events(h);
  const forged = h.run(
    ['decision', 'delegate', 'D1', '--answerers', '["worker-T1-1"]', '--agent', 'owner'],
    { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } },
  );
  assert.equal(forged.code, 1, forged.stderr);
  assert.match(forged.stderr, /a task process never acts as owner/);
  assert.deepEqual(h.readState('decisions.json').decisions[0].answerers, []);
  assert.deepEqual(events(h), before, 'a worker cannot name itself as an answerer');
});

test('the owner can always answer explicitly, and technical classification alone does not delegate', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /owner/);

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'owner']);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.answered_by, decision.answer_rule], ['owner', 'owner']);
});

test('technical delegation recognizes generated orchestrators by their recorded spawn role', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Answer a technical decision', '--acceptance', 'answer is authorized']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  // Spawn records its receipt under the home's cache, so the test gets a home that has one.
  const home = path.join(h.base, 'home');
  fs.mkdirSync(path.join(home, '.cache'), { recursive: true });
  Object.assign(h.env, { HOME: home, USERPROFILE: home });
  const spawned = {};
  for (const rung of ['easy', 'orchestrator']) {
    h.ok(['ladder', 'set', rung, '--harness', 'command',
      '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
      ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
    spawned[rung] = h.json(['spawn', '--task', 'T1', '--role', rung, '--wait']).agent;
  }
  assert.match(spawned.orchestrator, /^orchestrator-T1-\d+$/);
  assert.equal(events(h).findLast((event) => event.cmd === 'spawn'
    && event.detail.agent === spawned.orchestrator).detail.role, 'orchestrator');
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['decision', 'delegate', 'D1', '--answerers', JSON.stringify([spawned.orchestrator]), '--agent', 'owner']);
  const beforeNamed = events(h);
  const namedOnly = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(namedOnly.code, 1, namedOnly.stderr);
  assert.match(namedOnly.stderr, /only the owner with explicit identity can answer D1/);
  assert.deepEqual(events(h), beforeNamed, 'naming an orchestrator alone cannot authorize an answer');
  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);

  const noPolicy = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(noPolicy.code, 1, noPolicy.stderr);
  assert.match(noPolicy.stderr, /only the owner with explicit identity can answer D1/);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  h.ok(['decision', 'delegate', 'D1', '--technical', 'false', '--agent', 'owner']);
  const unmarked = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(unmarked.code, 1, unmarked.stderr);
  assert.match(unmarked.stderr, /only the owner with explicit identity can answer D1/);

  h.ok(['decision', 'delegate', 'D1', '--technical', 'true', '--agent', 'owner']);
  const before = events(h);
  for (const agent of [spawned.easy, 'orchestrator-T1-999']) {
    const denied = h.run(['answer', 'D1', '--choice', 'redis', '--agent', agent]);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /owner/);
    assert.match(denied.stderr, /orchestrator under technical delegation/);
  }
  assert.deepEqual(events(h), before, 'refused answers write no events');

  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.answered_by, decision.answer_rule], [
    spawned.orchestrator, 'owner-technical-delegation',
  ]);
  const answerEvent = events(h).findLast((event) => event.cmd === 'answer');
  assert.deepEqual(
    [answerEvent.agent, answerEvent.detail.answered_by, answerEvent.detail.answer_rule],
    [spawned.orchestrator, spawned.orchestrator, 'owner-technical-delegation'],
  );
});

test('a terminal owner question stays with the owner', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeRepo(t);
  h.init();
  const env = Object.fromEntries(Object.entries(h.env).filter(([key]) => !key.startsWith('TOWER_CRANE_')));
  const asked = runPty(
    ['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--state', h.state],
    { cwd: h.repo, env },
  );
  assert.equal(asked.code, 0, asked.stderr);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.asked_by, decision.technical], ['owner', false]);
});

test('a worker ask is answerable by the orchestrator; an owner-required escalation is not', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Choose a store', '--acceptance', 'answer is authorized']);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } };

  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1'], worker);
  const technical = h.readState('decisions.json').decisions[0];
  assert.deepEqual([technical.asked_by, technical.technical], ['worker-T1-1', true]);
  assert.equal(technical.escalation, undefined, 'a worker question with no owner-required setting does not escalate');
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  const answered = h.readState('decisions.json').decisions[0];
  assert.deepEqual([answered.answered_by, answered.answer_rule], ['orchestrator', 'owner-technical-delegation']);

  h.ok(['ask', '--question', 'Raise the budget?', '--option', 'yes', '--option', 'no', '--setting', 'budget.raise', '--blocks', 'T1'], worker);
  const escalated = h.readState('decisions.json').decisions[1];
  assert.equal(escalated.technical, false);
  assert.deepEqual(escalated.escalation, { settings: ['budget.raise'], change: null });
  h.ok(['decision', 'delegate', 'D2', '--technical', 'true', '--agent', 'owner']);
  const before = events(h);
  const refused = h.run(['answer', 'D2', '--choice', 'yes', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /D2 escalates budget\.raise to the owner/);
  assert.deepEqual(events(h), before, 'a refused escalation answer writes no event');
  h.ok(['answer', 'D2', '--choice', 'yes', '--agent', 'owner']);
  assert.equal(h.readState('decisions.json').decisions[1].answer_rule, 'owner');
});
