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

// symlink marks a name that is a symlink, or lies under one: no sandbox makes
// one, so it is the worktree's own.
function unsafePath(message, symlink = false) {
  return Object.assign(new Error(message), { code: 'ESYMLINK', symlink });
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
    if (stat.isSymbolicLink()) throw unsafePath(`ancestor of ${relative} is a symlink`, true);
    if (index < parts.length - 1 && !stat.isDirectory()) throw unsafePath(`ancestor of ${relative} is not a directory`);
  }
  const real = fs.realpathSync(current);
  if (!inside(root, real)) throw unsafePath(`${relative} resolves outside the worktree`);
  // bigint stats keep the inodes the child checks exact: Windows file ids run
  // past 2^53, where a Number rounds neighbouring files to one id.
  const stat = fs.lstatSync(real, { bigint: true });
  if (stat.isSymbolicLink()) throw unsafePath(`${relative} is a symlink`, true);
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
// A live sandbox may bind over the name from its own mount namespace, and
// moving or unlinking the name on the host would take it from under that bind,
// so the sandboxed command could write the name. The mount tables are read
// just before the rename, and again after it, when a bind made in between
// shows under the moved name; such a name is renamed back, which keeps the
// bind on it, and kept. A name is kept too where a table cannot be read.
const MOUNT_CHECK = `
const { mountedOver } = require(want.lib);
const heldBy = (paths) => {
  const mounted = mountedOver(paths);
  return mounted === true ? 'mounted' : mounted === null ? 'unknown' : null;
};
const keep = (why) => {
  process.stdout.write(why);
  process.exit(0);
};
`;

