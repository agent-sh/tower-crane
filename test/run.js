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
// order, but an absolute path sorts before every relative one: the longest
// two files per worker go as absolute paths and start first, the rest follow
// in sorted order. Reports name a file the same either way. A run of no more
// files than that starts them all at once and keeps them as given.
function startOrder(files, workers, durations = fileDurations()) {
  if (files.length <= 2 * workers) return files;
  const first = new Set(longestFirst(files, durations).slice(0, 2 * workers));
  return files.map((file) => (first.has(file) ? path.resolve(file) : file));
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
// A healthy Windows shard runs its tests in about 28 minutes; this leaves its dump
// and stop time inside the 45-minute test job limit in .github/workflows/ci.yml.
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
if (shard && !flags.some((flag) => flag.startsWith('--test-reporter'))) {
  args.unshift('--test-reporter=spec', '--test-reporter-destination=stdout',
    // A file URL: Windows reads an absolute path here as a URL with its drive as the scheme.
    `--test-reporter=${require('node:url').pathToFileURL(path.join(__dirname, 'file-progress.js')).href}`, '--test-reporter-destination=stdout');
}
args.push(...startOrder(run, concurrency));

const env = { ...process.env };
delete env.TC_TEST_SHARD;
delete env.TC_TEST_SHARD_DEADLINE_MIN;
// A runner invoked from a test must launch a new run, not Node's recursive no-op.
delete env.NODE_TEST_CONTEXT;

// The processes below ROOT, from one snapshot, and on Windows the ones created since
// SINCE whose parent is gone: Windows does not reparent, so a child of an exited test
// process can no longer be reached from ROOT.
function processTree(root, since) {
  const win = process.platform === 'win32';
  const out = win
    ? cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { '
      + '"$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) $($_.CommandLine)" }'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20, windowsHide: true }) // wait-allow: one snapshot, inside the minutes the deadline leaves before the job limit
    : cp.spawnSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 }); // wait-allow: one snapshot, inside the minutes the deadline leaves before the job limit
  const rows = (out.stdout || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((f) => f.length > 2)
    .map(([pid, parent, time, ...rest]) => ({ pid: Number(pid), parent: Number(parent), time, text: [time, ...rest].join(' ') }));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!tree.has(row.pid) && tree.has(row.parent)) { tree.add(row.pid); grew = true; }
  }
  const live = new Set(rows.map((row) => row.pid));
  return {
    tree: rows.filter((row) => tree.has(row.pid)),
    orphans: win ? rows.filter((row) => !tree.has(row.pid) && !live.has(row.parent) && Number(row.time) >= since) : [],
  };
}

// With every file skipped there is nothing to run; node --test with no file would search the directory.
if (!run.length) return;
const started = Date.now();
const child = cp.spawn(process.execPath, args, { stdio: 'inherit', env });
// A job its time limit cancels keeps no log, so a shard stops a few minutes under
// the test job's limit: it prints the processes the run still holds, stops them
// and fails. test/ci-required.test.js holds the default under that limit.
const deadlineMin = Number(process.env.TC_TEST_SHARD_DEADLINE_MIN || (shard ? SHARD_DEADLINE_MIN : 0));
let late = false;
const deadline = deadlineMin > 0 && setTimeout(() => { // wait-allow: the shard deadline CI sets under its job limit
  late = true;
  const { tree, orphans } = processTree(child.pid, started);
  console.error(`tower-crane: shard deadline of ${deadlineMin} min reached; processes still running (pid, parent, ${process.platform === 'win32' ? 'created at ms' : 'elapsed'}, command):`);
  for (const row of tree) console.error(`  ${row.pid} ${row.parent} ${row.text}`);
  if (orphans.length) console.error('tower-crane: started during the run, parent gone:');
  for (const row of orphans) console.error(`  ${row.pid} ${row.parent} ${row.text}`);
  if (process.platform === 'win32') {
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    for (const row of [...tree, ...orphans]) cp.spawnSync('taskkill', ['/PID', String(row.pid), '/F'], { stdio: 'ignore', windowsHide: true });
  } else for (const row of tree) try { killPid(row.pid, 'SIGKILL'); } catch { /* It ended meanwhile. */ }
  // The job must end with this log even if a stopped process never reports its exit.
  setTimeout(() => process.exit(1), 10000).unref(); // wait-allow: last resort after the deadline's stop
}, deadlineMin * 60000);
child.on('error', (error) => {
  clearTimeout(deadline);
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (status, signal) => {
  clearTimeout(deadline);
  if (late) process.exitCode = 1;
  else if (signal) process.exitCode = 128 + (os.constants.signals[signal] || 0);
  else process.exitCode = status ?? 1;
});
