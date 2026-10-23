'use strict';

// Host probe (T545): a gate command whose detached grandchild clears its environment, leaves the
// command's session and outlives its parent leaves no live process once the command's run
// returns, on success, on failure and on timeout. Gate commands get a cgroup only on the host
// (a node test worker launches them bare), so this runs there, from the worktree root:
//
//   node scripts/probe-gate-containment.js
//
// It runs each case with lib/gates/common.js at this checkout ("after") and at BASE, the commit
// before the change ("before"), and prints one JSON line per run. It exits 1 when an "after" run
// leaves a process or reports anything but an empty cgroup; "before" runs are evidence only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');

const BASE = '3d20cea9e768985f23b93ea43288dd918aec9cc0';
const root = path.resolve(__dirname, '..');

function common(version) {
  if (version === 'after') return require('../lib/gates/common');
  const filename = path.join(root, 'lib', 'gates', 'common.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(cp.execFileSync('git', ['show', `${BASE}:lib/gates/common.js`], { cwd: root, encoding: 'utf8', timeout: 5000 }), filename);
  return loaded.exports;
}

function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2)[0]);
  } catch { return false; }
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Spins until its own deadline, so a probe that finds it alive still ends.
const SPIN = 'const end = Date.now() + 60000; while (Date.now() < end) Math.sqrt(Math.random());';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-gate-containment-'));
  const resources = require('../lib/containment').resolveGate({});
  const setsid = ['/usr/bin/setsid', '/bin/setsid'].find((file) => fs.existsSync(file));
  const leaks = {
    // A node child started detached, with an empty environment.
    node: (pids) => `${quote(process.execPath)} -e ${quote(`const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SPIN)}], { detached: true, stdio: 'ignore', env: {} }); require('fs').appendFileSync(${JSON.stringify(pids)}, c.pid + '\\n'); c.unref();`)}`,
    // setsid -f with env -i, as a test or a daemon would start it.
    ...(setsid ? { setsid: (pids) => `${setsid} -f env -i ${quote(process.execPath)} -e ${quote(`require('fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n'); ${SPIN}`)}` } : {}),
  };
  const ends = { success: 'exit 0', failure: 'exit 1', timeout: 'sleep 600' };
  let failed = false;
  const planted = [];
  try {
    for (const version of ['before', 'after']) {
      const { treeExec } = common(version);
      for (const [leak, start] of Object.entries(leaks)) {
        for (const [end, tail] of Object.entries(ends)) {
          const pids = path.join(dir, `${version}-${leak}-${end}.pids`);
          // The leak writes its pid before the command goes on; give it a moment to do so.
          const command = `${start(pids)}; i=0; while [ ! -s ${quote(pids)} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; ${tail}`;
          const r = await treeExec(command, [], { shell: true, cwd: dir, resources, timeout: end === 'timeout' ? 3000 : 60000 });
          const found = fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];
          planted.push(...found);
          const left = found.filter(alive);
          const line = { version, leak, end, status: r.status, timed_out: r.error?.code === 'ETIMEDOUT', backend: r.containment?.backend,
            cleanup: r.cleanup ?? null, planted: found, alive_after_return: left };
          if (version === 'after' && (!found.length || left.length || r.cleanup?.backend !== 'cgroup' || r.cleanup?.empty !== true)) {
            line.fail = true;
            failed = true;
          }
          process.stdout.write(`${JSON.stringify(line)}\n`);
        }
      }
    }
  } finally {
    for (const pid of planted) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Gone meanwhile. */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
