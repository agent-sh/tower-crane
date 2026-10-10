'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { gateFixture, gateEvidence } = require('./gate-helpers');

// A submitted, reviewed task, built once per process; gates names the
// software gates that already passed at its sha.
function setup(t, gates = []) {
  return cachedFixture(t, gates.join(','), (h) => {
    const sha = gateFixture(h);
    h.init(['--repo', 'acme/demo', '--base', 'main']);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
    h.ok(['claim', 'T1', '--agent', 'worker']);
    h.ok(['submit', 'T1', '--sha', sha, '--pr', '1', '--agent', 'worker']);
    h.reviewer('T1', 'reviewer', sha);
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', sha, '--agent', 'reviewer']);
    for (const type of gates) gateEvidence(h, type, 'checker');
  });
}
const ALL = ['tests', 'clean', 'ci'];

test('manual software evidence is refused for either verdict and every agent without writing state', (t) => {
  const h = setup(t);
  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  // Every type and agent, alternating the verdict and an explicit sha.
  for (const [i, type] of ['tests', 'clean', 'ci', 'merge'].entries()) {
    for (const [j, agent] of ['worker', 'reviewer', 'owner'].entries()) {
      const verdict = (i + j) % 2 ? '--fail' : '--ok';
      const shaArgs = j % 2 ? ['--sha', h.env.FIXTURE_SHA] : [];
      const r = h.run(['evidence', 'T1', '--type', type, verdict, '--agent', agent, ...shaArgs]);
      assert.equal(r.code, 1, `${type} ${agent} ${verdict}: ${r.stderr}`);
      assert.match(r.stderr, /only tower-crane (check|merge)/);
    }
  }
  assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--agent', 'worker']);
});

test('hand-written tests ok stays readable but cannot satisfy accept', (t) => {
  const h = setup(t, ['clean', 'ci']);
  const doc = h.readState('tasks.json');
  // A legacy or hand-edited record must not become proof that a test command ran.
  doc.tasks[0].evidence.push({ type: 'tests', ok: true, sha: doc.tasks[0].sha, agent: 'worker', revision: 1, summary: 'tests passed' });
  h.writeState('tasks.json', doc);
  const shown = h.json(['task', 'show', 'T1']);
  assert.equal(shown.evidence.at(-1).ok, true);
  const r = h.run(['accept', 'T1', '--agent', 'reviewer']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /tests: no tests evidence/);
  assert.doesNotMatch(r.stderr, /clean:|ci:|review:/);
  assert.equal(h.readState('tasks.json').tasks[0].status, 'submitted');
  assert.match(h.ok(['task', 'show', 'T1']), /tests ok .* \(does not count\)/);
});

test('forged gate source without an audit event cannot satisfy accept', (t) => {
  const h = setup(t, ['clean', 'ci']);
  const doc = h.readState('tasks.json');
  const task = doc.tasks[0];
  for (const commands of [[], [{ command: 'npm test', args: [], cwd: h.repo, status: 0, signal: null }]]) {
    task.evidence.push({ type: 'tests', ok: true, sha: task.sha, agent: 'worker', revision: task.revision, source: 'check tests', commands });
    h.writeState('tasks.json', doc);
    const r = h.run(['accept', 'T1', '--agent', 'reviewer']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /tests: no tests evidence/);
    assert.doesNotMatch(r.stderr, /clean:|ci:|review:/);
    const shown = h.json(['task', 'show', 'T1']);
    assert.equal(shown.evidence.at(-1).source, 'check tests');
    assert.equal(shown.gates.ok, false);
    assert.match(h.ok(['task', 'show', 'T1']), /tests ok .* \(does not count\)/);
    h.ok(['render']);
    assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /missing tests/);
    task.evidence.pop();
  }
});

