'use strict';

// Why a task went back for rework. Each `rework` event records one of these as
// `cause` where it is raised; `tower-crane metrics` classifies older events
// without one from their reason text and the gate evidence of the same head.
const CAUSES = ['conflict_base', 'conflict_parent', 'stack_sync', 'coverage_gap', 'base_failure', 'timeout',
  'infrastructure', 'cross_task', 'head_check', 'tests', 'review', 'ci', 'clean', 'manual'];

// Causes no change of the task's own could have avoided: parallel work on the
// base or a parent, Tower Crane's own bookkeeping, the host and the base.
// A head check counts here only without a culprit (see metrics.js).
const TC = new Set(['conflict_base', 'conflict_parent', 'stack_sync', 'coverage_gap', 'base_failure', 'timeout',
  'infrastructure', 'cross_task']);

const CONFLICTING = /is CONFLICTING|\(DIRTY\)/;
const COVERAGE = /(^|\n)coverage gap: /;
const TIMED_OUT = /timed out after [\d.]+ min \(infrastructure failure\)/;

// A settled gate's failed evidence (task evidence or its `check TYPE` event
// detail, which carry the same flags). `parentBase` says a CI conflict is
// with a stack parent's branch rather than the project base.
function ofGate(type, evidence, { parentBase = false } = {}) {
  const e = evidence || {};
  const summary = e.summary || '';
  if (e.timeout || TIMED_OUT.test(summary)) return 'timeout';
  if (type === 'tests' && e.main_failure) return 'base_failure';
  if (type === 'tests' && COVERAGE.test(summary)) return 'coverage_gap';
  if (type === 'ci' && CONFLICTING.test(summary)) return parentBase ? 'conflict_parent' : 'conflict_base';
  if (e.infrastructure_failure || e.runner_crash) return 'infrastructure';
  return ['tests', 'clean', 'ci', 'review'].includes(type) ? type : 'manual';
}

// A conflict with the branch a task targets: the project base, or a stack parent's branch.
function ofConflict(target, base) {
  return target === base ? 'conflict_base' : 'conflict_parent';
}

// A quality failure escalation sends back: a stalled or exited worker, or a failed gate.
function ofEscalation(trigger) {
  if (trigger === 'stall') return 'timeout';
  if (trigger === 'exit') return 'infrastructure';
  return ofGate(trigger, null);
}

// An event recorded before `cause` existed, from its reason text. `gateEvidence`
// returns the failed evidence of a gate at the event's head when the log has it.
function fromReason(detail, { base = 'main', gateEvidence = () => null } = {}) {
  const reason = String(detail?.reason || '');
  if (detail?.from_review || /^(final )?review FAIL\b/.test(reason) || /^PR-body fix changed/.test(reason)) return 'review';
  const conflict = /^PR #\d+ conflicts with ([^\s:]+):/.exec(reason);
  if (conflict) return ofConflict(conflict[1], base);
  if (/^Merge T\d+'s resubmitted head \S+ into T\d+; resolve conflicts/.test(reason)) return 'conflict_parent';
  if (/^stack sync (merged|moved)|^gh stack sync aborted|; parent T\d+ submitted \S+\. Continue the existing work/.test(reason)) return 'stack_sync';
  if (/^(full suite fails|crucial and mapped suites fail) on PR #\d+ merged with /.test(reason)) return 'head_check';
  const gate = /^(tests|clean|ci) failed at \S+: ([\s\S]*)$/.exec(reason);
  if (gate) {
    const type = detail.gate || gate[1];
    // Check events carry the flags but not the summary, which the reason holds.
    return ofGate(type, { ...gateEvidence(type), summary: gate[2] });
  }
  const escalation = /^failed (tests|clean|ci|review): /.exec(reason);
  if (escalation) return ofGate(escalation[1], { summary: reason });
  if (/^stall: /.test(reason)) return 'timeout';
  if (/^worker exit without submit/.test(reason)) return 'infrastructure';
  return 'manual';
}

module.exports = { CAUSES, TC, ofGate, ofConflict, ofEscalation, fromReason };
