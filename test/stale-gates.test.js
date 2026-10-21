'use strict';

const test = require('node:test');
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
  h.logs = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
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
    const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
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
  const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
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

// Commits files on main, as a merge of another task would, and returns the new tip.
function advanceMain(h, files, message = 'advance base') {
  h.git(['switch', '-q', 'main']);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.repo, name)), { recursive: true });
    fs.writeFileSync(path.join(h.repo, name), text);
    h.git(['add', name]);
  }
  h.git(['commit', '--allow-empty', '-qm', message]);
  const tip = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'fixture-change']);
  return tip;
}

// T476's review: on a busy base every base move reran a long local CI, and a run as long as
// ginza T26's came back behind the tip each time, so the task never landed.
for (const change of ['source', 'empty']) {
  test(`the merge queue lands a local CI receipt behind the tip without a rerun after a disjoint ${change} commit`, (t) => {
    const h = accepted(t);
    h.ok(['project', 'set', '--ci-local', localCI]);
    h.ok(['check', 'ci', 'T1']);
    const checked = h.git(['rev-parse', 'main']);
    const tip = advanceMain(h, change === 'source' ? { 'README.md': 'Updated base.\n' } : {});
    assert.notEqual(tip, checked);
    const count = h.logs().filter((e) => e.cmd === 'check ci').length;
    h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    const ci = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
    assert.equal(ci.receipt.base_sha, checked, 'the receipt behind the tip is the one that landed');
    assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, count, 'no rerun');
    assert.ok(!h.logs().some((e) => e.cmd === 'local ci rerun'));
  });
}

// What a base move can change that the run depends on: a file the task changes too, a script the
// command names, a path the owner lists in `inputs`, or the history the receipt was checked on.
const overlaps = [
  ['a path the task changes', { local: localCI, move: (h) => advanceMain(h, { 'value.js': 'module.exports = 1;\n' }) },
    /the base changed value\.js, which the task changes or the CI command reads/],
  ['a script the command names', {
    local: JSON.stringify({ command: [process.execPath, 'ci.js'], timeout: 5 }),
    prepare: (h) => advanceMain(h, { 'ci.js': 'process.exit(0);\n' }, 'add the CI script'),
    move: (h) => advanceMain(h, { 'ci.js': 'process.exit(0);\n// changed\n' }),
  }, /the base changed ci\.js,/],
  ['an inputs glob', {
    local: JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], timeout: 5, inputs: ['config/**'] }),
    move: (h) => advanceMain(h, { 'config/ci.json': '{}\n' }),
  }, /the base changed config\/ci\.json,/],
  // A force-push drops the checked commit and keeps the base the head branched from.
  ['a rewritten base', { local: localCI, prepare: (h) => advanceMain(h, { 'notes.txt': 'notes\n' }), move: (h) => {
    const base = h.git(['rev-parse', 'main']);
    const tip = h.git(['commit-tree', `${base}^{tree}`, '-p', `${base}^`, '-m', 'rewritten base']);
    h.git(['update-ref', 'refs/heads/main', tip]);
    return tip;
  } }, /its checked base [0-9a-f]+ is not in the history of [0-9a-f]+/],
];

for (const [name, { local, prepare, move }, reason] of overlaps) {
  test(`the merge queue reruns local CI behind the tip when the base moved ${name}`, (t) => {
    const h = accepted(t);
    h.ok(['project', 'set', '--ci-local', local]);
    prepare?.(h);
    h.ok(['check', 'ci', 'T1']);
    const checked = h.git(['rev-parse', 'main']);
    const tip = move(h);
    const count = h.logs().filter((e) => e.cmd === 'check ci').length;
    h.ok(['merge', '--accepted', '--agent', 'orchestrator']);
    assert.equal(h.github().prs['7'].state, 'MERGED');
    const ci = h.readState('tasks.json').tasks[0].evidence.findLast((e) => e.type === 'ci');
    assert.equal(ci.receipt.base_sha, tip, 'what landed was checked on the tip');
    assert.equal(h.logs().filter((e) => e.cmd === 'check ci').length, count + 1);
    const reruns = h.logs().filter((e) => e.cmd === 'local ci rerun');
    assert.deepEqual(reruns.map((e) => [e.detail.from, e.detail.tip, e.detail.lost, e.detail.hold]), [[checked, tip, 0, undefined]]);
    assert.match(reruns[0].detail.reason, reason);
  });
}

