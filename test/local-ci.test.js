'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeRepo, cachedFixture } = require('./helpers');
const { gateFixture, changeKind } = require('./gate-helpers');

// Each fixture is built once per process and copied for each test.
function fixture(t, script) {
  return cachedFixture(t, `local:${script || ''}`, (h) => build(h, script));
}

function build(h, script) {
  // No worker runs here, so the gates check a base with no origin remote,
  // the local branch; originFixture adds one.
  h.git(['remote', 'remove', 'origin']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.log = path.join(h.base, 'check.json');
  h.command = [process.execPath, 'ci.js', h.log, 'literal argument; $(exit 1)'];
  h.init(['--ci-local', JSON.stringify({ command: h.command, timeout: 5 })]);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'old\n');
  fs.writeFileSync(path.join(h.repo, 'ci.js'), script || `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
assert.equal(fs.readFileSync('head.txt', 'utf8'), 'new\\n');
assert.equal(fs.readFileSync('base.txt', 'utf8'), 'base\\n');
fs.writeFileSync(process.argv[2], JSON.stringify({
  cwd: process.cwd(), argument: process.argv[3],
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
}));
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base checker']);
  h.git(['switch', '-qc', 'local-change']);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'new\n');
  h.git(['commit', '-qam', 'head change']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  fs.writeFileSync(path.join(h.repo, 'base.txt'), 'base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances']);
  h.baseSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'local check', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'local-change', '--pr', '1']);
  h.reviewer('T1', 'reviewer', h.sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  return { log: h.log, command: h.command, sha: h.sha, baseSha: h.baseSha };
}

// A fake gh on a preload, and with origin a bare remote and a clone of it.
function mergeFixture(t, { origin = false } = {}) {
  return cachedFixture(t, `merge:${origin}`, (h) => {
    const fields = build(h);
    h.ok(['project', 'set', '--repo', 'acme/demo']);
    h.merged = path.join(h.base, 'merged');
    const preload = path.join(h.base, 'github.js');
    fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, opts) {
  if (command === 'git' && args.includes('fetch') && process.env.LOCAL_FETCH_TIMEOUT) {
    require('node:assert/strict').equal(opts.timeout, 60000);
    const error = Object.assign(new Error('fetch timed out'), {code: 'ETIMEDOUT'});
    return {status: null, signal: 'SIGTERM', stdout: '', stderr: '', error};
  }
  if (command === 'git' && process.env.LOCAL_TREE_LOG
    && args.some((arg) => arg === 'merge-tree' || arg === 'ls-tree')) {
    fs.appendFileSync(process.env.LOCAL_TREE_LOG, JSON.stringify(args) + '\\n');
  }
  if (command !== 'gh') return original(command, args, opts);
  const merged = ${JSON.stringify(h.merged)};
  if (args[0] === 'pr' && args[1] === 'merge') fs.writeFileSync(merged, '');
  return {status: 0, stderr: '', stdout: JSON.stringify({
    headRefOid: ${JSON.stringify(h.sha)}, state: fs.existsSync(merged) ? 'MERGED' : 'OPEN',
    baseRefName: ${JSON.stringify(h.json(['project', 'show']).base)}, isCrossRepository: false,
    mergeCommit: {oid: ${JSON.stringify(h.sha)}}
  })};
};
`);
    h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
    if (origin) originFixture(h);
    return { ...fields, merged: h.merged, origin: h.origin, upstream: h.upstream };
  });
}

function originFixture(h) {
  h.origin = path.join(h.base, 'origin.git');
  h.git(['init', '--bare', '-q', h.origin]);
  h.git(['remote', h.git(['remote']).split('\n').includes('origin') ? 'set-url' : 'add', 'origin', h.origin]);
  h.git(['push', 'origin', 'main']);
  h.upstream = path.join(h.base, 'upstream');
  h.git(['clone', '-q', h.origin, h.upstream]);
}

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

test('local CI receipt for an older merged tree cannot satisfy acceptance or merge', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances again']);
  const refused = h.run(['accept', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /local CI receipt.*merged tree/);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'last.txt'), 'last\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base moves after acceptance']);
  const merge = h.run(['merge', 'T1']);
  assert.equal(merge.code, 1);
  assert.match(merge.stderr, /local CI receipt.*merged tree/);
  assert.match(merge.stderr, /tower-crane check ci T1/);
  assert.doesNotMatch(merge.stderr, /tower-crane rework/);
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
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base moves after merge']);
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
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*submitted head/);
  evidence.receipt.head_sha = next;
  evidence.receipt.tree_hash = 'f'.repeat(40);
  write();
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*current merged tree/);
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
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const now = performance.now;
  let clock = 0;
  performance.now = () => (clock += 6000);
  try {
    assert.match(redact.strip('Authorization: Bearer sekrit end'),
      /^\[unscannable text: over 5000 ms redaction time; content omitted\]$/);
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
  const build = (line, size) => {
    const parts = [];
    let length = 0;
    for (let i = 0; length < size; i++) {
      const next = line(i);
      parts.push(next);
      length += next.length;
    }
    return parts.join('').slice(0, size);
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
  ];
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  for (const [name, input] of cases) {
    let expected = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (input.endsWith('\r')) expected = expected.slice(0, -1);
    assert.equal(hash(stripEscapes(input)), hash(expected), `${name} cleanup`);
    assert.equal(hash(redactJoined({ stdout: input, stderr: '' }, redact)), hash(expected), `${name} joined`);
  }
});

