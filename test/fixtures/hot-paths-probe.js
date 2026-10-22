'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const S = require('../../lib/state');
const T = require('../../lib/tasks');
const Scope = require('../../lib/scope');
const Commands = require('../../lib/commands');

const repo = S.findRepo(null, process.cwd());
const stateDir = process.env.TOWER_CRANE_STATE || path.join(path.dirname(repo.commonDir), '.tower-crane');
const original = S.loadState(stateDir);
const cacheRoot = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache', 'tower-crane');
fs.mkdirSync(cacheRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cacheRoot, 'hot-path-probe-'));
const run = Commands.execFileSync;
let gitCalls = 0;
Commands.execFileSync = (command, ...args) => {
  if (command === 'git') gitCalls++;
  return run(command, ...args);
};
try {
  fs.cpSync(path.join(stateDir, 'briefs'), path.join(scratch, 'briefs'), { recursive: true });
  const samples = [];
  // Separate cache population from three repeatable warm measurements.
  for (let i = 0; i < 4; i++) {
    const st = { ...original, dir: scratch, project: { ...original.project,
      hot_paths: ['docs/state.md', 'docs/state/*', 'docs/cli.md', 'bin/tower-crane.js', 'lib/automation.js'] } };
    const candidates = st.tasks.tasks.filter((t) => ['todo', 'rework'].includes(T.effectiveStatus(t, Date.now()))).map((t) => t.id);
    gitCalls = 0;
    const start = performance.now();
    Scope.prepareHotPaths(st, { candidates });
    const preparedMs = performance.now() - start;
    const viewStart = performance.now();
    const ready = T.readyTasks(st, Date.now()), blocked = T.blockedTasks(st, Date.now());
    samples.push({ prepared_ms: Math.round(preparedMs), views_ms: Math.round(performance.now() - viewStart),
      git_calls: gitCalls, ready: ready.length, blocked: blocked.length });
  }
  const warm = samples.slice(1).map((s) => s.prepared_ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ tasks: original.tasks.tasks.length, samples,
    warm_prepared_ms: { median: warm[1], min: warm[0], max: warm.at(-1) } }));
} finally {
  Commands.execFileSync = run;
  fs.rmSync(scratch, { recursive: true, force: true });
}
