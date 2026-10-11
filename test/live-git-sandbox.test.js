'use strict';

// Probes the real claude and codex sandboxes from a task worktree: a worker
// cannot write the shared git config or hooks, can still commit, fetch,
// rebase onto main and push, and the harness's own git status runs nothing
// the repository planted. Nested sandboxes cannot start inside a worker's,
// so this file is host-only (tests.host_only).
//
// The codex probe makes no model call: a stand-in harness runs `git status`
// as the harness process, then the probe in `codex sandbox` with the
// generated permission profile. It runs wherever codex is on PATH and its
// sandbox starts. The claude probe runs a real claude agent, so it costs a
// model call: set TOWER_CRANE_LIVE_CLAUDE=1 (TOWER_CRANE_LIVE_MODEL picks the
// model, opus by default).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');

const PROBE = `'use strict';
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [common, out] = process.argv.slice(2);
const git = (...args) => cp.spawnSync('git', args, { encoding: 'utf8' });
const steps = {};
const step = (name, fn) => {
  try {
    const r = fn();
    steps[name] = r && typeof r.status === 'number' ? { ok: r.status === 0, detail: (r.stderr || '').trim().slice(-400) } : { ok: true };
  } catch (e) {
    steps[name] = { ok: false, detail: e.code || e.message };
  }
};
step('config', () => git('config', '--file', path.join(common, 'config'), 'core.fsmonitor', 'touch planted'));
step('hook', () => fs.writeFileSync(path.join(common, 'hooks', 'post-checkout'), '#!/bin/sh\\ntouch planted\\n', { mode: 0o755 }));
step('info', () => fs.writeFileSync(path.join(common, 'info', 'attributes'), '* filter=planted\\n'));
step('commit', () => {
  fs.writeFileSync('probe.txt', 'probe\\n');
  const a = git('add', 'probe.txt');
  return a.status ? a : git('commit', '-qm', 'probe');
});
step('fetch', () => git('fetch', '-q', 'origin'));
step('rebase', () => git('rebase', '-q', 'origin/main'));
step('push', () => git('push', '-q'));
fs.writeFileSync(out, JSON.stringify({ steps, marked: { SANDBOX_RUNTIME: process.env.SANDBOX_RUNTIME || null, CODEX_SANDBOX: process.env.CODEX_SANDBOX || null } }));
`;

// A task worktree whose origin moved on, with a planted fsmonitor and
// post-index-change hook that mark a run under the spawned harness only.
function fixture(t) {
  const h = makeRepo(t);
  const origin = path.join(h.base, 'origin.git');
  h.git(['init', '--bare', '-q', origin]);
  h.git(['remote', 'add', 'origin', origin]);
  h.git(['push', 'origin', 'main']);
  h.init();
  h.ok(['task', 'add', '--title', 'Git probe', '--acceptance', 'the shared git directory stays read-only']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'git probe\n' });
  const upstream = path.join(h.base, 'upstream');
  h.git(['clone', '-q', origin, upstream]);
  fs.writeFileSync(path.join(upstream, 'moved.txt'), 'moved\n');
  h.git(['add', 'moved.txt'], upstream);
  h.git(['commit', '-qm', 'moved'], upstream);
  h.git(['push', 'origin', 'main'], upstream);
  const results = path.join(h.base, 'results');
  fs.mkdirSync(results);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [results] })]);
  const common = fs.realpathSync(path.join(h.repo, '.git'));
  const marker = path.join(h.base, 'harness-ran');
  const touch = `[ -z "$TOWER_CRANE_SESSION" ] || [ -n "$SANDBOX_RUNTIME$CODEX_SANDBOX" ] || touch '${marker}'`;
  h.git(['config', 'core.fsmonitor', `${touch}; false`]);
  fs.writeFileSync(path.join(common, 'hooks', 'post-index-change'), `#!/bin/sh\n${touch}\n`, { mode: 0o755 });
  const probe = path.join(h.base, 'probe.js');
  fs.writeFileSync(probe, PROBE);
  return { h, origin, common, marker, probe, out: path.join(results, 'probe.json') };
}

