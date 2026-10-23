'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, runAsync } = require('./helpers');

function fixture(t) {
  return cachedFixture(t, 'presubmit', (h) => {
    h.init(['--base', 'main']);
    h.ok(['task', 'add', '--title', 'Check change', '--acceptance', 'check.js passes', '--kind', 'code']);
    h.git(['checkout', '-qb', 'fixture-presubmit']);
    fs.writeFileSync(path.join(h.repo, 'check.js'), "console.log('check.js:1: fix this'); process.exit(1);\n");
    h.git(['add', 'check.js']);
    h.git(['commit', '-qm', 'add check']);
    h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  });
}

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function set(h, command, timeout_sec) {
  h.ok(['project', 'set', '--presubmit', JSON.stringify(timeout_sec === undefined ? command : { command, timeout_sec })]);
}

function submit(h, extra = []) {
  return h.run(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker-T1-1', ...extra]);
}

test('project presubmit validates argv and bounded timeout, defaults to ten seconds and null clears', (t) => {
  const h = fixture(t);
  set(h, [process.execPath, '-e', '']);
  assert.equal(h.json(['project', 'show']).gates.presubmit[0], process.execPath);
  assert.match(h.ok(['project', 'show']), /timeout_sec":10/);
  for (const config of [
    'node check.js', [], [''], ['node', '\0'], { command: ['node'], timeout_sec: 0 },
    { command: ['node'], timeout_sec: 61 }, { command: ['node'], timeout_sec: '10' },
    { command: ['node'], timeout_sec: -1 }, { command: ['node'], shell: true },
  ]) {
    assert.ok(require('../lib/presubmit').errors(config).length, JSON.stringify(config));
  }
  assert.equal(h.run(['project', 'set', '--presubmit', '{"command":["node"],"timeout_sec":61}']).code, 2);
  assert.equal(h.run(['project', 'set', '--presubmit', '["node"]', '--agent', 'worker-T1-1']).code, 1);
  h.ok(['project', 'set', '--presubmit', 'null']);
  assert.equal(h.json(['project', 'show']).gates?.presubmit, undefined);
});

test('failing presubmit records its refusal and no head; fixing it submits in the same attempt', (t) => {
  const h = fixture(t);
  set(h, [process.execPath, 'check.js']);
  const before = h.json(['task', 'show', 'T1']);
  const failed = submit(h);
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /check\.js:1: fix this/);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.sha, null);
  assert.equal(task.status, 'in_progress');
  assert.deepEqual(task.claim, before.claim);
  assert.equal(events(h).filter((e) => e.cmd === 'submit').length, 0);
  assert.equal(events(h).at(-1).cmd, 'presubmit refused');
  fs.writeFileSync(path.join(h.repo, 'check.js'), "console.log('passed');\n");
  h.git(['add', 'check.js']);
  h.git(['commit', '-qm', 'fix check']);
  const passed = submit(h);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(h.json(['task', 'show', 'T1']).revision, before.revision);
  const receipt = events(h).findLast((e) => e.cmd === 'submit').detail.presubmit;
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.config.command, [process.execPath, 'check.js']);
  assert.ok(receipt.duration_ms >= 0);
});

test('passing presubmit uses the worktree and inherited environment, preserves argv and records duration', (t) => {
  const h = fixture(t);
  h.env.PRESUBMIT_EXPECTED_CWD = h.repo;
  h.env.PRESUBMIT_MARK = 'worker environment';
  const code = "if (process.cwd() !== process.env.PRESUBMIT_EXPECTED_CWD || process.env.PRESUBMIT_MARK !== 'worker environment' || process.argv[1] !== ' ; $(echo unsafe) ') process.exit(1)";
  const command = [process.execPath, '-e', code, ' ; $(echo unsafe) '];
  set(h, command);
  assert.equal(submit(h).code, 0);
  const event = events(h).findLast((e) => e.cmd === 'submit');
  assert.equal(event.detail.sha, h.git(['rev-parse', 'HEAD']));
  assert.deepEqual(event.detail.presubmit.config.command, command);
  assert.equal(event.detail.presubmit.status, 0);
});

