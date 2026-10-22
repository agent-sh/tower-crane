'use strict';

// npm test runs the whole suite; `npm test -- FILE... [--test-* flags]` runs
// only the files given. File workers stay below the machine's core count,
// since every file also starts CLI and git processes of its own. npm test asks
// for 4; a caller such as the tests gate on a large host may ask for more.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HUNG_TEST_MS, killPid } = require('./signals');

function testFiles() {
  return [
    ...fs.readdirSync(__dirname).filter((file) => file.endsWith('.test.js')).map((file) => `test/${file}`),
    ...fs.readdirSync(path.join(__dirname, 'gates')).filter((file) => file.endsWith('.test.js')).map((file) => `test/gates/${file}`),
  ].sort();
}
// Seconds each file's tests took in CI on this platform, from test/durations.json.
// scripts/test-durations.js refreshes the table from CI logs. A platform without a
// table of its own uses the Linux one; a copy without the table, such as a
// fixture's, measures nothing.
function fileDurations(platform = process.platform) {
  let text;
  // read-published: a checked-in table no process replaces while the runner reads it.
  try { text = fs.readFileSync(path.join(__dirname, 'durations.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const table = JSON.parse(text);
  return table[platform] || table.linux || {};
}
// A file the table does not list, such as a new one, counts as the table's median file.
function fileCost(durations) {
  const known = Object.values(durations).filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (file) => (Number.isFinite(durations[file]) && durations[file] >= 0 ? durations[file] : fallback);
}
// Longest measured file first; equal times keep the sorted order.
function longestFirst(files, durations = fileDurations()) {
  const cost = fileCost(durations);
  return [...files].sort().sort((a, b) => cost(b) - cost(a));
}
// A long file that started late would hold the run open after every other file
// finished. node --test sorts the paths it is given as text, so it takes no
// order, but each spelling of a path sorts in a band of its own: more `../`
// steps up from the working directory sort first, then absolute paths, then
// plain relative ones. The longest files take the earliest bands, one worker's
// worth to each, so the run starts them in about longest-first order; the
// shortest keep their plain paths. Reports name a file the same however it is
// spelled. A run of no more files than two per worker starts them all at once
// and keeps them as given.
function startOrder(files, workers, durations = fileDurations(), cwd = process.cwd()) {
  if (files.length <= 2 * workers) return files;
  const dir = path.resolve(cwd);
  const depth = path.relative(path.parse(dir).root, dir).split(path.sep).filter(Boolean).length;
  const bands = [];
  for (let up = depth; up >= 1; up--) {
    const steps = Array(up).fill('..');
    const ancestor = path.resolve(dir, ...steps);
    bands.push((file) => path.join(...steps, path.relative(ancestor, file)));
  }
  bands.push((file) => file);
  const band = new Map(longestFirst(files, durations).map((file, i) => [file, bands[Math.floor(i / workers)]]));
  return files.map((file) => (band.get(file) ? band.get(file)(path.resolve(dir, file)) : file));
}
// Shard INDEX of TOTAL gets an equal share of the measured time: the longest file
// goes to the shard with the least time so far. The runner owns the split and it
// depends only on the file list and the table, so every Node version on a
// platform runs the same files in each shard.
function shardFiles(files, index, total, durations = fileDurations()) {
  const cost = fileCost(durations);
  const order = longestFirst(files, durations);
  const loads = Array(total).fill(0);
  const shards = Array.from({ length: total }, () => []);
  for (const file of order) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += cost(file);
    shards[lightest].push(file);
  }
  return (shards[index - 1] || []).sort();
}
// A fresh 0700 directory for a run's sockets: in the runtime directory, or,
// in a sandbox that grants only its own socket leaf there, in that leaf. Its
// name is none the broker sweep takes. RUNNER in it names this process, so a
// later run removes the directory of a run that died without cleaning up, as
// one the shard watchdog kills does. Null when neither base can hold one.
const RUNNER = 'runner.json';
function privateRuntime(env) {
  for (const base of [env.XDG_RUNTIME_DIR, env.TOWER_CRANE_SOCKET_DIR]) {
    if (!base || !path.isAbsolute(base)) continue;
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(base, 'tct-'));
    } catch {
      // A base this run cannot write: the next one.
      continue;
    }
    fs.writeFileSync(path.join(dir, RUNNER), JSON.stringify(runner(process.pid)), { mode: 0o600 });
    sweepRuns(base, dir);
    return dir;
  }
  return null;
}
// What tells this runner from a later process at its pid, as lib/processes.js
// records it (identity). The runner keeps to node: built-ins, since the mutant
// harness runs it in a copy without lib/.
function procRead(read) {
  try { return read(); } catch { return null; }
}
function runner(pid) {
  const stat = procRead(() => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  return {
    pid, host: os.hostname(),
    start_ticks: stat ? stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] : null,
    pidns: procRead(() => fs.readlinkSync('/proc/self/ns/pid')),
  };
}
// Whether the runner a record names has provably exited (processState in
// lib/processes.js): on this host, in this pid namespace, and its pid is free
// or now holds a process that started later.
function runnerExited(record) {
  const own = runner(process.pid);
  if (!record || record.host !== own.host || record.pidns !== own.pidns || !Number.isInteger(record.pid) || record.pid <= 0) return false;
  try {
    killPid(record.pid, 0);
  } catch (e) {
    return e.code === 'ESRCH';
  }
  const now = runner(record.pid).start_ticks;
  return record.start_ticks != null && now != null && now !== record.start_ticks;
}
// The record a regular file of this user holds, checked and read through one
// open file so a swap at its name between the two cannot change what is read.
function readRecord(file, uid) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const f = fs.fstatSync(fd);
    return f.isFile() && f.uid === uid ? JSON.parse(fs.readFileSync(fd, 'utf8')) : null;
  } finally {
    fs.closeSync(fd);
  }
}
// Removes the tct- directories in base whose runner has exited. One whose
// record is missing, does not parse or names a runner that cannot be told
// gone (another host or pid namespace) stays: inside an agent's sandbox a
// live run on the host looks exited to kill(pid, 0) alone.
function sweepRuns(base, keep) {
  const uid = process.getuid();
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    // A sandbox can grant writing a leaf without listing its directory.
    return;
  }
  for (const name of names) {
    if (!/^tct-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = path.join(base, name);
    if (dir === keep) continue;
    try {
      const d = fs.lstatSync(dir);
      if (!d.isDirectory() || d.uid !== uid) continue;
      if (!runnerExited(readRecord(path.join(dir, RUNNER), uid))) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or nothing proves its runner exited.
    }
  }
}
// A healthy Windows shard runs its tests in about 28 minutes; this leaves its dump
// and stop time inside the 40-minute test step limit in .github/workflows/ci.yml.
const SHARD_DEADLINE_MIN = 36;
if (require.main !== module) {
  module.exports = { testFiles, shardFiles, longestFirst, startOrder, fileDurations, SHARD_DEADLINE_MIN };
  return;
}