const CHANGE_IN_DIRECTORY = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const flag = (name) => fs.constants[name] || 0;
const want = JSON.parse(process.argv[1]);
${MOUNT_CHECK}
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
  const before = heldBy(want.mounts);
  if (before) keep(before);
  try {
    fs.renameSync(want.name, moved);
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0);
    throw error;
  }
  const after = heldBy(want.dirs.map((dir) => dir + '/' + moved));
  if (after) {
    try {
      fs.renameSync(moved, want.name);
    } catch (error) {
      throw new Error('a sandbox bound it during cleanup, kept at ' + moved + ': ' + error.message);
    }
    keep(after);
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
// neither a swapped parent nor a filled directory can be removed. Like a file,
// the directory is renamed aside between two reads of the mount tables, since
// rmdir would detach a bind over it as unlink does, and renamed back when it
// is bound or no longer empty; a rename back replaces only an empty directory.
const RMDIR_IN_DIRECTORY = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const want = JSON.parse(process.argv[1]);
const moved = '.tower-crane-cleanup-' + crypto.randomUUID();
${MOUNT_CHECK}
const back = (why) => {
  try {
    fs.renameSync(moved, want.name);
  } catch (error) {
    throw new Error(why + ', kept at ' + moved + ': ' + error.message);
  }
};
try {
  const dir = fs.lstatSync('.', { bigint: true });
  if (!dir.isDirectory() || String(dir.dev) !== want.dirDev || String(dir.ino) !== want.dirIno) throw new Error('its directory changed during cleanup');
  const at = fs.lstatSync(want.name, { throwIfNoEntry: false, bigint: true });
  if (!at) process.exit(0);
  if (!at.isDirectory() || String(at.dev) !== want.dev || String(at.ino) !== want.ino) throw new Error('changed during cleanup');
  // A directory with entries stays where it is: it is never moved aside.
  if (fs.readdirSync(want.name).length) process.exit(0);
  const before = heldBy(want.mounts);
  if (before) keep(before);
  try {
    fs.renameSync(want.name, moved);
  } catch (error) {
    if (error.code === 'ENOENT') process.exit(0);
    throw error;
  }
  const now = fs.lstatSync(moved, { bigint: true });
  if (!now.isDirectory() || String(now.dev) !== want.dev || String(now.ino) !== want.ino) {
    back('changed during cleanup');
    throw new Error('changed during cleanup');
  }
  const after = heldBy(want.dirs.map((dir) => dir + '/' + moved));
  if (after) {
    back('a sandbox bound it during cleanup');
    keep(after);
  }
  try {
    fs.rmdirSync(moved);
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) {
      back('filled during cleanup');
      process.exit(0);
    }
    throw error;
  }
  process.stdout.write('removed');
} catch (error) {
  process.stderr.write(error.message);
  process.exit(2);
}
`;

// The name's paths a sandbox can mount at: the worktree as given and as
// resolved. 'removed', 'mounted' or 'unknown' (kept), or '' when it was gone.
function removeChecked(entry, cwd, relative) {
  const given = path.join(path.resolve(cwd), ...relative.split('/'));
  const mounts = [...new Set([entry.file, given])];
  const want = JSON.stringify({
    name: entry.name, dev: String(entry.stat.dev), ino: String(entry.stat.ino),
    dirDev: String(entry.dirStat.dev), dirIno: String(entry.dirStat.ino),
    lib: path.join(__dirname, 'git-placeholders.js'), mounts, dirs: mounts.map((p) => path.dirname(p)),
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
  return run.stdout;
}

const placeholderFile = (stat) => stat.isFile() && Number(stat.size) === 0 && Number(stat.nlink) === 1 && (Number(stat.mode) & 0o222) === 0;

// Removes the placeholders that are not in keep: each name that holds an
// empty, read-only, single-link file, then each placeholder directory and
// .claude that is empty. quietLinks leaves a symlinked name out of failures.
// held lists the names kept for a live sandbox's bind, with why.
function removeExcept(cwd, keep, quietLinks = false) {
  const removed = [];
  const failures = [];
  const held = [];
  const each = (names, wanted) => {
    for (const relative of names) {
      if (keep.has(relative)) continue;
      try {
        const entry = candidate(cwd, relative);
        if (!wanted(entry.stat)) continue;
        const outcome = removeChecked(entry, cwd, relative);
        if (outcome === 'removed') removed.push(relative);
        else if (outcome) held.push({ relative, why: outcome });
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && !(quietLinks && error.symlink)) failures.push({ relative, error });
      }
    }
  };
  each(FILES, placeholderFile);
  each(EMPTY_DIRECTORIES, (stat) => stat.isDirectory());
  return { removed, failures, held };
}

// One line for the names kept for a sandbox's bind, or null.
function heldLine(held, what) {
  if (!held?.length) return null;
  const names = [...new Set(held.map((h) => h.relative))];
  const them = names.length === 1 ? 'it' : 'them';
  const reasons = [];
  if (held.some((h) => h.why === 'mounted')) reasons.push(`a live sandbox binds over ${them}, and removing a bound name would let that sandbox write it`);
  if (held.some((h) => h.why === 'unknown')) reasons.push(`a mount table of this user's processes could not be read, so a sandbox may bind over ${them}`);
  return `tower-crane: kept ${what} ${names.join(', ')}: ${reasons.join('; ')}\n`;
}

// After an agent: what the sandbox left that was not there before it.
function remove(cwd, existedBefore) {
  return removeExcept(cwd, new Set(existedBefore));
}

// Before a spawn: placeholders an agent whose cleanup never ran left behind.
// The next spawn would take one for the worktree's own file, leave it out of
// the exclude file, and let it be committed. Whatever git tracks stays; git
// cannot read the worktree, nothing is removed. A name a live sandbox, such
// as another agent's on the same task, binds over stays (removeChecked). A
// symlink by a placeholder name is the worktree's own, and spawns pass it by
// without a warning each time.
function sweep(cwd, env = process.env) {
  if (!present(cwd).length) return { removed: [], failures: [], held: [] };
  const r = childProcess.spawnSync('git', ['ls-files', '-z', '--cached', '--', ...FILES, WRITE_LOG, PARENT], {
    cwd, env: require('./harness-git').harnessEnv(env, cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000, windowsHide: true,
  });
  if (r.error || r.status !== 0) return { removed: [], failures: [], held: [] };
  const tracked = String(r.stdout).split('\0').filter(Boolean);
  const keep = new Set([...FILES, WRITE_LOG, PARENT].filter((name) => tracked.some((file) => file === name || file.startsWith(`${name}/`))));
  return removeExcept(cwd, keep, true);
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

module.exports = { FILES, REGULAR_FILES, DIRECTORIES, IGNORE_PATTERNS, ignorePatterns, present, gitEnvironment, remove, sweep, committed, heldLine };
