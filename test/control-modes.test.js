'use strict';

// The owner runs a project either from the board or by telling the
// orchestrator. Every row of the authority table has a CLI path, the board's
// writes use the same check, and every change is audited the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, cachedFixture, BIN } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { COMMANDS } = require('../bin/tower-crane');
const Authority = require('../lib/authority');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const audits = (h) => events(h).filter((e) => e.cmd === 'setting');
const as = (agent) => ({ env: { TOWER_CRANE_AGENT: agent } });
const decisions = (h) => h.readState('decisions.json').decisions;

test('owner change matching accepts additional fields while keeping targets and replacement values exact', () => {
  const cases = [
    [{ 'merge-admin': 'true' }, { 'merge-admin': 'true', 'budget-hours': 10 }, true],
    [{ 'merge-admin': 'true' }, { 'merge-admin': 'false', 'budget-hours': 10 }, false],
    [{ decision: 'D1', answerers: ['a'] }, { decision: 'D2', answerers: ['a'], technical: true }, false],
    [{ decision: 'D1', answerers: ['a'] }, { decision: 'D1', answerers: ['a', 'b'] }, false],
    [{ ladder: { easy: { env: { A: '1', B: '2' } } } }, { ladder: { easy: { env: { B: '2', A: '1' }, scope: {} }, hard: { scope: {} } } }, true],
    [{ ladder: { easy: { env: { A: '1' } } } }, { ladder: { easy: { env: { A: '1', B: '2' } } } }, false],
    [{ ladder: { easy: { env: {} } } }, { ladder: { easy: { env: { A: '1' } } } }, false],
    [{ user_file: 'a', rung: 'easy', fallbacks: [{ env: { A: '1' } }] }, { user_file: 'b', rung: 'easy', fallbacks: [{ env: { A: '1' } }] }, false],
    [{ fallbacks: [{ model: 'a' }] }, { fallbacks: [{ model: 'a' }, { model: 'b' }] }, false],
    [{ fallbacks: [{ model: 'a' }, { model: 'b' }] }, { fallbacks: [{ model: 'b' }, { model: 'a' }] }, false],
    [{ fallbacks: null }, { fallbacks: [] }, false],
    [{ 'budget-hours': 10 }, null, false],
  ];
  for (const [requested, written, expected] of cases) {
    assert.equal(Authority.matchesOwnerChange(requested, written), expected, JSON.stringify({ requested, written }));
  }
});

async function withServe(h, fn) {
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', 'owner'], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  try {
    const { url, open } = await new Promise((resolve, reject) => {
      let out = '';
      server.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
      });
      server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    // Only the owner's one-time link carries the write token.
    const page = await (await fetch(open)).text();
    const token = /<meta name="tower-crane-token" content="([0-9a-f]{48})">/.exec(page)[1];
    const post = async (route, body) => {
      const r = await fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token }, body: JSON.stringify(body) });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    };
    await fn(post);
  } finally {
    server.kill();
    await exited;
  }
}

test('every authority row has a CLI path, and tower-crane authority lists the table', (t) => {
  const h = makeRepo(t);
  h.init();
  const rows = h.json(['authority']);
  assert.deepEqual(rows.map((r) => r.setting), Object.keys(Authority.TABLE));
  for (const row of rows) {
    assert.ok([Authority.OPERATIONAL, Authority.OWNER, Authority.REFUSED].includes(row.class), row.setting);
    // Each --flag the row names must be an option of a command it names.
    const named = COMMANDS.filter((c) => new RegExp(`(^|[\\s,(])${c.name.replace(/[-\s]/g, (m) => `\\${m}`)}(?=$|[\\s,])`).test(row.how));
    assert.ok(named.length, `${row.setting}: "${row.how}" names no tower-crane command`);
    for (const [, flag] of row.how.matchAll(/--([a-z_-]+)/g)) {
      assert.ok(named.some((c) => c.flags && Object.hasOwn(c.flags, flag)), `${row.setting}: --${flag} is not an option of ${named.map((c) => c.name).join(' or ')}`);
    }
  }
  assert.match(h.ok(['authority']), /^publish\s+owner-required\s+ask --setting publish/m);
});

