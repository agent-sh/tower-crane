'use strict';

const { waitOnRepo, childExit, killPid } = require('./signals');
const StateFiles = require('./state-files');
const { readPublished } = require('./atomic-file');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, cachedFixture, BIN, HOOKS, runPty, PTY_AVAILABLE, detachedAlive } = require('./helpers');

const PRIVATE_LOG = 'prompt: synthetic private instruction\ncredential: synthetic-secret-for-recovery-test';

function assertNoLogText(h) {
  for (const file of ['tasks.json', 'events.jsonl']) {
    const text = fs.readFileSync(path.join(h.state, file), 'utf8');
    for (const line of PRIVATE_LOG.split('\n')) assert.ok(!text.includes(line), `${file} contains log text`);
    assert.ok(!text.includes('last diagnostic before exit'), `${file} contains a log diagnostic`);
  }
}

function setup(t) {
  const h = cachedFixture(null, 'task', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Recover a worker', '--tier', 'easy', '--acceptance', 'exit is reported']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
  });
  h.stopWorkers = [];
  // Windows holds directories open while a worker still uses them.
  t.after(async () => {
    for (const stop of h.stopWorkers) stop();
    await h.cleanup();
  });
  return h;
}

// lifetimeMs ends the stand-in on its own after that long, leaving a .natural
// file beside its marker, so a test can tell that end from being stopped.
async function start(t, h, { claim = true, submit = false, wait = false, env = {}, lifetimeMs = 0 } = {}) {
  const marker = path.join(h.base, `started-${Date.now()}.json`);
  const worker = path.join(h.base, 'worker.js');
  const ending = lifetimeMs ? `setTimeout(() => { fs.writeFileSync(process.argv[3] + '.natural', ''); process.exit(0); }, ${lifetimeMs});` : 'setInterval(() => {}, 1000);'; // wait-allow: the stand-in's own end, which a test tells apart from being stopped
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const task = process.env.TOWER_CRANE_TASK;
${claim ? "cp.execFileSync(process.execPath, [process.argv[2], 'claim', task]);" : ''}
fs.writeSync(1, Array.from({ length: 30 }, (_, i) => 'progress ' + i).join('\\n') + '\\n');
fs.writeSync(2, 'last diagnostic before exit\\n');
fs.writeSync(2, ${JSON.stringify(PRIVATE_LOG + '\n')});
${submit ? "cp.execFileSync(process.execPath, [process.argv[2], 'submit', task, '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);" : ''}
fs.writeFileSync(process.argv[3] + '.tmp', JSON.stringify({ agent: process.env.TOWER_CRANE_AGENT, pid: process.pid }));
fs.renameSync(process.argv[3] + '.tmp', process.argv[3]);
${wait ? 'process.exit(7);' : ending}
`;
  fs.writeFileSync(worker, script);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, BIN, marker, '{prompt}']),
    '--clear', 'profile', '--clear', 'effort']);
  if (wait) return h.run(['spawn', '--role', 'easy', '--task', 'T1', '--wait']);
  const spawned = h.json(['spawn', '--task', 'T1'], { env });
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { killPid(spawned.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  h.stopWorkers.push(kill);
  const started = await waitOnRepo(h, () => fs.existsSync(marker) && JSON.parse(readPublished(marker, 'utf8')),
    'stand-in did not claim the task');
  assert.deepEqual(started, { agent: spawned.agent, pid: spawned.pid });
  return { ...spawned, kill, marker };
}

test('a killed spawned claimant is reported with its log tail and released for recovery', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  const events = () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const event = events().find((e) => e.cmd === 'spawn');
  assert.equal(event.detail.pid, spawned.pid);
  assert.equal(event.detail.log, spawned.log);
  assert.equal(event.detail.role, 'worker');
  assert.equal(event.detail.rung, 'easy');
  assert.equal(spawned.rung, 'easy');
  assert.doesNotMatch(h.ok(['status']), /exited without submit/);
  assert.doesNotMatch(h.ok(['ready']), /exited without submit/);
  assert.equal(h.run(['release', 'T1', '--reason', 'recover live worker', '--agent', 'another-worker']).code, 1);

  spawned.kill();
  await waitOnRepo(h, () => (h.json(['status']).exited_claims || []).length === 1, 'killed spawned claimant was not reported');
  await waitOnRepo(h, () => events().some((e) => e.cmd === 'spend' && e.detail.source === `spawn:${spawned.agent}`), 'exit usage was not collected');
  const before = StateFiles.logText(h.state);
  for (const args of [['status'], ['ready'], ['ready', '--all']]) {
    const data = h.json(args);
    assert.equal(data.exited_claims.length, 1);
    const exit = data.exited_claims[0];
    assert.deepEqual({ id: exit.id, agent: exit.agent, pid: exit.pid, log: exit.log },
      { id: 'T1', agent: spawned.agent, pid: spawned.pid, log: spawned.log });
    assert.match(exit.tail, /last diagnostic before exit/);
    assert.ok(exit.tail.includes(PRIVATE_LOG));
    assert.match(exit.tail, /progress 29/);
    assert.doesNotMatch(exit.tail, /progress 0\n/);
    assert.ok(exit.tail.split('\n').length <= 20);
    const text = h.ok(args);
    assert.match(text, /exited without submit/);
    assert.ok(text.includes(spawned.log), text);
    assert.match(text, /last diagnostic before exit/);
    assert.match(text, /tower-crane release T1 --reason/);
    assert.doesNotMatch(text, /--agent owner/);
    const workerText = h.ok([...args, '--agent', 'orchestrator']);
    assert.match(workerText, /tower-crane release T1 --reason/);
    assert.doesNotMatch(workerText, /--agent owner/);
    assert.deepEqual(data.ready, [], 'the claim stays held until release or lease expiry');
  }
  assert.equal(StateFiles.logText(h.state), before, 'views do not change state');
  assertNoLogText(h);

  const released = h.json(['release', 'T1', '--reason', 'recover killed worker', '--agent', 'another-worker']);
  assert.equal(released.status, 'todo');
  assert.equal(released.claim, null);
  assert.ok(released.notes.some((n) => n.text.includes('recover killed worker')));
  assert.ok(released.notes.some((n) => n.text.includes(spawned.log) && n.text.includes(String(spawned.pid))));
  assert.deepEqual(events().find((e) => e.cmd === 'release').detail.exited_spawn, {
    pid: spawned.pid, log: spawned.log, code: process.platform === 'win32' ? 1 : null, size: fs.statSync(spawned.log).size,
  });
  assertNoLogText(h);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).ready.map((x) => x.id), ['T1']);

  h.ok(['claim', 'T1', '--agent', spawned.agent]);
  assert.deepEqual(h.json(['status']).exited_claims, [], 'an old spawn is not attached to a new claim');
  h.ok(['release', 'T1', '--agent', spawned.agent, '--reason', 'start a replacement']);
  const replacement = await start(t, h);
  assert.notEqual(replacement.agent, spawned.agent);
  assert.deepEqual(h.json(['ready']).exited_claims, [], 'the replacement is alive');
});

test('teardown observes a monitor exit recorded after its PID snapshot', {
  skip: !['linux', 'win32'].includes(process.platform),
}, async (t) => {
  const h = setup(t);
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { child.kill(); await closed; });
  const dir = path.join(h.base, 'detached');
  fs.mkdirSync(dir);
  const file = path.join(dir, `${child.pid}.json`);
  const record = { pid: child.pid, kind: 'monitor', startTicks: '0', startTime: '0' };
  fs.writeFileSync(file, JSON.stringify(record));
  const snapshot = h.detached();
  assert.equal(snapshot[0].exited, undefined);
  // The stand-in stays alive to represent an unrelated process reusing the PID.
  fs.writeFileSync(file, JSON.stringify({ ...record, exited: true }));
  h.detached = () => snapshot;
  await h.cleanup();
  assert.equal(killPid(child.pid, 0), true, 'teardown killed a reused PID');
});

test('ordinary teardown waits for a monitor exit even when the wall clock jumps', {
  skip: process.platform === 'win32' && 'Windows teardown waits on native process handles',
}, async (t) => {
  const h = makeRepo(t);
  const ready = path.join(h.base, 'ready');
  const release = path.join(h.base, 'release');
  const child = cp.spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const watcher = fs.watch(${JSON.stringify(h.base)}, () => {
      if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
    });
    fs.writeFileSync(${JSON.stringify(ready)}, '');
  `], { detached: true, stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  await waitOnRepo(h, () => fs.existsSync(ready), 'monitor did not start');
  const dir = path.join(h.base, 'detached');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, kind: 'monitor' }));
  let clock = 0;
  const now = t.mock.method(Date, 'now', () => (clock += 20000));
  try {
    const cleaned = h.cleanup();
    queueMicrotask(() => fs.writeFileSync(release, ''));
    await cleaned;
    await closed;
    assert.equal(child.exitCode, 0, 'ordinary teardown observes natural completion');
  } finally {
    now.mock.restore();
  }
});

