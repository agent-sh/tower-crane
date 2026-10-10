'use strict';

function relativePath(value, glob = false) {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && !value.includes('\0') && !value.includes('\\') && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..')
    && (glob || !/[?*{}\[\]]/.test(value));
}

function settingError(value) {
  if (value == null) return null;
  return typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([source, suites]) => relativePath(source, true)
      && Array.isArray(suites) && suites.every((suite) => relativePath(suite)))
    ? null : 'must be an object mapping repository source paths or globs to arrays of literal test paths, or null';
}

function expand(template, paths) {
  const { shellQuote } = require('./gates/common');
  return template.replaceAll('{tests}', paths.map(shellQuote).join(' '));
}

function select(project, changed, isTest, available, globToRegExp, task) {
  const full = (reason) => ({ mode: 'full', reason });
  if (project.tests?.expensive !== true) return full('tests.expensive is not true');
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

module.exports = { settingError, expand, select };
