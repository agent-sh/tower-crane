'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Spawn = require('../lib/spawn');
const { makeRepo, dispatch } = require('./helpers');
const { readPublished } = require('./atomic-file');

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

test('spawned agents drop the dispatcher session ids and engine provenance', (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Session env', '--acceptance', 'agent env names its own session']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'print the inherited session variables\n' });
  const script = path.join(h.base, 'env.cjs');
  const names = ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'TOWER_CRANE_VIA', 'TOWER_CRANE_AUTOMATION_KEY_FD'];
  fs.writeFileSync(script, `console.log('ENV ' + JSON.stringify(${JSON.stringify(names)}.filter((k) => process.env[k] !== undefined)));\n`);
  const command = JSON.stringify([process.execPath, script, '{prompt}']);
  const clear = ['--clear', 'model', '--clear', 'profile', '--clear', 'provider', '--clear', 'effort', '--clear', 'args'];
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', command, ...clear]);
  const env = Object.fromEntries(names.map((k) => [k, 'dispatcher']));
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.equal(result.code, 0, result.stderr);
  const line = result.stdout.split('\n').find((l) => l.startsWith('ENV '));
  assert.ok(line, result.stdout);
  assert.deepEqual(JSON.parse(line.slice(4)), []);
});

// The hook bridge and the supervisor read the key whenever they start a CLI
// child, so a home build can race one. The preload holds the build's key write
// halfway, where a reader of the key finds what a racing helper would.
test('a home build publishes the automation key whole, never empty or half written', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Key write', '--acceptance', 'the key appears whole']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'exit\n' });
  const script = path.join(h.base, 'exit.cjs');
  fs.writeFileSync(script, '\n');
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, script, '{prompt}']),
    '--clear', 'model', '--clear', 'profile', '--clear', 'provider', '--clear', 'effort', '--clear', 'args']);
  const key = path.join(h.state, 'homes', 'worker-T1-1', 'automation.key');
  const { run, until } = dispatch(t, h, {
    args: ['spawn', '--task', 'T1', '--wait'],
    pre: ['--require', path.join(__dirname, 'fixtures', 'partial-write.js')],
    env: { PARTIAL_WRITE_TARGET: key },
  });
  await until(() => fs.existsSync(`${key}.half`), 'the key write held halfway');
  let seen = null;
  try { seen = readPublished(key, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(seen === null || /^[0-9a-f]{64}\n$/.test(seen), `a helper read ${JSON.stringify(seen)} mid-write`);
  fs.writeFileSync(`${key}.finish`, '');
  const result = await run;
  assert.equal(result.code, 0, result.stderr);
  assert.match(fs.readFileSync(key, 'utf8'), /^[0-9a-f]{64}\n$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(key)).filter((name) => name.startsWith('.automation.key.')), [], 'no staged key is left behind');
});
