'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, ACCOUNT_HOME, pinLiveRung, makeRepo, makeProjectRepo, makeTaskRepo, cachedFixture, fixtureLadder } = require('./helpers');
const { readPublished } = require('./atomic-file');

const { modelSelections } = require('../scripts/check-model-config');
const { DEADLINE_MIN } = require('../scripts/suite-time');

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

for (const harness of ['claude', 'codex']) {
  test(`live ${harness} fixture keeps account-home protection in the controller and out of agent commands`, {
    skip: process.platform === 'win32' && 'stand-in harnesses use POSIX executables',
  }, (t) => {
    const h = makeRepo(t);
    h.env.CODEX_HOME = path.join(h.env.HOME, '.codex');
    h.env.CLAUDE_CONFIG_DIR = path.join(h.env.HOME, '.claude');
    h.env.NODE_OPTIONS += ' --trace-warnings';
    // The environment probe needs no Claude broker socket on a sandboxed test host.
    const rung = harness === 'claude' ? 'orchestrator' : 'small';
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    const out = path.join(h.base, 'agent-probe.json');
    const missing = path.join(h.base, 'hidden-account-home.js');
    fs.writeFileSync(path.join(bin, harness), `#!${process.execPath}
const cp = require('node:child_process');
// A sandbox hides the test checkout, so the inherited preload is missing there.
const env = { ...process.env, NODE_OPTIONS: String(process.env.NODE_OPTIONS || '').replaceAll(
  ${JSON.stringify(ACCOUNT_HOME.replace(/\\/g, '/'))}, ${JSON.stringify(missing)}) };
const probe = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write("probe started")'],
  { env, encoding: 'utf8', timeout: 300000 });
require(${JSON.stringify(path.join(ROOT, 'test/atomic-file'))}).writeAtomic(${JSON.stringify(out)}, JSON.stringify({
  status: probe.status, stdout: probe.stdout, stderr: probe.stderr,
  options: process.env.NODE_OPTIONS, project: process.env.PROJECT_KEEP, rung: process.env.RUNG_KEEP,
}));
process.exit(probe.status ?? 1);
`, { mode: 0o755 });
    const pathKey = Object.keys(h.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
    h.env[pathKey] = bin + path.delimiter + (h.env[pathKey] || '');
    h.init();
    h.ok(['project', 'set', '--env', JSON.stringify({ PROJECT_KEEP: 'project-value' })]);
    h.ok(['ladder', 'set', rung, '--env', JSON.stringify({ RUNG_KEEP: 'rung-value' })]);
    h.ok(['task', 'add', '--title', 'Live fixture environment', '--acceptance', 'probe starts']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Run the bounded fixture probe.\n' });
    const variable = harness === 'claude' ? 'TOWER_CRANE_LIVE_MODEL' : 'TOWER_CRANE_LIVE_PROFILE';
    const saved = process.env[variable];
    process.env[variable] = harness === 'claude'
      ? fixtureLadder().ladder.orchestrator.model : fixtureLadder().ladder.small.profile;
    t.after(() => {
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    });
    pinLiveRung(h, harness, rung);
    for (const [source, options] of [
      ['inherited', undefined], ['project', '--trace-uncaught'], ['rung', '--trace-warnings'],
    ]) {
      if (source === 'project') h.ok(['project', 'set', '--env', JSON.stringify({ PROJECT_KEEP: 'project-value', NODE_OPTIONS: options })]);
      if (source === 'rung') h.ok(['ladder', 'set', rung, '--env', JSON.stringify({ RUNG_KEEP: 'rung-value', NODE_OPTIONS: options })]);
      if (fs.existsSync(out)) fs.rmSync(out);
      const result = h.run(['spawn', '--task', 'T1', '--role', rung, '--wait']);
      const seen = fs.existsSync(out) ? JSON.parse(readPublished(out, 'utf8')) : null;
      assert.equal(result.code, 0, `${source}: ${result.stderr}\n${JSON.stringify(seen)}`);
      assert.deepEqual(seen, {
        status: 0, stdout: 'probe started', stderr: '', ...(options === undefined ? {} : { options }),
        project: 'project-value', rung: 'rung-value',
      });
    }
    assert.ok(h.env.NODE_OPTIONS.includes(ACCOUNT_HOME.replace(/\\/g, '/')), 'controller CLIs retain the account preload');
    assert.equal(h.readState('project.json').owner_config_dir, path.dirname(h.env.TOWER_CRANE_CONFIG));
  });
}

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
  const summary = path.join(h.base, 'step-summary.md');
  const result = cp.spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'scripts', 'probe-model-swap.js')],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache, XDG_CACHE_HOME: 'caller-cache',
      LOCALAPPDATA: 'caller-cache', TC_TEST_SHARD: '1/3', GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model swap probe passed/);
  assert.match(result.stdout, new RegExp(`^Model swap probe: suite wall time \\d+\\.\\d min, \\d+% of the ${DEADLINE_MIN}-minute software-gate deadline$`, 'm'));
  assert.match(fs.readFileSync(summary, 'utf8'), /^Model swap probe: suite wall time /);
  assert.equal(fs.readFileSync(path.join(cache, 'model-swap-probe.tap'), 'utf8'), 'not ok 1 - replaced log\n');
  const failed = cp.spawnSync(process.execPath, ['--require', hook, path.join(ROOT, 'scripts', 'probe-model-swap.js')],
    { cwd: ROOT, env: { ...h.env, TOWER_CRANE_TEST_TMP: cache, PROBE_UNEXPECTED_FAILURE: '1', GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8', timeout: 300000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /error: fixture assertion details/);
});

test('raw model scan covers comments, regexes, strings and template text', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const file = path.join(h.repo, 'lib', 'selection.js');
  const id = ['gpt', 'probe-2099'].join('-');
  for (const source of [
    `// ${id}`, `/* ${id} */`, `const pattern = /${id}/;`,
    `const text = "${id}";`, 'const text = `' + id + ' ${suffix}`;',
  ]) {
    fs.writeFileSync(file, source);
    assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}`], source);
  }
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

test('object literal division cannot hide a later model literal', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  const file = path.join(h.repo, 'lib', 'selection.js');
  const id = ['gpt', 'probe-2099'].join('-');
  const source = `const ratio = { valueOf() { return 4; } } / 2; module.exports = { model: ${JSON.stringify(id)}, ratio };`;
  const context = { module: { exports: {} } };
  require('node:vm').runInNewContext(source, context);
  assert.equal(context.module.exports.model, id);
  assert.equal(context.module.exports.ratio, 2);
  fs.writeFileSync(file, source);
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}`]);
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
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}`, `lib/selection.js:2: ${id}`]);
});

test('raw model scan requires exact path and matched text allowlist entries with reasons', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib'));
  fs.mkdirSync(path.join(h.repo, 'tools'));
  const id = ['claude', 'provider'].join('-');
  const literal = './' + id;
  const allowlist = path.join(h.repo, 'tools', 'model-literals.json');
  const entry = { path: 'lib/selection.js', text: id, reason: 'Harness module import' };
  fs.writeFileSync(allowlist, JSON.stringify([entry]));
  const file = path.join(h.repo, entry.path);
  fs.writeFileSync(file, 'require(' + JSON.stringify(literal) + ');');
  assert.deepEqual(modelSelections(h.repo, h.env), []);
  fs.writeFileSync(file, 'module.exports = ' + JSON.stringify({ model: id + '-other' }) + ';');
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/selection.js:1: ${id}-other`]);
  fs.writeFileSync(file, 'module.exports = ' + JSON.stringify({ model: literal }) + ';');
  fs.renameSync(file, path.join(h.repo, 'lib', 'another.js'));
  assert.deepEqual(modelSelections(h.repo, h.env), [`lib/another.js:1: ${id}`]);
  fs.writeFileSync(allowlist, JSON.stringify([{ ...entry, reason: '' }]));
  assert.throws(() => modelSelections(h.repo, h.env), /reason/);
});

