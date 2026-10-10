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
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
  h.git(['remote', 'add', 'origin', h.origin]);
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
  assert.equal(trace.head, h.sha);
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
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
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
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
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
  h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', next, '--agent', 'reviewer']);
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
    h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: command || h.command, timeout })]);
    const r = h.run(['check', 'ci', 'T1']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, pattern);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false);
    assert.equal(h.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
    assert.deepEqual(fs.readdirSync(h.env.TOWER_CRANE_TMP), []);
  }
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
    changeKind(h, kind);
    const e = h.json(['check', 'ci', 'T1']);
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
  h.ok(['check', 'ci', 'T1']);
  changeKind(h, 'ops');
  assert.match(h.run(['accept', 'T1']).stderr, /receipt.*variant/);
  h.ok(['check', 'ci', 'T1']);
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
    '{"command":["node"],"timeout":"1"}']) {
    const r = h.run(['project', 'set', '--ci-local', local]);
    assert.equal(r.code, 2);
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
