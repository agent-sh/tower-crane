'use strict';

// The host resource governor. Every Tower Crane process that starts an agent,
// a heavy gate or a merge-queue suite asks it first, and all of them share one
// registry per user and host under the user's cache, so projects that run side
// by side draw on one budget. A unit is admitted only while the memory it may
// still need fits under the defer line of every limited level of its cgroup
// chain and of the host, after the room running units may still grow into and
// the room other sessions used recently; memory or CPU stall or load past
// their lines defers it too. Past the stop line Tower Crane stops its own
// running work, gates before agents and the newest first, and never signals a
// process it did not start (docs/state.md#host-resource-governor).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./state');
const P = require('./processes');
const { TowerCraneError, nowIso, sleepSync } = require('./util');

const MiB = 1024 * 1024;
const AGENT_KINDS = ['worker', 'reviewer', 'small', 'orchestrator'];
const GATE_KINDS = ['tests', 'clean', 'ci', 'suite'];
const KINDS = [...AGENT_KINDS, ...GATE_KINDS];
const KIND_TEXT = { worker: 'worker', reviewer: 'reviewer', small: 'small agent', orchestrator: 'orchestrator', tests: 'tests gate', clean: 'clean gate', ci: 'local CI gate', suite: 'merge-queue suite' };
// Stopped first: a gate or suite reruns from its inputs, a reviewer or a
// small agent starts its job again, a worker loses its session's context. The
// orchestrator runs the loop that resumes the others, so it is never stopped.
const STOP_ORDER = { tests: 0, clean: 0, ci: 0, suite: 0, reviewer: 1, small: 1, worker: 2 };

// The defaults and why: docs/state.md#host-resource-governor.
const DEFAULTS = {
  defer_at: 0.85,
  stop_at: 0.95,
  psi_memory_defer: 10,
  psi_memory_stop: 10,
  psi_cpu_defer: 60,
  load_defer: 2,
  others_window_min: 30,
  growth_window_min: 60,
  growth_samples_min: 20,
  expected_mb: { worker: 1536, reviewer: 1024, small: 1024, orchestrator: 1024, tests: 2048, clean: 1024, ci: 2048, suite: 2048 },
};

const TICK_MS = 2000;
// Between ticks every process probes the stop line this often, and past it
// ticks at once: memory can grow by gigabytes between two measurements.
const PROBE_MS = 500;
// A stopped unit's memory shows as freed once its processes exit. Until they
// have, or for this long, no other unit is stopped: a second stop would take
// work the first one is already making room for.
const STOP_SETTLE_MS = 5000;
// A gate's owner aborts it on its next tick; one that has not ended by then
// gets SIGTERM on the command groups it recorded.
const STOP_GRACE_MS = 10000;
const DEFER_KEEP_MS = 10 * 60000;
const STOPS_KEEP_MS = 60 * 60000;
const STOPS_MAX = 50;
const HISTORY_MAX = 200;
// Expected size is the largest of the kind's last LEARN measured peaks once
// LEARN_MIN of them exist; fewer only raise the configured default.
const LEARN = 20;
const LEARN_MIN = 3;
const OTHERS_KEEP_MIN = 120;
// Concurrent growth: a window opens each GROWTH_OPEN_MS with the units then
// running. The reservation is the GROWTH_PERCENTILE of the summed size that
// windows of the same mix reached, from the last GROWTH_KEEP of that mix
// within GROWTH_KEEP_MS; the log keeps the last WINDOWS_KEEP closed windows.
const GROWTH_OPEN_MS = 60000;
const GROWTH_PERCENTILE = 0.99;
const GROWTH_KEEP = 200;
const GROWTH_KEEP_MS = 7 * 24 * 60 * 60000;
const WINDOWS_KEEP = 10080;
const LOCK_WAIT_MS = 5000;
// A dispatch often exits right after it binds its agent, so a bind that met a
// busy lock keeps trying this much longer before it reports that it did not land.
const BIND_WAIT_MS = 10000;

function settings(project) {
  const g = project?.governor && typeof project.governor === 'object' ? project.governor : {};
  return { ...DEFAULTS, ...g, expected_mb: { ...DEFAULTS.expected_mb, ...(g.expected_mb || {}) } };
}

