'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { cachedFixture, BIN } = require('./helpers');
const T = require('../lib/tasks');
const S = require('../lib/state');
const Db = require('../lib/db');
const { runReleased } = require('./released-tool');
const { windowsFileIds } = require('./fixtures/windows-file-ids');

const RELEASED = 'v0.1.3';

// Simulated Windows file ids, past 2^53, in this process for the rest of the
// test and in each CLI the returned options run.
const WINDOWS_IDS = path.join(__dirname, 'fixtures', 'windows-file-ids.js');
function windowsIds(t) {
  t.after(windowsFileIds());
  return { pre: ['--require', WINDOWS_IDS], env: { TOWER_CRANE_TEST_WINDOWS_IDS: '1' } };
}

function migrated(t) {
  return cachedFixture(t, 'durability', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Durable', '--acceptance', 'survives a crash']);
  });
}

// The same state in the file layout of 0.1, as a 0.1 tool leaves it: the
// next command of this tool recovers any interrupted commit, then migrates it.
function setup(t) {
  const h = migrated(t);
  StateFiles.toFileLayout(h.state);
  return h;
}

const logged = (h) => h.events();
const noted = (h, text) => ({
  task: h.readState('tasks.json').tasks[0].notes.some((n) => n.text === text),
  event: logged(h).some((e) => e.cmd === 'task note' && e.detail.text === text),
});
const leftovers = (h) => fs.readdirSync(h.state).filter((name) => /^((tasks|project|decisions)\.json|commit|cut)\./.test(name));
const fileDoc = (h, name) => JSON.parse(fs.readFileSync(path.join(h.state, name), 'utf8'));

// A 0.1.3 writer killed inside its commit, on the file layout.
function crash(h, point, text, args = ['task', 'note', 'T1', text]) {
  const r = runReleased(h, RELEASED, args, { hooks: { HOOK_DIE_COMMIT: point } });
  assert.notEqual(r.code, 0, `the writer was killed at ${point}`);
  assert.ok(fs.existsSync(path.join(h.state, 'lock')), 'the killed writer left its lock');
}

function assertConsistent(h) {
  const v = h.run(['validate', '--json']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.deepEqual(JSON.parse(v.stdout).issues, []);
  assert.deepEqual(leftovers(h), []);
}

// A writer of this tool killed inside its commit, in the database.
function crashCommit(h, point, text) {
  const r = h.run(['task', 'note', 'T1', text], { hooks: { HOOK_DIE_COMMIT: point } });
  assert.notEqual(r.code, 0, `the writer was killed at ${point}`);
}

test('a writer killed right before its commit leaves neither its change nor its event, and the next writer goes on', (t) => {
  const h = migrated(t);
  crashCommit(h, 'staged', 'crashed note');
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: false, event: false });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
});

test('a writer killed right after its commit keeps its change and its event', (t) => {
  const h = migrated(t);
  crashCommit(h, 'landed', 'crashed note');
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
});

test('a commit that fails keeps neither its change nor its event', (t) => {
  const h = migrated(t);
  const before = logged(h).length;
  const r = h.run(['task', 'note', 'T1', 'failed note'], { hooks: { HOOK_FAIL_COMMIT: '1' } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /injected commit failure/);
  assert.deepEqual(noted(h, 'failed note'), { task: false, event: false });
  assert.equal(logged(h).length, before);
  assertConsistent(h);
});

test('every connection runs WAL with synchronous=FULL and fullfsync, and a writer leaves the log files for readers', (t) => {
  const h = migrated(t);
  h.ok(['task', 'note', 'T1', 'synced']);
  for (const suffix of ['-wal', '-shm']) assert.ok(fs.existsSync(path.join(h.state, `${Db.FILE}${suffix}`)), `${Db.FILE}${suffix} is left after the writer exits`);
  StateFiles.withDb(h.state, () => {
    const { db } = Db.handle(h.state);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    // 2 is FULL.
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('PRAGMA fullfsync').get().fullfsync, 1);
  });
});

