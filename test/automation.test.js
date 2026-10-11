'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');
const { waitFor } = require('./canary');
const { shellQuote } = require('../lib/gates/common');

const ghStub = path.join(__dirname, 'fixtures', 'automation-gh.js');
const harness = path.join(__dirname, 'fixtures', 'automation-harness.js');

function setup(t, { kind = 'code', ci = 'success' } = {}) {
  const h = makeRepo(t);
  h.sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  const tools = path.join(h.base, 'tools');
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env node\nrequire(${JSON.stringify(ghStub)});\n`);
  fs.chmodSync(path.join(tools, 'gh'), 0o755);
  delete h.env.NODE_OPTIONS;
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(tools, 'gh.cmd'), `@"${process.execPath}" "${ghStub}" %*\r\n`);
    const preload = path.join(h.base, 'offline-gh.js');
    // Windows cannot spawn a .cmd directly. Resolve PATH first so agent
    // policy shims still run before the offline GitHub executable.
    fs.writeFileSync(preload, `const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),run=cp.spawnSync;
cp.spawnSync=(cmd,args,opts)=>{
  if(cmd!=='gh')return run(cmd,args,opts);
  const env=opts?.env||process.env;
  for(const dir of String(env.PATH||env.Path||'').split(path.delimiter)){
    for(const ext of ['.exe','.cmd','.bat']){
      const file=path.join(dir,cmd+ext);
      if(!fs.existsSync(file))continue;
      if(ext==='.exe')return run(file,args,opts);
      const quoted=[file,...args].map(arg=>'"'+String(arg).replace(/"/g,'""')+'"').join(' ');
      return run(env.ComSpec||env.COMSPEC||'cmd.exe',['/d','/s','/c','"'+quoted+'"'],
        {...opts,windowsVerbatimArguments:true});
    }
  }
  return run(cmd,args,opts);
};\n`);
    h.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  }
  h.env.AUTOMATION_GITHUB = path.join(h.base, 'github.json');
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.saveGithub({ root: h.repo, prs: { 7: {
    state: 'OPEN', headRefOid: h.sha, headRefName: 'fixture-change',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main',
  } }, ci: { [h.sha]: ci } });
  h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works', '--kind', kind]);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Change\n\nImplement the acceptance.\n' });
  h.submit = (id = 'T1', sha = h.sha, pr = '7') => {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', sha, '--pr', pr, '--agent', 'worker']);
  };
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return h;
}

test('submission runs real software gates once through the existing waiter', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['task', 'note', 'T1', 'live orchestrator', '--agent', 'orchestrator'], { env: { CLAUDE_SESSION_ID: 'holder' } });
  const holder = h.readState('tasks.json').orchestrator_lease;
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'owner'],
    { env: { CLAUDE_SESSION_ID: 'engine-waiter' } });
  h.submit();
  assert.equal(h.consume().code, 2);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, holder.session_id, 'automation inherits the holder');
  assert.deepEqual(h.readState('tasks.json').orchestrator_lease, holder, 'background gates do not extend the session idle window');
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true], ['ci', false]]);
  assert.ok(task.evidence.every((e) => e.commands.length && e.source === `check ${e.type}`));
  assert.equal(task.status, 'submitted');
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 3, 'duplicate event delivery runs no gate twice');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0, 'pending CI starts no model');
});

test('background reactions leave vacant, released, taken-over and expired leases available for handoff', (t) => {
  const h = setup(t, { ci: 'pending' });
  const lease = () => h.readState('tasks.json').orchestrator_lease ?? null;
  const holder = { env: { CLAUDE_SESSION_ID: 'holder' } };
  const acquire = () => h.ok(['task', 'note', 'T1', 'native session', '--agent', 'orchestrator'], holder);
  const react = (opts) => h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'owner'], opts);
  h.submit();
  react();
  assert.equal(lease(), null, 'a monitor cannot become the first orchestrator');
  acquire();
  const live = lease();
  react();
  assert.deepEqual(lease(), live, 'background work cannot renew the holder');
  h.ok(['orchestrator', 'release', '--agent', 'orchestrator'], holder);
  react();
  assert.equal(lease(), null, 'background work cannot undo release');
  acquire();
  h.ok(['orchestrator', 'takeover', '--agent', 'owner']);
  react();
  assert.equal(lease(), null, 'background work cannot undo takeover');
  acquire();
  const expired = lease();
  const env = {
    TOWER_CRANE_TEST_NOW: String(Date.parse(expired.heartbeat) + h.readState('project.json').limits.lease_minutes * 60000 + 1),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`,
  };
  react({ env });
  assert.deepEqual(lease(), expired, 'background work cannot revive an idle session');
  h.ok(['task', 'note', 'T1', 'replacement session', '--agent', 'orchestrator'],
    { env: { ...env, CLAUDE_SESSION_ID: 'replacement' } });
  assert.notEqual(lease().session_id, expired.session_id);
});

test('CI completion refreshes a pending or failed receipt at the exact head and merges after review', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.consume();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const bad = h.github();
  bad.ci[h.sha] = 'failure';
  h.saveGithub(bad);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  const good = h.github();
  good.ci[h.sha] = 'success';
  h.saveGithub(good);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'accepted');
  assert.deepEqual(task.evidence.filter((e) => e.type === 'ci').map((e) => e.ok), [false, false, true]);
  assert.equal(task.evidence.at(-1).type, 'merge');
  const calls = h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'merge');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--match-head-commit') + 1], h.sha);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', 'fffffff', '--agent', 'orchestrator']).code, 1);
  assert.equal(h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker']).code, 1);
});

test('a passing gate reruns in the next reaction after its pinned command changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new command');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.gate_policy.tests_cmd, 'node -e "process.exit(0)"');
});

