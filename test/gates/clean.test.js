'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const gate = require('../../lib/gates/clean');
const { scratch, isolateGit, git, commit, initRepo, worktrees, quote } = require('./helpers');

const tmp = scratch('gates-clean');
isolateGit(tmp);
process.env.TOWER_CRANE_TMP = path.join(tmp, 'tower-crane-tmp');
fs.mkdirSync(process.env.TOWER_CRANE_TMP);
const root = path.join(tmp, 'repo');
const base = initRepo(root, { 'lib/a.js': 'module.exports = 1;\n', 'lib/c.js': 'one\ntwo\nthree\nfour\n', 'src/main.rs': 'fn main() {\n    dbg!(1);\n}\n' });
git(root, 'checkout', '-q', '-b', 'task');
// The change touches lib/a.js and line 3 of lib/c.js; src/main.rs is the base's.
const sha = commit(root, { 'lib/a.js': 'module.exports = 2;\n', 'lib/c.js': 'one\ntwo\nTHREE\nfour\n' });
git(root, 'checkout', '-q', 'main');

// Stands in for deslop: records how it was called and prints the report it is given.
const fake = path.join(tmp, 'fake-clean.js');
fs.writeFileSync(fake, `const fs = require('fs');
const { spawnSync } = require('child_process');
const [dir, ...rest] = process.argv.slice(2);
const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(process.env.FAKE_CLEAN_LOG, JSON.stringify({ dir, rest, head, tmpdir: process.env.TMPDIR, via: process.env.FAKE_CLEAN_VIA || 'env' }));
if (process.env.FAKE_CLEAN_MODE === 'crash') { console.error('cannot read the repository'); process.exit(1); }
if (process.env.FAKE_CLEAN_MODE === 'kill') process.kill(process.pid, 'SIGKILL');
if (process.env.FAKE_CLEAN_MODE === 'text') { console.log('deslop: 2 findings'); process.exit(0); }
// The deslop plugin 5.x: a "findings" list from the whole repository, exit 2 on a critical one.
if (process.env.FAKE_CLEAN_MODE === 'old') {
  console.log(JSON.stringify({ findings: [{ file: 'src/main.rs', line: 2, severity: 'critical', patternName: 'debug print' }], summary: { bySeverity: { critical: 1 } } }, null, 2));
  process.exit(Number(process.env.FAKE_CLEAN_EXIT || 2));
}
// "$DIR/" stands for the checkout, so a report can name files by absolute path.
const report = JSON.parse(fs.readFileSync(process.env.FAKE_CLEAN_REPORT, 'utf8'));
for (const it of report.items || []) if (typeof it.file === 'string' && it.file.startsWith('$DIR/')) it.file = require('path').join(dir, it.file.slice(5));
process.stdout.write(JSON.stringify(report));
`);
const logFile = path.join(tmp, 'fake-clean.log');
const reportFile = path.join(tmp, 'report.json');
const fakeCmd = `${quote(process.execPath)} ${quote(fake)}`;

// Read one by one: process.env matches names case-insensitively on Windows (Path), a copy does not.
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
function restore(...keys) {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
test.beforeEach(() => {
  for (const k of ['TOWER_CRANE_CLEAN_CMD', 'FAKE_CLEAN_MODE', 'FAKE_CLEAN_VIA', 'FAKE_CLEAN_EXIT']) delete process.env[k];
  restore('PATH', 'HOME', 'USERPROFILE');
  process.env.FAKE_CLEAN_LOG = logFile;
  process.env.FAKE_CLEAN_REPORT = reportFile;
  fs.rmSync(logFile, { force: true });
});
test.after(() => {
  restore('PATH', 'HOME', 'USERPROFILE');
  fs.rmSync(tmp, { recursive: true, force: true });
});

function report(items, extra = {}) {
  fs.writeFileSync(reportFile, JSON.stringify({ scope: 'diff', total: items.length, shown: items.length, items, errors: [], ...extra }));
}

function ctx() {
  return { root, worktree: null, task: { id: 'T2', kind: 'code', sha, status: 'submitted' }, project: { repo: 'acme/app', base: 'main', gates: { clean_cmd: fakeCmd } }, args: {}, log() {} };
}

function called() {
  return JSON.parse(fs.readFileSync(logFile, 'utf8'));
}

function item(severity, check, file, line, message) {
  return { severity, check, file, line, message };
}

function assertCleanedUp() {
  assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP), []);
  assert.equal(worktrees(root), 1);
}

test('a HIGH finding: not ok, listing the first 10 HIGH items and counts by check', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  const high = Array.from({ length: 12 }, (_, i) => item('high', i ? 'secret' : 'merge-residue', 'lib/a.js', i + 1, `finding ${i + 1}`));
  report([...high, item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b')]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, false);
  assert.equal(r.sha, sha);
  assert.match(r.summary, /high 12, review 1/);
  assert.match(r.summary, /By check: merge-residue 1, secret 11, no-caller 1/);
  assert.match(r.summary, /- lib\/a\.js:1 finding 1\n/);
  assert.match(r.summary, /- lib\/a\.js:10 finding 10\n- and 2 more/);
  assert.doesNotMatch(r.summary, /finding 11/);
  // The tool ran on a checkout of the submitted commit, against the merge base, asking for JSON.
  const c = called();
  assert.equal(c.head, sha);
  assert.deepEqual(c.rest, [`--base=${base}`, '--json']);
  assert.ok(c.dir.startsWith(process.env.TOWER_CRANE_TMP));
  // Its scratch goes under the gate's temp root too, not the system temp directory.
  assert.ok(c.tmpdir.startsWith(process.env.TOWER_CRANE_TMP + path.sep), c.tmpdir);
  assertCleanedUp();
});

test('only review and verify findings: ok', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  report([item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b'), item('verify', 'stale-mention', 'README.md', 3, 'mentions a')]);
  const r = await gate.run(ctx());
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /review 1, verify 1/);
  assertCleanedUp();
});

test('a scan with checks that did not run: not ok, naming them', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  const cases = [
    [{ errors: ['secrets: could not read tracked files'] }, /secrets: could not read tracked files/],
    [{ detectorErrors: [{ check: 'refs', error: 'git grep failed' }] }, /git grep failed/],
    [{ failedChecks: ['unwired'] }, /unwired/],
  ];
  for (const [extra, named] of cases) {
    report([], extra);
    const r = await gate.run(ctx());
    assert.equal(r.ok, false, JSON.stringify(extra));
    assert.equal(r.infrastructure_failure, true, 'a scan that did not complete is retried once, not reworked');
    assert.match(r.summary, /The scan is incomplete/);
    assert.match(r.summary, named);
  }
  report([item('review', 'no-caller', 'lib/b.js', 7, 'nothing calls b')], { errors: [], detectorErrors: [], failedChecks: [] });
  assert.equal((await gate.run(ctx())).ok, true);
  assertCleanedUp();
});

test('an installed cleanup tool is not inferred when the owner has not pinned it', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  const context = ctx();
  delete context.project.gates;
  const r = await gate.run(context);
  assert.equal(r.ok, false);
  assert.match(r.summary, /pinned/);
  assert.equal(fs.existsSync(logFile), false);
});

test('a tool killed by a signal: not ok, recorded as a runner crash rather than a finding', { skip: process.platform === 'win32' }, async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  process.env.FAKE_CLEAN_MODE = 'kill';
  const killed = await gate.run(ctx());
  assert.equal(killed.ok, false);
  assert.equal(killed.runner_crash, true);
  assert.equal(killed.confirmed_failure, undefined);
  assertCleanedUp();
});

