'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, BIN } = require('./helpers');
const { setup, configureHarness } = require('./automation-helpers');
const { waitOnRepo } = require('./signals');
const S = require('../lib/state');
const StateFiles = require('./state-files');
const T = require('../lib/tasks');
const G = require('../lib/github-broker');
const B = require('../lib/broker');
const C = require('../lib/gates/common');
const Body = require('../lib/review-body');

const finding = { kind: 'false-claim', path: 'PR body', claim: 'The body claims an unmeasured result.' };

function fixture(t, mode) {
  const h = cachedFixture(t, 'automatic body repair', (repo) => {
    const h = setup(null, { kind: 'docs', repo });
    configureHarness(h);
    h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
    const github = h.github();
    github.prs[7].body = 'An unmeasured result.';
    github.prs[7].title = 'Change';
    h.saveGithub(github);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--branch', 'fixture-change', '--agent', 'worker']);
    h.ok(['check', 'ci', 'T1']);
    const config = path.join(h.base, 'body-mode');
    const release = path.join(h.base, 'body-release');
    const script = path.join(h.base, 'body-harness.js');
    fs.writeFileSync(script, `
const fs = require('node:fs'), cp = require('node:child_process');
const { updateJson } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const mode = fs.readFileSync(${JSON.stringify(config)}, 'utf8');
const prompt = process.argv[2];
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'body-session' }));
if (prompt.includes('## PR-body repair')) {
  if (!prompt.includes('Do not claim, submit') || !prompt.includes('unmeasured result')) process.exit(2);
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'body-starts'))}, process.env.TOWER_CRANE_AGENT + '\\n');
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'body-prompts'))}, JSON.stringify(prompt) + '\\n');
  const end = Date.now() + 60000; // wait-allow: bounded fixture wait for the explicit body-edit release signal
  const repair = () => {
    if (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > end) process.exit(3);
      return setTimeout(repair, 20); // wait-allow: release signal with a 60-second deadline
    }
    if (mode === 'local-commit' || mode === 'remote-commit') {
      fs.writeFileSync('extra.md', 'Changed code.\\n');
      cp.execFileSync('git', ['add', 'extra.md']);
      cp.execFileSync('git', ['commit', '-qm', 'Unexpected commit']);
    }
    if (mode === 'untracked' || mode === 'staged-file') {
      fs.writeFileSync('pr-body.md', 'Corrected claim.\\n');
      if (mode === 'staged-file') cp.execFileSync('git', ['add', 'pr-body.md']);
    }
    const starts = fs.readFileSync(${JSON.stringify(path.join(h.base, 'body-starts'))}, 'utf8').trim().split('\\n').length;
    if (mode === 'availability-twice' || mode === 'availability-once' && starts === 1) process.exit(75);
    updateJson(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, (s) => {
      if (mode !== 'unchanged') s.prs[7].body += '\\nCorrected claim.';
      if (mode === 'remote-commit') s.prs[7].headRefOid = cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
      if (mode === 'title' || mode === 'retarget-title') s.prs[7].title = 'Changed title';
      if (mode === 'base') s.prs[7].baseRefName = 'other';
      if (mode.startsWith('retarget')) s.prs[7].baseRefName = 'main';
      return s;
    });
    if (mode === 'availability-after-edit') process.exit(75);
  };
  repair();
} else {
  if (!prompt.includes('## Light claim check')) process.exit(4);
  const attempts = ${JSON.stringify(path.join(h.base, 'body-review-starts'))};
  fs.appendFileSync(attempts, process.env.TOWER_CRANE_AGENT + '\\n');
  const attempt = fs.readFileSync(attempts, 'utf8').trim().split('\\n').length;
  if (mode === 'crash-cap' || mode === 'crash-once' && attempt === 1) process.exit(1);
  if (mode === 'outage-once' && attempt === 1) process.exit(75);
  if (mode === 'clean-no-verdict') process.exit(0);
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'body-checks'))}, prompt + '\\n');
  const s = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
  const round = s.prs[7].body.split('Corrected claim.').length - 1;
  const ok = ['pass-first', 'crash-once', 'outage-once', 'untracked', 'availability-once', 'availability-after-edit', 'title', 'base', 'staged-file', 'retarget', 'retarget-title'].includes(mode)
    || mode === 'pass-second' && round === 2;
  const args = [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', ok ? '--ok' : '--fail',
    '--sha', ${JSON.stringify(h.sha)}, '--summary', ok ? 'Corrected claims verified.' : 'The body still claims an unmeasured result.'];
  if (!ok) args.push('--findings', ${JSON.stringify(JSON.stringify([finding]))});
  const r = cp.spawnSync(process.execPath, args, {env:fakeAgentEnv(process.env),stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`);
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, script, '{prompt}']),
      '--supervision', '{"retries":0}']);
    h.reviewer('T1', 'first-reviewer', h.sha);
    h.ok(['evidence', 'T1', '--agent', 'first-reviewer', '--type', 'review', '--fail', '--sha', h.sha,
      '--summary', 'The body claims an unmeasured result.', '--findings', JSON.stringify([finding])]);
    return { sha: h.sha };
  });
  fs.writeFileSync(path.join(h.base, 'body-mode'), mode);
  if (mode.startsWith('retarget')) {
    require('./atomic-file').updateJson(h.env.AUTOMATION_GITHUB, (github) => {
      github.prs[7].baseRefName = 'merged-parent';
      return github;
    });
  }
  return h;
}