test('a reader without the lock sees each commit whole while writers commit', async (t) => {
  const h = migrated(t);
  const writers = [0, 1, 2].map((n) => new Promise((resolve, reject) => {
    const script = `const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
    for (let i = 0; i < 15; i++) {
      const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'task', 'note', 'T1', 'w${n}-' + i], { encoding: 'utf8', env: fakeAgentEnv(process.env) });
      if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
    }`;
    const child = cp.spawn(process.execPath, ['-e', script], { cwd: h.repo, env: h.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
  }));
  let reads = 0;
  let done = false;
  const all = Promise.all(writers).finally(() => { done = true; });
  while (!done) {
    // A fresh snapshot each time, as a separate reading command takes it.
    const st = StateFiles.withDb(h.state, () => S.loadState(h.state, { fresh: true }));
    const notes = st.tasks.tasks[0].notes.map((n) => n.text);
    const events = st.events.filter((e) => e.cmd === 'task note').map((e) => e.detail.text);
    assert.deepEqual(notes, events, 'every note a snapshot shows has its event, and no event is ahead of its note');
    reads++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await all;
  assert.ok(reads > 1, `the reader read while writers committed (${reads} reads)`);
  assert.equal(h.readState('tasks.json').tasks[0].notes.length, 45);
});

test('kill -9 at any moment loses no acknowledged write, and leaves every task change with its event', { timeout: 600000 }, async (t) => {
  const h = migrated(t);
  const acked = new Set();
  const writer = (n) => {
    let i = 0;
    let child = null;
    let stopped = false;
    let finished;
    const done = new Promise((resolve) => { finished = resolve; });
    const next = () => {
      if (stopped) return finished();
      const text = `k${n}-${i++}`;
      child = cp.spawn(process.execPath, [BIN, 'task', 'note', 'T1', text], { cwd: h.repo, env: h.env, stdio: 'ignore' });
      child.on('exit', (code) => {
        // Acknowledged: the command returned success to its caller.
        if (code === 0) acked.add(text);
        next();
      });
    };
    next();
    // `done` settles once the writer is stopped and its last command exited.
    return { kill: () => child?.kill('SIGKILL'), stop: () => { stopped = true; }, done };
  };
  const writers = [0, 1, 2, 3].map(writer);
  const end = Date.now() + 8000; // wait-allow: the kill loop runs for a fixed span of random kills, not until a condition
  let kills = 0;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 200))); // wait-allow: random gaps put the kills at random points of the writers' commits
    writers[Math.floor(Math.random() * writers.length)].kill();
    kills++;
  }
  for (const w of writers) w.stop();
  // Read what is durable once the last commands have exited.
  await Promise.all(writers.map((w) => w.done));
  assert.ok(kills > 10 && acked.size > 10, `${kills} kills and ${acked.size} acknowledged writes`);
  const notes = new Set(h.readState('tasks.json').tasks[0].notes.map((n) => n.text));
  const events = new Set(logged(h).filter((e) => e.cmd === 'task note').map((e) => e.detail.text));
  for (const text of acked) assert.ok(notes.has(text) && events.has(text), `acknowledged ${text} survived`);
  assert.deepEqual([...notes].sort(), [...events].sort(), 'every note has its event and every note event its note');
  StateFiles.withDb(h.state, () => assert.equal(Db.handle(h.state).db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'));
  h.ok(['task', 'note', 'T1', 'after the kills']);
  assertConsistent(h);
});

test('a 0.1 writer killed between its two commit writes leaves a change the next command completes, with its event, before it migrates', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
});

test('a 0.1 writer killed before it logs its events leaves no change, and validate recovers before it migrates', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'crashed note');
  // validate takes the lock, so it clears the dead writer's staged copy first.
  assertConsistent(h);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: false, event: false });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
});