test('every allowed settings change records one audit event with its actor, mode and authority class', async (t) => {
  const h = makeRepo(t);
  h.init(['--workers', '5']);
  assert.deepEqual(audits(h).map((e) => e.detail), [
    { command: 'init', actor: 'owner', mode: 'cli', settings: { 'limits.workers': 'operational' } },
  ]);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);

  h.ok(['project', 'set', '--workers', '2', '--merge-admin', 'true']);
  h.ok(['project', 'set', '--lease-minutes', '30'], as('orchestrator'));
  // Refused and escalated changes record no audit event.
  assert.equal(h.run(['project', 'set', '--workers', '9'], as('worker-T1-1')).code, 1);
  assert.equal(h.run(['project', 'set', '--merge-admin', 'false'], as('orchestrator')).code, 1);
  // Unguarded settings are not audited.
  h.ok(['project', 'set', '--goal', 'a new goal'], as('orchestrator'));
  h.ok(['task', 'update', 'T1', '--tier', 'hard'], as('orchestrator'));

  await withServe(h, async (post) => {
    await post('api/tiers', { tiers: { T1: 'easy' }, base: { T1: 'hard' } });
  });
  const rest = audits(h).slice(1);
  assert.deepEqual(rest.map((e) => [e.agent, e.detail]), [
    ['owner', { command: 'project set', actor: 'owner', mode: 'cli', settings: { 'limits.workers': 'operational', 'merge.admin': 'owner-required' } }],
    ['orchestrator', { command: 'project set', actor: 'orchestrator', mode: 'cli', settings: { 'limits.lease_minutes': 'operational' } }],
    ['orchestrator', { command: 'task update', actor: 'orchestrator', mode: 'cli', settings: { 'task.tier': 'operational' } }],
    ['owner', { command: 'task update', actor: 'owner', mode: 'board', settings: { 'task.tier': 'operational' } }],
  ]);
  // The audit precedes the command's own event in the same write.
  const log = events(h);
  const i = log.findIndex((e) => e === log.find((x) => x.cmd === 'setting' && x.detail.mode === 'board'));
  assert.deepEqual([log[i + 1].cmd, log[i + 1].detail.via], ['task update', 'serve']);
});

test('the owner approves an owner-required change from the CLI or the board, and the orchestrator applies exactly that change once', async (t) => {
  const h = makeRepo(t);
  h.init();
  const admin = (value, extra = []) => h.run(['project', 'set', '--merge-admin', value, ...extra], as('orchestrator'));

  const first = admin('true', ['--workers', '4']);
  assert.equal(first.code, 1, first.stderr);
  assert.match(first.stderr, /opened D1 .*run the same command again once it is approved/);
  assert.deepEqual(decisions(h)[0].options, ['approve', 'decline']);
  assert.equal(h.readState('project.json').limits.workers, 6, 'nothing changes before the owner answers');
  assert.equal(admin('false').code, 1);
  assert.equal(decisions(h).length, 2, 'another value is another request');

  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['answer', 'D2', '--choice', 'decline']);
  // The approval covers the owner-required values; the operational part is
  // the orchestrator's either way.
  const applied = admin('true', ['--workers', '4']);
  assert.equal(applied.code, 0, applied.stderr);
  const p = h.readState('project.json');
  assert.deepEqual([p.merge.admin, p.limits.workers], [true, 4]);
  assert.deepEqual(decisions(h)[0].applied.by, 'orchestrator');
  assert.deepEqual(audits(h).at(-1).detail, {
    command: 'project set', actor: 'orchestrator', mode: 'cli', approved_by: 'D1',
    settings: { 'merge.admin': 'owner-required', 'limits.workers': 'operational' },
  });
  // The approval is used up, and a declined request stays refused.
  assert.match(admin('true', ['--workers', '4']).stderr, /opened D3 /);
  assert.match(admin('false').stderr, /opened D4 /);
  assert.equal(h.readState('project.json').merge.admin, true);

  // From the board, answering is the whole approval.
  await withServe(h, async (post) => {
    await post('api/decisions/D4/answer', { choice: 'approve' });
  });
  assert.equal(admin('false').code, 0);
  assert.equal(h.readState('project.json').merge.admin, false);
  assert.equal(audits(h).at(-1).detail.approved_by, 'D4');
});