test('release manifest model-literal exemption stays within its file and token', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'lib', 'gates'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, 'tools'), { recursive: true });
  const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'model-literals.json'), 'utf8'))
    .filter(entry => entry.path === 'lib/gates/merge.js' && entry.text === 'claude-plugin');
  fs.writeFileSync(path.join(h.repo, 'tools', 'model-literals.json'), JSON.stringify(entries));
  const model = ['claude', 'fixture-2099'].join('-');
  for (const [file, literals, rejected] of [
    ['lib/gates/merge.js', ['.claude-plugin/plugin.json'], []],
    ['lib/gates/merge.js', ['.claude-plugin/marketplace.json'], []],
    ['lib/gates/merge.js', ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'], []],
    ['lib/gates/merge.js', ['claude-plugin-other'], ['claude-plugin-other']],
    ['lib/gates/another.js', ['.claude-plugin/plugin.json'], ['claude-plugin']],
    ['lib/gates/merge.js', [model], [model]],
  ]) {
    const target = path.join(h.repo, file);
    fs.writeFileSync(target, `module.exports = ${JSON.stringify(literals)};\n`);
    assert.deepEqual(modelSelections(h.repo, h.env), rejected.map(text => `${file}:1: ${text}`), JSON.stringify(literals));
    fs.rmSync(target);
  }
});

test('generated coverage filename allowance stays within its map and exact token', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.repo, 'tools'), { recursive: true });
  const token = ['claude', 'sandbox', 'placeholders.js'].join('-');
  const file = 'tools/tests-map.json';
  const entries = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'model-literals.json'), 'utf8'))
    .filter(entry => entry.path === file && entry.text === token);
  const allowfile = path.join(h.repo, 'tools/model-literals.json');
  fs.writeFileSync(allowfile, JSON.stringify(entries));
  const model = ['claude', 'fixture-2099'].join('-');
  for (const [where, value, rejected] of [
    [file, { [`lib/${token}`]: ['test/example.test.js'] }, []],
    [file, { 'lib/example.js': [`test/${token}`] }, []],
    [file, { [`lib/${token}-other`]: [] }, [token + '-other']],
    [file, { [`lib/${token.replace('.js', '.mjs')}`]: [] }, [token.replace('.js', '.mjs')]],
    ['tools/another-map.json', { [`lib/${token}`]: [] }, [token]],
    [file, { [`lib/${token}`]: [model] }, [model]],
  ]) {
    const target = path.join(h.repo, where);
    fs.writeFileSync(target, JSON.stringify(value));
    assert.deepEqual(modelSelections(h.repo, h.env), rejected.map(text => `${where}:1: ${text}`),
      JSON.stringify(value));
    fs.rmSync(target);
  }
  assert.equal(entries.length, 1);
  fs.writeFileSync(allowfile, JSON.stringify([{ ...entries[0], reason: '' }]));
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
