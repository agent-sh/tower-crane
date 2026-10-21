'use strict';

const { waitOnRepo, fileWritten } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { once } = require('node:events');
const { makeRepo, cachedFixture, BIN, HOOKS } = require('./helpers');
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
  h.save = (data) => {
    fs.writeFileSync(h.env.INBOX_GITHUB, JSON.stringify(data));
    fs.rmSync(path.join(h.state, 'inbox-github-cache.json'), { force: true });
  };
  h.add = (title, kind = 'docs') => {
    const task = h.json(['task', 'add', '--title', title, '--kind', kind, '--acceptance', 'works']);
    h.ok(['brief', 'set', task.id, '-'], { input: `${title}\n` });
    return task.id;
  };
  h.submit = (id, pr) => {
    h.ok(['claim', id, '--agent', `worker-${id}`]);
    h.ok(['submit', id, '--sha', h.sha, ...(pr ? ['--pr', String(pr)] : []), '--agent', `worker-${id}`]);
  };
  h.refresh = () => {
    const r = h.run(['wait', '--inbox', '--observe', '--after', 'now', '--types', 'inbox item',
      '--timeout', '0.01', '--agent', 'orchestrator']); // wait-allow: run one host follower refresh before reading its cached GitHub findings
    assert.ok([0, 2].includes(r.code), r.stderr);
  };
  h.inbox = (refresh = true) => {
    if (refresh) h.refresh();
    return h.json(['inbox', '--agent', 'orchestrator']);
  };
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

test('completed push selection preserves the newest recorded run and attempt', () => {
  const { latestPush } = require('../lib/main-ci');
  const previous = { id: 100, workflow_id: 11, number: 50, attempt: 2, event: 'push', conclusion: 'success' };
  for (const [number, attempt, status, conclusion, expected] of [
    [51, 1, 'in_progress', null, [50, 2, 'success']],
    [50, 3, 'in_progress', null, [50, 2, 'success']],
    [50, 1, 'completed', 'failure', [50, 2, 'success']],
    [49, 9, 'completed', 'failure', [50, 2, 'success']],
    [50, 3, 'completed', 'failure', [50, 3, 'failure']],
    [51, 1, 'completed', 'cancelled', [51, 1, 'cancelled']],
  ]) {
    const [run] = latestPush([{ id: 100, workflow_id: 11, run_number: number, run_attempt: attempt,
      name: 'CI', event: 'push', status, conclusion }], [previous]);
    assert.deepEqual([run.number, run.attempt, run.conclusion], expected);
  }
});

