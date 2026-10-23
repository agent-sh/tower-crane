'use strict';

// A head that only merges the advanced base into a gated head keeps that
// head's results; one that resolved conflicts is reviewed and tested on the
// resolution; any other change gets the normal gates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { setup, attach, holdSuite } = require('./automation-helpers');
const { waitUntil, fileWritten } = require('./signals');

const write = (h, file, text) => {
  fs.mkdirSync(path.dirname(path.join(h.repo, file)), { recursive: true });
  fs.writeFileSync(path.join(h.repo, file), text);
};

// Gated green at head A: tests, clean and an independent review pass. The own
// change holds shared.txt, whose second line upstream's later edit touches.
// running leaves tests and review to start at A later, as runs still going there.
// probes declares those host probes at A.
function gated(t, { running = false, probes = [] } = {}) {
  const h = cachedFixture(t, `base-only-head:gated:${running}:${JSON.stringify(probes)}`, (repo) => {
    const h = setup(null, { repo });
    h.git(['switch', '-q', 'main']);
    write(h, 'shared.txt', 'one\ntwo\nthree\n');
    h.git(['add', 'shared.txt']);
    h.git(['commit', '-qm', 'shared file']);
    h.git(['switch', '-q', 'fixture-change']);
    h.git(['merge', '-q', '--no-ff', '-m', 'take the base', 'main']);
    write(h, 'shared.txt', 'one\nTWO\nthree\n');
    // SHARED_FLAKE names a marker: the first run that finds it absent writes it and fails.
    write(h, 'test/shared.test.js', `const fs = require('node:fs');
require('node:test')('shared holds TWO', () => {
  const flake = process.env.SHARED_FLAKE;
  if (flake && !fs.existsSync(flake)) { fs.writeFileSync(flake, ''); throw new Error('flaked once'); }
  require('node:assert/strict').match(fs.readFileSync('shared.txt', 'utf8'), /TWO/);
});
`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'raise two']);
    h.sha = h.git(['rev-parse', 'HEAD']);
    const github = h.github();
    github.prs['7'].headRefOid = h.sha;
    h.saveGithub(github);
    h.ok(['project', 'set', '--tests-proof-cmd', 'node {tests}', '--tests-expensive', 'true', '--ci-required', '["test"]',
      '--tests-map', JSON.stringify({ 'value.js': ['test/value.test.js'], 'shared.txt': ['test/shared.test.js'] })]);
    h.submit();
    if (probes.length) h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker', ...probes.flatMap((cmd) => ['--host-probe', cmd])]);
    for (const gate of running ? ['clean'] : ['tests', 'clean']) h.ok(['check', gate, 'T1']);
    h.reviewer('T1', 'reviewer');
    if (!running) h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    return { sha: h.sha };
  });
  return attach(h);
}