for (const mode of ['pass-first', 'pass-second', 'fail-twice', 'local-commit', 'remote-commit', 'unchanged',
  'untracked', 'staged-file', 'availability-once', 'availability-twice', 'availability-after-edit', 'title', 'base',
  'retarget', 'retarget-title']) {
  test(`automatic PR-body repair: ${mode}`, async (t) => {
    const h = fixture(t, mode);
    const logs = () => S.readEvents(h.state);
    h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    assert.ok(logs().some((e) => e.cmd === 'spawn' && e.detail.body_fix), 'body-only failure dispatches its fix');
    await waitOnRepo(h, () => logs().some((e) => e.cmd === 'spawn' && e.detail.body_fix),
      'body-only failure did not dispatch its fix', { signal: t.signal });
    assert.match(h.ok(['status']), /submitted: T1 \(fixing PR body\)/);
    const first = h.json(['task', 'show', 'T1']);
    assert.equal(first.status, 'submitted');
    assert.equal(first.sha, h.sha);
    assert.equal(first.revision, 1);
    fs.writeFileSync(path.join(h.base, 'body-release'), '');
    const fullRework = mode.endsWith('commit') || ['staged-file', 'title', 'base', 'retarget-title'].includes(mode);
    const passes = mode.startsWith('pass') || ['untracked', 'availability-once', 'availability-after-edit', 'retarget'].includes(mode);
    await waitOnRepo(h, () => {
      const st = S.loadState(h.state);
      const task = T.getTask(st, 'T1');
      return ['rework', 'accepted'].includes(task.status) || require('../lib/review-body').state(st, task)?.stuck;
    }, 'body repair did not reach its terminal state', { signal: t.signal });
    const st = S.loadState(h.state);
    const task = T.getTask(st, 'T1');
    const fixes = logs().filter((e) => e.cmd === 'spawn' && e.detail.body_fix);
    const checks = logs().filter((e) => e.cmd === 'spawn' && e.detail.body_recheck);
    const retries = ['availability-once', 'availability-twice'].includes(mode);
    assert.equal(task.status, fullRework ? 'rework' : passes ? 'accepted' : 'submitted', mode);
    assert.equal(fixes.length, ['pass-second', 'fail-twice'].includes(mode) || retries ? 2 : 1);
    assert.equal(checks.length, fullRework || ['unchanged', 'availability-twice'].includes(mode) ? 0 : retries ? 1 : fixes.length);
    const prompts = fs.readFileSync(path.join(h.base, 'body-prompts'), 'utf8').trim().split('\n').map(JSON.parse);
    for (const prompt of prompts) assert.equal(prompt.split('## PR-body repair').length - 1, 1);
    for (const check of checks) {
      assert.equal(check.detail.sha, h.sha);
      assert.equal(check.detail.revision, 1);
      assert.equal(check.detail.review_rung, 'easy');
    }
    if (fixes.length === 2) {
      assert.equal(fixes[1].detail.resumed, true);
      assert.equal(fixes[1].detail.agent, fixes[0].detail.agent);
    }
    if (passes) {
      assert.equal(task.status, 'accepted');
      assert.equal(task.sha, h.sha);
      assert.equal(task.revision, 1);
    } else if (!fullRework) {
      const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_body_stuck');
      assert.deepEqual(item.blockers, [finding]);
      if (mode === 'fail-twice') assert.match(item.findings, /The body still claims/);
      assert.match(item.reason, ['unchanged', 'availability-twice'].includes(mode) ? /without changing/ : /two consecutive/);
      assert.match(item.correction, /Edit the false PR-body claims before accept/);
      assert.deepEqual(item.action.argv, ['accept', 'T1']);
      h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      assert.equal(logs().filter((e) => e.cmd === 'spawn' && e.detail.body_fix).length, fixes.length);
    }
    assert.deepEqual(task.escalations || [], []);
  });
}

