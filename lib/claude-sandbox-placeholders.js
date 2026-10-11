'use strict';

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

function withoutCoreExcludes(env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'GIT_CONFIG_PARAMETERS');
  if (!key) return {};
  const parameters = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of String(env[key])) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (!quote && char === '\\') {
      escaped = true;
    } else if (quote && char === quote) {
      quote = null;
    } else if (!quote && (char === '\'' || char === '"')) {
      quote = char;
    } else if (!quote && /\s/.test(char)) {
      if (token) {
        parameters.push(token);
        token = '';
      }
    } else {
      token += char;
    }
  }
  if (quote || escaped) throw refuse('GIT_CONFIG_PARAMETERS is malformed for Claude sandbox exclusions');
  if (token) parameters.push(token);

  const kept = parameters.filter((parameter) => {
    const equal = parameter.indexOf('=');
    if (equal < 1) throw refuse('GIT_CONFIG_PARAMETERS is malformed for Claude sandbox exclusions');
    return parameter.slice(0, equal).toLowerCase() !== 'core.excludesfile';
  });
  if (kept.length === parameters.length) return {};
  const quoteValue = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  return { GIT_CONFIG_PARAMETERS: kept.map(quoteValue).join(' ') };
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
  return { file: real, stat };
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

function remove(cwd, existedBefore) {
  const preserve = new Set(existedBefore);
  const removed = [];
  const failures = [];
  for (const relative of FILES) {
    if (preserve.has(relative)) continue;
    try {
      const before = candidate(cwd, relative);
      if (!before.stat.isFile() || before.stat.size !== 0 || before.stat.nlink !== 1 || (before.stat.mode & 0o222) !== 0) continue;

      const writable = candidate(cwd, relative);
      if (!writable.stat.isFile() || writable.stat.size !== 0
        || before.stat.dev !== writable.stat.dev || before.stat.ino !== writable.stat.ino) continue;
      fs.chmodSync(writable.file, (writable.stat.mode & 0o777) | 0o200);

      const after = candidate(cwd, relative);
      if (!after.stat.isFile() || after.stat.size !== 0 || after.stat.nlink !== 1
        || before.stat.dev !== after.stat.dev || before.stat.ino !== after.stat.ino) continue;
      fs.unlinkSync(after.file);
      removed.push(relative);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failures.push({ relative, error });
    }
  }
  return { removed, failures };
}

module.exports = { FILES, IGNORE_PATTERNS, ignorePatterns, present, gitEnvironment, remove };