test('a passing gate reruns in the next reaction after its tests mode changes', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(0)"', '--tests-mode', 'run-only']);
  h.submit();
  h.ok(['check', 'tests', 'T1']);
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const before = runs();
  h.ok(['project', 'set', '--tests-mode', 'none']);
  h.consume();
  assert.equal(runs(), before + 1, 'the reaction reruns tests under the new mode');
  const latest = h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest.tests_mode, 'none');
});

test('a failed gate at unchanged inputs waits for gates retry, which reruns it', (t) => {
  const h = setup(t, { ci: 'pending' });
  const marker = path.join(h.base, 'infra-failed-once');
  const script = path.join(h.base, 'flaky-tests.js');
  fs.writeFileSync(script, `const fs = require('node:fs');\nif (fs.existsSync(${JSON.stringify(marker)})) process.exit(0);\nfs.writeFileSync(${JSON.stringify(marker)}, '');\nprocess.exit(1);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`, '--tests-mode', 'run-only']);
  h.submit();
  const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
  const latest = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  h.consume();
  assert.equal(runs(), 1);
  assert.equal(latest().ok, false, 'the first run fails as infrastructure would');
  h.consume();
  assert.equal(runs(), 1, 'a failure at unchanged inputs is not retried without an explicit retry');
  assert.equal(h.run(['gates', 'retry', 'T1', '--agent', 'worker']).code, 1);
  assert.equal(runs(), 1);
  h.ok(['gates', 'retry', 'T1', '--agent', 'orchestrator']);
  assert.equal(runs(), 2);
  assert.equal(latest().ok, true, 'the retry at the same inputs passes');
});

test('gates retry exits nonzero while a retried gate still fails', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"', '--tests-mode', 'run-only']);
  h.submit();
  h.consume();
  const latest = () => h.readState('tasks.json').tasks[0].evidence.filter((e) => e.type === 'tests').at(-1);
  assert.equal(latest().ok, false);
  const retry = h.run(['gates', 'retry', 'T1', '--agent', 'orchestrator']);
  assert.equal(retry.code, 1, `a retry that still fails must exit nonzero: ${retry.stdout}${retry.stderr}`);
  assert.match(retry.stdout, /tests/);
  assert.equal(latest().ok, false, 'the retry ran at the same inputs and still fails');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
});

test('an accepted task with green gates merges in the event reaction without an agent turn', (t) => {
  const h = setup(t);
  h.submit();
  for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'orchestrator');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const spawns = () => h.logs().filter((e) => e.cmd === 'spawn').length;
  const recorded = spawns();
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const notification = JSON.parse(h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']));
  assert.equal(notification.type, 'merged', 'startup catches up accepted PRs and retains its automatic merge event');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(spawns(), recorded);
  h.consume();
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1);
});

test('a merge sends another conflicting PR to rework with real filenames and preserves its worktree', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'conflicting change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change' };
  github.advanceBase = true;
  h.saveGithub(github);
  h.submit('T2', other, '8');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const before = h.git(['status', '--porcelain']);
  h.consume();
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.match(fs.readFileSync(path.join(h.state, 'briefs', 'T2.md'), 'utf8'), /value\.js/);
  assert.equal(h.git(['status', '--porcelain']), before);
  assert.equal(h.git(['rev-parse', 'HEAD']), other);
  assert.equal(fs.readFileSync(path.join(h.repo, 'value.js'), 'utf8'), 'module.exports = 2;\n');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('worktree ').length - 1, 1);
});

test('startup reconciles a newly conflicting PR after a merge happened without a waiter', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.consume();
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 2;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'other submitted change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'works', '--kind', 'docs']);
  const state = h.github();
  state.prs['8'] = { ...state.prs['7'], headRefOid: other, headRefName: 'other-change' };
  h.saveGithub(state);
  h.submit('T2', other, '8');
  h.consume();
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[1].status, 'submitted');
  const ci = h.logs().findLast((e) => e.cmd === 'check ci' && e.task === 'T2');
  assert.ok(h.logs().some((e) => e.cmd === 'automation' && e.detail.source === ci.id && e.detail.phase === 'done'));

  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const changed = h.github();
  changed.advanceBase = true;
  h.saveGithub(changed);
  h.ok(['merge', 'T1', '--agent', 'orchestrator']);
  const conflicting = h.github();
  conflicting.prs['8'].mergeable = 'CONFLICTING';
  conflicting.prs['8'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  const before = h.git(['rev-parse', 'HEAD']);
  const event = JSON.parse(h.ok(['wait', '--types', 'rework', '--timeout', '5', '--agent', 'orchestrator']));
  assert.equal(event.task, 'T2');
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /value\.js/);
  assert.equal(h.git(['rev-parse', 'HEAD']), before);
});