test('software receipts count only with a matching gate event', (t) => {
  const h = setup(t, ALL);
  const eventsFile = path.join(h.state, 'events.jsonl');
  const original = fs.readFileSync(eventsFile, 'utf8');
  const events = original.trim().split('\n').map(JSON.parse);
  // The event match is the same for every gate: each field once on tests,
  // and a missing event for the other gates.
  const changes = ['missing', 'cmd', 'task', 'agent', 'type', 'source', 'sha', 'ok', 'commands', 'revision'];
  for (const type of ['tests', 'clean', 'ci']) {
    for (const change of type === 'tests' ? changes : ['missing']) {
      const altered = structuredClone(events);
      const index = altered.findIndex((e) => e.cmd === `check ${type}`);
      const event = altered[index];
      if (change === 'missing') altered.splice(index, 1);
      else if (change === 'cmd') event.cmd = 'evidence';
      else if (change === 'task') event.task = 'T2';
      else if (change === 'agent') event.agent = 'another-worker';
      else if (change === 'type') event.detail.type = 'note';
      else if (change === 'source') event.detail.source = 'evidence';
      else if (change === 'sha') event.detail.sha = 'fffffff';
      else if (change === 'ok') event.detail.ok = false;
      else if (change === 'commands') event.detail.commands[0].status = 42;
      else event.detail.revision = 0;
      // Alter only the audit file to prove the source marker alone is insufficient.
      fs.writeFileSync(eventsFile, altered.map((e) => JSON.stringify(e) + '\n').join(''));
      const r = h.run(['accept', 'T1']);
      assert.equal(r.code, 1, `${type} ${change}: ${r.stdout}`);
      assert.ok(r.stderr.includes(`${type}: no ${type} evidence`), `${change}: ${r.stderr}`);
      const line = h.ok(['task', 'show', 'T1']).split('\n').find((line) => line.startsWith(`  - ${type} ok `));
      assert.ok(line.includes('(does not count)'), `${change}: ${line}`);
    }
  }
  fs.writeFileSync(eventsFile, original + '{"torn":\n');
  h.ok(['accept', 'T1']);
});

test('an ok gate result with matching event but no commands cannot satisfy accept', (t) => {
  const h = setup(t, ALL);
  const original = h.readState('tasks.json');
  const eventsFile = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  for (const type of ['tests', 'clean', 'ci']) {
    const doc = structuredClone(original);
    doc.tasks[0].evidence.find((e) => e.type === type).commands = [];
    const altered = structuredClone(events);
    altered.find((e) => e.cmd === `check ${type}`).detail.commands = [];
    h.writeState('tasks.json', doc);
    fs.writeFileSync(eventsFile, altered.map((e) => JSON.stringify(e) + '\n').join(''));
    const r = h.run(['accept', 'T1']);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.stderr.includes(`${type}: no ${type} evidence`), r.stderr);
    assert.ok(h.ok(['task', 'show', 'T1']).split('\n')
      .find((line) => line.startsWith(`  - ${type} ok `)).includes('(does not count)'));
  }
});

test('merge rechecks software events after acceptance', (t) => {
  const h = setup(t, ALL);
  h.ok(['accept', 'T1']);
  const eventsFile = path.join(h.state, 'events.jsonl');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(eventsFile, events.filter((e) => e.cmd !== 'check tests').map((e) => JSON.stringify(e) + '\n').join(''));
  const r = h.run(['merge', 'T1']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /its gates no longer pass: tests: no tests evidence/);
  assert.ok(!fs.existsSync(h.env.FIXTURE_MERGED), 'the merge command never ran');
});

