'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const { waitUntil } = require('./signals');
const { ROOT, cachedFixture, dispatch, pinRung } = require('./helpers');
const { setup } = require('./automation-helpers');
const Runtime = require('../lib/runtime');

function submitted(t) {
  const h = cachedFixture(t, 'runtime-submission', repo => {
    const h = setup(null, { repo, ci: 'pending' });
    h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', 'node -e "process.exit(0)"']);
    h.submit();
    return { sha: h.sha };
  });
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = opts => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], opts);
  const source = h.logs().findLast(e => e.cmd === 'submit').id;
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
    id: `queued-${source}`, at: new Date().toISOString(), cmd: 'automation queued', agent: 'orchestrator',
    task: 'T1', detail: { source },
  }) + '\n');
  return h;
}

function toolCopy(h) {
  const root = path.join(h.state, 'homes', 'worker-exited', 'tool');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  return root;
}

function copiedCli(h, root) {
  const preload = path.join(h.base, 'runtime-cli.js');
  fs.writeFileSync(preload, `const M = require('node:module'), resolve = M._resolveFilename;
M._resolveFilename = function(request, parent, main, options) {
  if (main) request = ${JSON.stringify(path.join(root, 'bin', 'tower-crane.js'))};
  return resolve.call(this, request, parent, main, options);
};`);
  return ['--require', preload];
}

for (const force of [false, true]) {
  test(`an exited worker's tool copy ${force ? 'removed before' : 'kept during'} a supervisor gate drain`, async t => {
    const h = submitted(t);
    const root = toolCopy(h);
    const ready = path.join(h.base, 'runtime-ready');
    const release = path.join(h.base, 'runtime-release');
    const releaseLauncher = Runtime.hold(root);
    const sourceSpawn = pid => fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      id: `source-${pid}`, at: new Date().toISOString(), cmd: 'spawn', agent: 'orchestrator', task: null,
      detail: { agent: 'worker-exited', role: 'small', pid, ...require('../lib/processes').identity(pid) },
    }) + '\n');
    sourceSpawn(process.pid);
    pinRung(h, 'small', { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });
    const pruneFinish = path.join(h.base, 'prune-finish');
    const pruneHarness = path.join(h.base, 'prune-harness.js');
    fs.writeFileSync(pruneHarness, `require(${JSON.stringify(path.join(__dirname, 'signals.js'))})
      .fileWritten(${JSON.stringify(pruneFinish)}, { check: () => true });`);
    pinRung(h, 'easy', { harness: 'command', command: [process.execPath, pruneHarness, '{prompt}'] });
    const run = dispatch(t, h, {
      args: ['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'],
      pre: ['--require', path.join(__dirname, 'fixtures', 'runtime-prune.js')],
      env: { RUNTIME_COPY: root, RUNTIME_READY: ready, RUNTIME_RELEASE: release },
    });
    try {
      await run.signal(ready);
      sourceSpawn(2147483647);
      releaseLauncher();
      h.ok(['task', 'add', '--title', 'Prune stale homes', '--acceptance', 'prune', '--tier', 'easy']);
      h.ok(['brief', 'set', 'T2', '-'], { input: '# Prune\n' });
      h.ok(['spawn', '--task', 'T2']);
      if (!force) assert.equal(fs.existsSync(root), true, 'the live supervisor keeps its source home after the source worker exited');
      if (force) fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } finally {
      releaseLauncher();
      fs.writeFileSync(release, 'go');
    }
    const result = await run.run;
    assert.equal(result.code, 0, result.stderr);
    const task = h.readState('tasks.json').tasks[0];
    if (force) {
      assert.equal(task.evidence.some(e => e.type === 'tests'), false, 'a missing root takes no gate');
      assert.ok(h.json(['status']).gate_queue.queued.some(e => e.id === 'T1'), 'the original reaction is still owed');
      const healthy = h.consume();
      assert.equal(healthy.code, 2, healthy.stderr);
    }
    assert.ok(h.readState('tasks.json').tasks[0].evidence.some(e => e.type === 'tests' && e.ok));
    assert.equal(h.logs().some(e => e.cmd === 'rework' && e.task === 'T1'), false);
    h.ok(['interrupt', 'T2', '--agent', 'orchestrator']);
  });
}

