'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, useFixtureUserFile } = require('./helpers');
const Refresh = require('../lib/tests-map-refresh');

const A = 'test/a.test.js';
const B = 'test/b.test.js';
const old = { 'shared.js': [A, B], 'missing.js': [B], 'manual.js': [A], '**/*.md': [] };

function fixture(t) {
  const h = cachedFixture(t, 'map-refresh', (h) => {
    h.init(['--repo', 'acme/app', '--tests-paths', '["test/**"]']);
    h.ok(['project', 'set', '--tests-map', JSON.stringify(old)]);
    fs.mkdirSync(path.join(h.repo, 'test'));
    for (const file of [A, B, 'test/unselected.test.js', 'test/helpers.js']) {
      fs.writeFileSync(path.join(h.repo, file), 'console.log("suite");\n');
    }
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'test files']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
  useFixtureUserFile(t, h);
  return h;
}

test('coverage replacement preserves missing suites and unmeasured declarations', () => {
  for (const [name, tests, measured, expected] of [
    ['missing shard', [A], { 'shared.js': [A] }, { ...old, 'shared.js': [A, B] }],
    ['complete coverage replaces old suites', [A, B], { 'shared.js': [A] }, { ...old, 'shared.js': [A] }],
    ['empty measured source', [A], { 'shared.js': [] }, { ...old, 'shared.js': [B] }],
    ['absent sources', [A, B], {}, old],
    ['new source', [A], { 'new.js': [A] }, { ...old, 'new.js': [A] }],
  ]) {
    assert.deepEqual(Refresh.mergeMap(old, { tests, map: measured }, new Set([A, B])), expected, name);
  }
});

test('coverage preservation prunes removed and renamed suites in every source class', () => {
  const renamed = 'test/renamed.test.js';
  for (const [name, previous, tests, map, tracked, expected] of [
    ['deleted suite on measured and absent sources', old, [A], { 'shared.js': [A] }, [A],
      { 'shared.js': [A], 'manual.js': [A], '**/*.md': [] }],
    ['renamed suite', old, [A, renamed], { 'shared.js': [renamed] }, [A, renamed],
      { 'shared.js': [renamed], 'manual.js': [A], '**/*.md': [] }],
    ['absent coverage keeps only existing suites', old, [], {}, [B],
      { 'shared.js': [B], 'missing.js': [B], '**/*.md': [] }],
    ['declared glob and unmeasured source', { '*.md': [A, B], 'manual.sh': [B] }, [], {}, [A],
      { '*.md': [A] }],
    ['explicit empty declarations survive', { 'manual.js': [], '*.md': [], 'gone.js': [B] }, [], {}, [],
      { 'manual.js': [], '*.md': [] }],
    ['missing shard still tracked', old, [A], { 'shared.js': [A] }, [A, B], old],
  ]) {
    assert.deepEqual(Refresh.mergeMap(previous, { tests, map }, new Set(tracked)), expected, name);
  }
});

test('refresh inventories the artifact commit for deleted, renamed and missing-shard suites', async (t) => {
  for (const mode of ['deleted', 'renamed', 'historical', 'unavailable']) {
    await t.test(mode, (t) => {
      const h = fixture(t);
      const renamed = 'test/renamed.test.js';
      h.git(mode === 'renamed' ? ['mv', B, renamed] : ['rm', B]);
      h.git(['commit', '-qm', 'change test inventory']);
      const sha = mode === 'historical' ? h.sha : mode === 'unavailable' ? 'f'.repeat(40) : h.git(['rev-parse', 'HEAD']);
      const tests = mode === 'renamed' ? [A, renamed] : [A];
      const file = path.join(h.base, 'map.json');
      fs.writeFileSync(file, JSON.stringify({ sha, tests, map: { 'shared.js': tests } }));
      if (mode === 'unavailable') {
        const before = h.readState('project.json');
        const result = h.run(['tests', 'map', 'refresh', '--file', file]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /cannot list tracked files/);
        assert.deepEqual(h.readState('project.json'), before);
      } else {
        h.ok(['tests', 'map', 'refresh', '--file', file]);
        const map = h.readState('project.json').tests.map;
        assert.deepEqual(map['shared.js'], mode === 'historical' ? [A, B] : tests);
        assert.deepEqual(map['manual.js'], [A]);
        assert.equal(Object.hasOwn(map, 'missing.js'), mode === 'historical');
      }
    });
  }
});

test('status and inbox use the newest local or origin base, including remote-only refs', async (t) => {
  for (const mode of ['newer origin', 'origin only', 'newer local', 'local only', 'origin prefix', 'divergent', 'missing refs']) {
    await t.test(mode, async (t) => {
      const h = fixture(t);
      const fresh = 'test/fresh.test.js';
      h.git(['switch', '-qc', 'fresh-base']);
      fs.writeFileSync(path.join(h.repo, fresh), 'console.log("fresh suite");\n');
      h.git(['add', '.']);
      h.git(['commit', '-qm', 'new base test']);
      const sha = h.git(['rev-parse', 'HEAD']);
      let remote = mode === 'newer local' ? h.sha : sha;
      if (mode === 'divergent') {
        h.git(['switch', '-qc', 'other-base', h.sha]);
        fs.writeFileSync(path.join(h.repo, 'test/origin.test.js'), 'console.log("origin suite");\n');
        h.git(['add', '.']);
        h.git(['commit', '-qm', 'divergent base test']);
        remote = h.git(['rev-parse', 'HEAD']);
        h.git(['switch', 'fresh-base']);
      }
      if (['newer local', 'local only', 'divergent'].includes(mode)) h.git(['update-ref', 'refs/heads/main', sha]);
      if (mode !== 'local only' && mode !== 'missing refs') {
        h.git(['update-ref', 'refs/remotes/origin/main', remote]);
      }
      if (['origin only', 'origin prefix', 'missing refs'].includes(mode)) h.git(['branch', '-D', 'main']);
      if (mode === 'origin prefix') h.ok(['project', 'set', '--base', 'origin/main']);
      const expected = mode === 'missing refs' ? [] : [fresh, 'test/unselected.test.js'];
      assert.deepEqual(h.json(['status']).tests_unselected, expected);
      const ctx = { stateDir: h.state, cwd: h.repo, agent: 'orchestrator', agentExplicit: true, env: h.env };
      const inbox = await require('../lib/inbox').snapshot(ctx);
      const items = inbox.items.filter((entry) => entry.kind === 'tests_unselected');
      assert.equal(items.length, expected.length ? 1 : 0);
      if (expected.length) assert.deepEqual(items[0].files, expected);
    });
  }
});

test('refresh replaces measured coverage but keeps absent tests and manual sources', (t) => {
  const h = fixture(t);
  const file = path.join(h.base, 'map.json');
  fs.writeFileSync(file, JSON.stringify({ sha: h.sha, tests: [A], map: { 'shared.js': [], 'new.js': [A] } }));
  h.ok(['tests', 'map', 'refresh', '--file', file]);
  assert.deepEqual(h.readState('project.json').tests.map, {
    '**/*.md': [], 'manual.js': [A], 'missing.js': [B], 'new.js': [A], 'shared.js': [B],
  });
  fs.writeFileSync(file, JSON.stringify({ sha: h.sha, tests: [A, B], map: { 'shared.js': [A] } }));
  h.ok(['tests', 'map', 'refresh', '--file', file]);
  assert.deepEqual(h.readState('project.json').tests.map['shared.js'], [A]);
  assert.deepEqual(h.readState('project.json').tests.map['manual.js'], [A]);
});

test('status and one persistent inbox item name unselected tests, excluding helpers and crucial tests', async (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--tests-crucial', '["test/unselected.test.js"]']);
  assert.deepEqual(h.json(['status']).tests_unselected, []);
  h.ok(['project', 'set', '--tests-crucial', 'null']);
  const files = ['test/unselected.test.js'];
  assert.deepEqual(h.json(['status']).tests_unselected, files);
  assert.match(h.ok(['status']), /unselected tests: 1.*test\/unselected\.test\.js/);
  const ctx = { stateDir: h.state, cwd: h.repo, agent: 'orchestrator', agentExplicit: true, env: {} };
  for (let i = 0; i < 2; i++) {
    const inbox = await require('../lib/inbox').snapshot(ctx);
    const items = inbox.items.filter((entry) => entry.kind === 'tests_unselected');
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].files, files);
    assert.equal(items[0].count, 1);
  }
  h.ok(['project', 'set', '--tests-map', JSON.stringify({ ...old, 'unmeasurable.sh': files })]);
  assert.deepEqual(h.json(['status']).tests_unselected, []);
  const inbox = await require('../lib/inbox').snapshot(ctx);
  assert.equal(inbox.items.filter((entry) => entry.kind === 'tests_unselected').length, 0);
});

