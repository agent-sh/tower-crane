'use strict';
// The backstop behind gate containment. A gate runs its commands in a directory of its own under
// the gate temporary root (lib/gates/common.js withWorktree), and the tests it runs keep their
// fixtures in directories of the test temporary root (test/tmp-root.js). A process that escaped
// its gate's cleanup still names one of them: its working directory, or an argument. On
// 2026-10-23 a fixture worker and its busy child ran for four hours under a gate directory that
// had been deleted. The reaper finds such processes, kills them with their descendants and returns
// what it killed, so the gate records an event that status shows: a leak is never silent.
//
// A directory is over when it is deleted, when the gate or test that made it is gone (its owner
// file names a pid that exited), or when the caller names it finished. A directory without an
// owner file, or whose owner runs, belongs to a live gate or test and is left alone, as is any
// process of another user, in another pid namespace, or above the caller.
//
// Linux reads /proc for working directories and arguments. macOS has arguments only, from ps.
// Windows has neither cheaply; there the job object of each gate command holds what it starts.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./processes');

const GATE_OWNER = 'owner.json';
const TEST_OWNER = '.tower-crane-test-owner.json';
const COMMAND_CHARS = 300;

// The test temporary root a test run on this host uses, as test/tmp-root.js picks it.
function testRoot(env = process.env) {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
  const cache = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : env.XDG_CACHE_HOME || path.join(home, '.cache');
  return env.TOWER_CRANE_TEST_TMP || env.TOWER_CRANE_TMP || path.join(cache, 'tower-crane', 'test-tmp');
}

function procText(file) {
  try { return fs.readFileSync(file, 'latin1'); } catch { return null; }
}

// The pids above this process, which no reaper kills: they run the gate.
function ancestors() {
  const seen = new Set([process.pid]);
  for (let pid = process.ppid; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const stat = procText(`/proc/${pid}/stat`);
    if (!stat) break;
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return seen;
}

// [{pid, ppid, cwd, args}] for this user's live processes in this pid namespace.
function processes() {
  if (process.platform === 'linux') {
    const uid = process.getuid();
    const pidns = P.pidNamespace();
    const rows = [];
    let names = [];
    try { names = fs.readdirSync('/proc'); } catch { return rows; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      try {
        if (fs.statSync(`/proc/${name}`).uid !== uid) continue;
        if (pidns && fs.readlinkSync(`/proc/${name}/ns/pid`) !== pidns) continue;
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (['Z', 'X'].includes(fields[0])) continue;
        let cwd = null;
        try { cwd = fs.readlinkSync(`/proc/${name}/cwd`); } catch { /* A kernel thread or a process that is exiting. */ }
        const args = (procText(`/proc/${name}/cmdline`) || '').split('\0').filter(Boolean);
        rows.push({ pid: Number(name), ppid: Number(fields[1]), cwd, args });
      } catch { /* It exited while it was read. */ }
    }
    return rows;
  }
  if (process.platform === 'darwin') {
    const r = cp.spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,uid=,command='], { encoding: 'utf8', timeout: 5000 });
    const uid = process.getuid();
    return (r.stdout || '').split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((m) => m && Number(m[3]) === uid)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cwd: null, args: [m[4]] }));
  }
  return [];
}

