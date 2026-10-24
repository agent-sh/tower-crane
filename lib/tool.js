'use strict';

// The Tower Crane code this process runs, and the newest engine code the
// project's event log records. An executor whose tool is behind that record
// runs no reaction, gate, merge or dispatch: gate rules live in the tool, so a
// stale copy would judge and merge by rules the project has already replaced.

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const { refuse } = require('./util');

const ROOT = path.resolve(__dirname, '..');
// Events only the engine writes, each carrying the tool that wrote or started it.
const RECORDS = new Set(['automation', 'merge queue', 'spawn', 'accept', 'merge']);
let own;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function real(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// A snapshot pins its tool.json; a checkout reads its HEAD and commit time; an
// installed package has only its version.
function current() {
  if (!own) {
    const pinned = readJson(path.join(ROOT, 'tool.json'));
    const version = readJson(path.join(ROOT, 'package.json'))?.version ?? null;
    if (pinned) own = { sha: pinned.sha ?? null, version, committed: pinned.committed ?? null };
    else {
      const top = S.git(['rev-parse', '--show-toplevel'], ROOT);
      const checkout = !!top && real(top) === real(ROOT);
      own = { sha: checkout ? S.git(['rev-parse', 'HEAD'], ROOT) : null, version,
        committed: checkout ? S.git(['log', '-1', '--format=%cI', 'HEAD'], ROOT) : null };
    }
  }
  return own;
}

function parts(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return m ? m.slice(1).map(Number) : null;
}

// Whether tool a is older than tool b: a lower release version, or the same
// version at an earlier commit. Tools that cannot be ordered are not behind.
function behind(a, b) {
  const x = parts(a?.version);
  const y = parts(b?.version);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  if (a.sha && b.sha && a.sha === b.sha) return false;
  const t = Date.parse(a.committed);
  const u = Date.parse(b.committed);
  return Number.isFinite(t) && Number.isFinite(u) && t < u;
}

function recorded(e) {
  const tool = e.detail?.tool;
  return (RECORDS.has(e.cmd) || e.cmd.startsWith('check ')) && tool && typeof tool === 'object' && parts(tool.version)
    ? { sha: tool.sha ?? null, version: tool.version, committed: tool.committed ?? null } : null;
}

// The newest tool any engine record names, or null before any engine recorded one.
function newest(events) {
  let best = null;
  for (const e of events) {
    const tool = recorded(e);
    if (tool && (!best || behind(best, tool))) best = tool;
  }
  return best;
}

// The project's newest engine tool when this process's tool is behind it.
function stale(st) {
  const engine = newest(st.events);
  return engine && behind(current(), engine) ? engine : null;
}

function describe(tool) {
  if (!tool) return 'unknown';
  return [tool.version || 'unversioned', tool.sha ? String(tool.sha).slice(0, 8) : null].filter(Boolean).join(' ');
}

function staleText(engine) {
  return `this tool (${describe(current())}) is behind the project's engine (${describe(engine)})`;
}

function refuseStale(st, what) {
  const engine = stale(st);
  if (engine) throw Object.assign(refuse(`${what} refused: ${staleText(engine)}; run it with the current tool`), { staleTool: engine });
}

// Live executors and the tool each runs: running reaction receipts, the merge
// queue's holder and spawn supervisors, which react once their agents exit.
// A receipt without a tool came from code older than this record, so it is
// stale once any engine has recorded one.
function executors(st, now = Date.now()) {
  const P = require('./processes');
  const engine = newest(st.events);
  const out = [];
  const add = (kind, e, d, pid, extra = {}) => {
    const tool = d.tool && typeof d.tool === 'object' ? { sha: d.tool.sha ?? null, version: d.tool.version ?? null } : null;
    out.push({ kind, task: e.task || null, ...extra, pid, host: d.host || null, since: e.at,
      age_s: Math.max(0, Math.round((now - Date.parse(e.at)) / 1000)), tool,
      stale: !!engine && (tool ? behind(d.tool, engine) : true) });
  };
  const reactions = new Map();
  let queue = null;
  const spawns = new Map();
  for (const e of st.events) {
    if (e.cmd === 'automation') reactions.set(e.task, e);
    else if (e.cmd === 'merge queue' && e.detail.phase !== 'requested') queue = e;
    else if (e.cmd === 'spawn' && e.detail.agent) spawns.set(e.detail.agent, e);
  }
  for (const e of reactions.values()) {
    if (e.detail.phase === 'running' && P.processState(e.detail) !== 'exited') add('reaction', e, e.detail, e.detail.pid);
  }
  if (queue?.detail.phase === 'running' && P.processState(queue.detail) !== 'exited') add('merge queue', queue, queue.detail, queue.detail.pid);
  for (const e of spawns.values()) {
    const d = e.detail;
    if (Number.isInteger(d.monitor_pid)
      && P.processState({ pid: d.monitor_pid, host: d.host, start_ticks: d.monitor_start_ticks }) === 'running') {
      add('supervisor', e, d, d.monitor_pid, { agent: d.agent });
    }
  }
  return { engine, executors: out };
}

function age(s) {
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function executorLine({ engine, executors: list }) {
  const item = (x) => [x.kind, x.agent ? `${x.agent} (${x.task})` : x.task, `pid ${x.pid}${x.host ? ` on ${x.host}` : ''}`]
    .filter(Boolean).join(' ') + `, tool ${describe(x.tool)}, ${age(x.age_s)}${x.stale ? ', STALE' : ''}`;
  return `executors${engine ? ` (engine ${describe(engine)})` : ''}: ${list.length ? list.map(item).join('; ') : 'none'}`;
}

module.exports = { current, behind, newest, stale, describe, staleText, refuseStale, executors, executorLine };
