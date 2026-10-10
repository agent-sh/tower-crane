'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const { cachedFixture, BIN } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'message-harness.js');
const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function until(file) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`harness did not reach ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Built once per process for each harness and copied for each test.
function setup(t, harness) {
  const h = cachedFixture(t, harness, (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Hook messages', '--acceptance', 'message arrives', '--tier', 'easy']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'exercise hooks\n' });
    const ready = path.join(h.base, 'ready');
    const out = path.join(h.base, 'report.json');
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    const program = path.join(bin, harness + (process.platform === 'win32' ? '.exe' : ''));
    fs.writeFileSync(program, `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`, { mode: 0o755 });
    const preload = path.join(h.base, 'native.js');
    fs.writeFileSync(preload, `const cp = require('node:child_process');\nconst spawn = cp.spawn;\ncp.spawn = function(cmd, args, opts) { return cmd === ${JSON.stringify(harness)} ? spawn.call(this, process.execPath, [${JSON.stringify(program)}, ...args], opts) : spawn.call(this, cmd, args, opts); };\n`);
    const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    Object.assign(h.env, {
      MESSAGE_HARNESS: harness, MESSAGE_READY: ready, MESSAGE_OUT: out,
      [pathKey]: bin + path.delimiter + (h.env[pathKey] || ''),
      CODEX_HOME: path.join(h.base, 'codex'), CLAUDE_CONFIG_DIR: path.join(h.base, 'claude'),
      ...(process.platform === 'win32' ? { NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"` } : {}),
    });
    const flags = ['ladder', 'set', 'easy', '--harness', harness, '--clear', 'profile', '--clear', 'effort'];
    if (harness !== 'command') flags.push('--model', 'stub-model');
    else flags.push('--clear', 'model');
    if (harness === 'command') flags.push('--command', JSON.stringify([process.execPath, STUB, '{session}', '{prompt}']));
    h.ok(flags);
    return { ready, out, bin };
  });
  return { h, ready: h.ready, out: h.out, bin: h.bin };
}

for (const route of ['claude', 'codex', 'codex-notify', 'pi', 'opencode', 'agy', 'command']) {
  test(`${route}: home hooks deliver messages and publish progress and final reports`, async (t) => {
    const harness = route === 'codex-notify' ? 'codex' : route;
    const { h, ready, out } = setup(t, harness);
    if (route === 'codex-notify') h.env.MESSAGE_NOTIFY_ONLY = '1';
    const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json']);
    await until(ready);
    if (harness === 'claude') {
      const settings = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'settings.json')));
      for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
        assert.ok(settings.hooks[event][0].hooks[0].timeout >= 135, 'generated timeout covers both bridge calls');
      }
    }
    h.ok(['msg', '--to', 'worker-T1-1', '--task', 'T1', 'mid-run coordination', '--agent', 'orchestrator']);
    fs.writeFileSync(ready + '.go', '');
    const live = ['claude', 'codex', 'pi', 'opencode'].includes(harness) && route !== 'codex-notify';
    if (live) {
      await until(ready + '.stop');
      h.ok(['msg', '--to', 'worker-T1-1', 'finish this correction', '--agent', 'orchestrator']);
      fs.writeFileSync(ready + '.stop.go', '');
    }
    const result = await run;
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(fs.readFileSync(out));
    if (live) {
      assert.match(JSON.stringify(seen.turns), /mid-run coordination/);
      assert.match(JSON.stringify(seen.turns), /finish this correction/);
      assert.equal(seen.blocked, true);
    } else {
      assert.ok(!JSON.stringify(seen.turns).includes('mid-run coordination'));
      assert.ok(!events(h).some((e) => e.cmd === 'hook inbox' && e.detail.messages.length));
    }
    const audit = events(h);
    assert.ok(fs.readFileSync(path.join(h.state, 'progress.jsonl'), 'utf8').trim().split('\n')
      .map(JSON.parse).some((e) => e.cmd === 'hook progress'), 'automatic tool progress missing');
    const report = audit.find((e) => e.cmd === 'msg' && e.agent === 'worker-T1-1' && e.detail.to === 'orchestrator');
    assert.match(report.detail.text, /without submit/);
    assert.match(report.detail.text, new RegExp(`last report from ${harness}`));
    assert.match(audit.findLast((e) => e.cmd === 'hook stop').detail.report, new RegExp(`last report from ${harness}`));
    for (const e of audit.filter((e) => e.cmd.startsWith('hook '))) assert.equal(e.agent, 'worker-T1-1');
    const binding = path.join(h.state, 'homes', 'worker-T1-1', 'hook.json');
    const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    for (const agent of ['owner', 'another-worker']) {
      const denied = h.run(['hook', 'tool', '--binding', binding, '--agent', agent]);
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stderr, /identity/);
    }
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
    const bridge = cp.spawnSync(process.execPath, [
      path.join(__dirname, '..', 'lib', 'hook-bridge.js'), 'codex',
      JSON.stringify({ agent: 'owner', task: 'T999', 'last-assistant-message': 'bound notification' }),
    ], { env: { ...h.env, TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_STATE: h.state, TOWER_CRANE_HOOK: binding }, encoding: 'utf8' });
    assert.equal(bridge.status, 0, bridge.stderr);
    const notification = events(h).findLast((e) => e.cmd === 'hook report');
    assert.equal(notification.agent, 'worker-T1-1');
    assert.equal(notification.task, 'T1');
    if (['codex', 'command'].includes(harness)) {
      h.ok(['msg', '--to', 'worker-T1-1', 'queued resume coordination', '--agent', 'orchestrator']);
      h.ok(['submit', 'T1', '--sha', 'abcdef1', '--agent', 'worker-T1-1']);
      h.ok(['rework', 'T1', '--reason', 'resume correction']);
      const next = h.json(['spawn', '--task', 'T1', '--wait'], { env: { MESSAGE_RESUME: '1' } });
      assert.equal(next.agent, 'worker-T1-1');
      assert.match(JSON.parse(fs.readFileSync(out)).prompt, /queued resume coordination/);
      assert.ok(events(h).some((e) => e.cmd === 'hook inbox' && e.detail.messages.length));
    }
  });
}

