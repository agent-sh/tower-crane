'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, BIN } = require('./helpers');
const { gateFixture } = require('./gate-helpers');

const events = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const task = (h, id) => h.readState('tasks.json').tasks.find((t) => t.id === id);
const ready = (h) => h.json(['ready']).ready.map((t) => [t.id, t.status]);

test('a worker asks and releases with its PR linked; answering resumes that PR, and rework sends back a task released for a decision', (t) => {
  const h = makeRepo(t);
  const sha = gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Pick a store', '--acceptance', 'the store is chosen']);
  h.ok(['task', 'add', '--title', 'Pick a cache', '--acceptance', 'the cache is chosen']);
  h.ok(['task', 'add', '--title', 'Plain release', '--acceptance', 'no decision is involved']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'Implement the store.\n' });

  // The spawned worker only records the prompt it was given, so the test can read the PR note.
  const seen = path.join(h.base, 'seen.json');
  const script = path.join(h.base, 'worker.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
const [out, prompt] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({ prompt, agent: process.env.TOWER_CRANE_AGENT }));
`);
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
    '--command', JSON.stringify([process.execPath, script, seen, '{prompt}'])]);

  // T1: the worker opens PR 7 on its branch, asks, and releases with the PR linked.
  h.env.FIXTURE_PR_HEAD_7 = 'tower-crane/T1';
  h.env.FIXTURE_PR_STATE_7 = 'OPEN';
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['ask', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1', '--agent', 'w-1']);
  h.ok(['release', 'T1', '--reason', 'waiting on D1', '--pr', '7', '--agent', 'w-1']);
  assert.deepEqual([task(h, 'T1').status, task(h, 'T1').pr, task(h, 'T1').branch], ['todo', 7, 'tower-crane/T1']);
  assert.equal(events(h).findLast((e) => e.cmd === 'release').detail.decisions[0], 'D1');
  assert.ok(!ready(h).some(([id]) => id === 'T1'), 'the open decision keeps T1 out of ready');

  // T2 is released for a decision too; T3 is released without one.
  h.env.FIXTURE_PR_HEAD_8 = 'tower-crane/T2';
  h.env.FIXTURE_PR_STATE_8 = 'OPEN';
  h.ok(['claim', 'T2', '--agent', 'w-2']);
  h.ok(['ask', '--question', 'Which cache?', '--option', 'lru', '--option', 'none', '--blocks', 'T2', '--agent', 'w-2']);
  h.ok(['release', 'T2', '--reason', 'waiting on D2', '--pr', '8', '--agent', 'w-2']);
  h.ok(['claim', 'T3', '--agent', 'w-3']);
  h.ok(['release', 'T3', '--reason', 'stopped for now', '--agent', 'w-3']);
  const refused = h.run(['rework', 'T3', '--reason', 'send it back', '--agent', 'owner']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /todo tasks released for a decision/);
  assert.equal(task(h, 'T3').status, 'todo', 'a refused rework writes nothing');

  // Answering D1 makes T1 ready with its PR still linked, and the next dispatch gets that PR in its prompt.
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'owner']);
  assert.ok(ready(h).some(([id, status]) => id === 'T1' && status === 'todo'));
  const dispatched = h.json(['spawn', '--task', 'T1', '--wait']);
  const prompt = JSON.parse(fs.readFileSync(seen, 'utf8')).prompt;
  assert.match(prompt, /## Pull request T1\n\nThis task's pull request is #7 on branch tower-crane\/T1\./);
  assert.match(prompt, /submit with --pr 7; do not open another PR\./);
  assert.equal(dispatched.agent.startsWith('worker-T1-'), true);

  // The next worker continues PR 7 with a new head, instead of opening its own PR.
  h.ok(['claim', 'T1', '--agent', 'w-4']);
  fs.writeFileSync(path.join(dispatched.cwd, 'value.js'), 'module.exports = 2;\n');
  h.git(['commit', '-qam', 'resume the store'], dispatched.cwd);
  const resumed = h.git(['rev-parse', 'HEAD'], dispatched.cwd);
  const submitted = h.json(['submit', 'T1', '--sha', resumed, '--branch', 'tower-crane/T1', '--pr', '7', '--agent', 'w-4']);
  assert.deepEqual([submitted.status, submitted.pr, submitted.branch], ['submitted', 7, 'tower-crane/T1']);
  assert.notEqual(resumed, sha);

  // Rework sends back T2 once its decision is answered, and the task keeps PR 8 for the claim that resumes it.
  h.ok(['answer', 'D2', '--choice', 'lru', '--agent', 'owner']);
  h.ok(['rework', 'T2', '--reason', 'D2 answered lru; continue PR #8', '--agent', 'owner']);
  assert.deepEqual([task(h, 'T2').status, task(h, 'T2').pr], ['rework', 8]);
  assert.ok(ready(h).some(([id, status]) => id === 'T2' && status === 'rework'));
  h.ok(['claim', 'T2', '--agent', 'w-5']);
  assert.equal(task(h, 'T2').pr, 8);
});

test('a refused release by the orchestrator links no PR while its owner decision is open', (t) => {
  const h = makeRepo(t);
  gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Pick a store', '--acceptance', 'the store is chosen']);
  h.env.FIXTURE_PR_HEAD_7 = 'tower-crane/T1';
  h.env.FIXTURE_PR_STATE_7 = 'OPEN';
  h.ok(['claim', 'T1', '--agent', 'w-1']);

  // Releasing another agent's live claim is owner-required, so the attempt opens D1 and then refuses; the refusal writes no PR link.
  const refused = h.run(['release', 'T1', '--reason', 'taking over', '--pr', '7', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /opened D1 for the owner/);
  assert.equal(h.readState('decisions.json').decisions.length, 1);
  assert.deepEqual([task(h, 'T1').status, task(h, 'T1').claim.agent, task(h, 'T1').pr, task(h, 'T1').branch], ['in_progress', 'w-1', null, null]);
  assert.doesNotMatch(JSON.stringify(task(h, 'T1')), /linked PR/);
});

test('a task linked to a closed PR moves to a new PR when its claim is released', (t) => {
  const h = makeRepo(t);
  gateFixture(h);
  h.init(['--repo', 'acme/demo', '--base', 'main']);
  h.ok(['task', 'add', '--title', 'Pick a store', '--acceptance', 'the store is chosen']);
  h.env.FIXTURE_PR_HEAD_7 = 'tower-crane/T1';
  h.env.FIXTURE_PR_STATE_7 = 'OPEN';
  h.env.FIXTURE_PR_HEAD_9 = 'tower-crane/T1-retry';
  h.env.FIXTURE_PR_STATE_9 = 'OPEN';
  h.ok(['claim', 'T1', '--agent', 'w-1']);
  h.ok(['release', 'T1', '--reason', 'stopped', '--pr', '7', '--agent', 'w-1']);

  // While PR 7 is open, a release cannot link another PR in its place.
  h.ok(['claim', 'T1', '--agent', 'w-2']);
  const blocked = h.run(['release', 'T1', '--reason', 'retry', '--pr', '9', '--agent', 'w-2']);
  assert.equal(blocked.code, 1, blocked.stdout);
  assert.match(blocked.stderr, /already linked to open PR #7/);
  assert.deepEqual([task(h, 'T1').status, task(h, 'T1').pr, task(h, 'T1').branch], ['in_progress', 7, 'tower-crane/T1']);

  // Once PR 7 is closed, the release links PR 9 and takes its head branch, as submit does.
  h.env.FIXTURE_PR_STATE_7 = 'CLOSED';
  h.ok(['release', 'T1', '--reason', 'retry on a new PR', '--pr', '9', '--agent', 'w-2']);
  assert.deepEqual([task(h, 'T1').status, task(h, 'T1').pr, task(h, 'T1').branch], ['todo', 9, 'tower-crane/T1-retry']);
});