test('PR-body metadata distinguishes engine retargeting from unrelated changes', async (t) => {
  const h = fixture(t, 'pass-first');
  const baseline = S.loadState(h.state);
  const snapshotBase = 'parent-branch';
  let current, pr, outcome;
  t.mock.method(S, 'loadState', () => current);
  t.mock.method(C, 'gh', async () => ({ ok: true, stdout: JSON.stringify(pr) }));
  t.mock.method(C, 'resolveCommit', async () => h.sha);
  t.mock.method(C, 'git', async () => ({ ok: true, stdout: '' }));
  t.mock.method(require('../lib/spawn-session'), 'exitedAttempt', () => true);
  t.mock.method(require('../lib/reviewer'), 'reviewExit', () => ({ state: 'pending' }));
  t.mock.method(require('../lib/automation'), 'reviewHeld', async () => false);
  t.mock.method(T, 'accept', async () => { outcome = 'light check'; });
  t.mock.method(T, 'rework', () => { outcome = 'rework'; });
  const rows = [
    { name: 'snapshot during an active stack', stack: true, base: snapshotBase, ok: true },
    { name: 'main before parent merge', stack: true, base: 'main', ok: false },
    { name: 'parent merged before stack retirement', stack: true, merged: true, base: 'main', ok: true },
    { name: 'parent merged while reading GitHub', stack: true, merged: true, stale: true, base: 'main', ok: true },
    { name: 'parent merged during a light check', stack: true, merged: true, recheck: true, base: 'main', ok: true },
    { name: 'snapshot after parent merge', stack: true, merged: true, base: snapshotBase, ok: true },
    { name: 'stack record retired', base: 'main', ok: true },
    { name: 'unstacked fallback during a light check', recheck: true, base: 'main', ok: true },
    { name: 'active stack target after engine retarget', stack: true, target: 'next-parent', base: 'next-parent', ok: true },
    { name: 'unrelated base after merge', stack: true, merged: true, base: 'other', ok: false },
    { name: 'title edit with allowed retarget', stack: true, merged: true, base: 'main', title: 'Changed', ok: false },
  ];
  for (const row of rows) {
    current = structuredClone(baseline);
    const task = T.getTask(current, 'T1');
    const review = T.latestGateEvidence(task, 'review', current.events);
    if (row.stack) {
      task.stack = { parent: 'T2', base: row.target || snapshotBase };
      const parent = { ...structuredClone(task), id: 'T2', stack: undefined, evidence: [] };
      current.tasks.tasks.push(parent);
      if (row.merged) {
        const merge = { type: 'merge', source: 'merge', ok: true, sha: parent.sha, revision: parent.revision,
          agent: 'orchestrator', commands: [{ bin: 'gh', args: ['pr', 'merge', '8'], status: 0 }] };
        parent.evidence.push(merge);
        current.events.push({ cmd: 'merge', task: parent.id, agent: merge.agent, detail: merge });
      }
    }
    const fix = { sha: task.sha, revision: task.revision, pr: task.pr, branch: task.branch, review,
      title: 'Change', base: snapshotBase, body_hash: 'original-body' };
    current.events.push({ cmd: 'spawn', task: task.id,
      detail: { role: 'worker', agent: 'body-fixer', body_fix: fix, sha: task.sha, revision: task.revision } });
    if (row.recheck) current.events.push({ cmd: 'spawn', task: task.id,
      detail: { role: 'reviewer', agent: 'light-reviewer', sha: task.sha, revision: task.revision } });
    pr = { state: 'OPEN', headRefOid: task.sha, headRefName: task.branch,
      body: 'Corrected claim.', title: row.title || 'Change', baseRefName: row.base };
    outcome = null;
    const observed = row.stale ? structuredClone(current) : current;
    if (row.stale) {
      T.getTask(observed, 'T2').evidence = [];
      observed.events = observed.events.filter((e) => e.cmd !== 'merge');
    }
    await Body.react({ stateDir: h.state, cwd: h.repo, pos: ['T1'] }, observed, T.getTask(observed, 'T1'), review);
    assert.equal(outcome, row.ok ? 'light check' : 'rework', row.name);
  }
});

