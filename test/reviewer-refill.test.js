'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { setup, configureHarness } = require('./automation-helpers');
const { gateEvidence } = require('./gate-helpers');
const { waitOnRepo } = require('./signals');
const S = require('../lib/state');
const Body = require('../lib/review-body');
const { readPublished, writeAtomic, updateJson } = require('./atomic-file');

function fixture(t) {
  const h = cachedFixture(t, 'reviewer-refill', (repo) => {
    const h = setup(null, { repo });
    configureHarness(h);
    h.submit();
    for (const gate of ['tests', 'clean', 'ci']) gateEvidence(h, gate, 'orchestrator');
    // Only the easy rung runs a worker here, so urgent T2 keeps it with a recorded reason.
    h.ok(['task', 'add', '--title', 'Worker', '--acceptance', 'works', '--tier', 'easy', '--tier-reason', 'fixture worker rung']);
    h.ok(['brief', 'set', 'T2', '-'], { input: 'Implement T2.\n' });
    h.ok(['project', 'set', '--workers', '1']);
    const script = path.join(h.base, 'finish.js');
    fs.writeFileSync(script, 'process.exit(0);\n');
    for (const rung of ['easy', 'review']) {
      h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
    }
    return h;
  });
  h.logs = () => readPublished(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

for (const [name, reviewPriority, workerPriority, late, full, first] of [
  ['urgent reviewer before normal worker', 'urgent', 'normal', false, false, 'T1'],
  ['urgent worker before normal reviewer', 'normal', 'urgent', false, false, 'T2'],
  ['late admission deferral', 'urgent', 'normal', true, false, 'T1'],
  ['full worker capacity', 'urgent', 'normal', false, true, 'T1'],
  ['normal worker unblocks a dependent', 'normal', 'normal', false, false, 'T2'],
  ['direct reviewer spawn', 'urgent', 'normal', false, false, 'T1'],
  ['direct reviewer admission', 'urgent', 'normal', true, false, 'T1'],
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
    const command = name.startsWith('direct reviewer') ? ['spawn', '--task', 'T1', '--role', 'review'] : ['accept', 'T1'];
    const defer = h.run([...command, '--agent', 'orchestrator'], { pre: ['--require', preload] });
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
      const checks = readPublished(trace, 'utf8').trim().split('\n').map(JSON.parse);
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

for (const [automatic, stage, pendingExplicit] of [
  [true, 'check', false], [true, 'admit', false],
  [false, 'check', false], [false, 'admit', false],
  [true, 'check', true], [true, 'admit', true],
]) {
    test(`a deferred ${automatic ? 'automatic' : 'explicit'} light review retains its identity at ${stage}${pendingExplicit ? ' over an explicit debt' : ''}`, async (t) => {
      const h = fixture(t);
      h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
      const sha = h.json(['task', 'show', 'T1']).sha;
      const finding = { kind: 'false-claim', path: 'PR body', claim: 'An unmeasured result.' };
      h.reviewer('T1', 'first-reviewer', sha);
      const fail = (agent) => h.ok(['evidence', 'T1', '--agent', agent, '--type', 'review', '--fail', '--sha', sha,
        '--summary', 'The body still claims an unmeasured result.', '--findings', JSON.stringify([finding])]);
      fail('first-reviewer');
      const held = path.join(h.base, 'light-held');
      const input = path.join(h.base, 'light-marker.json');
      const preload = path.join(h.base, 'light-governor.js');
      fs.writeFileSync(preload, `const fs = require('node:fs');
const { readPublished } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const T = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'tasks.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
const accept = T.accept;
T.accept = (ctx) => {
  const marker = ${automatic} && fs.existsSync(${JSON.stringify(input)})
    ? JSON.parse(readPublished(${JSON.stringify(input)}, 'utf8')) : null;
  return accept({ ...ctx, automatic: !!marker, ...(marker ? { bodyRecheck: marker } : {}) });
};
for (const method of ['check', 'admit']) {
  const original = G[method];
  G[method] = (ctx, unit) => {
    if (method === ${JSON.stringify(stage)} && unit.kind === 'reviewer' && fs.existsSync(${JSON.stringify(held)})) {
      throw Object.assign(new TowerCraneError(3, unit.task + ': reviewer deferred by the host governor: light pressure'),
        { governorDeferred: true, task: unit.task, kind: unit.kind, reason: 'light pressure' });
    }
    return original(ctx, unit);
  };
}
`);
      if (pendingExplicit) {
        fs.writeFileSync(held, '');
        assert.equal(h.run(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] }).code, 3);
        assert.equal(h.json(['status']).deferred_reviewers[0].body_recheck, undefined);
      }
      for (let round = 1; round <= 2; round++) {
        const task = h.json(['task', 'show', 'T1']);
        const marker = { sha, revision: 1, pr: 7, branch: 'fixture-change',
          review: task.evidence.findLast((e) => e.type === 'review'), body_hash: `corrected-${round}` };
        writeAtomic(input, JSON.stringify(marker));
        fs.writeFileSync(held, '');
        assert.equal(h.run(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] }).code, 3);
        const debt = h.json(['status']).deferred_reviewers[0];
        const pass = () => h.run(['wait', '--after', String(fs.statSync(path.join(h.state, 'events.jsonl')).size),
          '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator'], { pre: ['--require', preload] }); // wait-allow: bounded refill before and after lifting the light-review deferral
        assert.equal(pass().code, 2);
        fs.unlinkSync(held);
        const result = pass();
        assert.equal(result.code, 2, result.stderr);
        const spawn = h.logs().findLast((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
        assert.deepEqual(spawn.detail.body_recheck, automatic ? marker : undefined, 'retry keeps the original review context');
        assert.deepEqual(debt.body_recheck, automatic ? marker : undefined);
        await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'spawn exit' && e.detail.agent === spawn.detail.agent),
          'the retried light reviewer exits', { signal: t.signal });
        fail(spawn.detail.agent);
        const now = S.loadState(h.state);
        const current = now.tasks.tasks.find((task) => task.id === 'T1');
        assert.equal(current.evidence.at(-1).body_recheck, automatic ? true : undefined, 'evidence keeps the automatic marker');
        assert.equal(Body.failures(now, current), automatic ? round : 0);
        assert.equal(!!Body.state(now, current)?.stuck, automatic && round === 2, 'only two automatic failures stop repair');
        if (automatic && round === 2) {
          assert.ok(h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.task === 'T1' && i.kind === 'review_body_stuck'),
            'the CLI surfaces the two-failure stop');
        }
      }
    });
}

