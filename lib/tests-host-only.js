'use strict';
// tests.host_only: test globs that cannot run inside a worker sandbox, where root-owned host files
// appear as uid/gid 65534 and no root mapping exists. Every spawned role gets the list in
// TOWER_CRANE_HOST_ONLY; a sandboxed run (TOWER_CRANE_SANDBOX=1) skips the matches in its runner,
// and the tests gate runs them on the host.
const fs = require('node:fs');
const path = require('node:path');
const { globToRegExp } = require('./gates/tests');

const ENV = 'TOWER_CRANE_HOST_ONLY';

function globs(project) {
  const list = project.tests?.host_only;
  return Array.isArray(list) ? list : [];
}

// The spawned role's value: the list as JSON, [] when the project names none.
function envValue(project) {
  return JSON.stringify(globs(project));
}

// The worker brief's list of tests it cannot run locally; empty when there are none.
function section(project) {
  const list = globs(project);
  if (!list.length) return '';
  return [
    '## Host-only tests',
    '',
    'These tests cannot run inside your sandbox: root-owned host files appear there as uid/gid 65534 and there is no root mapping. Do not run them locally. The tests gate runs them on the host, outside the sandbox.',
    '',
    ...list.map((glob) => `- ${glob}`),
  ].join('\n');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Splits the files a sandboxed runner was asked to run into those it runs and those it skips, and
// refuses a selection that is not a file. A runner expands a directory or a glob after this split,
// so it could reach a host-only file the split never saw; the caller refuses those arguments.
// A file may be named relative to root or absolute; both match against the repository path.
function split(files, env = process.env, root = process.cwd()) {
  const matchers = JSON.parse(env[ENV] || '[]').map(globToRegExp);
  if (!matchers.length) return { run: files, skipped: [], refused: [] };
  const refused = files.filter((file) => !isFile(path.resolve(root, file)));
  const repoPath = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const skipped = files.filter((file) => !refused.includes(file) && matchers.some((re) => re.test(repoPath(file))));
  return { run: files.filter((file) => !refused.includes(file) && !skipped.includes(file)), skipped, refused };
}

module.exports = { ENV, globs, envValue, section, split };
