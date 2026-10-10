'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, makeRepo, makeProjectRepo, makeTaskRepo, cachedFixture, fixtureLadder } = require('./helpers');

const { modelSelections, literals } = require('../scripts/check-model-config');

test('cached fixtures pin their ladder and keep copies independent', (t) => {
  const tasks = [{ args: ['--title', 'Cached task', '--acceptance', 'pinned model'], brief: 'cached brief\n' }];
  for (const create of [makeProjectRepo, t => makeTaskRepo(t, tasks),
    t => cachedFixture(t, 'pinned-ladder', h => { h.init(); })]) {
    const first = create(t);
    const second = create(t);
    const pinned = fixtureLadder();
    for (const h of [first, second]) {
      const project = h.readState('project.json');
      assert.deepEqual({ harness: project.harness, ladder: project.ladder }, pinned);
      assert.equal(fs.existsSync(h.userConfig), false);
    }
    first.ok(['ladder', 'set', 'easy', '--model', 'copy-only-model', '--clear', 'profile']);
    assert.deepEqual(second.readState('project.json').ladder, pinned.ladder);
  }
});

test('model swap probe has Git history and validates the same open log when its path is replaced', (t) => {
  const h = makeRepo(t);
  const cache = path.join(h.base, 'probe-cache');
  const hook = path.join(h.base, 'probe-hook.cjs');
  fs.writeFileSync(hook, `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function (command, args, options) {
  if (command !== process.execPath || (args[0] !== '--test' && args[0] !== path.join(options.cwd, 'test', 'run.js'))) return original.call(this, command, args, options);
  if (args[0] !== path.join(options.cwd, 'test', 'run.js') || !args.includes('--test-concurrency=3') || options.timeout !== 45 * 60 * 1000) {
    throw new Error('probe must use the software-gate runner and deadline');
  }
  for (const key of ['XDG_CACHE_HOME', 'LOCALAPPDATA', 'TC_TEST_SHARD', 'NODE_TEST_CONTEXT']) {
    if (key in options.env) throw new Error('probe inherited ' + key);
  }
  if (process.platform !== 'win32' && options.env.TOWER_CRANE_TEST_TMP.length > 50) {
    throw new Error('probe browser socket path is too long');
  }
  const check = original.call(this, process.execPath, [path.join(options.cwd, 'scripts', 'check-shared-files.js')],
    { cwd: options.cwd, env: options.env, encoding: 'utf8' });
  if (check.status !== 0) throw new Error('probe shared-files check failed: ' + check.stderr);
  const lint = original.call(this, process.execPath,
    ['--test', '--test-name-pattern=every shipped|model selections live', path.join(options.cwd, 'test', 'model-config.test.js')],
    { cwd: options.cwd, env: options.env, encoding: 'utf8' });
  if (lint.status !== 0) throw new Error('probe model lint failed: ' + lint.stdout + lint.stderr);
  fs.writeSync(options.stdio[1], 'not ok 1 - BUILTIN matches the documented defaults and init fallback\\n# tests 1\\n# fail 1\\n');
  if (options.env.PROBE_UNEXPECTED_FAILURE) {
    fs.writeSync(options.stdio[1], '# Subtest: unexpected fixture failure\\nnot ok 2 - unexpected fixture failure\\n  ---\\n  error: fixture assertion details\\n  ...\\n');
  }
  const log = path.join(${JSON.stringify(cache)}, 'model-swap-probe.tap');
  fs.renameSync(log, log + '.replaced');
  fs.writeFileSync(log, 'not ok 1 - replaced log\\n');
  return { status: 1 };
};
`);
  const result = cp.spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'scripts', 'probe-model-swap.js')],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache, XDG_CACHE_HOME: 'caller-cache',
      LOCALAPPDATA: 'caller-cache', TC_TEST_SHARD: '1/3' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model swap probe passed/);
  assert.equal(fs.readFileSync(path.join(cache, 'model-swap-probe.tap'), 'utf8'), 'not ok 1 - replaced log\n');
  const failed = cp.spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'scripts', 'probe-model-swap.js')],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache, PROBE_UNEXPECTED_FAILURE: '1' },
      encoding: 'utf8', timeout: 60000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /error: fixture assertion details/);
});

test('literal lexer distinguishes comments, regexes, escapes and nested templates', () => {
  const source = '// "ignored"\nconst pattern = /["\']/; const escaped = "\\x67pt-example";\n'
    + 'const message = `outer ${condition ? `nested ${"inside"}` : "otherwise"}`; const after = "after";';
  assert.deepEqual([...literals(source)].map(token => token.raw),
    ['"\\x67pt-example"', '"inside"', '"otherwise"', '"after"']);
});

