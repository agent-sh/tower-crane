'use strict';

// A released tower-crane, taken from its tag once per test process, so tests
// run a 0.1 tool on the file layouts it writes and the states this one
// migrates. CI checks out the full history, tags included.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempRoot } = require('./tmp-root');
const { HUNG_TEST_MS } = require('./signals');

const ROOT = path.join(__dirname, '..');
const tools = new Map();

function releasedBin(tag) {
  if (tools.has(tag)) return tools.get(tag);
  fs.mkdirSync(tempRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot(), `released-${tag}-`));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const archive = cp.execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', tag, 'bin', 'lib', 'package.json'], { env, maxBuffer: 256 << 20 });
  cp.execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: archive });
  const bin = path.join(dir, 'bin', 'tower-crane.js');
  tools.set(tag, bin);
  return bin;
}

// Runs the released CLI as h.run runs this one: in the fixture's repository,
// with its environment and the test hooks.
function runReleased(h, tag, args, { env = {}, hooks = {} } = {}) {
  const r = cp.spawnSync(process.execPath, ['--require', path.join(__dirname, 'fixtures', 'hooks.js'), releasedBin(tag), ...args], {
    cwd: h.repo,
    env: { ...h.env, HOOK_STATE: h.state, HOOK_PROCESSES_DIR: path.join(h.base, 'detached'), ...hooks, ...env },
    encoding: 'utf8',
    timeout: HUNG_TEST_MS,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

module.exports = { releasedBin, runReleased };
