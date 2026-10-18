'use strict';

// The owner sets policy once and the engine applies it: moot decisions close
// themselves, failures main shares go to the orchestrator, the orchestrator's
// own holds are its to cancel, a standing publish policy releases without a
// per-release ask, and only a crisis reaches the owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const orchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator' } };
const worker = (id) => ({ env: { TOWER_CRANE_AGENT: `worker-${id}-1`, TOWER_CRANE_TASK: id } });
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const decision = (h, id) => h.readState('decisions.json').decisions.find((d) => d.id === id);

// The tests evidence the gate records for a failure every failing name of
// which also fails on the base (T407).
function sharedMainFailure(h, id) {
  const tasks = h.readState('tasks.json');
  const task = tasks.tasks.find((t) => t.id === id);
  task.evidence.push({ type: 'tests', ok: false, sha: 'a'.repeat(40), agent: 'automation', revision: task.revision, at: new Date().toISOString(),
    summary: 'test/live-sandbox.test.js: not logged in', infrastructure_failure: true, main_failure: { base: 'b'.repeat(10), names: ['live claude login'] } });
  h.writeState('tasks.json', tasks);
}

function github(t) {
  const h = cachedFixture(t, 'owner-burden', (seed) => {
    const sha = gateFixture(seed);
    seed.init(['--repo', 'acme/demo', '--base', 'main', '--workers', '8']);
    fs.writeFileSync(path.join(seed.base, 'tools', 'gh'),
      `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures', 'inbox-gh.js'))});\n`);
    seed.env.INBOX_GITHUB = path.join(seed.base, 'github.json');
    fs.writeFileSync(seed.env.INBOX_GITHUB, JSON.stringify({
      calls: [], prs: { 7: { state: 'OPEN', headRefOid: sha, headRefName: 'fixture-change', baseRefName: 'main',
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: 'https://github.com/acme/demo/pull/7' } },
    }));
    return { sha };
  });
  h.mainCI = (conclusion) => {
    const data = JSON.parse(fs.readFileSync(h.env.INBOX_GITHUB, 'utf8'));
    data.main_runs = [{ id: 1001, run_number: 50, run_attempt: 1, workflow_id: 11, name: 'CI', path: '.github/workflows/ci.yml',
      event: 'push', status: 'completed', conclusion, head_sha: h.sha, html_url: 'https://github.com/acme/demo/actions/runs/1001' }];
    data.jobs = { 1001: [] };
    fs.writeFileSync(h.env.INBOX_GITHUB, JSON.stringify(data));
    fs.rmSync(path.join(h.state, 'main-ci-cache.json'), { force: true });
  };
  h.add = (title, args = []) => h.json(['task', 'add', '--title', title, '--kind', 'docs', '--acceptance', 'works', ...args]).id;
  // A release task accepted through its gates: a spawned reviewer's review and the full suite at its head.
  h.release = () => {
    const id = h.add('Release 0.1.5');
    h.ok(['brief', 'set', id, '-'], { input: 'release\n' });
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', h.sha, '--pr', '7', '--agent', `worker-${id}`]);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    h.ok(['check', 'tests', id]);
    h.ok(['check', 'ci', id]);
    return id;
  };
  return h;
}

const POLICY = JSON.stringify({ conditions: ['review_clean', 'full_suite', 'main_ci_green'] });

