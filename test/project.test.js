'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

test('the owner config binding is preserved by project settings and must be an absolute path', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = h.readState('project.json');
  h.ok(['project', 'set', '--name', 'renamed']);
  assert.equal(h.readState('project.json').owner_config_dir, original.owner_config_dir);
  const redirected = h.run(['project', 'set', '--owner-config-dir', h.base]);
  assert.equal(redirected.code, 2);
  assert.match(redirected.stderr, /unknown option --owner-config-dir/);
  assert.equal(h.readState('project.json').owner_config_dir, original.owner_config_dir);
  for (const invalid of [null, 4, {}, '', 'relative', `${h.base}\0suffix`]) {
    h.writeState('project.json', { ...original, owner_config_dir: invalid });
    const result = h.run(['project', 'show'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /owner_config_dir must be an absolute path/);
  }
});

test('project set stores, replaces and clears test paths and ignored CI apps', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = h.json(['project', 'show']);
  const paths = ['checks/**/*.chk.js', '**/*Test.java'];
  const apps = ['claude', 'cursor'];
  const set = h.json(['project', 'set', '--tests-paths', JSON.stringify(paths), '--ci-ignore-apps', JSON.stringify(apps)]);
  assert.deepEqual(set, { ...original, tests: { paths }, ci: { ignore_apps: apps } });
  assert.deepEqual(h.json(['project', 'show']), set);
  assert.deepEqual(h.readState('project.json'), set);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).cmd, 'project set');
  assert.equal(events.at(-1).agent, 'owner');
  assert.deepEqual(events.at(-1).detail, { 'tests-paths': JSON.stringify(paths), 'ci-ignore-apps': JSON.stringify(apps) });

  const replaced = h.json(['project', 'set', '--tests-paths', '["qa/"]']);
  assert.deepEqual(replaced.tests, { paths: ['qa/'] });
  assert.deepEqual(replaced.ci, set.ci);
  const renamed = h.json(['project', 'set', '--name', 'renamed']);
  assert.deepEqual(renamed.tests, replaced.tests);
  assert.deepEqual(renamed.ci, replaced.ci);

  const noIgnores = h.json(['project', 'set', '--ci-ignore-apps', '[]']);
  assert.deepEqual(noIgnores.ci, { ignore_apps: [] });
  assert.deepEqual(noIgnores.tests, replaced.tests);
  const defaultTests = h.json(['project', 'set', '--tests-paths', 'null']);
  assert.ok(!Object.hasOwn(defaultTests, 'tests'));
  assert.deepEqual(defaultTests.ci, noIgnores.ci);
  const cleared = h.json(['project', 'set', '--ci-ignore-apps', 'null']);
  assert.deepEqual(cleared, { ...original, name: 'renamed' });
  assert.deepEqual(h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']), cleared);
});

for (const flag of ['--tests-paths', '--tests-keep', '--ci-ignore-apps', '--ci-required']) {
  test(`project set validates ${flag} and writes nothing on invalid input`, (t) => {
    const h = makeRepo(t);
    h.init();
    const files = ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl', 'sketch.md', 'sketch.html'];
    const snapshot = () => files.map((f) => fs.readFileSync(path.join(h.state, f), 'utf8'));
    const before = snapshot();
    const invalid = ['[', '{}', '"test/**"', '1', 'true', '[null]', '[1]', '[""]', '[" \\t"]', '["valid", false]'];
    if (flag === '--tests-paths') invalid.push('[]');
    for (const value of invalid) {
      const r = h.run(['project', 'set', '--name', 'must not persist', flag, value]);
      assert.equal(r.code, 2, `${value}: ${r.stderr}`);
      assert.ok(r.stderr.includes(flag), r.stderr);
      assert.match(r.stderr, /JSON array of non-blank strings or null/);
      assert.deepEqual(snapshot(), before, `${value}: no state, events or sketch changes`);
    }

    const r = h.run(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '[false]']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /--ci-ignore-apps.*JSON array of non-blank strings or null/);
    assert.deepEqual(snapshot(), before, 'an invalid second field refuses both settings');
  });
}

