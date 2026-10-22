'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { makeTaskRepo, pinRung } = require('./helpers');
const { configureClaudeCache } = require('./claude-probe-cache');
const { HARNESS_TMPDIR_MAX, harnessFits } = require('../lib/gate-tmp');

test('live Claude setup callers pass their test context and fixture to cache allocation', () => {
  // Evaluate only setup expressions, without loading the host-only suites.
  const live = fs.readFileSync(path.join(__dirname, 'live-sandbox.test.js'), 'utf8');
  const git = fs.readFileSync(path.join(__dirname, 'live-git-sandbox.test.js'), 'utf8');
  const helper = live.match(/function login\(t, h\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'the live login helper is present');
  const calls = [...live.matchAll(/const h = (login\([^\n;]+\));/g)];
  assert.equal(calls.length, [...live.matchAll(/\blogin\(/g)].length - 1, 'every login caller has a table row');
  const rows = [
    ...calls.map((match) => [`live-sandbox.test.js:${live.slice(0, match.index).split('\n').length}`, match[1]]),
    ['short cache wrapper', live.match(/return (configureClaudeCache\(t, \{\}\));/)?.[1]],
    ['live Git setup', git.match(/^\s*(configureClaudeCache\(t, f\.h\.env\));$/m)?.[1]],
  ];
  const cache = path.join(path.parse(__dirname).root, 'live-cache');
  for (const [label, expression] of rows) {
    assert.ok(expression, label);
    const context = {};
    const fixture = { env: {} };
    let allocated = 0;
    const seen = vm.runInNewContext(`${helper}\n${expression}`, {
      t: context, claudeConfig: 'fixture-login', f: { h: fixture },
      makeRepo: (owner) => { assert.equal(owner, context, label); return fixture; },
      configureClaudeCache: (owner, env) => configureClaudeCache(owner, env, (cleanupOwner) => {
        assert.equal(cleanupOwner, context, `${label}: cache cleanup belongs to this test`);
        allocated++;
        return cache;
      }),
    });
    assert.equal(allocated, 1, `${label}: one cache allocation`);
    if (expression.startsWith('login(')) {
      assert.equal(seen, fixture, label);
      assert.equal(fixture.env.CLAUDE_CONFIG_DIR, 'fixture-login', label);
    } else assert.equal(seen, cache, label);
    if (label !== 'short cache wrapper') assert.equal(fixture.env.XDG_CACHE_HOME, cache, label);
  }
});

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