test('validate reports a task change whose event the migrated log lost', (t) => {
  const h = setup(t);
  assert.equal(runReleased(h, RELEASED, ['task', 'note', 'T1', 'kept in tasks.json']).code, 0);
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

test('a 0.1 commit whose log sync failed after its lines were written keeps its change for the next command', (t) => {
  const h = setup(t);
  const r = runReleased(h, RELEASED, ['task', 'note', 'T1', 'unsynced note'], { hooks: { HOOK_FAIL_EVENT_SYNC: '1' } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /EIO/);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'unsynced note'), { task: true, event: true });
  assertConsistent(h);
});

function tornMultiEvent(t, { windows = false } = {}) {
  const h = setup(t);
  const cli = windows ? windowsIds(t) : {};
  const log = path.join(h.state, 'events.jsonl');
  // One descriptor for the stat and the torn append, so the file measured is the file written.
  const fd = fs.openSync(log, 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  const event = (cmd, detail) => ({ at: new Date().toISOString(), agent: 'owner', cmd, task: 'T1', detail, id: `E${crypto.randomUUID()}`, type: cmd, to: 'orchestrator' });
  const first = event('task note', { text: 'torn note' });
  const second = event('evidence', { type: 'note', ok: true });
  const doc = fileDoc(h, 'tasks.json');
  doc.tasks[0].notes.push({ at: first.at, agent: 'owner', text: 'torn note' });
  doc.last_event = second.id;
  // A power cut kept the first line and all of the second but its newline.
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  fs.writeSync(fd, `${JSON.stringify(first)}\n${JSON.stringify(second)}`);
  fs.closeSync(fd);
  h.ok(['task', 'note', 'T1', 'next note'], cli);
  const ids = logged(h).map((e) => e.id);
  assert.ok(!ids.includes(first.id) && !ids.includes(second.id), 'the torn commit left no event');
  assert.deepEqual(noted(h, 'torn note'), { task: false, event: false });
  assert.deepEqual(noted(h, 'next note'), { task: true, event: true });
  assertConsistent(h);
}

test('recovery before migration cuts a torn multi-event append off the log, including a final line missing only its newline', (t) => tornMultiEvent(t));

// A tool through 0.1.2 wrote the inode as a Number only, rounded past 2^53.
test('recovery before migration cuts a torn append that a 0.1.2 manifest describes when file ids pass 2^53, as on Windows', (t) => tornMultiEvent(t, { windows: true }));

test('an add that failed after its commit keeps its brief, and only then', (t) => {
  const h = migrated(t);
  const brief = path.join(h.state, 'briefs', 'T2.md');
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, '# Context\n');
  // No commit recorded T2: the add did not commit.
  StateFiles.withDb(h.state, () => T.discardUncommittedBrief(h.state, 'T2'));
  assert.throws(() => fs.readFileSync(brief), { code: 'ENOENT' }, 'an add whose commit never landed loses its brief');
  fs.writeFileSync(brief, '# Context\n');
  const doc = h.readState('tasks.json');
  doc.tasks.push({ ...doc.tasks[0], id: 'T2', title: 'Committed', notes: [] });
  h.writeState('tasks.json', doc);
  StateFiles.withDb(h.state, () => T.discardUncommittedBrief(h.state, 'T2'));
  assert.equal(fs.readFileSync(brief, 'utf8'), '# Context\n', 'an add whose commit landed keeps its brief');
});

const foreign = (text) => ({ at: new Date().toISOString(), agent: 'owner', cmd: 'msg', task: 'T1', detail: { to: 'worker-a', text },
  id: `E${crypto.randomUUID()}`, type: 'worker-message', to: 'worker-a' });

test('recovery before migration never cuts events another writer appended after a commit that died before its append', (t) => {
  const h = setup(t);
  // task update --tier logs a setting audit event and its own: two events.
  crash(h, 'staged', null, ['task', 'update', 'T1', '--tier', 'hard']);
  // An older tool does not recover; it appends a message as it always did.
  const msg = foreign('from an older tool');
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(msg)}\n`);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.ok(logged(h).some((e) => e.id === msg.id), 'the older tool\'s message is still logged');
  assert.notEqual(h.readState('tasks.json').tasks[0].tier, 'hard');
  assertConsistent(h);
});

test('recovery before migration never cuts a log that was replaced since the commit staged', (t) => {
  const h = setup(t);
  crash(h, 'staged', null, ['task', 'update', 'T1', '--tier', 'hard']);
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

test('a staged 0.1 commit that cannot be removed stops the next command before it migrates', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'crashed note');
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'));
  const r = h.run(['task', 'note', 'T1', 'blocked note'], { hooks: { HOOK_BUSY_STAGED: '1' } });
  assert.notEqual(r.code, 0, 'the writer stops');
  assert.match(r.stderr, /interrupted commit file/);
  assert.ok(fs.readFileSync(path.join(h.state, 'events.jsonl')).equals(before), 'nothing was appended');
  assert.equal(fs.existsSync(path.join(h.state, Db.FILE)), false, 'nothing was migrated');
  h.ok(['task', 'note', 'T1', 'next note']);
  assertConsistent(h);
});

test('rolling a 0.1 commit forward syncs the log before it renames the staged files', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  const trace = path.join(h.base, 'sync-trace');
  h.ok(['task', 'note', 'T1', 'next note'], { hooks: { HOOK_SYNC_TRACE: trace } });
  const steps = fs.readFileSync(trace, 'utf8').trim().split('\n');
  assert.deepEqual(steps.slice(0, 2), ['fsync events.jsonl', 'rename tasks.json']);
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
});

const SHORT_WAIT = path.join(__dirname, 'fixtures', 'lock-wait.js');

test('a recovery rename another process holds open reports the busy code, and a later command finishes it', (t) => {
  const h = setup(t);
  crash(h, 'landed', 'crashed note');
  // Every rename onto tasks.json is refused past the 2 s retry, as Windows
  // refuses one while a scanner holds the file.
  const r = h.run(['task', 'note', 'T1', 'blocked note'], {
    env: { NODE_OPTIONS: `--require=${JSON.stringify(SHORT_WAIT)}` },
    hooks: { HOOK_BUSY_RENAME: '^tasks\\.json$', HOOK_BUSY_RENAME_TIMES: '0', HOOK_SHARING_BUSY: '1' },
  });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /holds an interrupted commit's file open/);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.deepEqual(noted(h, 'crashed note'), { task: true, event: true });
  assert.deepEqual(noted(h, 'blocked note'), { task: false, event: false });
  assertConsistent(h);
});

test('a writer sweeps the temp files dead writers left, and keeps a live writer\'s or a recent one', (t) => {
  const h = migrated(t);
  const old = (Date.now() - 120000) / 1000;
  const tmp = (name, pid, hex, age) => {
    const file = path.join(h.state, `${name}.${pid}.${hex}.tmp`);
    fs.writeFileSync(file, '{}');
    if (age) fs.utimesSync(file, age, age);
    return file;
  };
  // No pid on Linux, macOS or Windows reaches 2^31 - 2.
  const dead = tmp('tasks.json', 2147483646, '0123abcd', old);
  const build = tmp(Db.FILE, 2147483646, '89abcdef', old);
  const recent = tmp('tasks.json', 2147483646, '4567cdef', null);
  const live = tmp('tasks.json', process.pid, '89ab0123', old);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.equal(fs.existsSync(dead), false, 'the dead writer\'s temp file is swept');
  assert.equal(fs.existsSync(build), false, 'so is a database a dead migration was building');
  assert.ok(fs.existsSync(recent), 'a recent one may belong to a writer in another pid namespace');
  assert.ok(fs.existsSync(live));
});

test('recovery leaves a newer schema\'s staged commit alone and refuses, as reads do', (t) => {
  const h = setup(t);
  crash(h, 'staged', 'newer tool note');
  const staged = leftovers(h);
  assert.ok(staged.length >= 2, `staged files: ${staged}`);
  const project = fileDoc(h, 'project.json');
  fs.writeFileSync(path.join(h.state, 'project.json'), JSON.stringify({ ...project, schema_version: 3 }, null, 2) + '\n');
  for (const args of [['task', 'note', 'T1', 'older tool note'], ['validate']]) {
    const r = h.run(args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.stderr, /state schema 3 is incompatible/);
    assert.deepEqual(leftovers(h), staged, `${args[0]} left the newer tool's commit as it was`);
    assert.equal(fs.existsSync(path.join(h.state, Db.FILE)), false, `${args[0]} migrated nothing`);
  }
});