test('init accepts and validates test paths and ignored CI apps as shared settings', (t) => {
  const h = makeRepo(t);
  const bad = h.run(['init', '--name', 'demo', '--goal', 'prove the engine', '--tests-paths', '[]']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--tests-paths.*non-empty JSON array/);
  for (const f of ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl']) {
    assert.ok(!fs.existsSync(path.join(h.state, f)), `${f} not written`);
  }
  h.init(['--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
  const project = h.json(['project', 'show']);
  assert.deepEqual(project.tests, { paths: ['qa/'] });
  assert.deepEqual(project.ci, { ignore_apps: ['claude'] });

  const defaults = makeRepo(t);
  defaults.init(['--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  const cleared = defaults.json(['project', 'show']);
  assert.ok(!Object.hasOwn(cleared, 'tests'));
  assert.ok(!Object.hasOwn(cleared, 'ci'));
});

test('project set and init help document the JSON settings and clearing value', (t) => {
  const h = makeRepo(t);
  for (const command of [['project', 'set'], ['init']]) {
    const help = h.ok([...command, '--help']);
    assert.match(help, /--tests-paths JSON.*null/);
    assert.match(help, /--tests-keep JSON.*null/);
    assert.match(help, /--tests-mode MODE.*prove, run-only or none.*null/);
    assert.match(help, /--tests-by-kind JSON.*null/);
    assert.match(help, /--tests-expensive JSON.*null/);
    assert.match(help, /--ci-ignore-apps JSON.*null/);
    assert.match(help, /--ci-required JSON.*null/);
    assert.match(help, /--decision-delegation JSON.*owner only/);
  }
});

test('required CI names and prefixes are stored, printed, replaced and cleared through the CLI', (t) => {
  const h = makeRepo(t);
  h.init(['--ci-required', '[" test ( ", " lint "]', '--ci-ignore-apps', '["claude"]']);
  assert.deepEqual(h.json(['project', 'show']).ci, { required: ['test (', 'lint'], ignore_apps: ['claude'] });
  assert.match(h.ok(['project', 'show']), /ci\.required: \["test \(","lint"\]/);
  const set = h.json(['project', 'set', '--ci-required', '["test (windows-latest, node 24)"]']);
  assert.deepEqual(set.ci, { required: ['test (windows-latest, node 24)'], ignore_apps: ['claude'] });
  assert.deepEqual(h.readState('project.json'), set);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).detail, { 'ci-required': '["test (windows-latest, node 24)"]' });
  assert.deepEqual(h.json(['project', 'set', '--ci-required', '[]']).ci, { required: [], ignore_apps: ['claude'] });
  assert.deepEqual(h.json(['project', 'set', '--ci-required', 'null']).ci, { ignore_apps: ['claude'] });
  h.ok(['project', 'set', '--ci-ignore-apps', 'null']);
  assert.match(h.ok(['project', 'show']), /ci\.required: \[\]/);
  assert.ok(!Object.hasOwn(h.json(['project', 'show']), 'ci'));
});

test('tests.keep is configured through init and project set without replacing tests.paths', (t) => {
  const h = makeRepo(t);
  h.init(['--tests-paths', '["qa/"]', '--tests-keep', '[" Makefile ", " tools/**/*.gradle "]']);
  assert.deepEqual(h.json(['project', 'show']).tests, { paths: ['qa/'], keep: ['Makefile', 'tools/**/*.gradle'] });
  assert.match(h.ok(['project', 'show']), /tests\.keep: \["Makefile","tools\/\*\*\/\*\.gradle"\]/);
  const set = h.json(['project', 'set', '--tests-keep', '["setup.py"]']);
  assert.deepEqual(set.tests, { paths: ['qa/'], keep: ['setup.py'] });
  assert.deepEqual(h.readState('project.json').tests, set.tests);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).detail, { 'tests-keep': '["setup.py"]' });
  assert.deepEqual(h.json(['project', 'set', '--tests-paths', 'null']).tests, { keep: ['setup.py'] });
  assert.deepEqual(h.json(['project', 'set', '--tests-keep', '[]']).tests, { keep: [] });
  assert.ok(!Object.hasOwn(h.json(['project', 'set', '--tests-keep', 'null']), 'tests'));
  assert.match(h.ok(['project', 'show']), /tests\.keep: \[\]/);
});

test('project set and init trim padded test paths and ignored CI apps', (t) => {
  const h = makeRepo(t);
  h.init(['--tests-paths', '[" qa/\\t"]', '--ci-ignore-apps', '[" claude "]']);
  const initial = h.json(['project', 'show']);
  assert.deepEqual(initial.tests, { paths: ['qa/'] });
  assert.deepEqual(initial.ci, { ignore_apps: ['claude'] });

  const set = h.json(['project', 'set', '--tests-paths', '[" checks/**/*.js ", "\\t**/*Test.java\\n"]', '--ci-ignore-apps', '[" claude ", "\\tcursor\\n"]']);
  assert.deepEqual(set.tests, { paths: ['checks/**/*.js', '**/*Test.java'] });
  assert.deepEqual(set.ci, { ignore_apps: ['claude', 'cursor'] });
  assert.deepEqual(h.readState('project.json'), set);
});

