'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function events(h) {
  return fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function pass(h, type, agent, sha) {
  if (type === 'review') {
    h.reviewer('T1', agent, sha);
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', type, '--ok', '--sha', sha, '--agent', agent]);
  }
  else gateEvidence(h, type, agent);
}

function t68Rework(t) {
  const h = makeRepo(t);
  const oldSha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const oldBranch = 'tower-crane/T68';
  const newBranch = 'tower-crane/T68-rework';
  h.ok(['submit', 'T1', '--sha', oldSha, '--branch', oldBranch, '--pr', '34', '--agent', 'w-1']);
  h.ok(['rework', 'T1', '--reason', 'T68 rework', '--agent', 'owner']);
  h.ok(['claim', 'T1', '--agent', 'w-2']);

  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Reworked on a new branch.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-q', '-m', 'rework']);
  const newSha = h.git(['rev-parse', 'HEAD']);
  h.env.FIXTURE_PR_HEAD_34 = oldBranch;
  h.env.FIXTURE_PR_STATE_34 = 'OPEN';
  return { h, oldBranch, newBranch, newSha };
}

test('submit resolves an abbreviated commit and refuses unknown hashes without changing state', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const sha = h.git(['rev-parse', 'HEAD']);
  const submitted = h.json(['submit', 'T1', '--sha', sha.slice(0, 8).toUpperCase(), '--agent', 'w-1']);
  assert.equal(submitted.sha, sha);
  assert.equal(events(h).findLast((e) => e.cmd === 'submit').detail.sha, sha);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);
  const refused = h.run(['submit', 'T1', '--sha', 'f'.repeat(40), '--agent', 'w-1']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /cannot resolve.*commit/i);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
});

test('a legacy short submitted sha reuses its full-sha reviewer and recognizes its failed review', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', '["tower-crane-no-such-reviewer","{prompt}"]']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
  const legacy = h.readState('tasks.json');
  legacy.tasks[0].sha = sha.slice(0, 8);
  h.writeState('tasks.json', legacy);
  const revision = Number(h.revision('T1'));
  const spawn = { at: new Date().toISOString(), agent: 'orchestrator', cmd: 'spawn', task: 'T1',
    detail: { agent: 'r-1', role: 'reviewer', rung: 'review', sha, revision, pid: process.pid, attempt: 1,
      ...require('../lib/processes').identity(process.pid) } };
  const log = path.join(h.state, 'events.jsonl');
  fs.appendFileSync(log, `${JSON.stringify(spawn)}\n`);
  const pending = h.json(['accept', 'T1']);
  assert.equal(pending.review_pending, true);
  assert.equal(pending.reviewer, 'r-1');
  const duplicate = h.run(['spawn', '--task', 'T1', '--role', 'review']);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /reviewer is still running/);
  fs.appendFileSync(log, `${JSON.stringify({ at: spawn.at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1',
    detail: { agent: 'r-1', pid: process.pid, attempt: 1, code: 0 } })}\n`);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', sha, '--agent', 'r-1',
    '--summary', 'lib/value.js:1 - Check null before dereferencing']);
  const failed = h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'review');
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /Check null/);
  const denied = h.run(['accept', 'T1']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /Check null/);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].sha, sha.slice(0, 8));
  const reworked = h.json(['rework', '--from-review', 'T1', '--agent', 'orchestrator']);
  assert.equal(reworked.status, 'rework');
  assert.match(reworked.notes.at(-1).text, /Check null/);
});

test('submit refuses an ambiguous prefix and a non-commit object', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const tree = h.git(['rev-parse', 'HEAD^{tree}']);
  const crypto = require('node:crypto');
  const prefixes = new Map();
  let collision;
  for (let n = 0; !collision; n++) {
    const body = `tree ${tree}\nauthor test <test@example.invalid> 1700000000 +0000\ncommitter test <test@example.invalid> 1700000000 +0000\n\ncollision ${n}\n`;
    const sha = crypto.createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex');
    const prefix = sha.slice(0, 7);
    if (prefixes.has(prefix)) collision = { prefix, bodies: [prefixes.get(prefix), body] };
    else prefixes.set(prefix, body);
  }
  for (const input of collision.bodies) require('node:child_process').execFileSync('git',
    ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: h.repo, env: h.env, input });
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);
  for (const sha of [collision.prefix, h.git(['rev-parse', 'HEAD:README.md'])]) {
    const refused = h.run(['submit', 'T1', '--sha', sha, '--agent', 'w-1']);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, /cannot resolve.*commit/i);
  }
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
});

