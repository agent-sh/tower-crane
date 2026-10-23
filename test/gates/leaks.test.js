'use strict';
// No process outlives its gate (T545). A test command whose detached grandchild clears its
// environment and loses its parent escapes the process group and the run mark, so only the
// gate directory it works in still ties it to the gate. These run without a cgroup, as a node
// test worker launches gate commands; the cgroup and job object paths are host probes
// (scripts/probe-gate-containment.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const gate = require('../../lib/gates/tests');
const Reaper = require('../../lib/reaper');
const { scratch, isolateGit, isolateUserFile, commit, initRepo, worktrees, quote } = require('./helpers');
const { makeRepo, detachedAlive } = require('../helpers');
const { shellQuote, treeExec } = require('../../lib/gates/common');
const { waitUntil, killPid } = require('../signals');

const skip = !['linux'].includes(process.platform)
  && 'the reaper reads working directories from /proc; Windows gate commands use a job object instead';

// The leak: a grandchild in a session of its own with an empty environment, spinning until its
// deadline, whose parent then exits, fails or hangs as MODE says.
const LEAK = `const fs = require('fs');
const cp = require('child_process');
const [pids, mode] = process.argv.slice(2);
const spin = \`const end = Date.now() + 300000;
while (Date.now() < end) Math.sqrt(Math.random()); // spin-allow: the leak this test plants; only the gate may end it sooner
\`;
// Windows has no run mark to clear, and node there needs its system variables.
const child = cp.spawn(process.execPath, ['-e', spin], { detached: true, stdio: 'ignore', env: process.platform === 'win32' ? process.env : {} });
fs.appendFileSync(pids, child.pid + '\\n');
child.unref();
if (mode === 'hang') setInterval(() => {}, 1000);
else process.exitCode = Number(mode);
`;

test('a gate whose test leaves a detached spinning grandchild leaves no live process on success, failure and timeout', { skip }, async (t) => {
  const tmp = scratch('gates-leaks');
  isolateGit(tmp);
  isolateUserFile(tmp);
  process.env.TOWER_CRANE_TMP = path.join(tmp, 'gate-tmp');
  fs.mkdirSync(process.env.TOWER_CRANE_TMP);
  const root = path.join(tmp, 'repo');
  initRepo(root, { 'leak.js': LEAK, 'value.txt': '0\n' });
  const sha = commit(root, { 'value.txt': '1\n' });
  const pids = path.join(tmp, 'pids');
  const planted = () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
  t.after(() => {
    for (const pid of planted()) if (detachedAlive({ pid })) killPid(pid, 'SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const [mode, ok, minutes] of [['0', true, 20], ['1', false, 20], ['hang', false, 0.05]]) {
    const before = planted().length;
    const command = `${quote(process.execPath)} leak.js ${quote(pids)} ${mode}`;
    const out = await gate.run({
      root, worktree: null, log() {},
      task: { id: 'T1', kind: 'code', sha, status: 'submitted' },
      project: { repo: 'acme/app', base: 'main', gates: { tests_cmd: command, tests_timeout_min: minutes }, tests: { mode: 'run-only' } },
      args: { cmd: command },
    });
    assert.equal(out.ok, ok, `${mode}: ${out.summary}`);
    if (mode === 'hang') assert.match(out.summary, /timed out/);
    const leaked = planted().slice(before);
    assert.ok(leaked.length >= 1, `${mode}: the command planted its grandchild`);
    assert.deepEqual(leaked.filter((pid) => detachedAlive({ pid })), [], `${mode}: a grandchild outlived the gate`);
    assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP).filter((name) => name !== 'tests-base-cache'), [], `${mode}: the gate directory is gone`);
    assert.equal(worktrees(root), 1);
  }
});

test('a gate kills a process left in a deleted gate directory, records the event and status shows it', { skip }, async (t) => {
  const h = makeRepo(t);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  fs.mkdirSync(h.env.TOWER_CRANE_TMP);
  h.init(['--repo', 'acme/demo', '--base', 'main', '--tests-cmd', `${shellQuote(process.execPath)} -e 0`, '--tests-mode', 'run-only']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'tests pass']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.git(['switch', '-qc', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'value.txt'), '1\n');
  h.git(['add', '-A']);
  h.git(['commit', '-qm', 'change']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'fixture-change', '--agent', 'w-1']);
  // The orphan: a process an earlier gate left in its directory, which that gate then deleted.
  const dir = fs.mkdtempSync(path.join(h.env.TOWER_CRANE_TMP, 'tower-crane-'));
  const started = path.join(h.base, 'orphan-started');
  const orphan = cp.spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, '');
