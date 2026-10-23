'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { shellQuote } = require('../lib/gates/common');
const { HUNG_TEST_MS } = require('./signals');

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
    ['', '\x1b]8;;file:///test/slow.js\x07⚠ pending (test/slow.js:1:1)\x1b]8;;\x07\n', ['test/slow.js']],
    ['\x1b]0;suite\x07# Subtest: test/slow.js\n', '', ['test/slow.js']],
    ['working\n', 'terminated\n', []],
    ["test at test/old.js:1:1\n'Promise resolution is still pending but the event loop has already resolved'\n",
      '⚠ test/slow.js (test/slow.js:1:1)\n', ['test/slow.js']],
  ]) assert.deepEqual(timeouts.runningFiles(before, after), files);
  // The timeout tail loses escapes before redaction, so one inside a token cannot hide it.
  const token = `ghp_${'c3'.repeat(18)}`;
  const { createRedactor } = require('../lib/gates/common');
  const run = { timeoutOutput: `working\ntoken ${token.slice(0, 8)}\x1b]8;;x\x07${token.slice(8)}\n`, output: '' };
  const tail = timeouts.failure(run, 1, 'cmd', '', createRedactor([['TIMEOUT_TOKEN', token]])).timeout.output_tail;
  assert.equal(tail, 'working\ntoken [redacted:TIMEOUT_TOKEN]');
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