function errors(g) {
  if (g == null) return [];
  if (typeof g !== 'object' || Array.isArray(g)) return ['project.json governor must be an object or null'];
  const out = [];
  const known = Object.keys(DEFAULTS);
  for (const key of Object.keys(g)) if (!known.includes(key)) out.push(`project.json governor.${key} is not a governor setting (${known.join(', ')})`);
  const number = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const key of ['defer_at', 'stop_at']) {
    if (g[key] !== undefined && !(number(g[key]) && g[key] > 0 && g[key] <= 1)) out.push(`project.json governor.${key} must be a fraction above 0 and at most 1`);
  }
  for (const key of ['psi_memory_defer', 'psi_memory_stop', 'psi_cpu_defer']) {
    if (g[key] !== undefined && !(number(g[key]) && g[key] > 0 && g[key] <= 100)) out.push(`project.json governor.${key} must be a percentage above 0 and at most 100`);
  }
  for (const key of ['load_defer', 'others_window_min', 'growth_window_min']) {
    if (g[key] !== undefined && !(number(g[key]) && g[key] > 0)) out.push(`project.json governor.${key} must be a positive number`);
  }
  if (g.growth_samples_min !== undefined && !(Number.isInteger(g.growth_samples_min) && g.growth_samples_min > 0)) out.push('project.json governor.growth_samples_min must be a positive whole number');
  if (g.expected_mb !== undefined) {
    if (!g.expected_mb || typeof g.expected_mb !== 'object' || Array.isArray(g.expected_mb)) out.push('project.json governor.expected_mb must be an object of unit kinds to MiB');
    else {
      for (const [kind, mb] of Object.entries(g.expected_mb)) {
        if (!KINDS.includes(kind)) out.push(`project.json governor.expected_mb.${kind} is not a unit kind (${KINDS.join(', ')})`);
        else if (!(number(mb) && mb > 0)) out.push(`project.json governor.expected_mb.${kind} must be a positive number of MiB`);
      }
    }
  }
  const s = settings({ governor: g });
  if (!out.length && s.stop_at < s.defer_at) out.push('project.json governor.stop_at must be at least governor.defer_at');
  return out;
}

// Readings. TOWER_CRANE_HOST_ROOT puts /proc's host files and /sys/fs/cgroup
// under another directory, for tests and the stress script; per-process
// measurement always reads the real /proc.

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readBytes(file) {
  const text = readText(file);
  if (text === null) return null;
  const value = text.trim();
  if (value === 'max') return Infinity;
  return /^\d+$/.test(value) ? Number(value) : null;
}

function keyed(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && /^\d+$/.test(value || '')) out[key] = Number(value);
  }
  return out;
}

function meminfo(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function pressure(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)/.exec(line.trim());
    if (m) out[m[1]] = { avg10: Number(m[2]), avg60: Number(m[3]) };
  }
  return out.some ? out : null;
}

function cgroupOf(text) {
  const line = String(text || '').split('\n').find((l) => l.startsWith('0::'));
  const rel = line ? line.slice(3).trim() : '';
  return rel.startsWith('/') ? rel : null;
}

const cgroupRoot = (root) => path.join(root, 'sys', 'fs', 'cgroup');

// Page cache is reclaimed before the kernel throttles or kills, so a level's
// use is memory.current without its file pages.
function cgroupUse(root, rel) {
  const dir = path.join(cgroupRoot(root), rel);
  const current = readBytes(path.join(dir, 'memory.current'));
  if (current === null || current === Infinity) return null;
  const stat = keyed(readText(path.join(dir, 'memory.stat')));
  return { current, used: Math.max(0, current - (stat.active_file || 0) - (stat.inactive_file || 0)) };
}

// The cgroup chain from rel up to the root. memory.high throttles before
// memory.max kills, so the lower of the two is the level's limit.
function chain(root, rel) {
  const out = [];
  for (let cur = rel; ; cur = path.posix.dirname(cur)) {
    const use = cgroupUse(root, cur);
    if (use) {
      const dir = path.join(cgroupRoot(root), cur);
      const max = readBytes(path.join(dir, 'memory.max')) ?? Infinity;
      const high = readBytes(path.join(dir, 'memory.high')) ?? Infinity;
      const events = keyed(readText(path.join(dir, 'memory.events')));
      out.push({ name: cur, ...use, limit: Math.min(max, high), max, high, oom_kill: events.oom_kill ?? null });
    }
    if (cur === '/') break;
  }
  return out;
}

function probe(env = process.env) {
  const fake = env.TOWER_CRANE_HOST_ROOT || null;
  const linux = !!fake || process.platform === 'linux';
  const root = fake || '/';
  const degraded = [];
  let host = null;
  if (linux) {
    const m = meminfo(readText(path.join(root, 'proc', 'meminfo')));
    if (m.MemTotal && m.MemAvailable !== undefined) {
      host = { total: m.MemTotal, available: m.MemAvailable, swap_total: m.SwapTotal ?? null, swap_free: m.SwapFree ?? null };
    }
  } else if (process.platform === 'win32') {
    host = { total: os.totalmem(), available: os.freemem(), swap_total: null, swap_free: null };
  }
  if (!host) {
    degraded.push(process.platform === 'darwin' && !fake
      ? 'macOS reports no available-memory figure, so only load defers work'
      : 'host memory is unreadable');
  }
  const rel = linux ? cgroupOf(readText(path.join(root, 'proc', 'self', 'cgroup'))) : null;
  const levels = rel ? chain(root, rel).filter((l) => Number.isFinite(l.limit)) : [];
  if (linux && !rel) degraded.push('no cgroup v2 membership, so the host is the only memory level');
  else if (linux && !levels.length) degraded.push('no memory limit on the cgroup chain, so the host is the only memory level');
  if (host) {
    const used = Math.max(0, host.total - host.available);
    levels.push({ name: 'host', current: used, used, limit: host.total, max: host.total, high: Infinity, oom_kill: null });
  }
  const memory = linux ? pressure(readText(path.join(root, 'proc', 'pressure', 'memory'))) : null;
  const cpu = linux ? pressure(readText(path.join(root, 'proc', 'pressure', 'cpu'))) : null;
  if (!memory) degraded.push('no pressure stall information');
  const loadText = linux ? readText(path.join(root, 'proc', 'loadavg')) : null;
  const load = loadText ? Number(loadText.split(/\s+/)[0]) : os.loadavg()[0];
  const binding = levels.length ? levels.reduce((a, b) => (b.limit - b.used < a.limit - a.used ? b : a)) : null;
  return { at: nowIso(), root: fake, cgroup: rel, levels, binding: binding?.name ?? null, host,
    pressure: { memory, cpu }, load, cores: os.availableParallelism(), degraded };
}

