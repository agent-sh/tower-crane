'use strict';

// npm test runs the whole suite; `npm test -- FILE... [--test-* flags]` runs
// only the files given. Each file runs in a node --test runner of its own,
// unmeasured files first, then longest measured. No more files run at once
// than --test-concurrency or one below the machine's core count, since each
// also starts CLI and git processes of its own. npm test asks for 4; a caller such as the
// tests gate on a large host may ask for more. Inside Tower Crane
// (TOWER_CRANE_TEST_GRANT) that number is a request: the host governor grants
// up to it and the run resizes to its grant as it changes
// (docs/state.md#test-threads).

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
// An unmeasured file can take much longer than its median shard cost.
// Start it before measured files so a new long file does not start last.
function startOrder(files, durations = fileDurations()) {
  const listed = (file) => Number.isFinite(durations[file]) && durations[file] >= 0;
  return [...files.filter((file) => !listed(file)).sort(), ...longestFirst(files.filter(listed), durations)];
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
// O_NONBLOCK keeps a FIFO at the name from blocking the open, and with it the run.
function readRecord(file, uid) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
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
let nodeShard = null;
for (let i = 0; i < given.length; i++) {
  const arg = given[i];
  if (arg === '--test-concurrency' || arg.startsWith('--test-concurrency=')) {
    const value = arg === '--test-concurrency' ? given[++i] : arg.slice('--test-concurrency='.length);
    if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
      console.error('--test-concurrency requires a positive integer');
      process.exit(1);
    }
    requested = Number(value);
  } else if (arg === '--test-shard' || arg.startsWith('--test-shard=')) {
    // Node's own shard option splits the file list; the runner owns the list, so it splits it here.
    const value = arg === '--test-shard' ? given[++i] : arg.slice('--test-shard='.length);
    const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value || '');
    if (!m || Number(m[1]) > Number(m[2])) {
      console.error('--test-shard requires INDEX/TOTAL with 1 <= INDEX <= TOTAL');
      process.exit(1);
    }
    nodeShard = { index: Number(m[1]), total: Number(m[2]) };
  } else if (arg.startsWith('--test-reporter-destination=') && !['stdout', 'stderr'].includes(arg.slice('--test-reporter-destination='.length))) {
    // Each file runs in a runner of its own, and every one would rewrite the file.
    console.error('test/run.js runs each file in a runner of its own; --test-reporter-destination takes stdout or stderr here');
    process.exit(1);
  } else if (arg.startsWith('--')) flags.push(arg);
  else files.push(arg);
}
// One core stays free for the agents, CLIs and git the tests start.
const cap = Math.max(1, os.availableParallelism() - 1);
const request = Math.min(cap, requested);
const base = [
  '--test',
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
if (nodeShard) list = [...list].sort().filter((_, i) => i % nodeShard.total === nodeShard.index - 1);
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
// limit cut off shows which files were still running. The runner prints those
// lines; with TC_TEST_SHARD_LOG_DIR each file's own runner also appends them to
// progress.log as they happen, beside the watchdog's watchdog.log, for CI to
// upload when the job log is lost, even while this runner cannot write.
const logDir = process.env.TC_TEST_SHARD_LOG_DIR ? path.resolve(process.env.TC_TEST_SHARD_LOG_DIR) : null;
if (logDir) fs.mkdirSync(logDir, { recursive: true });
const progressLines = !!shard;
if (shard && !flags.some((flag) => flag.startsWith('--test-reporter'))) {
  base.unshift('--test-reporter=spec', '--test-reporter-destination=stdout');
  // A file URL: Windows reads an absolute path here as a URL with its drive as the scheme.
  if (logDir) base.unshift(`--test-reporter=${require('node:url').pathToFileURL(path.join(__dirname, 'file-progress.js')).href}`, '--test-reporter-destination=stdout');
}
// With nothing to run there is no lease, setup or file runner.
if (!run.length) return;

// The environment the runner was started in: Tower Crane's grant mark, and
// the host whose governor grants the threads, before the global setup points
// the tests at a fake one.
const hostEnv = { ...process.env };
const coverageDir = process.env.TC_TEST_COVERAGE_DIR ? path.resolve(process.env.TC_TEST_COVERAGE_DIR) : null;
const ROOT = path.join(__dirname, '..');
const started = Date.now();
const queue = startOrder(run);
const running = new Map();
const totals = {};
const failing = [];
let prefix = null;
let ran = 0;
let limit = request;
let stopping = false;
let finished = false;
let grants = null;
let recheck = null;
let env = null;
let coverageArg = null;

// Runs each file in a runner of its own, never more at once than the grant.
// A grant that shrinks starts no file until fewer run; one that grows starts
// more at once.
function fill() {
  while (!stopping && queue.length && running.size < limit) startFile(queue.shift());
  if (!running.size && (stopping || !queue.length)) finish();
}

function startFile(file) {
  const child = cp.spawn(process.execPath, [...base, ...(coverageArg ? [coverageArg] : []), file], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const err = [];
  let done = false;
  running.set(child, file);
  ran++;
  if (progressLines) process.stdout.write(`file started: ${file}\n`);
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.stderr.on('data', (chunk) => err.push(chunk));
  const end = (code, note = '') => {
    if (done) return;
    done = true;
    running.delete(child);
    // A file's output comes whole, so the lines of files that ran side by side never mix.
    const text = Buffer.concat(out).toString('utf8');
    process.stdout.write(text);
    process.stderr.write(Buffer.concat(err));
    if (note) process.stderr.write(note);
    // A file ends with its runner's summary; one stopped before it, as a shard watchdog stops a hung file, never ended.
    if (count(text) && progressLines) process.stdout.write(`file ended: ${file}\n`);
    if (code && !process.exitCode) process.exitCode = code;
    fill();
  };
  child.on('error', (error) => end(1, `tower-crane: ${file}: ${error.message}\n`));
  child.on('close', (status, signal) => end(signal ? 128 + (os.constants.signals[signal] || 0) : status ?? 1));
}

// The run's totals, from the summary each file's runner prints last. True when the file printed one.
const ESCAPES = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
function count(text) {
  const last = {};
  const plain = text.replace(ESCAPES, '');
  // The spec reporter's failure details, which a reader looks for at the end of the run.
  const at = plain.search(/^✖ failing tests:$/m);
  if (at >= 0) failing.push(plain.slice(at).replace(/^✖ failing tests:\n/, '').trim());
  for (const m of plain.matchAll(/^(ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
    prefix ||= m[1];
    last[m[2]] = Number(m[3]);
  }
  for (const [key, n] of Object.entries(last)) totals[key] = (totals[key] || 0) + n;
  return 'tests' in last;
}

function finish() {
  if (finished) return;
  finished = true;
  if (recheck) clearInterval(recheck);
  if (grants) {
    try { grants.close(); } catch { /* The holder's exit frees the lease too. */ }
  }
  // Totals for the whole run, after every file's own, so a reader of the last summary reads the run's.
  if (ran > 1 && prefix) {
    for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) process.stdout.write(`${prefix} ${key} ${totals[key] || 0}\n`);
    process.stdout.write(`${prefix} duration_ms ${Date.now() - started}\n`);
    if (failing.length) process.stdout.write(`\n✖ failing tests:\n\n${failing.join('\n\n')}\n`);
  }
  if (coverageDir) {
    const Map = require('../scripts/tests-coverage-map');
    const map = require('../lib/tests-coverage').collect(coverageDir, ROOT, process.env.GITHUB_SHA || Map.headSha(ROOT));
    Map.write(path.join(coverageDir, 'tests-coverage-map.json'), map);
    console.error(`tower-crane: coverage map of ${map.tests.length} test files, ${Object.keys(map.map).length} covered files, in ${coverageDir}`);
  }
}

// Node skips exit handlers when a signal ends it, so a stop request goes to the
// running files, no other file starts, and this process exits, cleanup
// included, once they have.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true;
    if (!process.exitCode) process.exitCode = 128 + (os.constants.signals[signal] || 0);
    for (const child of running.keys()) child.kill(signal);
    if (!running.size && env) finish();
    else if (!env) process.exit(process.exitCode);
  });
}

