'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, BIN } = require('./helpers');
const S = require('../lib/state');
const T = require('../lib/tasks');

function setup(t) {
  return cachedFixture(t, 'storage', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Stored evidence', '--acceptance', 'complete receipts']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.git(['rev-parse', 'HEAD'])]);
  });
}

test('CLI migrates large legacy evidence, preserves audit matching and reads full artifacts lazily', (t) => {
  const h = setup(t);
  const doc = h.readState('tasks.json');
  const task = doc.tasks[0];
  const entry = { type: 'tests', ok: true, sha: task.sha, agent: 'checker', revision: 1,
    source: 'check tests', summary: 'large summary\n'.repeat(1000),
    commands: [{ command: 'test', args: [], status: 0, output: 'large output\n'.repeat(10000) }],
    gate_policy: { tests_map: { source: Array(1000).fill('test/example.test.js') } },
    test_failure: { tail: 'failure detail\n'.repeat(1000) } };
  task.evidence.push(entry);
  const opaque = { type: 'future-gate', summary: 'opaque'.repeat(1000) };
  task.evidence.push(opaque);
  h.writeState('tasks.json', doc);
  const audit = { at: new Date().toISOString(), cmd: 'check tests', task: 'T1', agent: 'checker', detail: entry };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify(audit) + '\n');
  const eventBytes = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const before = fs.statSync(path.join(h.state, 'tasks.json')).size;
  h.ok(['task', 'note', 'T1', 'migrate through a normal write']);
  const raw = h.readState('tasks.json').tasks[0].evidence[0];
  assert.ok(fs.statSync(path.join(h.state, 'tasks.json')).size < before / 4);
  assert.deepEqual(Object.keys(raw.evidence_refs).sort(), ['commands', 'gate_policy', 'summary', 'test_failure']);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence[1], opaque);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl')).subarray(0, eventBytes).toString().endsWith(JSON.stringify(audit) + '\n'), true);
  const shown = h.json(['task', 'show', 'T1']).evidence[0];
  for (const key of Object.keys(entry)) assert.deepEqual(shown[key], entry[key], key);
  const st = S.loadState(h.state);
  assert.equal(T.eligibleGateEvidence(st.tasks.tasks[0], st.tasks.tasks[0].evidence[0], st.events), true);
  // A pinned reader sees the original field types and cannot count an incomplete command receipt.
  assert.equal(S.validateTasks(h.readState('tasks.json')).length, 0);
  assert.equal(T.eligibleGateEvidence(task, raw, [audit]), false);
  const file = path.join(h.state, 'evidence', 'T1', raw.evidence_refs.commands.sha256 + '.json');
  fs.renameSync(file, file + '.held');
  h.ok(['task', 'note', 'T1', 'unrelated writes need no historical output']);
  const failed = h.run(['task', 'show', 'T1']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /restore the evidence file/);
  fs.renameSync(file + '.held', file);
  fs.writeFileSync(file, '{}');
  assert.match(h.run(['task', 'show', 'T1']).stderr, /failed its content check/);
});

test('new CLI evidence stores large text once and preserves references across later writes', (t) => {
  const h = setup(t);
  const summary = 'full report\n'.repeat(600);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--summary', summary]);
  const evidence = h.readState('tasks.json').tasks[0].evidence[0];
  assert.ok(evidence.evidence_refs.summary);
  const file = path.join(h.state, 'evidence', 'T1', evidence.evidence_refs.summary.sha256 + '.json');
  assert.equal(JSON.parse(fs.readFileSync(file)), summary);
  const before = fs.statSync(file).mtimeMs;
  h.ok(['task', 'note', 'T1', 'preserve the artifact']);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence[0], evidence);
  assert.equal(h.json(['task', 'show', 'T1']).evidence[0].summary, summary);
});

test('migration keeps failed verdicts visible to pinned readers and never manufactures an audit', (t) => {
  const h = setup(t);
  const doc = h.readState('tasks.json');
  const task = doc.tasks[0];
  const entry = { type: 'tests', ok: false, sha: task.sha, agent: 'checker', revision: 1,
    source: 'check tests', commands: [{ command: 'test', args: [], status: 1, output: 'failure\n'.repeat(2000) }] };
  task.evidence.push(entry, { ...entry, type: 'clean', source: 'check clean' });
  h.writeState('tasks.json', doc);
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
    at: new Date().toISOString(), cmd: 'check tests', task: 'T1', agent: 'checker', detail: entry,
  }) + '\n');
  h.ok(['task', 'note', 'T1', 'migrate both entries']);
  const raw = h.readState('tasks.json').tasks[0];
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(T.latestGateEvidence(raw, 'tests', events).ok, false);
  assert.equal(T.latestGateEvidence(raw, 'clean', events), undefined);
  assert.equal(events.filter((event) => event.cmd === 'check tests').length, 2);
  assert.equal(events.filter((event) => event.cmd === 'check clean').length, 0);
  // An older writer preserves unknown fields when changing unrelated state.
  raw.notes.push({ at: new Date().toISOString(), agent: 'old-tool', text: 'older writer' });
  const rewritten = h.readState('tasks.json');
  rewritten.tasks[0] = raw;
  h.writeState('tasks.json', rewritten);
  assert.deepEqual(h.json(['task', 'show', 'T1']).evidence[0].commands, entry.commands);
});

test('tool progress and UserPromptSubmit proceed while another process holds the state lock', (t) => {
  const h = setup(t);
  const agent = 'worker';
  const binding = path.join(h.state, 'homes', agent, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ agent, task: 'T1', state: h.state, harness: 'claude', attempt: 1 }));
  h.ok(['msg', '--to', agent, '--task', 'T1', 'deliver after the lock clears']);
  const tasks = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const lock = S.acquireLock(h.state);
  try {
    const prompt = cp.spawnSync(process.execPath, [path.join(path.dirname(BIN), '..', 'lib', 'hook-bridge.js'), 'hook'], {
      cwd: h.repo, env: { ...h.env, TOWER_CRANE_AGENT: agent, TOWER_CRANE_STATE: h.state },
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout, '');
    const tool = cp.spawnSync(process.execPath, [BIN, 'hook', 'tool', '--agent', agent,
      '--state', h.state, '--binding', binding, '--payload', '{"tool":"Read"}'], {
      cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(tool.status, 0, tool.stderr);
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), tasks);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'progress.jsonl'), 'utf8')).detail.tool, 'Read');
    assert.equal(S.loadState(h.state).events.some((e) => e.cmd === 'hook progress'), false);
  } finally {
    S.releaseLock(lock);
  }
  const delivered = h.json(['hook', 'inbox', '--agent', agent, '--binding', binding]);
  assert.match(delivered.context, /deliver after the lock clears/);
});
