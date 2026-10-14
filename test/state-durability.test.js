'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cachedFixture } = require('./helpers');
const T = require('../lib/tasks');
const { waitOnRepo } = require('./signals');

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

// What a reader without the lock gets: the notes in tasks.json and the note
// events in the log, read as loadState reads them.
const S = require('../lib/state');
const unlocked = (h) => {
  const st = S.loadState(h.state, { fresh: true });
  return { notes: st.tasks.tasks[0].notes.map((n) => n.text), logged: st.events.filter((e) => e.cmd === 'task note').map((e) => e.detail.text) };
};

test('a reader without the lock sees a commit whose holder died after its commit point, before recovery renames it', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  assert.ok(fs.readdirSync(h.state).some((name) => /^tasks\.json\.E.*\.commit$/.test(name)), 'the staged tasks.json waits for the next lock holder');
  assert.deepEqual(unlocked(h), { notes: ['crashed note'], logged: ['crashed note'] });
  assert.deepEqual(h.json(['task', 'show', 'T1']).notes.map((n) => n.text), ['crashed note']);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(unlocked(h).notes, ['crashed note', 'next note']);
  assertConsistent(h);
});

test('a reader without the lock never sees staged files whose commit point was not reached', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'unlogged note');
  assert.ok(fs.readdirSync(h.state).some((name) => /^tasks\.json\.E.*\.commit$/.test(name)), 'the dead writer left its staged copy');
  assert.deepEqual(unlocked(h), { notes: [], logged: [] });
  // A torn append: the commit's first event is a whole line, its last lacks the newline.
  const log = path.join(h.state, 'events.jsonl');
  const fd = fs.openSync(log, 'a');
  const event = (text) => ({ at: new Date().toISOString(), agent: 'owner', cmd: 'task note', task: 'T1', detail: { text }, id: `E${crypto.randomUUID()}`, type: 'task note', to: 'orchestrator' });
  const first = event('torn first');
  const second = event('torn last');
  const doc = h.readState('tasks.json');
  doc.tasks[0].notes.push({ at: first.at, agent: 'owner', text: 'torn first' }, { at: second.at, agent: 'owner', text: 'torn last' });
  doc.last_event = second.id;
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), JSON.stringify(doc, null, 2) + '\n');
  fs.writeSync(fd, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  assert.deepEqual(unlocked(h).notes, [], 'a last line without its newline is no commit point');
  // An older tool appended after a commit that reached its log: recovery
  // deletes those staged files, so readers never show them either.
  fs.writeSync(fd, `\n${JSON.stringify(foreign('from an older tool'))}\n`);
  fs.closeSync(fd);
  assert.deepEqual(unlocked(h).notes, []);
});

// Runs read with fs.readFileSync wrapped by onRead(file, text, read), as a
// writer acting between a reader's own file reads would; `before` calls it
// ahead of the read, without the text.
function readingWith(t, onRead, { before = false } = {}) {
  const read = fs.readFileSync;
  const restore = () => { fs.readFileSync = read; };
  t.after(restore);
  fs.readFileSync = function observed(file, ...args) {
    if (before && typeof file === 'string') onRead(path.resolve(file), undefined, read);
    const text = read.call(this, file, ...args);
    if (!before && typeof file === 'string') onRead(path.resolve(file), text, read);
    return text;
  };
  return restore;
}

test('a reader whose staged files are renamed into place while it reads keeps that commit\'s state', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'renamed note');
  const staged = fs.readdirSync(h.state).filter((name) => /^(tasks|project|decisions)\.json\.E[0-9a-f-]{36}\.commit$/.test(name));
  assert.ok(staged.length);
  let renamed = false;
  // The renames land after the reader read the staged tasks.json, before it reads the rest.
  const restore = readingWith(t, (file) => {
    if (renamed || !staged.some((name) => file === path.join(h.state, name))) return;
    renamed = true;
    for (const name of staged) fs.renameSync(path.join(h.state, name), path.join(h.state, name.replace(/\.E[0-9a-f-]{36}\.commit$/, '')));
  });
  const read = unlocked(h);
  restore();
  assert.ok(renamed);
  assert.deepEqual(read, { notes: ['renamed note'], logged: ['renamed note'] });
});

// Puts a copy of events.jsonl in its place: the reader cannot tell it from a
// log that another commit changed while it read. A link keeps each replaced
// file, so the copy never reuses its inode; an open handle would instead stop
// the rename on Windows.
let replacedLogs = 0;
function replaceLog(h) {
  const log = path.join(h.state, 'events.jsonl');
  fs.linkSync(log, `${log}.kept-${++replacedLogs}`);
  fs.copyFileSync(log, `${log}.replaced`);
  fs.renameSync(`${log}.replaced`, log);
}

