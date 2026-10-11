'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { worker, setup, upper, resubmit } = require('./stack-fixture');
const { BIN } = require('./helpers');

test('submitted dependencies dispatch from the exact dependency head and spawn links PRs bottom to top', (t) => {
  const f = setup(t);
  assert.match(f.h.ok(['ready']), /T2/);
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.sha);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.base, f.lower.branch);
  worker(f);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
  const link = f.read().calls.find((c) => c.args[0] === 'stack' && c.args[1] === 'link');
  assert.deepEqual(link.args, ['stack', 'link', '11', '12', '--base', 'main']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, true);
});

test('detached spawn links the PR after its worker submits and exits', async (t) => {
  const f = setup(t);
  worker(f);
  f.h.ok(['spawn', '--task', 'T2']);
  const until = Date.now() + 15000;
  let task;
  do {
    task = f.h.json(['task', 'show', 'T2']);
    if (task.stack?.linked) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.equal(task.stack.linked, true);
  assert.equal(task.status, 'submitted');
  assert.deepEqual(f.read().order, [11, 12]);
});

test('a worktree prepared before its dependency was submitted moves onto the dependency head at dispatch', (t) => {
  const f = setup(t);
  f.add('top', 'T2');
  const early = f.h.json(['worktree', 'T3']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), f.h.git(['rev-parse', 'main']));
  const { wt, sha } = upper(f);
  const again = f.h.json(['worktree', 'T3']);
  assert.equal(again.path, early.path);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), sha);
  const task = f.h.json(['task', 'show', 'T3']);
  assert.equal(task.stack.parent, 'T2');
  assert.equal(task.stack.base, wt.branch);
});

test('a stale worktree with its own work refuses stacked dispatch', (t) => {
  const f = setup(t);
  f.add('top', 'T2');
  const early = f.h.json(['worktree', 'T3']);
  fs.writeFileSync(path.join(early.path, 'T3.txt'), 'T3\n');
  f.h.git(['add', 'T3.txt'], early.path);
  f.h.git(['commit', '-qm', 'early T3'], early.path);
  const head = f.h.git(['rev-parse', 'HEAD'], early.path);
  upper(f);
  const r = f.h.run(['worktree', 'T3']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /prepared before T2 was submitted and holds its own changes/);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], early.path), head);
  assert.equal(f.h.json(['task', 'show', 'T3']).stack, undefined);
});

test('spawn moves a prepared dependent onto its dependency\'s resubmitted head', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.sha);
  const sha = resubmit(f, false);
  worker(f);
  f.h.ok(['spawn', '--task', 'T2', '--wait']);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'submitted');
  assert.equal(task.stack.parent_sha, sha);
  assert.equal(f.h.git(['rev-parse', `${task.sha}^`]), sha);
});

test('worktree replaces a rewritten dependency head under an untouched prepared branch', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  const sha = resubmit(f, true);
  assert.throws(() => f.h.git(['merge-base', '--is-ancestor', f.sha, sha]));
  f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), sha);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent_sha, sha);
});

test('a prepared dependent with its own work refuses a resubmitted dependency until it merges the new head', (t) => {
  const f = setup(t);
  const wt = f.h.json(['worktree', 'T2']);
  fs.writeFileSync(path.join(wt.path, 'T2.txt'), 'T2\n');
  f.h.git(['add', 'T2.txt'], wt.path);
  f.h.git(['commit', '-qm', 'early T2'], wt.path);
  const head = f.h.git(['rev-parse', 'HEAD'], wt.path);
  const sha = resubmit(f, false);
  const r = f.h.run(['worktree', 'T2']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /holds its own changes on T1 .* resubmitted/);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), head);
  worker(f);
  assert.notEqual(f.h.run(['spawn', '--task', 'T2', '--wait']).code, 0);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'todo');
  f.h.git(['merge', '-q', '--no-edit', sha], wt.path);
  f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD^2'], wt.path), sha);
});

test('concurrent sibling dispatch on one submitted dependency records a single stack child', async (t) => {
  const f = setup(t);
  f.add('sibling', 'T1');
  const ready = path.join(f.h.base, 'view-ready');
  const release = path.join(f.h.base, 'view-release');
  const slow = f.h.runAsync(['worktree', 'T3'], {
    env: { TEST_STACK_PAUSE_VIEW: '11', TEST_STACK_PAUSE_READY: ready, TEST_STACK_PAUSE_RELEASE: release },
  });
  try {
    const deadline = performance.now() + 15000;
    while (!fs.existsSync(ready)) {
      if (performance.now() > deadline) throw new Error('T3 preparation never read the dependency PR');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    f.h.json(['worktree', 'T2']);
  } finally {
    fs.writeFileSync(release, 'release');
  }
  const r = await slow;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /changed during stack dispatch/);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.parent, 'T1');
  assert.equal(f.h.json(['task', 'show', 'T3']).stack, undefined);
  assert.match(f.h.run(['worktree', 'T3']).stderr, /one available stack chain/);
});

