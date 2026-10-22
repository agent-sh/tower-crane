'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { setup } = require('./automation-helpers');

function accepted(t, settings = [], tier = null) {
  const h = cachedFixture(t, `accepted-before-merge:${JSON.stringify([settings, tier])}`, (repo) => {
    const h = setup(null, { repo });
    if (tier) h.ok(['task', 'update', 'T1', '--tier', tier]);
    h.submit();
    h.ok(['project', 'set', '--tests-proof-cmd', 'node {tests}', ...settings]);
    for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1']);
    h.reviewer('T1', 'reviewer');
    h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
      '--sha', h.sha, '--ok', '--agent', 'reviewer']);
    h.ok(['accept', 'T1', '--agent', 'orchestrator']);
    return { sha: h.sha, clean: h.env.TOWER_CRANE_CLEAN_CMD };
  });
  h.env.TOWER_CRANE_CLEAN_CMD = '';
  h.github = () => JSON.parse(fs.readFileSync(h.env.AUTOMATION_GITHUB, 'utf8'));
  h.saveGithub = (state) => fs.writeFileSync(h.env.AUTOMATION_GITHUB, JSON.stringify(state));
  h.logs = () => StateFiles.logText(h.state).trim().split('\n').map(JSON.parse);
  return h;
}

const map = JSON.stringify({ 'value.js': ['test/value.test.js'] });
const localCI = JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 5 });
for (const json of [false, true]) {
  test(`project set preserves scope warnings while queuing gate refreshes (${json ? 'JSON' : 'text'})`, (t) => {
    const h = accepted(t);
    const args = ['project', 'set', '--tests-mode', 'run-only', '--scope', '{"MemoryMax":"4G"}'];
    const warning = 'scope MemoryMax: containment replaces this on every real launch; set the caps with tower-crane project set --tasks-max N --memory-max-bytes N';
    if (json) assert.deepEqual(h.json(args).warnings, [warning]);
    else {
      const output = h.ok(args);
      assert.ok(output.includes(`warning: ${warning}`));
      assert.match(output, /queued gate re-checks: T1 \(tests\)/);
    }
    assert.deepEqual(h.json(['status']).gate_queue.queued.map((q) => q.id), ['T1']);
    assert.deepEqual(h.logs().findLast((e) => e.cmd === 'automation reconcile').detail.gates, ['tests']);
  });
}

const policyChanges = [
  ['paths', [], ['--tests-paths', '["test/*.test.js"]']],
  ['keep', [], ['--tests-keep', '["README.md"]']],
  ['expensive', [], ['--tests-expensive', 'true']],
  ['host-only', [], ['--tests-host-only', '[]']],
  ['host-env', [], ['--tests-host-env', '{"T447_POLICY":"changed"}']],
  ['map', [], ['--tests-map', map]],
  ['mode', [], ['--tests-mode', 'run-only']],
  ['by-kind', [], ['--tests-by-kind', '{"code":"run-only"}']],
  ['mapped CI required', ['--tests-map', map], ['--ci-required', '["test"]']],
  ['mapped local CI', ['--tests-map', map], ['--ci-local', localCI]],
];

for (const [name, settings, flags] of policyChanges) {
  test(`test policy ${name} queues an accepted task and refreshes before merge`, (t) => {
    const h = accepted(t, settings);
    const runs = () => h.logs().filter((e) => e.cmd === 'check tests').length;
    const before = runs();
    const output = h.ok(['project', 'set', ...flags]);
    assert.match(output, /queued gate re-checks: T1 \(tests(?:, ci)?\)/);
    assert.deepEqual(h.json(['status']).gate_queue.queued.map((q) => q.id), ['T1']);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, false);
    const offset = StateFiles.logEnd(h.state);
    h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0',
      '--agent', 'orchestrator']);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    assert.equal(runs(), before + 1);
    assert.equal(h.readState('tasks.json').tasks[0].revision, 1);
    assert.doesNotMatch(h.ok(['project', 'set', ...flags]), /queued gate re-checks/,
      'an unchanged policy and a merged task create no new request');
  });
}

