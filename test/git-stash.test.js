'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const { tempRoot } = require('./tmp-root');
const { gitDenied } = require('../lib/shim');

const MESSAGE = 'commit work in progress on the task branch instead';
const REFUSED = [
  ['stash'],
  ['stash', 'push'],
  ['stash', 'save', 'work in progress'],
  ['stash', 'pop'],
  ['stash', 'apply', 'stash@{0}'],
  ['stash', 'drop', 'stash@{0}'],
  ['stash', 'clear'],
  ['stash', 'create'],
  ['stash', 'store', 'HEAD'],
  ['stash', '-u'],
  ['--no-pager', 'stash', 'push', '-m', 'work in progress'],
  ['-c', 'user.name=fixture', 'stash', 'pop'],
  ['-C', '.', 'stash', 'drop'],
];

test('agent git policies refuse every stash form except list', () => {
  for (const policy of [{ gitPush: 'branch', branch: 'task' }, { gitPush: 'none' }]) {
    for (const args of REFUSED) {
      assert.ok(gitDenied(args, policy)?.includes(MESSAGE), args.join(' '));
    }
    for (const args of [['stash', 'list'], ['--no-pager', 'stash', 'list', '--oneline']]) {
      assert.equal(gitDenied(args, policy), null, args.join(' '));
    }
  }
});

test('published shim policies agree on shared stash refusal and the branch alternative', async (t) => {
  const copies = [
    'docs/ladder.md',
    'skills/tower-crane-work/SKILL.md',
    'skills/tower-crane-review/SKILL.md',
    'changelog.d/T510.md',
  ];
  for (const file of copies) {
    await t.test(file, () => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const rule = source.split('\n').find((line) => line.includes('`git stash list`'));
      assert.ok(rule, `${file} must document the allowed list command`);
      assert.match(rule, /refus\w*|Never use/);
      assert.match(rule, /except `git stash list`/);
      assert.match(rule, /shared stash|every worktree shares/);
      assert.match(rule, /commit work in progress on (?:the|their) task branch/);
    });
  }
});

test('the git shim refuses stash in a CLI task worktree and leaves shared stashes and WIP intact', (t) => {
  const h = makeRepo(t);
  h.ok(['init', '--name', 'fixture', '--goal', 'stash isolation']);
  h.ok(['task', 'add', '--title', 'Task branch', '--acceptance', 'keep WIP on the branch']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  const wt = h.ok(['worktree', 'T1', '--agent', 'builder']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'another worktree WIP\n');
  h.git(['stash', 'push', '-m', 'another worktree'], h.repo);
  const stash = h.git(['rev-parse', 'refs/stash'], h.repo);
  const listing = h.git(['stash', 'list'], h.repo);
  const readme = path.join(wt, 'README.md');
  fs.appendFileSync(readme, 'task WIP\n');
  const wip = fs.readFileSync(readme, 'utf8');
  const status = h.git(['status', '--porcelain'], wt);
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const policy = path.join(shimDir, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: h.git(['branch', '--show-current'], wt), repo: 'acme/app' }));
  const shim = (...args) => cp.spawnSync(process.execPath,
    [path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', ...args],
    { cwd: wt, env: h.env, encoding: 'utf8', timeout: HUNG_TEST_MS });
  for (const args of REFUSED) {
    const result = shim(...args);
    assert.equal(result.status, 126, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(result.stderr.includes(MESSAGE), result.stderr);
    assert.equal(fs.readFileSync(readme, 'utf8'), wip);
    assert.equal(h.git(['status', '--porcelain'], wt), status);
    assert.equal(h.git(['rev-parse', 'refs/stash'], h.repo), stash);
    assert.equal(h.git(['stash', 'list'], h.repo), listing);
  }
  const result = shim('stash', 'list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), listing);
});

function assertNoEngineStash(lib) {
  for (const entry of fs.readdirSync(lib, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(lib, file);
    let source = fs.readFileSync(file, 'utf8');
    if (relative === 'shim.js') {
      source = source.replace('sparse-checkout stash status', 'sparse-checkout status')
        .replace("if (sub === 'stash' && args[i + 1] !== 'list') return 'git stash (commit work in progress on the task branch instead)';", '');
    }
    assert.doesNotMatch(source, /\bstash\b/i, `stash invocation in lib/${relative}`);
  }
}

test('lib contains no stash use beyond the shim command recognition and refusal', () => {
  assertNoEngineStash(path.join(ROOT, 'lib'));
});

test('the engine stash scan reads files without a separate path stat', async (t) => {
  fs.mkdirSync(tempRoot(), { recursive: true });
  const base = fs.mkdtempSync(path.join(tempRoot(), 'stash-scan-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const recognition = "sparse-checkout stash status\nif (sub === 'stash' && args[i + 1] !== 'list') return 'git stash (commit work in progress on the task branch instead)';";
  const cases = [
    { name: 'empty directories', files: {} },
    { name: 'top-level file', files: { 'safe.js': 'const safe = true;' } },
    { name: 'nested file', files: { 'gates/safe.js': 'const safe = true;' } },
    { name: 'top-level stash call', files: { 'merge.js': "git(['stash', 'push']);" }, refused: true },
    { name: 'nested stash call', files: { 'gates/merge.js': "git(['stash', 'pop']);" }, refused: true },
    { name: 'shim recognition', files: { 'shim.js': recognition } },
    { name: 'shim stash call', files: { 'shim.js': `${recognition}\ngit(['stash', 'drop']);` }, refused: true },
  ];
  for (const row of cases) {
    await t.test(row.name, (s) => {
      const lib = fs.mkdtempSync(path.join(base, 'lib-'));
      fs.mkdirSync(path.join(lib, 'empty'));
      for (const [name, source] of Object.entries(row.files)) {
        const file = path.join(lib, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
      }
      s.mock.method(fs, 'statSync', () => { throw new Error('separate path stat before read'); });
      if (row.refused) assert.throws(() => assertNoEngineStash(lib), /stash invocation/);
      else assertNoEngineStash(lib);
    });
  }
});
