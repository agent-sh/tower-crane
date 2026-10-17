'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

// Denied dotfiles and .claude entries the sandbox mounts over in a worktree
// root. Only names that are empty, read-only regular files after exit are
// ever removed.
const MOUNTS = [
  ['.bash_profile', 'file'], ['.bashrc', 'file'], ['.gitconfig', 'file'],
  ['.gitmodules', 'file'], ['.idea', 'directory'], ['.mcp.json', 'file'],
  ['.profile', 'file'], ['.ripgreprc', 'file'], ['.vscode', 'directory'],
  ['.zprofile', 'file'], ['.zshrc', 'file'],
  ['.claude/agents', 'directory'], ['.claude/commands', 'directory'],
  ['.claude/hooks', 'directory'], ['.claude/launch.json', 'file'],
  ['.claude/loop.md', 'file'], ['.claude/output-styles', 'directory'],
  ['.claude/routines', 'directory'], ['.claude/scheduled_tasks.json', 'file'],
  ['.claude/settings.json', 'file'], ['.claude/settings.local.json', 'file'],
  ['.claude/skills', 'directory'], ['.claude/workflows', 'directory'],
];
const FILES = Object.freeze(MOUNTS.map(([name]) => name));
const REGULAR_FILES = Object.freeze(MOUNTS.filter(([, kind]) => kind === 'file').map(([name]) => name));
const DIRECTORIES = Object.freeze(MOUNTS.filter(([, kind]) => kind === 'directory').map(([name]) => name));
const IGNORE_PATTERNS = Object.freeze(FILES.map((file) => file.includes('/') ? file : `/${file}`));
// The sandbox makes .claude itself when a placeholder under it needs it, and
// keeps its write log in .claude/.cc-writes.
const PARENT = '.claude';
const WRITE_LOG = '.claude/.cc-writes';
// Empty directories go deepest first, so .claude can go after its children.
const EMPTY_DIRECTORIES = Object.freeze([...DIRECTORIES, WRITE_LOG, PARENT]);

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
// ends one outside quotes, and the first unquoted `=` ends a name. An entry
// with no unquoted `=` is the older `'name=value'` form, so its name ends at
// the first `=` inside the quotes. Each entry keeps its original text, so its
// quoting reaches git unchanged.
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
    entries.push({ raw: text.slice(start, index), name: name ?? key.split('=')[0] });
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
  // bigint stats keep the inodes the child checks exact: Windows file ids run
  // past 2^53, where a Number rounds neighbouring files to one id.
  const stat = fs.lstatSync(real, { bigint: true });
  if (stat.isSymbolicLink()) throw unsafePath(`${relative} is a symlink`);
  const dir = path.dirname(real);
  return { file: real, dir, name: path.basename(real), stat, dirStat: fs.lstatSync(dir, { bigint: true }) };
}

