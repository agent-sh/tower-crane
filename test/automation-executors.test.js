'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { refillFixture } = require('./automation-helpers');
const { fileWritten } = require('./signals');
const { waitOnRepo } = require('./signals');
const S = require('../lib/state');

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
    assert.deepEqual(h.json(['status']).gate_queue.running.sort(), ['T5', 'T6', 'T7', 'T8']);
    if (saved.size) setPRs(true);
  } catch (error) {
    await finish();
    throw error;
  }
  return finish;
}

test('a failed review reworks and dispatches while all four gate executors are busy', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const finish = await busyExecutors(h, () => h.submit());
  try {
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
      '--fail', '--summary', 'lib/change.js:12 - handle the missing input', '--agent', 'reviewer']);
    h.ok(['project', 'set', '--paused', '']);
    h.consume();
    await waitOnRepo(h, () => fs.existsSync(h.marker('T1')), 'failed review dispatches its rework',
      { signal: AbortSignal.timeout(20000) }); // wait-allow: rework must dispatch before any held gate's 60 s limit
    const task = h.readState('tasks.json').tasks.find((task) => task.id === 'T1');
    assert.equal(task.status, 'in_progress');
    assert.equal(task.revision, 2);
    assert.equal(task.claim.from, 'rework');
    assert.match(fs.readFileSync(`${h.marker('T1')}.prompt`, 'utf8'), /lib\/change.js:12/);
    assert.equal(h.logs().some((e) => e.cmd === 'check tests'), false, 'none of the four held gates ended');
    assert.equal(h.logs().some((e) => e.task === 'T1' && e.cmd === 'automation queued'), false);
    assert.equal(h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1').length, 1);
    const queue = h.json(['status']).gate_queue;
    assert.deepEqual(queue.running.sort(), ['T5', 'T6', 'T7', 'T8']);
    assert.deepEqual(queue.queued, []);
  } finally {
    await finish();
  }
});

test('a merge queue preserves the next task suite after its originating task merges with every executor busy', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const finish = await busyExecutors(h, () => {
    const github = h.github();
    github.ci[h.sha] = 'success';
    github.prs['8'] = { ...github.prs['7'] };
    h.saveGithub(github);
    h.ok(['task', 'add', '--title', 'next merge', '--acceptance', 'works']);
    for (const [id, pr] of [['T1', '7'], ['T9', '8']]) {
      h.ok(['claim', id, '--agent', 'worker']);
      h.ok(['submit', id, '--sha', h.sha, '--pr', pr, '--agent', 'worker']);
      for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, id, '--agent', 'orchestrator']);
      h.reviewer(id, 'reviewer');
      h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
      h.ok(['accept', id, '--agent', 'orchestrator']);
    }
    h.git(['switch', 'main']);
    fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
    h.git(['add', 'README.md']);
    h.git(['commit', '-qm', 'advance main']);
    const merged = h.github();
    merged.prs['7'].state = 'MERGED';
    merged.prs['7'].mergeCommit = { oid: h.sha };
    h.saveGithub(merged);
  });
  try {
    h.consume();
    assert.ok(h.logs().some((e) => e.task === 'T1' && e.cmd === 'merge' && e.detail.ok));
    assert.ok(h.json(['status']).gate_queue.queued.some((q) => q.id === 'T9'), 'the suite remains queued after the original notification becomes ineligible');
    assert.equal(h.logs().some((e) => e.task === 'T9' && e.cmd === 'head check'), false);
  } finally {
    await finish();
  }
  assert.ok(h.logs().some((e) => e.task === 'T9' && e.cmd === 'head check' && e.detail.ok));
  assert.ok(h.logs().some((e) => e.task === 'T9' && e.cmd === 'merge' && e.detail.ok), 'the releasing executors drain the next suite without another notification');
});

