'use strict';

const { isDeepStrictEqual } = require('node:util');
const { shaMatch } = require('./util');

// Only consecutive rework revisions preserve scope. Acceptance edits and probe changes
// advance the revision without a rework event and stop reuse.
function revisions(task, events) {
  const T = require('./tasks');
  const reworks = new Map(T.taskEvents(events, task.id)
    .filter((e) => e.cmd === 'rework').map((e) => [e.detail.revision, e.detail]));
  const retired = new Set(T.retiredRevisions(events, task.id));
  const lineage = new Set([task.revision]);
  for (let revision = task.revision; revision > 1 && reworks.has(revision);) {
    const detail = reworks.get(revision);
    const previous = Object.hasOwn(detail, 'previous_revision') ? detail.previous_revision : revision - 1;
    if (!Number.isInteger(previous) || previous < 1 || previous >= revision || retired.has(previous)) break;
    revision = previous;
    lineage.add(revision);
  }
  return lineage;
}

function fullPasses(task, project, events = []) {
  const T = require('./tasks');
  const lineage = revisions(task, events);
  const policy = require('./tests-policy').resolve(project, task.kind);
  if (policy.error || policy.mode === 'none') return [];
  return (task.evidence || []).filter((e) => e.type === 'tests' && e.ok && !e.waived
    && lineage.has(e.revision) && e.tests_mode === policy.mode && e.receipt?.head_mode === 'full'
    && T.eligibleGateEvidence(task, e, events)
    && !require('./gate-commands').mismatch(e, project, task));
}

function mismatch(entry, task, project, events) {
  if (entry.receipt?.head_mode !== 'incremental') return null;
  const from = entry.receipt.incremental_from;
  const full = fullPasses(task, project, events).find((e) => shaMatch(e.sha, from)
    && !shaMatch(e.sha, entry.sha) && isDeepStrictEqual(e.gate_policy, entry.gate_policy));
  const ancestor = entry.commands.some((c) => c.command === 'git' && c.status === 0 && !c.signal
    && c.args.slice(2).join('\0') === ['merge-base', '--is-ancestor', from, entry.sha].join('\0'));
  return full && ancestor ? null
    : `incremental tests evidence needs earlier full tests evidence in the current revision lineage with the same gate policy and an ancestor receipt; run tower-crane check tests ${task.id} again`;
}

function isInfrastructure(p, template = '', command = '') {
  return /^(bin|lib|hooks)\//i.test(p) || p === 'package.json'
    || /(^|\/)(?:run|runner|global-setup)\.[^/]+$/i.test(p)
    || template.includes(p) || command.includes(p);
}

function suiteMatcher(isTest, template = '', command = '') {
  const { isDefaultBuildFile, isSupportFile } = require('./gates/tests');
  return (p) => isTest(p) && !isDefaultBuildFile(p) && !isSupportFile(p)
    && !/(^|\/)(?:run|runner|global-setup)\.[^/]+$/i.test(p)
    && !template.includes(p) && !command.includes(p);
}

function referencePatterns(changed, isTest) {
  const { posix } = require('node:path');
  return [...new Set(changed.filter((f) => !isTest(f.path))
    .flatMap((f) => [f.path, posix.basename(f.path)]))];
}

function select(map, changed, isTest, available, globToRegExp, template, command = '', readers = []) {
  const full = (reason) => ({ mode: 'full', reason });
  if (map == null || require('./tests-map').settingError(map)) return full('repository tests map is missing or malformed');
  if (!template?.includes('{tests}')) return full('gates.tests_proof_cmd has no {tests} selector');
  if (changed.some((f) => f.path === 'tools/tests-map.json')) return full('repository tests map changed');
  const shared = changed.filter(f => isInfrastructure(f.path, template, command));
  if (shared.length) return full(`shared CLI runtime or runner changed: ${shared.map(f => f.path).join(', ')}`);
  const entries = Object.entries(map).map(([source, suites]) => [globToRegExp(source), suites]);
  const suites = new Set(readers);
  const unmapped = [];
  const isSuite = suiteMatcher(isTest, template, command);
  for (const file of changed) {
    const matches = entries.filter(([pattern]) => pattern.test(file.path));
    const test = isSuite(file.path);
    if (!matches.length && (!test || file.status === 'D')) unmapped.push(file.path);
    if (test && file.status !== 'D') suites.add(file.path);
    for (const [, mapped] of matches) for (const suite of mapped) suites.add(suite);
  }
  if (unmapped.length) return full(`unmapped incremental paths: ${unmapped.join(', ')}`);
  const paths = [...suites].sort();
  const missing = paths.filter((p) => !available.has(p) || !isTest(p));
  if (missing.length) return full(`missing mapped test or path outside tests.paths at head: ${missing.join(', ')}`);
  return { mode: 'incremental', reason: 'delta since the earlier full pass is fully mapped', tests: paths,
    command: paths.length ? require('./tests-map').expand(template, paths) : null };
}

module.exports = { revisions, fullPasses, mismatch, isInfrastructure, suiteMatcher, referencePatterns, select };
