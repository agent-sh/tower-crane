'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Flakes = require('../lib/flakes');
const { TMP_ROOT } = require('./helpers');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const at = (minutes) => new Date(NOW - minutes * 60 * 1000).toISOString();
const flaky = (task, when, test = 'test/a.test.js') => ({ at: when, task, cmd: 'check tests',
  detail: { type: 'tests', sha: `${task}sha`, flaky: [{ test }] } });
const opened = (when, test = 'test/a.test.js') => ({ at: when, task: 'T9', cmd: 'task add', detail: { flake: test } });
const closed = (when) => ({ at: when, task: 'T9', cmd: 'accept', detail: {} });

// Each row's events precede T5's flaky pass of test/a.test.js at NOW; `opens` is how many flake tasks it
// opens, and `fix` is the status of T9, the flake task the row's `task add` opened (none: no such record).
test('a flaky pass opens a flake task only for a test another task saw flaky since its last flake task closed', (t) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-flakes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'briefs'));
  for (const [name, events, opens, fix] of [
    ['another task flaky within 7 days', [flaky('T1', at(60))], 1],
    ['only the same task flaky before', [flaky('T5', at(60))], 0],
    ['another task flaky 8 days ago', [flaky('T1', at(8 * 24 * 60))], 0],
    ['another task flaky on another test', [flaky('T1', at(60), 'test/b.test.js')], 0],
    ['the flake task opened in the millisecond of its record', [flaky('T1', at(60)), flaky('T2', at(1)), opened(at(1))], 0],
    ['the flake task opened later than its record', [flaky('T1', at(60)), flaky('T2', at(2)), opened(at(1))], 0],
    ['another task flaky after the last flake task', [flaky('T1', at(60)), flaky('T2', at(2)), opened(at(2)), flaky('T3', at(1))], 1],
    ...['todo', 'in_progress', 'submitted', 'rework'].map((status) => [`another task flaky while the flake task is ${status}`,
      [flaky('T1', at(60)), flaky('T2', at(3)), opened(at(3)), flaky('T3', at(1))], 0, status]),
    ['another task flaky after the flake task is accepted', [flaky('T1', at(60)), flaky('T2', at(3)), opened(at(3)), closed(at(2)),
      flaky('T3', at(1))], 1, 'accepted'],
    ['another task flaky after the flake task is cancelled', [flaky('T1', at(60)), flaky('T2', at(3)), opened(at(3)), closed(at(2)),
      flaky('T3', at(1))], 1, 'cancelled'],
    ['another task flaky only while the flake task was open', [flaky('T1', at(60)), flaky('T2', at(4)), opened(at(4)),
      flaky('T3', at(3)), closed(at(2))], 0, 'accepted'],
  ]) {
    const st = { dir, tasks: { next: 10, tasks: fix ? [{ id: 'T9', status: fix }] : [] }, events: [...events] };
    const emit = (task, detail, cmd) => st.events.push({ at: new Date(NOW).toISOString(), task, cmd, detail });
    const result = Flakes.open(st, emit, { id: 'T5' }, { type: 'tests', sha: 'T5sha', at: new Date(NOW).toISOString(),
      flaky: [{ test: 'test/a.test.js' }] }, NOW);
    assert.equal(result.length, opens, name);
    assert.equal(st.events.filter((e) => e.cmd === 'task add' && e.task !== 'T9').length, opens, name);
  }
});

// The reviewer's case: four tasks flaky on one test in turn open one flake task, and the next only
// once that task is accepted and two more tasks flake.
test('one test flaky in task after task opens one flake task until it closes', (t) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-flakes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'briefs'));
  const st = { dir, tasks: { next: 10, tasks: [] }, events: [] };
  const emit = (task, detail, cmd) => st.events.push({ at: new Date(NOW).toISOString(), task, cmd, detail });
  const pass = (id) => {
    const entry = { type: 'tests', sha: `${id}sha`, at: new Date(NOW).toISOString(), flaky: [{ test: 'test/a.test.js > x' }] };
    emit(id, entry, 'check tests');
    return Flakes.open(st, emit, { id }, entry, NOW).map((o) => o.id);
  };
  assert.deepEqual(['T1', 'T2', 'T3', 'T4'].map(pass), [[], ['T10'], [], []]);
  assert.deepEqual(st.tasks.tasks.map((x) => `${x.id} ${x.title}`), ['T10 Fix flaky test test/a.test.js > x']);
  st.tasks.tasks[0].status = 'accepted';
  emit('T10', {}, 'accept');
  assert.deepEqual(['T6', 'T7'].map(pass), [[], ['T11']], 'after T10 is accepted, two new tasks open the next');
});