const describe = (s) => `host budget ${s.budget} of ${s.cap} on ${s.cores} cores, ${s.granted} granted to ${s.runs} run${s.runs === 1 ? '' : 's'}`;

// Inside Tower Crane the grant sizes the pool: asked for at the start and
// again every few seconds while files remain. A run that cannot reach the
// governor keeps the request, as outside Tower Crane.
async function grant() {
  if (!hostEnv.TOWER_CRANE_TEST_GRANT) return;
  try {
    grants = await require('../lib/test-grants').open(hostEnv, request);
  } catch (e) {
    // An agent's broker leases one run at a time; a second run beside it takes one thread.
    if (e.leaseHeld) limit = 1;
    console.error(`tower-crane: test threads: no grant from the host governor (${e.message}); running ${limit} at once`);
    return;
  }
  if (!grants) return;
  limit = grants.state.grant;
  console.error(`tower-crane: test threads: granted ${limit} of ${request} (${describe(grants.state)})`);
  const every = require('../lib/intervals').ms('test_grant', hostEnv);
  let busy = false;
  recheck = setInterval(async () => {
    if (busy || finished) return;
    busy = true;
    try {
      const s = await grants.recheck();
      if (s && Number.isSafeInteger(s.grant) && s.grant !== limit && !finished) {
        console.error(`tower-crane: test threads: ${s.grant > limit ? 'grew' : 'shrank'} to ${s.grant} of ${request} (${describe(s)})`);
        limit = s.grant;
        fill();
      }
    } catch (e) {
      console.error(`tower-crane: test threads: recheck failed (${e.message}); keeping ${limit}`);
    } finally {
      busy = false;
    }
  }, every);
}

