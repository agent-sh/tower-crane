'use strict';

function relativePath(value, glob = false) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..')
    && (glob || !/[?*{}\[\]]/.test(value));
}

// Views resolve the policy for every task and gate against the same pinned
// map, so its validation is kept per map object.
const checked = new WeakMap();

function settingError(value) {
  if (value == null) return null;
  if (typeof value === 'object' && checked.has(value)) return checked.get(value);
  const error = typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([source, suites]) => relativePath(source, true)
      && Array.isArray(suites) && suites.every((suite) => relativePath(suite)))
    ? null : 'must be an object mapping repository source paths or globs to arrays of literal test paths, or null';
  if (typeof value === 'object') checked.set(value, error);
  return error;
}

function crucialError(value) {
  if (value == null) return null;
  return Array.isArray(value) && value.length && value.every((p) => relativePath(p)) && new Set(value).size === value.length
    ? null : 'must be a non-empty JSON array of distinct literal test paths, or null';
}

function expand(template, paths) {
  const { shellQuote } = require('./gates/common');
  return template.replaceAll('{tests}', paths.map(shellQuote).join(' '));
}

function unselected(project, available) {
  if (project.tests?.map == null || settingError(project.tests.map)) return [];
  const matcher = require('./gates/tests').hostTestMatcher(project);
  if (matcher.error) return [];
  const selected = new Set([...Object.values(project.tests.map).flat(),
    ...(Array.isArray(project.tests.crucial) ? project.tests.crucial : [])]);
  return [...available].filter((file) => matcher.match(file) && !selected.has(file)).sort();
}

async function unselectedAt(project, root, ref = project.base) {
  if (project.tests?.map == null || !root || !ref) return [];
  const C = require('./gates/common');
  const ctx = { root };
  const tip = await C.baseTip(ctx, root, ref);
  if (!tip) return [];
  const listed = await C.git(ctx, root, ['ls-tree', '-r', '--name-only', '-z', tip], { timeout: 60000 });
  if (!listed.ok) return [];
  return unselected(project, listed.stdout.split('\0').filter(Boolean));
}

// Crucial mode: tests.crucial, the changed tests and the mapped suites of every changed file, with
// no full suite and no hosted job. A changed file no entry covers is a gap the gate settles with
// coverage of the task's own tests; an entry's suites that are gone at head do not cover it.
function crucialSelect(project, changed, isTest, available, globToRegExp, skipped) {
  const omitted = new Set(skipped.map((entry) => entry.path));
  const crucial = project.tests.crucial.filter((p) => !omitted.has(p));
  const absent = crucial.filter((p) => !available.has(p) || !isTest(p));
  if (absent.length) return { mode: 'crucial', error: `tests.crucial names paths that are not test files at head: ${absent.join(', ')}` };
  const entries = Object.entries(project.tests.map).map(([source, suites]) => [globToRegExp(source), suites]);
  const suites = new Set([...crucial, ...changed.filter((f) => isTest(f.path) && f.status !== 'D').map((f) => f.path)]);
  const gaps = [];
  const dropped = new Set();
  for (const file of changed) {
    const matches = entries.filter(([pattern]) => pattern.test(file.path)).map(([, mapped]) => mapped);
    let covered = matches.some((mapped) => !mapped.length);
    for (const suite of matches.flat()) {
      if (available.has(suite) && isTest(suite)) {
        suites.add(suite);
        covered = true;
      } else dropped.add(suite);
    }
    if (!covered && !isTest(file.path) && file.status !== 'D') gaps.push(file.path);
  }
  const paths = [...suites].sort();
  return { mode: 'crucial', reason: 'tests.crucial plus the changed tests and the tests.map suites covering the change', tests: paths,
    command: expand(project.gates.tests_proof_cmd.trim(), paths), gaps, ...(skipped.length ? { skipped } : {}),
    ...(dropped.size ? { dropped: [...dropped].sort() } : {}) };
}

function select(project, changed, isTest, available, globToRegExp, task, skipped = []) {
  const full = (reason) => ({ mode: 'full', reason });
  if (project.tests?.expensive !== true) return full('tests.expensive is not true');
  if (require('./gate-commands').crucialMode(project)) return crucialSelect(project, changed, isTest, available, globToRegExp, skipped);
  if (!task?.pr) return full('task has no PR requiring the hosted full-suite CI job');
  if (project.ci?.local != null) return full('ci.local replaces the required hosted full-suite job');
  if (!Array.isArray(project.ci?.required) || !project.ci.required.length) return full('ci.required does not pin a full-suite job');
  if (project.tests?.map == null) return full('tests.map is not pinned');
  const template = project.gates?.tests_proof_cmd?.trim();
  if (!template?.includes('{tests}')) return full('gates.tests_proof_cmd has no {tests} selector');
  const entries = Object.entries(project.tests.map).map(([source, suites]) => [globToRegExp(source), suites]);
  const suites = new Set(changed.filter((f) => isTest(f.path) && f.status !== 'D').map((f) => f.path));
  const unmapped = [];
  for (const file of changed) {
    const matches = entries.filter(([pattern]) => pattern.test(file.path));
    if (!isTest(file.path) && !matches.length) unmapped.push(file.path);
    for (const [, mapped] of matches) for (const suite of mapped) suites.add(suite);
  }
  if (unmapped.length) return full(`unmapped changed source paths: ${unmapped.join(', ')}`);
  const paths = [...suites].sort();
  const missing = paths.filter((p) => !available.has(p) || !isTest(p));
  if (missing.length) return full(`missing mapped test or path outside tests.paths at head: ${missing.join(', ')}`);
  if (!paths.length) return full('tests.map selected no tests at head');
  return { mode: 'mapped', reason: 'changed tests plus tests.map suites; ci.required carries the full suite', tests: paths, command: expand(template, paths) };
}

module.exports = { settingError, crucialError, expand, select, unselected, unselectedAt };
