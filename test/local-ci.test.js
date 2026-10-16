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
for (let i = 0; i < 150; i++) console.log('cargo tree line ' + i);
fs.mkdirSync('.local/checks', { recursive: true });
// Like ginza's receipt, which holds every step's full output, including what the log redacts.
fs.writeFileSync('.local/checks/receipt.json', JSON.stringify({ failure_reasons: ['unit tests failed'], output: 'token ' + token }));
fs.writeFileSync('.local/checks/extra.json', '{}');
// A colored receipt: the escape inside the token would hide it from the patterns.
fs.writeFileSync('.local/checks/colored.json', '{"output": "\\x1b[32m' + token.slice(0, 4) + '\\x1b[1m' + token.slice(4) + '\\x1b[0m"}');
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
  assert.match(log, /^stderr token \[redacted:/m);
  assert.match(log, /^unterminated \nafter the unterminated escape\ntitle set\nDownloading\n\[redacted:GITHUB_TOKEN\]$/m);
  assert.ok(!log.includes('ghp_d4'), log);
  assert.ok(!log.includes(token));
  assert.ok(r.stdout.includes(`Full log: ${path.join(h.state, kept.log)}`), r.stdout);
  assert.ok(!r.stdout.includes(token));
  // Printed paths come first, then the globs; a file outside the gate directory is left in place.
  // Artifacts sit in ci-artifacts/, which every agent sandbox hides, beside the run's log name.
  const run = path.basename(path.dirname(kept.log));
  const copied = Object.fromEntries(kept.artifacts.map((a) => [path.basename(a.from), a]));
  assert.deepEqual(Object.keys(copied).sort(), ['blob.json', 'colored.json', 'extra.json', 'latin1.json', 'receipt.json', 'report.txt']);
  for (const a of kept.artifacts) assert.ok(a.path.startsWith(`ci-artifacts/${run}/`), a.path);
  // Text artifacts get the log's redaction; a binary one is redacted at the byte level.
  const receipt = fs.readFileSync(path.join(h.state, copied['receipt.json'].path), 'utf8');
  assert.ok(!receipt.includes(token));
  assert.deepEqual(JSON.parse(receipt), { failure_reasons: ['unit tests failed'], output: 'token [redacted:CI_FIXTURE_TOKEN]' });
  assert.equal(copied['receipt.json'].redacted, true);
  assert.equal(copied['receipt.json'].bytes, Buffer.byteLength(receipt));
  assert.equal(fs.readFileSync(path.join(h.state, copied['colored.json'].path), 'utf8'), '{"output": "[redacted:CI_FIXTURE_TOKEN]"}');
  assert.equal(copied['colored.json'].redacted, true);
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
  assert.deepEqual(kept.artifacts_skipped.map((s) => path.basename(s.from)), ['outside.json', 'utf16.json']);
  assert.match(kept.artifacts_skipped[0].reason, /outside the gate worktree/);
  assert.match(kept.artifacts_skipped[1].reason, /^binary, and a secret as .+ that exact byte redaction cannot remove$/);
  // The summary reaches worker prompts, so it counts the artifacts and names none.
  assert.match(r.stdout, /Artifacts: 6 kept for the orchestrator and the owner/);
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

test('a binary artifact is redacted at its exact bytes, or missed when a secret shows only in another view', () => {
  const { createRedactor } = require('../lib/gates/common');
  const github = `ghp_${'d4'.repeat(18)}`;
  const aws = `AKIA${'E5'.repeat(8)}`;
  const value = 'p\u00e4ss-\u20ac-0123456789abcdefgh';
  const redact = createRedactor([['FIXTURE_PASSWORD', value]]);
  const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
  const junk = Buffer.from([0xff, 0x00, 0xe9, 0x80, 0x1b]);
  const every = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  for (const [input, expected] of [
    [bytes(junk, value, junk), bytes(junk, '[redacted:FIXTURE_PASSWORD]', junk)],
    [bytes(junk, github, junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
    [bytes(junk, '"', github, '", "', aws, '"'), bytes(junk, '"[redacted:GITHUB_TOKEN]", "[redacted:AWS_ACCESS_KEY_ID]"')],
    [bytes('Authorization: Bearer ', junk, 'x y'), bytes('Authorization: Bearer [redacted:AUTHORIZATION] y')],
    [bytes(junk, '[redacted:GITHUB_TOKEN]', junk), bytes(junk, '[redacted:GITHUB_TOKEN]', junk)],
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
