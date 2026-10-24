'use strict';

const cp = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const git = (args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
const commits = git(['log', '--first-parent', '-60', '--format=%H', 'origin/main']).trim().split('\n');
const regions = {};
let changed = 0;
for (const sha of commits) {
  const diff = git(['diff', '--no-ext-diff', '-U0', `${sha}^`, sha, '--', 'bin/tower-crane.js']);
  if (!diff) continue;
  changed++;
  const old = git(['show', `${sha}^:bin/tower-crane.js`]).split('\n');
  const table = old.indexOf('const COMMANDS = [') + 1;
  const end = old.indexOf('];', table) + 1;
  const help = old.findIndex((line) => line.startsWith('function flagLine')) + 1;
  const convert = old.findIndex((line) => line.startsWith('function convert')) + 1;
  const touched = new Set();
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const from = Number(match[1]);
    const removed = Number(match[2] ?? 1);
    const to = from + Math.max(removed, 1) - 1;
    const region = table && from <= end && to >= table ? 'command registrations'
      : help && from < convert && to >= help ? 'help rendering'
        : table && from < table ? 'imports and option specifications' : 'parser and dispatch';
    regions[region] ||= { commits: 0, hunks: 0, added_and_removed_lines: 0 };
    regions[region].hunks++;
    regions[region].added_and_removed_lines += removed + Number(match[4] ?? 1);
    touched.add(region);
  }
  for (const region of touched) regions[region].commits++;
}
console.log(JSON.stringify({
  basis: 'Last 60 first-parent main commits, including squash merges. Changed hunks measure conflict risk, not recorded conflict resolutions.',
  head: commits[0], commits: commits.length, bin_changed_commits: changed, regions,
}, null, 2));
