'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cache = process.env.TOWER_CRANE_TEST_TMP || path.join(os.homedir(), '.cache', 'tower-crane-tests');
fs.mkdirSync(cache, { recursive: true });
const probe = fs.mkdtempSync(path.join(cache, 'model-swap-'));
const temporary = fs.mkdtempSync(path.join(cache, 'model-swap-tmp-'));
// Chrome's Unix socket paths have a much smaller limit than filesystem paths.
const aliasRoot = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'tc-swap-'));
const testTmp = aliasRoot ? path.join(aliasRoot, 't') : temporary;
if (aliasRoot) fs.symlinkSync(temporary, testTmp, 'dir');
const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

try {
  for (const file of new Set(files)) {
    const dest = path.join(probe, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
  cp.execFileSync('git', ['init', '-q'], { cwd: probe });
  cp.execFileSync('git', ['add', '.'], { cwd: probe });
  cp.execFileSync('git', ['-c', 'user.name=Model swap probe', '-c', 'user.email=probe@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(probe, '.git', 'no-hooks')}`,
    'commit', '-qm', 'Seed model swap probe'], { cwd: probe });
  const file = path.join(probe, 'lib', 'ladder.js');
  const text = fs.readFileSync(file, 'utf8');
  const builtin = {
    harness: 'pi',
    ladder: Object.fromEntries(['orchestrator', 'easy', 'medium', 'hard', 'research', 'review', 'small']
      .map(name => [name, { harness: 'pi', model: `fake-model-${name}-2099`, effort: 'high' }])),
    claude_aliases: { [['fake', 'alias'].join('')]: 'fake-release-2099' },
  };
  fs.writeFileSync(file, text.replace(/const BUILTIN = \{[\s\S]*?\n\};/,
    `const BUILTIN = ${JSON.stringify(builtin, null, 2)};`));
  const log = path.join(cache, 'model-swap-probe.tap');
  const fd = fs.openSync(log, 'w+');
  let result;
  let output;
  try {
    const env = { ...process.env, TOWER_CRANE_TEST_TMP: testTmp };
    // Every fixture owns its HOME and cache; a caller's agent cache changes those paths.
    for (const key of ['XDG_CACHE_HOME', 'LOCALAPPDATA', 'TC_TEST_SHARD', 'NODE_TEST_CONTEXT']) delete env[key];
    result = cp.spawnSync(process.execPath, [path.join(probe, 'test', 'run.js'),
      '--test-concurrency=3', '--test-reporter=tap'], {
      cwd: probe, env, stdio: ['ignore', fd, fd], timeout: 45 * 60 * 1000,
    });
    // Validate the same open file the runner wrote, even if its path changes.
    const buffer = Buffer.alloc(fs.fstatSync(fd).size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    output = buffer.toString('utf8', 0, offset);
  } finally { fs.closeSync(fd); }
  const failures = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map(m => m[1]);
  console.log(`Probe log: ${log}`);
  console.log(output.split('\n').filter(line => /^# (tests|pass|fail|skipped)|^not ok /.test(line)).join('\n'));
  const expected = 'BUILTIN matches the documented defaults and init fallback';
  // A timed-out run leaves unfinished tests that say nothing about the swap.
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`the suite did not finish within the 45-minute software-gate deadline (log: ${log})`);
  }
  if (result.error || result.status !== 1 || failures.length !== 1 || failures[0] !== expected) {
    // The log tail can omit an early failure, so retain its complete assertion block.
    for (const block of output.split(/(?=^# Subtest: )/m)) {
      const failed = /^not ok \d+ - (.*)$/m.exec(block);
      if (failed && failed[1] !== expected) console.error(block.trimEnd());
    }
    throw new Error(`expected only "${expected}" to fail: ${JSON.stringify(failures)}; ${result.error || ''}`);
  }
  console.log('Model swap probe passed: only the documented defaults assertion failed.');
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
  fs.rmSync(temporary, { recursive: true, force: true });
  if (aliasRoot) fs.rmSync(aliasRoot, { recursive: true, force: true });
}