test('unavailable stacks fall back for accepted dependencies and wait for submitted ones', (t) => {
  const f = setup(t);
  f.write((d) => { d.unavailable = true; });
  const waiting = f.h.run(['worktree', 'T2']);
  assert.equal(waiting.code, 1);
  assert.match(waiting.stderr, /stacks unavailable/);
  f.accept('T1');
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
});

test('same repo and one dependency chain are required for early dispatch', (t) => {
  const f = setup(t);
  f.write((d) => { d.prs[11].isCrossRepository = true; });
  assert.match(f.h.run(['worktree', 'T2']).stderr, /same-repository/);
  f.write((d) => { d.prs[11].isCrossRepository = false; });
  upper(f);
  f.add('fork', 'T1');
  assert.equal(f.h.run(['claim', 'T3']).code, 1);
  f.add('independent');
  const wt = f.h.json(['worktree', 'T4']);
  f.submit('T4', 14, wt);
  f.add('join', 'T1');
  f.h.ok(['task', 'update', 'T5', '--dep', 'T1', '--dep', 'T4']);
  assert.equal(f.h.run(['claim', 'T5']).code, 1);
  assert.match(f.h.run(['worktree', 'T5']).stderr, /one available stack chain/);
});

test('spawn refuses with claim readiness when a submitted dependency returns to in progress', (t) => {
  const f = setup(t);
  worker(f);
  f.h.json(['worktree', 'T2']);
  f.h.ok(['rework', 'T1', '--reason', 'the lower task needs another change']);
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);

  const claim = f.h.run(['claim', 'T2', '--agent', 'claim-probe']);
  assert.equal(claim.code, 1);
  assert.match(claim.stderr, /T2 is blocked: depends on T1 \(in_progress\)/);

  const spawn = f.h.run(['spawn', '--task', 'T2', '--wait']);
  assert.equal(spawn.code, 1);
  assert.ok(spawn.stderr.includes(claim.stderr.trim().replace(/^tower-crane: /, '')), spawn.stderr);
  const events = fs.readFileSync(path.join(f.h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.some((event) => event.cmd === 'spawn' && event.task === 'T2'), false);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'todo');
});

test('spawn repairs stale linked state from GitHub before checking a rework claim', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const state = f.h.readState('tasks.json');
  const upperTask = state.tasks.find((item) => item.id === 'T2');
  upperTask.stack.linked = false;
  upperTask.stack_disabled = true;
  f.h.writeState('tasks.json', state);

  const script = path.join(f.h.base, 'claim.js');
  fs.writeFileSync(script, `const cp = require('node:child_process');
const r = cp.spawnSync(process.execPath, [${JSON.stringify(BIN)}, 'claim', process.env.TOWER_CRANE_TASK], { encoding: 'utf8' });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status === null ? 1 : r.status);
`);
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, script, '{prompt}']),
    '--clear', 'model', '--clear', 'profile', '--clear', 'effort']);

  const spawned = f.h.run(['spawn', '--task', 'T2', '--wait']);
  assert.equal(spawned.code, 0, spawned.stderr);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'in_progress');
  assert.equal(task.stack.linked, true);
  assert.equal(task.stack_disabled, undefined);
  assert.ok(f.read().calls.some((call) => call.args[0] === 'api' && call.args[1] === 'repos/acme/app/stacks'));
});

test('a stacked rework is claimable while its lower task is only submitted', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const claim = f.h.run(['claim', 'T2', '--agent', 'claim-probe']);
  assert.equal(claim.code, 0, claim.stderr);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'in_progress');
});

test('a stacked rework whose branch is gone resumes from its own pushed head, not its dependency', (t) => {
  const f = setup(t);
  const { wt, sha } = upper(f);
  f.h.git(['worktree', 'remove', '--force', wt.path]);
  f.h.git(['branch', '-D', wt.branch]);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const again = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], again.path), sha);
});

