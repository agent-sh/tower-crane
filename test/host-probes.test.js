'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, ROOT, detachedAlive } = require('./helpers');
const { shellQuote, treeExec } = require('../lib/gates/common');
const { fileWritten } = require('./signals');

const NODE = shellQuote(process.execPath);
const PROBE = `${NODE} probe.js`;

function fixture(t) {
  return cachedFixture(t, 'host-probes', (h) => {
    h.init(['--base', 'main', '--tests-mode', 'run-only', '--tests-cmd', `${NODE} suite.js`,
      '--tests-host-env', '{"PROBE_NUMBER":"42","PROBE_SECRET":"hostSecret0123456789abcdef"}']);
    h.git(['switch', '-qc', 'probes']);
    fs.writeFileSync(path.join(h.repo, 'suite.js'), "require('node:fs').writeFileSync('suite-passed', 'yes');\n");
    fs.writeFileSync(path.join(h.repo, 'probe.js'), `
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(fs.readFileSync('suite-passed', 'utf8'), 'yes');
assert.equal(fs.readFileSync('value', 'utf8'), 'submitted');
assert.equal(process.env.TOWER_CRANE_SANDBOX, '0');
assert.equal(process.env.TOWER_CRANE_TEST_EXCLUDE, undefined);
process.stdin.resume();
process.stdin.on('end', () => console.log(process.env.PROBE_NUMBER, process.env.PROBE_SECRET));
`);
    fs.writeFileSync(path.join(h.repo, 'value'), 'submitted');
    fs.writeFileSync(path.join(h.repo, 'fail.js'), "console.log('probe failure 17'); process.exit(7);\n");
    fs.writeFileSync(path.join(h.repo, 'slow.js'), "console.log('slow pid', process.pid); setInterval(() => {}, 1000);\n");
    fs.writeFileSync(path.join(h.repo, 'signal.js'), "console.log('signal probe'); process.kill(process.pid, 'SIGTERM');\n");
    fs.writeFileSync(path.join(h.repo, 'held.js'), `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'started');
const hold = setInterval(() => {
  if (fs.existsSync(process.argv[3])) {
    clearInterval(hold);
    console.log('old probe finished');
    process.exit(Number(process.argv[4]));
  }
}, 20); // wait-allow: the regression releases the old probe after running its replacement
`);
    h.git(['add', '-A']);
    h.git(['commit', '-qm', 'probe scripts']);
    h.ok(['task', 'add', '--title', 'Host measurement', '--acceptance', 'host number is recorded']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
}

function submit(h, probes) {
  return h.ok(['submit', 'T1', '--sha', h.sha, '--branch', 'probes', '--agent', 'worker',
    ...probes.flatMap((command) => ['--host-probe', command])]);
}

test('submit runs repeatable host probes at the submitted sha and supplies redacted reviewer evidence', (t) => {
  const h = fixture(t);
  const second = `${NODE} -e "console.log(43)"`;
  submit(h, [PROBE, second]);
  assert.deepEqual(h.readState('tasks.json').tasks[0].host_probes, [PROBE, second]);
  assert.match(h.ok(['task', 'show', 'T1']), /host probes:[\s\S]*probe\.js/);
  fs.writeFileSync(path.join(h.repo, 'value'), 'live worktree');
  h.ok(['check', 'tests', 'T1'], { env: { TOWER_CRANE_TEST_EXCLUDE: '["anything"]' } });
  const st = require('../lib/state').loadState(h.state);
  const task = st.tasks.tasks[0];
  const evidence = task.evidence.at(-1);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.receipt.host_probes.length, 2);
  for (const [i, number] of [42, 43].entries()) {
    const result = evidence.receipt.host_probes[i];
    assert.equal(result.status, 0);
    assert.equal(result.timed_out, false);
    assert.ok(result.duration_ms >= 0);
    assert.match(result.output_tail, new RegExp(String(number)));
  }
  assert.match(evidence.receipt.host_probes[0].output_tail, /\[redacted:PROBE_SECRET\]/);
  assert.ok(!JSON.stringify(evidence).includes('hostSecret0123456789abcdef'));
  assert.equal(require('../lib/gate-commands').mismatch(evidence, st.project, task), null);
  const redactedDisplay = structuredClone(evidence);
  redactedDisplay.receipt.host_probes[0].command = '[redacted:COMMAND]';
  assert.equal(require('../lib/gate-commands').mismatch(redactedDisplay, st.project, task), null,
    'command hashes bind the receipt even when redaction changes its display');
  const diff = require('../lib/reviewer').diffOf({ root: h.repo }, st.project, task);
  const prompt = require('../lib/reviewer').context(st, task, diff, { gates: [{ type: 'tests', ok: true }] },
    { name: 'review', level: 'easy', builder: 'worker' }, [], false);
  assert.match(prompt, /"host_probes"[\s\S]*42 \[redacted:PROBE_SECRET\]/);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value'), 'utf8'), 'live worktree');
  assert.match(require('../lib/gate-commands').mismatch(evidence,
    { ...st.project, gates: { ...st.project.gates, host_probe_timeout_min: 2 } }, task), /host probe/);

  submit(h, [second]);
  const changed = h.readState('tasks.json').tasks[0];
  assert.match(require('../lib/gate-commands').mismatch(evidence, st.project, changed), /host probe/);
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.ok(['check', 'tests', 'T1']);
  const none = h.readState('tasks.json').tasks[0];
  assert.equal(require('../lib/gate-commands').mismatch(none.evidence.at(-1), h.readState('project.json'), none), null);
  submit(h, []);
  assert.deepEqual(h.readState('tasks.json').tasks[0].host_probes, []);
  const bad = h.run(['submit', 'T1', '--sha', h.sha, '--agent', 'worker', '--host-probe', ' ']);
  assert.equal(bad.code, 2, bad.stderr);
  assert.match(bad.stderr, /--host-probe.*non-blank/);
});

test('a failed head suite does not run declared probes', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--tests-cmd', `${NODE} fail.js`]);
  submit(h, [PROBE]);
  const out = h.run(['check', 'tests', 'T1']);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.deepEqual(evidence.receipt.host_probes, []);
  assert.ok(!evidence.commands.some((c) => c.command === PROBE));
});

for (const row of [
  { script: 'fail.js', status: 7, timedOut: false, output: /probe failure 17/ },
  { script: 'slow.js', status: null, timedOut: true, output: /slow pid \d+/ },
]) {
  test(`a ${row.script} host probe fails the gate with its output and stops later probes`, (t) => {
    const h = fixture(t);
    h.ok(['project', 'set', '--host-probe-timeout-min', '0.05']);
    submit(h, [`${NODE} ${row.script}`, `${NODE} -e "console.log('should not run')"`]);
    const out = h.run(['check', 'tests', 'T1']);
    assert.equal(out.code, 1, out.stdout + out.stderr);
    const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.worker_failure, true);
    assert.equal(evidence.runner_crash, undefined, 'probe timeouts return directly through rework');
    assert.match(evidence.summary, row.output);
    const probes = evidence.receipt.host_probes;
    assert.equal(probes.length, 1);
    if (row.timedOut) assert.notEqual(probes[0].status, 0);
    else assert.equal(probes[0].status, row.status);
    assert.equal(probes[0].timed_out, row.timedOut);
    assert.match(probes[0].output_tail, row.output);
    if (row.timedOut) {
      assert.match(evidence.summary, /timed out/);
      assert.equal(detachedAlive({ pid: Number(/slow pid (\d+)/.exec(probes[0].output_tail)[1]) }), false);
    }
  });
}

