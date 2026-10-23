'use strict';

// Local CI across a base move: the project's ci.overlap hook keeps a passing receipt for the
// new base, narrows it to the shared steps, or leaves everything to rerun, at check ci and merge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Local = require('../lib/ci-local');
const { mergeFixture } = require('./local-ci-helpers');

const steps = (pr, main, shared, verdict) => ({ pr_steps: pr, main_steps: main, shared, verdict });

test('the ci.overlap output contract accepts keep and shared steps, and names what it refuses', () => {
  for (const [name, value, want] of [
    ['keep', steps(['docs'], ['lint'], [], 'keep'), { shared: [], verdict: 'keep' }],
    ['shared steps', steps(['lint', 'unit'], ['unit', 'docs'], ['unit', 'unit'], 'rerun'), { shared: ['unit'], verdict: 'rerun' }],
    ['not an object', [], /not a JSON object/],
    ['missing list', { pr_steps: [], shared: [], verdict: 'keep' }, /main_steps is not a list of step names/],
    ['option-like step', steps(['--all'], [], [], 'keep'), /pr_steps is not a list of step names/],
    ['empty step', steps([''], [], [], 'keep'), /pr_steps is not a list/],
    ['unknown verdict', steps([], [], [], 'maybe'), /neither keep nor rerun/],
    ['unknown step', steps(['unit'], ['lint'], ['unit'], 'rerun'), /shared step unit is not in both pr_steps and main_steps/],
    ['keep with shared', steps(['unit'], ['unit'], ['unit'], 'keep'), /verdict keep names shared steps/],
    ['rerun without shared', steps(['unit'], ['lint'], [], 'rerun'), /verdict rerun names no shared steps/],
  ]) {
    const got = Local.overlapResult(value);
    if (want instanceof RegExp) assert.match(got.error || '', want, name);
    else assert.deepEqual({ shared: got.shared, verdict: got.verdict }, want, name);
  }
  assert.match(Local.parseOverlap('{"verdict": ').error, /not JSON/);
});

// A checker that logs each run's argv and checkout, and a hook that logs its argv and answers
// from OVERLAP_OUT, OVERLAP_EXIT or OVERLAP_SLEEP.
function overlapFixture(t, { hook = true } = {}) {
  const h = mergeFixture(t);
  h.runs = path.join(h.base, 'runs.jsonl');
  h.asked = path.join(h.base, 'asked.jsonl');
  const checker = path.join(h.base, 'checker.js');
  fs.writeFileSync(checker, `
const fs = require('node:fs');
const head = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD^1'], { encoding: 'utf8' }).trim();
fs.appendFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), base: head }) + '\\n');
`);
  const overlap = path.join(h.base, 'overlap.js');
  fs.writeFileSync(overlap, `
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');
if (process.env.OVERLAP_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.OVERLAP_SLEEP)); // wait-allow: a hook that outlives its timeout
if (process.env.OVERLAP_EXIT) { process.stderr.write('overlap broke\\n'); process.exit(Number(process.env.OVERLAP_EXIT)); }
process.stdout.write(process.env.OVERLAP_OUT || '');
`);
  h.ok(['project', 'set', '--ci-local', JSON.stringify({ command: [process.execPath, checker, h.runs], timeout: 5,
    rerun_cmd: [process.execPath, checker, h.runs, '--only', '{steps}'] })]);
  if (hook) h.ok(['project', 'set', '--ci-overlap', JSON.stringify({ command: [process.execPath, overlap, h.asked], timeout: 1 })]);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['accept', 'T1']);
  fs.writeFileSync(path.join(h.repo, 'later.txt'), 'later\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'an unrelated change lands on main']);
  h.newBase = h.git(['rev-parse', 'main']);
  h.read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []); // read-published: the checker and the hook append lines; nothing replaces the file
  h.ci = () => h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'ci');
  return h;
}

test('merge keeps a receipt the ci.overlap hook finds no shared steps for, with no local CI run', (t) => {
  const h = overlapFixture(t);
  const before = h.read(h.runs).length;
  const out = JSON.stringify(steps(['docs'], ['later'], [], 'keep'));
  const merged = h.json(['merge', 'T1'], { env: { OVERLAP_OUT: out } });
  assert.equal(merged.ok, true, merged.summary);
  assert.equal(h.read(h.runs).length, before, 'no local CI command ran');
  assert.deepEqual(h.read(h.asked), [[h.baseSha, h.newBase, h.sha]]);
  const kept = h.ci().at(-1);
  assert.equal(kept.ok, true);
  assert.match(kept.summary, new RegExp(`receipt on base ${h.baseSha.slice(0, 10)} kept for base ${h.newBase.slice(0, 10)}`));
  assert.equal(kept.receipt.base_sha, h.newBase);
  assert.equal(kept.receipt.narrows.base_sha, h.baseSha);
  assert.deepEqual(kept.receipt.steps, []);
  assert.deepEqual({ ...kept.receipt.overlap, command: kept.receipt.overlap.command.slice(-3) }, {
    base_sha: h.baseSha, command: [h.baseSha, h.newBase, h.sha], exit: 0, ...steps(['docs'], ['later'], [], 'keep'),
  });
  assert.ok(kept.commands.some((c) => c.args.at(-1) === h.sha && c.status === 0), 'the hook run is audited');
  assert.ok(fs.existsSync(h.merged), 'gh merged the PR');
});

