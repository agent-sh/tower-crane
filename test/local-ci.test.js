'use strict';

// Local CI as a gate: the checker on the merged tree, accept and merge reruns
// and base fetches, audited receipts, failures with redacted tails, and the work
// and memory budgets of text redaction. local-ci-redaction.test.js has the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeRepo } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { HUNG_TEST_MS } = require('./signals');
const { fixture, build, mergeFixture, originFixture } = require('./local-ci-helpers');

test('local CI runs argv on the merged tree and records audited evidence without hosted CI', (t) => {
  const h = fixture(t);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true);
  assert.equal(e.source, 'check ci');
  const tree = h.git(['merge-tree', '--write-tree', h.baseSha, h.sha]).split('\n')[0];
  assert.equal(e.receipt.tree_hash, tree);
  assert.equal(e.receipt.head_sha, h.sha);
  assert.equal(e.receipt.base_sha, h.baseSha);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.receipt.variant, 'default');
  assert.deepEqual(e.receipt.command, h.command);
  assert.equal(e.receipt.timeout, 5);
  assert.ok(e.receipt.duration_ms >= 0);
  const entries = require('node:child_process').execFileSync('git', ['ls-tree', '-r', '-z', tree], { cwd: h.repo });
  assert.equal(e.receipt.source_digest, crypto.createHash('sha256').update(entries).digest('hex'));
  const trace = JSON.parse(fs.readFileSync(h.log, 'utf8'));
  // HEAD is a commit of the merged tree with the base and the head as parents, and no ref names it.
  assert.equal(trace.head, e.receipt.merge_sha);
  assert.equal(h.git(['rev-parse', `${trace.head}^{tree}`]), tree);
  assert.equal(h.git(['rev-list', '--parents', '-n', '1', trace.head]), `${trace.head} ${h.baseSha} ${h.sha}`);
  assert.equal(h.git(['for-each-ref', '--contains', trace.head]), '');
  assert.equal(trace.argument, h.command[3]);
  assert.ok(trace.cwd.startsWith(h.env.TOWER_CRANE_TMP));
  assert.ok(!fs.existsSync(trace.cwd), 'temporary merged worktree removed');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  assert.equal(fs.readFileSync(path.join(h.repo, 'head.txt'), 'utf8'), 'old\n');
  assert.ok(e.commands.some((c) => c.command === h.command[0] && c.status === 0));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.receipt, e.receipt);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  h.ok(['accept', 'T1']);
});

test('accept reruns local CI when the submitted head has no receipt', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.git(['switch', '-q', 'local-change']);
  h.git(['commit', '--allow-empty', '-qm', 'another head with the same tree']);
  const next = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', next]);
  h.reviewer('T1', 'reviewer', next);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci').ok, false);
  h.ok(['accept', 'T1']);
  const evidence = h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'ci');
  assert.equal(evidence.length, 2);
  assert.equal(evidence.at(-1).receipt.head_sha, next);
});

test('accept keeps a receipt on its pinned base while the base moves, and merge requires a fresh check', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances again']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true, 'the receipt holds on the tree it checked');
  h.ok(['accept', 'T1']);
  const ci = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'ci');
  assert.equal(ci.length, 1, 'accept does not rerun a pinned receipt');
  assert.equal(ci[0].receipt.base_sha, h.baseSha);
  const merge = h.run(['merge', 'T1']);
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /local CI receipt base moved: main is [0-9a-f]+, checked base was [0-9a-f]+/);
  assert.match(merge.stderr, /tower-crane check ci T1/);
  assert.doesNotMatch(merge.stderr, /tower-crane rework/);
});

test('reports merge the pinned base once per base move', (t) => {
  const h = mergeFixture(t);
  h.ok(['check', 'ci', 'T1']);
  const log = path.join(h.base, 'tree-queries');
  const opts = { env: { LOCAL_TREE_LOG: log } };
  // read-published: the git shim appends queries; nothing replaces the file.
  const pinnedMerges = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [])
    .filter((args) => args.includes('merge-tree') && args.includes(h.baseSha)).length;
  for (const name of ['later.txt', 'last.txt']) {
    fs.writeFileSync(path.join(h.repo, name), `${name}\n`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', `base adds ${name}`]);
    const before = pinnedMerges();
    assert.equal(h.json(['task', 'show', 'T1'], opts).gates.ok, true);
    assert.equal(h.json(['task', 'show', 'T1'], opts).gates.ok, true);
    assert.equal(h.json(['task', 'list'], opts)[0].gates.ok, true);
    assert.equal(pinnedMerges() - before, 1, `one pinned merge after the base adds ${name}`);
  }
});

test('merge without origin records its base read in its command receipts', (t) => {
  const h = mergeFixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  const merged = h.json(['merge', 'T1']);
  assert.equal(merged.ok, true, merged.summary);
  assert.ok(merged.commands.some((c) => c.command === 'git' && c.args.includes('rev-parse') && c.args.includes('main^{commit}') && c.status === 0),
    JSON.stringify(merged.commands.map((c) => c.args)));
});

// The command advances main from inside its run: HEAD^1 of the gate checkout is the base it merged.
// A base that already has later.txt gets it replaced: a second entry of the same
// name is a corrupt tree that newer git refuses to merge.
const ADVANCE_BASE = `
const cp = require('node:child_process');
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@localhost' };
const git = (args, input) => cp.execFileSync('git', args, { encoding: 'utf8', input, env }).trim();
const base = git(['rev-parse', 'HEAD^1']);
const blob = git(['hash-object', '-w', '--stdin'], 'later ' + base + '\\n');
const kept = git(['ls-tree', base]).split('\\n').filter((line) => !line.endsWith('\\tlater.txt'));
const tree = git(['mktree'], [...kept, '100644 blob ' + blob + '\\tlater.txt'].join('\\n') + '\\n');
git(['update-ref', 'refs/heads/main', git(['commit-tree', tree, '-p', base, '-m', 'base advances during the check'])]);
`;

test('main moving during a local CI run leaves a valid receipt on the pinned tree; a rewritten base does not', (t) => {
  const h = fixture(t, ADVANCE_BASE);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.ok, true, e.summary);
  assert.equal(e.receipt.base_sha, h.baseSha);
  assert.match(e.summary, new RegExp(`of base ${h.baseSha.slice(0, 10)}`));
  const moved = h.git(['rev-parse', 'main']);
  assert.notEqual(moved, h.baseSha, 'the command advanced main');
  assert.notEqual(h.git(['merge-tree', '--write-tree', moved, h.sha]).split('\n')[0], e.receipt.tree_hash, 'the merged tree moved');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);

  // A base that no longer contains the checked one is not the same line of history.
  const rewritten = h.git(['commit-tree', `${moved}^{tree}`, '-p', `${h.baseSha}^`, '-m', 'rewritten base']);
  h.git(['update-ref', 'refs/heads/main', rewritten]);
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '),
    new RegExp(`current merged tree, and its checked base ${h.baseSha.slice(0, 10)} is not in the selected base's history`));
  h.ok(['accept', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.findLast((x) => x.type === 'ci').receipt.base_sha, rewritten);
  assert.deepEqual(h.git(['ls-tree', '--name-only', 'main']).split('\n').filter((name) => name === 'later.txt'), ['later.txt'],
    'the rerun on the rewritten base replaces later.txt');
});