test('a claimed stacked rework whose branch is gone resumes from its own submitted head, not its dependency', (t) => {
  const f = setup(t);
  const { wt, sha } = upper(f);
  f.h.git(['worktree', 'remove', '--force', wt.path]);
  f.h.git(['branch', '-D', wt.branch]);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  f.h.ok(['claim', 'T2', '--agent', 'worker-T2']);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'in_progress');
  const again = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], again.path), sha);
});

test('a stacked rework with its own branch but no worktree is not refused as prepared before its dependency', (t) => {
  const f = setup(t);
  const { wt, sha } = upper(f);
  f.h.git(['worktree', 'remove', '--force', wt.path]);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const again = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], again.path), sha);
});

test('a transient stack API failure refuses a stacked rework claim without disabling its stack', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  f.write((d) => { d.apiFailure = { status: 1, stderr: 'HTTP 503: Service Unavailable' }; });
  const claim = f.h.run(['claim', 'T2', '--agent', 'claim-probe']);
  assert.equal(claim.code, 1);
  assert.match(claim.stderr, /stack availability check failed/);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.stack_disabled, undefined);
  assert.equal(task.stack.linked, true);
});

const DENIED_API = { status: 1, stderr: "gh api repos/acme/app/stacks is not allowed by this agent's agent file" };
const apiCalls = (f) => f.read().calls.filter((c) => c.args[0] === 'api');

test('a spawned worker claims a task whose dependency merged while gh api is denied to it', (t) => {
  const f = setup(t);
  const { wt } = upper(f);
  f.accept('T1');
  f.h.ok(['merge', 'T1']);
  f.h.ok(['rework', 'T2', '--reason', 'the lower change merged']);
  const state = f.h.readState('tasks.json');
  const upperTask = state.tasks.find((item) => item.id === 'T2');
  upperTask.stack.linked = false;
  upperTask.stack_disabled = true;
  f.h.writeState('tasks.json', state);
  // The worker's commit must differ from the branch it was dispatched on.
  fs.writeFileSync(path.join(wt.path, 'T2.txt'), 'T2 rework\n');
  f.h.git(['commit', '-qam', 'T2 rework'], wt.path);
  worker(f);
  const before = apiCalls(f).length;
  f.write((d) => { d.apiFailure = DENIED_API; });
  const spawned = f.h.run(['spawn', '--task', 'T2', '--wait']);
  assert.equal(spawned.code, 0, spawned.stderr);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'submitted');
  assert.equal(apiCalls(f).length, before);
});

test('a spawned worker claim reads the recorded stack and makes no gh api call while its dependency is submitted', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const before = apiCalls(f).length;
  f.write((d) => { d.apiFailure = DENIED_API; });
  const dispatch = { TOWER_CRANE_HOOK: path.join(f.h.base, 'hook.json'), TOWER_CRANE_TASK: 'T2', TOWER_CRANE_AGENT: 'worker-T2' };
  const claim = f.h.run(['claim', 'T2', '--agent', 'worker-T2'], { env: dispatch });
  assert.equal(claim.code, 0, claim.stderr);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'in_progress');
  assert.equal(apiCalls(f).length, before);
});

test('a hooked claim on a task spawn did not dispatch reads GitHub and clears its stale stack record', (t) => {
  const f = setup(t);
  upper(f);
  f.h.ok(['rework', 'T2', '--reason', 'revise the stacked change']);
  const state = f.h.readState('tasks.json');
  const upperTask = state.tasks.find((item) => item.id === 'T2');
  upperTask.stack.linked = false;
  upperTask.stack_disabled = true;
  f.h.writeState('tasks.json', state);
  const before = apiCalls(f).length;
  const claim = f.h.run(['claim', 'T2', '--agent', 'worker-T2'], { env: { TOWER_CRANE_HOOK: path.join(f.h.base, 'hook.json') } });
  assert.equal(claim.code, 0, claim.stderr);
  assert.ok(apiCalls(f).length > before);
  const task = f.h.json(['task', 'show', 'T2']);
  assert.equal(task.status, 'in_progress');
  assert.equal(task.stack.linked, true);
  assert.equal(task.stack_disabled, undefined);
});

test('an outage leaves a dependent without a stack record unflagged, and recovery claims it once GitHub confirms its dependency', (t) => {
  const f = setup(t);
  upper(f);
  f.add('third', 'T2');
  f.write((d) => { d.unavailable = true; });

  const outage = f.h.run(['claim', 'T3', '--agent', 'claim-probe']);
  assert.equal(outage.code, 1);
  assert.match(outage.stderr, /T3 is blocked: depends on T2 \(submitted\)/);
  assert.equal(f.h.json(['task', 'show', 'T3']).stack_disabled, undefined);

  f.write((d) => { delete d.unavailable; });
  const claim = f.h.run(['claim', 'T3', '--agent', 'claim-probe']);
  assert.equal(claim.code, 0, claim.stderr);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, undefined);
});

