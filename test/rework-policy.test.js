'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const Reviews = require('../lib/review-findings');

function setup(t) {
  return cachedFixture(t, 'repeated-review', (h) => {
    Object.assign(h.env, {
      CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'), CODEX_HOME: path.join(h.env.HOME, '.codex'),
      PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
      XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'), XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
      GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    });
    h.init();
    h.ok(['task', 'add', '--title', 'Retry handling', '--acceptance', 'Retries work']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Implement retry handling.\n' });
    for (const digit of ['a', 'b']) {
      const sha = digit.repeat(40);
      h.ok(['claim', 'T1', '--agent', 'worker']);
      h.ok(['submit', 'T1', '--sha', sha, '--agent', 'worker']);
      h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha,
        '--revision', h.revision(), '--summary', '1 blocking finding: lib/retry.js:12 - Duplicate delivery']);
      h.ok(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
    }
  });
}

test('repeated review blocks claim, spawn previews, real spawn and ready batches; inbox explains the ruling', (t) => {
  const h = setup(t);
  for (const args of [
    ['claim', 'T1', '--agent', 'next-worker'],
    ['spawn', '--task', 'T1', '--dry-run'],
    ['spawn', '--task', 'T1'],
    ['spawn', '--task', 'T1', '--role', 'hard', '--dry-run'],
  ]) {
    const result = h.run(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /lib\/retry\.js.*two failed reviews.*scope-ruling/s);
  }
  assert.equal(h.json(['ready']).ready.length, 0);
  assert.equal(h.json(['spawn', '--ready', '--dry-run', '--agent', 'orchestrator']).results.length, 0);
  const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_redesign');
  assert.equal(item.task, 'T1');
  assert.deepEqual(item.areas, ['lib/retry.js']);
  assert.match(item.reason, /two failed reviews/);
  assert.ok(item.action.argv.includes('scope-ruling'));
});

test('only a scope ruling or explicit closed acceptance clears the repeated-review gate', (t) => {
  const h = setup(t);
  h.ok(['task', 'note', 'T1', 'Keep patching', '--agent', 'worker']);
  assert.equal(h.run(['task', 'note', 'T1', 'Remove the retry mechanism',
    '--kind', 'scope-ruling', '--agent', 'worker']).code, 1);
  h.ok(['task', 'update', 'T1', '--title', 'New title', '--agent', 'orchestrator']);
  h.ok(['task', 'update', 'T1', '--acceptance', 'All retries work', '--agent', 'orchestrator']);
  assert.equal(h.run(['claim', 'T1', '--agent', 'worker']).code, 1);
  h.ok(['task', 'note', 'T1', 'Replace retry state with a single idempotency key',
    '--kind', 'scope-ruling', '--agent', 'orchestrator']);
  const ruling = h.json(['task', 'show', 'T1']).notes.at(-1);
  assert.equal(ruling.kind, 'scope-ruling');
  assert.ok(h.json(['ready']).ready.some((task) => task.id === 'T1'));
  h.ok(['spawn', '--task', 'T1', '--dry-run']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['release', 'T1', '--agent', 'worker', '--reason', 'test release']);
  for (const digit of ['c', 'd']) {
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', digit.repeat(40), '--agent', 'worker']);
    h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', digit.repeat(40),
      '--revision', h.revision(), '--summary', 'lib/retry.js:20 - Another duplicate']);
    h.ok(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  }
  assert.equal(h.run(['claim', 'T1', '--agent', 'worker']).code, 1);
  assert.equal(h.run(['task', 'update', 'T1', '--acceptance', 'All retries work',
    '--closed-acceptance', '--agent', 'orchestrator']).code, 2);
  assert.equal(h.run(['task', 'update', 'T1', '--acceptance', 'Only retry HTTP 503',
    '--closed-acceptance', '--agent', 'worker']).code, 1);
  h.ok(['task', 'update', 'T1', '--acceptance', 'Only retry HTTP 503',
    '--closed-acceptance', '--agent', 'orchestrator']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
});

