'use strict';

// A program ahead of the real git or gh on PATH that runs `git` or `gh`
// again leads back to an agent's shim: the shim picks it as the real program,
// runs it, and it runs the shim. Unchecked, that recursed without end, and a
// timed-out read left its orphans recursing on, until the host ran out of
// processes (T406).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { ROOT, TMP_ROOT, assertNoProcessesIn } = require('./helpers');
const { HUNG_TEST_MS, killPid, killGroup, fileWritten, childExit } = require('./signals');
const { shellQuote } = require('../lib/gates/common');

const SHIM = path.join(ROOT, 'lib', 'shim.js');
const POSIX = process.platform === 'win32' && 'the shims and wrappers here are sh scripts';
// Deeper than this the wrappers stop on their own, so a shim that does not
// stop the loop fails the test instead of loading the machine.
const GUARD = 4;

// An agent home as spawn builds one: the marker findReal skips, the policy,
// and git and gh shims in bin.
function shimHome(base) {
  const home = path.join(base, 'home');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, '.tower-crane-origin.json'), '{}\n');
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ gitPush: 'none', gh: ['pr view'], masks: false, broker: false }) + '\n');
  for (const tool of ['git', 'gh']) {
    fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec ${[process.execPath, SHIM, path.join(home, 'policy.json'), bin, tool].map(shellQuote).join(' ')} "$@"\n`, { mode: 0o755 });
  }
  return bin;
}

function fixture(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-shim-loop-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = shimHome(base);
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  const wrap = path.join(base, 'wrap');
  fs.mkdirSync(wrap);
  const log = path.join(base, 'depth.log');
  const env = { HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  const host = [path.dirname(process.execPath), ...String(process.env.PATH || '').split(path.delimiter)];
  return { base, bin, work, wrap, log, env, host };
}

// A wrapper that runs the agent's shim, as a test's wrapper that runs "the
// git on PATH" does inside an agent. It logs how deep in the loop it runs.
function wrapper(f, tool, viaExec) {
  const shim = shellQuote(path.join(f.bin, tool));
  fs.writeFileSync(path.join(f.wrap, tool), `#!/bin/sh
d=$((\${SHIM_LOOP_DEPTH:-0} + 1)); export SHIM_LOOP_DEPTH=$d
echo $d >> ${shellQuote(f.log)}
if [ $d -gt ${GUARD} ]; then exit 99; fi
${viaExec ? 'exec ' : ''}${shim} "$@"
`, { mode: 0o755 });
}

function run(f, tool, args, dirs) {
  const PATH = [...dirs, ...f.host].join(path.delimiter);
  return cp.spawnSync(path.join(f.bin, tool), args, { cwd: f.work, env: { ...f.env, PATH }, encoding: 'utf8', timeout: HUNG_TEST_MS });
}

// read-published: appended only, and read after every writer has exited.
const depths = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n') : []);

for (const [tool, args, viaExec] of [['git', ['version'], true], ['git', ['version'], false], ['gh', ['pr', 'view'], true]]) {
  test(`a ${tool} wrapper on PATH that ${viaExec ? 'execs' : 'runs'} the shim stops at the second shim with exit 127`, { skip: POSIX }, (t) => {
    const f = fixture(t);
    wrapper(f, tool, viaExec);
    const r = run(f, tool, args, [f.wrap, f.bin]);
    assert.equal(r.error, undefined);
    assert.equal(r.status, 127, r.stderr);
    assert.ok(r.stderr.includes(`${tool} shim loop: ${path.join(f.wrap, tool)} leads back to this shim`), r.stderr);
    // Each wrapper run is one level below the first shim; the shim it starts
    // is the second, which stops.
    assert.ok(depths(f).length > 0, 'the wrapper ran');
    assert.deepEqual([...new Set(depths(f))], ['1'], `the loop went deeper: ${depths(f).join(' ')}`);
    assertNoProcessesIn(t, f.base);
  });
}

// git starts hooks with its exec path first on PATH, so a hook that runs the
// shim hands it a PATH the outer shim did not hand on, and the shim runs.
test('a git hook that runs git through the shim is no loop', { skip: POSIX }, (t) => {
  const f = fixture(t);
  const PATH = [f.bin, ...f.host].join(path.delimiter);
  const env = { ...f.env, PATH };
  const git = (args) => cp.spawnSync(path.join(f.bin, 'git'), args, { cwd: f.work, env, encoding: 'utf8', timeout: HUNG_TEST_MS });
  for (const args of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@example.com']]) assert.equal(git(args).status, 0);
  const seen = path.join(f.base, 'hook-saw');
  fs.writeFileSync(path.join(f.work, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${shellQuote(path.join(f.bin, 'git'))} rev-parse --git-dir > ${shellQuote(seen)}\n`, { mode: 0o755 });
  const r = git(['commit', '-q', '--allow-empty', '-m', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /shim loop/);
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), '.git');
});

// A read with a time limit that hangs, with children of its own: the wrapper
// is ahead of the real git, records its children's pids and waits on them.
const LINUX = process.platform !== 'linux' && 'the read\'s processes are found through /proc';
function hungRead(t) {
  const f = fixture(t);
  const pids = path.join(f.base, 'pids');
  const realGit = require(SHIM).findReal('git', '');
  fs.writeFileSync(path.join(f.wrap, 'git'), `#!/bin/sh
case " $* " in
  *" --git-common-dir "*) sleep 300 & echo $! >> ${shellQuote(pids)}; sleep 300 & echo $! >> ${shellQuote(pids)}; wait ;;
esac
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  const state = { started: [] };
  t.after(() => {
    for (const pid of state.started) {
      try { killPid(Number(pid), 'SIGKILL'); } catch { /* gone */ }
    }
  });
  // read-published: appended only, by the wrapper.
  const read = () => (state.started = fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean));
  // A killed child its new parent has not reaped yet is gone too.
  const zombie = (pid) => { try { return /^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
  const alive = () => state.started.filter((pid) => {
    try { killPid(Number(pid), 0); } catch { return false; }
    return !zombie(pid);
  });
  return { f, pids, read, alive };
}

test('a timed-out read kills what the real git started', { skip: LINUX }, (t) => {
  const { f, read, alive } = hungRead(t);
  const r = run(f, 'git', ['version'], [f.wrap, f.bin]);
  read();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(alive(), [], 'the sleeps the hung read started are gone');
  assertNoProcessesIn(t, f.base);
});

// A supervisor stops an agent by killing its process group. A read the shim
// is waiting on is in that group, with what it started.
test('killing the shim\'s process group during a read stops what the read started', { skip: LINUX }, async (t) => {
  const { f, pids, read, alive } = hungRead(t);
  const PATH = [f.wrap, f.bin, ...f.host].join(path.delimiter);
  const child = cp.spawn(path.join(f.bin, 'git'), ['version'], { cwd: f.work, env: { ...f.env, PATH }, stdio: 'ignore', detached: true });
  t.after(() => { try { killGroup(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  await fileWritten(pids, { check: (text) => text.split('\n').filter(Boolean).length === 2 });
  read();
  killGroup(child.pid, 'SIGKILL');
  await childExit(child);
  await waitUntilGone(alive);
  assertNoProcessesIn(t, f.base);
});

// The group signal is delivered at once, but a killed process leaves the
// process table only when it is reaped.
function waitUntilGone(alive) {
  return require('./signals').waitUntil(() => alive().length === 0, { what: 'the read\'s processes exit' });
}
