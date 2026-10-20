'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gate = require('../../lib/gates/tests');
const base = require('../../lib/gates/tests-base');
const { shellQuote, treeExec } = require('../../lib/gates/common');
const { cachedFixture } = require('../helpers');
const { readPublished } = require('../atomic-file');
const { scratch, isolateGit, isolateUserFile, initRepo, commit, git } = require('./helpers');

const tmp = scratch('tests-base');
isolateGit(tmp);
isolateUserFile(tmp);
process.env.TOWER_CRANE_TMP = path.join(tmp, 'gates');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const node = shellQuote(process.execPath);
const marker = path.join(tmp, 'runs.jsonl');
const files = {
  'runner.js': `const fs = require('node:fs');
const cp = require('node:child_process');
const files = process.argv.slice(2);
const selected = files.length ? files : fs.readdirSync('test').filter(f => f.endsWith('.test.js')).map(f => 'test/' + f);
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({files: selected, host: process.env.TC_OPT_IN, exclude: process.env.TOWER_CRANE_TEST_EXCLUDE, sandbox: process.env.TOWER_CRANE_SANDBOX}) + '\\n');
const r = cp.spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...selected], {stdio: 'inherit'});
process.exit(r.status ?? 1);
`,
  'test/fail.test.js': "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('first failure', () => assert.fail('old failure'));\ntest('second failure', () => assert.fail('old failure'));\n",
  'test/pass.test.js': "require('node:test')('unrelated case', () => {});\n",
};
const nestedFailure = "const { describe, it } = require('node:test');\ndescribe('suite', () => { it('nested failure', () => require('node:assert/strict').fail('old')); });\n";
const root = path.join(tmp, 'repo');
const baseSha = initRepo(root, files);
git(root, 'checkout', '-q', '-b', 'worker');
const sha = commit(root, { 'change.js': 'module.exports = 1;\n' });
git(root, 'checkout', '-q', 'main');
const cmd = `${node} runner.js`;
const project = { repo: 'acme/base-cache', base: 'main', tests: { mode: 'run-only' },
  gates: { tests_cmd: cmd, tests_proof_cmd: `${cmd} {tests}` } };
