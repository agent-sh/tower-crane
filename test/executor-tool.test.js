'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Tool = require('../lib/tool');
const P = require('../lib/processes');
const { waitOnRepo, waitUntil } = require('./signals');
const { makeRepo, ROOT } = require('./helpers');
const { setup, configureHarness } = require('./automation-helpers');

const OLD = { sha: `a79075ad${'0'.repeat(32)}`, version: '0.0.0' };

test('tool order: release version first, then commit time at the same version', () => {
  const at = (version, committed, sha = null) => ({ version, committed, sha });
  const rows = [
    ['lower version', at('0.1.6', null), at('0.1.7', null), true],
    ['higher version', at('0.1.8', null), at('0.1.7', null), false],
    ['numeric, not text, order', at('0.1.10', null), at('0.1.9', null), false],
    ['same version, earlier commit', at('0.1.7', '2026-10-20T10:00:00Z', 'a'), at('0.1.7', '2026-10-21T10:00:00Z', 'b'), true],
    ['same version, later commit', at('0.1.7', '2026-10-21T10:00:00Z', 'b'), at('0.1.7', '2026-10-20T10:00:00Z', 'a'), false],
    ['same sha', at('0.1.7', '2026-10-20T10:00:00Z', 'a'), at('0.1.7', '2026-10-21T10:00:00Z', 'a'), false],
    ['same version, commit time unknown', at('0.1.7', null, 'a'), at('0.1.7', '2026-10-21T10:00:00Z', 'b'), false],
    ['unparsable version', at('dev', null), at('0.1.7', null), false],
    ['no tool', null, at('0.1.7', null), false],
  ];
  for (const [name, a, b, expected] of rows) assert.equal(Tool.behind(a, b), expected, name);
  const events = [
    { cmd: 'automation', detail: { phase: 'running', tool: at('0.1.7', '2026-10-20T10:00:00Z', 'a') } },
    { cmd: 'check tests', detail: { tool: at('0.1.7', '2026-10-21T10:00:00Z', 'b') } },
    // Only engine records count: a progress tool name and a hand-written evidence detail do not.
    { cmd: 'hook progress', detail: { tool: 'Read' } },
    { cmd: 'evidence', detail: { tool: at('9.0.0', null) } },
    { cmd: 'spawn', detail: { tool: at('0.1.6', null, 'c') } },
  ];
  assert.deepEqual(Tool.newest(events), at('0.1.7', '2026-10-21T10:00:00Z', 'b'));
  assert.equal(Tool.newest([]), null);
});

