'use strict';

// claude's PreToolUse hook for Read, Grep and Glob, which answer to permission
// rules and not to the sandbox. A path under the user's home is read only
// inside the dispatch's readable paths, the list its sandbox reopens
// (read-guard.json in the agent's home, written at spawn). A search whose
// root holds the home would walk into it, so it is refused too. The path is
// checked where it leads, through symlinks. Exit 2 blocks the call; so does
// any failure here, since claude lets a call through when a hook errors.

const fs = require('node:fs');
const path = require('node:path');
const { readStdin } = require('./util');

const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// Where p leads: its real path, or its deepest existing ancestor's with the
// rest appended, so a file that does not exist yet is judged by where it would be.
function real(p) {
  const rest = [];
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync(at), ...rest);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(at) === at) throw error;
      rest.unshift(path.basename(at));
    }
  }
}

// The fixed part of a glob, before its first wildcard segment.
function base(pattern) {
  const parts = pattern.split(/[\\/]/);
  const at = parts.findIndex((s) => /[*?[\]{}]/.test(s));
  return at < 0 ? pattern : parts.slice(0, at).join(path.sep) || path.sep;
}

function check(input, policy) {
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const targets = [];
  if (tool === 'Read') targets.push(args.file_path);
  else if (tool === 'Grep' || tool === 'Glob') {
    const root = path.resolve(cwd, typeof args.path === 'string' && args.path ? args.path : '.');
    targets.push(root);
    if (tool === 'Glob' && typeof args.pattern === 'string') targets.push(base(path.resolve(root, args.pattern)));
  } else return null;
  const search = tool !== 'Read';
  for (const t of targets) {
    if (typeof t !== 'string' || !t) continue;
    const p = real(path.resolve(cwd, t));
    if (within(p, policy.home) && !policy.allow.some((dir) => within(p, dir))) {
      return `${t} is under the user's home outside this agent's readable paths`;
    }
    if (search && within(policy.home, p)) return `searching ${t} would read the user's home; search inside the worktree or a readable path`;
  }
  return null;
}

function main() {
  try {
    const policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const why = check(JSON.parse(readStdin()), policy);
    if (!why) return 0;
    process.stderr.write(`tower-crane: ${why}\n`);
  } catch (error) {
    process.stderr.write(`tower-crane: read check failed, so the call is refused: ${error.message}\n`);
  }
  return 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { check };