test('a decision closes itself as moot once every task it blocks is cancelled, superseded or accepted, and an approval request once its task closes', (t) => {
  const h = makeRepo(t);
  h.init();
  for (const title of ['Cancelled', 'Superseded', 'Replacement', 'Budgeted']) h.ok(['task', 'add', '--title', title, '--acceptance', 'works']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which parser?', '--option', 'a', '--option', 'b', '--blocks', 'T1'], worker('T1'));
  h.ok(['ask', '--kind', 'technical', '--question', 'Keep both?', '--option', 'yes', '--option', 'no', '--blocks', 'T2', '--blocks', 'T3'], worker('T2'));
  h.ok(['task', 'update', 'T4', '--budget-hours', '2']);
  const raise = h.run(['task', 'update', 'T4', '--budget-hours', '5', '--agent', 'orchestrator'], orchestrator);
  assert.equal(raise.code, 1, raise.stderr);
  assert.match(raise.stderr, /opened D3/);

  h.ok(['task', 'update', 'T1', '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  const moot = decision(h, 'D1');
  assert.deepEqual([moot.status, moot.withdrawn_by, moot.moot, moot.withdraw_reason], ['withdrawn', 'engine', true, 'moot: T1 cancelled']);
  const closed = events(h).findLast((e) => e.cmd === 'decision withdraw');
  assert.deepEqual([closed.type, closed.agent, closed.detail], ['decision-withdrawn', 'orchestrator',
    { decision: 'D1', reason: 'moot: T1 cancelled', blocks: ['T1'], withdrawn_by: 'engine', moot: true }]);

  // One blocked task closing is not enough while another is live.
  h.ok(['task', 'update', 'T2', '--superseded-by', 'T3', '--agent', 'orchestrator'], orchestrator);
  assert.equal(decision(h, 'D2').status, 'open');
  h.ok(['task', 'update', 'T3', '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  assert.equal(decision(h, 'D2').withdraw_reason, 'moot: T2 superseded by T3, T3 cancelled');

  // The owner's approval request for T4's budget names T4; cancelling T4 makes it moot too.
  assert.equal(decision(h, 'D3').status, 'open');
  h.ok(['task', 'update', 'T4', '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  assert.deepEqual([decision(h, 'D3').status, decision(h, 'D3').withdraw_reason], ['withdrawn', 'moot: T4 cancelled']);
  assert.equal(h.ok(['decisions', '--open']), 'no open decisions');
});

test('a worker question about a failure main shares goes to the orchestrator; credential is only for a grant', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Host-only failure', '--acceptance', 'works']);
  h.ok(['task', 'add', '--title', 'Plain', '--acceptance', 'works']);
  sharedMainFailure(h, 'T1');

  // D49's shape: a credential kind with no grant, about a host failure main shares.
  const routed = h.ok(['ask', '--kind', 'credential', '--question', 'Can the owner restore the host Claude login?',
    '--option', 'restore', '--option', 'wait', '--blocks', 'T1'], worker('T1'));
  assert.equal(routed, `D1 (routed to the orchestrator: T1's tests failure also fails on main at ${'b'.repeat(10)})`);
  // D47's shape: a tests waiver tagged owner-required.
  h.ok(['ask', '--kind', 'setting', '--setting', 'waive.tests', '--owner-required', 'only the owner waives tests',
    '--question', 'Waive the tests gate?', '--option', 'waive', '--option', 'wait', '--blocks', 'T1'], worker('T1'));
  const [first, second] = h.readState('decisions.json').decisions;
  assert.deepEqual([first.kind, first.technical, first.routed.to, first.routed.asked_kind], ['technical', true, 'orchestrator', 'credential']);
  assert.deepEqual([second.kind, second.technical, second.escalation, second.owner_required, second.routed.dropped, second.routed.owner_required],
    ['technical', true, undefined, null, ['waive.tests'], 'only the owner waives tests']);
  assert.deepEqual(events(h).findLast((e) => e.cmd === 'ask').detail.routed.names, ['live claude login']);
  h.ok(['answer', 'D1', '--choice', 'wait', '--agent', 'orchestrator'], orchestrator);
  h.ok(['answer', 'D2', '--choice', 'wait', '--agent', 'orchestrator'], orchestrator);

  // Money and a real grant stay with the owner even there.
  h.ok(['ask', '--kind', 'spend', '--question', 'Rent a host?', '--option', 'yes', '--option', 'no', '--blocks', 'T1'], worker('T1'));
  h.ok(['ask', '--kind', 'credential', '--setting', 'env', '--question', 'Provide NPM_TOKEN?', '--option', 'yes', '--option', 'no', '--blocks', 'T1'], worker('T1'));
  for (const id of ['D3', 'D4']) {
    assert.equal(decision(h, id).routed, undefined);
    assert.match(h.run(['answer', id, '--choice', 'yes', '--agent', 'orchestrator'], orchestrator).stderr, /only the owner answers it/);
  }

  // Without a failure main shares, a credential kind must name the grant.
  const bare = h.run(['ask', '--kind', 'credential', '--question', 'Fix the harness login?', '--option', 'yes', '--option', 'no', '--blocks', 'T2'], worker('T2'));
  assert.equal(bare.code, 2, bare.stderr);
  assert.match(bare.stderr, /--kind credential is for a request that grants a credential or loosens a sandbox/);
  assert.equal(h.readState('decisions.json').decisions.length, 4);
});

test('cancelling a task past the orchestrator\'s own hold is operational; the owner\'s or a worker\'s hold stays the owner\'s', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Native finish', '--acceptance', 'works', '--needs-owner', 'orchestrator finishes this natively', '--agent', 'orchestrator'], orchestrator);
  h.ok(['task', 'add', '--title', 'Owner call', '--acceptance', 'works', '--needs-owner', 'the owner picks the vendor']);
  h.ok(['task', 'add', '--title', 'Older hold', '--acceptance', 'works']);
  h.ok(['task', 'add', '--title', 'Worker hold', '--acceptance', 'works']);
  h.ok(['task', 'update', 'T3', '--needs-owner', 'held before the setter was kept', '--agent', 'orchestrator'], orchestrator);
  h.ok(['task', 'update', 'T4', '--needs-owner', 'a worker asked for the owner', '--agent', 'worker-T4-1'], { env: { TOWER_CRANE_AGENT: 'worker-T4-1' } });
  const tasks = h.readState('tasks.json');
  assert.deepEqual(tasks.tasks.map((x) => x.needs_owner_by), [{ agent: 'orchestrator', role: 'orchestrator' }, { agent: 'owner', role: 'owner' },
    { agent: 'orchestrator', role: 'orchestrator' }, { agent: 'worker-T4-1', role: 'agent' }]);
  // A hold recorded before needs_owner_by existed is traced to the event that set it.
  delete tasks.tasks[2].needs_owner_by;
  h.writeState('tasks.json', tasks);

  for (const id of ['T1', 'T3']) h.ok(['task', 'update', id, '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  assert.deepEqual(h.readState('tasks.json').tasks.slice(0, 3).map((x) => x.status), ['cancelled', 'todo', 'cancelled']);
  const audits = events(h).filter((e) => e.cmd === 'setting' && e.detail.settings['task.cancel_hold']);
  assert.deepEqual(audits.map((e) => [e.detail.actor, e.detail.settings]), [['orchestrator', { 'task.cancel_hold': 'operational' }], ['orchestrator', { 'task.cancel_hold': 'operational' }]]);
  assert.deepEqual(h.readState('decisions.json').decisions, []);

  for (const [id, d] of [['T2', 'D1'], ['T4', 'D2']]) {
    const asked = h.run(['task', 'update', id, '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
    assert.equal(asked.code, 1, asked.stderr);
    assert.match(asked.stderr, new RegExp(`task\\.cancel_needs_owner is owner-required; opened ${d}`));
  }
  // owner-done clears the hold and its setter together.
  h.ok(['owner-done', 'T2']);
  assert.equal(h.readState('tasks.json').tasks[1].needs_owner_by, undefined);
});

test('a crisis opens an owner decision and messages the owner; status and inbox say so', (t) => {
  const h = github(t);
  assert.match(h.ok(['status']), /^owner: nothing needed$/m);
  assert.equal(h.json(['inbox', '--agent', 'orchestrator'], orchestrator).owner.line, 'owner: nothing needed');
  const unclassed = h.run(['ask', '--kind', 'crisis', '--question', 'Disk is full', '--agent', 'orchestrator'], orchestrator);
  assert.equal(unclassed.code, 2, unclassed.stderr);
  assert.match(unclassed.stderr, /--kind crisis and --crisis CLASS go together/);
  const gated = h.add('Gated on the host');
  h.ok(['ask', '--kind', 'crisis', '--crisis', 'host', '--question', 'The gate host disk is full', '--blocks', gated, '--agent', 'orchestrator'], orchestrator);
  // The disk stays full when the task it blocked is dropped: a crisis is never moot.
  h.ok(['task', 'update', gated, '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  const d = decision(h, 'D1');
  assert.deepEqual([d.kind, d.crisis, d.technical, d.status], ['crisis', 'host', false, 'open']);
  const told = events(h).findLast((e) => e.cmd === 'msg');
  assert.deepEqual(told.detail, { to: 'owner', text: 'crisis (host stability: OOM, fork storm, disk full): The gate host disk is full (D1)' });
  assert.match(h.run(['answer', 'D1', '--choice', 'ok', '--agent', 'orchestrator'], orchestrator).stderr, /D1 is a crisis decision; only the owner answers it/);
  assert.match(h.ok(['status']), /^owner: crisis D1 \(host\): The gate host disk is full$/m);
  assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator'], orchestrator).owner.crisis, [{ id: 'D1', crisis: 'host', question: 'The gate host disk is full' }]);
  h.ok(['answer', 'D1', '--choice', 'freed 40 GB']);
  // A grant request waits on the owner without being a crisis.
  h.run(['project', 'set', '--merge-admin', 'true', '--agent', 'orchestrator'], orchestrator);
  assert.match(h.ok(['status']), /^owner: no crisis; waiting when convenient: D2$/m);
});

test('the owner\'s standing publish policy releases an accepted task while its conditions hold, and asks the owner when one fails', (t) => {
  const h = github(t);
  const set = h.run(['project', 'set', '--publish-policy', POLICY, '--agent', 'orchestrator'], orchestrator);
  assert.equal(set.code, 1, set.stderr);
  assert.match(set.stderr, /publish\.policy is owner-required; opened D1/);
  assert.equal(h.run(['project', 'set', '--publish-policy', '{"conditions":["tests_pass"]}']).code, 2);
  h.ok(['project', 'set', '--publish-policy', POLICY]);
  assert.deepEqual(h.readState('project.json').publish_policy, JSON.parse(POLICY));
  assert.equal(decision(h, 'D1').applied.by, 'owner', 'the owner setting it retires the request');

  const id = h.release();
  const publish = ['ask', '--setting', 'publish', '--change', JSON.stringify({ task: id, version: '0.1.5' }), '--agent', 'orchestrator'];
  // Submitted, not accepted: the policy does not hold, and the owner's decision names why.
  h.mainCI('success');
  const early = h.run(publish, orchestrator);
  assert.equal(early.code, 1, early.stderr);
  assert.match(early.stderr, new RegExp(`publish is owner-required; opened D2 .*the owner's publish policy did not hold: ${id} is submitted, not accepted`));
  assert.match(decision(h, 'D2').why, /publish policy did not hold/);
  // Accepting the release is what the publish waits for, not what makes it moot.
  h.ok(['accept', id]);
  assert.equal(decision(h, 'D2').status, 'open');
  h.ok(['decision', 'withdraw', 'D2', '--reason', 'asked too early', '--agent', 'orchestrator'], orchestrator);

  h.mainCI('failure');
  const red = h.run(publish, orchestrator);
  assert.equal(red.code, 1, red.stderr);
  assert.match(red.stderr, /opened D3 .*main_ci_green: main CI is red: CI run 1001/);
  // D3 names a task that was accepted before it opened, so no later write makes it moot.
  h.ok(['ask', '--kind', 'technical', '--question', 'Tag the release now?', '--option', 'yes', '--option', 'no', '--blocks', id], worker(id));
  h.add('Later work');
  assert.deepEqual(['D3', 'D4'].map((d) => decision(h, d).status), ['open', 'open']);
  h.ok(['decision', 'withdraw', 'D4', '--reason', 'tagged'], worker(id));
  h.ok(['decision', 'withdraw', 'D3', '--reason', 'main is red', '--agent', 'orchestrator'], orchestrator);

  h.mainCI('success');
  const before = h.readState('decisions.json').decisions.length;
  assert.match(h.ok(publish, orchestrator), new RegExp(`publish: the owner's publish policy holds for ${id} \\(review_clean, full_suite, main_ci_green\\); go ahead`));
  assert.equal(h.readState('decisions.json').decisions.length, before, 'no decision opens under the policy');
  const audit = events(h).findLast((e) => e.cmd === 'setting');
  assert.deepEqual([audit.task, audit.detail.actor, audit.detail.settings, audit.detail.policy.conditions.map((c) => c.ok), audit.detail.policy.sha],
    [id, 'orchestrator', { publish: 'owner-required' }, [true, true, true], h.sha]);
});

test('an ordinary day opens no owner decision: moot decisions, a failure main shares, holds and a release under policy', (t) => {
  const h = github(t);
  h.ok(['project', 'set', '--publish-policy', POLICY]);
  h.mainCI('success');
  const release = h.release();
  h.ok(['ask', '--kind', 'technical', '--question', 'Which changelog heading?', '--option', 'a', '--option', 'b', '--blocks', release], worker(release));
  const dropped = h.add('Dropped idea');
  h.ok(['ask', '--kind', 'technical', '--question', 'Keep the idea?', '--option', 'yes', '--option', 'no', '--blocks', dropped], worker(dropped));
  const host = h.add('Host-only failure');
  sharedMainFailure(h, host);
  h.ok(['ask', '--kind', 'credential', '--question', 'Restore the host harness login?', '--option', 'restore', '--option', 'wait', '--blocks', host], worker(host));
  const held = h.add('Held for a native finish', ['--needs-owner', 'orchestrator finishes it natively', '--agent', 'orchestrator']);

  h.ok(['task', 'update', dropped, '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  h.ok(['task', 'update', held, '--status', 'cancelled', '--agent', 'orchestrator'], orchestrator);
  h.ok(['answer', 'D3', '--choice', 'wait', '--agent', 'orchestrator'], orchestrator);
  h.ok(['accept', release]);
  h.ok(['ask', '--setting', 'publish', '--change', JSON.stringify({ task: release }), '--agent', 'orchestrator'], orchestrator);

  const all = h.readState('decisions.json').decisions;
  assert.deepEqual(all.map((d) => [d.id, d.status, d.moot === true]), [['D1', 'withdrawn', true], ['D2', 'withdrawn', true], ['D3', 'answered', false]]);
  assert.deepEqual(all.filter((d) => d.status === 'open'), []);
  assert.ok(all.every((d) => d.technical === true && !d.escalation && !d.owner_required), 'no decision of the day was the owner\'s');
  assert.deepEqual(events(h).filter((e) => e.cmd === 'msg' && e.detail.to === 'owner'), []);
  assert.match(h.ok(['status']), /^owner: nothing needed$/m);
  assert.equal(h.json(['inbox', '--agent', 'orchestrator'], orchestrator).owner.line, 'owner: nothing needed');
});
