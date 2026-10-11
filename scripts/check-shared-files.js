'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { check } = require('./cli-docs');
const { fragments } = require('./changelog');
const { normalizeText, readText } = require('./text');
const { checkTestWaits } = require('./test-waits');

// Non-blocking stdin fails a bare read with EAGAIN; readStdin in lib/util.js retries it.
// Matched across the whole file, so a call split over several lines is still found.
const BARE_STDIN = /readFileSync\(\s*(0|['"]\/dev\/stdin['"])\s*[,)]/g;

function checkStdinReads(root) {
  const found = [];
  for (const dir of ['lib', 'bin']) {
    for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      const file = `${dir}/${name.replace(/\\/g, '/')}`;
      if (!file.endsWith('.js') || file === 'lib/util.js') continue;
      const text = readText(path.join(root, file));
      for (const match of text.matchAll(BARE_STDIN)) {
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${file}:${line} reads stdin with readFileSync(0); use readStdin() from lib/util.js`);
      }
    }
  }
  if (found.length) throw new Error(found.join('\n'));
}

function checkChanges(root, base) {
  const git = (args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  const sha = normalizeText(git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
  const fields = git(['diff', '--name-status', '--no-renames', '-z', sha, '--']).split('\0');
  fields.pop();
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    fields.push('A', file);
  }
  let added = 0;
  let changed = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i];
    const file = fields[i + 1].replace(/\\/g, '/');
    changed++;
    if (file === 'CHANGELOG.md') throw new Error('do not edit CHANGELOG.md; add changelog.d/<task-or-pr>.md');
    if (file.startsWith('changelog.d/') && file !== 'changelog.d/README.md') {
      if (status !== 'A') throw new Error(`${file} belongs to its original change; add a new fragment`);
      added++;
    }
  }
  if (changed && !added) throw new Error('every change needs a new changelog.d/<task-or-pr>.md fragment');
}

function main(args) {
  let root = path.join(__dirname, '..');
  let base = process.env.TOWER_CRANE_CHANGE_BASE;
  for (let i = 0; i < args.length; i++) {
    if (!['--root', '--base'].includes(args[i]) || !args[i + 1]) {
      throw new Error('usage: node scripts/check-shared-files.js [--root DIR] [--base SHA]');
    }
    if (args[i] === '--root') root = path.resolve(args[++i]);
    else base = args[++i];
  }
  check(root);
  checkStdinReads(root);
  checkTestWaits(root);
  fragments(root);
  if (base && !/^0+$/.test(base)) checkChanges(root, base);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkChanges };
