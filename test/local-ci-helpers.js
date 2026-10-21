'use strict';

// The local CI fixtures the local CI suites share: a repository whose checker
// runs as ci.local, submitted and reviewed at a head, and a merge fixture with
// a fake gh and an optional bare origin. Each suite file runs in its own process.

const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');

// Each fixture is built once per process and copied for each test.
function fixture(t, script) {
  return cachedFixture(t, `local:${script || ''}`, (h) => build(h, script));
}

function build(h, script) {
  // No worker runs here, so the gates check a base with no origin remote,
  // the local branch; originFixture adds one.
  h.git(['remote', 'remove', 'origin']);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.log = path.join(h.base, 'check.json');
  h.command = [process.execPath, 'ci.js', h.log, 'literal argument; $(exit 1)'];
  h.init(['--ci-local', JSON.stringify({ command: h.command, timeout: 5 })]);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'old\n');
  fs.writeFileSync(path.join(h.repo, 'ci.js'), script || `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
assert.equal(fs.readFileSync('head.txt', 'utf8'), 'new\\n');
assert.equal(fs.readFileSync('base.txt', 'utf8'), 'base\\n');
fs.writeFileSync(process.argv[2], JSON.stringify({
  cwd: process.cwd(), argument: process.argv[3],
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
}));
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base checker']);
  h.git(['switch', '-qc', 'local-change']);
  fs.writeFileSync(path.join(h.repo, 'head.txt'), 'new\n');
  h.git(['commit', '-qam', 'head change']);
  h.sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  fs.writeFileSync(path.join(h.repo, 'base.txt'), 'base\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'base advances']);
  h.baseSha = h.git(['rev-parse', 'HEAD']);
  h.ok(['task', 'add', '--title', 'local check', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  h.ok(['submit', 'T1', '--agent', 'worker', '--sha', h.sha, '--branch', 'local-change', '--pr', '1']);
  h.reviewer('T1', 'reviewer', h.sha);
  h.ok(['evidence', 'T1', '--revision', h.revision('T1'), '--type', 'review', '--ok', '--sha', h.sha, '--agent', 'reviewer']);
  return { log: h.log, command: h.command, sha: h.sha, baseSha: h.baseSha };
}

// A fake gh on a preload, and with origin a bare remote and a clone of it.
function mergeFixture(t, { origin = false } = {}) {
  return cachedFixture(t, `merge:${origin}`, (h) => {
    const fields = build(h);
    h.ok(['project', 'set', '--repo', 'acme/demo']);
    h.merged = path.join(h.base, 'merged');
    const preload = path.join(h.base, 'github.js');
    fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, opts) {
  if (command === 'git' && args.includes('fetch') && process.env.LOCAL_FETCH_TIMEOUT) {
    require('node:assert/strict').equal(opts.timeout, 60000);
    const error = Object.assign(new Error('fetch timed out'), {code: 'ETIMEDOUT'});
    return {status: null, signal: 'SIGTERM', stdout: '', stderr: '', error};
  }
  if (command === 'git' && process.env.LOCAL_TREE_LOG
    && args.some((arg) => arg === 'merge-tree' || arg === 'ls-tree')) {
    fs.appendFileSync(process.env.LOCAL_TREE_LOG, JSON.stringify(args) + '\\n');
  }
  if (command !== 'gh') return original(command, args, opts);
  const merged = ${JSON.stringify(h.merged)};
  if (args[0] === 'pr' && args[1] === 'merge') fs.writeFileSync(merged, '');
  return {status: 0, stderr: '', stdout: JSON.stringify({
    headRefOid: ${JSON.stringify(h.sha)}, state: fs.existsSync(merged) ? 'MERGED' : 'OPEN',
    baseRefName: ${JSON.stringify(h.json(['project', 'show']).base)}, isCrossRepository: false,
    mergeCommit: {oid: ${JSON.stringify(h.sha)}}
  })};
};
`);
    h.env.NODE_OPTIONS = `${h.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`;
    if (origin) originFixture(h);
    return { ...fields, merged: h.merged, origin: h.origin, upstream: h.upstream };
  });
}

function originFixture(h) {
  h.origin = path.join(h.base, 'origin.git');
  h.git(['init', '--bare', '-q', h.origin]);
  h.git(['remote', h.git(['remote']).split('\n').includes('origin') ? 'set-url' : 'add', 'origin', h.origin]);
  h.git(['push', 'origin', 'main']);
  h.upstream = path.join(h.base, 'upstream');
  h.git(['clone', '-q', h.origin, h.upstream]);
}

module.exports = { fixture, build, mergeFixture, originFixture };