test('an approved waiver lets the orchestrator accept, and only that approval makes its waiver count', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  h.reviewer('T1', 'r-1');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  const waive = ['accept', 'T1', '--waive', 'tests', '--reason', 'no harness yet'];

  const asked = h.run(waive, as('orchestrator'));
  assert.equal(asked.code, 1, asked.stderr);
  assert.deepEqual(decisions(h)[0].escalation, { settings: ['waive.tests'], change: { accept: 'T1', sha, revision: 1, waive: ['tests'], reason: 'no harness yet' } });
  h.ok(['answer', 'D1', '--choice', 'approve']);
  // A failed gate keeps the approval for the next try, and failed tries audit nothing.
  const waivers = () => audits(h).filter((e) => e.detail.settings['waive.tests']);
  for (let i = 0; i < 2; i++) assert.equal(h.run(waive, { env: { TOWER_CRANE_AGENT: 'orchestrator', FIXTURE_GATE_OK: '0' } }).code, 1);
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(waivers().length, 0);
  h.ok(['check', 'clean', 'T1'], as('orchestrator'));
  h.ok(waive, as('orchestrator'));
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.waived).map((e) => [e.type, e.agent, e.approved_by]), [['tests', 'orchestrator', 'D1']]);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.deepEqual(waivers().map((e) => [e.detail.command, e.detail.actor, e.detail.approved_by]), [['accept', 'orchestrator', 'D1']]);
  // The approval names T1 at its sha; the same waiver copied onto another task does not count.
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'it works']);
  h.ok(['claim', 'T2', '--agent', 'w-2']);
  h.ok(['submit', 'T2', '--sha', sha, '--agent', 'w-2']);
  const copied = h.readState('tasks.json');
  const t2 = copied.tasks.find((x) => x.id === 'T2');
  t2.evidence.push({ ...task.evidence.find((e) => e.waived), revision: t2.revision });
  h.writeState('tasks.json', copied);
  assert.equal(h.json(['task', 'show', 'T2']).gates.gates.find((g) => g.type === 'tests').ok, false);
  // A waiver naming a decision the owner never approved does not count.
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].evidence.find((e) => e.waived).approved_by = 'D2';
  h.writeState('tasks.json', tasks);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
});

for (const answered of [false, true]) {
  test(`a successful owner write retires a matching ${answered ? 'approved' : 'open'} request`, (t) => {
    const h = cachedFixture(t, 'owner-setting-requests', h => h.init());
    const args = ['project', 'set', '--merge-admin', 'true'];
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
    if (answered) h.ok(['answer', 'D1', '--choice', 'approve']);
    const pending = decisions(h)[0];
    h.ok(['project', 'set', '--merge-admin', 'false', '--workers', '3']);
    assert.deepEqual(decisions(h)[0], pending, 'another value does not retire this request');
    assert.notEqual(h.run([...args, '--workers', '0']).code, 0);
    assert.deepEqual(decisions(h)[0], pending, 'a failed write leaves the request usable');

    const before = audits(h).length;
    h.ok(args);
    const retired = decisions(h)[0];
    assert.equal(retired.applied?.by, 'owner');
    assert.equal(retired.status, 'answered');
    assert.equal(retired.answer, 'approve');
    assert.equal(retired.answered_by, 'owner');
    assert.equal(audits(h).length, before + 1);
    assert.equal(audits(h).at(-1).detail.approved_by, undefined, 'the owner acts on their own authority');
    h.ok(['project', 'set', '--merge-admin', 'false']);
    assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
    assert.equal(h.readState('project.json').merge.admin, false, 'the retry cannot overwrite the later owner choice');
  });
}