test('successful push and PR creation publish events, and submitted stops retain the final report', async (t) => {
  const { h, ready, bin } = setup(t, 'command');
  const remote = path.join(h.base, 'remote.git');
  h.git(['init', '--bare', '-q', remote]);
  const script = path.join(bin, 'gh.js');
  fs.writeFileSync(script, `if (process.argv[2] === 'auth') console.log('stub-token'); else console.log('https://example.invalid/pull/1');\n`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  }
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { MESSAGE_COMMANDS: '1', MESSAGE_REMOTE: remote, MESSAGE_SUBMIT: '1' },
  });
  await until(ready);
  fs.writeFileSync(ready + '.go', '');
  const result = await run;
  assert.equal(result.code, 0, result.stderr);
  for (const cmd of ['hook git-push', 'hook pr-created']) {
    const e = events(h).find((row) => row.cmd === cmd);
    assert.equal(e?.agent, 'worker-T1-1', cmd);
    assert.equal(e?.task, 'T1', cmd);
  }
  const reports = events(h).filter((e) => e.cmd === 'msg' && e.detail.to === 'orchestrator');
  assert.equal(reports.length, 1);
  assert.match(reports[0].detail.text, /after submit/);
  assert.match(reports[0].detail.text, /last report from command/);
});

test('R1: a push or PR event recorded with no command is marked as an unverified hint', async (t) => {
  const { h, ready } = setup(t, 'command');
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json']);
  await until(ready);
  fs.writeFileSync(ready + '.go', '');
  assert.equal((await run).code, 0);
  // The worker's own binding, and no push or PR made: the shim never ran.
  const binding = path.join(h.state, 'homes', 'worker-T1-1', 'hook.json');
  for (const action of ['git-push', 'pr-created']) {
    h.ok(['hook', action, '--binding', binding, '--agent', 'worker-T1-1', '--state', h.state]);
    const e = events(h).findLast((row) => row.cmd === `hook ${action}`);
    assert.equal(e?.detail.unverified, true, `hook ${action} must not read as a verified push or PR`);
  }
});

