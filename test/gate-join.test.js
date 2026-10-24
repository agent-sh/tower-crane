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

// A tests gate whose every command counts its runs and holds until the test releases it,
// in expensive prove mode with two test files: up to thirteen timeout budgets per run.
const MINUTES = 10;
function testsFixture(t) {
  return cachedFixture(t, 'gate-join-tests', (h) => {
    h.git(['remote', 'remove', 'origin']);
    h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
    h.runs = path.join(h.base, 'test-runs');
    h.release = path.join(h.base, 'test-release');
    const { shellQuote } = require('../lib/gates/common');
    const gate = `${shellQuote(process.execPath)} gate.js ${shellQuote(h.runs)} ${shellQuote(h.release)}`;
    h.init(['--base', 'main', '--tests-cmd', gate, '--tests-proof-cmd', `${gate} {tests}`, '--tests-expensive', 'true',
      '--tests-host-only', JSON.stringify(['test/host.test.js']), '--tests-timeout-min', String(MINUTES)]);
    fs.writeFileSync(path.join(h.repo, 'gate.js'), `
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], 'run\\n');
const deadline = performance.now() + 300000;
while (!fs.existsSync(process.argv[3])) {
  if (performance.now() > deadline) process.exit(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (!fs.readFileSync('lib.js', 'utf8').includes('new')) process.exit(1);
console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0');
`);
    fs.writeFileSync(path.join(h.repo, 'lib.js'), 'old\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'gated library']);
    h.git(['switch', '-qc', 'change']);
    fs.writeFileSync(path.join(h.repo, 'lib.js'), 'new\n');
    fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'test', 'lib.test.js'), 'covers lib\n');
    fs.writeFileSync(path.join(h.repo, 'test', 'host.test.js'), 'covers lib on the host\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'library change']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', '-q', 'main']);
    h.ok(['task', 'add', '--title', 'library change', '--kind', 'code', '--acceptance', 'proved']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'change']);
    return { runs: h.runs, release: h.release, sha: h.sha };
  });
}

const testLeases = (h) => logs(h).filter((e) => e.cmd === 'gate run' && e.detail.type === 'tests');

test('the repo head lease at 75 minutes sums sequential commands and one shared base budget', () => {
  const root = path.resolve(__dirname, '..');
  const head = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  const cases = [
    [['test/live-git-sandbox.test.js', 'test/live-sandbox.test.js'], 19],
    [[], 7],
  ];
  for (const [hosts, budgets] of cases) {
    const project = { gates: { tests_timeout_min: 75 }, tests: { expensive: true, host_only: hosts } };
    const budget = require('../lib/gate-runs').budgetMs({}, project, root, { kind: 'code', sha: head.stdout.trim() }, 'tests');
    // Head, scoped proof and revert each run ordinary and host-only commands;
    // each can rerun once, and the shared base step adds one budget.
    assert.equal(budget, budgets * (75 + 1) * 60000, JSON.stringify(hosts));
  }
});