function check(f, label) {
  assert.ok(fs.existsSync(f.out), `${label}: the probe ran`);
  const { steps, marked } = JSON.parse(fs.readFileSync(f.out, 'utf8'));
  process.stdout.write(`# ${label} probe: ${JSON.stringify({ steps, marked })}\n`);
  for (const s of ['config', 'hook', 'info']) assert.equal(steps[s].ok, false, `${label}: writing the shared ${s} failed`);
  for (const s of ['commit', 'fetch', 'rebase', 'push']) assert.equal(steps[s].ok, true, `${label}: ${s}: ${steps[s].detail}`);
  assert.doesNotMatch(f.h.git(['config', '--get-all', 'core.fsmonitor']), /touch planted/);
  assert.ok(!fs.existsSync(path.join(f.common, 'hooks', 'post-checkout')), `${label}: no hook was planted`);
  assert.ok(!fs.existsSync(f.marker), `${label}: the harness's git ran a planted command`);
  const wt = f.h.json(['worktree', 'T1']);
  assert.equal(f.h.git(['rev-parse', `refs/heads/${wt.branch}`], f.origin), f.h.git(['rev-parse', 'HEAD'], wt.path), `${label}: the push reached origin`);
  assert.equal(f.h.git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], wt.path), '', `${label}: the branch is rebased onto main`);
}

// A real codex whose sandbox starts here, past any stand-in on PATH.
function realCodex() {
  if (process.platform !== 'linux') return { skip: 'the codex probe covers the Linux sandbox' };
  if (process.env.TOWER_CRANE_SANDBOX === '1') return { skip: 'inside a sandbox, where a nested one cannot start' };
  const r = cp.spawnSync('codex', ['sandbox', '--', 'true'], { encoding: 'utf8', timeout: 60000, cwd: process.env.TOWER_CRANE_TEST_TMP || undefined });
  if (r.error?.code === 'ENOENT') return { skip: 'codex is not on PATH' };
  if (r.status !== 0) return { skip: `codex sandbox does not start here: ${String(r.stderr).trim().split('\n').pop()}` };
  return { skip: false };
}
const codex = realCodex();

test('from a real codex sandbox a worker cannot write the shared git config or hooks, still commits, rebases, fetches and pushes, and the harness git runs nothing planted', { skip: codex.skip, timeout: 300000 }, (t) => {
  const f = fixture(t);
  // The stand-in harness: git status as the harness process, then the probe
  // in codex's sandbox with the profile spawn generated in CODEX_HOME.
  const bin = path.join(f.h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const cp = require('node:child_process');
const path = require('node:path');
// The agent's shims stay first on PATH; only this stand-in drops out.
const PATH = process.env.PATH.split(path.delimiter).filter((d) => path.resolve(d) !== ${JSON.stringify(bin)}).join(path.delimiter);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'probe' }) + '\\n');
cp.spawnSync('git', ['status', '--porcelain'], { stdio: 'ignore' });
const r = cp.spawnSync('codex', ['sandbox', '-c', 'default_permissions="tower-crane"', '--', process.execPath, ${JSON.stringify(f.probe)}, ${JSON.stringify(f.common)}, ${JSON.stringify(f.out)}],
  { env: { ...process.env, PATH }, stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  f.h.ok(['ladder', 'set', 'hard', '--harness', 'codex', '--model', 'probe', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const r = f.h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait'], { env: { PATH: `${bin}${path.delimiter}${f.h.env.PATH}` } });
  assert.equal(r.code, 0, r.stderr);
  check(f, 'codex');
});

test('from a real claude sandbox a worker cannot write the shared git config or hooks, still commits, rebases, fetches and pushes, and the harness git runs nothing planted', {
  skip: process.env.TOWER_CRANE_LIVE_CLAUDE !== '1' && 'set TOWER_CRANE_LIVE_CLAUDE=1 to run against the real claude CLI', timeout: 600000,
}, async (t) => {
  const f = fixture(t);
  f.h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly this one command with the Bash tool, then reply with its exit code and stop. Do not use tower-crane.\n\n${JSON.stringify(process.execPath)} ${JSON.stringify(f.probe)} ${JSON.stringify(f.common)} ${JSON.stringify(f.out)}\n`,
  });
  f.h.ok(['ladder', 'set', 'hard', '--harness', 'claude', '--model', process.env.TOWER_CRANE_LIVE_MODEL || 'opus', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const r = await f.h.runAsync(['spawn', '--role', 'hard', '--task', 'T1', '--wait']);
  assert.equal(r.code, 0, r.stderr);
  check(f, 'claude');
});
