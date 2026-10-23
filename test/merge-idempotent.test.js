'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

function acceptedTask(t) {
  return cachedFixture(t, 'accepted merge', (h) => {
    const sha = gateFixture(h);
    h.git(['switch', '-q', 'main']);
    h.init(['--repo', 'acme/demo', '--base', 'main']);
    h.ok(['task', 'add', '--title', 'Change', '--kind', 'code', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker-T1']);
    h.ok(['submit', 'T1', '--sha', sha, '--pr', '42', '--agent', 'worker-T1']);
    for (const type of ['tests', 'clean', 'ci']) gateEvidence(h, type, 'checker');
    h.reviewer('T1', 'reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
    h.ok(['accept', 'T1']);
    h.env.FIXTURE_GH_LOG = path.join(h.base, 'gh.jsonl');
    return { sha };
  });
}

for (const onGitHub of [false, true]) {
  test(`repeated merges append nothing after ${onGitHub ? 'confirming a GitHub merge' : 'merging an accepted task'}`, (t) => {
    const h = acceptedTask(t);
    if (onGitHub) h.env.FIXTURE_PR_STATE = 'MERGED';
    const command = ['merge', 'T1', '--agent', 'orchestrator'];
    const first = h.json(command);
    assert.equal(first.ok, true, first.summary);
    assert.equal(first.ref, h.sha);
    const snapshot = () => ['tasks.json', 'events.jsonl'].map((file) => fs.readFileSync(path.join(h.state, file), 'utf8'));
    const before = snapshot();
    const calls = fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8');
    const second = h.ok(command);
    assert.deepEqual(snapshot(), before, 'the second merge changes no state or events');
    assert.match(second, new RegExp(`already merged at ${first.ref}`));
    const third = h.json(command);
    assert.equal(third.ok, true, third.summary);
    assert.equal(third.ref, first.ref);
    assert.match(third.summary, new RegExp(`already merged at ${first.ref}`));
    assert.deepEqual(snapshot(), before, 'JSON output also changes no state or events');
    assert.equal(fs.readFileSync(h.env.FIXTURE_GH_LOG, 'utf8'), calls, 'a recorded merge needs no GitHub lookup');
    const events = before[1].trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.task === 'T1' && event.type === 'merged').length, 1);
    assert.equal(h.readState('tasks.json').tasks[0].evidence.filter((entry) => entry.type === 'merge').length, 1);
    const merges = calls.trim().split('\n').map(JSON.parse).filter((args) => args[0] === 'pr' && args[1] === 'merge');
    assert.equal(merges.length, onGitHub ? 0 : 1);
  });
}