for (const [name, settings, flags] of [
  ['an unrelated kind', [], ['--tests-by-kind', '{"docs":"run-only"}']],
  ['a masked global mode', ['--tests-by-kind', '{"code":"prove"}'], ['--tests-mode', 'run-only']],
]) {
  test(`test policy changes for ${name} leave the accepted task current`, (t) => {
    const h = accepted(t, settings);
    const requests = () => h.logs().filter((e) => e.cmd === 'automation reconcile').length;
    const before = requests();
    assert.doesNotMatch(h.ok(['project', 'set', ...flags]), /queued gate re-checks/);
    assert.equal(requests(), before);
    assert.equal(h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'tests').ok, true);
  });
}

const changes = [
  { gate: 'clean', flags: (h) => ['--clean-cmd', `${h.clean} --fixture`] },
  { gate: 'tests', flags: () => ['--tests-cmd', 'node --trace-warnings test/value.test.js'] },
  { gate: 'tests', flags: () => ['--tests-proof-cmd', 'node --trace-warnings {tests}'] },
  { gate: 'ci', flags: () => ['--ci-required', '["test"]'] },
  { gate: 'ci', flags: () => ['--ci-local', JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 5 })] },
];

for (const [index, change] of changes.entries()) {
  test(`policy change ${index + 1} queues accepted ${change.gate}, shows its block and merges after refresh`, (t) => {
    const h = accepted(t);
    const before = h.logs().filter((e) => e.cmd === `check ${change.gate}`).length;
    const flags = change.flags(h);
    assert.match(h.ok(['project', 'set', ...flags, '--agent', 'orchestrator']),
      new RegExp(`queued gate re-checks: T1 \\(${change.gate}\\)`));
    const status = h.json(['status']);
    assert.deepEqual(status.gate_queue.queued.map((q) => q.id), ['T1']);
    assert.equal(status.merge_blocked[0].id, 'T1');
    assert.match(status.merge_blocked[0].reason, /policy.*no longer matches|local CI receipt/);
    assert.match(h.ok(['status']), /merge blocked: T1/);
    const requested = h.logs().filter((e) => e.cmd === 'automation reconcile').length;
    h.ok(['project', 'set', ...flags, '--agent', 'orchestrator']);
    assert.equal(h.logs().filter((e) => e.cmd === 'automation reconcile').length, requested,
      'setting the same command adds no queue request');
    h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
    const task = h.readState('tasks.json').tasks[0];
    assert.equal(task.status, 'accepted');
    assert.equal(task.evidence.at(-1).type, 'merge');
    assert.equal(task.evidence.at(-1).ok, true);
    assert.equal(h.logs().filter((e) => e.cmd === `check ${change.gate}`).length, before + 1);
    assert.equal(task.evidence.filter((e) => e.type === 'review').length, 1);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    assert.deepEqual(h.json(['status']).merge_blocked, []);
    const set = h.ok(['project', 'set', '--clean-cmd', `${h.clean} --after-merge`]);
    assert.doesNotMatch(set, /queued gate re-checks/);
  });
}

test('a queued clean refresh runs without replaying old notifications and reworks a failure', (t) => {
  const h = accepted(t);
  h.ok(['project', 'set', '--clean-cmd', `${h.clean} --fixture`, '--agent', 'orchestrator']);
  h.env.FIXTURE_GATE_OK = '0';
  // Observe from the end: the persistent queue request must suffice to run the refresh.
  const offset = StateFiles.logEnd(h.state);
  h.run(['wait', '--after', String(offset), '--types', 'never', '--timeout', '0',
    '--agent', 'orchestrator']);
  const task = h.readState('tasks.json').tasks[0];
  assert.equal(task.status, 'rework');
  assert.equal(task.revision, 2);
  assert.equal(h.logs().filter((e) => e.cmd === 'rework').length, 1);
  assert.equal(h.logs().findLast((e) => e.cmd === 'rework').detail.gate, 'clean');
  assert.equal(h.github().prs['7'].state, 'OPEN');
});