for (const reaction of ['review dispatch', 'body findings', 'accepted merge', 'merge suite', 'current local CI']) {
  test(`${reaction} takes an executor only if a software gate is needed`, async (t) => {
    const h = refillFixture(t);
    for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
    const github = h.github();
    github.ci[h.sha] = 'success';
    h.saveGithub(github);
    const finish = await busyExecutors(h, () => {
      if (reaction === 'current local CI') h.ok(['project', 'set', '--ci-local',
        JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 30 })]);
      h.submit();
      for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
      if (reaction !== 'review dispatch') {
        h.reviewer('T1', 'reviewer');
        h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha,
          ...(reaction === 'body findings'
            ? ['--fail', '--summary', 'PR body: false claim about validation', '--findings',
              JSON.stringify([{ kind: 'false-claim', path: 'PR body', claim: 'false claim about validation' }])]
            : ['--ok']), '--agent', 'reviewer']);
      }
      if (['accepted merge', 'merge suite'].includes(reaction)) h.ok(['accept', 'T1', '--agent', 'orchestrator']);
      if (reaction === 'merge suite') {
        h.git(['switch', 'main']);
        fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
        h.git(['add', 'README.md']);
        h.git(['commit', '-qm', 'advance main']);
      }
    });
    try {
      h.ok(['project', 'set', '--paused', '']);
      // Native submitters request reviewer dispatch explicitly; record a tracked exit.
      if (reaction === 'review dispatch') {
        S.withLock(h.state, () => {
          const at = new Date().toISOString();
          const detail = { role: 'worker', agent: 'worker', pid: 99999999 };
          fs.appendFileSync(path.join(h.state, 'events.jsonl'), [
            { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail },
            { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { ...detail, code: 0 } },
          ].map((e) => `${JSON.stringify(e)}\n`).join(''));
        });
      }
      const before = h.logs().filter((e) => e.cmd === 'check tests').length;
      const ciBefore = h.logs().filter((e) => e.cmd === 'check ci').length;
      h.consume();
      const log = h.logs();
      const own = log.filter((e) => e.task === 'T1' && e.cmd === 'automation');
      assert.ok(own.some((e) => e.detail.phase === 'running' && e.detail.executor === false), 'a task reservation starts without an executor');
      assert.equal(log.filter((e) => e.cmd === 'check tests').length, before, 'held executors prevent any new suite');
      const queue = h.json(['status']).gate_queue;
      assert.deepEqual(queue.running.sort(), ['T5', 'T6', 'T7', 'T8']);
      if (reaction === 'merge suite') {
        assert.ok(queue.queued.some((q) => q.id === 'T1'), 'a discovered merge suite joins the gate queue');
        assert.ok(own.some((e) => e.detail.phase === 'queued'));
        assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
      } else {
        assert.equal(queue.queued.some((q) => q.id === 'T1'), false, 'fast reactions stay out of the gate queue');
        if (reaction === 'review dispatch') assert.ok(log.some((e) => e.task === 'T1' && e.cmd === 'spawn' && e.detail.role === 'reviewer'));
        if (reaction === 'body findings') {
          assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
          h.ok(['accept', 'T1', '--agent', 'orchestrator']);
          assert.ok(h.logs().some((e) => e.task === 'T1' && e.cmd === 'spawn' && e.detail.role === 'reviewer'),
            'an explicit body correction check dispatches while gate executors are occupied');
          assert.equal(h.json(['status']).gate_queue.running.includes('T1'), false);
        }
        if (reaction === 'accepted merge') assert.ok(log.some((e) => e.task === 'T1' && e.cmd === 'merge' && e.detail.ok));
        if (reaction === 'current local CI') assert.equal(log.filter((e) => e.cmd === 'check ci').length, ciBefore);
      }
    } finally {
      await finish();
    }
    if (reaction === 'merge suite') {
      assert.ok(h.logs().some((e) => e.task === 'T1' && e.cmd === 'head check' && e.detail.ok), 'queued suite runs once an executor is free');
      assert.ok(h.logs().some((e) => e.task === 'T1' && e.cmd === 'merge' && e.detail.ok));
    }
  });
}

test('a fast reservation serializes its task and queues a gate whose inputs move during PR inspection', async (t) => {
  const h = refillFixture(t);
  for (const id of ['T2', 'T3', 'T4']) h.ok(['task', 'update', id, '--status', 'cancelled']);
  const finish = await busyExecutors(h, () => {
    const github = h.github();
    github.ci[h.sha] = 'success';
    h.saveGithub(github);
    h.submit();
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1', '--agent', 'orchestrator']);
  });
  const inspecting = path.join(h.base, 'inspecting-pr');
  const resume = path.join(h.base, 'resume-pr');
  const hook = path.join(h.base, 'hold-pr.js');
  fs.writeFileSync(hook, `
const C = require(${JSON.stringify(path.resolve(__dirname, '../lib/gates/common'))});
const run = C.gh;
C.gh = async (ctx, args, opts) => {
  if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7'
    && !require('node:fs').existsSync(${JSON.stringify(inspecting)})) {
    require('node:fs').writeFileSync(${JSON.stringify(inspecting)}, '');
    await require(${JSON.stringify(path.join(__dirname, 'signals'))}).fileWritten(${JSON.stringify(resume)});
  }
  return run(ctx, args, opts);
};
`);
  let child;
  const host = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { pre: ['--require', hook], onSpawn: (c) => { child = c; } });
  try {
    await fileWritten(inspecting, { alive: child });
    const receipt = h.logs().findLast((e) => e.cmd === 'automation' && e.task === 'T1');
    assert.equal(receipt.detail.phase, 'running');
    assert.equal(receipt.detail.executor, false);
    assert.deepEqual(h.json(['status']).gate_queue.running.sort(), ['T5', 'T6', 'T7', 'T8']);
    assert.deepEqual(h.json(['inbox', '--agent', 'orchestrator']).executors.map((e) => e.task).sort(),
      ['T5', 'T6', 'T7', 'T8'], 'inbox counts only gate executors while the fast reaction holds its task');
    h.ok(['project', 'set', '--clean-cmd', 'node -e "process.exit(0)"']);
    h.consume();
    assert.ok(h.json(['status']).gate_queue.blocked.some((q) => q.id === 'T1'), 'another reaction waits for the task reservation');
    assert.equal(h.logs().filter((e) => e.cmd === 'automation' && e.task === 'T1' && e.detail.phase === 'running').length, 1);
    fs.writeFileSync(resume, '');
    await host;
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation' && e.task === 'T1').detail.phase, 'queued');
    assert.ok(h.json(['status']).gate_queue.queued.some((q) => q.id === 'T1'));
    assert.equal(h.logs().filter((e) => e.cmd === 'check clean' && e.task === 'T1').length, 1, 'the moved gate waits for an executor');
  } finally {
    fs.writeFileSync(resume, '');
    await host;
    await finish();
  }
  assert.equal(h.logs().filter((e) => e.cmd === 'check clean' && e.task === 'T1').length, 2, 'the queued gate runs after an executor frees');
});
