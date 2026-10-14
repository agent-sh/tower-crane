'use strict';

// Engine helpers that run the CLI as a child process (the spawn supervisor
// and the harness hook bridge) prove they act for the engine with a key from
// the dispatched agent's home. TOWER_CRANE_VIA=automation alone carries no
// authority: any process can set it. The key binds the claim to that one
// agent; a process that reads homes directly is outside what the lease
// protects, as for any direct state write.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENV = 'TOWER_CRANE_AUTOMATION_KEY';
const NAME = /^[A-Za-z][\w.-]*$/;

function file(stateDir, agent) {
  return path.join(stateDir, 'homes', agent, 'automation.key');
}

function create(home) {
  fs.writeFileSync(path.join(home, 'automation.key'), `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
}

function read(stateDir, agent) {
  if (!stateDir || typeof agent !== 'string' || !NAME.test(agent)) return null;
  try { return fs.readFileSync(file(stateDir, agent), 'utf8').trim() || null; } catch { return null; }
}

// The environment for a helper's CLI child. Without a readable key the
// child runs as its agent's own native command.
function env(stateDir, agent) {
  const key = read(stateDir, agent);
  return { TOWER_CRANE_VIA: 'automation', ...(key ? { [ENV]: key } : {}) };
}

function verify(env, given, stateDir, agent) {
  if (env?.TOWER_CRANE_VIA !== 'automation' || typeof given !== 'string' || !given.trim()) return false;
  const key = read(stateDir, agent);
  if (!key) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(given.trim()), digest(key));
}

module.exports = { ENV, file, create, env, verify };
