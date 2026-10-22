'use strict';

// Live spend through recovery and on the board: partial logs, submitted and
// periodic collection, budget stops, interrupts, ranged stops, configured costs,
// live telemetry ageing and freshness, and retry budgets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { BIN, HOOKS } = require('./helpers');
const { CHROME, openBrowser, closeBrowser } = require('./browser');
const { events, recordedSpend, liveEntries, fixtureState, until, viewClock, setup, exited } = require('./live-spend-helpers');

test.after(closeBrowser);

for (const partialLog of [false, true]) {
  test(`Claude exit without a result includes final session usage with ${partialLog ? 'a partial log' : 'no log usage'}`, async (t) => {
    const h = setup(t, 'claude');
    const finish = path.join(h.base, 'finish');
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
      LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_FINISH: finish, ...(partialLog ? { LIVE_LOG_PREFIX: '1' } : {}),
    }) });
    await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1000), 'the first usage was not collected');
    fs.writeFileSync(finish, '');
    await until(t, h, () => exited(h, spawned.agent), 'the harness did not exit');
    await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'exit usage was not finalized');
    const spend = h.json(['task', 'show', 'T1']).spend;
    assert.equal(fs.readFileSync(h.done, 'utf8'), '2', 'the harness wrote a final session record');
    assert.equal(spend.tokens, 2000);
    assert.equal(spend.entries.length, 1);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 2000, 'recollection keeps the final total');
  });
}

test('final session usage repairs spend collected before submitted supervisor reconciliation', async (t) => {
  const h = setup(t, 'claude');
  const finish = path.join(h.base, 'finish');
  const paused = path.join(h.base, 'final-paused');
  h.ok(['task', 'update', 'T1', '--budget-tokens', '1500']);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_FINISH: finish, LIVE_LOG_PREFIX: '1', LIVE_PAUSE_FINAL: paused,
    LIVE_FINAL_UNSAMPLED: '1',
  }) });
  try {
    await until(t, h, () => liveEntries(h).some((e) => e.tokens === 1000), 'initial usage was not recorded');
    h.ok(['submit', 'T1', '--agent', spawned.agent, '--sha', h.git(['rev-parse', 'HEAD'])]);
    fs.writeFileSync(finish, '');
    await until(t, h, () => fs.existsSync(paused), 'the supervisor did not pause before its final read');
    assert.equal(fs.readFileSync(h.done, 'utf8'), '2');
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    const early = recordedSpend(h);
    assert.equal(early.tokens, 1000);
    assert.equal(early.entries.length, 1);
    assert.equal(early.entries[0].live, undefined, 'the early collector finalized the entry');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  await until(t, h, () => exited(h, spawned.agent), 'the supervisor did not finish reconciliation');
  const final = h.json(['task', 'show', 'T1']).spend;
  assert.equal(final.tokens, 2000, 'the final reading replaces early collection');
  assert.equal(final.entries.length, 1);
  assert.equal(final.entries[0].live, undefined, 'final reconciliation does not reopen live telemetry');
  assert.ok(events(h).some((e) => e.cmd === 'budget stop'), 'reconciled usage still enforces the budget');
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 2000, 'recollection preserves the reconciled total');
});

