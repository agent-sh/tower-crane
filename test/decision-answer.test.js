'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const Decisions = require('../lib/decisions');
const Events = require('../lib/events');
const Answer = require('../lib/decision-answer');

const variants = [
  { name: 'no note', choice: 'redis', note: null, lines: 0 },
  { name: 'empty note', choice: 'redis', note: '', lines: 0 },
  { name: 'short note', choice: 'postgres', note: 'yes', lines: 1 },
  { name: 'long single line', choice: 'redis', note: 'Also fix the CI gate before submitting.', lines: 1, notice: true },
  { name: 'multiple lines', choice: 'redis', note: 'Use Redis.\nAlso fix the CI gate.\nKeep dispatch runs out.', lines: 3, notice: true },
  { name: 'blank lines and CRLF', choice: 'redis', note: 'Use Redis.\r\n\r\nKeep the last requirement.\r\n', lines: 4, notice: true },
];

for (const row of variants) {
  test(`decision reads keep the full answer note: ${row.name}`, () => {
    const text = Decisions.line({
      id: 'D1', status: 'answered', question: 'Which store?', options: [],
      blocks: [], answer: row.choice, note: row.note,
    });
    assert.ok(text.includes(` -> ${row.choice}`));
    if (row.lines) assert.ok(text.endsWith(`\nOrchestrator note:\n${row.note}`), text);
    else assert.doesNotMatch(text, /Orchestrator note:/);
    if (row.notice) assert.ok(text.split('\n')[0].includes(`answer has a note with ${row.lines} lines`), text);
    else assert.doesNotMatch(text, /answer has a note/);
    const wake = Events.wake({
      id: 'E1', type: 'decision-answer', cmd: 'answer', to: 'orchestrator', agent: 'orchestrator',
      detail: { decision: 'D1', choice: row.choice, note: row.note },
    });
    assert.ok(wake.text.includes(`answered: ${row.choice}`));
    const notice = Events.notice([wake], 'asking-worker');
    if (row.lines) assert.ok(notice.includes(`\nOrchestrator note:\n${row.note}`), notice);
    else assert.doesNotMatch(notice, /Orchestrator note:/);
  });
}

test('decision prompt sections select answered decisions for their task', () => {
  const decisions = [
    { id: 'D1', status: 'answered', blocks: ['T1', 'T2'], answer: 'redis', note: 'Keep the extra requirement.' },
    { id: 'D2', status: 'open', blocks: ['T1'], answer: null, note: null },
    { id: 'D3', status: 'withdrawn', blocks: ['T1'], answer: null, note: null },
    { id: 'D4', status: 'answered', blocks: ['T3'], answer: 'other', note: 'Other task requirement.' },
  ];
  for (const task of ['T1', 'T2', 'T3', 'T4']) {
    const text = Answer.section(decisions, task);
    if (task === 'T4') assert.equal(text, '');
    else {
      assert.ok(text.startsWith(`## Decision answers ${task}`));
      assert.ok(text.includes(`Orchestrator note:\n${task === 'T3' ? 'Other task requirement.' : 'Keep the extra requirement.'}`));
      assert.doesNotMatch(text, /decision D2|decision D3/);
      if (task !== 'T3') assert.doesNotMatch(text, /Other task requirement\./);
      else assert.doesNotMatch(text, /Keep the extra requirement\./);
    }
  }
});

function setup(t) {
  return cachedFixture(t, 'answer delivery', (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Pick a store', '--acceptance', 'the complete answer arrives']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'Implement the chosen store.\n' });
    const seen = path.join(h.base, 'prompt.txt');
    const worker = path.join(h.base, 'worker.js');
    fs.writeFileSync(worker, "require('node:fs').writeFileSync(process.argv[2], process.argv[3]);\nconsole.log(JSON.stringify({ type: 'thread.started', thread_id: 'answer-session' }));\n");
    h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--clear', 'profile', '--clear', 'effort',
      '--command', JSON.stringify([process.execPath, worker, seen, '{prompt}'])]);
    return { seen };
  });
}

