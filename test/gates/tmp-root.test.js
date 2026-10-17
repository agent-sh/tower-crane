'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const { makeRepo } = require('../helpers');
const gateTmp = require('../../lib/gate-tmp');
const { shellQuote } = require('../../lib/gates/common');

test('gates.tmp_root holds the worktrees of check tests, ci and clean, and status names it; TOWER_CRANE_TMP overrides it', (t) => {
  const h = makeRepo(t);
  // The fixture sets TOWER_CRANE_TMP, which outranks the project setting this test checks.
  delete h.env.TOWER_CRANE_TMP;
  // Every gate command appends the directory it ran in to a log outside the temporary roots.
  const recorder = path.join(h.base, 'record.js');
  const log = path.join(h.base, 'ran.jsonl');
  fs.writeFileSync(recorder, `
const fs = require('node:fs');
const [gate, file] = process.argv.slice(2);
fs.appendFileSync(file, JSON.stringify({ gate, cwd: fs.realpathSync.native(process.cwd()) }) + '\\n');
if (gate === 'clean') console.log(JSON.stringify({ items: [] }));
`);
  const shellCommand = (gate) => `${shellQuote(process.execPath)} ${shellQuote(recorder)} ${gate} ${shellQuote(log)}`;
  const ranLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  // status names the root the gates use and the setting that chose it, in text and JSON.
  const statusRoot = (root, source) => {
    assert.ok(h.ok(['status']).split('\n').includes(`gate tmp root: ${root} (${source})`));
    assert.deepEqual(h.json(['status']).gate_tmp_root, { root, source });
  };
  h.init(['--tests-mode', 'run-only', '--tests-cmd', shellCommand('tests'), '--clean-cmd', shellCommand('clean'),
    '--ci-local', JSON.stringify({ command: [process.execPath, recorder, 'ci', log], timeout: 30 })]);
  h.ok(['task', 'add', '--title', 'Scratch on the project root', '--acceptance', 'gates build under gates.tmp_root']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);

  // Operational like the other gate settings: a worker cannot set it, and a relative path is refused.
  const denied = h.run(['project', 'set', '--tmp-root', h.base, '--agent', 'worker']);
  assert.equal(denied.code, 1, denied.stderr);
  assert.match(denied.stderr, /operational|orchestrator/);
  const relative = h.run(['project', 'set', '--tmp-root', 'scratch', '--agent', 'orchestrator']);
  assert.equal(relative.code, 2, relative.stderr);
  assert.match(relative.stderr, /absolute directory/);

  const root = path.join(h.base, 'scratch');
  fs.mkdirSync(root);
  h.ok(['project', 'set', '--tmp-root', root, '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), new RegExp(`gates\\.tmp_root: ${JSON.stringify(root).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  statusRoot(root, 'gates.tmp_root');
  for (const gate of ['tests', 'clean', 'ci']) {
    const result = h.run(['check', gate, 'T1', '--agent', 'orchestrator']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(ranLog().map((r) => r.gate), ['tests', 'clean', 'ci']);
  for (const r of ranLog()) assert.ok(r.cwd.startsWith(`${root}${path.sep}`), `${r.gate} ran in ${r.cwd}`);
  // Each worktree is removed when its gate returns, so the root holds nothing afterwards.
  assert.deepEqual(fs.readdirSync(root), []);
  let evidence = h.readState('tasks.json').tasks[0].evidence;
  for (const type of ['tests', 'clean', 'ci']) assert.equal(evidence.findLast((e) => e.type === type).tmp_root, root);

  // TOWER_CRANE_TMP still wins over the project setting.
  const override = path.join(h.base, 'override');
  fs.mkdirSync(override);
  h.env.TOWER_CRANE_TMP = override;
  const overridden = h.run(['check', 'tests', 'T1', '--agent', 'orchestrator']);
  assert.equal(overridden.code, 0, overridden.stdout + overridden.stderr);
  assert.ok(ranLog().at(-1).cwd.startsWith(`${override}${path.sep}`));
  evidence = h.readState('tasks.json').tasks[0].evidence;
  assert.equal(evidence.findLast((e) => e.type === 'tests').tmp_root, override);
  statusRoot(override, 'TOWER_CRANE_TMP');
  delete h.env.TOWER_CRANE_TMP;

  // Unset, the gates use tc/g under the user's cache, not the OS temporary directory: /tmp is
  // often a RAM-backed tmpfs, and some suites refuse to run there. When that cache is too deep for
  // the scratch path, the root comes from the account's own cache, then the OS temporary
  // directory. Each of the three is a fixture here, so the gate never writes or sweeps the real
  // cache: TC_GATE_HOME is the account's home for lib/gate-tmp.js (test/fixtures/account-home.js).
  h.ok(['project', 'set', '--tmp-root', 'null', '--agent', 'orchestrator']);
  assert.match(h.ok(['project', 'show']), /gates\.tmp_root: null/);
  const account = path.join(h.base, 'account');
  const systemTmp = path.join(h.base, 'system-tmp');
  fs.mkdirSync(systemTmp);
  h.env.TC_GATE_HOME = account;
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) h.env[key] = systemTmp;
  const userCache = process.platform === 'win32' ? h.env.LOCALAPPDATA : h.env.XDG_CACHE_HOME;
  const cacheRoot = [userCache, path.join(account, '.cache')].map((base) => path.join(base, 'tc', 'g')).find(gateTmp.scratchFits);
  const want = cacheRoot ? { root: cacheRoot, source: 'cache' } : { root: systemTmp, source: 'system' };
  statusRoot(want.root, want.source);
  const defaulted = h.run(['check', 'clean', 'T1', '--agent', 'orchestrator']);
  assert.equal(defaulted.code, 0, defaulted.stdout + defaulted.stderr);
  const ran = ranLog().at(-1).cwd;
  assert.ok(ran.startsWith(`${fs.realpathSync.native(want.root)}${path.sep}`), ran);
  assert.ok(ran.startsWith(`${fs.realpathSync.native(h.base)}${path.sep}`), ran);
  if (want.source === 'cache') assert.ok(Buffer.byteLength(path.join(path.dirname(ran), 'tmp')) <= 62, ran);
  assert.ok(!fs.existsSync(path.dirname(ran)));
  evidence = h.readState('tasks.json').tasks[0].evidence;
  assert.equal(evidence.findLast((e) => e.type === 'clean').tmp_root, want.root);
});

// Full Chromium aborts with "Socket path too long" under a TMPDIR over 62 bytes.
test('the default gate root keeps the scratch TMPDIR within 62 bytes', () => {
  const env = (cache) => (process.platform === 'win32' ? { LOCALAPPDATA: cache } : { XDG_CACHE_HOME: cache });
  const short = path.join(path.parse(process.cwd()).root, 'c');
  assert.deepEqual(gateTmp.resolve({}, env(short)), { root: path.join(short, 'tc', 'g'), source: 'cache' });
  assert.equal(Buffer.byteLength(gateTmp.scratchPath(path.join(short, 'tc', 'g'))), Buffer.byteLength(short) + 28);
  const deep = path.join(path.parse(process.cwd()).root, 'd'.repeat(80));
  const fallback = gateTmp.resolve({}, env(deep));
  assert.ok(!fallback.root.startsWith(deep), fallback.root);
  assert.ok(Buffer.byteLength(gateTmp.scratchPath(fallback.root)) <= gateTmp.GATE_TMPDIR_MAX, fallback.root);
  assert.equal(gateTmp.GATE_TMPDIR_MAX, 62);
});

test('a gate removes stale gate directories whose owner is gone and keeps the rest', (t) => {
  const h = makeRepo(t);
  delete h.env.TOWER_CRANE_TMP;
  const root = path.join(h.base, 'scratch');
  fs.mkdirSync(root);
  h.init(['--clean-cmd', `${shellQuote(process.execPath)} -e "console.log(JSON.stringify({items: []}))"`, '--tmp-root', root]);
  h.ok(['task', 'add', '--title', 'Sweep', '--acceptance', 'stale gate directories go']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker']);
  // A pid that has exited: spawnSync waits for it and reaps it.
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid;
  const hour = 60 * 60000;
  const dirs = {
    // Owner gone and older than the 20-minute default budget: removed.
    'tower-crane-dead01': { pid: dead, host: os.hostname(), started: Date.now() - hour },
    // Owner gone but younger than the budget: kept.
    'tower-crane-young1': { pid: dead, host: os.hostname(), started: Date.now() },
    // Owner alive: kept.
    'tower-crane-live01': { pid: process.pid, host: os.hostname(), started: Date.now() - hour },
    // Another host's gate: kept.
    'tower-crane-host01': { pid: dead, host: `${os.hostname()}-other`, started: Date.now() - hour },
    // No owner file: an older Tower Crane's gate, kept.
    'tower-crane-nomark': null,
    'unrelated-dir': { pid: dead, host: os.hostname(), started: Date.now() - hour },
  };
  for (const [name, owner] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(root, name, 'wt'), { recursive: true });
    if (owner) fs.writeFileSync(path.join(root, name, 'owner.json'), JSON.stringify(owner));
  }
  const r = h.run(['check', 'clean', 'T1', '--agent', 'orchestrator']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(root).sort(), Object.keys(dirs).filter((n) => n !== 'tower-crane-dead01').sort());
  assert.match(r.stderr, /removed stale gate directory .*tower-crane-dead01/);
});
