#!/usr/bin/env node
'use strict';

// Plants each bug below in a scratch copy of the repository and runs the test
// files named for it; a mutant is caught when that run fails. A mutant the
// named files miss is run against the whole suite before it counts as missed,
// so the score is the suite's, and the file lists only make it cheap.
//
//   node scripts/mutants.js [--root DIR] [--jobs 4] [--only ID,ID] [--no-full] [--skip PATTERN]
//
// --skip passes --test-skip-pattern to every run, for a test the current
// environment cannot run, such as a nested git push inside an agent's sandbox.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// from must occur exactly once in file. tests are the files expected to catch it.
const MUTANTS = [
  // gates
  { id: 'tests-pass-without-change', area: 'gates', file: 'lib/gates/tests.js',
    from: 'if (without.ok) {', to: 'if (false) {', tests: ['test/gates/tests.test.js'] },
  { id: 'tests-deleted-test-counts', area: 'gates', file: 'lib/gates/tests.js',
    from: "isTest(f.path) && f.status !== 'D'", to: 'isTest(f.path)', tests: ['test/gates/tests.test.js'] },
  { id: 'ci-cancelled-is-green', area: 'gates', file: 'lib/gates/ci.js',
    from: "new Set(['success', 'neutral', 'skipped'])", to: "new Set(['success', 'neutral', 'skipped', 'cancelled'])", tests: ['test/gates/ci.test.js'] },
  { id: 'clean-high-passes', area: 'gates', file: 'lib/gates/clean.js',
    from: 'res(high.length === 0 && gaps.length === 0,', to: 'res(gaps.length === 0,', tests: ['test/gates/clean.test.js'] },
  { id: 'sources-loopback-public', area: 'gates', file: 'lib/public-http.js',
    from: "['127.0.0.0', 8],", to: '', tests: ['test/sources.test.js'] },
  { id: 'evidence-without-audit', area: 'gates', file: 'lib/tasks.js',
    from: "independentReviewer(task, entry, events) : hasGateEvent(task, entry, events)", to: 'independentReviewer(task, entry, events) : true', tests: ['test/evidence.test.js'] },
  { id: 'review-by-submitter', area: 'gates', file: 'lib/tasks.js',
    from: "entry.type === 'review' ? independentReviewer(task, entry, events) :", to: "entry.type === 'review' ? true :", tests: ['test/accept.test.js'] },
  { id: 'evidence-old-revision', area: 'gates', file: 'lib/tasks.js',
    from: 'e.type === type && e.revision === task.revision\n', to: 'e.type === type\n', tests: ['test/accept.test.js'] },
  // authority
  { id: 'spawned-agent-is-orchestrator', area: 'authority', file: 'lib/authority.js',
    from: "if (jobs.length) return jobs.every((role) => role === 'orchestrator');", to: 'if (jobs.length) return true;', tests: ['test/authority.test.js'] },
  { id: 'brokered-command-has-authority', area: 'authority', file: 'lib/authority.js',
    from: 'if (broker && isOrchestrator(identity, events)) return null;', to: '', tests: ['test/authority.test.js', 'test/broker.test.js'] },
  { id: 'orchestrator-makes-owner-changes', area: 'authority', file: 'lib/authority.js',
    from: "if (who === 'owner' || (who === 'orchestrator' && !owner.length)) {", to: "if (who === 'owner' || who === 'orchestrator') {", tests: ['test/authority.test.js'] },
  { id: 'tagged-question-grants-approval', area: 'authority', file: 'lib/authority.js',
    from: 'd.approval_request === true && d.escalation', to: 'd.escalation', tests: ['test/control-modes.test.js'] },
  { id: 'owner-write-keeps-approval', area: 'authority', file: 'lib/authority.js',
    from: "if (who === 'owner' && !keep) {", to: 'if (false) {', tests: ['test/control-modes.test.js'] },
  { id: 'owner-budget-write-keeps-raise-approval', area: 'authority', file: 'lib/project.js',
    from: "settings.map((key) => key === 'budget.lower' ? 'budget.raise' : key)", to: 'settings', tests: ['test/control-modes.test.js'] },
  { id: 'owner-budget-hides-other-approval', area: 'authority', file: 'lib/authority.js',
    from: 'applyOwner(ctx, st, owner, change, emit);', to: '', tests: ['test/approval-context.test.js'] },
  { id: 'owner-extra-settings-keep-approval', area: 'authority', file: 'lib/authority.js',
    from: 'd.escalation.settings.every(key => owner.includes(key))', to: 'isDeepStrictEqual(d.escalation.settings, owner)', tests: ['test/control-modes.test.js'] },
  { id: 'owner-extra-fields-keep-approval', area: 'authority', file: 'lib/authority.js',
    from: 'return Object.entries(requested).every(([key, value]) => {', to: 'return isDeepStrictEqual(requested, written) && Object.entries(requested).every(([key, value]) => {', tests: ['test/control-modes.test.js'] },
  { id: 'owner-json-format-keeps-approval', area: 'authority', file: 'lib/authority.js',
    from: "if (project && key !== 'env_file') {", to: 'if (false) {', tests: ['test/control-modes.test.js'] },
  { id: 'owner-fallback-delta-keeps-approval', area: 'authority', file: 'lib/project.js',
    from: "const ownerWrite = { settings: [...L.FIELDS.map(fieldSetting), 'ladder.reach'], change };", to: 'const ownerWrite = null;', tests: ['test/control-rework.test.js'] },
  { id: 'owner-primary-delta-keeps-approval', area: 'authority', file: 'lib/project.js',
    from: 'const ownerWrite = ladderOwnerWrite(p, ctx.env, changes, rungs, fields);', to: 'const ownerWrite = null;', tests: ['test/approval-context.test.js'] },
  { id: 'owner-kind-write-keeps-approval', area: 'authority', file: 'lib/tasks.js',
    from: "...(f.kind !== undefined ? ['task.downgrade'] : []),", to: '...[],', tests: ['test/approval-context.test.js'] },
  { id: 'owner-cancellation-keeps-approval', area: 'authority', file: 'lib/tasks.js',
    from: "...(f.status === 'cancelled' ? ['task.cancel_needs_owner'] : []),", to: '...[],', tests: ['test/approval-context.test.js'] },
  { id: 'owner-unchanged-write-keeps-approval', area: 'authority', file: 'lib/authority.js',
    from: 'const refused = keys.find((k) => classOf(k) === REFUSED);', to: 'if (!keys.length) return who;\n  const refused = keys.find((k) => classOf(k) === REFUSED);', tests: ['test/approval-context.test.js'] },
  { id: 'owner-reach-facts-must-equal', area: 'authority', file: 'lib/authority.js',
    from: 'value.every(grant => written[key].some(actual => isDeepStrictEqual(grant, actual)))', to: 'isDeepStrictEqual(value, written[key])', tests: ['test/approval-context.test.js'] },
  { id: 'owner-review-class-keeps-approval', area: 'authority', file: 'lib/tasks.js',
    from: "Authority.applyOwner(ctx, st, settings.map(key => key === 'waive.review' ? 'waive.review_live' : key), change, emit);", to: '', tests: ['test/approval-context.test.js'] },
  { id: 'waiver-request-omits-revision', area: 'authority', file: 'lib/tasks.js',
    from: 'revision: t.revision, waive, reason: f.reason.trim()', to: 'waive, reason: f.reason.trim()', tests: ['test/approval-context.test.js'] },
  { id: 'waiver-proof-ignores-revision', area: 'authority', file: 'lib/authority.js',
    from: 'Number.isInteger(revision) && revision > 0 && change.revision === revision', to: 'true', tests: ['test/approval-context.test.js'] },
  { id: 'release-approval-ignores-claim-instance', area: 'authority', file: 'lib/tasks.js',
    from: 'holder: t.claim.agent, claim_since: t.claim.since', to: 'holder: t.claim.agent', tests: ['test/approval-context.test.js'] },
  { id: 'browser-kit-approval-ignores-file', area: 'authority', file: 'lib/browser-kit.js',
    from: 'change: { user_file: file, servers: names }', to: 'change: { servers: names }', tests: ['test/approval-context.test.js'] },
  { id: 'personal-fallback-borrows-primary-grants', area: 'authority', file: 'lib/project.js',
    from: 'const previous = personalPolicyRoutes(name, oldRoutes, ctx.env);', to: "const previous = projectPolicyRoutes(st.project, ctx.env).map(entry => ({ ...entry, binding: 'explicit' }));", tests: ['test/personal-authority.test.js'] },
  { id: 'personal-fallback-ignores-harness-binding', area: 'authority', file: 'lib/project.js',
    from: "binding: route.harness ? 'explicit' : 'inherited'", to: "binding: 'explicit'", tests: ['test/personal-authority.test.js'] },
  { id: 'personal-fallback-checks-one-harness', area: 'authority', file: 'lib/project.js',
    from: 'const harnesses = route.harness ? [route.harness] : L.HARNESSES;', to: "const harnesses = [route.harness || 'claude'];", tests: ['test/personal-authority.test.js'] },
  { id: 'budget-clear-rejected-by-parser', area: 'authority', file: 'bin/tower-crane.js',
    from: "if (spec.nullable && raw === 'null') return null;", to: '', tests: ['test/personal-authority.test.js'] },
  { id: 'task-budget-write-retires-project-approval', area: 'authority', file: 'lib/authority.js',
    from: "if (container === 'change' && Object.hasOwn(requested, 'task') !== Object.hasOwn(written, 'task')) return false;", to: '', tests: ['test/personal-authority.test.js'] },
  { id: 'budget-alert-reuses-setting-approval', area: 'authority', file: 'lib/authority.js',
    from: "d.approval_request !== true && d.status === 'open' && d.escalation", to: "d.status === 'open' && d.escalation", tests: ['test/personal-authority.test.js'] },
  { id: 'authority-without-audit-emitter', area: 'authority', file: 'lib/authority.js',
    from: 'if (st && (keys.length || ownerWrite) && !emit && !quiet) {', to: 'if (false) {', tests: ['test/approval-context.test.js'] },
  { id: 'board-range-removal-without-audit', area: 'authority', file: 'lib/tasks.js',
    from: 't.tier !== tiers[t.id] || t.tier_range', to: 't.tier !== tiers[t.id]', tests: ['test/control-modes.test.js'] },
  { id: 'generated-delegation-not-consumed', area: 'authority', file: 'lib/spawn.js',
    from: "delegation && Auth.role(ctx, st.events) === 'orchestrator'", to: "delegation && Auth.actor(ctx, st.events) === 'orchestrator'", tests: ['test/control-rework.test.js'] },
  { id: 'mixed-waiver-tags-operational', area: 'authority', file: 'lib/tasks.js',
    from: 'approved && Authority.classOf(settings[i]) === Authority.OWNER', to: 'approved', tests: ['test/control-rework.test.js'] },
  { id: 'interrupt-without-setting-audit', area: 'authority', file: 'lib/tasks.js',
    from: "Authority.enforce(ctx, st, ['task.interrupt'], { emit: audit ? emit : null, quiet: !audit });", to: "Authority.enforce(ctx, st, ['task.interrupt'], { quiet: true });", tests: ['test/control-rework.test.js'] },
  { id: 'decision-delegation-without-enforcement', area: 'authority', file: 'lib/decisions.js',
    from: "Authority.enforce(ctx, st, ['decision.delegate'], { change, emit, commit });", to: '', tests: ['test/control-rework.test.js'] },
  { id: 'fallback-route-grants-operational', area: 'authority', file: 'lib/project.js',
    from: '[...settings, ...reach.settings, ...unconfined.settings]', to: "['ladder.fallbacks']", tests: ['test/control-rework.test.js'] },
  { id: 'fallback-overwrites-user-primary', area: 'authority', file: 'lib/project.js',
    from: 'const rung = { ...next.ladder[name] };', to: 'const rung = {};', tests: ['test/control-rework.test.js'] },
  { id: 'terminal-fallback-is-owner', area: 'authority', file: 'lib/authority.js',
    from: "if (!ctx.agentExplicit || typeof ctx.agent !== 'string' || !ctx.agent.trim()) return null;", to: "if (typeof ctx.agent !== 'string' || !ctx.agent.trim()) return null;", tests: ['test/identity.test.js'] },
  // broker
  { id: 'broker-any-command', area: 'broker', file: 'lib/broker.js',
    from: 'if (!allowed.includes(cmd.name)) {', to: 'if (false) {', tests: ['test/broker.test.js'] },
  { id: 'broker-other-task', area: 'broker', file: 'lib/broker.js',
    from: 'for (const id of ids) if (id !== job.task) throw', to: 'for (const id of ids) if (false) throw', tests: ['test/broker.test.js'] },
  { id: 'broker-no-token', area: 'broker', file: 'lib/broker.js',
    from: 'if (!req || !sameToken(req.token, token))', to: 'if (!req)', tests: ['test/broker.test.js'] },
  // spawn and supervisor
  { id: 'supervisor-writes-after-incompatible-state', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "if (committed && !incompatible && fs.existsSync(path.join(spawn.state, 'project.json'))) sampleUsage(true);",
    to: "if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) sampleUsage(true);", tests: ['test/state-compatibility.test.js'] },
  { id: 'supervisor-retries-permanent-exit', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: '  if (code === 0) return false;\n  return providerError;', to: '  if (code === 0) return false;\n  return true;', tests: ['test/supervision.test.js'] },
  { id: 'supervisor-extra-retry', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'retryable && attempt < config.retries && (canResume || freshRetry)', to: 'retryable && attempt <= config.retries && (canResume || freshRetry)', tests: ['test/supervision.test.js'] },
  { id: 'supervisor-ignores-cpu', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'if (signature !== stamp || ticks !== null && ticks !== cpu) {', to: 'if (signature !== stamp) {', tests: ['test/supervision.test.js'] },
  { id: 'workers-limit-off-by-one', area: 'spawn/supervisor', file: 'lib/tasks.js',
    from: 'if (holders.length >= st.project.limits.workers) {', to: 'if (holders.length > st.project.limits.workers) {', tests: ['test/claim.test.js', 'test/worker-slots.test.js'] },
  { id: 'expired-renewal-skips-readiness', area: 'spawn/supervisor', file: 'lib/tasks.js',
    from: 'if (leaseExpired(t, now)) checkReady(', to: 'if (leaseExpired(t, now)) checkWorkers(', tests: ['test/claim.test.js'] },
  { id: 'worker-starts-before-lease', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "const gated = initial && spawn.role === 'worker' && process.platform !== 'win32';", to: 'const gated = false;', tests: ['test/supervision.test.js'] },
  { id: 'spawn-ignores-live-reservation', area: 'spawn/supervisor', file: 'lib/spawn.js',
    from: 'if (held.length) throw refuse(', to: 'if (false) throw refuse(', tests: ['test/worker-slots.test.js'] },
  { id: 'spawn-counts-dead-reservation-first', area: 'spawn/supervisor', file: 'lib/spawn.js',
    from: "if (!f['dry-run'] && p.job === 'worker' && T.reservations(p.st, Date.now()).some((r) => reservationGone(r.proc))) {", to: 'if (false) {', tests: ['test/worker-slots.test.js'] },
  { id: 'supervisor-stop-trusts-exit-code', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'const stopped = !!stopReason || !!budgetStop || stalled || harnessRefusal || exit.code !== 0;', to: 'const stopped = harnessRefusal || exit.code !== 0;', tests: ['test/supervision.test.js'] },
  { id: 'group-probe-clears-live-group', area: 'spawn/supervisor', file: 'lib/processes.js',
    from: "try { process.kill(-pgid, 0); return 'unknown'; }", to: "try { process.kill(-pgid, 0); return 'exited'; }", tests: ['test/worker-slots.test.js'] },
  { id: 'startup-window-silent', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "stopReason = `${awaitingLease ? 'no lease: ' : ''}its spawn was not recorded", to: 'stopReason = `its spawn was not recorded', tests: ['test/supervision.test.js'] },
  { id: 'claim-hook-skips-undispatched-refresh', area: 'spawn/supervisor', file: 'lib/tasks.js',
    from: 'const dispatched = !!ctx.env.TOWER_CRANE_HOOK && ctx.env.TOWER_CRANE_TASK === ctx.pos[0] && ctx.env.TOWER_CRANE_AGENT === ctx.agent;',
    to: 'const dispatched = !!ctx.env.TOWER_CRANE_HOOK;', tests: ['test/stack.test.js'] },
  // state lock
  { id: 'lock-breaks-live-holder', area: 'state lock', file: 'lib/state.js',
    from: '    if (!lockIsStale(marker)) {', to: '    if (false) {', tests: ['test/lock.test.js'] },
  { id: 'lock-ignores-pid-namespace', area: 'state lock', file: 'lib/state.js',
    from: '(pidns ?? null) === pidNamespace() && Number.isInteger(pid)', to: 'Number.isInteger(pid)', tests: ['test/lock.test.js'] },
  { id: 'lock-never-ages-out', area: 'state lock', file: 'lib/state.js',
    from: 'const LOCK_STALE_MS = 60000;', to: 'const LOCK_STALE_MS = 6000000;', tests: ['test/lock.test.js'] },
  // merge and stacks
  { id: 'merge-moved-head', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "  if (!sameSha(head, sha)) {\n    return res(false, `PR head moved", to: "  if (false) {\n    return res(false, `PR head moved", tests: ['test/gates/merge.test.js'] },
  { id: 'merge-stack-refusal-no-fallback', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "if (!m.ok && method !== 'rebase' && ASYNC_ONLY.test(", to: "if (!m.ok && method !== 'rebase' && false && ASYNC_ONLY.test(", tests: ['test/merge-options.test.js'] },
  { id: 'merge-async-fallback-rebase', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "if (!m.ok && method !== 'rebase' && ASYNC_ONLY.test(", to: "if (!m.ok && ASYNC_ONLY.test(", tests: ['test/merge-options.test.js'] },
  { id: 'merge-async-fallback-no-delete', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "const deleted = project.merge?.keep_branch ? '' : await deleteBranch(", to: "const deleted = '' && await deleteBranch(", tests: ['test/merge-options.test.js'] },
  { id: 'merge-async-fallback-admin-dropped', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "if (project.merge?.admin === true) return res(false, `gh pr merge refused PR #${pr}: it is part", to: "if (false) return res(false, `gh pr merge refused PR #${pr}: it is part", tests: ['test/merge-options.test.js'] },
  { id: 'stack-merge-unaccepted-lower', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "if (t.status !== 'accepted' || (!ctx.mergedIds", to: 'if ((!ctx.mergedIds', tests: ['test/stack-merge.test.js'] },
  { id: 'stack-merge-untracked-lower', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: 'if (lower.some((pr) => !known.includes(pr)))', to: 'if (false)', tests: ['test/stack-merge.test.js'] },
  { id: 'stack-merge-admin', area: 'merge/stacks', file: 'lib/gates/merge.js',
    from: "if (ctx.args?.admin || project.merge?.admin === true) return fail('stack merges cannot use --admin;", to: "if (false) return fail('stack merges cannot use --admin;", tests: ['test/stack-merge.test.js'] },
  { id: 'merge-confirm-skips-sync', area: 'merge/stacks', file: 'lib/check.js',
    from: "if (name === 'merge' && !result.confirmOnly && ", to: "if (name === 'merge' && ", tests: ['test/stack-merge.test.js'] },
  { id: 'merge-confirm-before-gates', area: 'merge/stacks', file: 'lib/check.js',
    from: "if (typeof gate.confirm === 'function') {", to: 'if (false) {', tests: ['test/stack-merge.test.js'] },
  // secrets
  { id: 'codex-config-keeps-secrets', area: 'secrets', file: 'lib/agents.js',
    from: 'out.model_providers = keepTables(doc.model_providers, PROVIDER_FIELDS);', to: 'out.model_providers = doc.model_providers;', tests: ['test/isolation.test.js'] },
  { id: 'env-file-error-echoes', area: 'secrets', file: 'lib/spawn-settings.js',
    from: 'throw refuse(`invalid env_file ${file} at line ${assignmentLine}`);', to: 'throw refuse(`invalid env_file ${file} at line ${assignmentLine}: ${text}`);', tests: ['test/sandbox-extensions.test.js'] },
  // board
  { id: 'board-unescaped-lt', area: 'board', file: 'lib/board/view.js',
    from: ".replace(/</g, '&lt;')", to: '', tests: ['test/board.test.js'] },
  { id: 'serve-no-page-token', area: 'board', file: 'lib/serve.js',
    from: "if (!same(req.headers['x-tower-crane-token'], token)) {", to: 'if (false) {', tests: ['test/settings.test.js'] },
  { id: 'serve-anyone-owner', area: 'board', file: 'lib/serve.js',
    from: "const canWriteOwner = ctx.agent === 'owner' && ctx.agentExplicit;", to: 'const canWriteOwner = true;', tests: ['test/events.test.js'] },
];

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const jobs = Number(opt('--jobs', '4'));
const only = opt('--only', null)?.split(',');
const full = !args.includes('--no-full');
const skip = opt('--skip', null);
const root = path.resolve(opt('--root', path.join(__dirname, '..')));
const selected = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
if (!selected.length || only?.some((id) => !MUTANTS.some((m) => m.id === id))) throw new Error('unknown or empty mutation selection');