test('wait help keeps ownership and complete decision answers', (t) => {
  const h = setup(t);
  const help = h.ok(['wait', '--help']);
  assert.match(help, /--own --task ID/);
  assert.match(help, /--own waits as the PR owner/);
  assert.match(help, /--follow streams wakes with complete decision answers/);
  assert.match(help, /including complete decision answers/);
});

for (const rule of [null, 'owner', 'owner-named-agent', 'owner-technical-delegation', 'orchestrator-escalated-question']) {
  test(`decision notes retain the answer rule: ${rule || 'legacy'}`, () => {
    const note = 'Use Redis.\nKeep the extra requirement.';
    const text = Decisions.line({
      id: 'D1', status: 'answered', question: 'Which store?', options: [],
      blocks: [], answer: 'redis', answer_rule: rule, note,
    });
    assert.ok(text.split('\n')[0].includes(` -> redis${rule ? ` (${rule})` : ''}`), text);
    assert.ok(text.endsWith(`\nOrchestrator note:\n${note}`), text);
  });
}

for (const note of [null, '', 'Keep this requirement.', 'Use Redis.\nAlso fix the CI gate.']) {
  test(`delegated answer notes retain the authority notice: ${note === null ? 'absent' : note === '' ? 'empty' : note.includes('\n') ? 'multiline' : 'single line'}`, (t) => {
    const h = setup(t);
    h.ok(['ask', '--kind', 'technical', '--setting', 'sandbox', '--question', 'How should we continue?',
      '--option', 'redis', '--blocks', 'T1', '--agent', 'asking-worker']);
    const before = h.readState('project.json');
    const output = h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator',
      ...(note === null ? [] : ['--note', note])]);
    const notice = 'This answer authorizes no setting change; any widening still needs a separate owner approval request.';
    assert.ok(output.startsWith('D1 answered: redis'));
    assert.ok(output.endsWith(notice), output);
    if (note) {
      assert.ok(output.includes(`\nOrchestrator note:\n${note}\n${notice}`), output);
    } else assert.doesNotMatch(output, /Orchestrator note:/);
    const decision = h.readState('decisions.json').decisions[0];
    assert.equal(decision.answer_rule, 'orchestrator-escalated-question');
    assert.ok(h.ok(['decisions']).includes('redis (orchestrator-escalated-question)'));
    const message = h.json(['wait', '--after', '0', '--for', 'asking-worker', '--agent', 'asking-worker',
      '--types', 'worker-message', '--observe', '--timeout', '0']);
    assert.ok(message.detail.text.includes('redis'));
    if (note) assert.ok(message.detail.text.endsWith(`\nOrchestrator note:\n${note}`));
    assert.deepEqual(h.readState('project.json'), before, 'the answer grants no setting change');
  });
}

test('a resumed worker gets the answer again after its hook acknowledged it', (t) => {
  const h = setup(t);
  const first = h.json(['spawn', '--task', 'T1', '--wait']);
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--blocks', 'T1', '--agent', first.agent]);
  const note = 'Use Redis.\nAlso fix the CI gate so dispatch runs do not poison it.';
  h.ok(['answer', 'D1', '--choice', 'redis', '--note', note, '--agent', 'orchestrator']);
  const binding = path.join(h.state, 'homes', first.agent, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ state: h.state, agent: first.agent, task: 'T1', role: 'worker', attempt: 1 }));
  const delivery = h.json(['hook', 'inbox', '--binding', binding, '--agent', first.agent]);
  assert.ok(delivery.context.includes(`Orchestrator note:\n${note}`));
  assert.equal(h.json(['hook', 'inbox', '--binding', binding, '--agent', first.agent]).context, '');
  const sha = h.git(['rev-parse', 'HEAD'], first.cwd);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', first.agent]);
  h.ok(['rework', 'T1', '--reason', 'Continue after the decision.', '--agent', 'orchestrator']);
  const resumed = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.agent, first.agent);
  const prompt = fs.readFileSync(h.seen, 'utf8');
  assert.ok(prompt.includes(`decision D1 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${note}`), prompt);
});