test('reconciling a longer chain keeps the link GitHub confirms for its lower members', (t) => {
  const f = setup(t);
  upper(f);
  f.add('third', 'T2');
  const wt = f.h.json(['worktree', 'T3']);
  f.submit('T3', 13, wt);
  f.h.ok(['stack', 'link', 'T3']);
  f.h.ok(['rework', 'T3', '--reason', 'revise the top change']);
  // GitHub's stack holds T1 and T2 but not T3.
  f.write((d) => { d.order = [11, 12]; });

  f.h.run(['claim', 'T3', '--agent', 'claim-probe']);
  assert.equal(f.h.json(['task', 'show', 'T2']).stack.linked, true);
  assert.equal(f.h.json(['task', 'show', 'T3']).stack.linked, false);
});

test('transient stack API failures and ordinary 404s do not disable stacks', (t) => {
  const failures = [
    { status: 1, stderr: 'HTTP 503: Service Unavailable' },
    { status: 1, stderr: 'HTTP 503: gh stack extension temporarily unavailable' },
    { status: 1, stderr: 'HTTP 404: Not Found' },
    { status: null, error: { code: 'ENETUNREACH', message: 'network is unreachable' } },
    { status: null, error: { code: 'ENOENT', message: 'spawnSync gh ENOENT' } },
  ];
  for (const failure of failures) {
    const f = setup(t);
    f.accept('T1');
    f.write((d) => { d.apiFailure = failure; });

    const result = f.h.run(['worktree', 'T2']);
    assert.equal(result.code, 1, JSON.stringify(failure));
    assert.match(result.stderr, /stack availability check failed/, JSON.stringify(failure));
    assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, undefined, JSON.stringify(failure));
  }
});

test('GitHub saying stacked pull requests are not enabled still permits accepted fallback', (t) => {
  const f = setup(t);
  f.accept('T1');
  f.write((d) => { d.apiFailure = { status: 1, stderr: 'HTTP 404: Stacked pull requests are not enabled' }; });

  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
});

test('pull_request webhook stack object appears in task show and the board', (t) => {
  const f = setup(t);
  const stack = { id: 5, pull_requests: [{ number: 11 }, { number: 12 }] };
  const payload = { repository: { full_name: 'acme/app' }, action: 'stacked', pull_request: { number: 11, stack } };
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.deepEqual(f.h.json(['task', 'show', 'T1']).github_stack, stack);
  assert.match(f.h.ok(['task', 'show', 'T1']), /GitHub stack:.*pull_requests/);
  assert.match(fs.readFileSync(path.join(f.h.state, 'sketch.html'), 'utf8'), /GitHub stack.*pull_requests/);
  delete payload.pull_request.stack;
  payload.stack = { id: 8 };
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.deepEqual(f.h.json(['task', 'show', 'T1']).github_stack, payload.stack);
  payload.stack = null;
  f.h.ok(['stack', 'webhook', '-'], { input: JSON.stringify(payload) });
  assert.equal(f.h.json(['task', 'show', 'T1']).github_stack, null);
  payload.repository.full_name = 'fork/app';
  assert.equal(f.h.run(['stack', 'webhook', '-'], { input: JSON.stringify(payload) }).code, 1);
});

test('older gh-stack versions fall back before creating a dependency-based branch', (t) => {
  const f = setup(t);
  f.accept('T1');
  f.write((d) => { d.version = '0.1.1'; });
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
  assert.equal(f.read().calls.some((c) => c.args[0] === 'api' && c.args[1].includes('/stacks')), false);
});

test('gh without the gh-stack extension falls back for accepted dependencies and waits for submitted ones', (t) => {
  const f = setup(t);
  f.write((d) => { d.missingExtension = true; });
  const waiting = f.h.run(['worktree', 'T2']);
  assert.equal(waiting.code, 1);
  assert.match(waiting.stderr, /stacks unavailable; wait for T1/);
  f.accept('T1');
  const wt = f.h.json(['worktree', 'T2']);
  assert.equal(f.h.git(['rev-parse', 'HEAD'], wt.path), f.h.git(['rev-parse', 'main']));
  assert.equal(f.h.json(['task', 'show', 'T2']).stack_disabled, true);
});
