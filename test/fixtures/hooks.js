'use strict';

// Preloaded into a tower-crane process by tests that need to steer it from the
// outside: stop it at a point until the test lets it go, kill it while it
// holds the lock, slow it down, or make one kind of filesystem call fail.
// Each hook is off unless its HOOK_* variable is set, and acts only on paths
// under HOOK_STATE. Hooks key on file names, filesystem calls and error codes,
// not on tower-crane's functions, so a test built on them drives any version of
// the lock through the same schedule.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

const env = process.env;
// The probe child observes the environment passed to Git, then runs real Git.
if (env.HOOK_GIT_ENV_REPORT && path.basename(process.argv[1] || '') === 'tower-crane.js') {
  const exec = cp.execFileSync;
  cp.execFileSync = function gitEnvironment(command, args, options) {
    if (command !== 'git') return exec.call(this, command, args, options);
    return exec.call(this, process.execPath, [path.join(__dirname, 'git-env-probe.js'), ...args], options);
  };
}

// Keep a known missing PID absent when a test waits long enough for OS reuse.
if (env.HOOK_DEAD_PID) {
  const kill = process.kill;
  process.kill = function missingPid(pid, signal) {
    if (pid === Number(env.HOOK_DEAD_PID) && signal === 0) {
      const error = new Error('process no longer exists');
      error.code = 'ESRCH';
      throw error;
    }
    return kill.call(this, pid, signal);
  };
}

// A sandbox may share state files while hiding sibling workers and monitors.
if (env.HOOK_HIDDEN_PIDS) {
  const hidden = new Set(JSON.parse(env.HOOK_HIDDEN_PIDS));
  const kill = process.kill;
  const read = fs.readFileSync;
  process.kill = function hiddenPid(pid, signal) {
    if (hidden.has(pid) && signal === 0) {
      throw Object.assign(new Error('process is outside the pid view'), { code: 'ESRCH' });
    }
    return kill.call(this, pid, signal);
  };
  fs.readFileSync = function hiddenProc(file, ...args) {
    const pid = typeof file === 'string' && /^\/proc\/(\d+)\//.exec(file);
    if (pid && hidden.has(Number(pid[1]))) {
      throw Object.assign(new Error('process is outside the pid view'), { code: 'ENOENT' });
    }
    return read.call(this, file, ...args);
  };
}

// HOOK_KEEP_SPAWN_DIRS=1: spawn's job and receipt files stay in the cache, as
// they do when the dispatching CLI is killed before it removes them.
if (env.HOOK_KEEP_SPAWN_DIRS) {
  const rm = fs.rmSync;
  fs.rmSync = function keepSpawnDir(file, ...args) {
    if (typeof file === 'string' && /[\\/]tower-crane[\\/]spawn-[^\\/]+([\\/]started\.json)?$/.test(file)) return;
    return rm.call(this, file, ...args);
  };
}

// HOOK_PIDNS=ID: this process reports ID as its pid namespace, as a command
// in a sandbox of its own does.
if (env.HOOK_PIDNS) {
  const readlink = fs.readlinkSync;
  fs.readlinkSync = function sandboxPidNamespace(file, ...args) {
    if (file === '/proc/self/ns/pid') return env.HOOK_PIDNS;
    return readlink.call(this, file, ...args);
  };
}

if (env.HOOK_CLOCK_FILE) {
  const DateClass = Date;
  const clock = () => Number(fs.readFileSync(env.HOOK_CLOCK_FILE, 'utf8'));
  global.Date = class extends DateClass {
    constructor(...args) { super(...(args.length ? args : [clock()])); }
    static now() { return clock(); }
  };
}

