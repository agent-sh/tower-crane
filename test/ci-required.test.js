'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { BIN, cachedFixture } = require('./helpers');

const REQUIRED = [
  'test (ubuntu-latest, node 26)',
  'test (ubuntu-latest, node 24)',
  'test (windows-latest, node 26, shard 1/3)',
  'test (windows-latest, node 26, shard 2/3)',
  'test (windows-latest, node 26, shard 3/3)',
];
const CAP_POLICY = [{ app: 'revuto-review', pattern: 'reached the \\d+-round review limit' }];
const github = path.join(__dirname, 'fixtures', 'github.js');

test('package support, CI matrix, and required jobs target Node 24 and 26', () => {
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=24');

  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const matrix = [...workflow.matchAll(/^\s+- \{ os: ([^,]+), node: (\d+), shard: '([^']*)' \}$/gm)]
    .map(([, os, node, shard]) => ({ os, node: Number(node), shard }));
  assert.deepEqual(matrix, [
    { os: 'ubuntu-latest', node: 26, shard: '' },
    { os: 'ubuntu-latest', node: 24, shard: '' },
    { os: 'windows-latest', node: 26, shard: '1/3' },
    { os: 'windows-latest', node: 26, shard: '2/3' },
    { os: 'windows-latest', node: 26, shard: '3/3' },
  ]);
  assert.deepEqual(matrix.map(({ os, node, shard }) => `test (${os}, node ${node}${shard ? `, shard ${shard}` : ''})`), REQUIRED);

  const requiredJson = JSON.stringify(REQUIRED);
  for (const file of ['docs/state.md', 'docs/cli.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes(requiredJson), `${file} has stale required job names`);
  }
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\bNode 24 or newer\b/);
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
    const sha = h.git(['rev-parse', 'HEAD']);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, ...(withPr ? ['--pr', '40'] : [])]);
    return { sha };
  });
  const { sha } = h;
  return {
    check({ pr = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, runs = REQUIRED.map((name) => run(name)), ci = {}, suites: given } = {}) {
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
      fs.writeFileSync(file, JSON.stringify({ sha, pr, runs, suites }));
      const r = cp.spawnSync(process.execPath, ['--require', github, BIN, 'check', 'ci', 'T1', '--agent', 'checker', '--json'], {
        cwd: h.repo, env: { ...h.env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 60000,
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
  assert.equal(r.commands[0].args.at(-1), 'headRefOid,mergeable,mergeStateStatus');
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
  const name = 'test (windows-latest, node 26, shard 2/3)';
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
  const name = 'test (windows-latest, node 26, shard 2/3)';
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

test('a queued rerun newer than a success is the current run: the gate waits for it', (t) => {
  // A queued run has no started_at yet, so the earlier success must not supersede it by its start time.
  const h = fixture(t);
  const name = 'test (windows-latest, node 26, shard 2/3)';
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
