'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, makeTaskRepo, BIN, detachedAlive } = require('./helpers');
const Sessions = require('../lib/spawn-session');
const windowsConcurrency = process.platform === 'win32' ? 2 : false;

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

describe('spawn resume integration cases', { concurrency: windowsConcurrency }, () => {
test('isolated Codex session lookup matches the recorded rollout id', (t) => {
  const h = makeRepo(t);
  const codexHome = path.join(h.base, 'homes', '.codex');
  const codexSession = path.join(codexHome, 'sessions', '2026', '10', '07', 'rollout-test-codex-session.jsonl');
  fs.mkdirSync(path.dirname(codexSession), { recursive: true });
  fs.writeFileSync(codexSession, '{}\n');

  assert.equal(Sessions.missingCodexSession('codex-session', { usageRoot: codexHome }), null);
  assert.equal(Sessions.missingCodexSession('other-session', { usageRoot: codexHome }),
    'recorded codex session has no rollout file in the isolated sessions directory');
});

function setup(t, format = 'codex', session = true) {
  const h = makeTaskRepo(t, [{
    args: ['--title', 'Resume worker', '--acceptance', 'rework resumes'],
    brief: 'Implement the acceptance.\n',
  }]);
  const script = path.join(h.base, 'harness.js');
  const seen = path.join(h.base, 'seen.json');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const cp = require('node:child_process');
const [bin, out, prior, prompt, format, enabled, assigned] = process.argv.slice(2);
const cli = (...args) => cp.execFileSync(process.execPath, [bin, ...args], { stdio: 'pipe' });
const task = JSON.parse(cli('task', 'show', 'T1', '--json'));
fs.writeFileSync(out, JSON.stringify({ prior, prompt, cwd: process.cwd(), agent: process.env.TOWER_CRANE_AGENT, claim: task.claim }));
// The launcher restores resumed claims after its startup receipt.
if (!prior && (!task.claim || task.claim.agent === process.env.TOWER_CRANE_AGENT)) cli('claim', 'T1');
if (enabled === 'true') {
  const record = format === 'codex'
    ? { type: 'thread.started', thread_id: prior || 'worker-session-1' }
    : { type: 'result', session_id: prior || assigned || 'worker-session-1' };
  if (process.env.RESUME_USAGE && format === 'claude') {
    record.usage = prior
      ? { input_tokens: 15, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 7 }
      : { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 };
  }
  const text = JSON.stringify(record);
  process.stdout.write(text.slice(0, 12));
  process.stdout.write(text.slice(12) + '\\n');
  if (process.env.RESUME_USAGE && format === 'codex') {
    console.log(JSON.stringify({ type: 'turn.completed', usage: prior
      ? { input_tokens: 250, cached_input_tokens: 70, output_tokens: 25 }
      : { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } }));
  }
}
if (process.env.RESUME_EXIT_DELAY) setTimeout(() => {}, Number(process.env.RESUME_EXIT_DELAY));
`);
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, BIN, seen, '{session}', '{prompt}', format, String(session)])]);
  return { h, seen, script };
}

function sendBack(h, agent = 'worker-T1-1') {
  h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', agent]);
  h.reviewer('T1', 'reviewer-T1-1');
  h.reviewer('T1', 'reviewer-T1-2', 'abcdef2');
  // Findings under a name no review dispatch started never reach the worker.
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'made-up-reviewer',
    '--summary', 'Forged finding']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef1', '--agent', 'reviewer-T1-1',
    '--summary', 'Missing worktree validation', '--ref', 'review-receipt']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', 'abcdef2', '--agent', 'reviewer-T1-2',
    '--summary', 'Unrelated older head']);
  h.ok(['rework', 'T1', '--reason', 'Add the worktree guard']);
}

function nativeHarness(h, script, seen, harness) {
  fs.appendFileSync(script, `
const path = require('node:path');
const id = prior || 'worker-session-1';
if (format === 'codex') {
  const sessions = path.join(process.env.CODEX_HOME, 'sessions');
  const rollout = path.join(sessions, \`rollout-test-\${id}.jsonl\`);
  if (prior && !fs.existsSync(rollout)) {
    console.error(\`thread/resume failed: no rollout found for thread id \${prior}\`);
    process.exit(1);
  }
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(rollout, '{}\\n');
}
`);
  const bins = path.join(h.base, 'bin');
  fs.mkdirSync(bins, { recursive: true });
  const stub = path.join(bins, harness + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(stub, `#!/usr/bin/env node
  const args = process.argv.slice(2);
  const flag = args.indexOf('--resume');
  const prior = flag >= 0 ? args[flag + 1] : args.includes('worker-session-1') ? 'worker-session-1' : '';
  const assigned = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : '';
  const prompt = args.find((arg) => arg.includes('## Task') || arg.includes('## Rework') || arg.includes('## Interrupt'));
  process.argv = [process.execPath, ${JSON.stringify(script)}, ...${JSON.stringify([BIN, seen])}, prior, prompt, '${harness}', 'true', assigned];
  require(${JSON.stringify(script)});
`, { mode: 0o755 });
  h.env.NODE_OPTIONS = '';
  if (process.platform === 'win32') {
    const hook = path.join(h.base, 'native-harness.js');
    fs.writeFileSync(hook, `
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  return command === '${harness}'
    ? spawn.call(this, process.execPath, [${JSON.stringify(stub)}, ...args], options)
    : spawn.call(this, command, args, options);
};
`);
    // Windows cannot execute the shebang stub directly.
    h.env.NODE_OPTIONS = `--require "${hook.replace(/\\/g, '/')}"`;
  }
  const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  h.env[pathKey] = bins + path.delimiter + (h.env[pathKey] || '');
  h.env.CODEX_HOME = path.join(h.base, 'codex-home');
  h.env.CLAUDE_CONFIG_DIR = path.join(h.base, 'claude-config');
  h.env.RESUME_USAGE = '1';
  h.ok(['ladder', 'set', 'medium', '--harness', harness, '--clear', 'command',
    ...(harness === 'codex' ? ['--profile', 'sol', '--effort', 'high'] : ['--model', 'opus', '--effort', 'high'])]);
}

for (const harness of ['codex', 'claude']) {
  test(`${harness} interrupted native worker keeps dirty files and collects usage before redispatch`, async (t) => {
    const { h, script, seen } = setup(t, harness);
    nativeHarness(h, script, seen, harness);
    h.env.RESUME_EXIT_DELAY = '60000';
    const first = h.json(['spawn', '--task', 'T1']);
    const deadline = Date.now() + 15000;
    while (!events(h).some((e) => e.cmd === 'spawn session')) {
      assert.ok(Date.now() < deadline, 'session not recorded');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Claude's session id is assigned before launch, so the session event does not show that the agent
    // printed anything. Wait for its usage to reach the log, so the interrupt keeps that usage.
    const logged = Date.now() + 15000;
    while (!fs.readFileSync(first.log, 'utf8').includes('"usage"')) {
      assert.ok(Date.now() < logged, 'usage not logged');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fs.writeFileSync(path.join(first.cwd, 'README.md'), '# native unfinished work\n');
    fs.writeFileSync(path.join(first.cwd, 'unfinished.txt'), 'keep native edits\n');
    h.ok(['interrupt', 'T1', '--agent', 'orchestrator']);
    while (detachedAlive({ pid: first.monitor_pid })) {
      assert.ok(Date.now() < deadline, 'supervisor did not stop');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(h.json(['task', 'show', 'T1']).spend.entries.length, 1);
    h.env.RESUME_EXIT_DELAY = '0';
    const second = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(second.resumed, harness === 'codex');
    assert.equal(second.agent === first.agent, harness === 'codex');
    assert.equal(second.cwd, first.cwd);
    const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(input.prior, harness === 'codex' ? 'worker-session-1' : '');
    assert.match(input.prompt, /Interrupt T1/);
    assert.equal(fs.readFileSync(path.join(first.cwd, 'README.md'), 'utf8'), '# native unfinished work\n');
    assert.equal(fs.readFileSync(path.join(first.cwd, 'unfinished.txt'), 'utf8'), 'keep native edits\n');
    const task = h.json(['task', 'show', 'T1']);
    assert.equal(task.revision, 1);
    assert.equal(task.claim.from, 'todo');
    assert.equal(task.spend.entries.length, 2);
    assert.equal(task.spend.tokens, harness === 'codex' ? 275 : 130);
    h.ok(['spend', 'T1', '--from-spawn', second.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, task.spend.tokens);
  });
}

for (const format of ['codex', 'claude']) {
  test(`${format} session output resumes rework with its review note and original claim`, (t) => {
    const { h, seen } = setup(t, format);
    const first = h.json(['spawn', '--task', 'T1', '--wait']);
    const claim = h.json(['task', 'show', 'T1']).claim;
    const receipt = events(h).find((e) => e.cmd === 'spawn session');
    assert.equal(receipt.detail.session_id, 'worker-session-1');
    assert.equal(receipt.detail.harness, 'command');
    assert.equal(receipt.detail.rung, 'medium');
    assert.equal(receipt.detail.cwd, first.cwd);
    sendBack(h);
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(dry.resumed, true);
    assert.equal(dry.agent, first.agent);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.agent, first.agent);
    assert.equal(next.cwd, first.cwd);
    assert.equal(next.session_id, 'worker-session-1');
    assert.equal(next.attempt, 2);
    const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(input.prior, 'worker-session-1');
    assert.match(input.prompt, /Add the worktree guard/);
    assert.match(input.prompt, /Missing worktree validation/);
    assert.match(input.prompt, /review-receipt/);
    assert.ok(!input.prompt.includes('Unrelated older head'));
    assert.ok(!input.prompt.includes('worker-session-1'));
    const held = h.json(['task', 'show', 'T1']).claim;
    assert.equal(held.agent, claim.agent);
    assert.equal(held.since, claim.since);
    assert.equal(held.from, 'rework');
    h.ok(['submit', 'T1', '--sha', 'abcdef3', '--agent', next.agent]);
    h.ok(['rework', 'T1', '--reason', 'Second round']);
    assert.equal(h.json(['spawn', '--task', 'T1', '--wait']).agent, first.agent);
  });
}

test('a detached command harness records its session and resumes with a separate attempt log', async (t) => {
  const { h } = setup(t);
  const first = h.json(['spawn', '--task', 'T1'], { env: { RESUME_EXIT_DELAY: '2000' } });
  const deadline = Date.now() + 10000;
  while (!events(h).some((e) => e.cmd === 'spawn session')) {
    if (Date.now() > deadline) throw new Error('session was not recorded');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const exit = h.json(['wait', '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', '10']);
  assert.equal(exit.detail.agent, first.agent);
  assert.equal(exit.detail.pid, first.pid);
  sendBack(h);
  const next = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(next.agent, first.agent);
  assert.equal(next.resumed, true);
  assert.notEqual(next.log, first.log);
  assert.ok(fs.existsSync(first.log));
});

test('no session record or a changed rung starts a fresh worker', (t) => {
  for (const change of ['missing', 'rung', 'route']) {
    const { h, seen } = setup(t, 'codex', change !== 'missing');
    h.json(['spawn', '--task', 'T1', '--wait']);
    sendBack(h);
    if (change === 'rung') h.ok(['task', 'update', 'T1', '--tier', 'easy']);
    if (change === 'route') h.ok(['ladder', 'set', 'medium', '--args', '["changed-route"]']);
    const next = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(next.resumed, false, change);
    assert.equal(next.agent, 'worker-T1-2', change);
    assert.equal(next.session_id, null, change);
    if (change !== 'rung') {
      const started = h.json(['spawn', '--task', 'T1', '--wait']);
      assert.equal(started.resumed, false);
      assert.equal(started.agent, 'worker-T1-2');
      const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
      assert.equal(input.prior, '');
      assert.match(input.prompt, /## Task/);
    }
  }
});

test('a changed harness or moved worktree starts fresh with the failed review note', (t) => {
  for (const change of ['harness', 'worktree']) {
    const { h, script, seen } = setup(t);
    const first = h.json(['spawn', '--task', 'T1', '--wait']);
    sendBack(h);
    let cwd = first.cwd;
    if (change === 'harness') {
      nativeHarness(h, script, seen, 'codex');
    } else {
      cwd = path.join(h.base, 'moved-worker');
      h.git(['worktree', 'move', first.cwd, cwd]);
    }
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(dry.resumed, false);
    assert.equal(dry.session_id, null);
    assert.equal(dry.agent, 'worker-T1-2');
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.resumed, false);
    assert.equal(next.agent, 'worker-T1-2');
    assert.equal(next.cwd, cwd);
    const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(input.prior, '');
    assert.match(input.prompt, /Add the worktree guard/);
    assert.match(input.prompt, /Missing worktree validation/);
    assert.match(input.prompt, /review-receipt/);
    assert.ok(!input.prompt.includes('worker-session-1'));
    assert.ok(!input.prompt.includes('Unrelated older head'));
    assert.ok(!input.prompt.includes('Forged finding'));
    assert.equal(h.json(['task', 'show', 'T1']).claim.agent, next.agent);
  }
});

test('resume preserves an existing claim and refuses another claimant', (t) => {
  for (const agent of ['worker-T1-1', 'replacement-worker']) {
    const { h } = setup(t);
    h.json(['spawn', '--task', 'T1', '--wait']);
    sendBack(h);
    h.ok(['claim', 'T1', '--agent', agent]);
    const before = h.json(['task', 'show', 'T1']).claim;
    const result = h.run(['spawn', '--task', 'T1', '--wait']);
    assert.equal(result.code, agent === 'worker-T1-1' ? 0 : 1, result.stderr);
    if (result.code) assert.match(result.stderr, /cannot resume .* while claimed by replacement-worker/);
    assert.deepEqual(h.json(['task', 'show', 'T1']).claim, before);
  }
});

test('resume obeys worker limits and blockers before restoring a claim', (t) => {
  const { h } = setup(t);
  h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  h.ok(['project', 'set', '--workers', '1']);
  h.ok(['task', 'add', '--title', 'Occupy slot', '--acceptance', 'held']);
  h.ok(['claim', 'T2', '--agent', 'other-worker']);
  let result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /workers limit is reached/);
  h.ok(['release', 'T2', '--agent', 'other-worker', '--reason', 'done']);
  h.ok(['task', 'update', 'T1', '--needs-owner', 'resolve requirement']);
  result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /is blocked/);
  assert.equal(h.json(['task', 'show', 'T1']).claim, null);
});

for (const harness of ['codex', 'claude']) {
  test(`${harness} native rework ${harness === 'codex' ? 'resumes' : 'starts fresh'} without putting the recorded id in the prompt`, (t) => {
    const { h, script, seen } = setup(t, harness);
    nativeHarness(h, script, seen, harness);
    const first = h.json(['spawn', '--task', 'T1', '--wait']);
    const receipt = events(h).find((e) => e.cmd === 'spawn session');
    assert.equal(receipt.detail.session_id, harness === 'codex' ? 'worker-session-1' : first.session_id);
    assert.equal(receipt.detail.harness, harness);
    sendBack(h);
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(dry.harness, harness);
    assert.equal(dry.resumed, harness === 'codex');
    if (harness === 'codex') assert.equal(dry.session_id, 'worker-session-1');
    else {
      assert.match(dry.session_id, /^[a-f0-9-]{36}$/);
      assert.notEqual(dry.session_id, first.session_id);
    }
    if (harness === 'codex') {
      assert.deepEqual(dry.argv.slice(0, 5), ['codex', 'exec', '-p', 'sol', 'resume']);
      assert.ok(dry.argv.includes('--json'));
    } else {
      assert.deepEqual(dry.argv.slice(0, 2), ['claude', '-p']);
      assert.ok(!dry.argv.includes('--resume'));
      assert.ok(!dry.argv.includes('--fork-session'));
    }
    const next = h.json(['spawn', '--task', 'T1', '--wait']);
    assert.equal(next.resumed, harness === 'codex');
    assert.equal(next.agent, harness === 'codex' ? 'worker-T1-1' : 'worker-T1-2');
    const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.equal(input.prior, harness === 'codex' ? 'worker-session-1' : '');
    if (harness === 'codex') {
      assert.ok(!input.prompt.includes('## Role instructions: tower-crane-work'));
      assert.ok(!input.prompt.includes('# Tower Crane: work one task'));
    } else {
      assert.ok(input.prompt.startsWith('## Role instructions: tower-crane-work'));
      assert.ok(input.prompt.includes('# Tower Crane: work one task'));
    }
    assert.match(input.prompt, /Add the worktree guard/);
    assert.match(input.prompt, /Missing worktree validation/);
    assert.match(input.prompt, /review-receipt/);
    assert.ok(!input.prompt.includes('worker-session-1'));
    const spend = h.json(['task', 'show', 'T1']).spend;
    assert.equal(spend.tokens, harness === 'codex' ? 275 : 130);
    assert.equal(spend.cached, harness === 'codex' ? 70 : 40);
    assert.deepEqual(spend.entries.map((e) => e.source), ['spawn:worker-T1-1', harness === 'codex' ? 'spawn:worker-T1-1:attempt:2' : 'spawn:worker-T1-2']);
    h.json(['spend', 'T1', '--from-spawn', next.agent]);
    assert.deepEqual(h.json(['task', 'show', 'T1']).spend, spend, 'a repeated collector cannot double count either attempt');
    const reviewer = h.json(['spawn', '--task', 'T1', '--role', 'review', '--dry-run']);
    assert.equal(reviewer.resumed, false);
  });
}

test('a missing isolated codex rollout falls back to a fresh worker and records why', (t) => {
  const { h, script, seen } = setup(t, 'codex');
  nativeHarness(h, script, seen, 'codex');
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  const rollout = path.join(first.codex_home, 'sessions', 'rollout-test-worker-session-1.jsonl');
  assert.ok(fs.existsSync(rollout));
  fs.unlinkSync(rollout);
  sendBack(h);
  h.ok(['claim', 'T1', '--agent', first.agent]);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, first.agent);

  const result = h.run(['spawn', '--task', 'T1', '--wait', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const next = JSON.parse(result.stdout);
  assert.equal(next.resumed, false);
  assert.equal(next.agent, 'worker-T1-2');
  assert.equal(next.session_id, null);
  const log = events(h);
  const spawn = log.findLast((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.agent === next.agent);
  assert.equal(spawn.detail.resume_fallback_reason, 'recorded codex session has no rollout file in the isolated sessions directory');
  const claim = log.findLast((e) => e.cmd === 'claim' && e.task === 'T1' && e.detail.holder === next.agent);
  assert.equal(claim.detail.took_over_from, first.agent);
  assert.ok(log.indexOf(claim) < log.indexOf(spawn), 'the fresh spawn takes ownership before its spawn event');
  assert.ok(log.some((e) => e.cmd === 'claim' && e.task === 'T1' && e.agent === next.agent && e.detail.renewed),
    'the fresh worker can repeat its startup claim after the transfer commits');
  const held = h.json(['task', 'show', 'T1']).claim;
  assert.equal(held.agent, next.agent);
  assert.equal(held.from, 'rework');
  const input = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(input.prior, '');
  assert.equal(input.claim.agent, next.agent, 'the committed transfer is visible when the child starts');
  assert.match(input.prompt, /Add the worktree guard/);
  assert.match(input.prompt, /Missing worktree validation/);
  assert.equal(first.agent, 'worker-T1-1');
});

test('a pre-launch fallback failure restores the old claim and permits retry', (t) => {
  const { h, script, seen } = setup(t, 'codex');
  nativeHarness(h, script, seen, 'codex');
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  h.ok(['claim', 'T1', '--agent', first.agent]);
  const before = h.json(['task', 'show', 'T1']).claim;
  fs.unlinkSync(path.join(first.codex_home, 'sessions', 'rollout-test-worker-session-1.jsonl'));

  const occupiedLog = path.join(h.state, 'logs', 'T1-worker-T1-2.log');
  fs.writeFileSync(occupiedLog, 'preserve this log\n');
  const failed = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /EEXIST: log already exists/);
  assert.deepEqual(h.json(['task', 'show', 'T1']).claim, before);
  const afterFailure = events(h);
  const rollback = afterFailure.findLast((e) => e.cmd === 'claim' && e.task === 'T1' && e.detail.rollback);
  assert.deepEqual([rollback.detail.holder, rollback.detail.restored_from], [first.agent, 'worker-T1-2']);
  assert.ok(!afterFailure.some((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.agent === 'worker-T1-2'));
  assert.equal(fs.readFileSync(occupiedLog, 'utf8'), 'preserve this log\n');

  fs.unlinkSync(occupiedLog);
  const retry = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(retry.agent, 'worker-T1-2');
  assert.equal(retry.resumed, false);
  assert.equal(h.json(['task', 'show', 'T1']).claim.agent, retry.agent);
  assert.equal(JSON.parse(fs.readFileSync(seen, 'utf8')).claim.agent, retry.agent);
});

test('a still-running worker cannot be resumed', async (t) => {
  const { h, script } = setup(t);
  const ready = path.join(h.base, 'live-ready');
  fs.appendFileSync(script, `\nfs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const first = h.json(['spawn', '--task', 'T1']);
  t.after(() => { try { process.kill(first.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) || fs.readFileSync(ready, 'utf8') !== String(first.pid)) {
    if (Date.now() > deadline) throw new Error('worker did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  sendBack(h);
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /still running or its exit is unverified/);
  assert.match(result.stderr, /wait for its exit, then retry tower-crane spawn --task T1/);
});

test('a foreground exit receipt permits resume even when its pid is reused', (t) => {
  const { h } = setup(t);
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  const hook = path.join(h.base, 'reused-pid.js');
  fs.writeFileSync(hook, `
const kill = process.kill;
process.kill = function(pid, signal) {
  if (pid === ${first.pid} && signal === 0) return true;
  return kill.call(this, pid, signal);
};
`);
  h.env.NODE_OPTIONS = `--require "${hook.replace(/\\/g, '/')}"`;
  const next = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(next.resumed, true);
  assert.equal(next.agent, first.agent);
});

test('exit receipts without attempt match the latest spawn by task, agent and pid', (t) => {
  const { h } = setup(t);
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  const receipt = events(h).find((e) => e.cmd === 'spawn exit' && e.detail.pid === first.pid);
  assert.equal(receipt.detail.attempt, first.attempt);
  sendBack(h);
  const hook = path.join(h.base, 'unverified-exit.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const kill = process.kill;
process.kill = function(pid, signal) {
  if (pid === ${first.pid} && signal === 0) return true;
  return kill.call(this, pid, signal);
};
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file) === '/proc/${first.pid}/stat') throw Object.assign(new Error('unavailable'), { code: 'EACCES' });
  const value = read.call(this, file, ...args);
  if (!String(file).endsWith('events.jsonl') || typeof value !== 'string') return value;
  return value.split('\\n').map((line) => {
    if (!line) return line;
    const event = JSON.parse(line);
    if (event.cmd === 'spawn exit' && event.detail.pid === ${first.pid}) delete event.detail.attempt;
    return JSON.stringify(event);
  }).join('\\n');
};
`);
  for (const args of [
    ['spawn', '--task', 'T1', '--dry-run'],
    ['spend', 'T1', '--from-spawn', first.agent],
  ]) {
    const r = h.run(args, { env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` } });
    assert.equal(r.code, 0, r.stderr);
  }
});

test('the shared eligibility check compares route values independent of key order', (t) => {
  const { h } = setup(t);
  h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  const hook = path.join(h.base, 'route-order.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = read.call(this, file, ...args);
  if (!String(file).endsWith('events.jsonl') || typeof value !== 'string') return value;
  return value.split('\\n').map((line) => {
    if (!line) return line;
    const event = JSON.parse(line);
    if (event.cmd === 'spawn' && event.detail.route) event.detail.route = Object.fromEntries(Object.entries(event.detail.route).reverse());
    return JSON.stringify(event);
  }).join('\\n');
};
`);
  const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], {
    env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` },
  });
  assert.equal(dry.resumed, true);
});

test('an earlier attempt exit cannot collect or resume a live attempt with a reused pid', async (t) => {
  const { h, script } = setup(t);
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  const ready = path.join(h.base, 'live-ready');
  fs.appendFileSync(script, `\nfs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const live = h.json(['spawn', '--task', 'T1']);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) || fs.readFileSync(ready, 'utf8') !== String(live.pid)) {
    if (Date.now() > deadline) throw new Error('resumed worker did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  h.ok(['submit', 'T1', '--sha', 'abcdef3', '--agent', live.agent]);
  h.ok(['rework', 'T1', '--reason', 'Finish next attempt']);
  const hook = path.join(h.base, 'reused-spawn.js');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = read.call(this, file, ...args);
  if (String(file).endsWith('events.jsonl') && typeof value === 'string') {
    return value.split('\\n').map((line) => {
      if (!line) return line;
      const event = JSON.parse(line);
      if (event.cmd === 'spawn exit' && event.detail.pid === ${first.pid}) {
        event.detail.pid = ${live.pid};
        if (process.env.OMIT_EXIT_ATTEMPT) delete event.detail.attempt;
      }
      return JSON.stringify(event);
    }).join('\\n');
  }
  return value;
};
`);
  for (const missing of ['', '1']) {
    for (const args of [
      ['spend', 'T1', '--from-spawn', live.agent],
      ['spawn', '--task', 'T1', '--dry-run'],
    ]) {
      const result = h.run(args, { env: { NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"`, OMIT_EXIT_ATTEMPT: missing } });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /still running or its exit is unverified/);
    }
  }
});

test('an expired resumed claim needs room and keeps its original since', (t) => {
  const { h } = setup(t);
  h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1', '--lease', '1']);
  const before = h.json(['task', 'show', 'T1']).claim;
  h.ok(['project', 'set', '--workers', '1']);
  h.ok(['task', 'add', '--title', 'Other worker', '--acceptance', 'slot']);
  const clock = path.join(h.base, 'clock');
  fs.writeFileSync(clock, String(Date.now() + 120000));
  const opts = { hooks: { HOOK_CLOCK_FILE: clock } };
  h.ok(['claim', 'T2', '--agent', 'other-worker'], opts);
  const refused = h.run(['spawn', '--task', 'T1', '--wait'], opts);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /workers limit is reached/);
  h.ok(['release', 'T2', '--agent', 'other-worker', '--reason', 'done'], opts);
  h.json(['spawn', '--task', 'T1', '--wait'], opts);
  const after = h.json(['task', 'show', 'T1']).claim;
  assert.equal(after.agent, before.agent);
  assert.equal(after.since, before.since);
  assert.ok(Date.parse(after.until) > Number(fs.readFileSync(clock, 'utf8')));
});

test('a failed resume launch leaves the task, claim and receipts unchanged', (t) => {
  const { h } = setup(t);
  h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  const before = h.readState('tasks.json');
  const audit = events(h);
  const failed = h.run(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_SPAWN_FAIL: '1' } });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /could not start/);
  assert.deepEqual(h.readState('tasks.json'), before);
  assert.deepEqual(events(h), audit);
  assert.equal(h.json(['spawn', '--task', 'T1', '--wait']).resumed, true);
});
});