const given = process.argv.slice(2);
const flags = [];
const files = [];
let requested = 4;
for (let i = 0; i < given.length; i++) {
  const arg = given[i];
  if (arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')) {
    const value = arg === '--test-concurrency' ? given[++i] : arg.slice('--test-concurrency='.length);
    if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
      console.error('--test-concurrency requires a positive integer');
      process.exit(1);
    }
    requested = Number(value);
  } else if (arg.startsWith('--')) flags.push(arg);
  else files.push(arg);
}
const concurrency = Math.min(Math.max(1, os.availableParallelism() - 1), requested);
const args = [
  '--test', `--test-concurrency=${concurrency}`,
  // The clean git seed every test repository copies, built once per run.
  `--test-global-setup=${path.join(__dirname, 'global-setup.js')}`,
  // A hung test fails after five minutes, about three times the slowest test
  // measured on a loaded machine, instead of holding CI to its job timeout.
  `--test-timeout=${HUNG_TEST_MS}`, '--test-force-exit',
  // Every test file fails when it resolves the user's real ladder file.
  `--require=${path.join(__dirname, 'fixtures', 'user-config-guard.js')}`,
  // Every test file fails when its process ends before the runner has all its tests.
  `--require=${path.join(__dirname, 'fixtures', 'report-guard.js')}`,
  // State a test file writes in its own process skips the flush to disk, as its CLIs do.
  `--require=${path.join(__dirname, 'fixtures', 'no-fsync.js')}`,
  ...flags,
];
let list = files.length ? files : testFiles();
// The gate runs host-only files separately with their opt-in environment.
const excluded = JSON.parse(process.env.TOWER_CRANE_TEST_EXCLUDE || '[]');
if (excluded.length) {
  const matchers = excluded.map(require('../lib/gates/tests').globToRegExp);
  list = list.filter((file) => !matchers.some((re) => re.test(path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/'))));
}
const shard = process.env.TC_TEST_SHARD;
if (shard) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match || Number(match[1]) > Number(match[2])) {
    console.error('TC_TEST_SHARD requires INDEX/TOTAL with 1 <= INDEX <= TOTAL');
    process.exit(1);
  }
  list = shardFiles(list, Number(match[1]), Number(match[2]));
}
// Node would run its default pattern, the whole tree, when given no files.
if (!list.length) {
  console.log(shard ? `TC_TEST_SHARD ${shard} has no test files` : 'No selected test files remain after exclusions');
  return;
}
// A sandboxed run skips tests.host_only files; the tests gate runs them on the host. Only a sandbox
// loads the helper, so an ordinary run needs no lib/ modules.
const { run, skipped, refused } = process.env.TOWER_CRANE_SANDBOX === '1'
  ? require('../lib/tests-host-only').split(list, process.env)
  : { run: list, skipped: [], refused: [] };
if (refused.length) {
  console.error(`tower-crane: a sandboxed run with tests.host_only names test files, not directories or globs: ${refused.join(' ')}`);
  process.exit(1);
}
if (skipped.length) console.error(`tower-crane: skipped host-only tests in this sandbox, the tests gate runs them on the host: ${skipped.join(' ')}`);
// A CI shard's log says which files started and ended, so a log the job's time
// limit cut off shows which files were still running.
// TC_TEST_SHARD_LOG_DIR also keeps those lines in progress.log, beside the watchdog's
// watchdog.log, for CI to upload when the job log is lost.
const logDir = process.env.TC_TEST_SHARD_LOG_DIR ? path.resolve(process.env.TC_TEST_SHARD_LOG_DIR) : null;
if (logDir) fs.mkdirSync(logDir, { recursive: true });
if (shard && !flags.some((flag) => flag.startsWith('--test-reporter'))) {
  // A file URL: Windows reads an absolute path here as a URL with its drive as the scheme.
  const progress = `--test-reporter=${require('node:url').pathToFileURL(path.join(__dirname, 'file-progress.js')).href}`;
  args.unshift('--test-reporter=spec', '--test-reporter-destination=stdout', progress, '--test-reporter-destination=stdout');
  if (logDir) args.unshift(progress, `--test-reporter-destination=${path.join(logDir, 'progress.log')}`);
}
args.push(...startOrder(run, concurrency));

const env = { ...process.env };
delete env.TC_TEST_SHARD;
delete env.TC_TEST_SHARD_DEADLINE_MIN;
delete env.TC_TEST_SHARD_LOG_DIR;
delete env.TC_TEST_SHARD_HANG;
// A runner invoked from a test must launch a new run, not Node's recursive no-op.
delete env.NODE_TEST_CONTEXT;

// With every file skipped there is nothing to run; node --test with no file would search the directory.
if (!run.length) return;
// A broker a test starts sweeps its socket roots for directories that killed
// brokers left (sweep in lib/broker.js). The real runtime directory holds the
// live sockets of agents, a worker's own included, so the run gets a private
// one there, removed when the run ends. A test that probes the host's own
// runtime directory, such as its session bus, reads TOWER_CRANE_HOST_RUNTIME_DIR.
const runtime = process.platform === 'win32' ? null : privateRuntime(process.env);
if (runtime) {
  if (!env.TOWER_CRANE_HOST_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) env.TOWER_CRANE_HOST_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  env.XDG_RUNTIME_DIR = runtime;
  process.on('exit', () => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
}
const started = Date.now();
const child = cp.spawn(process.execPath, args, { stdio: 'inherit', env });
// Node skips exit handlers when a signal ends it, so a stop request goes to the
// tests, and this process exits, cleanup included, once they have.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
// A job its time limit cancels keeps no log, so a shard stops a few minutes under
// the test step's limit: test/shard-watchdog.js prints the processes the run still
// holds, stops them and fails. It runs in a process of its own, since a timer here
// cannot fire while this event loop is blocked. test/ci-required.test.js holds the
// default under that limit.
const deadlineMin = Number(process.env.TC_TEST_SHARD_DEADLINE_MIN || (shard ? SHARD_DEADLINE_MIN : 0));
if (deadlineMin > 0) {
  const watchdog = cp.spawn(process.execPath, [path.join(__dirname, 'shard-watchdog.js'), JSON.stringify({
    root: process.pid, started, deadlineMin, logDir, shard, files: run,
  })], { stdio: ['pipe', 'ignore', 'inherit'], detached: true, windowsHide: true });
  // Its stdin closes when this process exits, however it exits, and the watchdog ends with it.
  watchdog.on('error', (error) => console.error(`tower-crane: shard watchdog: ${error.message}`));
  watchdog.stdin.on('error', () => {});
  watchdog.unref();
  watchdog.stdin.unref();
}
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (status, signal) => {
  if (signal) process.exitCode = 128 + (os.constants.signals[signal] || 0);
  else process.exitCode = status ?? 1;
});
// Test only: a runner whose event loop never returns, the hang the watchdog must outlive.
if (process.env.TC_TEST_SHARD_HANG === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // wait-allow: blocks this runner until its shard watchdog stops it