for (const tier of [null, 'easy..medium', 'medium..medium']) {
  for (const gate of ['tests', 'clean', 'ci']) {
    for (const failure of ['recorded', 'refresh']) {
      test(`accepted ${tier || 'single-tier'} ${failure} ${gate} failure reworks once`, (t) => {
        const h = accepted(t, [], tier);
        const before = h.readState('tasks.json').tasks[0];
        if (gate === 'tests') {
          h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd',
            'node -e "require(\'node:assert/strict\').equal(require(\'./value\'), 0)"']);
        } else if (gate === 'clean') {
          if (failure === 'refresh') h.ok(['project', 'set', '--clean-cmd', `${h.clean} --fixture`]);
          h.env.FIXTURE_GATE_OK = '0';
        } else {
          if (failure === 'refresh') h.ok(['project', 'set', '--ci-required', '["test"]']);
          const github = h.github();
          github.ci[h.sha] = 'failure';
          h.saveGithub(github);
        }
        if (failure === 'recorded') assert.equal(h.run(['check', gate, 'T1']).code, 1);
        h.run(['merge', '--accepted', '--agent', 'orchestrator']);
        const task = h.readState('tasks.json').tasks[0];
        assert.equal(task.evidence.findLast((e) => e.type === gate).confirmed_failure, true);
        assert.equal(task.status, 'rework');
        assert.equal(task.revision, 2);
        assert.equal(task.tier, before.tier, 'accepted failures rework at the existing tier');
        assert.deepEqual(task.tier_range, before.tier_range);
        assert.equal(h.github().prs['7'].state, 'OPEN');
        h.run(['merge', '--accepted', '--agent', 'orchestrator']);
        const reworks = h.logs().filter((e) => e.cmd === 'rework' && e.task === 'T1');
        assert.equal(reworks.length, 1);
        assert.equal(reworks[0].detail.gate, gate);
        assert.equal(h.logs().filter((e) => e.cmd === 'escalate' && e.task === 'T1').length, 0);
      });
    }
  }
}

test('restoring a cleanup pin queues and runs an accepted task blocked by missing configuration', (t) => {
  const h = accepted(t);
  h.ok(['project', 'set', '--clean-cmd', 'null']);
  assert.equal(h.run(['merge', '--accepted', '--agent', 'orchestrator']).code, 1);
  const blocked = h.readState('tasks.json').tasks[0];
  assert.equal(blocked.status, 'accepted');
  assert.ok(blocked.evidence.findLast((e) => e.type === 'clean').config_failure);
  assert.match(h.ok(['project', 'set', '--clean-cmd', h.clean]), /queued gate re-checks: T1 \(clean\)/);
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(h.github().prs['7'].state, 'MERGED');
});

for (const change of ['source', 'empty']) {
  test(`the merge queue reruns pinned local CI on the real merged tree after a ${change} commit advances its checked base`, (t) => {
    const h = accepted(t);
    h.ok(['project', 'set', '--ci-local',
      JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 5 })]);
    h.ok(['check', 'ci', 'T1']);
    h.git(['switch', '-q', 'main']);
    if (change === 'source') {
      fs.appendFileSync(path.join(h.repo, 'README.md'), 'Updated base.\n');
      h.git(['add', 'README.md']);
    }
    h.git(['commit', '--allow-empty', '-qm', 'advance base']);
    const tip = h.git(['rev-parse', 'HEAD']);
    h.git(['switch', '-q', 'fixture-change']);
    const count = h.logs().filter((e) => e.cmd === 'check ci').length;
    const report = h.json(['task', 'show', 'T1']).gates.gates.find((g) => g.type === 'ci');
    assert.equal(report.ok, true, 'reports keep the receipt on the tree it checked');
    h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    const ci = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
    assert.equal(ci.receipt.base_sha, tip);
    assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, count + 1);
  });
}

