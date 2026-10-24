'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../lib/intervals');

// The CLI wiring is covered where a fixture sets TOWER_CRANE_INTERVALS: lock
// waits in test/lock.test.js and test/supervision.test.js, startup windows in
// test/supervision.test.js, governor waits in test/governor.test.js.
test('TOWER_CRANE_INTERVALS replaces named intervals and refuses anything else', () => {
  const env = (value) => (value === undefined ? {} : { TOWER_CRANE_INTERVALS: value });
  for (const [value, name, expected] of [
    [undefined, 'lock_wait', 60000],
    ['', 'startup', 10000],
    ['{}', 'lock_refresh', 10000],
    ['{"lock_wait":1500}', 'lock_wait', 1500],
    ['{"lock_wait":1500}', 'startup', 10000],
    ['{"startup":0.5}', 'startup', 0.5],
    ['{"governor_lock_wait":300,"governor_bind_wait":600}', 'governor_bind_wait', 600],
  ]) {
    assert.equal(I.ms(name, env(value)), expected, `${value} ${name}`);
  }
  for (const [value, message] of [
    ['not json', /is not JSON/],
    ['[1000]', /must be a JSON object/],
    ['null', /must be a JSON object/],
    ['{"lock_wiat":1000}', /unknown interval: lock_wiat; known: lock_wait, startup, lock_refresh/],
    ['{"lock_wait":0}', /lock_wait must be a positive number/],
    ['{"lock_wait":-5}', /lock_wait must be a positive number/],
    ['{"lock_wait":"1000"}', /lock_wait must be a positive number/],
  ]) {
    assert.throws(() => I.ms('lock_wait', env(value)), message, value);
  }
  assert.throws(() => I.ms('lock_wiat', {}), /unknown interval: lock_wiat/);
  assert.deepEqual(Object.keys(I.DEFAULTS), ['lock_wait', 'startup', 'lock_refresh', 'governor_lock_wait', 'governor_bind_wait', 'test_grant']);
});

test('an interval set in this process applies to a module loaded before it', (t) => {
  const S = require('../lib/state');
  const saved = process.env.TOWER_CRANE_INTERVALS;
  t.after(() => {
    if (saved === undefined) delete process.env.TOWER_CRANE_INTERVALS;
    else process.env.TOWER_CRANE_INTERVALS = saved;
  });
  assert.equal(S.lockWaitMs(), S.LOCK_WAIT_MS);
  process.env.TOWER_CRANE_INTERVALS = JSON.stringify({ lock_wait: 250 });
  assert.equal(S.lockWaitMs(), 250);
  assert.equal(S.LOCK_WAIT_MS, 60000, 'the production constant stays');
});
