'use strict';

// Rung and project env values are for the agent process only. Events,
// receipts, the spawn job file and spawn output keep each variable's name
// with MASK as its value; the supervisor receives the values in ENV, or in
// a private FILE it deletes on read when they do not fit one variable.

const fs = require('node:fs');
const path = require('node:path');

const MASK = '[redacted]';
const ENV = 'TOWER_CRANE_SPAWN_SECRETS';
const FILE = 'TOWER_CRANE_SPAWN_SECRETS_FILE';
// One environment entry: Linux caps it at 128 KiB, Windows at 32767 chars.
const LIMIT = process.platform === 'win32' ? 32000 : 120 * 1024;

const table = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Visits every `env` field in document order, which a JSON round trip keeps.
function walk(value, onEnv) {
  if (Array.isArray(value)) return value.map((v) => walk(v, onEnv));
  if (!table(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'env' ? onEnv(v) : walk(v, onEnv)]));
}

const masked = (env) => Object.fromEntries(Object.keys(env).map((k) => [k, MASK]));

// project set records its flags, where --env is still JSON text.
function redact(value) {
  return walk(value, (env) => {
    if (table(env)) return masked(env);
    if (typeof env !== 'string') return env;
    let parsed;
    try { parsed = JSON.parse(env); } catch { return env; }
    return table(parsed) ? JSON.stringify(masked(parsed)) : env;
  });
}

// The same rung env appears under several job fields; each value travels
// once and every env names it by index.
function split(value) {
  const values = [];
  const index = new Map();
  const envs = [];
  const out = walk(value, (env) => {
    if (!table(env)) return env;
    envs.push(Object.fromEntries(Object.entries(env).map(([k, v]) => {
      const key = JSON.stringify(v);
      if (!index.has(key)) index.set(key, values.push(v) - 1);
      return [k, index.get(key)];
    })));
    return masked(env);
  });
  return { value: out, secrets: { values, envs } };
}

function join(value, secrets) {
  const left = [...secrets.envs];
  const mismatch = () => new Error('spawn secrets do not match the job');
  const out = walk(value, (env) => {
    if (!table(env)) return env;
    if (!left.length) throw mismatch();
    return Object.fromEntries(Object.entries(left.shift()).map(([k, i]) => [k, secrets.values[i]]));
  });
  if (left.length) throw mismatch();
  return out;
}

// The supervisor's environment entries for these secrets; an oversized
// payload goes to a 0600 file in dir, which only this user can read.
function handoff(secrets, dir) {
  const text = JSON.stringify(secrets);
  if (Buffer.byteLength(text) + ENV.length + 2 <= LIMIT) return { [ENV]: text };
  const file = path.join(dir, 'secrets.json');
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  return { [FILE]: file };
}

// Takes the secrets out of env, deleting the file, so no child inherits them
// and none outlives the read. Undefined when the dispatch passed none.
function receive(env) {
  const text = env[ENV];
  const file = env[FILE];
  delete env[ENV];
  delete env[FILE];
  if (file === undefined) return text === undefined ? undefined : JSON.parse(text);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } finally { fs.rmSync(file, { force: true }); }
}

module.exports = { MASK, ENV, FILE, LIMIT, redact, split, join, handoff, receive };