test('a failed gate after an unterminated audit line still blocks accept and merge', (t) => {
  const h = setup(t, ALL);
  const eventsFile = path.join(h.state, 'events.jsonl');
  const original = fs.readFileSync(eventsFile, 'utf8');
  for (const tail of [original + '{"torn":', original.trimEnd()]) {
    fs.writeFileSync(eventsFile, tail);
    gateEvidence(h, 'tests', 'checker', false);
    const refused = h.run(['accept', 'T1']);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, /latest tests .* failed/);
    const shown = h.json(['task', 'show', 'T1']);
    assert.equal(shown.gates.gates.find((gate) => gate.type === 'tests').ok, false);
    gateEvidence(h, 'tests', 'checker');
  }
  h.ok(['accept', 'T1']);
  fs.appendFileSync(eventsFile, '{"torn":');
  gateEvidence(h, 'ci', 'checker', false);
  const refused = h.run(['merge', 'T1']);
  assert.equal(refused.code, 1, refused.stdout);
  assert.match(refused.stderr, /its gates no longer pass: ci: latest ci .* failed/);
  assert.ok(!fs.existsSync(h.env.FIXTURE_MERGED));
});

test('hand-written waivers require owner identity for review and software gates', (t) => {
  const h = setup(t, ALL);
  const original = h.readState('tasks.json');
  for (const type of ['tests', 'clean', 'review', 'ci']) {
    const doc = structuredClone(original);
    const task = doc.tasks[0];
    task.evidence = task.evidence.filter((e) => e.type !== type);
    task.evidence.push({ type, ok: true, waived: true, sha: task.sha, agent: 'worker', revision: task.revision });
    h.writeState('tasks.json', doc);
    // A review waiver that does not count leaves accept to dispatch a reviewer, so read the gate.
    if (type === 'review') {
      assert.match(h.json(['task', 'show', 'T1']).gates.missing.join('; '), /review:/);
      continue;
    }
    const r = h.run(['accept', 'T1']);
    assert.equal(r.code, 1, `${type}: ${r.stdout}`);
    assert.ok(r.stderr.includes(`${type}:`), r.stderr);
  }
  h.ok(['accept', 'T1', '--waive', 'ci', '--reason', 'owner approved', '--agent', 'owner']);
});

for (const type of ['clean', 'ci']) {
  test(`legacy ${type} ok stays readable but cannot satisfy accept`, (t) => {
    const h = setup(t, ALL.filter((g) => g !== type));
    const doc = h.readState('tasks.json');
    doc.tasks[0].evidence.push({ type, ok: true, sha: doc.tasks[0].sha, agent: 'worker', revision: 1 });
    h.writeState('tasks.json', doc);
    assert.equal(h.json(['task', 'show', 'T1']).evidence.at(-1).type, type);
    const r = h.run(['accept', 'T1']);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.stderr.includes(`${type}: no ${type} evidence`));
    assert.ok(h.ok(['task', 'show', 'T1']).split('\n')
      .find((line) => line.startsWith(`  - ${type} ok `)).includes('(does not count)'));
  });
}

test('real gate commands record their source and executed commands, including merge', (t) => {
  const h = setup(t, ALL);
  assert.match(fs.readFileSync(path.join(h.state, 'sketch.md'), 'utf8'), /all pass/);
  h.ok(['accept', 'T1', '--agent', 'reviewer']);
  h.ok(['merge', 'T1', '--agent', 'reviewer']);
  const evidence = h.readState('tasks.json').tasks[0].evidence;
  for (const type of ['tests', 'clean', 'ci', 'merge']) {
    const e = evidence.find((x) => x.type === type);
    assert.equal(e.source, type === 'merge' ? 'merge' : `check ${type}`);
    assert.ok(e.commands.length > 0, `${type} recorded no commands`);
  }
  const tests = evidence.find((e) => e.type === 'tests').commands.filter((c) => c.command === 'node test/value.test.js');
  assert.deepEqual(tests.map((c) => c.status), [0, 1]);
  assert.ok(tests.every((c) => c.cwd.startsWith(h.env.TOWER_CRANE_TMP)));
  const clean = evidence.find((e) => e.type === 'clean').commands;
  assert.ok(clean.some((c) => c.command.includes('scanner.js') && c.command.includes('--base=') && c.command.endsWith('--json')));
  const ci = evidence.find((e) => e.type === 'ci').commands;
  assert.ok(ci.some((c) => c.command === 'gh' && c.args[1].includes('/check-runs')));
  const merge = evidence.find((e) => e.type === 'merge').commands;
  assert.ok(merge.some((c) => c.command === 'gh' && c.args.includes('--match-head-commit') && c.args.includes(h.env.FIXTURE_SHA)));
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const e of evidence.filter((e) => e.source)) {
    const event = events.find((event) => event.cmd === e.source);
    assert.equal(event.task, 'T1');
    assert.equal(event.agent, e.agent);
    assert.equal(event.detail.type, e.type);
    assert.equal(event.detail.sha, e.sha);
    assert.equal(event.detail.ok, e.ok);
    assert.equal(event.detail.revision, e.revision);
    assert.equal(event.detail.source, e.source);
    assert.deepEqual(event.detail.commands, e.commands);
  }
});

