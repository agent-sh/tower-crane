'use strict';
// Gate worktrees in one repository: gates that run at once must not run git's worktree commands at
// the same time, since git's bookkeeping for them races when they overlap.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('node:util');
const { withWorktree } = require('../../lib/gates/common');
const { scratch, isolateGit, initRepo, worktrees } = require('./helpers');

const execFile = promisify(cp.execFile);
const tmp = scratch('gates-worktree');
isolateGit(tmp);
process.env.TOWER_CRANE_TMP = path.join(tmp, 'tower-crane-tmp');
fs.mkdirSync(process.env.TOWER_CRANE_TMP);
const root = path.join(tmp, 'repo');
const sha = initRepo(root, { 'lib/add.js': 'module.exports = (a, b) => a + b;\n' });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('gates that share a repository never run worktree commands at the same time', async () => {
  // Asynchronous, so the calls of gates in this process overlap as separate gate processes do.
  let inFlight = 0;
  let peak = 0;
  const exec = async (cmd, args, opts) => {
    const worktreeCommand = args.includes('worktree');
    if (worktreeCommand) peak = Math.max(peak, ++inFlight);
    try {
      const { stdout, stderr } = await execFile(cmd, args, { encoding: 'utf8', maxBuffer: Infinity, ...opts });
      return { status: 0, stdout, stderr };
    } catch (e) {
      return { status: e.code, stdout: e.stdout, stderr: e.stderr };
    } finally {
      if (worktreeCommand) inFlight -= 1;
    }
  };
  const ctx = { exec };
  const runs = await Promise.all(Array.from({ length: 16 }, async () => {
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await withWorktree(ctx, root, sha, (dir) => fs.existsSync(path.join(dir, 'lib', 'add.js'))));
    return results;
  }));
  assert.deepEqual(runs.flat(), new Array(32).fill(true));
  assert.equal(peak, 1, 'at most one worktree command ran at a time');
  assert.equal(worktrees(root), 1, 'no gate worktree is left registered');
});
