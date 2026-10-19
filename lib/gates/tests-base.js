'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../state');
const { settingError } = require('../tests-map');

// Two base tips retain an overlapping gate's results after main moves. Sixty-four
// one-MiB outputs bound the completed cache to roughly 64 MiB per repository.
const MAX_BASES = 2;
const MAX_RESULTS = 64;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (value) => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));

function settings(project, host, tmpEnv) {
  const env = { ...process.env, TMPDIR: '<gate-scratch>', TMP: '<gate-scratch>', TEMP: '<gate-scratch>' };
  if (env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = '<gate-compile-cache>';
  if (tmpEnv && !tmpEnv.TOWER_CRANE_TMP) delete env.TOWER_CRANE_TMP;
  const count = Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0;
  Object.assign(env, { GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'gc.autoDetach', [`GIT_CONFIG_VALUE_${count}`]: 'false' });
  if (host) {
    Object.assign(env, project.tests?.host_env);
    delete env.TOWER_CRANE_TEST_EXCLUDE;
  } else env.TOWER_CRANE_TEST_EXCLUDE = JSON.stringify(project.tests?.host_only ?? []);
  env.TOWER_CRANE_SANDBOX = '0';
  delete env.TOWER_CRANE_HOST_ONLY;
  delete env.NODE_TEST_CONTEXT;
  // POSIX shells replace PWD with their working directory, another fresh path.
  if (process.platform !== 'win32') env.PWD = '<gate-worktree>';
  return hash({ host, host_only: project.tests?.host_only ?? [], host_env: sorted(project.tests?.host_env),
    env: sorted(env), hostname: require('node:os').hostname(), platform: process.platform, arch: process.arch, node: process.version });
}

// Read the complete kept head output, before its diagnostic tail is cut. Spec
// summaries and TAP YAML associate a location with the preceding failing name.
function failingFiles(output, names, cwd) {
  const locations = new Map(names.map((name) => [name, new Set()]));
  let unsafe = false;
  const add = (name, file) => {
    if (!locations.has(name)) return;
    let rel = file.replace(/\\/g, '/');
    if (path.isAbsolute(file)) rel = path.relative(cwd, file).replace(/\\/g, '/');
    rel = rel.replace(/^\.\//, '');
    if (settingError({ source: [rel] }) === null) locations.get(name).add(rel);
    else unsafe = true;
  };
  const lines = output.split(/\r?\n/);
  let tapName = null;
  for (let i = 0; i < lines.length; i++) {
    const spec = /^\s*test at (.+?):\d+(?::\d+)?\s*$/.exec(lines[i]);
    const next = /^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(lines[i + 1] || '');
    if (spec && next) add(next[1], spec[1]);
    const tap = /^\s*not ok(?:\s+\d+)?(?:\s+-\s*|\s+)(.+?)\s*$/.exec(lines[i]);
    if (tap) tapName = tap[1];
    else if (/^\s*ok(?:\s+\d+)?\s/.test(lines[i])) tapName = null;
    const location = /^\s*location:\s*['"]?(.+?):\d+(?::\d+)?['"]?\s*$/.exec(lines[i]);
    if (location && tapName) add(tapName, location[1]);
  }
  if (unsafe || !names.length || [...locations.values()].some((files) => !files.size)) return null;
  return [...new Set([...locations.values()].flatMap((files) => [...files]))].sort();
}

function prune(root, current) {
  const lock = S.tryMarkedLock(path.join(root, 'prune.lock'), { keepLive: true });
  if (!lock) return;
  try {
    pruneHeld(root, current);
  } finally {
    S.releaseMarkedLock(lock);
  }
}

function pruneHeld(root, current) {
  const bases = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-f0-9]{40,64}$/.test(e.name))
    .map((e) => ({ name: e.name, dir: path.join(root, e.name) }));
  const results = [];
  for (const base of bases) {
    base.active = false;
    base.last = 0;
    let entries;
    try { entries = fs.readdirSync(base.dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const entry of entries) {
      if (entry.endsWith('.lock')) {
        const lock = path.join(base.dir, entry);
        S.clearStaleLock(lock, true);
        if (fs.existsSync(lock)) base.active = true;
      }
      if (!entry.endsWith('.json')) continue;
      const file = path.join(base.dir, entry);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (stat) {
        base.last = Math.max(base.last, stat.mtimeMs);
        results.push({ file, time: stat.mtimeMs, base });
      }
    }
  }
  const keep = new Set([current, ...bases.filter((b) => b.name !== current).sort((a, b) => b.last - a.last)
    .slice(0, MAX_BASES - 1).map((b) => b.name)]);
  for (const base of bases) {
    // Remove only completed files, never a directory a concurrent caller uses.
    if (!keep.has(base.name) && !base.active) {
      for (const r of results.filter((r) => r.base === base)) {
        try { fs.unlinkSync(r.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      try { fs.rmdirSync(base.dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
    }
  }
  const retained = results.filter((r) => keep.has(r.base.name) || r.base.active).sort((a, b) => b.time - a.time);
  for (const r of retained.slice(MAX_RESULTS).filter((r) => !r.base.active)) {
    try { fs.unlinkSync(r.file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

async function cached({ root, sha, command, settingsHash, file, timeout, signal, run, snapshot }) {
  const dir = path.join(root, sha);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resultFile = path.join(dir, `${hash([command, settingsHash, file])}.json`);
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      if (value.version !== 1 || !Number.isInteger(value.result?.status) || typeof value.result.output !== 'string') return null;
      const now = new Date();
      fs.utimesSync(resultFile, now, now);
      return value.result;
    } catch (e) {
      if (!['ENOENT', 'SyntaxError'].includes(e.code || e.name)) throw e;
      return null;
    }
  };
  const deadline = Date.now() + timeout + 60000;
  let lock;
  for (;;) {
    const result = read();
    if (result) {
      prune(root, sha);
      return { result, cached: true };
    }
    if (signal?.aborted) return { result: { ok: false, status: null, signal: 'SIGTERM', stdout: '', stderr: '', output: '' }, cached: false };
    const maintenance = S.tryMarkedLock(path.join(root, 'prune.lock'), { keepLive: true });
    if (maintenance) {
      try {
        // Directory creation and acquisition cannot race pruning an old base.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        lock = S.tryMarkedLock(`${resultFile}.lock`, { keepLive: true });
      } finally {
        S.releaseMarkedLock(maintenance);
      }
    }
    if (lock) break;
    if (Date.now() >= deadline) return { result: { ok: false, status: null, timedOut: true, stdout: '', stderr: '', output: '' }, cached: false };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  S.keepMarkedLockFresh(lock);
  try {
    const previous = read();
    if (previous) return { result: previous, cached: true };
    const result = await run();
    if (Number.isInteger(result.status) && result.status >= 0 && result.status < 128
      && ![126, 127].includes(result.status) && !result.error && !result.timedOut && !result.signal) {
      const temp = `${resultFile}.${lock.nonce}.new`;
      try {
        fs.writeFileSync(temp, JSON.stringify({ version: 1, result: snapshot(result) }), { mode: 0o600 });
        fs.renameSync(temp, resultFile);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    return { result, cached: false };
  } finally {
    S.releaseMarkedLock(lock);
    prune(root, sha);
  }
}

module.exports = { settings, failingFiles, cached, prune, hash, MAX_BASES, MAX_RESULTS };
