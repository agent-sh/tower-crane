'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

test('browser needs round-trip through add, update and plan import, and invalidate old evidence', (t) => {
  const h = makeRepo(t);
  h.init();
  const task = h.json(['task', 'add', '--title', 'UI', '--acceptance', 'visible', '--needs', '["browser","browser"]']);
  assert.deepEqual(task.needs, ['browser']);
  assert.match(h.ok(['task', 'show', task.id]), /needs: browser/);
  const updated = h.json(['task', 'update', task.id, '--needs', '[]']);
  assert.deepEqual(updated.needs, []);
  assert.equal(updated.revision, 2);
  assert.equal(h.json(['task', 'update', task.id, '--needs', '[]']).revision, 2);
  h.ok(['plan', 'import', '-'], { input: JSON.stringify([{ title: 'design', acceptance: ['visible'], needs: ['browser'] }]) });
  assert.deepEqual(h.json(['task', 'show', 'T2']).needs, ['browser']);
  for (const needs of ['null', '"browser"', '["unknown"]', '[1]']) {
    const r = h.run(['task', 'update', task.id, '--needs', needs]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /needs.*browser/);
  }
});

test('browser kit is an owner-controlled user setting, defaults to playwright and survives ladder save-user', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.deepEqual(h.json(['browser-kit', 'show']).servers, ['playwright']);
  const before = h.run(['browser-kit', 'set', '--servers', '["visual","playwright"]', '--agent', 'worker']);
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /only the owner/);
  const escalated = h.run(['browser-kit', 'set', '--servers', '["visual"]', '--agent', 'orchestrator']);
  assert.equal(escalated.code, 1, escalated.stderr);
  assert.match(escalated.stderr, /browser_kit is owner-required; opened D1 for the owner/);
  assert.equal(fs.existsSync(h.userConfig), false);
  h.ok(['browser-kit', 'set', '--servers', '["visual","playwright","visual"]']);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.userConfig, 'utf8')).browser_kit, ['visual', 'playwright']);
  h.ok(['ladder', 'save-user']);
  assert.deepEqual(h.json(['browser-kit', 'show']).servers, ['visual', 'playwright']);
  assert.equal(h.readState('project.json').browser_kit, undefined, 'the kit follows the user instead of the project');
  h.ok(['browser-kit', 'set', '--servers', '[]']);
  assert.deepEqual(h.json(['browser-kit', 'show']).servers, []);
  for (const servers of ['null', '[1]', '[""]']) assert.notEqual(h.run(['browser-kit', 'set', '--servers', servers]).code, 0);
});

test('accepted tasks require rework before their browser capability can change', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'UI notes', '--kind', 'docs', '--acceptance', 'readable']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.git(['rev-parse', 'HEAD'])]);
  h.ok(['accept', 'T1', '--waive', 'review', '--reason', 'fixture']);
  const result = h.run(['task', 'update', 'T1', '--needs', '["browser"]']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /accepted.*needs.*rework/);
  const unchanged = h.json(['task', 'show', 'T1']);
  assert.equal(unchanged.status, 'accepted');
  assert.deepEqual(unchanged.needs, []);
});

test('a brokered worker can read the browser kit but cannot change the user setting', async (t) => {
  const h = makeRepo(t);
  h.init();
  const B = require('../lib/broker');
  const binding = path.join(h.base, B.FILE);
  const broker = await B.start({ state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: binding });
  try {
    const env = { TOWER_CRANE_BROKER: binding, TOWER_CRANE_AGENT: 'worker-T1-1' };
    const shown = await h.runAsync(['browser-kit', 'show', '--json'], { env });
    assert.equal(shown.code, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).servers, ['playwright']);
    const changed = await h.runAsync(['browser-kit', 'set', '--servers', '["other"]'], { env });
    assert.notEqual(changed.code, 0);
    assert.match(changed.stderr, /not browser-kit set/);
    const asOwner = await h.runAsync(['browser-kit', 'set', '--servers', '["other"]', '--agent', 'owner'], { env });
    assert.notEqual(asOwner.code, 0);
    assert.match(asOwner.stderr, /TOWER_CRANE_AGENT names worker-T1-1/);
    assert.equal(fs.existsSync(h.userConfig), false);
  } finally {
    await broker.close();
  }
});