// The registry: one JSON file per user and host, replaced atomically under a
// marked lock that a dead holder does not keep.

const safeHost = () => os.hostname().replace(/[^\w.-]/g, '_');

// A fake host (TOWER_CRANE_HOST_ROOT) is another machine, with a registry of its own.
function dir(env = process.env) {
  if (env.TOWER_CRANE_HOST_ROOT) return path.join(env.TOWER_CRANE_HOST_ROOT, 'tower-crane-governor');
  const A = require('./agents');
  return path.join(A.cacheDir(env, A.origin(env).home), 'tower-crane', 'governor');
}

const registryFile = (env) => path.join(dir(env), `${safeHost()}.json`);
const registryLock = (env) => path.join(dir(env), `${safeHost()}.lock`);
const windowsFile = (env) => path.join(dir(env), `${safeHost()}.windows.jsonl`);

function empty() {
  return { version: 1, units: [], deferred: [], stops: [], history: [], others: [], windows: [], growth: [], logged: 0, ticked_at: null, measured_at: null, last_stop_at: null };
}

// null when the file is there but unreadable as a registry.
function read(env = process.env) {
  const text = readText(registryFile(env));
  if (text === null) return empty();
  try {
    const doc = JSON.parse(text);
    if (doc && doc.version === 1 && Array.isArray(doc.units)) return { ...empty(), ...doc };
  } catch { /* A torn or foreign file; the next writer sets it aside. */ }
  return null;
}

function busy(lockDir) {
  return Object.assign(new TowerCraneError(3, `the host governor's registry is locked (${lockDir}); retry`), { governorDeferred: true, reason: 'the host governor registry is busy' });
}

function withRegistry(env, fn) {
  const d = dir(env);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const lockDir = registryLock(env);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let lock;
  while (!(lock = S.tryMarkedLock(lockDir, { keepLive: true }))) {
    if (Date.now() >= deadline) throw busy(lockDir);
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
  try {
    const file = registryFile(env);
    let reg = read(env);
    if (!reg) {
      // Kept for a person to read; the budget starts again from live readings.
      try { fs.renameSync(file, `${file}.corrupt`); } catch { /* Gone meanwhile. */ }
      reg = empty();
    }
    const before = JSON.stringify(reg);
    const out = fn(reg);
    const after = JSON.stringify(reg);
    if (after !== before) S.writeAtomic(file, after + '\n');
    return out;
  } finally {
    S.releaseMarkedLock(lock);
  }
}

const holding = (u) => u.holders.some((h) => P.processState({ ...h, host: u.host }) !== 'exited');

function prune(reg, now) {
  const gone = reg.units.filter((u) => !holding(u));
  for (const u of gone) remember(reg, u, now);
  reg.units = reg.units.filter((u) => !gone.includes(u));
  reg.deferred = reg.deferred.filter((d) => now - Date.parse(d.at) < DEFER_KEEP_MS);
  reg.stops = reg.stops.filter((s) => now - Date.parse(s.at) < STOPS_KEEP_MS).slice(-STOPS_MAX);
  reg.others = reg.others.filter((o) => now - Date.parse(o.at) < OTHERS_KEEP_MIN * 60000);
  reg.growth = reg.growth.filter((g) => now - Date.parse(g.at) < GROWTH_KEEP_MS);
}

function remember(reg, u, now) {
  if (u.peak > 0) reg.history = [...reg.history, { kind: u.kind, project: u.project, peak: u.peak, at: new Date(now).toISOString() }].slice(-HISTORY_MAX);
}

// Measurement, Linux only. A unit is its root processes and their
// descendants, each process counted once, for the unit whose root is its
// nearest ancestor; its size is their anonymous resident memory, which is
// what a cgroup charges and cannot reclaim without swap. A unit inside a
// cgroup of its own (T404's scopes) is that cgroup's use instead.

function processTable() {
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return null; }
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readText(`/proc/${name}/stat`);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    table.set(Number(name), { ppid: Number(fields[1]), start_ticks: fields[19] });
  }
  return table;
}

function anonymous(pid) {
  const m = /^RssAnon:\s+(\d+)\s*kB/m.exec(readText(`/proc/${pid}/status`) || '');
  return m ? Number(m[1]) * 1024 : 0;
}