test('teardown kills a recorded worker and leaves a reused worker PID alone', {
  skip: !['linux', 'win32'].includes(process.platform),
}, async (t) => {
  const h = setup(t);
  const dir = path.join(h.base, 'detached');
  fs.mkdirSync(dir);
  const children = [];
  const start = (record) => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', resolve));
    children.push({ child, closed });
    let startTicks = '0';
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      startTicks = record.genuine ? stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] : '0';
    }
    fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({
      pid: child.pid, kind: 'worker', startTicks, recordedAt: record.recordedAt ?? Date.now(),
    }));
    return child;
  };
  t.after(async () => {
    for (const { child, closed } of children) {
      child.kill();
      await closed;
    }
  });
  // Recorded right after its start, as the spawning parent records a worker.
  const recorded = start({ genuine: true });
  // Started after its record was written, as a process reusing an exited worker's PID would.
  const reused = start({ recordedAt: Date.now() - 1000 });
  await h.cleanup();
  await childExit(recorded, { what: `teardown did not kill recorded worker ${recorded.pid}` });
  assert.equal(killPid(reused.pid, 0), true, 'teardown killed a reused worker PID');
});

test('teardown waits for OS termination after a monitor marks its exit', async (t) => {
  const h = setup(t);
  const dir = path.join(h.base, 'detached');
  fs.mkdirSync(dir);
  const start = path.join(h.base, 'exit-start');
  const marked = path.join(h.base, 'exit-marked');
  const monitor = path.join(h.base, 'spawn-monitor.js');
  fs.writeFileSync(monitor, `
const fs = require('node:fs');
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: probe cadence of the loops below
process.once('exit', () => {
  fs.writeFileSync(${JSON.stringify(marked)}, '');
  const deadline = Date.now() + 30000; // wait-allow: hold an exit listener alive to exercise native-process teardown
  while (Date.now() < deadline) sleep();
});
const deadline = Date.now() + 300000;
while (!fs.existsSync(${JSON.stringify(start)}) && Date.now() < deadline) sleep();
process.exit(0);
`);
  const child = cp.spawn(process.execPath, ['--require', HOOKS, monitor], {
    detached: true, stdio: 'ignore', env: { ...h.env, HOOK_PROCESSES_DIR: dir },
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  const record = { pid: child.pid, kind: 'monitor' };
  if (process.platform === 'win32') record.startTime = require('./windows-process').startTime(child.pid);
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    record.startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  }
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify(record));
  fs.writeFileSync(start, '');
  await waitOnRepo(h, () => fs.existsSync(marked), 'monitor did not reach its exit listener');
  assert.equal(h.detached()[0].exited, true);
  assert.equal(child.kill(0), true, 'monitor must still be running inside the exit listener');
  if (process.platform === 'win32') await h.cleanup();
  else {
    await assert.rejects(h.cleanup({ monitorGraceMs: 10000 }), /detached usage monitors outlived test teardown/); // wait-allow: the held exit listener must exceed teardown's observation grace
    await closed;
  }
  assert.equal(child.kill(0), false, 'cleanup returned before the original monitor terminated');
  assert.equal(detachedAlive(record), false, 'a terminated monitor must be observable as stopped');
});