const end = Date.now() + 300000;
while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // spin-allow: the orphan this test plants; only the gate may end it sooner
`], { cwd: dir, detached: true, stdio: 'ignore' });
  orphan.unref();
  t.after(() => { if (detachedAlive({ pid: orphan.pid })) killPid(orphan.pid, 'SIGKILL'); });
  await waitUntil(() => fs.existsSync(started), { paths: [h.base], signal: t.signal, alive: orphan, what: 'orphan start' });
  fs.rmSync(dir, { recursive: true, force: true });
  const r = h.run(['check', 'tests', 'T1', '--agent', 'checker', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`killed 1 leaked process at gate start: ${orphan.pid} \\(deleted `));
  // Without a cgroup, as here, the evidence says the process group was the boundary.
  assert.deepEqual(JSON.parse(r.stdout).commands.find((c) => c.command !== 'git').cleanup, { backend: 'process-group', empty: true });
  assert.equal(detachedAlive({ pid: orphan.pid }), false);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const reap = events.find((e) => e.cmd === 'gate reap');
  assert.equal(reap.task, 'T1');
  assert.equal(reap.detail.gate, 'tests');
  assert.equal(reap.detail.phase, 'start');
  const real = path.join(fs.realpathSync(h.env.TOWER_CRANE_TMP), path.basename(dir));
  assert.deepEqual(reap.detail.processes.map((p) => [p.pid, p.dir, p.kind, p.reason]), [[orphan.pid, real, 'gate', 'deleted']]);
  assert.match(reap.detail.processes[0].command, /Atomics\.wait/);
  const status = h.run(['status']);
  assert.match(status.stdout, new RegExp(`^leaked processes killed: 1 in the last 7 days, last pid ${orphan.pid} \\(.*\\) from .*tower-crane-\\w+ by the tests gate of T1 at `, 'm'));
  assert.deepEqual(h.json(['status']).leaked_processes.last.pid, orphan.pid);
});

test('the reaper spares live gates and tests, and kills what names a finished or deleted one with its descendants', { skip }, (t) => {
  const root = fs.realpathSync(scratch('reaper-roots'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name, owner, file = Reaper.GATE_OWNER) => {
    fs.mkdirSync(path.join(root, name));
    if (owner) fs.writeFileSync(path.join(root, name, file), JSON.stringify(owner));
    return path.join(root, name);
  };
  const exited = cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  const live = dir('tower-crane-live01', { pid: process.pid, host: require('node:os').hostname() });
  const unowned = dir('tower-crane-old001');
  const ended = dir('tower-crane-ended1', { pid: Number(exited), host: require('node:os').hostname() });
  const done = dir('tower-crane-done01');
  dir('other-dir');
  const testLive = dir('tc-test-live01', { pid: process.ppid, host: require('node:os').hostname() }, Reaper.TEST_OWNER);
  const rows = [
    { pid: 101, ppid: 1, cwd: `${live}/wt`, args: ['node'] },
    { pid: 102, ppid: 1, cwd: '/home', args: ['node', `${root}/tower-crane-gone01/wt/test.js`] },
    { pid: 103, ppid: 102, cwd: '/home', args: ['sleep'] },
    { pid: 104, ppid: 1, cwd: `${done}/tmp (deleted)`, args: ['node'] },
    { pid: 105, ppid: 1, cwd: `/x${root}/tower-crane-gone01`, args: ['node'] },
    { pid: 106, ppid: 1, cwd: `${root}/other-dir/wt`, args: ['node'] },
    { pid: 107, ppid: 1, cwd: unowned, args: ['node'] },
    { pid: 108, ppid: 1, cwd: '/home', args: ['node', `--dir=${ended}/tmp`] },
    { pid: 109, ppid: 1, cwd: `${testLive}/repo`, args: ['node'] },
    { pid: 110, ppid: 1, cwd: `${root}/tc-test-gone01 (deleted)`, args: ['node'] },
    { pid: process.pid, ppid: 1, cwd: `${root}/tower-crane-gone01`, args: ['node'] },
  ];
  const killed = [];
  const found = Reaper.reap({ roots: [{ root, kind: 'gate' }, { root, kind: 'test' }], finished: [done],
    list: () => rows, kill: (pid) => killed.push(pid) });
  assert.deepEqual(found.map((p) => [p.pid, path.basename(p.dir), p.kind, p.reason, p.via ?? null]).sort((a, b) => a[0] - b[0]), [
    [102, 'tower-crane-gone01', 'gate', 'deleted', null],
    [103, 'tower-crane-gone01', 'gate', 'deleted', 102],
    [104, 'tower-crane-done01', 'gate', 'finished', null],
    [108, 'tower-crane-ended1', 'gate', 'owner exited', null],
    [110, 'tc-test-gone01', 'test', 'deleted', null],
  ]);
  assert.deepEqual(killed.sort(), [102, 103, 104, 108, 110]);
  assert.equal(Reaper.named(`--dir=${root}/tower-crane-ab12CD/wt`, root), `${root}/tower-crane-ab12CD`);
  assert.equal(Reaper.named(`${root}x/tower-crane-ab12CD`, root), null);
});

test('a Windows gate command runs in a job object that stops its orphaned grandchild and reports the job empty', {
  skip: process.platform !== 'win32' && 'Windows only; Linux gates use a cgroup, which scripts/probe-gate-containment.js checks on the host',
}, async (t) => {
  const tmp = scratch('gates-job');
  const pids = path.join(tmp, 'pids');
  t.after(() => {
    for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []) {
      if (detachedAlive({ pid })) killPid(pid, 'SIGKILL');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(tmp, 'leak.js'), LEAK);
  const r = await treeExec(`${quote(process.execPath)} leak.js ${quote(pids)} 0`, [], {
    shell: true, cwd: tmp, timeout: 300000, resources: { tasks_max: 64, memory_max_bytes: 2 ** 30 },
    env: { ...process.env, TOWER_CRANE_TEST_CONTAINMENT: '1' },
  });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.cleanup, { backend: 'job', empty: true });
  const pid = Number(fs.readFileSync(pids, 'utf8').trim());
  assert.equal(detachedAlive({ pid }), false, 'the orphan outlived its job');
});
