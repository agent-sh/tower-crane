'use strict';

// Preloaded into each test file process of a coverage map run (lib/tests-coverage.js). The node
// processes the test starts, CLI runs included, inherit NODE_V8_COVERAGE, so pointing it at a
// directory of this file's own keeps their profiles with the test that ran them.
const Coverage = require('./tests-coverage');

const scope = process.env[Coverage.SCOPE_ENV];
// The runner process loads this too; only a test file's process (node:test sets
// NODE_TEST_CONTEXT there) has a file of its own, and only it hides the scope from its children.
if (scope && process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  delete process.env[Coverage.SCOPE_ENV];
  const fs = require('node:fs');
  const path = require('node:path');
  const { dir, root } = JSON.parse(scope);
  const file = path.relative(root, path.resolve(process.argv[1])).split(path.sep).join('/');
  const slug = require('node:crypto').createHash('sha256').update(file).digest('hex').slice(0, 16);
  const children = path.join(dir, 'raw', slug);
  for (const sub of [children, path.join(dir, 'pids'), path.join(dir, 'names')]) fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, 'names', slug), file);
  fs.writeFileSync(path.join(dir, 'pids', String(process.pid)), slug);
  process.env.NODE_V8_COVERAGE = children;
  process.env[Coverage.READS_ENV] = JSON.stringify({ dir: children, root });
  require('./tests-coverage-reads').install(children, root);
  process.on('exit', () => {
    try { Coverage.fold(dir, slug, root); } catch (e) { process.stderr.write(`tower-crane: coverage fold for ${file}: ${e.message}\n`); }
  });
} else if (process.env[Coverage.READS_ENV]) {
  const { dir, root } = JSON.parse(process.env[Coverage.READS_ENV]);
  require('./tests-coverage-reads').install(dir, root);
}