for (const changedTree of [true, false]) {
  test(`merge refreshes a remote-only base advance with ${changedTree ? 'a changed' : 'the same'} tree`, (t) => {
    const h = mergeFixture(t, { origin: true });
    h.ok(['check', 'ci', 'T1']);
    h.ok(['accept', 'T1']);
    if (changedTree) fs.writeFileSync(path.join(h.upstream, 'remote.txt'), 'remote\n');
    h.git(['add', '.'], h.upstream);
    h.git(['commit', '--allow-empty', '-qm', 'remote advances'], h.upstream);
    const remote = h.git(['rev-parse', 'HEAD'], h.upstream);
    h.git(['push', 'origin', 'main'], h.upstream);
    h.git(['config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other']);
    assert.equal(h.git(['rev-parse', 'origin/main']), h.baseSha);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);

    const refused = h.run(['merge', 'T1']);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, /local CI receipt.*base.*moved/);
    assert.match(refused.stderr, /tower-crane check ci T1/);
    assert.doesNotMatch(refused.stderr, /tower-crane rework/);
    assert.equal(h.git(['rev-parse', 'origin/main']), remote);
    assert.equal(h.git(['rev-parse', 'main']), h.baseSha);
    assert.ok(!fs.existsSync(h.merged), 'GitHub merge never ran');
    assert.ok(!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'));

    const receipt = h.json(['check', 'ci', 'T1']).receipt;
    assert.equal(receipt.base_sha, remote);
    const merged = h.json(['merge', 'T1']);
    assert.equal(merged.ok, true);
    assert.match(merged.summary, /into main/);
    assert.ok(merged.commands.some((c) => c.command === 'git' && c.args.includes('fetch') && c.status === 0));
  });
}

test('merge refuses an unreachable or timed out local CI base fetch', (t) => {
  const h = mergeFixture(t, { origin: true });
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  const timedOut = h.run(['merge', 'T1'], { env: { LOCAL_FETCH_TIMEOUT: '1' } });
  assert.equal(timedOut.code, 1);
  assert.match(timedOut.stderr, /fetch.*timed out/);
  assert.ok(!fs.existsSync(h.merged));
  fs.renameSync(h.origin, `${h.origin}.offline`);
  const failed = h.run(['merge', 'T1']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /fetch.*failed/);
  assert.ok(!fs.existsSync(h.merged));
});

test('a divergent local base cannot hide a remote advance from merge', (t) => {
  const h = mergeFixture(t, { origin: true });
  fs.writeFileSync(path.join(h.repo, 'local.txt'), 'local\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'local base advances']);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  fs.writeFileSync(path.join(h.upstream, 'remote.txt'), 'remote\n');
  h.git(['add', '.'], h.upstream);
  h.git(['commit', '-qm', 'remote diverges'], h.upstream);
  h.git(['push', 'origin', 'main'], h.upstream);
  const refused = h.run(['merge', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /local CI receipt.*base.*moved/);
  assert.ok(!fs.existsSync(h.merged));
});

test('hosted CI merges without fetching an unavailable origin when ci.local is absent', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.git(['switch', '-q', 'main']);
  h.init(['--repo', 'acme/demo']);
  originFixture(h);
  h.ok(['task', 'add', '--title', 'hosted check', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', sha, '--branch', 'fixture-change', '--pr', '1']);
  h.reviewer('T1', 'reviewer', sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  fs.renameSync(h.origin, `${h.origin}.offline`);
  const merged = h.json(['merge', 'T1']);
  assert.equal(merged.ok, true);
  assert.ok(!merged.commands.some((c) => c.command === 'git' && c.args.includes('fetch')));
});

test('completed local CI tasks keep their audited result without reading current trees', (t) => {
  const h = mergeFixture(t, { origin: true });
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  const merged = h.json(['merge', 'T1']);
  assert.equal(merged.ok, true);
  assert.match(merged.summary, /into main/);
  // A rewritten base fails a receipt that is still validated; a forward move would keep it.
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base moves after merge']);
  h.git(['update-ref', 'refs/heads/main', h.git(['commit-tree', 'HEAD^{tree}', '-p', `${h.baseSha}^`, '-m', 'base rewritten after merge'])]);
  const log = path.join(h.base, 'tree-queries');
  const opts = { env: { LOCAL_TREE_LOG: log } };
  assert.equal(h.json(['task', 'show', 'T1'], opts).gates.ok, true);
  assert.equal(h.json(['task', 'list'], opts)[0].gates.ok, true);
  assert.ok(!fs.existsSync(log), 'completed tasks do not recompute their merged tree');
  fs.renameSync(h.origin, `${h.origin}.offline`);
  h.ok(['merge', 'T1'], opts);
  assert.ok(!fs.existsSync(log), 'repeated merges do not recompute their merged tree');

  const audit = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(audit, events.filter((e) => e.cmd !== 'merge').map(JSON.stringify).join('\n') + '\n');
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false, 'unaudited merge evidence cannot bypass CI');
});

test('local CI receipt edits lose their gate proof and manual verdicts remain refused', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  const doc = h.readState('tasks.json');
  const original = structuredClone(doc);
  for (const patch of [{ head_sha: 'f'.repeat(40) }, { tree_hash: 'e'.repeat(40) }, { source_digest: 'd'.repeat(64) }, { variant: 'task:T1' }]) {
    const forged = structuredClone(original);
    Object.assign(forged.tasks[0].evidence.at(-1).receipt, patch);
    h.writeState('tasks.json', forged);
    assert.equal(h.run(['accept', 'T1']).code, 1, JSON.stringify(patch));
  }
  const manual = h.run(['evidence', 'T1', '--type', 'ci', '--ok', '--sha', h.sha]);
  assert.equal(manual.code, 1);
  assert.match(manual.stderr, /only tower-crane check ci/);
});

test('matching audit copies cannot bind a receipt to another head or tree', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.git(['switch', '-q', 'local-change']);
  h.git(['commit', '--allow-empty', '-qm', 'new head for receipt validation']);
  const next = h.git(['rev-parse', 'HEAD']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', next]);
  h.reviewer('T1', 'reviewer', next);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
  const doc = h.readState('tasks.json');
  const evidence = doc.tasks[0].evidence.findLast((e) => e.type === 'ci');
  const log = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const event = events.findLast((e) => e.cmd === 'check ci');
  evidence.sha = next;
  event.detail.sha = next;
  const write = () => {
    event.detail.receipt = structuredClone(evidence.receipt);
    h.writeState('tasks.json', doc);
    fs.writeFileSync(log, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  write();
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /receipt.*submitted head/);
  h.ok(['accept', 'T1']);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).receipt.head_sha, next);
  doc.tasks[0].status = 'submitted';
  evidence.receipt.head_sha = next;
  evidence.receipt.tree_hash = 'f'.repeat(40);
  write();
  assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /receipt.*current merged tree/);
  h.ok(['accept', 'T1']);
  assert.notEqual(h.readState('tasks.json').tasks[0].evidence.at(-1).receipt.tree_hash, 'f'.repeat(40));
});

test('failed, missing and timed out local commands record failure and clean their worktrees', (t) => {
  for (const [script, command, timeout, pattern] of [
    ['process.exit(7);', null, 5, /exit 7/],
    ['', ['missing-local-check-command'], 5, /not found/],
    ['setInterval(() => {}, 1000);', null, 0.05, /timed out/],
  ]) {
    const h = fixture(t, script || '// no-op\n');
    // An absent fixture path avoids permission errors from the host PATH.
    const argv = command ? [path.join(h.base, command[0])] : h.command;
    h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: argv, timeout })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, pattern);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
  }
});