for (const schedule of ['each check', 'each second']) {
  for (const stage of ['check', 'admit']) {
    test(`changing reasons ${schedule} at ${stage} keep one debt and let wait expire`, (t) => {
      const h = fixture(t);
      h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
      const latest = path.join(h.base, 'latest-governor.json');
      const preload = path.join(h.base, 'changing-governor.js');
      fs.writeFileSync(preload, `const fs = require('node:fs');
const { readPublished, writeAtomic } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
const latest = ${JSON.stringify(latest)};
for (const method of ['check', 'admit']) {
  const original = G[method];
  G[method] = (ctx, unit) => {
    if (method === ${JSON.stringify(stage)} && unit.kind === 'reviewer') {
      const prior = fs.existsSync(latest) ? JSON.parse(readPublished(latest, 'utf8')) : { checks: 0 };
      const checks = prior.checks + 1;
      // A broken self-wake loop must fail the fixture before flooding its log.
      if (checks > 32) throw new Error('runaway governor probes');
      const reading = ${JSON.stringify(schedule)} === 'each check' ? checks : Math.floor(Date.now() / 1000);
      const reason = 'load: ' + reading + ' on 16 cores';
      writeAtomic(latest, JSON.stringify({ checks, reason }));
      throw Object.assign(new TowerCraneError(3, unit.task + ': reviewer deferred by the host governor: ' + reason),
        { governorDeferred: true, task: unit.task, kind: unit.kind, reason });
    }
    return original(ctx, unit);
  };
}
const view = G.view;
G.view = (ctx, project) => {
  const current = view(ctx, project);
  if (fs.existsSync(latest)) current.deferred.push({ task: 'T1', kind: 'reviewer',
    reason: JSON.parse(readPublished(latest, 'utf8')).reason, since: '2026-10-20T12:00:00Z', at: new Date().toISOString() });
  return current;
};
`);
      assert.equal(h.run(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] }).code, 3);
      const debt = h.logs().find((e) => e.cmd === 'review dispatch deferred').detail;
      const result = h.run(['wait', '--after', String(fs.statSync(path.join(h.state, 'events.jsonl')).size),
        '--types', 'never', '--timeout', '2.1', '--agent', 'orchestrator'], { pre: ['--require', preload] }); // wait-allow: two fallback ticks exercise changing readings and the deadline
      assert.equal(h.logs().filter((e) => e.cmd === 'review dispatch deferred').length, 1, 'reading changes never append another outstanding debt');
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).type, 'timeout', 'the wait reaches its own deadline');
      const observed = JSON.parse(readPublished(latest, 'utf8'));
      assert.ok(observed.checks > 1, 'the governor is retried during the wait');
      assert.notEqual(observed.reason, debt.reason);
      const status = h.json(['status'], { pre: ['--require', preload] });
      assert.equal(status.deferred_reviewers[0].reason, observed.reason, 'status reads the latest registry hint');
      assert.equal(status.deferred_reviewers[0].since, debt.since, 'the first deferral time is stable');
      assert.ok(h.ok(['status'], { pre: ['--require', preload] })
        .includes(`deferred reviewers: T1 since ${debt.since}: ${observed.reason}`), 'text status has the live reason too');
    });
  }
}

