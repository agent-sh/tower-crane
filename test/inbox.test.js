'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRepo, cachedFixture } = require('./helpers');
const { gateFixture } = require('./gate-helpers');
const { shellQuote } = require('../lib/gates/common');

function setup(t) {
  const h = cachedFixture(t, 'inbox', (seed) => {
    const sha = gateFixture(seed);
    seed.init(['--repo', 'acme/demo', '--base', 'main', '--workers', '8']);
    // gateFixture's Windows adapter also routes this replacement script.
    fs.writeFileSync(path.join(seed.base, 'tools', 'gh'),
      `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures', 'inbox-gh.js'))});\n`);
    seed.env.INBOX_GITHUB = path.join(seed.base, 'github.json');
    fs.writeFileSync(seed.env.INBOX_GITHUB, JSON.stringify({
      calls: [], prs: Object.fromEntries([7, 8, 9].map((n) => [n, {
        state: 'OPEN', headRefOid: sha, headRefName: 'fixture-change', baseRefName: 'main',
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', url: `https://github.com/acme/demo/pull/${n}`,
      }])),
    }));
    return { sha };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.INBOX_GITHUB, 'utf8'));
  h.save = (data) => fs.writeFileSync(h.env.INBOX_GITHUB, JSON.stringify(data));
  h.add = (title, kind = 'docs') => {
    const task = h.json(['task', 'add', '--title', title, '--kind', kind, '--acceptance', 'works']);
    h.ok(['brief', 'set', task.id, '-'], { input: `${title}\n` });
    return task.id;
  };
  h.submit = (id, pr) => {
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', h.sha, ...(pr ? ['--pr', String(pr)] : []), '--agent', `worker-${id}`]);
  };
  h.inbox = () => h.json(['inbox', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

// Lifecycle fixtures represent processes that exited before the observer
// starts. All task transitions and the resolving actions use the real CLI.
function event(h, task, cmd, detail, agent = 'orchestrator') {
  const e = { id: `fixture-${h.logs().length}`, at: new Date().toISOString(), cmd, agent, task, detail };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
}

test('one fixture exposes every inbox kind and resolving commands clear their conditions', async (t) => {
  const h = setup(t);
  const review = h.add('Failed review');
  h.submit(review);
  h.reviewer(review, 'reviewer', h.sha);
  h.ok(['evidence', review, '--type', 'review', '--fail', '--sha', h.sha,
    '--summary', 'Check null before dereferencing.', '--ref', 'https://github.com/acme/demo/pull/1#issuecomment-1', '--agent', 'reviewer']);
  const rework = h.add('Rework without a worker');
  h.submit(rework);
  h.ok(['rework', rework, '--reason', 'base conflict in parser.js']);
  const dead = h.add('Dead claim');
  h.ok(['claim', dead, '--agent', 'gone']);
  event(h, dead, 'spawn', { agent: 'gone', role: 'worker', pid: 2147483647, host: os.hostname() });
  const accepted = h.add('Accepted but not merged');
  h.submit(accepted, 7);
  h.reviewer(accepted, 'reviewer', h.sha);
  h.ok(['evidence', accepted, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', accepted]);
  h.ok(['accept', accepted]);
  const revuto = h.add('Revuto finding');
  h.submit(revuto, 8);
  const codeql = h.add('CodeQL finding');
  h.submit(codeql, 9);
  const stall = h.add('Stalled worker');
  h.ok(['claim', stall, '--agent', 'stalled']);
  const claim = h.json(['task', 'show', stall]).claim;
  event(h, stall, 'stall', { agent: 'stalled', until: claim.until, progress_at: claim.since });
  h.ok(['ask', '--question', 'Which API?', '--option', 'A', '--option', 'B', '--blocks', stall]);
  h.ok(['msg', '--to', 'orchestrator', '--task', stall, 'Need API guidance', '--agent', 'messenger']);
  event(h, accepted, 'automation', { phase: 'running', pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  const github = h.github();
  github.review_comments = { 1: [{ id: 1, html_url: 'https://github.com/acme/demo/pull/1#issuecomment-1',
    body: `Review (Tower Crane, clean context)\n\nBlocking: 1 finding at ${h.sha}.\n\n- lib/value.js:1 - Check null before dereferencing. - Avoid the crash.\n` }] };
  github.revuto = { name: 'revuto', app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Fix bounds' } };
  github.comments = [
    { commit_id: h.sha, user: { login: 'revuto-review[bot]' }, body: 'Check index bounds', path: 'parse.js', line: 8, html_url: 'https://github.com/acme/demo/pull/8#discussion_r8' },
    { commit_id: 'f'.repeat(40), user: { login: 'revuto-review[bot]' }, body: 'stale finding' },
  ];
  github.alerts = { 9: [{ tool: { name: 'CodeQL' }, rule: { id: 'js/injection' }, html_url: 'https://github.com/acme/demo/security/code-scanning/1',
    most_recent_instance: { commit_sha: h.sha, message: { text: 'Untrusted input' }, location: { path: 'query.js', start_line: 3 } } }] };
  h.save(github);
  const inbox = h.inbox();
  const kinds = new Set(inbox.items.map((i) => i.kind));
  for (const kind of ['review_failed', 'rework_ready', 'dead_claim', 'decision', 'accepted_unmerged', 'revuto_failed', 'codeql_alert', 'message', 'stall']) {
    assert.ok(kinds.has(kind), `missing ${kind}: ${JSON.stringify(inbox)}`);
  }
  assert.equal(inbox.executors.length, 1);
  const executable = process.platform === 'win32' ? '"tower-crane"' : 'tower-crane';
  for (const { action } of inbox.items) {
    assert.ok(action.command.startsWith(`${executable} `), action.command);
    assert.ok(action.argv.length);
  }
  assert.match(inbox.items.find((i) => i.kind === 'review_failed').findings, /null/);
  assert.match(inbox.items.find((i) => i.kind === 'rework_ready').reason, /parser.js/);
  assert.equal(inbox.items.find((i) => i.kind === 'revuto_failed').comments.length, 1);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /discussion_r8/);
  h.ok(['rework', '--from-review', review, '--agent', 'orchestrator']);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', `${review}.md`), 'utf8'), /Check null.*\nhttps:\/\/github.com/s);
  h.ok(['release', '--dead', '--agent', 'orchestrator']);
  h.ok(['answer', 'D1', '--choice', 'A']);
  const answer = h.inbox().items.find((i) => i.kind === 'decision_answer');
  h.ok([...answer.action.argv, '--agent', 'orchestrator']);
  for (const i of inbox.items.filter((i) => ['message', 'stall'].includes(i.kind))) h.ok([...i.action.argv, '--agent', 'orchestrator']);
  for (const id of [revuto, codeql]) {
    const i = inbox.items.find((i) => i.task === id && i.kind === (id === revuto ? 'revuto_failed' : 'codeql_alert'));
    h.ok([...i.action.argv, '--agent', 'orchestrator']);
  }
  event(h, accepted, 'automation', { phase: 'done' });
  const clean = h.github();
  delete clean.revuto;
  h.save(clean);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], h.sha);
  const worker = path.join(h.base, 'worker.js');
  fs.writeFileSync(worker, 'setTimeout(() => {}, 60000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'model', '--clear', 'profile', '--clear', 'effort']);
  const dispatch = h.run(['spawn', '--ready', '--agent', 'orchestrator', '--json']);
  assert.equal(dispatch.code, 0, dispatch.stdout + dispatch.stderr);
  const spawned = JSON.parse(dispatch.stdout);
  assert.equal(spawned.results.length, 5);
  assert.ok(spawned.results.every((r) => r.ok));
  assert.equal(h.inbox().items.length, 0);
  assert.deepEqual(h.json(['spawn', '--ready', '--agent', 'orchestrator']).results, []);
});

test('review replacement, capped revuto, old CodeQL heads and unavailable GitHub remain explicit', (t) => {
  const h = setup(t);
  const id = h.add('Current findings');
  h.submit(id, 8);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'old fail', '--agent', 'reviewer']);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  assert.equal(h.run(['rework', '--from-review', id]).code, 1);
  h.ok(['project', 'set', '--ci-capped-review', '[{"app":"revuto-review","pattern":"Daily review limit reached"}]']);
  const github = h.github();
  github.revuto = { app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Daily review limit reached' } };
  github.alerts = { 8: [{ tool: { name: 'CodeQL' }, most_recent_instance: { commit_sha: 'f'.repeat(40) } }] };
  h.save(github);
  assert.deepEqual(h.inbox().items, []);
  github.fail = true;
  h.save(github);
  assert.equal(h.inbox().items[0].kind, 'github_error');
  assert.equal(h.run(['inbox', '--agent', 'worker']).code, 1);
  assert.equal(h.run(['release', '--dead', '--agent', 'worker']).code, 1);
  assert.equal(h.run(['spawn', '--ready', '--agent', 'worker']).code, 1);
  github.fail = false;
  github.prs[8].headRefOid = 'f'.repeat(40);
  h.save(github);
  const moved = h.inbox().items.find((i) => i.kind === 'head_changed');
  h.ok([...moved.action.argv, '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', id]).status, 'rework');
  assert.equal(h.json(['task', 'show', id]).sha, h.sha, 'a new remote head does not become reviewed evidence');
});

test('ready dispatch respects worker slots and unobservable processes cannot be released or replaced', (t) => {
  const h = setup(t);
  const remote = h.add('Remote claim');
  h.ok(['claim', remote, '--agent', 'remote']);
  event(h, remote, 'spawn', { role: 'worker', agent: 'remote', pid: 2147483647, host: 'another-host.invalid' });
  const unclaimed = h.add('Unclaimed live worker');
  event(h, unclaimed, 'spawn', { role: 'worker', agent: 'live', reserved: true, attempt: 1, pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  h.add('Ready A');
  h.add('Ready B');
  h.ok(['project', 'set', '--workers', '3']);
  const before = h.readState('tasks.json');
  assert.deepEqual(h.json(['release', '--dead', '--agent', 'orchestrator']).results, []);
  assert.deepEqual(h.readState('tasks.json'), before);
  const worker = path.join(h.base, 'worker.js');
  fs.writeFileSync(worker, 'setTimeout(() => {}, 60000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'model', '--clear', 'profile', '--clear', 'effort']);
  const dispatch = h.run(['spawn', '--ready', '--agent', 'orchestrator', '--json']);
  assert.equal(dispatch.code, 0, dispatch.stdout + dispatch.stderr);
  const spawned = JSON.parse(dispatch.stdout);
  assert.deepEqual(spawned.results.map((r) => r.task), ['T3']);
  assert.deepEqual(h.json(['spawn', '--ready', '--agent', 'orchestrator']).results, []);
});

test('MCP tools retain identity, expose actions and reject argument overrides', (t) => {
  const h = setup(t);
  const id = h.add('Review');
  h.submit(id);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'fix bounds', '--agent', 'reviewer']);
  const requests = [
    { method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { method: 'tools/list' },
    { method: 'tools/call', params: { name: 'inbox' } },
    { method: 'tools/call', params: { name: 'rework_from_review', arguments: { id } } },
    { method: 'tools/call', params: { name: 'release_dead' } },
    { method: 'tools/call', params: { name: 'inbox', arguments: { agent: 'owner' } } },
  ];
  const input = requests.map((r, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r })).join('\n') + '\n';
  const result = h.run(['mcp', '--agent', 'orchestrator'], { input });
  assert.equal(result.code, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[1].result.tools.length, 5);
  assert.equal(JSON.parse(replies[2].result.content[0].text).items[0].kind, 'review_failed');
  assert.equal(replies[3].result.isError, false);
  assert.equal(replies[4].result.isError, false);
  assert.equal(replies[5].result.isError, true);
  assert.equal(h.json(['task', 'show', id]).status, 'rework');
  const worker = h.run(['mcp', '--agent', 'worker'], { input });
  assert.equal(worker.code, 0, worker.stderr);
  const denied = worker.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(denied[1].result.tools.length, 5, 'discovery itself grants no authority');
  assert.ok(denied.slice(2).every((r) => r.result.isError));
});

test('new inbox items wake through wait and unchanged snapshots do not wake twice', (t) => {
  const h = setup(t);
  h.add('Ready');
  const before = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  const args = ['wait', '--inbox', '--observe', '--after', String(before), '--types', 'inbox item', '--timeout', '0.2', '--agent', 'orchestrator'];
  const wake = h.run(args);
  assert.equal(wake.code, 0, wake.stderr);
  assert.equal(JSON.parse(wake.stdout).detail.item, 'ready:T1');
  const after = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  args[args.indexOf('--after') + 1] = String(after);
  assert.equal(h.run(args).code, 2);
});

test('accepted batch skips unknown PRs and merges independent ready PRs with the queue checks', (t) => {
  const h = setup(t);
  for (const pr of [7, 8]) {
    const id = h.add(`PR ${pr}`);
    h.submit(id, pr);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    h.ok(['check', 'ci', id]);
    h.ok(['accept', id]);
  }
  const submitted = h.add('Unrelated submitted PR');
  h.submit(submitted, 9);
  const github = h.github();
  github.prs[7].mergeable = 'UNKNOWN';
  github.failEndpoint = '/code-scanning/';
  h.save(github);
  const result = h.run(['merge', '--accepted', '--agent', 'orchestrator', '--json']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).remaining[0].reason, /UNKNOWN/);
  assert.equal(h.github().prs[7].state, 'OPEN');
  assert.equal(h.github().prs[8].state, 'MERGED');
  const skipped = h.logs().findLast((e) => e.cmd === 'queue skipped' && e.task === 'T1');
  assert.equal(skipped.detail.sha, h.sha);
  assert.match(skipped.detail.reason, /UNKNOWN/);
  const ready = h.github();
  ready.prs[7].mergeable = 'MERGEABLE';
  h.save(ready);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(h.github().prs[7].state, 'MERGED');
});

test('accepted batch confirms a landed head with stale gates before merging the next PR', (t) => {
  const h = setup(t);
  for (const pr of [7, 8]) {
    const id = h.add(`PR ${pr}`);
    h.submit(id, pr);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    h.ok(['check', 'ci', id]);
    h.ok(['accept', id]);
  }
  h.ok(['project', 'set', '--ci-required', '["test"]']);
  h.ok(['check', 'ci', 'T2']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const github = h.github();
  github.prs[7].state = 'MERGED';
  github.prs[7].mergeCommit = { oid: 'c'.repeat(40) };
  h.save(github);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  const first = h.json(['task', 'show', 'T1']).evidence.findLast((e) => e.type === 'merge');
  assert.equal(first.ok, true);
  assert.equal(first.ref, 'c'.repeat(40));
  assert.equal(h.github().prs[8].state, 'MERGED');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8']);
});

test('accepted batch waits for the queue, merges capped and crashed revuto checks in acceptance order and reports each outcome', async (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--ci-capped-review', JSON.stringify([
    { app: 'revuto-review', pattern: 'Daily review limit reached|Revuto could not complete this review' },
  ])]);
  const tasks = [7, 8].map((pr) => {
    const id = h.add(`PR ${pr}`);
    h.submit(id, pr);
    h.reviewer(id, 'reviewer', h.sha);
    h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
    const github = h.github();
    github.prs[pr].mergeStateStatus = 'UNSTABLE';
    github.revuto = { name: 'revuto', app: 'revuto-review', status: 'completed', conclusion: 'failure',
      output: { summary: pr === 7 ? 'Daily review limit reached' : 'Revuto could not complete this review' } };
    h.save(github);
    h.ok(['check', 'ci', id]);
    return id;
  });
  for (const id of tasks.toReversed()) h.ok(['accept', id]);
  event(h, null, 'merge queue', { phase: 'running', pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  let settled = false;
  const merging = h.runAsync(['merge', '--accepted', '--agent', 'orchestrator', '--json']).then((result) => {
    settled = true;
    return result;
  });
  try {
    const deadline = Date.now() + 10000;
    while (!h.logs().some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested')) {
      assert.ok(Date.now() < deadline, 'batch requested the busy queue');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled, false, 'batch waits until the queue is released');
    assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
  } finally {
    event(h, null, 'merge queue', { phase: 'done' });
  }
  const result = await merging;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7']);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.remaining, []);
  for (const id of tasks) {
    assert.equal(data.results.find((r) => r.task === id).ok, true);
    assert.match(data.results.find((r) => r.task === id).summary, /merged PR/);
    assert.equal(h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
  }
});

test('accepted batch reports an unobservable queue holder and bounds an observable wait', (t) => {
  const h = setup(t);
  const id = h.add('Accepted PR');
  h.submit(id, 7);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', id]);
  h.ok(['accept', id]);
  event(h, null, 'merge queue', { phase: 'running', pid: process.pid, host: 'unobservable-fixture-host' });
  const result = h.run(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(result.code, 1);
  assert.match(result.stderr + result.stdout, /queue.*cannot be observed/);
  assert.doesNotMatch(result.stderr + result.stdout, /accepted PR has not merged/);
  assert.equal(h.github().prs[7].state, 'OPEN');
  h.ok(['project', 'set', '--tests-timeout-min', '0.001']);
  event(h, null, 'merge queue', { phase: 'running', pid: process.pid, ...require('../lib/processes').identity(process.pid) });
  const timeout = h.run(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(timeout.code, 1);
  assert.match(timeout.stderr, /merge queue remained busy for 0\.001 min/);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});

test('accepted batch routes linked members through pinned stack merges', (t) => {
  const f = require('./stack-fixture').stacked(t);
  f.accept('T1');
  f.accept('T2');
  f.write((d) => { for (const pr of Object.values(d.prs)) Object.assign(pr, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }); });
  f.write((d) => { d.prs[11].state = 'CLOSED'; });
  const refused = f.h.run(['merge', '--accepted', '--agent', 'orchestrator', '--json']);
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  const remaining = JSON.parse(refused.stdout).remaining;
  assert.deepEqual(remaining.map((r) => r.task), ['T1', 'T2']);
  for (const entry of remaining) assert.match(entry.reason, /T1: PR #11 is CLOSED/);
  assert.equal(f.read().calls.filter((c) => c.args.includes('POST') && c.args[1].endsWith('/merge-async')).length, 0);
  f.write((d) => { d.prs[11].state = 'OPEN'; });
  const result = f.h.run(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const merges = f.read().calls.filter((c) => c.args[0] === 'api' && c.args.includes('POST') && c.args[1].endsWith('/merge-async'));
  assert.deepEqual(merges.map((c) => c.args[1]), ['repos/acme/app/pulls/11/merge-async', 'repos/acme/app/pulls/12/merge-async']);
  for (const [index, head] of [f.sha, f.upper.sha].entries()) {
    assert.ok(merges[index].args.includes('merge_method=merge'));
    assert.ok(merges[index].args.includes(`expected_head_sha=${head}`));
  }
  for (const id of ['T1', 'T2']) assert.equal(f.h.json(['task', 'show', id]).evidence.findLast((e) => e.type === 'merge').ok, true);
});

test('GitHub-only findings wake the watcher and endpoint failures retain other findings', (t) => {
  const h = setup(t);
  const id = h.add('Remote review');
  h.submit(id, 8);
  const after = () => String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  const wait = () => h.run(['wait', '--inbox', '--observe', '--after', after(), '--types', 'inbox item', '--timeout', '0.1', '--agent', 'orchestrator']);
  assert.equal(wait().code, 2);
  const github = h.github();
  github.revuto = { name: 'review', app: { slug: 'revuto-review' }, status: 'completed', conclusion: 'failure', output: { summary: 'Bounds check missing' } };
  github.failEndpoint = '/code-scanning/';
  h.save(github);
  const wake = wait();
  assert.equal(wake.code, 0, wake.stderr);
  assert.equal(JSON.parse(wake.stdout).detail.item, `revuto_failed:${id}`);
  const kinds = h.inbox().items.map((i) => i.kind);
  assert.ok(kinds.includes('revuto_failed'));
  assert.ok(kinds.includes('github_error'));
  assert.equal(wait().code, 2);
});

test('inbox derives an expired native worker stall without a prior watcher', (t) => {
  const h = setup(t);
  const id = h.add('Native worker');
  h.ok(['claim', id, '--agent', 'native', '--lease', '1']);
  const clock = path.join(h.base, 'clock');
  fs.writeFileSync(clock, String(Date.now() + 120000));
  h.env.HOOK_CLOCK_FILE = clock;
  const inbox = h.inbox();
  const stall = inbox.items.find((i) => i.kind === 'stall');
  assert.equal(stall.task, id);
  assert.ok(!inbox.items.some((i) => i.kind === 'dead_claim'));
  h.ok([...stall.action.argv, '--agent', 'orchestrator']);
  assert.ok(!h.inbox().items.some((i) => i.kind === 'stall'));
});

test('verified workers cannot use orchestrator inbox or batch tools', (t) => {
  const h = setup(t);
  const id = h.add('Bound worker');
  h.ok(['claim', id, '--agent', 'worker-T1-1']);
  const env = { TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_TASK: id };
  h.ok(['msg', '--to', 'orchestrator', 'owner instruction']);
  const message = h.inbox().items.find((i) => i.kind === 'message');
  const before = h.logs();
  for (const args of [['inbox'], ['inbox', '--ack', message.id], ['spawn', '--ready'], ['merge', '--accepted'], ['release', '--dead']]) {
    const result = h.run([...args, '--agent', env.TOWER_CRANE_AGENT], { env });
    assert.equal(result.code, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /orchestrator or owner/);
  }
  const result = h.run(['mcp', '--agent', env.TOWER_CRANE_AGENT], { env,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'release_dead' } }) + '\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.isError, true);
  assert.deepEqual(h.logs(), before);
  const wait = h.run(['wait', '--inbox', '--observe', '--after', 'now', '--timeout', '0.01', '--agent', env.TOWER_CRANE_AGENT], { env });
  assert.equal(wait.code, 2, wait.stderr);
  assert.deepEqual(h.logs(), before, 'a worker observer emits no inbox notifications');
});

test('CodeQL merge-ref alerts match the current merge commit and submitted parents', (t) => {
  const h = setup(t);
  const id = h.add('Pull request analysis');
  h.submit(id, 8);
  const merge = 'c'.repeat(40);
  const base = 'b'.repeat(40);
  const old = 'd'.repeat(40);
  const ref = 'refs/pull/8/merge';
  const github = h.github();
  github.prs[8].mergeRefOid = merge;
  github.prs[8].baseRefOid = base;
  github.commits = { [merge]: { sha: merge, parents: [{ sha: base }, { sha: h.sha }] } };
  const alert = (number, commit_sha, analysisRef = ref) => ({ number, tool: { name: 'CodeQL' },
    rule: { id: 'js/injection' }, html_url: `https://github.com/acme/demo/security/code-scanning/${number}`,
    most_recent_instance: { ref: analysisRef, commit_sha, message: { text: 'Untrusted input' } } });
  github.alerts = { 8: [alert(1, merge), alert(2, old), alert(3, merge, 'refs/pull/9/merge')] };
  h.save(github);
  const finding = h.inbox().items.find((i) => i.kind === 'codeql_alert');
  assert.ok(finding, 'the current PR merge analysis is visible');
  assert.equal(finding.sha, h.sha);
  assert.deepEqual(finding.alerts.map((a) => a.number), [1], 'stale and unrelated analyses stay out');
  assert.equal(finding.alerts[0].most_recent_instance.commit_sha, merge);
  assert.ok(h.github().calls.some((args) => decodeURIComponent(args[1]).includes('ref=refs/pull/8/merge')));
  github.commits[merge].parents[1].sha = old;
  h.save(github);
  const stale = h.inbox().items;
  assert.ok(!stale.some((i) => i.kind === 'codeql_alert'), 'a merge of an older head is not current evidence');
  assert.ok(stale.some((i) => i.kind === 'github_error'));
  github.commits[merge].parents[1].sha = h.sha;
  h.save(github);
  h.ok([...finding.action.argv, '--agent', 'orchestrator']);
  assert.ok(!h.inbox().items.some((i) => i.kind === 'codeql_alert'));
});

test('decision answers and owner comments remain in the inbox until explicitly acknowledged', (t) => {
  const h = setup(t);
  const id = h.add('Owner input');
  h.ok(['ask', '--question', 'Which API?', '--option', 'A', '--option', 'B', '--blocks', id]);
  h.ok(['decision', 'note', 'D1', 'Use the stable contract']);
  h.ok(['task', 'note', id, 'Preserve compatibility']);
  h.ok(['answer', 'D1', '--choice', 'B', '--note', 'Approved for this release']);
  const notes = () => h.inbox().items.filter((i) => ['decision_answer', 'owner_comment'].includes(i.kind));
  const first = notes();
  assert.equal(first.length, 3);
  const answer = first.find((i) => i.kind === 'decision_answer');
  assert.equal(answer.decision.id, 'D1');
  assert.equal(answer.decision.answer, 'B');
  assert.equal(answer.decision.note, 'Approved for this release');
  assert.deepEqual(answer.decision.blocks, [id]);
  assert.deepEqual(first.filter((i) => i.kind === 'owner_comment').map((i) => i.text),
    ['Use the stable contract', 'Preserve compatibility']);
  assert.deepEqual(notes(), first, 'reading and restarting the CLI consumes no owner input');
  const text = h.ok(['inbox', '--agent', 'orchestrator']);
  assert.match(text, /Approved for this release/);
  assert.match(text, /Preserve compatibility/);
  for (const i of first) h.ok([...i.action.argv, '--agent', 'orchestrator']);
  assert.deepEqual(notes(), []);
  h.ok(['decision', 'note', 'D1', 'Ship the compatibility adapter']);
  assert.equal(notes().length, 1);
  assert.equal(notes()[0].text, 'Ship the compatibility adapter');
});

test('MCP discovery works before project initialization and tool errors remain JSON-RPC replies', (t) => {
  const h = makeRepo(t);
  const input = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'inbox' } },
    { id: 4, method: 'ping' },
  ].map((r) => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n';
  for (const cwd of [h.repo, h.base]) {
    const result = h.run(['mcp', '--agent', 'orchestrator'], { cwd, input });
    assert.equal(result.code, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(replies.map((r) => r.id), [1, 2, 3, 4]);
    assert.equal(replies[0].result.serverInfo.name, 'tower-crane');
    assert.equal(replies[1].result.tools.length, 5);
    assert.equal(replies[2].result.isError, true);
    assert.match(replies[2].result.content[0].text, /init|repository/);
    assert.deepEqual(replies[3].result, {});
  }
});

test('current failed software gates expose diagnostics and commands that clear their items', (t) => {
  const h = setup(t);
  for (const key of Object.keys(h.env)) if (key.startsWith('NODE_TEST_')) delete h.env[key];
  const id = h.add('Software gate failures', 'code');
  const script = path.join(h.base, 'failing.test.js');
  fs.writeFileSync(script, "require('node:test')('rejects invalid gate inputs', () => require('node:assert/strict').equal(process.env.INBOX_TEST_OK, '1'));\n");
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd',
    [process.execPath, '--test', script].map(shellQuote).join(' ')]);
  h.submit(id, 7);
  assert.equal(h.run(['check', 'tests', id], { env: { INBOX_TEST_OK: '0' } }).code, 1);
  assert.equal(h.run(['check', 'clean', id], { env: { FIXTURE_GATE_OK: '0' } }).code, 1);
  assert.equal(h.run(['check', 'sources', id]).code, 1, 'missing research manifest fails without a network request');
  const github = h.github();
  github.ci = 'failure';
  h.save(github);
  assert.equal(h.run(['check', 'ci', id]).code, 1);
  const failures = () => h.inbox().items.filter((i) => i.kind === 'gate_failed');
  const items = failures();
  assert.deepEqual(items.map((i) => i.gate).sort(), ['ci', 'clean', 'sources', 'tests']);
  const evidence = h.json(['task', 'show', id]).evidence;
  for (const i of items) {
    assert.equal(i.sha, h.sha);
    assert.equal(i.revision, 1);
    assert.equal(i.summary, evidence.findLast((e) => e.type === i.gate).summary);
    if (i.confirmed_failure) {
      assert.deepEqual(i.action.argv.slice(0, 3), ['rework', id, '--reason']);
      assert.ok(i.action.argv[3].includes(i.summary));
    } else assert.deepEqual(i.action.argv, ['check', i.gate, id]);
  }
  const failedTests = items.find((i) => i.gate === 'tests');
  assert.ok(failedTests.test_failure.names.some((name) => name.includes('rejects invalid gate inputs')));
  assert.deepEqual(failedTests.action.argv.slice(0, 3), ['rework', id, '--reason']);
  assert.match(failedTests.action.argv[3], /rejects invalid gate inputs/);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /rejects invalid gate inputs/);
  assert.equal(h.run(['inbox', '--ack', failedTests.id, '--agent', 'orchestrator']).code, 2);
  h.ok(['check', 'clean', id, '--agent', 'orchestrator']);
  assert.ok(!failures().some((i) => i.gate === 'clean'), 'the latest pass replaces the earlier failure');
  github.ci = 'success';
  h.save(github);
  h.ok(['check', 'ci', id, '--agent', 'orchestrator']);
  assert.ok(!failures().some((i) => i.gate === 'ci'));
  h.ok([...failedTests.action.argv, '--agent', 'orchestrator']);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8'), /rejects invalid gate inputs/);
  assert.deepEqual(failures(), []);
  h.ok(['task', 'update', id, '--acceptance', 'updated acceptance']);
  h.submit(id, 7);
  assert.deepEqual(failures(), [], 'old revision failures are not current findings');
  assert.equal(h.run(['check', 'tests', id], { env: { INBOX_TEST_OK: '0' } }).code, 1);
  assert.equal(failures()[0].revision, 2);
  h.ok(['check', 'tests', id], { env: { INBOX_TEST_OK: '1' } });
  assert.deepEqual(failures(), []);
});

test('an accepted PR with stale gate policy resolves through gate reruns before merge', (t) => {
  const h = setup(t);
  delete h.env.TOWER_CRANE_CLEAN_CMD;
  const id = h.add('Accepted policy changes', 'code');
  h.submit(id, 7);
  for (const type of ['tests', 'clean', 'ci']) h.ok(['check', type, id]);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['accept', id, '--agent', 'orchestrator']);
  const clean = path.join(h.base, 'new-clean.js');
  fs.writeFileSync(clean, 'console.log(JSON.stringify({items: []}));\n');
  for (const [gate, flag, value] of [
    ['ci', '--ci-required', '["test"]'],
    ['tests', '--tests-mode', 'run-only'],
    ['clean', '--clean-cmd', [process.execPath, clean].map(shellQuote).join(' ')],
  ]) {
    h.ok(['project', 'set', flag, value]);
    const blocked = h.inbox().items.find((i) => i.kind === 'accepted_unmerged');
    assert.ok(blocked.reason.includes(`${gate}:`), blocked.reason);
    assert.deepEqual(blocked.action.argv, ['check', gate, id]);
    const rerun = h.run([...blocked.action.argv, '--agent', 'orchestrator']);
    assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
    const ready = h.inbox().items.find((i) => i.kind === 'accepted_unmerged');
    assert.deepEqual(ready.action.argv, ['merge', '--accepted']);
  }
  const ready = h.inbox().items.find((i) => i.kind === 'accepted_unmerged');
  h.ok([...ready.action.argv, '--agent', 'orchestrator']);
  assert.equal(h.github().prs[7].state, 'MERGED');
  assert.ok(!h.inbox().items.some((i) => i.kind === 'accepted_unmerged' || i.kind === 'gate_failed'));
});

test('confirmed CI failures request rework while pending and observation failures request retries', (t) => {
  const h = setup(t);
  const id = h.add('Workflow diagnostics');
  h.submit(id, 7);
  const finding = () => h.inbox().items.find((i) => i.kind === 'gate_failed' && i.gate === 'ci');
  for (const state of [{ ci: 'pending' }, { ci: 'success', failEndpoint: '/check-runs' }]) {
    h.save({ ...h.github(), ...state });
    assert.equal(h.run(['check', 'ci', id]).code, 1);
    const entry = h.json(['task', 'show', id]).evidence.at(-1);
    assert.notEqual(entry.confirmed_failure, true);
    assert.deepEqual(finding().action.argv, ['check', 'ci', id]);
    assert.equal(h.json(['task', 'show', id]).status, 'submitted');
  }
  const github = h.github();
  delete github.failEndpoint;
  github.ci = 'failure';
  h.save(github);
  assert.equal(h.run(['check', 'ci', id]).code, 1);
  const entry = h.json(['task', 'show', id]).evidence.at(-1);
  assert.equal(entry.confirmed_failure, true);
  assert.equal(entry.test_failure, undefined);
  assert.equal(h.logs().findLast((e) => e.cmd === 'check ci').detail.confirmed_failure, true);
  const failure = finding();
  assert.deepEqual(failure.action.argv.slice(0, 3), ['rework', id, '--reason']);
  assert.ok(failure.action.argv[3].includes(entry.summary));
  h.ok([...failure.action.argv, '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', id]).status, 'rework');
  assert.ok(fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8').includes(entry.summary));
  assert.equal(finding(), undefined);
});

test('a remotely merged accepted PR remains actionable until its audited merge receipt exists', (t) => {
  const h = setup(t);
  const id = h.add('Missing merge confirmation');
  h.submit(id, 7);
  h.ok(['check', 'ci', id]);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['accept', id, '--agent', 'orchestrator']);
  const github = h.github();
  github.prs[7].state = 'MERGED';
  github.prs[7].mergeCommit = { oid: 'c'.repeat(40) };
  h.save(github);
  assert.equal(h.json(['task', 'show', id]).evidence.some((e) => e.type === 'merge'), false);
  const items = h.inbox().items.filter((i) => i.task === id);
  assert.equal(items.length, 1, 'confirmation replaces stale gate actions for the landed head');
  assert.deepEqual(items[0].action.argv, ['merge', '--accepted']);
  assert.match(items[0].reason, /confirm|receipt/);
  assert.deepEqual(h.inbox().items.filter((i) => i.task === id), items, 'reading does not record a merge');
  github.ci = 'failure';
  h.save(github);
  assert.equal(h.run(['check', 'ci', id]).code, 1);
  assert.deepEqual(h.inbox().items.filter((i) => i.task === id), items, 'later failed gates do not rework a landed head');
  h.ok([...items[0].action.argv, '--agent', 'orchestrator']);
  const task = h.json(['task', 'show', id]);
  const receipt = task.evidence.findLast((e) => e.type === 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, 'c'.repeat(40));
  assert.ok(h.logs().some((e) => e.cmd === 'merge' && e.detail.ok && e.detail.sha === h.sha));
  assert.ok(!h.inbox().items.some((i) => i.task === id));
  assert.equal(h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge').length, 0);
});

function reviewComments(h, id) {
  const ref = 'https://github.com/acme/demo/pull/7#issuecomment-23';
  const body = `Review (Tower Crane, clean context)\n\nBlocking: 2 findings at ${h.sha}.\n\n`
    + '- [P1] lib/store.js:12 - First finding: reject duplicate writes - Prevent corruption.\n'
    + '- [P2] lib/cache.js:31 - Second finding: invalidate deleted entries - Prevent stale reads.\n';
  h.submit(id, 7);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--agent', 'reviewer',
    '--summary', '2 blocking findings: reject duplicate writes', '--ref', ref]);
  const github = h.github();
  github.review_comments = { 7: [
    { id: 21, body: body.replaceAll(h.sha, 'a'.repeat(40)), html_url: ref.replace('23', '21') },
    { id: 22, body: `Review (Tower Crane, clean context)\n\n1 finding at ${h.sha}.\n\n- lib/old.js:1 - Older finding - Superseded.\n`, html_url: ref.replace('23', '22') },
    { id: 23, body, html_url: ref },
    { id: 24, body: body.replaceAll(h.sha, 'f'.repeat(40)), html_url: ref.replace('23', '24') },
    { id: 25, body: `Unrelated comment mentioning ${h.sha}`, html_url: ref.replace('23', '25') },
  ] };
  h.save(github);
  return { ref, body };
}