test('a periodic sample that crosses the budget after submit keeps early collection behind the supervisor', async (t) => {
  const h = setup(t, 'claude');
  const finish = path.join(h.base, 'finish');
  const paused = path.join(h.base, 'final-paused');
  h.ok(['task', 'update', 'T1', '--budget-tokens', '1500']);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_FINISH: finish, LIVE_LOG_PREFIX: '1', LIVE_PAUSE_FINAL: paused,
    LIVE_FINAL_HOLD: '1',
  }) });
  try {
    await until(t, h, () => liveEntries(h).some((e) => e.tokens === 1000), 'initial usage was not recorded');
    h.ok(['submit', 'T1', '--agent', spawned.agent, '--sha', h.git(['rev-parse', 'HEAD'])]);
    fs.writeFileSync(finish, '');
    // The harness holds after its final record, so a periodic sample reads it
    // before any exit. A supervisor that reaches its final read first holds
    // there until the test releases it, so that order fails now, not at the
    // runner's timeout. The pause is checked first: a budget stop precedes it.
    await until(t, h, () => {
      const final = fs.existsSync(paused);
      if (events(h).some((e) => e.cmd === 'budget stop')) return true;
      if (final) throw new Error(`the supervisor reached its final read before a live sample stopped the budget; ${fixtureState(h)}`);
      return false;
    }, 'the live sample did not stop the budget');
    await until(t, h, () => fs.existsSync(paused), 'the supervisor did not pause before its final read');
    const early = h.run(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(early.code, 1);
    assert.match(early.stderr, new RegExp(`${spawned.agent} is still supervised`));
    assert.equal(recordedSpend(h).tokens, 2000, 'the live reading stays until the supervisor reconciles');
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  await until(t, h, () => exited(h, spawned.agent), 'the supervisor did not finish reconciliation');
  await until(t, h, () => recordedSpend(h).entries?.every((e) => !e.live), 'exit usage was not finalized');
  const final = h.json(['task', 'show', 'T1']);
  assert.equal(final.spend.tokens, 2000);
  assert.equal(final.spend.entries.length, 1);
  assert.equal(final.spend.entries[0].live, undefined);
  assert.equal(final.run.active, false, 'the closed budget stop leaves no supervised phase');
  assert.equal(events(h).filter((e) => e.cmd === 'budget stop').length, 1);
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 2000);
});

for (const tokens of [1500, 0]) {
  test(`a Claude invocation result authoritatively reconciles to ${tokens} tokens`, async (t) => {
    const h = setup(t, 'claude');
    const finish = path.join(h.base, 'finish');
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
      LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_FINISH: finish,
      LIVE_LOG_PREFIX: '1', LIVE_FINAL_RESULT_TOKENS: String(tokens),
    }) });
    await until(t, h, () => liveEntries(h).some((e) => e.tokens === 1000), 'initial usage was not recorded');
    fs.writeFileSync(finish, '');
    await until(t, h, () => exited(h, spawned.agent), 'the harness did not exit');
    await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'result was not finalized');
    assert.equal(fs.readFileSync(h.done, 'utf8'), '2', 'the session contains 2000 tokens');
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
  });
}

test('default wait ignores live usage changes but delivers a budget stop', async (t) => {
  const h = setup(t, 'claude');
  h.ok(['task', 'update', 'T1', '--budget-tokens', '2500']);
  const resume = path.join(h.base, 'continue');
  const finish = path.join(h.base, 'finish');
  h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '2', LIVE_CONTINUE: resume, LIVE_HOLD: 'until-stop', LIVE_FINISH: finish,
  }) });
  await until(t, h, () => events(h).some((e) => e.cmd === 'spend live' && e.detail.tokens === 1000), 'initial usage was not recorded');
  const cursor = events(h).at(-1).id;
  fs.writeFileSync(resume, '');
  await until(t, h, () => events(h).some((e) => e.cmd === 'spend live' && e.detail.tokens === 2000), 'changed usage was not recorded');
  const args = ['wait', '--agent', 'orchestrator', '--task', 'T1', '--after', cursor, '--observe', '--timeout', '0'];
  const quiet = h.run(args);
  assert.equal(quiet.code, 2, quiet.stderr || quiet.stdout);
  assert.equal(JSON.parse(quiet.stdout).type, 'timeout');
  for (const types of ['spend live', 'all']) {
    const visible = h.run([...args, '--types', types]);
    assert.equal(visible.code, 0, visible.stderr);
    const wake = JSON.parse(visible.stdout);
    assert.equal(wake.type, 'spend live');
    assert.equal(events(h).find((e) => e.id === wake.id).detail.tokens, 2000);
  }
  const after = events(h).at(-1).id;
  fs.writeFileSync(finish, '');
  await until(t, h, () => events(h).some((e) => e.cmd === 'budget stop'), 'budget stop was not recorded');
  const stopped = h.run(['wait', '--agent', 'orchestrator', '--task', 'T1', '--after', after, '--observe', '--timeout', '0']);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).type, 'budget stop');
});