// inbox reads PRs with synchronous gh calls while its base CI read runs in the background, so a
// timer can come due while the event loop is blocked, before the child's exit or output is seen.
test('a timeout that comes due during a blocked event loop stops only a child with nothing to show', async (t) => {
  const C = require('../lib/gates/common');
  const h = makeRepo(t);
  const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // wait-allow: blocks the event loop past the gate timeout, the condition under test
  const cases = [
    ['exited', 1, 4],
    // More than a pipe buffer: the child cannot exit until the parent reads.
    ['waiting on its stdout pipe', 1, 1 << 20],
    ['waiting on its stderr pipe', 2, 1 << 20],
    ['idle', null, 0],
  ];
  for (const startup of [0, 1800]) {
    for (const [what, fd, size] of cases) {
      const ready = path.join(h.base, `ready-${startup}-${fd}-${size}`);
      const script = `
const fs = require('node:fs');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startup}); // wait-allow: models a child not scheduled before the old fixed block ended
${fd ? `fs.writeSync(${fd}, 'x'.repeat(${Math.min(size, 4096)}));` : ''}
// write-atomic: existence signals that output is in the pipe, or the idle child has started.
fs.writeFileSync(${JSON.stringify(ready)}, '');
${fd ? `process.${fd === 1 ? 'stdout' : 'stderr'}.write('x'.repeat(${Math.max(0, size - 4096)}));`
    : 'setTimeout(() => {}, 30000);'} // wait-allow: idle child outlives the gate timeout under test
`;
      const pending = C.exec({ exec: C.treeExec }, process.execPath, ['-e', script], { timeout: 300 }); // wait-allow: the gate timeout itself is under test
      // Keep the loop blocked while waiting for actual pipe output. A fixed delay alone
      // races child startup under load and can turn a pipe case into the idle case.
      const deadline = performance.now() + HUNG_TEST_MS;
      while (!fs.existsSync(ready) && performance.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // wait-allow: readiness while deliberately preventing the timeout and pipe callbacks from running
      }
      const started = fs.existsSync(ready);
      if (started) block();
      const r = await pending;
      assert.equal(started, true, `${what}, startup=${startup}: child never became ready`);
      assert.equal(r.timedOut, fd === null, `${what}, startup=${startup}`);
      if (fd !== null) {
        assert.equal(r.ok, true, `${what}: ${r.stderr}`);
        assert.equal(r.stdout.length, fd === 1 ? size : 0, what);
        assert.equal(r.stderr.length, fd === 2 ? size : 0, what);
      } else {
        const failure = C.ghFailure({ ...r, stdout: '{"id":1}' }, 'gh api runs');
        assert.match(failure, /^gh api runs failed: timed out after 300 ms \(status=/);
        assert.doesNotMatch(failure, /"id"/);
      }
    }
  }
});

// A runner killed at its deadline often stops mid-line, and both streams can end that way.
test('unfinished lines end on lines of their own, and the timeout snapshot keeps only whole lines', async () => {
  const C = require('../lib/gates/common');
  const partial = "process.stdout.write('# Subtest: test/slow.js'); process.stderr.write('stderr partial');";
  const exited = await C.exec({ exec: C.treeExec }, process.execPath, ['-e', `${partial} process.exitCode = 1;`], {});
  assert.deepEqual(exited.output.split('\n').sort(), ['# Subtest: test/slow.js', 'stderr partial']);
  // The rest of a token arrives during the shutdown grace: the snapshot must not keep its first half.
  const token = 'ghp_T361Head' + 'T361TailBody01234567';
  const hung = `process.stdout.write('# Subtest: test/slow.js\\ntoken ${token.slice(0, 12)}');
process.on('SIGTERM', () => { process.stdout.write('${token.slice(12)}\\n'); process.exit(1); });
setTimeout(() => {}, 60000);`; // wait-allow: a child that outlives the gate timeout under test
  const r = await C.exec({ exec: C.treeExec }, process.execPath, ['-e', hung], { timeout: 3000 }); // wait-allow: the gate timeout itself is under test
  assert.equal(r.timedOut, true);
  assert.equal(r.timeoutOutput, '# Subtest: test/slow.js\n');
  if (process.platform !== 'win32') assert.match(r.output, new RegExp(`^token ${token}$`, 'm'));
  const failure = require('../lib/gate-timeouts').failure(r, 1, 'node slow.js');
  assert.deepEqual(failure.timeout.running_files, ['test/slow.js']);
  assert.ok(!JSON.stringify(failure).includes('T361Head'), JSON.stringify(failure));
});

// A line longer than twice the kept length is cut somewhere in its middle, where a secret may sit.
test('a line longer than the kept tail is omitted, never kept from an arbitrary character', async () => {
  const C = require('../lib/gates/common');
  const script = `const fs = require('node:fs');
fs.writeSync(1, 'key ghp_' + 'C'.repeat(90));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // wait-allow: the gate must read the first part of the line on its own, the condition under test
fs.writeSync(1, 'C'.repeat(10) + ' end\\n');`;
  const r = await C.exec({ exec: C.treeExec }, process.execPath, ['-e', script], { keep: 40 });
  assert.equal(r.ok, true, r.stderr);
  for (const text of [r.output, r.stdout]) {
    assert.ok(!text.includes('CCCCCCCCCC'), text);
    assert.match(text, /\[overlong line omitted\]/);
  }
  // A cut that falls on a line start keeps that line.
  assert.equal(C.keepTail('ab\ncd\nef', 5), 'cd\nef');
  assert.equal(C.keepTail('ab\ncdef\n', 6), 'cdef\n');
  assert.equal(C.keepTail('abcdefgh', 3), '[overlong line omitted]');
});

// Searching everything a stream holds again on each chunk makes a long line quadratic.
test('a stream without newlines is joined in linear work', async () => {
  const C = require('../lib/gates/common');
  const size = 8 << 20;
  let scanned = 0;
  const original = { indexOf: String.prototype.indexOf, lastIndexOf: String.prototype.lastIndexOf };
  for (const name of Object.keys(original)) {
    String.prototype[name] = function (...args) { scanned += this.length; return original[name].apply(this, args); };
  }
  let r;
  try {
    r = await C.exec({ exec: C.treeExec }, process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`], {});
  } finally {
    Object.assign(String.prototype, original);
  }
  assert.equal(r.ok, true, r.stderr);
  assert.equal(r.output.length, size);
  assert.ok(scanned < 4 * size, `searched ${scanned} characters for ${size} written`);
});
