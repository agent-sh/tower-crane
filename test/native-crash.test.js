'use strict';
// The native crash patterns run in process; test/gates/tests.test.js runs the gate's rerun and
// test/gates.test.js the evidence and status wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const NativeCrash = require('../lib/native-crash');
const { scratch } = require('./gates/helpers');

// node:test's spec failure for a test whose execFileSync child got the signal.
const execError = (name, { signal = 'SIGSEGV', stdout = '<Buffer >', stderr = '<Buffer >', pid = 22 } = {}) => `test at test/crash.test.js:3:1
✖ ${name} (211.8ms)
  Error: Command failed: node -e crash
      at checkExecSyncError (node:child_process:990:11)
      at TestContext.<anonymous> (test/crash.test.js:4:6) {
    status: null,
    signal: '${signal}',
    output: [ null, ${stdout}, ${stderr} ],
    pid: ${pid},
    stdout: ${stdout},
    stderr: ${stderr}
  }
`;

// T412: the crash sits in a worker log the test's own error quotes.
const NESTED = `test at test/escalation.test.js:582:3
✖ climbs to the owner at the range ceiling (5294.9ms)
  Error: Unexpected escalation ceiling: T1 exhausted easy..medium at medium: worker exit without submit (code 1).
  Worker worker-T1-2: exit 1, signal null, log /tmp/T1-worker-T1-2.log
  node:child_process:1029
      throw err;
      ^

  Error: Command failed: node bin/tower-crane.js claim T1
      at Object.execFileSync (node:child_process:1026:15)
      at [eval]:5:1 {
    status: null,
    signal: 'SIGSEGV',
    output: [ null, '', '' ],
    pid: 416821,
    stdout: '',
    stderr: ''
  }

  Node.js v26.12.0

      at test/escalation.test.js:147:13
`;

// T453: the test helper's message ends where the child's stderr would follow.
const cliLine = (name, signal, stderr = '') => `test at test/board.test.js:963:1
✖ ${name} (1484.3ms)
  Error: tower-crane task add --title Metrics --acceptance d exited null (signal ${signal}): ${stderr}
      at cliFailure (test/helpers.js:611:10)
`;

const ORDINARY = `test at test/atomic-file.test.js:350:1
✖ reads with readPublished (24.3ms)
  AssertionError [ERR_ASSERTION]: read with readPublished
      at Test.fn (test/atomic-file.test.js:362:10)
`;

test('native crash patterns: signal, empty output, pid and whether every failing test shows one', () => {
  const cases = [
    ['execFileSync with empty buffers', execError('a'), ['a'], [{ test: 'a', signal: 'SIGSEGV', pid: 22 }], true],
    ['empty strings in a quoted worker log', NESTED, ['climbs to the owner at the range ceiling'],
      [{ test: 'climbs to the owner at the range ceiling', signal: 'SIGSEGV', pid: 416821 }], true],
    ['helper message with empty stderr', cliLine('b', 'SIGSEGV'), ['b'], [{ test: 'b', signal: 'SIGSEGV', pid: null }], true],
    ['SIGBUS', cliLine('b', 'SIGBUS'), ['b'], [{ test: 'b', signal: 'SIGBUS', pid: null }], true],
    ['SIGILL', execError('a', { signal: 'SIGILL' }), ['a'], [{ test: 'a', signal: 'SIGILL', pid: 22 }], true],
    ['TAP quotes the helper message', `not ok 1 - c\n  ---\n  error: 'tower-crane claim T1 exited null (signal SIGSEGV): '\n  ...\n`, ['c'],
      [{ test: 'c', signal: 'SIGSEGV', pid: null }], true],
    ['helper message with stderr', cliLine('b', 'SIGSEGV', 'FATAL ERROR: heap limit'), ['b'], [], false],
    ['child with stderr', execError('a', { stderr: "'boom'" }), ['a'], [], false],
    ['child with stdout', execError('a', { stdout: '<Buffer 6f 6b>' }), ['a'], [], false],
    ['SIGTERM is a stop, not a crash', execError('a', { signal: 'SIGTERM' }), ['a'], [], false],
    ['SIGKILL is a stop, not a crash', cliLine('b', 'SIGKILL'), ['b'], [], false],
    ['an ordinary failure', ORDINARY, ['reads with readPublished'], [], false],
    ['beside an ordinary failure', `${ORDINARY}\n${cliLine('b', 'SIGSEGV')}`, ['reads with readPublished', 'b'],
      [{ test: 'b', signal: 'SIGSEGV', pid: null }], false],
    ['a crash under another test name', execError('a'), ['other'], [], false],
    ['printed in the stream and the summary', `${execError('a')}\n✖ failing tests:\n\n${execError('a')}`, ['a'],
      [{ test: 'a', signal: 'SIGSEGV', pid: 22 }], true],
    ['two children of one test', `${execError('a')}${execError('a', { pid: 23 }).split('\n').slice(2).join('\n')}`, ['a'],
      [{ test: 'a', signal: 'SIGSEGV', pid: 22 }, { test: 'a', signal: 'SIGSEGV', pid: 23 }], true],
    ['no failing names', execError('a'), [], [], false],
  ];
  for (const [name, output, names, crashes, every] of cases) {
    assert.deepEqual(NativeCrash.find(output, names), { crashes, every }, name);
  }
});

test('the crash report is the newest node report written since the run started', (t) => {
  const dir = scratch('native-crash');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, ageMs) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'ProblemType: Crash\n');
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };
  const since = Date.now() - 60000;
  write('_home_u_.nvm_versions_node_v26.12.0_bin_node.1000.crash', 3600000);
  write('_usr_bin_python3.14.1000.crash', 1000);
  assert.equal(NativeCrash.crashFile(dir, since), null, 'an older node report and another binary are not this crash');
  write('_usr_bin_node.1000.crash', 30000);
  const newest = write('_home_u_.nvm_versions_node_v26.12.0_bin_node.1000.crash', 1000);
  assert.equal(NativeCrash.crashFile(dir, since), newest);
  assert.equal(NativeCrash.crashFile(path.join(dir, 'missing'), since), null);
  assert.equal(NativeCrash.crashFile(null, since), null);
});

test('recent counts native crashes from tests gate events in the last seven days', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const crash = { test: 'a', signal: 'SIGSEGV', pid: 1 };
  const events = [
    { at: '2026-10-12T12:00:00Z', cmd: 'check tests', task: 'T1', detail: { native_crash: [crash] } },
    { at: '2026-10-14T12:00:00Z', cmd: 'check tests', task: 'T2', detail: { native_crash: [crash, crash] } },
    { at: '2026-10-19T12:00:00Z', cmd: 'check tests', task: 'T3', detail: { native_crash: [crash] } },
    { at: '2026-10-19T13:00:00Z', cmd: 'check clean', task: 'T4', detail: { native_crash: [crash] } },
    { at: '2026-10-19T14:00:00Z', cmd: 'check tests', task: 'T5', detail: { ok: true } },
  ];
  assert.deepEqual(NativeCrash.recent(events, now), { days: 7, count: 3, last: { at: '2026-10-19T12:00:00Z', task: 'T3' } });
  assert.deepEqual(NativeCrash.recent([], now), { days: 7, count: 0, last: null });
});