const scratchRoot = process.env.TOWER_CRANE_TEST_TMP || os.tmpdir();
fs.mkdirSync(scratchRoot, { recursive: true });
const copy = fs.mkdtempSync(path.join(scratchRoot, 'tower-crane-mutants-'));
// The repository's runner, so each test has its timeout and a hung run ends.
function runTests(files) {
  const r = cp.spawnSync(process.execPath, ['test/run.js', `--test-concurrency=${jobs}`, ...(skip ? [`--test-skip-pattern=${skip}`] : []), ...files], {
    cwd: copy, encoding: 'utf8', env: process.env, maxBuffer: 1 << 28, timeout: 60 * 60 * 1000,
  });
  if (r.status !== 0) runTests.failures = `${r.error?.message || ''}\n${r.stdout || ''}\n${r.stderr || ''}`.slice(-8192);
  return r.status === 0;
}

const allFiles = () => require(path.join(copy, 'test', 'run.js')).testFiles();

let caught = 0;
try {
  // Include test inputs outside the npm package, without local state or caches.
  const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  for (const file of new Set(files.split('\0').filter(Boolean))) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.cpSync(source, path.join(copy, file), { recursive: true });
  }
  for (const m of selected) {
    if (fs.readFileSync(path.join(copy, m.file), 'utf8').split(m.from).length !== 2) {
      throw new Error(`${m.id}: the text to mutate must occur once in ${m.file}`);
    }
  }
  // A file that fails unmutated would count every mutant as caught.
  const named = [...new Set(selected.flatMap((m) => m.tests))];
  if (!runTests(named)) throw new Error(`the unmutated tests fail:\n${runTests.failures}`);
  let fullValidated = false;
  for (const m of selected) {
    const file = path.join(copy, m.file);
    const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, source.replace(m.from, m.to));
    let by = null;
    try {
      if (!runTests(m.tests)) by = m.tests.join(', ');
      else if (full) {
        if (!fullValidated) {
          fs.writeFileSync(file, source);
          if (!runTests(allFiles())) throw new Error(`the unmutated full suite fails:\n${runTests.failures}`);
          fullValidated = true;
          fs.writeFileSync(file, source.replace(m.from, m.to));
        }
        if (!runTests(allFiles())) by = 'full suite';
      }
    } finally {
      fs.writeFileSync(file, source);
    }
    if (by) caught++;
    console.log(`${by ? 'caught' : 'MISSED'}  ${m.area.padEnd(16)} ${m.id}${by ? ` (${by})` : ''}`);
  }
} finally {
  fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`\n${caught}/${selected.length} mutants caught`);
if (caught !== selected.length) process.exitCode = 1;