test('submission ends lease renewal and retries but live budgets hold until the harness exits', async (t) => {
  const h = setup(t, 'claude');
  h.ok(['task', 'update', 'T1', '--budget-tokens', '3500']);
  const resume = path.join(h.base, 'continue');
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '4', LIVE_EVERY: '200', LIVE_CONTINUE: resume, LIVE_COMPLETE: path.join(h.base, 'complete'),
  }) });
  await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1000), 'initial usage was not recorded');
  h.ok(['submit', 'T1', '--agent', spawned.agent, '--sha', h.git(['rev-parse', 'HEAD'])]);
  fs.writeFileSync(resume, '');
  await until(t, h, () => exited(h, spawned.agent), 'submitted worker was not stopped');
  const log = events(h);
  const submit = log.findIndex((e) => e.cmd === 'submit');
  const after = log.slice(submit + 1);
  assert.ok(after.some((e) => e.cmd === 'budget stop'), 'spending after submission crosses the task budget');
  assert.ok(after.some((e) => e.cmd === 'spend live' && e.detail.tokens > 3500));
  assert.equal(fs.existsSync(h.done), false, 'budget enforcement stops the submitted harness before natural exit');
  assert.equal(after.some((e) => ['renew', 'spawn retry', 'spawn fallback'].includes(e.cmd)), false);
  assert.equal(h.json(['task', 'show', 'T1']).status, 'submitted');
  assert.deepEqual(h.readState('decisions.json').decisions.find((d) => d.escalation).escalation.settings, ['budget.raise']);
  await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'submitted exit usage was not finalized');
});

test('interrupt stops a live-spend dispatch and reconciles usage without changing its revision', async (t) => {
  const h = setup(t, 'claude');
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_HOLD: 'until-stop' }) });
  await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1000), 'initial usage was not recorded');
  const revision = h.json(['task', 'show', 'T1']).revision;
  h.ok(['interrupt', 'T1']);
  await until(t, h, () => exited(h, spawned.agent), 'the interrupted harness did not exit');
  await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'interrupted exit usage was not finalized');
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.revision, revision);
  assert.equal(task.claim, null);
  assert.equal(task.run.phase, 'stopped');
  assert.equal(task.run.active, false);
  assert.equal(task.spend.tokens, 1000);
  assert.equal(task.spend.entries.length, 1);
  assert.equal(fs.existsSync(h.done), false);
  assert.equal(events(h).some((e) => ['spawn retry', 'spawn fallback'].includes(e.cmd)), false);
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 1000);
});

test('a ranged task budget stop does not climb the quality ladder', async (t) => {
  const h = setup(t, 'codex');
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium', '--budget-tokens', '3500']);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '4', LIVE_EVERY: '300', LIVE_COMPLETE: path.join(h.base, 'complete'),
  }) });
  await until(t, h, () => exited(h, spawned.agent), 'the budget did not stop the ranged worker');
  await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'ranged exit usage was not finalized');
  h.ok(['recover', 'T1']);
  const task = h.json(['task', 'show', 'T1']);
  assert.equal(task.tier, 'easy', 'a budget stop is not a quality failure');
  assert.deepEqual(task.escalations || [], []);
  assert.equal(events(h).some((e) => e.cmd === 'escalate'), false);
  assert.equal(events(h).filter((e) => e.cmd === 'spawn').length, 1);
  const decisions = h.readState('decisions.json').decisions;
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].escalation.settings, ['budget.raise']);
});

