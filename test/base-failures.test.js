'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CI = require('../lib/gates/ci');
const T = require('../lib/tasks');
const { cachedFixture } = require('./helpers');
const { setup } = require('./automation-helpers');
const { shellQuote } = require('../lib/gates/common');

const SHA = 'a'.repeat(40);
const ERROR = 'Error: shared fixture is missing';
const failedLog = (name = 'base test', error = ERROR) => `✖ ${name} (1ms)\n  ${error}\n`;
const run = (id, event, hours, extra = {}) => ({ id, workflow_id: 5, head_branch: 'main', head_sha: SHA,
  event, status: 'completed', conclusion: 'failure', created_at: `2026-10-21T${hours}:00:00Z`, ...extra });

test('base selection uses the newer complete daily or merge-base push, including a green replacement', () => {
  const push = run(1, 'push', '10');
  const daily = run(2, 'schedule', '11');
  for (const [label, runs, ids] of [
    ['newer daily', [push, daily], [2]],
    ['newer push', [daily, run(3, 'push', '12')], [3]],
    ['incomplete daily', [push, { ...daily, status: 'in_progress' }], [1]],
    ['different push commit', [push, run(3, 'push', '12', { head_sha: 'b'.repeat(40) })], [1]],
    ['different branch', [push, { ...daily, head_branch: 'other' }], [1]],
    ['newer green daily clears red', [push, { ...daily, conclusion: 'success' }], [2]],
    ['PR does not count', [push, run(3, 'pull_request', '12')], [1]],
    ['old scheduled evidence', [push, run(3, 'schedule', '09')], [1]],
    ['old schedule rerun recently', [push, run(3, 'schedule', '09', { updated_at: '2026-10-21T12:00:00Z' })], [1]],
  ]) assert.deepEqual(CI.selectBaseRuns(runs, 'main', SHA, '2026-10-21T10:00:00Z').map((r) => r.id), ids, label);
  assert.deepEqual(CI.selectBaseRuns([push], 'main', SHA, 'invalid'), []);
});

test('matching a base failure preserves run, test and error, and keeps new or different failures', () => {
  const base = { ...run(2, 'schedule', '11'), jobs: [{ name: 'test (linux, shard 1/3)', tests: [{ name: 'base test', error: ERROR }] }] };
  for (const [label, failures, job, count] of [
    ['same test and error', [{ name: 'base test', error: ERROR }], 'test (linux, shard 2/3)', 1],
    ['new test', [{ name: 'new test', error: ERROR }], 'test (linux)', 0],
    ['new error', [{ name: 'base test', error: 'Error: different cause' }], 'test (linux)', 0],
    ['missing error', [{ name: 'base test', error: null }], 'test (linux)', 0],
    ['another platform', [{ name: 'base test', error: ERROR }], 'test (windows)', 0],
    ['mixed old and new', [{ name: 'base test', error: ERROR }, { name: 'new test', error: ERROR }], null, 1],
  ]) {
    const result = CI.matchBaseFailures(failures, [base], job);
    assert.equal(result.length, count, label);
    if (count) {
      assert.equal(result[0].base_run.id, 2);
      assert.equal(result[0].error, ERROR);
      assert.equal(result[0].classification, 'base_failure');
    }
  }
});

function fixture(t) {
  const h = cachedFixture(t, 'base failure gates', (repo) => {
    const h = setup(null, { repo, ci: 'pending' });
    h.ok(['project', 'set', '--tests-mode', 'run-only']);
    return { sha: h.sha };
  });
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.submit = () => {
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
  };
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  h.consume = () => h.run(['wait', '--after', '0', '--types', 'never', '--timeout', '0', '--agent', 'orchestrator']);
  return h;
}

function baseState(h) {
  const state = h.github();
  state.baseRuns = [run(200, 'push', '10', { head_sha: h.git(['rev-parse', 'main']), created_at: new Date().toISOString() })];
  state.baseJobs = { 200: [{ id: 201, name: 'test', status: 'completed', conclusion: 'failure' }] };
  state.jobLogs = { 201: failedLog() };
  h.saveGithub(state);
}