if (env.HOOK_WATCH_READY || env.HOOK_NO_WATCH || env.HOOK_SILENT_WATCH) {
  const watch = fs.watch;
  fs.watch = function hookedWatch(...args) {
    if (env.HOOK_WATCH_READY) fs.writeFileSync(env.HOOK_WATCH_READY, '');
    if (env.HOOK_NO_WATCH) throw new Error('directory watch unavailable');
    if (env.HOOK_SILENT_WATCH) return { close() {}, on() {} };
    return watch.apply(this, args);
  };
}
const STATE = env.HOOK_STATE ? path.resolve(env.HOOK_STATE) : null;
const LOCK = STATE ? path.join(STATE, 'lock') : null;
const WRAPPED = ['openSync', 'closeSync', 'readFileSync', 'readSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'linkSync', 'statSync', 'readdirSync', 'mkdirSync', 'existsSync', 'utimesSync'];
// Calls that remove or move what is at their first argument.
const CHANGES = ['renameSync', 'unlinkSync', 'rmdirSync', 'rmSync', 'linkSync'];
const BUSY = ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES'];
const real = {};
for (const name of WRAPPED) real[name] = fs[name];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const under = (root, p) => !!root && typeof p === 'string' && (path.resolve(p) === root || path.resolve(p).startsWith(root + path.sep));
const inState = (p) => under(STATE, p);
const inLock = (p) => under(LOCK, p);

function ownsLock() {
  try {
    return real.readdirSync(LOCK).some((name) =>
      JSON.parse(real.readFileSync(path.join(LOCK, name), 'utf8')).pid === process.pid);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

// Tells the test this process reached a point (by creating SIGNAL with its
// pid), then waits until the test creates SIGNAL.go.
function stop(signal) {
  real.writeFileSync(signal, String(process.pid));
  const go = `${signal}.go`;
  const end = Date.now() + 30000;
  while (!real.existsSync(go) && Date.now() < end) sleep(10);
}

// HOOK_BARRIER=DIR with HOOK_BARRIER_N=N: the first time this process finds
// the lock taken, it waits until N processes have, so they all race for the
// same holder's lock at once.
let barrierDone = !env.HOOK_BARRIER;
function barrier() {
  if (barrierDone) return;
  barrierDone = true;
  real.writeFileSync(path.join(env.HOOK_BARRIER, String(process.pid)), '');
  const end = Date.now() + 20000;
  while (real.readdirSync(env.HOOK_BARRIER).length < Number(env.HOOK_BARRIER_N) && Date.now() < end) sleep(5);
}

const once = {};
const descriptors = new Map();
function first(key) {
  if (once[key]) return false;
  once[key] = true;
  return true;
}

function before(name, args) {
  const target = args[0];
  // Stdin is read with readStdin (readSync) or a bare readFileSync(0).
  if (env.HOOK_STDIN_READY && (name === 'readFileSync' || name === 'readSync') && target === 0) {
    real.writeFileSync(env.HOOK_STDIN_READY, '');
  }
  // HOOK_JITTER_MS=MS: a random pause of up to MS before each call on the state.
  if (env.HOOK_JITTER_MS && (inState(target) || inState(args[1]))) sleep(Math.floor(Math.random() * Number(env.HOOK_JITTER_MS)));
  // State commits precede board replacement; expose that interval to readers.
  if (env.HOOK_RENDER_DELAY_MS && name === 'renameSync' && args[1] === path.join(STATE, 'sketch.html')) {
    sleep(Number(env.HOOK_RENDER_DELAY_MS));
  }
  // Authentication reads project.json before locking; a dead-holder probe
  // must kill the process only after its own lock marker has been published.
  if (env.HOOK_DIE_ON && name === 'readFileSync' && inState(target) && path.basename(target) === env.HOOK_DIE_ON && ownsLock()) {
    process.kill(process.pid, 'SIGKILL');
    sleep(5000);
  }
  // HOOK_FAIL_LOCK=FILE: removing or moving anything at or inside the lock
  // fails with EPERM; each attempt adds a byte to FILE.
  if (env.HOOK_FAIL_LOCK && CHANGES.includes(name) && inLock(target)) {
    real.appendFileSync(env.HOOK_FAIL_LOCK, '.');
    const e = new Error(`EPERM: operation not permitted, ${name} '${target}'`);
    e.code = 'EPERM';
    throw e;
  }
}

let pendingLockRead;
function after(name, args, rawArgs = args) {
  const target = args[0];
  if (env.HOOK_STOP_RENDER && name === 'renameSync' && args[1] === path.join(STATE, 'sketch.md')
    && path.basename(process.argv[1]) === 'tower-crane.js' && process.argv.includes('spawn') && first('render')) stop(env.HOOK_STOP_RENDER);
  // HOOK_PAUSE_ON=FILE stops at HOOK_PAUSED after its first read; HOOK_PAUSE_PROCESS
  // optionally limits the pause to one executable's basename.
  if (env.HOOK_PAUSE_ON && name === 'readFileSync' && inState(target) && path.basename(target) === env.HOOK_PAUSE_ON
    && (!env.HOOK_PAUSE_PROCESS || path.basename(process.argv[1]) === env.HOOK_PAUSE_PROCESS) && first('pause')) stop(env.HOOK_PAUSED);
  // Windows keeps an unlinked marker pending deletion until its reader closes
  // it. Pause with the snapshot, without keeping the lock directory open.
  if (env.HOOK_STOP_LOCK_READ && name === 'readFileSync' && inLock(target) && first('lock-read')) {
    if (typeof rawArgs[0] === 'number') pendingLockRead = rawArgs[0];
    else stop(env.HOOK_STOP_LOCK_READ);
  }
  if (name === 'closeSync' && rawArgs[0] === pendingLockRead) {
    pendingLockRead = undefined;
    stop(env.HOOK_STOP_LOCK_READ);
  }
  // HOOK_STOP_LOCK_CHANGE=SIGNAL: stop after the first attempt to remove or
  // move what is at or inside the lock, whether or not it worked.
  if (env.HOOK_STOP_LOCK_CHANGE && CHANGES.includes(name) && inLock(target) && first('lock-change')) stop(env.HOOK_STOP_LOCK_CHANGE);
}

if (STATE) {
  for (const name of WRAPPED) {
    const orig = real[name];
    // The lock is taken by creating it (openSync) or by renaming onto it (renameSync).
    const lockArg = { openSync: 0, renameSync: 1 }[name];
    fs[name] = function hooked(...args) {
      const observed = typeof args[0] === 'number' && descriptors.has(args[0]) ? [descriptors.get(args[0]), ...args.slice(1)] : args;
      before(name, observed);
      let out;
      try {
        out = orig.apply(this, args);
      } catch (e) {
        if (lockArg !== undefined && path.resolve(String(args[lockArg])) === LOCK && BUSY.includes(e.code)) barrier();
        after(name, observed, args);
        throw e;
      }
      if (name === 'openSync') descriptors.set(out, args[0]);
      if (name === 'closeSync') descriptors.delete(args[0]);
      after(name, observed, args);
      return out;
    };
  }
}

// HOOK_STOP_WORKTREE_ADD=SIGNAL: stop right after git worktree add returns,
// before the command takes the lock to record what it made.
if (env.HOOK_STOP_WORKTREE_ADD) {
  const orig = cp.execFileSync;
  cp.execFileSync = function hookedExecFileSync(file, args, ...rest) {
    const out = orig.call(this, file, args, ...rest);
    const completed = args[0] === 'worktree' && (args[1] === 'unlock'
      || (args[1] === 'add' && !args.includes('--lock')));
    if (completed && first('worktree-add')) stop(env.HOOK_STOP_WORKTREE_ADD);
    return out;
  };
}

// HOOK_STOP_WORKTREE_STATUS=SIGNAL: stop before the first git status runs, which
// is the first look at a worktree that a removal may delete.
if (env.HOOK_STOP_WORKTREE_STATUS) {
  const orig = cp.execFileSync;
  cp.execFileSync = function hookedExecFileSync(file, args, ...rest) {
    if (args[0] === 'status' && first('worktree-status')) stop(env.HOOK_STOP_WORKTREE_STATUS);
    return orig.call(this, file, args, ...rest);
  };
}

// HOOK_STOP_WORKTREE_REMOVE=SIGNAL: stop before the first git worktree remove runs,
// after the removal has passed its checks and released the state lock.
if (env.HOOK_STOP_WORKTREE_REMOVE) {
  const orig = cp.execFileSync;
  cp.execFileSync = function hookedExecFileSync(file, args, ...rest) {
    if (args[0] === 'worktree' && args[1] === 'remove' && first('worktree-remove')) stop(env.HOOK_STOP_WORKTREE_REMOVE);
    return orig.call(this, file, args, ...rest);
  };
}

if (env.HOOK_REVIEW_DIFF_REPORT || env.HOOK_STOP_REVIEW_DIFF) {
  const orig = cp.execFileSync;
  cp.execFileSync = function reviewDiff(file, args, ...rest) {
    const diff = file === 'git' && args.includes('diff');
    if (diff && env.HOOK_REVIEW_DIFF_REPORT) {
      real.appendFileSync(env.HOOK_REVIEW_DIFF_REPORT, JSON.stringify({ locked: real.existsSync(LOCK) }) + '\n');
    }
    const out = orig.call(this, file, args, ...rest);
    if (diff && !args.includes('--name-only') && !args.includes('--numstat')
      && env.HOOK_STOP_REVIEW_DIFF && first('review-diff')) stop(env.HOOK_STOP_REVIEW_DIFF);
    return out;
  };
}

// Make the first fetch hit a real tracking-ref lock, then release it so the
// retry can fetch. Other modes inject Git's ref-transaction error or a
// permanent failure; every attempt is recorded.
if (env.HOOK_FETCH_ERROR) {
  const orig = cp.execFileSync;
  cp.execFileSync = function fetchError(file, args, options) {
    if (file !== 'git' || args[0] !== 'fetch') return orig.call(this, file, args, options);
    real.appendFileSync(env.HOOK_FETCH_ATTEMPTS, '.');
    if (first('fetch-error') || env.HOOK_FETCH_ALWAYS) {
      if (env.HOOK_FETCH_ERROR === 'lock') {
        const ref = args[args.length - 1].split(':')[1];
        const lock = path.join(options.cwd, '.git', `${ref}.lock`);
        real.writeFileSync(lock, '');
        try {
          return orig.call(this, file, args, options);
        } catch (e) {
          // Some Git versions report this lock conflict as "reference already
          // exists"; expose the older diagnostic that this retry handles.
          if (String(e.stderr).includes('reference already exists')) e.stderr += `\nerror: cannot lock ref '${ref}'`;
          throw e;
        } finally {
          real.unlinkSync(lock);
        }
      }
      const e = new Error('git fetch failed');
      e.stderr = env.HOOK_FETCH_ERROR;
      e.status = 1;
      throw e;
    }
    return orig.call(this, file, args, options);
  };
}

// Refuse overlapping worktree adds, as Git does when it reads another
// worktree's partially written metadata. Pause before the real add to force it.
if (env.HOOK_WORKTREE_ADD_ACTIVE) {
  const orig = cp.execFileSync;
  cp.execFileSync = function worktreeAddGuard(file, args, options) {
    if (file !== 'git' || args[0] !== 'worktree' || args[1] !== 'add') return orig.call(this, file, args, options);
    try {
      real.writeFileSync(env.HOOK_WORKTREE_ADD_ACTIVE, '', { flag: 'wx' });
    } catch {
      const e = new Error('concurrent worktree add');
      e.stderr = 'fatal: failed to read worktree commondir';
      throw e;
    }
    try {
      sleep(500);
      return orig.call(this, file, args, options);
    } finally {
      real.unlinkSync(env.HOOK_WORKTREE_ADD_ACTIVE);
    }
  };
}

// Expose the CLI pid while real Git and its checkout hook run, or interrupt
// after add returns with its native initialization lock still in place.
if (env.HOOK_ADD_PID || env.HOOK_ADD_ERROR || env.HOOK_DIE_WORKTREE_ADD) {
  const orig = cp.execFileSync;
  cp.execFileSync = function interruptedAdd(file, args, options) {
    const add = file === 'git' && args[0] === 'worktree' && args[1] === 'add';
    if (add && env.HOOK_ADD_PID) real.writeFileSync(env.HOOK_ADD_PID, String(process.pid));
    const out = orig.call(this, file, args, options);
    if (add && env.HOOK_ADD_ERROR) {
      const e = new Error('worktree add interrupted');
      e.code = env.HOOK_ADD_ERROR;
      e.stderr = 'fatal: worktree add interrupted';
      throw e;
    }
    if (add && env.HOOK_DIE_WORKTREE_ADD) {
      process.kill(process.pid, 'SIGKILL');
      sleep(5000);
    }
    return out;
  };
}

// HOOK_SPAWN_FAIL=1: every child process fails to start, as a program that
// vanished after it was found would. git runs through execFileSync and is
// unaffected.
if (env.HOOK_SPAWN_FAIL) {
  cp.spawn = function failingSpawn(file) {
    const child = new EventEmitter();
    child.pid = undefined;
    process.nextTick(() => {
      const e = new Error(`spawn ${file} ENOENT`);
      e.code = 'ENOENT';
      child.emit('error', e);
    });
    return child;
  };
}

// Real CLI dispatch with an offline harness that emits captured telemetry.
if (env.HOOK_USAGE_HARNESS) {
  const original = cp.spawn;
  cp.spawn = function usageHarness(file, args, options) {
    if (file === env.HOOK_USAGE_HARNESS) {
      return original.call(this, process.execPath, [
        require('node:path').join(__dirname, 'usage-harness.js'), env.HOOK_USAGE_FILE,
      ], options);
    }
    return original.call(this, file, args, options);
  };
}

if (env.HOOK_USAGE_READ_FAIL) {
  const original = fs.readFileSync;
  fs.readFileSync = function unreadableUsage(file, ...args) {
    if (typeof file === 'string' && file.startsWith(path.join(env.HOOK_STATE, 'logs') + path.sep)) {
      throw Object.assign(new Error('usage log unavailable'), { code: 'EACCES' });
    }
    return original.call(this, file, ...args);
  };
}

if (env.HOOK_USAGE_WRITE_FAIL) {
  const logFds = new Set();
  if (env.HOOK_USAGE_INHERITED_FD) logFds.add(Number(env.HOOK_USAGE_INHERITED_FD));
  const open = fs.openSync;
  const close = fs.closeSync;
  const isLog = (file) => typeof file === 'string' && file.startsWith(path.join(env.HOOK_STATE, 'logs') + path.sep);
  fs.openSync = function captureFd(file, ...args) {
    const fd = open.call(this, file, ...args);
    if (isLog(file)) logFds.add(fd);
    return fd;
  };
  fs.closeSync = function releaseCaptureFd(fd) {
    logFds.delete(fd);
    return close.call(this, fd);
  };
  for (const name of ['writeFileSync', 'appendFileSync']) {
    const original = fs[name];
    fs[name] = function fullUsageDisk(file, data, ...args) {
      const log = logFds.has(file) || isLog(file);
      if (log && data?.length) throw Object.assign(new Error('usage disk full'), { code: 'ENOSPC' });
      return original.call(this, file, data, ...args);
    };
  }
}

// Track detached children outside state so teardown can await every collector.
if (env.HOOK_PROCESSES_DIR) {
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js') {
    process.once('exit', () => {
      const file = path.join(env.HOOK_PROCESSES_DIR, `${process.pid}.json`);
      try {
        const tracked = JSON.parse(real.readFileSync(file, 'utf8'));
        const tmp = `${file}.exited`;
        real.writeFileSync(tmp, JSON.stringify({ ...tracked, exited: true }));
        real.renameSync(tmp, file);
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    });
  }
  const original = cp.spawn;
  cp.spawn = function trackDetached(file, args, options) {
    const monitor = args.some((arg) => path.basename(arg) === 'spawn-monitor.js');
    if (monitor && Number.isInteger(options?.stdio?.[3])) {
      options = { ...options, env: { ...options.env, HOOK_USAGE_INHERITED_FD: '3' } };
    }
    if (monitor && env.HOOK_MONITOR_HOST) {
      args = [...args];
      if (args.at(-1).startsWith('{')) {
        args[args.length - 1] = JSON.stringify({ ...JSON.parse(args.at(-1)), host: env.HOOK_MONITOR_HOST });
      } else {
        const fd = real.openSync(args.at(-1), 'r+');
        try {
          const job = JSON.parse(real.readFileSync(fd, 'utf8'));
          fs.ftruncateSync(fd, 0);
          fs.writeSync(fd, JSON.stringify({ ...job, host: env.HOOK_MONITOR_HOST }), 0, 'utf8');
        } finally { fs.closeSync(fd); }
      }
    }
    const child = original.call(this, file, args, options);
    if (options?.detached && child.pid) {
      const startTime = process.platform === 'win32' && monitor
        ? require('../windows-process').startTime(child.pid) : undefined;
      let startTicks;
      if (process.platform === 'linux') {
        try {
          const stat = real.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
          startTicks = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
        } catch { /* A short-lived child may have already exited. */ }
      }
      real.mkdirSync(env.HOOK_PROCESSES_DIR, { recursive: true });
      const trackedFile = path.join(env.HOOK_PROCESSES_DIR, `${child.pid}.json`);
      real.writeFileSync(trackedFile, JSON.stringify({
        pid: child.pid, startTicks, startTime,
        kind: monitor ? 'monitor' : 'worker',
      }));
      // A reaped Windows PID can immediately belong to another test's CLI.
      // The live parent observes worker exit. A monitor's own exit marker
      // precedes OS termination, so teardown also checks process identity.
      if (!monitor) child.once('exit', () => real.rmSync(trackedFile, { force: true }));
    }
    return child;
  };
}
