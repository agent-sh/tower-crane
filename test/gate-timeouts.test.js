'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');

test('timeout validation and runner interruption formats', () => {
  const timeouts = require('../lib/gate-timeouts');
  for (const value of [0, -1, Infinity, NaN, '1', true, 1e-10, 2 ** 31 / 60000]) {
    assert.equal(timeouts.valid(value), false, String(value));
  }
  for (const value of [0.05, 20, 60]) assert.equal(timeouts.valid(value), true);
  assert.equal(timeouts.minutes({}, 'tests'), 20);
  assert.equal(timeouts.minutes({ gates: { clean_timeout_min: null } }, 'clean'), 20);
  for (const [before, after, files] of [
    ['# Subtest: test/done.js\nok 1 - test/done.js\n# Subtest: test/slow.js\n', '', ['test/slow.js']],
    ['', 'Interrupted while running:\n\n⚠ test/slow.js (test/slow.js:1:1)\n', ['test/slow.js']],
    ['', '# Interrupted while running: test/slow.js at test/slow.js:1:1\n', ['test/slow.js']],
    ['', "test at test/done.js:5:1\n✖ assertion\nError: bad\n\ntest at test/slow.js:1:1\n✖ test/slow.js\n  'Promise resolution is still pending but the event loop has already resolved'\n", ['test/slow.js']],
    ['', '\x1b[31m⚠ pending (test/slow.js:1:1)\x1b[39m\n', ['test/slow.js']],
    ['working\n', 'terminated\n', []],
    ["test at test/old.js:1:1\n'Promise resolution is still pending but the event loop has already resolved'\n",
      '⚠ test/slow.js (test/slow.js:1:1)\n', ['test/slow.js']],
  ]) assert.deepEqual(timeouts.runningFiles(before, after), files);
});

test('gate timeouts are operational settings and record infrastructure failure through the CLI', (t) => {
  const h = makeRepo(t);
  const script = path.join(h.base, 'suite.js');
  // A scripted TAP runner starts one file and never completes it before the gate deadline.
  fs.writeFileSync(script, `
console.log('TAP version 13\\n# Subtest: test/slow.test.js');
process.on('SIGTERM', () => {
  console.log("not ok 1 - test/slow.test.js\\n  ---\\n  error: 'Promise resolution is still pending but the event loop has already resolved'\\n  ...");
  process.exit(1);
});
setTimeout(() => process.exit(0), 10000); // wait-allow: the gate must time out before this deliberately slow runner completes
`);
  const command = `${shellQuote(process.execPath)} ${shellQuote(script)}`;
  h.init(['--tests-mode', 'run-only', '--tests-cmd', command, '--clean-cmd', command,
    '--tests-timeout-min', '0.05', '--clean-timeout-min', '0.05']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.ok(['task', 'add', '--title', 'Slow suite', '--acceptance', 'timeout is infrastructure']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  for (const type of ['tests', 'clean']) {
    const flag = `--${type}-timeout-min`;
    const denied = h.run(['project', 'set', flag, '1', '--agent', 'worker']);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /operational|orchestrator/);
    h.ok(['project', 'set', flag, '0.05', '--agent', 'orchestrator']);
    assert.match(h.ok(['project', 'show']), new RegExp(`gates\\.${type}_timeout_min: 0\\.05`));

    const result = h.run(['check', type, 'T1', '--agent', 'orchestrator']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const task = h.readState('tasks.json').tasks[0];
    const evidence = task.evidence.at(-1);
    assert.equal(evidence.type, type);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.infrastructure_failure, true);
    assert.equal(evidence.confirmed_failure, undefined);
    assert.equal(evidence.test_failure, undefined);
    assert.equal(evidence.timeout.minutes, 0.05);
    assert.deepEqual(evidence.timeout.running_files, ['test/slow.test.js']);
    assert.match(evidence.summary, /timed out after 0\.05 min/);
    assert.doesNotMatch(evidence.summary, /Failing tests|Make the tests pass|Promise resolution/);
    assert.equal(task.status, 'submitted');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const audit = events.findLast((e) => e.cmd === `check ${type}`);
    assert.equal(audit.detail.infrastructure_failure, true);
    assert.deepEqual(audit.detail.timeout, evidence.timeout);
    assert.equal(events.some((e) => e.cmd === 'escalate'), false);
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);

    const invalid = h.run(['project', 'set', flag, '0', '--agent', 'orchestrator']);
    assert.equal(invalid.code, 2, invalid.stderr);
    assert.match(invalid.stderr, /positive.*minutes/);
    h.ok(['project', 'set', flag, 'null', '--agent', 'orchestrator']);
    assert.equal(h.readState('project.json').gates[`${type}_timeout_min`], undefined);
    assert.match(h.ok(['project', 'show']), new RegExp(`gates\\.${type}_timeout_min: 20`));
  }
});
