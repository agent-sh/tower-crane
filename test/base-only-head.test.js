'use strict';

// A head that only merges the advanced base into a gated head keeps that
// head's results; one that resolved conflicts is reviewed and tested on the
// resolution; any other change gets the normal gates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { setup, attach } = require('./automation-helpers');

const write = (h, file, text) => {
  fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(h.repo, file), text);
};

// Gated green at head A: tests, clean and an independent review pass. The own
// change holds shared.txt, whose second line upstream's later edit touches.
function gated(t) {
  const h = cachedFixture(t, 'base-only-head:gated', (repo) => {
    const h = setup(null, { repo });
    h.git(['switch', '-q', 'main']);
    write(h, 'shared.txt', 'one\ntwo\nthree\n');
    h.git(['add', 'shared.txt']);
    h.git(['commit', '-qm', 'shared file']);
    h.git(['switch', '-q', 'fixture-change']);
    h.git(['merge', '-q', '--no-ff', '-m', 'take the base', 'main']);
    write(h, 'shared.txt', 'one\nTWO\nthree\n');
    write(h, 'test/shared.test.js', "require('node:assert/strict').match(require('node:fs').readFileSync('shared.txt', 'utf8'), /TWO/);\n");
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'raise two']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    const github = h.github();
    github.prs['7'].headRefOid = h.sha;
    h.saveGithub(github);
    h.ok(['project', 'set', '--tests-proof-cmd', 'node {tests}', '--tests-expensive', 'true', '--ci-required', '["test"]',
      '--tests-map', JSON.stringify({ 'value.js': ['test/value.test.js'], 'shared.txt': ['test/shared.test.js'] })]);
    h.submit();
    for (const gate of ['tests', 'clean']) h.ok(['check', gate, 'T1']);
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    return { sha: h.sha };
  });
  return attach(h);
}

// Upstream advances main; the worker merges it into A and submits the new head.
function advance(h, { conflict = false, extra = null } = {}) {
  h.git(['switch', '-q', 'main']);
  write(h, 'upstream.md', 'An upstream change.\n');
  if (conflict) write(h, 'shared.txt', 'one\ntwo\nTHREE\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'advance the base']);
  h.git(['switch', '-q', 'fixture-change']);
  let merge = true;
  try { h.git(['merge', '-q', '--no-ff', '-m', 'merge the base', 'main']); } catch { merge = false; }
  assert.equal(merge, !conflict, conflict ? 'the base edit must conflict with the own change' : 'the merge must be automatic');
  if (conflict) {
    write(h, 'shared.txt', 'one\nTWO\nTHREE\n');
    h.git(['add', 'shared.txt']);
    h.git(['commit', '-qm', 'merge the base']);
  }
  if (extra) {
    write(h, extra.file, extra.text);
    h.git(['add', extra.file]);
    h.git(['commit', '-qm', 'change one line']);
  }
  const head = h.git(['rev-parse', 'HEAD']);
  const github = h.github();
  github.prs['7'].headRefOid = head;
  github.ci[head] = 'success';
  h.saveGithub(github);
  h.ok(['submit', 'T1', '--sha', head, '--pr', '7', '--agent', 'worker']);
  return head;
}

const gate = (h, type) => h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === type);
const atHead = (h, head, cmd) => h.logs().filter((e) => e.cmd === cmd && e.task === 'T1' && e.detail.sha === head
  && (cmd !== 'spawn' || e.detail.role === 'reviewer'));