// Fails its `lab` step on the first `fail` runs and moves the base under the check on the first
// `move` runs, both read from LOG.config; `--only STEPS` runs just those steps.
const RERUN_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [log, ...rest] = process.argv.slice(2);
// read-published: the test wrote the config before the gate started.
const config = JSON.parse(fs.readFileSync(log + '.config', 'utf8'));
// read-published: appended only, by one gate run at a time.
const runs = fs.existsSync(log + '.runs') ? fs.readFileSync(log + '.runs', 'utf8').length : 0;
fs.appendFileSync(log + '.runs', 'x');
fs.appendFileSync(log + '.argv', JSON.stringify(rest) + '\\n');
fs.appendFileSync(log + '.trees', cp.execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }));
if (runs < config.move) {
  fs.writeFileSync(path.join(config.repo, 'moved-' + runs + '.txt'), 'moved\\n');
  cp.execFileSync('git', ['-C', config.repo, 'add', '-A']);
  cp.execFileSync('git', ['-C', config.repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base moves']);
}
const only = rest.indexOf('--only');
const failing = runs < config.fail;
const steps = only === -1 ? ['unit', 'lab'] : rest.slice(only + 1);
fs.mkdirSync('.local/checks', { recursive: true });
fs.writeFileSync('.local/checks/receipt.json', JSON.stringify({
  steps: steps.map((name) => ({ name, outcome: name === 'lab' && failing ? 'failed' : 'passed' })),
}));
console.log(failing ? 'lab: timing bound exceeded under load' : 'all steps OK');
process.exit(failing ? 1 : 0);
`;

test('local CI reruns a failure once on the same merge, and a base that moves meanwhile leaves the pass on the pinned tree', (t) => {
  for (const [name, { fail = 0, move = 0, settings = {} }, want] of [
    ['fails once', { fail: 1 }, { ok: true, runs: 2, rerun: 'command', flaky: 'local CI lab', gate: true, note: /Rerun: reran the whole command once on the same merge: exit 0; flaky: local CI lab\./ }],
    ['fails twice', { fail: 2 }, { ok: false, runs: 2, rerun: 'command', gate: false, note: /Rerun: reran the whole command once on the same merge: exit 1; the failure stands\./ }],
    ['fails once with rerun_cmd', { fail: 1, settings: { rerun_cmd: 'only' } }, { ok: true, runs: 2, rerun: 'steps', flaky: 'local CI lab', gate: true, note: /Rerun: reran failed steps lab once on the same merge: exit 0/ }],
    ['fails once with rerun off', { fail: 1, settings: { rerun: false } }, { ok: false, runs: 1, gate: false, note: /^local CI exit 1/ }],
    ['base moves', { move: 99 }, { ok: true, runs: 1, trees: 1, gate: true, note: /^local CI \(default\) passed at [0-9a-f]+ on merged tree [0-9a-f]+ of base [0-9a-f]+ \(\d+ ms\)$/ }],
    ['fails once while the base moves', { fail: 1, move: 99 }, { ok: true, runs: 2, trees: 1, rerun: 'command', flaky: 'local CI lab', gate: true, note: /Rerun: reran the whole command once on the same merge: exit 0/ }],
  ]) {
    const h = fixture(t, RERUN_SCRIPT);
    fs.writeFileSync(`${h.log}.config`, JSON.stringify({ repo: h.repo, fail, move }));
    const local = { command: h.command, timeout: 5, receipts: ['.local/checks/*.json'],
      ...(settings.rerun_cmd ? { rerun_cmd: [...h.command, '--only', '{steps}'] } : {}),
      ...(settings.rerun === false ? { rerun: false } : {}) };
    h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, want.ok ? 0 : 1, `${name}: ${r.stdout}${r.stderr}`);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(e.ok, want.ok, name);
    assert.match(e.summary, want.note, name);
    assert.equal(fs.readFileSync(`${h.log}.runs`, 'utf8').length, want.runs, `${name}: runs`);
    const argv = fs.readFileSync(`${h.log}.argv`, 'utf8').trim().split('\n').map(JSON.parse);
    if (want.rerun === 'steps') assert.deepEqual(argv[1], [h.command[3], '--only', 'lab'], name);
    else assert.ok(argv.every((args) => args.length === 1), `${name}: whole command runs ${JSON.stringify(argv)}`);
    if (want.rerun) {
      assert.deepEqual(e.receipt.rerun, { command: want.rerun === 'steps' ? [...h.command, '--only', 'lab'] : h.command,
        steps: want.rerun === 'steps' ? ['lab'] : null, exit: want.ok ? 0 : 1, signal: null, duration_ms: e.receipt.rerun.duration_ms }, name);
      assert.equal(e.receipt.exit, 1, `${name}: the receipt keeps the first run`);
    } else assert.equal(e.receipt.rerun, undefined, name);
    assert.equal(!!e.confirmed_failure, !want.ok, name);
    if (want.flaky) {
      assert.deepEqual(e.flaky.map((f) => [f.test, f.first_failure.status, f.rerun.status]), [[want.flaky, 1, 0]], name);
      assert.match(e.flaky[0].first_failure.excerpt, /timing bound exceeded/, name);
      assert.equal(e.flaky[0].first_failure.log, e.local_ci.first_failure.log, name);
      assert.equal(e.flaky[0].rerun.log, e.local_ci.log, name);
      assert.notEqual(e.local_ci.log, e.local_ci.first_failure.log, name);
    } else assert.equal(e.flaky, undefined, name);
    if (want.trees) {
      const trees = fs.readFileSync(`${h.log}.trees`, 'utf8').trim().split('\n');
      assert.equal(new Set(trees).size, want.trees, `${name}: every run is on the pinned merged tree`);
      assert.equal(e.receipt.tree_hash, trees.at(-1), name);
      assert.notEqual(h.git(['rev-parse', 'main']), e.receipt.base_sha, `${name}: the base moved during the check`);
    }
    const ci = h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci');
    assert.equal(ci.ok, want.gate, `${name}: ${ci.reason}`);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1, name);
  }
});

// A run whose worktree cannot be set up has no exit to record: the gate fails with the setup's
// own reason, for the first run and for the rerun.
test('local CI reports a worktree it could not set up, for the first run and for the rerun', (t) => {
  for (const [name, setup, want] of [
    ['first run', (h) => { h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp-file'); fs.writeFileSync(h.env.TOWER_CRANE_TMP, ''); },
      { runs: 0, summary: /^cannot create a temporary directory under .*gate-tmp-file/ }],
    // The second checkout's post-checkout hook fails, so only the rerun's worktree is refused.
    // The gate's git runs only hooks from the user's own config.
    ['rerun', (h) => {
      const hooks = path.join(h.base, 'hooks');
      const count = path.join(h.base, 'checkouts').replace(/\\/g, '/');
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho x >> '${count}'\n[ "$(wc -l < '${count}')" -lt 2 ]\n`, { mode: 0o755 });
      h.git(['config', '--global', 'core.hooksPath', hooks.replace(/\\/g, '/')]);
    }, { runs: 1, summary: /^local CI exit 1[\s\S]*\nRerun: could not rerun the whole command: could not create a worktree at [0-9a-f]+: .*post-checkout hook passes\.; the failure stands\.$/ }],
  ]) {
    const h = fixture(t, RERUN_SCRIPT);
    fs.writeFileSync(`${h.log}.config`, JSON.stringify({ repo: h.repo, fail: 2, move: 0 }));
    h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 5, receipts: ['.local/checks/*.json'] })]);
    setup(h);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError/, name);
    const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
    assert.equal(e.ok, false, name);
    assert.match(e.summary, want.summary, name);
    const runs = fs.existsSync(`${h.log}.runs`) ? fs.readFileSync(`${h.log}.runs`, 'utf8').length : 0;
    assert.equal(runs, want.runs, `${name}: runs`);
    if (want.runs) assert.deepEqual([e.receipt.rerun.exit, e.receipt.rerun.signal], [null, null], name);
  }
});

