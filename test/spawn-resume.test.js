'use strict';

const { HUNG_TEST_MS, waitOnRepo, killPid } = require('./signals');
const { readPublished } = require('./atomic-file');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, makeTaskRepo, BIN, detachedAlive, TMP_ROOT } = require('./helpers');
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
  // Harness discovery must use fixture credentials and origin directories.
  Object.assign(h.env, {
    USERPROFILE: h.env.HOME,
    CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'),
    CODEX_HOME: path.join(h.env.HOME, '.codex'),
    PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
    GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'),
    XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(h.env.HOME, '.config', 'opencode'),
  });
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
if (process.env.RESUME_EXIT_DELAY) setTimeout(() => {}, Number(process.env.RESUME_EXIT_DELAY)); // wait-allow: fixture injects exit delay to exercise resume while finalization is pending
`);
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, BIN, seen, '{session}', '{prompt}', format, String(session)])]);
  return { h, seen, script };
}

function sendBack(h, agent = 'worker-T1-1') {
  h.ok(['submit', 'T1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', agent]);
  h.reviewer('T1', 'reviewer-T1-1');
  h.reviewer('T1', 'reviewer-T1-2', '5bfcb6f56ab912a009883c798a61298c507dada4');
  // Findings under a name no review dispatch started never reach the worker.
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', 'made-up-reviewer',
    '--summary', 'Forged finding']);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--fail', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', 'reviewer-T1-1',
    '--summary', 'Missing worktree validation', '--ref', 'review-receipt']);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--revision', h.revision('T1'), '--agent', 'reviewer-T1-2',
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
  h.env.CLAUDE_CONFIG_DIR = path.join(h.base, 'harness-config');
  h.env.RESUME_USAGE = '1';
  h.ok(['ladder', 'set', 'medium', '--harness', harness, '--clear', 'command',
    ...(harness === 'codex' ? ['--profile', 'fixture-main', '--effort', 'high'] : ['--model', 'fixture-large', '--effort', 'high'])]);
}

for (const harness of ['codex', 'claude']) {
  test(`${harness} interrupted native worker keeps dirty files and collects usage before redispatch`, async (t) => {
    const { h, script, seen } = setup(t, harness);
    nativeHarness(h, script, seen, harness);
    h.env.RESUME_EXIT_DELAY = '60000';
    const first = h.json(['spawn', '--task', 'T1']);
    await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'));
    // Claude's session id is assigned before launch, so the session event does not show that the agent
    // printed anything. Wait for its usage to reach the log, so the interrupt keeps that usage.
    await waitOnRepo(h, () => fs.readFileSync(first.log, 'utf8').includes('"usage"'));
    fs.writeFileSync(path.join(first.cwd, 'README.md'), '# native unfinished work\n');
    fs.writeFileSync(path.join(first.cwd, 'unfinished.txt'), 'keep native edits\n');
    const after = String(fs.statSync(path.join(h.state, 'events.jsonl')).size);
    // Model Windows startup consuming the session deadline before interruption.
    // The shutdown wait must use completion receipts independently of that clock.
    const clockBeforeInterrupt = Date.now();
    const startupClock = t.mock.method(Date, 'now', () => clockBeforeInterrupt + HUNG_TEST_MS + 1);
    let spent;
    try {
      h.ok(['interrupt', 'T1', '--agent', 'orchestrator']);
      // Final spend follows pipe closure, process cleanup and the stopped phase.
      // Capture the cursor before interrupt so a fast exit cannot be missed.
      spent = h.json(['wait', '--after', after, '--task', 'T1', '--types', 'spend',
        '--observe', '--timeout', '300', '--agent', 'orchestrator']);
    } finally {
      startupClock.mock.restore();
    }
    assert.equal(spent.detail.source, `spawn:${first.agent}`);
    assert.equal(spent.detail.tokens, harness === 'codex' ? 110 : 65);
    assert.equal(spent.detail.live, undefined);
    const receipts = events(h);
    const stopped = receipts.findLast((e) => e.cmd === 'spawn phase'
      && e.detail.agent === first.agent);
    assert.equal(stopped.detail.phase, 'stopped');
    assert.equal(stopped.detail.active, false);
    assert.equal(stopped.detail.monitor_pid, first.monitor_pid);
    assert.ok(receipts.some((e) => e.cmd === 'spawn exit'
      && e.detail.agent === first.agent && e.detail.pid === first.pid));
    const interrupted = h.json(['task', 'show', 'T1']);
    assert.equal(interrupted.spend.entries.length, 1);
    assert.equal(interrupted.spend.entries[0].live, undefined);
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
    const reworked = h.json(['task', 'show', 'T1']);
    assert.equal(reworked.revision, 2);
    assert.equal(reworked.evidence[0].revision, 1);
    h.ok(['task', 'update', 'T1', '--acceptance', 'rework resumes with the revised acceptance']);
    h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', h.revision('T1'), '--agent', 'later-reviewer',
      '--summary', 'Unrelated later revision']);
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
    assert.ok(!input.prompt.includes('Unrelated later revision'));
    assert.ok(!input.prompt.includes('worker-session-1'));
    const held = h.json(['task', 'show', 'T1']).claim;
    assert.equal(held.agent, claim.agent);
    assert.equal(held.since, claim.since);
    assert.equal(held.from, 'rework');
    h.ok(['submit', 'T1', '--sha', 'cfed4d76efd3afe887bbbfc7f62c7d94158e3255', '--agent', next.agent]);
    h.ok(['rework', 'T1', '--reason', 'Second round']);
    assert.equal(h.json(['spawn', '--task', 'T1', '--wait']).agent, first.agent);
  });
}

test('a detached command harness records its session and resumes with a separate attempt log', async (t) => {
  const { h } = setup(t);
  const first = h.json(['spawn', '--task', 'T1'], { env: { RESUME_EXIT_DELAY: '2000' } });
  await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn session'));
  const exit = h.json(['wait', '--observe', '--after', '0', '--task', 'T1', '--types', 'worker-exited', '--timeout', '300']);
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
    const scratch = h.json(['task', 'show', 'T1']).scratch;
    fs.writeFileSync(path.join(scratch, 'receipt.txt'), 'earlier measurement\n');
    const receipt = events(h).find((e) => e.cmd === 'spawn session');
    assert.equal(receipt.detail.session_id, harness === 'codex' ? 'worker-session-1' : first.session_id);
    assert.equal(receipt.detail.harness, harness);
    sendBack(h);
    h.env.XDG_CACHE_HOME = path.join(h.base, 'another-cache');
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run']);
    assert.equal(dry.harness, harness);
    assert.equal(dry.resumed, harness === 'codex');
    if (harness === 'codex') assert.equal(dry.session_id, 'worker-session-1');
    else {
      assert.match(dry.session_id, /^[a-f0-9-]{36}$/);
      assert.notEqual(dry.session_id, first.session_id);
    }
    if (harness === 'codex') {
      assert.deepEqual(dry.argv.slice(0, 5), ['codex', 'exec', '-p', 'fixture-main', 'resume']);
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
    assert.ok(input.prompt.includes(scratch), 'fresh and resumed workers are told where earlier scratch lives');
    assert.equal(h.json(['task', 'show', 'T1']).scratch, scratch);
    assert.equal(fs.readFileSync(path.join(scratch, 'receipt.txt'), 'utf8'), 'earlier measurement\n');
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

for (const format of ['codex', 'claude', 'native-codex']) {
  for (const freshOverflow of [false, true]) {
    test(`${format} resumed context overflow retries fresh once${freshOverflow ? ' even if fresh also overflows' : ''}`, (t) => {
      const { h, script } = setup(t, format);
      const calls = path.join(h.base, 'calls.jsonl');
      const error = format !== 'claude'
        ? { type: 'turn.failed', error: { message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." } }
        : { type: 'result', is_error: true, errors: ['Prompt is too long'], subtype: 'error_during_execution' };
      fs.writeFileSync(script, `
