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

test('the orchestrator answers technical decisions unless project policy turns that off', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);

  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":false}', '--agent', 'owner']);
  const off = h.run(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(off.code, 1, off.stderr);
  assert.match(off.stderr, /owner/);

  h.ok(['project', 'set', '--decision-delegation', 'null', '--agent', 'owner']);
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

test('the owner can always answer explicitly, and a false delegation policy keeps technical decisions with the owner', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres']);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":false}', '--agent', 'owner']);
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
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":false}', '--agent', 'owner']);
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

  const policyOff = h.run(['answer', 'D1', '--choice', 'redis', '--agent', spawned.orchestrator]);
  assert.equal(policyOff.code, 1, policyOff.stderr);
  assert.match(policyOff.stderr, /only the owner with explicit identity can answer D1/);
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

test('a terminal owner question is technical unless it names an owner-required setting', { skip: !PTY_AVAILABLE }, (t) => {
  const h = makeRepo(t);
  h.init();
  const env = Object.fromEntries(Object.entries(h.env).filter(([key]) => !key.startsWith('TOWER_CRANE_')));
  const asked = runPty(
    ['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--state', h.state],
    { cwd: h.repo, env },
  );
  assert.equal(asked.code, 0, asked.stderr);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.asked_by, decision.technical], ['owner', true]);
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

test('without the setting, the orchestrator answers a worker technical decision; owner-only decisions refuse it', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Choose a store', '--acceptance', 'answer is authorized']);
  assert.equal(h.readState('project.json').decision_delegation, undefined);
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } };

  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1'], worker);
  const technical = h.readState('decisions.json').decisions[0];
  assert.deepEqual([technical.asked_by, technical.technical, technical.escalation, technical.owner_required], [
    'worker-T1-1', true, undefined, undefined,
  ]);
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  const answered = h.readState('decisions.json').decisions[0];
  assert.deepEqual([answered.answered_by, answered.answer_rule], ['orchestrator', 'owner-technical-delegation']);

  h.ok(['ask', '--question', 'Rent a GPU box?', '--option', 'yes', '--option', 'no', '--owner-required', 'spend needs the owner'], worker);
  h.ok(['ask', '--question', 'Raise the budget?', '--option', 'yes', '--option', 'no', '--setting', 'budget.raise'], worker);
  const decisions = h.readState('decisions.json').decisions;
  assert.deepEqual([decisions[1].technical, decisions[1].owner_required], [false, 'spend needs the owner']);
  assert.deepEqual([decisions[2].technical, decisions[2].escalation], [false, { settings: ['budget.raise'], change: null }]);
  const before = events(h);
  const marked = h.run(['answer', 'D2', '--choice', 'yes', '--agent', 'orchestrator']);
  assert.equal(marked.code, 1, marked.stderr);
  assert.match(marked.stderr, /D2 is owner-required \(spend needs the owner\); only the owner answers it/);
  const escalated = h.run(['answer', 'D3', '--choice', 'yes', '--agent', 'orchestrator']);
  assert.equal(escalated.code, 1, escalated.stderr);
  assert.match(escalated.stderr, /D3 escalates budget\.raise to the owner/);
  assert.deepEqual(events(h), before, 'refused owner-only answers write no event');

  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":false}', '--agent', 'owner']);
  h.ok(['ask', '--question', 'Cache in memory or disk?', '--option', 'memory', '--option', 'disk'], worker);
  const kept = h.run(['answer', 'D4', '--choice', 'memory', '--agent', 'orchestrator']);
  assert.equal(kept.code, 1, kept.stderr);
  assert.match(kept.stderr, /only the owner/);
});

test('spend and credential questions stay with the owner without a marker', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Rent a GPU box', '--acceptance', 'the owner decides spend and credentials']);
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } };

  h.ok(['ask', '--question', 'May we spend $200 to rent a GPU?', '--option', 'yes', '--option', 'no', '--blocks', 'T1'], worker);
  h.ok(['ask', '--question', 'Will the owner provide the production API credentials?', '--option', 'yes', '--option', 'no', '--blocks', 'T1'], worker);
  const [spend, credentials] = h.readState('decisions.json').decisions;
  assert.deepEqual([spend.technical, spend.owner_required], [false, 'asks for spend']);
  assert.deepEqual([credentials.technical, credentials.owner_required], [false, 'asks for credentials']);

  const before = events(h);
  for (const [id, reason] of [['D1', 'asks for spend'], ['D2', 'asks for credentials']]) {
    const refused = h.run(['answer', id, '--choice', 'yes', '--agent', 'orchestrator']);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`${id} is owner-required \\(${reason}\\); only the owner answers it`));
  }
  assert.deepEqual(events(h), before, 'refused owner-only answers write no event');

  // A decision opened before topics were stored has no owner_required, so its text still keeps it with the owner.
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1'], worker);
  const legacy = h.readState('decisions.json');
  legacy.decisions[2].question = 'Pay for the Redis plan?';
  h.writeState('decisions.json', legacy);
  const legacyRefused = h.run(['answer', 'D3', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(legacyRefused.code, 1, legacyRefused.stderr);
  assert.match(legacyRefused.stderr, /D3 is owner-required \(asks for spend\); only the owner answers it/);

  h.ok(['answer', 'D1', '--choice', 'yes', '--agent', 'owner']);
  assert.equal(h.readState('decisions.json').decisions[0].answer_rule, 'owner');
});

test('credential and spend asks stay with the owner however they are phrased, options included', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Wire the proxy', '--acceptance', 'the proxy runs with the owner decision']);
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: 'T1' } };
  const asks = [
    ['Which HF_TOKEN should the worker use?', ['yes', 'no'], 'asks for credentials'],
    ['Use MY_API_KEY for the proxy?', ['yes', 'no'], 'asks for credentials'],
    ['Subscribe to the paid plan?', ['yes', 'no'], 'asks for spend'],
    ['Where should the worker run?', ['rent an H100', 'use the local GPU'], 'asks for spend'],
    ['Which cache key layout should the worker use?', ['prefix', 'hash'], null],
  ];
  for (const [question, options] of asks) {
    h.ok(['ask', '--question', question, ...options.flatMap((o) => ['--option', o]), '--blocks', 'T1'], worker);
  }
  const decisions = h.readState('decisions.json').decisions;
  assert.deepEqual(
    decisions.map((d) => [d.technical, d.owner_required ?? null]),
    asks.map(([, , reason]) => [reason === null, reason]),
  );

  const before = events(h);
  for (const [i, [, options, reason]] of asks.entries()) {
    if (!reason) continue;
    const refused = h.run(['answer', `D${i + 1}`, '--choice', options[0], '--agent', 'orchestrator']);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, new RegExp(`D${i + 1} is owner-required \\(${reason}\\); only the owner answers it`));
  }
  assert.deepEqual(events(h), before, 'refused owner-only answers write no event');

  h.ok(['answer', 'D5', '--choice', 'prefix', '--agent', 'orchestrator']);
  assert.equal(h.readState('decisions.json').decisions[4].answer_rule, 'owner-technical-delegation');
});
