'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRepo } = require('../helpers');
const { shellQuote } = require('../../lib/gates/common');

test('gates.tmp_root holds the worktrees of check tests, ci and clean; TOWER_CRANE_TMP overrides it', (t) => {
  const h = makeRepo(t);
  // Every gate command appends the directory it ran in to a log outside the temporary roots.
  const recorder = path.join(h.base, 'record.js');
  const log = path.join(h.base, 'ran.jsonl');
  fs.writeFileSync(recorder, `
const fs = require('node:fs');
const [gate, file] = process.argv.slice(2);
fs.appendFileSync(file, JSON.stringify({ gate, cwd: fs.realpathSync.native(process.cwd()) }) + '\\n');
if (gate === 'clean') console.log(JSON.stringify({ items: [] }));
`);
  const shellCommand = (gate) => `${shellQuote(process.execPath)} ${shellQuote(recorder)} ${gate} ${shellQuote(log)}`;
  const ranLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  h.init(['--tests-mode', 'run-only', '--tests-cmd', shellCommand('tests'), '--clean-cmd', shellCommand('clean'),
    '--ci-local', JSON.stringify({ command: [process.execPath, recorder, 'ci', log], timeout: 30 })]);
  h.ok(['task', 'add', '--title', 'Scratch on the project root', '--acceptance', 'gates build under gates.tmp_root']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);

  // Operational like the other gate settings: a worker cannot set it, and a relative path is refused.
  const denied = h.run(['project', 'set', '--tmp-root', h.base, '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /operational|orchestrator/);
  const relative = h.run(['project', 'set', '--tmp-root', 'scratch', '--agent', 'orchestrator']);
  assert.equal(relative.code, 2, relative.stderr);
  assert.match(relative.stderr, /absolute directory/);

  const root = path.join(h.base, 'scratch');
  fs.mkdirSync(root);
  h.ok(['project', 'set', '--tmp-root', root, '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), new RegExp(`gates\\.tmp_root: ${JSON.stringify(root).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  for (const gate of ['tests', 'clean', 'ci']) {
    const result = h.run(['check', gate, 'T1', '--agent', 'orchestrator']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(ranLog().map((r) => r.gate), ['tests', 'clean', 'ci']);
  for (const r of ranLog()) assert.ok(r.cwd.startsWith(`${root}${path.sep}`), `${r.gate} ran in ${r.cwd}`);
  // Each worktree is removed when its gate returns, so the root holds nothing afterwards.
  assert.deepEqual(fs.readdirSync(root), []);
  let evidence = h.readState('tasks.json').tasks[0].evidence;
  for (const type of ['tests', 'clean', 'ci']) assert.equal(evidence.findLast((e) => e.type === type).tmp_root, root);

  // TOWER_CRANE_TMP still wins over the project setting.
  const override = path.join(h.base, 'override');
  fs.mkdirSync(override);
  h.env.TOWER_CRANE_TMP = override;
  const overridden = h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(overridden.code, 0, overridden.stdout + overridden.stderr);
  assert.ok(ranLog().at(-1).cwd.startsWith(`${override}${path.sep}`));
  evidence = h.readState('tasks.json').tasks[0].evidence;
  assert.equal(evidence.findLast((e) => e.type === 'tests').tmp_root, override);
  delete h.env.TOWER_CRANE_TMP;

  // Unset, the gates use the OS temporary directory again.
  h.ok(['project', 'set', '--tmp-root', 'null', '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), /gates\.tmp_root: null/);
  const defaulted = h.run(['check', 'clean', 'T1', '--agent', 'orchestrator']);
  assert.equal(defaulted.code, 0, defaulted.stdout + defaulted.stderr);
  assert.ok(ranLog().at(-1).cwd.startsWith(`${fs.realpathSync.native(os.tmpdir())}${path.sep}`));
  evidence = h.readState('tasks.json').tasks[0].evidence;
  assert.equal(evidence.findLast((e) => e.type === 'clean').tmp_root, os.tmpdir());
});