test('an unobservable tests holder expires at the deadline its planner recorded', (t) => {
  const h = testsFixture(t);
  fs.writeFileSync(h.release, '');
  h.ok(['check', 'tests', 'T1']);
  const first = testLeases(h).find((e) => e.detail.phase === 'running');
  const before = runs(h);
  const preload = path.join(h.base, 'deadline-clock.cjs');
  fs.writeFileSync(preload, 'Date.now = () => Number(process.env.TC_DEADLINE_NOW);\n');
  const source = 'gate:unobservable-tests';
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({
    ...first, detail: { ...first.detail, source, host: 'another-host' },
  })}\n`);
  const r = h.run(['check', 'tests', 'T1'], { env: {
    NODE_OPTIONS: `--require=${preload}`,
    TC_DEADLINE_NOW: String(Date.parse(first.detail.deadline)),
  } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /cannot be observed and passed its deadline .*; treating it as ended and running the gate here/);
  assert.equal(runs(h), before + 5);
  assert.deepEqual(testLeases(h).findLast((e) => e.detail.phase === 'running').detail.replaces, [source]);
});

test('the planned commands of a tests run cover each mode, expensive proof, host-only files and one rerun of each', () => {
  const Tests = require('../lib/gates/tests');
  const Runs = require('../lib/gate-runs');
  const cases = [
    [{ mode: 'none' }, 0, 0],
    [{ mode: 'run-only' }, 0, 3],
    [{ mode: 'run-only' }, 2, 7],
    [{}, 0, 5],
    [{ expensive: true }, 0, 7],
    [{ host_only: ['test/h.js'] }, 1, 9],
    [{ expensive: true, host_only: ['test/h.js'] }, 1, 13],
    [{ mode: 'prove', by_kind: { docs: 'run-only' } }, 0, 3, 'docs'],
    [{ mode: 'bogus' }, 0, 0],
  ];
  for (const [tests, hosts, want, kind = 'code'] of cases) {
    assert.equal(Tests.plannedCommands({ tests }, kind, hosts), want, JSON.stringify({ tests, hosts, kind }));
  }
  const project = { gates: { tests_timeout_min: 2, clean_timeout_min: 3 }, tests: { expensive: true }, ci: { local: { command: ['ci'], timeout: 90 } } };
  const task = { kind: 'code', sha: 'abc' };
  // Each planned budget gets its timeout and a minute for the metadata queries around it.
  assert.equal(Runs.budgetMs({}, project, null, task, 'tests'), 7 * (120000 + 60000));
  assert.equal(Runs.budgetMs({ flags: { timeout: '1' } }, project, null, task, 'tests'), 7 * (60000 + 60000), 'a --timeout override sets each command budget');
  assert.equal(Runs.budgetMs({}, project, null, task, 'clean'), 180000 + 60000, 'clean runs one command');
  assert.equal(Runs.budgetMs({}, project, null, task, 'ci'), 2 * (90000 + 60000), 'local CI runs its command and one rerun on the same merge');
  assert.equal(Runs.budgetMs({}, { ...project, ci: { local: { ...project.ci.local, rerun: false } } }, null, task, 'ci'), 90000 + 60000, 'without the rerun, the command alone');
  assert.equal(Runs.budgetMs({}, { tests: { mode: 'none' } }, null, task, 'tests'), 60000, 'a run with no command keeps the metadata minute');
});

// A git listing that fails would count no host-only file and leave the deadline three commands
// short per file, so the count falls back to the matching files in the checkout on disk.
test('host-only files are counted from the checkout when git cannot list them twice', (t) => {
  const { hostFileCount } = require('../lib/gates/tests');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-count-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ['test/host/a.test.js', 'test/host/deep/b.test.js', 'test/host/notes.md', 'test/plain.test.js', 'node_modules/test/host/c.test.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
  const project = { tests: { host_only: ['test/host/**', '**/x.host.test.js'] } };
  const calls = [];
  const failing = (args) => { calls.push(args); return { status: null, error: new Error('timed out'), stdout: '' }; };
  assert.equal(hostFileCount(project, root, 'abc', failing), 2);
  assert.equal(calls.length, 2, 'the listing is retried once before the fallback');
  // A listing that succeeds on the retry is used as is.
  let tries = 0;
  const flaky = () => (++tries === 1 ? { status: 128, stdout: '' } : { status: 0, stdout: 'test/host/a.test.js\0test/host/z.test.js\0test/host/c.test.js\0' });
  assert.equal(hostFileCount(project, root, 'abc', flaky), 3);
});

test('a tests run leases until every command it may start could have used its full timeout', (t) => {
  const h = testsFixture(t);
  fs.writeFileSync(h.release, '');
  const r = h.run(['check', 'tests', 'T1']);
  assert.equal(r.code, 0, r.stderr);
  // Head and scoped proof each with the host-only file, then the reverted run, which fails at its first command.
  assert.equal(runs(h), 5, 'one passing run starts five timed commands');
  const lease = testLeases(h).find((e) => e.detail.phase === 'running');
  // The fixture has one ordinary test and one host-only file; each command may rerun once.
  const planned = 13 * (MINUTES * 60000 + 60000);
  const held = Date.parse(lease.detail.deadline) - Date.parse(lease.at);
  assert.ok(Math.abs(held - planned) < 5000, `deadline ${held} ms after the start, want ${planned}`);
});

// macOS and Windows record no start ticks, so a live holder there is trusted only until its deadline.
// Linux reaches the same branch for a lease written without start_ticks: processState sees the pid
// running but cannot prove it is the same process, and holderState falls back to the deadline.
test('a holder without start ticks, past one command budget but inside its planned run, is joined and not run twice', async (t) => {
  const h = testsFixture(t);
  fs.writeFileSync(h.release, '');
  h.ok(['check', 'tests', 'T1']);
  const first = testLeases(h).find((e) => e.detail.phase === 'running');
  const evidence = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  const before = runs(h);
  // As recorded on macOS: the same deadline span, started two command budgets ago.
  const at = Date.now() - 2 * MINUTES * 60000;
  const span = Date.parse(first.detail.deadline) - Date.parse(first.at);
  // The lease names the first run's process; a macOS one carries none of these to tell it by.
  const { start_ticks: _ticks, pidns: _pidns, created: _created, seen: _seen, ...detail } = first.detail;
  const append = (e) => fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
  append({ ...first, at: new Date(at).toISOString(), detail: { ...detail, source: 'gate:mac', pid: process.pid, host: os.hostname(), deadline: new Date(at + span).toISOString() } });
  let stderr = '';
  let child;
  const joiner = h.runAsync(['check', 'tests', 'T1', '--json'], { onSpawn: (c) => { child = c; c.stderr.on('data', (d) => { stderr += d; }); } });
  await waitUntil(() => /joining the tests run.*\n/.test(stderr), { alive: child, what: () => `the joiner reports joining: ${stderr}` });
  // The wait can last hours, so the joiner says until when.
  const ends = new Date(at + span).toISOString();
  const note = /joining the tests run.*/.exec(stderr)[0];
  assert.ok(note.includes(`it cannot be observed, so it counts as ended at its deadline ${ends}, in `), note);
  const minutes = Number(/, in (\d+) min$/.exec(note)[1]);
  assert.ok(Math.abs(minutes - (span - 2 * MINUTES * 60000) / 60000) <= 1, `${minutes} min until the deadline`);
  append({ ...first, at: new Date().toISOString(), detail: { type: 'tests', sha: first.detail.sha, revision: first.detail.revision, source: 'gate:mac', phase: 'done', evidence_at: evidence.at } });
  const r = await joiner;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).joined.source, 'gate:mac');
  assert.equal(runs(h), before, 'the joiner ran no test command');
});

// The guard refuses the run's evidence write when the orchestrator lease changes mid-run, and
// the same guard refuses the lease's error write; the lease must still end.
test('a run whose orchestrator lease was taken over still ends its lease when the guard refuses the release', async (t) => {
  const h = testsFixture(t);
  const orchestrator = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'first' } };
  const running = h.runAsync(['check', 'tests', 'T1'], orchestrator);
  try {
    await fileWritten(h.runs, { what: 'the orchestrator run starts its head command' });
    h.ok(['orchestrator', 'takeover']);
  } finally {
    fs.writeFileSync(h.release, '');
  }
  const r = await running;
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /orchestrator lease changed during command/);
  const leases = testLeases(h);
  assert.deepEqual(leases.map((e) => e.detail.phase), ['running', 'error'], 'the refused release is written as engine bookkeeping');
  assert.match(leases[1].detail.error, /orchestrator lease changed during command/);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'tests'), false, 'the refused run records no evidence');
});