test('submitted workers and claims without a matching spawn are not reported', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h, { submit: true });
  spawned.kill();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);

  h.ok(['task', 'add', '--title', 'Manual worker', '--acceptance', 'claim stays held']);
  h.ok(['claim', 'T2', '--agent', 'manual']);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);
});

test('foreground exits without submit are reported from their recorded exit', async (t) => {
  const h = setup(t);
  const result = await start(t, h, { wait: true });
  assert.equal(result.code, 7, result.stderr);
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const exitEvent = events.find((e) => e.cmd === 'spawn exit');
  assert.equal(exitEvent.detail.role, 'worker');
  assert.equal(exitEvent.detail.rung, 'easy');
  for (const args of [['status'], ['ready']]) {
    const exits = h.json(args).exited_claims;
    assert.equal(exits.length, 1);
    assert.equal(exits[0].agent, 'worker-T1-1');
    assert.equal(exits[0].log, events.find((e) => e.cmd === 'spawn').detail.log);
    assert.match(h.ok(args), /last diagnostic before exit/);
  }
  const spawned = events.find((e) => e.cmd === 'spawn').detail;
  h.ok(['release', 'T1', '--reason', 'recover foreground worker']);
  const release = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse)
    .find((e) => e.cmd === 'release');
  assert.deepEqual(release.detail.exited_spawn, {
    pid: spawned.pid, log: spawned.log, code: 7, size: fs.statSync(spawned.log).size,
  });
  assertNoLogText(h);
});

// Linux and Windows stop a process outside the group that holds the output;
// other systems only close the pipes.
const TRACES_HOLDERS = ['linux', 'win32'].includes(process.platform);

