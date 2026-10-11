'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');

test('task add stores the task with defaults and refuses bad input', (t) => {
  const h = makeRepo(t);
  h.init();
  assert.equal(h.ok(['task', 'add', '--title', 'Schema', '--acceptance', 'table exists', '--acceptance', 'migration runs']), 'T1');
  const t1 = h.readState('tasks.json').tasks[0];
  assert.deepEqual(
    { kind: t1.kind, size: t1.size, tier: t1.tier, status: t1.status, revision: t1.revision, acceptance: t1.acceptance },
    { kind: 'code', size: 'M', tier: 'medium', status: 'todo', revision: 1, acceptance: ['table exists', 'migration runs'] },
  );

  const noAcc = h.run(['task', 'add', '--title', 'x']);
  assert.equal(noAcc.code, 2);
  assert.match(noAcc.stderr, /--acceptance/);

  const unknownDep = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--dep', 'T9']);
  assert.equal(unknownDep.code, 1);
  assert.match(unknownDep.stderr, /T9, which does not exist/);

  const badSize = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--size', 'XL']);
  assert.equal(badSize.code, 2);
  const badTier = h.run(['task', 'add', '--title', 'x', '--acceptance', 'a', '--tier', 'ghost']);
  assert.equal(badTier.code, 2);
  assert.match(badTier.stderr, /--tier must be one of easy, medium, hard, research/);
  assert.equal(h.readState('tasks.json').tasks.length, 1, 'refused adds wrote nothing');
});

test('task update refuses a dependency cycle and bumps revision on acceptance or dependency changes', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'C', '--acceptance', 'c', '--dep', 'T2']);
  const cyc = h.run(['task', 'update', 'T1', '--dep', 'T3']);
  assert.equal(cyc.code, 1);
  assert.match(cyc.stderr, /cycle \(T1 -> T3 -> T2 -> T1/);
  assert.deepEqual(h.readState('tasks.json').tasks[0].depends_on, []);

  h.ok(['task', 'update', 'T2', '--title', 'B renamed']);
  assert.equal(h.readState('tasks.json').tasks[1].revision, 1, 'a title change keeps the revision');
  h.ok(['task', 'update', 'T2', '--acceptance', 'b2']);
  assert.equal(h.readState('tasks.json').tasks[1].revision, 2);
  h.ok(['task', 'update', 'T2', '--dep', '']);
  const t2 = h.readState('tasks.json').tasks[1];
  assert.equal(t2.revision, 3);
  assert.deepEqual(t2.depends_on, []);
  h.ok(['task', 'update', 'T3', '--status', 'cancelled']);
  assert.equal(h.readState('tasks.json').tasks[2].status, 'cancelled');
  assert.equal(h.run(['task', 'update', 'T3', '--status', 'accepted']).code, 2);
});

test('plan import resolves local names in order and is all or nothing', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'existing', '--acceptance', 'x']);
  const plan = path.join(h.base, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify([
    { id: 'schema', title: 'Schema', acceptance: 'table exists', size: 'S' },
    { id: 'api', title: 'API', acceptance: ['endpoint works'], depends_on: ['schema', 'T1'] },
    { title: 'Docs', acceptance: ['readme'], kind: 'docs', depends_on: ['api'], needs_owner: '  approve wording  ' },
    { id: 'blank', title: 'Blank owner request', acceptance: 'scheduled', needs_owner: ' \t ' },
  ]));
  const out = h.json(['plan', 'import', plan]);
  assert.deepEqual(out.added.map((a) => [a.id, a.local]), [['T2', 'schema'], ['T3', 'api'], ['T4', null], ['T5', 'blank']]);
  const tasks = h.readState('tasks.json').tasks;
  assert.deepEqual(tasks[2].depends_on, ['T2', 'T1']);
  assert.deepEqual(tasks[3].depends_on, ['T3']);
  assert.equal(tasks[3].needs_owner, 'approve wording');
  h.ok(['task', 'update', 'T4', '--needs-owner', ' approve wording ', '--agent', 'reviewer']);
  assert.equal(h.readState('tasks.json').tasks[3].needs_owner, 'approve wording');
  assert.equal(tasks[4].needs_owner, null);
  assert.equal(tasks[1].size, 'S');

  const before = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
  const cases = [
    [[{ id: 'a', title: 'A', acceptance: 'x' }, { title: 'B', acceptance: 'y', depends_on: ['later'] }, { id: 'later', title: 'L', acceptance: 'z' }], /unknown dependency later/],
    [[{ title: 'A', acceptance: 'x' }, { title: 'no acceptance' }], /plan entry 2 has no acceptance/],
    [[{ title: 'A', acceptance: 'x', deps: ['T1'] }], /unknown field deps/],
    [[{ title: 'A', acceptance: 'x', size: 'XL' }], /size must be one of S, M, L/],
  ];
  for (const [entries, msg] of cases) {
    fs.writeFileSync(plan, JSON.stringify(entries));
    const r = h.run(['plan', 'import', plan]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, msg);
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), before, 'a refused import adds nothing');
  }
});