for (const failure of ['gate', 'module', 'runner', 'aborted module']) {
  test(`missing engine ${failure} stays owed without a gate verdict and a healthy drain retries it`, t => {
    const h = submitted(t);
    const root = toolCopy(h);
    const gate = path.join(root, 'lib', 'gates', 'tests.js');
    if (failure === 'gate') fs.rmSync(gate);
    if (failure.includes('module')) {
      fs.writeFileSync(gate, `exports.run = async () => {
        ${failure === 'aborted module' ? 'global.runtimeAbort.abort();' : ''}
        require('../generated-conflicts');
      };\n`);
      fs.rmSync(path.join(root, 'lib', 'generated-conflicts.js'));
    }
    if (failure === 'runner') {
      // A containment runner can disappear between preflight and exec.
      fs.writeFileSync(gate, `exports.run = async ctx => {
        const r = await ctx.exec(process.execPath, [${JSON.stringify(path.join(root, 'lib', 'containment-runner.js'))}]);
        return {ok: r.status === 0, summary: r.stderr};
      };`);
      fs.rmSync(path.join(root, 'lib', 'containment-runner.js'));
    }
    const pre = copiedCli(h, root);
    if (failure === 'aborted module') {
      fs.appendFileSync(pre[1], `const automation = require(${JSON.stringify(path.join(root, 'lib', 'automation.js'))});
const consume = automation.consume;
global.runtimeAbort = new AbortController();
automation.consume = (ctx, ...args) => consume({ ...ctx, automationSignal: global.runtimeAbort.signal }, ...args);
`);
    }
    const clock = path.join(h.base, 'retry-clock');
    fs.writeFileSync(clock, String(Date.now()));
    const hooks = { HOOK_CLOCK_FILE: clock };
    const runBroken = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], { pre, hooks });
    const broken = runBroken();
    assert.ok([1, 2].includes(broken.code), broken.stderr);
    const receipts = h.logs().filter(e => e.cmd === 'automation' && e.detail.phase === 'infrastructure');
    assert.ok(receipts.length, broken.stderr);
    assert.ok(receipts.every(e => e.detail.infrastructure_failure));
    const starts = () => h.logs().filter(e => e.cmd === 'automation' && e.detail.phase === 'running').length;
    const before = starts();
    runBroken();
    runBroken();
    assert.equal(starts(), before, 'same-root drains and fresh reconcile sources cannot reserve during the retry delay');
    assert.equal(receipts.at(-1).detail.infrastructure.root, root);
    fs.writeFileSync(clock, String(receipts.at(-1).detail.infrastructure.until));
    runBroken();
    assert.equal(starts(), before + 1, 'expiry allows one retry, then the new receipt holds the runtime again');
    assert.equal(h.readState('tasks.json').tasks[0].evidence.some(e => e.type === 'tests'), false);
    assert.equal(h.logs().some(e => e.cmd === 'rework'), false);
    assert.ok(h.json(['status']).gate_queue.queued.some(e => e.id === 'T1'));
    const healthy = h.consume({ hooks });
    assert.equal(healthy.code, 2, healthy.stderr);
    assert.ok(h.readState('tasks.json').tasks[0].evidence.some(e => e.type === 'tests' && e.ok));
  });
}

for (const kind of ['controller', 'keeper']) {
  test(`a live ${kind} keeps an exited agent's snapshot through pruning`, {
    skip: kind === 'keeper' && process.platform !== 'linux',
  }, async t => {
    const h = submitted(t);
    const root = toolCopy(h);
    let child;
    if (kind === 'controller') {
      child = h.spawnCli(['wait', '--observe', '--types', 'never', '--follow'], { pre: copiedCli(h, root) });
    } else {
      const fields = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].trim().split(/\s+/);
      const state = { rows: [{ pid: process.pid, start: fields[19] }],
        limits: { tasks_max: Number.MAX_SAFE_INTEGER, memory_max_bytes: Number.MAX_SAFE_INTEGER } };
      child = cp.spawn(process.execPath, [path.join(root, 'lib', 'containment-keeper.js'), JSON.stringify(state)], { stdio: 'ignore' });
    }
    const ended = once(child, 'close');
    try {
      await waitUntil(() => Runtime.inUse(root), { paths: [h.base], alive: () => child.exitCode === null,
        what: `the ${kind} holds its snapshot` });
      h.ok(['task', 'add', '--title', 'Prune stale homes', '--acceptance', 'prune', '--tier', 'easy']);
      h.ok(['brief', 'set', 'T2', '-'], { input: '# Prune\n' });
      pinRung(h, 'easy', { harness: 'command', command: [process.execPath, '-e', 'process.exit(0)', '{prompt}'] });
      h.ok(['spawn', '--task', 'T2', '--wait']);
      assert.equal(fs.existsSync(path.join(root, 'lib', 'automation.js')), true);
    } finally {
      child.kill('SIGKILL');
      await ended;
    }
    assert.equal(Runtime.inUse(root), false, 'the exited user no longer holds the copy');
  });
}

