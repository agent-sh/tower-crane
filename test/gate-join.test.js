'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture } = require('./helpers');
const { waitUntil, fileWritten } = require('./signals');

// Local CI that counts its runs and holds each one until the test releases it.
function fixture(t) {
  return cachedFixture(t, 'gate-join', (h) => {
    h.git(['remote', 'remove', 'origin']);
    h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
    h.runs = path.join(h.base, 'ci-runs');
    h.release = path.join(h.base, 'ci-release');
    h.init(['--ci-local', JSON.stringify({ command: [process.execPath, 'ci.js', h.runs, h.release], timeout: 600 })]);
    fs.writeFileSync(path.join(h.repo, 'ci.js'), `
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'run\\n');
const deadline = performance.now() + 300000;
while (!fs.existsSync(process.argv[3])) {
  if (performance.now() > deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'slow checker']);
    h.git(['switch', '-qc', 'change']);
    fs.writeFileSync(path.join(h.repo, 'head.txt'), 'new\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'head change']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', '-q', 'main']);
    h.ok(['task', 'add', '--title', 'slow check', '--kind', 'docs', '--acceptance', 'checked']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'change', '--pr', '1']);
    h.reviewer('T1', 'reviewer', h.sha);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    return { runs: h.runs, release: h.release, sha: h.sha };
  });
}

const runs = (h) => (fs.existsSync(h.runs) ? fs.readFileSync(h.runs, 'utf8').split('\n').filter(Boolean).length : 0); // read-published: the fake CI only appends lines, never replaces the file
const logs = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const ciEvidence = (h) => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'ci');

// Starts `first`, waits for its CI run, then starts `second` and releases the
// run once `second` reports that it joined, or once it starts a CI run of its own.
async function overlap(h, first, second) {
  const a = h.runAsync(first);
  let joining = '';
  let b;
  try {
    await fileWritten(h.runs, { what: 'the first command starts local CI' });
    let child;
    b = h.runAsync(second, { onSpawn: (c) => { child = c; c.stderr.on('data', (d) => { joining += d; }); } });
    await waitUntil(() => /joining the ci run/.test(joining) || runs(h) > 1,
      { paths: [h.runs], alive: child, what: () => `the second command joins or runs: ${joining}` });
  } finally {
    fs.writeFileSync(h.release, '');
  }
  return { a: await a, b: await b, joining };
}

// The field case: a reaction's CI run and a manual accept at the same head.
for (const [holder, by] of [['a manual check', 'owner'], ['an automation reaction', 'orchestrator via automation']]) {
  test(`accept joins the local CI run ${holder} started at the same head, and CI runs once`, async (t) => {
    const h = fixture(t);
    const first = holder === 'a manual check' ? ['check', 'ci', 'T1'] : ['ci', 'completed', 'T1', '--sha', h.sha];
    const { a, b, joining } = await overlap(h, first, ['accept', 'T1']);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(runs(h), 1, 'one CI run, not two');
    assert.match(joining, new RegExp(`joining the ci run at [0-9a-f]+ \\(revision \\d+\\) by ${by}, pid \\d+`));
    assert.equal(ciEvidence(h).length, 1);
    assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
    const leases = logs(h).filter((e) => e.cmd === 'gate run');
    assert.deepEqual(leases.map((e) => e.detail.phase), ['running', 'done']);
    assert.equal(leases[1].detail.evidence_at, ciEvidence(h)[0].at);
  });
}

test('a second check ci reports the joined run and its evidence instead of running again', async (t) => {
  const h = fixture(t);
  const { a, b } = await overlap(h, ['check', 'ci', 'T1', '--json'], ['check', 'ci', 'T1', '--json']);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(runs(h), 1);
  const [first, second] = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
  assert.equal(second.at, first.at, 'the joiner returns the evidence the run recorded');
  assert.equal(second.joined.agent, 'owner');
  assert.equal(second.joined.at, logs(h).find((e) => e.cmd === 'gate run').at);
  assert.equal(ciEvidence(h).length, 1);
});

// A CI completion notification runs the CI gate inside an automation reaction.
test('automation joins the local CI run a manual check holds instead of starting its own', async (t) => {
  const h = fixture(t);
  const { a, b, joining } = await overlap(h, ['check', 'ci', 'T1'], ['ci', 'completed', 'T1', '--sha', h.sha]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(runs(h), 1, 'the reaction did not start a second CI run');
  assert.match(joining, /joining the ci run at [0-9a-f]+ \(revision \d+\) by owner/);
  assert.equal(ciEvidence(h).length, 1);
  assert.ok(logs(h).some((e) => e.cmd === 'automation' && e.via === 'automation'), 'the reaction ran');
});

// A hand-written lease held by this test process, which the test then ends.
function holderFixture(t, overrides = {}) {
  const h = fixture(t);
  fs.writeFileSync(h.release, '');
  const task = h.readState('tasks.json').tasks[0];
  h.append = (e) => fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
  h.lease = (source, detail = {}) => h.append({ at: new Date(Date.now() - 600000).toISOString(), agent: 'orchestrator', via: 'automation', cmd: 'gate run', task: 'T1',
    detail: { type: 'ci', sha: task.sha, revision: task.revision, source, phase: 'running', deadline: new Date(Date.now() + 600000).toISOString(),
      pid: process.pid, ...require('../lib/processes').identity(process.pid), ...overrides, ...detail } });
  h.end = (source, detail) => h.append({ at: new Date().toISOString(), agent: 'orchestrator', via: 'automation', cmd: 'gate run', task: 'T1',
    detail: { type: 'ci', sha: task.sha, revision: task.revision, source, ...detail } });
  // Starts a joiner and resolves once it reports joining, with its result promise.
  h.join = async (args) => {
    let stderr = '';
    let child;
    const result = h.runAsync(args, { onSpawn: (c) => { child = c; c.stderr.on('data', (d) => { stderr += d; }); } });
    await waitUntil(() => /joining the ci run/.test(stderr), { alive: child, what: () => `the joiner reports joining: ${stderr}` });
    return { result, stderr: () => stderr };
  };
  return { h, task };
}

test('a joiner keeps waiting on a holder proven alive past its deadline, then runs the gate when the holder ends without evidence',
  { skip: process.platform !== 'linux' && 'only Linux start ticks prove a holder alive' }, async (t) => {
    const { h } = holderFixture(t);
    h.lease('gate:slow', { deadline: new Date(Date.now() - 1000).toISOString() });
    const joiner = await h.join(['check', 'ci', 'T1']);
    h.end('gate:slow', { phase: 'error', error: 'holder stopped' });
    const r = await joiner.result;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /ended without usable evidence; running the gate here/);
    assert.equal(runs(h), 1);
  });

test('an unobservable holder past its deadline counts as ended: the caller says so and runs the gate', (t) => {
  const { h } = holderFixture(t, { host: 'another-host', deadline: new Date(Date.now() - 1000).toISOString() });
  h.lease('gate:elsewhere');
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /the ci run by orchestrator via automation, pid \d+ on another-host, started .* cannot be observed and passed its deadline .*; treating it as ended and running the gate here/);
  assert.equal(runs(h), 1);
  assert.deepEqual(logs(h).findLast((e) => e.cmd === 'gate run' && e.detail.phase === 'running').detail.replaces, ['gate:elsewhere']);
  // A holder whose process has exited is skipped without a deadline.
  h.lease('gate:dead', { pid: cp.spawnSync(process.execPath, ['-e', '']).pid, start_ticks: undefined });
  h.ok(['check', 'ci', 'T1']);
  assert.equal(runs(h), 2);
});

test('a joiner that receives evidence from a run interrupted by wait shutdown runs the gate itself', async (t) => {
  const { h } = holderFixture(t);
  h.ok(['check', 'ci', 'T1']);
  const recorded = ciEvidence(h).at(-1);
  h.lease('gate:drained');
  const joiner = await h.join(['check', 'ci', 'T1']);
  h.end('gate:drained', { phase: 'done', evidence_at: recorded.at, interrupted: true });
  const r = await joiner.result;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /ended without usable evidence \(interrupted by wait shutdown\); running the gate here/);
  assert.equal(runs(h), 2, 'the joiner ran its own CI instead of taking the interrupted result');
});