test('timeout and missing command refuse without recording a head', (t) => {
  for (const [command, timeout, expected, escalated] of [
    [[process.execPath, '-e', "console.log('waiting'); setInterval(() => {}, 1000)"], 0.1, /ETIMEDOUT/, false],
    [['tower-crane-no-such-presubmit-tool'], 1, /ENOENT/, true],
  ]) {
    const h = fixture(t);
    set(h, command, timeout);
    const failed = submit(h);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, expected);
    assert.equal(h.json(['task', 'show', 'T1']).sha, null);
    assert.equal(events(h).at(-1).detail.escalated, escalated);
  }
});

test('unset and cleared presubmit leave submit behavior unchanged', (t) => {
  for (const clear of [false, true]) {
    const h = fixture(t);
    if (clear) {
      set(h, ['tower-crane-no-such-presubmit-tool']);
      h.ok(['project', 'set', '--presubmit', 'null']);
    }
    assert.equal(submit(h).code, 0);
    assert.equal(events(h).findLast((e) => e.cmd === 'submit').detail.presubmit, undefined);
  }
});

test('three identical failures pause the loop with attempts and output in the orchestrator inbox; retry resets it', (t) => {
  const h = fixture(t);
  set(h, [process.execPath, 'check.js']);
  for (let n = 1; n <= 3; n++) {
    const failed = submit(h);
    assert.equal(failed.code, 1);
    assert.equal(events(h).at(-1).detail.attempts, n);
  }
  const item = h.json(['inbox']).items.find((i) => i.kind === 'presubmit_failed');
  assert.equal(item.addressed_to, 'orchestrator');
  assert.equal(item.attempts, 3);
  assert.match(item.output, /fix this/);
  const count = events(h).length;
  assert.match(submit(h).stderr, /stop retrying/);
  assert.equal(events(h).length, count);
  assert.equal(h.run(['presubmit', 'retry', 'T1', '--reason', 'fixed dependency', '--agent', 'worker-T1-1']).code, 1);
  h.ok(['presubmit', 'retry', 'T1', '--reason', 'fixed dependency', '--agent', 'orchestrator']);
  assert.equal(h.json(['inbox']).items.some((i) => i.kind === 'presubmit_failed'), false);
  assert.equal(submit(h).code, 1);
  assert.equal(events(h).at(-1).detail.attempts, 1);
});

test('changed failing output resets the consecutive count', (t) => {
  const h = fixture(t);
  set(h, [process.execPath, '-e', "console.log(process.env.PRESUBMIT_DIAGNOSTIC); process.exit(1)"]);
  for (const [output, attempts] of [['first', 1], ['first', 2], ['second', 1]]) {
    h.env.PRESUBMIT_DIAGNOSTIC = output;
    assert.equal(submit(h).code, 1);
    assert.equal(events(h).at(-1).detail.attempts, attempts);
  }
});

test('external file and environment failures escalate on the first attempt', (t) => {
  for (const output of ['README.md:1: invalid link', 'ModuleNotFoundError: missing dependency']) {
    const h = fixture(t);
    set(h, [process.execPath, '-e', `console.log(${JSON.stringify(output)}); process.exit(1)`]);
    assert.match(submit(h).stderr, /Escalated to orchestrator/);
    const item = h.json(['inbox']).items.find((i) => i.kind === 'presubmit_failed');
    assert.equal(item.attempts, 1);
    assert.equal(item.output.trim(), output);
  }
});