for (const field of ['hours', 'tokens']) {
  for (const unchanged of [false, true]) {
    test(`an owner ${unchanged ? 'unchanged' : 'lower'} ${field} budget write retires its earlier raise approval`, (t) => {
      const h = cachedFixture(t, 'budget-requests', h => h.init(['--budget-hours', '5', '--budget-tokens', '5']));
      const flag = `--budget-${field}`;
      const args = ['project', 'set', flag, '10'];
      assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
      h.ok(['answer', 'D1', '--choice', 'approve']);
      h.ok(['project', 'set', flag, '20']);
      const pending = decisions(h)[0];
      assert.equal(pending.applied, undefined, 'a different amount leaves the approval pending');
      if (unchanged) {
        h.ok(args, as('orchestrator'));
        assert.deepEqual(decisions(h)[0], pending, 'an operational orchestrator write does not act for the owner');
      }
      assert.notEqual(h.run([...args, '--workers', '0']).code, 0);
      assert.deepEqual(decisions(h)[0], pending, 'a failed owner write leaves the approval pending');
      const before = audits(h).length;
      h.ok(args);
      assert.equal(decisions(h)[0].applied?.by, 'owner');
      assert.deepEqual(audits(h).slice(before).map(e => e.detail), [{
        command: 'project set', actor: 'owner', mode: 'cli', settings: { 'budget.lower': 'operational' },
      }]);
      h.ok(['project', 'set', flag, '5']);
      assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
      assert.equal(h.readState('project.json').budget[field], 5, 'an old approval cannot overwrite the later owner budget');
    });
  }
}

test('an owner lower-budget write retires a combined open request with its other owner settings', (t) => {
  const h = cachedFixture(t, 'budget-requests', h => h.init(['--budget-hours', '5', '--budget-tokens', '5']));
  const args = ['project', 'set', '--merge-admin', 'true', '--budget-hours', '10', '--budget-tokens', '10'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
  h.ok(['project', 'set', '--budget-hours', '20', '--budget-tokens', '20']);
  h.ok(args);
  const retired = decisions(h)[0];
  assert.equal(retired.status, 'answered');
  assert.equal(retired.applied?.by, 'owner');
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'merge.admin': 'owner-required', 'budget.lower': 'operational' });
  h.ok(['project', 'set', '--merge-admin', 'false', '--budget-hours', '5', '--budget-tokens', '5']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
  assert.deepEqual(h.readState('project.json').budget, { hours: 5, tokens: 5 });
  assert.equal(h.readState('project.json').merge.admin, false);
});

test('operational budget edits remain outside an orchestrator approval for another setting', (t) => {
  const h = cachedFixture(t, 'budget-requests', h => h.init(['--budget-hours', '5', '--budget-tokens', '5']));
  const args = ['project', 'set', '--merge-admin', 'true', '--budget-hours'];
  assert.match(h.run([...args, '3'], as('orchestrator')).stderr, /opened D1 /);
  assert.deepEqual(decisions(h)[0].escalation, { settings: ['merge.admin'], change: { 'merge-admin': 'true' } });
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok([...args, '2'], as('orchestrator'));
  assert.equal(h.readState('project.json').budget.hours, 2);
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.deepEqual(audits(h).at(-1).detail, {
    command: 'project set', actor: 'orchestrator', mode: 'cli',
    settings: { 'merge.admin': 'owner-required', 'budget.lower': 'operational' }, approved_by: 'D1',
  });
});

