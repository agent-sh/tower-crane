'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shellQuote } = require('../lib/gates/common');
const { TMP_ROOT } = require('./helpers');

let gateRepoSeed;

function gitBaseline(h) {
  if (h.git(['status', '--porcelain', '--untracked-files=all'])) return null;
  const gitDir = path.join(h.repo, '.git');
  const headPath = path.join(gitDir, 'HEAD');
  const mainPath = path.join(gitDir, 'refs', 'heads', 'main');
  const configPath = path.join(gitDir, 'config');
  const excludePath = path.join(gitDir, 'info', 'exclude');
  if (![headPath, mainPath, configPath, excludePath].every((file) => fs.existsSync(file))) return null;
  const heads = fs.readdirSync(path.join(gitDir, 'refs', 'heads')).sort();
  const head = fs.readFileSync(headPath, 'utf8');
  if (head !== 'ref: refs/heads/main\n' || heads.length !== 1 || heads[0] !== 'main'
    || fs.existsSync(path.join(gitDir, 'packed-refs'))) return null;
  return {
    config: fs.readFileSync(configPath, 'utf8'),
    exclude: fs.readFileSync(excludePath, 'utf8'),
    main: fs.readFileSync(mainPath, 'utf8'),
  };
}

function saveGateRepoSeed(h, sha, baseline) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-gate-seed-')));
  try {
    fs.cpSync(path.join(h.repo, '.git'), path.join(base, '.git'), { recursive: true });
    fs.copyFileSync(path.join(h.repo, 'value.js'), path.join(base, 'value.js'));
    fs.cpSync(path.join(h.repo, 'test'), path.join(base, 'test'), { recursive: true });
    gateRepoSeed = { base, sha, baseline };
    process.once('exit', () => {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
  } catch (error) {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

function restoreGateRepo(h) {
  fs.rmSync(path.join(h.repo, '.git'), { recursive: true, force: true });
  fs.cpSync(path.join(gateRepoSeed.base, '.git'), path.join(h.repo, '.git'), { recursive: true });
  fs.copyFileSync(path.join(gateRepoSeed.base, 'value.js'), path.join(h.repo, 'value.js'));
  fs.cpSync(path.join(gateRepoSeed.base, 'test'), path.join(h.repo, 'test'), { recursive: true });
  fs.mkdirSync(path.join(h.repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  return gateRepoSeed.sha;
}

// Run the real gates against a small change so acceptance tests need no network or installed scanner.
function gateFixture(h) {
  const baseline = gitBaseline(h);
  let sha;
  if (gateRepoSeed && baseline && JSON.stringify(baseline) === JSON.stringify(gateRepoSeed.baseline)) {
    sha = restoreGateRepo(h);
  } else {
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 0;\n');
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'base value']);
    h.git(['switch', '-qc', 'fixture-change']);
    fs.writeFileSync(path.join(h.repo, 'value.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(h.repo, 'test'));
    fs.writeFileSync(path.join(h.repo, 'test', 'value.test.js'), "require('node:assert/strict').equal(require('../value'), 1);\n");
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'change with regression']);
    sha = h.git(['rev-parse', 'HEAD']);
    if (!gateRepoSeed && baseline) saveGateRepoSeed(h, sha, baseline);
  }
  const tools = path.join(h.base, 'tools');
  fs.mkdirSync(tools);
  const scanner = path.join(tools, 'scanner.js');
  fs.writeFileSync(scanner, `console.log(JSON.stringify({ items: process.env.FIXTURE_GATE_OK === '0' ? [{severity: 'HIGH', message: 'fixture finding'}] : [] }));\n`);
  const gh = path.join(tools, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FIXTURE_GH_LOG) fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + '\\n');
// FIXTURE_MERGED_PER_PR gives each PR its own merge marker.
const merged = process.env.FIXTURE_MERGED && process.env.FIXTURE_MERGED + (process.env.FIXTURE_MERGED_PER_PR ? '-' + args[2] : '');
if (args[0] === 'pr' && args[1] === 'merge') {
  fs.writeFileSync(merged, 'merged');
} else if (args[0] === 'pr') {
  const pr = args[2];
  console.log(JSON.stringify({
    headRefOid: process.env.FIXTURE_SHA,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: process.env['FIXTURE_PR_HEAD_' + pr] || process.env.FIXTURE_PR_HEAD || 'fixture-change',
    baseRefName: process.env.FIXTURE_PR_BASE || 'main',
    isCrossRepository: false,
    state: process.env['FIXTURE_PR_STATE_' + pr] || process.env.FIXTURE_PR_STATE || (fs.existsSync(merged) ? 'MERGED' : 'OPEN'),
    mergeCommit: {oid: process.env.FIXTURE_SHA},
  }));
} else {
  const ok = process.env.FIXTURE_GATE_OK !== '0';
  console.log(JSON.stringify({name: 'fixture', app: 'fixture', status: 'completed', conclusion: ok ? 'success' : 'failure', runs: 1}));
  // A review app that hit its usage limit, for ci.capped_review.
  if (process.env.FIXTURE_CAPPED && args.some((a) => a.includes('/check-runs'))) {
    console.log(JSON.stringify({name: 'bot-review', app: 'reviewbot', status: 'completed', conclusion: 'failure', suite: 9, output: {title: 'usage limit reached'}}));
  }
}
`);
  fs.chmodSync(gh, 0o755);
  if (process.platform === 'win32') {
    // Windows cannot execute a shebang stub, so route only gh to the same fixture.
    const preload = path.join(tools, 'gh-preload.js');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (command, args, opts) => command === 'gh'
  ? original(process.execPath, [${JSON.stringify(gh)}, ...args], opts)
  : original(command, args, opts);
`);
    h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
  }
  // Windows preserves the inherited Path casing in this plain environment object.
  const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  Object.assign(h.env, {
    [pathKey]: tools + path.delimiter + (h.env[pathKey] || ''),
    TOWER_CRANE_TMP: path.join(h.base, 'gate-tmp'),
    TOWER_CRANE_CLEAN_CMD: `${shellQuote(process.execPath)} ${shellQuote(scanner)}`,
    FIXTURE_SHA: sha,
    FIXTURE_MERGED: path.join(h.base, 'merged'),
  });
  h.gateSettings = ['--tests-cmd', 'node test/value.test.js', '--clean-cmd', h.env.TOWER_CRANE_CLEAN_CMD];
  if (fs.existsSync(path.join(h.state, 'project.json'))) h.ok(['project', 'set', ...h.gateSettings]);
  return sha;
}

function gateEvidence(h, type, agent, ok = true) {
  const args = ['check', type, 'T1', '--agent', agent];
  if (type === 'tests') {
    const cmd = ok ? 'node test/value.test.js' : 'node -e "process.exit(1)"';
    h.ok(['project', 'set', '--tests-cmd', cmd]);
    args.push('--cmd', cmd);
  }
  const r = h.run(args, { env: { FIXTURE_GATE_OK: ok ? '1' : '0' } });
  if (r.code !== (ok ? 0 : 1)) throw new Error(`gate ${type}: ${r.stderr}\n${r.stdout}`);
  return r;
}

// A submitted task keeps its kind, so a kind change goes through rework and a
// new submission of the same head, as an agent would make it.
function changeKind(h, kind) {
  const { sha, submitted_by: agent } = h.json(['task', 'show', 'T1']);
  h.ok(['rework', 'T1', '--reason', `kind ${kind}`, '--agent', 'owner']);
  h.ok(['task', 'update', 'T1', '--kind', kind]);
  h.ok(['claim', 'T1', '--agent', agent]);
  h.ok(['submit', 'T1', '--sha', sha, '--agent', agent]);
}

module.exports = { gateFixture, gateEvidence, changeKind };
