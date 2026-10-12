'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

// Denied dotfiles and .claude entries the sandbox mounts over in a worktree
// root. Only names that are empty, read-only regular files after exit are
// ever removed.
const FILES = Object.freeze([
  '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json',
  '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc',
  '.claude/agents', '.claude/commands', '.claude/hooks',
  '.claude/launch.json', '.claude/loop.md', '.claude/output-styles',
  '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/skills', '.claude/workflows',
]);
const IGNORE_PATTERNS = Object.freeze(FILES.map((file) => file.includes('/') ? file : `/${file}`));

function ignorePatterns(existedBefore) {
  const existing = new Set(existedBefore);
  return FILES.flatMap((file, index) => existing.has(file) ? [] : [IGNORE_PATTERNS[index]]);
}

function gitEnvironment(excludeFile, env) {
  const countKey = Object.keys(env).find((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT');
  const raw = countKey ? env[countKey] : '0';
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw refuse('GIT_CONFIG_COUNT must be a nonnegative integer for Claude sandbox exclusions');
  }
  const index = Number(raw);
  return {
    ...withoutCoreExcludes(env),
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: 'core.excludesFile',
    [`GIT_CONFIG_VALUE_${index}`]: excludeFile,
  };
}

// An inherited core.excludesFile in GIT_CONFIG_PARAMETERS would win over the
// private one, so only that entry is dropped. Other entries keep their text,
// including a bare `'name'` that git reads as a boolean.
function withoutCoreExcludes(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'GIT_CONFIG_PARAMETERS');
  if (!key) return {};
  const entries = parameters(String(env[key]));
  const kept = entries.filter((entry) => entry.name.toLowerCase() !== 'core.excludesfile');
  if (kept.length === entries.length) return {};
  return { GIT_CONFIG_PARAMETERS: kept.map((entry) => entry.raw).join(' ') };
}

// Splits GIT_CONFIG_PARAMETERS the way git does: whitespace between entries
// ends one outside quotes, and the first unquoted `=` ends a name. Each entry
// keeps its original text, so its quoting reaches git unchanged.
function parameters(text) {
  const entries = [];
  let start = -1;
  let key = '';
  let name = null;
  let quote = null;
  let escaped = false;
  const begin = (index) => {
    if (start < 0) start = index;
  };
  const append = (char) => {
    if (name === null) key += char;
  };
  const end = (index) => {
    if (start < 0) return;
    entries.push({ raw: text.slice(start, index), name: name ?? key });
    start = -1;
    key = '';
    name = null;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      append(char);
    } else if (!quote && char === '\\') {
      begin(index);
      escaped = true;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === '\'' || char === '"')) {
      begin(index);
      quote = char;
    } else if (!quote && /\s/.test(char)) {
      end(index);
    } else if (!quote && char === '=' && name === null) {
      begin(index);
      name = key;
    } else {
      begin(index);
      append(char);
    }
  }
  if (quote || escaped) throw refuse('GIT_CONFIG_PARAMETERS is malformed for Claude sandbox exclusions');
  end(text.length);
  return entries;
}

function unsafePath(message) {
  return Object.assign(new Error(message), { code: 'ESYMLINK' });
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function candidate(cwd, relative) {
  const worktree = path.resolve(cwd);
  const inputStat = fs.lstatSync(worktree);
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) throw unsafePath('worktree root is not a real directory');
  const root = fs.realpathSync(worktree);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unsafePath('worktree realpath is not a directory');

  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw unsafePath(`ancestor of ${relative} is a symlink`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw unsafePath(`ancestor of ${relative} is not a directory`);
  }
  const real = fs.realpathSync(current);
  if (!inside(root, real)) throw unsafePath(`${relative} resolves outside the worktree`);
  const stat = fs.lstatSync(real);
  if (stat.isSymbolicLink()) throw unsafePath(`${relative} is a symlink`);
  const dir = path.dirname(real);
  return { file: real, dir, name: path.basename(real), stat, dirStat: fs.lstatSync(dir) };
}

function present(cwd) {
  return FILES.filter((relative) => {
    try {
      candidate(cwd, relative);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      return true;
    }
  });
}

// The change runs in a child process whose working directory is the checked
// directory. The working directory follows the directory itself, not its path,
// so a parent swapped for a symlink after the check cannot redirect the change.
// The child checks both identities again before it acts, and changes the file
// it opened, not the path.
const CHANGE_IN_DIRECTORY = `
const fs = require('node:fs');
const flag = (name) => fs.constants[name] || 0;
const want = JSON.parse(process.argv[1]);
const same = (stat) => stat.isFile() && stat.size === 0 && stat.nlink === 1 && stat.dev === want.dev && stat.ino === want.ino;
try {
  const dir = fs.lstatSync('.');
  if (!dir.isDirectory() || dir.dev !== want.dirDev || dir.ino !== want.dirIno) throw new Error('its directory changed during cleanup');
  let fd;
  try {
    fd = fs.openSync(want.name, flag('O_RDONLY') | flag('O_NONBLOCK') | flag('O_NOFOLLOW'));
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0);
    throw error;
  }
  let writable = false;
  try {
    const stat = fs.fstatSync(fd);
    writable = same(stat) && (stat.mode & 0o222) === 0;
    if (writable) fs.fchmodSync(fd, (stat.mode & 0o777) | 0o200);
  } finally {
    fs.closeSync(fd);
  }
  if (!writable) process.exit(0);
  if (!same(fs.lstatSync(want.name))) throw new Error('changed during cleanup');
  fs.unlinkSync(want.name);
  process.stdout.write('removed');
} catch (error) {
  process.stderr.write(error.message);
  process.exit(2);
}
`;

function unlinkChecked(entry) {
  const want = JSON.stringify({
    name: entry.name, dev: entry.stat.dev, ino: entry.stat.ino,
    dirDev: entry.dirStat.dev, dirIno: entry.dirStat.ino,
  });
  const run = childProcess.spawnSync(process.execPath, ['-e', CHANGE_IN_DIRECTORY, want], {
    cwd: entry.dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    windowsHide: true,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr.trim() || `cleanup exited with status ${run.status}`);
  return run.stdout === 'removed';
}

function remove(cwd, existedBefore) {
  const preserve = new Set(existedBefore);
  const removed = [];
  const failures = [];
  for (const relative of FILES) {
    if (preserve.has(relative)) continue;
    try {
      const entry = candidate(cwd, relative);
      if (!entry.stat.isFile() || entry.stat.size !== 0 || entry.stat.nlink !== 1 || (entry.stat.mode & 0o222) !== 0) continue;
      if (unlinkChecked(entry)) removed.push(relative);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failures.push({ relative, error });
    }
  }
  return { removed, failures };
}

module.exports = { FILES, IGNORE_PATTERNS, ignorePatterns, present, gitEnvironment, remove };
