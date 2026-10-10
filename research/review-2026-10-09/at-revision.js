'use strict';

// Keep the reviewed engine revision separate from this report branch.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const checkout = path.resolve(__dirname, '../..');
const requested = process.argv[2];
assert.match(requested || '', /^[a-f0-9]{7,40}$/i, 'supply an existing engine commit SHA');
const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
assert.ok(/\/\.cache(?:\/|$)/.test(path.resolve(cache)), 'scratch must be under ~/.cache');
fs.mkdirSync(cache, { recursive: true });
const base = fs.mkdtempSync(path.join(cache, 'T144-engine-'));
const engine = path.join(base, 'engine');
const git = (args, cwd) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const sha = git(['rev-parse', '--verify', `${requested}^{commit}`], checkout);
  git(['clone', '--shared', '--no-checkout', checkout, engine], checkout);
  git(['checkout', '--detach', sha], engine);
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...process.argv.slice(3)], {
    cwd: checkout, stdio: 'inherit',
    env: { ...process.env, T144_ENGINE_ROOT: engine,
      T144_PROBE_COMMAND_PREFIX: `nice -n 19 node research/review-2026-10-09/at-revision.js ${sha}` },
  });
  if (r.error) throw r.error;
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
