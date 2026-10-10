'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { refuse } = require('./util');

const FIELDS = ['sandbox', 'env', 'env_file', 'scope'];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const word = (v) => typeof v === 'string' && v.trim() && !v.includes('\0');
const reserved = (k) => /^(HOME|USERPROFILE|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CODING_AGENT_SESSION_DIR|PATH|TOWER_CRANE_.*)$/i.test(k);
const key = (k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !reserved(k);

function errors(doc) {
  const errs = [];
  if (doc.sandbox !== undefined) {
    const s = doc.sandbox;
    if (!object(s)) errs.push('sandbox must be an object');
    else {
      for (const k of Object.keys(s)) if (k !== 'write') errs.push(`sandbox: unknown field ${k}`);
      if (s.write !== undefined && (!Array.isArray(s.write) || !s.write.every(word))) errs.push('sandbox.write must be an array of non-blank paths without NUL bytes');
    }
  }
  if (doc.env !== undefined && (!object(doc.env) || !Object.entries(doc.env).every(([k, v]) => key(k) && typeof v === 'string' && !v.includes('\0')))) {
    errs.push('env must be an object of variable names and string values without NUL bytes; HOME, USERPROFILE, PATH, harness homes and TOWER_CRANE_* are reserved');
  }
  if (doc.env_file !== undefined && !word(doc.env_file)) errs.push('env_file must be a non-blank path without NUL bytes');
  if (doc.scope !== undefined && (!object(doc.scope) || !Object.entries(doc.scope).every(([k, v]) =>
    /^[A-Za-z][A-Za-z0-9]*$/.test(k) && word(v) && !/[\r\n]/.test(v)))) {
    errs.push('scope must be an object of systemd property names and non-blank string values without NUL bytes or newlines');
  }
  return errs;
}

function resolve(project, rung) {
  return {
    sandbox: { ...project.sandbox, ...rung.sandbox },
    env: { ...project.env, ...rung.env },
    env_file: rung.env_file ?? project.env_file,
    scope: rung.scope ?? project.scope,
  };
}

function expand(value, home, cwd) {
  const p = value === '~' ? home : /^~[/\\]/.test(value) ? path.join(home, value.slice(2)) : value;
  return path.resolve(cwd, p);
}

function prepare(settings, home, cwd) {
  return {
    ...settings,
    sandbox: { ...settings.sandbox, write: (settings.sandbox.write || []).map((p) => expand(p, home, cwd)) },
    env_file: settings.env_file ? expand(settings.env_file, home, cwd) : undefined,
  };
}

function scoped(settings) {
  return !!settings.scope && Object.keys(settings.scope).length > 0;
}

function scopeCommand(settings, argv) {
  if (!scoped(settings)) return argv;
  return ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no',
    ...Object.entries(settings.scope).flatMap(([k, v]) => ['-p', `${k}=${v}`]), '--', ...argv];
}

// EnvironmentFile quoting is not shell evaluation. Only an initial quote
// starts a quoted value; unquoted interior quotes remain literal.
function parseEnv(text, file) {
  const env = Object.create(null);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let assignmentLine = 1;
  const bad = () => { throw refuse(`invalid env_file ${file} at line ${assignmentLine}`); };
  const take = () => {
    const c = text[i++];
    if (c === '\n') line++;
    return c;
  };
  while (i < text.length) {
    while (i < text.length && /[ \t\r\n]/.test(text[i])) take();
    if (i === text.length) break;
    if (text[i] === '#' || text[i] === ';') {
      while (i < text.length && take() !== '\n') {}
      continue;
    }
    assignmentLine = line;
    let name = '';
    while (i < text.length && !['=', '\n'].includes(text[i])) name += take();
    name = name.trim();
    if (take() !== '=' || !key(name)) bad();
    while (i < text.length && /[ \t\r]/.test(text[i])) take();
    const quote = ['"', "'"].includes(text[i]) ? take() : null;
    let value = '';
    let whitespace = '';
    let closed = !quote;
    while (i < text.length) {
      const c = take();
      if (quote && c === quote) { closed = true; break; }
      if (!quote && c === '\n') break;
      if (c === '\\' && quote !== "'") {
        if (i === text.length) bad();
        const next = take();
        if (next === '\n') continue;
        if (quote === '"' && !['\\', '$', '`', '"'].includes(next)) value += '\\';
        value += whitespace + next;
        whitespace = '';
      } else if (!quote && /[ \t\r]/.test(c)) whitespace += c;
      else {
        value += whitespace + c;
        whitespace = '';
      }
    }
    if (!closed) bad();
    if (quote) {
      while (i < text.length && /[ \t\r]/.test(text[i])) take();
      if (i < text.length && take() !== '\n') bad();
    }
    if (value.includes('\0')) bad();
    env[name] = value;
  }
  return env;
}

function agentEnv(settings) {
  let fromFile = {};
  if (settings.env_file) {
    let text;
    try { text = fs.readFileSync(settings.env_file, 'utf8'); }
    catch (e) { throw refuse(`cannot read env_file ${settings.env_file} (${e.code})`); }
    fromFile = parseEnv(text, settings.env_file);
  }
  return { ...fromFile, ...settings.env, ...(scoped(settings) ? { TOWER_CRANE_SCOPED: '1' } : {}) };
}

// A parent test runner's context makes an agent's node --test skip all files.
function cleanAgentEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^NODE_TEST_/i.test(name)));
}

module.exports = { FIELDS, errors, resolve, prepare, agentEnv, cleanAgentEnv, scoped, scopeCommand };