test('the claimant resubmits a newer head and its gates need evidence at that head', (t) => {
  const h = makeRepo(t);
  const oldSha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', oldSha, '--branch', 'fixture-change', '--pr', '7', '--agent', 'w-1']);
  assert.deepEqual(
    events(h).find((event) => event.cmd === 'submit').detail,
    { previous_sha: null, sha: oldSha, branch: 'fixture-change', pr: 7, summary: null, scope: { basis: 'repo', named: [], outside: [] } },
  );
  const gates = [['tests', 'w-1'], ['clean', 'w-1'], ['review', 'r-1'], ['ci', 'ci']];
  for (const [type, agent] of gates) pass(h, type, agent, oldSha);
  const before = h.json(['task', 'show', 'T1']);
  assert.equal(before.gates.ok, true);

  fs.appendFileSync(path.join(h.repo, 'README.md'), 'The newer change.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-q', '-m', 'newer change']);
  const newSha = h.git(['rev-parse', 'HEAD']);
  const submitted = h.json(['submit', 'T1', '--sha', newSha.toUpperCase(), '--branch', 'fixture-change', '--pr', '7',
    '--summary', 'fixed review feedback', '--agent', 'w-1']);
  assert.deepEqual(
    [submitted.status, submitted.sha, submitted.branch, submitted.pr, submitted.submitted_by, submitted.claim, submitted.revision],
    ['submitted', newSha, 'fixture-change', 7, 'w-1', null, before.revision],
  );
  assert.deepEqual(submitted.evidence, before.evidence);
  assert.equal(submitted.notes.at(-1).text, 'submitted: fixed review feedback');
  const resubmit = events(h).filter((event) => event.cmd === 'submit').at(-1);
  assert.deepEqual(
    [resubmit.task, resubmit.agent, resubmit.detail.previous_sha, resubmit.detail.sha],
    ['T1', 'w-1', oldSha, newSha],
  );

  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.gates.ok, false);
  assert.deepEqual(shown.gates.gates.map((gate) => [gate.type, gate.ok]), gates.map(([type]) => [type, false]));
  h.ok(['project', 'set', '--tests-cmd', 'null']);
  const stale = h.run(['accept', 'T1']);
  assert.equal(stale.code, 1);
  for (const [type] of gates) assert.match(stale.stderr, new RegExp(`no ${type} evidence at ${newSha.slice(0, 7)}`));
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');

  h.env.FIXTURE_SHA = newSha;
  for (const [type, agent] of [['tests', 'w-1'], ['clean', 'w-1'], ['review', 'w-1'], ['ci', 'ci']]) {
    pass(h, type, agent, newSha);
  }
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /only the submitter \(w-1\) reviewed/);
  h.reviewer('T1', 'r-1', newSha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', newSha, '--agent', 'r-1']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  h.ok(['accept', 'T1']);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'accepted');
});

test('resubmission belongs to the current submitter and stops after acceptance or rework', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', sha, '--branch', 'feature/old', '--pr', '7', '--agent', 'w-1']);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);
  for (const agent of ['w-2', 'owner']) {
    const denied = h.run(['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--agent', agent]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /only the submitter \(w-1\) can resubmit T1/);
  }
  assert.equal(h.run(['submit', 'T1', '--sha', 'not-a-sha', '--agent', 'w-1']).code, 2);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);

  h.reviewer('T1', 'r-1', sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', sha, '--agent', 'r-1']);
  const again = h.json(['submit', 'T1', '--sha', sha.toUpperCase(), '--agent', 'w-1']);
  assert.deepEqual([again.sha, again.branch, again.pr], [sha, 'feature/old', 7]);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((gate) => gate.type === 'review').ok, true);
  gateEvidence(h, 'ci', 'ci');
  h.ok(['accept', 'T1']);
  const accepted = h.json(['task', 'show', 'T1']);
  const acceptedEvents = events(h);
  assert.equal(h.run(['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--agent', 'w-1']).code, 1);
  assert.deepEqual(h.json(['task', 'show', 'T1']), accepted);
  assert.deepEqual(events(h), acceptedEvents);

  h.ok(['rework', 'T1', '--reason', 'another change', '--agent', 'r-1']);
  assert.equal(h.run(['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--agent', 'w-1']).code, 1);
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  assert.equal(h.run(['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--agent', 'w-1']).code, 1);
  h.ok(['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--agent', 'w-2']);
  const afterRework = events(h).filter((event) => event.cmd === 'submit').at(-1);
  assert.deepEqual([afterRework.detail.previous_sha, afterRework.detail.sha], [sha, '5bfcb6f56ab912a009883c798a61298c507dada4']);
  assert.equal(h.run(['submit', 'T1', '--sha', 'cfed4d76efd3afe887bbbfc7f62c7d94158e3255', '--agent', 'w-1']).code, 1);
  assert.equal(h.json(['submit', 'T1', '--sha', 'cfed4d76efd3afe887bbbfc7f62c7d94158e3255', '--agent', 'w-2']).submitted_by, 'w-2');
});