// A harness stand-in that leaves processes behind and exits. holder: a process
// in a session of its own (outside the process group the monitor stops; Windows
// has no group at all) that inherits the harness output, like a dev server or
// a watcher. Its own end, a minute away, bounds the run when nothing stops it.
// member: a process in the group that inherits the output and ignores SIGTERM.
// bystander: a process outside the group that does not hold the output.
// nested: the harness dispatches T2 before it exits, as an orchestrator does;
// 'wait' leaves that dispatch running as a detached spawn --wait, the
// supervisor's parent, outside the group.
function leaver(h, { holder = false, member = false, bystander = false, nested = false, env = {} } = {}) {
  const files = { holder: path.join(h.base, 'holder.json'), member: path.join(h.base, 'member.json'),
    bystander: path.join(h.base, 'bystander.json'), nested: path.join(h.base, 'nested.json'), finish: path.join(h.base, 'nested.finish') };
  const child = (signals) => `
const fs = require('node:fs');
${signals ? "process.on('SIGTERM', () => {});" : ''}
fs.writeSync(1, 'child started\\n');
fs.writeFileSync(process.argv[1] + '.tmp', JSON.stringify({ pid: process.pid }));
fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);
setTimeout(() => { fs.writeFileSync(process.argv[1] + '.natural', ''); process.exit(0); }, 60000); // wait-allow: the child's own end bounds a run that nothing stops
`;
  const worker = path.join(h.base, 'leaver.js');
  fs.writeFileSync(worker, `
const fs = require('node:fs');
const cp = require('node:child_process');
const [bin, files] = [process.argv[2], JSON.parse(process.argv[3])];
cp.execFileSync(process.execPath, [bin, 'claim', process.env.TOWER_CRANE_TASK]);
const start = (file, script, options) => {
  cp.spawn(process.execPath, ['-e', script, file], { windowsHide: true, ...options }).unref();
  while (!fs.existsSync(file)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: the harness exits only once its children run
};
if (${!!nested}) {
  const env = { ...process.env, TOWER_CRANE_AGENT: 'orchestrator' };
  for (const key of ['TOWER_CRANE_TASK', 'TOWER_CRANE_HOOK', 'TOWER_CRANE_SESSION']) delete env[key];
  if (${JSON.stringify(nested)} === 'wait') {
    cp.spawn(process.execPath, [bin, 'spawn', '--role', 'medium', '--task', 'T2', '--wait'], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    cp.execFileSync(process.execPath, [bin, 'spawn', '--role', 'medium', '--task', 'T2', '--json'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  while (!fs.existsSync(files.nested)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: the nested harness reports its pid
}
if (${holder}) start(files.holder, ${JSON.stringify(child(false))}, { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
if (${member}) start(files.member, ${JSON.stringify(child(true))}, { stdio: ['ignore', 'inherit', 'inherit'] });
if (${bystander}) start(files.bystander, ${JSON.stringify(child(false))}, { detached: true, stdio: 'ignore' });
fs.writeSync(1, 'harness done\\n');
`);
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, BIN, JSON.stringify(files), '{prompt}']),
    '--clear', 'profile', '--clear', 'effort']);
  if (nested) {
    const inner = path.join(h.base, 'nested.js');
    fs.writeFileSync(inner, `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ pid: process.pid }));
fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
setInterval(() => { if (fs.existsSync(process.argv[3])) { fs.writeSync(1, 'nested done\\n'); process.exit(0); } }, 25); // wait-allow: the nested harness runs until the test lets it end
`);
    h.ok(['task', 'add', '--title', 'Nested task', '--tier', 'medium', '--acceptance', 'runs beside T1']);
    h.ok(['brief', 'set', 'T2', '-'], { input: 'Work on T2.\n' });
    h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, inner, files.nested, files.finish, '{prompt}']),
      '--clear', 'profile', '--clear', 'effort']);
  }
  h.stopWorkers.push(() => {
    fs.writeFileSync(files.finish, '');
    for (const file of [files.holder, files.member, files.bystander]) {
      if (!fs.existsSync(file)) continue;
      try { killPid(JSON.parse(readPublished(file, 'utf8')).pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
  });
  const pid = (file) => JSON.parse(readPublished(file, 'utf8')).pid;
  const result = h.run(['spawn', '--role', 'easy', '--task', 'T1', '--wait'], { env });
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const exit = events.findLast((e) => e.cmd === 'spawn exit' && e.task === 'T1');
  return { result, files, pid, events, exit };
}

test('a descendant that keeps the harness output open is stopped and spawn --wait finishes', async (t) => {
  const h = setup(t);
  const { result, files, pid, exit } = leaver(h, { holder: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(files.holder + '.natural'), false, 'spawn --wait waited for the holder to end on its own');
  assert.match(result.stdout, /child started/);
  assert.match(result.stdout, /harness done/);
  assert.match(result.stderr, /output stayed open/, JSON.stringify({ stdout: result.stdout, exit: exit.detail }));
  assert.equal(exit.detail.code, 0);
  if (TRACES_HOLDERS) {
    assert.equal(detachedAlive({ pid: pid(files.holder) }), false, 'the descendant holding the output still runs');
    assert.deepEqual(exit.detail.output_held.pids, [pid(files.holder)]);
  } else {
    // Nothing outside the group is claimed stopped where none can be traced.
    assert.deepEqual(exit.detail.output_held.pids, []);
  }
});

test('a group member that ignores SIGTERM is not an output holder, and processes outside the group stay', {
  skip: process.platform === 'win32' && 'POSIX process groups',
}, async (t) => {
  const h = setup(t);
  // The member outlives the harness by the five-second group grace and then a
  // second more, so the group is still there when that grace ends.
  const hook = path.join(__dirname, 'fixtures', 'slow-group-kill.js').replace(/\\/g, '/');
  const { result, files, pid, exit } = leaver(h, { member: true, bystander: true,
    env: { NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_SLOW_GROUP_KILL: '1000' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(files.member + '.natural'), false, 'the group member ended on its own');
  assert.equal(detachedAlive({ pid: pid(files.member) }), false, 'SIGKILL did not reach the group member');
  assert.doesNotMatch(result.stderr, /output stayed open/);
  assert.equal(exit.detail.output_held, undefined);
  assert.equal(detachedAlive({ pid: pid(files.bystander) }), true, 'a process that held no output was stopped');
});

for (const nested of [true, 'wait']) {
test(`a task an agent dispatches survives the output release of the agent that started it${nested === 'wait' ? ', with its dispatch left running' : ''}`, async (t) => {
  const h = setup(t);
  const { result, files, pid, events, exit } = leaver(h, { holder: true, nested });
  assert.equal(result.code, 0, result.stderr);
  const spawned = events.findLast((e) => e.cmd === 'spawn' && e.task === 'T2').detail;
  const inner = { pid: pid(files.nested), ...(process.platform === 'win32' ? {} : { startTicks: spawned.start_ticks }) };
  const why = () => JSON.stringify({ stderr: result.stderr, t1: exit.detail,
    t2: StateFiles.logText(h.state).trim().split('\n').map(JSON.parse).filter((e) => e.task === 'T2').map((e) => [e.cmd, e.detail.phase, e.detail.reason]),
    log: fs.existsSync(spawned.log) ? readPublished(spawned.log, 'utf8').slice(-2000) : null });
  assert.equal(detachedAlive(inner), true, `the nested harness was stopped: ${why()}`);
  assert.equal(detachedAlive({ pid: spawned.monitor_pid }), true, `the nested supervisor was stopped: ${why()}`);
  assert.ok(exit.detail.output_held, `no output release: ${why()}`);
  for (const stopped of exit.detail.output_held.pids) assert.ok(![inner.pid, spawned.monitor_pid].includes(stopped), JSON.stringify(exit.detail.output_held));
  fs.writeFileSync(files.finish, '');
  await waitOnRepo(h, () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse)
    .some((e) => e.cmd === 'spawn exit' && e.task === 'T2'), 'the nested task did not finish');
});
}

test('the Windows tree of an exited harness keeps only processes it started', () => {
  const { windowsTree } = require('../lib/processes');
  // Harness pid 10 ran from 1000 to 2000; pid 10 was then reused at 5000.
  const rows = [
    { pid: 11, parent: 10, start: 1500 }, // its child, still running
    { pid: 12, parent: 11, start: 3000 }, // started by that child after the harness exited
    { pid: 13, parent: 10, start: 800 }, // a child of an earlier pid 10
    { pid: 14, parent: 10, start: 5100 }, // a child of the process that reused pid 10
    { pid: 15, parent: 14, start: 5200 },
    { pid: 16, parent: 11, start: 1200 }, // names pid 11 but started before it: an earlier pid 11's child
    { pid: 17, parent: 99, start: 1600 }, // a grandchild whose parent already exited
    { pid: 18, parent: 10, start: 2050 }, // a child within the clock allowance of the observed exit
  ];
  assert.deepEqual(windowsTree(rows, 10, 1000, 2000).map((r) => r.pid), [11, 18, 12]);
  assert.deepEqual(windowsTree([], 10, 1000, 2000), []);
});

// Windows PowerShell on Windows; on Linux PowerShell 7 when it is installed
// (GitHub's Ubuntu runners have it), which runs the same script and reads
// creation times from /proc.
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe'
  : process.platform === 'linux' && cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 300000 }).status === 0 ? 'pwsh' : null;

test('the Windows stop takes one target, skips a target that is gone and leaves a reused pid alone', {
  skip: !POWERSHELL && 'no PowerShell',
}, async (t) => {
  const { windowsStop, windowsStarts, windowsProcesses } = require('../lib/processes');
  const execFile = (file, args, options, callback) => cp.execFile(POWERSHELL, args, options, callback);
  const started = [];
  t.after(() => {
    for (const child of started) {
      if (child.exitCode === null && child.signalCode === null) killPid(child.pid, 'SIGKILL');
    }
  });
  const start = () => {
    const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); // wait-allow: a process that runs until it is stopped
    started.push(child);
    return child;
  };
  // Each time comes from a PowerShell process of its own, as the snapshot's
  // does, so a reading that differs between processes fails here.
  const startTime = async (pid) => (await windowsStarts(execFile, [pid], 300000)).get(pid);
  // One target: a list PowerShell would unroll to two numbers.
  const lone = start();
  const loneStart = await startTime(lone.pid);
  assert.equal(Number.isSafeInteger(loneStart), true, `no creation time for ${lone.pid}`);
  if (process.platform === 'win32') {
    // The snapshot the stop takes its targets from reads the same time.
    assert.equal((await windowsProcesses(execFile, 300000)).find((r) => r.pid === lone.pid)?.start, loneStart);
  }
  assert.deepEqual(await windowsStop(execFile, [{ pid: lone.pid, start: loneStart }], 300000),
    [{ pid: lone.pid, outcome: 'stopped' }]);
  await childExit(lone, { signal: t.signal });
  // The last target exited before its turn; the one before it still stops.
  const kept = start();
  const gone = start();
  const goneStart = await startTime(gone.pid);
  killPid(gone.pid, 'SIGKILL');
  await childExit(gone, { signal: t.signal });
  const reused = start();
  assert.deepEqual(await windowsStop(execFile, [
    { pid: kept.pid, start: await startTime(kept.pid) },
    { pid: reused.pid, start: await startTime(reused.pid) - 5000 },
    { pid: gone.pid, start: goneStart },
  ], 300000), [
    { pid: kept.pid, outcome: 'stopped' },
    { pid: reused.pid, outcome: 'reused' },
    { pid: gone.pid, outcome: 'gone' },
  ]);
  await childExit(kept, { signal: t.signal });
  assert.equal(reused.exitCode === null && reused.signalCode === null, true, 'a pid with another creation time was stopped');
});

test('the Windows stop splits a long target list into calls that fit a Windows command line', async () => {
  const { windowsStop } = require('../lib/processes');
  const lengths = [];
  // Stands in for PowerShell: reads the targets back from the encoded script.
  const execFile = (file, args, options, callback) => {
    lengths.push([file, ...args].join(' ').length);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    const list = /^\$t = @\(([\d,]*)\)$/m.exec(script)[1].split(',');
    const out = [];
    for (let i = 0; i < list.length; i += 2) out.push(`${list[i]} gone`);
    callback(null, out.join('\n'));
  };
  // The widest pids and creation times a target can have.
  const targets = Array.from({ length: 1000 }, (_, i) => ({ pid: 4294967295 - i, start: 9999999999999 }));
  const outcomes = await windowsStop(execFile, targets, 300000);
  assert.deepEqual(outcomes, targets.map((target) => ({ pid: target.pid, outcome: 'gone' })));
  assert.ok(lengths.length > 1, 'a thousand targets went in one call');
  for (const length of lengths) assert.ok(length < 32767, `a command line of ${length} characters`);
});

test('the Windows tree of an exited harness spares a supervisor, what runs below it and its parent', () => {
  const { windowsTree } = require('../lib/processes');
  const rows = [
    { pid: 11, parent: 10, start: 1500 }, // a foreground dispatch the harness left running
    { pid: 12, parent: 11, start: 1600, supervisor: true }, // the supervisor in that dispatch's job
    { pid: 13, parent: 12, start: 1700 }, // that supervisor's harness
    { pid: 14, parent: 10, start: 1550 }, // a holder
    { pid: 15, parent: 10, start: 1560, supervisor: true }, // a supervisor the harness started itself
    { pid: 16, parent: 15, start: 1570 },
  ];
  assert.deepEqual(windowsTree(rows, 10, 1000, 2000).map((r) => r.pid), [14]);
});

test('a supervisor is known by its command line in every shape Windows shows it', () => {
  const { supervisorCommand } = require('../lib/processes');
  for (const command of [
    // As a Windows CI runner launched one.
    '"C:\\hostedtoolcache\\windows\\node\\26.12.0\\x64\\node.exe" D:\\a\\tower-crane\\tower-crane\\lib\\spawn-monitor.js D:\\a\\_temp\\tower-crane-tests\\tower-crane-EdyGw4\\repo\\.tower-crane\\cache\\spawn-1\\job.json',
    '"C:\\Program Files\\nodejs\\node.exe" --max-old-space-size=4096 "C:\\Users\\a b\\tool\\lib\\spawn-monitor.js" "C:\\Users\\a b\\job.json"',
    'node C:/tool/lib/SPAWN-MONITOR.JS job.json',
    'node spawn-monitor.js',
  ]) assert.equal(supervisorCommand(command), true, command);
  for (const command of ['node my-spawn-monitor.js', 'node spawn-monitor.jsx', 'node C:\\tool\\bin\\tower-crane.js spawn --wait', '', null]) {
    assert.equal(supervisorCommand(command), false, String(command));
  }
});

test('a launch keeps an outer gate run marker and drops an outer spawn run marker', () => {
  const { cleanAgentEnv } = require('../lib/spawn-settings');
  assert.deepEqual(cleanAgentEnv({ TOWERCRANE_SPAWN_RUN_1_ab: '1', TOWERCRANE_GATE_RUN_2_cd: '1', KEEP: 'x' }),
    { TOWERCRANE_GATE_RUN_2_cd: '1', KEEP: 'x' });
});

test('a missing log does not hide an exited claimant', async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  spawned.kill();
  fs.rmSync(spawned.log);
  await waitOnRepo(h, () => (h.json(['ready']).exited_claims || []).length === 1, 'exit was hidden by its missing log');
  const exit = h.json(['status']).exited_claims[0];
  assert.equal(exit.log, spawned.log);
  assert.match(exit.tail, /log unavailable.*ENOENT/);
  // Process death is visible before the monitor finishes writing its exit receipt.
  await waitOnRepo(h, () => h.json(['status']).exited_claims[0]?.code === (process.platform === 'win32' ? 1 : null), 'exit receipt did not arrive');
  h.ok(['release', 'T1', '--reason', 'recover worker with missing log']);
  const release = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse)
    .find((e) => e.cmd === 'release');
  assert.deepEqual(release.detail.exited_spawn, {
    pid: spawned.pid, log: spawned.log, code: process.platform === 'win32' ? 1 : null, size: null,
  });
  assertNoLogText(h);
});

