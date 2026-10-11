'use strict';

const { ROOT, repo, task, submit, load, replay, fs, path, out } = require('./harness');
const { gateFixture } = require(`${ROOT}/test/gate-helpers`);
const T = require(`${ROOT}/lib/tasks`);
const C = require(`${ROOT}/lib/gates/common`);
const probes = [];

function probe(id, expected, fn, initialTests = true) {
  probes.push({ id, expected, async run() {
    const h = repo();
    try {
      h.sha = gateFixture(h);
      h.init(['--repo', 'acme/probe', '--base', 'main']);
      submit(h, task(h, 'code'), h.sha);
      if (initialTests) h.ok(['check', 'tests', 'T1']);
      const report = (type = 'tests') => {
        const st = h.snapshot();
        return T.gateReport(st.tasks.tasks[0], st.events, st).gates.find((g) => g.type === type);
      };
      return await fn(h, report);
    } finally { await h.cleanup(); }
  } });
}

probe('G01', 'Changing the pinned tests command invalidates its previous successful evidence.', (h, report) => {
  h.ok(['project', 'set', '--tests-cmd', 'node -e "process.exit(1)"']);
  const gate = report();
  return { held: !gate.ok, observed: gate };
});
probe('G02', 'Changing tests mode invalidates evidence under the old mode.', (h, report) => {
  h.ok(['project', 'set', '--tests-mode', 'run-only']);
  const gate = report();
  return { held: !gate.ok, observed: gate };
});
probe('G03', 'Changing tests.paths to exclude the regression invalidates its previous proof.', (h, report) => {
  h.ok(['project', 'set', '--tests-paths', '["elsewhere/**"]']);
  const beforeRerun = report();
  const rerun = h.run(['check', 'tests', 'T1']);
  return { held: !beforeRerun.ok, observed: { beforeRerun, rerun: out(rerun) } };
});
probe('G04', 'Removing a kept build file invalidates proof that passed with that file kept.', (h, report) => {
  h.ok(['project', 'set', '--tests-keep', '["value.js"]']);
  h.ok(['check', 'tests', 'T1']);
  h.ok(['project', 'set', '--tests-keep', '[]']);
  const beforeRerun = report();
  return { held: !beforeRerun.ok, observed: { beforeRerun, currentKeep: h.snapshot().project.tests.keep } };
}, false);
probe('G05', 'Enabling scoped expensive proof invalidates evidence that never ran that proof.', (h, report) => {
  h.ok(['project', 'set', '--tests-expensive', 'true']);
  const beforeRerun = report();
  const rerun = h.run(['check', 'tests', 'T1']);
  return { held: !beforeRerun.ok, observed: { beforeRerun, rerun: out(rerun) } };
});
probe('G06', 'Changing the cleanup command invalidates the old cleanup pass.', (h, report) => {
  h.ok(['check', 'clean', 'T1']);
  h.ok(['project', 'set', '--clean-cmd', 'node new-scanner.js']);
  const gate = report('clean');
  return { held: !gate.ok, observed: gate };
}, false);
probe('G07', 'Changing hosted CI requirements invalidates the old CI pass.', (h, report) => {
  h.ok(['submit', 'T1', '--sha', h.sha, '--pr', '7', '--agent', 'worker-T1']);
  h.ok(['check', 'ci', 'T1']);
  h.ok(['project', 'set', '--ci-required', '["new-required-check"]']);
  const gate = report('ci');
  return { held: !gate.ok, observed: gate };
}, false);
probe('G08', 'A real short gate timeout reports infrastructure failure without naming cut-off tests as failures (T140).', async (h) => {
  const script = path.join(h.base, 'timeout.js');
  fs.writeFileSync(script, `process.on('SIGTERM', () => {
  console.log('not ok 1 - still-running-at-cutoff');
  process.exit(0);
});
setInterval(() => {}, 1000);\n`);
  h.ok(['project', 'set', '--tests-mode', 'run-only', '--tests-cmd', `${C.shellQuote(process.execPath)} ${C.shellQuote(script)}`]);
  const st = h.snapshot();
  const entry = await require(`${ROOT}/lib/gates/tests`).run({
    root: h.repo, project: st.project, task: st.tasks.tasks[0], args: { timeout: 0.05 },
  });
  return { held: !entry.ok && !entry.test_failure?.names?.length && !entry.confirmed_failure,
    observed: { ok: entry.ok, summary: entry.summary, testFailure: entry.test_failure, confirmedFailure: entry.confirmed_failure || false } };
}, false);
probe('G09', 'The default tests gate budget is 20 minutes in this checkout (T140).', async (h) => {
  const seen = [];
  const gate = load('lib/gates/tests.js', [], { './common': { ...C,
    shell: async (_ctx, _cmd, opts) => { seen.push(opts.timeout); return { ok: true, status: 0 }; },
  } });
  const st = h.snapshot();
  st.project.tests = { ...st.project.tests, mode: 'run-only' };
  const r = await gate.run({ root: h.repo, project: st.project, task: st.tasks.tasks[0] });
  return { verdict: r.ok && seen[0] === 1200000 ? 'by design' : 'CONFIRMED',
    observed: { ok: r.ok, timeoutMilliseconds: seen } };
}, false);
probe('G10', 'A timeout during the merged-head check keeps the task accepted and reports infrastructure failure (T140).', async (h) => {
  h.git(['switch', 'main']);
  fs.writeFileSync(path.join(h.repo, 'base-update.txt'), 'base moved\n');
  h.git(['add', 'base-update.txt']);
  h.git(['commit', '-qm', 'move base']);
  h.git(['switch', 'fixture-change']);
  const r = replay(h.snapshot());
  const t = r.st.tasks.tasks[0];
  Object.assign(t, { status: 'accepted', pr: 7 });
  const reworks = [];
  const budgets = [];
  const a = load('lib/automation.js', ['headCheck'], {
    './state': r.state,
    './tasks': { ...T, rework: (ctx) => { reworks.push(ctx.flags.reason); t.status = 'rework'; } },
    './gates/common': { ...C, shell: async (_ctx, _cmd, opts) => {
      budgets.push(opts.timeout);
      return { ok: false, status: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '',
        error: Object.assign(new Error('timed out after 1200000 ms'), { code: 'ETIMEDOUT' }) };
    } },
  });
  const result = await a.headCheck(r.ctx, r.st, { members: [t], target: t }, new Map());
  if (budgets.length !== 1) throw new Error('probe did not reach the merged-head shell');
  return { held: t.status === 'accepted' && reworks.length === 0,
    observed: { result, taskStatus: t.status, reworks, budgets } };
}, false);
probe('G11', 'Increasing executor capacity leaves tests evidence valid because it does not change the test contract.', (h, report) => {
  h.ok(['project', 'set', '--executors', '3']);
  const gate = report();
  return { held: gate.ok, observed: gate };
});
probe('G12', 'Unchanged command and mode keep evidence valid.', (h, report) => {
  h.ok(['project', 'set', '--tests-cmd', 'node test/value.test.js', '--tests-mode', 'prove']);
  const gate = report();
  return { held: gate.ok, observed: gate };
});

module.exports = probes;
