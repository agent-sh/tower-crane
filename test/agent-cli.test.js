'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { cachedFixture, pinRung, ROOT } = require('./helpers');

function setup(t) {
  return cachedFixture(t, 'agent-cli', h => {
    h.init();
    h.ok(['task', 'add', '--title', 'Pinned CLI', '--acceptance', 'runs the pinned CLI']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'probe the pinned CLI\n' });
  });
}

test('a command agent runs the pinned CLI before an old global install, including the Windows launcher', t => {
  const h = setup(t);
  const oldBin = path.join(h.base, 'old-bin');
  fs.mkdirSync(oldBin);
  fs.writeFileSync(path.join(oldBin, 'tower-crane'), '#!/bin/sh\necho 0.0.1\nexit 2\n', { mode: 0o700 });
  fs.writeFileSync(path.join(oldBin, 'tower-crane.cmd'), '@echo 0.0.1\r\n@exit /b 2\r\n');
  const out = path.join(h.base, 'cli-result.json');
  const script = path.join(h.base, 'cli-probe.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH');
const first = process.env[key].split(path.delimiter)[0];
const run = args => {
  const r = cp.spawnSync('tower-crane', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ first, version: run(['--version']), dispatch: run(['ci', 'dispatch', '--help']) }));
`);
  pinRung(h, 'small', { harness: 'command', command: [process.execPath, script, '{prompt}'] });
  const key = Object.keys(h.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const started = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: {
    [key]: oldBin + path.delimiter + h.env[key],
  } });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.first, path.join(h.state, 'homes', started.agent, 'bin'));
  for (const name of ['tower-crane', 'tower-crane.cmd']) {
    assert.ok(fs.readFileSync(path.join(seen.first, name), 'utf8').includes(path.join(started.tool.path, 'bin', 'tower-crane.js')));
  }
  assert.equal(seen.version.code, 0, seen.version.stderr);
  assert.equal(seen.version.stdout.trim(), `${started.tool.version} (commit ${started.tool.sha || 'unknown'})`);
  assert.equal(seen.dispatch.code, 0, seen.dispatch.stderr);
  assert.match(seen.dispatch.stdout, /ci dispatch/);
});

for (const [operation, launcher] of [['writeFileSync', 'tower-crane'], ['writeFileSync', 'tower-crane.cmd'], ['accessSync', 'tower-crane.js']]) {
  test(`spawn refuses before starting the harness when ${operation} fails for ${launcher}`, t => {
    const h = setup(t);
    const marker = path.join(h.base, 'harness-started');
    pinRung(h, 'small', { harness: 'command', command: [process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`, '{prompt}'] });
    const preload = path.join(h.base, 'shim-failure.cjs');
    fs.writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path');
const original = fs[${JSON.stringify(operation)}];
fs[${JSON.stringify(operation)}] = function(file, ...args) {
  if (path.basename(String(file)) === ${JSON.stringify(launcher)} && String(file).includes('homes')) {
    throw Object.assign(new Error('planted shim write failure'), { code: 'EACCES' });
  }
  return original.call(this, file, ...args);
};
`);
    const result = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { pre: ['--require', preload] });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /cannot provide the pinned tower-crane shim.*EACCES/);
    assert.equal(fs.existsSync(marker), false, 'the harness never started');
  });
}

test('an installed tool reports its pinned commit or unknown without using the caller repository', t => {
  const h = cachedFixture(t, 'installed-cli', h => {
    const tool = path.join(h.base, 'installed-tool');
    for (const name of ['bin', 'lib', 'package.json']) {
      fs.cpSync(path.join(ROOT, name), path.join(tool, name), { recursive: true });
    }
  });
  const tool = path.join(h.base, 'installed-tool');
  for (const sha of ['1234567890abcdef1234567890abcdef12345678', null]) {
    fs.writeFileSync(path.join(tool, 'tool.json'), JSON.stringify({ sha }));
    const result = cp.spawnSync(process.execPath, [path.join(tool, 'bin', 'tower-crane.js'), '--version'], {
      cwd: h.repo, env: h.env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${require('../package.json').version} (commit ${sha || 'unknown'})`);
  }
});