test('live and reconciled spend keep the configured cost for their rung', async (t) => {
  const h = setup(t, 'claude');
  h.ok(['task', 'update', 'T1', '--tier', 'easy..medium']);
  h.ok(['project', 'set', '--review-policy', JSON.stringify({ prices: {
    'live-model': { input: 1, cache_write: 1, cache_read: 1, output: 1 },
  } })]);
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_CACHED: '0' }) });
  await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1000), 'initial usage was not recorded');
  const before = h.json(['task', 'show', 'T1']);
  assert.deepEqual(before.spend_by_rung.easy, { tokens: 1000, cost_usd: 0.001 });
  assert.equal(before.spend.entries[0].cost_usd, 0.001);
  assert.match(h.ok(['task', 'show', 'T1']), /easy: 1000 tokens, USD 0\.001/);
  h.ok(['interrupt', 'T1']);
  await until(t, h, () => exited(h, spawned.agent), 'the priced worker did not exit');
  await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'priced exit usage was not finalized');
  const after = h.json(['task', 'show', 'T1']);
  assert.deepEqual(after.spend_by_rung, before.spend_by_rung);
  assert.equal(after.spend.entries.length, 1);
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.deepEqual(h.json(['task', 'show', 'T1']).spend_by_rung, before.spend_by_rung);
});

for (const partialLog of [false, true]) {
  test(`${partialLog ? 'a smaller partial log' : 'unavailable telemetry'} preserves known spend and its age through recovery and exit`, async (t) => {
    const h = setup(t, 'claude');
    const location = path.join(h.base, 'usage-file');
    const tokens = partialLog ? 2000 : 1000;
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
      LIVE_STEPS: partialLog ? '2' : '1', LIVE_HOLD: 'until-stop', LIVE_FILE: location,
      ...(partialLog ? { LIVE_LOG_PREFIX: '1' } : {}),
    }) });
    // A commit logs its events before it renames tasks.json, so these waits
    // read the task file that the next lock-free read sees, not the log.
    await until(t, h, () => liveEntries(h).some((e) => e.tokens === tokens), 'initial usage was not recorded');
    const before = h.json(['task', 'show', 'T1']).spend;
    const file = fs.readFileSync(location, 'utf8');
    const data = fs.readFileSync(file);
    fs.unlinkSync(file);
    await until(t, h, () => liveEntries(h)[0]?.live.state === 'stale', 'missing telemetry was not observed');
    const missing = h.json(['task', 'show', 'T1']).spend;
    for (const key of ['tokens', 'input', 'cached', 'output']) assert.equal(missing[key], before[key], key);
    assert.equal(missing.entries[0].at, before.entries[0].at, 'missing data cannot refresh the last measured usage');
    assert.equal(h.json(['status']).spend.live[0].state, 'stale');
    fs.writeFileSync(file, data);
    await until(t, h, () => liveEntries(h)[0]?.live.state === 'live', 'recovered telemetry stayed stale');
    fs.unlinkSync(file);
    await until(t, h, () => liveEntries(h)[0]?.live.state === 'stale', 'lost telemetry did not become stale again');
    h.ok(['task', 'update', 'T1', '--budget-tokens', String(tokens - 500)]);
    await until(t, h, () => exited(h, spawned.agent), 'the harness did not exit');
    assert.ok(events(h).some((e) => e.cmd === 'budget stop'), 'missing telemetry cannot restore spent budget');
    await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'exit usage was not finalized');
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, tokens);
  });
}