for (const mode of ['ordinary', 'governor', 'mixed-worker', 'mixed-reviewer', 'mixed-worker-throw', 'mixed-reviewer-throw', 'same-worker', 'same-reviewer']) {
  test(`refill caches ordinary refusals independently: ${mode}`, (t) => {
    const h = fixture(t);
    const same = mode.startsWith('same-');
    const reviewerRefusal = mode.includes('reviewer');
    const refused = reviewerRefusal ? 'T1' : 'T2';
    const deferredKind = reviewerRefusal ? 'worker' : 'reviewer';
    if (same) {
      h.ok(['task', 'add', '--title', 'Deferred sibling', '--acceptance', 'works', '--tier', 'easy']);
      h.ok(['brief', 'set', 'T3', '-'], { input: 'Implement T3.\n' });
      if (reviewerRefusal) {
        h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
        const sha = h.json(['task', 'show', 'T1']).sha;
        h.ok(['claim', 'T3', '--agent', 'worker']);
        h.ok(['submit', 'T3', '--sha', sha, '--pr', '7', '--agent', 'worker']);
        for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T3', '--agent', 'orchestrator']);
      }
    }
    if (mode.startsWith('mixed-') || mode === 'same-reviewer') {
      const seed = path.join(h.base, 'cache-seed.js');
      fs.writeFileSync(seed, `const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
G.check = (ctx, unit) => { throw Object.assign(new TowerCraneError(3, 'fixture deferral'),
  { governorDeferred: true, task: unit.task, kind: unit.kind, reason: 'cache pressure' }); };
`);
      for (const id of mode === 'same-reviewer' ? ['T1', 'T3'] : ['T1']) {
        assert.equal(h.run(['accept', id, '--agent', 'orchestrator'], { pre: ['--require', seed] }).code, 3);
      }
    }
    const trace = path.join(h.base, 'cache-trace.json');
    const preload = path.join(h.base, 'cache-refill.js');
    fs.writeFileSync(preload, `const { writeAtomic } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const A = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'automation.js'))});
const T = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'tasks.js'))});
const Spawn = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'spawn.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
const mode = ${JSON.stringify(mode)}, same = ${same}, refused = ${JSON.stringify(refused)};
let probes = 0, dispatches = 0, measured = false;
// Isolate refill from concurrent gate reactions, which have separate coverage.
A.consume = async () => [];
const deferred = (task, kind) => Object.assign(new TowerCraneError(3, 'fixture governor deferral'),
  { governorDeferred: true, task, kind, reason: 'cache pressure' });
G.check = (ctx, unit) => {
  if (same) return;
  if (mode === 'ordinary') { probes++; return; }
  if (unit.kind === (mode === 'governor' ? 'worker' : ${JSON.stringify(deferredKind)})) {
    probes++; throw deferred(unit.task, unit.kind);
  }
};
Spawn.spawn = async (ctx) => {
  if (same && ctx.flags.task === 'T3') { probes++; throw deferred('T3', ${JSON.stringify(reviewerRefusal ? 'reviewer' : 'worker')}); }
  dispatches++;
  if (mode.endsWith('-throw')) throw new TowerCraneError(1, 'fixture ordinary refusal');
  return { code: 1, text: 'fixture ordinary refusal' };
};
const refill = A.refillWorkers;
A.refillWorkers = async (ctx, attempt) => {
  if (measured) return refill(ctx, attempt);
  measured = true;
  const counts = [], now = Date.now;
  const take = async () => { await refill(ctx, attempt); counts.push({ probes, dispatches }); };
  await take();
  await take();
  const cached = attempt.refusals?.get(refused);
  Date.now = () => cached ? cached.until + 1 : attempt.retryAt ? attempt.retryAt + 1 : now() + 60001;
  try { await take(); } finally { Date.now = now; }
  T.taskNote({ ...ctx, pos: [refused, 'Progress note'], flags: {} });
  await take();
  T.taskUpdate({ ...ctx, pos: [refused], flags: { priority: 'urgent' } });
  await take();
  writeAtomic(${JSON.stringify(trace)}, JSON.stringify(counts));
};
`);
    const result = h.run(['wait', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator'], // wait-allow: bounded wait drives cache probes, note/input changes and an explicit minute advance
      { pre: ['--require', preload] });
    assert.equal(result.code, 2, result.stderr);
    const counts = JSON.parse(readPublished(trace, 'utf8'));
    assert.deepEqual(counts.map((c) => c.dispatches), mode === 'governor' ? [0, 0, 0, 0, 0] : [1, 1, 2, 2, 3],
      'ordinary refusals remain cached until expiry or changed inputs, including while a sibling is deferred');
    assert.deepEqual(counts.map((c) => c.probes), mode === 'ordinary' ? [1, 1, 2, 2, 3] : [1, 2, 3, 4, 5],
      'deferred tasks still get a governor retry each pass');
    assert.equal((result.stderr.match(/fixture ordinary refusal/g) || []).length, mode === 'governor' ? 0 : 3,
      'the diagnostic follows the ordinary refusal cache too');
  });
}

for (const condition of ['paused', 'tests configuration', 'pending CI']) {
  test(`status explains deferred reviewer waiting for ${condition}`, (t) => {
    const h = fixture(t);
    h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
    const preload = path.join(h.base, 'status-defer.js');
    fs.writeFileSync(preload, `const G = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'governor.js'))});
const { TowerCraneError } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'util.js'))});
G.check = (ctx, unit) => { throw Object.assign(new TowerCraneError(3, 'fixture deferral'),
  { governorDeferred: true, task: unit.task, kind: unit.kind, reason: 'status pressure' }); };
`);
    assert.equal(h.run(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] }).code, 3);
    let expected;
    if (condition === 'paused') {
      h.ok(['project', 'set', '--paused', 'fixture hold']);
      expected = /^project paused: fixture hold$/;
    } else if (condition === 'tests configuration') {
      h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"']);
      expected = /^waiting for software gates: tests:/;
    } else {
      const sha = h.json(['task', 'show', 'T1']).sha;
      updateJson(h.env.AUTOMATION_GITHUB, (github) => { github.ci[sha] = 'pending'; return github; });
      assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
      expected = /^waiting for software gates: ci:/;
    }
    const debt = h.json(['status']).deferred_reviewers[0];
    assert.equal(debt.reason, 'status pressure', 'the governor reason remains available');
    assert.match(debt.waiting || '', expected, 'the retry blocker is explicit');
    assert.ok(h.ok(['status']).includes(`; ${debt.waiting}`), 'text status includes the same blocker');
  });
}