test('runtime missing-code classification excludes project and external modules', () => {
  for (const [error, expected] of [
    [new Error('gate not installed: tests (lib/gates/tests.js is missing; update tower-crane)'), true],
    [new Error(`Cannot find module '${path.join(ROOT, 'lib', 'containment-runner.js')}'`), true],
    [Object.assign(new Error("Cannot find module './generated-conflicts'"), { requireStack: [path.join(ROOT, 'lib', 'automation.js')] }), true],
    [Object.assign(new Error("Cannot find module './app'"), { requireStack: [path.join(ROOT, '..', 'project', 'index.js')] }), false],
    [Object.assign(new Error("Cannot find module 'external'"), { requireStack: [path.join(ROOT, 'lib', 'automation.js')] }), false],
    [new Error('resource-scope-failed: no user manager'), false],
    [new Error('tests failed'), false],
  ]) assert.equal(Runtime.missing(error), expected, error.message);
});

test('a live wait does not retry missing engine code on its own fs.watch receipts', async t => {
  const h = submitted(t);
  const root = toolCopy(h);
  const counter = path.join(h.base, 'drain-passes');
  const clock = path.join(h.base, 'retry-clock');
  fs.writeFileSync(clock, String(Date.now()));
  const child = h.spawnCli(['wait', '--after', '0', '--types', 'never', '--follow', '--agent', 'orchestrator'], {
    pre: [...copiedCli(h, root), '--require', path.join(__dirname, 'fixtures', 'runtime-wake.js')],
    env: { RUNTIME_WAKE_ROOT: root, RUNTIME_WAKE_COUNTER: counter }, hooks: { HOOK_CLOCK_FILE: clock },
  });
  const ended = once(child, 'close');
  const passes = () => fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  const completed = count => waitUntil(() => passes() >= count, { paths: [h.base],
    alive: () => child.exitCode === null, what: `wait completed ${count} drains` });
  try {
    await completed(1);
    for (let i = 0; i < 3; i++) {
      const next = passes() + 1;
      h.ok(['task', 'note', 'T1', `wake ${i}`]);
      await completed(next);
    }
    assert.equal(h.logs().filter(e => e.cmd === 'automation' && e.detail.phase === 'running').length, 1);
    assert.equal(h.logs().filter(e => e.cmd === 'automation' && e.detail.phase === 'infrastructure').length, 1);
    assert.equal(h.logs().filter(e => e.cmd === 'automation').length, 2, 'wakeups append no extra reaction receipts');
    assert.ok(h.json(['status']).gate_queue.queued.some(e => e.id === 'T1'));
  } finally {
    child.kill('SIGKILL');
    await ended;
  }
  assert.equal(h.consume({ hooks: { HOOK_CLOCK_FILE: clock } }).code, 2);
  assert.ok(h.readState('tasks.json').tasks[0].evidence.some(e => e.type === 'tests' && e.ok));
});

test('runtime holds retain live controllers and discard exited users', async t => {
  const h = submitted(t);
  const root = toolCopy(h);
  const release = Runtime.hold(root);
  assert.equal(Runtime.inUse(root), true);
  release();
  assert.equal(Runtime.inUse(root), false);
  const child = h.spawnCli(['status']);
  const ended = once(child, 'close');
  Runtime.hold(root, child.pid);
  await ended;
  assert.equal(Runtime.inUse(root), false);
});