const fs = require('node:fs');
const cp = require('node:child_process');
const [bin, out, prior, prompt, format] = process.argv.slice(2);
const task = JSON.parse(cp.execFileSync(process.execPath, [bin, 'task', 'show', 'T1', '--json'], { encoding: 'utf8' }));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ prior, prompt, cwd: process.cwd(), agent: process.env.TOWER_CRANE_AGENT, claim: task.claim }) + '\\n');
if (prior || (${freshOverflow} && prompt.includes('## Rework'))) {
  console.log(JSON.stringify(${JSON.stringify(error)}));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: prompt.includes('## Rework') ? 'fresh-session-2' : 'worker-session-1' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 } }));
`);
      if (format === 'native-codex') {
        nativeHarness(h, script, path.join(h.base, 'seen.json'), 'codex');
        fs.mkdirSync(h.env.CODEX_HOME, { recursive: true });
        fs.writeFileSync(path.join(h.env.CODEX_HOME, 'config.toml'), '[profiles.fixture-main]\nmodel = "fixture-large"\n');
      }
      const first = h.json(['spawn', '--task', 'T1', '--wait']);
      sendBack(h);
      h.ok(['claim', 'T1', '--agent', first.agent]);
      const claim = h.json(['task', 'show', 'T1']).claim;
      const result = h.run(['spawn', '--task', 'T1', '--wait', '--json']);
      assert.equal(result.code, freshOverflow ? 1 : 0, result.stderr);
      const inputs = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(inputs.length, 3, 'one resumed invocation and exactly one fresh retry');
      assert.equal(inputs[1].prior, 'worker-session-1');
      assert.equal(inputs[2].prior, '');
      assert.equal(inputs[2].agent, first.agent);
      assert.equal(inputs[2].cwd, first.cwd);
      assert.deepEqual(inputs[2].claim, claim);
      assert.match(inputs[2].prompt, /Project goal: prove the engine/);
      if (format === 'native-codex') assert.match(inputs[2].prompt, /## Role instructions: tower-crane-work/);
      assert.match(inputs[2].prompt, /## Task/);
      assert.match(inputs[2].prompt, /Implement the acceptance/);
      assert.match(inputs[2].prompt, /Add the worktree guard/);
      assert.match(inputs[2].prompt, /Missing worktree validation/);
      assert.match(inputs[2].prompt, /review-receipt/);
      assert.deepEqual(h.json(['task', 'show', 'T1']).claim, claim);
      const fallbacks = events(h).filter((e) => e.cmd === 'spawn fallback');
      assert.equal(fallbacks.length, 1);
      assert.equal(fallbacks[0].detail.reason, 'session context overflow');
      assert.equal(fallbacks[0].detail.previous.session_id, 'worker-session-1');
      assert.equal(fallbacks[0].detail.previous.overflowed, true);
      assert.equal(fallbacks[0].detail.route_index, 0);
      assert.equal(fallbacks[0].detail.fresh, true);
      assert.equal(events(h).filter((e) => e.cmd === 'spawn retry').length, 0);
      const audit = events(h);
      const prior = audit.findLast((e) => e.cmd === 'spawn').detail;
      const candidate = { cmd: 'spawn', task: 'T1', detail: {
        ...prior, attempt: prior.attempt + 1, session_id: 'worker-session-1', pid: 999999999,
      } };
      const history = [...audit, candidate, { cmd: 'spawn exit', task: 'T1', detail: candidate.detail }];
      const policy = { job: 'worker', task: { id: 'T1', status: 'rework', submitted_by: first.agent },
        rung: prior.route, rungName: prior.rung };
      assert.equal(Sessions.eligible(policy, first.cwd, history), null, 'overflowed ids stay excluded in later attempts');
      assert.equal(Sessions.eligible(policy, first.cwd, history.filter((e) => e.cmd !== 'spawn fallback')).id,
        'worker-session-1', 'the overflow marker is what excludes the id');
      assert.equal(Sessions.eligible(policy, first.cwd, [
        ...history.filter((e) => e.cmd !== 'spawn fallback'),
        { cmd: 'spawn exit', task: 'T1', detail: { ...candidate.detail, overflowed: true } },
      ]), null, 'an overflow exit excludes the session even without a fallback');
      if (freshOverflow) assert.equal(audit.findLast((e) => e.cmd === 'spawn exit').detail.overflowed, true);
      const spend = h.json(['task', 'show', 'T1']).spend;
      const freshUsage = spend.entries.find((e) => e.source === `spawn:${first.agent}:attempt:2:retry:0`);
      assert.ok(freshUsage, 'fresh fallback has a separate usage receipt');
      assert.equal(freshUsage.live, undefined, 'exit collection finalizes fresh fallback usage');
      if (!freshOverflow && format === 'native-codex') assert.equal(freshUsage.tokens, 11);
      h.ok(['spend', 'T1', '--from-spawn', first.agent]);
      assert.deepEqual(h.json(['task', 'show', 'T1']).spend, spend, 'collection cannot double count fallback usage');
      h.ok(['submit', 'T1', '--sha', 'cfed4d76efd3afe887bbbfc7f62c7d94158e3255', '--agent', first.agent]);
      h.ok(['rework', 'T1', '--reason', 'Next round']);
      assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run']).resumed, false);
    });
  }
}

test('a resumed overflow recovered by the harness completes without a fresh retry', (t) => {
  const { h, script } = setup(t, 'claude');
  const calls = path.join(h.base, 'recovered-calls.jsonl');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const [bin, out, prior] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ prior }) + '\\n');
if (prior) {
  console.log(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Prompt is too long' }] } }));
}
console.log(JSON.stringify({ type: 'result', session_id: prior || 'worker-session-1', is_error: false }));
`);
  h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  assert.equal(h.run(['spawn', '--task', 'T1', '--wait']).code, 0);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  const audit = events(h);
  assert.equal(audit.filter((e) => e.cmd === 'spawn fallback').length, 0);
  assert.equal(audit.findLast((e) => e.cmd === 'spawn exit').detail.overflowed, undefined);
  assert.equal(audit.findLast((e) => e.cmd === 'spawn phase').detail.phase, 'waiting');
});