test('a local CI rerun resolves per variant: args overrides append, a replacement command reruns whole unless it names its own', () => {
  const Local = require('../lib/ci-local');
  const base = { command: ['ci'], timeout: 5, rerun_cmd: ['ci', '--only', '{steps}'] };
  for (const [name, local, task, want] of [
    ['default', base, { kind: 'code' }, { rerun: true, rerun_cmd: ['ci', '--only', '{steps}'] }],
    ['no rerun_cmd', { command: ['ci'], timeout: 5 }, { kind: 'code' }, { rerun: true, rerun_cmd: null }],
    ['off', { ...base, rerun: false }, { kind: 'code' }, { rerun: false, rerun_cmd: ['ci', '--only', '{steps}'] }],
    ['args override', { ...base, by_kind: { ops: { args: ['--lab'] } } }, { kind: 'ops' }, { rerun: true, rerun_cmd: ['ci', '--only', '{steps}', '--lab'] }],
    ['replacement command', { ...base, by_kind: { ops: { command: ['lab'] } } }, { kind: 'ops' }, { rerun: true, rerun_cmd: null }],
    ['replacement with its own', { ...base, by_kind: { ops: { command: ['lab'], rerun_cmd: ['lab', '{steps}'] } } }, { kind: 'ops' }, { rerun: true, rerun_cmd: ['lab', '{steps}'] }],
    ['task override', base, { id: 'T1', kind: 'code', ci_local: { args: ['--x'] } }, { rerun: true, rerun_cmd: ['ci', '--only', '{steps}', '--x'] }],
  ]) {
    const r = Local.resolve(local, task);
    assert.deepEqual({ rerun: r.rerun, rerun_cmd: r.rerun_cmd }, want, name);
  }
  for (const [name, local] of [
    ['rerun_cmd without {steps}', { ...base, rerun_cmd: ['ci', '--only'] }],
    ['blank rerun_cmd', { ...base, rerun_cmd: [] }],
    ['rerun not a boolean', { ...base, rerun: 'no' }],
    ['override rerun_cmd without {steps}', { ...base, by_kind: { ops: { args: [], rerun_cmd: ['ci'] } } }],
  ]) assert.equal(Local.valid(local), false, name);
  assert.deepEqual(Local.expandSteps(['ci', '--only', '{steps}', 'x{steps}'], ['a b', 'c']), ['ci', '--only', 'a b', 'c', 'x{steps}']);
});