test('an owner operational budget edit keeps retirement for the other requested owner setting', (t) => {
  const h = cachedFixture(t, 'budget-requests', h => h.init(['--budget-hours', '5', '--budget-tokens', '5']));
  const args = ['project', 'set', '--merge-admin', 'true', '--budget-hours', '3'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(args);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  assert.deepEqual(audits(h).at(-1).detail.settings, { 'merge.admin': 'owner-required', 'budget.lower': 'operational' });
  h.ok(['project', 'set', '--merge-admin', 'false']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
  assert.equal(h.readState('project.json').merge.admin, false);
});

test('a combined owner write retires each satisfied request without consuming unrelated ones', (t) => {
  const h = cachedFixture(t, 'budget-requests', h => h.init(['--budget-hours', '5', '--budget-tokens', '5']));
  const admin = ['project', 'set', '--merge-admin', 'true'];
  assert.match(h.run(admin, as('orchestrator')).stderr, /opened D1 /);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  assert.match(h.run(['project', 'set', '--budget-hours', '10'], as('orchestrator')).stderr, /opened D2 /);
  assert.match(h.run(['project', 'set', '--budget-tokens', '20'], as('orchestrator')).stderr, /opened D3 /);
  const combined = [...admin, '--budget-hours', '10'];
  assert.match(h.run(combined, as('orchestrator')).stderr, /opened D4 /, 'an orchestrator still needs approval for the broader request');
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(h.readState('project.json').merge?.admin ?? false, false);
  const before = decisions(h);
  assert.notEqual(h.run([...combined, '--workers', '0']).code, 0);
  assert.deepEqual(decisions(h), before, 'failed writes retire nothing');
  const count = audits(h).length;
  h.ok(combined);
  assert.deepEqual(decisions(h).map(d => d.applied?.by), ['owner', 'owner', undefined, 'owner']);
  assert.equal(decisions(h)[1].status, 'answered', 'a satisfied open request closes too');
  assert.equal(decisions(h)[2].status, 'open');
  assert.equal(audits(h).length, count + 1, 'one setting audit for the combined write');
  h.ok(['project', 'set', '--merge-admin', 'false']);
  assert.match(h.run(admin, as('orchestrator')).stderr, /opened D5 /);
  assert.equal(h.readState('project.json').merge.admin, false);
});

test('owner ladder writes satisfy requested fields within a rung and preserve replacement values', (t) => {
  const h = makeRepo(t);
  h.init();
  const args = ['ladder', 'set', 'easy', '--env', '{"ROUTE":"private"}'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['ladder', 'set', 'hard', '--env', '{"ROUTE":"private"}', '--scope', '{}']);
  assert.equal(decisions(h)[0].applied, undefined, 'another rung does not satisfy the request');
  h.ok(['ladder', 'set', 'easy', '--env', '{"ROUTE":"different"}', '--scope', '{}']);
  assert.equal(decisions(h)[0].applied, undefined, 'a different field value does not satisfy the request');
  h.ok([...args, '--scope', '{}']);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  h.ok(['ladder', 'set', 'easy', '--clear', 'env']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
  assert.equal(h.readState('project.json').ladder.easy.env, undefined);
});

test('project owner writes compare JSON field values independently of their serialization', (t) => {
  const h = makeRepo(t);
  h.init();
  const args = ['project', 'set', '--env', '{"A":"one","B":"two"}'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1 /);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(['project', 'set', '--env', '{ "B": "two", "A": "one" }', '--scope', '{}']);
  assert.equal(decisions(h)[0].applied?.by, 'owner');
  h.ok(['project', 'set', '--env', 'null']);
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D2 /);
  assert.equal(h.readState('project.json').env, undefined);
});

test('the board audits removing a tier range at its current rung just like the CLI', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Board', '--acceptance', 'works', '--tier', 'easy..hard']);
  h.ok(['task', 'add', '--title', 'CLI', '--acceptance', 'works', '--tier', 'easy..hard']);
  const before = audits(h).length;
  await withServe(h, async (post) => {
    await post('api/tiers', { tiers: { T1: 'easy' }, base: { T1: 'easy' } });
  });
  h.ok(['task', 'update', 'T2', '--tier', 'easy']);
  assert.ok(h.readState('tasks.json').tasks.every(t => t.tier === 'easy' && !t.tier_range));
  assert.deepEqual(audits(h).slice(before).map(e => e.detail), ['board', 'cli'].map(mode => ({
    command: 'task update', actor: 'owner', mode, settings: { 'task.tier': 'operational' },
  })));
});

test('owner acceptance retires a matching approval only after the gates pass', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
  const args = ['accept', 'T1', '--waive', 'tests', '--reason', 'no harness yet'];
  assert.match(h.run(args, as('orchestrator')).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  assert.equal(h.run(args, { env: { FIXTURE_GATE_OK: '0' } }).code, 1);
  assert.equal(decisions(h)[0].applied, undefined);
  h.ok(['check', 'clean', 'T1']);
  h.ok(args);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'accepted');
  assert.equal(decisions(h)[0].applied?.by, 'owner');
});