for (const mode of ['crash-once', 'outage-once', 'clean-no-verdict', 'crash-cap']) {
  test(`light PR-body check recovers or reports its hold: ${mode}`, async (t) => {
    const h = fixture(t, mode);
    const events = () => S.readEvents(h.state);
    const checks = () => events().filter((e) => e.cmd === 'spawn' && e.detail.body_recheck);
    const consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
    consume();
    fs.writeFileSync(path.join(h.base, 'body-release'), '');
    await waitOnRepo(h, () => checks().length && events().some((e) => e.cmd === 'spawn exit'
      && e.detail.agent === checks()[0].detail.agent), 'the first light reviewer did not exit', { signal: t.signal });
    const held = ['clean-no-verdict', 'crash-cap'].includes(mode);
    // A crashed light reviewer is replaced once its supervisor has finished, which a
    // Windows runner can take longer to see than a fixed number of passes.
    if (mode === 'clean-no-verdict') for (let i = 0; i < 3; i++) consume();
    else if (mode === 'crash-cap') {
      await waitOnRepo(h, () => { consume(); return events().some((e) => e.cmd === 'review held'); },
        'light reviewers crashing up to the cap never recorded a review hold', { signal: t.signal });
      assert.ok(checks().length >= 2, 'the crash cap requires reviewer replacement');
    } else {
      await waitOnRepo(h, () => { consume(); return checks().length >= 2; },
        'a no-verdict crash gets a replacement without another body edit, and no replacement light reviewer was spawned',
        { signal: t.signal });
    }
    if (held) {
      await waitOnRepo(h, () => events().some((e) => e.cmd === 'review held'), 'no review hold was recorded', { signal: t.signal });
      const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_held' && i.task === 'T1');
      assert.ok(item, 'the held light reviewer is actionable despite the original failed verdict');
      assert.deepEqual(item.action.argv, ['accept', 'T1']);
      if (mode === 'crash-cap') {
        assert.equal(item.failures, require('../lib/reviewer').REVIEW_EXIT_CAP);
        assert.equal(checks().length, item.cap);
      } else assert.equal(checks().length, 1);
      assert.doesNotMatch(h.ok(['status']), /T1 \(fixing PR body\)/, 'an exited, held reviewer is not shown as running');
      assert.ok(!h.json(['inbox', '--agent', 'orchestrator']).items.some((i) => i.task === 'T1' && i.kind === 'review_failed'));
      const count = checks().length;
      consume();
      assert.equal(checks().length, count, 'a held reviewer is not replaced automatically');
      fs.writeFileSync(path.join(h.base, 'body-mode'), 'pass-first');
      h.ok(['accept', 'T1', '--agent', 'orchestrator']);
    } else {
      assert.ok(checks().length >= 2, 'a no-verdict crash gets a replacement without another body edit');
    }
    await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].status === 'accepted',
      'the recovered light review did not accept', { signal: t.signal });
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.sha, h.sha);
    assert.equal(task.revision, 1);
    assert.equal(events().filter((e) => e.cmd === 'spawn' && e.detail.body_fix).length, 1);
    assert.equal(require('../lib/review-body').failures(S.loadState(h.state), task), 0, 'no verdict does not count as a body-check failure');
    for (const check of checks()) {
      assert.equal(check.detail.sha, h.sha);
      assert.equal(check.detail.revision, 1);
    }
  });
}

test('a light-check monitor may finish its receipt, then a missing receipt triggers replacement', async (t) => {
  const h = fixture(t, 'clean-no-verdict');
  const events = () => S.readEvents(h.state);
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  fs.writeFileSync(path.join(h.base, 'body-release'), '');
  await waitOnRepo(h, () => events().some((e) => e.cmd === 'review held'), 'the first light check did not settle', { signal: t.signal });
  const prior = events().findLast((e) => e.cmd === 'spawn' && e.detail.body_recheck);
  const at = new Date().toISOString();
  const pending = { ...prior.detail, agent: 'missing-light-reviewer', pid: 999999, attempt: 1,
    monitor_pid: process.pid, monitor_start_ticks: require('../lib/processes').identity(process.pid).start_ticks };
  StateFiles.appendLog(h.state, JSON.stringify({ at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: pending }) + '\n');
  const checks = () => events().filter((e) => e.cmd === 'spawn' && e.detail.body_recheck);
  const count = checks().length;
  fs.writeFileSync(path.join(h.base, 'body-mode'), 'pass-first');
  h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.equal(checks().length, count, 'a live monitor gets time to record its receipt');
  assert.match(h.ok(['status']), /T1 \(fixing PR body\)/);
  const clock = path.join(__dirname, 'fixtures', 'clock.js');
  // Past the receipt window; a loaded host can need more than one pass to dispatch the replacement.
  await waitOnRepo(h, () => {
    h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'], {
      env: { NODE_OPTIONS: `${h.env.NODE_OPTIONS || ''} --require ${JSON.stringify(clock)}`,
        TOWER_CRANE_TEST_NOW: String(Date.parse(at) + 11 * 60000 + 8000) },
    });
    return checks().length > count;
  }, 'the expired receipt window never replaced the light reviewer', { signal: t.signal });
  assert.equal(checks().length, count + 1, 'the expired receipt window replaces the light reviewer once');
  assert.equal(events().filter((e) => e.cmd === 'review exit missing' && e.detail.agent === pending.agent).length, 1);
  await waitOnRepo(h, () => h.readState('tasks.json').tasks[0].status === 'accepted',
    'the replacement for the missing receipt did not accept', { signal: t.signal });
  assert.equal(events().filter((e) => e.cmd === 'spawn' && e.detail.body_fix).length, 1);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.sha, h.sha);
  assert.equal(task.revision, 1);
});