test('a spawn on another host is not inferred dead from a local PID', async (t) => {
  const h = setup(t);
  const hook = path.join(h.base, 'other-host.js');
  fs.writeFileSync(hook, "const os = require('node:os');\nconst hostname = os.hostname;\nos.hostname = () => hostname() + '-other';\n");
  const spawned = await start(t, h, { env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` } });
  // A local probe cannot infer the remote PID's exit. The remote supervisor
  // records an authoritative exit after the real child finishes.
  assert.deepEqual(h.json(['status']).exited_claims, []);
  assert.deepEqual(h.json(['ready']).exited_claims, []);
  spawned.kill();
  await waitOnRepo(h, () => (h.json(['status']).exited_claims || []).length === 1, 'supervised exit was not recorded');
});

test('terminal fallback cannot release another live claim', { skip: !PTY_AVAILABLE }, async (t) => {
  const h = setup(t);
  const spawned = await start(t, h);
  const args = ['release', 'T1', '--reason', 'cancel live worker'];
  const env = { ...h.env };
  delete env.TOWER_CRANE_AGENT;
  const refused = runPty(args, { cwd: h.repo, env });
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  const result = runPty([...args, '--agent', 'owner'], { cwd: h.repo, env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'todo');
  spawned.kill();
});

test('Linux zombie and reused pid diagnostics do not mistake the process for a live worker', { skip: process.platform !== 'linux' }, async (t) => {
  const h = setup(t);
  const markerHook = path.join(__dirname, 'fixtures', 'slow-ready-marker.js').replace(/\\/g, '/');
  const spawned = await start(t, h, { env: { NODE_OPTIONS: `--require "${markerHook}"` } });
  const hook = path.join(__dirname, 'fixtures', 'process-stat.js').replace(/\\/g, '/');
  const stat = fs.readFileSync(`/proc/${spawned.pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const event = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'spawn');
  assert.equal(event.detail.start_ticks, ticks);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  const before = StateFiles.logText(h.state);
  const baseEnv = { NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_PROC_PID: String(spawned.pid), TOWER_CRANE_TEST_MONITOR_PID: String(spawned.monitor_pid) };
  for (const change of [{ TOWER_CRANE_TEST_PROC_STATE: 'Z' }, { TOWER_CRANE_TEST_PROC_STATE: 'X' }, { TOWER_CRANE_TEST_PROC_TICKS: String(BigInt(ticks) + 1n) }]) {
    for (const args of [['status'], ['ready']]) {
      const data = h.json(args, { env: { ...baseEnv, ...change } });
      assert.equal(data.exited_claims.length, 1);
      assert.equal(data.exited_claims[0].pid, spawned.pid);
      assert.match(data.exited_claims[0].tail, /last diagnostic before exit/);
    }
  }
  assert.equal(StateFiles.logText(h.state), before);
  assert.deepEqual(h.json(['status']).exited_claims, []);
});

test('reclaiming an expired lease under the same identity does not inherit its old spawn', async (t) => {
  const h = setup(t);
  const agent = 'worker-T1-1';
  h.ok(['claim', 'T1', '--agent', agent, '--lease', '1']);
  const oldClaim = h.readState('tasks.json').tasks[0].claim;
  const spawned = await start(t, h, { claim: false });
  assert.equal(spawned.agent, agent);
  spawned.kill();
  await waitOnRepo(h, () => (h.json(['status']).exited_claims || []).length === 1, 'old claim exit was not reported');
  const hook = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  h.ok(['claim', 'T1', '--agent', agent], {
    env: { NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_NOW: String(Date.parse(oldClaim.until) + 1) },
  });
  assert.notEqual(h.readState('tasks.json').tasks[0].claim.since, oldClaim.since);
  for (const args of [['status'], ['ready'], ['ready', '--all']]) {
    assert.deepEqual(h.json(args).exited_claims, [], 'a new claim must not use the old process');
    assert.doesNotMatch(h.ok(args), /exited without submit/);
  }
  const released = h.json(['release', 'T1', '--agent', agent, '--reason', 'finish new claim']);
  assert.equal(released.status, 'todo');
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.cmd === 'release').detail.exited_spawn, undefined);
});