test('blocking areas handle markdown, path variants and follow-ups', () => {
  const cases = [
    ['summary', '2 blockers: lib/retry.js:12 - duplicate; lib/store.js:8 - missing key', ['lib/retry.js', 'lib/store.js']],
    ['markdown', '## Blocking findings\n- **[P1] `./lib/retry.js:12`** - duplicate\n## Follow-ups\n- lib/store.js:8 - later', ['lib/retry.js']],
    ['windows', '1. lib\\retry.js:12-14 - duplicate', ['lib/retry.js']],
    ['duplicate', '- lib/retry.js:12 - duplicate\n- lib/retry.js:40 - variant', ['lib/retry.js']],
    ['nonblocking', 'lib/retry.js:12 - duplicate\nNonblocking: lib/store.js:8 - later', ['lib/retry.js']],
    ['fenced probe', '## Blocking findings\nlib/retry.js:12 - duplicate\n```\nlib/store.js:8 - fixture\n```', ['lib/retry.js']],
    ['fixed blocker before heading', '## Prior blockers\nlib/retry.js:12 - fixed\n## Blocking findings\nlib/store.js:8 - new failure', ['lib/store.js']],
    ['fixed status before plain heading', 'Earlier lib/retry.js:12 is fixed.\nBlocking: 1 finding.\nlib/store.js:8 - new failure', ['lib/store.js']],
    ['reproduction reference', '## Blocking findings\n- lib/retry.js:12 - duplicate; reproduce using lib/store.js:8\n  - Run lib/fixture.js:20 - fixture setup\n## Verification\nlib/check.js:10 - passed', ['lib/retry.js']],
    ['reproduction subsection', '## Blocking findings\nlib/retry.js:12 - duplicate\n### Reproduction\nlib/fixture.js:20 - setup', ['lib/retry.js']],
    ['plain reproduction label', 'Blocking: 1 finding.\nlib/retry.js:12 - duplicate\nSteps to reproduce:\nCall the fixture at lib/fixture.js:20.', ['lib/retry.js']],
    ['finding after reproduction', '## Blocking findings\n- lib/retry.js:12 - duplicate\n  Reproduction:\n  Call lib/fixture.js:20.\n- lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['finding after tests', '## Blocking findings\nlib/retry.js:12 - duplicate\nTests:\nRun lib/fixture.js:20.\nlib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['finding after verification', '## Blocking findings\n- lib/retry.js:12 - duplicate\n  Verification:\n  Run lib/fixture.js:20.\n- lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['finding after nested reproduction heading', '## Blocking findings\n- lib/retry.js:12 - duplicate\n### Reproduction\nlib/fixture.js:20 - setup\n- lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['asterisk findings after nested detail', '## Blocking findings\n* **lib/retry.js:12** - duplicate\n### Reproduction\nlib/fixture.js:20 - setup\n* lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['numbered findings after nested detail', '## Blocking findings\n1. lib/retry.js:12 - duplicate\n### Tests\nlib/fixture.js:20 - setup\n2. lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['plus findings after nested detail', '## Blocking findings\n+ lib/retry.js:12 - duplicate\n### Verification\nlib/fixture.js:20 - setup\n+ lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['indented reproduction location', '## Blocking findings\n- lib/retry.js:12 - duplicate\n  Reproduction:\n  lib/fixture.js:20 - setup\n- lib/store.js:8 - stale key', ['lib/retry.js', 'lib/store.js']],
    ['review with no blockers', 'Review (Tower Crane, clean context)\nSHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n## Prior blockers\nlib/retry.js:12 - fixed\n## Blocking findings\nNone\n## Follow-ups\nlib/store.js:8 - later', []],
    ['header mentions path', 'Review (Tower Crane, clean context)\nVerified lib/retry.js:12\n## Blocking findings\nlib/store.js:8 - new failure', ['lib/store.js']],
    ['only nonblocking sections', '## Follow-ups\nlib/store.js:8 - later\n## Tests\nlib/retry.js:12 - passed', []],
    ['review without blocking section', 'Review (Tower Crane, clean context)\nlib/retry.js:12 - fixed', []],
    ['no paths', '2 blocking findings, missing retry guards', []],
  ];
  for (const [name, body, expected] of cases) assert.deepEqual(Reviews.areas(body), expected, name);
});

test('review failure counting distinguishes areas, verdicts, revisions and authorized reviewers', () => {
  const failure = (area, revision = 1, sha = 'a'.repeat(40), extra = {}) => ({
    type: 'review', ok: false, agent: 'owner', revision, sha,
    summary: `${area}:12 - duplicate`, ...extra,
  });
  const cases = [
    ['one review, two findings', [failure('lib/a.js', 1, undefined, { summary: 'lib/a.js:12 - one\nlib/a.js:30 - two' })], []],
    ['same head and revision twice', [failure('lib/a.js'), failure('lib/a.js')], []],
    ['abbreviated same head', [failure('lib/a.js'), failure('lib/a.js', 1, 'a'.repeat(7))], []],
    ['same file in two revisions', [failure('lib/a.js'), failure('lib/a.js', 2)], ['lib/a.js']],
    ['different files', [failure('lib/a.js'), failure('lib/b.js', 2)], []],
    ['passing review', [failure('lib/a.js'), failure('lib/a.js', 2, undefined, { ok: true })], []],
    ['untrusted reviewer', [failure('lib/a.js'), failure('lib/a.js', 2, undefined, { agent: 'stranger' })], []],
    ['separate heads', [failure('lib/a.js'), failure('lib/a.js', 1, 'b'.repeat(40))], ['lib/a.js']],
    ['ruling cutoff', [failure('lib/a.js'), failure('lib/a.js', 2)], [], 2],
    ['failure after ruling', [failure('lib/a.js'), failure('lib/a.js', 2), failure('lib/a.js', 3)], [], 2],
    ['late old reviews after ruling', [failure('lib/a.js'), failure('lib/a.js', 2)], [], 0, 3],
    ['parsed areas preserved', [failure('lib/a.js', 1, undefined, { areas: ['lib/hidden.js'] }),
      failure('lib/b.js', 2, undefined, { areas: ['lib/hidden.js'] })], ['lib/hidden.js']],
  ];
  for (const [name, evidence, expected, cutoff, revision] of cases) {
    const task = { id: 'T1', evidence };
    const events = cutoff === undefined ? [] : [{
      cmd: 'task note', task: 'T1', detail: { kind: 'scope-ruling', review_after: cutoff, revision },
    }];
    assert.deepEqual(Reviews.repeatedAreas(task, events), expected, name);
  }
  const evidence = ['reviewer-1', 'reviewer-2'].map((agent) => failure('lib/a.js', 1, undefined, { agent }));
  const events = evidence.map((entry) => ({
    cmd: 'spawn', task: 'T1',
    detail: { role: 'reviewer', agent: entry.agent, sha: entry.sha, revision: entry.revision },
  }));
  assert.deepEqual(Reviews.repeatedAreas({ id: 'T1', evidence }, events), ['lib/a.js'],
    'independent reviewers at the same head count separately');
});