test('validate reports cycles, unknown dependencies, missing acceptance, unsplit L tasks and oversize budgets', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'add', '--title', 'B', '--acceptance', 'b', '--dep', 'T1']);
  h.ok(['task', 'add', '--title', 'C', '--acceptance', 'c']);
  h.ok(['task', 'add', '--title', 'D', '--acceptance', 'd', '--size', 'L']);
  const clean = h.run(['validate']);
  assert.equal(clean.code, 1, 'the L task is reported');
  assert.match(clean.stdout, /T4 is size L/);
  h.ok(['task', 'note', 'T4', 'split: one migration, cannot land in parts']);
  assert.equal(h.run(['validate']).code, 0);

  // Files edited by hand can hold what the CLI refuses to write.
  const doc = h.readState('tasks.json');
  doc.tasks[0].depends_on = ['T2'];
  doc.tasks[2].depends_on = ['T9'];
  doc.tasks[2].acceptance = [];
  h.writeState('tasks.json', doc);
  const r = h.run(['validate', '--json']);
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  const kinds = report.issues.map((i) => `${i.kind}:${i.task}`).sort();
  assert.deepEqual(kinds, ['cycle:T1', 'no-acceptance:T3', 'unknown-dependency:T3']);
  assert.match(report.issues.find((i) => i.kind === 'cycle').message, /T1 -> T2 -> T1/);

  h.writeState('tasks.json', { ...doc, tasks: doc.tasks.map((x) => ({ ...x, depends_on: [], acceptance: ['ok'] })) });
  h.ok(['project', 'set', '--budget-hours', '10']);
  const overRun = h.run(['validate', '--json']);
  assert.equal(overRun.code, 1);
  const over = JSON.parse(overRun.stdout);
  assert.equal(over.ok, false);
  assert.deepEqual(over.issues.map((i) => i.kind), ['budget']);
  assert.match(over.issues[0].message, /about 20 h .* budget of 10 h/);
});

test('notes and briefs round-trip', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'A', '--acceptance', 'a']);
  h.ok(['task', 'note', 'T1', 'found', 'the', 'flaky', 'test'], { env: { TOWER_CRANE_AGENT: 'w-1' } });
  const note = h.readState('tasks.json').tasks[0].notes[0];
  assert.equal(note.text, 'found the flaky test');
  assert.equal(note.agent, 'w-1');

  const missing = h.run(['brief', 'get', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /brief set T1/);
  h.ok(['brief', 'set', 'T1', '-'], { input: '# Context\n\nUse the retry table.\n' });
  assert.equal(h.ok(['brief', 'get', 'T1']), '# Context\n\nUse the retry table.');
  const file = path.join(h.base, 'brief.md');
  fs.writeFileSync(file, 'from a file\n');
  h.ok(['brief', 'set', 't1', '--file', file]);
  assert.equal(fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8'), 'from a file\n');
  assert.equal(h.run(['brief', 'set', 'T1']).code, 2);
});