test('a spawned orchestrator applies an approved waiver under its recorded role', (t) => {
  const h = makeRepo(t);
  h.init();
  const sha = gateFixture(h);
  h.ok(['project', 'set', '--repo', 'acme/demo']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command',
    '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
  const { agent } = h.json(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait']);
  assert.match(agent, /^orchestrator-T1-\d+$/);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  h.reviewer('T1', 'r-1');
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  const waive = ['accept', 'T1', '--waive', 'tests', '--reason', 'no harness yet'];
  assert.match(h.run(waive, as(agent)).stderr, /opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  h.ok(waive, as(agent));
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  assert.equal(decisions(h)[0].applied.by, agent);
  const audit = audits(h).find((e) => e.detail.settings['waive.tests']);
  assert.deepEqual([audit.agent, audit.detail.actor, audit.detail.approved_by], [agent, 'orchestrator', 'D1']);
});

test('ask --setting requests an owner-required change no command makes, and applies the approval once', (t) => {
  const h = makeRepo(t);
  h.init();
  const publish = ['ask', '--setting', 'publish', '--change', '{"release":"v1.0.0"}'];
  const asked = h.run(publish, as('orchestrator'));
  assert.equal(asked.code, 1, asked.stderr);
  assert.match(asked.stderr, /publish is owner-required; opened D1/);
  assert.match(h.run(publish, as('orchestrator')).stderr, /opened D1 /, 'asking again waits on the same decision');
  assert.equal(decisions(h)[0].question, 'orchestrator asks the owner to change publish: {"release":"v1.0.0"}');

  assert.equal(h.run(['answer', 'D1', '--choice', 'approve'], as('orchestrator')).code, 1, 'only the owner answers');
  h.ok(['answer', 'D1', '--choice', 'approve']);
  const go = h.run(publish, as('orchestrator'));
  assert.equal(go.code, 0, go.stderr);
  assert.match(go.stdout, /publish: the owner approved D1; go ahead/);
  assert.deepEqual(audits(h).at(-1).detail, { command: 'ask', actor: 'orchestrator', mode: 'cli', approved_by: 'D1', settings: { publish: 'owner-required' } });
  assert.match(h.run(publish, as('orchestrator')).stderr, /opened D2 /);

  const operational = h.run(['ask', '--setting', 'limits.workers'], as('orchestrator'));
  assert.equal(operational.code, 1);
  assert.match(operational.stderr, /limits\.workers is operational: the orchestrator makes it with project set --workers/);
  assert.equal(h.run(['ask', '--setting', 'nope'], as('orchestrator')).code, 2);
  assert.equal(h.run(['ask', '--setting', 'publish', '--question', 'q', '--change', '{}'], as('orchestrator')).code, 2);
  assert.match(h.run(['ask', '--setting', 'publish']).stderr, /the owner makes publish changes directly/);
  assert.match(h.run(publish, as('worker-T1-1')).stderr, /only the owner/);

  // A setting some command changes is asked for by that command, which
  // applies the approval; asking here would use it up with nothing changed.
  const before = decisions(h).length;
  const owned = Object.keys(Authority.TABLE).filter((k) => Authority.classOf(k) === Authority.OWNER && k !== 'publish');
  assert.ok(owned.includes('merge.admin'));
  for (const setting of owned) {
    const r = h.run(['ask', '--setting', setting], as('orchestrator'));
    assert.equal(r.code, 1, setting);
    assert.match(r.stderr, new RegExp(`${setting.replace('.', '\\.')} is changed by .*run that command`), setting);
  }
  assert.equal(decisions(h).length, before, 'no decision opens for them');
});

test('tagged questions cannot be reused as one-use setting approvals', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ask', '--kind', 'technical', '--question', 'Discuss publishing?', '--option', 'approve', '--option', 'decline',
    '--setting', 'publish'], as('worker-T1-1'));
  const publish = ['ask', '--setting', 'publish'];
  assert.match(h.run(publish, as('orchestrator')).stderr, /opened D2/, 'an open question is not an approval request');
  h.ok(['answer', 'D1', '--choice', 'approve']);
  assert.match(h.run(publish, as('orchestrator')).stderr, /opened D2/, 'answering a question authorizes no command');
  assert.equal(decisions(h)[0].applied, undefined);
  assert.equal(audits(h).length, 0);
  h.ok(['answer', 'D2', '--choice', 'approve']);
  h.ok(publish, as('orchestrator'));
  assert.equal(audits(h).at(-1).detail.approved_by, 'D2');
  assert.equal(decisions(h)[0].applied, undefined);
});