test('a tool that fails or prints no JSON: not ok', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  process.env.FAKE_CLEAN_MODE = 'crash';
  const crashed = await gate.run(ctx());
  assert.equal(crashed.ok, false);
  assert.match(crashed.summary, /exit 1: cannot read the repository/);
  process.env.FAKE_CLEAN_MODE = 'text';
  const text = await gate.run(ctx());
  assert.equal(text.ok, false);
  assert.match(text.summary, /did not print JSON/);
  assertCleanedUp();
});

test('a tool that scans the whole repository: only findings on the lines the change touches are judged', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  // Debug prints the base already had, and one on a line of a changed file the change left alone.
  const outside = [item('high', 'debug-print', 'src/main.rs', 2, 'Debug print macros in production code'), item('high', 'debug-print', 'lib/c.js', 1, 'untouched line'),
    item('high', 'debug-print', '$DIR/src/main.rs', 2, 'by absolute path')];
  report(outside, { scope: undefined });
  const clean = await gate.run(ctx());
  assert.equal(clean.ok, true, clean.summary);
  assert.match(clean.summary, /no findings in the change/);
  assert.match(clean.summary, /Out of scope, not judged \(3, outside the files and lines \w+\.\.\w+ changes\): src\/main\.rs:2 \(high\), lib\/c\.js:1 \(high\)/);
  assert.match(clean.summary, /every finding is outside the change/);
  assert.match(clean.summary, /deslop 2\.0 or newer, the diff-scoped rewrite/);
  assert.doesNotMatch(clean.summary, /HIGH/);

  // Findings on the changed line, by relative or absolute path, or naming the changed file as a whole, are judged.
  report([...outside, item('high', 'debug-print', 'lib/c.js', 3, 'changed line'), item('high', 'debug-print', '$DIR/lib/c.js', 3, 'changed line by absolute path'),
    item('review', 'no-caller', 'lib/a.js', 0, 'nothing calls a')], { scope: 'repo' });
  const dirty = await gate.run(ctx());
  assert.equal(dirty.ok, false);
  assert.equal(dirty.confirmed_failure, true);
  assert.match(dirty.summary, /high 2, review 1 in the change/);
  assert.match(dirty.summary, /HIGH \(2\):\n- lib\/c\.js:3 changed line\n- lib\/c\.js:3 changed line by absolute path\n/);
  assert.match(dirty.summary, /3 of 6 findings are outside the change/);
  assert.doesNotMatch(dirty.summary, /- src\/main\.rs/);

  // A tool that declares diff scope tied each finding to the change itself (a stale mention in an untouched file), so none is dropped.
  report(outside);
  const scoped = await gate.run(ctx());
  assert.equal(scoped.ok, false);
  assert.match(scoped.summary, /HIGH \(3\):\n- src\/main\.rs:2 Debug print/);
  assert.doesNotMatch(scoped.summary, /Out of scope|no diff scope/);
  assertCleanedUp();
});

test('the deslop plugin 5.x output: not ok whatever its exit status, naming the diff-scoped deslop', async () => {
  process.env.TOWER_CRANE_CLEAN_CMD = fakeCmd;
  process.env.FAKE_CLEAN_MODE = 'old';
  const failed = await gate.run(ctx());
  assert.equal(failed.ok, false);
  assert.match(failed.summary, /failed: exit 2/);
  assert.match(failed.summary, /deslop plugin 5\.x's, which ignores --base/);
  assert.match(failed.summary, /deslop 2\.0 or newer, the diff-scoped rewrite/);
  assert.deepEqual(failed.config_failure, { key: 'clean_cmd' });
  process.env.FAKE_CLEAN_EXIT = '0';
  const passed = await gate.run(ctx());
  assert.equal(passed.ok, false);
  assert.match(passed.summary, /"findings" list, the deslop plugin 5\.x's output, which ignores --base/);
  assert.match(passed.summary, /deslop 2\.0 or newer/);
  assert.deepEqual(passed.config_failure, { key: 'clean_cmd' });
  assertCleanedUp();
});