test('mixed 16 MiB text fails closed below 1 GiB in a fresh process', () => {
  const cp = require('node:child_process');
  const script = `
const { createRedactor, redactJoined } = require(${JSON.stringify(require.resolve('../lib/gates/common'))});
const value = 'perfSecret123456789abcdef';
const unit = 'normal line lorem125 ok\\nx\\x1b[0mAuthorization: Bearer sekrit end\\n'
  + [...value].join('\\x1b[0m') + '\\n';
const text = unit.repeat(Math.ceil((16 << 20) / unit.length)).slice(0, 16 << 20);
const runs = [{ stream: 'out', text: text.slice(0, text.length / 2) },
  { stream: 'err', text: text.slice(text.length / 2) }];
const output = redactJoined({ output: text, runs }, createRedactor([['PERF_SECRET', value]]));
console.log(JSON.stringify({ output, peakKiB: process.resourceUsage().maxRSS }));
`;
  const result = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert.match(result.output, /^\[unscannable text: .+; content omitted\]$/);
  assert.ok(result.peakKiB < 1048576, `${result.peakKiB} KiB peak`);
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

test('16 MiB CR-heavy and short ordinary logs stay below 1 GiB in fresh processes', () => {
  const cp = require('node:child_process');
  for (const unit of ['\r\n', '-\r\\\r|\r/\r', 'a\r', '123456\r\n', '\rpppppppp', '1234567\r\n']) {
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
console.log(JSON.stringify({ notice: output.startsWith('[unscannable text:') ? output : null,
  hash, peakKiB: process.resourceUsage().maxRSS }));
`;
    const result = JSON.parse(cp.execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
    if (result.notice) {
      assert.ok(['\r\n', '-\r\\\r|\r/\r', 'a\r'].includes(unit), `ordinary ${JSON.stringify(unit)} was omitted`);
      assert.match(result.notice, /^\[unscannable text: .+; content omitted\]$/);
    }
    else {
      const input = unit.repeat(Math.ceil((16 << 20) / unit.length)).slice(0, 16 << 20);
      let expected = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (input.endsWith('\r')) expected = expected.slice(0, -1);
      assert.equal(result.hash, crypto.createHash('sha256').update(expected).digest('hex'));
    }
    assert.ok(result.peakKiB < 1048576, `${JSON.stringify(unit)}: ${result.peakKiB} KiB peak`);
  }
});

test('captured GitHub CI logs keep the redaction output from before the text budget', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  // Captured logs pin the cleaned text, so the budget cannot silently drop normal output.
  const cases = [
    ['gate-scratch-etimedout.log', 'b674f8053b2eb0cd567805836a984d8a719224ae00a94fb5f92e84db3c760983'],
    ['gate-scratch-leak.log', '0334cf4e39e42c7c8c9d4f637d71de2d6228394c3d37153e7c6daf6cd696f3fb'],
    ['model-swap-timeout.log', '4ae01c709d2eab64279c403a90369d284f5dd8f0f5d2c5880fbe802ed49b42b2'],
  ];
  for (const [file, expected] of cases) {
    const output = fs.readFileSync(path.join(__dirname, 'fixtures', 'proof-logs', file), 'utf8');
    const clean = redactJoined({ output }, createRedactor([]));
    assert.equal(crypto.createHash('sha256').update(clean).digest('hex'), expected, file);
  }
});

test('local CI saves only a notice for unscannable logs and text artifacts', (t) => {
  // Each start of the value explores hundreds of escape readings, past the work its length allows.
  const h = fixture(t, `
const fs = require('node:fs');
const text = ('a\\x1b[' + '1'.repeat(1024) + 'm ').repeat(1024);
fs.writeFileSync('dense.txt', text);
process.stdout.write(text);
process.exitCode = 1;
`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 30, artifacts: ['dense.txt'] })]);
  const result = h.run(['check', 'ci', 'T1'], { env: { FIXTURE_TOKEN: 'a123456789bcdefghijk0' } });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const kept = h.readState('tasks.json').tasks[0].evidence.at(-1).local_ci;
  assert.ok(kept, result.stdout + result.stderr);
  const notice = /^\[unscannable text: .+; content omitted\]$/;
  assert.match(fs.readFileSync(path.join(h.state, kept.log), 'utf8'), notice);
  assert.match(kept.output_tail, notice);
  assert.equal(kept.artifacts.length, 1);
  assert.match(fs.readFileSync(path.join(h.state, kept.artifacts[0].path), 'utf8'), notice);
});

test('a removed control keeps the word boundary token shapes are found by', () => {
  const { stripEscapes, createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  for (const [input, expected] of [
    // Joined, the controls inside a token would hide it; split at them, a boundary would.
    [`${github.slice(0, 8)}\x1b\x7f${github.slice(8)}`, '[redacted:GITHUB_TOKEN]'],
    [`Downloading\r${github}`, 'Downloading\n[redacted:GITHUB_TOKEN]'],
    [`${aws}\rDONE`, '[redacted:AWS_ACCESS_KEY_ID]\nDONE'],
    [`x\b${github}`, 'x [redacted:GITHUB_TOKEN]'],
    [`${aws}\x00DONE`, '[redacted:AWS_ACCESS_KEY_ID] DONE'],
  ]) assert.equal(redact(stripEscapes(input)), expected, JSON.stringify(input));
  // The token stays whole for the redactor, which labels an environment value by its variable.
  const env = createRedactor([['FIXTURE_TOKEN', github], ['PLAIN_SECRET', 'abcdefghij0123456789xyz']]);
  assert.equal(env(stripEscapes(`a ${github.slice(0, 8)}\x00${github.slice(8)}`)), 'a [redacted:FIXTURE_TOKEN]');
  // A value with no token shape stays whole when the redactor cleans the text: its controls go,
  // a carriage return included.
  assert.equal(env(env.strip('pre abcdefghij\x00012345\r6789xyz post')), 'pre [redacted:PLAIN_SECRET] post');
});

test('a token that escapes take part of and split, or that a line break splits, is redacted whole', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = 'ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
  const aws = `AKIA${'E5'.repeat(8)}`;
  const env = createRedactor([['FIXTURE_TOKEN', github]]);
  const plain = createRedactor([]);
  const head = github.slice(0, 8);
  const tail = github.slice(8);
  for (const [name, input, expected] of [
    // A terminal reads ESC g as one escape, so the cleanup loses the token's first character.
    ['a stray ESC takes the first character', `a \x1b${head}\x1b[1m${tail} b`, 'a [redacted:X] b'],
    ['a word before the stray ESC', `a\x1b${head}\x1b[1m${tail}`, 'a [redacted:X]'],
    ['ESC ( takes the first character', `\x1b(${head}\x1b[1m${tail}`, '[redacted:X]'],
    ['a charset escape splits it too', `\x1b${head}\x1b(B${tail}`, '[redacted:X]'],
    ['an unterminated OSC takes the head', `\x1b]0;title ${head}\x1b[1m${tail}\nnext`, '[redacted:X]\nnext'],
    ['a newline splits the token', `key ${github.slice(0, 10)}\n${github.slice(10)} done`, 'key [redacted:X] done'],
    ['CRLF splits the token', `key ${github.slice(0, 10)}\r\n${github.slice(10)} done`, 'key [redacted:X] done'],
    // A removed line break is a word boundary: the lines around the token do not glue onto it.
    ['a word line before a token split across lines', `token is\n${github.slice(0, 14)}\n${github.slice(14)} ok`, 'token is\n[redacted:X] ok'],
    ['a split token whose tail ends its line', `key ${github.slice(0, 10)}\n${github.slice(10)}\nnext`, 'key [redacted:X]\nnext'],
    // ESC [ right before a token reads as a CSI whose final byte is the token's first letter.
    ['ESC [ takes the first character', `x \x1b[${github} y`, 'x [redacted:X] y'],
    ['ESC [ takes the first character of a split token', `x \x1b[${head}\x1b[1m${tail} y`, 'x [redacted:X] y'],
    // Kept as they were: a token that ends its line keeps the next line's first word, a header
    // value ends at its line, and an escape's final byte after a token does not change its label.
    ['a token ends its line', `token ${github}\nnext line`, 'token [redacted:X]\nnext line'],
    ['a charset reset after the token', `\x1b[31m${github}\x1b(B\x1b[m`, '[redacted:X]'],
    ['a header value ends at its line', 'Authorization: Bearer abc\nAccept: */*', 'Authorization: Bearer [redacted:AUTHORIZATION]\nAccept: */*'],
    // A line break inside a token prefix joins with two of its characters before the break or
    // three after it: `s` then a line `K-...` is no API key.
    ['a one-letter word before a line `K-`', 'run 0.3 s\nK-long_async rc 1', 'run 0.3 s\nK-long_async rc 1'],
    ['a line break after a token\'s first letter', `xx ${github[0]}\n${github.slice(1)} y`, 'xx [redacted:X] y'],
    ['a line break inside a token prefix', `xx ${github.slice(0, 2)}\r\n${github.slice(2)}\nnext`, 'xx [redacted:X]\nnext'],
  ]) {
    assert.equal(env(env.strip(input)), expected.replaceAll('[redacted:X]', '[redacted:FIXTURE_TOKEN]'), name);
    assert.equal(plain(plain.strip(input)), expected.replaceAll('[redacted:X]', '[redacted:GITHUB_TOKEN]'), name);
  }
  // A fixed-length shape keeps its word boundary when it is joined back, with a line after it too.
  assert.equal(plain(plain.strip(`token is\n${aws[0]}\n${aws.slice(1)}\nnext`)), 'token is\n[redacted:AWS_ACCESS_KEY_ID]\nnext');
  // A token whose prefix a line break splits is not put back over another secret: its joined text
  // would cut an environment value an escape splits, or a token the cleaned text shows.
  const overlap = createRedactor([['MY_SECRET', 'Wx2Zq9Xw8Vu7Ts6']]);
  assert.equal(overlap(overlap.strip(`xx g\n${github.slice(1)}Zq9\x1b=Xw8Vu7Ts6 y`)), `xx g\n${github.slice(1, -3)}[redacted:MY_SECRET] y`);
  assert.equal(plain(plain.strip('id=xox\nb-l2SorrmC\n0FhbP-gho_3uN9vAEJTHvInLGgsXGIqgB5 y')), 'id=xox\nb-l2SorrmC\n0FhbP-[redacted:GITHUB_TOKEN] y');
  // Nor over a token or header a view recovers after an escape takes its first character.
  for (const [input, secret] of [
    [`x g\n${github.slice(1, 26)}\x1bsk-proj-abcdefghijklmnop ok`, 'abcdefghijklmnop'],
    [`x g\n${github.slice(1, 26)}\x1bxoxb-1234567890-abcdef ok`, '1234567890-abcdef'],
    [`log g\n${github.slice(1, 26)}\x1bAuthorization: Bearer s3cr3tvalue123 ok`, 's3cr3tvalue123'],
    ['AS\nIAPACIFIC\x1bAUTHORIZATION: Bearer test-value', 'test-value'],
  ]) assert.ok(!plain(plain.strip(input)).includes(secret), JSON.stringify(input));
  // Nor over a token the redactor finds once the environment value glued before it is redacted.
  const glued = createRedactor([['MY_SECRET', 'AGVCLyB0UqFWaWBjHoW2KwhAm1']]);
  assert.equal(glued(glued.strip('x AGVCLyB0UqFWaWBjHoW2KwhAm1ghs_QEXOi2e7ePqMbY\x1bAx0JI5\x1bghs\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n')), 'x [redacted:MY_SECRET][redacted:GITHUB_TOKEN]\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n');
  // The same with the value split by a line break or an escape, which the cleaned text does not show whole.
  for (const split of ['\n', '\x1b(']) {
    assert.equal(glued(glued.strip(`x AGVCLyB0Uq${split}FWaWBjHoW2KwhAm1ghs_QEXOi2e7ePqMbY\x1bAx0JI5\x1bghs\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n`)), 'x [redacted:MY_SECRET] [redacted:GITHUB_TOKEN]\n_Dgm6eT6p3sOC76q8NN6NDZi2pLzL4XLEvA27RHpV\n', JSON.stringify(split));
  }
  // Two secrets put back next to each other keep one space between them.
  assert.equal(plain(plain.strip(`x g\n${github.slice(1, 26)}\x1bsk-proj-abcdefghijklmnop ok`)), 'x [redacted:GITHUB_TOKEN] [redacted:API_KEY] ok');
  // Split tokens next to each other go back apart, each from the view it was found in, so a
  // fixed-length shape does not take the next one's first character.
  assert.equal(plain(plain.strip('\n\nAK\nIA658PUUFDAL0P\n\x1b[31mR4\x1bXO\nAK\x1b[m\nIAKDXEI\rU3ZNV9O\x1bI3EQ=x')), '\n\n[redacted:AWS_ACCESS_KEY_ID] [redacted:AWS_ACCESS_KEY_ID]=x');
  // Two line breaks inside a prefix, or a blank line, join nothing.
  for (const input of [`x g\nh\np_${github.slice(4)}`, `x g\n\nhp_${github.slice(4)}`, 'run s\nk-means_clustering']) assert.equal(plain(plain.strip(input)), input);
  assert.equal(plain(plain.strip(`k=${aws.slice(0, 9)}\n${aws.slice(9)}\n`)), 'k=[redacted:AWS_ACCESS_KEY_ID]\n');
  assert.equal(plain(plain.strip(`id=${aws.slice(0, 9)}\n${aws.slice(9)}\nnext line`)), 'id=[redacted:AWS_ACCESS_KEY_ID]\nnext line');
  // An environment value is redacted however escapes and line breaks split it: here a stray ESC
  // takes one of its characters, a real two-character escape sits in it and a line break splits it.
  const value = 'Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0';
  const values = createRedactor([['MY_SECRET', value]]);
  for (const input of [
    `v=${value[0]}\x1b${value.slice(1, 4)}\n${value.slice(4)} end`,
    `v=${value[0]}\x1bM${value.slice(1, 5)}\x1b(${value.slice(5)} end`,
    `v=${value.slice(0, 3)}\x1b7${value.slice(3, 9)}\r\n\x1b[1m${value.slice(9)} end`,
  ]) assert.equal(values(values.strip(input)), 'v=[redacted:MY_SECRET] end', JSON.stringify(input));
  // A join takes a bounded run: a short prefix before many lines of token characters takes a few
  // of them, not the rest of the text.
  const lines = `sk-ab\n${'cd\n'.repeat(20000)}`;
  const joined = plain(plain.strip(lines));
  assert.ok(joined.startsWith('[redacted:API_KEY]\ncd\n'), joined.slice(0, 40));
  assert.ok(joined.split('\n').length > 19990);
});

test('a binary artifact is redacted at its exact bytes, or missed when a secret shows only in another view', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  const value = 'p\u00e4ss-\u20ac-0123456789abcdefgh';
  const redact = createRedactor([['FIXTURE_PASSWORD', value]]);
  const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
  const junk = Buffer.from([0xff, 0x00, 0xe9, 0x80, 0x1b]);
  const nul = Buffer.from([0xff, 0x00]);
  const every = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  for (const [input, expected] of [
    [bytes(junk, value, junk), bytes(junk, '[redacted:FIXTURE_PASSWORD]', junk)],
    [bytes(junk, github, junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
    [bytes(junk, '"', github, '", "', aws, '"'), bytes(junk, '"[redacted:GITHUB_TOKEN]", "[redacted:AWS_ACCESS_KEY_ID]"')],
    [bytes('Authorization: Bearer ', junk, 'x y'), bytes('Authorization: Bearer [redacted:AUTHORIZATION] y')],
    [bytes(junk, '[redacted:GITHUB_TOKEN]', junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
    // A token that ends its line, and a charset reset after a token, are redacted in place.
    [bytes(nul, github, '\nnext\n'), bytes(nul, '[redacted:GITHUB_TOKEN]\nnext\n')],
    [bytes(nul, `"${github}\x1b(B\x1b[m"`), bytes(nul, '"[redacted:GITHUB_TOKEN]\x1b(B\x1b[m"')],
    [bytes(nul, 'run 0.3 s\nK-long_async rc 1'), bytes(nul, 'run 0.3 s\nK-long_async rc 1')],
    [every, every],
  ]) {
    const out = redact.bytes(input);
    assert.equal(out.missed, undefined, input.toString('hex'));
    assert.deepEqual(out.body, expected, input.toString('hex'));
  }
  const utf16 = (text, big) => {
    const b = Buffer.from(text, 'utf16le');
    return big ? b.swap16() : b;
  };
  // Most of these show in the bytes once NULs and escapes go; a non-ASCII value needs a UTF-16 view.
  const ANY = /^a secret as /;
  for (const [name, input, view] of [
    // 0x90 and 0x98 bytes here are halves of characters, not 8-bit string introducers.
    ['an arrow before a UTF-16 token', utf16(`{"t": "\u2190 ${github}"}`), ANY],
    ['a CJK character before a UTF-16 token', utf16(`\u9019 ${github}`), ANY],
    ['a UTF-16BE token', utf16(`x ${github}`, true), ANY],
    ['a UTF-16 token at an odd offset', bytes(Buffer.from([0xff]), utf16(` ${github}`)), ANY],
    ['a color escape inside a UTF-16 token', utf16(`${github.slice(0, 8)}\x1b[32m${github.slice(8)}`), ANY],
    ['a non-ASCII environment value in UTF-16', utf16(`v=${value}`), /as UTF-16LE/],
    ['AWS key split by an escape', bytes(Buffer.from([0xff]), ` ${aws.slice(0, 8)}\x1b[1m${aws.slice(8)}\x00DONE`), ANY],
    ['a token tail after a carriage return', bytes(junk, `${github.slice(0, 26)}\r${github.slice(26)}`), ANY],
    ['a UTF-8 character with a 0x98 byte before a split token', bytes(junk, `\u662f ${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), ANY],
    ['a split environment value', bytes(junk, `${value.slice(0, 5)}\r${value.slice(5)}`), ANY],
    // Escape removal takes a character from these tokens, so only a gentle view shows them whole.
    ['a stray ESC takes a split token\'s first character', bytes(nul, `\x1b${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['ESC ( takes a split token\'s first character', bytes(nul, `\x1b(${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['a stray ESC takes the first character of a token a charset escape splits', bytes(nul, `\x1b${github.slice(0, 8)}\x1b(B${github.slice(8)}`), /gently and joined/],
    ['a word before a stray ESC that takes a split token\'s first character', bytes(nul, `x\x1b${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
    ['an unterminated OSC takes a split token\'s head', bytes(nul, `\x1b]0;t ${github.slice(0, 8)}\x1b[1m${github.slice(8)}\n`), /gently/],
    ['a token split across lines', bytes(nul, `${github.slice(0, 10)}\n${github.slice(10)}`), /line breaks removed/],
    ['a token split by CRLF', bytes(nul, `${github.slice(0, 10)}\r\n${github.slice(10)}`), /line breaks removed/],
    ['an environment value split across lines', bytes(nul, `${value.slice(0, 5)}\n${value.slice(5)}`), /inside an environment value/],
    ['an environment value split by a stray and a real escape', bytes(nul, `${value.slice(0, 1)}\x1bM${value.slice(1, 5)}\x1b(${value.slice(5)}`), /inside an environment value/],
    ['an AWS key split across lines before a word line', bytes(nul, `id=${aws.slice(0, 9)}\n${aws.slice(9)}\nnext line`), /line breaks removed/],
    ['a word line before a token split across lines', bytes(nul, `token is\n${github.slice(0, 14)}\n${github.slice(14)} ok`), /line breaks removed/],
    ['a line break inside a token prefix', bytes(nul, `xx ${github[0]}\n${github.slice(1)} y`), /line breaks removed/],
    ['ESC [ takes a split token\'s first character', bytes(nul, `x \x1b[${github.slice(0, 8)}\x1b[1m${github.slice(8)}`), /gently/],
  ]) assert.match(redact.bytes(input).missed || '', view, name);
});

test('a binary artifact is scanned without a map per byte, and as UTF-16 only when it could hold it', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = `ghp_${'d4'.repeat(18)}`;
  const redact = createRedactor([['FIXTURE_PASSWORD', 'hunter2-secret-value']]);
  const text = Buffer.from(`${'build ok\n'.repeat(1 << 16)}${github} \x1b[1mdone\n`);
  // A 64 MiB file peaked at 1.4 GiB: two 4-byte source maps per byte once a secret showed, and four
  // UTF-16 copies of a file that had no NUL byte. Arrays over a shared buffer allocate nothing.
  const big = [];
  const saved = { Int32Array, Uint16Array };
  for (const [name, Base] of Object.entries(saved)) {
    globalThis[name] = class extends Base {
      constructor(...args) {
        super(...args);
        if (!(args[0] instanceof ArrayBuffer) && this.length >= text.length / 8) big.push(`${name}(${this.length})`);
      }
    };
  }
  try {
    for (const head of [0xff, 0x00]) {
      const out = redact.bytes(Buffer.concat([Buffer.from([head]), text]));
      assert.equal(out.missed, undefined);
      assert.match(out.body.toString('latin1'), /\n\[redacted:GITHUB_TOKEN\] \x1b\[1mdone\n$/);
    }
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(big, []);
  // A value with no ASCII character has no NUL byte in UTF-16, so a non-ASCII value keeps those views.
  const value = '中文密码中文';
  const wide = Buffer.from(value, 'utf16le');
  assert.equal(wide.includes(0), false);
  assert.match(createRedactor([['FIXTURE_PASSWORD', value]]).bytes(Buffer.concat([Buffer.from([0xff]), wide])).missed || '', /as UTF-16LE from its second byte/);
  // An empty buffer has no unit from its second byte; that view threw on a negative length.
  assert.deepEqual(createRedactor([['FIXTURE_PASSWORD', value]]).bytes(Buffer.alloc(0)), { body: Buffer.alloc(0) });
});

test('dense overlapping environment values in a binary artifact merge as they are found', () => {
  const { createRedactor } = require('../lib/gates/common');
  // Both values occur at every other byte of a run of `a1`. 64 MiB of it made 67M spans, one per
  // occurrence, and ran out of memory at 7 GB. Arrays over a shared buffer allocate nothing.
  const redact = createRedactor([['SECRET_A', 'a1'.repeat(10)], ['SECRET_B', 'a1'.repeat(11)]]);
  const run = 'a1'.repeat(1 << 19);
  const big = [];
  const saved = { Int32Array, Uint32Array };
  for (const [name, Base] of Object.entries(saved)) {
    globalThis[name] = class extends Base {
      constructor(...args) {
        super(...args);
        if (!(args[0] instanceof ArrayBuffer) && this.length >= run.length / 8) big.push(`${name}(${this.length})`);
      }
    };
  }
  try {
    // The charset escape keeps its final byte in the gentle views, which then run too.
    for (const [input, expected] of [
      [`\x00${run}`, '\x00[redacted:SECRET_B]'],
      [`\x00\x1b(B${run}`, '\x00\x1b(B[redacted:SECRET_B]'],
      [`\x00${run} \x1b(B ${run}\n`, '\x00[redacted:SECRET_B] \x1b(B [redacted:SECRET_B]\n'],
    ]) {
      const out = redact.bytes(Buffer.from(input, 'latin1'));
      assert.equal(out.missed, undefined);
      assert.equal(out.body.toString('latin1'), expected);
    }
  } finally {
    Object.assign(globalThis, saved);
  }
  assert.deepEqual(big, []);
});

test('an environment value is redacted however an escape splits it, and a header an escape glues on keeps its value hidden', () => {
  const { createRedactor } = require('../lib/gates/common');
  const shows = (out, secret) => Array.from({ length: secret.length - 5 }, (_, i) => secret.slice(i, i + 6)).some((w) => out.replace(/[\x00-\x1f\x7f-\x9f]/g, '').includes(w));
  const value = 'm.SQhCuRiP7Puvr5-jZYLEMzpy';
  const env = createRedactor([['MY_SECRET', value]]);
  // A line-split token whose tail is the head of a value that a real two-character escape splits.
  const tail = createRedactor([['MY_SECRET', 'jXNogNs9XVM82r2']]);
  assert.equal(tail(tail.strip('ghp_5j63\nJyejyrqtFRVIndoXPk4KhSudBJNTpPdjXNog\x1b=Ns9XVM82r2 key')), '[redacted:GITHUB_TOKEN] [redacted:MY_SECRET] key');
  for (const input of [
    // `ESC [` reads the value's next character, or its digits and the character after, as a CSI.
    `v ${value.slice(0, 6)}\x1b[${value.slice(6)} end`,
    `v ${value.slice(0, 6)}\x1b[1;${value.slice(6)} end`,
    `v ${value.slice(0, 10)}\x1b[${value.slice(10)} end`,
    // An escape's intermediate byte is the value's own `.`, and the value goes on in an OSC body.
    `v ${value.slice(0, 1)}\x1b(${value.slice(1)} end`,
    `v ${value.slice(0, 1)}\x1b]0;t ${value.slice(1)} end`,
  ]) {
    assert.ok(!shows(env(env.strip(input)), value), JSON.stringify(input));
    assert.ok(env.bytes(Buffer.from(`\x00${input}`, 'latin1')).missed, JSON.stringify(input));
  }
  // A token that a real two-character escape and a line break both split is not copied.
  assert.match(createRedactor([]).bytes(Buffer.from('ghp_Ab3dEf\x1b(B6hIj9kLm2nO\np5qRs8tUv1wXy4zAb7d\0', 'latin1')).missed || '', /line breaks removed/);
  // A token glued to a header by an escape the cleanup removes takes the header word no more.
  const plain = createRedactor([]);
  const github = 'ghp_Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
  for (const input of [
    'z xoxa-ab\ncdefghij\x1b(B\x1b[1mAuthorization: Bearer sekrit-value',
    `z ${github}\x1b[0mAuthorization: Bearer sekrit-value`,
    `z ${github.slice(0, 9)}\r\n${github.slice(9)}\x1b7authorization: token sekrit-value`,
    // A token whole before its line break keeps its tail, glued by the escape to the header.
    `z ${github.slice(0, -1)}\n${github.slice(-1)}\x1b(BAUTHORIZATION: Basic sekrit-value`,
  ]) {
    assert.ok(!plain(plain.strip(input)).includes('sekrit'), JSON.stringify(input));
    const binary = plain.bytes(Buffer.from(`\x00${input}`, 'latin1'));
    assert.ok(binary.missed || !binary.body.toString('latin1').includes('sekrit'), JSON.stringify(input));
  }
});

test('a value found by reading its own characters as escape bytes yields to the secret next to it', () => {
  const { createRedactor } = require('../lib/gates/common');
  // The longest run of each value's characters the redacted text shows: a reading that completes
  // one value through an escape's final or a string's body once took the next value's first
  // character, or a token's, and that secret then went unredacted.
  const longest = (out, value) => {
    const flat = out.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    for (let w = value.length; w > 0; w--) for (let i = 0; i + w <= value.length; i++) if (flat.includes(value.slice(i, i + w))) return w;
    return 0;
  };
  for (const [input, values, shown] of [
    ["MXqy66Mp)n4ON[RpY;U[blM\u001b];9oS[tUd6\u001bMXqy66Mp)n4ON[RpY;U[blM9oS[tUd6", ["MXqy66Mp)n4ON[RpY;U[blM9oS[tUd6"], [22]],
    ["NUaymyOGww31eUrQ1ew9DN\u001b]NRq3j5\u001bNUaymyOGww31eUrQ1ew9DNRq3j5", ["NUaymyOGww31eUrQ1ew9DNRq3j5"], [21]],
    ["z.-5944266\u001b[1485051.5-2-..;\u001b_1\u001b;cqBv9kHeu4SduMI3)v1P9", ["z.-59442661485051.5-2-..;1",";cqBv9kHeu4SduMI3)v1P9"], [24,1]],
    ["t\u009b(1RFDj3fjaueLt\u001bPnRLsRjwB5\u001bt1RFDj3fjaueLtnRLsRjwB5", ["t1RFDj3fjaueLtnRLsRjwB5"], [12]],
    ["d.9i_2.AwBMs\u001bAPs3A5A\u001b_2d.9i_\u009c2.AwBMsAPs3A5A2", ["d.9i_2.AwBMsAPs3A5A2"], [1]],
    ["Zi\\KtUcLu9Dt!Z\u009d;y39VSNzoOvdB8\u001bZi\\KtUcLu9Dt!Zy39VSNzoOvdB8", ["Zi\\KtUcLu9Dt!Zy39VSNzoOvdB8"], [13]],
    [";TROJ-;P\u009b;\u009dlyevZK5\u001b;TROJ-;PlyevZK5", [";TROJ-;PlyevZK5"], [8]],
    ["ghs_Ts11bZC0Zq7aHV\u001bw\u001bP\u001by1WKo\n\u001b1", ["1bZC0Zq7aHVwy1WKo1"], [1]],
    ["jPvnOM.aFSqiQ\u009d;3\u001bQLXKA72OYA8@#rY3hX7B4Suwpcn9", ["jPvnOM.aFSqiQ3","QLXKA72OYA8@#rY3hX7B4Suwpcn9"], [12,1]],
    ["fVf\u009d;Kfi89wxZZwvvF7oA5\u001bfVfKfi89wxZZwv\u009bmvF7oA5", ["fVfKfi89wxZZwvvF7oA5"], [2]],
    ["byfLZlhUtC2ZZDTVFSF6GWb\u009d;47K1\u001bbyfLZlhUtC2ZZDTVFSF6GWb47K1", ["byfLZlhUtC2ZZDTVFSF6GWb47K1"], [22]],
    ["E6M0@v\u001b[onU5kWEd\u001bXLClsTi!d0\u001bdpF!GANsVQ6d92lmWHU@ec1NM#V8", ["dpF!GANsVQ6d92lmWHU@ec1NM#V8","E6M0@vonU5kWEdLClsTi!d0"], [1,6]],
    ["ASIAAXGDD9ECDI6JTPS\n7\u001b];\u001b\\AuThOrIzAtIoN:HLyexBO69t\u009b;GX73hs3OSW3github_p", ["HLyexBO69tGX73hs3OSW3"], [1]],
  ]) {
    const redact = createRedactor(values.map((v, i) => [`SECRET_${i}`, v]));
    const out = redact(redact.strip(input));
    values.forEach((v, i) => assert.ok(longest(out, v) <= shown[i], `${JSON.stringify(input)} shows ${longest(out, v)} of ${v}`));
  }
});

test('the text redactor redacts what reading escapes only as a terminal does redacts', () => {
  const { createRedactor } = require('../lib/gates/common');
  const flat = (out) => out.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  const longest = (out, value) => {
    for (let w = value.length; w > 0; w--) for (let i = 0; i + w <= value.length; i++) if (flat(out).includes(value.slice(i, i + w))) return w;
    return 0;
  };
  // A value whose characters an escape takes in one reading joins up across a line break in the
  // other: the terminal reading shows 16 of its characters, and no more may show.
  const value = 'CG8f9JH2DMB1rIfUBY8UioDg8';
  const env = createRedactor([['SECRET_0', value]]);
  const joined = env(env.strip(`github_pat_\n${value}C\n\x1bG8f9JH2DMB1rIfUBY\x1b[8UioDg8`));
  assert.ok(longest(joined, value) <= 16, joined);
  // A header value the terminal reading redacts whole keeps its tail hidden after a value found in it.
  const header = createRedactor([['SECRET_0', 'HLyexBO69tGX73hs3OSW3']]);
  const out = header(header.strip('ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p'));
  assert.ok(!flat(out).includes('github_p'), out);
  // Mapped, as the joined output of two streams reads it, the same characters stay redacted.
  const view = header.stripMapped('ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p');
  assert.equal(header(view.text), out);
  for (let i = 0; i < view.text.length; i++) {
    const [a, b] = view.at(i);
    assert.ok(a <= b && (i === 0 || view.at(i - 1)[0] <= a), `at(${i})`);
  }
});

test('mapped escape readings keep both span endpoints in order when a value is put beside a token', () => {
  const { stripEscapesViews, stripEscapesMapped } = require('../lib/ci-log-text');
  const { createRedactor } = require('../lib/gates/common');
  for (const [input, value] of [
    ['ghs_Ts11bZC0Zq7aHV\x1bw\x1bP\x1by1WKo\n\x1b1', '1bZC0Zq7aHVwy1WKo1'],
    ['ASIAAXGDD9ECDI6JTPS\n7\x1b];\x1b\\AuThOrIzAtIoN:HLyexBO69t\x9b;GX73hs3OSW3github_p', 'HLyexBO69tGX73hs3OSW3'],
    ['MXqy66Mp)n4ON[RpY;U[blM\x1b];9oS[tUd6\x1bMXqy66Mp)n4ON[RpY;U[blM9oS[tUd6', 'MXqy66Mp)n4ON[RpY;U[blM9oS[tUd6'],
    ['github_pat_defghij\x1bAuthorization:e\x9b;HLyexBO69tGX73hs3OSW3', 'HLyexBO69tGX73hs3OSW3'],
    ['xoxa-aghijrd\x1bghp_8x2\x9b1bZC0Zq7aHVwy1WKo1\x1b]0', '1bZC0Zq7aHVwy1WKo1'],
    ['\x1b]xoxa-k\x1bAuthorization:Bearer\x9b1bZC0Zq7aHVwy1WKo1', '1bZC0Zq7aHVwy1WKo1'],
  ]) {
    const redact = createRedactor([['FIXTURE_SECRET', value]]);
    const views = [...stripEscapesViews(input, [value]), stripEscapesMapped(input, [value]), redact.stripMapped(input)];
    for (const view of views) {
      let previous = [0, 0];
      for (let i = 0; i < view.text.length; i++) {
        const [a, b] = view.at(i);
        assert.ok(a >= previous[0] && b >= previous[1] && a <= b && b <= input.length,
          `${JSON.stringify(input)} at(${i}): ${previous} -> ${a},${b}`);
        previous = [a, b];
      }
      // Random access must give the same spans as ordered access.
      for (let i = view.text.length - 1; i >= 0; i--) {
        if (i > 0) assert.ok(view.at(i - 1)[1] <= view.at(i)[1]);
      }
    }
    assert.ok(!redact(redact.strip(input)).includes(value));
  }
});

test('a header value recovered across a hidden escape keeps the following lorem125 line', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const value = ';l4mPuuBezabcdefghijk';
  const redact = createRedactor([['FIXTURE_SECRET', value]]);
  for (const lineEnd of ['\n', '\r\n']) {
    const input = `AuThOrIzAtIoN: ;l4m\r\x1bPuuBezabcdefghijk${lineEnd}lorem125`;
    const expected = 'AuThOrIzAtIoN: [redacted:AUTHORIZATION]\nlorem125';
    assert.equal(redact(redact.strip(input)), expected, JSON.stringify(lineEnd));
    const at = input.indexOf('lorem125');
    assert.equal(redactJoined({ output: input, runs: [
      { stream: 'out', text: input.slice(0, at) }, { stream: 'err', text: input.slice(at) },
    ] }, redact), expected, JSON.stringify(lineEnd));
  }
});

test('common leading digits of a secret do not exhaust the work budget on a 1 MiB plain joined log', () => {
  const { createRedactor, redactJoined } = require('../lib/gates/common');
  const { valueSpans } = require('../lib/escape-views');
  const value = '012345678901234567890123456789';
  const redact = createRedactor([['THIRD_SECRET', value]]);
  const unit = 'ok 0123456789\n';
  const plain = unit.repeat(Math.ceil((1 << 20) / unit.length)).slice(0, 1 << 20);
  const result = (text) => redactJoined({ output: text, runs: [
    { stream: 'out', text: text.slice(0, text.length / 2) },
    { stream: 'err', text: text.slice(text.length / 2) },
  ] }, redact);
  assert.equal(result(plain), plain);
  for (const more of [false, true]) assert.deepEqual(valueSpans(plain, value, null, more), []);
  // Real candidates still include an exact value and one interrupted in its leading digits.
  const input = `${plain}\n${value} end\n01\x1b[0m${value.slice(2)} end\n`;
  assert.equal(result(input), `${plain}\n[redacted:THIRD_SECRET] end\n[redacted:THIRD_SECRET] end\n`);
});

test('glued headers on one long line are read once each, and a long glued header value stays redacted', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  // The value runs on past what a fixed window read, and its tail showed.
  const long = redact(redact.strip(`x\x1b[0mAuthorization: Bearer ${'a'.repeat(5000)} end`));
  assert.ok(!long.includes('aaaaaaaaa'), long.slice(0, 200));
  // Read to the line's end once per header, a line of them took minutes: the characters read for
  // the headers stay a small multiple of the line. Joined once per header, a line of headers with
  // no space between them overflowed a string.
  const { gluedHeaders } = require('../lib/escape-views');
  const { shapeMatches } = require('../lib/ci-log-text');
  const size = 4 << 20;
  for (const unit of ['w\x1b[mAuthorization: Bearer abc ', 'w\x1b(Bauthorization:', 'word\x1b[1mAuthorization:']) {
    const line = unit.repeat(Math.ceil((1 << 20) / unit.length));
    let read = 0;
    const found = gluedHeaders(line, (t) => { read += t.length; return shapeMatches(t); });
    assert.ok(found.length > 0 && read < 4 * line.length, `${JSON.stringify(unit)} read ${read} characters for ${line.length}`);
    const text = unit.repeat(Math.ceil(size / unit.length));
    assert.ok(!redact(redact.strip(text)).includes('abc'), JSON.stringify(unit));
    assert.ok(redact.bytes(Buffer.from(`\0${text}`, 'latin1')).missed, JSON.stringify(unit));
  }
});

test('a binary artifact is read across lines a window at a time', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  // A copy without line breaks and a map of every line peaked at 1.4 GiB for 64 MiB of short lines
  // after a token prefix; a window holds a few thousand of them.
  const text = Buffer.from(`\x00sk-ab\n${'cd\n'.repeat(1 << 19)}`, 'latin1');
  const big = [];
  const Saved = Int32Array;
  globalThis.Int32Array = class extends Saved {
    constructor(...args) {
      super(...args);
      if (!(args[0] instanceof ArrayBuffer) && this.length >= text.length / 8) big.push(this.length);
    }
  };
  let out;
  try {
    out = redact.bytes(text);
  } finally {
    globalThis.Int32Array = Saved;
  }
  assert.match(out.missed || '', /line breaks removed/);
  assert.deepEqual(big, []);
});

test('restoring redaction markers is linear in their count', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([['FIXTURE_TOKEN', `ghp_${'d4'.repeat(18)}`]]);
  const text = '[redacted:A] '.repeat(Math.ceil((1 << 20) / 13));
  // A split and join of the whole text per marker took minutes for these 1 MiB. Counting splits of
  // the text, at least the size it has with markers in place, shows the passes without timing them.
  const split = String.prototype.split;
  let passes = 0;
  String.prototype.split = function (...args) {
    if (this.length >= text.length / 4) passes++;
    return split.apply(this, args);
  };
  try {
    assert.equal(redact(`${text}ghp_${'d4'.repeat(18)}`), `${text}[redacted:FIXTURE_TOKEN]`);
  } finally {
    String.prototype.split = split;
  }
  assert.ok(passes <= 1, `${passes} passes`);
  const binary = Buffer.from(`\x00${text}`, 'latin1');
  assert.equal(redact.bytes(binary).body, binary);
});

test('a token prefix before 16 MiB of token characters is redacted whole in linear work', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([['FIXTURE_TOKEN', `ghp_${'d4'.repeat(18)}`]]);
  const size = 16 << 20;
  // The token shapes ran as backtracking regular expressions, which threw a RangeError (maximum
  // call stack size exceeded) from about 8 MiB of run: the gate crashed instead of redacting. The
  // NUL byte sends the text through the control cleanup's token search too.
  const cases = [
    [`ghp_${'aB3'.repeat(size / 3)}`, '[redacted:GITHUB_TOKEN]'],
    [`sk-${'ab-'.repeat(size / 3)}z`, '[redacted:API_KEY]'],
    [`Authorization: Bearer ${'Zy9'.repeat(size / 3)}`, 'Authorization: Bearer [redacted:AUTHORIZATION]'],
    [`ghp_${'aB3'.repeat(size / 3)}_tail`, '[redacted:GITHUB_TOKEN]_tail'],
  ];
  // Counting character reads shows the scans read each character a bounded number of times,
  // without timing them.
  const charCodeAt = String.prototype.charCodeAt;
  let reads = 0;
  String.prototype.charCodeAt = function (i) {
    reads++;
    return charCodeAt.call(this, i);
  };
  try {
    for (const [token, expected] of cases) {
      const input = `\x00pre ${token} post`;
      reads = 0;
      assert.equal(redact(redact.strip(input)), `pre ${expected} post`, token.slice(0, 24));
      const out = redact.bytes(Buffer.from(input, 'latin1'));
      assert.equal(out.missed, undefined, token.slice(0, 24));
      assert.equal(out.body.toString('latin1'), `\x00pre ${expected} post`, token.slice(0, 24));
      assert.ok(reads <= 16 * input.length, `${reads} character reads for ${input.length} characters`);
    }
  } finally {
    String.prototype.charCodeAt = charCodeAt;
  }
});

test('a token run glued to more word characters is redacted whole, and the word after it stays', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  const slack = `xoxb-1234567890-1234567890-${'AbCd'.repeat(6)}`;
  // Without a word boundary after the run, the shapes skipped these and left the whole secret, or,
  // for the Slack token, stopped at its last dash and left the secret part.
  for (const [input, expected] of [
    [`${github}_suffix`, '[redacted:GITHUB_TOKEN]_suffix'],
    [`${github}_${github}`, '[redacted:GITHUB_TOKEN]_ghp_d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'],
    [`${aws}abc`, '[redacted:AWS_ACCESS_KEY_ID]abc'],
    // An AWS key id is 20 characters, so a longer run keeps its tail.
    [`${aws}XYZ`, '[redacted:AWS_ACCESS_KEY_ID]XYZ'],
    [`${aws}_2`, '[redacted:AWS_ACCESS_KEY_ID]_2'],
    [`${slack}_x`, '[redacted:SLACK_TOKEN]_x'],
    [`xoxb-${'ab'.repeat(5)}_x`, '[redacted:SLACK_TOKEN]_x'],
    // Shorter than the shape's minimum, a glued run is not a token.
    [`ghp_${'a'.repeat(19)}_x`, `ghp_${'a'.repeat(19)}_x`],
  ]) {
    assert.equal(redact(`key=${input} end`), `key=${expected} end`, input);
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    assert.equal(out.missed, undefined, input);
    assert.equal(out.body.toString('latin1'), `\x00key=${expected} end`, input);
  }
  // A control inside a glued run goes, so the token is redacted whole; one at the token's end stays
  // a boundary. Without that, `ghp_ABCD\rEFGH..._x` became two lines that no shape matches. The
  // bytes cannot be redacted in place there, so the binary file is missed.
  // binary is the redacted file, or null when it is missed.
  for (const [input, expected, binary] of [
    [`ghp_${'a'.repeat(10)}\r${'b'.repeat(26)}_suffix`, '[redacted:GITHUB_TOKEN]_suffix', null],
    [`ghp_ABCD\rEFGH${'c'.repeat(32)}_x`, '[redacted:GITHUB_TOKEN]_x', null],
    [`ghp_ABCD\x00EFGH${'c'.repeat(32)}_x`, '[redacted:GITHUB_TOKEN]_x', null],
    [`${slack.slice(0, 20)}\r${slack.slice(20)}_x`, '[redacted:SLACK_TOKEN]_x', null],
    [`${aws.slice(0, 8)}\r${aws.slice(8)}XYZ`, '[redacted:AWS_ACCESS_KEY_ID]XYZ', null],
    [`${github}\x00_x`, '[redacted:GITHUB_TOKEN] _x', '[redacted:GITHUB_TOKEN]\x00_x'],
    [`${aws}\rDONE`, '[redacted:AWS_ACCESS_KEY_ID]\nDONE', '[redacted:AWS_ACCESS_KEY_ID]\rDONE'],
    [`${aws}\x00DONE`, '[redacted:AWS_ACCESS_KEY_ID] DONE', '[redacted:AWS_ACCESS_KEY_ID]\x00DONE'],
  ]) {
    assert.equal(redact(redact.strip(`key=${input} end`)), `key=${expected} end`, JSON.stringify(input));
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    if (binary === null) assert.match(out.missed || '', /^a secret as /, JSON.stringify(input));
    else assert.equal(out.body?.toString('latin1'), `\x00key=${binary} end`, JSON.stringify(input));
  }
});

// The old token expressions, safe on short inputs, as the reference for the scans.
const OLD_SHAPES = [
  ['\\bgh[pousr]_', 'A-Za-z0-9', 20, Infinity, ''],
  ['\\bgithub_pat_', 'A-Za-z0-9_', 20, Infinity, ''],
  ['\\bsk-', 'A-Za-z0-9_-', 8, Infinity, 'i'],
  ['\\b(?:AKIA|ASIA)', '0-9A-Z', 16, 16, ''],
  ['\\bxox[a-z]-', 'A-Za-z0-9-', 10, Infinity, 'i'],
].map(([lead, body, min, max, flags]) => ({
  old: new RegExp(`${lead}[${body}]{${min},${max === Infinity ? '' : max}}\\b`, `g${flags}`),
  run: new RegExp(`^${lead}[${body}]{${min},}$`, flags),
}));
const OLD_HEADER = /(\bauthorization:\s*(?:(?:bearer|basic|token)\s+)?)\S+/gi;
// A seeded generator (mulberry32), so a failure names an input that reproduces.
const seeded = (seed) => (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const wide = [0xe9, 0x17f, 0xa0, 0x2003, 0x3000, 0xfeff, 0x2028, 0x85].map((c) => String.fromCharCode(c));
const TOKEN_PIECES = ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'ghx_', 'GHP_', 'github_pat_', 'github_pat_11ABC_',
  'sk-', 'SK-', 'Sk-', 'sk-proj-', 'sk-ant-api03-', 'AKIA', 'ASIA', 'akia', 'ASIAPACIFIC', 'xoxb-', 'xoxa-', 'xoxp-',
  'xoxr-', 'XoXs-', 'XOXP-', 'xox-', 'authorization:', 'Authorization: ', 'AUTHORIZATION:', 'Authorization:\t',
  'Bearer ', 'BEARER\t', 'bearer', 'Basic ', 'Token ', 'token\t', 'a', 'B', '7', 'Z', '_', '-', ' ', '\n', '.', ':',
  '=', '"', '/', 'IOSFODNN', 'EXAMPLE7', 'AKIAIOSFODNN7EXAMPLE', 'ASIAQWERTYUIOP123456', 'aaaaaaaa',
  'A1B2C3D4E5F6G7H8', 'xyz0123456789', 'a-a-a-a-', 'Q_q_Q_', ...wide];

test('token shapes find every token the old regular expressions found', () => {
  // Strict scans find exactly the old matches. The default scans find each of them again, ending
  // where it ended unless the run is glued to a word character, and find more only for a glued run.
  const { TOKEN_SHAPES } = require('../lib/ci-log-text');
  const next = seeded(1);
  let glued = 0;
  for (let k = 0; k < 20000; k++) {
    let text = '';
    for (let i = 1 + next(14); i > 0; i--) text += TOKEN_PIECES[next(TOKEN_PIECES.length)];
    OLD_SHAPES.forEach(({ old, run }, i) => {
      const found = TOKEN_SHAPES[i].find(text);
      const isGlued = ([at, , end]) => run.test(text.slice(at, end)) && /\w/.test(text[end] ?? '');
      const before = [...text.matchAll(old)].map((m) => [m.index, m.index, m.index + m[0].length]);
      assert.deepEqual(TOKEN_SHAPES[i].find(text, 'strict'), before, `${JSON.stringify(text)} shape ${i}`);
      for (const [at, , end] of before) {
        const now = found.find(([a]) => a === at);
        assert.ok(now && (now[2] === end || (now[2] > end && isGlued(now))), `${JSON.stringify(text)} shape ${i}`);
      }
      for (const match of found) {
        if (before.some(([a, , b]) => a === match[0] && b === match[2])) continue;
        assert.ok(isGlued(match), `${JSON.stringify(text)} shape ${i} ${match}`);
        glued++;
      }
    });
    const auth = [...text.matchAll(OLD_HEADER)].map((m) => [m.index, m.index + m[1].length, m.index + m[0].length]);
    assert.deepEqual(TOKEN_SHAPES[5].find(text, 'strict'), auth, JSON.stringify(text));
  }
  assert.ok(glued > 0, 'no glued run was generated');
});

test('every shape is found in the same text, and a control before a token keeps it apart', () => {
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const key = 'AKIAIOSFODNN7EXAMPLE';
  // binary is the redacted file, or null when it is missed.
  for (const [input, expected, binary] of [
    // Replaced one shape at a time, the API key's replacement took the header word, and the header's
    // value stayed.
    ['sk-authorization: s3cr3tvalue', '[redacted:API_KEY]: [redacted:AUTHORIZATION]', '[redacted:API_KEY]: [redacted:AUTHORIZATION]'],
    [`AUTHORIZATION:${key}xoxp-AUTHORIZATION:xoxp-Token`, 'AUTHORIZATION:[redacted:AUTHORIZATION]', 'AUTHORIZATION:[redacted:AUTHORIZATION]'],
    // A header right after a glued AWS key, and a header as another header's value.
    [`${key}AUTHORIZATION: Bearer s3cr3tvalue`, '[redacted:AWS_ACCESS_KEY_ID]AUTHORIZATION: Bearer [redacted:AUTHORIZATION]', '[redacted:AWS_ACCESS_KEY_ID]AUTHORIZATION: Bearer [redacted:AUTHORIZATION]'],
    ['Authorization: Authorization: s3cr3tvalue', 'Authorization: [redacted:AUTHORIZATION] [redacted:AUTHORIZATION]', 'Authorization: [redacted:AUTHORIZATION] [redacted:AUTHORIZATION]'],
    // Joined across the carriage return, the AWS shape took the header, or a Slack run hid the key
    // after it.
    ['Region ASIAPACIFIC\rAUTHORIZATION: Bearer s3cr3tvalue', 'Region ASIAPACIFIC\nAUTHORIZATION: Bearer [redacted:AUTHORIZATION]', null],
    [`xoxb-ASIAQWERTYUIOP123456a\r${key}_x`, '[redacted:SLACK_TOKEN]\n[redacted:AWS_ACCESS_KEY_ID]_x', null],
  ]) {
    assert.equal(redact(redact.strip(`key=${input} end`)), `key=${expected} end`, JSON.stringify(input));
    const out = redact.bytes(Buffer.from(`\x00key=${input} end`, 'latin1'));
    if (binary === null) assert.match(out.missed || '', /^a secret as /, JSON.stringify(input));
    else assert.equal(out.body?.toString('latin1'), `\x00key=${binary} end`, JSON.stringify(input));
  }
});

test('no token the old expressions find in any reading of the input survives redaction', () => {
  // Random lines of token prefixes, headers, word pieces, escapes and controls. Every token or
  // header value of 8 or more characters that the old expressions find in the text with its
  // escapes removed and its controls removed, made newlines or made spaces, or in the cleaned text,
  // must be gone from the redacted text: it may show there only as often as some reading has it
  // outside the tokens found, since the same characters can be a token in one reading and plain
  // text in another. A header word given as another header's value is a header, also when an escape
  // took its first letter (`\x1bAUTHORIZATION:`).
  // A binary copy must hold none found in its bytes.
  const { createRedactor } = require('../lib/gates/common');
  const redact = createRedactor([]);
  const pieces = [...TOKEN_PIECES, '\r', '\v', '\f', '\x00', '\x7f', '\x08', '\x1b', '\x1b[31m', '\x1b[0m', '\x9b'];
  const escapes = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;
  const controls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
  // Each secret found once per position, as `position:secret`.
  const secrets = (view) => {
    const out = OLD_SHAPES.flatMap(({ old }) => [...view.matchAll(old)].map((m) => `${m.index}:${m[0]}`));
    for (const m of view.matchAll(OLD_HEADER)) {
      const value = m[0].slice(m[1].length);
      if (!'authorization:'.endsWith(value.toLowerCase())) out.push(`${m.index + m[1].length}:${value}`);
    }
    return [...new Set(out)].map((s) => s.slice(s.indexOf(':') + 1)).filter((s) => s.length >= 8);
  };
  const count = (text, part) => text.split(part).length - 1;
  const gone = (views, out, what) => {
    const found = views.map(secrets);
    for (const secret of new Set(found.flat())) {
      const kept = Math.max(...views.map((view, i) => count(view, secret) - found[i].filter((s) => s === secret).length));
      assert.ok(count(out, secret) <= kept, `${what} ${JSON.stringify(secret)}`);
    }
  };
  const next = seeded(7);
  for (let k = 0; k < 20000; k++) {
    let text = '';
    for (let i = 1 + next(20); i > 0; i--) text += pieces[next(pieces.length)];
    const cleaned = redact.strip(text);
    const out = redact(cleaned);
    const bare = text.replace(escapes, '');
    gone([cleaned, bare.replace(controls, ''), bare.replace(controls, '\n'), bare.replace(controls, ' ')], out, `${JSON.stringify(text)} kept`);
    const bytes = Buffer.from(text, 'latin1');
    const copy = redact.bytes(bytes);
    if (copy.missed) continue;
    const raw = bytes.toString('latin1');
    gone([raw], copy.body.toString('latin1'), `${JSON.stringify(text)} copied`);
  }
});

test('a passing local CI keeps its log without a tail or artifacts', (t) => {
  const h = fixture(t);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 5, artifacts: ['*.js'] })]);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.ok, true);
  assert.equal(e.local_ci.output_tail, undefined);
  assert.deepEqual(e.local_ci.artifacts, []);
  assert.ok(fs.existsSync(path.join(h.state, e.local_ci.log)));
  assert.ok(!fs.existsSync(path.join(h.state, 'ci-artifacts')));
});

test('local CI joins stdout and stderr by whole lines, so a stderr line cannot split a secret', (t) => {
  // Like a Python or cargo step writing to pipes: stdout flushes a block that ends inside a token,
  // stderr reports the failure before the rest of that line arrives, and both end without a newline.
  const h = fixture(t, `
const fs = require('node:fs');
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // wait-allow: the gate must read each write before the other stream writes, the condition under test
const token = process.env.CI_FIXTURE_TOKEN;
fs.writeSync(1, 'line 1\\nline 2\\ntoken ' + token.slice(0, 12));
pause();
fs.writeSync(2, '! FAILING STEP: unit tests\\n');
pause();
fs.writeSync(1, token.slice(12) + ' end\\nline 3\\n');
fs.writeSync(1, 'unfinished out');
fs.writeSync(2, 'unfinished err');
process.exit(1);
`);
  const token = 'ghp_T361Head' + 'T361TailBody01234567';
  h.env.CI_FIXTURE_TOKEN = token;
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  const log = fs.readFileSync(path.join(h.state, e.local_ci.log), 'utf8');
  for (const text of [log, e.local_ci.output_tail]) {
    assert.match(text, /^token \[redacted:CI_FIXTURE_TOKEN\] end$/m, text);
    assert.match(text, /^! FAILING STEP: unit tests$/m, text);
    assert.match(text, /^unfinished out$/m, text);
    assert.match(text, /^unfinished err$/m, text);
    // Each line of one stream keeps its place; the stderr line comes where its newline arrived.
    const at = ['line 2', '! FAILING STEP', 'token [redacted', 'line 3'].map((s) => text.indexOf(s));
    assert.deepEqual([...at].sort((a, b) => a - b), at, text);
  }
  const stored = [log, r.stdout, r.stderr, JSON.stringify(e), fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8')].join('\n');
  assert.ok(!stored.includes('T361Head'), 'the first half of the token leaked');
  assert.ok(!stored.includes('T361TailBody'), 'the second half of the token leaked');
});

test('local CI keeps the newest five runs of a task and leaves other tasks\' runs', (t) => {
  const h = fixture(t);
  const logs = path.join(h.state, 'logs');
  const store = path.join(h.state, 'ci-artifacts');
  const old = Date.now() / 1000 - 3600;
  for (const name of [...Array.from({ length: 6 }, (_, i) => `ci-T1-0123456789-old${i}`), 'ci-T12-0123456789-other']) {
    for (const dir of [logs, store]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'output.log'), name);
    }
    // old0 is the oldest; each later one is a minute newer.
    const at = old + Number(/old(\d)$/.exec(name)?.[1] ?? 0) * 60;
    fs.utimesSync(path.join(logs, name), at, at);
  }
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.ok, true);
  const run = path.basename(path.dirname(e.local_ci.log));
  const left = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('ci-T1-')).sort();
  assert.deepEqual(left(logs), [run, 'ci-T1-0123456789-old2', 'ci-T1-0123456789-old3', 'ci-T1-0123456789-old4', 'ci-T1-0123456789-old5'].sort());
  assert.deepEqual(left(store), ['ci-T1-0123456789-old2', 'ci-T1-0123456789-old3', 'ci-T1-0123456789-old4', 'ci-T1-0123456789-old5']);
  for (const dir of [logs, store]) assert.ok(fs.existsSync(path.join(dir, 'ci-T12-0123456789-other')));
});

test('conflicting merged trees fail before running the local command', (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'conflict\n');
  h.git(['commit', '-qam', 'base conflicts']);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /merge|conflict/);
  assert.ok(!fs.existsSync(h.log));
});

test('changed local CI policy invalidates its earlier receipt', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: h.command, timeout: 10 })]);
  assert.match(h.run(['accept', 'T1']).stderr, /configured command or timeout/);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [...h.command, 'extra'], timeout: 10 })]);
  assert.match(h.run(['accept', 'T1']).stderr, /configured command or timeout/);
  h.ok(['project', 'set', '--ci-local', 'null']);
  assert.equal(h.run(['accept', 'T1']).code, 1);
});

test('local CI selects kind args, replacement commands and the default with audited variants', (t) => {
  const h = fixture(t, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  const local = {
    command: h.command, timeout: 5,
    by_kind: {
      docs: { args: ['--native-extended', '', 'literal; $(exit 1)'] },
      ops: { command: [process.execPath, 'ci.js', h.log, '--lab'], timeout: 10 },
    },
  };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  for (const [kind, variant, command, timeout] of [
    ['docs', 'kind:docs', [...h.command, ...local.by_kind.docs.args], 5],
    ['ops', 'kind:ops', local.by_kind.ops.command, 10],
    ['research', 'default', h.command, 5],
  ]) {
    const before = h.json(['task', 'show', 'T1']);
    changeKind(h, kind);
    const reworked = h.json(['task', 'show', 'T1']);
    assert.equal(reworked.revision, before.revision + 1);
    assert.equal(reworked.gates.gates.find(g => g.type === 'review').ok, false);
    assert.deepEqual(reworked.evidence, before.evidence);
    h.reviewer('T1', 'reviewer', h.sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--revision', h.revision('T1'), '--agent', 'reviewer']);
    const e = h.json(['check', 'ci', 'T1']);
    assert.equal(e.revision, reworked.revision);
    assert.equal(e.receipt.variant, variant);
    assert.deepEqual(e.receipt.command, command);
    assert.equal(e.receipt.timeout, timeout);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.log, 'utf8')), command.slice(3));
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.findLast((v) => v.cmd === 'check ci').detail.receipt, e.receipt);
    const gates = h.json(['task', 'show', 'T1']).gates;
    assert.equal(gates.gates.find(g => g.type === 'ci').ok, true);
    assert.equal(gates.ok, kind !== 'research');
    if (kind === 'research') assert.equal(gates.gates.find(g => g.type === 'sources').ok, false);
  }
});

test('changing kind, which can select a different local CI variant, is the orchestrator\'s or the owner\'s', (t) => {
  const h = fixture(t);
  const local = {
    command: h.command, timeout: 5,
    by_kind: { docs: { args: ['--lab'] }, ops: { args: ['--s3'] } },
  };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  // A submitted task refuses any kind change, so the kind moves while it waits for rework.
  h.ok(['rework', 'T1', '--reason', 'retier the local check', '--agent', 'owner']);
  const tasks = h.readState('tasks.json');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const denied = h.run(['task', 'update', 'T1', '--kind', 'ops', '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /only the orchestrator or the owner/);
  assert.deepEqual(h.readState('tasks.json'), tasks);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);

  const override = { args: ['--custom'] };
  h.ok(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  const allowed = h.run(['task', 'update', 'T1', '--kind', 'ops', '--agent', 'orchestrator']);
  assert.equal(allowed.code, 0, allowed.stderr);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha]);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'task:T1');
  assert.deepEqual(e.receipt.command, [...h.command, ...override.args]);
});

test('owner task override takes precedence and clearing restores the kind variant', (t) => {
  const h = fixture(t);
  const local = { command: h.command, timeout: 5, by_kind: { docs: { args: ['--lab'] } } };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  h.ok(['check', 'ci', 'T1']);
  const override = { args: ['--s3'] };
  const updated = h.json(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  assert.deepEqual(updated.ci_local, override);
  assert.match(h.ok(['task', 'show', 'T1']), /ci\.local override:/);
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*variant/);
  let e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'task:T1');
  assert.deepEqual(e.receipt.command, [...h.command, '--s3']);
  assert.equal(e.receipt.timeout, 5);

  local.by_kind.docs = { args: ['--native-extended'] };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true, 'unselected kind policy does not invalidate the override');
  const replacement = { command: [...h.command, '--lab'], timeout: 10 };
  h.ok(['task', 'update', 'T1', '--ci-local', JSON.stringify(replacement)]);
  assert.match(h.run(['accept', 'T1']).stderr, /configured command or timeout/);
  e = h.json(['check', 'ci', 'T1']);
  assert.deepEqual(e.receipt.command, replacement.command);
  assert.equal(e.receipt.timeout, 10);

  const cleared = h.json(['task', 'update', 'T1', '--ci-local', 'null']);
  assert.ok(!Object.hasOwn(cleared, 'ci_local'));
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*variant/);
  e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.variant, 'kind:docs');
  assert.deepEqual(e.receipt.command, [...h.command, '--native-extended']);
  h.ok(['accept', 'T1']);
  const refused = h.run(['task', 'update', 'T1', '--ci-local', JSON.stringify(override)]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /accepted.*local CI override/);
});

test('kind variants with identical argv cannot reuse receipts or merge under a different variant', (t) => {
  const h = mergeFixture(t);
  const local = { command: h.command, timeout: 5, by_kind: { docs: { args: [] }, ops: { args: [] } } };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  const previousCI = h.json(['check', 'ci', 'T1']);
  changeKind(h, 'ops');
  const reworked = h.json(['task', 'show', 'T1']);
  assert.equal(reworked.revision, previousCI.revision + 1);
  assert.equal(reworked.gates.gates.find(g => g.type === 'ci').ok, false);
  assert.deepEqual({ task: reworked.id, ...reworked.evidence.find(e => e.type === 'ci') }, previousCI);
  h.reviewer('T1', 'reviewer', h.sha);
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--revision', h.revision('T1'), '--agent', 'reviewer']);
  h.ok(['check', 'ci', 'T1']);
  delete local.by_kind.ops;
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*variant/);
  local.by_kind.ops = { args: [] };
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  h.ok(['accept', 'T1']);
  delete local.by_kind.ops;
  h.ok(['project', 'set', '--ci-local', JSON.stringify(local)]);
  const refused = h.run(['merge', 'T1']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /receipt.*variant/);
  assert.ok(!fs.existsSync(h.merged), 'GitHub merge never ran');
  h.ok(['check', 'ci', 'T1']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
});

test('local CI variant settings validate atomically and task overrides require explicit owner identity', (t) => {
  const h = fixture(t);
  const project = h.readState('project.json');
  const tasks = h.readState('tasks.json');
  const audit = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const invalid = [null, [], {}, { args: 'x' }, { args: [2] }, { args: ['\0'] },
    { command: [] }, { command: [' '] }, { command: ['node', '\0'] },
    { command: ['node'], args: [] }, { args: [], timeout: 0 },
    { args: [], timeout: 2147483648 }, { args: [], typo: true }];
  for (const by_kind of [null, [], { tooling: { args: [] } }, ...invalid.map((v) => ({ docs: v }))]) {
    const r = h.run(['project', 'set', '--name', 'changed', '--ci-local', JSON.stringify({ command: h.command, timeout: 5, by_kind })]);
    assert.equal(r.code, 2, JSON.stringify(by_kind));
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('project.json'), project);
  }
  for (const override of ['{', ...invalid.filter((v) => v !== null).map((v) => JSON.stringify(v))]) {
    const r = h.run(['task', 'update', 'T1', '--title', 'changed', '--ci-local', override]);
    assert.equal(r.code, 2, override);
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('tasks.json'), tasks);
  }
  for (const value of ['{"args":["--s3"]}', 'null']) {
    for (const identity of [
      { flags: ['--agent', 'worker'], env: {}, code: 1, pattern: /only the orchestrator or the owner/ },
      { flags: [], env: { TOWER_CRANE_AGENT: '' }, code: 2, pattern: /no agent/ },
    ]) {
      const r = h.run(['task', 'update', 'T1', '--ci-local', value, ...identity.flags], { env: identity.env });
      assert.equal(r.code, identity.code);
      assert.match(r.stderr, identity.pattern);
      assert.deepEqual(h.readState('tasks.json'), tasks);
    }
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), audit);
  assert.match(h.ok(['task', 'update', '--help']), /--ci-local JSON/);
});

test('malformed task override fails local CI closed before command execution', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.rmSync(h.log);
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].ci_local = { args: 'invalid' };
  h.writeState('tasks.json', tasks);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /invalid.*override/);
  assert.ok(!fs.existsSync(h.log));
});

test('local CI runs on a clean checkout of the merge, so a clean-tree check passes', (t) => {
  // Shaped like ginza's tools/check.py working_tree_clean.
  const h = fixture(t, `
const cp = require('node:child_process');
cp.execFileSync('git', ['diff', '--quiet', 'HEAD']);
cp.execFileSync('git', ['diff', '--cached', '--quiet']);
if (cp.execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}) !== '') process.exit(3);
`);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.receipt.head_sha, h.sha);
  // The same base and head give the same merge commit.
  assert.equal(h.json(['check', 'ci', 'T1', '--agent', 'checker']).receipt.merge_sha, e.receipt.merge_sha);
});

test('a signed base under log.showSignature still gives the merge commit its time', (t) => {
  const h = fixture(t);
  h.git(['config', 'log.showSignature', 'true']);
  // A signature header is enough: git reports its verification before the commit's own fields.
  const body = `tree ${h.git(['rev-parse', 'main^{tree}'])}\nparent ${h.baseSha}\n`
    + 'author a <a@example.com> 1700000000 +0000\ncommitter a <a@example.com> 1700000000 +0000\n'
    + 'gpgsig -----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----\n\nsigned base\n';
  const signed = require('node:child_process').execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
    { cwd: h.repo, env: h.env, input: body, encoding: 'utf8' }).trim();
  h.git(['update-ref', 'refs/heads/main', signed]);
  assert.match(h.git(['show', '-s', '--format=%ct', signed]), /signature/i, 'the fixture shows a signature line');
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.equal(e.receipt.base_sha, signed);
});

test('the merge reads .gitattributes from the head, so its merge drivers apply', (t) => {
  const h = fixture(t);
  h.git(['switch', '-q', 'local-change']);
  fs.writeFileSync(path.join(h.repo, '.gitattributes'), 'notes.txt merge=union\n');
  fs.writeFileSync(path.join(h.repo, 'notes.txt'), 'head\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'head notes']);
  const head = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  fs.writeFileSync(path.join(h.repo, 'notes.txt'), 'base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base notes']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', head]);
  const e = h.json(['check', 'ci', 'T1', '--agent', 'checker']);
  assert.equal(e.ok, true, e.summary);
  assert.deepEqual(h.git(['show', `${e.receipt.tree_hash}:notes.txt`]).split('\n').sort(), ['base', 'head']);
});

test('tracked changes made by a successful local check cannot pass', (t) => {
  const h = fixture(t, "require('node:fs').writeFileSync('head.txt', 'changed\\n');\n");
  const r = h.run(['check', 'ci', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed tracked sources/);
  const e = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(e.receipt.exit, 0);
  assert.equal(e.ok, false);
});

test('a newer fetched base invalidates a local receipt while preserving the local branch', (t) => {
  const h = fixture(t);
  h.ok(['check', 'ci', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'remote.txt'), 'remote\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'remote base advances']);
  const remote = h.git(['rev-parse', 'HEAD']);
  h.git(['update-ref', 'refs/remotes/origin/main', remote]);
  h.git(['reset', '--hard', h.baseSha]);
  assert.match(h.run(['accept', 'T1']).stderr, /current merged tree/);
  const e = h.json(['check', 'ci', 'T1']);
  assert.equal(e.receipt.base_sha, remote);
  assert.equal(h.git(['rev-parse', 'main']), h.baseSha);
  h.ok(['accept', 'T1']);
});

test('project settings validate local argv and timeout, preserve CI siblings and allow clearing', (t) => {
  const h = makeRepo(t);
  h.init(['--ci-ignore-apps', '["claude"]']);
  const original = h.readState('project.json');
  for (const local of ['{', '[]', '{}', '{"command":[],"timeout":1}', '{"command":[""],"timeout":1}',
    '{"command":["node",2],"timeout":1}', '{"command":["node"]}', '{"command":["node"],"timeout":0}',
    '{"command":["node"],"timeout":"1"}', '{"command":["node"],"timeout":1,"artifacts":["/abs/*.json"]}',
    '{"command":["node"],"timeout":1,"artifacts":["../up/*.json"]}', '{"command":["node"],"timeout":1,"artifacts":".local"}',
    '{"command":["node"],"timeout":1,"artifact_pattern":"("}', '{"command":["node"],"timeout":1,"artifact_pattern":""}']) {
    const r = h.run(['project', 'set', '--ci-local', local]);
    assert.equal(r.code, 2, JSON.stringify({ local, ...r }));
    assert.match(r.stderr, /--ci-local/);
    assert.deepEqual(h.readState('project.json'), original);
  }
  const local = { command: ['python3', 'tools/check.py', ''], timeout: 120 };
  const set = h.json(['project', 'set', '--ci-local', JSON.stringify(local)]);
  assert.deepEqual(set.ci, { ignore_apps: ['claude'], local });
  assert.match(h.ok(['project', 'show']), /ci\.local:/);
  const cleared = h.json(['project', 'set', '--ci-local', 'null']);
  assert.deepEqual(cleared, original);
  assert.match(h.ok(['project', 'set', '--help']), /--ci-local JSON/);
});