test('real tests gate records base failure, stays submitted, and updates one fix task on a second occurrence', (t) => {
  const h = fixture(t);
  const script = path.join(h.base, 'failure.js');
  fs.writeFileSync(script, `console.log(${JSON.stringify(failedLog())}); process.exit(1);\n`);
  h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
  baseState(h);
  h.submit();
  h.consume();
  let task = h.json(['task', 'show', 'T1']);
  assert.equal(task.status, 'submitted');
  const entry = task.evidence.findLast((e) => e.type === 'tests');
  assert.equal(entry.ok, true, entry.summary);
  assert.equal(entry.base_failure[0].base_run.id, 200);
  const fix = entry.base_failure[0].fix_task;
  const priorNotes = h.readState('tasks.json').tasks.find((t) => t.id === fix).notes.filter((n) => n.text.startsWith('T1 tests at ')).length;
  h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  const tasks = h.readState('tasks.json').tasks;
  assert.equal(tasks.filter((t) => t.title === 'base test fails on main').length, 1);
  assert.equal(tasks.find((t) => t.id === fix).notes.filter((n) => n.text.startsWith('T1 tests at ')).length, priorNotes + 1);
  const status = h.json(['status']);
  assert.equal(status.base_failures.find((f) => f.task === 'T1').fix_task, fix);
  assert.match(h.ok(['status']), /T1 tests: base_failure base test, run 200, fix task T\d+/);
  task = h.json(['task', 'show', 'T1']);
  assert.equal(T.gateReport(task, h.logs()).gates.find((g) => g.type === 'tests').ok, true);
});

test('new and mixed failures still rework through automation', (t) => {
  for (const mixed of [false, true]) {
    const h = fixture(t);
    const script = path.join(h.base, 'new-failure.js');
    fs.writeFileSync(script, `const head = require('node:fs').readFileSync('value.js', 'utf8').includes('1');
console.log(${JSON.stringify(mixed ? failedLog() : '')});
if (head) console.log(${JSON.stringify(failedLog('new test'))});
process.exit(${mixed} || head ? 1 : 0);\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    h.submit();
    h.consume();
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.status, 'rework', String(mixed));
    assert.equal(task.evidence.findLast((e) => e.type === 'tests').confirmed_failure, true);
    assert.equal(h.readState('tasks.json').tasks.filter((t) => t.title === 'base test fails on main').length, mixed ? 1 : 0);
  }
});

test('known flake passes only after its rerun passes, reuses its open task, and a twice-failing flake reworks', (t) => {
  for (const twice of [false, true]) {
    const h = fixture(t);
    const script = path.join(h.base, 'flake.js');
    const marker = path.join(h.base, 'flake-ran');
    fs.writeFileSync(script, `const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
if (${twice} || !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '');
  console.log(${JSON.stringify(failedLog('known flake'))}); process.exit(1);
}\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    const fix = h.json(['task', 'add', '--title', 'Fix flaky test known flake', '--acceptance', 'passes']).id;
    const eventsFile = path.join(h.state, 'events.jsonl');
    const events = h.logs();
    events.findLast((e) => e.cmd === 'task add').detail.flake = 'known flake';
    fs.writeFileSync(eventsFile, events.map((e) => JSON.stringify(e) + '\n').join(''));
    h.submit();
    h.consume();
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.status, twice ? 'rework' : 'submitted');
    const entry = task.evidence.findLast((e) => e.type === 'tests');
    assert.equal(entry.ok, !twice);
    if (!twice) {
      assert.equal(entry.known_flake[0].fix_task, fix);
      assert.equal(entry.known_flake[0].first_failure.error, ERROR);
      assert.equal(h.readState('tasks.json').tasks.length, 2);
    } else assert.equal(entry.known_flake, undefined);
  }
});

test('hosted CI excludes an explained failing test job but keeps a new failure', (t) => {
  for (const newFailure of [false, true]) {
    const h = fixture(t);
    baseState(h);
    h.submit();
    const state = h.github();
    state.checks = [{ id: 300, name: 'test', app: 'github-actions', suite: 3, status: 'completed', conclusion: 'failure',
      url: 'https://github.com/acme/demo/actions/runs/300/job/301' }];
    state.suites = [{ id: 3, app: 'github-actions', status: 'completed', conclusion: 'failure', runs: 1 }];
    state.workflows = [{ ...run(300, 'pull_request', '12'), head_sha: h.sha, check_suite_id: 3 }];
    state.jobLogs[301] = failedLog(newFailure ? 'new test' : 'base test');
    h.saveGithub(state);
    const result = h.run(['check', 'ci', 'T1', '--agent', 'orchestrator', '--json']);
    assert.equal(result.code, newFailure ? 1 : 0, result.stderr + result.stdout);
    const entry = JSON.parse(result.stdout);
    if (!newFailure) assert.equal(entry.base_failure[0].base_run.id, 200);
    else assert.equal(entry.confirmed_failure, true);
  }
});