// False where nothing could be measured, so no growth window learns from sizes of zero.
function measure(reg, env, now) {
  reg.measured_at = new Date(now).toISOString();
  if (process.platform !== 'linux') return false;
  const table = processTable();
  if (!table) return false;
  const roots = new Map();
  for (const u of reg.units) {
    for (const r of u.roots) {
      const p = table.get(r.pid);
      if (p && (r.start_ticks === undefined || p.start_ticks === r.start_ticks)) roots.set(r.pid, u);
    }
  }
  const memo = new Map();
  const unitOf = (pid) => {
    const walked = [];
    let cur = pid;
    let found = null;
    for (;;) {
      if (memo.has(cur)) { found = memo.get(cur); break; }
      if (roots.has(cur)) { found = roots.get(cur); break; }
      const p = table.get(cur);
      if (!p || cur <= 1) break;
      walked.push(cur);
      cur = p.ppid;
    }
    for (const w of walked) memo.set(w, found);
    return found;
  };
  const sums = new Map(reg.units.map((u) => [u.id, 0]));
  for (const pid of table.keys()) {
    const u = unitOf(pid);
    if (u && !u.cgroup) sums.set(u.id, sums.get(u.id) + anonymous(pid));
  }
  const root = env.TOWER_CRANE_HOST_ROOT || '/';
  for (const u of reg.units) {
    const bytes = u.cgroup ? cgroupUse(root, u.cgroup)?.used : sums.get(u.id);
    if (bytes == null) continue;
    u.measured = bytes;
    u.peak = Math.max(u.peak || 0, bytes);
  }
  return true;
}

// A root in a cgroup apart from the process that admitted it runs in a scope
// of its own, whose use is the unit's.
function ownCgroup(env, pid) {
  if (process.platform !== 'linux') return null;
  const rel = cgroupOf(readText(`/proc/${pid}/cgroup`));
  const mine = cgroupOf(readText('/proc/self/cgroup'));
  return rel && rel !== mine && cgroupUse(env.TOWER_CRANE_HOST_ROOT || '/', rel) ? rel : null;
}

// The use of everything in the binding level that is not Tower Crane's, in
// one sample per minute, so a session's recent peak is room it may take again.
function sample(reg, reading, now) {
  const binding = reading.levels.find((l) => l.name === reading.binding);
  if (!binding) return;
  const tc = reg.units.reduce((n, u) => n + (u.measured || 0), 0);
  const bytes = Math.max(0, binding.used - tc);
  // One sample per minute, the minute's largest, dated when it was seen.
  const last = reg.others.at(-1);
  if (last && Math.floor(Date.parse(last.at) / 60000) === Math.floor(now / 60000)) {
    if (bytes >= last.bytes) Object.assign(last, { at: new Date(now).toISOString(), bytes });
  } else reg.others.push({ at: new Date(now).toISOString(), bytes });
}

// Concurrent growth. Running units rarely all reach their peaks at the same
// moment, so once enough windows of the same mix of kinds exist the budget
// reserves what such sets actually grew to together, not the sum of every
// unit's own peak (docs/state.md#the-budget).

const mixOf = (units) => {
  const n = {};
  for (const u of units) n[u.kind] = (n[u.kind] || 0) + 1;
  return Object.keys(n).sort().map((k) => `${k}:${n[k]}`).join(',');
};

// Nearest rank: below 100 samples the 99th percentile is the largest seen.
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

// The room running units may still grow into together, and the rule behind
// it: the size sets of their mix reached together, less what they measure
// now, so a unit admitted a moment ago and not yet grown keeps its room.
function reserve(reg, s) {
  const sum = reg.units.reduce((n, u) => n + Math.max(0, (u.expected || 0) - (u.measured || 0)), 0);
  const size = reg.units.reduce((n, u) => n + (u.measured || 0), 0);
  const mix = mixOf(reg.units);
  const totals = mix ? (reg.growth || []).filter((g) => g.mix === mix).map((g) => g.total) : [];
  const out = { sum, mix, samples: totals.length, min: s.growth_samples_min };
  if (!mix || totals.length < s.growth_samples_min) return { ...out, bytes: sum, rule: 'sum' };
  return { ...out, bytes: Math.max(0, percentile(totals, GROWTH_PERCENTILE) - size), rule: 'measured' };
}

// A window opens each minute with the units then running, the binding
// level's use and the growth reserved for them. Every measurement raises its
// total to the most the set's summed size has reached: a unit that ended gave
// its memory back, and a unit admitted later is not in the set, since its own
// size is reserved when it is admitted. The window follows the level it
// opened on, whichever level binds later. It closes after growth_window_min,
// or once every unit in it ended, and its total becomes a sample of its mix.
// Returns the windows it closed.
function observe(reg, reading, s, now) {
  const binding = reading.levels.find((l) => l.name === reading.binding);
  if (!binding) return [];
  const byId = new Map(reg.units.map((u) => [u.id, u]));
  const at = new Date(now).toISOString();
  const open = [];
  const closed = [];
  for (const w of reg.windows || []) {
    const live = w.units.filter((id) => byId.has(id));
    w.total = Math.max(w.total, live.reduce((n, id) => n + (byId.get(id).measured || 0), 0));
    w.grew = w.total - w.base;
    const level = reading.levels.find((l) => l.name === w.level);
    if (level) w.slice_peak = Math.max(w.slice_peak, level.used);
    if (live.length && now - Date.parse(w.at) < s.growth_window_min * 60000) {
      open.push(w);
      continue;
    }
    closed.push({ ...w, end: at, predicted: w.used + w.reserved, actual: w.used + w.grew, crossed: w.grew > w.reserved });
    reg.growth = [...(reg.growth || []), { mix: w.mix, at, total: w.total }];
    const same = reg.growth.filter((g) => g.mix === w.mix);
    if (same.length > GROWTH_KEEP) reg.growth = reg.growth.filter((g) => g !== same[0]);
  }
  const last = open.at(-1);
  if (reg.units.length && (!last || now - Date.parse(last.at) >= GROWTH_OPEN_MS)) {
    const r = reserve(reg, s);
    const base = reg.units.reduce((n, u) => n + (u.measured || 0), 0);
    open.push({ at, level: binding.name, limit: binding.limit, mix: r.mix, units: reg.units.map((u) => u.id), base, used: binding.used,
      sum: r.sum, reserved: r.bytes, rule: r.rule, samples: r.samples, total: base, grew: 0, slice_peak: binding.used });
  }
  reg.windows = open;
  return closed;
}

