'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'tower-crane.js');

// The gate bounds each suite run. A failing head runs the suite again on the
// base for the failing names, so the probe outlasts two runs and still gets
// the gate's report naming the failures.
const TESTS_MIN = 45;

function contents(root) {
  return fs.readdirSync(root, { recursive: true }).sort();
}

// A separate state exercises the real gate without changing the project's tasks.
function probe({ root = ROOT, cache, command, environment = process.env } = {}) {
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
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOWER_CRANE_') || key.startsWith('TC_TEST_') || key === 'NODE_TEST_CONTEXT') delete env[key];
  }
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
    const data = out.stdout.trim() ? JSON.parse(out.stdout) : null;
    if (out.status !== 0 && args[0] !== 'check') {
      throw new Error(`tower-crane ${args.join(' ')} failed: ${out.stderr || out.stdout}`);
    }
    return { data, status: out.status, stderr: out.stderr };
  };
  try {
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
    const checked = call(['check', 'tests', id]);
    result.gate = checked.data;
    result.exit = checked.status;
    result.stderr = checked.stderr;
    result.outer_after = contents(outer);
    result.gate_root_after = contents(gates);
    // Receipts name the worktree actually created, rather than a guessed parent path.
    const worktrees = checked.data.commands.filter((c) => c.args.includes('worktree') && c.args.includes('add'))
      .flatMap((c) => c.args.filter((arg) => arg.startsWith(gates + path.sep) && path.basename(arg) === 'wt'));
    result.gate_parents = [...new Set(worktrees.map((dir) => path.dirname(dir)))]
      .map((parent) => ({ path: parent, removed: !fs.existsSync(parent) }));
    result.cleanup_ok = result.outer_before.length === 0 && result.outer_after.length === 0
      && result.gate_root_before.length === 0 && result.gate_root_after.length === 0
      && result.gate_parents.length > 0 && result.gate_parents.every((parent) => parent.removed);
    result.ok = checked.status === 0 && checked.data.ok && result.cleanup_ok;
    result.finished_at = new Date().toISOString();
    return result;
  } finally {
    // Measurement precedes this cleanup, so removing the probe cannot hide a gate leak.
    fs.rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (require.main === module) {
  const result = probe();
  const file = process.env.TOWER_CRANE_PROOF_OUTPUT
    || path.join(process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-proof'), 'gate-scratch-proof.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`Gate scratch proof: ${file}`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = { probe };
