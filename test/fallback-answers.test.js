'use strict';

// Decision answers reach every attempt of a task across retries and route switches.

const { waitOnRepo } = require('./signals');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { caseConcurrency, events, setup } = require('./fallback-helpers');

describe('decision answers survive fallback', { concurrency: caseConcurrency }, () => {
for (const row of [
  { state: 'fresh', nextHarness: 'codex', reason: 'outage', chain: true, ack: true },
  { state: 'fresh', nextHarness: 'claude', reason: 'refusal', ack: false },
  { state: 'resumed', nextHarness: 'codex', reason: 'refusal', ack: true },
  { state: 'resumed', nextHarness: 'claude', reason: 'outage', ack: true },
  { state: 'running', nextHarness: 'claude', reason: 'auth', ack: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: false },
  { state: 'retrying', primaryHarness: 'agy', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'pi', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'opencode', nextHarness: 'codex', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'outage', ack: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'no-session', ack: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'claude', nextHarness: 'codex', reason: 'outage', ack: false, pre: true },
  { state: 'retrying', primaryHarness: 'agy', nextHarness: 'codex', reason: 'outage', ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'pi', nextHarness: 'codex', reason: 'outage', ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'opencode', nextHarness: 'codex', reason: 'outage', ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'no-session', ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'claude', reason: 'outage', chain: true, ack: true, pre: true },
  { state: 'retrying', primaryHarness: 'codex', nextHarness: 'agy', reason: 'outage', chain: true, ack: true, pre: true },
]) {
  test(`decision answers survive fallback: ${row.state} ${row.primaryHarness || 'codex'} to ${row.nextHarness}, ${row.reason}, ${row.ack ? 'acknowledged' : 'unread'}${row.pre ? ', pre-dispatch and late answers' : ''}`, async (t) => {
    const h = setup(t, row);
    const agent = 'worker-T1-1';
    const finish = path.join(h.base, 'finish-primary');
    const login = path.join(h.base, 'login');
    const note = 'Use Redis.\nAlso fix the CI gate so dispatch runs do not poison it.';
    const lateNote = 'Keep the late requirement.\nIt must survive the next route too.';
    const answer = (id, text) => {
      h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--blocks', 'T1', '--agent', agent]);
      h.ok(['answer', id, '--choice', 'redis', '--note', text, '--agent', 'orchestrator']);
      if (row.ack) {
        const binding = path.join(h.state, 'homes', agent, 'hook.json');
        fs.mkdirSync(path.dirname(binding), { recursive: true });
        fs.writeFileSync(binding, JSON.stringify({ state: h.state, agent, task: 'T1', role: 'worker', attempt: 1 }));
        const delivered = h.json(['hook', 'inbox', '--binding', binding, '--agent', agent]);
        assert.ok(delivered.context.includes(`Orchestrator note:\n${text}`));
        assert.equal(h.json(['hook', 'inbox', '--binding', binding, '--agent', agent]).context, '');
      }
    };
    if (row.pre) answer('D1', note);
    if (row.state === 'running') {
      Object.assign(h.spawnEnv, { TOWER_CRANE_TEST_FALLBACK_FINISH: finish, TOWER_CRANE_TEST_LATE_AUTH: 'first' });
    }
    if (row.state === 'retrying') {
      Object.assign(h.spawnEnv, { TOWER_CRANE_TEST_FALLBACK_FINISH: finish, TOWER_CRANE_TEST_LATE_OUTAGE: '1' });
    }
    if (row.state !== 'fresh') {
      fs.writeFileSync(login, '');
      const first = h.json(['spawn', '--task', 'T1', ...(row.state === 'resumed' ? ['--wait'] : [])], {
        env: { ...h.spawnEnv, TOWER_CRANE_TEST_LOGIN_FLAG: login },
      });
      assert.equal(first.agent, agent);
      if (row.state === 'running' || row.state === 'retrying') {
        await waitOnRepo(h, () => fs.existsSync(h.file) && h.attempts().length === 1, 'the primary worker to start', { alive: first.monitor_pid });
      } else {
        const session = events(h).findLast((e) => e.cmd === 'spawn session').detail.session_id;
        const sessions = path.join(h.state, 'homes', '.codex', agent, 'sessions');
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, `rollout-${session}.jsonl`), '{}\n');
      }
    }
    answer(row.pre ? 'D2' : 'D1', row.pre ? lateNote : note);
    h.ok(['ask', '--kind', 'technical', '--question', 'Unrelated work?', '--agent', 'other-worker']);
    h.ok(['answer', row.pre ? 'D3' : 'D2', '--choice', 'other', '--note', 'Other task requirement.', '--agent', 'orchestrator']);
    if (row.state === 'resumed') {
      h.ok(['submit', 'T1', '--agent', agent, '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736']);
      h.ok(['rework', 'T1', '--reason', 'Continue after the decision.']);
      assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run'], { env: h.spawnEnv }).resumed, true);
    }
    const before = row.state === 'fresh' ? 0 : h.attempts().length;
    if (row.state === 'running' || row.state === 'retrying') {
      if (row.state === 'retrying') fs.unlinkSync(login);
      fs.writeFileSync(finish, '');
      await waitOnRepo(h, () => events(h).some((e) => e.cmd === 'spawn exit'), 'the fallback worker to exit');
      const exit = events(h).findLast((e) => e.cmd === 'spawn exit').detail;
      assert.equal(exit.code, 0, JSON.stringify({ exit, attempts: h.attempts() }));
    } else {
      const result = h.spawn();
      assert.equal(result.code, 0, result.stderr);
    }
    const attempts = h.attempts().slice(before);
    assert.ok(attempts.some((a) => a.harness === row.nextHarness && a.model === 'second'));
    if (row.state === 'retrying') {
      const retries = attempts.filter((a) => a.model === 'first');
      assert.deepEqual(retries.map((a) => a.retry), ['1', '2']);
      if (row.primaryHarness === 'codex' && row.reason !== 'no-session') {
        assert.ok(retries.every((a) => a.args.includes('resume') && a.args.includes('11111111-1111-1111-1111-111111111111')));
        assert.ok(retries.every((a) => !a.args.some((arg) => arg.includes('## Decision answers'))),
          'warm resumes keep their conversation without repeating the answer section');
      } else assert.ok(retries.every((a) => !a.args.includes('resume') && !a.args.includes('--resume')));
      if (row.primaryHarness === 'claude') {
        const sessions = h.attempts().filter((a) => a.model === 'first')
          .map((a) => a.args[a.args.indexOf('--session-id') + 1]);
        assert.equal(new Set(sessions).size, 3, 'each Claude invocation starts a new conversation');
      }
    }
    const expected = `decision D1 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${note}`;
    const copies = (attempt, text) => attempt.args.reduce((n, arg) => n + arg.split(text).length - 1, 0);
    if (row.pre) assert.equal(copies(h.attempts()[0], expected), 1, 'dispatch includes the full pre-dispatch answer once');
    for (const attempt of attempts) {
      // Warm retries keep the conversation; route starts rebuild its prompt.
      if (attempt.retry !== '0' && attempt.args.includes('resume')) continue;
      assert.ok(attempt.args.some((arg) => arg.includes(expected)), `${attempt.harness} ${attempt.model} retry ${attempt.retry} lost the answer`);
      assert.equal(copies(attempt, expected), 1, `${attempt.harness} ${attempt.model} retry ${attempt.retry} repeats the answer`);
      if (row.pre) {
        const late = `decision D2 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${lateNote}`;
        assert.equal(copies(attempt, late), 1, `${attempt.harness} ${attempt.model} retry ${attempt.retry} must keep the late answer once`);
      }
      assert.ok(!attempt.args.some((arg) => arg.includes('Other task requirement.')));
    }
    assert.equal(events(h).filter((e) => e.cmd === 'spawn fallback').length, row.chain ? 2 : 1);
  });
}
});
