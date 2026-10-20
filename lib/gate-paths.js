'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

function errors(gates) {
  const list = gates?.clean_paths;
  if (list == null) return [];
  return Array.isArray(list) && list.every(p => typeof p === 'string' && p.trim()
    && !p.includes('\0') && (path.isAbsolute(p.trim()) || p.trim().startsWith('~/')))
    ? [] : ['gates.clean_paths must be a JSON array of absolute paths or ~/ paths without NUL bytes, or null'];
}

// Read literal shell words without evaluating the owner's command or its substitutions.
function literalWords(command) {
  const words = [];
  let word = '', quote = '';
  const flush = () => {
    if (word) words.push(word);
    word = '';
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return [];
      else if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) word += `\\${next}`;
      else if (next !== '\n') word += next;
    } else if (quote) {
      if (c === quote) quote = '';
      else {
        if (quote === '"' && (c === '$' || c === '`')) return words;
        word += c;
      }
    } else if (c === "'" || c === '"') quote = c;
    else if (/\s|[;&|<>()]/.test(c)) flush();
    else {
      if (c === '$' || c === '`' || c === '~' || c === '*' || c === '?' || c === '[') return words;
      word += c;
    }
  }
  if (quote) return [];
  flush();
  return words;
}

function within(p, dir) {
  const rel = path.relative(dir, p);
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return /\.(?:exe|com|bat|cmd|sh)$/i.test(file);
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Only the executable and a direct interpreter script are tools; other arguments are data.
function commandFiles(command) {
  const words = literalWords(command);
  if (words[0] === 'exec') words.shift();
  if (!words.length) return [];
  const files = [];
  const program = words[0];
  if (path.isAbsolute(program) && executable(program)) files.push(program);
  const interpreter = path.basename(program).replace(/\.exe$/i, '');
  if (/^(?:node|nodejs|python(?:\d+(?:\.\d+)?)?|bash|sh|dash|zsh|ruby|perl)$/.test(interpreter)
    && words[1] && path.isAbsolute(words[1])) files.push(words[1]);
  return files;
}

function reads(project, cwd, home) {
  const gates = project?.gates || {};
  const bad = errors(gates);
  if (bad.length) throw refuse(bad.join('; '));
  const root = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  const paths = new Set();
  const add = (file, declared = false) => {
    let actual;
    try {
      actual = fs.realpathSync(file);
      if (!fs.statSync(actual).isFile() && !fs.statSync(actual).isDirectory()) throw new Error('not a file or directory');
    } catch {
      if (declared) throw refuse(`gates.clean_paths path ${file} is not a readable file or directory`);
      return;
    }
    if (within(actual, root)) return;
    paths.add(actual);
    if (!declared) {
      paths.add(path.dirname(actual));
      paths.add(fs.realpathSync(path.dirname(file)));
    }
  };
  for (const key of ['clean_cmd', 'tests_proof_cmd']) {
    for (const file of commandFiles(gates[key] || '')) {
      if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) add(file);
    }
  }
  for (const file of gates.clean_paths || []) {
    const p = file.trim();
    add(p.startsWith('~/') ? path.join(home, p.slice(2)) : p, true);
  }
  for (const p of paths) {
    if (within(root, p) || within(home, p)) {
      throw refuse(`gate tool path ${p} holds the worktree or user's home; install the tool in a dedicated directory`);
    }
  }
  return [...paths];
}

module.exports = { errors, literalWords, reads };