test('main push failures produce one item per current head and follow observes completion without --inbox', async (t) => {
  const h = setup(t);
  const github = h.github();
  const run = (id, workflow, sha = h.sha, conclusion = 'failure') => ({
    id, workflow_id: workflow, name: `CI ${workflow}`, run_number: id, event: 'push',
    status: 'completed', conclusion, head_sha: sha,
  });
  github.main_head = h.sha;
  github.main_runs = [run(101, 11), run(102, 12), run(99, 13, 'd'.repeat(40))];
  github.jobs = { 101: [{ id: 501, name: 'linux', status: 'completed', conclusion: 'failure' }] };
  github.logs = { 501: 'not ok 1 - current head regression\n  ---\n  error: failed\n  ...\n' };
  h.save(github);
  const cache = path.join(h.state, 'main-ci-cache.json');
  const failed = () => {
    fs.rmSync(cache, { force: true });
    return h.inbox().items.filter((i) => i.kind === 'main_ci_failed');
  };
  const beforeRefresh = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
  const first = failed().filter((i) => i.sha === h.sha);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, `main_ci_failed:project:${h.sha}`);
  assert.deepEqual(first[0].runs.map((r) => r.id).sort(), [101, 102]);
  assert.equal(first[0].jobs[0].tests[0].name, 'current head regression');
  assert.deepEqual(failed().filter((i) => i.sha === h.sha).map((i) => i.id), first.map((i) => i.id));
  assert.equal(h.logs().filter((e) => e.cmd === 'main ci').length, 1);
  const observe = (after = 'now') => h.run(['wait', '--inbox', '--observe', '--after', after, '--types', 'inbox item', '--timeout', '0.2', '--agent', 'orchestrator']); // wait-allow: observe already-published main CI
  assert.equal(observe(beforeRefresh).code, 0);
  github.main_runs[0].run_attempt = 2;
  h.save(github);
  failed();
  const rerun = observe();
  if (rerun.code === 0) assert.notEqual(JSON.parse(rerun.stdout).detail.item, first[0].id);
  else assert.equal(rerun.code, 2);
  assert.equal(h.logs().filter((e) => e.cmd === 'inbox item' && e.detail.item === first[0].id).length, 1);
  github.main_runs = [run(103, 11, h.sha, 'success'), run(104, 12, h.sha, 'success'), run(106, 13, h.sha, 'success')];
  h.save(github);
  assert.deepEqual(failed(), []);
  observe();

  github.main_runs = [run(105, 11, h.sha, 'timed_out')];
  github.main_runs[0].status = 'in_progress';
  github.main_runs[0].conclusion = null;
  h.save(github);
  fs.rmSync(cache, { force: true });
  const advance = path.join(h.base, 'advance-main-clock');
  const clock = path.join(h.base, 'main-clock.js');
  fs.writeFileSync(clock, "const fs = require('node:fs'); const real = Date.now; Date.now = () => real() + (fs.existsSync(process.env.TC_MAIN_CLOCK_ADVANCE) ? 61000 : 0);\n");
  const follower = cp.spawn(process.execPath, ['--require', clock, '--require', HOOKS, BIN, 'wait', '--follow', '--agent', 'orchestrator'], {
    cwd: h.repo, env: { ...h.env, TC_MAIN_CLOCK_ADVANCE: advance },
  });
  const closed = once(follower, 'close');
  let output = '';
  let errors = '';
  follower.stderr.on('data', (b) => { errors += b; });
  const woke = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no main CI wake: ${output} ${errors}`)), 20000); // wait-allow: bound the follower completion probe
    follower.stdout.on('data', (b) => {
      output += b;
      if (output.includes('"type":"main ci"')) { clearTimeout(timer); resolve(); }
    });
    follower.once('close', () => { clearTimeout(timer); reject(new Error(`follower exited: ${errors}`)); });
  });
  try {
    await Promise.all([woke, fileWritten(cache, { signal: t.signal }).then(() => {
      github.main_runs[0].status = 'completed';
      github.main_runs[0].conclusion = 'timed_out';
      h.save(github);
      fs.writeFileSync(advance, '');
    })]);
    assert.equal(h.inbox().items.filter((i) => i.kind === 'main_ci_failed').length, 1);
  } finally {
    follower.kill();
    await closed;
  }
});

test('push inbox retains older-head blockers and uses every green conclusion', (t) => {
  const h = setup(t);
  for (const current of [false, true]) for (const pending of [true, false]) {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'success', 'neutral', 'skipped']) {
      const data = h.github();
      data.main_head = current ? h.sha : 'd'.repeat(40);
      const run = { id: 100, workflow_id: 11, run_number: 50, name: 'CI', event: 'push',
        status: 'completed', conclusion, head_sha: h.sha };
      data.main_runs = [run];
      if (pending) data.main_runs.unshift({ ...run, id: 101, run_number: 51, head_sha: data.main_head, status: 'in_progress', conclusion: null });
      h.save(data);
      fs.rmSync(path.join(h.state, 'main-ci-cache.json'), { force: true });
      const items = h.inbox().items.filter((i) => i.kind === 'main_ci_failed');
      const green = ['success', 'neutral', 'skipped'].includes(conclusion);
      assert.equal(items.length, green ? 0 : 1, JSON.stringify({ current, pending, conclusion, items }));
      if (!green) {
        assert.equal(items[0].run, 100);
        assert.equal(items[0].id, `main_ci_failed:project:${h.sha}`);
        assert.equal(items[0].action.argv[1], 'add');
      }
    }
  }
});

// Lifecycle fixtures represent processes that exited before the observer
// starts. All task transitions and the resolving actions use the real CLI.
function event(h, task, cmd, detail, agent = 'orchestrator', at = new Date().toISOString()) {
  const e = { id: `fixture-${h.logs().length}`, at, cmd, agent, task, detail };
  fs.appendFileSync(path.join(h.state, 'events.jsonl'), `${JSON.stringify(e)}\n`);
}

test('multi-item acknowledgements are atomic, deduplicated and retain single-item receipts', (t) => {
  const h = setup(t);
  for (const text of ['one', 'two', 'three']) h.ok(['msg', '--to', 'orchestrator', text, '--agent', 'messenger']);
  const messages = h.inbox().items.filter((i) => i.kind === 'message');
  const before = h.logs();
  for (const invalid of ['message:project:missing', h.inbox().items.find((i) => i.kind === 'ready')?.id || 'ready:T999']) {
    assert.equal(h.run(['inbox', '--ack', messages[0].id, '--ack', invalid, '--agent', 'orchestrator']).code, 2);
    assert.deepEqual(h.logs(), before, 'one invalid id refuses the entire batch');
  }
  const data = h.json(['inbox', '--ack', messages[0].id, '--ack', messages[1].id,
    '--ack', messages[0].id, '--agent', 'orchestrator']);
  assert.deepEqual(data, { acknowledged: messages.slice(0, 2).map((i) => i.id), count: 2 });
  const added = h.logs().slice(before.length);
  assert.equal(added.length, 1);
  assert.equal(added[0].cmd, 'inbox ack');
  assert.deepEqual(added[0].detail, { items: data.acknowledged, count: 2 });
  assert.deepEqual(h.inbox().items.filter((i) => i.kind === 'message').map((i) => i.id), [messages[2].id]);
  const single = h.json(['inbox', '--ack', messages[2].id, '--agent', 'orchestrator']);
  assert.deepEqual(single, { acknowledged: messages[2].id });
  assert.deepEqual(h.logs().at(-1).detail, { item: messages[2].id });
  assert.equal(h.inbox().items.filter((i) => i.kind === 'message').length, 0);
});

test('owner comment acknowledgements distinguish current and legacy events on one task', (t) => {
  for (const legacy of [false, true]) {
    const h = setup(t);
    const task = h.add(`Comment ids ${legacy ? 'legacy' : 'current'}`);
    const cutoff = '2026-01-02T00:00:00.000Z';
    for (let i = 0; i < 2; i++) {
      event(h, task, 'task note', { text: 'Same owner comment' }, 'owner', cutoff);
    }
    if (legacy) {
      const logs = h.logs().map((e) => {
        if (e.cmd === 'task note' && e.agent === 'owner') delete e.id;
        return e;
      });
      fs.writeFileSync(path.join(h.state, 'events.jsonl'), logs.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    const comments = () => h.inbox().items.filter((i) => i.kind === 'owner_comment');
    const first = comments();
    assert.equal(first.length, 2);
    assert.equal(new Set(first.map((i) => i.id)).size, 2, 'every comment has its own id');
    assert.deepEqual(comments(), first, 'ids survive repeated CLI reads');
    h.ok([...first[0].action.argv, '--agent', 'orchestrator']);
    assert.deepEqual(comments(), [first[1]], 'single ack clears exactly one comment');
    event(h, task, 'task note', { text: 'Later owner comment' }, 'owner', cutoff);
    const before = comments();
    assert.equal(before.length, 2);
    assert.equal(before[0].id, first[1].id, 'appending events preserves legacy ids');
    const ack = h.json(['inbox', '--ack-before', cutoff, '--kind', 'owner_comment', '--agent', 'orchestrator']);
    assert.deepEqual(ack.acknowledged, before.map((i) => i.id));
    assert.equal(ack.count, before.length);
    assert.equal(comments().length, 0, 'listing decreases by the acknowledgement count');
  }
});

test('inbox reuses successful GitHub reads for a minute and refreshes changed submissions', (t) => {
  const h = setup(t);
  const id = h.add('Cached GitHub');
  h.submit(id, 7);
  const first = h.inbox();
  const before = h.github().calls.length;
  assert.deepEqual(h.inbox(false), first);
  assert.equal(h.github().calls.length, before, 'a second CLI process reuses the GitHub observations');
  const cacheFile = path.join(h.state, 'inbox-github-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache.started_at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  h.refresh();
  assert.ok(h.github().calls.length > before, 'the next follower pass refreshes even responses that arrived late');
  for (const entry of Object.values(cache.entries)) entry.at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const afterRefresh = h.github().calls.length;
  assert.ok(h.inbox(false).items.some((i) => i.kind === 'github_pending'));
  assert.equal(h.github().calls.length, afterRefresh, 'expired data does not launch foreground reads');
  h.refresh();
  assert.ok(h.github().calls.length > before, 'expired reads refresh');
  const current = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  for (const entry of Object.values(current.entries)) entry.at = '2999-01-01T00:00:00.000Z';
  fs.writeFileSync(cacheFile, JSON.stringify(current));
  const expired = h.github().calls.length;
  assert.ok(h.inbox(false).items.some((i) => i.kind === 'github_pending'));
  h.refresh();
  assert.ok(h.github().calls.length > expired, 'future cache stamps are not trusted');
  h.ok(['rework', id, '--reason', 'new submission']);
  h.ok(['claim', id, '--agent', `worker-${id}`]);
  h.ok(['submit', id, '--sha', h.sha, '--pr', '7', '--agent', `worker-${id}`]);
  const resubmitted = h.github().calls.length;
  assert.ok(h.inbox(false).items.some((i) => i.kind === 'github_pending'));
  h.refresh();
  assert.ok(h.github().calls.length > resubmitted, 'a new revision invalidates cached PR observations');
  h.ok(['task', 'update', id, '--status', 'cancelled']);
  h.refresh();
  const pruned = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.ok(Object.values(pruned.entries).every((entry) => !entry.tasks.some((task) => task[0] === id)),
    'closed task observations are pruned from the cache file');
});

test('foreground inbox never launches slow GitHub reads and preserves refreshed failures and local comments', (t) => {
  for (const endpoint of ['', '/code-scanning/', '/issues/']) {
    const h = setup(t);
    const id = h.add(`Slow GitHub ${endpoint}`);
    h.submit(id, 7);
    if (endpoint === '/issues/') {
      h.reviewer(id, 'reviewer', h.sha);
      h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha, '--revision', h.revision(id),
        '--summary', 'A blocking review', '--agent', 'reviewer']);
    }
    event(h, id, 'task note', { text: 'Keep owner input' }, 'owner');
    h.save({ ...h.github(), delayMs: 4000, delayEndpoint: endpoint });
    const before = h.github().calls.length;
    const started = performance.now();
    const data = h.inbox(false);
    assert.ok(performance.now() - started < 3000, 'foreground reads never wait for GitHub'); // wait-allow: verify the three-second inbox contract with cold GitHub cache and stalled endpoints
    assert.ok(data.items.some((i) => i.kind === 'owner_comment' && i.text === 'Keep owner input'));
    assert.equal(data.items.filter((i) => i.kind === 'github_pending').length, 1, 'one summary covers missing reads');
    assert.equal(data.items.filter((i) => i.kind === 'github_error').length, 0, 'missing cache entries are not GitHub failures');
    assert.equal(h.github().calls.length, before, 'no foreground GitHub subprocesses');
    h.save({ ...h.github(), delayMs: 0, failEndpoint: '/code-scanning/',
      failMessage: 'GitHub unavailable: INBOX_GITHUB_PENDING appears in a repository name' });
    h.refresh();
    const refreshed = h.github().calls.length;
    const failures = h.inbox(false).items.filter((i) => i.kind === 'github_error');
    assert.ok(failures.some((i) => /GitHub unavailable/.test(i.reason)), 'real background failures stay visible');
    assert.equal(h.github().calls.length, refreshed, 'cached failures do not trigger foreground reads');
    const cacheFile = path.join(h.state, 'inbox-github-cache.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const entry of Object.values(cache.entries)) entry.at = new Date(Date.now() - 61000).toISOString();
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    assert.deepEqual(h.inbox(false).items.filter((i) => i.kind === 'github_error'), failures,
      'overdue failed observations stay explicit until replacement');
    assert.equal(h.github().calls.length, refreshed, 'overdue errors do not launch foreground reads');
  }
});

test('overdue cached findings survive every refresh boundary and an in-flight follower pass', async (t) => {
  const h = setup(t);
  const submitted = h.add('Cached security findings');
  h.submit(submitted, 7);
  const moved = h.add('Cached moved head');
  h.submit(moved, 8);
  const accepted = h.add('Cached merge confirmation');
  h.submit(accepted, 9);
  h.reviewer(accepted, 'accepted-reviewer', h.sha);
  h.ok(['evidence', accepted, '--revision', h.revision(accepted), '--type', 'review', '--ok',
    '--sha', h.sha, '--agent', 'accepted-reviewer']);
  h.ok(['check', 'ci', accepted]);
  h.ok(['accept', accepted]);
  const acceptedOpen = h.add('Cached accepted mergeability');
  h.submit(acceptedOpen, 7);
  h.reviewer(acceptedOpen, 'open-reviewer', h.sha);
  h.ok(['evidence', acceptedOpen, '--revision', h.revision(acceptedOpen), '--type', 'review', '--ok',
    '--sha', h.sha, '--agent', 'open-reviewer']);
  h.ok(['check', 'ci', acceptedOpen]);
  h.ok(['accept', acceptedOpen]);
  const reviewed = h.add('Cached failed review');
  h.submit(reviewed, 7);
  h.reviewer(reviewed, 'failed-reviewer', h.sha);
  h.ok(['evidence', reviewed, '--revision', h.revision(reviewed), '--type', 'review', '--fail',
    '--sha', h.sha, '--summary', 'Blocking review', '--agent', 'failed-reviewer']);
  const restore = h.add('Cached restore hint');
  h.submit(restore, 7);
  h.ok(['rework', restore, '--reason', 'environment failed']);
  const revision = h.json(['task', 'show', restore]).revision;
  event(h, restore, 'rework', { gate: 'ci', sha: h.sha, revision, previous_revision: revision - 1,
    reason: 'environment failed' }, 'automation');
  const github = h.github();
  github.prs[8].headRefOid = 'f'.repeat(40);
  github.prs[9].state = 'MERGED';
  github.revuto = { name: 'revuto', app: { slug: 'revuto-review' }, status: 'completed',
    conclusion: 'failure', output: { summary: 'Bounds error' } };
  github.alerts = { 7: [{ number: 1, tool: { name: 'CodeQL' }, rule: { id: 'js/injection' },
    most_recent_instance: { commit_sha: h.sha, message: { text: 'Untrusted input' } } }] };
  github.review_comments = { 7: [{ id: 1,
    body: `Review (Tower Crane, clean context)\n\nBlocking: 1 at ${h.sha}.\n\n- lib/value.js:1 - Bounds error - Avoid corruption.\n` }] };
  h.save(github);
  const expected = h.inbox().items.filter((i) => i.task);
  for (const kind of ['revuto_failed', 'codeql_alert', 'head_changed', 'accepted_unmerged', 'review_failed', 'rework_ready']) {
    assert.ok(expected.some((i) => i.kind === kind), kind);
  }
  assert.equal(expected.find((i) => i.task === accepted && i.kind === 'accepted_unmerged').confirmation, true);
  assert.equal(expected.find((i) => i.task === acceptedOpen && i.kind === 'accepted_unmerged').remote.mergeable,
    'MERGEABLE');
  assert.equal(expected.find((i) => i.task === reviewed && i.kind === 'review_failed').findings_complete, true);
  assert.equal(expected.find((i) => i.task === restore && i.kind === 'rework_ready').restore,
    `gates retry ${restore} --from-rework`);
  const file = path.join(h.state, 'inbox-github-cache.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const age of [59000, 61000, 78000, 123000]) {
    const cache = structuredClone(original);
    const at = new Date(Date.now() - age).toISOString();
    cache.started_at = at;
    for (const entry of Object.values(cache.entries)) entry.at = at;
    fs.writeFileSync(file, JSON.stringify(cache));
    const calls = h.github().calls.length;
    const data = h.inbox(false);
    assert.deepEqual(data.items.filter((i) => i.task), expected, `last findings remain visible at age ${age}`);
    assert.equal(h.github().calls.length, calls, 'foreground launches no GitHub reads');
    if (age > 60000) assert.ok(data.items.some((i) => i.kind === 'github_pending' && i.stale),
      'overdue data is explicit');
  }
  const signalFile = path.join(h.base, 'refresh-paused');
  fs.writeFileSync(h.env.INBOX_GITHUB, JSON.stringify({ ...h.github(), delayMs: 4000,
    delayEndpoint: '/code-scanning/', delaySignal: signalFile }));
  const follower = cp.spawn(process.execPath, ['--require', HOOKS, BIN, 'wait', '--inbox', '--observe', '--after', 'now', '--timeout', '0.01', '--agent', 'orchestrator'], { cwd: h.repo, env: h.env }); // wait-allow: pause one follower refresh to verify cached findings stay visible until its replacement is written
  const closed = once(follower, 'close');
  let errors = '';
  follower.stderr.on('data', (b) => { errors += b; });
  follower.stdout.resume();
  try {
    await fileWritten(signalFile, { signal: t.signal });
    assert.deepEqual(h.inbox(false).items.filter((i) => i.task), expected,
      'old findings stay visible while replacement reads are in flight');
    const [code] = await closed;
    assert.ok([0, 2].includes(code), errors);
    assert.deepEqual(h.inbox(false).items.filter((i) => i.task), expected, 'completed refresh replaces the snapshot');
  } finally {
    follower.kill();
    await closed;
  }
});

test('base CI observations expire into one pending summary without active PRs or foreground reads', (t) => {
  const h = setup(t);
  h.refresh();
  const file = path.join(h.state, 'main-ci-cache.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const actions = fs.readFileSync(`${h.env.INBOX_GITHUB}.actions`, 'utf8');
  const cases = [
    { name: 'fresh', cache: base, pending: false },
    { name: 'missing', cache: null, pending: true },
    { name: 'expired', cache: { ...base, read_at: '2000-01-01T00:00:00.000Z' }, pending: true },
    { name: 'future', cache: { ...base, read_at: '2999-01-01T00:00:00.000Z' }, pending: true },
    { name: 'repository changed', cache: { ...base, repo: 'other/repo' }, pending: true },
    { name: 'base changed', cache: { ...base, base: 'other' }, pending: true },
  ];
  for (const row of cases) {
    if (row.cache) fs.writeFileSync(file, JSON.stringify(row.cache));
    else fs.rmSync(file, { force: true });
    const pending = h.inbox(false).items.filter((i) => i.kind === 'github_pending');
    assert.equal(pending.length, row.pending ? 1 : 0, row.name);
    if (row.pending) {
      assert.equal(pending[0].count, 0);
      assert.match(pending[0].reason, /project base/);
    }
    assert.equal(fs.readFileSync(`${h.env.INBOX_GITHUB}.actions`, 'utf8'), actions, 'foreground never refreshes base CI');
  }
  fs.rmSync(file, { force: true });
  h.save({ ...h.github(), failActions: true });
  h.refresh();
  const failed = h.inbox(false).items;
  assert.ok(failed.some((i) => i.kind === 'github_error' && /GitHub unavailable/.test(i.reason)));
  assert.ok(!failed.some((i) => i.kind === 'github_pending'), 'a fresh failed base read is an explicit error');
  const inboxFile = path.join(h.state, 'inbox-github-cache.json');
  const cache = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  cache.read_at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(inboxFile, JSON.stringify(cache));
  assert.equal(h.inbox(false).items.filter((i) => i.kind === 'github_pending').length, 1,
    'an expired failed base read also needs a refresh');
});

test('pending GitHub actions reread recent refreshes or perform one bounded observation without dispatch', (t) => {
  for (const row of [
    { name: 'cold', at: null, observe: true },
    { name: 'recent refresh', age: 10000, observe: false },
    { name: 'between healthy passes', age: 59000, observe: false },
    { name: 'overdue refresh', age: 61000, observe: true },
    { name: 'stopped follower', age: 180000, observe: true },
    { name: 'invalid timestamp', at: 'invalid', observe: true },
    { name: 'future timestamp', at: '2999-01-01T00:00:00.000Z', observe: true },
  ]) {
    const h = setup(t);
    h.add(`Ready during ${row.name}`);
    h.refresh();
    const now = Date.now();
    const clock = path.join(h.base, 'pending-clock');
    fs.writeFileSync(clock, String(now));
    h.env.HOOK_CLOCK_FILE = clock;
    const inboxFile = path.join(h.state, 'inbox-github-cache.json');
    const baseFile = path.join(h.state, 'main-ci-cache.json');
    if (row.name === 'cold') fs.rmSync(inboxFile, { force: true });
    else {
      const cache = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
      cache.read_at = row.at || new Date(now - row.age).toISOString();
      fs.writeFileSync(inboxFile, JSON.stringify(cache));
    }
    const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    base.read_at = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(baseFile, JSON.stringify(base));
    const pending = h.inbox(false).items.find((i) => i.kind === 'github_pending');
    assert.ok(pending, row.name);
    assert.deepEqual(pending.action.argv, row.observe
      ? ['wait', '--inbox', '--observe', '--timeout', '1'] : ['inbox'], row.name);
    const before = h.logs().length;
    const tasks = h.readState('tasks.json').tasks;
    const action = h.run([...pending.action.argv, '--agent', 'orchestrator']);
    assert.ok([0, 2].includes(action.code), `${row.name}: ${action.stderr}`);
    assert.deepEqual(h.readState('tasks.json').tasks, tasks, `${row.name}: ready work stays untouched`);
    assert.ok(h.logs().slice(before).every((e) => !['spawn', 'automation', 'automation reconcile'].includes(e.cmd)),
      `${row.name}: resolving unread data must not start work or software reactions`);
  }
});

test('ack-before includes the cutoff, filters kinds and leaves newer items and findings', (t) => {
  const h = setup(t);
  const task = h.add('Cutoff input');
  const stalled = h.add('Cutoff stall');
  h.ok(['claim', stalled, '--agent', 'stalled']);
  const claim = h.json(['task', 'show', stalled]).claim;
  const cutoff = '2026-01-02T00:00:00.000Z';
  event(h, stalled, 'stall', { agent: 'stalled', until: claim.until, progress_at: claim.since }, 'orchestrator', cutoff);
  event(h, stalled, 'review exit missing', { agent: 'reviewer', reason: 'monitor exited' }, 'orchestrator', cutoff);
  for (const at of ['2026-01-01T23:59:59.999Z', cutoff, '2026-01-02T00:00:00.001Z']) {
    event(h, task, 'msg', { to: 'orchestrator', text: at }, 'messenger', at);
    event(h, task, 'task note', { text: at }, 'owner', at);
  }
  h.ok(['ask', '--kind', 'technical', '--question', 'Which API?', '--option', 'A', '--blocks', task]);
  h.ok(['answer', 'D1', '--choice', 'A']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which later API?', '--option', 'A', '--blocks', task]);
  h.ok(['answer', 'D2', '--choice', 'A']);
  const file = path.join(h.state, 'decisions.json');
  const decisions = JSON.parse(fs.readFileSync(file, 'utf8'));
  decisions.decisions[0].answered_at = cutoff;
  decisions.decisions[1].answered_at = '2026-01-02T00:00:00.001Z';
  fs.writeFileSync(file, JSON.stringify(decisions));
  const items = h.inbox().items;
  let before = h.logs();
  for (const args of [
    ['--ack-before', 'invalid'],
    ['--ack-before', cutoff, '--kind', 'ready'],
    ['--kind', 'message'],
    ['--ack-before', cutoff, '--ack', items.find((i) => i.kind === 'message').id],
  ]) {
    assert.equal(h.run(['inbox', ...args, '--agent', 'orchestrator']).code, 2);
    assert.deepEqual(h.logs(), before);
  }
  const messages = items.filter((i) => i.kind === 'message' && i.text <= cutoff).map((i) => i.id);
  const filtered = h.json(['inbox', '--ack-before', cutoff, '--kind', 'message', '--agent', 'orchestrator']);
  assert.deepEqual(filtered, { acknowledged: messages, count: 2, cutoff });
  let added = h.logs().slice(before.length);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].detail, { items: messages, count: 2, cutoff, kind: 'message' });
  assert.equal(h.inbox().items.filter((i) => i.kind === 'owner_comment').length, 3);
  before = h.logs();
  const remaining = items.filter((i) => (i.kind === 'owner_comment' && i.text <= cutoff)
    || (i.kind === 'decision_answer' && i.decision.answered_at <= cutoff)
    || ['stall', 'review_exit_missing'].includes(i.kind)).map((i) => i.id);
  const all = h.json(['inbox', '--ack-before', '2026-01-02T02:00:00+02:00', '--agent', 'orchestrator']);
  assert.deepEqual(all, { acknowledged: remaining, count: 5, cutoff });
  added = h.logs().slice(before.length);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].detail, { items: remaining, count: 5, cutoff });
  const newer = h.inbox().items;
  assert.equal(newer.filter((i) => ['message', 'owner_comment'].includes(i.kind)).length, 2);
  assert.deepEqual(newer.filter((i) => i.kind === 'decision_answer').map((i) => i.decision.id), ['D2']);
  assert.ok(newer.some((i) => i.kind === 'ready'));
  before = h.logs();
  assert.deepEqual(h.json(['inbox', '--ack-before', cutoff, '--agent', 'orchestrator']),
    { acknowledged: [], count: 0, cutoff });
  assert.equal(h.logs().length, before.length + 1);
});

test('old closed-task inputs expire without changing history while main CI is observed', (t) => {
  const h = setup(t);
  const merged = h.add('Merged input');
  h.submit(merged, 7);
  h.reviewer(merged, 'reviewer', h.sha);
  h.ok(['evidence', merged, '--revision', h.revision(merged), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', merged]);
  h.ok(['accept', merged]);
  h.ok(['merge', merged]);
  const cancelled = h.add('Cancelled input');
  h.ok(['task', 'update', cancelled, '--status', 'cancelled']);
  const unmerged = h.add('Accepted input');
  h.submit(unmerged, 8);
  h.reviewer(unmerged, 'reviewer', h.sha);
  h.ok(['evidence', unmerged, '--revision', h.revision(unmerged), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  h.ok(['check', 'ci', unmerged]);
  h.ok(['accept', unmerged]);
  const active = h.add('Active input');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const recent = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
  const cases = [
    { tasks: [merged], hidden: true },
    { tasks: [cancelled], hidden: true },
    { tasks: [merged, cancelled], hidden: true },
    { tasks: [unmerged], hidden: false },
    { tasks: [active], hidden: false },
    { tasks: [merged, active], hidden: false },
    { tasks: [], hidden: false },
  ];
  for (const [index, row] of cases.entries()) {
    for (const at of [old, recent]) event(h, row.tasks[0] || null, 'msg', { to: 'orchestrator', text: `${index}:${at}` }, 'messenger', at);
    h.ok(['ask', '--kind', 'technical', '--question', `Input ${index}`, '--option', 'A', ...row.tasks.flatMap((id) => ['--blocks', id])]);
    h.ok(['answer', `D${index + 1}`, '--choice', 'A']);
  }
  h.ok(['ask', '--kind', 'technical', '--question', 'Recent merged input', '--option', 'A', '--blocks', merged]);
  h.ok(['answer', `D${cases.length + 1}`, '--choice', 'A']);
  event(h, merged, 'task note', { text: 'Retain owner input' }, 'owner', old);
  const file = path.join(h.state, 'decisions.json');
  const decisions = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const decision of decisions.decisions) decision.answered_at = old;
  decisions.decisions.at(-1).answered_at = recent;
  fs.writeFileSync(file, JSON.stringify(decisions));
  for (const [index, conclusion] of [null, 'pending', 'success', 'failure', 'success'].entries()) {
    const github = h.github();
    github.main_head = (index + 1).toString(16).repeat(40);
    github.main_runs = conclusion === null ? [] : [{
      id: 100 + index, workflow_id: 11, run_number: index + 1, name: 'CI', event: 'push',
      head_sha: github.main_head, status: conclusion === 'pending' ? 'in_progress' : 'completed',
      conclusion: conclusion === 'pending' ? null : conclusion,
    }];
    h.save(github);
    fs.rmSync(path.join(h.state, 'main-ci-cache.json'), { force: true });
    const before = h.logs();
    h.refresh();
    const refreshed = h.logs();
    const items = h.inbox(false).items;
    for (const [index, row] of cases.entries()) {
      const messageHidden = [merged, cancelled].includes(row.tasks[0]);
      assert.equal(items.some((i) => i.kind === 'message' && i.text === `${index}:${old}`), !messageHidden, JSON.stringify(row));
      assert.ok(items.some((i) => i.kind === 'message' && i.text === `${index}:${recent}`));
      assert.equal(items.some((i) => i.kind === 'decision_answer' && i.decision.id === `D${index + 1}`), !row.hidden, JSON.stringify(row));
    }
    assert.ok(items.some((i) => i.kind === 'owner_comment' && i.text === 'Retain owner input'));
    assert.ok(items.some((i) => i.kind === 'decision_answer' && i.decision.id === `D${cases.length + 1}`));
    assert.equal(items.filter((i) => i.kind === 'main_ci_failed').length, conclusion === 'failure' ? 1 : 0);
    const after = h.logs();
    assert.deepEqual(after, refreshed, 'foreground expiration appends no events');
    assert.deepEqual(refreshed.slice(0, before.length), before, 'expiration preserves every existing event');
    const added = refreshed.slice(before.length);
    assert.deepEqual(added.filter((e) => e.cmd === 'main ci').map((e) => e.detail.head),
      [github.main_head], 'the follower appends the fresh CI observation');
    assert.ok(added.every((e) => ['main ci', 'inbox item', 'inbox snapshot'].includes(e.cmd)),
      'the follower only appends CI observations and inbox receipts');
  }
});

test('one fixture exposes every inbox kind and resolving commands clear their conditions', async (t) => {
  const h = setup(t);
  const review = h.add('Failed review');
  h.submit(review);
  h.reviewer(review, 'reviewer', h.sha);
  h.ok(['evidence', review, '--revision', h.revision(review), '--type', 'review', '--fail', '--sha', h.sha,
    '--summary', 'Check null before dereferencing.', '--ref', 'https://github.com/acme/demo/pull/1#issuecomment-1', '--agent', 'reviewer']);
  const rework = h.add('Rework without a worker');
  h.submit(rework);
  h.ok(['rework', rework, '--reason', 'base conflict in parser.js']);
  const dead = h.add('Dead claim');
  h.ok(['claim', dead, '--agent', 'gone']);
  event(h, dead, 'spawn', { agent: 'gone', role: 'worker', harness: 'command', pid: 2147483647, host: os.hostname() });
  const accepted = h.add('Accepted but not merged');
  h.submit(accepted, 7);
  h.reviewer(accepted, 'reviewer', h.sha);
  h.ok(['evidence', accepted, '--revision', h.revision(accepted), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
  h.ok(['ask', '--kind', 'technical', '--question', 'Which API?', '--option', 'A', '--option', 'B', '--blocks', stall]);
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
  fs.writeFileSync(worker, 'setInterval(() => {}, 1000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
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
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'old fail', '--agent', 'reviewer']);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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

test('a ready task without a brief is brief_missing until brief set clears it', (t) => {
  const h = setup(t);
  const id = h.json(['task', 'add', '--title', 'Briefless', '--kind', 'docs', '--acceptance', 'works']).id;
  const items = () => h.inbox().items.filter((i) => i.task === id && ['brief_missing', 'ready'].includes(i.kind));
  assert.deepEqual(items().map((i) => [i.kind, i.action.argv]), [['brief_missing', ['brief', 'set', id, '--file', '<brief file>']]]);
  assert.match(h.ok(['status']), new RegExp(`ready: ${id} Briefless \\(no brief\\)`));

  h.ok(['brief', 'set', id, '-'], { input: 'Context.\n' });
  assert.deepEqual(items().map((i) => i.kind), ['ready']);
  assert.doesNotMatch(h.ok(['status']), /no brief/);
});

test('a rework task without a brief is brief_missing in place of its rework item', (t) => {
  const h = setup(t);
  const id = h.json(['task', 'add', '--title', 'Reworked', '--kind', 'docs', '--acceptance', 'works']).id;
  h.submit(id);
  h.ok(['rework', id, '--reason', 'base conflict in parser.js']);
  const kinds = () => h.inbox().items.filter((i) => i.task === id).map((i) => i.kind);
  assert.deepEqual(kinds(), ['rework_ready']);
  // rework writes its notes into the brief, so only a removed brief file leaves the task without one.
  fs.rmSync(path.join(h.state, 'briefs', `${id}.md`));
  assert.deepEqual(kinds(), ['brief_missing']);
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
  const after = h.readState('tasks.json');
  delete after.orchestrator_lease;
  delete before.orchestrator_lease;
  assert.deepEqual(after, before);
  const worker = path.join(h.base, 'worker.js');
  fs.writeFileSync(worker, 'setInterval(() => {}, 1000);\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, worker, '{prompt}']), '--clear', 'profile', '--clear', 'effort']);
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
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--fail', '--sha', h.sha, '--summary', 'fix bounds', '--agent', 'reviewer']);
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
  // Retain the follower's ready notification while warming its CI cache.
  h.inbox();
  const args = ['wait', '--inbox', '--observe', '--after', String(before), '--types', 'inbox item', '--timeout', '0.2', '--agent', 'orchestrator']; // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
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
    h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
    h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
    await waitOnRepo(h, () => h.logs().some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested'));
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
  // Async GitHub reads must finish within the wait, including a cold cache.
  const wait = () => h.run(['wait', '--inbox', '--observe', '--after', after(), '--types', 'inbox item', '--timeout', '2', '--agent', 'orchestrator']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
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
  const wait = h.run(['wait', '--inbox', '--observe', '--after', 'now', '--timeout', '0.01', '--agent', env.TOWER_CRANE_AGENT], { env }); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
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
  h.ok(['ask', '--kind', 'technical', '--question', 'Which API?', '--option', 'A', '--option', 'B', '--blocks', id]);
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
    // A temp root inside another checkout must not discover that project's state.
    const result = h.run(['mcp', '--agent', 'orchestrator'], { cwd, input, env: { TOWER_CRANE_STATE: h.state } });
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
  fs.writeFileSync(script, "if (!require('node:fs').readFileSync('value.js', 'utf8').includes('1')) process.exit(0);\nrequire('node:test')('rejects invalid gate inputs', () => require('node:assert/strict').equal(process.env.INBOX_TEST_OK, '1'));\n");
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
  const reworkedRevision = Number(h.revision(id));
  assert.equal(reworkedRevision, 2);
  h.ok(['task', 'update', id, '--acceptance', 'updated acceptance']);
  h.submit(id, 7);
  assert.deepEqual(failures(), [], 'old revision failures are not current findings');
  assert.equal(h.run(['check', 'tests', id], { env: { INBOX_TEST_OK: '0' } }).code, 1);
  assert.equal(failures()[0].revision, reworkedRevision + 1);
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
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
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
    + '## Prior blockers\n\nEarlier lib/fixed.js:7 is fixed.\n\n## Blocking findings\n\n'
    + '- [P1] lib/store.js:12 - First finding: reject duplicate writes - Prevent corruption.\n'
    + '  Reproduction:\n  Write twice through lib/fixture.js:50.\n'
    + '- [P2] lib/cache.js:31 - Second finding: invalidate deleted entries - Prevent stale reads.\n'
    + '\nReproduce through lib/fixture.js:50, then run the existing checks.\n';
  h.submit(id, 7);
  h.reviewer(id, 'reviewer', h.sha);
  h.ok(['evidence', id, '--revision', h.revision(id), '--type', 'review', '--fail', '--sha', h.sha, '--agent', 'reviewer',
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
  assert.equal(task.revision, 2);
  assert.ok(task.evidence.every((entry) => entry.revision === 1));
  assert.deepEqual(task.evidence.find((entry) => entry.type === 'review').areas, ['lib/cache.js', 'lib/store.js']);
  const rework = h.logs().findLast((entry) => entry.cmd === 'rework' && entry.task === id);
  assert.equal(rework.detail.previous_revision, 1);
  assert.equal(rework.detail.revision, 2);
  assert.ok(task.notes.at(-1).text.includes(body));
  const brief = fs.readFileSync(path.join(h.state, 'briefs', `${id}.md`), 'utf8');
  assert.ok(brief.includes(body));
  assert.ok(brief.includes(ref));
  assert.doesNotMatch(brief, /Older finding/);
  h.submit(id, 7);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha,
    '--revision', '1', '--agent', 'owner']);
  assert.equal(h.json(['task', 'show', id]).gates.gates.find((gate) => gate.type === 'review').ok, false);
  h.ok(['evidence', id, '--type', 'review', '--ok', '--sha', h.sha,
    '--revision', '2', '--agent', 'owner']);
  assert.equal(h.json(['task', 'show', id]).gates.gates.find((gate) => gate.type === 'review').ok, true);
  h.ok(['evidence', id, '--type', 'review', '--fail', '--sha', h.sha,
    '--revision', '2', '--agent', 'owner', '--summary', '2 blockers; see full comment', '--ref', ref]);
  h.ok(['rework', '--from-review', id, '--agent', 'orchestrator']);
  const redesign = h.inbox().items.find((item) => item.task === id && item.kind === 'review_redesign');
  assert.deepEqual(redesign.areas, ['lib/cache.js', 'lib/store.js']);
  assert.equal(h.run(['claim', id, '--agent', 'next-worker']).code, 1);
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
  github.reviewDuringFetch = { task: id, sha: h.sha, revision: h.revision(id) };
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

test('a red push or schedule run on the base shows in inbox and status until a later green run of its workflow', (t) => {
  const h = setup(t);
  const run = (id, number, event, status, conclusion, attempt = 1) => ({ id, run_number: number, run_attempt: attempt, workflow_id: 11,
    name: 'CI', path: '.github/workflows/ci.yml', event, status, conclusion, head_sha: h.sha, html_url: `https://github.com/acme/demo/actions/runs/${id}` });
  const job = (id, name, conclusion) => ({ id, name, status: 'completed', conclusion, html_url: `https://github.com/acme/demo/actions/runs/1/job/${id}` });
  const linux = 'test (ubuntu-latest, node 26, shard 1/3)';
  const test = 'resolves a linux path';
  // The runner echoes step commands in color, so a real job log carries escape sequences.
  const log = (name) => ['\x1b[36;1mnpm test\x1b[0m', 'TAP version 13', 'ok 1 - reads the config', `\x1b[31mnot ok 2 - ${name}\x1b[0m`, '  ---',
    "  error: 'expected /tmp/a to equal /tmp/b'", '  ...', '1..2']
    .map((line, i) => `2026-10-13T03:20:0${i}.0000000Z ${line}`).join('\n') + '\n';
  const github = h.github();
  github.main_runs = [run(1001, 50, 'push', 'completed', 'failure')];
  github.jobs = { 1001: [job(501, linux, 'failure'), job(502, 'test (windows-latest, node 26, shard 1/3)', 'success')] };
  github.logs = { 501: log(test) };
  h.save(github);
  const cache = path.join(h.state, 'main-ci-cache.json');
  // A read younger than a minute is reused; each step here stands for a later minute.
  const red = (expire = true) => {
    if (expire) fs.rmSync(cache, { force: true });
    return h.inbox().items.filter((i) => i.kind.startsWith('main_ci_'));
  };
  const actionCalls = () => {
    try { return fs.readFileSync(`${h.env.INBOX_GITHUB}.actions`, 'utf8').trim().split('\n').length; } catch { return 0; }
  };
  const mainEvents = () => h.logs().filter((e) => e.cmd === 'main ci').length;

  const [failed] = red();
  assert.equal(failed.kind, 'main_ci_failed', JSON.stringify(red()));
  assert.equal(failed.id, `main_ci_failed:project:${h.sha}`);
  assert.deepEqual(failed.jobs.map((j) => [j.name, j.conclusion, j.tests.map((x) => x.name)]), [[linux, 'failure', [test]]]);
  assert.match(failed.reason, /CI run 1001 attempt 1 \(push at .+\): failure/);
  assert.deepEqual(failed.action.argv, ['task', 'add', '--title', 'Fix main CI: CI (workflow 11), red since run 1001', '--kind', 'code',
    '--acceptance', 'CI on main is green']);
  const status = h.ok(['status']);
  assert.match(status, /main ci red: CI run 1001 attempt 1 \(push at /);
  assert.ok(status.includes(`${linux}: failure; failing tests: ${test}`), status);
  assert.equal(h.json(['status']).main_ci_red[0].jobs[0].tests[0].error, "error: 'expected /tmp/a to equal /tmp/b'");
  // Within a minute the last read is reused without GitHub calls; an unchanged red run is not recorded again.
  const calls = actionCalls();
  assert.equal(red(false).length, 1);
  assert.equal(actionCalls(), calls);
  red();
  assert.equal(mainEvents(), 1);
  // Only an open task on this base's fix prefix with the whole workflow token is the fix task.
  for (const title of ['Notes on workflow 11 runners', 'Fix release CI: CI (workflow 11), red since run 9', 'Fix main CI: CI (workflow 110)']) {
    h.ok(['task', 'add', '--title', title, '--kind', 'code', '--acceptance', 'works']);
  }
  assert.equal(red()[0].action.argv[1], 'add');
  h.ok([...failed.action.argv, '--agent', 'orchestrator']);
  const fix = h.json(['task', 'list']).find((x) => x.title === 'Fix main CI: CI (workflow 11), red since run 1001');
  assert.deepEqual(red()[0].action.argv, ['task', 'show', fix.id]);

  // Main stays red across a merge: the next push fails the same test. The fix task covers it, and it is not flaky.
  github.main_runs.unshift(run(1002, 51, 'push', 'completed', 'failure'));
  github.jobs[1002] = [job(504, linux, 'failure')];
  github.logs[504] = log(test);
  h.save(github);
  assert.deepEqual(red().map((i) => [i.kind, i.run, i.action.argv]), [['main_ci_failed', 1002, ['task', 'show', fix.id]]]);
  // A rerun keeps the run red while it runs, and a failing second attempt is the same run, not a flaky repeat.
  github.main_runs[0] = run(1002, 51, 'push', 'in_progress', null, 2);
  h.save(github);
  assert.deepEqual(red().map((i) => [i.kind, i.run, i.attempt]), [['main_ci_failed', 1002, 1]]);
  github.main_runs[0] = run(1002, 51, 'push', 'completed', 'failure', 2);
  h.save(github);
  assert.deepEqual(red().map((i) => [i.kind, i.run, i.attempt]), [['main_ci_failed', 1002, 2]]);

  // A later green push of the workflow clears it.
  github.main_runs.unshift(run(1003, 52, 'push', 'completed', 'success'));
  h.save(github);
  assert.deepEqual(red(), []);
  assert.doesNotMatch(h.ok(['status']), /ci red/);

  // A successful completed attempt still decides while its next attempt runs.
  github.main_runs[0] = run(1003, 52, 'push', 'in_progress', null, 2);
  h.save(github);
  assert.deepEqual(red(), []);
  assert.doesNotMatch(h.ok(['status']), /ci red/);
  github.main_runs[0] = run(1003, 52, 'push', 'completed', 'success', 2);
  h.save(github);
  assert.deepEqual(red(), []);

  // A pending newer push cannot clear a cancelled completed push.
  github.main_runs.unshift(run(1005, 54, 'push', 'in_progress', null), run(1004, 53, 'push', 'completed', 'cancelled'));
  github.jobs[1004] = [job(503, linux, 'cancelled')];
  h.save(github);
  assert.equal(red()[0].conclusion, 'cancelled');
  assert.match(h.ok(['status']), /ci red/);

  // Without a newer run, a cancelled run is not green.
  github.main_runs.shift();
  github.jobs[1004] = [job(503, linux, 'cancelled')];
  h.save(github);
  const [cancelled] = red();
  assert.equal(cancelled.conclusion, 'cancelled');
  assert.equal(cancelled.jobs[0].name, linux);
  assert.match(cancelled.jobs[0].log_error, /logs expired/);
  assert.match(h.ok(['status']), /main ci red: CI run 1004 attempt 1 \(push at .+\): cancelled/);

  // The same test failing after a green run is a flaky-test item.
  github.main_runs.unshift(run(1006, 55, 'push', 'completed', 'failure'));
  github.jobs[1006] = [job(506, linux, 'failure')];
  github.logs[506] = log(test);
  h.save(github);
  const flaky = red().find((i) => i.kind === 'main_ci_flaky');
  assert.deepEqual([flaky.test, flaky.run, flaky.earlier_runs], [test, 1006, [1001, 1002]]);
  assert.deepEqual(flaky.action.argv, ['task', 'add', '--title', `Flaky test on main CI: ${test}`, '--kind', 'code',
    '--acceptance', `${test} passes repeatably on main`]);
  h.ok([...flaky.action.argv, '--agent', 'orchestrator']);
  const flakyTask = h.json(['task', 'list']).find((x) => x.title === `Flaky test on main CI: ${test}`);
  assert.deepEqual(red().find((i) => i.kind === 'main_ci_flaky').action.argv, ['task', 'show', flakyTask.id]);

  // Recorded runs belong to their base; another base starts clean.
  h.ok(['project', 'set', '--base', 'release', '--agent', 'orchestrator']);
  github.main_runs = [];
  h.save(github);
  assert.doesNotMatch(h.ok(['status']), /ci red/);
  assert.deepEqual(red(), []);
});