test('a matching UNKNOWN head runs submission gates during the same wait', async (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
  state.becomeMergeableAfterView = true;
  h.saveGithub(state);
  const result = await h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0.2', '--agent', 'orchestrator']);
  assert.equal(result.code, 2, result.stderr);
  const task = h.readState('tasks.json').tasks[0];
  assert.deepEqual(task.evidence.filter((e) => ['tests', 'clean'].includes(e.type)).map((e) => [e.type, e.ok]),
    [['tests', true], ['clean', true]]);
  assert.equal(task.status, 'submitted');
  assert.equal(h.github().prs['7'].mergeable, 'MERGEABLE');
  assert.equal(h.logs().filter((e) => e.cmd === 'spawn').length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const unknown = h.github();
  unknown.prs['7'].mergeable = unknown.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(unknown);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted',
    'UNKNOWN still blocks acceptance even with earlier passing CI and independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a submitted PR that GitHub reports UNKNOWN, then CONFLICTING, goes to rework before any suite runs', (t) => {
  const h = setup(t);
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.git(['add', 'value.js']);
  h.git(['commit', '-qm', 'main moves value']);
  h.submit();
  const github = h.github();
  Object.assign(github.prs['7'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', unknownViews: 1 });
  h.saveGithub(github);
  h.consume();
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.match(task.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.logs().filter((e) => ['check tests', 'check clean'].includes(e.cmd)).length, 0, 'no suite or clean runs');
  assert.equal(h.github().calls.filter((a) => a[0] === 'pr' && a[1] === 'view').length, 2, 'the UNKNOWN read is retried once');
});

test('startup retains gate evidence when main moves and the submitted head stays mergeable', (t) => {
  const h = setup(t);
  h.submit();
  h.consume();
  const before = h.readState('tasks.json').tasks[0].evidence;
  h.git(['switch', 'main']);
  fs.appendFileSync(path.join(h.repo, 'README.md'), 'Independent base update.\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-qm', 'advance main']);
  h.consume();
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.evidence, before);
  assert.ok(after.gates.gates.filter((g) => g.type !== 'review').every((g) => g.ok));
});

test('stale or unknown PR heads and missing review never merge', (t) => {
  const h = setup(t);
  h.submit();
  const state = h.github();
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  assert.equal(h.readState('tasks.json').tasks[0].evidence.length, 0);
  state.prs['7'].headRefOid = h.sha;
  state.prs['7'].mergeable = 'UNKNOWN';
  state.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  state.prs['7'].mergeable = 'MERGEABLE';
  state.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(state);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted', 'green software gates still require independent review');
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false);
});

test('a completion webhook is only a hint, rejects another repository and ignores stale heads', (t) => {
  const h = setup(t, { kind: 'docs', ci: 'failure' });
  h.submit();
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  const payload = { repository: { full_name: 'acme/demo' }, action: 'completed',
    check_suite: { head_sha: h.sha, status: 'completed', conclusion: 'success' } };
  const deliver = () => h.run(['ci', 'webhook', '-', '--agent', 'orchestrator'], { input: JSON.stringify(payload) });
  assert.equal(deliver().code, 0);
  assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).ok, false, 'GitHub failure wins over payload success');
  payload.repository.full_name = 'acme/other';
  assert.equal(deliver().code, 1);
  payload.repository.full_name = 'acme/demo';
  payload.check_suite.head_sha = 'a'.repeat(40);
  assert.deepEqual(JSON.parse(h.ok(['ci', 'webhook', '-', '--json', '--agent', 'orchestrator'],
    { input: JSON.stringify(payload) })).tasks, []);
  payload.check_suite.head_sha = h.sha;
  const state = h.github();
  state.ci[h.sha] = 'success';
  h.saveGithub(state);
  assert.equal(deliver().code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('concurrent event consumers execute each submission gate only once', async (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const results = await Promise.all([
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']),
  ]);
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci']);
});

// A slow stub suite records each run's start and end, so the log shows how
// many gate executors ran at once across every consumer process.
function slowSuite(h, { executors, crash = false } = {}) {
  const runs = path.join(h.base, 'suite-runs.log');
  const suite = path.join(h.base, 'tools', 'slow-suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(runs)}, '+\\n');
const crash = ${JSON.stringify(crash ? path.join(h.base, 'crashed') : null)};
if (crash && !fs.existsSync(crash)) {
  fs.writeFileSync(crash, '');
  const events = fs.readFileSync(${JSON.stringify(path.join(h.state, 'events.jsonl'))}, 'utf8').trim().split('\\n').map(JSON.parse);
  process.kill(events.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
}
setTimeout(() => fs.appendFileSync(${JSON.stringify(runs)}, '-\\n'), 2500);
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    ...(executors ? ['--executors', String(executors)] : []), '--agent', 'orchestrator']);
  for (const id of ['T1', 'T2', 'T3']) {
    if (id !== 'T1') h.ok(['task', 'add', '--title', `Change ${id}`, '--acceptance', 'it works', '--kind', 'code']);
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  return () => {
    let now = 0;
    let peak = 0;
    const marks = fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').trim().split('\n') : [];
    for (const mark of marks) peak = Math.max(peak, now += mark === '+' ? 1 : -1);
    return { starts: marks.filter((m) => m === '+').length, peak };
  };
}

test('gate executors across several watchers stay within gates.executors and queue the rest in order', async (t) => {
  const h = setup(t);
  const runs = slowSuite(h);
  assert.match(h.ok(['project', 'show']), /gates\.executors: 2/);
  const results = await Promise.all([0, 1, 2].map(() =>
    h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'])));
  assert.ok(results.every((r) => r.code === 2), JSON.stringify(results));
  assert.deepEqual(runs(), { starts: 3, peak: 2 });
  const queued = h.logs().filter((e) => e.cmd === 'automation queued' && e.detail.executors === 2);
  assert.ok(queued.some((e) => e.task === 'T3'), JSON.stringify(queued));
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.equal(started.at(-1), 'T3', 'the queued submission runs after a slot frees');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

test('a killed executor releases its gate executor slot', (t) => {
  const h = setup(t);
  const runs = slowSuite(h, { executors: 1, crash: true });
  assert.notEqual(h.consume().code, 2, 'the suite kills the first executor');
  h.consume();
  assert.equal(runs().starts, 4, 'the killed run is retried and the other two run');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => e.type), ['tests', 'clean'], task.id);
  }
});

test('older queued work takes a freed executor slot before a newer arrival', async (t) => {
  const h = setup(t);
  const events = path.join(h.state, 'events.jsonl');
  const suite = path.join(h.base, 'tools', 'stall-suite.js');
  // The first run holds the only slot until T2 is queued behind it, then
  // dies, leaving a free slot and T2 still waiting.
  fs.writeFileSync(suite, `const fs = require('node:fs');
const flag = ${JSON.stringify(path.join(h.base, 'stalled'))};
if (fs.existsSync(flag)) process.exit(0);
fs.writeFileSync(flag, '');
const read = () => fs.readFileSync(${JSON.stringify(events)}, 'utf8').trim().split('\\n').map(JSON.parse);
const until = Date.now() + 20000;
const poll = () => {
  const log = read();
  if (log.some((e) => e.cmd === 'automation queued' && e.task === 'T2') || Date.now() > until) {
    process.kill(log.findLast((e) => e.cmd === 'automation' && e.detail.phase === 'running').detail.pid, 'SIGKILL');
    process.exit(1);
  }
  setTimeout(poll, 50);
};
poll();
`);
  h.ok(['project', 'set', '--tests-cmd', `node ${JSON.stringify(suite)}`, '--tests-mode', 'run-only',
    '--executors', '1', '--agent', 'orchestrator']);
  h.ok(['task', 'add', '--title', 'Change T2', '--acceptance', 'it works', '--kind', 'code']);
  h.ok(['task', 'add', '--title', 'Change T3', '--acceptance', 'it works', '--kind', 'code']);
  for (const id of ['T1', 'T2']) {
    h.ok(['claim', id, '--agent', 'worker']);
    h.ok(['submit', id, '--sha', h.sha, '--agent', 'worker']);
  }
  const holder = h.runAsync(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  assert.notEqual(await waitFor(path.join(h.base, 'stalled')), null, 'the first executor starts');
  h.consume();
  assert.notEqual((await holder).code, 2, 'the stalled executor is killed');
  assert.ok(h.logs().some((e) => e.cmd === 'automation queued' && e.task === 'T2' && e.detail.executors === 1));
  const offset = fs.statSync(events).size;
  h.ok(['claim', 'T3', '--agent', 'worker']);
  h.ok(['submit', 'T3', '--sha', h.sha, '--agent', 'worker']);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  const started = h.logs().filter((e) => e.cmd === 'automation' && e.detail.phase === 'running').map((e) => e.task);
  assert.deepEqual(started, ['T1', 'T1', 'T2', 'T3'], 'queued T1 and T2 run before the newer T3');
  for (const task of h.readState('tasks.json').tasks) {
    assert.deepEqual(task.evidence.map((e) => [e.type, e.ok]), [['tests', true], ['clean', true]], task.id);
  }
});

for (const reason of ['unknown mergeability', 'transport error']) {
  test(`startup retries ${reason} without a new lifecycle event`, (t) => {
    const h = setup(t, { kind: 'docs' });
    h.submit();
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    const state = h.github();
    if (reason === 'transport error') state.failView = true;
    else state.prs['7'].mergeable = state.prs['7'].mergeStateStatus = 'UNKNOWN';
    h.saveGithub(state);
    h.consume();
    assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
    assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase,
      reason === 'transport error' ? 'error' : 'deferred');
    const recovered = h.github();
    recovered.failView = false;
    recovered.prs['7'].mergeable = 'MERGEABLE';
    recovered.prs['7'].mergeStateStatus = 'CLEAN';
    h.saveGithub(recovered);
    h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.at(-1).type, 'merge');
    assert.equal(h.github().prs['7'].state, 'MERGED');
  });
}

test('startup confirms the accepted head after the executor dies between remote merge and receipt', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const crash = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { AUTOMATION_CRASH_AFTER_MERGE: '1' } });
  assert.notEqual(crash.code, 0);
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge'), false);
  assert.equal(h.logs().findLast((e) => e.cmd === 'automation').detail.phase, 'running');
  h.ok(['wait', '--types', 'merged', '--timeout', '5', '--agent', 'orchestrator']);
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sha, h.sha);
  assert.equal(receipt.ref, h.sha);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 1, 'confirmation does not repeat the remote merge');
});

