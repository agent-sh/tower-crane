'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { setup, configureHarness } = require('./automation-helpers');
const { gateEvidence } = require('./gate-helpers');

function fixture(t) {
  const h = cachedFixture(t, 'reviewer-refill', (repo) => {
    const h = setup(null, { repo });
    configureHarness(h);
    h.submit();
    for (const gate of ['tests', 'clean', 'ci']) gateEvidence(h, gate, 'orchestrator');
    h.ok(['task', 'add', '--title', 'Worker', '--acceptance', 'works', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T2', '-'], { input: 'Implement T2.\n' });
    h.ok(['project', 'set', '--workers', '1']);
    const script = path.join(h.base, 'finish.js');
    fs.writeFileSync(script, 'process.exit(0);\n');
    for (const rung of ['easy', 'review']) {
      h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
    }
    return h;
  });
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

for (const [name, reviewPriority, workerPriority, late, full, first] of [
  ['urgent reviewer before normal worker', 'urgent', 'normal', false, false, 'T1'],
  ['urgent worker before normal reviewer', 'normal', 'urgent', false, false, 'T2'],
  ['late admission deferral', 'urgent', 'normal', true, false, 'T1'],
  ['full worker capacity', 'urgent', 'normal', false, true, 'T1'],
  ['normal worker unblocks a dependent', 'normal', 'normal', false, false, 'T2'],
]) {
  test(`refill retries a deferred reviewer: ${name}`, (t) => {
    const h = fixture(t);
    h.ok(['task', 'update', 'T1', '--priority', reviewPriority]);
    h.ok(['task', 'update', 'T2', '--priority', workerPriority]);
    if (name === 'normal worker unblocks a dependent') {
      h.ok(['task', 'add', '--title', 'Dependent', '--acceptance', 'works', '--dep', 'T2']);
    }
    if (full) h.ok(['claim', 'T2', '--agent', 'native-worker']);
    const held = path.join(h.base, 'governor-held');
    fs.writeFileSync(held, '');
    const preload = path.join(h.base, 'review-governor.js');
    fs.writeFileSync(preload, `const fs = require('node:fs');
const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
const held = ${JSON.stringify(held)};
const error = (task) => Object.assign(new TowerCraneError(3, task + ': reviewer deferred by the host governor: fixture pressure'),
  { governorDeferred: true, task, kind: 'reviewer', reason: 'fixture pressure' });
const check = G.check, admit = G.admit;
G.check = (ctx, unit) => {
  if (!${late} && unit.kind === 'reviewer' && fs.existsSync(held)) throw error(unit.task);
  return check(ctx, unit);
};
G.admit = (ctx, unit) => {
  if (${late} && unit.kind === 'reviewer' && fs.existsSync(held)) throw error(unit.task);
  return admit(ctx, unit);
};
`);
    const defer = h.run(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] });
    assert.equal(defer.code, 3, defer.stderr);
    assert.match(defer.stderr, /fixture pressure/);
    const status = h.json(['status']);
    const statusText = h.ok(['status']);
    // Each new wait performs a refill without needing a submission event.
    const pass = () => h.run(['wait', '--after', String(fs.statSync(path.join(h.state, 'events.jsonl')).size),
      '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator'], { pre: ['--require', preload] }); // wait-allow: each bounded wait drives one refill pass
    if (first === 'T1' && !late) {
      assert.equal(pass().code, 2);
      assert.equal(pass().code, 2);
      assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'deferral holds the lower-ranked worker too');
      assert.equal(h.logs().filter((e) => e.cmd === 'review dispatch deferred').length, 1, 'unchanged deferrals do not append duplicates');
    }
    fs.unlinkSync(held);
    const result = pass();
    assert.equal(result.code, 2, result.stderr);
    const spawns = h.logs().filter((e) => e.cmd === 'spawn');
    assert.equal(spawns[0]?.task, first, 'dispatches share priority order');
    assert.equal(spawns.filter((e) => e.task === 'T1' && e.detail.role === 'reviewer').length, 1);
    assert.deepEqual(status.deferred_reviewers.map((d) => [d.id, d.reason]), [['T1', 'fixture pressure']]);
    assert.match(statusText, /deferred reviewers: T1 .*fixture pressure/);
    assert.deepEqual(h.json(['status']).deferred_reviewers, [], 'dispatch clears the queue');
    assert.equal(pass().code, 2);
    assert.equal(h.logs().filter((e) => e.task === 'T1' && e.cmd === 'spawn').length, 1, 'a drained queue never dispatches twice');
  });
}

test('reviewer dispatch debt follows the current submission and verdict', () => {
  const R = require('../lib/reviewer');
  const sha = 'a'.repeat(40), other = 'b'.repeat(40);
  const debt = { sha, revision: 1, reason: 'pressure', since: '2026-10-20T12:00:00Z' };
  const task = { id: 'T1', status: 'submitted', sha, revision: 1, evidence: [], submitted_by: 'worker' };
  const deferred = { cmd: 'review dispatch deferred', task: 'T1', detail: debt };
  const spawn = { cmd: 'spawn', task: 'T1', detail: { role: 'reviewer', sha, revision: 1 } };
  const review = { type: 'review', sha, revision: 1, agent: 'owner', ok: true };
  for (const [name, changed, events, expected] of [
    ['owed', {}, [deferred], 1],
    ['head changed', { sha: other }, [deferred], 0],
    ['revision changed', { revision: 2 }, [deferred], 0],
    ['reworked', { status: 'rework' }, [deferred], 0],
    ['accepted', { status: 'accepted' }, [deferred], 0],
    ['cancelled', { status: 'cancelled' }, [deferred], 0],
    ['dispatched', {}, [deferred, spawn], 0],
    ['older spawn', {}, [spawn, deferred], 1],
    ['other head spawned', {}, [deferred, { ...spawn, detail: { ...spawn.detail, sha: other } }], 1],
    ['other task spawned', {}, [deferred, { ...spawn, task: 'T2' }], 1],
    ['worker spawned', {}, [deferred, { ...spawn, detail: { ...spawn.detail, role: 'worker' } }], 1],
    ['passed verdict', { evidence: [review] }, [deferred], 0],
    ['failed verdict', { evidence: [{ ...review, ok: false }] }, [deferred], 0],
    ['body-only light review', { evidence: [{ ...review, ok: false, findings: [{ path: 'PR body', kind: 'false-claim', claim: 'false claim' }] }] }, [deferred], 1],
    ['stale verdict', { evidence: [{ ...review, sha: other }] }, [deferred], 1],
  ]) {
    const st = { tasks: { tasks: [{ ...task, ...changed }] }, events };
    assert.equal(R.deferredDispatches(st).length, expected, name);
  }
});
