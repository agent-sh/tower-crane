'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Spawn = require('../lib/spawn');
const { makeRepo } = require('./helpers');

function npmShim(dir, prefix = '%dp0%') {
  const script = path.join(dir, 'node_modules', '@fixture', 'harness', 'bin', 'echo.cjs');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'console.log(JSON.stringify({ argv: process.argv.slice(2) }));\n');
  const shim = path.join(dir, 'fixture-harness.cmd');
  fs.writeFileSync(shim, [
    '@ECHO off',
    'SET dp0=%~dp0',
    `"%_prog%" "${prefix}\\node_modules\\@fixture\\harness\\bin\\echo.cjs" %*`,
    '',
  ].join('\r\n'));
  return { shim, script };
}

const prompt = 'First line "quoted" & | < > ^ %PATH% !value!\r\nSecond line\n\nLast line\\';

test('Windows npm shim lookup resolves modern and legacy targets without a shell', (t) => {
  const h = makeRepo(t);
  const dir = path.join(h.base, 'npm bin with spaces');
  const { shim, script } = npmShim(dir);
  const env = { Path: dir };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let argv;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.equal(Spawn.findExecutable('fixture-harness', h.repo, true, env), shim);
    assert.equal(Spawn.findExecutable(shim, h.repo, true, env), shim);
    argv = Spawn.launchCommand(['fixture-harness', prompt, ''], h.repo, env);
    assert.deepEqual(argv, [process.execPath, script, prompt, '']);
    npmShim(dir, '%~dp0');
    assert.deepEqual(Spawn.launchCommand([shim, prompt, ''], h.repo, env), argv);
    fs.writeFileSync(path.join(dir, 'ordinary.cmd'), '@echo %*\r\n');
    assert.equal(Spawn.findExecutable('ordinary', h.repo, true, env), null);
    fs.unlinkSync(script);
    assert.equal(Spawn.findExecutable('fixture-harness', h.repo, true, env), null);
    npmShim(dir);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('CLI spawn preserves the full multiline prompt, using an npm .cmd harness on Windows', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Windows npm harness', '--acceptance', 'prompt arrives intact']);
  h.ok(['brief', 'set', 'T1', '-'], { input: prompt });
  const dir = path.join(h.base, 'npm bin with spaces');
  const { script } = npmShim(dir);
  const command = process.platform === 'win32' ? ['fixture-harness'] : [process.execPath, script];
  h.ok(['ladder', 'set', 'medium', '--harness', 'command',
    '--command', JSON.stringify([...command, '{prompt}', prompt]),
    '--clear', 'model', '--clear', 'profile', '--clear', 'provider', '--clear', 'effort', '--clear', 'args']);
  const env = { PATH: `${dir}${path.delimiter}${h.env.PATH || h.env.Path || ''}` };
  const expected = h.json(['spawn', '--task', 'T1', '--dry-run'], { env }).argv.slice(command.length);
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.equal(result.code, 0, result.stderr);
  const echoed = result.stdout.split('\n').find((line) => line.startsWith('{"argv":'));
  assert.ok(echoed, result.stdout);
  assert.deepEqual(JSON.parse(echoed).argv, expected);
});
