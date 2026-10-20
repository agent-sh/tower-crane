#!/usr/bin/env node
'use strict';

// Plants each bug below in a scratch copy of the repository and runs the test
// files named for it; a mutant is caught when that run fails. A mutant the
// named files miss is run against the suite before it counts as missed, except
// for the pristine-anchor check, which cannot score a deliberately planted bug.
//
//   node scripts/mutants.js [--root DIR] [--jobs 4] [--only ID,ID] [--no-full] [--skip PATTERN] [--process-limit N]
//   node scripts/mutants.js --check [--root DIR] [--only ID,ID]
//
// --skip passes --test-skip-pattern to every run, for a test the current
// environment cannot run, such as a nested git push inside an agent's sandbox.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readText } = require('./text');

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
  { id: 'release-keeps-previous-sha', area: 'tasks', file: 'lib/tasks.js',
    from: 'if (t.pr && t.pr !== pr) t.sha = null;', to: '', tests: ['test/decision-resume.test.js'] },
  { id: 'browser-kit-approval-ignores-file', area: 'authority', file: 'lib/browser-kit.js',
    from: 'change: { user_file: file, servers: names }', to: 'change: { servers: names }', tests: ['test/approval-context.test.js'] },
  { id: 'personal-fallback-borrows-primary-grants', area: 'authority', file: 'lib/project.js',
    from: 'const previous = personalPolicyRoutes(name, RouteGrants.approvedRoutes(st.project, file, name, oldRoutes, oldHarnesses, base), ctx.env);', to: "const previous = projectPolicyRoutes(st.project, ctx.env).map(entry => ({ ...entry, binding: 'explicit' }));", tests: ['test/personal-authority.test.js'] },
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
    from: "delegation && (Auth.role(ctx, st.events) === 'orchestrator' ||", to: "delegation && (Auth.actor(ctx, st.events) === 'orchestrator' ||", tests: ['test/control-rework.test.js'] },
  { id: 'mixed-waiver-tags-operational', area: 'authority', file: 'lib/tasks.js',
    from: 'approved && Authority.classOf(settings[i]) === Authority.OWNER', to: 'approved', tests: ['test/control-rework.test.js'] },
  { id: 'interrupt-without-setting-audit', area: 'authority', file: 'lib/tasks.js',
    from: 'Authority.enforce(ctx, st, settings, { emit: audit ? emit : null, quiet: !audit });', to: 'Authority.enforce(ctx, st, settings, { quiet: true });', tests: ['test/control-rework.test.js'] },
  { id: 'decision-delegation-without-enforcement', area: 'authority', file: 'lib/decisions.js',
    from: "Authority.enforce(ctx, st, ['decision.delegate'], { change, emit, commit });", to: '', tests: ['test/control-rework.test.js'] },
  { id: 'technical-delegation-defaults-off', area: 'authority', file: 'lib/decisions.js',
    from: 'st.project.decision_delegation?.orchestrator_technical !== false;', to: 'st.project.decision_delegation?.orchestrator_technical === true;', tests: ['test/decision-access.test.js'] },
  { id: 'owner-required-decision-open-to-orchestrator', area: 'authority', file: 'lib/decisions.js',
    from: 'if (ownerOnly && !owner) throw', to: 'if (decision.escalation && !owner) throw', tests: ['test/decision-access.test.js'] },
  { id: 'spend-kind-answerable-by-orchestrator', area: 'authority', file: 'lib/decisions.js',
    from: "if (decision.kind && decision.kind !== 'technical' && decision.technical !== true) return", to: 'if (false) return', tests: ['test/decision-access.test.js'] },
  { id: 'kind-ignored-for-technical-default', area: 'authority', file: 'lib/decisions.js',
    from: "technical: fields.technical ?? (kind === 'technical' && !(fields.escalation || ownerReason)),", to: 'technical: fields.technical ?? true,', tests: ['test/decision-access.test.js'] },
  { id: 'legacy-open-decision-owner-only', area: 'authority', file: 'lib/decisions.js',
    from: 'return decision.kind ? decision.technical === true : true;', to: 'return decision.technical === true;', tests: ['test/decision-access.test.js'] },
  { id: 'owner-only-decision-names-answerers', area: 'authority', file: 'lib/decisions.js',
    from: 'if (answerers !== undefined && answerers.length && ownerOnlyWhy(d)) {', to: 'if (false) {', tests: ['test/decision-access.test.js'] },
  { id: 'owner-lift-clears-escalation', area: 'authority', file: 'lib/decisions.js',
    from: 'if (technical) d.owner_required = null;', to: 'if (technical) d.owner_required = null, d.escalation = null;', tests: ['test/decision-access.test.js'] },
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
  { id: 'sandboxed-worktree-takes-lock', area: 'broker', file: 'lib/worktree.js',
    from: "const sandboxed = !!ctx.env?.TOWER_CRANE_BROKER && require('./broker').serves(ctx.env.TOWER_CRANE_BROKER, ctx.stateDir);", to: 'const sandboxed = false;', tests: ['test/broker.test.js'] },
  { id: 'sandboxed-worktree-any-state', area: 'broker', file: 'lib/worktree.js',
    from: "const sandboxed = !!ctx.env?.TOWER_CRANE_BROKER && require('./broker').serves(ctx.env.TOWER_CRANE_BROKER, ctx.stateDir);", to: 'const sandboxed = !!ctx.env?.TOWER_CRANE_BROKER;', tests: ['test/broker.test.js'] },
  { id: 'orphan-removal-skips-reservation', area: 'worktrees', file: 'lib/worktree.js',
    from: 'markOrphanRetiring(ctx, hit, outcome.reservation_id);', to: '', tests: ['test/worktree-lifecycle.test.js'] },
  // host-only tests
  { id: 'sandbox-runs-directory-selection', area: 'host-only tests', file: 'lib/tests-host-only.js',
    from: 'const refused = files.filter((file) => !isFile(path.resolve(root, file)));', to: 'const refused = [];', tests: ['test/host-only.test.js'] },
  // spawn and supervisor
  { id: 'supervisor-writes-after-incompatible-state', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "if (committed && !incompatible && S.fileExists(path.join(spawn.state, 'project.json'))) sampleUsage(true);",
    to: "if (committed && S.fileExists(path.join(spawn.state, 'project.json'))) sampleUsage(true);", tests: ['test/state-compatibility.test.js'] },
  { id: 'spawn-moves-live-agent-log', area: 'spawn/supervisor', file: 'lib/spawn.js',
    from: '  if (live) return false;\n', to: '', tests: ['test/spawn-resume.test.js'] },
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
    from: "const gated = initial && spawn.role === 'worker' && !spawn.body_fix && !spawn.handshake;", to: 'const gated = false;', tests: ['test/supervision.test.js'] },
  { id: 'handshake-launches-before-go', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'while (!fs.existsSync(spawn.handshake.go)) {', to: 'while (false) {', tests: ['test/supervision.test.js'] },
  { id: 'spawn-ignores-live-reservation', area: 'spawn/supervisor', file: 'lib/spawn.js',
    from: 'if (held.length) throw refuse(', to: 'if (false) throw refuse(', tests: ['test/worker-slots.test.js'] },
  { id: 'spawn-counts-dead-reservation-first', area: 'spawn/supervisor', file: 'lib/spawn.js',
    from: "if (!f['dry-run'] && p.job === 'worker' && clearDeadReservations(ctx)) p = prepare(ctx);", to: 'if (false) p = prepare(ctx);', tests: ['test/worker-slots.test.js'] },
  { id: 'batch-counts-dead-reservation-first', area: 'spawn/supervisor', file: 'lib/actions.js',
    from: "if (!ctx.flags['dry-run'] && require('./spawn').clearDeadReservations(ctx)) st = S.loadState(ctx.stateDir);", to: '', tests: ['test/worker-slots.test.js'] },
  { id: 'incompatible-gate-waits-for-stdin', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'if (awaitingLease && !exit) {\n              awaitingLease = false;\n              terminateGroup(child);', to: 'if (false) {', tests: ['test/supervision.test.js'] },
  { id: 'supervisor-stop-trusts-exit-code', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'const stopped = !!stopReason || !!budgetStop || stalled || contextOverflow || harnessRefusal || loginFailed || exit.code !== 0;', to: 'const stopped = harnessRefusal || loginFailed || exit.code !== 0;', tests: ['test/supervision.test.js'] },
  { id: 'clean-exit-clears-any-pause', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: 'if (!stopped && spawn.probe && Health.probed(currentState, spawn.harness, spawn.probe)) Health.cleared', to: 'if (!stopped && Health.paused(currentState, spawn.harness)) Health.cleared', tests: ['test/harness-auth.test.js'] },
  { id: 'login-check-clears-superseded-pause', area: 'spawn/supervisor', file: 'lib/harness-health.js',
    from: 'if (!probed(current, harness, token)) return;', to: '', tests: ['test/harness-auth.test.js'] },
  { id: 'group-probe-clears-live-group', area: 'spawn/supervisor', file: 'lib/processes.js',
    from: "try { process.kill(-pgid, 0); return 'unknown'; }", to: "try { process.kill(-pgid, 0); return 'exited'; }", tests: ['test/worker-slots.test.js'] },
  { id: 'startup-window-silent', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "stopReason = `${awaitingLease ? 'no lease: ' : ''}its spawn was not recorded", to: 'stopReason = `its spawn was not recorded', tests: ['test/supervision.test.js'] },
  { id: 'refused-lease-silent', area: 'spawn/supervisor', file: 'lib/spawn-monitor.js',
    from: "stopReason = `no lease: ${e.message}`;\n        process.stderr.write(`tower-crane: ${stopReason}\\n`);", to: 'stopReason = `no lease: ${e.message}`;', tests: ['test/supervision.test.js'] },
  { id: 'claim-hook-skips-undispatched-refresh', area: 'spawn/supervisor', file: 'lib/tasks.js',
    from: 'const dispatched = !!ctx.env.TOWER_CRANE_HOOK && ctx.env.TOWER_CRANE_TASK === ctx.pos[0] && ctx.env.TOWER_CRANE_AGENT === ctx.agent;',
    to: 'const dispatched = !!ctx.env.TOWER_CRANE_HOOK;', tests: ['test/stack.test.js'] },
  // state lock
  { id: 'lock-breaks-live-holder', area: 'state lock', file: 'lib/state.js',
    from: '    if (!releasedMarkers.has(file) && !lockIsStale(marker, keepLive)) {', to: '    if (false) {', tests: ['test/lock.test.js'] },
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
  // git shim
  { id: 'masked-merge-skip-worktree-dropped', area: 'git', file: 'lib/masked-merge.js',
    from: "'--skip-worktree', '--stdin'], { input: [...after.keys()]", to: "'--skip-worktree', '--stdin'], { input: []", tests: ['test/masked-merge.test.js'] },
  { id: 'masked-merge-never-plumbs', area: 'git', file: 'lib/masked-merge.js',
    from: 'if (refs.length !== 1) return null;', to: 'if (true) return null;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-merge-ignores-policy', area: 'git', file: 'lib/shim.js',
    from: "tool === 'git' && policy.masks && args[sub] === 'merge'", to: "tool === 'git' && args[sub] === 'merge'", tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-never-plumbs', area: 'git', file: 'lib/masked-merge.js',
    from: 'if (refs.length > 1 || (!refs.length && !create) || (create && !create.name)) return null;', to: 'if (true) return null;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-merge-runs-in-cwd', area: 'git', file: 'lib/masked-merge.js',
    from: 'const r = cp.spawnSync(real, [...rest, ...argv], { cwd, encoding', to: 'const r = cp.spawnSync(real, [...rest, ...argv], { encoding', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-merge-splits-every-tab', area: 'git', file: 'lib/masked-merge.js',
    from: 'return [line.slice(tab + 1), { mode, sha }];', to: "return [line.slice(tab + 1).split('\\t')[0], { mode, sha }];", tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-ignores-other-worktree', area: 'git', file: 'lib/masked-merge.js',
    from: 'const other = branch && checkedOutElsewhere(g, branch);', to: 'const other = null;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-skips-name-check', area: 'git', file: 'lib/masked-merge.js',
    from: 'if (create && !name) return fail(', to: 'if (false) return fail(', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-ignores-shorthand', area: 'git', file: 'lib/masked-merge.js',
    from: 'const name = branchName(g, create ? create.name : start);', to: 'const name = create ? create.name : start;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-takes-tag-over-branch', area: 'git', file: 'lib/masked-merge.js',
    from: '`${existing ? `refs/heads/${name}` : start}^{commit}`', to: '`${start}^{commit}`', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-checkout-reflog-not-git', area: 'git', file: 'lib/masked-merge.js',
    from: 'const reason = `checkout: moving from ${from} to ${name ?? start}`;', to: 'const reason = `checkout ${start}`;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-names-case-sensitive', area: 'git', file: 'lib/masked-merge.js',
    from: 'const lower = p.toLowerCase();', to: 'const lower = p;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-names-root-only', area: 'git', file: 'lib/masked-merge.js',
    from: 'return (parts.length <= MASK_SEARCH_DEPTH && MASKED_FILES.some(file => lower === file || lower.endsWith(`/${file}`)))\n    || maskedDirectories(p).length > 0;', to: 'return MASKED_FILES.includes(p) || MASKED_DIRS.some(d => p.startsWith(`${d}/`));', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-tree-root-pathspecs', area: 'git', file: 'lib/masked-merge.js',
    from: "run(['ls-tree', '--full-tree', '-r', '-z', rev]);", to: "run(['ls-tree', '--full-tree', '-r', '-z', rev, '--', ...MASKED_FILES, ...MASKED_DIRS]);", tests: ['test/masked-merge.test.js'] },
  { id: 'masked-absent-nested-file-held', area: 'git', file: 'lib/masked-merge.js',
    from: 'return isMasked(p) && mounted(p);', to: 'return isMasked(p);', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-root-mounts-files-only', area: 'git', file: 'lib/masked-merge.js',
    from: 'const ROOT_MOUNTS = [...MASKED_FILES, ...MASKED_DIRS];', to: 'const ROOT_MOUNTS = MASKED_FILES;', tests: ['test/masked-merge.test.js', 'test/masked-mounts.test.js'] },
  { id: 'masked-deleted-left-unnamed', area: 'git', file: 'lib/masked-merge.js',
    from: 'leftOnMount(g, [...before.keys()].filter((p) => !after.has(p)));', to: 'void before;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-search-depth-too-deep', area: 'git', file: 'lib/masked-merge.js',
    from: 'const MASK_SEARCH_DEPTH = 3;', to: 'const MASK_SEARCH_DEPTH = 4;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-bind-writable-mode-bits', area: 'git', file: 'lib/masked-merge.js',
    from: 'fs.accessSync(p, fs.constants.W_OK);', to: 'void p;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-readonly-parent-ignored', area: 'git', file: 'lib/masked-merge.js',
    from: 'if (mounted(dir)) return true;', to: 'if (false) return true;', tests: ['test/masked-merge.test.js'] },
  { id: 'masked-claude-settings-omitted', area: 'git', file: 'lib/claude-sandbox-placeholders.js',
    from: "['.claude/settings.json', 'file']", to: "['.claude/other-settings.json', 'file']", tests: ['test/masked-merge.test.js'] },
  { id: 'masked-claude-hooks-omitted', area: 'git', file: 'lib/claude-sandbox-placeholders.js',
    from: "['.claude/hooks', 'directory']", to: "['.claude/other-hooks', 'directory']", tests: ['test/masked-merge.test.js'] },
  { id: 'session-bus-grants-manager-socket', area: 'sandbox', file: 'lib/agents.js',
    from: 'return { sockets: [bus] };', to: "return { sockets: [bus, resolved(path.join(runtime, 'systemd', 'private'))] };", tests: ['test/sandbox-extensions.test.js'] },
  { id: 'session-bus-missing-socket-spawns', area: 'sandbox', file: 'lib/agents.js',
    from: 'if (!fs.existsSync(bus)) throw refuse(', to: 'if (false) throw refuse(', tests: ['test/sandbox-extensions.test.js'] },
  { id: 'session-bus-spawning-env-names-sockets', area: 'sandbox', file: 'lib/agents.js',
    from: 'const env = workerEnv(ctx);\n  const runtime = runtimeDir(env);', to: 'const env = { ...ctx.env };\n  const runtime = runtimeDir(env);', tests: ['test/sandbox-extensions.test.js'] },
  { id: 'session-bus-dry-run-reads-env-file', area: 'sandbox', file: 'lib/agents.js',
    from: 'return { flags, tmp, tmpSpec, notices, env: { CLAUDE_CONFIG_DIR: home, ...ClaudeProvider', to: 'return { flags, tmp, tmpSpec, notices, env: { CLAUDE_CONFIG_DIR: home, ...Settings.agentEnv(ctx.settings || {}), ...ClaudeProvider', tests: ['test/sandbox-extensions.test.js'] },
  { id: 'session-bus-address-from-spawning-env', area: 'sandbox', file: 'lib/spawn-monitor.js',
    from: "require('./agents').sessionBusEnv(spawn.harness, spawn.settings || {}, agentEnv)", to: "require('./agents').sessionBusEnv(spawn.harness, spawn.settings || {}, process.env)", tests: ['test/sandbox-extensions.test.js'] },
  { id: 'sandbox-denies-spawning-runtime', area: 'sandbox', file: 'lib/agents.js',
    from: '...[...new Set([ctx.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR])].filter((dir) => dir && !runDirs().some((r) => within(resolved(dir), r))),', to: '...[env.XDG_RUNTIME_DIR].filter((dir) => dir && !runDirs().some((r) => within(resolved(dir), r))),', tests: ['test/sandbox-extensions.test.js'] },
  // board
  { id: 'board-unescaped-lt', area: 'board', file: 'lib/board/parts.js',
    from: ".replace(/</g, '&lt;')", to: '', tests: ['test/board.test.js'] },
  { id: 'serve-no-page-token', area: 'board', file: 'lib/serve.js',
    from: "if (!same(req.headers['x-tower-crane-token'], token)) {", to: 'if (false) {', tests: ['test/settings.test.js'] },
  { id: 'serve-anyone-owner', area: 'board', file: 'lib/serve.js',
    from: "const canWriteOwner = ctx.agent === 'owner' && ctx.agentExplicit;", to: 'const canWriteOwner = true;', tests: ['test/events.test.js'] },
];