test('a reader that keeps losing to commits reads once under the lock', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'contended note');
  const file = path.join(h.state, 'project.json');
  const lock = path.join(h.state, 'lock');
  let replaced = 0;
  // The log changes during every read of project.json made without the lock.
  const restore = readingWith(t, (read, text, original) => {
    if (read !== file) return;
    let mine = false;
    try {
      mine = fs.readdirSync(lock).some((name) => JSON.parse(original(path.join(lock, name), 'utf8')).pid === process.pid);
    } catch {
      // No lock, or one being replaced: not this process's.
    }
    if (mine) return;
    replaceLog(h);
    replaced++;
  });
  const read = unlocked(h);
  restore();
  assert.ok(replaced >= 5, `the reader lost ${replaced} reads`);
  // The lock's holder had died; taking it renamed the logged commit into place.
  assert.deepEqual(read, { notes: ['contended note'], logged: ['contended note'] });
  assert.equal(fs.existsSync(lock), false, 'the reader released the lock');
  assertConsistent(h);
});

test('a reader without the lock sees each commit it has the events of while the writer still renames', async (t) => {
  const h = setup(t);
  const writer = h.runAsync(['task', 'note', 'T1', 'live note'], { hooks: { HOOK_COMMIT_DELAY_MS: '3000' } });
  let seen = null;
  let staged = false;
  await waitOnRepo(h, () => {
    const read = unlocked(h);
    if (!read.logged.includes('live note')) return false;
    // Still staged after the read: tasks.json was the old file throughout it.
    staged = fs.readdirSync(h.state).some((name) => /^tasks\.json\.E.*\.commit$/.test(name));
    seen = read;
    return true;
  }, 'the writer logs its note');
  assert.ok(staged, 'the reader read inside the window');
  assert.deepEqual(seen, { notes: ['live note'], logged: ['live note'] });
  assert.equal((await writer).code, 0);
  assertConsistent(h);
});

test('a reader that reads the other files after a commit\'s staged ones never takes a later commit\'s file', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'staged note');
  const [staged] = fs.readdirSync(h.state).filter((name) => /^tasks\.json\.E[0-9a-f-]{36}\.commit$/.test(name));
  const project = path.join(h.state, 'project.json');
  const later = { ...foreign('later'), cmd: 'project set', type: 'project set', to: 'orchestrator', task: null, detail: { goal: 'later goal' } };
  let stagedRead = false;
  let fired = false;
  // After the reader used the staged tasks.json, and before it reads
  // project.json beside it: the commit's rename, then a later commit that
  // replaces project.json and logs its event.
  const restore = readingWith(t, (file, text, original) => {
    if (file === path.join(h.state, staged)) stagedRead = true;
    if (!stagedRead || fired || file !== project) return;
    fired = true;
    fs.renameSync(path.join(h.state, staged), path.join(h.state, 'tasks.json'));
    const doc = JSON.parse(original(project, 'utf8'));
    fs.writeFileSync(`${project}.later`, JSON.stringify({ ...doc, goal: 'later goal' }, null, 2) + '\n');
    fs.renameSync(`${project}.later`, project);
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(later)}\n`);
  }, { before: true });
  const st = S.loadState(h.state, { fresh: true });
  restore();
  assert.ok(fired);
  assert.equal(st.project.goal, 'later goal');
  assert.ok(st.events.some((e) => e.id === later.id), 'the reader read again, with the event of the commit whose file it shows');
  assert.deepEqual(st.tasks.tasks[0].notes.map((n) => n.text), ['staged note']);
});

test('a reader that keeps losing waits only briefly for a held lock, then returns its last read', async (t) => {
  const h = setup(t);
  const signal = path.join(h.base, 'holding');
  const holder = h.runAsync(['task', 'note', 'T1', 'held note'], { hooks: { HOOK_PAUSE_LOCKED: signal } });
  let read;
  let replaced = 0;
  let waited;
  try {
    await waitOnRepo(h, () => fs.existsSync(signal), 'the holder takes the lock');
    const file = path.join(h.state, 'tasks.json');
    const restore = readingWith(t, (name) => {
      if (name !== file) return;
      replaceLog(h);
      replaced++;
    });
    const started = Date.now();
    read = unlocked(h);
    waited = Date.now() - started;
    restore();
  } finally {
    fs.writeFileSync(`${signal}.go`, '');
    assert.equal((await holder).code, 0);
  }
  assert.ok(replaced >= 5, `the reader lost ${replaced} reads`);
  assert.deepEqual(read, { notes: [], logged: [] });
  // 500 ms for the lock, and the reads around it; a writer would wait 60 s.
  assert.ok(waited < 10000, `the reader waited ${waited} ms`);
  assert.deepEqual(unlocked(h).notes, ['held note']);
});
