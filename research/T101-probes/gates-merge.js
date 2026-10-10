'use strict';
// Gate evidence binding across shas, revisions and rework; the merge gate's
// checks on a PR's base and the stack merge's head race. GitHub is a fake exec.
const fs = require('node:fs');
const path = require('node:path');
const { H, ROOT, rec, save, out, plain } = require('./lib');
const { result, fakeExec } = require(path.join(ROOT, 'test', 'gates', 'helpers'));
const merge = require(path.join(ROOT, 'lib', 'gates', 'merge'));

async function evidenceProbes() {
  const h = H.makeRepo();
  try {
    h.init();
    for (const t of ['A', 'B', 'C']) h.ok(['task', 'add', '--title', t, '--acceptance', 'x', '--kind', 'docs']);
    const first = h.git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(h.repo, 'f.txt'), 'two\n');
    h.git(['add', 'f.txt']);
    h.git(['commit', '-q', '-m', 'two']);
    const second = h.git(['rev-parse', 'HEAD']);
    const env = plain(h.env);
    const gates = (id) => h.ok(['task', 'show', id]).split('\n').find((l) => l.startsWith('gates:')) || '';
    const submitAs = (id, sha, who) => h.ok(['submit', id, '--sha', sha, '--agent', who]);

    h.ok(['claim', 'T1', '--agent', 'w1']);
    submitAs('T1', first, 'w1');
    h.ok(['evidence', 'T1', '--type', 'review', '--ok', '--sha', first, '--agent', 'r1'], { env });
    submitAs('T1', second, 'w1');
    let g = gates('T1');
    rec('G1', 'gates', `review ok at ${first.slice(0, 7)} by r1, then the worker resubmits T1 at ${second.slice(0, 7)}; task show T1`,
      'review missing at the new head', g, /review ok/.test(g) ? 'CONFIRMED' : 'held');
    submitAs('T1', first, 'w1');
    g = gates('T1');
    rec('G2', 'gates', `the worker resubmits T1 back at ${first.slice(0, 7)} (the reviewed head); task show T1`,
      'review counts again: it was made at this sha and revision (expected binding)', g, /review ok/.test(g) ? 'held' : 'CONFIRMED');

    h.ok(['rework', 'T1', '--reason', 'the reviewer missed a broken link', '--agent', 'orchestrator'], { env });
    h.ok(['claim', 'T1', '--agent', 'w1']);
    submitAs('T1', first, 'w1');
    g = gates('T1');
    let r = h.run(['accept', 'T1', '--agent', 'orchestrator'], { env });
    rec('G3', 'gates', `rework T1 --reason "...", then the worker claims and resubmits the same sha ${first.slice(0, 7)} with no change; accept T1`,
      'refused: the review that rework rejected should not carry over', `${g}; ${out(r)}`, r.code === 0 ? 'CONFIRMED' : 'held');

    h.ok(['claim', 'T2', '--agent', 'w2']);
    submitAs('T2', first, 'w2');
    h.ok(['evidence', 'T2', '--type', 'review', '--ok', '--sha', first, '--agent', 'r2'], { env });
    h.ok(['brief', 'set', 'T2', '-'], { input: '- new requirement: also cover the CLI docs\n' });
    g = gates('T2');
    rec('G4', 'gates', 'review ok on T2, then brief set T2 with a new requirement; task show T2',
      'the brief is part of what was reviewed; a changed brief needs a new review', g, /review ok/.test(g) ? 'CONFIRMED' : 'held');
    h.ok(['task', 'update', 'T2', '--acceptance', 'x', '--acceptance', 'y'], { env: { ...env, TOWER_CRANE_AGENT: 'orchestrator' } });
    g = gates('T2');
    rec('G5', 'gates', 'task update T2 --acceptance x --acceptance y (acceptance change); task show T2', 'review no longer counts (revision bump)', g,
      /review ok/.test(g) ? 'CONFIRMED' : 'held');

    // G6: a tests entry written into tasks.json by hand, with no audit event.
    h.ok(['task', 'update', 'T3', '--kind', 'code'], { env: { ...env, TOWER_CRANE_AGENT: 'orchestrator' } });
    h.ok(['claim', 'T3', '--agent', 'w3']);
    submitAs('T3', first, 'w3');
    const tasks = h.readState('tasks.json');
    const t3 = tasks.tasks.find((t) => t.id === 'T3');
    for (const type of ['tests', 'clean']) t3.evidence.push({ type, ok: true, sha: first, agent: 'orchestrator', at: new Date().toISOString(), summary: 'forged', ref: null, revision: t3.revision, source: `check ${type}`, commands: [{ argv: ['true'] }] });
    h.writeState('tasks.json', tasks);
    g = gates('T3');
    rec('G6', 'gates', 'append tests and clean evidence to tasks.json by hand (no check event in events.jsonl); task show T3',
      'not counted: no audit receipt', g, /tests ok|clean ok/.test(g) ? 'CONFIRMED' : 'held');
  } finally {
    fs.rmSync(h.base, { recursive: true, force: true });
  }
}