test('a remotely merged different head produces failed merge evidence', (t) => {
  const h = setup(t, { kind: 'docs' });
  h.submit();
  h.ok(['check', 'ci', 'T1', '--agent', 'orchestrator']);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  const state = h.github();
  state.prs['7'].state = 'MERGED';
  state.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(state);
  h.consume();
  const receipt = h.readState('tasks.json').tasks[0].evidence.at(-1);
  assert.equal(receipt.type, 'merge');
  assert.equal(receipt.ok, false);
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
});

function configureHarness(h, { rules = false } = {}) {
  const home = path.join(h.base, 'home');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(h.env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), XDG_CONFIG_HOME: path.join(home, '.config'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), XDG_CACHE_HOME: path.join(home, '.cache'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), npm_config_cache: path.join(home, 'npm'),
    GH_TOKEN: 'automation-fixture', STUB_RUN: '[]',
    AUTOMATION_CONTEXT_DIR: path.join(h.base, 'context'),
  });
  fs.mkdirSync(h.env.AUTOMATION_CONTEXT_DIR);
  if (rules) fs.writeFileSync(path.join(h.base, 'AGENTS.md'), 'Read the acceptance before changing code.\n');
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  for (const rung of ['easy', 'review']) h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
    JSON.stringify([process.execPath, harness, BIN, 'auto', '{prompt}']),
    ...['model', 'profile', 'provider', 'effort', 'args'].flatMap((f) => ['--clear', f])]);
}

