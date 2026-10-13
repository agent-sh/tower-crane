'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { BIN, cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const APP = 'revuto-review';
const CAP = { title: 'Revuto did not review this pull request', summary: 'reached the 2-round review limit', text: null };
const POLICY = [{ app: APP, pattern: 'reached the \\d+-round review limit' }];
const github = path.join(__dirname, 'fixtures', 'github.js');

function run(name, app, id, output = null, conclusion = 'success', status = 'completed') {
  return { name, app: { slug: app }, check_suite: { id }, output, conclusion, status };
}

function suite(app, id, conclusion = 'success', status = 'completed', runs = 1) {
  return { app: { slug: app }, id, conclusion, status, latest_check_runs_count: runs };
}

function fixture(t) {
  const h = cachedFixture(t, 'submitted', (h) => {
    h.init(['--repo', 'acme/app']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    // Submit reads the PR's checks, so it needs the fake gh that gateFixture puts on PATH.
    const sha = gateFixture(h);
    h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, '--pr', '9']);
    return { sha };
  });
  const { sha } = h;
  return {
    check({ policy = POLICY, runs = [run('Revuto', APP, 2, CAP, 'failure')], suites = [suite(APP, 2, 'failure')], ci = {}, build = true } = {}) {
      const project = h.readState('project.json');
      project.ci = { ...ci, ...(policy === null ? {} : { capped_review: policy }) };
      h.writeState('project.json', project);
      const file = path.join(h.base, 'github.json');
      fs.writeFileSync(file, JSON.stringify({
        sha, runs: [...(build ? [run('build', 'github-actions', 1)] : []), ...runs],
        suites: [...(build ? [suite('github-actions', 1)] : []), ...suites],
      }));
      const r = cp.spawnSync(process.execPath, ['--require', github, BIN, 'check', 'ci', 'T1', '--agent', 'checker', '--json'], {
        cwd: h.repo, env: { ...h.env, TEST_GITHUB: file }, encoding: 'utf8', timeout: 60000,
      });
      const evidence = JSON.parse(r.stdout);
      assert.equal(evidence.sha, sha);
      assert.equal(evidence.type, 'ci');
      assert.equal(evidence.source, 'check ci');
      assert.ok(Array.isArray(evidence.commands));
      assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1), {
        type: evidence.type, ok: evidence.ok, sha: evidence.sha, agent: evidence.agent,
        at: evidence.at, summary: evidence.summary, ref: evidence.ref, revision: evidence.revision,
        source: 'check ci', commands: evidence.commands, ci_policy: evidence.ci_policy,
        ...(evidence.capped_review ? { capped_review: evidence.capped_review } : {}),
        ...(evidence.confirmed_failure !== undefined ? { confirmed_failure: evidence.confirmed_failure } : {}),
      });
      assert.equal(evidence.source, 'check ci');
      assert.ok(Array.isArray(evidence.commands));
      return { code: r.status, ...evidence };
    },
  };
}

test('configured review cap passes the real CLI gate and is named in recorded evidence', (t) => {
  const h = fixture(t);
  for (const output of [CAP, { title: CAP.summary }]) {
    const r = h.check({ runs: [run('Revuto', APP, 2, output, 'failure')] });
    assert.equal(r.code, 0, r.summary);
    assert.equal(r.ok, true);
    assert.match(r.summary, /ci\.capped_review: Revuto \(revuto-review\)/);
    assert.deepEqual(r.capped_review, ['Revuto (revuto-review)']);
    assert.equal(r.confirmed_failure, undefined, 'a cap is not a confirmed failure');
  }
});

test('a capped review cannot satisfy the requirement for a CI run', (t) => {
  const h = fixture(t);
  for (const options of [{ build: false }, { ci: { ignore_apps: ['github-actions'] } }]) {
    const r = h.check(options);
    assert.equal(r.code, 1, r.summary);
    assert.equal(r.ok, false);
    assert.match(r.summary, /no check runs/);
    assert.match(r.summary, /ci\.capped_review: Revuto \(revuto-review\)/);
    assert.equal(r.confirmed_failure, undefined, 'missing runs do not confirm a failed attempt');
  }
});