// A copy of this checkout's runtime that reports an older release, as a
// supervisor's pinned snapshot from before an upgrade does.
function oldTool(h) {
  const dir = path.join(h.base, 'old-tool');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards']) fs.cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version: OLD.version }));
  fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify(OLD));
  return (args) => {
    const r = cp.spawnSync(process.execPath, [path.join(dir, 'bin', 'tower-crane.js'), ...args], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

test('an executor on an older tool leaves queued work for a current one; receipts and accepts record the tool', (t) => {
  const h = setup(t);
  h.submit();
  // The current engine's gate run is the project's newest tool record.
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const old = oldTool(h);
  const waited = old(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.equal(waited.code, 2, waited.stderr);
  assert.match(waited.stderr, /this tool \(0\.0\.0 a79075ad\) is behind the project's engine/);
  assert.deepEqual(h.logs().filter((e) => e.cmd === 'automation'), [], 'the old executor took no reaction');
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['ci', 'review']);
  const submit = h.logs().find((e) => e.cmd === 'submit');
  const queued = h.logs().filter((e) => e.cmd === 'automation queued');
  assert.ok(queued.some((e) => e.detail.source === submit.id), JSON.stringify(queued));
  assert.ok(queued.every((e) => e.detail.tool.version === OLD.version && e.detail.engine_tool.sha === Tool.current().sha));
  for (const args of [['check', 'tests', 'T1'], ['accept', 'T1'], ['merge', '--accepted'], ['spawn', '--task', 'T1']]) {
    const r = old([...args, '--agent', 'orchestrator']);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /refused: this tool \(0\.0\.0 a79075ad\) is behind the project's engine/, args.join(' '));
  }
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  // A current wait host takes the queued work.
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.ok(task.evidence.some((e) => e.type === 'merge' && e.ok), JSON.stringify(task.evidence.map((e) => e.type)));
  const current = Tool.current();
  const done = h.logs().find((e) => e.cmd === 'automation' && e.detail.source === submit.id && e.detail.phase === 'running');
  assert.deepEqual(done.detail.tool, current);
  for (const cmd of ['check tests', 'check clean', 'check ci', 'accept', 'merge']) {
    const records = h.logs().filter((e) => e.cmd === cmd);
    assert.ok(records.length, cmd);
    assert.ok(records.every((e) => e.detail.tool?.sha === current.sha && e.detail.tool.version === current.version), cmd);
  }
  assert.deepEqual(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'running').detail.tool, current);
});

test('a supervisor whose agent exits runs only its own task\'s reactions; the wait host runs another task\'s queued one', async (t) => {
  const h = setup(t);
  configureHarness(h);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefName: 'other-change', url: 'https://github.com/acme/demo/pull/8' };
  h.saveGithub(github);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'Implement T2.\n' });
  h.submit('T2', h.sha, '8');
  // T2's reaction waits in the shared queue with no wait host running.
  const other = h.logs().findLast((e) => e.cmd === 'submit' && e.task === 'T2');
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), agent: 'orchestrator',
    cmd: 'automation queued', task: 'T2', detail: { source: other.id, executors: 2 } })}\n`);
  assert.equal((await h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'])).code, 0);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok),
    () => JSON.stringify(h.logs().slice(-10)));
  // Both supervisors, the worker's and the reviewer's it dispatched, exit.
  const monitors = h.logs().filter((e) => e.cmd === 'spawn' && e.task === 'T1').map((e) => e.detail);
  assert.deepEqual(monitors.map((d) => d.role), ['worker', 'reviewer']);
  // Each agent's snapshot is a copy of the dispatching tool, and its spawn records it.
  for (const d of monitors) assert.deepEqual({ ...d.tool, path: undefined }, { ...Tool.current(), path: undefined }, d.agent);
  for (const d of monitors) {
    await waitUntil(() => P.processState({ pid: d.monitor_pid, host: d.host, start_ticks: d.monitor_start_ticks }) === 'exited',
      { what: `${d.agent}'s supervisor did not exit` });
  }
  assert.deepEqual([...new Set(h.logs().filter((e) => e.cmd === 'automation').map((e) => e.task))], ['T1']);
  const t2 = () => h.readState('tasks.json').tasks.find((x) => x.id === 'T2');
  assert.deepEqual(t2().evidence, [], 'no supervisor ran T2\'s gates');
  h.consume();
  const ran = h.logs().filter((e) => e.cmd === 'automation' && e.detail.source === other.id);
  assert.equal(ran[0]?.detail.phase, 'running', JSON.stringify(ran));
  assert.ok(!monitors.some((d) => d.monitor_pid === ran[0].detail.pid), 'the wait host ran it');
  assert.notEqual(ran.at(-1).detail.phase, 'running');
  assert.ok(t2().evidence.some((e) => e.type === 'tests'), JSON.stringify(t2().evidence));
});

test('status lists live executors with tool version and age and flags one behind the engine', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'One', '--acceptance', 'works']);
  h.ok(['task', 'add', '--title', 'Two', '--acceptance', 'works']);
  const live = { pid: process.pid, ...P.identity(process.pid) };
  const at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
    { at: now, agent: 'orchestrator', cmd: 'automation', task: 'T1', detail: { source: 's1', phase: 'running', ...live, tool: Tool.current() } },
    { at, agent: 'orchestrator', cmd: 'automation', task: 'T2', detail: { source: 's2', phase: 'running', ...live, tool: OLD } },
    { at, agent: 'orchestrator', cmd: 'spawn', task: 'T2', detail: { agent: 'worker-T2-1', role: 'worker', pid: 999999,
      monitor_pid: process.pid, host: live.host, monitor_start_ticks: live.start_ticks, tool: { ...OLD, path: '/old' } } },
  ].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const data = h.json(['status']);
  assert.deepEqual(data.engine_tool, Tool.current());
  const byKind = Object.fromEntries(data.executors.map((x) => [`${x.kind} ${x.task}`, x]));
  assert.equal(byKind['reaction T1'].stale, false);
  assert.equal(byKind['reaction T1'].tool.version, Tool.current().version);
  assert.equal(byKind['reaction T2'].stale, true);
  assert.equal(byKind['reaction T2'].tool.sha, OLD.sha);
  assert.ok(byKind['reaction T2'].age_s >= 3 * 3600 - 5, JSON.stringify(byKind['reaction T2']));
  assert.equal(byKind['supervisor T2'].agent, 'worker-T2-1');
  assert.equal(byKind['supervisor T2'].stale, true);
  const line = h.ok(['status']).split('\n').find((l) => l.startsWith('executors'));
  assert.ok(line.startsWith(`executors (engine ${Tool.describe(Tool.current())}): `), line);
  assert.match(line, /reaction T2 pid \d+ on [^,]+, tool 0\.0\.0 a79075ad, 3h, STALE/);
  assert.match(line, /supervisor worker-T2-1 \(T2\) pid \d+ on [^,]+, tool 0\.0\.0 a79075ad, 3h, STALE/);
  assert.match(line, /reaction T1 pid \d+ on [^,]+, tool [^,]+, \d+s(;|$)/);
});