test('submit refuses changing only the PR while its old PR is open', (t) => {
  const { h, oldBranch, newSha } = t68Rework(t);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);

  const refused = h.run(['submit', 'T1', '--sha', newSha, '--pr', '39', '--agent', 'w-2']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /open PR #34/);
  assert.ok(refused.stderr.includes(oldBranch), refused.stderr);
  assert.match(refused.stderr, /PR #39/);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
});

test('submit refuses changing only the branch while the task PR is open', (t) => {
  const { h, oldBranch, newBranch, newSha } = t68Rework(t);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);

  const refused = h.run(['submit', 'T1', '--sha', newSha, '--branch', newBranch, '--agent', 'w-2']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /open PR #34/);
  assert.ok(refused.stderr.includes(oldBranch), refused.stderr);
  assert.ok(refused.stderr.includes(newBranch), refused.stderr);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
});

test('submit refuses changing both PR and branch beside an open PR', (t) => {
  const { h, oldBranch, newBranch, newSha } = t68Rework(t);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);

  const refused = h.run(['submit', 'T1', '--sha', newSha, '--branch', newBranch, '--pr', '39', '--agent', 'w-2']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /open PR #34/);
  assert.match(refused.stderr, /PR #39/);
  assert.ok(refused.stderr.includes(oldBranch), refused.stderr);
  assert.ok(refused.stderr.includes(newBranch), refused.stderr);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
});

test('after closing the old PR, a new PR supplies or verifies the submitted branch', (t) => {
  const { h, oldBranch, newBranch, newSha } = t68Rework(t);
  h.env.FIXTURE_PR_STATE_34 = 'CLOSED';
  h.env.FIXTURE_PR_HEAD_39 = newBranch;
  h.env.FIXTURE_PR_STATE_39 = 'OPEN';
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);

  const wrongBranch = 'tower-crane/T68-wrong';
  const refused = h.run(['submit', 'T1', '--sha', newSha, '--branch', wrongBranch, '--pr', '39', '--agent', 'w-2']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.ok(refused.stderr.includes(newBranch), refused.stderr);
  assert.ok(refused.stderr.includes(wrongBranch), refused.stderr);
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);

  const submitted = h.json(['submit', 'T1', '--sha', newSha, '--pr', '39', '--agent', 'w-2']);
  assert.deepEqual([submitted.status, submitted.sha, submitted.branch, submitted.pr], ['submitted', newSha, newBranch, 39]);
  const checked = h.json(['submit', 'T1', '--sha', newSha, '--branch', newBranch, '--pr', '39', '--agent', 'w-2']);
  assert.deepEqual([checked.branch, checked.pr], [newBranch, 39]);
});

test('review evidence must pin the reviewed sha when a worker resubmits during review', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', '["tower-crane-no-such-reviewer","{prompt}"]']);
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  const reviewedSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', reviewedSha, '--agent', 'w-1']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'A change after review started.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-q', '-m', 'update during review']);
  const newerSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--sha', newerSha, '--agent', 'w-1']);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);

  for (const verdict of ['--ok', '--fail']) {
    const refused = h.run(['evidence', 'T1', '--type', 'review', verdict, '--agent', 'r-1']);
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stderr, /review evidence needs --sha/);
  }
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);

  const review = h.json(['evidence', 'T1', '--type', 'review', '--ok', '--sha', reviewedSha.toUpperCase(), '--revision', h.revision('T1'), '--agent', 'r-1']);
  assert.equal(review.sha, reviewedSha);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const stale = h.run(['accept', 'T1']);
  assert.equal(stale.code, 1, stale.stdout);
  assert.match(stale.stderr, /could not start tower-crane-no-such-reviewer/);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
  h.reviewer('T1', 'r-1', newerSha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', newerSha, '--agent', 'r-1']);
  assert.equal(h.json(['accept', 'T1']).status, 'accepted');
  assert.equal(h.json(['task', 'show', 'T1']).sha, newerSha);
});

test('only note evidence can default to the submitted sha', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  const noHead = h.run(['evidence', 'T1', '--type', 'note', '--ok']);
  assert.equal(noHead.code, 1);
  assert.match(noHead.stderr, /no submitted sha yet; pass --sha/);
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['submit', 'T1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', 'w-1']);
  const before = h.json(['task', 'show', 'T1']);
  const beforeEvents = events(h);
  for (const type of ['tests', 'clean', 'review', 'ci', 'merge']) {
    const refused = h.run(['evidence', 'T1', '--type', type, '--ok', '--agent', 'r-1']);
    if (type === 'review') {
      assert.equal(refused.code, 2, refused.stdout);
      assert.match(refused.stderr, /review evidence needs --sha/);
    } else {
      assert.equal(refused.code, 1, `${type}: ${refused.stdout}`);
      assert.match(refused.stderr, /only tower-crane (check|merge)/);
    }
  }
  assert.deepEqual(h.json(['task', 'show', 'T1']), before);
  assert.deepEqual(events(h), beforeEvents);
  const note = h.json(['evidence', 'T1', '--type', 'note', '--ok', '--agent', 'r-1']);
  assert.deepEqual([note.type, note.sha], ['note', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
  const pinned = h.json(['evidence', 'T1', '--type', 'note', '--ok', '--sha', '5BFCB6F56AB912A009883C798A61298C507DADA4', '--agent', 'r-1']);
  assert.equal(pinned.sha, '5bfcb6f56ab912a009883c798a61298c507dada4');
});
