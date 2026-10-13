'use strict';

// The read check claude's Read, Grep and Glob calls go through, in process.
// The wiring (settings hook, spawn, stub harness) is in test/isolation.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { check } = require('../lib/read-guard');

const GUARD = path.join(__dirname, '..', 'lib', 'read-guard.js');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || os.tmpdir(), 'tower-crane-guard-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const wt = path.join(home, 'projects', 'app');
  for (const d of [path.join(home, '.aws'), path.join(wt, 'src'), path.join(home, 'projects', 'other')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'secret\n');
  fs.writeFileSync(path.join(home, 'rules.md'), 'rules\n');
  fs.symlinkSync(path.join(home, '.aws'), path.join(wt, 'aws'));
  return { base, home, wt, policy: { home, allow: [wt, path.join(home, 'rules.md')] } };
}

test('a file tool reads under the home only inside the readable paths', (t) => {
  const { base, home, wt, policy } = fixture(t);
  const cases = [
    ['Read', { file_path: path.join(wt, 'src', 'a.js') }, null],
    ['Read', { file_path: 'src/a.js' }, null],
    ['Read', { file_path: path.join(home, 'rules.md') }, null],
    ['Read', { file_path: path.join(base, 'outside.txt') }, null],
    ['Read', { file_path: path.join(home, '.aws', 'credentials') }, /outside this agent's readable paths/],
    ['Read', { file_path: path.join(home, 'secret-test') }, /outside this agent's readable paths/],
    ['Read', { file_path: '../other/x' }, /outside this agent's readable paths/],
    // A link inside the worktree is judged by where it leads.
    ['Read', { file_path: path.join(wt, 'aws', 'credentials') }, /outside this agent's readable paths/],
    ['Grep', { pattern: 'x' }, null],
    ['Grep', { pattern: 'x', path: path.join(home, '.aws') }, /outside this agent's readable paths/],
    ['Grep', { pattern: 'x', path: base }, /would read the user's home/],
    ['Grep', { pattern: 'x', path: '/' }, /would read the user's home/],
    ['Glob', { pattern: '**/*.js' }, null],
    ['Glob', { pattern: '../../.aws/*' }, /outside this agent's readable paths/],
    ['Glob', { pattern: `${home}/*` }, /outside this agent's readable paths/],
    ['Glob', { pattern: '*', path: path.join(wt, 'aws') }, /outside this agent's readable paths/],
    ['Bash', { command: `cat ${path.join(home, '.aws', 'credentials')}` }, null],
  ];
  for (const [tool, input, expected] of cases) {
    const why = check({ tool_name: tool, tool_input: input, cwd: wt }, policy);
    if (expected) assert.match(String(why), expected, `${tool} ${JSON.stringify(input)}`);
    else assert.equal(why, null, `${tool} ${JSON.stringify(input)}`);
  }
});

test('the hook blocks with exit 2, including when it cannot read its policy', (t) => {
  const { home, wt, policy } = fixture(t);
  const file = path.join(home, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy));
  const run = (policyFile, input) => cp.spawnSync(process.execPath, [GUARD, policyFile], { input: JSON.stringify(input), encoding: 'utf8' });
  const read = (p) => ({ tool_name: 'Read', tool_input: { file_path: p }, cwd: wt });
  assert.equal(run(file, read(path.join(wt, 'src', 'a.js'))).status, 0);
  const denied = run(file, read(path.join(home, '.aws', 'credentials')));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /outside this agent's readable paths/);
  const broken = run(path.join(home, 'missing.json'), read(path.join(wt, 'src', 'a.js')));
  assert.equal(broken.status, 2, 'a hook that cannot decide refuses the call');
});