// The rolling log of closed windows beside the registry: what each predicted
// and what its units and the binding level reached.
function logWindows(env, reg, closed) {
  if (!closed.length) return;
  const file = windowsFile(env);
  fs.appendFileSync(file, closed.map((w) => `${JSON.stringify(w)}\n`).join(''), { mode: 0o600 });
  reg.logged = (reg.logged || 0) + closed.length;
  if (reg.logged > WINDOWS_KEEP * 1.25) {
    const kept = (readText(file) || '').split('\n').filter(Boolean).slice(-WINDOWS_KEEP);
    S.writeAtomic(file, kept.map((l) => `${l}\n`).join(''));
    reg.logged = kept.length;
  }
}

// Each reading: measure every unit, sample the other sessions and follow the growth windows.
function observeAll(reg, env, reading, s, now) {
  const measured = measure(reg, env, now);
  sample(reg, reading, now);
  if (measured) logWindows(env, reg, observe(reg, reading, s, now));
}

function expected(reg, project, kind, s) {
  const own = reg.history.filter((h) => h.kind === kind && h.project === project).slice(-LEARN);
  const peaks = (own.length ? own : reg.history.filter((h) => h.kind === kind).slice(-LEARN)).map((h) => h.peak);
  const learned = peaks.length ? Math.max(...peaks) : 0;
  const configured = s.expected_mb[kind] * MiB;
  return peaks.length >= LEARN_MIN ? learned : Math.max(configured, learned);
}

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const pct = (fraction) => `${Math.round(fraction * 100)}%`;
const levelName = (l) => (l.name === 'host' ? 'the host' : path.posix.basename(l.name));

// The budget at a reading, and whether `need` more bytes fit under every
// level's defer line.
function assess(reading, reg, s, need = 0, kind = null, now = Date.now()) {
  const reasons = [];
  const tc = reg.units.reduce((n, u) => n + (u.measured || 0), 0);
  const reserved = reserve(reg, s);
  const growth = reserved.bytes;
  const binding = reading.levels.find((l) => l.name === reading.binding) || null;
  const others = binding ? Math.max(0, binding.used - tc) : 0;
  // A peak's claim fades over the window: a session that just let go of
  // memory may take it back, one that let go long ago less likely.
  const window = s.others_window_min * 60000;
  const othersRoom = reg.others.reduce((n, o) => {
    const age = Math.max(0, now - Date.parse(o.at));
    return age < window ? Math.max(n, (o.bytes - others) * (1 - age / window)) : n;
  }, 0);
  const what = kind ? `a ${KIND_TEXT[kind]} needs ${gib(need)}` : null;
  for (const l of reading.levels) {
    const line = s.defer_at * l.limit;
    const projected = l.used + growth + othersRoom + need;
    if (projected > line) {
      reasons.push(`memory: ${levelName(l)} has ${gib(l.used)} of ${gib(l.limit)} in use, running Tower Crane work may grow ${gib(growth)}`
        + ` and other sessions ${gib(othersRoom)} toward their peak of the last ${s.others_window_min} minutes${what ? `, and ${what}` : ''};`
        + ` ${gib(projected)} is over the ${pct(s.defer_at)} line (${gib(line)})`);
    }
  }
  const memory = reading.pressure.memory?.some?.avg10;
  if (memory !== undefined && memory >= s.psi_memory_defer) reasons.push(`memory pressure: some avg10 ${memory}% is at or over ${s.psi_memory_defer}%`);
  const cpu = reading.pressure.cpu?.some?.avg10;
  if (cpu !== undefined && cpu >= s.psi_cpu_defer) reasons.push(`cpu pressure: some avg10 ${cpu}% is at or over ${s.psi_cpu_defer}%`);
  const loadLine = s.load_defer * reading.cores;
  if (reading.load >= loadLine) reasons.push(`load: ${reading.load} on ${reading.cores} cores is at or over ${loadLine}`);
  return {
    ok: !reasons.length,
    reasons,
    budget: binding && {
      level: binding.name, limit: binding.limit, used: binding.used, defer_line: s.defer_at * binding.limit, stop_line: s.stop_at * binding.limit,
      tower_crane: tc, growth, growth_rule: reserved.rule, growth_sum: reserved.sum, growth_mix: reserved.mix,
      growth_samples: reserved.samples, growth_samples_min: reserved.min, others, others_room: othersRoom, need, units: reg.units.length,
      projects: new Set(reg.units.map((u) => u.project)).size,
    },
  };
}