test('a failed local CI keeps a redacted output tail, its full log and the artifacts it names', (t) => {
  // Shaped like ginza's tools/check.py: the failing step prints early, later steps print after
  // it, and the receipt it writes inside the gate worktree is named on the last line.
  const h = fixture(t, `
const fs = require('node:fs');
const path = require('node:path');
console.log('step 1: scaffold ok');
// A token wrapped onto two stdout lines with a stderr line written between them. The pauses let
// the gate read each write on its own, so the stderr line arrives between the halves.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // wait-allow: the gate sends the fixture no signal when it has read a write
console.log('split ' + process.env.CI_FIXTURE_TOKEN.slice(0, 10));
pause(100);
console.error('between the halves');
pause(100);
console.log(process.env.CI_FIXTURE_TOKEN.slice(10) + ' tail');
for (let i = 0; i < 300; i++) console.log('early line ' + i);
// stdout: the gate reads stdout and stderr from two sockets and joins them in arrival order, so
// a stderr line can land hundreds of stdout lines from where it was written.
console.log('FAILING STEP: unit tests, token ' + process.env.CI_FIXTURE_TOKEN);
console.error('stderr token ' + process.env.CI_FIXTURE_TOKEN);
// A color escape inside the token hides it from the patterns until the escape is removed.
const token = process.env.CI_FIXTURE_TOKEN;
console.log('colored ' + token.slice(0, 4) + '\\x1b[1m' + token.slice(4) + '\\x1b[0m');
// An OSC hyperlink and a charset escape (tput sgr0) inside the token hide it the same way.
console.log('osc ' + token.slice(0, 4) + '\\x1b]8;;https://x\\x07' + token.slice(4, 10) + '\\x1b(B' + token.slice(10));
// An OSC without its terminator ends at its line, so it cannot remove lines up to a later BEL.
console.log('unterminated \\x1b]8;;https://x');
console.log('after the unterminated escape');
console.log('title \\x1b]0;t\\x07set');
// A progress redraw right before a token that is not in the environment: the token shape still matches.
console.log('Downloading\\rghp_' + 'd4'.repeat(18));
// A stray ESC takes the token's first character, and an unterminated OSC its head, while a second
// escape splits it; a line break splits another.
console.log('stray \\x1b' + token.slice(0, 8) + '\\x1b[1m' + token.slice(8));
console.log('osc head \\x1b]0;t ' + token.slice(0, 8) + '\\x1b[1m' + token.slice(8));
console.log('wrapped ' + token.slice(0, 10));
console.log(token.slice(10) + ' end');
for (let i = 0; i < 150; i++) console.log('cargo tree line ' + i);
fs.mkdirSync('.local/checks', { recursive: true });
// Like ginza's receipt, which holds every step's full output, including what the log redacts.
fs.writeFileSync('.local/checks/receipt.json', JSON.stringify({ failure_reasons: ['unit tests failed'], output: 'token ' + token }));
fs.writeFileSync('.local/checks/extra.json', '{}');
// A colored receipt: the escape inside the token would hide it from the patterns.
fs.writeFileSync('.local/checks/colored.json', '{"output": "\\x1b[32m' + token.slice(0, 4) + '\\x1b[1m' + token.slice(4) + '\\x1b[0m"}');
// The same splits in a text artifact and a binary one.
const split = '\\x1b(' + token.slice(0, 8) + '\\x1b[1m' + token.slice(8) + ' \\x1b]0;t ' + token.slice(0, 8) + '\\x1b[1m' + token.slice(8) + '\\n' + token.slice(0, 10) + '\\n' + token.slice(10);
fs.writeFileSync('.local/checks/split.json', split);
fs.writeFileSync('.local/checks/split-binary.json', '\\x00' + split);
// Every byte value, twice: no secret, so it must come out byte for byte.
fs.writeFileSync('.local/checks/blob.json', Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)));
// Latin-1 text: invalid UTF-8 without a NUL byte, holding the environment's token and another token shape.
fs.writeFileSync('.local/checks/latin1.json', Buffer.from('{"caf\\xe9": "' + token + '", "other": "ghp_' + 'e5'.repeat(18) + '"}', 'latin1'));
// UTF-16 puts a NUL between the token's characters, where no byte-level match finds it.
fs.writeFileSync('.local/checks/utf16.json', Buffer.from('{"t": "' + token + '"}', 'utf16le'));
fs.writeFileSync(path.join(process.env.TMPDIR, 'report.txt'), 'scratch report');
console.log('Scratch report: ' + path.join(process.env.TMPDIR, 'report.txt'));
console.log('Local check receipt: ' + path.resolve('.local/checks/receipt.json'));
console.log('Local check receipt: ' + path.resolve('..', '..', '..', 'outside.json'));
// Not process.exit(1): node's stdout to the gate is a socket that holds about 170 writes, and
// when the gate has not read yet node queues the rest, which an explicit exit drops.
process.exitCode = 1;
`);
  const token = `ghp_${'a1'.repeat(18)}`;
  h.env.CI_FIXTURE_TOKEN = token;
  fs.writeFileSync(path.join(h.env.TOWER_CRANE_TMP, '..', 'outside.json'), '{}');
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 30,
    artifacts: ['.local/checks/*.json'], artifact_pattern: '^(?:Local check receipt|Scratch report): (.+)$' })]);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(e.ok, false);
  assert.equal(e.confirmed_failure, true);
  const kept = e.local_ci;
  // The tail reaches back past 150 later lines to the failing step, with the token redacted.
  assert.match(kept.output_tail, /FAILING STEP: unit tests, token \[redacted:/);
  assert.ok(!kept.output_tail.includes(token));
  assert.ok(kept.output_tail.split('\n').length <= 200);
  assert.doesNotMatch(kept.output_tail, /^step 1: scaffold ok$/m);
  assert.doesNotMatch(kept.output_tail, /^early line 0$/m);
  assert.match(kept.output_tail, /^colored \[redacted:/m);
  assert.match(kept.output_tail, /^osc \[redacted:/m);
  // The full log holds every line, redacted, under the state directory's logs.
  assert.match(kept.log, /^logs\/ci-T1-[0-9a-f]{10}-[^/]+\/output\.log$/);
  const log = fs.readFileSync(path.join(h.state, kept.log), 'utf8');
  assert.match(log, /^step 1: scaffold ok$/m);
  assert.match(log, /^early line 0$/m);
  assert.match(log, /^cargo tree line 149$/m);
  assert.equal(log.match(/^stderr token \[redacted:CI_FIXTURE_TOKEN\]$/gm)?.length, 1, log);
  // Lines keep their order only within a stream (docs/state.md), so a stderr line can land
  // between any two stdout lines; runs of stdout lines are checked without them.
  const stdoutLog = log.split('\n').filter((line) => !/^(?:stderr token |between the halves$)/.test(line)).join('\n');
  // Each stream's own text is read for secrets too, so a stderr line read between a token's
  // halves leaves both redacted, each on its own line.
  assert.match(log, /^between the halves$/m);
  assert.match(stdoutLog, /^split \[redacted:CI_FIXTURE_TOKEN\](?:\n\[redacted:CI_FIXTURE_TOKEN\])? tail$/m);
  assert.match(stdoutLog, /^unterminated \nafter the unterminated escape\ntitle set\nDownloading\n\[redacted:GITHUB_TOKEN\]$/m);
  // The stderr line can also land between the halves of the wrapped token; each half is then
  // redacted on its own line.
  assert.match(stdoutLog, /^stray \[redacted:CI_FIXTURE_TOKEN\]\nosc head \[redacted:CI_FIXTURE_TOKEN\]\nwrapped \[redacted:CI_FIXTURE_TOKEN\](?:\n\[redacted:CI_FIXTURE_TOKEN\])? end$/m);
  assert.doesNotMatch(log, /(?:a1){4}/);
  assert.doesNotMatch(kept.output_tail, /(?:a1){4}/);
  assert.ok(!log.includes('ghp_d4'), log);
  assert.ok(!log.includes(token));
  assert.ok(r.stdout.includes(`Full log: ${path.join(h.state, kept.log)}`), r.stdout);
  assert.ok(!r.stdout.includes(token));
  // Printed paths come first, then the globs; a file outside the gate directory is left in place.
  // Artifacts sit in ci-artifacts/, which every agent sandbox hides, beside the run's log name.
  const run = path.basename(path.dirname(kept.log));
  const copied = Object.fromEntries(kept.artifacts.map((a) => [path.basename(a.from), a]));
  assert.deepEqual(Object.keys(copied).sort(), ['blob.json', 'colored.json', 'extra.json', 'latin1.json', 'receipt.json', 'report.txt', 'split.json']);
  for (const a of kept.artifacts) assert.ok(a.path.startsWith(`ci-artifacts/${run}/`), a.path);
  // Text artifacts get the log's redaction; a binary one is redacted at the byte level.
  const receipt = fs.readFileSync(path.join(h.state, copied['receipt.json'].path), 'utf8');
  assert.ok(!receipt.includes(token));
  assert.deepEqual(JSON.parse(receipt), { failure_reasons: ['unit tests failed'], output: 'token [redacted:CI_FIXTURE_TOKEN]' });
  assert.equal(copied['receipt.json'].redacted, true);
  assert.equal(copied['receipt.json'].bytes, Buffer.byteLength(receipt));
  assert.equal(fs.readFileSync(path.join(h.state, copied['colored.json'].path), 'utf8'), '{"output": "[redacted:CI_FIXTURE_TOKEN]"}');
  assert.equal(copied['colored.json'].redacted, true);
  assert.equal(fs.readFileSync(path.join(h.state, copied['split.json'].path), 'utf8'), '[redacted:CI_FIXTURE_TOKEN] [redacted:CI_FIXTURE_TOKEN]\n[redacted:CI_FIXTURE_TOKEN]');
  assert.deepEqual(fs.readFileSync(path.join(h.state, copied['blob.json'].path)), Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)));
  assert.equal(copied['blob.json'].binary, true);
  assert.equal(copied['blob.json'].redacted, undefined);
  // Decoding invalid UTF-8 would replace its bytes with U+FFFD, so it is binary: the environment
  // value and the token shape are redacted in place and every other byte stays as written.
  const latin1 = Buffer.from('{"caf\xe9": "[redacted:CI_FIXTURE_TOKEN]", "other": "[redacted:GITHUB_TOKEN]"}', 'latin1');
  assert.deepEqual(fs.readFileSync(path.join(h.state, copied['latin1.json'].path)), latin1);
  assert.equal(copied['latin1.json'].binary, true);
  assert.equal(copied['latin1.json'].redacted, true);
  assert.equal(copied['latin1.json'].bytes, latin1.length);
  assert.equal(fs.readFileSync(path.join(h.state, copied['report.txt'].path), 'utf8'), 'scratch report');
  assert.equal(copied['report.txt'].path, `ci-artifacts/${run}/TMPDIR/report.txt`);
  assert.equal(copied['extra.json'].path, `ci-artifacts/${run}/worktree/.local/checks/extra.json`);
  assert.equal(fs.readFileSync(path.join(h.state, 'ci-artifacts', '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(kept.artifacts_skipped.map((s) => path.basename(s.from)), ['outside.json', 'split-binary.json', 'utf16.json']);
  assert.match(kept.artifacts_skipped[0].reason, /outside the gate worktree/);
  assert.match(kept.artifacts_skipped[1].reason, /^binary, and a secret as bytes with escapes removed gently that exact byte redaction cannot remove$/);
  assert.match(kept.artifacts_skipped[2].reason, /^binary, and a secret as .+ that exact byte redaction cannot remove$/);
  // The summary reaches worker prompts, so it counts the artifacts and names none.
  assert.match(r.stdout, /Artifacts: 7 kept for the orchestrator and the owner/);
  assert.ok(!r.stdout.includes('ci-artifacts'), r.stdout);
  assert.ok(!e.summary.includes('ci-artifacts'));
  // The gate worktree is still removed.
  assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
  assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.local_ci, kept);
});

test('gate output loses terminal escapes, and an unterminated string ends at its line', () => {
  const { stripEscapes } = require('../lib/gates/common');
  const cases = [
    ['CSI', 'a\x1b[31mred\x1b[0m', 'ared'],
    ['C1 CSI', '\x9b31mred\x9b0m', 'red'],
    ['OSC BEL', '\x1b]0;title\x07text', 'text'],
    ['OSC ST', '\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['charset', 'a\x1b(Bb', 'ab'],
    ['DCS', 'a\x1bPq#0\x1b\\b', 'ab'],
    ['OSC to the line end', 'a\x1b]8;;https://x\nkept\n\x1b]0;t\x07b', 'a\nkept\nb'],
    ['DCS to the line end', 'a\x1bPq\nkept\x1b\\b', 'a\nkeptb'],
    ['OSC up to the next escape', 'a\x1b]8;;x\x1b[1mb', 'ab'],
    ['8-bit ST ends an OSC', '\x1b]8;;url\x9clink\x1b]8;;\x9c rest', 'link rest'],
    ['C1 OSC and DCS', 'a\x9d0;t\x9cb\x90q\x9cc', 'abc'],
    ['lone ESC before DEL, ESC and non-ASCII', 'a\x1b\x7f.\x1b\x1b\x7f,\x1béb', 'a.,éb'],
    ['C0 and C1 controls go; tab and newline stay', '(\x00\x08\x0b\x7f\x85)\tc\n', '()\tc\n'],
    ['a control run between word characters goes', 'ab\x00cd\x7f\x85ef_\x1b\x7fg', 'abcdef_g'],
    // A Windows tool's UTF-16 output read as UTF-8: a NUL after every character.
    ['UTF-16 text', [...'Forbidden (403).\n'].map((c) => `${c}\x00`).join(''), 'Forbidden (403).\n'],
    ['a control run inside a token shape goes', `ghp_${'a'.repeat(10)}\x1b\x7f${'b'.repeat(10)}\x00 next`, `ghp_${'a'.repeat(10)}${'b'.repeat(10)} next`],
    ['a CR ends a line and CRLF is LF', 'get 10%\rget 50%\r\nnext\r\r\nlast\r', 'get 10%\nget 50%\nnext\nlast'],
  ];
  for (const [name, input, expected] of cases) assert.equal(stripEscapes(input), expected, name);
  // Each unterminated string ends at the next ESC. A lazy scan to a terminator that never comes
  // went to the end of the text for each of them, about 5 seconds for 50000. Each input below is
  // a million characters of a form that makes a backtracking scan quadratic.
  const million = 1e6;
  for (const [name, input, expected] of [
    ['unterminated OSC', '\x1b]x'.repeat(Math.ceil(million / 3)), ''],
    ['unterminated C1 OSC', '\x9dx'.repeat(million / 2), ''],
    ['unterminated DCS', '\x1bPx'.repeat(Math.ceil(million / 3)), ''],
    ['CSI without a final byte', ('\x1b[' + '0'.repeat(98)).repeat(million / 100), '0'.repeat(98 * million / 100)],
    ['ESC runs', '\x1b'.repeat(million), ''],
  ]) assert.equal(stripEscapes(input), expected, name);
});

test('text redaction drops the entire input past its size or search work budget', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const { stripEscapes, stripEscapesMapped, stripEscapesViews } = require('../lib/ci-log-text');
  const redact = createRedactor([['FIXTURE_SECRET', 'a123456789b']]);
  const notice = /^\[unscannable text: .+; content omitted\]$/;
  for (const input of [
    `private ${'x'.repeat(32 << 20)}`,
    // Every value start explores hundreds of escape readings that go nowhere: 3 work units for
    // each character, where the budget allows 1.
    `private ${('a\x1b[' + '1'.repeat(1024) + 'm ').repeat(1024)} end`,
  ]) {
    assert.match(redact(redact.strip(input)), notice);
    assert.match(stripEscapes(input, ['a123456789b']), notice);
    const mapped = stripEscapesMapped(input, ['a123456789b']);
    assert.match(mapped.text, notice);
    assert.match(mapped.unscannable, /over /);
    assert.deepEqual(mapped.at(0), [0, input.length]);
    for (const v of stripEscapesViews(input, ['a123456789b'])) assert.match(v.text, notice);
    assert.match(redactJoined({ output: input, runs: [{ stream: 'out', text: input }, { stream: 'err', text: '' }] }, redact), notice);
  }
  assert.match(redact('private ' + 'x'.repeat(32 << 20)), notice);
  const huge = 'a123456789b '.repeat((32 << 20) / 12 + 1);
  assert.deepEqual(redact.ranges(huge), [{ a: 0, b: huge.length, label: 'UNSCANNABLE' }]);
  // The budget grows with the text: dense colors, line breaks, headers, placeholders and secrets
  // cost a little work each and stay scannable at any count.
  assert.equal(redact.strip(`a ${'\x1b[0m'.repeat(1 << 18)} b`), 'a  b');
  assert.equal(redact.strip(`a ${'\n'.repeat(1 << 20)} b`), `a ${'\n'.repeat(1 << 20)} b`);
  assert.equal(redact(redact.strip('Authorization: value\n'.repeat(1 << 16))), 'Authorization: [redacted:AUTHORIZATION]\n'.repeat(1 << 16));
  assert.equal(redact('[redacted:A] '.repeat(1 << 18)), '[redacted:A] '.repeat(1 << 18));
  assert.equal(redact('a123456789b '.repeat(1 << 18)), '[redacted:FIXTURE_SECRET] '.repeat(1 << 18));
  const short = createRedactor([['SHORT_SECRET', 'ab']]);
  assert.equal(short(short.strip('\x07' + 'ab '.repeat(1 << 18))), '[redacted:SHORT_SECRET] '.repeat(1 << 18));
  // Exhausting one call never disables scanning or contaminates the next.
  assert.equal(redact(redact.strip('a123\x1b[0m456789b after')), '[redacted:FIXTURE_SECRET] after');
});

test('multi-MB plain, colored and CRLF logs keep the redaction output from before the text budget', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const { stripEscapes } = require('../lib/ci-log-text');
  // Shaped like the logs a fixed budget dropped whole: `git log -p` of this repository at 7.5 MB,
  // the same in color at 800 KB, and a 2 MB log with CRLF line ends.
  const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const patch = [
    'commit 9201fbd4c0ffee5a8d3e1b2c4f6a7b8c9d0e1f2a',
    'Author: Tower Crane <tc@example.com>',
    '',
    '    T399: shell lint reads arithmetic and never overflows the stack',
    '',
    'diff --git a/lib/shell-lint.js b/lib/shell-lint.js',
    '@@ -120,7 +120,9 @@ function words(text) {',
    '-  const depth = stack.length;',
    '+  const depth = Math.min(stack.length, MAX_DEPTH);',
    '   if (depth > 0) return words(text.slice(1));',
    '',
  ].join('\n');
  const colored = '\x1b[32m\u2714\x1b[39m \x1b[90mlocal CI keeps the tail of a passing run\x1b[39m \x1b[33m(12ms)\x1b[39m\n';
  const crlf = 'ok 12 - gate output loses terminal escapes # time=3.5ms\r\n';
  const redact = createRedactor([['FIXTURE_TOKEN', 'ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2']]);
  for (const [name, text, expected] of [
    ['plain', fill(patch, 7.5e6), (t) => t],
    ['colored', fill(colored, 8e5), (t) => t.replace(/\x1b\[\d+m/g, '')],
    ['CRLF', fill(crlf, 2e6), (t) => t.replaceAll('\r\n', '\n')],
  ]) {
    const clean = expected(text);
    assert.equal(stripEscapes(text), clean, name);
    assert.equal(redactJoined({ stdout: text, stderr: '' }, redact), clean, name);
    const half = Math.floor(text.length / 2);
    assert.equal(redactJoined({ output: text, runs: [
      { stream: 'out', text: text.slice(0, half) },
      { stream: 'err', text: text.slice(half) },
    ] }, redact), clean, `${name} streams`);
  }
});

test('a text redaction deadline drops content and restores the budget for the next call', () => {
  const { performance } = require('node:perf_hooks');
  const { textBudget, textWork } = require('../lib/text-redaction-budget');
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const now = performance.now;
  let clock = 0;
  performance.now = () => (clock += 6000);
  try {
    assert.match(redact.strip('Authorization: Bearer sekrit end'),
      /^\[unscannable text: over 5000 ms redaction time; content omitted\]$/);
    for (const [size, deadline] of [[0, 5000], [16 << 20, 21000]]) {
      const input = 'x'.repeat(size);
      for (const stage of ['work', 'completion']) {
        for (const elapsed of [deadline - 1, deadline, deadline + 1]) {
          clock = 0;
          performance.now = () => clock;
          const result = textBudget(input, () => {
            clock = elapsed;
            if (stage === 'work') textWork(1);
            return 'kept';
          });
          const expected = elapsed > deadline
            ? `[unscannable text: over ${deadline} ms redaction time; content omitted]` : 'kept';
          assert.equal(result, expected, `${size} characters, ${stage}, ${elapsed} ms`);
          assert.equal(textBudget('', () => 'next'), 'next');
        }
      }
    }
  } finally {
    performance.now = now;
  }
  assert.equal(redact(redact.strip('Authorization: Bearer sekrit end')),
    'Authorization: Bearer [redacted:AUTHORIZATION] end');
});

test('short CRLF and redraw logs keep ordinary download progress and counters', () => {
  const { stripEscapes, createRedactor, redactJoined } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const build = (line, size, complete = false) => {
    const parts = [];
    let length = 0;
    for (let i = 0; length < size; i++) {
      const next = line(i);
      parts.push(next);
      length += next.length;
    }
    const text = parts.join('');
    return complete ? text : text.slice(0, size);
  };
  const progress = Array.from({ length: 101 }, (_, p) => '\r' + String(p).padStart(3) + '%').join('');
  const cases = [
    ['download-512KiB', build((i) => `Downloading pkg-${i}.tar.gz\n${progress}\n`, 512 << 10)],
    ['download-1MiB', build((i) => `Downloading pkg-${i}.tar.gz\n${progress}\n`, 1 << 20)],
    ['counter-1MiB', build((i) => `${i}\r\n`, 1 << 20)],
    ...Array.from({ length: 7 }, (_, i) => [`CRLF-${i + 1}`, fill('p'.repeat(i + 1) + '\r\n', 4 << 20)]),
    ...Array.from({ length: 6 }, (_, i) => [`redraw-${i + 3}`, fill('\r' + 'p'.repeat(i + 3), 4 << 20)]),
    ['percent', fill('\r 45%', 4 << 20)],
    ['blank lines', fill('a\r\n\r\n\r\nb line here\r\n', 4 << 20)],
    ['dotnet-1MiB', fill('passed test1\r\n', 1 << 20)],
    ['jest redraw', build((i) => `\r\x1b[K\x1b[1mRUNS\x1b[22m test/file${i % 50}.test.js\r\n`, 4 << 20, true)],
  ];
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  for (const [name, input] of cases) {
    let expected = input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (input.endsWith('\r')) expected = expected.slice(0, -1);
    assert.equal(hash(stripEscapes(input)), hash(expected), `${name} cleanup`);
    assert.equal(hash(redactJoined({ stdout: input, stderr: '' }, redact)), hash(expected), `${name} joined`);
    const half = input.length >> 1;
    assert.equal(hash(redactJoined({ output: input, runs: [
      { stream: 'out', text: input.slice(0, half) }, { stream: 'err', text: input.slice(half) },
    ] }, redact)), hash(expected), `${name} streams`);
  }
});

test('erase-line redraws before short words keep all three readings', () => {
  const { stripEscapes, createRedactor, redactJoined } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const fill = (unit, size) => unit.repeat(Math.ceil(size / unit.length));
  const cases = [
    ['erase redraw', fill('\r\x1b[Kfetchxxxx', 4 << 20)],
    ['erase CRLF', fill('\x1b[Kok 123\r\n', 1 << 20)],
    ...[9, 10, 11].flatMap((width) => {
      const word = 'fetch' + 'x'.repeat(width - 5);
      return [
        [`redraw-${width}`, fill('\r\x1b[K' + word, 4 << 20)],
        [`CRLF-${width}`, fill('\x1b[K' + word + '\r\n', 4 << 20)],
      ];
    }),
  ];
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  for (const [name, input] of cases) {
    const expected = input.replace(/\x1b\[K/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    assert.equal(hash(stripEscapes(input)), hash(expected), name + ' cleanup');
    assert.equal(hash(redactJoined({ stdout: input, stderr: '' }, redact)), hash(expected), name + ' joined');
    const half = input.length >> 1;
    assert.equal(hash(redactJoined({ output: input, runs: [
      { stream: 'out', text: input.slice(0, half) }, { stream: 'err', text: input.slice(half) },
    ] }, redact)), hash(expected), name + ' streams');
  }
});

function redactionMemoryProbe(t, name, script) {
  const cp = require('node:child_process');
  // Memory probes must finish the scan even when host contention consumes its time budget.
  // The deadline has a separate test; work limits still bound scans and allocations here.
  const source = `
require('node:perf_hooks').performance.now = () => 0;
${script}
console.log(JSON.stringify({ ...result, peakKiB: process.resourceUsage().maxRSS }));
`;
  const result = JSON.parse(cp.execFileSync(process.execPath, [
    '--require', path.join(__dirname, 'fixtures', 'redaction-clock-jump.js'), '-e', source,
  ], { encoding: 'utf8', timeout: HUNG_TEST_MS }));
  const boundKiB = 1048576;
  t.diagnostic(`${name}: peak ${result.peakKiB} KiB; bound < ${boundKiB} KiB`);
  assert.ok(Number.isFinite(result.peakKiB) && result.peakKiB > 0 && result.peakKiB < boundKiB,
    `${name}: ${result.peakKiB} KiB peak; bound < ${boundKiB} KiB`);
  return result;
}

test('mixed 16 MiB text fails closed below 1 GiB in a fresh process', (t) => {
  const script = `
const { createRedactor, redactJoined } = require(${JSON.stringify(require.resolve('../lib/gates/common'))});
const value = 'perfSecret123456789abcdef';
const unit = 'normal line lorem125 ok\\nx\\x1b[0mAuthorization: Bearer sekrit end\\n'
  + [...value].join('\\x1b[0m') + '\\n';
const text = unit.repeat(Math.ceil((16 << 20) / unit.length)).slice(0, 16 << 20);
const runs = [{ stream: 'out', text: text.slice(0, text.length / 2) },
  { stream: 'err', text: text.slice(text.length / 2) }];
const output = redactJoined({ output: text, runs }, createRedactor([['PERF_SECRET', value]]));
const result = { output };
`;
  const result = redactionMemoryProbe(t, 'mixed text', script);
  assert.match(result.output, /^\[unscannable text: over \d+ redaction work units; content omitted\]$/);
});

test('16 MiB of tokens an escape and a line break split stays scannable below 1 GiB in two streams', (t) => {
  // The joined view kept every view and secret its readings made alive while each stream was
  // read, and peaked at 1.26 GB.
  const script = `
const { createRedactor, redactJoined } = require(${JSON.stringify(require.resolve('../lib/gates/common'))});
const unit = 'ghp_Ab3dEf\\x1b(B6hIj9kLm2nO\\np5qRs8tUv1wXy4zAb7d done\\n';
const units = Math.floor((16 << 20) / unit.length);
const text = unit.repeat(units);
const half = text.length >> 1;
const output = redactJoined({ output: text, runs: [
  { stream: 'out', text: text.slice(0, half) },
  { stream: 'err', text: text.slice(half) },
] }, createRedactor([]));
const expected = '[redacted:GITHUB_TOKEN] done\\n'.repeat(units);
const result = { same: output === expected, head: output.slice(0, 80) };
`;
  const result = redactionMemoryProbe(t, 'two-stream tokens', script);
  assert.ok(result.same, result.head);
});

test('a value search reads only the controls a value prefix can end at', () => {
  const { textBudget } = require('../lib/text-redaction-budget');
  const { valueSpans } = require('../lib/escape-views');
  // A colored 4 MiB log costs 1025 units a reading. Reading the run before every control as well,
  // as a JavaScript walk did, cost about 600 more, and 200 readings left the 262144-unit floor.
  const line = '\x1b[32mPASS\x1b[0m test name here \x1b[1;31mFAIL\x1b[0m\n';
  const text = line.repeat(Math.ceil((4 << 20) / line.length)).slice(0, 4 << 20);
  const literal = 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0';
  const read = () => {
    for (let k = 0; k < 100; k++) {
      assert.deepEqual(valueSpans(text, literal), []);
      assert.deepEqual(valueSpans(text, literal, null, false), []);
    }
    return 'read';
  };
  assert.equal(textBudget('', read), 'read');
  // A value split by a control is still found, and an exact one stands as itself.
  const split = `x ${literal.slice(0, 9)}\x1b[1m${literal.slice(9)} ${literal}`;
  assert.deepEqual(valueSpans(split, literal).map(([a, b]) => [a, b]), [[2, 36], [37, 67]]);
});

test('a long value that starts like a long run of text costs one reading of the run', () => {
  const { textBudget } = require('../lib/text-redaction-budget');
  const { valueSpans } = require('../lib/escape-views');
  // A search forward from every first character read the value's other characters again at
  // each one, outside the work units: 1 MiB of these took 2 to 5 s a reading, past the 5 s
  // floor in all, against a few ms now.
  const runs = [
    ['a'.repeat(1 << 20), 'a'.repeat(999) + 'b'],
    ['ab'.repeat(1 << 19), 'ab'.repeat(500) + 'c'],
  ];
  const read = () => {
    for (const [text, literal] of runs) {
      assert.deepEqual(valueSpans(text, literal), []);
      assert.deepEqual(valueSpans(text, literal, null, false), []);
    }
    return 'read';
  };
  assert.equal(textBudget('', read), 'read');
  // A prefix of such a value that a control splits from its rest is still found.
  const literal = 'a'.repeat(999) + 'b';
  const split = `${'a'.repeat(1500)}\x1b[1m${'b'} ${literal}`;
  assert.deepEqual(valueSpans(split, literal).map(([a, b]) => [a, b]), [[501, 1505], [1506, 2506]]);
});

test('dense CR cleanup keeps its text with compact control maps', () => {
  const { stripEscapes, stripEscapesMapped, stripEscapesViews } = require('../lib/ci-log-text');
  for (const unit of ['\r\n', '-\r\\\r|\r/\r', 'a\r']) {
    const input = unit.repeat(Math.ceil((1 << 20) / unit.length));
    let expected = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (input.endsWith('\r')) expected = expected.slice(0, -1);
    assert.equal(stripEscapes(input), expected, JSON.stringify(unit));
    const mapped = stripEscapesMapped(input);
    assert.equal(mapped.text, expected);
    for (const v of stripEscapesViews(input)) assert.equal(v.text, expected);
  }
  assert.equal(stripEscapes('ok\r\nnext\r'), 'ok\nnext');
});

test('a character map over the work budget is rejected before its array allocation', (t) => {
  const { textBudget, textMap } = require('../lib/text-redaction-budget');
  const arrays = t.mock.method(globalThis, 'Int32Array', () => {
    throw new Error('array allocated before checking the budget');
  });
  assert.match(textBudget('', () => textMap(16 * (262144 + 1))),
    /^\[unscannable text: over \d+ redaction work units; content omitted\]$/);
  assert.equal(arrays.mock.callCount(), 0);
});

test('allocation credits pay entries once and cannot fund new or later allocations', (t) => {
  const { textBudget, textMap, textWork } = require('../lib/text-redaction-budget');
  const credit = {};
  const notice = /^\[unscannable text: over \d+ redaction work units; content omitted\]$/;
  assert.equal(textBudget('', () => {
    textMap(16 * 1024, credit);
    textWork(262144 - 1024);
    textWork(1024, credit);
    return 'kept';
  }), 'kept');
  assert.match(textBudget('', () => {
    textMap(16 * 1024, credit);
    textWork(262144 - 1024);
    textWork(1024, credit);
    textWork(1, credit);
    return 'spent twice';
  }), notice);
  assert.equal(textBudget('', () => {
    textMap(16 * 1024, credit);
    return 'unused credit';
  }), 'unused credit');
  assert.match(textBudget('', () => {
    textWork(262144);
    textWork(1, credit);
    return 'used outside its budget';
  }), notice);
  assert.match(textBudget('', () => {
    textMap(16 * 1024, credit);
    textWork(262144 - 1024);
    const arrays = t.mock.method(globalThis, 'Int32Array', function () {
      throw new Error('new capacity used bookkeeping credit before its allocation check');
    });
    try {
      return textMap(16, credit);
    } finally {
      assert.equal(arrays.mock.callCount(), 0);
      arrays.mock.restore();
    }
  }), notice);
});

test('a prefix map over the work budget is rejected before its entries are allocated', (t) => {
  const { textBudget } = require('../lib/text-redaction-budget');
  const { revealTerminal } = require('../lib/escape-views');
  const input = 'a\r';
  const entries = 16 * (262144 + input.length + 1);
  const literal = 'a' + 'z'.repeat(entries - 1);
  const ArrayType = globalThis.Int32Array;
  const arrays = t.mock.method(globalThis, 'Int32Array', function (length) {
    assert.notEqual(length, entries, 'prefix entries allocated before checking the budget');
    return new ArrayType(length);
  });
  const result = textBudget(input, () => revealTerminal(input,
    { text: 'a\n', src: (i) => i }, [literal], () => [], () => false));
  assert.match(result, /^\[unscannable text: over \d+ redaction work units; content omitted\]$/);
  assert.ok(arrays.mock.calls.every((call) => call.arguments[0] !== entries));
});

test('16 MiB CR-heavy and short ordinary logs stay below 1 GiB in fresh processes', (t) => {
  for (const unit of ['\r\n', '-\r\\\r|\r/\r', 'a\r', '123456\r\n', '\rpppppppp', '1234567\r\n', '\r\x1b[Kfetchxxxx']) {
    const script = `
const { createRedactor, redactJoined } = require(${JSON.stringify(require.resolve('../lib/gates/common'))});
const unit = ${JSON.stringify(unit)};
const text = unit.repeat(Math.ceil((16 << 20) / unit.length)).slice(0, 16 << 20);
const half = text.length / 2;
const output = redactJoined({ output: text, runs: [
  { stream: 'out', text: text.slice(0, half) },
  { stream: 'err', text: text.slice(half) },
] }, createRedactor([]));
const hash = require('node:crypto').createHash('sha256').update(output).digest('hex');
const result = { notice: output.startsWith('[unscannable text:') ? output : null, hash };
`;
    const result = redactionMemoryProbe(t, JSON.stringify(unit), script);
    if (result.notice) {
      assert.ok(['\r\n', '-\r\\\r|\r/\r', 'a\r'].includes(unit), `ordinary ${JSON.stringify(unit)} was omitted`);
      assert.match(result.notice, /^\[unscannable text: over \d+ redaction work units; content omitted\]$/);
    }
    else {
      const input = unit.repeat(Math.ceil((16 << 20) / unit.length)).slice(0, 16 << 20);
      let expected = input.replace(/\x1b\[K/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (input.endsWith('\r')) expected = expected.slice(0, -1);
      assert.equal(result.hash, crypto.createHash('sha256').update(expected).digest('hex'));
    }
  }
});