test('automatic refresh selects the newest completed full base run with an artifact regardless of conclusion', async (t) => {
  for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out']) {
    await t.test(conclusion, async (t) => {
      const h = fixture(t);
      const fullRun = { head_sha: h.sha };
      const runs = [
        { id: 50, event: 'schedule', status: 'completed', head_branch: 'main', conclusion },
        { id: 60, event: 'workflow_dispatch', status: 'completed', head_branch: 'main', conclusion: 'failure' },
        { id: 70, event: 'schedule', status: 'in_progress', head_branch: 'main' },
        { id: 80, event: 'push', status: 'completed', head_branch: 'main' },
        { id: 90, event: 'workflow_dispatch', status: 'completed', head_branch: 'topic' },
        { id: 40, event: 'schedule', status: 'completed', head_branch: 'main', conclusion: 'success' },
      ].map((run) => ({ ...fullRun, ...run, created_at: new Date(Date.now() - (100 - run.id) * 1000).toISOString() }));
      const calls = [];
      const exec = async (cmd, args, opts) => {
        if (cmd === 'git') return require('../lib/commands').spawnSync(cmd, args, { ...opts, env: h.env });
        calls.push(args);
        let stdout = '';
        if (args[0] === 'api' && args[1].includes('/actions/runs?')) stdout = JSON.stringify({ workflow_runs: runs });
        else if (args[0] === 'api' && args[1].includes('/artifacts')) {
          stdout = JSON.stringify({ artifacts: args[1].includes('/50/') || args[1].includes('/40/')
            ? [{ name: 'tests-coverage-map', expired: false }] : [] });
        } else if (args[0] === 'run' && args[1] === 'download') {
          assert.equal(args[2], '50');
          fs.writeFileSync(path.join(args[args.indexOf('-D') + 1], 'tests-coverage-map.json'),
            JSON.stringify({ sha: h.sha, tests: [A], map: { 'shared.js': [A] } }));
        } else assert.fail(`unexpected ${cmd} ${args.join(' ')}`);
        return { status: 0, stdout, stderr: '' };
      };
      const ctx = { stateDir: h.state, cwd: h.repo, agent: 'orchestrator', agentExplicit: true,
        env: { TOWER_CRANE_TMP: path.join(h.base, 'tmp') }, exec };
      const st = require('../lib/state').loadState(h.state);
      assert.equal(await Refresh.automatic(ctx, st), true);
      assert.deepEqual(h.readState('project.json').tests.map['shared.js'], [A, B]);
      assert.deepEqual(h.readState('project.json').tests.map['manual.js'], [A]);
      const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        .findLast((e) => e.cmd === 'tests map refresh');
      assert.equal(event.detail.run, 50);
      assert.equal(event.detail.conclusion, conclusion);
      assert.equal(await Refresh.automatic(ctx, require('../lib/state').loadState(h.state)), false);
      assert.equal(calls.filter((args) => args[0] === 'run').length, 1);
    });
  }
});