// The placeholder names, the write log and .claude that the worktree holds.
function present(cwd) {
  return [...FILES, WRITE_LOG, PARENT].filter((relative) => {
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
// The child renames the name aside before it checks anything, so the object it
// checks and removes is the one it moved. A replacement that fails the check is
// put back under its name: a file is linked back, since link never replaces a
// file that is there; a directory is renamed back, since link cannot take one,
// and a rename replaces only an empty directory.
const CHANGE_IN_DIRECTORY = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const flag = (name) => fs.constants[name] || 0;
const want = JSON.parse(process.argv[1]);
const moved = '.tower-crane-cleanup-' + crypto.randomUUID();
const same = (stat) => stat.isFile() && Number(stat.size) === 0 && Number(stat.nlink) === 1 && String(stat.dev) === want.dev && String(stat.ino) === want.ino;
const restore = () => {
  try {
    if (fs.lstatSync(moved).isDirectory()) {
      fs.renameSync(moved, want.name);
    } else {
      fs.linkSync(moved, want.name);
      fs.unlinkSync(moved);
    }
  } catch (error) {
    throw new Error('changed during cleanup, kept at ' + moved + ': ' + error.message);
  }
};
const isPlaceholder = () => {
  const fd = fs.openSync(moved, flag('O_RDONLY') | flag('O_NONBLOCK') | flag('O_NOFOLLOW'));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const mode = Number(stat.mode);
    if (!same(stat) || (mode & 0o222) !== 0) return false;
    fs.fchmodSync(fd, (mode & 0o777) | 0o200);
    return true;
  } finally {
    fs.closeSync(fd);
  }
};
try {
  const dir = fs.lstatSync('.', { bigint: true });
  if (!dir.isDirectory() || String(dir.dev) !== want.dirDev || String(dir.ino) !== want.dirIno) throw new Error('its directory changed during cleanup');
  // Nothing is moved unless the name still holds the checked object.
  const at = fs.lstatSync(want.name, { throwIfNoEntry: false, bigint: true });
  if (!at) process.exit(0);
  if (String(at.dev) !== want.dev || String(at.ino) !== want.ino) throw new Error('changed during cleanup');
  try {
    fs.renameSync(want.name, moved);
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0);
    throw error;
  }
  let placeholder;
  try {
    placeholder = isPlaceholder();
  } catch (error) {
    restore();
    throw error;
  }
  if (!placeholder) {
    restore();
    throw new Error('changed during cleanup');
  }
  fs.unlinkSync(moved);
  process.stdout.write('removed');
} catch (error) {
  process.stderr.write(error.message);
  process.exit(2);
}
`;

// rmdir only removes an empty directory, and runs in the checked directory, so
// neither a swapped parent nor a filled directory can be removed.
const RMDIR_IN_DIRECTORY = `
const fs = require('node:fs');
const want = JSON.parse(process.argv[1]);
try {
  const dir = fs.lstatSync('.', { bigint: true });
  if (!dir.isDirectory() || String(dir.dev) !== want.dirDev || String(dir.ino) !== want.dirIno) throw new Error('its directory changed during cleanup');
  const at = fs.lstatSync(want.name, { throwIfNoEntry: false, bigint: true });
  if (!at) process.exit(0);
  if (!at.isDirectory() || String(at.dev) !== want.dev || String(at.ino) !== want.ino) throw new Error('changed during cleanup');
  try {
    fs.rmdirSync(want.name);
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) process.exit(0);
    throw error;
  }
  process.stdout.write('removed');
} catch (error) {
  process.stderr.write(error.message);
  process.exit(2);
}
`;

function removeChecked(entry) {
  const want = JSON.stringify({
    name: entry.name, dev: String(entry.stat.dev), ino: String(entry.stat.ino),
    dirDev: String(entry.dirStat.dev), dirIno: String(entry.dirStat.ino),
  });
  const script = entry.stat.isDirectory() ? RMDIR_IN_DIRECTORY : CHANGE_IN_DIRECTORY;
  const run = childProcess.spawnSync(process.execPath, ['-e', script, want], {
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

const placeholderFile = (stat) => stat.isFile() && Number(stat.size) === 0 && Number(stat.nlink) === 1 && (Number(stat.mode) & 0o222) === 0;

// Removes the placeholders that are not in keep: each name that holds an
// empty, read-only, single-link file, then each placeholder directory and
// .claude that is empty.
function removeExcept(cwd, keep) {
  const removed = [];
  const failures = [];
  const each = (names, wanted) => {
    for (const relative of names) {
      if (keep.has(relative)) continue;
      try {
        const entry = candidate(cwd, relative);
        if (!wanted(entry.stat)) continue;
        if (removeChecked(entry)) removed.push(relative);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failures.push({ relative, error });
      }
    }
  };
  each(FILES, placeholderFile);
  each(EMPTY_DIRECTORIES, (stat) => stat.isDirectory());
  return { removed, failures };
}

// After an agent: what the sandbox left that was not there before it.
function remove(cwd, existedBefore) {
  return removeExcept(cwd, new Set(existedBefore));
}

// Before a spawn: placeholders an agent whose cleanup never ran left behind.
// The next spawn would take one for the worktree's own file, leave it out of
// the exclude file, and let it be committed. Whatever git tracks stays; git
// cannot read the worktree, nothing is removed.
function sweep(cwd, env = process.env) {
  if (!present(cwd).length) return { removed: [], failures: [] };
  const r = childProcess.spawnSync('git', ['ls-files', '-z', '--cached', '--', ...FILES, WRITE_LOG, PARENT], {
    cwd, env: require('./harness-git').harnessEnv(env, cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true,
  });
  if (r.error || r.status !== 0) return { removed: [], failures: [] };
  const tracked = String(r.stdout).split('\0').filter(Boolean);
  const keep = new Set([...FILES, WRITE_LOG, PARENT].filter((name) => tracked.some((file) => file === name || file.startsWith(`${name}/`))));
  return removeExcept(cwd, keep);
}

// The placeholder names a commit range adds as empty files.
function committed(root, base, head, env = process.env) {
  const git = (args) => childProcess.spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, windowsHide: true });
  const added = git(['diff', '--no-renames', '--no-ext-diff', '--diff-filter=A', '--name-only', '-z', base, head, '--', ...REGULAR_FILES]);
  if (added.error || added.status !== 0) return [];
  return String(added.stdout).split('\0').filter((name) => REGULAR_FILES.includes(name)).filter((name) => {
    const size = git(['cat-file', '-s', `${head}:${name}`]);
    return size.status === 0 && String(size.stdout).trim() === '0';
  });
}

module.exports = { FILES, REGULAR_FILES, DIRECTORIES, IGNORE_PATTERNS, ignorePatterns, present, gitEnvironment, remove, sweep, committed };