test('a spawned replacement can claim after another worker lease expires', async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'previous-worker', '--lease', '1']);
  const previousClaim = h.readState('tasks.json').tasks[0].claim;
  const hook = path.join(__dirname, 'fixtures', 'clock.js').replace(/\\/g, '/');
  const spawned = await start(t, h, {
    env: { NODE_OPTIONS: `--require "${hook}"`, TOWER_CRANE_TEST_NOW: String(Date.parse(previousClaim.until) + 1) },
  });
  assert.equal(h.readState('tasks.json').tasks[0].claim.agent, spawned.agent);
  assert.deepEqual(h.json(['status']).exited_claims, []);
  spawned.kill();
  // Until the supervisor records the attempt inactive, only a pid probe tells
  // the exit, and Windows can hand that pid to another process between views.
  const ended = () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse)
    .some((e) => e.cmd === 'spawn phase' && e.detail.active === false && e.detail.agent === spawned.agent);
  await waitOnRepo(h, () => ended() && (h.json(['status']).exited_claims || []).length === 1, 'replacement exit was not reported');
  assert.equal(h.json(['ready']).exited_claims[0].pid, spawned.pid);
});

test('an attempt the supervisor recorded inactive stays exited when its pid is live again', async (t) => {
  const h = setup(t);
  const agent = 'worker-T1-1';
  h.ok(['claim', 'T1', '--agent', agent]);
  // A process without a recorded start time at the spawn's pid, as Windows
  // records spawns, stands for the pid reused after the harness exited.
  const reused = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); // wait-allow: the stand-in lives until the test stops it
  t.after(() => reused.kill('SIGKILL'));
  const record = (cmd, detail) => StateFiles.appendLog(h.state, `${JSON.stringify({
    at: new Date().toISOString(), agent: 'orchestrator', cmd, task: 'T1',
    detail: { role: 'worker', agent, pid: reused.pid, host: require('node:os').hostname(), attempt: 1, log: null, ...detail },
  })}\n`);
  record('spawn', {});
  const views = () => [['status'], ['ready'], ['ready', '--all']].map((args) => h.json(args).exited_claims.map((c) => c.pid));
  assert.deepEqual(views(), [[], [], []], 'a live pid reads as a running harness');
  // A queued retry is still the supervisor's attempt, not an exit.
  record('spawn phase', { phase: 'retrying', active: true, retry: 1 });
  assert.deepEqual(views(), [[], [], []]);
  // Another attempt's record proves nothing about this one.
  record('spawn phase', { phase: 'waiting', active: false, retry: 1, attempt: 2 });
  assert.deepEqual(views(), [[], [], []]);
  record('spawn phase', { phase: 'waiting', active: false, retry: 1 });
  assert.deepEqual(views(), [[reused.pid], [reused.pid], [reused.pid]]);
});

