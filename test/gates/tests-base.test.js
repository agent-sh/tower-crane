'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gate = require('../../lib/gates/tests');
const base = require('../../lib/gates/tests-base');
const { shellQuote } = require('../../lib/gates/common');
const { cachedFixture } = require('../helpers');
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
const root = path.join(tmp, 'repo');
const baseSha = initRepo(root, files);
git(root, 'checkout', '-q', '-b', 'worker');
const sha = commit(root, { 'change.js': 'module.exports = 1;\n' });
git(root, 'checkout', '-q', 'main');
const cmd = `${node} runner.js`;
const project = { repo: 'acme/base-cache', base: 'main', tests: { mode: 'run-only' },
  gates: { tests_cmd: cmd, tests_proof_cmd: `${cmd} {tests}` } };
const rows = () => fs.readFileSync(marker, 'utf8').trim().split('\n').map(JSON.parse);
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
  const second = await gate.run(context());
  assert.deepEqual(second.main_failure, first.main_failure);
  assert.equal(second.receipt.base_rerun.results[0].cached, true);
  assert.equal(rows().length, 3);
  assert.ok(logs.some((line) => /base.*test\/fail.test.js.*cached/.test(line)));
});

test('two concurrent gates share one base file and host settings invalidate the cache', async () => {
  const p = { ...project, tests: { ...project.tests, host_env: { TC_OPT_IN: 'changed' } } };
  const before = rows().length;
  const results = await Promise.all([gate.run(context(p)), gate.run(context(p))]);
  const newRows = rows().slice(before);
  assert.equal(newRows.filter((r) => r.files.length === 1).length, 1);
  assert.deepEqual(results.map((r) => r.receipt.base_rerun.results[0].cached).sort(), [false, true]);
  assert.ok(newRows.every((r) => r.host === undefined && r.exclude === '[]' && r.sandbox === '0'));
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

test('base-only selection preserves new and shared failure verdicts without running missing files', async () => {
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
  assert.deepEqual(result.receipt.base_rerun.files, ['test/fail.test.js']);
  assert.equal(rows().length, before + 1, 'the old base file is cached and the new file is absent at base');
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
    fs.readdirSync(path.join(cache, repo, sha)).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(cache, repo, sha, f), 'utf8'))));
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
  for (const interrupted of [{ status: null, signal: 'SIGTERM' }, { status: null, timedOut: true }, { status: 127 }, { status: 1, error: new Error('unavailable') }]) {
    let attempts = 0;
    const opts = { ...options, command: JSON.stringify(interrupted), run: async () => { attempts++; return interrupted; } };
    await base.cached(opts);
    await base.cached(opts);
    assert.equal(attempts, 2);
  }
  const resultFile = path.join(cache, options.sha, `${base.hash([cmd, 'settings', options.file])}.json`);
  fs.writeFileSync(resultFile, '{broken');
  assert.equal((await base.cached(options)).cached, false);
  fs.unlinkSync(resultFile);
  const stale = require('../../lib/state').tryMarkedLock(`${resultFile}.lock`, { keepLive: true });
  const marker = JSON.parse(fs.readFileSync(stale.file, 'utf8'));
  fs.writeFileSync(stale.file, JSON.stringify({ ...marker, pid: 2147483647 }));
  assert.equal((await base.cached(options)).cached, false, 'a dead holder does not block the file');
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
    fs.writeFileSync(path.join(h.repo, 'test/fail.test.js'), files['test/fail.test.js']);
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