test('project set replaces and clears non-object list sections while preserving object siblings', (t) => {
  const h = makeRepo(t);
  h.init();
  const original = h.readState('project.json');
  for (const section of ['broken', ['broken'], true, 42, null]) {
    h.writeState('project.json', { ...original, tests: section, ci: section });
    const set = h.json(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
    assert.deepEqual(set, { ...original, tests: { paths: ['qa/'] }, ci: { ignore_apps: ['claude'] } });

    h.writeState('project.json', { ...original, tests: section, ci: section });
    const cleared = h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
    assert.deepEqual(cleared, original);
  }

  h.writeState('project.json', { ...original, tests: { extra: 'keep', paths: ['old/'] }, ci: { extra: 'keep', ignore_apps: ['old'] } });
  const set = h.json(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude"]']);
  assert.deepEqual(set.tests, { extra: 'keep', paths: ['qa/'] });
  assert.deepEqual(set.ci, { extra: 'keep', ignore_apps: ['claude'] });
  const cleared = h.json(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  assert.deepEqual(cleared.tests, { extra: 'keep' });
  assert.deepEqual(cleared.ci, { extra: 'keep' });
});

test('project set and show text print configured lists and their defaults alongside the ladder', (t) => {
  const h = makeRepo(t);
  h.init();
  const defaults = h.ok(['project', 'show']);
  assert.match(defaults, /tests\.paths: default layouts/);
  assert.match(defaults, /ci\.ignore_apps: \[\]/);
  assert.match(defaults, /decision_delegation\.orchestrator_technical: false/);
  assert.match(defaults, /ladder \(default harness /);

  const set = h.ok(['project', 'set', '--tests-paths', '["qa/"]', '--ci-ignore-apps', '["claude","cursor"]']);
  assert.match(set, /tests\.paths: \["qa\/"\]/);
  assert.match(set, /ci\.ignore_apps: \["claude","cursor"\]/);
  assert.equal(h.ok(['project', 'show']), set);
  const delegated = h.json([
    'project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner',
  ]);
  assert.deepEqual(delegated.decision_delegation, { orchestrator_technical: true });
  assert.match(h.ok(['project', 'show']), /decision_delegation\.orchestrator_technical: true/);
  assert.match(h.ok(['project', 'set', '--decision-delegation', 'null', '--agent', 'owner']), /decision_delegation\.orchestrator_technical: false/);
  assert.equal(h.ok(['project', 'show']), set);

  const empty = h.ok(['project', 'set', '--ci-ignore-apps', '[]']);
  assert.match(empty, /ci\.ignore_apps: \[\]/);
  const cleared = h.ok(['project', 'set', '--tests-paths', 'null', '--ci-ignore-apps', 'null']);
  assert.equal(cleared, defaults);
});

test('decision delegation accepts only its supported project rule', (t) => {
  const initialized = makeRepo(t);
  initialized.init(['--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  assert.deepEqual(initialized.json(['project', 'show']).decision_delegation, { orchestrator_technical: true });

  const h = makeRepo(t);
  h.init();
  const files = ['project.json', 'events.jsonl'];
  const before = files.map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));
  for (const value of ['[', '[]', 'true', '{"orchestrator_technical":1}', '{"unexpected":true}']) {
    const result = h.run(['project', 'set', '--name', 'must not persist', '--decision-delegation', value, '--agent', 'owner']);
    assert.equal(result.code, 2, `${value}: ${result.stderr}`);
    assert.match(result.stderr, /--decision-delegation/);
    assert.deepEqual(files.map((file) => fs.readFileSync(path.join(h.state, file), 'utf8')), before);
  }
});

test('test modes, kind overrides and expensive suites can be set, replaced and cleared', (t) => {
  const h = makeRepo(t);
  h.init(['--tests-mode', 'run-only', '--tests-by-kind', '{"docs":"none","ops":"none"}', '--tests-expensive', 'true', '--tests-keep', '["Makefile"]']);
  assert.deepEqual(h.json(['project', 'show']).tests, {
    mode: 'run-only', by_kind: { docs: 'none', ops: 'none' }, expensive: true, keep: ['Makefile'],
  });
  const text = h.ok(['project', 'show']);
  assert.match(text, /tests\.mode: run-only/);
  assert.match(text, /tests\.by_kind: \{"docs":"none","ops":"none"\}/);
  assert.match(text, /tests\.expensive: true/);
  const set = h.json(['project', 'set', '--tests-mode', 'prove', '--tests-by-kind', '{"code":"run-only"}', '--tests-expensive', 'false']);
  assert.deepEqual(set.tests, { mode: 'prove', by_kind: { code: 'run-only' }, expensive: false, keep: ['Makefile'] });
  assert.deepEqual(h.readState('project.json'), set);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).detail, {
    'tests-mode': 'prove', 'tests-by-kind': '{"code":"run-only"}', 'tests-expensive': 'false',
  });
  assert.deepEqual(h.json(['project', 'set', '--tests-by-kind', '{}']).tests.by_kind, {});
  assert.deepEqual(h.json(['project', 'set', '--tests-mode', 'null', '--tests-by-kind', 'null', '--tests-expensive', 'null']).tests, { keep: ['Makefile'] });
  h.ok(['project', 'set', '--tests-keep', 'null']);
  assert.match(h.ok(['project', 'show']), /tests\.mode: prove/);
  assert.match(h.ok(['project', 'show']), /tests\.expensive: false/);
  assert.ok(!Object.hasOwn(h.json(['project', 'show']), 'tests'));
});

for (const [flag, value] of [
  ['--tests-mode', 'none'], ['--tests-by-kind', '{"code":"run-only"}'],
  ['--tests-expensive', 'true'], ['--tests-paths', '["src/**"]'], ['--tests-keep', '["lib/**"]'],
  ['--ci-local', JSON.stringify({ command: [process.execPath, '-e', ''], timeout: 5 })],
  ['--decision-delegation', '{"orchestrator_technical":true}'],
]) {
  const ownerRequired = flag === '--decision-delegation';
  const allowed = ownerRequired ? /only the owner with an explicit identity/ : /only the orchestrator or the owner/;
  test(`${flag} requires ${ownerRequired ? 'explicit owner identity' : 'the orchestrator or explicit owner'} on init and project set without writing state`, (t) => {
    const h = makeRepo(t);
    const init = h.run(['init', '--name', 'demo', '--goal', 'owner policy', flag, value, '--agent', 'worker-T9-1']);
    assert.equal(init.code, 1, init.stderr);
    assert.match(init.stderr, allowed);
    assert.ok(!fs.existsSync(h.state), 'refused init creates no state directory');
    h.init();
    const files = ['project.json', 'tasks.json', 'decisions.json', 'events.jsonl', 'sketch.md', 'sketch.html'];
    const snapshot = () => files.map((f) => fs.readFileSync(path.join(h.state, f), 'utf8'));
    const before = snapshot();
    for (const input of [value, 'null']) {
      const denied = h.run(['project', 'set', '--name', 'must not persist', flag, input, '--agent', 'worker-T9-1']);
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stderr, allowed);
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(h.run(['project', 'set', flag, value]).code, 0, 'explicit owner from env may set policy');
  });
}

for (const [flag, invalid] of [
  ['--tests-mode', ['skip', '', 'true', 'PROVE']],
  ['--tests-by-kind', ['[', '[]', '"none"', '{"tooling":"none"}', '{"code":null}', '{"docs":"skip"}', '{"__proto__":"none"}']],
  ['--tests-expensive', ['1', '"true"', '{}', 'yes']],
]) {
  test(`${flag} rejects invalid input without writing state or events`, (t) => {
    const h = makeRepo(t);
    const bad = h.run(['init', '--name', 'demo', '--goal', 'test modes', flag, invalid[0]]);
    assert.equal(bad.code, 2, bad.stderr);
    assert.ok(bad.stderr.includes(flag), bad.stderr);
    assert.ok(!fs.existsSync(path.join(h.state, 'project.json')));
    h.init();
    const files = ['project.json', 'events.jsonl', 'sketch.md', 'sketch.html'];
    const snapshot = () => files.map((f) => fs.readFileSync(path.join(h.state, f), 'utf8'));
    const before = snapshot();
    for (const value of invalid) {
      const r = h.run(['project', 'set', '--name', 'must not persist', flag, value]);
      assert.equal(r.code, 2, `${value}: ${r.stderr}`);
      assert.ok(r.stderr.includes(flag), r.stderr);
      assert.deepEqual(snapshot(), before);
    }
  });
}