test('base failures do not supply proof: a reverted new failure proves the change, a base-only failure does not', (t) => {
  for (const proves of [false, true]) {
    const h = fixture(t);
    const script = path.join(h.base, 'proof.js');
    fs.writeFileSync(script, `console.log(${JSON.stringify(failedLog())});
if (${proves} && !require('node:fs').readFileSync('value.js', 'utf8').includes('1')) console.log(${JSON.stringify(failedLog('regression proves change'))});
process.exit(1);\n`);
    h.ok(['project', 'set', '--tests-mode', 'prove', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    h.submit();
    const result = h.run(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']);
    assert.equal(result.code, proves ? 0 : 1, result.stdout + result.stderr);
    const entry = JSON.parse(result.stdout);
    assert.equal(entry.base_failure[0].base_run.id, 200);
    if (!proves) assert.match(entry.summary, /tests pass without the change/);
    else assert.equal(T.gateReport(h.json(['task', 'show', 'T1']), h.logs(), { project: h.readState('project.json') }).gates.find((g) => g.type === 'tests').ok, true);
  }
});

test('an existing open task naming the failing test is reused; a cancelled task is replaced', (t) => {
  for (const cancelled of [false, true]) {
    const h = fixture(t);
    const existing = h.json(['task', 'add', '--title', 'base test fails on main', '--acceptance', 'passes']).id;
    if (cancelled) h.ok(['task', 'update', existing, '--status', 'cancelled']);
    const script = path.join(h.base, 'failure.js');
    fs.writeFileSync(script, `console.log(${JSON.stringify(failedLog())}); process.exit(1);\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    h.submit();
    const entry = JSON.parse(h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']));
    assert.equal(entry.base_failure[0].fix_task === existing, !cancelled);
    assert.equal(h.readState('tasks.json').tasks.length, cancelled ? 3 : 2);
  }
});

test('status preserves the legacy base_failure object used by a hotfix waiver', (t) => {
  const h = fixture(t);
  h.submit();
  const tasks = h.readState('tasks.json');
  tasks.tasks[0].evidence.push({ type: 'tests', ok: true, waived: true, agent: 'owner',
    sha: h.sha, revision: 1, base_failure: { base: SHA, names: ['old host failure'] } });
  fs.writeFileSync(path.join(h.state, 'tasks.json'), JSON.stringify(tasks));
  assert.deepEqual(h.json(['status']).base_failures, []);
});

test('known-flake identities apply only while their fix task is open', () => {
  const events = [{ task: 'T9', cmd: 'task add', detail: { flake: 'known flake' } }];
  for (const status of ['todo', 'in_progress', 'submitted', 'rework', 'accepted', 'cancelled']) {
    assert.equal(T.knownFlakes(events, [{ id: 'T9', status }]).has('known flake'), !['accepted', 'cancelled'].includes(status), status);
  }
  assert.equal(T.knownFlakes(events, []).size, 0);
});

test('generic test names do not attach failure evidence to unrelated active tasks', (t) => {
  for (const status of ['todo', 'in_progress', 'submitted', 'rework']) {
    const h = fixture(t);
    const other = h.json(['task', 'add', '--title', 'Fix submit refusing stacked PRs', '--acceptance', 'works']).id;
    h.ok(['brief', 'set', other, '-'], { input: '# An unrelated feature\n' });
    const tasks = h.readState('tasks.json');
    const unrelated = tasks.tasks.find((t) => t.id === other);
    unrelated.status = status;
    if (status === 'in_progress') unrelated.claim = { agent: 'other-worker', since: new Date().toISOString(),
      until: new Date(Date.now() + 3600000).toISOString(), from: 'todo' };
    fs.writeFileSync(path.join(h.state, 'tasks.json'), JSON.stringify(tasks));
    const before = fs.readFileSync(path.join(h.state, 'briefs', `${other}.md`), 'utf8');
    const script = path.join(h.base, 'failure.js');
    fs.writeFileSync(script, `console.log(${JSON.stringify(failedLog('submit'))}); process.exit(1);\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    const state = h.github();
    state.jobLogs[201] = failedLog('submit');
    h.saveGithub(state);
    h.submit();
    const entry = JSON.parse(h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']));
    assert.notEqual(entry.base_failure[0].fix_task, other, status);
    assert.equal(fs.readFileSync(path.join(h.state, 'briefs', `${other}.md`), 'utf8'), before, status);
    assert.equal(h.readState('tasks.json').tasks.find((t) => t.id === other).notes.length, 0, status);
  }
});

test('closed flake tasks return recurrent passes to the two-task flake ledger', (t) => {
  for (const status of ['accepted', 'cancelled']) {
    const h = fixture(t);
    const fix = h.json(['task', 'add', '--title', 'Fix flaky test known flake', '--acceptance', 'passes']).id;
    const events = h.logs();
    events.findLast((e) => e.cmd === 'task add').detail.flake = 'known flake';
    fs.writeFileSync(path.join(h.state, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
    const tasks = h.readState('tasks.json');
    tasks.tasks.find((t) => t.id === fix).status = status;
    fs.writeFileSync(path.join(h.state, 'tasks.json'), JSON.stringify(tasks));
    const marker = path.join(h.base, 'ran');
    const script = path.join(h.base, 'flake.js');
    fs.writeFileSync(script, `const fs=require('node:fs'), marker=${JSON.stringify(marker)};
if (!fs.existsSync(marker)) { fs.writeFileSync(marker,''); console.log(${JSON.stringify(failedLog('known flake'))}); process.exit(1); }\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    h.submit();
    const entry = JSON.parse(h.ok(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']));
    assert.equal(entry.ok, true);
    assert.equal(entry.known_flake, undefined);
    assert.equal(entry.flaky[0].test, 'known flake');
    assert.equal(h.readState('tasks.json').tasks.length, 2, status);
    const next = h.json(['task', 'add', '--title', 'Second change', '--acceptance', 'works']).id;
    h.ok(['claim', next, '--agent', 'worker']);
    h.ok(['submit', next, '--sha', h.sha, '--pr', '7', '--agent', 'worker']);
    fs.rmSync(marker);
    h.ok(['check', 'tests', next, '--agent', 'orchestrator']);
    const fixes = h.readState('tasks.json').tasks.filter((t) => t.title === 'Fix flaky test known flake'
      && !['accepted', 'cancelled'].includes(t.status));
    assert.equal(fixes.length, 1, status);
    assert.notEqual(fixes[0].id, fix, status);
  }
});

test('old base runs cannot excuse a current failure and the API query is bounded and projected', (t) => {
  for (const event of ['schedule', 'push']) {
    const h = fixture(t);
    const script = path.join(h.base, 'failure.js');
    fs.writeFileSync(script, `console.log(${JSON.stringify(failedLog())}); process.exit(1);\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    const state = h.github();
    const mergeTime = Date.parse(h.git(['show', '-s', '--format=%cI', 'main']));
    Object.assign(state.baseRuns[0], { event, created_at: new Date(mergeTime - 86400000).toISOString(),
      updated_at: new Date().toISOString() });
    h.saveGithub(state);
    h.submit();
    const result = h.run(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']);
    assert.equal(result.code, 1, event);
    assert.equal(JSON.parse(result.stdout).base_failure, undefined, event);
    const query = h.github().calls.find((args) => args[0] === 'api' && args[1].includes('actions/runs?branch='));
    assert.match(query[1], /&created=%3E%3D/);
    assert.match(query[query.indexOf('--jq') + 1], /workflow_id.*created_at.*html_url/);
  }
});

test('base exclusions require both failed runs to match, including later command parts and changed errors', (t) => {
  for (const [label, second, passed] of [
    ['same base failure twice', { name: 'base test', error: ERROR, exit: 1 }, true],
    ['new test on rerun', { name: 'new test', error: ERROR, exit: 1 }, false],
    ['new error on rerun', { name: 'base test', error: 'Error: new regression', exit: 1 }, false],
    ['unnamed rerun failure', { exit: 1 }, false],
    ['interrupted rerun', { name: 'base test', error: ERROR, exit: 143 }, false],
    ['successful rerun', { exit: 0 }, true],
  ]) {
    const h = fixture(t);
    const marker = path.join(h.base, 'reran');
    const script = path.join(h.base, 'command.js');
    fs.writeFileSync(script, `const fs = require('node:fs'), marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '');
  console.log(${JSON.stringify(failedLog())}); process.exit(1);
}
${second.name ? `console.log(${JSON.stringify(failedLog(second.name, second.error))});` : ''}
process.exit(${second.exit});\n`);
    h.ok(['project', 'set', '--tests-cmd', `node ${shellQuote(script)}`]);
    baseState(h);
    h.submit();
    const result = h.run(['check', 'tests', 'T1', '--agent', 'orchestrator', '--json']);
    assert.equal(result.code, passed ? 0 : 1, `${label}: ${result.stdout} ${result.stderr}`);
    const entry = JSON.parse(result.stdout);
    if (second.exit === 0) assert.match(entry.summary, /exit 1, then exit 0 on its rerun/, label);
    else if (passed) assert.match(entry.summary, /exit 1 \(base failures excluded\)/, label);
    else assert.equal(entry.ok, false, label);
  }
});
