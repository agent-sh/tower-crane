'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, BIN } = require('./helpers');
const S = require('../lib/state');
const T = require('../lib/tasks');

const BRIDGE = path.join(__dirname, '..', 'lib', 'hook-bridge.js');

function setup(t) {
  return cachedFixture(t, 'storage', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Stored evidence', '--acceptance', 'complete receipts']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.git(['rev-parse', 'HEAD'])]);
  });
}

const gate = (task, sha, ok) => ({ type: 'tests', ok, sha, agent: 'checker', revision: task.revision,
  source: 'check tests', summary: 'large summary\n'.repeat(1000),
  commands: [{ command: 'test', args: [], status: ok ? 0 : 1, output: 'large output\n'.repeat(10000) }],
  gate_policy: { tests_map: { source: Array(1000).fill('test/example.test.js') } },
  test_failure: ok ? null : { tail: 'failure detail\n'.repeat(1000) } });

const stateFile = (h, name) => path.join(h.state, name);
const artifact = (h, task, ref) => path.join(h.state, 'evidence', task, `${ref.sha256}.json`);

test('the first write moves settled evidence out, keeps current evidence inline and reads artifacts back checked', (t) => {
  const h = setup(t);
  const doc = h.readState('tasks.json');
  const task = doc.tasks[0];
  const old = gate(task, 'abcdef1', false);
  // Gates accept an abbreviated head, so this entry is current too.
  const current = gate(task, task.sha.slice(0, 12), true);
  const opaque = { type: 'future-gate', sha: 'abcdef1', summary: 'opaque'.repeat(1000) };
  task.evidence.push(old, opaque, current);
  h.writeState('tasks.json', doc);
  const audit = (detail) => ({ at: new Date().toISOString(), cmd: 'check tests', task: 'T1', agent: 'checker', detail });
  fs.appendFileSync(stateFile(h, 'events.jsonl'), JSON.stringify(audit(old)) + '\n' + JSON.stringify(audit(current)) + '\n');
  const log = fs.readFileSync(stateFile(h, 'events.jsonl'));
  const before = fs.statSync(stateFile(h, 'tasks.json')).size;
  h.ok(['task', 'note', 'T1', 'migrate through a normal write']);
  const raw = h.readState('tasks.json').tasks[0].evidence;
  assert.deepEqual(Object.keys(raw[0].evidence_refs).sort(), ['commands', 'gate_policy', 'summary', 'test_failure']);
  assert.deepEqual(raw[0].commands, []);
  assert.equal(raw[0].gate_policy, null);
  assert.match(raw[0].summary, /^\[stored in evidence\/T1\/[a-f0-9]{64}\.json\]$/);
  assert.equal(JSON.parse(fs.readFileSync(artifact(h, 'T1', raw[0].evidence_refs.commands))).at(0).output, old.commands[0].output);
  assert.deepEqual(raw[1], opaque);
  // Gate decisions of a pinned older tool read the current head, which stays whole.
  assert.deepEqual(raw[2], current);
  assert.ok(T.eligibleGateEvidence(task, raw[2], [audit(current)]));
  assert.ok(fs.statSync(stateFile(h, 'tasks.json')).size < before * 0.6);
  assert.ok(fs.readFileSync(stateFile(h, 'events.jsonl')).subarray(0, log.length).equals(log), 'the event log is never rewritten');
  assert.deepEqual(h.json(['task', 'show', 'T1']).evidence[0], old, 'readers see the entry as recorded');
  const st = S.loadState(h.state);
  assert.equal(T.eligibleGateEvidence(st.tasks.tasks[0], st.tasks.tasks[0].evidence[0], st.events), true);
  const file = artifact(h, 'T1', raw[0].evidence_refs.commands);
  fs.renameSync(file, file + '.held');
  h.ok(['task', 'note', 'T1', 'unrelated writes need no historical output']);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence[0], raw[0]);
  const missing = h.run(['task', 'show', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /restore the evidence file/);
  fs.renameSync(file + '.held', file);
  fs.writeFileSync(file, '{}');
  assert.match(h.run(['task', 'show', 'T1']).stderr, /failed its content check/);
});

test('evidence settles when the head moves, its file is written once and an older writer\'s value wins', (t) => {
  const h = setup(t);
  const summary = 'full report\n'.repeat(600);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--summary', summary]);
  assert.equal(h.readState('tasks.json').tasks[0].evidence[0].summary, summary, 'evidence at the head stays inline');
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', 'abcdef1']);
  const settled = h.readState('tasks.json').tasks[0].evidence[0];
  const file = artifact(h, 'T1', settled.evidence_refs.summary);
  assert.equal(JSON.parse(fs.readFileSync(file)), summary);
  const mtime = fs.statSync(file).mtimeMs;
  h.ok(['task', 'note', 'T1', 'preserve the artifact']);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence[0], settled);
  assert.equal(h.json(['task', 'show', 'T1']).evidence[0].summary, summary);
  // An older tool that cannot follow the reference sets the field itself.
  const doc = h.readState('tasks.json');
  doc.tasks[0].evidence[0].summary = 'replaced by an older writer';
  h.writeState('tasks.json', doc);
  h.ok(['task', 'note', 'T1', 'drop the stale reference']);
  const replaced = h.readState('tasks.json').tasks[0].evidence[0];
  assert.equal(replaced.summary, 'replaced by an older writer');
  assert.equal(replaced.evidence_refs, undefined);
});