test('a fresh native Claude outage retry that overflows blocks without another fresh retry', (t) => {
  const { h, script, seen } = setup(t, 'claude');
  nativeHarness(h, script, seen, 'claude');
  const calls = path.join(h.base, 'claude-calls.json');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const file = ${JSON.stringify(calls)};
// read-published: this stub writes the file in place; nothing replaces it.
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
calls.push(process.argv.slice(2));
fs.writeFileSync(file, JSON.stringify(calls));
console.log(JSON.stringify({ type: 'result', is_error: true, errors: [calls.length === 1 ? 'HTTP 503 service unavailable' : 'Prompt is too long'] }));
process.exit(1);
`);
  h.ok(['ladder', 'set', 'medium', '--supervision', JSON.stringify({
    retries: 1, backoff_ms: 10, max_backoff_ms: 10, stall_ms: 60000,
  })]);
  const result = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(fs.readFileSync(calls, 'utf8')).length, 2);
  const audit = events(h);
  assert.equal(audit.filter((e) => e.cmd === 'spawn retry').length, 1);
  assert.equal(audit.filter((e) => e.cmd === 'spawn fallback').length, 0);
  assert.equal(audit.findLast((e) => e.cmd === 'spawn exit').detail.overflowed, true);
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
  // A directory, since a plain file there would be moved aside as a failed start's log.
  fs.mkdirSync(occupiedLog);
  const failed = h.run(['spawn', '--task', 'T1', '--wait']);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /EEXIST: log already exists/);
  assert.deepEqual(h.json(['task', 'show', 'T1']).claim, before);
  const afterFailure = events(h);
  const rollback = afterFailure.findLast((e) => e.cmd === 'claim' && e.task === 'T1' && e.detail.rollback);
  assert.deepEqual([rollback.detail.holder, rollback.detail.restored_from], [first.agent, 'worker-T1-2']);
  assert.ok(!afterFailure.some((e) => e.cmd === 'spawn' && e.task === 'T1' && e.detail.agent === 'worker-T1-2'));
  assert.ok(fs.statSync(occupiedLog).isDirectory());

  fs.rmdirSync(occupiedLog);
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
  t.after(() => { try { killPid(first.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } });
  await waitOnRepo(h, () => fs.existsSync(ready) && readPublished(ready, 'utf8') === String(first.pid));
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
  await waitOnRepo(h, () => fs.existsSync(ready) && readPublished(ready, 'utf8') === String(live.pid));
  h.ok(['submit', 'T1', '--sha', 'cfed4d76efd3afe887bbbfc7f62c7d94158e3255', '--agent', live.agent]);
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

// A failed resume start records no spawn, so the next resume takes the same
// attempt log name. The log there is moved aside only when no recorded spawn
// of the agent may still be running; from another host its processes are unknown.
test('a resume moves an earlier start\'s attempt log aside only once no recorded spawn of the agent may still run', (t) => {
  const { h } = setup(t);
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  sendBack(h);
  const logs = path.dirname(first.log);
  const log = path.join(logs, `T1-${first.agent}-attempt-2.log`);
  fs.writeFileSync(log, 'an earlier start\n');
  const audit = events(h);
  const refused = h.run(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_HOSTNAME: 'another-host' } });
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /EEXIST: log already exists/);
  assert.equal(fs.readFileSync(log, 'utf8'), 'an earlier start\n');
  assert.deepEqual(fs.readdirSync(logs).filter((n) => n.includes('startup-failed')), []);
  assert.ok(!events(h).slice(audit.length).some((e) => e.cmd === 'spawn'));

  const next = h.run(['spawn', '--task', 'T1', '--wait', '--json']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).resumed, true);
  const aside = fs.readdirSync(logs).filter((n) => n.includes('startup-failed'));
  assert.equal(aside.length, 1, aside.join(', '));
  assert.equal(fs.readFileSync(path.join(logs, aside[0]), 'utf8'), 'an earlier start\n');
  assert.ok(next.stderr.includes(`tower-crane: moved ${log}, left by a start that failed before it was recorded, to ${path.join(logs, aside[0])}\n`), next.stderr);
});

// Windows records no start time with a pid and reuses a freed pid within
// seconds, so the guard above asks Windows when the process now at a recorded
// pid was created. These run that path in process with a stand-in for
// PowerShell, on live pids that the signal check cannot tell apart from the
// recorded processes.
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const filetime = (ms) => String(BigInt(ms) * 10000n + FILETIME_UNIX_EPOCH);
const powershellStub = (asked, lines, result = {}) => (cmd, args, options) => {
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  asked.push({ cmd, pids: script.match(/@\(([^)]*)\)/)[1], script, timeout: options.timeout });
  return { status: 0, stdout: lines.map((line) => `${line}\r\n`).join(''), ...result };
};

test('a recorded spawn whose pids Windows gave to processes created after it counts as gone', (t) => {
  const P = require('../lib/processes');
  const os = require('node:os');
  const cp = require('node:child_process');
  const live = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); // wait-allow: a process group that runs until the test kills it
  t.after(() => killPid(live.pid, 'SIGKILL'));
  const at = Date.parse('2026-10-16T11:00:00.000Z');
  const detail = { host: os.hostname(), pid: live.pid, monitor_pid: process.pid };
  assert.deepEqual(P.spawnPids(detail), [process.pid, live.pid]);
  const after = at + 5000;
  // Creation times come from UTC FILETIMEs, never from a local time.
  const asked = [];
  const created = P.windowsCreated([process.pid, live.pid], 5000,
    powershellStub(asked, [`${process.pid} ${filetime(after)}`, `${live.pid} ${filetime(after + 1)}`, `4 ${filetime(after)}`, 'Access is denied.']));
  assert.deepEqual([...created], [[process.pid, after], [live.pid, after + 1]]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].cmd, 'powershell.exe');
  assert.equal(asked[0].pids, `${process.pid},${live.pid}`);
  assert.equal(asked[0].timeout, 5000);
  assert.match(asked[0].script, /StartTime\.ToFileTimeUtc\(\)/);
  assert.doesNotMatch(asked[0].script, /CreationDate|ToUniversalTime/);
  assert.equal(P.spawnGone(detail, at, created, 'win32'), true);
  // A process created before the event was recorded, or within the clock
  // allowance after it, may be the recorded one.
  assert.equal(P.spawnGone(detail, at, new Map([[live.pid, after], [process.pid, at - 5000]]), 'win32'), false);
  assert.equal(P.spawnGone(detail, at, new Map([[live.pid, after], [process.pid, at + 50]]), 'win32'), false);
  // A spawn recorded at 02:45 CEST on 2026-10-25, the first pass of the hour
  // Europe repeats, whose supervisor started at 02:30 CEST (00:30 UTC). A
  // local 02:30 read as standard time is 01:30 UTC, after the event, and would
  // call the running spawn gone; its FILETIME keeps it running.
  const dst = Date.parse('2026-10-25T00:45:00.000Z');
  const firstPass = P.windowsCreated([process.pid, live.pid], 5000,
    powershellStub([], [`${process.pid} ${filetime(Date.parse('2026-10-25T00:30:00.000Z'))}`, `${live.pid} ${filetime(dst + 5000)}`]));
  assert.equal(P.spawnGone(detail, dst, firstPass, 'win32'), false);
  // A time PowerShell did not report, or a PowerShell that failed, proves nothing.
  assert.equal(P.spawnGone(detail, at, new Map([[live.pid, after]]), 'win32'), false);
  assert.deepEqual([...P.windowsCreated([process.pid], 5000, powershellStub([], [`${process.pid} ${filetime(after)}`], { status: 1 }))], []);
  assert.deepEqual([...P.windowsCreated([process.pid], 5000, powershellStub([], [`${process.pid} ${filetime(after)}`], { error: new Error('spawnSync powershell.exe ETIMEDOUT') }))], []);
  assert.equal(P.spawnGone(detail, NaN, created, 'win32'), false);
  // Another host's pids, and systems with a start time of their own, take no creation time.
  assert.equal(P.spawnGone({ ...detail, host: 'another-host' }, at, created, 'win32'), false);
  if (process.platform !== 'win32') assert.equal(P.spawnGone(detail, at, created, process.platform), false);
  // Exited processes need no creation time.
  const done = cp.spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.deepEqual(P.spawnPids({ host: os.hostname(), pid: done.pid, monitor_pid: done.pid }), []);
  assert.equal(P.spawnGone({ host: os.hostname(), pid: done.pid, monitor_pid: done.pid }, at, new Map(), 'win32'), true);
});

// Windows PowerShell on Windows; on Linux PowerShell 7 when it is installed
// (GitHub's Ubuntu runners have it), which runs the same script.
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe'
  : process.platform === 'linux' && require('node:child_process').spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 300000 }).status === 0 ? 'pwsh' : null;

test('PowerShell reads a running process\'s creation time as UTC epoch ms', {
  skip: !POWERSHELL && 'no PowerShell',
}, (t) => {
  const P = require('../lib/processes');
  const cp = require('node:child_process');
  const from = Date.now();
  const live = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); // wait-allow: a process that runs until the test kills it
  t.after(() => killPid(live.pid, 'SIGKILL'));
  const to = Date.now();
  const created = P.windowsCreated([live.pid, 2147483644], 300000, (cmd, args, options) => cp.spawnSync(POWERSHELL, args, options));
  assert.deepEqual([...created.keys()], [live.pid]);
  // Linux reads the start in clock ticks from a boot time PowerShell derives itself.
  assert.ok(created.get(live.pid) >= from - 1000 && created.get(live.pid) <= to + 1000, `${created.get(live.pid)} not in ${from}..${to}`);
});

test('Windows reads the creation times for every recorded spawn of the task in one call, and only when a failed start left a log', (t) => {
  const { recordedCreated } = require('../lib/spawn');
  const os = require('node:os');
  const cp = require('node:child_process');
  const live = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); // wait-allow: a process group that runs until the test kills it
  t.after(() => killPid(live.pid, 'SIGKILL'));
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const logs = fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-created-'));
  t.after(() => fs.rmSync(logs, { recursive: true, force: true }));
  const host = os.hostname();
  const done = cp.spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  const st = { events: [
    { cmd: 'spawn', task: 'T1', at: '2026-10-16T11:00:00.000Z', detail: { agent: 'worker-T1-1', host, pid: live.pid, monitor_pid: process.pid, log: path.join(logs, 'T1-worker-T1-1.log') } },
    { cmd: 'spawn', task: 'T1', at: '2026-10-16T11:05:00.000Z', detail: { agent: 'worker-T1-2', host, pid: done.pid, monitor_pid: live.pid, log: path.join(logs, 'T1-worker-T1-2.log') } },
    { cmd: 'spawn', task: 'T2', at: '2026-10-16T11:05:00.000Z', detail: { agent: 'worker-T2-1', host, pid: process.ppid, monitor_pid: process.ppid, log: path.join(logs, 'T2-worker-T2-1.log') } },
  ] };
  fs.writeFileSync(path.join(logs, 'T1-worker-T1-1.log'), 'recorded\n');
  fs.writeFileSync(path.join(logs, 'T1-worker-T1-1-startup-failed-2026-10-16T11-01-00-000Z.log'), 'kept\n');
  fs.writeFileSync(path.join(logs, 'T2-worker-T2-1-attempt-2.log'), 'another task\n');
  const asked = [];
  const stub = powershellStub(asked, [`${live.pid} ${filetime(Date.now())}`]);
  assert.deepEqual([...recordedCreated(logs, st, 'T1', 'win32', stub)], []);
  fs.writeFileSync(path.join(logs, 'T1-worker-T1-2-attempt-2.log'), 'an earlier start\n');
  assert.deepEqual([...recordedCreated(logs, st, 'T1', 'linux', stub)], []);
  assert.deepEqual(asked, []);
  assert.equal(recordedCreated(logs, st, 'T1', 'win32', stub).has(live.pid), true);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].pids.split(',').map(Number).sort((a, b) => a - b), [process.pid, live.pid].sort((a, b) => a - b));
  assert.ok(asked[0].timeout <= 5000, String(asked[0].timeout));
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