// The directory under root that text names, as `root/<name>`, or null.
function named(text, root) {
  if (!text) return null;
  for (let at = text.indexOf(root + path.sep); at >= 0; at = text.indexOf(root + path.sep, at + 1)) {
    // The root starts a path here, not in the middle of a longer one.
    if (at > 0 && !/[\s'"`=:,;]/.test(text[at - 1])) continue;
    const name = /^[^/\\\s'"`:;]+/.exec(text.slice(at + root.length + 1))?.[0];
    if (name) return path.join(root, name);
  }
  return null;
}

function owner(dir, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
}

// Why the directory is over: deleted, finished, or its owner exited; null while it is live.
function state(dir, kind, finished) {
  if (finished.has(dir)) return 'finished';
  let stat;
  try { stat = fs.statSync(dir); } catch (e) { return e.code === 'ENOENT' ? 'deleted' : null; }
  if (!stat.isDirectory()) return null;
  const record = owner(dir, kind === 'gate' ? GATE_OWNER : TEST_OWNER);
  if (!record || !Number.isInteger(record.pid) || record.pid === process.pid) return null;
  return P.processState(record) === 'exited' ? 'owner exited' : null;
}

// roots: [{root, kind: 'gate' | 'test'}]; finished: directories the caller is done with.
// Returns [{pid, command, cwd, dir, kind, reason, via}] for each process it killed.
function reap({ roots, finished = [], list = processes, kill = (pid) => process.kill(pid, 'SIGKILL') } = {}) {
  const wanted = [];
  for (const { root, kind } of roots) {
    if (!root) continue;
    const resolved = path.resolve(root);
    let real = resolved;
    try { real = fs.realpathSync.native(resolved); } catch { /* A missing root still names deleted directories. */ }
    for (const r of new Set([resolved, real])) wanted.push({ root: r, kind });
  }
  if (!wanted.length) return [];
  const done = new Set(finished.flatMap((dir) => {
    try { return [path.resolve(dir), fs.realpathSync.native(dir)]; } catch { return [path.resolve(dir)]; }
  }));
  const spared = ancestors();
  const rows = list().filter((row) => !spared.has(row.pid));
  const over = new Map();
  const verdict = new Map();
  for (const row of rows) {
    for (const { root, kind } of wanted) {
      const texts = [row.cwd && row.cwd.replace(/ \(deleted\)$/, ''), ...row.args];
      const dir = texts.map((text) => named(text, root)).find(Boolean);
      if (!dir) continue;
      if (kind === 'gate' && !path.basename(dir).startsWith(require('./gate-tmp').GATE_PREFIX)) continue;
      if (!verdict.has(dir)) verdict.set(dir, state(dir, kind, done));
      const reason = verdict.get(dir);
      if (reason) { over.set(row.pid, { row, dir, kind, reason }); break; }
    }
  }
  // Their descendants go with them, whatever they name.
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) || []), row]);
  const queue = [...over.values()];
  while (queue.length) {
    const found = queue.pop();
    for (const child of children.get(found.row.pid) || []) {
      if (over.has(child.pid)) continue;
      const entry = { row: child, dir: found.dir, kind: found.kind, reason: found.reason, via: found.row.pid };
      over.set(child.pid, entry);
      queue.push(entry);
    }
  }
  const killed = [];
  for (const { row, dir, kind, reason, via } of over.values()) {
    try { kill(row.pid); } catch { continue; }
    killed.push({ pid: row.pid, command: require('./ci-log-text').redactTokenShapes(row.args.join(' ')).slice(0, COMMAND_CHARS),
      cwd: row.cwd, dir, kind, reason, ...(via ? { via } : {}) });
  }
  return killed;
}

// Reaped processes the gates recorded in the last DAYS days, from their events.
const DAYS = 7;
function recent(events, now = Date.now()) {
  const since = now - DAYS * 24 * 60 * 60 * 1000;
  let count = 0;
  let last = null;
  for (const e of events) {
    if (e.cmd !== 'gate reap' || !Array.isArray(e.detail?.processes)) continue;
    if (!(Date.parse(e.at) >= since)) continue;
    count += e.detail.processes.length;
    const first = e.detail.processes[0];
    if (first && (!last || e.at > last.at)) last = { at: e.at, task: e.task, gate: e.detail.gate || null, pid: first.pid, command: first.command, dir: first.dir };
  }
  return { days: DAYS, count, last };
}

module.exports = { reap, recent, processes, named, testRoot, GATE_OWNER, TEST_OWNER, DAYS };