test('tasks.json grows by a small fixed amount per settled receipt, whatever its output size', (t) => {
  const h = setup(t);
  const doc = h.readState('tasks.json');
  const sizes = [];
  for (const lines of [1000, 10000, 40000]) {
    const entry = gate(doc.tasks[0], 'abcdef1', true);
    entry.commands[0].output = 'line\n'.repeat(lines);
    doc.tasks[0].evidence.push(entry);
    h.writeState('tasks.json', doc);
    h.ok(['task', 'note', 'T1', `settle ${lines}`]);
    sizes.push(fs.statSync(stateFile(h, 'tasks.json')).size);
  }
  const steps = sizes.slice(1).map((size, i) => size - sizes[i]);
  for (const step of steps) assert.ok(step < 2048, `one settled receipt added ${step} bytes`);
});

test('UserPromptSubmit and tool hooks proceed while another process holds the state lock', (t) => {
  const h = setup(t);
  const agent = 'worker';
  const binding = path.join(h.state, 'homes', agent, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ agent, task: 'T1', state: h.state, harness: 'claude', attempt: 1 }));
  const env = { ...h.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_STATE: h.state };
  const bridge = (event) => cp.spawnSync(process.execPath, [BRIDGE, 'hook'], {
    cwd: h.repo, env, input: JSON.stringify({ hook_event_name: event, tool_name: 'Read' }), encoding: 'utf8', timeout: 300000,
  });
  const files = () => ['tasks.json', 'events.jsonl'].map((name) => fs.readFileSync(stateFile(h, name), 'utf8'));
  const lock = S.acquireLock(h.state);
  try {
    // Nothing pending: the poll reads the log and never asks for the lock.
    const idle = bridge('UserPromptSubmit');
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(idle.stdout, '');
    const tool = bridge('PostToolUse');
    assert.equal(tool.status, 0, tool.stderr);
  } finally {
    S.releaseLock(lock);
  }
  h.ok(['msg', '--to', agent, '--task', 'T1', 'deliver after the lock clears']);
  const unchanged = files();
  const held = S.acquireLock(h.state);
  try {
    // A message is waiting, so the poll tries the lock once and leaves it unread.
    const started = Date.now();
    const prompt = bridge('UserPromptSubmit');
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout, '');
    assert.ok(Date.now() - started < S.LOCK_WAIT_MS / 4, 'the prompt did not wait for the lock');
    assert.deepEqual(files(), unchanged);
  } finally {
    S.releaseLock(held);
  }
  const progress = fs.readFileSync(S.progressFile(h.state, agent), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(progress.map((e) => [e.cmd, e.task, e.detail.tool]), [['hook progress', 'T1', 'Read']]);
  assert.equal(S.loadState(h.state).events.some((e) => e.cmd === 'hook progress'), false);
  const delivered = bridge('UserPromptSubmit');
  assert.equal(delivered.status, 0, delivered.stderr);
  assert.match(JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext, /deliver after the lock clears/);
  assert.equal(bridge('UserPromptSubmit').stdout, '', 'a delivered message is acknowledged once');
});

test('historical progress in the event log keeps its bytes but leaves state snapshots', (t) => {
  const h = setup(t);
  const line = JSON.stringify({ id: 'Eold', at: new Date().toISOString(), agent: 'worker', cmd: 'hook progress', task: 'T1', detail: { tool: 'Read' } });
  const nested = JSON.stringify({ id: 'Enested', at: new Date().toISOString(), agent: 'worker', cmd: 'task note', task: 'T1', detail: { cmd: 'hook progress' } });
  fs.appendFileSync(stateFile(h, 'events.jsonl'), line + '\n' + nested + '\n');
  h.ok(['task', 'note', 'T1', 'note quoting "cmd":"hook progress" stays an event']);
  assert.match(fs.readFileSync(stateFile(h, 'events.jsonl'), 'utf8'), new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const events = S.readEvents(h.state);
  assert.equal(events.some((e) => e.id === 'Eold'), false);
  assert.ok(events.some((e) => e.id === 'Enested'), 'a detail naming hook progress is still an event');
  assert.ok(events.some((e) => e.cmd === 'task note' && e.detail.text?.includes('hook progress')));
  assert.equal(cp.spawnSync(process.execPath, [BIN, 'status', '--state', h.state], { env: h.env, encoding: 'utf8' }).status, 0);
});