function start() {
  if (stopping) {
    finish();
    return;
  }
  const swept = require('./tmp-root').sweepTempRoot();
  console.error(`Test tmp sweep: removed ${swept.count} directories, ${swept.bytes} bytes`);
  // The clean git seed every test repository copies, built once per run and
  // passed to every file through the environment (test/global-setup.js).
  const setup = require('./global-setup');
  setup.globalSetup();
  process.on('exit', () => setup.globalTeardown());
  env = { ...process.env };
  // The lease is this runner's; a runner a test starts asks for none unless the test marks it.
  delete env.TOWER_CRANE_TEST_GRANT;
  // TC_TEST_COVERAGE_DIR builds the coverage map tests.map pins (scripts/tests-coverage-map.js): each
  // test file's coverage, the CLI processes it starts included, is kept apart and folded into
  // DIR/tests-coverage-map.json when the run ends. CI sets it on the daily and manual full runs.
  if (coverageDir) {
    env = require('../scripts/tests-coverage-map').scopeEnv(env, coverageDir, ROOT, false);
    coverageArg = `--require=${path.join(ROOT, 'lib', 'tests-coverage-scope.js')}`;
  }
  delete env.TC_TEST_COVERAGE_DIR;
  delete env.TC_TEST_SHARD;
  delete env.TC_TEST_SHARD_DEADLINE_MIN;
  delete env.TC_TEST_SHARD_LOG_DIR;
  delete env.TC_TEST_SHARD_HANG;
  if (logDir) env.TC_TEST_PROGRESS_LOG = path.join(logDir, 'progress.log');
  // A runner invoked from a test must launch a new run, not Node's recursive no-op.
  delete env.NODE_TEST_CONTEXT;
  // A broker a test starts sweeps its socket roots for directories that killed
  // brokers left (sweep in lib/broker.js). The real runtime directory holds the
  // live sockets of agents, a worker's own included, so the run gets a private
  // one there, removed when the run ends. A test that probes the host's own
  // runtime directory, such as its session bus, reads TOWER_CRANE_HOST_RUNTIME_DIR.
  // systemctl --user and systemd-run --user find the user manager only under
  // XDG_RUNTIME_DIR, so the private directory links the host's systemd and bus
  // entries; removing the directory removes the links, never their targets.
  const runtime = process.platform === 'win32' ? null : privateRuntime(process.env);
  if (runtime) {
    if (!env.TOWER_CRANE_HOST_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR) env.TOWER_CRANE_HOST_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    const host = env.TOWER_CRANE_HOST_RUNTIME_DIR;
    for (const entry of host ? ['systemd', 'bus'] : []) {
      try { fs.symlinkSync(path.join(host, entry), path.join(runtime, entry)); } catch { /* No such entry on this host. */ }
    }
    env.XDG_RUNTIME_DIR = runtime;
    process.on('exit', () => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
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
  fill();
  // Test only: a runner whose event loop never returns, the hang the watchdog must outlive.
  if (process.env.TC_TEST_SHARD_HANG === '1') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // wait-allow: blocks this runner until its shard watchdog stops it
}

if (hostEnv.TOWER_CRANE_TEST_GRANT) grant().then(start, (e) => { console.error(e.stack || e.message); process.exitCode = 1; });
else start();
