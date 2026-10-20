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
  if (!${late} && fs.existsSync(held)) throw error(unit.task);
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

for (const kind of ['worker', 'reviewer']) {
  for (const stage of ['precheck', 'spawn check', 'admit', ...(kind === 'worker' ? ['dispatch lock'] : [])]) {
    test(stage === 'dispatch lock' ? 'a dispatch lock stops both refill kinds'
      : `a ${kind} deferral at ${stage} leaves the other kind dispatchable`, (t) => {
      const h = fixture(t);
      const sha = h.json(['task', 'show', 'T1']).sha;
      const blocked = kind === 'worker' ? 'T2' : 'T1';
      const admitted = kind === 'worker' ? 'T1' : 'T2';
      h.ok(['task', 'update', blocked, '--priority', 'urgent']);
      h.ok(['task', 'add', '--title', 'Same kind sibling', '--acceptance', 'works', '--tier', 'easy']);
      h.ok(['brief', 'set', 'T3', '-'], { input: 'Implement T3.\n' });
      if (kind === 'reviewer') {
        h.ok(['claim', 'T3', '--agent', 'worker']);
        h.ok(['submit', 'T3', '--sha', sha, '--pr', '7', '--agent', 'worker']);
        for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T3', '--agent', 'orchestrator']);
      }
      const seed = path.join(h.base, 'seed-deferral');
      const held = path.join(h.base, 'kind-held');
      const trace = path.join(h.base, 'kind-checks.jsonl');
      fs.writeFileSync(seed, '');
      fs.writeFileSync(held, '');
      const preload = path.join(h.base, 'kind-governor.js');
      fs.writeFileSync(preload, `const fs = require('node:fs');
const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
const check = G.check, admit = G.admit;
const A = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation.js'))});
const refill = A.refillWorkers;
let pass = 0;
A.refillWorkers = (ctx, attempt) => { pass += 1; return refill(ctx, attempt); };
const denied = (ctx, unit, op) => {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ op, task: unit.task, kind: unit.kind, phase: ctx.flags.task ? 'spawn' : 'refill', pass }) + '\\n');
  const seed = unit.kind === 'reviewer' && fs.existsSync(${JSON.stringify(seed)});
  const held = unit.kind === ${JSON.stringify(kind)} && fs.existsSync(${JSON.stringify(held)});
  const stage = ${JSON.stringify(stage)};
  if (seed || held && (stage === 'precheck' && op === 'check'
    || stage === 'spawn check' && op === 'check' && ctx.flags.task
    || stage === 'admit' && op === 'admit')) {
    throw Object.assign(new TowerCraneError(3, unit.task + ': ' + unit.kind + ' deferred by the host governor: kind-specific memory'),
      { governorDeferred: true, task: unit.task, kind: unit.kind, reason: 'kind-specific memory' });
  }
};
G.check = (ctx, unit) => { denied(ctx, unit, 'check'); return check(ctx, unit); };
G.admit = (ctx, unit) => { denied(ctx, unit, 'admit'); return admit(ctx, unit); };
const Spawn = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'spawn.js'))});
const spawn = Spawn.spawn;
Spawn.spawn = (ctx) => {
  if (${JSON.stringify(stage)} === 'dispatch lock' && ctx.flags.task === 'T2' && fs.existsSync(${JSON.stringify(held)})) {
    throw Object.assign(new TowerCraneError(3, 'fixture dispatch lock'), { dispatchLocked: true });
  }
  return spawn(ctx);
};
`);
      for (const id of kind === 'reviewer' ? ['T1', 'T3'] : ['T1']) {
        assert.equal(h.run(['accept', id, '--agent', 'orchestrator'], { pre: ['--require', preload] }).code, 3);
      }
      fs.unlinkSync(seed);
      fs.writeFileSync(trace, '');
      const pass = () => h.run(['wait', '--after', String(fs.statSync(path.join(h.state, 'events.jsonl')).size),
        '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator'], { pre: ['--require', preload] }); // wait-allow: each bounded wait drives a kind-specific refill
      const result = pass();
      assert.equal(result.code, 2, result.stderr);
      const spawns = h.logs().filter((e) => e.cmd === 'spawn');
      assert.equal(spawns.some((e) => e.task === admitted), stage !== 'dispatch lock',
        'only a dispatch lock holds the other kind');
      assert.equal(spawns.some((e) => [blocked, 'T3'].includes(e.task)), false, 'the deferred kind and its sibling stay queued');
      const checks = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
      for (const unit of ['worker', 'reviewer']) {
        assert.equal(checks.filter((c) => c.op === 'check' && c.phase === 'refill' && c.pass === 1 && c.kind === unit).length, 1,
          'each kind gets one precheck in the first refill pass');
      }
      assert.equal(checks.some((c) => c.phase === 'spawn' && c.task === 'T3'), false, 'a refusal skips later tasks of its own kind');
      fs.unlinkSync(held);
      assert.equal(pass().code, 2);
      assert.ok(h.logs().some((e) => e.cmd === 'spawn' && e.task === blocked), 'the deferred kind retries once admitted');
    });
  }
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