function startupContexts(h, withRules) {
  const startups = h.logs().filter((e) => e.cmd === 'startup');
  assert.deepEqual(startups.map((e) => e.detail.role), ['worker', 'reviewer']);
  for (const { task, detail } of startups) {
    const report = JSON.parse(fs.readFileSync(path.join(h.env.AUTOMATION_CONTEXT_DIR, `${detail.agent}.json`), 'utf8'));
    assert.equal(report.harness, 'command');
    assert.equal(report.args[2], report.prompt, 'the shared stub records the delivered argument');
    assert.match(report.prompt, /^## Goal\n/);
    assert.ok(report.prompt.includes(`Project goal: ${detail.goal}`));
    const target = JSON.parse(/## Task\s+```json\n([\s\S]*?)\n```/.exec(report.prompt)[1]);
    assert.equal(target.id, task);
    assert.equal(target.title, detail.target.title);
    assert.equal(target.acceptance.length, detail.target.acceptance);
    assert.equal(detail.receives_prompt, true);
    assert.equal(detail.prompt_bytes, Buffer.byteLength(report.prompt));
    assert.equal(detail.prompt_tokens, Math.ceil(detail.prompt_bytes / 4));
    assert.equal(report.prompt.includes('## House rules'), withRules);
    if (withRules) {
      assert.ok(detail.rules.some((r) => r.path === path.join(h.base, 'AGENTS.md') && r.loaded === 'read'));
      for (const rule of detail.rules) assert.ok(report.prompt.includes(rule.path));
    } else {
      assert.deepEqual(detail.rules, []);
      assert.equal(detail.rules_bytes, 0);
      assert.equal(detail.rules_tokens, 0);
    }
  }
}

test('a worker identity cannot authorize reactions by passing the orchestrator name', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const result = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator'],
    { env: { TOWER_CRANE_AGENT: 'worker', TOWER_CRANE_TASK: 'T1' } });
  assert.equal(result.code, 2);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
});

test('a worker that names its own identity cannot complete CI or run reactions as the orchestrator', (t) => {
  const h = setup(t, { ci: 'pending' });
  h.submit();
  const worker = { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } };
  const completed = h.run(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'worker-T1-1'], worker);
  assert.equal(completed.code, 1, completed.stderr);
  assert.match(completed.stderr, /ci completed is an orchestrator or owner command/);
  const waited = h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'worker-T1-1'], worker);
  assert.equal(waited.code, 2, waited.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  assert.equal(h.logs().filter((e) => e.cmd === 'ci completed').length, 0);
  h.consume();
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.map((e) => e.type), ['tests', 'clean', 'ci'],
    'the orchestrator still runs the reactions');
});

test('supervisor reactions pin unconfigured gates and bypass the real restrictive agent shims', async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test/value.test.js' } }));
  h.git(['add', 'package.json']);
  h.git(['commit', '-qm', 'detectable test command']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  const state = h.github();
  state.prs['7'].headRefOid = h.sha;
  h.saveGithub(state);
  h.ok(['project', 'set', '--tests-cmd', 'null', '--clean-cmd', 'null']);
  configureHarness(h);
  h.env.AUTOMATION_POLICY_PROBE = path.join(h.base, 'policy-probe.jsonl');
  h.ok(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator']);
  const deadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > deadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const pins = h.logs().filter((e) => e.cmd === 'gates pin');
  assert.deepEqual(pins.map((e) => e.detail.key), ['tests_cmd', 'clean_cmd']);
  assert.ok(pins.every((e) => e.agent === 'orchestrator' && e.detail.authority === 'orchestrator'));
  const probes = fs.readFileSync(h.env.AUTOMATION_POLICY_PROBE, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.denials.every((d) => d.status === 126 && /not allowed/.test(d.stderr))), JSON.stringify(probes));
  assert.ok(probes.every((p) => p.path.includes(path.join(h.state, 'homes'))));
  startupContexts(h, false);
});

