'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeTaskRepo, pinRung } = require('./helpers');
const { configureClaudeCache } = require('./claude-probe-cache');
const { HARNESS_TMPDIR_MAX, harnessFits } = require('../lib/gate-tmp');

test('live Claude cache setup gives private proxy sockets a bounded path for every fixture cache shape', {
  skip: process.platform === 'win32' && 'Claude proxy sockets are POSIX only',
}, (t) => {
  const h = makeTaskRepo(t, [{ args: ['--title', 'Proxy probe', '--acceptance', 'proxy socket fits'], brief: 'Proxy probe.\n' }]);
  pinRung(h, 'hard', { harness: 'claude', model: 'fixture-model' });
  const root = path.parse(h.base).root;
  const bounded = path.join(root, 'c'.repeat(44));
  for (const initial of [
    path.join(h.env.HOME, '.cache'),
    path.join(h.base, 'deep-cache-root-for-the-live-sandbox'),
    path.join(h.base, 'tower-crane', 'tasks', '0123456789ab', 'T1'),
    'relative-cache',
  ]) {
    h.env.XDG_CACHE_HOME = initial;
    let budget;
    configureClaudeCache(t, h.env, (_ctx, max) => { budget = max; return bounded; });
    const plan = h.json(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run']);
    assert.ok(harnessFits(plan.env.TMPDIR), `${initial}: ${plan.env.TMPDIR}`);
    assert.equal(budget, HARNESS_TMPDIR_MAX - 28);
    assert.deepEqual([plan.env.TMP, plan.env.TEMP], [plan.env.TMPDIR, plan.env.TMPDIR]);
    assert.ok(plan.env.TMPDIR.startsWith(path.join(bounded, 'tower-crane') + path.sep));
  }
});

test('live Claude cache setup reports an unavailable short cache instead of leaving a deep one', () => {
  const env = { XDG_CACHE_HOME: '/deep/cache' };
  assert.throws(() => configureClaudeCache({}, env, () => null), /short.*cache|cache.*socket/);
  assert.equal(env.XDG_CACHE_HOME, '/deep/cache');
});