const SHA = 'c'.repeat(40);
const MOVED = 'd'.repeat(40);
const task = (o = {}) => ({ id: 'T4', title: 'Change', acceptance: ['works'], kind: 'code', sha: SHA, pr: 42, status: 'accepted', revision: 1, ...o });

async function mergeProbes() {
  // M1: the PR was retargeted to another base after the gates ran.
  let pr = { state: 'OPEN', headRefOid: SHA, baseRefName: 'release', mergeCommit: null, isCrossRepository: false };
  let gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') return result(JSON.stringify(pr));
    if (args[0] === 'pr' && args[1] === 'merge') { Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } }); return result(''); }
    return null;
  });
  let r = await merge.run({ root: '/repo', task: task(), project: { repo: 'acme/app', base: 'main' }, args: {}, exec: gh.exec, log() {} });
  rec('M1', 'merge', 'merge gate on accepted T4 whose PR #42 base is "release" while project.base is "main" (fake gh)',
    'refused: the gates ran against main', `ok=${r.ok}; ${r.summary}; gh calls: ${gh.calls.map((c) => c.slice(1, 3).join(' ')).join(', ')}`, r.ok ? 'CONFIRMED' : 'held');

  // M2: cross-repository PR on the plain path.
  pr = { state: 'OPEN', headRefOid: SHA, baseRefName: 'main', mergeCommit: null, isCrossRepository: true };
  r = await merge.run({ root: '/repo', task: task(), project: { repo: 'acme/app', base: 'main' }, args: {}, exec: gh.exec, log() {} });
  rec('M2', 'merge', 'merge gate on T4 whose PR #42 is from a fork (isCrossRepository true)', 'refused like the stack path, or the same-repo assumption documented',
    `ok=${r.ok}; ${r.summary}`, r.ok ? 'CONFIRMED' : 'held');

  // M3: head moved before the plain merge: guarded by --match-head-commit.
  pr = { state: 'OPEN', headRefOid: MOVED, baseRefName: 'main', mergeCommit: null };
  r = await merge.run({ root: '/repo', task: task(), project: { repo: 'acme/app', base: 'main' }, args: {}, exec: gh.exec, log() {} });
  rec('M3', 'merge', 'merge gate on T4 whose PR head moved to an unaccepted commit', 'refused', `ok=${r.ok}; ${r.summary}`, r.ok ? 'CONFIRMED' : 'held');

  // M4: stack merge, the head moves after the last view and before gh stack merge.
  const views = { n: 0 };
  const lower = { state: 'OPEN', headRefOid: SHA, baseRefName: 'main', mergeCommit: null, isCrossRepository: false, autoMergeRequest: null };
  let landed = null;
  gh = fakeExec((args) => {
    if (args[0] === 'pr' && args[1] === 'view') { views.n++; return result(JSON.stringify(lower)); }
    if (args[0] === 'api') return result(JSON.stringify({ pull_requests: [{ number: 42 }] }));
    if (args[0] === 'stack' && args[1] === 'merge') {
      lower.headRefOid = MOVED; // the worker pushed between the check and the merge
      landed = lower.headRefOid;
      Object.assign(lower, { state: 'MERGED', mergeCommit: { oid: 'e'.repeat(40) } });
      return result('');
    }
    return null;
  });
  const t = task({ stack: { linked: true, repo: 'acme/app', base: 'main' } });
  r = await merge.run({ root: '/repo', task: t, project: { repo: 'acme/app', base: 'main' }, args: {}, exec: gh.exec, log() {},
    isStacked: true, stackTasks: [t], stackReports: { T4: { ok: true } } });
  rec('M4', 'stack/merge', 'stack merge of T4: the PR head moves after the last pr view and before gh stack merge --squash (fake gh)',
    'nothing unaccepted lands', `ok=${r.ok}; landed head ${landed ? landed.slice(0, 7) : 'none'}; ${r.summary}`, landed === MOVED ? 'CONFIRMED' : 'held');
}

(async () => {
  try {
    await evidenceProbes();
    await mergeProbes();
  } finally {
    save('gates-merge');
  }
})();