// Without its state no exit can be recorded and no reaction can follow, so the
// monitor stops its agent rather than let a paid session run on unrecorded.
// A removal that takes project.json first leaves the monitor no read that
// fails, so only project.json is removed here.
test('a monitor whose project state is removed stops its agent and exits', { skip: process.platform === 'win32' }, async (t) => {
  const h = setup(t);
  const spawned = await start(t, h, { lifetimeMs: 30000 });
  fs.unlinkSync(path.join(h.state, 'project.json'));
  await waitOnRepo(h, () => !detachedAlive({ pid: spawned.pid }) && !detachedAlive({ pid: spawned.monitor_pid }),
    'the agent or its monitor outlived the state directory');
  assert.equal(fs.existsSync(`${spawned.marker}.natural`), false, 'the agent ran to its own end');
});

test('a worker that keeps exiting without a submit is parked for the owner at the respawn cap', async (t) => {
  const h = setup(t);
  const worker = path.join(h.base, 'quits.js');
  fs.writeFileSync(worker, "process.stderr.write('stub harness gave up\\n'); process.exit(1);\n");
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']),
    '--clear', 'profile', '--clear', 'effort']);
  const spawns = () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse)
    .filter((e) => e.cmd === 'spawn').length;
  // As the wait host does: recover the dead claim, then dispatch again.
  const spawnOnce = () => {
    if (h.readState('tasks.json').tasks[0].claim) h.ok(['release', '--dead']);
    const before = spawns();
    const r = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(spawns(), before + 1, r.stderr);
  };
  for (let i = 1; i < 3; i++) {
    spawnOnce();
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null, `exit ${i} is under the cap`);
  }
  spawnOnce();
  const task = h.readState('tasks.json').tasks[0];
  assert.match(task.needs_owner, /^worker exited without submitting 3 times at revision 1 \(last worker-T1-\d+, code 1\)/);
  const events = StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  const park = events.filter((e) => e.cmd === 'respawn cap');
  assert.equal(park.length, 1);
  assert.deepEqual([park[0].detail.cap, park[0].detail.exits, park[0].detail.revision], [3, 3, 1]);
  // Dispatch skips the parked task, and asking for it by name is refused.
  h.ok(['release', '--dead']);
  assert.deepEqual(h.json(['ready']).ready, []);
  h.run(['spawn', '--ready']);
  assert.equal(spawns(), 3, 'spawn --ready skips the parked task');
  const named = h.run(['spawn', '--task', 'T1']);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /needs owner: worker exited without submitting 3 times/);
  // task show reads the log tail from the file; state holds none of it.
  assert.match(h.ok(['task', 'show', 'T1']), /last worker log: .*\n {2}tail \(last 20 lines, at most 8192 bytes\):\n {4}stub harness gave up/);
  for (const file of ['tasks.json', 'events.jsonl']) {
    assert.ok(!fs.readFileSync(path.join(h.state, file), 'utf8').includes('stub harness gave up'), `${file} holds log text`);
  }
  // owner-done clears the ask and starts the count again.
  h.ok(['owner-done', 'T1']);
  spawnOnce();
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null, 'the count restarts after owner-done');
});

