'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseUsage, records } = require('./usage');

function read(file, encoding = 'utf8') {
  const empty = () => encoding ? '' : Buffer.alloc(0);
  if (!file) return empty();
  try { return fs.readFileSync(file, encoding); } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return empty();
    throw e;
  }
}

function sessionId(log) {
  const text = /^session id:\s*([a-f0-9-]{36})\s*$/m.exec(log)?.[1];
  return text || records(log).find((r) => r.type === 'thread.started')?.thread_id;
}

function codexSession(root, id) {
  if (!root || !/^[a-f0-9-]{36}$/.test(id || '')) return '';
  // Only rollout files for the exact id printed by this spawn are opened.
  // No config, auth, unrelated transcripts or "most recent" guessing.
  function find(dir) {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (['ENOENT', 'ENOTDIR'].includes(e.code)) return '';
      throw e;
    }
    for (const entry of names) {
      if (entry.isDirectory()) {
        const found = find(path.join(dir, entry.name));
        if (found) return found;
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) {
        return read(path.join(dir, entry.name));
      }
    }
    return '';
  }
  return find(path.join(root, 'sessions'));
}

function readLog(spawn) {
  const raw = read(spawn.log, null);
  return raw.subarray(spawn.log_start || 0, spawn.log_end ?? raw.length).toString('utf8');
}

// Only an invocation result can supersede Claude's reconciled session total.
function readResult(spawn) {
  if (spawn.harness !== 'claude') return null;
  const result = records(readLog(spawn)).findLast((r) => r.type === 'result' && r.usage);
  return result ? parseUsage('claude', JSON.stringify(result)) : null;
}

function readUsage(spawn) {
  const log = readLog(spawn);
  const root = spawn.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const session = spawn.harness === 'codex' ? codexSession(root, sessionId(log)) : '';
  return parseUsage(spawn.harness, log, session);
}

// claude writes each session to <config dir>/projects/<cwd slug>/<id>.jsonl as
// it runs. Only the file named for this spawn's own session id is opened.
function claudeSession(root, id) {
  if (!root || !/^[a-f0-9-]{36}$/.test(id || '')) return '';
  let dirs;
  try { dirs = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true }); } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes(e.code)) return '';
    throw e;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const text = read(path.join(root, 'projects', dir.name, `${id}.jsonl`));
    if (text) return text;
  }
  return '';
}

// Usage so far of a running spawn's current segment, from the harness's own
// session data; null when the harness exposes none yet. Claude's stream or
// session file can lead the other, so keep the larger observed total.
function readLive(spawn) {
  if (spawn.harness === 'claude') {
    const log = readUsage(spawn);
    let session;
    try { session = parseUsage('claude', claudeSession(spawn.claude_home, spawn.session_id)); } catch (e) {
      if (log) return log;
      throw e;
    }
    return !session || log && log.tokens > session.tokens ? log : session;
  }
  return readUsage(spawn);
}

module.exports = { readUsage, readLive, readResult };