for (const light of [false, true]) {
  test(`concurrent ${light ? 'light' : 'ordinary'} reviewer preparation records one launch`, async (t) => {
    const h = fixture(t);
    h.ok(['task', 'update', 'T2', '--status', 'cancelled']);
    const sha = h.json(['task', 'show', 'T1']).sha;
    h.ok(['worktree', 'T1', '--agent', 'orchestrator']);
    if (light) {
      h.reviewer('T1', 'initial-reviewer', sha);
      h.ok(['evidence', 'T1', '--agent', 'initial-reviewer', '--type', 'review', '--fail', '--sha', sha,
        '--summary', 'A false claim.', '--findings', JSON.stringify([{ kind: 'false-claim', path: 'PR body', claim: 'A false claim.' }])]);
    }
    const arrived = path.join(h.base, 'review-arrivals');
    const released = path.join(h.base, 'review-release');
    fs.mkdirSync(arrived);
    const harness = path.join(h.base, 'held-review.js');
    fs.writeFileSync(harness, `const fs = require('node:fs');
const { HUNG_TEST_MS } = require(${JSON.stringify(path.join(__dirname, 'signals.js'))});
const end = Date.now() + HUNG_TEST_MS;
const done = () => {
  if (fs.existsSync(${JSON.stringify(released)})) return process.exit(0);
  if (Date.now() >= end) return process.exit(1);
  setTimeout(done, 10); // wait-allow: hold the reviewer until the parent validates both concurrent dispatches
};
done();
`);
    for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--command', JSON.stringify([process.execPath, harness, '{prompt}'])]);
    const preload = path.join(h.base, 'parallel-review.js');
    fs.writeFileSync(preload, `const fs = require('node:fs'), path = require('node:path');
const R = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'reviewer.js'))});
const T = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'tasks.js'))});
const { HUNG_TEST_MS } = require(${JSON.stringify(path.join(__dirname, 'signals.js'))});
if (${light}) {
  const accept = T.accept;
  T.accept = (ctx) => accept({ ...ctx, automatic: true, bodyRecheck: { sha: ${JSON.stringify(sha)}, revision: 1 } });
}
const revuto = R.revuto;
R.revuto = async (...args) => {
  const result = await revuto(...args);
  fs.writeFileSync(path.join(${JSON.stringify(arrived)}, String(process.pid)), '');
  const end = Date.now() + HUNG_TEST_MS;
  await new Promise((resolve, reject) => {
    const ready = () => {
      if (fs.readdirSync(${JSON.stringify(arrived)}).length === 2) return resolve();
      if (Date.now() >= end) return reject(new Error('the peer dispatch did not finish preparation'));
      setTimeout(ready, 10); // wait-allow: synchronize two CLI callers before the state-lock dispatch check
    };
    ready();
  });
  return result;
};
`);
    const before = h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length;
    try {
      const results = await Promise.all([
        h.runAsync(['accept', 'T1', '--agent', 'orchestrator'], { pre: ['--require', preload] }),
        h.runAsync(['spawn', '--task', 'T1', '--role', 'review', '--agent', 'orchestrator'], { pre: ['--require', preload] }),
      ]);
      assert.deepEqual(results.map((r) => r.code).sort(), [0, 1], results.map((r) => r.stderr).join('\n'));
      assert.match(results.find((r) => r.code).stderr, /a reviewer is still running/);
      assert.equal(fs.readdirSync(arrived).length, 2, 'both callers completed asynchronous preparation');
      assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, before + 1);
    } finally {
      if (fs.existsSync(h.base)) fs.writeFileSync(released, '');
    }
  });
}

