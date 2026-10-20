'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const G = require('../lib/gate-paths');

test('literal gate paths support quoting and escapes without evaluating shell expansions', () => {
  for (const [input, expected] of [
    ['/opt/tool/run --json', ['/opt/tool/run', '--json']],
    ["node '/opt/my tool/run.js' {tests}", ['node', '/opt/my tool/run.js', '{tests}']],
    ['"/opt/my tool/run" --json', ['/opt/my tool/run', '--json']],
    ['/opt/my\\ tool/run', ['/opt/my tool/run']],
    ['"$TOOL/run" "$(secret)" `secret` ~/tool /opt/*/run', []],
    ['$(cat /private/file) /opt/run', []],
    ['/opt/run "$OUT"', ['/opt/run']],
    ['"/opt/\\$tool/run" "/opt/\\q/run"', ['/opt/$tool/run', '/opt/\\q/run']],
  ]) assert.deepEqual(G.literalWords(input), expected, input);
});

test('external gate files and directories are resolved while worktree files stay writable', (t) => {
  const h = makeRepo(t);
  const toolDir = path.join(h.base, 'tools with spaces');
  const dependency = path.join(h.base, 'dependency');
  fs.mkdirSync(toolDir);
  fs.mkdirSync(dependency);
  const file = path.join(toolDir, 'check.js');
  const local = path.join(h.repo, 'local.js');
  fs.writeFileSync(file, '');
  fs.writeFileSync(local, '');
  for (const key of ['clean_cmd', 'tests_proof_cmd']) {
    const seen = G.reads({ gates: { [key]: `node "${file}" "${local}"`, clean_paths: [dependency] } }, h.repo, h.env.HOME);
    assert.deepEqual(new Set(seen), new Set([file, toolDir, dependency]));
  }
  assert.throws(() => G.reads({ gates: { clean_paths: [h.base] } }, h.repo, h.env.HOME), /holds the worktree/);
  assert.throws(() => G.reads({ gates: { clean_paths: [path.join(h.base, 'missing')] } }, h.repo, h.env.HOME), /not a readable file/);
});

test('clean_paths CLI stores, prints and clears paths, and only the owner can grant them', (t) => {
  const h = makeRepo(t);
  h.init(['--clean-paths', '["~/tools"]']);
  assert.deepEqual(h.json(['project', 'show']).gates.clean_paths, ['~/tools']);
  const list = [path.join(h.base, 'tools')];
  h.ok(['project', 'set', '--clean-paths', JSON.stringify(list)]);
  assert.match(h.ok(['project', 'show']), /gates\.clean_paths:/);
  assert.deepEqual(h.json(['project', 'show']).gates.clean_paths, list);
  for (const agent of ['orchestrator', 'worker-T1-1']) {
    const r = h.run(['project', 'set', '--clean-paths', 'null', '--agent', agent]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /owner-required|only the owner/);
  }
  for (const value of ['{}', '[1]', '["relative"]', '["/tool\\u0000"]']) {
    const before = h.readState('project.json');
    assert.equal(h.run(['project', 'set', '--name', 'invalid', '--clean-paths', value]).code, 2);
    assert.deepEqual(h.readState('project.json'), before);
  }
  h.ok(['project', 'set', '--clean-paths', '[]']);
  assert.deepEqual(h.json(['project', 'show']).gates.clean_paths, []);
  h.ok(['project', 'set', '--clean-paths', 'null']);
  assert.ok(!h.json(['project', 'show']).gates);
});