test('exit collection preserves cumulative usage when a harness log shrinks', async (t) => {
  const h = setup(t, 'opencode');
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '2', LIVE_HOLD: 'until-stop' }) });
  await until(t, h, () => events(h).some((e) => e.cmd === 'spend live' && e.detail.tokens === 2000), 'initial usage was not recorded');
  const file = events(h).find((e) => e.cmd === 'spawn' && e.detail.agent === spawned.agent).detail.log;
  const first = fs.readFileSync(file, 'utf8').split('\n').find((line) => {
    try { return JSON.parse(line).type === 'step_finish'; } catch { return false; }
  });
  assert.ok(first, 'the harness captured a first step');
  fs.writeFileSync(file, first + '\n');
  await until(t, h, () => liveEntries(h)[0]?.live.state === 'stale', 'the truncated log was not marked stale');
  assert.equal(recordedSpend(h).tokens, 2000);
  h.ok(['task', 'update', 'T1', '--budget-tokens', '1500']);
  await until(t, h, () => exited(h, spawned.agent), 'known spend did not stop the agent');
  await until(t, h, () => recordedSpend(h).entries.every((e) => !e.live), 'exit usage was not finalized');
  assert.equal(recordedSpend(h).tokens, 2000, 'exit collection cannot refund a cumulative snapshot');
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.equal(recordedSpend(h).tokens, 2000);
});

test('an open board ages live telemetry without state writes or a page reload', { skip: !CHROME && 'no Chrome to drive' }, async (t) => {
  const b = await openBrowser(t);
  const h = setup(t, 'claude', { usage_ms: 1000 });
  const location = path.join(h.base, 'usage-file');
  h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_FILE: location }) });
  await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1000), 'initial usage was not recorded');
  const file = fs.readFileSync(location, 'utf8');
  fs.unlinkSync(file);
  fs.mkdirSync(file); // Failed reads leave the last reading to age without another state write.
  const reading = liveEntries(h)[0];
  const clock = viewClock(h, reading.at);
  await b.send('Page.enable');
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.boardNow = ${Date.parse(reading.at) + 1000};
    Date.now = () => window.boardNow;
    window.boardTimers = [];
    window.setInterval = (callback) => window.boardTimers.push(callback);
  ` });
  const server = cp.spawn(process.execPath, ['--require', HOOKS, BIN, 'serve', '--port', '0', '--json', '--agent', 'viewer'],
    { cwd: h.repo, env: { ...h.env, ...clock.hooks } });
  const closed = new Promise((resolve) => server.once('close', resolve));
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  try {
    await until(t, h, () => output.includes('\n'), 'serve did not start', server.stdout);
    const { url } = JSON.parse(output.split('\n')[0]);
    await b.goto(`${url}spend`);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    assert.equal(await b.inPage(`document.querySelector('#spend tr[data-live-state]').dataset.liveState`), 'live');
    assert.equal(await b.inPage(`document.querySelector('[data-key="agent-T1"] [data-usage]').dataset.liveState`), 'live');
    const log = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    await b.inPage(`window.boardNow += 60000; window.boardTimers.forEach((callback) => callback());`);
    // The server's clock stays at the reading, so only the page can age it.
    await b.until(`document.querySelector('#spend tr[data-live-state]').dataset.liveState === 'stale'`, 'the page to age the reading');
    const shown = await b.inPage(`(() => {
      const row = document.querySelector('#spend tr[data-live-state]');
      const floor = document.querySelector('[data-key="agent-T1"] [data-usage]');
      return { freshness: row.cells[3].textContent, age: row.cells[4].textContent, floor: floor.dataset.liveState, words: floor.textContent };
    })()`);
    assert.equal(shown.freshness, 'stale');
    assert.equal(shown.age, '61 s ago');
    assert.equal(shown.floor, 'stale');
    assert.match(shown.words, /stale, 61 s old/);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), log, 'time passing wrote no state');
  } finally {
    server.kill();
    await closed;
  }
});

// The test context's cleanup stops the detached agents these tests leave running.
test('live usage shows its freshness: live, stale when no reading arrives, unavailable without harness data', async (t) => {
  const h = setup(t, 'claude');
  // Two readings, then a long hold: age follows the last changed reading.
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '2', LIVE_STEP_TOKENS: '700', LIVE_HOLD: 'until-stop' }) });
  await until(t, h, () => liveEntries(h).some((l) => l.tokens === 1400), 'live usage was not shown');
  const at = liveEntries(h)[0].at;
  const fresh = viewClock(h, at);
  const status = h.json(['status'], fresh);
  assert.equal(status.spend.tokens, 1400, 'live usage is in the totals');
  assert.equal(status.spend.missing_usage, 0);
  assert.deepEqual(status.spend.live.map((l) => [l.task, l.agent, l.state]), [['T1', spawned.agent, 'live']]);
  assert.match(h.ok(['status'], fresh), new RegExp(`live spend: T1 ${spawned.agent}: 1400 tokens, live`));
  assert.match(h.ok(['task', 'show', 'T1'], fresh), /live spend: .*1400 tokens, live/);
  // A write re-renders after it releases the lock, so read a render of our own.
  h.ok(['render'], fresh);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /data-live-state="live"/);

  // An hour without a new reading, as when the supervisor is gone.
  const clock = path.join(h.base, 'clock');
  fs.writeFileSync(clock, String(Date.parse(at) + 3600000));
  const later = { hooks: { HOOK_CLOCK_FILE: clock } };
  assert.equal(h.json(['status'], later).spend.live[0].state, 'stale');
  assert.match(h.run(['status'], later).stdout, /1400 tokens, stale, last read 60m ago/);
  h.ok(['render'], later);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.html'), 'utf8'), /data-live-state="stale"/);
});

test('a harness without live usage is shown unavailable, never as zero', async (t) => {
  const h = setup(t, 'claude');
  const script = `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', 'T1'], { env: fakeAgentEnv(process.env) }); setInterval(() => {}, 1000);`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, require('./helpers').BIN, '{prompt}'])]);
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(t, h, () => liveEntries(h).length === 1, 'no live state was recorded');
  const fresh = viewClock(h, liveEntries(h)[0].at);
  const [live] = h.json(['status'], fresh).spend.live;
  assert.equal(live.state, 'unavailable');
  assert.equal(live.tokens, null);
  assert.equal(h.json(['status']).spend.missing_usage, 0, 'a running spawn is not yet missing usage');
  assert.match(h.ok(['status'], fresh), /usage unavailable from command while it runs/);
});