// The command stands in for a two-hour run: a merge that changes the script it runs lands on
// main during each of the next two runs, so each comes back behind an overlapping change.
const BUSY_BASE = `
const fs = require('node:fs');
const cp = require('node:child_process');
const [count, repo, cli, out] = process.argv.slice(2);
// The other task's own runs leave main alone.
if (fs.existsSync('other.txt')) process.exit(0);
const run = (fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) + 1;
fs.writeFileSync(count, String(run));
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@localhost' };
const git = (args, input) => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, env }).trim();
if (run === 2 || run === 3) {
  const base = git(['rev-parse', 'refs/heads/main']);
  const blob = git(['hash-object', '-w', '--stdin'], git(['show', base + ':ci.js']) + '\\n// moved during run ' + run + '\\n');
  const tree = git(['mktree'], git(['ls-tree', base]).split('\\n').map((l) => (l.endsWith('\\tci.js') ? '100644 blob ' + blob + '\\tci.js' : l)).join('\\n') + '\\n');
  git(['update-ref', 'refs/heads/main', git(['commit-tree', tree, '-p', base, '-m', 'busy base ' + run])]);
}
// The other task checks the current base, so only the hold keeps it from landing during this run.
if (run === 4) {
  const tc = (args) => cp.spawnSync(process.execPath, [cli, ...args, '--agent', 'merger'], { cwd: repo, encoding: 'utf8' });
  const check = tc(['check', 'ci', 'T2']);
  const r = tc(['merge', 'T2']);
  fs.writeFileSync(out, JSON.stringify({ check: check.status, code: r.status, stderr: r.stderr }));
}
`;

test('local CI reruns lost to base moves twice in a row hold merges to the base until the task lands', (t) => {
  const h = accepted(t);
  const count = path.join(h.base, 'ci-runs');
  const out = path.join(h.base, 'held-merge.json');
  const cli = path.join(__dirname, '..', 'bin', 'tower-crane.js');
  advanceMain(h, { 'ci.js': BUSY_BASE }, 'add the CI script');
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, 'ci.js', count, h.repo, cli, out], timeout: 30 })]);
  h.ok(['check', 'ci', 'T1']);

  // T2, accepted after T1, merges to the same base.
  h.git(['switch', '-qc', 'other-change', 'main']);
  fs.writeFileSync(path.join(h.repo, 'other.txt'), 'other\n');
  h.git(['add', 'other.txt']);
  h.git(['commit', '-qm', 'other change']);
  const other = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'fixture-change']);
  const github = h.github();
  github.prs['8'] = { ...github.prs['7'], headRefOid: other, headRefName: 'other-change', url: 'https://github.com/acme/demo/pull/8' };
  github.ci[other] = 'success';
  h.saveGithub(github);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'it works', '--kind', 'docs']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '# Other\n\nImplement the acceptance.\n' });
  h.ok(['claim', 'T2', '--agent', 'worker']);
  h.ok(['submit', 'T2', '--sha', other, '--pr', '8', '--agent', 'worker']);
  h.reviewer('T2', 'reviewer', other);
  h.ok(['evidence', 'T2', '--revision', h.revision('T2'), '--type', 'review', '--sha', other, '--ok', '--agent', 'reviewer']);
  h.ok(['accept', 'T2', '--agent', 'orchestrator']);

  // A merge after T1's check changes the script, so the queue reruns it.
  const first = advanceMain(h, { 'ci.js': `${BUSY_BASE}// merged after the check\n` });
  h.ok(['merge', '--accepted', '--agent', 'orchestrator']);

  const reruns = h.logs().filter((e) => e.cmd === 'local ci rerun' && e.task === 'T1');
  assert.deepEqual(reruns.map((e) => e.detail.lost), [0, 1, 2]);
  assert.equal(reruns[0].detail.tip, first);
  assert.deepEqual(reruns.map((e) => e.detail.hold), [undefined, undefined, '2 local CI reruns in a row came back behind a moved main']);
  const held = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(held.check, 0, 'T2 has a receipt on the current base');
  assert.equal(held.code, 1, 'a merge to the held base during the run is refused');
  assert.match(held.stderr, /T2: merges to main are held for T1 until its local CI lands: 2 local CI reruns in a row came back behind a moved main/);

  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(h.github().prs['7'].state, 'MERGED', 'the task lands');
  assert.equal(t1.evidence.findLast((e) => e.type === 'ci').receipt.base_sha, h.git(['rev-parse', 'main']));
  assert.equal(fs.readFileSync(count, 'utf8'), '4');
  assert.equal(h.github().prs['8'].state, 'MERGED', 'the hold ends when the task lands');
  assert.equal(t2.evidence.at(-1).type, 'merge');
});

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