function checkMutants(root, mutants = MUTANTS) {
  const sources = new Map();
  const failures = [];
  for (const m of mutants) {
    try {
      if (!sources.has(m.file)) sources.set(m.file, readText(path.join(root, m.file)));
      const count = sources.get(m.file).split(m.from).length - 1;
      if (count !== 1) failures.push(`${m.id}: the text to mutate must occur once in ${m.file}; found ${count}`);
    } catch (error) {
      failures.push(`${m.id}: cannot read ${m.file}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

// A Windows pass takes a CIM snapshot, about a second on a hosted runner and many
// seconds on a cold one, and a taskkill per member, so Windows waits longer.
const WINDOWS_WAIT_MS = 30000;

// Track descendants as well as groups: the CLI starts detached supervisors.
function processSnapshot() {
  if (process.platform === 'linux') {
    const rows = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        rows.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
          start: fields[19], live: !['Z', 'X'].includes(fields[0]) });
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
    }
    return rows;
  }
  if (process.platform === 'win32') {
    const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: WINDOWS_WAIT_MS, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`cannot inspect mutant processes: ${r.error?.message || r.stderr}`);
    const rows = JSON.parse(r.stdout);
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({
      pid: row.ProcessId, parent: row.ParentProcessId, start: row.CreationDate, live: true,
    }));
  }
  const r = cp.spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) throw new Error(`cannot inspect mutant processes: ${r.error?.message || r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [pid, parent, group, state, ...start] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group),
      start: start.join(' '), live: !state.startsWith('Z') };
  });
}

