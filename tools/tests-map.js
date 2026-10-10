#!/usr/bin/env node
'use strict';

// Static imports seed coverage; shared CLI infrastructure keeps every suite.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ref = process.argv[2];
const files = cp.execFileSync('git', ref ? ['ls-tree', '-r', '--name-only', '-z', ref] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const read = (file) => ref
  ? cp.execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' })
  : fs.readFileSync(path.join(root, file), 'utf8');
const suites = files.filter((p) => /^test\/(?:gates\/)?[^/]+\.test\.js$/.test(p));
const sources = files.filter((p) => /^(lib|bin|scripts|tools|hooks|test)\//.test(p) && !suites.includes(p) && /\.(?:js|mjs|json)$/.test(p));
const map = Object.fromEntries(sources.map((p) => [p, new Set()]));
function imports(file) {
  const text = read(file);
  const deps = new Set();
  for (const match of text.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    const target = [base, `${base}.js`, `${base}/index.js`].find((p) => files.includes(p));
    if (target && target !== 'bin/tower-crane.js') deps.add(target);
  }
  // Fixtures passed as argv or preload paths do not use require in the caller.
  for (const source of sources.filter((p) => p.startsWith('test/fixtures/'))) {
    if (text.includes(path.posix.basename(source))) deps.add(source);
  }
  return deps;
}
const graph = new Map([...sources, ...suites].filter((p) => /\.(js|mjs)$/.test(p)).map((p) => [p, imports(p)]));
for (const suite of suites) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (map[file]) map[file].add(suite);
    for (const dep of graph.get(file) || []) visit(dep);
  };
  visit(suite);
  // CLI integration suites also cover the matching command module.
  for (const source of sources) {
    if (path.posix.basename(source).replace(/\.(js|mjs)$/, '') === path.posix.basename(suite).replace('.test.js', '')) visit(source);
  }
}
for (const file of ['bin/tower-crane.js', 'lib/commands.js', 'lib/state.js', 'lib/util.js', 'lib/project.js', 'lib/tasks.js', 'lib/authority.js', 'package.json', 'test/run.js', 'test/helpers.js', 'test/repo-seed.js']) {
  if (files.includes(file)) map[file] = new Set(suites);
}
map['**/*.md'] = new Set();
// Unknown executable coverage remains unmapped and therefore runs the full suite.
const pinned = Object.fromEntries(Object.entries(map).filter(([p, tests]) => tests.size || p === '**/*.md').sort(([a], [b]) => a.localeCompare(b)).map(([p, tests]) => [p, [...tests].sort()]));
process.stdout.write(`{\n${Object.entries(pinned).map(([source, tests]) => `  ${JSON.stringify(source)}: ${JSON.stringify(tests)}`).join(',\n')}\n}\n`);