for (const [change, ref] of [
  ['empty', 'main'], ['empty', 'refs/remotes/origin/main'],
  ['checked changes', 'main'], ['source', 'main'], ['source', 'refs/remotes/origin/main'], ['rewritten', 'main'],
]) {
  test(`local CI reports ${change === 'rewritten' ? 'invalidate a receipt after a rewritten' : `preserve a pinned receipt after ${change} advances`} ${ref}`, (t) => {
    const h = accepted(t);
    h.ok(['project', 'set', '--ci-local', localCI]);
    h.ok(['check', 'ci', 'T1']);
    const old = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
    const base = h.git(['rev-parse', 'main']);
    let tip;
    if (change === 'source' || change === 'rewritten') {
      // A rewritten base is a force-push that drops the checked base commit.
      h.git(['switch', '-q', ...(change === 'rewritten' ? ['--detach', `${base}^`] : ['main'])]);
      fs.appendFileSync(path.join(h.repo, 'README.md'), 'Changed merged result.\n');
      h.git(['add', 'README.md']);
      h.git(['commit', '-qm', 'change base source']);
      tip = h.git(['rev-parse', 'HEAD']);
      h.git(['switch', '-q', 'fixture-change']);
      h.git(['update-ref', 'refs/heads/main', base]);
    } else {
      const tree = change === 'empty' ? `${base}^{tree}` : `${h.sha}^{tree}`;
      tip = h.git(['commit-tree', tree, '-p', base, '-m', 'base advances']);
    }
    h.git(['update-ref', ref === 'main' ? 'refs/heads/main' : ref, tip]);
    const count = h.logs().filter((e) => e.cmd === 'check ci').length;
    const shown = h.json(['task', 'show', 'T1']);
    const ci = shown.gates.gates.find((g) => g.type === 'ci');
    assert.equal(ci.ok, change !== 'rewritten');
    assert.deepEqual(shown.evidence.findLast((e) => e.type === 'ci'), old);
    assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, count, 'a report does not rerun CI');
    if (change === 'rewritten') assert.match(ci.reason, /checked base [0-9a-f]+ is not in the selected base's history/);
  });
}

test('a local CI base ahead of origin is reported once instead of refreshed indefinitely', (t) => {
  const h = accepted(t);
  const origin = path.join(h.base, 'origin.git');
  h.git(['clone', '--bare', h.repo, origin]);
  h.git(['remote', 'set-url', 'origin', origin]);
  h.git(['switch', '-q', 'main']);
  h.git(['commit', '--allow-empty', '-qm', 'local base ahead']);
  h.git(['switch', '-q', 'fixture-change']);
  h.ok(['project', 'set', '--ci-local', localCI]);
  h.ok(['check', 'ci', 'T1']);
  const count = h.logs().filter((e) => e.cmd === 'check ci').length;
  const result = h.run(['merge', '--accepted', '--agent', 'orchestrator']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /local CI selected base .* does not match fetched base/);
  assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, count + 1);
  assert.equal(h.github().prs['7'].state, 'OPEN');
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
});

test('accept refreshes a stale clean policy before accepting', (t) => {
  const h = accepted(t);
  h.ok(['rework', 'T1', '--reason', 'new acceptance pass', '--agent', 'orchestrator']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.sha, '--agent', 'worker']);
  for (const gate of ['tests', 'clean', 'ci']) h.ok(['check', gate, 'T1']);
  h.reviewer('T1', 'reviewer-2');
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review',
    '--sha', h.sha, '--ok', '--agent', 'reviewer-2']);
  h.ok(['project', 'set', '--clean-cmd', `${h.clean} --fixture`]);
  const count = h.logs().filter((e) => e.cmd === 'check clean').length;
  h.ok(['accept', 'T1', '--agent', 'orchestrator']);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'accepted');
  assert.equal(h.logs().filter((e) => e.cmd === 'check clean').length, count + 1);
});

for (const obsolete of ['sha', 'revision']) {
  test(`the merge queue refreshes software receipts from an earlier ${obsolete}`, (t) => {
    const h = accepted(t);
    const tasks = h.readState('tasks.json');
    for (const e of tasks.tasks[0].evidence.filter((e) => ['tests', 'clean', 'ci'].includes(e.type))) {
      if (obsolete === 'sha') e.sha = h.git(['rev-parse', 'main']);
      else e.revision = 0;
    }
    h.writeState('tasks.json', tasks);
    h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    const task = h.readState('tasks.json').tasks[0];
    for (const gate of ['tests', 'clean', 'ci']) {
      const latest = task.evidence.findLast((e) => e.type === gate);
      assert.equal(latest.ok, true);
      assert.equal(latest.sha, h.sha);
      assert.equal(latest.revision, task.revision);
    }
  });
}

test('status reports a recorded merge refusal when software gates still pass', (t) => {
  const h = accepted(t);
  const github = h.github();
  github.prs['7'].state = 'CLOSED';
  h.saveGithub(github);
  assert.equal(h.run(['merge', '--accepted', '--agent', 'orchestrator']).code, 1);
  assert.deepEqual(h.json(['status']).merge_blocked,
    [{ id: 'T1', reason: 'T1: PR #7 is CLOSED' }]);
});