function callerSlice() {
  const group = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'));
  const slice = group?.slice(3).split('/').filter(part => part.endsWith('.slice')).at(-1);
  if (!slice) throw new Error('cannot determine the caller systemd slice');
  return `--slice=${slice}`;
}

function scopeAvailable() {
  if (process.platform !== 'linux') return false;
  let slice;
  try { slice = callerSlice(); } catch { return false; }
  const r = cp.spawnSync('systemd-run', ['--user', '--scope', '--quiet', slice, '-p', 'TasksMax=512',
    '-p', 'MemoryMax=4G', '--', process.execPath, '-e', ''],
  { encoding: 'utf8', timeout: 10000 });
  return !r.error && r.status === 0;
}

async function runContained(command, argv, { cwd, env = process.env, limit = 512, scope = false, timeout = 3600000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 512) throw new Error('process limit must be an integer from 2 to 512');
  const before = new Map((scope ? [] : processSnapshot()).map(row => [row.pid, row.start]));
  // The inherited marker finds Linux descendants reparented between snapshots.
  const marker = require('node:crypto').randomUUID();
  const markedEnv = { ...env, TOWER_CRANE_MUTANT_RUN: [env.TOWER_CRANE_MUTANT_RUN, marker].filter(Boolean).join(',') };
  const unit = `tower-crane-mutant-${process.pid}-${require('node:crypto').randomUUID()}.scope`;
  const args = scope ? ['--user', '--scope', '--quiet', callerSlice(), `--unit=${unit}`, '-p', `TasksMax=${limit}`,
    '-p', 'MemoryMax=4G', '--', command, ...argv] : argv;
  const child = cp.spawn(scope ? 'systemd-run' : command, args, { cwd, env: markedEnv,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const known = new Map();
  let output = '';
  let peak = 0;
  let reason = null;
  let inspectionError = null;
  let controlGroup;
  let groupProbeAt = 0;
  let scopedCount = 0;
  let ended = false;
  const capture = chunk => { output = (output + chunk.toString()).slice(-8192); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const scopeDirectory = () => {
    if (controlGroup || Date.now() < groupProbeAt) return controlGroup;
    // A scope may not be registered at the first inspection.
    groupProbeAt = Date.now() + 100;
    const r = cp.spawnSync('systemctl', ['--user', 'show', unit, '-p', 'ControlGroup', '--value'],
      { encoding: 'utf8', timeout: 5000 });
    if (r.error) throw r.error;
    if (r.status === 0 && r.stdout.trim()) controlGroup = path.join('/sys/fs/cgroup', r.stdout.trim());
    return controlGroup;
  };
  const rememberScoped = () => {
    const group = scopeDirectory();
    const pids = new Set([child.pid, ...known.keys()].filter(Boolean));
    scopedCount = 0;
    if (group) {
      // kernfs reports ENODEV when systemd removes a scope after its file was opened.
      try {
        scopedCount = Number(fs.readFileSync(path.join(group, 'pids.current'), 'utf8').trim());
        if (!Number.isSafeInteger(scopedCount) || scopedCount < 0) throw new Error('invalid scope process count');
        for (const pid of fs.readFileSync(path.join(group, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean)) {
          const number = Number(pid);
          if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid scope process membership');
          pids.add(number);
        }
      } catch (error) { if (!['ENOENT', 'ENODEV'].includes(error.code)) throw error; }
    }
    const members = [];
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const start = fields[19];
        // A PID observed earlier may have been reused after the scope stopped.
        if (known.has(pid) && known.get(pid) !== start) continue;
        known.set(pid, start);
        if (!['Z', 'X'].includes(fields[0])) members.push({ pid, group: Number(fields[2]), start });
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
        // Keep the runner's identity so a later reuse cannot become a member.
        if (pid !== child.pid) known.delete(pid);
      }
    }
    return members;
  };
  const remember = () => {
    if (scope) return rememberScoped();
    const rows = processSnapshot();
    const members = new Map(rows.filter(row => known.get(row.pid) === row.start).map(row => [row.pid, row]));
    const leader = rows.find(row => row.pid === child.pid);
    if (leader && !known.has(leader.pid)) { known.set(leader.pid, leader.start); members.set(leader.pid, leader); }
    if (process.platform === 'linux') {
      for (const row of rows) {
        if (members.has(row.pid) || known.has(row.pid) && known.get(row.pid) !== row.start
          || before.get(row.pid) === row.start || !row.live) continue;
        try {
          const entry = fs.readFileSync(`/proc/${row.pid}/environ`, 'utf8').split('\0')
            .find(value => value.startsWith('TOWER_CRANE_MUTANT_RUN='));
          if (entry?.slice('TOWER_CRANE_MUTANT_RUN='.length).split(',').includes(marker)) {
            known.set(row.pid, row.start);
            members.set(row.pid, row);
          }
        } catch (error) {
          if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        }
      }
    }
    let added;
    do {
      added = false;
      for (const row of rows) {
        if (!members.has(row.pid) && (!known.has(row.pid) || known.get(row.pid) === row.start) && (members.has(row.parent)
          || (row.group && [...members.values()].some(member => member.pid === member.group && member.group === row.group)))) {
          known.set(row.pid, row.start);
          members.set(row.pid, row);
          added = true;
        }
      }
    } while (added);
    return [...members.values()].filter(row => row.live);
  };
  const kill = () => {
    if (!child.pid) return;
    if (scope) cp.spawnSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', '--kill-whom=all', unit],
      { encoding: 'utf8', timeout: 5000 });
    const members = remember();
    if (process.platform === 'win32') {
      for (const row of members) cp.spawnSync('taskkill', ['/F', '/T', '/PID', String(row.pid)],
        { encoding: 'utf8', timeout: 5000, windowsHide: true });
    } else {
      const groups = new Set(members.filter(row => row.pid === row.group).map(row => row.group));
      for (const group of groups) {
        try { process.kill(-group, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      for (const row of members) {
        try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  };
  const scopeCap = () => {
    if (!scope) return null;
    scopeDirectory();
    if (!controlGroup) return null;
    for (const [file, event, label] of [['pids.events', 'max', `process cap (${limit})`], ['memory.events', 'oom_kill', 'memory cap (4G)']]) {
      try {
        const events = fs.readFileSync(path.join(controlGroup, file), 'utf8');
        if (new RegExp(`^${event} [1-9]\\d*$`, 'm').test(events)) return label;
      } catch (error) { if (!['ENOENT', 'ENODEV'].includes(error.code)) throw error; }
    }
    return null;
  };
  const stop = why => {
    reason ||= why;
    try { kill(); } catch (error) { inspectionError ||= error; child.kill('SIGKILL'); }
  };
  const inspect = () => {
    try {
      const members = remember();
      const count = scope ? scopedCount : members.length;
      peak = Math.max(peak, count);
      const cap = scopeCap();
      if (cap || count >= limit) stop(cap || `process cap (${limit}); observed ${count}`);
    } catch (error) {
      inspectionError ||= error;
      stop('watchdog inspection failed');
    }
  };
  const onSignal = signal => stop(`interrupted by ${signal}`);
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timer = setInterval(inspect, 25);
  const deadline = setTimeout(() => stop(`caught-by-timeout (${timeout} ms)`), timeout);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => {
        ended = true;
        try {
          // Inspect before removing the scope or losing surviving descendants.
          inspect();
          kill();
        } catch (error) { inspectionError ||= error; }
        resolve({ status, signal });
      });
    });
    const cleanupDeadline = Date.now() + (process.platform === 'win32' ? WINDOWS_WAIT_MS : 5000);
    while (remember().length) {
      kill();
      if (Date.now() >= cleanupDeadline) throw new Error('mutant descendants survived containment cleanup');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (inspectionError) throw inspectionError;
    if (scope && !reason && result.status !== 0
      && /^Failed to (?:connect .*bus|start transient scope|create bus connection|find executable|resolve executable|execute)/m.test(output)) {
      throw new Error(`cannot launch mutant systemd scope:\n${output}`);
    }
    return { ...result, reason, output, peak };
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (!ended) kill();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

// Five baseline times leave room for loaded hosts; the floor covers process startup.
function mutationTimeout(files, timings) {
  const measured = files.reduce((sum, file) => {
    const ms = timings.get(file);
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`missing baseline time for ${file}`);
    return sum + ms;
  }, 0);
  return Math.ceil(Math.max(30000, measured * 5));
}

async function runMutationTests(files, timings, testResult, onRetry = () => {}) {
  const timeout = mutationTimeout(files, timings);
  let run = await testResult(files, timeout);
  if (run.reason?.startsWith('caught-by-timeout')) {
    onRetry();
    run = await testResult(files, timeout);
  }
  const caughtBy = run.reason?.startsWith('caught-by-timeout') ? 'timeout'
    : run.reason ? 'cap' : run.status !== 0 ? 'tests' : null;
  return { run, caughtBy };
}

module.exports = { MUTANTS, checkMutants, runContained, mutationTimeout, runMutationTests };
if (require.main !== module) return;

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const jobs = Number(opt('--jobs', '4'));
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 4) throw new Error('--jobs must be an integer from 1 to 4');
  const only = opt('--only', null)?.split(',');
  const full = !args.includes('--no-full');
  const skip = opt('--skip', null);
  const processLimit = Number(opt('--process-limit', '512'));
  if (!Number.isSafeInteger(processLimit) || processLimit < 2 || processLimit > 512) throw new Error('--process-limit must be an integer from 2 to 512');
  const root = path.resolve(opt('--root', path.join(__dirname, '..')));
  const selected = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  if (!selected.length || only?.some((id) => !MUTANTS.some((m) => m.id === id))) throw new Error('unknown or empty mutation selection');

  // Validate before copying the repository or starting a baseline.
  checkMutants(root, selected);
  if (args.includes('--check')) {
    console.log(`${selected.length} mutant targets match once`);
    return;
  }

  const scratchRoot = process.env.TOWER_CRANE_TEST_TMP || os.tmpdir();
  fs.mkdirSync(scratchRoot, { recursive: true });
  const copy = fs.mkdtempSync(path.join(scratchRoot, 'tower-crane-mutants-'));
  const scope = scopeAvailable();
  console.log(`Containment: ${scope ? 'systemd scope (MemoryMax=4G) and watchdog' : 'process watchdog'}; process limit ${processLimit}`);
  const timings = new Map();
  async function testResult(files, timeout, concurrency = jobs) {
    const r = await runContained(process.execPath, ['test/run.js', `--test-concurrency=${concurrency}`, ...(skip ? [`--test-skip-pattern=${skip}`] : []), ...files],
      { cwd: copy, limit: processLimit, scope, timeout });
    if (r.reason?.startsWith('interrupted by')) throw new Error(r.reason);
    return r;
  }
  async function baseline(files) {
    const pending = [...new Set(files)].filter(file => !timings.has(file));
    // Measure each file in its own run, without adding more file workers.
    let failed;
    await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, async () => {
      while (pending.length && !failed) {
        const file = pending.shift();
        const started = performance.now();
        try {
          const r = await testResult([file], undefined, 1);
          if (r.status !== 0 || r.reason) throw new Error(`the unmutated tests fail:\n${file}\n${r.reason || r.signal || ''}\n${r.output}`);
          timings.set(file, performance.now() - started);
        } catch (error) { failed ||= error; }
      }
    }));
    if (failed) throw failed;
  }
  const runTests = (files, id) => runMutationTests(files, timings, testResult,
    () => console.log(`retry   ${id}: timeout-only catch`));

  // Anchor validation checks the pristine catalog, not behavior under a planted bug.
  const allFiles = () => require(path.join(copy, 'test', 'run.js')).testFiles()
    .filter((file) => file !== 'test/mutants.test.js');

  let caught = 0;
  const catches = { tests: 0, timeout: 0, cap: 0 };
  try {
    // Include test inputs outside the npm package, without local state or caches.
    const files = cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
    for (const file of new Set(files.split('\0').filter(Boolean))) {
      const source = path.join(root, file);
      // A sandbox mask is a character device (/dev/null) where the host has no file.
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.cpSync(source, path.join(copy, file), { recursive: true });
    }
    checkMutants(copy, selected);
    // A file that fails unmutated would count every mutant as caught.
    const named = [...new Set(selected.flatMap((m) => m.tests))];
    await baseline(named);
    let fullValidated = false;
    for (const m of selected) {
      const file = path.join(copy, m.file);
      const source = readText(file);
      fs.writeFileSync(file, source.replace(m.from, m.to));
      let by = null;
      let result;
      try {
        result = await runTests(m.tests, m.id);
        if (result.caughtBy) by = result.run.reason || m.tests.join(', ');
        else if (full) {
          if (!fullValidated) {
            fs.writeFileSync(file, source);
            try { await baseline(allFiles()); }
            catch (error) { throw new Error(`the unmutated full suite fails:\n${error.message}`); }
            fullValidated = true;
            fs.writeFileSync(file, source.replace(m.from, m.to));
          }
          result = await runTests(allFiles(), m.id);
          if (result.caughtBy) by = result.run.reason || 'full suite';
        }
      } finally {
        fs.writeFileSync(file, source);
      }
      if (by) { caught++; catches[result.caughtBy]++; }
      console.log(`${by ? 'caught' : 'MISSED'}  ${m.area.padEnd(16)} ${m.id}${by ? ` (${by})` : ''}`);
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`\n${caught}/${selected.length} mutants caught (${catches.tests} by tests, ${catches.timeout} by timeout, ${catches.cap} by caps)`);
  if (caught !== selected.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