test('a torn last line cut before its own id is cut off before migration, even when its detail names another event', (t) => {
  const h = setup(t);
  const log = path.join(h.state, 'events.jsonl');
  // One descriptor for the stat and the torn append, so the file measured is the file written.
  const fd = fs.openSync(log, 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  const event = (cmd, detail) => ({ at: new Date().toISOString(), agent: 'owner', cmd, task: 'T1', detail, id: `E${crypto.randomUUID()}`, type: cmd, to: 'orchestrator' });
  const first = event('task note', { text: 'torn note' });
  const second = event('evidence', { type: 'note', ok: true, ref: { id: `E${crypto.randomUUID()}` } });
  const doc = fileDoc(h, 'tasks.json');
  doc.tasks[0].notes.push({ at: first.at, agent: 'owner', text: 'torn note' });
  doc.last_event = second.id;
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  const line = JSON.stringify(second);
  fs.writeSync(fd, `${JSON.stringify(first)}\n${line.slice(0, line.indexOf(',"id":"'))}`);
  fs.closeSync(fd);
  h.ok(['task', 'note', 'T1', 'next note']);
  assert.ok(!logged(h).some((e) => e.id === first.id), 'the torn commit left no event');
  assert.equal(StateFiles.logText(h.state).includes(second.detail.ref.id), false, 'the torn line is gone');
  assert.deepEqual(noted(h, 'torn note'), { task: false, event: false });
  assertConsistent(h);
});
