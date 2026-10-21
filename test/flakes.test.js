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

// Each row's events precede T5's flaky pass of test/a.test.js at NOW; `opens` is how many flake tasks it opens.
test('a flaky pass opens a flake task only for a test another task saw flaky since its last flake task', (t) => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-flakes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'briefs'));
  for (const [name, events, opens] of [
    ['another task flaky within 7 days', [flaky('T1', at(60))], 1],
    ['only the same task flaky before', [flaky('T5', at(60))], 0],
    ['another task flaky 8 days ago', [flaky('T1', at(8 * 24 * 60))], 0],
    ['another task flaky on another test', [flaky('T1', at(60), 'test/b.test.js')], 0],
    ['the flake task opened in the millisecond of its record', [flaky('T1', at(60)), flaky('T2', at(1)), opened(at(1))], 0],
    ['the flake task opened later than its record', [flaky('T1', at(60)), flaky('T2', at(2)), opened(at(1))], 0],
    ['another task flaky after the last flake task', [flaky('T1', at(60)), flaky('T2', at(2)), opened(at(2)), flaky('T3', at(1))], 1],
  ]) {
    const st = { dir, tasks: { next: 10, tasks: [] }, events: [...events] };
    const emit = (task, detail, cmd) => st.events.push({ at: new Date(NOW).toISOString(), task, cmd, detail });
    const result = Flakes.open(st, emit, { id: 'T5' }, { type: 'tests', sha: 'T5sha', at: new Date(NOW).toISOString(),
      flaky: [{ test: 'test/a.test.js' }] }, NOW);
    assert.equal(result.length, opens, name);
    assert.equal(st.events.filter((e) => e.cmd === 'task add' && e.task !== 'T9').length, opens, name);
  }
});
