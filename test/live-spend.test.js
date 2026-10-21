'use strict';

// Live spend while a harness runs: completed attempts against the budget, and
// each harness's live usage crossing a task or project budget. live-spend-board.test.js has the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { events, recordedSpend, liveEntries, until, viewClock, setup, exited } = require('./live-spend-helpers');

for (const [harness, next] of [['claude', 'retry'], ['codex', 'retry'], ['claude', 'fallback'], ['codex', 'fallback'],
  ['opencode', 'fallback'], ['pi', 'fallback'], ['agy', 'fallback']]) {
  test(`completed ${harness} usage stops a ${next} before the next paid attempt`, async (t) => {
    const h = setup(t, harness, { usage_ms: 30000, retries: next === 'retry' ? 1 : 0, backoff_ms: 10, max_backoff_ms: 10 });
    if (next === 'fallback') {
      fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
      fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { easy: { fallbacks: [{ harness, model: 'fallback-model' }] } } }));
    }
    h.ok(['task', 'update', 'T1', '--budget-tokens', '3500']);
    const attempts = path.join(h.base, 'attempts');
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
      LIVE_STEPS: '1', LIVE_STEP_TOKENS: '5000', LIVE_RESULT: '1', LIVE_ATTEMPTS: attempts,
      LIVE_EXIT: next === 'retry' ? '75' : '1', ...(next === 'fallback' ? { LIVE_OUTAGE: '1' } : {}),
    }) });
    await until(t, h, () => exited(h, spawned.agent), 'the supervised run did not finish');
    assert.equal(fs.readFileSync(attempts, 'utf8'), `${harness}\n`, 'no paid retry or fallback starts after the budget is exhausted');
    assert.ok(events(h).some((e) => e.cmd === 'budget stop'));
    assert.deepEqual(h.readState('decisions.json').decisions.find((d) => d.escalation).escalation.settings, ['budget.raise']);
    await until(t, h, () => recordedSpend(h).entries?.length && recordedSpend(h).entries.every((e) => !e.live), 'exit usage was not finalized');
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 5000);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 5000);
  });
}

test('sub-second usage requests obey the sampling floor and unchanged readings write once', async (t) => {
  const h = setup(t, 'claude', { usage_ms: 1 });
  const reads = path.join(h.base, 'reads');
  h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_READS: reads, LIVE_READ_DELAY_MS: '250', LIVE_NO_CLAIM: '1' }) });
  await until(t, h, () => events(h).some((e) => e.cmd === 'spend live' && e.detail.tokens === 1000),
    'initial usage was not recorded');
  const readTimes = () => fs.readFileSync(reads, 'utf8').trim().split('\n').map(Number);
  await until(t, h, () => readTimes().length >= 3, 'the supervisor did not keep sampling');
  const samples = events(h).filter((e) => e.cmd === 'spend live' && e.detail.tokens === 1000);
  assert.equal(samples.length, 1, 'watcher wakes and unchanged snapshots do not write more usage');
  assert.equal(samples[0].detail.live.interval_ms, 1000);
  h.ok(['task', 'note', 'T1', 'wake the sampler']);
  const count = readTimes().length;
  await until(t, h, () => readTimes().length >= count + 2, 'the supervisor stopped sampling after a state change');
  assert.equal(events(h).filter((e) => e.cmd === 'spend live' && e.detail.tokens === 1000).length, 1);
  const times = readTimes();
  assert.ok(times.length >= 2, 'the supervisor still samples an unchanged file');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 950, `reads were ${times[i] - times[i - 1]}ms apart`); // wait-allow: verify the production sampling floor
});

test('an initial read error records unavailable telemetry with only its error class', async (t) => {
  const h = setup(t, 'claude');
  const location = path.join(h.base, 'usage-file');
  h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_UNREADABLE: '1', LIVE_FILE: location }) });
  await until(t, h, () => liveEntries(h).some((e) => e.live.error), 'initial read errors left the agent absent from live spend');
  const entry = liveEntries(h).find((e) => e.live.error);
  const [live] = h.json(['status'], viewClock(h, entry.at)).spend.live;
  assert.equal(live.state, 'unavailable');
  assert.equal(live.tokens, null);
  assert.match(live.error, /^(EISDIR|EPERM|EACCES)$/);
  const detail = events(h).find((e) => e.cmd === 'spend live' && e.detail.live.error).detail;
  assert.equal(detail.live.state, 'unavailable');
  assert.equal(detail.live.error, live.error);
  assert.equal(JSON.stringify(detail).includes(fs.readFileSync(location, 'utf8')), false, 'the error contains no session path');
  assert.equal('message' in detail.live, false);
});

test('completed attempts below budget continue and reconcile each fresh invocation once', async (t) => {
  const h = setup(t, 'claude', { usage_ms: 30000, retries: 1, backoff_ms: 10, max_backoff_ms: 10 });
  h.ok(['task', 'update', 'T1', '--budget-tokens', '10001']);
  const attempts = path.join(h.base, 'attempts');
  const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
    LIVE_STEPS: '1', LIVE_STEP_TOKENS: '5000', LIVE_RESULT: '1', LIVE_ATTEMPTS: attempts, LIVE_EXIT: '75',
  }) });
  await until(t, h, () => exited(h, spawned.agent), 'the supervised run did not finish');
  assert.equal(fs.readFileSync(attempts, 'utf8'), 'claude\nclaude\n');
  assert.equal(events(h).some((e) => e.cmd === 'budget stop'), false);
  await until(t, h, () => {
    const entries = recordedSpend(h).entries;
    return entries.length === 2 && entries.every((e) => !e.live);
  }, 'both attempts were not finalized');
  assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 10000);
  h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
  assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, 10000);
});

