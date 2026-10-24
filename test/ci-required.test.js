'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { BIN, cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const REQUIRED = [
  'test (ubuntu-latest, node 26, shard 1/3)',
  'test (ubuntu-latest, node 26, shard 2/3)',
  'test (ubuntu-latest, node 26, shard 3/3)',
  'test (ubuntu-latest, node 24, shard 1/3)',
  'test (ubuntu-latest, node 24, shard 2/3)',
  'test (ubuntu-latest, node 24, shard 3/3)',
  'test (windows-latest, node 26, shard 1/4)',
  'test (windows-latest, node 26, shard 2/4)',
  'test (windows-latest, node 26, shard 3/4)',
  'test (windows-latest, node 26, shard 4/4)',
];
const CAP_POLICY = [{ app: 'revuto-review', pattern: 'reached the \\d+-round review limit' }];
const github = path.join(__dirname, 'fixtures', 'github.js');

function readWorkflow(root) {
  // Windows checkouts can write CRLF line endings; the patterns below expect LF.
  return fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
}

// Every event that runs the test job runs the whole matrix.
function workflowMatrix(workflow) {
  // Inclusions apply after exclusions; each one here names a whole job.
  const included = [...workflow.matchAll(/^[ \t]+- \{ os: ([^,}\n]+), node: (\d+), shard: '(\d+\/\d+)' \}$/gm)]
    .map(([, os, node, shard]) => ({ os, node: Number(node), shard }));

  // Read the workflow's axes, rather than a second matrix in the test.
  const systems = JSON.parse(workflow.match(/^\s+os: (\[[^\n]+\])/m)[1].replace(/'/g, '"'));
  const nodes = JSON.parse(workflow.match(/^\s+node: (\[[^\n]+\])/m)[1]);
  const shards = JSON.parse(workflow.match(/^\s+shard: (\[[^\n]+\])/m)[1].replace(/'/g, '"'));
  // An exclusion matches every job that agrees with the keys it names.
  const excluded = [...workflow.matchAll(/^[ \t]+- \{ os: ([^,}\n]+)(?:, node: (\d+))? \}$/gm)];
  return [...systems.flatMap((os) => nodes.flatMap((node) => shards.map((shard) => ({ os, node, shard }))))
    .filter((entry) => !excluded.some(([, os, node]) => entry.os === os && (node === undefined || entry.node === Number(node)))),
  ...included];
}

function jobNames(matrix) {
  return matrix.map(({ os, node, shard }) => `test (${os}, node ${node}, shard ${shard})`);
}

test('package support, CI matrix, and required jobs target Node 24 and 26', () => {
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=24');

  const workflow = readWorkflow(root);
  const matrix = workflowMatrix(workflow);
  // Each OS and Node pair must run every shard of its split once, and no other shard.
  const jobs = new Map();
  for (const entry of matrix) {
    const job = `${entry.os} node ${entry.node}`;
    jobs.set(job, [...(jobs.get(job) || []), entry]);
  }
  for (const [job, shards] of jobs) {
    const total = Number(shards[0].shard.split('/')[1]);
    assert.deepEqual(shards.map(({ shard }) => shard), Array.from({ length: total }, (_, i) => `${i + 1}/${total}`), `${job} shards`);
  }
  assert.deepEqual(jobNames(matrix), REQUIRED);

  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\bNode 24 or newer\b/);
});

test('pull requests run CI for every base, with main pushes, release tags, daily and manual runs', () => {
  const root = path.resolve(__dirname, '..');
  const workflow = readWorkflow(root);
  // A base filter would drop CI from stacks on custom task branches, which submission accepts.
  assert.match(workflow, /^on:\n {2}pull_request:\n(?: {4}#.*\n)* {2}push:\n {4}branches: \[main\]\n(?: {4}#.*\n)* {4}tags: \['v\*'\]\n/m);
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[0-9]+ [0-9]+ \* \* \*'\n/m);
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/m);
});

function jobBlock(workflow, id) {
  return workflow.split(`\n  ${id}:\n`)[1].split(/\n {2}[\w-]+:\n/)[0];
}

// A job's `if:` under one event's github context and dispatch inputs. The workflow's conditions use
// ==, !=, !, &&, ||, startsWith and cancelled(), whose JavaScript forms mean the same for these values.
function runsOn(workflow, id, { inputs = {}, ...github }, cancelled = false) {
  const condition = /^ {4}if: (.+)$/m.exec(jobBlock(workflow, id))?.[1];
  if (!condition) return true;
  const value = (root, name) => JSON.stringify(name.split('.').slice(1).reduce((o, k) => o?.[k], root) ?? null);
  const js = condition.replace(/^"(.*)"$/, '$1').replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/github(?:\.[\w]+)+/g, (name) => value(github, name))
    .replace(/inputs(?:\.[\w]+)+/g, (name) => value(inputs, name));
  return Function('startsWith', 'cancelled', 'always', `return (${js});`)((a, b) => String(a).startsWith(b), () => cancelled, () => true);
}

const REPO = 'agent-sh/tower-crane';
const EVENTS = {
  'main push': { event_name: 'push', ref: 'refs/heads/main', repository: REPO },
  'same-repository PR': { event_name: 'pull_request', ref: 'refs/pull/7/merge', repository: REPO, event: { pull_request: { head: { repo: { full_name: REPO } } } } },
  'fork PR': { event_name: 'pull_request', ref: 'refs/pull/8/merge', repository: REPO, event: { pull_request: { head: { repo: { full_name: 'someone/tower-crane' } } } } },
  'release tag': { event_name: 'push', ref: 'refs/tags/v0.1.0', repository: REPO },
  schedule: { event_name: 'schedule', ref: 'refs/heads/main', repository: REPO },
  'manual run': { event_name: 'workflow_dispatch', ref: 'refs/heads/main', repository: REPO },
  'profile dispatch': { event_name: 'workflow_dispatch', ref: 'refs/heads/main', repository: REPO, inputs: { profile: true } },
};

test('main pushes and same-repo PRs run only the shared check; fork PRs, tags, daily and manual runs the full matrix', () => {
  const workflow = readWorkflow(path.resolve(__dirname, '..'));
  const jobs = [...workflow.split('\njobs:\n')[1].matchAll(/^ {2}([\w-]+):\n/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ['checks', 'test', 'coverage-map', 'repeats', 'gate-scratch', 'model-swap', 'profile', 'mutants']);
  const full = ['test', 'repeats', 'gate-scratch', 'model-swap'];
  for (const [event, expected] of [
    ['main push', ['checks']],
    ['same-repository PR', ['checks']],
    ['fork PR', full],
    ['release tag', full],
    ['schedule', [...full, 'coverage-map']],
    ['manual run', [...full, 'coverage-map']],
    ['profile dispatch', ['profile', 'mutants']],
  ]) {
    assert.deepEqual(jobs.filter((id) => runsOn(workflow, id, EVENTS[event])).sort(), expected.sort(), event);
  }
  // The daily and manual runs collect coverage on the three Linux Node 26 shards, which run every file.
  const coverage = /TC_TEST_COVERAGE_DIR: \$\{\{ (.+) && format\('\{0\}\/coverage', runner\.temp\) \|\| '' \}\}/.exec(jobBlock(workflow, 'test'))?.[1];
  assert.ok(coverage, 'the shard step sets TC_TEST_COVERAGE_DIR from the event and matrix');
  for (const [event, github] of Object.entries(EVENTS)) {
    if (!runsOn(workflow, 'test', github)) continue;
    const shards = workflowMatrix(workflow).filter((m) => Function('github', 'matrix', `return (${coverage});`)(github, m));
    assert.deepEqual(jobNames(shards), ['schedule', 'manual run'].includes(event) ? REQUIRED.slice(0, 3) : [], event);
  }
  assert.match(jobBlock(workflow, 'coverage-map'), /node scripts\/tests-coverage-map\.js merge --out /);
  assert.match(jobBlock(workflow, 'coverage-map'), /name: tests-coverage-map\n/);
  for (const event of ['schedule', 'manual run']) {
    assert.equal(runsOn(workflow, 'coverage-map', EVENTS[event], true), true, `${event}: collect available maps after a cancelled shard`);
  }
});

test('the matrix is all ten shards, beside the proofs and the repeat job', () => {
  const workflow = readWorkflow(path.resolve(__dirname, '..'));
  assert.deepEqual(jobNames(workflowMatrix(workflow)), REQUIRED);
  assert.equal([...workflow.matchAll(/^ {2}test:\n/gm)].length, 1, 'one test job owns the matrix');
  assert.match(workflow, /^ {4}name: test \(\$\{\{ matrix\.os \}\}, node \$\{\{ matrix\.node \}\}, shard \$\{\{ matrix\.shard \}\}\)$/m);
  const testJob = workflow.split('\n  test:\n')[1].split(/\n {2}[\w-]+:\n/)[0];
  const checks = jobBlock(workflow, 'checks');
  assert.match(checks, /^ {4}name: checks \(shared files\)$/m);
  // A main push checks the pushed range.
  assert.match(checks, /- run: npm run check:shared\n {8}env:\n {10}TOWER_CRANE_CHANGE_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
  assert.doesNotMatch(checks, /npm test/, 'the PR check does not run the suite');
  assert.match(testJob, /- run: npm run check:shared/);
  assert.match(testJob, /- name: npm test\n {8}run: [^\n]*'npm test'[^\n]*\n[\s\S]*TC_TEST_SHARD: \$\{\{ matrix\.shard \}\}/);
  for (const id of ['gate-scratch', 'model-swap']) assert.match(jobBlock(workflow, id), /- run: node scripts\/probe-/);
  // Flake repeat loops cost hosted Windows time on every PR; they run after merge and daily, in
  // their own job so the shards keep the share of the suite test/run.js measured for them.
  assert.doesNotMatch(testJob, /- name: Repeat /, 'the test shards run no repeat loops');
  const repeatJob = jobBlock(workflow, 'repeats');
  // A profile dispatch measures the suite and the mutation sample on hosted runners and runs nothing else.
  assert.match(workflow, /^ {6}profile:\n {8}description: [^\n]+\n {8}type: boolean\n {8}default: false\n {6}profile_baseline:\n/m);
  for (const [id, command] of [['profile', /- run: node scripts\/suite-profile\.js [^\n]*--baseline "\$BASELINE" --runs 3 [^\n]*\| tee /],
    ['mutants', /- run: node scripts\/mutants\.js --no-full 2>&1 \| tee /]]) {
    const job = workflow.split(`\n  ${id}:\n`)[1].split(/\n {2}[\w-]+:\n/)[0];
    assert.match(job, /^ {4}if: github\.event_name == 'workflow_dispatch' && inputs\.profile$/m, `${id} runs on a profile dispatch only`);
    assert.match(job, command, id);
    assert.match(job, /\| tee [^\n]*\n(?: {8}#[^\n]*\n)* {8}shell: bash\n/, `${id}: pipefail keeps the exit status through tee`);
    assert.match(job, /uses: actions\/upload-artifact@/, `${id} keeps its output`);
  }
  assert.match(repeatJob, /^ {4}runs-on: windows-latest$/m);
  const repeats = [...repeatJob.matchAll(/- name: (Repeat [^\n]+)/g)].map((m) => m[1]);
  assert.deepEqual(repeats, ['Repeat Claude Code mod wakeup twenty times', 'Repeat Claude interrupted native worker ten times',
    'Repeat lock-free reader and torn recovery tests thirty times', 'Repeat state compatibility twenty times',
    'Repeat owner authority and board approval files ten times', 'Repeat interrupt during backoff and origin read tests twenty times',
    'Repeat mutation containment tests ten times'],
  'the wakeup loop runs first, on a fresh runner');
  // GitHub keeps one running and one pending run per group, and a newer run replaces the pending one.
  // Main pushes share a group so only the newest pending head waits; tag, scheduled and manual runs stay unique.
  assert.match(workflow, /^concurrency:\n {2}group: \$\{\{ github\.event_name == 'pull_request' && format\('ci-pr-\{0\}', github\.event\.pull_request\.number\) \|\| github\.ref == 'refs\/heads\/main' && github\.event_name == 'push' && 'ci-main-push' \|\| format\('ci-run-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m,
    'PR runs cancel per PR; main pushes share one group that never cancels a running run; tag, scheduled and manual runs are unique');
});

test('a shard reaches its deadline, and leaves a log, before the test step and job limits cancel it without one', () => {
  const root = path.resolve(__dirname, '..');
  const workflow = readWorkflow(root);
  const testJob = workflow.split('\n  test:\n')[1].split(/\n {2}[\w-]+:\n/)[0];
  const limit = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(testJob)?.[1]);
  const step = testJob.split('- name: npm test\n')[1].split(/\n {6}- /)[0];
  const stepLimit = Number(/^ {8}timeout-minutes: (\d+)$/m.exec(step)?.[1]);
  const { SHARD_DEADLINE_MIN } = require('./run');
  // The watchdog's process dump and stop take up to two minutes.
  assert.ok(SHARD_DEADLINE_MIN <= stepLimit - 4, `shard deadline ${SHARD_DEADLINE_MIN} min against a ${stepLimit} min test step limit`);
  // On Windows a process outside node runs the tests and stops them when node's own watchdog could not.
  assert.match(step, /^ {8}run: \$\{\{ runner\.os == 'Windows' && 'pwsh -NoProfile -File scripts\/shard-guard\.ps1 npm test' \|\| 'npm test' \}\}$/m);
  const guard = /^ {10}TC_SHARD_GUARD_DEADLINE_MIN: \$\{\{ inputs\.hang && '2' \|\| '(\d+)' \}\}$/m.exec(step);
  assert.ok(guard, 'the workflow sets the guard deadline, 2 minutes for a hang run');
  const guardMin = Number(guard[1]);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'shard-guard.ps1'), 'utf8'), new RegExp(`TC_SHARD_GUARD_DEADLINE_MIN : ${guardMin}\\)`), 'the script default matches CI');
  // The guard's dump, bounded CIM query and stop take about a minute.
  assert.ok(SHARD_DEADLINE_MIN < guardMin && guardMin <= stepLimit - 2, `guard deadline ${guardMin} min between the ${SHARD_DEADLINE_MIN} min shard deadline and the ${stepLimit} min step limit`);
  // A hang run blocks node, and on Windows node's watchdog waits past the guard, so the guard is what stops it.
  assert.match(step, /^ {10}TC_TEST_SHARD_DEADLINE_MIN: \$\{\{ inputs\.hang && \(runner\.os == 'Windows' && '(\d+)' \|\| '2'\) \|\| '' \}\}$/m);
  assert.ok(Number(/runner\.os == 'Windows' && '(\d+)' \|\| '2'/.exec(step)[1]) > 2, 'node waits past the guard in a hang run');
  for (const name of ['TC_SHARD_GUARD_MAX_PROCESSES', 'TC_SHARD_GUARD_MAX_MEMORY_MB']) {
    assert.ok(Number(new RegExp(`^ {10}${name}: (\\d+)$`, 'm').exec(step)?.[1]) > 0, `${name} bounds the job`);
  }
  // Progress leaves the VM as a check run while the shard runs; only Windows gets the token, and the tests never see it.
  assert.match(testJob, /^ {4}permissions:\n {6}contents: read\n {6}checks: write\n/m);
  assert.match(step, /^ {10}TC_SHARD_PROGRESS_CHECK: shard progress \(\$\{\{ matrix\.os \}\}, node \$\{\{ matrix\.node \}\}, shard \$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(step, /^ {10}TC_SHARD_PROGRESS_TOKEN: \$\{\{ runner\.os == 'Windows' && github\.token \|\| '' \}\}$/m);
  // Checkout, Node setup and check:shared run before the step, and the upload after it.
  assert.ok(stepLimit <= limit - 4, `test step limit ${stepLimit} min against a ${limit} min job limit`);
  assert.match(step, /^ {10}TC_TEST_SHARD_LOG_DIR: \$\{\{ runner\.temp \}\}\/shard-log$/m);
  const upload = testJob.split('- name: Save shard progress\n')[1];
  assert.match(upload, /^ {8}if: always\(\)\n {8}uses: actions\/upload-artifact@/, 'the progress uploads on every outcome');
  assert.match(upload, /^ {10}path: \$\{\{ runner\.temp \}\}\/shard-log$/m);
});

test('the stack section says hosted CI runs on every stack member at its own base', () => {
  const root = path.resolve(__dirname, '..');
  const state = fs.readFileSync(path.join(root, 'docs', 'state', 'stacks.md'), 'utf8');
  assert.match(state, /Hosted CI runs on every stack member at its own base\. `ci\.yml` has no base filter on pull requests\b/);
});

test('the model swap proof checks out the PR merge, so a branch older than its probe still runs it', () => {
  const root = path.resolve(__dirname, '..');
  // A Windows checkout writes CRLF line endings.
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = workflow.slice(workflow.indexOf('\n  model-swap:\n'));
  // Pinning the head sha checks out a branch that predates scripts/probe-model-swap.js.
  assert.doesNotMatch(job, /pull_request\.head\.sha/);
  assert.match(job, /node scripts\/probe-model-swap\.js/);
});

function run(name, conclusion = 'success', status = 'completed', app = 'github-actions', id = 1) {
  return { name, conclusion, status, app: { slug: app }, check_suite: { id } };
}

const CODEQL = [run('CodeQL'), run('Analyze (javascript-typescript)'), run('CodeQL (javascript-typescript)')];
const CAPPED = {
  ...run('Revuto', 'failure', 'completed', 'revuto-review', 2),
  output: { title: 'Revuto did not review this pull request', summary: 'reached the 2-round review limit' },
};

function fixture(t, withPr = true) {
  const h = cachedFixture(t, String(withPr), (h) => {
    h.init(['--repo', 'acme/app']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    // Submit with a PR reads its checks, so it needs the fake gh that gateFixture puts on PATH.
    const sha = gateFixture(h);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, ...(withPr ? ['--pr', '40'] : [])]);
    return { sha };
  });
  const { sha } = h;
  return {
    check({ pr = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, runs = REQUIRED.map((name) => run(name)), ci = {}, suites: given, workflows = [], spawnFailure = null } = {}) {
      const project = h.readState('project.json');
      h.writeState('project.json', { ...project, ci: { required: REQUIRED, capped_review: CAP_POLICY, ...ci } });
      const file = path.join(h.base, 'github.json');
      const suites = given ?? [...new Set(runs.map((c) => c.check_suite.id))].map((id) => {
        const linked = runs.filter((c) => c.check_suite.id === id);
        return {
          id, app: linked[0].app, status: 'completed',
          conclusion: linked.some((c) => c.conclusion === 'failure') ? 'failure' : 'success',
          latest_check_runs_count: linked.length,
        };
      });
      fs.writeFileSync(file, JSON.stringify({ sha, pr, runs, suites, workflows }));
      const preload = [];
      if (spawnFailure) {
        const failureFile = path.join(h.base, 'gh-failure.cjs');
        fs.writeFileSync(failureFile, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => cmd === 'gh' && args[0] === 'api'
  ? ${JSON.stringify(spawnFailure)} : original(cmd, args, opts);
`);
        preload.push('--require', failureFile);
      }
      const r = cp.spawnSync(process.execPath, ['--require', github, ...preload, BIN, 'check', 'ci', 'T1', '--agent', 'checker', '--json'], {
        cwd: h.repo, env: { ...h.env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 300000,
      });
      assert.ok(r.stdout, r.stderr);
      const evidence = JSON.parse(r.stdout);
      assert.equal(evidence.sha, sha);
      const { task, ...stored } = evidence;
      assert.equal(task, 'T1');
      assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1), stored);
      return { code: r.status, ...evidence };
    },
  };
}

test('CI evidence records an empty-output gh startup failure', (t) => {
  const r = fixture(t, false).check({
    spawnFailure: { status: null, signal: null, error: { code: 'EAGAIN', message: 'spawnSync gh EAGAIN' } },
  });
  assert.equal(r.code, 1);
  assert.equal(r.ok, false);
  assert.match(r.summary, /status=null/);
  assert.match(r.summary, /EAGAIN: spawnSync gh EAGAIN/);
  assert.match(r.summary, /no output/);
});

test('documented fork PR job lists pass CI with the full matrix check runs', (t) => {
  const root = path.resolve(__dirname, '..');
  const names = jobNames(workflowMatrix(readWorkflow(root)));
  const h = fixture(t);
  for (const file of ['docs/state/tasks.md', 'docs/cli.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const documented = text.match(/(?:PR test jobs are|matrix jobs have these full names:)\s+`(\[[^`]+\])`/);
    assert.ok(documented, `${file} documents the PR job names`);
    const required = JSON.parse(documented[1]);
    const r = h.check({ ci: { required }, runs: [...CODEQL, ...names.map((name) => run(name))] });
    assert.equal(r.code, 0, `${file}: ${r.summary}`);
    assert.deepEqual(required, names, `${file} requires every PR shard`);
  }
});

test('T71 regression: conflicts block CodeQL successes plus a capped review with no test workflow', (t) => {
  const r = fixture(t).check({
    pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    runs: [...CODEQL, CAPPED],
  });
  assert.equal(r.code, 1, r.summary);
  assert.equal(r.ok, false);
  assert.match(r.summary, /PR #40.*CONFLICTING.*conflict/i);
  assert.doesNotMatch(r.summary, /CI green/);
  assert.equal(r.commands.length, 1, 'conflicts fail before reading check runs');
  assert.equal(r.commands[0].args.at(-1), 'state,headRefOid,mergeable,mergeStateStatus');
});

test('unknown or absent mergeability requires a later check even with successful tests', (t) => {
  const h = fixture(t);
  for (const pr of [
    { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'MERGEABLE' },
    {},
    { mergeable: 'unexpected', mergeStateStatus: 'CLEAN' },
  ]) {
    const r = h.check({ pr });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /mergeability.*(unknown|unavailable).*retry/i);
  }
});

test('conflicts block even successful required tests or an empty required list', (t) => {
  const h = fixture(t);
  for (const pr of [
    { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    { mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' },
  ]) {
    const r = h.check({ pr, ci: { required: [] } });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /CONFLICTING.*conflict/i);
  }
});

test('a mergeable PR with only CodeQL and a capped review reports every missing matrix job', (t) => {
  const r = fixture(t).check({ runs: [...CODEQL, CAPPED] });
  assert.equal(r.code, 1, r.summary);
  assert.match(r.summary, /missing required check runs/);
  for (const name of REQUIRED) assert.ok(r.summary.includes(name), r.summary);
});

test('every named job must run, and all required jobs pass even when reviews block merging', (t) => {
  const h = fixture(t);
  for (const missing of REQUIRED) {
    const r = h.check({ runs: [...CODEQL, ...REQUIRED.filter((name) => name !== missing).map((name) => run(name)), CAPPED] });
    assert.equal(r.code, 1, r.summary);
    assert.ok(r.summary.includes(missing), r.summary);
  }
  const r = h.check({
    pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' },
    runs: [...REQUIRED.map((name) => run(name)), CAPPED],
  });
  assert.equal(r.code, 0, r.summary);
  assert.equal(r.ok, true);
});

test('a literal required prefix needs matching jobs, all completed successfully', (t) => {
  const h = fixture(t);
  const ci = { required: ['test ('] };
  assert.equal(h.check({ ci }).code, 0);
  assert.equal(h.check({ ci, runs: REQUIRED.filter((name) => name.includes('windows-latest')).map((name) => run(name)) }).code, 0);
  assert.equal(h.check({ ci, runs: CODEQL }).code, 1);
  for (const [conclusion, status] of [
    ['skipped', 'completed'], ['neutral', 'completed'], ['failure', 'completed'],
    ['cancelled', 'completed'], ['timed_out', 'completed'], [null, 'queued'], [null, 'in_progress'],
  ]) {
    const r = h.check({ ci, runs: [run(REQUIRED[0]), run(REQUIRED[1], conclusion, status)] });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /required check runs not successful/);
    assert.ok(r.summary.includes(REQUIRED[1]), r.summary);
  }
});

test('ignored apps and capped failures cannot satisfy required checks', (t) => {
  const h = fixture(t);
  const ignored = h.check({ ci: { required: ['test ('], ignore_apps: ['github-actions'] }, runs: [...REQUIRED.map((name) => run(name)), CAPPED] });
  assert.equal(ignored.code, 1, ignored.summary);
  assert.match(ignored.summary, /missing required check runs.*test \(/);
  const capped = h.check({ ci: { required: ['Revuto'] }, runs: [...CODEQL, CAPPED] });
  assert.equal(capped.code, 1, capped.summary);
  assert.match(capped.summary, /required check runs not successful.*Revuto/);
});

for (const status of ['missing', 'pending']) {
  test(`completed uncapped CI failures stay confirmed when a required check is ${status}`, (t) => {
    const h = fixture(t);
    const required = status === 'pending' ? [run('required-build', null, 'in_progress')] : [];
    for (const [other, confirmed] of [
      [run('outside-test', 'failure'), true],
      [run('outside-test'), false],
      [run('outside-test', null, 'in_progress'), false],
      [run('outside-test', 'cancelled'), false],
      [CAPPED, false],
      [run('ignored-test', 'failure', 'completed', 'ignored-app', 3), false],
    ]) {
      const result = h.check({
        ci: { required: ['required-build'], ignore_apps: ['ignored-app'] },
        runs: [...required, other],
      });
      assert.equal(result.code, 1, result.summary);
      assert.equal(result.confirmed_failure, confirmed ? true : undefined);
      assert.match(result.summary, status === 'missing' ? /missing required check runs/ : /required check runs not successful/);
      if (confirmed) assert.match(result.summary, /failing: outside-test \(failure\)/);
    }
  });
}

test('malformed required lists fail closed, while empty or absent lists preserve hosted defaults', (t) => {
  const h = fixture(t);
  for (const required of ['test (', {}, [null], [1], [''], [' \t']]) {
    const r = h.check({ ci: { required }, runs: CODEQL });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /ci\.required.*array.*non-blank strings/);
    assert.equal(r.commands.length, 0);
  }
  for (const required of [[], null, undefined]) {
    const r = h.check({ ci: { required }, runs: CODEQL });
    assert.equal(r.code, 0, r.summary);
  }
});

test('required checks also apply to a submitted head without a PR', (t) => {
  const h = fixture(t, false);
  const missing = h.check({ runs: CODEQL });
  assert.equal(missing.code, 1, missing.summary);
  assert.match(missing.summary, /missing required check runs/);
  assert.equal(h.check().code, 0);
});

test('a superseded failed run does not block: the latest run of each required check decides', (t) => {
  // T160 at f361335: one windows shard failed on 2026-10-09 and passed on a rerun the next day.
  const h = fixture(t);
  const name = 'test (windows-latest, node 26, shard 2/4)';
  const failed = { ...run(name, 'failure'), id: 114055863456, started_at: '2026-10-09T22:36:00Z' };
  const passed = { ...run(name, 'success'), id: 114217721960, started_at: '2026-10-10T12:54:00Z' };
  const others = REQUIRED.filter((n) => n !== name).map((n) => run(n));
  const suite = (id, conclusion, runs) => ({ id, app: { slug: 'github-actions' }, status: 'completed', conclusion, latest_check_runs_count: runs });

  // A rerun in the same suite: GitHub grades the suite by its current runs, so it is green. The stale run is listed first.
  const rerun = h.check({ runs: [failed, ...others, passed], suites: [suite(1, 'success', REQUIRED.length)] });
  assert.equal(rerun.code, 0, rerun.summary);
  assert.match(rerun.summary, /CI green/);

  // A reopened PR starts every workflow again in a new suite. The old suite keeps its failure with no current run.
  const reopened = h.check({
    runs: [
      { ...failed, check_suite: { id: 1 } },
      ...others.map((r) => ({ ...r, check_suite: { id: 1 }, started_at: '2026-10-09T22:36:00Z' })),
      ...others.map((r) => ({ ...r, check_suite: { id: 2 }, started_at: '2026-10-10T12:54:00Z' })),
      { ...passed, check_suite: { id: 2 } },
    ],
    suites: [suite(1, 'failure', REQUIRED.length), suite(2, 'success', REQUIRED.length)],
  });
  assert.equal(reopened.code, 0, reopened.summary);
  assert.match(reopened.summary, /CI green/);

  // The newest run decides: a later failure still blocks after an earlier success.
  const relapse = h.check({
    runs: [passed, { ...run(name, 'failure'), id: 114300000000, started_at: '2026-10-10T13:30:00Z' }, ...others],
    suites: [suite(1, 'failure', REQUIRED.length)],
  });
  assert.equal(relapse.code, 1, relapse.summary);
  assert.ok(relapse.summary.includes(`failing: ${name} (failure)`), relapse.summary);
});

test('an unfinished or partly read suite blocks even when its runs were superseded', (t) => {
  const h = fixture(t);
  const name = 'test (windows-latest, node 26, shard 2/4)';
  const old = { ...run(name, 'success'), id: 114055863456, started_at: '2026-10-09T22:36:00Z', check_suite: { id: 1 } };
  const current = { ...run(name, 'success'), id: 114217721960, started_at: '2026-10-10T12:54:00Z', check_suite: { id: 2 } };
  const others = REQUIRED.filter((n) => n !== name).map((n) => ({ ...run(n), check_suite: { id: 2 } }));
  const suite = (id, status, conclusion, runs) => ({ id, app: { slug: 'github-actions' }, status, conclusion, latest_check_runs_count: runs });
  const passing = suite(2, 'completed', 'success', REQUIRED.length);

  // The old suite has not finished, so more of its runs may still come.
  const running = h.check({ runs: [old, current, ...others], suites: [suite(1, 'in_progress', null, 1), passing] });
  assert.equal(running.code, 1, running.summary);
  assert.match(running.summary, /check suites not green.*in_progress/);

  // The old suite failed and reports two runs, but only one was read, so the other one is unknown.
  const partial = h.check({ runs: [old, current, ...others], suites: [suite(1, 'completed', 'failure', 2), passing] });
  assert.equal(partial.code, 1, partial.summary);
  assert.match(partial.summary, /check suites not green.*failure, 2 runs/);
});

function workflow(id, checkSuite, conclusion = 'success', extra = {}) {
  return {
    id, check_suite_id: checkSuite, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request',
    created_at: `2026-10-11T${id === 100 ? '10' : '11'}:00:00Z`,
    status: 'completed', conclusion, ...extra,
  };
}

function actionSuite(id, conclusion = 'success', extra = {}) {
  return { id, app: { slug: 'github-actions' }, status: 'completed', conclusion, latest_check_runs_count: REQUIRED.length, ...extra };
}

test('a newer passing workflow supersedes an old failed suite whose check runs are absent', (t) => {
  const h = fixture(t);
  const old = workflow(100, 1, 'failure');
  const current = workflow(200, 2);
  for (const workflows of [[old, current], [current, old]]) {
    const r = h.check({
      runs: REQUIRED.map((name) => run(name, 'success', 'completed', 'github-actions', 2)),
      suites: [actionSuite(1, 'failure'), actionSuite(2)],
      workflows,
    });
    assert.equal(r.code, 0, r.summary);
    assert.match(r.summary, /CI green.*1 check suites completed/);
    assert.match(r.summary, /Superseded workflow runs: .*ci\.yml.*pull_request.*100.*failure.*suite 1/);
    assert.doesNotMatch(r.summary, /check suites not green/);
    assert.equal(r.confirmed_failure, undefined);
    assert.ok(r.commands.some((c) => c.args.includes(`repos/acme/app/actions/runs?head_sha=${r.sha}&per_page=100`)));
  }
});

test('a newer failed workflow still blocks and its older passing run is recorded as superseded', (t) => {
  const r = fixture(t).check({
    runs: REQUIRED.map((name) => run(name, 'success', 'completed', 'github-actions', 2)),
    suites: [actionSuite(1), actionSuite(2, 'failure')],
    workflows: [workflow(200, 2, 'failure'), workflow(100, 1)],
  });
  assert.equal(r.code, 1, r.summary);
  assert.match(r.summary, /check suites not green: github-actions \(failure/);
  assert.match(r.summary, /Superseded workflow runs: .*100.*success.*suite 1/);
  assert.doesNotMatch(r.summary, /Superseded workflow runs: .*200/);
});

test('a queued rerun newer than a success is the current run: the gate waits for it', (t) => {
  // A queued run has no started_at yet, so the earlier success must not supersede it by its start time.
  const h = fixture(t);
  const name = 'test (windows-latest, node 26, shard 2/4)';
  const passed = { ...run(name, 'success'), id: 114217721960, started_at: '2026-10-10T12:54:00Z' };
  const queued = { ...run(name, null, 'queued'), id: 114300000000 };
  const others = REQUIRED.filter((n) => n !== name).map((n) => run(n));
  const suite = (id, status, conclusion, runs) => ({ id, app: { slug: 'github-actions' }, status, conclusion, latest_check_runs_count: runs });

  // The rerun is queued in the same suite, which is still running. A success that started earlier but has a higher id
  // is in the mix too: the verdict must hold whatever order GitHub lists the three runs in.
  const early = { ...run(name, 'success'), id: 114400000000, started_at: '2026-10-10T11:00:00Z' };
  const inSuite = [suite(1, 'in_progress', null, REQUIRED.length)];
  const orders = [
    [passed, queued, early], [passed, early, queued], [queued, passed, early],
    [queued, early, passed], [early, passed, queued], [early, queued, passed],
  ];
  for (const order of orders) {
    const same = h.check({ runs: [...order, ...others], suites: inSuite });
    assert.equal(same.code, 1, same.summary);
    assert.ok(same.summary.includes(`${name} (queued)`), same.summary);
  }

  // A reopened PR queues the rerun in a new suite. The old suite's success is no longer current.
  const reopened = h.check({
    runs: [{ ...passed, check_suite: { id: 1 } }, ...others.map((r) => ({ ...r, check_suite: { id: 1 } })), { ...queued, check_suite: { id: 2 } }],
    suites: [suite(1, 'completed', 'success', REQUIRED.length), suite(2, 'queued', null, 1)],
  });
  assert.equal(reopened.code, 1, reopened.summary);
  assert.ok(reopened.summary.includes(`${name} (queued)`), reopened.summary);

  // A run that was cancelled before it started, and is older than a rerun that did start, does not block the rerun.
  const stale = { ...run(name, 'cancelled'), id: 114100000000 };
  const rerun = h.check({ runs: [stale, passed, ...others], suites: [suite(1, 'completed', 'success', REQUIRED.length)] });
  assert.equal(rerun.code, 0, rerun.summary);
  assert.match(rerun.summary, /CI green/);
});