test('a supervised worker submission runs gates and dispatches the offline reviewer after exit', async (t) => {
  const h = setup(t);
  configureHarness(h, { rules: true });
  const hold = path.join(h.base, 'worker-hold');
  const spawned = h.runAsync(['spawn', '--task', 'T1', '--wait', '--agent', 'orchestrator'],
    { env: { AUTOMATION_WORKER_HOLD: hold } });
  const deadline = Date.now() + 60000;
  try {
    while (!fs.existsSync(hold)) {
      if (Date.now() > deadline) throw new Error('worker did not submit');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    h.consume();
    assert.equal(h.logs().filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 0,
      'a worker still running after submit blocks review dispatch');
  } finally {
    fs.writeFileSync(`${hold}.go`, '');
    assert.equal((await spawned).code, 0);
  }
  // Reviewer completion has its own CLI command deadline after worker exit.
  const reviewDeadline = Date.now() + 60000;
  while (!h.readState('tasks.json').tasks[0].evidence.some((e) => e.type === 'merge' && e.ok)) {
    if (Date.now() > reviewDeadline) throw new Error(JSON.stringify(h.logs().slice(-10)));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const events = h.logs();
  const review = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer');
  const exit = events.findIndex((e) => e.cmd === 'spawn exit' && e.detail.role === 'worker');
  assert.ok(review > exit);
  const workerStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'worker');
  const worker = events.findIndex((e) => e.cmd === 'spawn' && e.detail.role === 'worker');
  const reviewStartup = events.findIndex((e) => e.cmd === 'startup' && e.detail.role === 'reviewer');
  assert.ok(workerStartup >= 0 && workerStartup < worker && worker < exit);
  assert.ok(reviewStartup > exit && reviewStartup < review);
  startupContexts(h, true);
  assert.equal(events.filter((e) => e.cmd === 'spawn' && e.detail.role === 'reviewer').length, 1);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

// A second PR that touches other files, and a suite command that logs each
// run with PR #7's state at that moment.
function queueFixture(t) {
  const h = setup(t);
  h.git(['switch', '-qc', 'second-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.js'), 'module.exports = 2;\n');
  fs.mkdirSync(path.join(h.repo, 'test'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'test', 'other.test.js'), "require('node:assert/strict').equal(require('../other'), 2);\n");
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'second change']);
  h.second = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'works']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: h.second, headRefName: 'second-change' };
  github.ci[h.second] = 'success';
  h.saveGithub(github);
  h.suiteLog = path.join(h.base, 'suites.jsonl');
  const suite = path.join(h.base, 'suite.js');
  fs.writeFileSync(suite, `const fs = require('node:fs'), path = require('node:path');
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(h.env.AUTOMATION_GITHUB)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(h.suiteLog)}, JSON.stringify({ pr7: gh.prs['7'].state }) + '\\n');
// A gate run that fails once, as gates did for tasks accepted before evidence.
const failOnce = ${JSON.stringify(path.join(h.base, 'fail-once'))};
if (fs.existsSync(failOnce)) { fs.rmSync(failOnce); process.exit(1); }
// One run moves main while it runs, as another merge landing would.
if (fs.existsSync(${JSON.stringify(path.join(h.base, 'move-main-once'))})) {
  fs.rmSync(${JSON.stringify(path.join(h.base, 'move-main-once'))});
  const git = (a) => require('node:child_process').execFileSync('git', ['-C', ${JSON.stringify(h.repo)}, ...a], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/main', git(['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'lands during the check'])]);
}
// Another CLI acting while the suite runs.
const during = ${JSON.stringify(path.join(h.base, 'during-check.js'))};
if (fs.existsSync(during)) {
  const script = during + '.ran';
  fs.renameSync(during, script);
  require(script);
}
for (const f of fs.readdirSync('test')) if (f.endsWith('.test.js')) require(path.resolve('test', f));
`);
  h.ok(['project', 'set', '--tests-cmd', `${shellQuote(process.execPath)} ${shellQuote(suite)}`]);
  h.suites = () => (fs.existsSync(h.suiteLog)
    ? fs.readFileSync(h.suiteLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  h.moveMain = (file = 'README.md', text = 'Independent base update.\n') => {
    h.git(['switch', '-q', 'main']);
    fs.appendFileSync(path.join(h.repo, file), text);
    h.git(['add', file]);
    h.git(['commit', '-qm', 'advance main']);
  };
  h.submit();
  h.submit('T2', h.second, '8');
  h.consume();
  for (const id of ['T1', 'T2']) {
    const gates = h.json(['task', 'show', id]).gates.gates;
    assert.ok(gates.filter((g) => g.type !== 'review').every((g) => g.ok), JSON.stringify(gates));
  }
  return h;
}

const headChecks = (h) => h.logs().filter((e) => e.cmd === 'head check');
const softwareEvidence = (h, id) => h.readState('tasks.json').tasks.find((x) => x.id === id).evidence
  .filter((e) => ['tests', 'clean', 'ci'].includes(e.type));

function acceptBoth(h) {
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.reviewer('T2', 'reviewer');
  h.ok(['evidence', 'T2', '--type', 'review', '--sha', h.second, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);
}

test('main moves: a mergeable PR keeps its evidence and merges after one head-of-line check', (t) => {
  const h = queueFixture(t);
  const before = softwareEvidence(h, 'T1');
  h.moveMain();
  const suites = h.suites().length;
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.deepEqual(softwareEvidence(h, 'T1'), before, 'a base move reruns no gate and resets no evidence');
  assert.equal(h.github().prs['7'].state, 'MERGED');
  assert.equal(h.suites().length - suites, 1);
  const checks = headChecks(h);
  assert.deepEqual(checks.map((e) => [e.task, e.detail.ok, e.detail.base_sha]), [['T1', true, h.git(['rev-parse', 'main'])]]);
  assert.ok(checks[0].detail.commands.some((c) => c.args.includes('merge')));
  h.consume();
  assert.equal(headChecks(h).length, 1, 'a repeated reaction does not run the suite again');
});

test('the head of the line that turns CONFLICTING goes to rework with its files and the next PR merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const github = h.github();
  github.prs['7'].mergeable = 'CONFLICTING';
  github.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.match(t1.notes.at(-1).text, /conflicts with main: value\.js/);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(headChecks(h).map((e) => e.task), ['T2']);
});

test('two queued PRs run exactly one full suite each at their turn and none before', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const suites = h.suites().length;
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  blocked.advanceBase = true;
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.suites().length, suites, 'nothing runs while the head of the line waits');
  assert.equal(headChecks(h).length, 0);
  assert.equal(h.github().calls.some((a) => a[1] === 'merge'), false, 'the second PR does not jump the line');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(stopped.detail.blocked.task, 'T1');
  assert.match(stopped.detail.blocked.reason, /mergeability of PR #7 is UNKNOWN/);

  const ready = h.github();
  ready.prs['7'].mergeable = 'MERGEABLE';
  ready.prs['7'].mergeStateStatus = 'CLEAN';
  h.saveGithub(ready);
  h.ok(['wait', '--types', 'merged', '--task', 'T2', '--timeout', '10', '--agent', 'orchestrator']);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['7', '8']);
  assert.deepEqual(h.suites().slice(suites), [{ pr7: 'OPEN' }, { pr7: 'MERGED' }],
    'T1 runs its suite before merging; T2 runs its suite only after T1 merged');
  assert.deepEqual(headChecks(h).map((e) => [e.task, e.detail.ok]), [['T1', true], ['T2', true]]);
  assert.equal(headChecks(h)[1].detail.base_sha, h.sha, 'T2 is checked against main after T1 landed');
});