test('postfix updates before division cannot hide later model literals', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const file = path.join(h.repo, 'lib', 'selection.js');
  const id = ['gpt', 'probe-2099'].join('-');
  for (const [update, ratio] of [['count++', 2], ['count--', 2], ['++count', 2.5], ['--count', 1.5]]) {
    const source = `let count = 4; const ratio = ${update} / 2; module.exports = { model: ${JSON.stringify(id)}, ratio };`;
    const context = { module: { exports: {} } };
    require('node:vm').runInNewContext(source, context);
    assert.equal(context.module.exports.model, id);
    assert.equal(context.module.exports.ratio, ratio);
    fs.writeFileSync(file, source);
    assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}`], update);
  }
});

test('literal lint has no syntax-based reference exemptions', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const file = path.join(h.repo, 'lib', 'selection.js');
  const id = ['gpt', 'probe-2099'].join('-');
  const forms = [
    'module.exports = { model: ID };',
    'const selected = { path: ID }; module.exports = { model: selected.path };',
    'for (const file of [ID]) { module.exports = { model: file }; }',
    'module.exports = { files: [ID], tests: [ID] };',
    'require(ID);',
    'require(ID,);',
    'require(ID /* comment */);',
    'import data from ID with { type: "json" };',
    'module.exports = { model: /* comment */ ID };',
  ];
  for (const quote of ['"', "'", '`']) for (const form of forms) {
    fs.writeFileSync(file, form.replaceAll('ID', quote + id + quote));
    const violations = modelSelections(h.repo, h.env);
    assert.ok(violations.some(value => value === `lib/selection.js:1: ${id}`), form);
  }
  fs.writeFileSync(file, '// ' + id + '\nconst words = "unrelated"; /* ' + id + ' */');
  assert.deepEqual(modelSelections(h.repo, h.env), []);
});

test('literal lint requires exact path and whole literal allowlist entries with reasons', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  fs.mkdirSync(path.join(h.repo, 'tools'));
  const id = ['claude', 'provider'].join('-');
  const literal = './' + id;
  const allowlist = path.join(h.repo, 'tools', 'model-literals.json');
  const entry = { path: 'lib/selection.js', literal, reason: 'Harness module import' };
  fs.writeFileSync(allowlist, JSON.stringify([entry]));
  const file = path.join(h.repo, entry.path);
  fs.writeFileSync(file, 'require(' + JSON.stringify(literal) + ');');
  assert.deepEqual(modelSelections(h.repo, h.env), []);
  fs.writeFileSync(file, 'module.exports = ' + JSON.stringify({ model: id }) + ';');
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}`]);
  fs.writeFileSync(file, 'module.exports = ' + JSON.stringify({ model: literal }) + ';');
  fs.renameSync(file, path.join(h.repo, 'lib', 'another.js'));
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/another.js:1: ${id}`]);
  fs.writeFileSync(allowlist, JSON.stringify([{ ...entry, reason: '' }]));
  assert.throws(() => modelSelections(h.repo, h.env), /reason/);
});

test('model lint rejects every shipped alias and model pattern in code and JSON', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  fs.mkdirSync(path.join(h.repo, 'bin'));
  fs.mkdirSync(path.join(h.repo, 'research'));
  const aliases = Object.keys(require('../lib/ladder').BUILTIN.claude_aliases);
  const ids = [...aliases, ['claude', 'fixture-2099'].join('-'), ['gpt', 'fixture-2099'].join('-'),
    ['as', 'tra'].join(''), ['so', 'l'].join(''), ['lu', 'na'].join('')];
  for (const file of ['lib/selection.js', 'bin/selection.cjs', 'research/runtime.json']) {
    for (const id of ids) {
      const config = JSON.stringify({ model: id });
      fs.writeFileSync(path.join(h.repo, file), file.endsWith('.json') ? config : 'module.exports = ' + config + ';');
      assert.deepEqual(modelSelections(h.repo, h.env), [`${file}:1: ${id}`]);
    }
    fs.rmSync(path.join(h.repo, file));
  }
});

test('model lint scans documentary JSON regardless of import syntax', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'research'));
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const id = ['gpt', 'fixture-2099'].join('-');
  const record = 'research/T38.json';
  fs.writeFileSync(path.join(h.repo, record), JSON.stringify({
    sources: [{ id: 'stub', url: 'https://example.invalid' }],
    claims: [{ claim: 'A historical measurement', quote: id, source: 'stub' }],
  }));
  for (const source of ['', 'require("../research/T38");', 'require(`../research/T38.json`);',
    'import data from "../research/T38.json" with { type: "json" };']) {
    fs.writeFileSync(path.join(h.repo, 'lib', 'selection.js'), source);
    assert.deepEqual(modelSelections(h.repo, h.env), [`${record}:1: ${id}`]);
  }
});

test('model selections live only in BUILTIN or explicitly allowed literals', () => {
  const violations = modelSelections(ROOT);
  assert.deepEqual(violations, [], `model selections outside configuration:\n${violations.join('\n')}`);
});