test('a kept receipt loses its proof when its hook run or the receipt it narrows is edited', (t) => {
  const h = overlapFixture(t);
  h.ok(['check', 'ci', 'T1'], { env: { OVERLAP_OUT: JSON.stringify(steps([], [], [], 'keep')) } });
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  for (const [edit, reason] of [
    [(r) => { r.overlap.verdict = 'rerun'; }, /steps do not match its ci.overlap verdict/],
    [(r) => { r.overlap.command[r.overlap.command.length - 3] = h.newBase; }, /no matching ci.overlap run|does not narrow/],
    [(r) => { r.narrows.exit = 1; }, /narrows a receipt that does not hold/],
    [(r) => { r.steps = ['later']; }, /steps do not match/],
  ]) {
    const tasks = h.readState('tasks.json');
    const e = tasks.tasks[0].evidence.findLast((x) => x.type === 'ci');
    const saved = structuredClone(e.receipt);
    edit(e.receipt);
    const r = Local.mismatch(e.receipt, e.receipt, Local.resolve(h.json(['project', 'show']).ci.local, tasks.tasks[0], h.json(['project', 'show']).ci.overlap), e.commands);
    assert.match(r || '', reason);
    e.receipt = saved;
  }
});

test('shared steps rerun alone on the new merged tree, and merge leaves that run to check ci', (t) => {
  const h = overlapFixture(t);
  const env = { OVERLAP_OUT: JSON.stringify(steps(['lint', 'later'], ['later'], ['later'], 'rerun')) };
  const before = h.read(h.runs).length;
  const refused = h.run(['merge', 'T1'], { env });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /local CI receipt base moved: .*check ci reruns the shared steps later; run tower-crane check ci T1/);
  assert.equal(h.read(h.runs).length, before, 'merge runs no local CI');
  assert.equal(h.ci().length, 1, 'a declined overlap records nothing');
  const e = h.json(['check', 'ci', 'T1'], { env });
  assert.equal(e.ok, true, e.summary);
  assert.deepEqual(h.read(h.runs).slice(before), [{ args: ['--only', 'later'], base: h.newBase }]);
  assert.deepEqual(e.receipt.steps, ['later']);
  assert.equal(e.receipt.base_sha, h.newBase);
  assert.equal(e.receipt.narrows.base_sha, h.baseSha);
  assert.deepEqual(e.receipt.overlap.shared, ['later']);
  assert.match(e.summary, /ci.overlap named shared steps later; ran only those/);
  assert.equal(h.json(['task', 'show', 'T1']).gates.ok, true);
  const merged = h.json(['merge', 'T1'], { env });
  assert.equal(merged.ok, true, merged.summary);
});

for (const [name, opts, env, reason] of [
  ['no hook', { hook: false }, {}, /no ci.overlap hook is set/],
  ['a failing hook', {}, { OVERLAP_EXIT: '3' }, /ci.overlap exit 3: overlap broke/],
  ['a timed out hook', {}, { OVERLAP_SLEEP: '4000' }, /ci.overlap timed out after 1 s/],
  ['bad JSON', {}, { OVERLAP_OUT: 'shared: none' }, /ci.overlap its output is not JSON: shared: none/],
  ['an unknown step', {}, { OVERLAP_OUT: JSON.stringify(steps(['unit'], ['docs'], ['unit'], 'rerun')) }, /shared step unit is not in both/],
]) {
  test(`${name} reruns everything after a base move and records why`, (t) => {
    const h = overlapFixture(t, opts);
    const before = h.read(h.runs).length;
    const refused = h.run(['merge', 'T1'], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /local CI receipt base moved/);
    if (opts.hook !== false) assert.match(refused.stderr, reason);
    const e = h.json(['check', 'ci', 'T1'], { env });
    assert.equal(e.ok, true, e.summary);
    assert.deepEqual(h.read(h.runs).slice(before), [{ args: [], base: h.newBase }], 'the whole command ran on the new base');
    assert.equal(e.receipt.steps, undefined);
    assert.equal(e.receipt.narrows, undefined);
    assert.equal(e.receipt.overlap.base_sha, h.baseSha);
    assert.match(e.receipt.overlap.reason, reason);
    assert.match(e.summary, /reran everything/);
  });
}
