'use strict';
// Fixtures for the gate tests: scratch directories, git repositories isolated from the user's
// git config, and a fake gh for the gates that talk to GitHub.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempRoot } = require('../tmp-root');
const { FOREGROUND_MAINTENANCE } = require('../repo-seed');
// Fails a gate test that resolves the user's real ladder file, also when run without test/run.js.
require('../fixtures/user-config-guard');

// A scratch directory under the test temp root, removed by the caller.
function scratch(prefix) {
  const base = tempRoot();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

// Keeps the user's global config (signing, hooks, default branch) out of the fixtures.
function isolateGit(dir) {
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, FOREGROUND_MAINTENANCE);
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'tower-crane test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'tower-crane test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  });
}

// Gates call lib/ladder.js in the test process, which would read the user's
// real ladder file; this names one in the fixture, absent unless a test writes it.
function isolateUserFile(dir) {
  process.env.TOWER_CRANE_CONFIG = path.join(dir, 'home', '.config', 'tower-crane', 'config.json');
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// Writes files (path -> content, or null to delete) and commits them; returns the new sha.
function commit(root, files, message = 'change') {
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(root, p);
    if (content === null) {
      fs.rmSync(abs, { force: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function initRepo(root, files) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  return commit(root, files, 'base');
}

function worktrees(root) {
  return git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
}

// Double quotes read the same in sh and cmd.exe for the plain paths these tests use;
// JSON.stringify would double Windows backslashes.
function quote(p) {
  return `"${p}"`;
}

function result(stdout = '', status = 0, stderr = '') {
  return { status, stdout, stderr };
}

// Records every call and answers from `handler(args)`; anything unexpected fails the test.
function fakeExec(handler) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'gh') throw new Error(`unexpected command ${cmd}`);
    const r = handler(args);
    if (!r) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    return r;
  };
  return { exec, calls };
}

// A node:test file whose test starts a child that ends itself with SIGSEGV on its first `times`
// runs, counted in `marker`. It writes `report` first, as apport would. RLIMIT_CORE 1 keeps the
// kernel from piping the deliberate crash to apport, so no real crash report is left behind.
function nativeCrashTest({ marker, times = 1, report = null, ordinary = false }) {
  return `const test = require('node:test');
const fs = require('node:fs');
const cp = require('node:child_process');
const marker = ${JSON.stringify(marker)};
test('child crashes natively', () => {
  // read-published: only this test writes the marker, and runs are sequential.
  const runs = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').length : 0;
  fs.appendFileSync(marker, 'x');
  if (runs >= ${times}) return;
  ${report ? `fs.writeFileSync(${JSON.stringify(report)}, 'ProblemType: Crash\\n');` : ''}
  cp.execFileSync('sh', ['-c', 'ulimit -c 1; exec "$0" -e "process.kill(process.pid, \\'SIGSEGV\\')"', process.execPath]);
});
${ordinary ? "test('ordinary failure', () => { throw new Error('plain assertion'); });" : ''}
`;
}

module.exports = { scratch, isolateGit, isolateUserFile, git, commit, initRepo, worktrees, quote, result, fakeExec, nativeCrashTest };