test('a budget lowered during retry backoff cancels the relaunch, records the stop and asks the owner', async (t) => {
  const h = setup(t, 'claude', { retries: 1, backoff_ms: 60000, max_backoff_ms: 60000 });
  const attempts = path.join(h.base, 'attempts');
  const script = "const fs = require('node:fs'); fs.appendFileSync(process.argv[2], 'x');"
    + `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
 require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', 'T1'], { env: fakeAgentEnv(process.env) }); process.exit(75);`;
  h.ok(['ladder', 'set', 'easy', '--harness', 'command', '--clear', 'model', '--command', JSON.stringify([process.execPath, '-e', script, require('./helpers').BIN, attempts, '{prompt}'])]);
  h.ok(['spend', 'T1', '--agent', 'earlier', '--tokens', '5000']);
  const spawned = h.json(['spawn', '--task', 'T1']);
  await until(t, h, () => events(h).some((e) => e.cmd === 'spawn phase' && e.detail.phase === 'retrying'), 'retry was not scheduled');
  h.ok(['project', 'set', '--budget-tokens', '1000']);
  await until(t, h, () => exited(h, spawned.agent), 'the pending retry was not cancelled');
  const log = events(h);
  assert.equal(fs.readFileSync(attempts, 'utf8'), 'x', 'no paid attempt was launched');
  assert.equal(log.filter((e) => e.cmd === 'spawn retry').length, 0);
  const stop = log.find((e) => e.cmd === 'budget stop');
  assert.deepEqual(stop.detail.breaches.map((b) => [b.scope, b.what, b.limit]), [['project', 'tokens', 1000]]);
  assert.deepEqual(h.readState('decisions.json').decisions.find((d) => d.escalation).escalation.settings, ['budget.raise']);
  const run = h.json(['task', 'show', 'T1']).run;
  assert.equal(run.phase, 'blocked');
  assert.match(run.reason, /tokens budget crossed/);
});
