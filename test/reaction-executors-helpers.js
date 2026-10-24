'use strict';

// Shared by the reaction-executors*.test.js files: four held gates that fill every executor.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { waitOnRepo } = require('./signals');
const S = require('../lib/state');

const leased = (h) => h.json(['status']).gate_executors.in_use.map((u) => u.task).sort();

async function busyExecutors(h, prepare = () => {}) {
  const started = path.join(h.base, 'held-gates');
  const release = path.join(h.base, 'release-gates');
  const suite = path.join(h.base, 'tools', 'held-gate.js');
  fs.mkdirSync(started);
  fs.writeFileSync(release, '');
  fs.writeFileSync(suite, `
const fs = require('node:fs'), path = require('node:path');
if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
fs.writeFileSync(path.join(${JSON.stringify(started)}, String(process.pid)), '');
const until = Date.now() + 60000; // wait-allow: the release file ends held gates; this bounds a failed test
const poll = () => {
  if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
  if (Date.now() >= until) process.exit(1);
  setTimeout(poll, 25); // wait-allow: probe cadence for the release file
};
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '4', '--agent', 'orchestrator']);
  for (const id of ['T2', 'T3', 'T4']) {
    if (h.readState('tasks.json').tasks.some((task) => task.id === id)) continue;
    h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
    h.ok(['task', 'update', id, '--status', 'cancelled']);
  }
  for (const id of ['T5', 'T6', 'T7', 'T8']) h.ok(['task', 'add', '--title', id, '--acceptance', 'works']);
  prepare();
  // Start only the four held gates; prepared reactions get their PRs back
  // once every executor is occupied.
  const saved = new Map(h.readState('tasks.json').tasks.filter((task) => task.pr).map((task) => [task.id, task.pr]));
  const setPRs = (restore) => S.withLock(h.state, () => {
    const tasks = h.readState('tasks.json');
    for (const task of tasks.tasks) if (saved.has(task.id)) task.pr = restore ? saved.get(task.id) : null;
    h.writeState('tasks.json', tasks);
  });
  if (saved.size) setPRs(false);
  fs.rmSync(release);
  const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  for (const id of ['T5', 'T6', 'T7', 'T8']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  h.ok(['project', 'set', '--paused', 'prepare busy executors']);
  const hosts = Array.from({ length: 4 }, () => h.runAsync(['wait', '--after', String(offset),
    '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']));
  const finish = async () => {
    fs.writeFileSync(release, '');
    await Promise.all(hosts);
  };
  try {
    await waitOnRepo(h, () => fs.readdirSync(started).length === 4, 'all four fake gates start');
    assert.deepEqual(leased(h), ['T5', 'T6', 'T7', 'T8']);
    if (saved.size) setPRs(true);
  } catch (error) {
    await finish();
    throw error;
  }
  return finish;
}

module.exports = { leased, busyExecutors };
