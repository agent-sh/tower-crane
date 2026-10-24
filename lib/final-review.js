'use strict';
// gates.final_review: the external reviewer accept asks once per head and revision after every
// other gate passed (lib/gates/final-review.js runs it). Gate internals ship separately in
// lib/gates/, so the settings that project validation, accept and status read live here.

const WHEN = ['capped', 'always'];
const KEYS = ['command', 'when', 'capped_pattern', 'timeout', 'concerns_exit'];
// concerns_exit defaults to the code the review bot this was built for exits with on blocking
// concerns (it exits 0 on a pass, 1 on an error and 3 when it refuses); the timeout to the other
// gate commands' budget.
const DEFAULTS = { when: 'capped', timeout: 1200, concerns_exit: 2 };
const MAX_TIMER_MS = 2 ** 31 - 1;

function errors(gates) {
  const v = gates?.final_review;
  if (v == null) return [];
  const bad = (message) => [`project.json gates.final_review ${message}`];
  if (typeof v !== 'object' || Array.isArray(v)) return bad('must be an object or null');
  const unknown = Object.keys(v).filter((k) => !KEYS.includes(k));
  if (unknown.length) return bad(`has unknown keys: ${unknown.join(', ')}; it takes ${KEYS.join(', ')}`);
  if (!Array.isArray(v.command) || !v.command.length || !v.command.every((a) => typeof a === 'string' && !a.includes('\0'))
    || !v.command[0].trim()) return bad('command must be a nonempty argv array of strings without NUL bytes');
  if (v.when !== undefined && !WHEN.includes(v.when)) return bad('when must be "capped" or "always"');
  if ((v.when ?? DEFAULTS.when) === 'capped' || v.capped_pattern !== undefined) {
    if (typeof v.capped_pattern !== 'string' || !v.capped_pattern.trim()) return bad('capped_pattern must be a nonempty regular expression; "when": "capped" needs it');
    try { new RegExp(v.capped_pattern, 'i'); } catch (e) { return bad(`capped_pattern is not a valid regular expression: ${e.message}`); }
  }
  if (v.timeout !== undefined && !(typeof v.timeout === 'number' && v.timeout > 0 && v.timeout * 1000 <= MAX_TIMER_MS)) {
    return bad("timeout must be a positive number of seconds within Node's timer range");
  }
  if (v.concerns_exit !== undefined && !(Number.isInteger(v.concerns_exit) && v.concerns_exit >= 1 && v.concerns_exit <= 255)) {
    return bad('concerns_exit must be an exit code from 1 to 255');
  }
  return [];
}

function settings(project) {
  const v = project.gates?.final_review;
  return v == null || errors(project.gates).length ? null : { ...DEFAULTS, ...v };
}

// The final review evidence that stands for the task's head and revision, if any. A run that
// recorded no outcome (a refused gate) or that wait shutdown interrupted is no verdict, so the
// next accept asks again.
function current(task, events) {
  const verdicts = task.evidence.filter((e) => e.type !== 'final-review' || (e.final_review?.outcome && !e.final_review.interrupted));
  return require('./tasks').latestGateEvidence({ ...task, evidence: verdicts }, 'final-review', events) || null;
}

// Only the reviewer's concerns block; any other failed entry is not its verdict.
function concerns(entry) {
  return entry?.ok === false && entry.final_review?.outcome === 'concerns';
}

function expand(arg, values) {
  return arg.replace(/\{(repo|pr|sha)\}/g, (_, key) => values[key]);
}

module.exports = { errors, settings, current, concerns, expand, DEFAULTS };