// Why Tower Crane must stop running work now, or null.
function overStop(reading, s) {
  for (const l of reading.levels) {
    if (l.used >= s.stop_at * l.limit) return `memory: ${levelName(l)} has ${gib(l.used)} of ${gib(l.limit)} in use, at or past the ${pct(s.stop_at)} stop line (${gib(s.stop_at * l.limit)})`;
  }
  const full = reading.pressure.memory?.full?.avg10;
  if (full !== undefined && full >= s.psi_memory_stop) return `memory pressure: full avg10 ${full}% is at or over the ${s.psi_memory_stop}% stop line`;
  return null;
}

// An agent is stopped through its supervisor; until its dispatch binds the
// supervisor, the unit's holder is the dispatching process, never a victim.
function victims(reg) {
  return reg.units.filter((u) => u.kind in STOP_ORDER && !u.stop && (!AGENT_KINDS.includes(u.kind) || u.bound))
    .sort((a, b) => STOP_ORDER[a.kind] - STOP_ORDER[b.kind] || Date.parse(b.started_at) - Date.parse(a.started_at) || (a.id < b.id ? 1 : -1));
}

// Only processes this registry recorded when Tower Crane started them, and
// only while their start time still matches, so a reused pid is left alone.
function signal(u, list, group) {
  for (const p of list) {
    if (P.processState({ ...p, host: u.host }) !== 'running') continue;
    try { process.kill(group && process.platform !== 'win32' ? -p.pid : p.pid, 'SIGTERM'); } catch { /* Ended meanwhile. */ }
  }
}

// Signals go into `later`, sent once the registry that records why is
// written, so a stopped supervisor reads its reason.
function shed(reg, reading, s, now, later) {
  const why = overStop(reading, s);
  if (!why) return null;
  for (const u of reg.units) {
    if (u.stop && !u.stop.signalled && GATE_KINDS.includes(u.kind) && now - Date.parse(u.stop.at) >= STOP_GRACE_MS) {
      later.push(() => signal(u, u.roots, true));
      u.stop.signalled = new Date(now).toISOString();
    }
  }
  if (reg.last_stop_at && now - Date.parse(reg.last_stop_at) < STOP_SETTLE_MS && reg.units.some((u) => u.stop)) return null;
  const victim = victims(reg)[0];
  if (!victim) return null;
  const at = new Date(now).toISOString();
  victim.stop = { at, reason: why };
  reg.last_stop_at = at;
  reg.stops.push({ project: victim.project, name: victim.name, task: victim.task, kind: victim.kind, agent: victim.agent, reason: why, at });
  // An agent's supervisor stops its harness on SIGTERM and records the exit;
  // a gate's owner aborts it on its own tick.
  if (AGENT_KINDS.includes(victim.kind)) later.push(() => signal(victim, victim.holders, false));
  return victim;
}

// Units this process runs, by id: the abort that stops each one.
const local = new Map();
const watchers = new Set();
// Registry writes that met a busy lock, retried on every probe until they
// land: a release or bind left undone would keep a place for as long as its
// holder, often the wait, lives.
const retries = new Map();

function retry(key, env, op) {
  try {
    op();
    retries.delete(key);
  } catch {
    retries.set(key, { env, op });
    schedule();
  }
}

function runRetries() {
  for (const [key, { env, op }] of [...retries]) retry(key, env, op);
}
let timer = null;
let warned = false;

function stopOwn(reg) {
  for (const u of reg?.units || []) if (u.stop && local.has(u.id)) local.get(u.id).abort(u.stop.reason);
}

// One pass, every PROBE_MS in each process: stop own units the registry
// marks, and, once per TICK_MS across the host or at once past the stop line,
// measure every unit, sample the other sessions and stop work.
function tick(env = process.env, project = null) {
  const seen = read(env);
  stopOwn(seen);
  const s = settings(project);
  const reading = probe(env);
  // Past the stop line every probe ticks; otherwise one tick per TICK_MS across the host.
  const urgent = !!overStop(reading, s);
  const due = (reg) => urgent || !reg?.ticked_at || Date.now() - Date.parse(reg.ticked_at) >= TICK_MS * 0.9;
  if (seen && !due(seen)) return null;
  const later = [];
  const victim = withRegistry(env, (reg) => {
    if (!due(reg)) return null;
    const now = Date.now();
    reg.ticked_at = new Date(now).toISOString();
    prune(reg, now);
    observeAll(reg, env, reading, s, now);
    return shed(reg, reading, s, now, later);
  });
  for (const send of later) send();
  stopOwn(read(env));
  return victim;
}

function safeTick() {
  runRetries();
  const w = [...watchers].at(-1) || [...local.values()].at(-1);
  if (!w) {
    schedule();
    return;
  }
  try {
    tick(w.env, w.project?.());
  } catch (e) {
    if (!warned) process.stderr.write(`tower-crane: host governor tick failed: ${e.message}\n`);
    warned = true;
  }
}