test('a base that moves during the head check gets a new check before the merge', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  fs.writeFileSync(path.join(h.base, 'move-main-once'), '');
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const checks = headChecks(h);
  assert.equal(checks.length, 2, 'the check against the old base does not authorize the merge');
  assert.notEqual(checks[0].detail.base_sha, checks[1].detail.base_sha);
  assert.equal(checks[1].detail.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('a head replaced during its check is checked again at the new sha before the merge', (t) => {
  const h = queueFixture(t);
  h.git(['switch', '-q', 'fixture-change']);
  fs.writeFileSync(path.join(h.repo, 'NOTES.md'), 'Replacement head.\n');
  h.git(['add', 'NOTES.md']);
  h.git(['commit', '-qm', 'replacement head']);
  const replacement = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.moveMain();
  // The owner reworks and reaccepts T1 at a new head while its suite runs.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process'), fs = require('node:fs');
const env = ${JSON.stringify(h.env)};
const cli = (...a) => cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, ...a], { cwd: ${JSON.stringify(h.repo)}, env, encoding: 'utf8' });
const file = env.AUTOMATION_GITHUB;
cli('rework', 'T1', '--reason', 'replace the head', '--agent', 'owner');
const gh = JSON.parse(fs.readFileSync(file, 'utf8'));
gh.prs['7'].headRefOid = ${JSON.stringify(replacement)};
gh.ci[${JSON.stringify(replacement)}] = 'success';
fs.writeFileSync(file, JSON.stringify(gh));
cli('claim', 'T1', '--agent', 'worker');
cli('submit', 'T1', '--sha', ${JSON.stringify(replacement)}, '--pr', '7', '--agent', 'worker');
for (const gate of ['tests', 'clean', 'ci']) cli('check', gate, 'T1', '--agent', 'owner');
const events = ${JSON.stringify(path.join(h.state, 'events.jsonl'))};
const revision = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h.state, 'tasks.json'))}, 'utf8')).tasks.find((x) => x.id === 'T1').revision;
const at = new Date().toISOString();
fs.appendFileSync(events, [
  { at, agent: 'orchestrator', cmd: 'spawn', task: 'T1', detail: { agent: 'reviewer', role: 'reviewer', rung: 'review', sha: ${JSON.stringify(replacement)}, revision, pid: 999999, attempt: 1 } },
  { at, agent: 'orchestrator', cmd: 'spawn exit', task: 'T1', detail: { agent: 'reviewer', pid: 999999, attempt: 1, code: 0 } },
].map((e) => JSON.stringify(e) + '\\n').join(''));
cli('evidence', 'T1', '--type', 'review', '--sha', ${JSON.stringify(replacement)}, '--ok', '--agent', 'reviewer');
cli('accept', 'T1', '--agent', 'owner');
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the replacement ran during the check');
  assert.deepEqual(headChecks(h).map((e) => [e.detail.sha, e.detail.ok]), [[h.sha, true], [replacement, true]],
    'the check of the old head does not authorize merging the new one');
  const merges = h.github().calls.filter((a) => a[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0][merges[0].indexOf('--match-head-commit') + 1], replacement);
  const order = h.logs().filter((e) => e.cmd === 'head check' || e.cmd === 'merge').map((e) => e.cmd);
  assert.deepEqual(order, ['head check', 'head check', 'merge']);
});

test('a head that stops the line and then goes to rework lets the PR behind it merge', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const blocked = h.github();
  blocked.prs['7'].mergeable = blocked.prs['7'].mergeStateStatus = 'UNKNOWN';
  h.saveGithub(blocked);
  h.consume();
  assert.equal(h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').detail.blocked.task, 'T1');
  assert.equal(h.github().prs['8'].state, 'OPEN');

  fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 3;\n');
  h.moveMain('value.js', '');
  const conflicting = h.github();
  conflicting.prs['7'].mergeable = 'CONFLICTING';
  conflicting.prs['7'].mergeStateStatus = 'DIRTY';
  h.saveGithub(conflicting);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.status, 'rework');
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
});

test('a merged-head suite timeout stops the queue without reworking an accepted task', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  h.ok(['project', 'set', '--tests-timeout-min', '0.05', '--agent', 'orchestrator']);
  fs.appendFileSync(path.join(h.base, 'suite.js'), `
console.log('# Subtest: test/slow.test.js');
setTimeout(() => {}, 10000);
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  const check = headChecks(h).at(-1).detail;
  assert.equal(check.ok, false);
  assert.equal(check.infrastructure_failure, true);
  assert.equal(check.timeout.minutes, 0.05);
  assert.deepEqual(check.timeout.running_files, ['test/slow.test.js']);
  assert.match(check.summary, /timed out after 0\.05 min/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.github().calls.filter((a) => a[1] === 'merge').length, 0);
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /timed out after 0\.05 min/);
});

test('a head check that fails after its settings changed checks again under the current settings', (t) => {
  const h = queueFixture(t);
  h.moveMain();
  const cmd = h.readState('project.json').gates.tests_cmd;
  // The suite fails, but only after the owner replaces the tests command.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const cp = require('node:child_process');
cp.execFileSync(process.execPath, [${JSON.stringify(BIN)}, 'project', 'set', '--tests-cmd', ${JSON.stringify(`${cmd} again`)}, '--agent', 'owner'],
  { cwd: ${JSON.stringify(h.repo)}, env: ${JSON.stringify(h.env)}, encoding: 'utf8' });
process.exitCode = 1;
`);
  h.reviewer('T1', 'reviewer');
  h.ok(['evidence', 'T1', '--type', 'review', '--sha', h.sha, '--ok', '--agent', 'reviewer']);
  h.consume();
  assert.equal(fs.existsSync(path.join(h.base, 'during-check.js.ran')), true, 'the settings changed during the check');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted', 'the stale failure sends nothing to rework');
  const stopped = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.match(stopped.detail.blocked.reason, /tests evidence command policy/, 'the line restarted on the current command');

  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  h.consume();
  assert.deepEqual(headChecks(h).map((e) => [e.detail.command, e.detail.ok]), [[cmd, false], [`${cmd} again`, true]]);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

test('an accepted PR that already merged without current evidence is confirmed and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  // T1 is a legacy task: its tests evidence no longer passes and its PR
  // landed on GitHub before tower-crane recorded merge evidence.
  fs.writeFileSync(path.join(h.base, 'fail-once'), '');
  h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, false);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].mergeCommit = { oid: 'c'.repeat(40) };
  h.saveGithub(github);
  h.consume();
  const [t1, t2] = h.readState('tasks.json').tasks;
  const receipt = t1.evidence.at(-1);
  assert.deepEqual([receipt.type, receipt.ok, receipt.sha, receipt.ref], ['merge', true, h.sha, 'c'.repeat(40)]);
  assert.equal(t2.evidence.at(-1).type, 'merge');
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8'], 'the landed PR is not merged again');
  assert.equal(h.logs().filter((e) => e.cmd === 'queue skipped').length, 0);
});

