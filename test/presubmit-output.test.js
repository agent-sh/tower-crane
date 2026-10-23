'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFailureOutput, externalFailure } = require('../lib/presubmit');

test('failure output normalization ignores runner timing metadata across formats', () => {
  const variants = [
    ['node spec', '✖ same (0.52ms)\nℹ duration_ms 45.79', '✖ same (1.23ms)\nℹ duration_ms 89.21'],
    ['node TAP', 'not ok 1 - same\n  duration_ms: 0.52\n# duration_ms 45.79',
      'not ok 1 - same\n  duration_ms: 1.23\n# duration_ms 89.21'],
    ['pytest', 'FAILED same\n=== 1 failed, 2 passed in 0.12s ===',
      'FAILED same\n=== 1 failed, 2 passed in 0.25s ==='],
    ['Go', '--- FAIL: TestSame (0.01s)\nFAIL\texample/check\t0.012s',
      '--- FAIL: TestSame (0.03s)\nFAIL\texample/check\t0.035s'],
    ['Jest', 'FAIL same.test.js (0.12 s)\nTime: 0.12 s, estimated 2 s',
      'FAIL same.test.js (0.25 s)\nTime: 0.25 s, estimated 3 s'],
    ['Rust', 'test result: FAILED. 0 passed; 1 failed; finished in 0.12s',
      'test result: FAILED. 0 passed; 1 failed; finished in 0.25s'],
    ['Vitest', 'Start at 01:23:45\nDuration 250ms (transform 15ms, tests 50ms, prepare 10ms)',
      'Start at 01:24:12\nDuration 400ms (transform 25ms, tests 70ms, prepare 20ms)'],
    ['microseconds', '✖ same (500µs)', '✖ same (800us)'],
  ];
  for (const [name, before, after] of variants) {
    assert.equal(normalizeFailureOutput(before), normalizeFailureOutput(after), name);
  }
});

test('failure output normalization preserves meaningful changed diagnostics', () => {
  for (const [before, after] of [
    ['✖ first (0.52ms)', '✖ second (0.52ms)'],
    ['expected 1, got 2', 'expected 1, got 3'],
    ['Error: timeout after 10ms', 'Error: timeout after 20ms'],
    ['src/b.ts:1:14 - error TS2305', 'src/b.ts:2:14 - error TS2305'],
    ['# Error: operation took 10ms', '# Error: operation took 20ms'],
    ['=== 1 failed in 0.12s ===', '=== 2 failed in 0.12s ==='],
  ]) {
    assert.notEqual(normalizeFailureOutput(before), normalizeFailureOutput(after), `${before} / ${after}`);
  }
});

test('only hook executable launch failures are definite external failures', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    assert.equal(externalFailure(code), `environment: ${code}`, code);
  }
  for (const code of [null, undefined, 'ETIMEDOUT', 'WORKTREE_CHANGED', 'ERR_MODULE_NOT_FOUND']) {
    assert.equal(externalFailure(code), null, String(code));
  }
});
