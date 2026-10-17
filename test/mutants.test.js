'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { readText } = require('../scripts/text');

test('check:shared rejects missing and duplicate mutant targets without running tests', (t) => {
  const h = makeRepo(t);
  for (const name of ['bin', 'lib', 'scripts', 'docs', 'changelog.d', '.github']) {
    fs.cpSync(path.join(ROOT, name), path.join(h.repo, name), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(h.repo, 'CHANGELOG.md'));
  const { scripts } = require('../package.json');
  assert.equal(scripts['check:shared'], 'node scripts/check-shared-files.js --mutants');
  const script = (name, args) => cp.spawnSync(process.execPath,
    [path.join(h.repo, 'scripts', name), ...args],
    { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000 });
  const check = () => script('check-shared-files.js', ['--mutants']);
  const file = path.join(h.repo, 'lib/gates/tests.js');
  const source = readText(file);
  const anchor = 'if (without.ok) {';
  assert.equal(check().status, 0, 'a fixture without a test tree still validates every target');
  const targets = script('mutants.js', ['--check', '--root', h.repo]);
  assert.equal(targets.status, 0, targets.stderr);
  assert.match(targets.stdout, /^\d+ mutant targets match once\n$/);
  for (const [text, occurrences] of [
    [source.replace(anchor, 'if (false) {'), 0],
    [source + `\n// ${anchor}\n`, 2],
  ]) {
    fs.writeFileSync(file, text);
    const drift = check();
    assert.equal(drift.status, 1, drift.stderr);
    assert.match(drift.stderr, new RegExp(`tests-pass-without-change:.*once in lib/gates/tests\\.js.*found ${occurrences}`));
    const selected = script('mutants.js', ['--check', '--only', 'tests-pass-without-change']);
    assert.equal(selected.status, 1);
    assert.match(selected.stderr, new RegExp(`tests-pass-without-change:.*found ${occurrences}`));
  }
  fs.writeFileSync(file, source.replace(/\n/g, '\r\n'));
  const tasks = path.join(h.repo, 'lib/tasks.js');
  fs.writeFileSync(tasks, readText(tasks).replace(/\n/g, '\r\n'));
  assert.equal(check().status, 0, 'multiline anchors match Windows line endings');
  fs.rmSync(file);
  const missing = check();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /tests-pass-without-change:.*lib\/gates\/tests\.js/);
});
