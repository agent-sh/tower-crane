'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scratch, isolateGit } = require('./helpers');
const { HUNG_TEST_MS } = require('../signals');

const tmp = scratch('gates-isolation');
isolateGit(tmp);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const foreign = path.join(tmp, 'foreign');
fs.mkdirSync(foreign);
fs.writeFileSync(path.join(foreign, 'marker'), 'untouched\n');

const inherited = {
  TOWER_CRANE_STATE: foreign,
  GIT_DIR: foreign,
  GIT_COMMON_DIR: foreign,
  GIT_WORK_TREE: foreign,
  GIT_INDEX_FILE: path.join(foreign, 'index'),
  GIT_OBJECT_DIRECTORY: foreign,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: foreign,
};
const cases = [
  ['no overrides', {}],
  ...Object.entries(inherited).map(([key, value]) => [key, { [key]: value }]),
  ['all overrides', inherited],
];

test('gate fixtures ignore inherited state and Git repository paths', async (t) => {
  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      const dir = path.join(tmp, name.replaceAll(' ', '-'));
      const source = `
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const { isolateGit, initRepo, worktrees } = require(${JSON.stringify(require.resolve('./helpers'))});
        const { withWorktree } = require(${JSON.stringify(require.resolve('../../lib/gates/common'))});
        const { lockPath } = require(${JSON.stringify(require.resolve('../../lib/worktree'))});
        const dir = ${JSON.stringify(dir)};
        fs.mkdirSync(dir);
        isolateGit(dir);
        assert.equal(process.env.TOWER_CRANE_STATE, undefined);
        for (const key of ${JSON.stringify(Object.keys(inherited).filter((key) => key.startsWith('GIT_')))}) {
          assert.equal(process.env[key], undefined, key);
        }
        process.env.TOWER_CRANE_TMP = path.join(dir, 'gate-tmp');
        const root = path.join(dir, 'repo');
        const sha = initRepo(root, { 'fixture.txt': 'scratch only\\n' });
        const lock = lockPath({ root, commonDir: path.join(root, '.git') });
        // lockPath names the lock by the repository's real path, and the temp root can be a symlink.
        assert.ok(lock.startsWith(fs.realpathSync.native(root) + path.sep), lock);
        withWorktree({}, root, sha, (checkout) => {
          assert.equal(fs.readFileSync(path.join(checkout, 'fixture.txt'), 'utf8'), 'scratch only\\n');
          assert.ok(checkout.startsWith(dir + path.sep), checkout);
          return true;
        }).then((result) => {
          assert.equal(result, true);
          assert.equal(worktrees(root), 1);
          assert.deepEqual(fs.readdirSync(process.env.TOWER_CRANE_TMP), []);
        }).catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      const env = { ...process.env };
      for (const key of Object.keys(inherited)) delete env[key];
      cp.execFileSync(process.execPath, ['-e', source], {
        env: { ...env, ...overrides }, encoding: 'utf8', timeout: HUNG_TEST_MS,
      });
      assert.deepEqual(fs.readdirSync(foreign), ['marker']);
      assert.equal(fs.readFileSync(path.join(foreign, 'marker'), 'utf8'), 'untouched\n');
    });
  }
});
