'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { suiteTime, reportSuiteTime, DEADLINE_MIN } = require('./suite-time');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');

// The gate bounds each suite run. A failing head runs the suite again on the
// base for the failing names, so the probe outlasts two runs and still gets
// the gate's report naming the failures.
const TESTS_MIN = DEADLINE_MIN;

function contents(root) {
  return fs.readdirSync(root, { recursive: true }).sort();
}

// The tests gate keeps completed base reruns in the gate root on purpose, shared
// across gates and pruned (docs/state.md); the rest of the root is gate scratch.
const BASE_CACHE = 'tests-base-cache';
const baseCache = (entries) => entries.filter((entry) => entry.split(path.sep)[0] === BASE_CACHE);
const scratch = (entries) => entries.filter((entry) => entry.split(path.sep)[0] !== BASE_CACHE);

// The test threads the host governor grants the gate's run, read from its registry every few
// seconds by a child process while the check blocks this one. Each line is a change: the time,
// the budget and its reasons, and the grant of each lease the proof's state holds.
const SAMPLE_MS = 5000;
function sampleGrants(env, stateDir, file, every = SAMPLE_MS) {
  const governor = require('../lib/governor');
  const project = path.resolve(stateDir);
  let last = null;
  const sample = () => {
    const reg = governor.read(env);
    const leases = (reg?.tests || []).filter((l) => l.project === project);
    const b = reg?.test_budget || {};
    const row = { budget: b.budget ?? null, cap: b.cap ?? null, cores: b.cores ?? null, source: b.source ?? null,
      others: b.others ?? null, load: b.load ?? null, cpu_some: b.cpu_some ?? null, reasons: b.reasons || [],
      grants: leases.map((l) => [l.granted, l.requested]) };
    const key = JSON.stringify([row.budget, row.grants, row.reasons.length > 0]);
    if (key !== last) fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
    last = key;
  };
  sample();
  setInterval(sample, every);
  // The proof closes stdin when the check returns, or by exiting.
  process.stdin.on('end', () => process.exit(0)).resume();
}