const rows = () => fs.existsSync(marker) ? readPublished(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const logs = [];
const context = (p = project) => ({ root, stateDir: path.join(tmp, 'state'), project: p,
  task: { id: 'T1', kind: 'code', sha }, log: (line) => logs.push(line) });

test('base runs only the file holding both failing names, then a later gate reuses it', async () => {
  const first = await gate.run(context());
  assert.deepEqual(first.main_failure?.names, ['first failure', 'second failure'], first.summary);
  assert.equal(first.confirmed_failure, undefined);
  assert.deepEqual(rows().map((r) => r.files), [['test/fail.test.js', 'test/pass.test.js'], ['test/fail.test.js']]);
  assert.deepEqual(first.receipt.base_rerun.files, ['test/fail.test.js']);
  assert.equal(first.receipt.base_rerun.results[0].cached, false);
  assert.equal(first.receipt.base_rerun.base, baseSha);
  assert.deepEqual(first.receipt.test_logs.map((r) => r.phase), ['head', 'base']);
  const baseLog = first.receipt.test_logs[1].log;
  assert.match(fs.readFileSync(path.join(tmp, 'state', baseLog), 'utf8'), /old failure/);
  const second = await gate.run(context());
  assert.deepEqual(second.main_failure, first.main_failure);
  assert.equal(second.receipt.base_rerun.results[0].cached, true);
  assert.equal(second.receipt.test_logs[1].cached, true);
  assert.equal(fs.readFileSync(path.join(tmp, 'state', second.receipt.test_logs[1].log), 'utf8'),
    fs.readFileSync(path.join(tmp, 'state', baseLog), 'utf8'));
  assert.equal(rows().length, 3);
  assert.ok(logs.some((line) => /base .*test\/fail\.test\.js: cached$/.test(line)));
});

test('two concurrent gates share one base file and host settings invalidate the cache', async () => {
  const p = { ...project, tests: { ...project.tests, host_env: { TC_OPT_IN: 'changed' } } };
  const before = rows().length;
  const contexts = [context(p), context(p)];
  contexts[1].task.id = 'T2';
  const results = await Promise.all(contexts.map((c) => gate.run(c)));
  const newRows = rows().slice(before);
  assert.equal(newRows.filter((r) => r.files.length === 1).length, 1);
  assert.deepEqual(results.map((r) => r.receipt.base_rerun.results[0].cached).sort(), [false, true]);
  assert.ok(newRows.every((r) => r.host === undefined && r.exclude === '[]' && r.sandbox === '0'));
});

test('a changed inherited environment invalidates the base result', async () => {
  const saved = process.env.TC_BASE_GENERATION;
  try {
    for (const value of ['first-environment', 'second-environment']) {
      process.env.TC_BASE_GENERATION = value;
      const result = await gate.run(context());
      assert.equal(result.receipt.base_rerun.results[0].cached, false, value);
    }
  } finally {
    if (saved === undefined) delete process.env.TC_BASE_GENERATION;
    else process.env.TC_BASE_GENERATION = saved;
  }
});

test('the environment key covers observed values and normalizes scratch and authoritative markers', () => {
  const cases = [
    ['TC_VISIBLE', 'old', 'new', false, {}, false],
    ['TC_VISIBLE', 'old', 'new', true, { TC_VISIBLE: 'pinned' }, true],
    ['TMPDIR', '/first/scratch', '/second/scratch', false, {}, true],
    ['NODE_TEST_CONTEXT', 'first', 'second', false, {}, true],
    ['TOWER_CRANE_SANDBOX', '1', '0', false, {}, true],
    ['TOWER_CRANE_TEST_EXCLUDE', '["first"]', '["second"]', false, {}, true],
    ['TOWER_CRANE_HOST_ONLY', '["first"]', '["second"]', true, {}, true],
  ];
  for (const [name, first, second, host, host_env, same] of cases) {
    const saved = process.env[name];
    try {
      const p = { tests: { host_env } };
      process.env[name] = first;
      const a = base.settings(p, host);
      process.env[name] = second;
      assert.equal(a === base.settings(p, host), same, `${name}, host=${host}`);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }
});

test('unknown locations fall back to the original command', async () => {
  const custom = `${node} -e "console.log('not ok unknown case'); process.exit(1)"`;
  const p = { ...project, gates: { tests_cmd: custom, tests_proof_cmd: `${cmd} {tests}` } };
  const result = await gate.run(context(p));
  assert.deepEqual(result.main_failure?.names, ['unknown case'], result.summary);
  assert.equal(result.receipt.base_rerun.mode, 'full');
  assert.equal(result.receipt.base_rerun.results[0].command, custom);
  assert.deepEqual(result.receipt.base_rerun.files, []);
});

test('base selection preserves new and shared failure verdicts when files are missing', async () => {
  git(root, 'checkout', '-q', '-b', 'new-failure', 'worker');
  const head = commit(root, { 'test/new.test.js': "require('node:test')('new failure', () => require('node:assert/strict').fail('new error'));\n" });
  git(root, 'checkout', '-q', 'main');
  const c = context();
  c.task.sha = head;
  const before = rows().length;
  const result = await gate.run(c);
  assert.equal(result.confirmed_failure, true);
  assert.equal(result.main_failure, undefined);
  assert.match(result.summary, /Also fails on main.*first failure, second failure/);
  assert.deepEqual(result.receipt.base_rerun.files, ['test/fail.test.js', 'test/new.test.js']);
  assert.equal(rows().length, before + 2, 'the old file is cached and the missing file is checked through the selector');
});

test('nested spec failures keep the base run scoped for suites and subtests', async () => {
  const cases = [
    ['describe', nestedFailure, ['nested failure', 'suite']],
    ['subtest', "require('node:test')('parent', async t => { await t.test('child', () => require('node:assert/strict').fail('old')); });\n", ['child', 'parent']],
  ];
  for (const [label, source, names] of cases) {
    git(root, 'checkout', '-q', '-b', `nested-base-${label}`, 'main');
    commit(root, { 'test/fail.test.js': source });
    git(root, 'checkout', '-q', '-b', `nested-head-${label}`);
    const head = commit(root, { 'change.js': 'module.exports = 4;\n' });
    git(root, 'checkout', '-q', 'main');
    const c = context({ ...project, base: `nested-base-${label}` });
    c.task.sha = head;
    const before = rows().length;
    const result = await gate.run(c);
    assert.deepEqual(result.test_failure.names, names, label);
    assert.deepEqual(result.main_failure?.names, names, result.summary);
    assert.equal(result.receipt.base_rerun.mode, 'files', label);
    assert.deepEqual(result.receipt.base_rerun.files, ['test/fail.test.js'], label);
    assert.deepEqual(rows().slice(before).map((r) => r.files),
      [['test/fail.test.js', 'test/pass.test.js'], ['test/fail.test.js']], label);
  }
});

test('generated files compare against the base whether the head tracks them or not', async () => {
  git(root, 'checkout', '-q', '-b', 'generated-base', 'main');
  const runner = `const fs = require('node:fs');
fs.mkdirSync('generated', {recursive: true});
fs.writeFileSync('generated/fail.test.js', ${JSON.stringify(files['test/fail.test.js'])});
const r = require('node:child_process').spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...(process.argv.slice(2).length ? process.argv.slice(2) : ['generated/fail.test.js'])], {stdio: 'inherit'});
process.exit(r.status ?? 1);
`;
  commit(root, { 'generated-runner.js': runner });
  const command = `${node} generated-runner.js`;
  const p = { ...project, base: 'generated-base', gates: { tests_cmd: command, tests_proof_cmd: `${command} {tests}` } };
  for (const tracked of [false, true]) {
    git(root, 'checkout', '-q', '-b', `generated-head-${tracked}`, 'generated-base');
    const additions = { 'change.js': 'module.exports = 3;\n' };
    if (tracked) additions['generated/fail.test.js'] = files['test/fail.test.js'];
    const head = commit(root, additions);
    git(root, 'checkout', '-q', 'main');
    const c = context(p);
    c.task.sha = head;
    const result = await gate.run(c);
    assert.deepEqual(result.main_failure?.names, ['first failure', 'second failure'], result.summary);
    assert.equal(result.confirmed_failure, undefined);
    assert.equal(result.receipt.base_rerun.mode, 'files');
    assert.deepEqual(result.receipt.base_rerun.files, ['generated/fail.test.js']);
    assert.equal(result.receipt.base_rerun.results[0].cached, tracked, 'the second head shares the generated base file');
  }
});

test('the base lease budgets both joining a cache holder and a fresh run', () => {
  const cases = [
    [{ mode: 'run-only' }, 0, 3, 7],
    [{ mode: 'run-only' }, 2, 1, 5],
    [{ mode: 'prove' }, 0, 1, 4],
    [{ mode: 'prove', expensive: true }, 1, 2, 10],
    [{ mode: 'none' }, 2, 3, 0],
  ];
  for (const [tests, hosts, files, expected] of cases) {
    assert.equal(gate.plannedCommands({ tests }, 'code', hosts, files), expected, JSON.stringify({ tests, hosts, files }));
  }
});

test('base commands receive the remaining phase budget after setup or cache waiting', async () => {
  const c = context({ ...project, tests: { ...project.tests, host_env: { TC_CACHE_BUDGET: 'probe' } } });
  c.args = { timeout: 0.2 };
  const budgets = [];
  c.exec = async (command, args, opts) => {
    if (opts.shell) budgets.push(opts.timeout);
    return treeExec(command, args, opts);
  };
  const result = await gate.run(c);
  assert.deepEqual(result.main_failure?.names, ['first failure', 'second failure'], result.summary);
  assert.equal(budgets.length, 2);
  assert.equal(budgets[0], 12000);
  assert.ok(budgets[1] > 0 && budgets[1] < budgets[0], JSON.stringify(budgets));
});

test('host-only base commands keep host_env and clear exclusions, including cached diagnostics', async () => {
  const secret = 'host-secret-for-base-cache-123456';
  git(root, 'checkout', '-q', '-b', 'host-base', 'main');
  const host = "require('node:test')('host failure', () => { console.log(process.env.TC_PASSWORD); require('node:assert/strict').equal(process.env.TC_OPT_IN, 'required-value'); });\n";
  commit(root, { 'test/host.test.js': host });
  git(root, 'checkout', '-q', '-b', 'host-head');
  const head = commit(root, { 'change.js': 'module.exports = 2;\n' });
  git(root, 'checkout', '-q', 'main');
  const p = { ...project, base: 'host-base', tests: { mode: 'run-only', host_only: ['test/host.test.js'],
    host_env: { TC_OPT_IN: 'opted-in', TC_PASSWORD: secret } },
  gates: { tests_cmd: `${cmd} test/pass.test.js`, tests_proof_cmd: `${cmd} {tests}` } };
  for (const cached of [false, true]) {
    const c = context(p);
    c.task.sha = head;
    const before = rows().length;
    const result = await gate.run(c);
    assert.equal(result.infrastructure_failure, true, result.summary);
    assert.equal(result.receipt.base_rerun.results[0].cached, cached);
    const ran = rows().slice(before);
    assert.equal(ran.length, cached ? 2 : 3);
    assert.equal(ran[0].host, undefined);
    assert.equal(ran[0].exclude, '["test/host.test.js"]');
    for (const r of ran.slice(1)) {
      assert.deepEqual(r.files, ['test/host.test.js']);
      assert.equal(r.host, 'opted-in');
      assert.equal(r.exclude, undefined);
      assert.equal(r.sandbox, '0');
    }
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const cache = path.join(process.env.TOWER_CRANE_TMP, 'tests-base-cache');
  const contents = fs.readdirSync(cache).flatMap((repo) => fs.readdirSync(path.join(cache, repo)).flatMap((sha) =>
    fs.readdirSync(path.join(cache, repo, sha)).filter((f) => f.endsWith('.json')).map((f) => readPublished(path.join(cache, repo, sha, f), 'utf8'))));
  assert.ok(contents.every((content) => !content.includes(secret)), 'cached output is redacted');
});

test('locations handle spec, TAP, duplicates, spaces, absolute paths and incomplete reports', () => {
  const cwd = path.join(tmp, 'wt');
  const cases = [
    ['spec', 'test at test/a.test.js:2:3\n✖ a (1ms)', ['a'], ['test/a.test.js']],
    ['TAP', "not ok 1 - a\n  location: 'test/a.test.js:2:3'", ['a'], ['test/a.test.js']],
    ['absolute', `test at ${path.join(cwd, 'test/a.test.js')}:2:3\n✖ a (1ms)`, ['a'], ['test/a.test.js']],
    ['spaces', 'test at test/a b.test.js:2:3\n✖ a', ['a'], ['test/a b.test.js']],
    ['duplicate names', 'test at test/a.test.js:2:3\n✖ a\ntest at test/b.test.js:2:3\n✖ a', ['a'], ['test/a.test.js', 'test/b.test.js']],
    ['partial', 'test at test/a.test.js:2:3\n✖ a', ['a', 'b'], null],
    ['outside', 'test at ../other.test.js:2:3\n✖ a', ['a'], null],
    ['duplicate outside', 'test at test/a.test.js:2:3\n✖ a\ntest at ../other.test.js:2:3\n✖ a', ['a'], null],
    ['describe parent', '▶ suite\n  ✖ a (1ms)\n✖ suite (2ms)\n✖ failing tests:\ntest at test/a.test.js:2:3\n✖ a (1ms)', ['a', 'suite'], ['test/a.test.js']],
    ['subtest parent', '▶ parent\n  ✖ child\n✖ parent\ntest at test/a.test.js:2:3\n✖ child', ['child', 'parent'], ['test/a.test.js']],
    ['deep parents', '▶ outer\n  ▶ inner\n    ✖ a\n  ✖ inner\n✖ outer\ntest at test/a.test.js:2:3\n✖ a', ['a', 'inner', 'outer'], ['test/a.test.js']],
    ['duplicate parents', '▶ suite\n  ✖ a\n✖ suite\n▶ suite\n  ✖ b\n✖ suite\ntest at test/a.test.js:2:3\n✖ a\ntest at test/b.test.js:2:3\n✖ b', ['a', 'b', 'suite'], ['test/a.test.js', 'test/b.test.js']],
    ['hook failure', '▶ suite\n  ✖ body\n✖ suite\ntest at test/a.test.js:2:3\n✖ body\ntest at test/a.test.js:1:1\n✖ suite', ['body', 'suite'], ['test/a.test.js']],
    ['load error', '✖ test/a.test.js\ntest at test/a.test.js:1:1\n✖ test/a.test.js', ['test/a.test.js'], ['test/a.test.js']],
    ['nested TAP', "not ok 1 - child\n  location: 'test/a.test.js:2:3'\nnot ok 1 - suite\n  location: 'test/a.test.js:1:1'", ['child', 'suite'], ['test/a.test.js']],
    ['incomplete nested report', '▶ suite\n  ✖ a\n  ✖ b\n✖ suite\ntest at test/a.test.js:2:3\n✖ a', ['a', 'b', 'suite'], null],
    ['unsafe nested report', '▶ suite\n  ✖ a\n✖ suite\ntest at ../other.test.js:2:3\n✖ a', ['a', 'suite'], null],
    ['none', '', [], null],
  ];
  for (const [name, output, names, expected] of cases) assert.deepEqual(base.failingFiles(output, names, cwd), expected, name);
});

test('cache keys, interrupted runs, corruption, stale locks and pruning', async () => {
  const cache = path.join(tmp, 'unit-cache');
  let runs = 0;
  const run = async () => ({ ok: false, status: 1, output: `not ok case ${++runs}` });
  const options = { root: cache, sha: 'a'.repeat(40), command: cmd, settingsHash: 'settings', file: 'test/a.test.js',
    timeout: 1000, run, snapshot: (r) => r };
  assert.equal((await base.cached(options)).cached, false);
  assert.equal((await base.cached(options)).cached, true);
  for (const change of [{ command: `${cmd} other` }, { settingsHash: 'other' }, { file: 'test/b.test.js' }, { sha: 'b'.repeat(40) }]) {
    assert.equal((await base.cached({ ...options, ...change })).cached, false);
  }
  for (const interrupted of [{ status: 1, signal: 'SIGTERM' }, { status: 1, timedOut: true }, { status: 127 },
    { status: 1, error: new Error('unavailable') }, { ok: false, status: 1, resource_reason: 'process limit', output: 'not ok stopped case' },
    { ok: false, status: 1, abort: true, output: 'not ok interrupted case' }]) {
    let attempts = 0;
    const attempt = () => {
      const controller = new AbortController();
      return base.cached({ ...options, command: JSON.stringify(interrupted), signal: controller.signal, run: async () => {
        attempts++;
        if (interrupted.abort) controller.abort();
        return { ok: false, output: 'not ok interrupted runner', ...interrupted };
      } });
    };
    await attempt();
    await attempt();
    assert.equal(attempts, 2);
  }
  const resultFile = path.join(cache, options.sha, `${base.hash([cmd, 'settings', options.file])}.json`);
  fs.writeFileSync(resultFile, '{broken');
  assert.equal((await base.cached(options)).cached, false);
  fs.unlinkSync(resultFile);
  const stale = require('../../lib/state').tryMarkedLock(`${resultFile}.lock`, { keepLive: true });
  const marker = JSON.parse(readPublished(stale.file, 'utf8'));
  fs.writeFileSync(stale.file, JSON.stringify({ ...marker, pid: 2147483647 }));
  assert.equal((await base.cached(options)).cached, false, 'a dead holder does not block the file');
  const stagedOutput = `${resultFile}.deadbeefdeadbeef.new`;
  const stagedLock = `${resultFile}.lock.2147483647.deadbeefdeadbeef.new`;
  fs.writeFileSync(stagedOutput, 'partial output');
  fs.mkdirSync(stagedLock);
  fs.writeFileSync(path.join(stagedLock, 'deadbeefdeadbeef'), JSON.stringify({ ...marker, pid: 2147483647, nonce: 'deadbeefdeadbeef' }));
  base.prune(cache, options.sha);
  assert.equal(fs.existsSync(stagedOutput), false, 'orphaned output is pruned');
  assert.equal(fs.existsSync(stagedLock), false, 'a dead staged lock is pruned');
  await base.cached({ ...options, sha: 'c'.repeat(40) });
  assert.equal(fs.existsSync(path.join(cache, 'b'.repeat(40))), false, 'old base directories are removed');
  for (let i = 0; i < base.MAX_RESULTS + 1; i++) await base.cached({ ...options, sha: 'c'.repeat(40), file: `${i}.js` });
  const results = fs.readdirSync(cache).flatMap((dir) => fs.readdirSync(path.join(cache, dir)).filter((f) => f.endsWith('.json')));
  assert.ok(results.length <= base.MAX_RESULTS, `${results.length} retained`);
});

test('the real CLI persists selective base evidence and cached results', (t) => {
  const h = cachedFixture(t, 'base-failure', (h) => {
    h.init(['--tests-cmd', `${node} --test --test-reporter=spec test/*.test.js`, '--tests-proof-cmd', `${node} --test --test-reporter=spec {tests}`]);
    h.ok(['project', 'set', '--tests-mode', 'run-only']);
    fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'test/fail.test.js'), nestedFailure);
    h.git(['add', '-A']);
    h.git(['commit', '-qm', 'base failure']);
    h.git(['checkout', '-qb', 'worker']);
    fs.writeFileSync(path.join(h.repo, 'change.js'), 'module.exports = 1;\n');
    h.git(['add', '-A']);
    h.git(['commit', '-qm', 'change']);
    const head = h.git(['rev-parse', 'HEAD']).trim();
    h.git(['checkout', '-q', 'main']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', head, '--agent', 'worker']);
  });
  for (const cached of [false, true]) {
    const result = h.run(['check', 'tests', 'T1', '--agent', 'worker', '--json']);
    assert.equal(result.code, 1, result.stderr + result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(evidence.receipt.base_rerun.files, ['test/fail.test.js']);
    assert.equal(evidence.receipt.base_rerun.results[0].cached, cached);
    assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1).receipt.base_rerun, evidence.receipt.base_rerun);
  }
});
