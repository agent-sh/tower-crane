'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { check } = require('./cli-docs');
const { fragments, released } = require('./changelog');
const { normalizeText, readText } = require('./text');
const { checkTestWaits } = require('./test-waits');
const { checkSuiteDeadline } = require('./suite-time');
const { checkFakeAgentEnvs } = require('./fake-agent-env');
const { checkMutants } = require('./mutants');

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

function checkScratchRoots(root) {
  const found = [];
  // Construct forbidden spellings so this script also obeys the rule.
  const systemTemp = new RegExp('\\bos\\s*\\.\\s*' + 'tmpdir\\s*\\(', 'g');
  const literalTemp = new RegExp('[\\x27"`]/' + 'tmp(?:/|[\\x27"`])', 'g');
  for (const dir of ['lib', 'bin', 'scripts']) {
    for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      const file = `${dir}/${name.replace(/\\/g, '/')}`;
      if (!fs.statSync(path.join(root, file)).isFile()) continue;
      const text = readText(path.join(root, file));
      for (const pattern of [systemTemp, literalTemp]) {
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(0, match.index).split('\n').length;
          found.push(`${file}:${line} uses the system temp directory; use lib/scratch-root.js`);
        }
      }
    }
  }
  if (found.length) throw new Error(found.join('\n'));
}

const RELEASE_HEADING = /^## [0-9]/;
const body = (text) => text.replace(/^# Changelog\n/, '').trim();

// A release change adds the section for package.json's version above the earlier
// release notes, which stay byte for byte; every other change leaves the file alone.
// Returns the released version, or null when the edit is not a release.
function releaseEdit(root, git, sha) {
  let version;
  try { version = JSON.parse(readText(path.join(root, 'package.json'))).version; } catch { return null; }
  if (typeof version !== 'string' || !fs.existsSync(path.join(root, 'CHANGELOG.md'))) return null;
  const isVersion = (line) => line === `## ${version}` || line.startsWith(`## ${version} `);
  const after = body(readText(path.join(root, 'CHANGELOG.md')));
  let before = '';
  try { before = body(normalizeText(git(['show', `${sha}:CHANGELOG.md`]))); } catch { /* no archive at the base */ }
  if (before.split('\n').some(isVersion)) return null;
  const frozen = before.split('\n').some((line) => RELEASE_HEADING.test(line));
  // Earlier releases are frozen: their notes must be the unchanged tail of the file.
  if (frozen && !after.endsWith(`\n${before}`)) return null;
  const added = frozen ? after.slice(0, after.length - before.length) : after;
  const releases = added.split('\n').filter((line) => RELEASE_HEADING.test(line));
  return releases.length === 1 && isVersion(added.split('\n').find((line) => line.startsWith('## '))) ? version : null;
}

function checkChanges(root, base) {
  const git = (args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  const sha = normalizeText(git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
  // Compare from the merge base: a branch behind its base would otherwise see the base's newer files as deletions.
  const from = normalizeText(git(['merge-base', sha, 'HEAD'])).trim();
  const fields = git(['diff', '--name-status', '--no-renames', '-z', from, '--']).split('\0');
  fields.pop();
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    fields.push('A', file);
  }
  let added = 0;
  let changed = 0;
  let release = null;
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i];
    const file = fields[i + 1].replace(/\\/g, '/');
    changed++;
    if (file === 'CHANGELOG.md') {
      release = status === 'D' ? null : releaseEdit(root, git, sha);
      if (!release) {
        throw new Error('do not edit CHANGELOG.md; add changelog.d/<task-or-pr>.md (only a release adds its "## <version>" section above the earlier notes)');
      }
    }
    if (file.startsWith('changelog.d/') && file !== 'changelog.d/README.md') {
      // Fragments are draft release notes: a later change may correct one it made untrue, but not remove it.
      if (status === 'D') throw new Error(`${file} belongs to its original change; correct it instead of deleting it`);
      if (status === 'A') added++;
    }
  }
  if (changed && !added) throw new Error('every change needs a new changelog.d/<task-or-pr>.md fragment');
  if (release) {
    // Merging marks every fragment in the tree released; list them so the notes can be checked against them.
    const done = released(root, sha);
    const consumed = fragments(root).map((fragment) => fragment.name).filter((name) => !done.has(name));
    process.stdout.write(`release ${release} marks ${consumed.length} fragments released: ${consumed.join(', ')}\n`);
  }
}

function main(args) {
  let root = path.join(__dirname, '..');
  let base = process.env.TOWER_CRANE_CHANGE_BASE;
  let mutants = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mutants') { mutants = true; continue; }
    if (!['--root', '--base'].includes(args[i]) || !args[i + 1]) {
      throw new Error('usage: node scripts/check-shared-files.js [--root DIR] [--base SHA] [--mutants]');
    }
    if (args[i] === '--root') root = path.resolve(args[++i]);
    else base = args[++i];
  }
  check(root);
  checkStdinReads(root);
  checkScratchRoots(root);
  checkTestWaits(root);
  checkFakeAgentEnvs(root);
  checkSuiteDeadline(root);
  // Mutation scoring runs shared checks on deliberately changed code.
  if (mutants) checkMutants(root);
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