test('host probe timeout settings validate, print, clear and extend the gate lease', (t) => {
  const h = fixture(t);
  const timeouts = require('../lib/gate-timeouts');
  assert.equal(timeouts.minutes({}, 'host_probe'), 10);
  h.ok(['project', 'set', '--host-probe-timeout-min', '2', '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), /gates\.host_probe_timeout_min: 2/);
  const denied = h.run(['project', 'set', '--host-probe-timeout-min', '3', '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  for (const value of ['0', '-1', 'no', '99999999']) {
    assert.equal(h.run(['project', 'set', '--host-probe-timeout-min', value]).code, 2);
  }
  const budget = require('../lib/gate-runs').budgetMs;
  const project = h.readState('project.json');
  const task = { id: 'T1', kind: 'code', sha: h.sha };
  const withProbes = { ...task, host_probes: [PROBE, PROBE] };
  assert.ok(budget({}, project, h.repo, withProbes, 'tests') - budget({}, project, h.repo, task, 'tests') >= 240000);
  assert.equal(budget({}, { ...project, gates: { ...project.gates, host_probe_timeout_min: 3 } }, h.repo, withProbes, 'tests')
    - budget({}, project, h.repo, withProbes, 'tests'), 120000);
  h.ok(['project', 'set', '--host-probe-timeout-min', 'null']);
  assert.equal(h.readState('project.json').gates.host_probe_timeout_min, undefined);
});

test('probes use gate resource caps in all tests modes and run before proof reversion', async (t) => {
  const h = fixture(t);
  const priorConfig = process.env.TOWER_CRANE_CONFIG;
  require('./gates/helpers').isolateUserFile(h.base);
  t.after(() => {
    if (priorConfig === undefined) delete process.env.TOWER_CRANE_CONFIG;
    else process.env.TOWER_CRANE_CONFIG = priorConfig;
  });
  fs.mkdirSync(path.join(h.repo, 'test'));
  fs.writeFileSync(path.join(h.repo, 'test/value.test.js'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('value', 'utf8'), 'submitted');\n");
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'proof test']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  for (const mode of ['prove', 'run-only', 'none']) {
    const project = { base: 'main', tests: { mode, host_env: { PROBE_NUMBER: '42' } },
      gates: { tests_cmd: `${NODE} suite.js ${mode}` } };
    // The proof runner fails after the value file is reverted or removed.
    const command = `${NODE} -e "require('./suite.js'); require('./test/value.test.js')"`;
    project.gates.tests_cmd = command;
    const task = { id: 'T1', kind: 'code', sha: h.sha,
      host_probes: [mode === 'none' ? `${NODE} -e "console.log(42)"` : PROBE] };
    let probeRuns = 0;
    const out = await require('../lib/gates/tests').run({
      root: h.repo, stateDir: h.state, task, project, tmpEnv: h.env,
      exec: async (cmd, args, opts) => {
        opts.env = { ...h.env, ...opts.env };
        if (task.host_probes.includes(cmd)) {
          probeRuns++;
          assert.deepEqual(opts.resources, require('../lib/containment').resolveGate(project));
          assert.equal(opts.timeout, 600000);
          assert.equal(opts.input, undefined);
        }
        return treeExec(cmd, args, opts);
      },
    });
    assert.equal(out.ok, true, `${mode}: ${out.summary}`);
    assert.equal(probeRuns, 1);
    assert.match(out.receipt.host_probes[0].output_tail, /42/);
  }
});

test('workers and orchestrators leave host checks and cleanup to the gates', () => {
  const work = fs.readFileSync(path.join(ROOT, 'skills/tower-crane-work/SKILL.md'), 'utf8');
  const orchestrator = fs.readFileSync(path.join(ROOT, 'agents/tower-crane-orchestrator.md'), 'utf8');
  for (const text of [work, orchestrator]) {
    assert.match(text, /--host-probe/);
    assert.match(text, /leave cleanup to the clean gate/i);
    assert.match(text, /do not open a decision/);
    assert.match(text, /PR body.*pending/);
  }
  assert.doesNotMatch(work, /run the configured cleanup tool if enabled/);
});

for (const row of [
  { name: 'nonzero exit', run: { status: 7 }, flags: { worker_failure: true } },
  { name: 'missing command', run: { status: 127 }, flags: { worker_failure: true } },
  { name: 'SIGTERM', run: { status: null, signal: 'SIGTERM' }, flags: { runner_crash: true } },
  { name: 'SIGKILL', run: { status: null, signal: 'SIGKILL' }, flags: { runner_crash: true } },
  { name: 'shell signal status', run: { status: 143 }, flags: { runner_crash: true } },
  { name: 'memory cap', run: { status: null, resource_reason: 'memory', containment: { backend: 'fixture' } },
    flags: { runner_crash: true, resource_reason: 'memory', containment: { backend: 'fixture' } } },
  { name: 'PID cap', run: { status: 1, resource_reason: 'tasks', containment: { backend: 'fixture' } },
    flags: { runner_crash: true, resource_reason: 'tasks', containment: { backend: 'fixture' } } },
  { name: 'abort without signal', run: { status: 1, error: { code: 'ABORT_ERR' } }, flags: { runner_crash: true } },
  { name: 'timeout killed by signal', run: { status: null, signal: 'SIGTERM', timedOut: true },
    flags: { worker_failure: true } },
  { name: 'timeout with resource reason', run: { status: null, timedOut: true, resource_reason: 'memory',
    containment: { backend: 'fixture' } },
    flags: { worker_failure: true, resource_reason: 'memory', containment: { backend: 'fixture' } } },
]) {
  test(`probe interruption classification: ${row.name}`, () => {
    assert.deepEqual(require('../lib/gates/tests').probeFailureFlags(row.run), row.flags);
  });
}

test('a signal probe records a retryable runner failure', {
  skip: process.platform === 'win32' && 'Unix shell signal exit codes are not available on Windows',
}, (t) => {
  const h = fixture(t);
  submit(h, [`${NODE} signal.js`]);
  const out = h.run(['check', 'tests', 'T1']);
  assert.equal(out.code, 1, out.stdout + out.stderr);
  const task = h.readState('tasks.json').tasks[0];
  const runs = task.evidence.filter((e) => e.type === 'tests');
  assert.equal(runs.length, 1);
  for (const evidence of runs) {
    assert.equal(evidence.runner_crash, true);
    assert.equal(evidence.worker_failure, undefined);
    assert.match(evidence.receipt.host_probes[0].output_tail, /signal probe/);
    assert.equal(evidence.receipt.host_probes[0].timed_out, false);
  }
});

const NUMBER = `${NODE} -e "console.log(42)"`;
const REPLACEMENT = `${NODE} -e "console.log(43)"`;
for (const row of [
  { name: 'completed pass', before: [NUMBER], after: [REPLACEMENT], bump: true },
  { name: 'completed failure', before: [`${NODE} fail.js`], after: [REPLACEMENT], bump: true },
  { name: 'completed timeout', before: [`${NODE} slow.js`], after: [REPLACEMENT], bump: true, timeout: true },
  { name: 'cleared list', before: [`${NODE} fail.js`], after: [], bump: true },
  { name: 'reordered list', before: [NUMBER, REPLACEMENT], after: [REPLACEMENT, NUMBER], bump: true },
  { name: 'unchanged list', before: [NUMBER], after: [NUMBER], bump: false },
  { name: 'different sha', before: [`${NODE} fail.js`], after: [REPLACEMENT], bump: false, newSha: true },
]) {
  test(`host probe replacement invalidates the right revision: ${row.name}`, (t) => {
    const h = fixture(t);
    if (row.timeout) h.ok(['project', 'set', '--host-probe-timeout-min', '0.05']);
    submit(h, row.before);
    h.run(['check', 'tests', 'T1']);
    const before = h.readState('tasks.json').tasks[0];
    if (row.newSha) {
      h.git(['commit', '-qm', 'new head', '--allow-empty']);
      h.sha = h.git(['rev-parse', 'HEAD']);
    }
    submit(h, row.after);
    const st = require('../lib/state').loadState(h.state);
    const current = st.tasks.tasks[0];
    assert.equal(current.revision, before.revision + Number(row.bump));
    if (row.bump) {
      const event = st.events.findLast((e) => e.cmd === 'submit');
      assert.equal(event.detail.previous_revision, before.revision);
      assert.equal(event.detail.revision, current.revision);
    }
    const latest = require('../lib/tasks').latestGateEvidence(current, 'tests', st.events);
    if (row.bump || row.newSha) assert.equal(latest, undefined, 'the previous verdict no longer counts');
    else assert.equal(latest.ok, true, 'an unchanged declaration preserves its verdict');
    h.ok(['check', 'tests', 'T1']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, true);
  });
}

for (const row of [
  { name: 'success', status: 0 },
  { name: 'failure', status: 7 },
  { name: 'timeout', status: 7, timeout: true },
]) {
  test(`a live old host probe ${row.name} cannot join or judge its replacement`, async (t) => {
    const h = fixture(t);
    if (row.timeout) h.ok(['project', 'set', '--host-probe-timeout-min', '0.05']);
    const started = path.join(h.base, 'old-started');
    const release = path.join(h.base, 'old-release');
    submit(h, [`${NODE} held.js ${shellQuote(started)} ${shellQuote(release)} ${row.status}`]);
    const revision = h.readState('tasks.json').tasks[0].revision;
    const old = h.runAsync(['check', 'tests', 'T1']);
    await fileWritten(started, { signal: t.signal });
    submit(h, [REPLACEMENT]);
    const current = h.readState('tasks.json').tasks[0];
    if (current.revision === revision) {
      fs.writeFileSync(release, 'release');
      await old;
      assert.fail('same-sha probe changes must retire the old run revision');
    }
    let next;
    try {
      next = await h.runAsync(['check', 'tests', 'T1']);
    } finally {
      if (!row.timeout) fs.writeFileSync(release, 'release');
    }
    const finished = await old;
    assert.equal(next.code, 0, next.stdout + next.stderr);
    assert.doesNotMatch(next.stderr, /joining/);
    assert.equal(finished.code, row.status || row.timeout ? 1 : 0, finished.stdout + finished.stderr);
    const st = require('../lib/state').loadState(h.state);
    const latest = require('../lib/tasks').latestGateEvidence(st.tasks.tasks[0], 'tests', st.events);
    assert.equal(latest.ok, true, 'the later completion of the old run cannot replace the new verdict');
    assert.equal(latest.revision, revision + 1);
    assert.match(latest.receipt.host_probes[0].output_tail, /43/);
  });
}