// Upstream advances main, with an edit next to the own change's line when conflict is set.
function upstream(h, conflict) {
  h.git(['switch', '-q', 'main']);
  write(h, 'upstream.md', 'An upstream change.\n');
  if (conflict) write(h, 'shared.txt', 'one\ntwo\nTHREE\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'advance the base']);
  h.git(['switch', '-q', 'fixture-change']);
}

// The worker merges main into A, resolving the conflict upstream() made, and submits the new head.
function mergeAndSubmit(h, { conflict = false, extra = null, agent = 'worker', probes = [] } = {}) {
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
  Object.assign(github.prs['7'], { headRefOid: head, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  github.ci[head] = 'success';
  h.saveGithub(github);
  h.ok(['submit', 'T1', '--sha', head, '--pr', '7', '--agent', agent, ...probes.flatMap((cmd) => ['--host-probe', cmd])]);
  return head;
}

function advance(h, { conflict = false, extra = null } = {}) {
  upstream(h, conflict);
  return mergeAndSubmit(h, { conflict, extra });
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

// The worker resolves the conflict on its own, or after automation's conflict
// rework sent the task back; the rework's revision bump keeps the link. The
// project is paused for that round, so no refill worker's supervisor gates the
// head and dispatches reviewers beside the test's own dispatch. A
// declared host probe runs again at the resolved head, whose receipt must hold it.
const PROBE = 'node -e "process.exit(0)"';
for (const [path_, probes] of [['resubmit', []], ['conflict rework', []], ['resubmit', [PROBE]]]) test(`a conflict-resolving head (${path_}${probes.length ? ', host probe' : ''}) is reviewed on the resolved hunks and tests only the resolved file`, (t) => {
  const h = gated(t, { probes });
  const revision = Number(h.revision('T1'));
  const reviewed = h.readState('tasks.json').tasks[0].sha;
  upstream(h, true);
  if (path_ === 'conflict rework') {
    const github = h.github();
    Object.assign(github.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    h.saveGithub(github);
    h.ok(['project', 'set', '--paused', 'the test claims the rework']);
    h.consume();
    const rework = h.logs().findLast((e) => e.cmd === 'rework');
    assert.equal(rework?.detail.conflict, true, 'automation sends a conflicting PR back as a conflict rework');
    assert.ok(!h.logs().some((e) => e.cmd === 'spawn' && e.detail.role === 'worker'), 'the paused round refills no worker');
    h.ok(['project', 'set', '--paused', '']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
  }
  const head = mergeAndSubmit(h, { conflict: true, probes });
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.carry.kind, 'resolved');
  assert.deepEqual(task.carry.files, ['shared.txt']);
  assert.deepEqual([task.carry.from_revision, task.carry.revision], path_ === 'resubmit' ? [revision, revision] : [revision, revision + 1]);
  for (const type of ['tests', 'clean', 'review']) assert.equal(gate(h, type).ok, false, type);
  h.ok(['check', 'tests', 'T1']);
  const tests = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'tests');
  assert.equal(tests.ok, true, tests.summary);
  assert.equal(tests.sha, head);
  assert.equal(tests.receipt.mode, 'resolved');
  assert.deepEqual(tests.receipt.head_tests, ['test/shared.test.js']);
  assert.deepEqual((tests.receipt.host_probes ?? []).map((r) => [r.command, r.status]), probes.map((cmd) => [cmd, 0]));
  const ran = tests.commands.filter((c) => c.command !== 'git' && !probes.includes(c.command)).map((c) => c.command);
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

// The resolved run is the pinned proof command over the selected tests, so a
// failure in one of them reruns that file alone, as a crucial head's would.
test('a resolved head reruns its failing selected test file once on its own', (t) => {
  const h = gated(t);
  upstream(h, true);
  const head = mergeAndSubmit(h, { conflict: true });
  h.env.SHARED_FLAKE = path.join(h.base, 'shared-flaked');
  h.ok(['check', 'tests', 'T1']);
  const tests = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'tests');
  assert.equal(tests.ok, true, tests.summary);
  assert.equal(tests.sha, head);
  assert.equal(tests.receipt.mode, 'resolved');
  assert.deepEqual(tests.receipt.reruns, [{ step: 'head', files: ['test/shared.test.js'], ok: true }], tests.summary);
  assert.match(tests.summary, /Rerun: reran test\/shared\.test\.js once in the same checkout: exit 0; flaky: test\/shared\.test\.js > shared holds TWO\./);
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

test('a tests run and a review still going at the earlier head pass for the base-only head when they land', async (t) => {
  const h = gated(t, { running: true });
  const { stalled, release } = holdSuite(h);
  const earlier = h.sha;
  const first = h.runAsync(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  let joiner;
  let joinerErr = '';
  try {
    await fileWritten(stalled, { what: 'the tests run at the earlier head started' });
    const head = advance(h);
    assert.equal(gate(h, 'tests').ok, false, 'nothing passed at the earlier head yet');
    // A check at the new head joins the run at the earlier head instead of starting a second suite.
    let child;
    joiner = h.runAsync(['check', 'tests', 'T1', '--agent', 'orchestrator'], { onSpawn: (c) => {
      child = c;
      c.stderr.on('data', (d) => (joinerErr += d));
    } });
    await waitUntil(() => joinerErr.includes('joining the tests run'), { alive: child, what: 'the check at the new head joined the earlier run' });
    fs.writeFileSync(release, '');
    const [ran, joined] = await Promise.all([first, joiner]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(joined.code, 0, joined.stderr);
    assert.equal(h.logs().filter((e) => e.cmd === 'gate run' && e.detail.type === 'tests' && e.detail.phase === 'running').length, 1, 'one suite ran');
    const tests = gate(h, 'tests');
    assert.equal(tests.ok, true, tests.reason);
    assert.equal(tests.carried, `carried from ${earlier.slice(0, 7)}: base-only head`);
    assert.equal(h.logs().findLast((e) => e.cmd === 'check tests').detail.carried_to, head);
    // The reviewer dispatched at the earlier head records its verdict there; it counts for the new head.
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--sha', earlier, '--ok', '--agent', 'reviewer']);
    assert.equal(gate(h, 'review').ok, true);
    assert.equal(h.logs().findLast((e) => e.cmd === 'evidence').detail.carried_to, head);
  } finally {
    fs.writeFileSync(release, '');
    await Promise.all([first, joiner].filter(Boolean));
  }
});
