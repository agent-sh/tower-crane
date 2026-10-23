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

test('child dispatches keep the orchestrator snapshot until it is respawned from an upgraded CLI', t => {
  const h = setup(t);
  const checkout = path.join(h.base, 'tool-checkout');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(checkout, name), { recursive: true });
  }
  h.git(['init', '-q', checkout]);
  h.git(['add', '.'], checkout);
  h.git(['commit', '-qm', 'initial tool'], checkout);
  const initialSha = h.git(['rev-parse', 'HEAD'], checkout);
  for (const title of ['Pinned child', 'Upgraded dispatch', 'Respawned child']) {
    const task = h.json(['task', 'add', '--title', title, '--acceptance', 'tool version']);
    h.ok(['brief', 'set', task.id, '-'], { input: 'probe tool version\n' });
  }
  const child = path.join(h.base, 'child.cjs');
  fs.writeFileSync(child, `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const r = cp.spawnSync('tower-crane', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) throw new Error(r.stderr);
fs.writeFileSync(path.join(${JSON.stringify(h.base)}, process.env.TOWER_CRANE_TASK + '-version.txt'), r.stdout);
`);
  const parent = path.join(h.base, 'parent.cjs');
  fs.writeFileSync(parent, `
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const checkout = ${JSON.stringify(checkout)};
const upgraded = path.join(checkout, 'upgraded');
const task = fs.existsSync(upgraded) ? 'T4' : 'T2';
if (task === 'T2') {
  const pkg = path.join(checkout, 'package.json');
  const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  data.version = '9.9.9';
  fs.writeFileSync(pkg, JSON.stringify(data));
  fs.writeFileSync(upgraded, 'upgraded');
  for (const args of [['add', '.'], ['commit', '-qm', 'upgraded tool']]) {
    const r = cp.spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  }
}
const r = cp.spawnSync('tower-crane', ['spawn', '--role', 'small', '--task', task, '--wait', '--json'], {
  encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32',
});
if (r.status !== 0) throw new Error(r.stderr);
fs.writeFileSync(path.join(${JSON.stringify(h.base)}, task + '-spawn.json'), r.stdout);
const released = cp.spawnSync('tower-crane', ['orchestrator', 'release'], {
  encoding: 'utf8', shell: process.platform === 'win32',
});
if (released.status !== 0) throw new Error(released.stderr);
`);
  pinRung(h, 'small', { harness: 'command', command: [process.execPath, child, '{prompt}'] });
  pinRung(h, 'orchestrator', { harness: 'command', command: [process.execPath, parent, '{prompt}'] });
  const dispatch = (role, task) => {
    const r = cp.spawnSync(process.execPath, [path.join(checkout, 'bin', 'tower-crane.js'),
      'spawn', '--role', role, '--task', task, '--wait', '--json'], {
      cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 300000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const original = dispatch('orchestrator', 'T1');
  assert.equal(original.tool.sha, initialSha);
  const upgradedSha = h.git(['rev-parse', 'HEAD'], checkout);
  assert.notEqual(upgradedSha, initialSha);
  const direct = dispatch('small', 'T3');
  const respawned = dispatch('orchestrator', 'T1');
  assert.equal(respawned.tool.sha, upgradedSha);
  for (const [task, started, sha, version] of [
    ['T2', JSON.parse(fs.readFileSync(path.join(h.base, 'T2-spawn.json'), 'utf8')), initialSha, original.tool.version],
    ['T3', direct, upgradedSha, '9.9.9'],
    ['T4', JSON.parse(fs.readFileSync(path.join(h.base, 'T4-spawn.json'), 'utf8')), upgradedSha, '9.9.9'],
  ]) {
    assert.equal(started.tool.sha, sha, task);
    assert.equal(fs.readFileSync(path.join(h.base, task + '-version.txt'), 'utf8').trim(),
      `${version} (commit ${sha})`, task);
  }
  for (const [file, patterns] of [
    ['docs/state.md', [
      /dispatch pins the runtime of the CLI that starts it/,
      /A spawned orchestrator keeps its pinned tool for child dispatches until it is respawned from an upgraded CLI\./,
    ]],
    ['docs/cli.md', [
      /dispatch pins the runtime of the CLI that starts it/,
      /A spawned orchestrator keeps its pinned tool for child dispatches until it is respawned from an upgraded CLI\./,
    ]],
    ['changelog.d/T506.md', [
      /Child dispatches from a spawned orchestrator use its snapshot/,
      /respawn the orchestrator from an upgraded CLI to use the new version/,
    ]],
  ]) {
    const contract = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const pattern of patterns) assert.ok(pattern.test(contract), `${file}: missing ${pattern}`);
    assert.doesNotMatch(contract, /Moving or upgrading the tool checkout affects the next dispatch/);
  }
});

for (const [file, universal] of [
  ['docs/ladder.md', /Every spawned agent's `bin\/` holds `tower-crane` and `tower-crane\.cmd`/],
  ['docs/state.md', /Every spawned agent's PATH starts with its shim directory, including `tower-crane` and `tower-crane\.cmd`/],
  ['changelog.d/T506.md', /Every spawned agent runs `tower-crane` from its pinned tool snapshot before any global install/],
]) {
  test(`the agent-home contract in ${file} gives every spawned agent the pinned CLI`, () => {
    const contract = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(universal.test(contract), `${file}: missing universal pinned CLI contract`);
    assert.equal(/A sandboxed claude or codex agent's `bin\/` also holds `tower-crane`/.test(contract),
      false, `${file}: stale sandbox-only CLI contract`);
  });
}

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
