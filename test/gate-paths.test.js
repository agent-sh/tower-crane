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

test('gate interpreters infer script suffixes and extensionless shebang scripts', (t) => {
  const h = makeRepo(t);
  const tools = path.join(h.base, 'tools');
  fs.mkdirSync(tools);
  for (const [program, suffix, content] of [
    ['node', '.js', ''], ['python3', '.py', ''], ['sh', '.sh', ''],
    ['ruby', '.rb', ''], ['perl', '.pl', ''], ['python3', '', '#!/usr/bin/env python3\n'],
  ]) {
    const file = path.join(tools, `tool-${program}${suffix}`);
    fs.writeFileSync(file, content);
    for (const key of ['clean_cmd', 'tests_proof_cmd']) {
      assert.deepEqual(new Set(G.reads({ gates: { [key]: `${program} "${file}" {tests}` } }, h.repo, h.env.HOME)),
        new Set([file, tools]), `${key}: ${program}: ${suffix || 'shebang'}`);
    }
  }
});

test('gate command data arguments do not expose credential directories', (t) => {
  const h = makeRepo(t);
  const tools = path.join(h.base, 'tools');
  fs.mkdirSync(tools);
  const wrapper = path.join(tools, 'clean.sh');
  const script = path.join(tools, 'proof.js');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(script, '');
  for (const dir of ['.ssh', '.aws', '.config/gh']) {
    const secretDir = path.join(h.env.HOME, dir);
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, 'credential');
    fs.writeFileSync(secret, 'fixture secret', { mode: 0o600 });
    const alias = path.join(tools, `${path.basename(dir)}-credential`);
    if (process.platform !== 'win32') fs.symlinkSync(secret, alias);
    for (const key of ['clean_cmd', 'tests_proof_cmd']) {
      for (const [command, expected] of [
        [`cat "${secret}" {tests}`, []],
        [`python3 "${secret}" {tests}`, []],
        [`"${secret}"`, []],
        [`"${wrapper}" "${secret}"`, [wrapper, tools]],
        [`node "${script}" "${secret}"`, [script, tools]],
        [`node -e "${secret}"`, []],
        ...(process.platform === 'win32' ? [] : [
          [`cat "${alias}" {tests}`, []],
          [`python3 "${alias}" {tests}`, []],
          [`"${alias}"`, []],
          [`node "${script}" "${alias}"`, [script, tools]],
        ]),
      ]) {
        assert.deepEqual(new Set(G.reads({ gates: { [key]: command } }, h.repo, h.env.HOME)),
          new Set(expected), `${key}: ${dir}: ${command}`);
      }
    }
  }
});

test('clean_paths CLI stores, prints and clears paths under operational authority', (t) => {
  const h = makeRepo(t);
  h.init(['--clean-paths', '["~/tools"]']);
  assert.deepEqual(h.json(['project', 'show']).gates.clean_paths, ['~/tools']);
  const list = [path.join(h.base, 'tools')];
  h.ok(['project', 'set', '--clean-paths', JSON.stringify(list)]);
  assert.match(h.ok(['project', 'show']), /gates\.clean_paths:/);
  assert.deepEqual(h.json(['project', 'show']).gates.clean_paths, list);
  for (const value of [JSON.stringify(list), '[]', 'null']) {
    h.ok(['project', 'set', '--clean-paths', value, '--agent', 'orchestrator']);
    const r = h.run(['project', 'set', '--clean-paths', value, '--agent', 'worker-T1-1']);
    assert.equal(r.code, 1, value);
    assert.match(r.stderr, /only the orchestrator or the owner/);
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