test('a base-only head keeps tests, clean and review at the same revision and queues no gate', (t) => {
  const h = gated(t);
  const before = h.readState('tasks.json').tasks[0];
  const head = advance(h);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.revision, before.revision);
  assert.equal(task.sha, head);
  for (const type of ['tests', 'clean', 'review']) {
    const g = gate(h, type);
    assert.equal(g.ok, true, type);
    assert.equal(g.carried, `carried from ${before.sha.slice(0, 7)}: base-only head`, type);
  }
  assert.match(h.ok(['task', 'show', 'T1']), new RegExp(`tests ok \\(carried from ${before.sha.slice(0, 7)}: base-only head\\)`));
  assert.match(h.ok(['status']), new RegExp(`T1 \\(.*tests, clean, review carried from ${before.sha.slice(0, 7)}: base-only head\\)`));
  h.consume();
  assert.deepEqual(atHead(h, head, 'check tests'), [], 'no tests gate runs at the base-only head');
  assert.deepEqual(atHead(h, head, 'check clean'), [], 'no clean gate runs at the base-only head');
  assert.deepEqual(atHead(h, head, 'spawn'), [], 'no reviewer is dispatched at the base-only head');
  assert.ok(atHead(h, head, 'check ci').length, 'the ci gate still reads checks at the new head');
  const after = h.readState('tasks.json').tasks[0];
  assert.equal(after.revision, before.revision);
  assert.equal(after.status, 'accepted');
});

test('a conflict-resolving head is reviewed on the resolved hunks and tests only the resolved file', (t) => {
  const h = gated(t);
  const reviewed = h.readState('tasks.json').tasks[0].sha;
  const head = advance(h, { conflict: true });
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.carry.kind, 'resolved');
  assert.deepEqual(task.carry.files, ['shared.txt']);
  for (const type of ['tests', 'clean', 'review']) assert.equal(gate(h, type).ok, false, type);
  h.ok(['check', 'tests', 'T1']);
  const tests = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'tests');
  assert.equal(tests.ok, true, tests.summary);
  assert.equal(tests.sha, head);
  assert.equal(tests.receipt.mode, 'resolved');
  assert.deepEqual(tests.receipt.head_tests, ['test/shared.test.js']);
  const ran = tests.commands.filter((c) => c.command !== 'git').map((c) => c.command);
  assert.equal(ran.length, 1, ran.join('\n'));
  assert.match(ran[0], /test\/shared\.test\.js/);
  assert.doesNotMatch(ran[0], /value\.test\.js/);
  assert.equal(gate(h, 'tests').ok, true, 'the resolved run passes the tests gate');
  for (const type of ['clean', 'ci']) h.ok(['check', type, 'T1']);
  // A reviewer that only keeps its prompt; the dispatch writes the packet with the diff.
  const out = path.join(h.base, 'resolution-review.txt');
  const command = JSON.stringify([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', out, '{prompt}']);
  for (const name of ['easy', 'medium', 'hard', 'research', 'review']) {
    h.ok(['ladder', 'set', name, '--harness', 'command', '--clear', 'model', '--clear', 'profile', '--clear', 'provider',
      '--clear', 'effort', '--clear', 'args', '--command', command]);
  }
  const dispatched = h.json(['spawn', '--task', 'T1', '--role', 'review', '--wait']);
  assert.equal(dispatched.review_scope.resolution, true);
  const prompt = fs.readFileSync(out, 'utf8');
  assert.match(prompt, /## Review scope\n\nConflict resolution review/);
  assert.match(prompt, new RegExp(`passed the review at ${reviewed}`));
  const packet = fs.readFileSync(path.join(h.state, 'reviews', `T1-${head}.md`), 'utf8');
  assert.match(packet, /diff --git a\/shared.txt b\/shared.txt/);
  assert.match(packet, /^-<<<<<<< /m, 'the resolution removes the conflict markers');
  for (const file of ['value.js', 'upstream.md', 'test/shared.test.js']) assert.ok(!packet.includes(`diff --git a/${file}`), file);
});

test('a head that changes one line of the own change gets the normal gates', (t) => {
  const h = gated(t);
  const head = advance(h, { extra: { file: 'value.js', text: 'module.exports = 1; // one\n' } });
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.carry, undefined);
  for (const type of ['tests', 'clean', 'review']) assert.equal(gate(h, type).ok, false, type);
  h.consume();
  assert.equal(atHead(h, head, 'check tests').length, 1, 'the tests gate runs at the changed head');
  assert.equal(atHead(h, head, 'check clean').length, 1, 'the clean gate runs at the changed head');
});
