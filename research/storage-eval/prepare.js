'use strict';
// Builds the three datasets from a copy of a live state directory:
//   live  the copy as it is
//   s50   the newest 50 MiB of its event log (cut at a line boundary)
//   s200  the live log after a prefix of re-identified copies of events of
//         finished tasks, up to 200 MiB
// Each dataset gets the T254 files (A), a SQLite database (B) and a Valkey
// AOF directory (D) holding the same tasks and events.
// With --cli it writes only the files, for a run of a real CLI (B-cli), and
// also sets the bench tasks back to todo, since a newer live copy has them
// finished, and lifts the worker limit above the bench's writers.
// Usage: node prepare.js --src DIR --out DIR [--only NAME] [--cli]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const B = require('./stores/sqlite');
const D = require('./stores/valkey');
const { Resp } = require('./stores/resp');

const MiB = 1 << 20;
const BENCH_TASKS = ['T155', 'T166', 'T189', 'T194', 'T195', 'T196', 'T202', 'T206'];
const KEEP = ['project.json', 'tasks.json', 'decisions.json', 'briefs', 'evidence', 'progress', 'reviews', 'sketch.md', 'sketch.html'];
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };

function lines(buf) {
  const out = buf.toString('utf8').split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}

function eventsFor(name, live) {
  if (name === 'live') return live;
  if (name === 's50') {
    let start = live.length - 50 * MiB;
    start = live.indexOf(10, start) + 1;
    return live.subarray(start);
  }
  const closed = new Set(JSON.parse(fs.readFileSync(path.join(arg('src'), 'tasks.json'), 'utf8')).tasks
    .filter((t) => ['accepted', 'cancelled'].includes(t.status)).map((t) => t.id));
  const pool = lines(live).filter((l) => {
    if (l.includes('"cmd":"msg"') || l.includes('"cmd":"hook inbox"')) return false;
    try { return closed.has(JSON.parse(l).task); } catch { return false; }
  });
  const need = 200 * MiB - live.length;
  const pad = [];
  let size = 0;
  for (let i = 0; size < need; i++) {
    const l = pool[i % pool.length].replace(/"id":"E[0-9a-f-]{36}"/, `"id":"E${crypto.randomUUID()}"`).replace(/"at":"2026-/, '"at":"2025-');
    pad.push(l);
    size += Buffer.byteLength(l) + 1;
  }
  return Buffer.concat([Buffer.from(pad.join('\n') + '\n'), live]);
}

async function waitFor(fn, ms = 120000) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function buildValkey(dir, tasksDoc, eventLines) {
  fs.mkdirSync(dir, { recursive: true });
  const port = 6391;
  const srv = spawn('valkey-server', ['--port', String(port), '--bind', '127.0.0.1', '--dir', dir, '--appendonly', 'yes',
    '--appendfsync', 'no', '--save', '', '--auto-aof-rewrite-percentage', '0', '--logfile', path.join(dir, 'valkey.log')], { stdio: 'ignore' });
  let exited = false;
  srv.once('exit', () => { exited = true; });
  try {
    return await load(srv, () => exited, port, tasksDoc, eventLines);
  } finally {
    if (!exited) srv.kill('SIGKILL');
  }
}

async function load(srv, exited, port, tasksDoc, eventLines) {
  let c;
  await waitFor(async () => {
    if (exited()) throw new Error('valkey-server exited');
    c = await Resp.connect({ port });
    return (await c.call('PING')) === 'PONG';
  });
  await D.importState(port, tasksDoc, eventLines);
  await c.call('BGREWRITEAOF');
  await waitFor(async () => {
    const info = await c.call('INFO', 'persistence');
    return /aof_rewrite_in_progress:0/.test(info) && /aof_rewrite_scheduled:0/.test(info);
  }, 600000);
  const mem = (await c.call('INFO', 'memory')).match(/used_memory_human:(\S+)/)[1];
  const gone = new Promise((r) => srv.once('exit', r));
  await c.call('SHUTDOWN').catch(() => {});
  await gone;
  return mem;
}

async function main() {
  const src = arg('src');
  const out = arg('out');
  const live = fs.readFileSync(path.join(src, 'events.jsonl'));
  // Benchmark-only edits so the real CLI can run the workload on a copy: the
  // owner's pause is lifted, the live orchestrator's lease is dropped (the
  // bench process takes it), and the bench tasks lose their PR numbers so
  // submit does not ask GitHub about commits that do not exist.
  const tasksDoc = JSON.parse(fs.readFileSync(path.join(src, 'tasks.json'), 'utf8'));
  delete tasksDoc.orchestrator_lease;
  for (const t of tasksDoc.tasks) if (BENCH_TASKS.includes(t.id)) t.pr = null;
  const project = JSON.parse(fs.readFileSync(path.join(src, 'project.json'), 'utf8'));
  delete project.limits.paused;
  const cliOnly = process.argv.includes('--cli');
  if (cliOnly) {
    for (const t of tasksDoc.tasks) if (BENCH_TASKS.includes(t.id)) {
      Object.assign(t, { status: 'todo', claim: null, sha: null, submitted_by: null, needs_owner: null, depends_on: [], locks: [], branch: null });
      for (const k of ['superseded_by', 'folded_into', 'hotfix', 'stack', 'stack_disabled', 'worktree', 'github_stack']) delete t[k];
    }
    project.limits.workers = 50;
  }
  const manifest = {};
  for (const name of ['live', 's50', 's200']) {
    if (arg('only') && arg('only') !== name) continue;
    const root = path.join(out, name);
    fs.rmSync(root, { recursive: true, force: true });
    const files = path.join(root, 'files');
    fs.mkdirSync(files, { recursive: true });
    for (const k of KEEP) if (fs.existsSync(path.join(src, k))) execFileSync('cp', ['-r', path.join(src, k), files]);
    fs.writeFileSync(path.join(files, 'tasks.json'), JSON.stringify(tasksDoc, null, 2) + '\n');
    fs.writeFileSync(path.join(files, 'project.json'), JSON.stringify(project, null, 2) + '\n');
    const events = eventsFor(name, live);
    fs.writeFileSync(path.join(files, 'events.jsonl'), events);
    if (cliOnly) {
      manifest[name] = { events_bytes: events.length, tasks: tasksDoc.tasks.length, tasks_json_bytes: fs.statSync(path.join(files, 'tasks.json')).size };
      process.stdout.write(`${name} ${JSON.stringify(manifest[name])}\n`);
      continue;
    }
    const eventLines = lines(events);
    let t = Date.now();
    B.importState(path.join(root, 'store.sqlite'), tasksDoc, eventLines);
    const sqliteMs = Date.now() - t;
    t = Date.now();
    const valkeyMem = await buildValkey(path.join(root, 'valkey'), tasksDoc, eventLines);
    const state = eventLines.filter((l) => { try { return !!require('./stores/files').parseEvent(l); } catch { return false; } });
    manifest[name] = { events_bytes: events.length, events: eventLines.length, state_events: state.length,
      state_event_bytes: state.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0), tasks: tasksDoc.tasks.length,
      tasks_json_bytes: fs.statSync(path.join(src, 'tasks.json')).size,
      sqlite_bytes: fs.statSync(path.join(root, 'store.sqlite')).size, sqlite_import_ms: sqliteMs,
      valkey_aof_bytes: Number(execFileSync('du', ['-sb', path.join(root, 'valkey', 'appendonlydir')]).toString().split('\t')[0]),
      valkey_used_memory: valkeyMem, valkey_import_ms: Date.now() - t };
    process.stdout.write(`${name} ${JSON.stringify(manifest[name])}\n`);
  }
  const file = path.join(out, 'manifest.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(file, JSON.stringify({ ...prev, ...manifest }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