test('failed review inbox and rework preserve every finding from the latest comment at the head', (t) => {
  const h = setup(t);
  const id = h.add('Two review findings');
  const { body, ref } = reviewComments(h, id);
  const finding = h.inbox().items.find((i) => i.kind === 'review_failed');
  assert.equal(finding.finding_count, 2);
  assert.equal(finding.findings, body);
  assert.equal(finding.ref, ref);
  assert.equal(finding.findings_complete, true);
  assert.match(h.ok(['inbox', '--agent', 'orchestrator']), /Second finding/);
  const before = h.github().calls.length;
  h.ok(['rework', '--from-review', id, '--agent', 'orchestrator']);
  assert.ok(h.github().calls.slice(before).some((args) => args[0] === 'api'
    && args[1].includes('/issues/7/comments') && args.includes('--paginate')));
  const task = h.json(['task', 'show', id]);
  assert.equal(task.status, 'rework');
  assert.ok(task.notes.at(-1).text.includes(body));
  const brief = fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8');
  assert.ok(brief.includes(body));
  assert.ok(brief.includes(ref));
  assert.doesNotMatch(brief, /Older finding/);
});

test('review comment failures refuse rework without replacing full findings with a summary', (t) => {
  const h = setup(t);
  const id = h.add('Review retrieval');
  const { body } = reviewComments(h, id);
  const original = fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8');
  for (const state of ['unavailable', 'wrong-head']) {
    const github = h.github();
    if (state === 'unavailable') github.failEndpoint = '/issues/';
    else {
      delete github.failEndpoint;
      github.review_comments[7] = [
        { id: 22, body },
        { id: 23, body: body.replaceAll(h.sha, 'e'.repeat(40)) },
      ];
    }
    h.save(github);
    const result = h.run(['rework', '--from-review', id, '--agent', 'orchestrator']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(h.json(['task', 'show', id]).status, 'submitted');
    assert.equal(fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8'), original);
    const inbox = h.inbox();
    const review = inbox.items.find((i) => i.kind === 'review_failed');
    assert.equal(review.finding_count, 2);
    assert.equal(review.findings_complete, false);
    assert.ok(inbox.items.some((i) => i.kind === 'github_error'));
  }
});

test('review rework rechecks the verdict after fetching comments outside the state lock', (t) => {
  const h = setup(t);
  const id = h.add('Concurrent review');
  reviewComments(h, id);
  h.reviewer(id, 'replacement-reviewer', h.sha);
  const github = h.github();
  github.reviewDuringFetch = { task: id, sha: h.sha };
  h.save(github);
  const original = fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8');
  const result = h.run(['rework', '--from-review', id, '--agent', 'orchestrator']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /review|changed/i);
  const task = h.json(['task', 'show', id]);
  assert.equal(task.status, 'submitted');
  assert.equal(task.evidence.findLast((e) => e.type === 'review').ok, true);
  assert.equal(fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8'), original);
});