test('stack and test-location metadata stay local; primary external diagnostics escalate', (t) => {
  for (const [label, diagnostic, escalated] of [
    ['Node frame', (h) => `Error: regression\n    at TestContext.<anonymous> (${h.repo}/README.md:30:5)`, false],
    ['TAP frame', (h) => `# Error: regression\n#     at TestContext.<anonymous> (${h.repo}/README.md:30:5)`, false],
    ['Python frame', (h) => `Traceback (most recent call last):\n  File "${h.repo}/README.md", line 10, in test\nValueError: regression`, false],
    ['node:test location', (h) => `location: '${h.repo}/README.md:30:1'\nerror: regression`, false],
    ['test-at location', () => 'test at README.md:30:1\nerror: regression', false],
    ['primary location', () => 'README.md:1: invalid link', true],
  ]) {
    const h = fixture(t);
    set(h, [process.execPath, '-e', `console.log(${JSON.stringify(diagnostic(h))}); process.exit(1)`]);
    const result = submit(h);
    assert.equal(result.code, 1, label);
    const event = events(h).at(-1);
    assert.equal(event.cmd, 'presubmit refused', label);
    assert.equal(event.detail.escalated, escalated, label);
    assert.equal(event.detail.attempts, 1, label);
    assert.equal(h.json(['task', 'show', 'T1']).sha, null, label);
  }
});

test('untracked inputs and hook outputs refuse, while ignored dependencies remain usable', (t) => {
  for (const variant of ['input', 'output', 'ignored dependency']) {
    const h = fixture(t);
    if (variant === 'input') fs.writeFileSync(path.join(h.repo, 'local-only.js'), 'untracked input\n');
    if (variant === 'ignored dependency') {
      fs.appendFileSync(path.join(h.repo, '.gitignore'), '\nignored-deps/\n');
      h.git(['add', '.gitignore']);
      h.git(['commit', '-qm', 'ignore dependency cache']);
      fs.mkdirSync(path.join(h.repo, 'ignored-deps'));
      fs.writeFileSync(path.join(h.repo, 'ignored-deps', 'dependency.js'), 'ignored dependency\n');
    }
    const code = variant === 'output' ? "require('node:fs').writeFileSync('local-only.js', 'untracked output')"
      : `if (!require('node:fs').existsSync(${JSON.stringify(variant === 'input' ? 'local-only.js' : 'ignored-deps/dependency.js')})) process.exit(1)`;
    set(h, [process.execPath, '-e', code]);
    const result = submit(h);
    assert.equal(result.code, variant === 'ignored dependency' ? 0 : 1, `${variant}: ${result.stderr}`);
    const task = h.json(['task', 'show', 'T1']);
    if (variant === 'ignored dependency') assert.equal(task.sha, h.git(['rev-parse', 'HEAD']));
    else {
      assert.equal(task.sha, null, variant);
      assert.equal(task.status, 'in_progress', variant);
      assert.match(result.stderr, /clean worktree/, variant);
    }
  }
});

test('only orchestrator or owner overrides with a recorded reason, bound to one head and one submission', (t) => {
  const h = fixture(t);
  set(h, ['tower-crane-no-such-presubmit-tool']);
  assert.equal(submit(h).code, 1);
  assert.equal(h.run(['presubmit', 'override', 'T1', '--reason', 'tool unavailable', '--agent', 'worker-T1-1']).code, 1);
  assert.equal(h.run(['presubmit', 'override', 'T1', '--reason', '  ', '--agent', 'orchestrator']).code, 2);
  h.ok(['presubmit', 'override', 'T1', '--reason', 'tool unavailable', '--agent', 'orchestrator']);
  const override = events(h).at(-1);
  assert.equal(override.detail.reason, 'tool unavailable');
  assert.equal(submit(h).code, 0);
  assert.equal(events(h).findLast((e) => e.cmd === 'submit').detail.presubmit.override, override.id);
  assert.equal(submit(h).code, 1);
});

