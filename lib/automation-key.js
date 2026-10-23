'use strict';

// Engine helpers that run the CLI as a child process (the spawn supervisor
// and the harness hook bridge) prove they act for the engine with a key from
// the dispatched agent's home. TOWER_CRANE_VIA=automation alone carries no
// authority: any process can set it. The key binds the claim to that one
// agent; a process that reads homes directly is outside what the lease
// protects, as for any direct state write.
//
// The key never travels in an environment: Linux keeps a process's initial
// environment readable in /proc/<pid>/environ for its whole life, whatever
// the process deletes later. A helper writes it as the first line of its
// child's stdin and names that descriptor in TOWER_CRANE_AUTOMATION_KEY_FD.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sleepSync, refuse } = require('./util');

const FD_ENV = 'TOWER_CRANE_AUTOMATION_KEY_FD';
const NAME = /^[A-Za-z][\w.-]*$/;
// A key is 64 hex digits. A longer first line is not one, and dropping it
// would leave its tail as the command's input, so it is refused.
const MAX_LINE = 256;

function file(stateDir, agent) {
  return path.join(stateDir, 'homes', agent, 'automation.key');
}

// Staged beside the key and renamed over it, so a helper reading the key
// while a home is rebuilt finds the whole old key, the whole new one or none,
// never an empty or partial one.
function create(home) {
  const target = path.join(home, 'automation.key');
  const staged = path.join(home, `.automation.key.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(staged, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flush: true });
  require('./state').renameRetry(staged, target);
}

function read(stateDir, agent) {
  if (!stateDir || typeof agent !== 'string' || !NAME.test(agent)) return null;
  try { return fs.readFileSync(file(stateDir, agent), 'utf8').trim() || null; } catch { return null; }
}

// What a helper gives its CLI child: the environment marks and the first line
// of the child's stdin. Without a readable key the line is empty and the child
// runs as its agent's own native command.
function present(stateDir, agent) {
  const key = read(stateDir, agent);
  return { env: { TOWER_CRANE_VIA: 'automation', [FD_ENV]: '0' }, input: `${key || ''}\n` };
}

// Reads the key line from the descriptor the helper named, one byte at a
// time so the rest of stdin stays for the command's own input.
function take(env) {
  const fd = env[FD_ENV];
  delete env[FD_ENV];
  if (typeof fd !== 'string' || !/^\d+$/.test(fd)) return undefined;
  // Helpers always pipe the key. A marker leaked into an interactive shell
  // must not wait on the terminal for a line nobody will type.
  if (require('node:tty').isatty(Number(fd))) return undefined;
  const bytes = [];
  const one = Buffer.alloc(1);
  while (bytes.length <= MAX_LINE) { // spin-allow: reads one line of piped input, which its writer ends
    let n;
    try {
      n = fs.readSync(Number(fd), one, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        sleepSync(10);
        continue;
      }
      return undefined;
    }
    if (n === 0 || one[0] === 0x0a) return Buffer.from(bytes).toString('utf8');
    bytes.push(one[0]);
  }
  throw refuse(`the automation key line on descriptor ${fd} is longer than ${MAX_LINE} bytes; a helper writes the 64-digit key from homes/<agent>/automation.key`);
}

function verify(env, given, stateDir, agent) {
  if (env?.TOWER_CRANE_VIA !== 'automation' || typeof given !== 'string' || !given.trim()) return false;
  const key = read(stateDir, agent);
  if (!key) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(given.trim()), digest(key));
}

module.exports = { FD_ENV, file, create, present, take, verify };