test('the asking worker gets the choice and full note in wake, hook and decision reads', (t) => {
  const h = setup(t);
  const asker = 'asking-worker';
  const note = 'Use Redis.\nAlso fix the CI gate so dispatch runs do not poison it.';
  const expected = `decision D1 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${note}`;
  h.ok(['task', 'add', '--title', 'Use the same store', '--acceptance', 'the answer arrives here too']);
  h.ok(['claim', 'T1', '--agent', asker]);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis',
    '--blocks', 'T1', '--blocks', 'T2', '--agent', asker]);
  const answer = h.ok(['answer', 'D1', '--choice', 'redis', '--note', note, '--agent', 'orchestrator']);
  assert.ok(answer.includes(`Orchestrator note:\n${note}`), answer);

  const wake = h.json(['wait', '--after', '0', '--for', asker, '--agent', asker, '--task', 'T2',
    '--types', 'worker-message', '--observe', '--timeout', '0']);
  assert.equal(wake.detail.to, asker);
  assert.equal(wake.detail.text, expected);

  const binding = path.join(h.state, 'homes', asker, 'hook.json');
  fs.mkdirSync(path.dirname(binding), { recursive: true });
  fs.writeFileSync(binding, JSON.stringify({ state: h.state, agent: asker, task: 'T1', role: 'worker', attempt: 1 }));
  const hook = (action, payload) => h.json(['hook', action, '--binding', binding, '--agent', asker,
    '--payload', JSON.stringify(payload)]);
  const inbox = hook('inbox', { ack: false });
  assert.ok(inbox.context.includes(expected), inbox.context);
  const stop = hook('stop', {});
  assert.equal(stop.block, true);
  assert.ok(stop.context.includes(expected), stop.context);
  assert.equal(hook('inbox', {}).context, '', 'the stop delivery acknowledged the message');
  assert.ok(h.ok(['decisions', '--agent', asker]).includes(`Orchestrator note:\n${note}`));
  assert.ok(h.ok(['task', 'show', 'T1', '--agent', asker]).includes(expected));
  assert.ok(h.ok(['task', 'show', 'T2', '--agent', asker]).includes(expected));
});

test('a note reaches an asker even when the decision blocks no task', (t) => {
  const h = setup(t);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--agent', 'asking-worker']);
  h.ok(['answer', 'D1', '--choice', 'redis', '--note', 'Keep the CI fix.', '--agent', 'orchestrator']);
  const wake = h.json(['wait', '--after', '0', '--for', 'asking-worker', '--agent', 'asking-worker',
    '--types', 'worker-message', '--observe', '--timeout', '0']);
  assert.ok(wake.detail.text.includes('redis'));
  assert.ok(wake.detail.text.endsWith('\nOrchestrator note:\nKeep the CI fix.'));
});

for (const rework of [false, true]) {
  test(`a ${rework ? 'rework' : 'fresh'} worker prompt keeps the complete decision answer`, (t) => {
    const h = setup(t);
    const note = 'Use Redis.\nAlso fix the CI gate so dispatch runs do not poison it.';
    h.ok(['claim', 'T1', '--agent', 'asking-worker']);
    h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--blocks', 'T1', '--agent', 'asking-worker']);
    h.ok(['release', 'T1', '--reason', 'waiting on D1', '--agent', 'asking-worker']);
    h.ok(['answer', 'D1', '--choice', 'redis', '--note', note, '--agent', 'orchestrator']);
    h.ok(['ask', '--kind', 'technical', '--question', 'Unrelated question?', '--agent', 'another-worker']);
    h.ok(['answer', 'D2', '--choice', 'unrelated', '--note', 'Other work.', '--agent', 'orchestrator']);
    if (rework) h.ok(['rework', 'T1', '--reason', 'Continue after the decision.', '--agent', 'orchestrator']);
    h.json(['spawn', '--task', 'T1', '--wait']);
    const prompt = fs.readFileSync(h.seen, 'utf8');
    assert.ok(prompt.includes(`decision D1 answered: redis (answer has a note with 2 lines)\nOrchestrator note:\n${note}`), prompt);
    assert.doesNotMatch(prompt, /Other work\./);
  });
}
