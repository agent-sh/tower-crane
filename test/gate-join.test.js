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
    h.init(['--ci-local', JSON.stringify({ command: [process.execPath, 'ci.js', h.runs, h.release], timeout: 120 })]);
    fs.writeFileSync(path.join(h.repo, 'ci.js'), `
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'run\\n');
const deadline = performance.now() + 120000;
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

const runs = (h) => (fs.existsSync(h.runs) ? fs.readFileSync(h.runs, 'utf8').split('\n').filter(Boolean).length : 0);
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

test('a run past its deadline is refused with its owner, and a dead holder leaves the gate to the caller', (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.release, '');
  const task = h.readState('tasks.json').tasks[0];
  const lease = (pid, source) => ({ at: new Date(Date.now() - 600000).toISOString(), agent: 'orchestrator', via: 'automation', cmd: 'gate run', task: 'T1',
    detail: { type: 'ci', sha: task.sha, revision: task.revision, source, phase: 'running', deadline: new Date(Date.now() - 1000).toISOString(), pid, host: os.hostname() } });
  const append = (e) => fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
  append(lease(process.pid, 'gate:live'));
  const refused = h.run(['check', 'ci', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`ci is already running at [0-9a-f]+ \\(revision ${task.revision}\\) by orchestrator via automation, pid ${process.pid} on ${os.hostname()}, started .*passed its deadline`));
  assert.equal(runs(h), 0);
  append({ at: new Date().toISOString(), agent: 'orchestrator', cmd: 'gate run', task: 'T1', detail: { source: 'gate:live', phase: 'error', error: null } });
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  append(lease(dead, 'gate:dead'));
  h.ok(['check', 'ci', 'T1']);
  assert.equal(runs(h), 1);
});