test('the bridge refuses path-selected bindings and another dispatch identity', async (t) => {
  const { h, ready } = setup(t, 'command');
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json']);
  await until(ready);
  fs.writeFileSync(ready + '.go', '');
  assert.equal((await run).code, 0);
  const bridge = path.join(__dirname, '..', 'lib', 'hook-bridge.js');
  const binding = path.join(h.state, 'homes', 'worker-T1-1', 'hook.json');
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const env = { ...h.env, TOWER_CRANE_AGENT: 'reviewer-T1-1', TOWER_CRANE_STATE: h.state, TOWER_CRANE_HOOK: binding };
  for (const args of [
    [bridge, binding, 'codex', JSON.stringify({ 'last-assistant-message': 'forged report' })],
    ['-e', `require(${JSON.stringify(bridge)}).call(${JSON.stringify(binding)}, 'tool', { tool: 'forged' })`],
    [bridge, 'codex', JSON.stringify({ 'last-assistant-message': 'forged report' })],
  ]) {
    const result = cp.spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'another dispatch must not use the worker binding');
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  }
  // A binding located in the caller's own home must still match the caller.
  const own = JSON.parse(fs.readFileSync(binding));
  fs.writeFileSync(binding, JSON.stringify({ ...own, agent: 'reviewer-T1-1' }));
  const mismatch = cp.spawnSync(process.execPath, [bridge, 'codex', '{}'], {
    env: { ...env, TOWER_CRANE_AGENT: 'worker-T1-1' }, encoding: 'utf8',
  });
  assert.notEqual(mismatch.status, 0);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
});

test('the hook bridge reads hook input from a non-blocking stdin pipe', { skip: process.platform === 'win32' && 'needs a FIFO' }, async (t) => {
  const { h, ready } = setup(t, 'command');
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json']);
  await until(ready);
  fs.writeFileSync(ready + '.go', '');
  assert.equal((await run).code, 0);
  h.ok(['msg', '--to', 'worker-T1-1', 'pipe delivered message', '--agent', 'orchestrator']);
  const bridge = path.join(__dirname, '..', 'lib', 'hook-bridge.js');
  const preload = path.join(__dirname, 'fixtures', 'stdin-marker.js');
  const binding = path.join(h.state, 'homes', 'worker-T1-1', 'hook.json');
  const marker = path.join(h.base, 'stdin-read');
  // libuv resets fds 0-2 of each child to blocking, so the preload reopens the
  // FIFO on fd 0 with O_NONBLOCK, as a hook runner's stdin is: an empty read
  // gives EAGAIN. The parent opens the FIFO once, read-write, so it holds the
  // writer without blocking and closes it to send EOF.
  const fifo = path.join(h.base, 'stdin.fifo');
  cp.execFileSync('mkfifo', [fifo]);
  const writer = fs.openSync(fifo, fs.constants.O_RDWR);
  const env = { ...h.env, TOWER_CRANE_AGENT: 'worker-T1-1', TOWER_CRANE_STATE: h.state, TOWER_CRANE_HOOK: binding, STDIN_MARKER: marker, STDIN_FIFO: fifo };
  const child = cp.spawn(process.execPath, ['--require', preload, bridge, 'hook'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  // Listen before the bridge can exit: a failing bridge may exit inside the wait below.
  const closed = once(child, 'close');
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
  // Deliver input only once the bridge is reading, so an empty read is seen.
  await until(marker);
  fs.writeSync(writer, JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
  fs.closeSync(writer);
  const [code] = await closed;
  assert.equal(code, 0, err);
  const { hookSpecificOutput } = JSON.parse(out);
  assert.equal(hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(hookSpecificOutput.additionalContext, /pipe delivered message/);
});

for (const probe of ['sessions', 'reject', 'error']) {
  test(`OpenCode ${probe}: idle delivers only to the dispatch session and retains failed prompts`, async (t) => {
    const { h, ready, out } = setup(t, 'opencode');
    const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
      env: { MESSAGE_OPENCODE_PROBE: probe },
    });
    await until(ready);
    h.ok(['msg', '--to', 'worker-T1-1', 'pending parent message', '--agent', 'orchestrator']);
    fs.writeFileSync(ready + '.go', '');
    const result = await run;
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(fs.readFileSync(out));
    if (probe === 'sessions') {
      assert.equal(seen.unrelatedCalls, 0);
      assert.equal(seen.unrelatedReceipts, 0);
      assert.equal(seen.promptCalls.length, 1);
    } else {
      assert.equal(seen.failedReceipts, 0, 'failed prompt must leave the inbox unread');
      assert.equal(seen.promptCalls.length, 2, 'the next idle retries the pending context');
      assert.deepEqual(seen.promptCalls[0], seen.promptCalls[1]);
    }
    for (const prompt of seen.promptCalls) {
      assert.equal(prompt.path.id, 'parent');
      assert.match(JSON.stringify(prompt.body), /pending parent message/);
    }
    assert.equal(events(h).filter((e) => e.cmd === 'hook inbox').flatMap((e) => e.detail.messages).length, 1);
  });
}

test('transient resumes inject queued messages without a worker checking its inbox', async (t) => {
  const { h, ready, out } = setup(t, 'command');
  h.ok(['ladder', 'set', 'easy', '--supervision', JSON.stringify({ retries: 1, backoff_ms: 100, max_backoff_ms: 100 })]);
  const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { env: { MESSAGE_RETRY: '1' } });
  await until(ready);
  h.ok(['msg', '--to', 'worker-T1-1', 'resume with this correction', '--agent', 'orchestrator']);
  fs.writeFileSync(ready + '.go', '');
  const result = await run;
  assert.equal(result.code, 0, result.stderr);
  assert.match(JSON.parse(fs.readFileSync(out)).prompt, /resume with this correction/);
  const delivered = events(h).filter((e) => e.cmd === 'hook inbox').flatMap((e) => e.detail.messages);
  assert.equal(delivered.length, 1);
});

test('refused commands without a context placeholder retain messages', (t) => {
  const { h, ready } = setup(t, 'command');
  h.ok(['ladder', 'set', 'easy', '--command', JSON.stringify([process.execPath, STUB])]);
  h.ok(['msg', '--to', 'worker-T1-1', 'retain undelivered context', '--agent', 'orchestrator']);
  const result = h.run(['spawn', '--task', 'T1', '--wait', '--json']);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /command.*\{prompt\}.*\{brief\}.*house rules/);
  assert.equal(fs.existsSync(ready), false);
  assert.ok(!events(h).some((e) => e.cmd === 'hook inbox' && e.detail.messages.length));
});