test('a session that releases the task for an open decision does not count toward the respawn cap; a bare release does', async (t) => {
  const h = setup(t);
  const worker = path.join(h.base, 'asks.js');
  const script = (ask) => `
const cp = require('node:child_process');
const run = (args) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...args], { stdio: 'ignore' });
${ask ? "run(['ask', '--kind', 'technical', '--question', 'which? ' + Date.now(), '--option', 'A', '--option', 'B', '--blocks', 'T1']);" : ''}
run(['release', 'T1', '--reason', ${JSON.stringify(ask ? 'waiting on a decision' : 'giving up')}]);
`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']),
    '--clear', 'profile', '--clear', 'effort']);
  const round = () => {
    const r = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(r.code, 0, r.stderr);
    for (const d of h.readState('decisions.json').decisions.filter((x) => x.status === 'open')) {
      h.ok(['answer', d.id, '--choice', 'A', '--agent', 'orchestrator']);
    }
  };
  fs.writeFileSync(worker, script(true));
  for (let i = 0; i < 3; i++) round();
  assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null, 'three decision releases park nothing');
  fs.writeFileSync(worker, script(false));
  for (let i = 0; i < 3; i++) round();
  assert.match(h.readState('tasks.json').tasks[0].needs_owner, /^worker exited without submitting 3 times at revision 1 \(last worker-T1-\d+, code 0\)/);
  // Only the run that released for the decision is skipped: two earlier
  // bare exits still count, and the next bare exit is the third.
  h.ok(['owner-done', 'T1']);
  const plan = [false, false, true, false];
  for (const [i, ask] of plan.entries()) {
    fs.writeFileSync(worker, script(ask));
    round();
    const parked = h.readState('tasks.json').tasks[0].needs_owner;
    if (i < plan.length - 1) assert.equal(parked, null, `run ${i + 1} is under the cap`);
    else assert.match(parked, /^worker exited without submitting 3 times/);
  }
});

test('a worker whose monitor died counts toward the respawn cap through its worker-exited record', { skip: process.platform === 'win32' }, async (t) => {
  const h = setup(t);
  const events = () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  for (let i = 1; i <= 3; i++) {
    assert.equal(h.readState('tasks.json').tasks[0].needs_owner, null, `exit ${i - 1} is under the cap`);
    const spawned = await start(t, h);
    const monitor = events().findLast((e) => e.cmd === 'spawn').detail.monitor_pid;
    killPid(monitor, 'SIGKILL');
    spawned.kill();
    await waitOnRepo(h, () => (h.json(['status']).exited_claims || []).length === 1, 'the killed worker was not reported');
    // Any observer records the exit; spend collection is one.
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.ok(events().some((e) => e.cmd === 'worker-exited' && e.detail.agent === spawned.agent));
    assert.ok(!events().some((e) => e.cmd === 'spawn exit' && e.detail.agent === spawned.agent && 'code' in e.detail), 'the dead monitor recorded no exit');
    h.ok(['release', 'T1', '--reason', 'recover killed worker', '--agent', 'another-worker']);
  }
  assert.match(h.readState('tasks.json').tasks[0].needs_owner, /^worker exited without submitting 3 times at revision 1/);
});