test('brief get selects the caller role and ignores headings inside fenced code', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Role brief', '--acceptance', 'sections stay private']);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: [
      'SHARED_PREAMBLE_SENTINEL',
      '```md',
      '## Reviewer',
      'FENCED_REVIEWER_SENTINEL',
      '## Worker',
      'FENCED_WORKER_SENTINEL',
      '```',
      '## Shared',
      'SHARED_SECTION_SENTINEL',
      '## wOrKeR',
      'WORKER_SECTION_SENTINEL',
      '## rEvIeWeR',
      'REVIEWER_SECTION_SENTINEL',
      '## Rework notes',
      'REWORK_SHARED_SENTINEL',
    ].join('\n'),
  });

  const get = (agent, args = []) => h.run(['brief', 'get', 'T1', ...args], { env: { TOWER_CRANE_AGENT: agent } });
  const worker = get('worker-T1-1');
  assert.equal(worker.code, 0, worker.stderr);
  assert.match(worker.stdout, /SHARED_PREAMBLE_SENTINEL/);
  assert.match(worker.stdout, /SHARED_SECTION_SENTINEL/);
  assert.match(worker.stdout, /FENCED_REVIEWER_SENTINEL/);
  assert.match(worker.stdout, /FENCED_WORKER_SENTINEL/);
  assert.match(worker.stdout, /WORKER_SECTION_SENTINEL/);
  assert.match(worker.stdout, /REWORK_SHARED_SENTINEL/);
  assert.ok(!worker.stdout.includes('REVIEWER_SECTION_SENTINEL'));

  const reviewer = get('reviewer-T1-1');
  assert.equal(reviewer.code, 0, reviewer.stderr);
  assert.match(reviewer.stdout, /SHARED_PREAMBLE_SENTINEL/);
  assert.match(reviewer.stdout, /SHARED_SECTION_SENTINEL/);
  assert.match(reviewer.stdout, /FENCED_REVIEWER_SENTINEL/);
  assert.match(reviewer.stdout, /FENCED_WORKER_SENTINEL/);
  assert.match(reviewer.stdout, /REVIEWER_SECTION_SENTINEL/);
  assert.match(reviewer.stdout, /REWORK_SHARED_SENTINEL/);
  assert.ok(!reviewer.stdout.includes('WORKER_SECTION_SENTINEL'));

  const owner = get('owner');
  const orchestrator = get('orchestrator-T1-1');
  assert.match(owner.stdout, /WORKER_SECTION_SENTINEL/);
  assert.match(owner.stdout, /REVIEWER_SECTION_SENTINEL/);
  assert.match(orchestrator.stdout, /WORKER_SECTION_SENTINEL/);
  assert.match(orchestrator.stdout, /REVIEWER_SECTION_SENTINEL/);

  const explicit = get('owner', ['--role', 'reviewer']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.match(explicit.stdout, /REVIEWER_SECTION_SENTINEL/);
  assert.ok(!explicit.stdout.includes('WORKER_SECTION_SENTINEL'));
});

test('brief get keeps an unsectioned brief shared with workers and reviewers', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Shared brief', '--acceptance', 'plain briefs remain shared']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'PLAIN_SHARED_BRIEF\n' });
  assert.equal(h.ok(['brief', 'get', 'T1'], { env: { TOWER_CRANE_AGENT: 'worker-T1-1' } }), 'PLAIN_SHARED_BRIEF');
  assert.equal(h.ok(['brief', 'get', 'T1'], { env: { TOWER_CRANE_AGENT: 'reviewer-T1-1' } }), 'PLAIN_SHARED_BRIEF');
});

test('brief set warns when a reviewer section has no worker section', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Role brief', '--acceptance', 'warn on incomplete roles']);

  const fenced = h.run(['brief', 'set', 'T1', '-'], {
    input: ['```md', '## Reviewer', 'FENCED_ONLY_SENTINEL', '```'].join('\n'),
  });
  assert.equal(fenced.code, 0, fenced.stderr);
  assert.equal(fenced.stderr, '');

  const missingWorker = h.run(['brief', 'set', 'T1', '-'], {
    input: ['~~~md', '## Worker', 'FENCED_WORKER_SENTINEL', '~~~', '## rEvIeWeR', 'REVIEWER_SECTION_SENTINEL'].join('\n'),
  });
  assert.equal(missingWorker.code, 0, missingWorker.stderr);
  assert.match(missingWorker.stderr, /Reviewer section.*without a .*Worker section/i);
});

test('task add --brief writes the brief in the same command and refuses an unreadable file before adding', (t) => {
  const h = makeRepo(t);
  h.init();
  const file = path.join(h.base, 'brief.md');
  fs.writeFileSync(file, '# Context\n\nFrom the add.\n');
  assert.equal(h.ok(['task', 'add', '--title', 'Briefed', '--acceptance', 'brief lands', '--brief', file]), 'T1');
  assert.equal(fs.readFileSync(path.join(h.state, 'briefs', 'T1.md'), 'utf8'), '# Context\n\nFrom the add.\n');
  assert.equal(h.ok(['brief', 'get', 'T1']), '# Context\n\nFrom the add.');

  const missing = h.run(['task', 'add', '--title', 'Lost', '--acceptance', 'never added', '--brief', path.join(h.base, 'absent.md')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read/);
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  assert.equal(fs.existsSync(path.join(h.state, 'briefs', 'T2.md')), false);
});
