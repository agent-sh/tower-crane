'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, BIN, HOOKS } = require('./helpers');
const { CHROME, openBrowser, closeBrowser } = require('./browser');
const { waitOnRepo } = require('./signals');

test.after(closeBrowser);

const STUB = path.join(__dirname, 'fixtures', 'live-usage-harness.js').replace(/\\/g, '/');
const events = (h) => require('../lib/state').readEvents(h.state);
const recordedSpend = (h) => h.readState('tasks.json').tasks[0].spend;
const liveEntries = (h) => (recordedSpend(h).entries || []).filter((e) => e.live);

function until(t, h, fn, message, stream) {
  return waitOnRepo(h, fn, message, {
    signal: t.signal,
    subscribe: stream && ((probe) => {
      stream.on('data', probe);
      return () => stream.off('data', probe);
    }),
  });
}

function viewClock(h, at) {
  const file = path.join(h.base, 'view-clock');
  fs.writeFileSync(file, String(Date.parse(at) + 1000));
  return { hooks: { HOOK_CLOCK_FILE: file } };
}

function setup(t, harness, supervision = {}) {
  const h = cachedFixture(t, `live-spend:${harness}`, (fixture) => {
    fixture.init();
    fixture.ok(['task', 'add', '--title', 'Spend live', '--tier', 'easy', '--acceptance', 'budget holds']);
    fixture.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
    const bin = path.join(fixture.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    fixture.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'dispatch-model', '--clear', 'profile', '--clear', 'effort',
      '--supervision', '{"usage_ms":500,"stall_ms":60000}']);
  });
  if (Object.keys(supervision).length) h.ok(['ladder', 'set', 'easy', '--supervision',
    JSON.stringify({ usage_ms: 500, stall_ms: 60000, ...supervision })]);
  const bin = path.join(h.base, 'bin');
  h.done = path.join(h.base, 'done');
  h.liveEnv = (extra = {}) => ({
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${STUB}"`, LIVE_DONE: h.done, ...extra,
  });
  return h;
}

const exited = (h, agent) => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent && e.detail.code !== undefined);

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
  h.json(['spawn', '--task', 'T1'], { env: h.liveEnv({ LIVE_STEPS: '1', LIVE_HOLD: 'until-stop', LIVE_READS: reads, LIVE_NO_CLAIM: '1' }) });
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

    // The owner is told, through a decision only the owner can answer.
    const decision = h.readState('decisions.json').decisions.find((d) => d.escalation);
    assert.deepEqual(decision.escalation.settings, ['budget.raise']);
    assert.deepEqual(decision.blocks, scope === 'project' ? [] : ['T1']);
    assert.match(decision.question, /was stopped/);
    assert.deepEqual(decision.answerers, []);
    assert.equal(decision.technical, false);
    assert.equal(decision.answer_rule, null);
    const answer = h.run(['answer', decision.id, '--choice', 'raise', '--agent', 'orchestrator']);
    assert.notEqual(answer.code, 0);
    assert.match(answer.stderr, /only the owner answers it/);

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
    await until(t, h, () => events(h).some((e) => e.cmd === 'spend live' && e.detail.tokens === tokens), 'initial usage was not recorded');
    const before = h.json(['task', 'show', 'T1']).spend;
    const file = fs.readFileSync(location, 'utf8');
    const data = fs.readFileSync(file);
    const readings = events(h).filter((e) => e.cmd === 'spend live').length;
    fs.unlinkSync(file);
    await until(t, h, () => events(h).filter((e) => e.cmd === 'spend live').length > readings, 'missing telemetry was not observed');
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
    await b.goto(`${url}#spend`);
    await b.until(`document.querySelector('.conn').dataset.conn === 'live'`, 'the live stream');
    assert.equal(await b.inPage(`document.querySelector('[data-live-state]').dataset.liveState`), 'live');
    const log = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    await b.inPage(`window.boardNow += 60000; window.boardTimers.forEach((callback) => callback());`);
    const shown = await b.inPage(`(() => {
      const row = document.querySelector('[data-live-state]');
      return { state: row.dataset.liveState, freshness: row.cells[3].textContent, age: row.cells[4].textContent,
        summary: document.querySelector('.spendmini').textContent, running: document.querySelector('.total[data-live]').textContent };
    })()`);
    assert.equal(shown.state, 'stale');
    assert.equal(shown.freshness, 'stale');
    assert.equal(shown.age, '61s ago');
    assert.match(shown.summary, /stale/);
    assert.match(shown.running, /stale/);
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
  const script = "require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']); setInterval(() => {}, 1000);";
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
    + " require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'claim', 'T1']); process.exit(75);";
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