test('a new head, command configuration or task revision cannot reuse an override', (t) => {
  for (const change of ['head', 'command', 'revision']) {
    const h = fixture(t);
    set(h, ['tower-crane-no-such-presubmit-tool']);
    assert.equal(submit(h).code, 1);
    h.ok(['presubmit', 'override', 'T1', '--reason', 'tool unavailable', '--agent', 'orchestrator']);
    if (change === 'head') {
      fs.appendFileSync(path.join(h.repo, 'check.js'), '// changed\n');
      h.git(['add', 'check.js']);
      h.git(['commit', '-qm', 'change head']);
    } else if (change === 'command') set(h, ['tower-crane-another-missing-presubmit-tool']);
    else {
      h.ok(['release', 'T1', '--agent', 'worker-T1-1', '--reason', 'requirements update']);
      h.ok(['task', 'update', 'T1', '--acceptance', 'check.js still passes']);
      h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
    }
    const failed = submit(h);
    assert.equal(failed.code, 1, change);
    assert.match(failed.stderr, /ENOENT/, change);
    assert.equal(h.json(['task', 'show', 'T1']).sha, null, change);
  }
});

test('hook output is capped and secrets are redacted from diagnostics and events', (t) => {
  const h = fixture(t);
  const token = 'presubmit-secret-value-123456789';
  h.env.API_TOKEN = token;
  set(h, [process.execPath, '-e', "console.log(process.env.API_TOKEN); console.log('x'.repeat(20000)); console.error(process.env.API_TOKEN); process.exit(1)"]);
  const failed = submit(h);
  assert.equal(failed.code, 1);
  assert.ok(!failed.stderr.includes(token));
  assert.ok(failed.stderr.length < 10000);
  const event = events(h).at(-1);
  assert.ok(!JSON.stringify(event).includes(token));
  assert.match(event.detail.output, /redacted:API_TOKEN/);
  assert.match(event.detail.output, /output capped/);
});

test('presubmit refuses a mismatching head and dirty tracked worktree', (t) => {
  const h = fixture(t);
  set(h, [process.execPath, '-e', '']);
  const previous = h.git(['rev-parse', 'HEAD~1']);
  const wrong = h.run(['submit', 'T1', '--sha', previous, '--agent', 'worker-T1-1']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /worktree HEAD/);
  fs.appendFileSync(path.join(h.repo, 'check.js'), '// dirty\n');
  assert.match(submit(h).stderr, /clean worktree/);
  assert.equal(h.json(['task', 'show', 'T1']).sha, null);
});

test('brokered submit runs the hook in the worker environment, carries its receipt and never executes on the host', async (t) => {
  const h = fixture(t);
  const saved = Object.fromEntries(Object.keys(h.env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, h.env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const B = require('../lib/broker');
  const workerOnly = 'worker-only-marker';
  const command = [process.execPath, '-e',
    `if (process.env.PRESUBMIT_WORKER_ONLY !== ${JSON.stringify(workerOnly)}) process.exit(23)`];
  set(h, command);
  const job = { state: h.state, cwd: h.repo, task: 'T1', agent: 'worker-T1-1', role: 'worker',
    harness: 'codex', broker_harnesses: ['codex'], broker: path.join(h.base, 'broker', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const env = { ...h.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task,
    TOWER_CRANE_BROKER: job.broker, PRESUBMIT_WORKER_ONLY: workerOnly };
  const sha = h.git(['rev-parse', 'HEAD']);
  const missing = await B.forward(job.broker, ['submit', 'T1', '--sha', sha], h.state);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /receipt is missing/);
  const config = { command, timeout_sec: 10 };
  const receipt = { sha, config, config_key: require('node:crypto').createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    duration_ms: 1, status: 0, ok: true, output: '' };
  for (const badConfig of [null, command, {}]) {
    const refused = await B.forward(job.broker, ['submit', 'T1', '--sha', sha], h.state, undefined,
      { ...receipt, config: badConfig });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /receipt is missing or stale/);
    assert.equal(h.json(['task', 'show', 'T1']).sha, null);
  }
  const result = await runAsync(['submit', 'T1', '--sha', sha, '--state', h.state, '--agent', job.agent],
    { cwd: h.repo, env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(events(h).findLast((e) => e.cmd === 'submit').detail.presubmit.ok, true);
});
