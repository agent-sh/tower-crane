'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture, BIN } = require('./helpers');
const { setup, configureHarness } = require('./automation-helpers');
const { waitOnRepo } = require('./signals');
const S = require('../lib/state');
const T = require('../lib/tasks');
const G = require('../lib/github-broker');
const B = require('../lib/broker');

const finding = { kind: 'false-claim', path: 'PR body', claim: 'The body claims an unmeasured result.' };

function fixture(t, mode) {
  const h = cachedFixture(t, 'automatic body repair', (repo) => {
    const h = setup(null, { kind: 'docs', repo });
    configureHarness(h);
    h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
    const github = h.github();
    github.prs[7].body = 'An unmeasured result.';
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
    updateJson(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, (s) => {
      if (mode !== 'unchanged') s.prs[7].body += '\\nCorrected claim.';
      if (mode === 'remote-commit') s.prs[7].headRefOid = cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
      return s;
    });
  };
  repair();
} else {
  if (!prompt.includes('## Light claim check')) process.exit(4);
  fs.appendFileSync(${JSON.stringify(path.join(h.base, 'body-checks'))}, prompt + '\\n');
  const s = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
  const round = s.prs[7].body.split('Corrected claim.').length - 1;
  const ok = mode === 'pass-first' || mode === 'pass-second' && round === 2;
  const args = [${JSON.stringify(BIN)}, 'evidence', 'T1', '--type', 'review', ok ? '--ok' : '--fail',
    '--sha', ${JSON.stringify(h.sha)}, '--summary', ok ? 'Corrected claims verified.' : 'The body still claims an unmeasured result.'];
  if (!ok) args.push('--findings', ${JSON.stringify(JSON.stringify([finding]))});
  const r = cp.spawnSync(process.execPath, args, {env:fakeAgentEnv(process.env),stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`);
    h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, script, '{prompt}'])]);
    h.reviewer('T1', 'first-reviewer', h.sha);
    h.ok(['evidence', 'T1', '--agent', 'first-reviewer', '--type', 'review', '--fail', '--sha', h.sha,
      '--summary', 'The body claims an unmeasured result.', '--findings', JSON.stringify([finding])]);
    return { sha: h.sha };
  });
  fs.writeFileSync(path.join(h.base, 'body-mode'), mode);
  return h;
}

for (const mode of ['pass-first', 'pass-second', 'fail-twice', 'local-commit', 'remote-commit', 'unchanged']) {
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
    const changedHead = mode.endsWith('commit');
    const passes = mode.startsWith('pass');
    await waitOnRepo(h, () => {
      const st = S.loadState(h.state);
      const task = T.getTask(st, 'T1');
      return changedHead ? task.status === 'rework' : passes ? task.status === 'accepted'
        : require('../lib/review-body').state(st, task)?.stuck;
    }, 'body repair did not reach its terminal state', { signal: t.signal });
    const st = S.loadState(h.state);
    const task = T.getTask(st, 'T1');
    const fixes = logs().filter((e) => e.cmd === 'spawn' && e.detail.body_fix);
    const checks = logs().filter((e) => e.cmd === 'spawn' && e.detail.body_recheck);
    assert.equal(fixes.length, ['pass-second', 'fail-twice'].includes(mode) ? 2 : 1);
    assert.equal(checks.length, changedHead || mode === 'unchanged' ? 0 : fixes.length);
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
    } else if (!changedHead) {
      const item = h.json(['inbox', '--agent', 'orchestrator']).items.find((i) => i.kind === 'review_body_stuck');
      assert.deepEqual(item.blockers, [finding]);
      if (mode === 'fail-twice') assert.match(item.findings, /The body still claims/);
      assert.match(item.reason, mode === 'unchanged' ? /without changing/ : /two consecutive/);
      h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
      assert.equal(logs().filter((e) => e.cmd === 'spawn' && e.detail.body_fix).length, fixes.length);
    }
    assert.deepEqual(task.escalations || [], []);
  });
}

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
  const file = path.join(h.state, 'tasks.json');
  const state = h.readState('tasks.json');
  state.tasks[0].spend = { ...task.spend, tokens: 123, entries: [{ agent: 'stale-worker', source: 'fixture-live', minutes: 0,
    input: null, cached: null, output: null, rung: null, model: null, profile: null,
    at: new Date(now - 90000000).toISOString(), tokens: 123, harness: 'command',
    live: { state: 'live', interval_ms: 1000 } }] };
  fs.writeFileSync(file, JSON.stringify(state));
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
