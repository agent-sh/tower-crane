'use strict';

// tests.host_only files are skipped by a sandboxed run and still run in the tests gate on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, ROOT } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');

const RUNNER = path.join(ROOT, 'test', 'run.js');
// Each file leaves a marker in MARK_DIR when it runs.
const mark = (name) => `require('node:fs').writeFileSync(require('node:path').join(process.env.MARK_DIR, '${name}'), 'ran');\n`;
const FILES = {
  'test/host.test.js': `require('node:test')('opted-in host test', { skip: process.env.TC_HOST_OPT_IN !== '1' }, () => {
require('node:assert/strict').equal(process.env.TC_HOST_OPT_IN, '1');
${mark('host')}});
`,
  'test/plain.test.js': "require('node:assert/strict').equal(process.env.TC_HOST_OPT_IN, undefined);\n" + mark('plain'),
};

function submitChange(h) {
  h.git(['switch', '-qc', 'host-change']);
  for (const [name, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(h.repo, name)), { recursive: true });
    fs.writeFileSync(path.join(h.repo, name), text);
  }
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'host-only and plain tests']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'the host test runs on the host']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'host-change', '--agent', 'w-1']);
  return sha;
}

test('a host_only test is skipped in a sandboxed run and executed by check tests', (t) => {
  const h = makeRepo(t);
  const marks = path.join(h.base, 'marks');
  fs.mkdirSync(marks);
  const env = { MARK_DIR: marks };
  const cmd = `${shellQuote(process.execPath)} ${shellQuote(RUNNER)} test/host.test.js test/plain.test.js`;
  const proof = `${shellQuote(process.execPath)} ${shellQuote(RUNNER)} {tests}`;
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-mode', 'run-only', '--tests-cmd', cmd, '--tests-proof-cmd', proof, '--tests-host-only', JSON.stringify(['test/host.test.js']), '--tests-host-env', '{"TC_HOST_OPT_IN":"1"}']);
  submitChange(h);

  // A sandboxed worker runs the test command with the environment its spawn gives it.
  const sandbox = { ...env, TOWER_CRANE_SANDBOX: '1', TOWER_CRANE_HOST_ONLY: JSON.stringify(['test/host.test.js']) };
  const worker = cp.spawnSync(process.execPath, [RUNNER, 'test/host.test.js', 'test/plain.test.js'], {
    cwd: h.repo, encoding: 'utf8', env: { ...h.env, ...sandbox },
  });
  assert.equal(worker.status, 0, worker.stdout + worker.stderr);
  assert.match(worker.stderr, /skipped host-only tests in this sandbox.*test\/host\.test\.js/);
  assert.deepEqual(fs.readdirSync(marks), ['plain'], 'the sandboxed run skips the host-only file and runs the rest');

  // An absolute path names the same file, so the sandboxed run skips it too.
  fs.rmSync(path.join(marks, 'plain'));
  const absolute = cp.spawnSync(process.execPath, [RUNNER, path.join(h.repo, 'test', 'host.test.js'), 'test/plain.test.js'], {
    cwd: h.repo, encoding: 'utf8', env: { ...h.env, ...sandbox },
  });
  assert.equal(absolute.status, 0, absolute.stdout + absolute.stderr);
  assert.deepEqual(fs.readdirSync(marks), ['plain'], 'an absolute path to the host-only file is skipped as well');

  // Node expands a directory or a glob after the skip, so a sandboxed run refuses those selections.
  fs.rmSync(path.join(marks, 'plain'));
  for (const selection of ['test', 'test/*.test.js']) {
    const refused = cp.spawnSync(process.execPath, [RUNNER, selection], {
      cwd: h.repo, encoding: 'utf8', env: { ...h.env, ...sandbox },
    });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /names test files, not directories or globs/);
    assert.ok(refused.stderr.includes(selection), refused.stderr);
  }
  assert.deepEqual(fs.readdirSync(marks), [], 'a refused selection runs no test');

  // The gate runs in the same sandboxed environment but still runs every test on the host.
  const gate = h.run(['check', 'tests', 'T1', '--agent', 'checker'], { env: sandbox });
  assert.equal(gate.code, 0, gate.stdout + gate.stderr);
  assert.deepEqual(fs.readdirSync(marks).sort(), ['host', 'plain']);
  const evidence = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(evidence.type, 'tests');
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.receipt.host_only.run, ['test/host.test.js']);
  assert.deepEqual(evidence.receipt.host_only.skipped, []);
  assert.equal(evidence.receipt.host_only.results[0].ran, 1);
});

test('host_env is operational, stored, printed, replaced and cleared, and rejects invalid maps', (t) => {
  const h = makeRepo(t);
  const values = { TC_HOST_OPT_IN: '1', TC_HOST_MODEL: 'test-model' };
  h.init(['--tests-host-env', JSON.stringify(values), '--tests-host-only', '["test/host.test.js"]']);
  assert.deepEqual(h.readState('project.json').tests.host_env, values);
  assert.match(h.ok(['project', 'show']), /tests\.host_env: .*TC_HOST_OPT_IN/);
  h.ok(['project', 'set', '--tests-host-env', '{"TC_HOST_OPT_IN":"2"}'], { env: { TOWER_CRANE_AGENT: 'orchestrator' } });
  assert.deepEqual(h.readState('project.json').tests.host_env, { TC_HOST_OPT_IN: '2' });
  const before = h.readState('project.json');
  for (const value of ['[', '[]', '1', '"x"', '{"":"1"}', '{"BAD-NAME":"1"}', '{"OPT_IN":1}', '{"OPT_IN":"\\u0000"}']) {
    const bad = h.run(['project', 'set', '--tests-host-env', value]);
    assert.equal(bad.code, 2, bad.stderr);
    assert.match(bad.stderr, /--tests-host-env.*JSON map/);
    assert.deepEqual(h.readState('project.json'), before);
  }
  h.ok(['project', 'set', '--tests-host-env', '{}']);
  assert.deepEqual(h.readState('project.json').tests.host_env, {});
  h.ok(['project', 'set', '--tests-host-env', 'null']);
  assert.deepEqual(h.readState('project.json').tests, { host_only: ['test/host.test.js'] });
});

test('a spawned worker is told the host-only tests and gets them in its environment', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-host-only', JSON.stringify(['test/host.test.js']), '--tests-host-env', '{"TC_HOST_OPT_IN":"1"}']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T1', '-'], { input: '- change the lab session\n' });
  h.env.CODEX_HOME = path.join(h.base, 'codex');
  h.env.CLAUDE_CONFIG_DIR = path.join(h.base, 'claude');
  const seen = h.json(['spawn', '--task', 'T1', '--dry-run']);
  const prompt = seen.argv.find((arg) => arg.includes('## Task'));
  assert.match(prompt, /## Host-only tests[\s\S]*- test\/host\.test\.js/);
  assert.equal(seen.env.TOWER_CRANE_HOST_ONLY, JSON.stringify(['test/host.test.js']));
  assert.equal(seen.env.TC_HOST_OPT_IN, undefined);
});