test('PR-body repair refuses pushes, submissions and PR changes other than its body', async (t) => {
  const h = fixture(t, 'pass-first');
  const job = { state: h.state, task: 'T1', agent: 'worker', role: 'worker', body_fix: true };
  await assert.rejects(G.push(job, {}, {}), /cannot push commits/);
  for (const command of ['claim', 'renew', 'release', 'submit']) {
    assert.throws(() => B.authorize(job, [command, 'T1']), new RegExp(`cannot ${command}`));
  }
  for (const args of [['pr', 'create'], ['pr', 'edit', '7', '--title', 'Changed'],
    ['pr', 'edit', '7', '--base', 'other']]) {
    assert.throws(() => G.ghCommand(job, args, {}), /permits only/);
  }
  assert.equal(G.ghCommand(job, ['pr', 'edit', '7', '--body', 'Corrected'], {}).parsed.command, 'pr edit');
});

test('status hides closed or day-old live spend while retaining totals', (t) => {
  const h = fixture(t, 'pass-first');
  const task = h.readState('tasks.json').tasks[0];
  const now = Date.now();
  for (const [status, age, visible] of [
    ['submitted', 1000, true], ['submitted', 86400000, true], ['submitted', 86400001, false],
    ['accepted', 1000, false], ['cancelled', 1000, false],
  ]) {
    const sample = structuredClone(task);
    sample.status = status;
    sample.spend = { ...task.spend, tokens: 123, entries: [{ agent: 'live-worker', at: new Date(now - age).toISOString(),
      tokens: 123, harness: 'command', live: { state: 'live', interval_ms: 1000 } }] };
    assert.equal(require('../lib/render').statusLiveSpend([sample], now).length > 0, visible, `${status}, age ${age}`);
    assert.equal(T.liveSpend(sample, now).length, 1, 'raw readings remain available to monitoring and task inspection');
    assert.equal(sample.spend.tokens, 123);
  }
  const state = h.readState('tasks.json');
  state.tasks[0].spend = { ...task.spend, tokens: 123, entries: [{ agent: 'stale-worker', source: 'fixture-live', minutes: 0,
    input: null, cached: null, output: null, rung: null, model: null, profile: null,
    at: new Date(now - 90000000).toISOString(), tokens: 123, harness: 'command',
    live: { state: 'live', interval_ms: 1000 } }] };
  h.writeState('tasks.json', state);
  assert.doesNotMatch(h.ok(['status']), /live spend:/);
  assert.equal(h.json(['status']).spend.tokens, 123);
});

test('runaway monitoring retains missing-usage warnings beyond the status cutoff', (t) => {
  const h = fixture(t, 'pass-first');
  const st = S.loadState(h.state);
  const original = T.getTask(st, 'T1');
  const now = Date.now();
  const results = [];
  for (const age of [60000, 86400000, 86400001, 10 * 86400000]) {
    const task = structuredClone(original);
    task.status = 'in_progress';
    task.claim = { agent: 'worker', since: new Date(now - age).toISOString(),
      until: new Date(now + 60000).toISOString(), from: 'todo' };
    task.spend.entries = [{ agent: 'worker', tokens: 123, at: new Date(now - age).toISOString(),
      harness: 'command', live: { state: 'live', interval_ms: 1000 } }];
    const flags = require('../lib/runaway').runaways({ ...st, tasks: { tasks: [task] } }, now).flags;
    results.push({ age, stale: flags.filter((f) => f.rule === 'stale').length });
  }
  assert.deepEqual(results, [60000, 86400000, 86400001, 10 * 86400000].map((age) => ({ age, stale: 1 })));
});