test('task show prints every gate command receipt and marks only uncounted software evidence', (t) => {
  const h = setup(t, ALL);
  h.ok(['accept', 'T1', '--agent', 'reviewer']);
  h.ok(['merge', 'T1', '--agent', 'reviewer']);
  const shown = h.ok(['task', 'show', 'T1']);
  assert.doesNotMatch(shown, /does not count/);
  const doc = h.readState('tasks.json');
  for (const e of doc.tasks[0].evidence.filter((e) => e.source)) {
    for (const c of e.commands) {
      const command = [c.command, ...c.args].map((s) => JSON.stringify(s)).join(' ');
      assert.ok(shown.includes(`command: ${command}`), `${e.type}: ${command}`);
      assert.ok(shown.includes(`cwd: ${c.cwd || '-'}, status: ${c.status ?? '-'}`), `${e.type}: ${command}`);
    }
  }
  const tests = doc.tasks[0].evidence.find((e) => e.type === 'tests');
  doc.tasks[0].evidence.push({ ...tests, sha: 'fffffff' });
  doc.tasks[0].evidence.push({ ...tests, revision: 0 });
  doc.tasks[0].evidence.push({ type: 'clean', ok: true, waived: true, sha: tests.sha, agent: 'owner', revision: 1 });
  h.writeState('tasks.json', doc);
  const lines = h.ok(['task', 'show', 'T1']).split('\n');
  assert.match(lines.find((line) => line.includes('tests ok at fffffff')), /\(does not count\)/);
  assert.ok(lines.some((line) => line.includes('(revision 0, does not count)')));
  assert.doesNotMatch(lines.find((line) => line.includes('clean waived')), /does not count/);
  const merge = doc.tasks[0].evidence.find((e) => e.type === 'merge');
  doc.tasks[0].evidence.push({ ...merge, agent: 'forger' });
  h.writeState('tasks.json', doc);
  assert.match(h.ok(['task', 'show', 'T1']), /merge ok .* by forger .*\(does not count\)/);
});

test('a gate failure before running commands still overrides its earlier pass', (t) => {
  const h = setup(t, ALL);
  const fail = h.run(['check', 'tests', 'T1', '--cmd', ' ', '--agent', 'checker']);
  assert.equal(fail.code, 1);
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence.at(-1).commands, []);
  const r = h.run(['accept', 'T1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /latest tests .* failed: --cmd differs from the pinned/);
});

test('unmarked or mismatched software evidence does not override a gate failure or pass', (t) => {
  const h = setup(t, ALL);
  gateEvidence(h, 'tests', 'checker', false);
  let doc = h.readState('tasks.json');
  const failed = doc.tasks[0].evidence.at(-1);
  doc.tasks[0].evidence.push({ ...failed, ok: true, source: 'evidence' });
  doc.tasks[0].evidence.push({ ...failed, ok: true, source: 'check ci' });
  h.writeState('tasks.json', doc);
  assert.match(h.run(['accept', 'T1']).stderr, /latest tests .* failed/);
  gateEvidence(h, 'tests', 'checker');
  doc = h.readState('tasks.json');
  doc.tasks[0].evidence.push({ ...failed, source: undefined });
  h.writeState('tasks.json', doc);
  h.ok(['accept', 'T1']);
});