function schedule() {
  if (watchers.size || local.size || retries.size) {
    if (!timer) {
      timer = setInterval(safeTick, PROBE_MS);
      timer.unref();
    }
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Reads project.json again only when its stat changes, so an idle wait's
// ticks reuse its settings instead of reading state every probe. The stat and
// the read use one descriptor, so the key always describes the bytes read.
function projectReader(stateDir) {
  const file = path.join(stateDir, 'project.json');
  let key = null;
  let project = null;
  return () => {
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const s = fs.fstatSync(fd, { bigint: true });
      const next = `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      if (next !== key) {
        project = JSON.parse(fs.readFileSync(fd, 'utf8'));
        key = next;
      }
      return project;
    } catch {
      key = null;
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  };
}

// Keeps this process ticking until the returned function runs: the wait
// loop and every supervisor, so the host is governed while any of them runs.
function watch(ctx) {
  const w = { env: ctx.env || process.env, project: projectReader(ctx.stateDir) };
  w.project();
  watchers.add(w);
  schedule();
  return () => {
    watchers.delete(w);
    schedule();
  };
}

function deferral(task, kind, reasons) {
  const reason = reasons.join('; ');
  return Object.assign(new TowerCraneError(3, `${task}: ${KIND_TEXT[kind]} deferred by the host governor: ${reason}`),
    { governorDeferred: true, reason, task, kind });
}

function stopError(task, kind, reason) {
  return Object.assign(new TowerCraneError(3, `${task}: ${KIND_TEXT[kind]} stopped by the host governor: ${reason}; it runs again once there is room`),
    { governorDeferred: true, governorStopped: true, reason, task, kind });
}

// Admits one unit or throws a deferral (code 3, governorDeferred) whose
// reason the registry keeps for status, inbox and the board.
function admit(ctx, { kind, task, agent = ctx.agent, project }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown governor unit kind ${kind}`);
  const env = ctx.env || process.env;
  const s = settings(project);
  const reading = probe(env);
  const stateDir = path.resolve(ctx.stateDir);
  const same = (d) => d.project === stateDir && d.task === task && d.kind === kind;
  const out = withRegistry(env, (reg) => {
    const now = Date.now();
    prune(reg, now);
    if (!reg.measured_at || now - Date.parse(reg.measured_at) >= TICK_MS) observeAll(reg, env, reading, s, now);
    const need = expected(reg, stateDir, kind, s);
    const verdict = assess(reading, reg, s, need, kind, now);
    const at = new Date(now).toISOString();
    if (!verdict.ok) {
      const prior = reg.deferred.find(same);
      const entry = { project: stateDir, name: project?.name || null, task, kind, agent, reason: verdict.reasons.join('; '), since: prior?.since || at, at };
      reg.deferred = [...reg.deferred.filter((d) => !same(d)), entry];
      return { deferred: verdict.reasons };
    }
    reg.deferred = reg.deferred.filter((d) => !same(d));
    const unit = { id: `u-${crypto.randomBytes(8).toString('hex')}`, project: stateDir, name: project?.name || null, task, kind, agent,
      host: os.hostname(), holders: [{ pid: process.pid, ...P.identity(process.pid) }], roots: [], cgroup: null,
      expected: need, measured: 0, peak: 0, started_at: at };
    reg.units.push(unit);
    return { unit };
  });
  if (out.deferred) throw deferral(task, kind, out.deferred);
  return handle(env, stateDir, out.unit);
}

function update(env, id, fn) {
  return withRegistry(env, (reg) => {
    const u = reg.units.find((x) => x.id === id);
    return u ? fn(u, reg) : null;
  });
}

function handle(env, stateDir, unit) {
  const controller = new AbortController();
  const entry = { env, project: projectReader(stateDir), abort: (reason) => {
    if (!controller.signal.aborted) controller.abort(stopError(unit.task, unit.kind, reason));
  } };
  local.set(unit.id, entry);
  schedule();
  let released = false;
  const forget = () => {
    local.delete(unit.id);
    schedule();
  };
  return {
    id: unit.id,
    kind: unit.kind,
    signal: controller.signal,
    // A command the unit started: measured with it, and signalled if its stop
    // outlives the grace.
    attach(pid) {
      const root = { pid, ...P.identity(pid) };
      retry(`${unit.id}:attach:${pid}`, env, () => update(env, unit.id, (u) => {
        u.roots = [...u.roots.filter((r) => P.processState({ ...r, host: u.host }) !== 'exited'), root];
        u.cgroup ||= ownCgroup(env, pid);
      }));
    },
    // The process that holds the unit from here on, such as an agent's
    // supervisor, which outlives the dispatch. False when the registry stayed
    // busy: the write stays queued for this process's later probes.
    bind(pid, startTicks, agent) {
      const id = { pid, ...(startTicks !== undefined ? { start_ticks: startTicks } : P.identity(pid)) };
      forget();
      const key = `${unit.id}:bind`;
      retry(key, env, () => update(env, unit.id, (u) => {
        u.holders = [id];
        u.roots = [id];
        u.cgroup = ownCgroup(env, pid);
        u.bound = true;
        if (agent) u.agent = agent;
      }));
      const deadline = Date.now() + BIND_WAIT_MS;
      while (retries.has(key) && Date.now() < deadline) retry(key, env, retries.get(key).op);
      return !retries.has(key);
    },
    // The stop error when the governor stopped this unit, else null.
    stopped() {
      if (controller.signal.aborted) return controller.signal.reason;
      const u = read(env)?.units.find((x) => x.id === unit.id);
      return u?.stop ? stopError(unit.task, unit.kind, u.stop.reason) : null;
    },
    release() {
      if (released) return;
      released = true;
      forget();
      retries.delete(`${unit.id}:bind`);
      retry(`${unit.id}:release`, env, () => withRegistry(env, (reg) => {
        const u = reg.units.find((x) => x.id === unit.id);
        if (!u) return;
        remember(reg, u, Date.now());
        reg.units = reg.units.filter((x) => x !== u);
      }));
    },
  };
}

// Whether a unit of `kind` would be admitted now, without taking a place:
// callers that prepare a dispatch ask this before work a deferral would waste.
function check(ctx, { kind, task, project }) {
  const env = ctx.env || process.env;
  const s = settings(project);
  const reading = probe(env);
  const reg = read(env) || empty();
  const live = { ...reg, units: reg.units.filter(holding) };
  const verdict = assess(reading, live, s, expected(reg, path.resolve(ctx.stateDir), kind, s), kind);
  if (!verdict.ok) {
    try { admit(ctx, { kind, task, project }).release(); } catch (e) { if (e.governorDeferred) throw e; }
  }
}

// Why the governor stopped the unit that pid holds, or null.
function stopReason(env, pid) {
  return read(env)?.units.find((u) => u.stop && u.holders.some((h) => h.pid === pid))?.stop.reason || null;
}

// What status, inbox and the board show: the reading, the budget, and this
// project's deferred and stopped work.
function view(ctx, project) {
  const env = ctx.env || process.env;
  const s = settings(project);
  const reading = probe(env);
  const reg = read(env) || empty();
  const live = { ...reg, units: reg.units.filter(holding) };
  const stateDir = path.resolve(ctx.stateDir);
  // Deferring while not even the smallest unit this project starts would fit.
  const smallest = KINDS.map((kind) => [kind, expected(reg, stateDir, kind, s)]).reduce((a, b) => (b[1] < a[1] ? b : a));
  const verdict = assess(reading, live, s, smallest[1], smallest[0]);
  const stop = overStop(reading, s);
  const now = Date.now();
  const mine = (x) => x.project === stateDir;
  return {
    state: stop ? 'stopping' : verdict.ok ? 'open' : 'deferring',
    reasons: stop ? [stop] : verdict.reasons,
    budget: verdict.budget,
    settings: s,
    reading: {
      levels: reading.levels.map(({ name, used, limit, oom_kill }) => ({ name, used, limit, oom_kill })),
      binding: reading.binding, host: reading.host, pressure: reading.pressure, load: reading.load, cores: reading.cores, degraded: reading.degraded,
    },
    units: live.units.filter(mine).map(({ id, task, kind, agent, expected: e, measured, peak, started_at, stop: st }) => ({
      id, task, kind, agent, expected: e, measured, peak, started_at, ...(st ? { stop: st } : {}) })),
    deferred: reg.deferred.filter((d) => mine(d) && now - Date.parse(d.at) < DEFER_KEEP_MS),
    stops: reg.stops.filter((x) => mine(x) && now - Date.parse(x.at) < STOPS_KEEP_MS),
  };
}

function lines(v) {
  const out = [];
  const b = v.budget;
  const psi = (p) => (p?.some ? `${p.some.avg10}%` : 'n/a');
  const windows = (n) => `${n} window${n === 1 ? '' : 's'}`;
  const rule = !b?.units ? ''
    : b.growth_rule === 'measured' ? ` (p99 of ${windows(b.growth_samples)} of this mix, ${b.growth_mix})`
      : ` (sum of unit peaks; ${b.growth_samples} of ${windows(b.growth_samples_min)} of this mix, ${b.growth_mix}, before measured growth)`;
  const head = b
    ? `${levelName({ name: b.level })} ${gib(b.used)} of ${gib(b.limit)} in use (defer at ${pct(v.settings.defer_at)}, stop at ${pct(v.settings.stop_at)});`
      + ` Tower Crane ${gib(b.tower_crane)} in ${b.units} unit${b.units === 1 ? '' : 's'} across ${b.projects} project${b.projects === 1 ? '' : 's'}, may grow ${gib(b.growth)}${rule};`
      + ` other sessions ${gib(b.others)}, room kept for ${gib(b.others_room)} more`
    : 'no memory reading';
  out.push(`host governor: ${v.state}; ${head}; memory pressure ${psi(v.reading.pressure.memory)}, cpu ${psi(v.reading.pressure.cpu)}, load ${v.reading.load} on ${v.reading.cores} cores`);
  if (v.state !== 'open') out.push(`host governor ${v.state === 'stopping' ? 'stops work' : 'defers work'}: ${v.reasons.join('; ')}`);
  for (const d of v.deferred) out.push(`governor deferred: ${d.task} ${KIND_TEXT[d.kind]} since ${d.since}: ${d.reason}`);
  for (const x of v.stops) out.push(`governor stopped: ${x.task} ${KIND_TEXT[x.kind]}${x.agent ? ` (${x.agent})` : ''} at ${x.at}: ${x.reason}`);
  if (v.reading.degraded.length) out.push(`host governor degraded: ${v.reading.degraded.join('; ')}`);
  return out;
}

module.exports = {
  DEFAULTS, KINDS, KIND_TEXT, TICK_MS, PROBE_MS, STOP_SETTLE_MS, STOP_GRACE_MS,
  settings, errors, probe, assess, overStop, victims, expected, reserve, observe, admit, check, tick, watch, view, lines, read, dir,
  registryFile, registryLock, windowsFile, stopReason,
};
