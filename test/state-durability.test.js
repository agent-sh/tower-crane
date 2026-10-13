'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');

function setup(t) {
  return cachedFixture(t, 'durability', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Durable', '--acceptance', 'survives a crash']);
  });
}

const logged = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const noted = (h, text) => ({
  task: h.readState('tasks.json').tasks[0].notes.some((n) => n.text === text),
  event: logged(h).some((e) => e.cmd === 'task note' && e.detail.text === text),
});
const leftovers = (h) => fs.readdirSync(h.state).filter((name) => /^(tasks|project|decisions)\.json\./.test(name));

function crash(h, point, text) {
  const r = h.run(['task', 'note', 'T1', text], { hooks: { HOOK_DIE_COMMIT: point } });
  assert.notEqual(r.code, 0, `the writer was killed at ${point}`);
  assert.ok(fs.existsSync(path.join(h.state, 'lock')), 'the killed writer left its lock');
}

function assertConsistent(h) {
  const v = h.run(['validate', '--json']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.deepEqual(JSON.parse(v.stdout).issues, []);
  assert.deepEqual(leftovers(h), []);
}

test('a writer killed between its two commit writes leaves a change the next writer completes, with its event', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
});

test('a writer killed before it logs its events leaves no change, and validate recovers before it reads', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'crashed note');
  // validate takes the lock, so it clears the dead writer's staged copy first.
  assertConsistent(h);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: false, event: false });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
});

test('an event-only write syncs the log; a task change syncs its copy and the log before the rename, then the directory', (t) => {
  const h = setup(t);
  const trace = path.join(h.base, 'sync-trace');
  const steps = (args) => {
    fs.rmSync(trace, { force: true });
    h.ok(args, { hooks: { HOOK_SYNC_TRACE: trace } });
    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
    // Windows cannot sync a directory.
    return process.platform === 'win32' ? lines.filter((l) => l !== 'fsync .') : lines;
  };
  assert.deepEqual(steps(['msg', '--to', 'worker-a', '--task', 'T1', 'hello']), ['append events.jsonl', 'fsync events.jsonl']);
  const dirSync = process.platform === 'win32' ? [] : ['fsync .'];
  assert.deepEqual(steps(['task', 'note', 'T1', 'synced']), [
    'fsync tasks.json.staged', ...dirSync, 'append events.jsonl', 'fsync events.jsonl', 'rename tasks.json', ...dirSync,
  ]);
});

test('validate reports a task change whose event the log lost', (t) => {
  const h = setup(t);
  h.ok(['task', 'note', 'T1', 'kept in tasks.json']);
  const file = path.join(h.state, 'events.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(JSON.parse(lines.at(-1)).detail.text, 'kept in tasks.json');
  fs.writeFileSync(file, lines.slice(0, -1).map((l) => `${l}\n`).join(''));
  const v = h.run(['validate', '--json']);
  assert.equal(v.code, 1, v.stdout + v.stderr);
  const drift = JSON.parse(v.stdout).issues.filter((i) => i.kind === 'log-drift');
  assert.equal(drift.length, 1);
  assert.match(drift[0].message, /missing from events\.jsonl; events\.jsonl lost a write/);
});