for (const [harness, scope, logOnly] of [['claude', 'project'], ['claude', 'task', true], ['codex', 'task'],
  ['opencode', 'project'], ['pi', 'task'], ['agy', 'project']]) {
  test(`${harness}${logOnly ? ' log' : ''} usage read while it runs crosses the ${scope} token budget and the agent is stopped before it exits`, async (t) => {
    const h = setup(t, harness);
    h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}']);
    if (scope === 'project') h.ok(['project', 'set', '--budget-tokens', '3500']);
    else h.ok(['task', 'update', 'T1', '--budget-tokens', '3500']);
    // Four steps cross the budget. Completion needs a signal, so a loaded
    // supervisor still has to stop a live process rather than collect an exit.
    const spawned = h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({
      LIVE_STEPS: '4', LIVE_STEP_TOKENS: '1000', LIVE_EVERY: '300', LIVE_COMPLETE: path.join(h.base, 'complete'),
      ...(logOnly ? { LIVE_LOG_ONLY: '1' } : {}),
    }) });
    await until(t, h, () => exited(h, spawned.agent), 'the agent was not stopped');
    assert.equal(fs.existsSync(h.done), false, 'the agent was stopped before it finished on its own');

    const log = events(h);
    const live = log.filter((e) => e.cmd === 'spend live');
    // Before the harness writes any usage the reading is unavailable, not zero.
    assert.ok(live.some((e) => e.detail.live.state === 'live'), 'usage was recorded while the agent ran');
    for (const e of live) {
      if (e.detail.live.state === 'live') assert.ok(e.detail.tokens > 0);
      else assert.equal(e.detail.tokens, null);
    }
    const stop = log.find((e) => e.cmd === 'budget stop');
    assert.ok(stop, 'the stop is recorded');
    assert.equal(stop.detail.authority, 'operational');
    assert.deepEqual(stop.detail.breaches.map((b) => [b.scope, b.what, b.limit]), [[scope === 'project' ? 'project' : 'T1', 'tokens', 3500]]);
    assert.ok(log.indexOf(stop) < log.findIndex((e) => e.cmd === 'spawn exit'), 'the stop came before the exit');
    const phase = h.json(['task', 'show', 'T1']).run;
    assert.equal(phase.phase, 'blocked');
    assert.match(phase.reason, /tokens budget crossed/);
    assert.equal(log.filter((e) => e.cmd === 'spawn retry').length, 0, 'a budget stop is not retried');

    // Budget decisions retain their spend restriction under question delegation.
    const decision = h.readState('decisions.json').decisions.find((d) => d.escalation);
    assert.deepEqual(decision.escalation.settings, ['budget.raise']);
    assert.deepEqual(decision.blocks, scope === 'project' ? [] : ['T1']);
    assert.match(decision.question, /was stopped/);
    assert.deepEqual(decision.answerers, []);
    assert.equal(decision.kind, 'spend');
    assert.equal(decision.technical, false);
    assert.equal(decision.answer_rule, null);
    const answer = h.run(['answer', decision.id, '--choice', 'raise', '--agent', 'orchestrator']);
    assert.notEqual(answer.code, 0);
    assert.match(answer.stderr, /only the owner answers it/);
    const withdrawal = h.run(['decision', 'withdraw', decision.id, '--reason', 'use another route', '--agent', 'orchestrator']);
    assert.notEqual(withdrawal.code, 0);
    assert.match(withdrawal.stderr, /only the agent that opened.*or the owner/);
    assert.equal(h.readState('decisions.json').decisions.find((d) => d.id === decision.id).status, 'open');

    // The exit collection replaces the live entry: one entry, counted once.
    await until(t, h, () => {
      const s = recordedSpend(h);
      return s.entries?.length === 1 && !s.entries[0].live;
    }, 'exit collection did not reconcile the live entry');
    const spend = h.json(['task', 'show', 'T1']).spend;
    assert.equal(spend.entries[0].source, `spawn:${spawned.agent}`);
    assert.equal(spend.tokens, 4000);
    assert.equal(spend.tokens, spend.entries[0].tokens);
    h.ok(['spend', 'T1', '--from-spawn', spawned.agent]);
    assert.equal(h.json(['task', 'show', 'T1']).spend.tokens, spend.tokens, 'recollection does not count twice');
    assert.deepEqual(h.json(['status']).spend.live, []);

    // Further spawns wait for the owner to raise the budget.
    if (scope === 'project') {
      h.ok(['task', 'add', '--title', 'Next worker', '--tier', 'easy', '--acceptance', 'project budget holds']);
      h.ok(['brief', 'set', 'T2', '-'], { input: 'Work on T2.\n' });
      const again = h.run(['spawn', '--task', 'T2'], { env: h.liveEnv({ LIVE_STEPS: '1' }) });
      assert.notEqual(again.code, 0);
      assert.match(again.stderr, /project tokens budget crossed.*only the owner raises a budget/);
    } else {
      const raise = h.run(['task', 'update', 'T1', '--budget-tokens', '100000', '--agent', 'orchestrator']);
      assert.notEqual(raise.code, 0);
      assert.match(raise.stderr, /budget.raise is owner-required/);
      h.ok(['task', 'update', 'T1', '--budget-tokens', '3000', '--agent', 'orchestrator']);
      assert.equal(h.readState('tasks.json').tasks[0].budget.tokens, 3000, 'lowering is operational');
    }

    const text = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    for (const secret of [path.join(h.state, 'homes'), 'projects' + path.sep, 'rollout-']) {
      assert.ok(!live.some((e) => JSON.stringify(e).includes(secret)), `live usage events name ${secret}`);
    }
    assert.ok(!text.includes('"claude_home"'), 'events never carry the claude session root');
  });
}
