'use strict';

// Writes lib/gh-flags.json, the flags of each gh command a sandboxed agent
// may run through the broker, read from `gh <command> --help` of the gh on
// PATH. The broker parses an agent's gh arguments with this table: it tells
// a flag's value from a positional argument, and refuses a flag it does not
// know, so a newer gh's flag is refused until the table is regenerated.
//
// usage: node scripts/gh-flags.js

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = ['auth status', 'issue list', 'issue view', 'label list', 'pr checks', 'pr close', 'pr comment',
  'pr create', 'pr diff', 'pr edit', 'pr list', 'pr merge', 'pr ready', 'pr reopen', 'pr review', 'pr status',
  'pr view', 'release list', 'release view', 'repo view', 'run list', 'run view', 'run watch', 'workflow list',
  'workflow view'];

// "  -a, --assignee login   Assign ..." or "      --dry-run   Print ...":
// a value flag names its value in one word after a single space.
const LINE = /^\s+(?:-([A-Za-z0-9]), )?--([A-Za-z0-9][\w-]*)(?: (\S+))?(?:\s{2,}|$)/;

function flags(command) {
  const r = cp.spawnSync('gh', [...command.split(' '), '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  if (r.status !== 0) throw new Error(`gh ${command} --help failed: ${r.stderr}`);
  const out = {};
  let section = null;
  for (const line of r.stdout.split('\n')) {
    if (/^[A-Z][A-Z ]+$/.test(line)) section = line.trim();
    else if (['FLAGS', 'INHERITED FLAGS'].includes(section)) {
      const m = LINE.exec(line);
      if (m) out[m[2]] = { ...(m[1] ? { short: m[1] } : {}), value: m[3] || null };
    }
  }
  return out;
}

const version = cp.execFileSync('gh', ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
const table = { gh: version, commands: Object.fromEntries(COMMANDS.map((c) => [c, flags(c)])) };
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'gh-flags.json'), `${JSON.stringify(table, null, 1)}\n`);
