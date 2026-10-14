'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cachedFixture } = require('./helpers');
const T = require('../lib/tasks');

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
const leftovers = (h) => fs.readdirSync(h.state).filter((name) => /^((tasks|project|decisions)\.json|commit)\./.test(name));

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

test('a commit whose log sync fails after its lines are written keeps its change for the next writer', (t) => {
  const h = setup(t);
  const r = h.run(['task', 'note', 'T1', 'unsynced note'], { hooks: { HOOK_FAIL_EVENT_SYNC: '1' } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /EIO/);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'unsynced note'), { task: true, event: true });
  assertConsistent(h);
});

test('recovery cuts a torn multi-event append off the log, including a final line missing only its newline', (t) => {
  const h = setup(t);
  const log = path.join(h.state, 'events.jsonl');
  // One descriptor for the stat and the torn append, so the file measured is the file written.
  const fd = fs.openSync(log, 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  const event = (cmd, detail) => ({ at: new Date().toISOString(), agent: 'owner', cmd, task: 'T1', detail, id: `E${crypto.randomUUID()}`, type: cmd, to: 'orchestrator' });
  const first = event('task note', { text: 'torn note' });
  const second = event('evidence', { type: 'note', ok: true });
  const doc = h.readState('tasks.json');
  doc.tasks[0].notes.push({ at: first.at, agent: 'owner', text: 'torn note' });
  doc.last_event = second.id;
  // A power cut kept the first line and all of the second but its newline.
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  fs.writeSync(fd, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  fs.closeSync(fd);
  h.ok(['task', 'note', 'T1', 'next note']);
  const ids = logged(h).map((e) => e.id);
  assert.ok(!ids.includes(first.id) && !ids.includes(second.id), 'the torn commit left no event');
  assert.deepEqual(noted(h, 'torn note'), { task: false, event: false });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
});

test('an add that failed after its commit point keeps its brief, and only then', (t) => {
  const h = setup(t);
  const doc = h.readState('tasks.json');
  doc.tasks.push({ ...doc.tasks[0], id: 'T2', title: 'Staged', notes: [] });
  const id = `E${crypto.randomUUID()}`;
  const staged = path.join(h.state, `tasks.json.${id}.commit`);
  fs.writeFileSync(staged, JSON.stringify(doc, null, 2) + '\n');
  const brief = path.join(h.state, 'briefs', 'T2.md');
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, '# Context\n');
  // The staged commit never logged its last event: the add did not commit.
  T.discardUncommittedBrief(h.state, 'T2');
  assert.throws(() => fs.readFileSync(brief), { code: 'ENOENT' }, 'a staged add whose last event is not logged loses its brief');
  fs.writeFileSync(brief, '# Context\n');
  // Its last event, an audit event after the add's own, is the log's last line.
  const log = path.join(h.state, 'events.jsonl');
  fs.appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), agent: 'owner', cmd: 'setting', task: 'T2', detail: {}, id, type: 'setting', to: 'orchestrator' })}\n`);
  T.discardUncommittedBrief(h.state, 'T2');
  assert.equal(fs.readFileSync(brief, 'utf8'), '# Context\n', 'a staged add whose last event is logged keeps its brief');
});

const foreign = (text) => ({ at: new Date().toISOString(), agent: 'owner', cmd: 'msg', task: 'T1', detail: { to: 'worker-a', text },
  id: `E${crypto.randomUUID()}`, type: 'worker-message', to: 'worker-a' });

test('recovery never cuts events another writer appended after a commit that died before its append', (t) => {
  const h = setup(t);
  // task update --tier logs a setting audit event and its own: two events.
  const r = h.run(['task', 'update', 'T1', '--tier', 'hard'], { hooks: { HOOK_DIE_COMMIT: 'staged' } });
  assert.notEqual(r.code, 0);
  // An older tool does not recover; it appends a message as it always did.
  const msg = foreign('from an older tool');
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(msg)}\n`);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.ok(logged(h).some((e) => e.id === msg.id), 'the older tool\'s message is still logged');
  assert.notEqual(h.readState('tasks.json').tasks[0].tier, 'hard');
  assertConsistent(h);
});

test('recovery never cuts a log that was replaced since the commit staged', (t) => {
  const h = setup(t);
  const r = h.run(['task', 'update', 'T1', '--tier', 'hard'], { hooks: { HOOK_DIE_COMMIT: 'staged' } });
  assert.notEqual(r.code, 0);
  const [manifest] = fs.readdirSync(h.state).filter((name) => /^commit\./.test(name));
  const { ids } = JSON.parse(fs.readFileSync(path.join(h.state, manifest), 'utf8'));
  // A restore copies a log in place: a new file whose line carries one of the commit's ids.
  const log = path.join(h.state, 'events.jsonl');
  const restored = { ...foreign('restored'), id: ids[0] };
  fs.writeFileSync(`${log}.restore`, `${fs.readFileSync(log, 'utf8')}${JSON.stringify(restored)}\n`);
  fs.renameSync(`${log}.restore`, log);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.ok(logged(h).some((e) => e.id === restored.id), 'the restored log keeps its lines');
});

test('a staged commit that cannot be removed stops the next writer before it appends', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'crashed note');
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['task', 'note', 'T1', 'blocked note'], { hooks: { HOOK_BUSY_STAGED: '1' } });
  assert.notEqual(r.code, 0, 'the writer stops');
  assert.match(r.stderr, /interrupted commit file/);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before, 'nothing was appended');
  h.ok(['task', 'note', 'T1', 'next note']);
  assertConsistent(h);
});

test('rolling a commit forward syncs the log before it renames the staged files', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  const trace = path.join(h.base, 'sync-trace');
  h.ok(['task', 'note', 'T1', 'next note'], { hooks: { HOOK_SYNC_TRACE: trace } });
  const steps = fs.readFileSync(trace, 'utf8').trim().split('\n');
  assert.deepEqual(steps.slice(0, 2), ['fsync events.jsonl', 'rename tasks.json']);
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
});

test('a torn last line cut before its own id is cut off, even when its detail names another event', (t) => {
  const h = setup(t);
  const log = path.join(h.state, 'events.jsonl');
  // One descriptor for the stat and the torn append, so the file measured is the file written.
  const fd = fs.openSync(log, 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  const event = (cmd, detail) => ({ at: new Date().toISOString(), agent: 'owner', cmd, task: 'T1', detail, id: `E${crypto.randomUUID()}`, type: cmd, to: 'orchestrator' });
  const first = event('task note', { text: 'torn note' });
  const second = event('evidence', { type: 'note', ok: true, ref: { id: `E${crypto.randomUUID()}` } });
  const doc = h.readState('tasks.json');
  doc.tasks[0].notes.push({ at: first.at, agent: 'owner', text: 'torn note' });
  doc.last_event = second.id;
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  const line = JSON.stringify(second);
  fs.writeSync(fd, `${JSON.stringify(first)}\n${line.slice(0, line.indexOf(',"id":"'))}`);
  fs.closeSync(fd);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.ok(!logged(h).some((e) => e.id === first.id), 'the torn commit left no event');
  assert.equal(fs.readFileSync(log, 'utf8').includes(second.detail.ref.id), false, 'the torn line is gone');
  assert.deepEqual(noted(h, 'torn note'), { task: false, event: false });
  assertConsistent(h);
});