test('an orchestrator spawn uses the owner\'s delegation approval and records it only once the spawn starts', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Run', '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'stand-in\n' });
  const rung = (program) => h.ok(['ladder', 'set', 'orchestrator', '--harness', 'command',
    '--command', JSON.stringify([program, '-e', 'process.exit(0)', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((field) => ['--clear', field])]);
  const spawn = () => h.run(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait'], as('orchestrator'));
  const delegations = () => audits(h).filter((e) => Object.hasOwn(e.detail.settings, 'delegation'));

  rung(path.join(h.base, 'missing-program'));
  const asked = spawn();
  assert.equal(asked.code, 1, asked.stderr);
  assert.match(asked.stderr, /delegation is owner-required; opened D1/);
  h.ok(['answer', 'D1', '--choice', 'approve']);
  const failed = spawn();
  assert.equal(failed.code, 1, failed.stderr);
  assert.doesNotMatch(failed.stderr, /owner-required/);
  assert.deepEqual(delegations(), [], 'a spawn that never started delegated nothing');
  assert.equal(decisions(h)[0].applied, undefined, 'and leaves the approval usable');

  rung(process.execPath);
  const started = spawn();
  assert.equal(started.code, 0, started.stderr);
  assert.equal(decisions(h)[0].applied.by, 'orchestrator');
  assert.deepEqual(delegations().map((e) => e.detail), [
    { command: 'spawn', actor: 'orchestrator', mode: 'cli', approved_by: 'D1', settings: { delegation: 'owner-required' } },
  ]);
  assert.match(spawn().stderr, /opened D2 /, 'the approval is used up');

  h.ok(['answer', 'D2', '--choice', 'approve']);
  rung(path.join(h.base, 'missing-program'));
  const args = ['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait'];
  assert.equal(h.run(args).code, 1);
  assert.equal(decisions(h)[1].applied, undefined, 'a failed owner spawn keeps the approval');
  rung(process.execPath);
  h.ok(args);
  assert.equal(decisions(h)[1].applied?.by, 'owner');
  assert.equal(delegations().at(-1).detail.actor, 'owner');
  assert.equal(delegations().at(-1).detail.approved_by, undefined);
  assert.match(spawn().stderr, /opened D3 /, 'a successful owner spawn retires the approval');
});