test('deferred review evidence is read only for current outstanding debt', (t) => {
  const R = require('../lib/reviewer');
  const T = require('../lib/tasks');
  const sha = 'a'.repeat(40);
  const task = { id: 'T1', status: 'submitted', sha, revision: 1, evidence: [] };
  const deferred = { cmd: 'review dispatch deferred', task: 'T1', detail: { sha, revision: 1, reason: 'pressure' } };
  const spawn = { cmd: 'spawn', task: 'T1', detail: { sha, revision: 1, role: 'reviewer' } };
  const calls = [];
  const latest = T.latestGateEvidence;
  t.mock.method(T, 'latestGateEvidence', (...args) => { calls.push(args[0].id); return latest(...args); });
  for (const [name, events, changed, expected] of [
    ['no debt', [], {}, []],
    ['unrelated debt', [{ ...deferred, task: 'T2' }], {}, ['T2']],
    ['settled debt', [deferred, spawn], {}, []],
    ['changed head', [deferred], { sha: 'b'.repeat(40) }, []],
    ['changed revision', [deferred], { revision: 2 }, []],
    ['changed status', [deferred], { status: 'accepted' }, []],
    ['current debt', [deferred], {}, ['T1']],
  ]) {
    calls.length = 0;
    R.deferredDispatches({ tasks: { tasks: [{ ...task, ...changed }, { ...task, id: 'T2' }] }, events });
    assert.deepEqual(calls, expected, name);
  }
});

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
  for (const [name, hints, reason] of [
    ['current registry hint', [{ task: 'T1', kind: 'reviewer', reason: 'fresh pressure' }], 'fresh pressure'],
    ['latest hint', [{ task: 'T1', kind: 'reviewer', reason: 'earlier pressure' }, { task: 'T1', kind: 'reviewer', reason: 'fresh pressure' }], 'fresh pressure'],
    ['expired hint', [], 'pressure'],
    ['another kind', [{ task: 'T1', kind: 'worker', reason: 'worker pressure' }], 'pressure'],
    ['another task', [{ task: 'T2', kind: 'reviewer', reason: 'other pressure' }], 'pressure'],
  ]) {
    const st = { tasks: { tasks: [task] }, events: [deferred] };
    const before = structuredClone(st);
    assert.equal(R.deferredDispatches(st, { deferred: hints })[0].reason, reason, name);
    assert.deepEqual(st, before, 'status never updates the stored debt');
  }
  const marker = { sha, revision: 1, body_hash: 'automatic-context' };
  const context = { cmd: 'review dispatch context', task: 'T1', detail: { sha, revision: 1, body_recheck: marker } };
  for (const [name, events, expected] of [
    ['upgrade outstanding explicit debt', [deferred, context], marker],
    ['another head', [deferred, { ...context, detail: { ...context.detail, sha: other } }], undefined],
    ['another revision', [deferred, { ...context, detail: { ...context.detail, revision: 2 } }], undefined],
    ['another task', [deferred, { ...context, task: 'T2' }], undefined],
    ['settled debt', [deferred, spawn, context], undefined],
  ]) {
    const st = { tasks: { tasks: [task] }, events };
    const before = structuredClone(st);
    assert.deepEqual(R.deferredDispatches(st)[0]?.body_recheck, expected, name);
    assert.deepEqual(st, before, 'context reconstruction never mutates events');
  }
});