// Stop holds a worker that still holds its task when the turn ends with a background
// job or an empty final message, once. The stop index is the held one (-1 for none).
// A pending job sends the orchestrator no note.
const HEADLESS = [
  ['background', 0, null],
  ['silent', 0, /stopped without submit/],
  ['resumed', 1, /stopped without submit/],
  ['submitted', -1, /stopped after submit/],
  ['reported', -1, /stopped without submit/],
];
for (const [mode, heldAt, note] of HEADLESS) {
  const expected = heldAt >= 0 ? 'holds the unsubmitted worker once, in the foreground' : 'does not hold';
  test(`headless claude ${mode}: Stop ${expected}`, async (t) => {
    const { h, ready, out } = setup(t, 'claude');
    const run = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { env: { MESSAGE_HEADLESS: mode } });
    await until(ready);
    fs.writeFileSync(ready + '.go', '');
    const result = await run;
    assert.equal(result.code, 0, result.stderr);
    JSON.parse(fs.readFileSync(out)).stops.forEach((stop, i) => {
      if (i !== heldAt) {
        assert.equal(stop.decision, undefined, `stop ${i} is not held`);
        return;
      }
      assert.equal(stop.decision, 'block');
      assert.match(stop.reason, /tower-crane wait --task T1 --timeout SEC/);
      assert.match(stop.reason, /foreground/);
    });
    const audit = events(h);
    const waits = audit.filter((e) => e.cmd === 'hook wait');
    assert.equal(waits.length, heldAt >= 0 ? 1 : 0, 'the hold is taken once');
    if (mode === 'background' || mode === 'submitted') {
      assert.ok(audit.some((e) => e.cmd === 'hook background' && e.agent === 'worker-T1-1'), 'background start missing');
    }
    const notes = audit.filter((e) => e.cmd === 'msg' && e.detail.to === 'orchestrator' && /stopped/.test(e.detail.text));
    if (note) {
      assert.equal(notes.length, 1, 'the orchestrator hears one stop note');
      assert.match(notes[0].detail.text, note);
      if (mode === 'resumed') {
        // The earlier turn's report still reaches the orchestrator, and the empty stop holds after it.
        assert.match(notes[0].detail.text, /last report from claude/);
        assert.ok(audit.indexOf(notes[0]) < audit.indexOf(waits[0]), 'the first stop note precedes the hold');
      } else if (heldAt >= 0) {
        assert.ok(audit.indexOf(waits[0]) < audit.indexOf(notes[0]), 'the hold must come before the note');
      }
    } else {
      assert.equal(notes.length, 0, 'a pending job sends no stop note');
    }
  });
}
