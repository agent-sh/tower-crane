'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo } = require('./helpers');

test('--json output parses for every reading and writing command', (t) => {
  const h = makeRepo(t);
  const parse = (args, opts) => {
    const r = h.run([...args, '--json'], opts);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  assert.equal(parse(['init', '--name', 'demo', '--goal', 'g']).project.name, 'demo');
  assert.equal(parse(['task', 'add', '--title', 'A', '--acceptance', 'a']).id, 'T1');
  assert.equal(parse(['task', 'add', '--title', 'B', '--acceptance', 'b', '--dep', 'T1']).depends_on[0], 'T1');
  assert.equal(parse(['task', 'update', 'T2', '--size', 'S']).size, 'S');
  assert.equal(parse(['task', 'note', 'T1', 'hello']).text, 'hello');
  assert.equal(parse(['task', 'show', 'T1']).display, 'ready');
  assert.equal(parse(['task', 'list', '--status', 'blocked'])[0].id, 'T2');
  assert.equal(parse(['brief', 'set', 'T1', '-'], { input: 'brief' }).id, 'T1');
  assert.equal(parse(['brief', 'get', 'T1']).brief, 'brief');
  assert.equal(parse(['validate']).ok, true);
  assert.equal(parse(['ready', '--all']).blocked[0].id, 'T2');
  assert.equal(parse(['ask', '--question', 'Q?', '--option', 'a', '--option', 'b']).id, 'D1');
  assert.equal(parse(['decisions']).length, 1);
  assert.deepEqual(
    parse(['decision', 'delegate', 'D1', '--answerers', '["w"]', '--agent', 'owner']).answerers,
    ['w'],
  );
  const answered = parse(['answer', 'D1', '--choice', 'a', '--agent', 'owner']);
  assert.deepEqual([answered.answer, answered.answered_by, answered.answer_rule], ['a', 'owner', 'owner']);
  assert.equal(parse(['claim', 'T1', '--agent', 'w']).claim.agent, 'w');
  assert.equal(parse(['renew', 'T1', '--agent', 'w']).status, 'in_progress');
  assert.equal(parse(['spend', 'T1', '--minutes', '5', '--tokens', '10']).spend.tokens, 10);
  assert.equal(parse(['submit', 'T1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', 'w']).status, 'submitted');
  assert.equal(parse(['evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', '1', '--agent', 'r']).type, 'review');
  assert.equal(parse(['rework', 'T1', '--reason', 'r']).status, 'rework');
  assert.equal(parse(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'm', '--clear', 'profile']).harness, 'pi');
  assert.equal(parse(['ladder', 'show']).ladder.small.model, 'm');
  assert.equal(parse(['ladder', 'harness', 'codex']).harness, 'codex');
  assert.equal(parse(['project', 'set', '--workers', '3']).limits.workers, 3);
  assert.equal(parse(['project', 'show']).limits.workers, 3);
  assert.equal(parse(['status']).counts.rework, 1);
  assert.ok(parse(['render']).html.endsWith('sketch.html'));
});
