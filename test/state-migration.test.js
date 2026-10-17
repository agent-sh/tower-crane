'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const StateFiles = require('./state-files');
const { makeRepo } = require('./helpers');
const { runReleased } = require('./released-tool');

// The last release before the database: its file layout is what real
// installs migrate, and it must refuse a migrated state.
const RELEASED = 'v0.1.3';
const LAYOUT = ['tasks.json', 'decisions.json', 'events.jsonl'];

function released(h, args, opts) {
  const r = runReleased(h, RELEASED, args, opts);
  assert.equal(r.code, 0, `${RELEASED} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A state that 0.1.3 made and wrote: a task with a note, a message and its
// delivery to nobody yet, and the file layout as 0.1.3 left it.
function fileLayout(t) {
  const h = makeRepo(t);
  released(h, ['init', '--name', 'demo', '--goal', 'prove the engine']);
  released(h, ['task', 'add', '--title', 'Migrated', '--acceptance', 'keeps its history']);
  released(h, ['task', 'note', 'T1', 'written by 0.1.3']);
  released(h, ['msg', '--to', 'worker-T1-1', '--task', 'T1', 'still unread']);
  return h;
}

// Where each line of a log ends: the cursor of the event on it.
function lineEnds(bytes) {
  const ends = [];
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1)) ends.push(i + 1);
  return ends;
}

function legacyDir(h) {
  const dirs = fs.readdirSync(path.join(h.state, 'legacy'));
  assert.equal(dirs.length, 1);
  return path.join(h.state, 'legacy', dirs[0]);
}

test('the first command moves a 0.1 file layout into state.db, keeps every event at its cursor and exports it back byte for byte', (t) => {
  const h = fileLayout(t);
  const project = JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'));
  const tasks = JSON.parse(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'));
  const decisions = JSON.parse(fs.readFileSync(path.join(h.state, 'decisions.json'), 'utf8'));
  const log = fs.readFileSync(path.join(h.state, 'events.jsonl'));
  assert.equal(project.schema_version, 1);

  const shown = h.json(['task', 'show', 'T1']);
  assert.deepEqual(shown.notes.map((n) => n.text), ['written by 0.1.3']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8')),
    { version: 1, schema_version: 2, storage: 'state.db', owner_config_dir: project.owner_config_dir });
  for (const name of LAYOUT) assert.equal(fs.existsSync(path.join(h.state, name)), false, `${name} moved out of the state directory`);
  const legacy = legacyDir(h);
  assert.deepEqual(fs.readdirSync(legacy).sort(), ['decisions.json', 'events.jsonl', 'project.json', 'tasks.json']);
  assert.ok(fs.readFileSync(path.join(legacy, 'events.jsonl')).equals(log), 'the old log is kept as it was');

  assert.deepEqual(h.readState('project.json'), { ...project, schema_version: 2 });
  assert.deepEqual(h.readState('tasks.json'), tasks);
  assert.deepEqual(h.readState('decisions.json'), decisions);
  const events = h.events({ offsets: true });
  assert.deepEqual(events.map((e) => e.offset), lineEnds(log), 'each event ends where its line ended');
  assert.deepEqual(events.map(({ offset, ...e }) => e), log.toString('utf8').trim().split('\n').map((line) => JSON.parse(line)));

  // A cursor 0.1.3 handed out names the same place: after the note, the message.
  const note = events.find((e) => e.cmd === 'task note');
  const woke = JSON.parse(h.ok(['wait', '--agent', 'worker-T1-1', '--for', 'worker-T1-1', '--after', `${note.offset}:0`, '--timeout', '5'])); // wait-allow: the message is already logged, so wait returns at once
  assert.equal(woke.detail.text, 'still unread');
  // The undelivered message is in the inbox a hook reads.
  assert.deepEqual(StateFiles.withDb(h.state, () => require('../lib/db').undelivered(h.state, 'worker-T1-1').map((r) => JSON.parse(r.body).detail.text)), ['still unread']);

  h.ok(['task', 'note', 'T1', 'written by the database']);
  const out = path.join(h.base, 'export');
  h.ok(['state', 'export', out]);
  const exported = fs.readFileSync(path.join(out, 'events.jsonl'));
  assert.ok(exported.subarray(0, log.length).equals(log), 'the export starts with the migrated log byte for byte');
  assert.deepEqual(lineEnds(exported), h.events({ offsets: true }).map((e) => e.offset), 'every exported line ends at its cursor');
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'project.json'), 'utf8')).schema_version, 1);
  // 0.1.3 runs on the export and sees both notes.
  const back = JSON.parse(released(h, ['--state', out, 'task', 'show', 'T1', '--json']));
  assert.deepEqual(back.notes.map((n) => n.text), ['written by 0.1.3', 'written by the database']);
  released(h, ['--state', out, 'task', 'note', 'T1', 'written by 0.1.3 again']);
});

test('0.1.3 refuses a migrated state before it reads or writes any of it', (t) => {
  const h = fileLayout(t);
  h.ok(['task', 'show', 'T1']);
  const before = { events: StateFiles.logText(h.state), tasks: StateFiles.docText(h.state, 'tasks.json'), names: fs.readdirSync(h.state).sort() };
  for (const args of [['task', 'show', 'T1'], ['task', 'note', 'T1', 'from 0.1.3'], ['claim', 'T1', '--agent', 'worker-T1-1'], ['msg', '--to', 'orchestrator', 'from 0.1.3'], ['status'], ['validate'], ['wait', '--timeout', '0']]) {
    const r = runReleased(h, RELEASED, args);
    assert.notEqual(r.code, 0, `${args.join(' ')} ran: ${r.stdout}`);
    assert.match(r.stderr, /state schema 2 is incompatible with this tool \(supports through 1\); upgrade Tower Crane/, args.join(' '));
  }
  assert.equal(StateFiles.logText(h.state), before.events);
  assert.equal(StateFiles.docText(h.state, 'tasks.json'), before.tasks);
  assert.deepEqual(fs.readdirSync(h.state).filter((name) => !['lock', 'sketch.md', 'sketch.html', 'sketch.stamp'].includes(name)).sort(),
    before.names.filter((name) => !['lock', 'sketch.md', 'sketch.html', 'sketch.stamp'].includes(name)));
});

for (const [point, kept] of [['landed', true], ['staged', false]]) {
  test(`a 0.1.3 commit killed ${point === 'landed' ? 'after' : 'before'} its commit point is ${kept ? 'finished' : 'discarded'} before the state is migrated`, (t) => {
    const h = fileLayout(t);
    const r = runReleased(h, RELEASED, ['task', 'note', 'T1', 'interrupted'], { hooks: { HOOK_DIE_COMMIT: point } });
    assert.notEqual(r.code, 0, 'the 0.1.3 writer was killed');
    assert.ok(fs.readdirSync(h.state).some((name) => /^(tasks\.json\.E|commit\.E)/.test(name)), 'it left its staged commit');
    const notes = h.json(['task', 'show', 'T1']).notes.map((n) => n.text);
    assert.deepEqual(notes, kept ? ['written by 0.1.3', 'interrupted'] : ['written by 0.1.3']);
    assert.equal(h.events().some((e) => e.cmd === 'task note' && e.detail.text === 'interrupted'), kept);
    assert.deepEqual(fs.readdirSync(h.state).filter((name) => /\.commit$|^commit\./.test(name)), []);
    const v = h.run(['validate', '--json']);
    assert.deepEqual(JSON.parse(v.stdout).issues, [], v.stderr);
  });
}

for (const [step, file] of [['before its marker', 'state.db'], ['after its marker', 'project.json']]) {
  test(`a migration killed ${step} is completed by the next command`, (t) => {
    const h = fileLayout(t);
    const log = fs.readFileSync(path.join(h.state, 'events.jsonl'));
    const r = h.run(['task', 'show', 'T1'], { hooks: { HOOK_DIE_AFTER_RENAME: file } });
    assert.notEqual(r.code, 0, 'the migration was killed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8')).storage, file === 'state.db' ? undefined : 'state.db');
    h.ok(['task', 'note', 'T1', 'after the crash']);
    assert.deepEqual(h.json(['task', 'show', 'T1']).notes.map((n) => n.text), ['written by 0.1.3', 'after the crash']);
    for (const name of LAYOUT) assert.equal(fs.existsSync(path.join(h.state, name)), false, `${name} moved out`);
    assert.ok(fs.readFileSync(path.join(legacyDir(h), 'events.jsonl')).equals(log));
    assert.deepEqual(h.events({ offsets: true }).slice(0, lineEnds(log).length).map((e) => e.offset), lineEnds(log));
  });
}

test('a reader that cannot write the state directory reads the migrated database; a file layout there is refused', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const h = fileLayout(t);
  const lockDown = () => {
    for (const name of fs.readdirSync(h.state)) {
      const file = path.join(h.state, name);
      if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o444);
    }
    fs.chmodSync(h.state, 0o555);
  };
  const open = () => {
    fs.chmodSync(h.state, 0o755);
    for (const name of fs.readdirSync(h.state)) {
      const file = path.join(h.state, name);
      if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o644);
    }
  };
  // Restored before the fixture's own cleanup, which must remove the directory.
  try {
    lockDown();
    const refused = h.run(['task', 'show', 'T1']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /file layout of tower-crane 0\.1, and this process cannot write it/);
    open();
    h.ok(['task', 'note', 'T1', 'migrated by a writer']);
    lockDown();
    assert.deepEqual(h.json(['task', 'show', 'T1']).notes.map((n) => n.text), ['written by 0.1.3', 'migrated by a writer']);
    assert.match(h.ok(['status']), /T1/);
  } finally {
    open();
  }
});