test('a head the queue cannot advance is reported once and the PR behind it merges', (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  const github = h.github();
  github.prs['7'].state = 'MERGED';
  github.prs['7'].headRefOid = 'f'.repeat(40);
  h.saveGithub(github);
  h.consume();
  assert.equal(h.github().prs['8'].state, 'MERGED');
  assert.equal(h.readState('tasks.json').tasks[1].evidence.at(-1).type, 'merge');
  const done = h.logs().findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
  assert.equal(done.detail.blocked.task, 'T1');
  assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);
  h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
  const skips = h.logs().filter((e) => e.cmd === 'queue skipped');
  assert.deepEqual(skips.map((e) => [e.task, e.detail.sha]), [['T1', h.sha]], 'a later pass does not report the same head again');
  assert.match(skips[0].detail.reason, /merged with head f+, not the accepted/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

for (const failure of ['failView', 'invalidView']) {
  test(`an unreadable queue head (${failure}) is skipped once and the ready PR behind it merges`, (t) => {
    const h = queueFixture(t);
    acceptBoth(h);
    const github = h.github();
    github.prs['7'][failure] = true;
    h.saveGithub(github);
    const offset = h.logs().length;

    h.ok(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
    assert.equal(h.github().prs['8'].state, 'MERGED');
    const [t1, t2] = h.readState('tasks.json').tasks;
    assert.equal(t1.status, 'accepted');
    assert.ok(!t1.evidence.some((e) => e.type === 'merge'));
    assert.equal(t2.evidence.at(-1).type, 'merge');
    assert.equal(t2.evidence.at(-1).ok, true);
    const done = h.logs().slice(offset).findLast((e) => e.cmd === 'merge queue' && e.detail.phase === 'done');
    assert.equal(done.detail.blocked.task, 'T1');
    assert.deepEqual(done.detail.skipped.map((s) => s.task), ['T1']);

    // The confirmed merge event starts another pass while T1 is still unreadable.
    h.consume();
    const events = h.logs().slice(offset);
    assert.ok(events.filter((e) => e.cmd === 'merge queue' && e.detail.phase === 'done').length >= 2);
    assert.ok(!events.some((e) => e.cmd === 'merge queue' && e.detail.phase === 'error'));
    const skips = events.filter((e) => e.cmd === 'queue skipped');
    assert.deepEqual(skips.map((e) => [e.task, e.detail.sha, e.detail.revision]), [['T1', h.sha, t1.revision]]);
    assert.match(skips[0].detail.reason, failure === 'failView'
      ? /Could not resolve PullRequest number 7/ : /cannot read PR #7 mergeability/);
    assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8']);
  });
}

test('a concurrent CI completion retries a skipped head in the next drain pass', async (t) => {
  const h = queueFixture(t);
  acceptBoth(h);
  h.moveMain();
  const failed = h.github();
  failed.ci[h.sha] = 'failure';
  h.saveGithub(failed);
  assert.equal(h.run(['check', 'ci', 'T1', '--agent', 'orchestrator']).code, 1);
  const green = h.github();
  green.ci[h.sha] = 'success';
  h.saveGithub(green);

  const paused = path.join(h.base, 'queue-paused');
  const resume = path.join(h.base, 'queue-resume');
  // Hold T2's head check after T1 is skipped, until a second command
  // records T1's passing CI and requests another queue pass.
  fs.writeFileSync(path.join(h.base, 'during-check.js'), `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(paused)}, '');
const until = Date.now() + 20000;
const poll = () => {
  if (fs.existsSync(${JSON.stringify(resume)})) return;
  if (Date.now() > until) throw new Error('queue was not resumed');
  setTimeout(poll, 25);
};
poll();
`);
  const offset = h.logs().length;
  const first = h.runAsync(['ci', 'completed', 'T2', '--sha', h.second, '--agent', 'orchestrator']);
  let result;
  try {
    assert.notEqual(await waitFor(paused), null, 'T2 holds the queue after T1 is skipped');
    const skipped = h.logs().slice(offset).find((e) => e.cmd === 'queue skipped');
    assert.equal(skipped?.task, 'T1');
    assert.match(skipped.detail.reason, /ci: latest ci .* failed/);
    h.ok(['ci', 'completed', 'T1', '--sha', h.sha, '--agent', 'orchestrator']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
    assert.ok(h.logs().slice(offset).some((e) => e.cmd === 'merge queue' && e.detail.phase === 'requested'));
  } finally {
    fs.writeFileSync(resume, '');
    result = await first;
  }
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.github().calls.filter((a) => a[1] === 'merge').map((a) => a[2]), ['8', '7'],
    'both commands finish with both PRs merged, without a later notification');
  for (const task of h.readState('tasks.json').tasks) {
    const receipt = task.evidence.findLast((e) => e.type === 'merge');
    assert.equal(receipt?.ok, true, task.id);
    assert.equal(receipt.sha, task.sha);
  }
  const events = h.logs().slice(offset);
  assert.equal(events.filter((e) => e.cmd === 'queue skipped').length, 1);
  const passes = events.filter((e) => e.cmd === 'merge queue');
  assert.equal(passes.filter((e) => e.detail.phase === 'running').length, 2);
  assert.equal(passes.at(-1).detail.phase, 'done');
  assert.equal(passes.at(-1).detail.blocked, null);
  assert.deepEqual(passes.at(-1).detail.skipped, []);
});
