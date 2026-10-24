'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const Refresh = require('../lib/tests-map-refresh');

const A = 'test/a.test.js';
const B = 'test/b.test.js';
const old = { 'shared.js': [A, B], 'missing.js': [B], 'manual.js': [A], '**/*.md': [] };

function fixture(t) {
  return cachedFixture(t, 'map-refresh', (h) => {
    h.init(['--repo', 'acme/app', '--tests-map', JSON.stringify(old), '--tests-paths', '["test/**"]']);
    fs.mkdirSync(path.join(h.repo, 'test'));
    for (const file of [A, B, 'test/unselected.test.js', 'test/helpers.js']) {
      fs.writeFileSync(path.join(h.repo, file), 'console.log("suite");\n');
    }
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'test files']);
    return { sha: h.git(['rev-parse', 'HEAD']) };
  });
}

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
      const fullRun = { head_sha: h.sha, created_at: new Date().toISOString() };
      const runs = [
        { id: 50, event: 'schedule', status: 'completed', head_branch: 'main', conclusion },
        { id: 60, event: 'workflow_dispatch', status: 'completed', head_branch: 'main', conclusion: 'failure' },
        { id: 70, event: 'schedule', status: 'in_progress', head_branch: 'main' },
        { id: 80, event: 'push', status: 'completed', head_branch: 'main' },
        { id: 90, event: 'workflow_dispatch', status: 'completed', head_branch: 'topic' },
        { id: 40, event: 'schedule', status: 'completed', head_branch: 'main', conclusion: 'success' },
      ].map((run) => ({ ...fullRun, ...run }));
      const calls = [];
      const exec = async (cmd, args) => {
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
      const event = h.logs().findLast((e) => e.cmd === 'tests map refresh');
      assert.equal(event.detail.run, 50);
      assert.equal(event.detail.conclusion, conclusion);
      assert.equal(await Refresh.automatic(ctx, require('../lib/state').loadState(h.state)), false);
      assert.equal(calls.filter((args) => args[0] === 'run').length, 1);
    });
  }
});