test('review findings that quote a cap in output text still block', (t) => {
  const h = fixture(t);
  for (const policy of [POLICY, [{ app: APP, pattern: 'review limit' }]]) {
    const r = h.check({
      policy,
      runs: [run('Revuto', APP, 2, {
        title: 'Revuto found review concerns',
        summary: 'HIGH finding',
        text: 'The documentation says "reached the 2-round review limit".',
      }, 'failure')],
    });
    assert.equal(r.code, 1, r.summary);
    assert.equal(r.ok, false);
    assert.match(r.summary, /failing: Revuto \(failure\)/);
    assert.doesNotMatch(r.summary, /ci\.capped_review:/);
  }
});

test('the same app still blocks for other failures and other unsuccessful conclusions', (t) => {
  const h = fixture(t);
  for (const [output, conclusion, status] of [
    [{ title: 'Review found a bug', summary: 'HIGH finding' }, 'failure', 'completed'],
    [null, 'failure', 'completed'],
    [CAP, 'cancelled', 'completed'],
    [CAP, 'timed_out', 'completed'],
    [CAP, null, 'in_progress'],
  ]) {
    const r = h.check({ runs: [run('Revuto', APP, 2, output, conclusion, status)] });
    assert.equal(r.code, 1, r.summary);
    assert.equal(r.ok, false);
    assert.match(r.summary, /Revuto \(/);
    assert.doesNotMatch(r.summary, /ci\.capped_review:/);
  }
});

test('matching output needs a configured app and defaults to no cap exceptions', (t) => {
  const h = fixture(t);
  for (const policy of [null, [], [{ app: 'another-reviewer', pattern: 'review limit' }]]) {
    const r = h.check({ policy });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /failing: Revuto \(failure\)/);
  }
});

test('a capped run never hides other failed or pending runs in its suite', (t) => {
  const h = fixture(t);
  for (const [conclusion, status] of [['failure', 'completed'], [null, 'queued']]) {
    const r = h.check({
      runs: [run('Revuto', APP, 2, CAP, 'failure'), run('other review', APP, 2, null, conclusion, status)],
      suites: [suite(APP, 2, 'failure', 'completed', 2)],
    });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /other review \(/);
    assert.match(r.summary, /check suites not green: revuto-review/);
    assert.match(r.summary, /ci\.capped_review: Revuto \(revuto-review\)/);
    assert.equal(r.confirmed_failure, conclusion === 'failure' ? true : undefined,
      'only a completed failing sibling confirms a failed attempt');
  }
  const greenSibling = h.check({
    runs: [run('Revuto', APP, 2, CAP, 'failure'), run('other review', APP, 2)],
    suites: [suite(APP, 2, 'failure', 'completed', 2)],
  });
  assert.equal(greenSibling.code, 0, greenSibling.summary);
  assert.equal(greenSibling.confirmed_failure, undefined);
});

test('only the completed failure suite linked to the capped run can pass', (t) => {
  const h = fixture(t);
  for (const suites of [
    [suite(APP, 2, 'failure'), suite(APP, 3, 'failure')],
    [suite(APP, 2, null, 'queued')],
    [suite(APP, 2, 'cancelled')],
    [suite(APP, 2, 'failure', 'completed', 2)],
    [suite(APP, null, 'failure')],
  ]) {
    const r = h.check({ suites });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /check suites not green: revuto-review/);
  }
});

test('capped review patterns are case-insensitive regular expressions', (t) => {
  const r = fixture(t).check({
    policy: [{ app: APP, pattern: 'REVIEW\\s+LIMIT' }],
  });
  assert.equal(r.code, 0, r.summary);
});

test('malformed capped review rules fail the CLI gate with the field named', (t) => {
  const h = fixture(t);
  for (const policy of [
    'review limit', [null], [{}], [{ app: '', pattern: 'review limit' }],
    [{ app: ` ${APP}`, pattern: 'review limit' }], [{ app: `${APP} `, pattern: 'review limit' }],
    [{ app: APP, pattern: '' }], [{ app: APP, pattern: '[' }],
  ]) {
    const r = h.check({ policy });
    assert.equal(r.code, 1, r.summary);
    assert.match(r.summary, /ci\.capped_review/);
  }
});