function readGrants(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => {
    try { return line ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

// One line for the log: how many threads the gate's run held from each change to the next.
function grantSummary(rows, end) {
  const held = new Map();
  rows.forEach((row, i) => {
    const until = Date.parse(rows[i + 1]?.at ?? end);
    const grant = row.grants.reduce((n, [g]) => n + g, 0);
    held.set(grant, (held.get(grant) || 0) + Math.max(0, until - Date.parse(row.at)));
  });
  const minutes = [...held].sort(([a], [b]) => a - b).map(([g, ms]) => `${g} for ${(ms / 60000).toFixed(1)} min`);
  const top = rows.find((row) => row.cores);
  return `test threads granted ${minutes.join(', ') || 'never sampled'}${top ? ` (cap ${top.cap} on ${top.cores} cores)` : ''}`;
}

// A separate state exercises the real gate without changing the project's tasks.
function probe({ root = ROOT, cache, command, environment = process.env, sampleMs = SAMPLE_MS } = {}) {
  if (!command && (environment.TOWER_CRANE_SANDBOX === '1' || environment.TOWER_CRANE_BROKER)) {
    throw new Error('the complete gate scratch proof must run on the host, outside the worker sandbox');
  }
  cache ||= environment.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-proof');
  command ||= 'node test/run.js --test-concurrency=3';
  fs.mkdirSync(cache, { recursive: true });
  const run = fs.mkdtempSync(path.join(cache, 'gate-scratch-proof-'));
  const outer = path.join(run, 'outer');
  const gates = path.join(run, 'gates');
  const state = path.join(run, 'state');
  const env = { ...environment };
  // Host readings describe the machine, independently of the probe's fresh state.
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOWER_CRANE_') && key !== 'TOWER_CRANE_HOST_ROOT'
      || key.startsWith('TC_TEST_') || key === 'NODE_TEST_CONTEXT') delete env[key];
  }
  // Tests use an isolated governor; host measurements still use the real host.
  // A fake host made here is written inside the try below, so the run's removal covers it.
  const fakeHost = !environment.TOWER_CRANE_HOST_ROOT && (environment.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT);
  if (environment.TOWER_CRANE_HOST_ROOT) env.TOWER_CRANE_HOST_ROOT = environment.TOWER_CRANE_HOST_ROOT;
  else if (fakeHost) env.TOWER_CRANE_HOST_ROOT = path.join(run, 'host');
  Object.assign(env, {
    TMPDIR: outer, TMP: outer, TEMP: outer,
    TOWER_CRANE_TMP: gates,
    TOWER_CRANE_CONFIG: path.join(run, 'config.json'),
    // The CLI's own cache is separate; the gate must relocate this for its children.
    NODE_COMPILE_CACHE: path.join(run, 'runner-compile-cache'),
  });
  const result = { command, root, outer, gate_root: gates, started_at: new Date().toISOString() };
  const call = (args, agent = 'orchestrator') => {
    const argv = [BIN, ...args, '--agent', agent, '--state', state, '--json'];
    const out = cp.spawnSync(process.execPath, argv, {
      cwd: root, env, encoding: 'utf8', timeout: (2 * TESTS_MIN + 2) * 60 * 1000, maxBuffer: 16 << 20,
    });
    if (out.error) throw out.error;
    let data = null;
    try {
      data = out.stdout.trim() ? JSON.parse(out.stdout) : null;
    } catch (error) {
      if (args[0] !== 'check') throw error;
    }
    if (args[0] === 'check' && !data) {
      throw new Error(`tower-crane ${args.join(' ')} returned no JSON (exit code ${out.status}): ${out.stderr.trim() || '(no stderr)'}`);
    }
    if (out.status !== 0 && args[0] !== 'check') {
      throw new Error(`tower-crane ${args.join(' ')} failed: ${out.stderr || out.stdout}`);
    }
    return { data, status: out.status, stderr: out.stderr };
  };
  try {
    if (fakeHost) require('../test/host').writeHost(env.TOWER_CRANE_HOST_ROOT);
    for (const dir of [outer, gates]) fs.mkdirSync(dir);
    result.sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
    call(['init', '--name', 'Gate scratch proof', '--goal', 'Measure full-gate scratch cleanup',
      '--tests-mode', 'run-only', '--tests-cmd', command, '--tests-timeout-min', String(TESTS_MIN)]);
    const task = call(['task', 'add', '--title', 'Gate scratch proof', '--acceptance', 'Scratch is removed']).data;
    const id = task.id;
    call(['claim', id], 'scratch-proof-worker');
    call(['submit', id, '--sha', result.sha], 'scratch-proof-worker');
    result.outer_before = contents(outer);
    result.gate_root_before = contents(gates);
    const grantsFile = path.join(run, 'test-threads.jsonl');
    const sampler = cp.spawn(process.execPath, [__filename, '--sample-grants', state, grantsFile, String(sampleMs)],
      { cwd: root, env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    sampler.on('error', () => {});
    const started = performance.now();
    let checked;
    try {
      checked = call(['check', 'tests', id]);
    } finally {
      sampler.stdin.end();
      sampler.kill();
    }
    result.test_threads = readGrants(grantsFile);
    // A passing head runs the suite once, so this is its wall time; a failing
    // head adds the base rerun, and the proof fails anyway.
    result.suite_time = suiteTime(performance.now() - started);
    result.gate = checked.data;
    result.exit = checked.status;
    result.stderr = checked.stderr;
    result.outer_after = contents(outer);
    const after = contents(gates);
    result.gate_root_after = scratch(after);
    result.base_cache_after = baseCache(after);
    // Receipts name the worktree actually created, rather than a guessed parent path.
    const commands = Array.isArray(checked.data?.commands) ? checked.data.commands : [];
    const worktrees = commands.filter((c) => c.args.includes('worktree') && c.args.includes('add'))
      .flatMap((c) => c.args.filter((arg) => arg.startsWith(gates + path.sep) && path.basename(arg) === 'wt'));
    result.gate_parents = [...new Set(worktrees.map((dir) => path.dirname(dir)))]
      .map((parent) => ({ path: parent, removed: !fs.existsSync(parent) }));
    result.cleanup_ok = result.outer_before.length === 0 && result.outer_after.length === 0
      && result.gate_root_before.length === 0 && result.gate_root_after.length === 0
      && result.gate_parents.length > 0 && result.gate_parents.every((parent) => parent.removed);
    result.ok = checked.status === 0 && checked.data?.ok === true && result.cleanup_ok;
    result.finished_at = new Date().toISOString();
    return result;
  } finally {
    // Measurement precedes this cleanup, so removing the probe cannot hide a gate leak.
    fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module && process.argv[2] === '--sample-grants') {
  sampleGrants(process.env, process.argv[3], process.argv[4], Number(process.argv[5]) || SAMPLE_MS);
} else if (require.main === module) {
  const result = probe();
  const file = process.env.TOWER_CRANE_PROOF_OUTPUT
    || path.join(process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-proof'), 'gate-scratch-proof.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`Gate scratch proof: ${file}`);
  if (result.suite_time) reportSuiteTime('Gate scratch proof', result.suite_time);
  console.log(`Gate scratch proof: ${grantSummary(result.test_threads || [], result.finished_at)}`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = { probe, grantSummary };
