'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Commands = require('./commands');
const { execFileSync } = Commands;
const { TowerCraneError, refuse, nowIso, sleepSync } = require('./util');
const L = require('./ladder');
const Secrets = require('./secrets');
const EvidenceStore = require('./evidence-store');

const KINDS = ['code', 'docs', 'research', 'design', 'ops'];
const NEEDS = ['browser'];
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['todo', 'in_progress', 'submitted', 'accepted', 'rework', 'cancelled'];
const EVIDENCE_TYPES = ['tests', 'clean', 'sources', 'review', 'ci', 'merge', 'note'];
const { HARNESSES, TIERS } = L;
// Additive fields and enum members keep this version. Changes that old
// readers cannot safely ignore must publish a higher version first.
const SCHEMA_VERSION = 1;

// Startup bursts share this bound with the existing stale-marker window.
const LOCK_WAIT_MS = 60000;
const LOCK_STALE_MS = 60000;

function git(args, cwd) {
  Commands.assertUnlocked('git');
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A command the state broker runs for a sandboxed agent runs no git: the
// repository's config and the commits in it are the agent's to write, and
// git can run commands they name (merge drivers, fsmonitor).
function repoAt(dir) {
  if (process.env.TOWER_CRANE_VIA === 'broker') return null;
  if (!isDir(dir)) return null;
  const out = git(['rev-parse', '--git-common-dir'], dir);
  if (!out) return null;
  const commonDir = path.resolve(dir, out);
  // A bare repository has no main checkout, so its common dir stands in for one.
  const root = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  return { root, commonDir };
}

function locateStateDir(flag, env, cwd) {
  if (flag) return path.resolve(cwd, flag);
  if (env.TOWER_CRANE_STATE) return path.resolve(cwd, env.TOWER_CRANE_STATE);
  const repo = repoAt(cwd);
  if (!repo) {
    throw refuse('not inside a git repository; run tower-crane from the repo, or pass --state DIR or set TOWER_CRANE_STATE');
  }
  return path.join(repo.root, '.tower-crane');
}

// The repository tower-crane runs in wins; outside one, fall back to the repository
// that holds the state directory.
function findRepo(stateDir, cwd) {
  return repoAt(cwd) || (stateDir ? repoAt(path.dirname(stateDir)) : null);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// The lock is a directory, `lock`, holding one marker file named after its
// holder's random nonce, with its pid, host, process identity and time inside.
//
// - Taking it: the writer prepares a private directory with its marker and
//   renames it to `lock`. The rename fails while `lock` holds a marker, so a
//   holder's marker is in the lock from the moment it holds it, and no other
//   writer's rename can land until that marker is gone.
// - Breaking a stale one: unlink the stale marker by its own name, then rmdir
//   `lock`. Nonces are never reused, so a breaker that lost a race to another
//   breaker unlinks nothing; it cannot reach the marker of whoever took the
//   lock since. rmdir removes only an empty directory.
// - Releasing: the same two steps on the holder's own marker.
//
// Every removal names exactly what it removes, so no process acts on a lock it
// looked at earlier that has since been replaced, whatever the interleaving.
const MARKER_BYTES = 8;
const STAGING_RE = /^lock\.(\d+)\.([0-9a-f]{16})\.new$/;
// The errors a rename onto a held lock gives. Windows cannot rename onto any
// existing directory and reports that, and a directory still pending delete,
// as EPERM or EACCES.
const LOCK_BUSY = process.platform === 'win32'
  ? ['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY']
  : ['EEXIST', 'ENOTEMPTY', 'ENOTDIR'];
const LOCK_BACKOFF_MIN_MS = 10;
const LOCK_BACKOFF_MAX_MS = 100;

function readMarker(file) {
  let fd;
  let stat;
  let raw;
  try {
    fd = fs.openSync(file, 'r');
    stat = fs.fstatSync(fd);
    raw = fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let holder = {};
  try {
    holder = JSON.parse(raw) || {};
  } catch {
    // Markers are complete before the lock appears, so only a hand edit gets here.
  }
  return { holder, mtimeMs: stat.mtimeMs };
}

// A pid means something only inside its pid namespace. Command sandboxes
// (bubblewrap, containers) give each command a namespace of its own on the
// same host, where another namespace's live holder looks gone, so breaking on
// it lets two writers hold the lock and one overwrite the other's update.
// Platforms without namespaces read null on both sides.
let ownPidNamespace;
function pidNamespace() {
  if (ownPidNamespace === undefined) {
    try {
      ownPidNamespace = fs.readlinkSync('/proc/self/ns/pid');
    } catch {
      ownPidNamespace = null;
    }
  }
  return ownPidNamespace;
}

let ownBootId;
function bootId() {
  if (ownBootId === undefined) {
    try {
      ownBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
    } catch {
      ownBootId = null;
    }
  }
  return ownBootId;
}

function lockIsStale(marker) {
  const { pid, host, pidns, start_ticks, boot_id } = marker.holder;
  if (host === os.hostname()) {
    const boot = bootId();
    // A reboot also replaces pid namespaces; its old holders are all gone.
    if (boot_id && boot && boot_id !== boot) return true;
    if ((pidns ?? null) === pidNamespace() && Number.isInteger(pid) && pid > 0) {
      if (!pidAlive(pid)) return true;
      if (process.platform === 'linux' && typeof start_ticks === 'string') {
        const state = require('./processes').processState({ pid, host, start_ticks });
        if (state === 'exited') return true;
        if (state === 'running') return false;
      }
    }
  }
  // Without a readable start identity, a live PID may belong to a replacement.
  return Date.now() - marker.mtimeMs > LOCK_STALE_MS;
}

function holderText(h) {
  return h && h.pid ? `pid ${h.pid} on ${h.host} since ${h.at}` : 'another process';
}

function removeQuietly(fn, target) {
  try {
    fn(target);
    return true;
  } catch {
    return false;
  }
}

// One look at a lock we could not take: who holds it, and clear what is stale.
// progress is true when this call removed something, so the caller retries at
// once; stuck names a stale holder whose marker could not be removed.
function clearStale(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    // A plain file here is not a lock this version takes or breaks.
    if (e.code === 'ENOTDIR') return { progress: false, holder: (readMarker(dir) || {}).holder || null };
    return { progress: false, holder: null };
  }
  let progress = false;
  let holder = null;
  let stuck = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const marker = readMarker(file);
    if (!marker) continue;
    if (!lockIsStale(marker)) {
      holder = marker.holder;
      continue;
    }
    try {
      fs.unlinkSync(file);
      progress = true;
    } catch (e) {
      if (e.code === 'ENOENT') progress = true;
      else stuck = { holder: marker.holder, code: e.code };
    }
  }
  if (!holder && !stuck && removeQuietly(fs.rmdirSync, dir)) progress = true;
  return { progress, holder, stuck };
}

function lockTimeout(dir, seen) {
  if (seen.stuck) {
    return new TowerCraneError(3, `state is locked by ${holderText(seen.stuck.holder)}, which is gone, but its lock could not be removed (${seen.stuck.code}); remove ${dir} by hand`);
  }
  return new TowerCraneError(3, `state is locked by ${holderText(seen.holder)}; retry, or remove ${dir} if that process is gone`);
}

// A writer killed while preparing leaves its directory behind. The pid in
// its name protects a live writer even before its marker exists, when a
// clock jump or suspension can make the directory appear old.
function sweepStaging(stateDir) {
  let names;
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = STAGING_RE.exec(name);
    if (!m) continue;
    if (pidAlive(Number(m[1]))) continue;
    const dir = path.join(stateDir, name);
    const marker = readMarker(path.join(dir, m[2]));
    let mtimeMs = marker ? marker.mtimeMs : null;
    if (mtimeMs === null) {
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (Date.now() - mtimeMs <= LOCK_STALE_MS) continue;
    removeQuietly(fs.unlinkSync, path.join(dir, m[2]));
    removeQuietly(fs.rmdirSync, dir);
  }
}

function acquireLock(stateDir, waitMs = LOCK_WAIT_MS) {
  const dir = path.join(stateDir, 'lock');
  const deadline = performance.now() + waitMs;
  const identity = require('./processes').identity(process.pid);
  const boot_id = bootId();
  let backoff = LOCK_BACKOFF_MIN_MS;
  let finalAttempt = false;
  for (;;) {
    const nonce = crypto.randomBytes(MARKER_BYTES).toString('hex');
    const staging = path.join(stateDir, `lock.${process.pid}.${nonce}.new`);
    const marker = path.join(staging, nonce);
    const mine = path.join(dir, nonce);
    let prepared = false;
    try {
      // Never reuse a directory another attempt might still be cleaning up.
      fs.mkdirSync(staging);
      prepared = true;
      fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, ...identity, boot_id, pidns: pidNamespace(), at: nowIso(), nonce }));
      fs.renameSync(staging, dir);
      // A sweeper in another pid namespace can see us as gone. The rename
      // can land on an empty directory if it removed our marker first.
      if (fs.existsSync(mine)) {
        sweepStaging(stateDir);
        return { dir, nonce, file: mine };
      }
      removeQuietly(fs.rmdirSync, dir);
    } catch (e) {
      if (e.code === 'ENOENT' && !isDir(stateDir)) {
        throw refuse(`no tower-crane state at ${stateDir}; run tower-crane init --name N --goal G (or point --state at the right directory)`);
      }
      if (e.code !== 'ENOENT' && !LOCK_BUSY.includes(e.code)) throw e;
    } finally {
      if (prepared) {
        removeQuietly(fs.unlinkSync, marker);
        removeQuietly(fs.rmdirSync, staging);
      }
    }
    const seen = clearStale(dir);
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      // Reclaim at the deadline permits one attempt, never another retry loop.
      if (!seen.progress || finalAttempt) throw lockTimeout(dir, seen);
      finalAttempt = true;
    } else {
      sleepSync(Math.min(remaining, backoff + Math.floor(Math.random() * backoff)));
      backoff = Math.min(backoff * 2, LOCK_BACKOFF_MAX_MS);
    }
  }
}

// Windows refuses to delete a file another process has open without
// FILE_SHARE_DELETE (a virus scanner, say), so retry briefly.
function unlinkRetry(file) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) return false;
      sleepSync(25);
    }
  }
}

function releaseLock(lock) {
  unlinkRetry(lock.file);
  // Removes only an empty directory: a holder that took over since keeps its lock.
  removeQuietly(fs.rmdirSync, lock.dir);
}

function withLock(stateDir, fn, waitMs = LOCK_WAIT_MS) {
  const lock = acquireLock(stateDir, waitMs);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// Windows refuses to replace a file another process has open (a reader or
// fs.watch), so retry the rename briefly before giving up.
function renameRetry(from, to) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || Date.now() > deadline) {
        try {
          fs.unlinkSync(from);
        } catch {
          // Nothing to clean up.
        }
        throw e;
      }
      sleepSync(25);
    }
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameRetry(tmp, file);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw refuse(`${path.basename(file)} is missing from ${path.dirname(file)}; restore it or run tower-crane init in a fresh state directory`);
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw refuse(`${file} is not valid JSON (${e.message}); fix it by hand or restore it from version control`);
  }
}

const isStr = (v) => typeof v === 'string';
const isNonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isNullOr = (v, check) => v === null || check(v);
const isInt = (v) => Number.isInteger(v);
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function validateProject(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['project.json must hold an object'];
  if (p.version !== 1) errs.push('version must be 1');
  if (p.schema_version !== undefined && (!Number.isSafeInteger(p.schema_version) || p.schema_version < 1)) {
    errs.push('schema_version must be a positive safe integer');
  }
  if (!isNonEmpty(p.name)) errs.push('name must be a non-empty string');
  if (!isNonEmpty(p.goal)) errs.push('goal must be a non-empty string');
  if (!isNullOr(p.repo, isNonEmpty)) errs.push('repo must be null or "owner/repo"');
  if (!isNonEmpty(p.base)) errs.push('base must be a branch name');
  if (!isNonEmpty(p.standards)) errs.push('standards must be "default" or a path');
  if (p.owner_config_dir !== undefined
    && (!isNonEmpty(p.owner_config_dir) || !path.isAbsolute(p.owner_config_dir) || p.owner_config_dir.includes('\0'))) {
    errs.push('owner_config_dir must be an absolute path without NUL bytes');
  }
  if (p.roles !== undefined) errs.push('roles was replaced by harness and ladder (docs/state.md); remove roles, and add a ladder if the defaults do not fit');
  // Shape only: whether a rung can run may depend on the user file, which
  // can change under a project; spawn, ladder writes and validate check that.
  errs.push(...L.shapeErrors(p));
  errs.push(...require('./reviewer').errors(p.review));
  errs.push(...require('./research').errors(p.research));
  errs.push(...require('./gate-commands').errors(p.gates));
  if (p.merge !== undefined) {
    if (!p.merge || typeof p.merge !== 'object' || Array.isArray(p.merge)) errs.push('merge must be an object');
    else {
      for (const key of ['keep_branch', 'admin']) {
        if (p.merge[key] !== undefined && typeof p.merge[key] !== 'boolean') errs.push(`merge.${key} must be a boolean`);
      }
    }
  }
  if (p.decision_delegation !== undefined) {
    const delegation = p.decision_delegation;
    if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) {
      errs.push('decision_delegation must be an object');
    } else {
      for (const key of Object.keys(delegation)) {
        if (key !== 'orchestrator_technical') errs.push(`decision_delegation.${key} is unknown`);
      }
      if (delegation.orchestrator_technical !== undefined && typeof delegation.orchestrator_technical !== 'boolean') {
        errs.push('decision_delegation.orchestrator_technical must be a boolean');
      }
    }
  }
  const l = p.limits || {};
  if (!isInt(l.workers) || l.workers < 1) errs.push('limits.workers must be a positive integer');
  if (!isInt(l.lease_minutes) || l.lease_minutes < 1) errs.push('limits.lease_minutes must be a positive integer');
  if (l.paused !== undefined && (typeof l.paused !== 'string' || !l.paused.trim())) errs.push('limits.paused must be a non-blank reason');
  const b = p.budget || {};
  if (!isNullOr(b.hours, isNonNegNum)) errs.push('budget.hours must be null or a non-negative number');
  if (!isNullOr(b.tokens, isNonNegNum)) errs.push('budget.tokens must be null or a non-negative number');
  return errs;
}

function validateTask(t, errs) {
  const at = t && t.id ? t.id : 'a task';
  const bad = (m) => errs.push(`${at}: ${m}`);
  if (!t || typeof t !== 'object') return errs.push('every task must be an object');
  if (!/^T\d+$/.test(t.id)) bad('id must look like T1');
  if (!isNonEmpty(t.title)) bad('title must be a non-empty string');
  if (!isNonEmpty(t.kind)) bad('kind must be a non-empty string');
  if (t.needs !== undefined && (!Array.isArray(t.needs) || !t.needs.every(isNonEmpty))) bad('needs must be an array of capability names');
  if (!Array.isArray(t.acceptance) || !t.acceptance.every(isStr)) bad('acceptance must be an array of strings');
  if (!Array.isArray(t.depends_on) || !t.depends_on.every(isStr)) bad('depends_on must be an array of task ids');
  if (!Array.isArray(t.locks) || !t.locks.every(isNonEmpty) || new Set(t.locks).size !== t.locks.length) {
    bad('locks must be an array of unique non-empty resource names');
  }
  if (!isNullOr(t.environment, isNonEmpty)) bad('environment must be null or a non-empty label');
  if (!isNullOr(t.needs_owner, isNonEmpty)) bad('needs_owner must be null or a reason');
  if (!isNonEmpty(t.size)) bad('size must be a non-empty string');
  if (!isNonEmpty(t.tier)) bad('tier must be a non-empty string');
  if (t.tier_range !== undefined) {
    const range = t.tier_range;
    if (!range || !isNonEmpty(range.min) || !isNonEmpty(range.max)
      || [range.min, range.max, t.tier].every((tier) => TIERS.includes(tier))
        && (!L.tierSpec(`${range.min}..${range.max}`)
          || TIERS.indexOf(t.tier) < TIERS.indexOf(range.min) || TIERS.indexOf(t.tier) > TIERS.indexOf(range.max))) bad('tier_range must be { min, max } containing the current tier');
  }
  if (t.escalation_pending !== undefined && typeof t.escalation_pending !== 'boolean') bad('escalation_pending must be boolean');
  if (t.escalations !== undefined && (!Array.isArray(t.escalations) || t.escalations.some((e) => !e || !isNonEmpty(e.source) || !isNonEmpty(e.from) || !isNullOr(e.to, isNonEmpty) || !isNonEmpty(e.reason)))) bad('escalations must record source, from, to and reason');
  if (!isNonEmpty(t.status)) bad('status must be a non-empty string');
  if (t.claim !== null) {
    const c = t.claim;
    if (!c || !isNonEmpty(c.agent) || !isStr(c.since) || !isStr(c.until)) bad('claim must be null or { agent, since, until }');
  }
  if (t.status === 'in_progress' && !t.claim) bad('an in_progress task needs a claim');
  if (!isNullOr(t.branch, isNonEmpty)) bad('branch must be null or a branch name');
  if (!isNullOr(t.pr, (v) => isInt(v) && v > 0)) bad('pr must be null or a pull request number');
  if (!isNullOr(t.sha, isNonEmpty)) bad('sha must be null or a commit hash');
  if (!isNullOr(t.submitted_by, isNonEmpty)) bad('submitted_by must be null or an agent');
  if (t.retiring !== undefined && t.retiring !== null) {
    const r = t.retiring;
    if (!r || !isStr(r.since) || !Number.isInteger(r.pid) || r.pid <= 0 || !isNonEmpty(r.host)) bad('retiring must be null or { since, pid, host }');
  }
  if (t.stack !== undefined && t.stack !== null) {
    const s = t.stack;
    if (!s || !/^T\d+$/.test(s.parent) || !isNonEmpty(s.base) || !isNonEmpty(s.repo)
      || !isNonEmpty(s.parent_sha) || !isNonEmpty(s.synced_base) || typeof s.linked !== 'boolean') {
      bad('stack must hold parent, base, repo, parent_sha, synced_base and linked');
    }
  }
  if (t.stack_disabled !== undefined && typeof t.stack_disabled !== 'boolean') bad('stack_disabled must be a boolean');
  if (t.github_stack != null && (typeof t.github_stack !== 'object' || Array.isArray(t.github_stack))) bad('github_stack must be an object or null');
  if (!Array.isArray(t.evidence)) bad('evidence must be an array');
  else {
    for (const e of t.evidence) {
      // An unfamiliar receipt cannot satisfy a known gate. Its payload is
      // owned by the tool that wrote that evidence type.
      if (e && isNonEmpty(e.type) && !EVIDENCE_TYPES.includes(e.type)) continue;
      if (e?.confirmed_failure !== undefined && typeof e.confirmed_failure !== 'boolean') bad('confirmed_failure must be a boolean');
      if (!e || !EVIDENCE_TYPES.includes(e.type) || typeof e.ok !== 'boolean' || !isNonEmpty(e.agent) || !isInt(e.revision)) {
        bad(`evidence entries need type (${EVIDENCE_TYPES.join(', ')}), ok, agent and revision`);
        break;
      }
    }
  }
  if (!isInt(t.revision) || t.revision < 1) bad('revision must be a positive integer');
  if (t.budget !== undefined && (!t.budget || typeof t.budget !== 'object'
    || !isNullOr(t.budget.hours, isNonNegNum) || !isNullOr(t.budget.tokens, isNonNegNum))) {
    bad('budget must be { hours, tokens }, each null or a non-negative number');
  }
  if (!t.spend || !isNonNegNum(t.spend.minutes) || !Number.isSafeInteger(t.spend.tokens) || t.spend.tokens < 0) bad('spend must be { minutes, tokens }, with non-negative safe integer tokens');
  else {
    for (const key of ['input', 'cached', 'output']) {
      if (t.spend[key] !== undefined && (!Number.isSafeInteger(t.spend[key]) || t.spend[key] < 0)) bad(`spend.${key} must be a non-negative safe integer`);
    }
    if (t.spend.entries !== undefined) {
      if (!Array.isArray(t.spend.entries)) bad('spend.entries must be an array');
      else for (const entry of t.spend.entries) {
        if (!entry || !isNonEmpty(entry.at) || !isNonEmpty(entry.agent) || !isNonEmpty(entry.source) || !isNonNegNum(entry.minutes)) {
          bad('spend entries need at, agent, source and minutes');
          continue;
        }
        for (const key of ['tokens', 'input', 'cached', 'output']) {
          if (entry[key] !== null && (!Number.isSafeInteger(entry[key]) || entry[key] < 0)) bad(`spend entry ${key} must be null or a non-negative safe integer`);
        }
        if (entry.cost_usd !== undefined && !isNullOr(entry.cost_usd, isNonNegNum)) bad('spend entry cost_usd must be null or a non-negative number');
        if (!isNullOr(entry.rung, isNonEmpty)) bad('spend entry rung must be null or a ladder rung');
        if (!isNullOr(entry.harness, isNonEmpty)) bad('spend entry harness must be null or a harness');
        for (const key of ['model', 'profile']) if (!isNullOr(entry[key], isNonEmpty)) bad(`spend entry ${key} must be null or a non-empty string`);
        if (entry.live !== undefined && (!entry.live || !isNonEmpty(entry.live.state)
          || !Number.isSafeInteger(entry.live.interval_ms) || entry.live.interval_ms < 1)) {
          bad('spend entry live must have a non-empty state and positive integer interval_ms');
        }
        if (entry.live?.error !== undefined && !isNonEmpty(entry.live.error)) {
          bad('spend entry live.error must be a non-empty error class');
        }
        if (entry.provider !== undefined && !isNonEmpty(entry.provider)) bad('spend entry provider must be a non-empty string');
      }
    }
  }
  if (!Array.isArray(t.notes)) bad('notes must be an array');
}

function validateTasks(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['tasks.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (!Array.isArray(doc.tasks)) return errs.concat('tasks must be an array');
  const seen = new Set();
  for (const t of doc.tasks) {
    validateTask(t, errs);
    if (t && t.id) {
      if (seen.has(t.id)) errs.push(`${t.id}: duplicate id`);
      seen.add(t.id);
    }
  }
  return errs;
}

function validateDecisions(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object') return ['decisions.json must hold an object'];
  if (doc.version !== 1) errs.push('version must be 1');
  if (!isInt(doc.next) || doc.next < 1) errs.push('next must be a positive integer');
  if (!Array.isArray(doc.decisions)) return errs.concat('decisions must be an array');
  const seen = new Set();
  for (const d of doc.decisions) {
    const at = d && d.id ? d.id : 'a decision';
    if (!d || !/^D\d+$/.test(d.id)) errs.push(`${at}: id must look like D1`);
    else if (seen.has(d.id)) errs.push(`${d.id}: duplicate id`);
    else seen.add(d.id);
    if (!d) continue;
    if (!isNonEmpty(d.question)) errs.push(`${at}: question must be a non-empty string`);
    if (!Array.isArray(d.options) || !d.options.every(isNonEmpty)) errs.push(`${at}: options must be an array of strings`);
    if (!Array.isArray(d.blocks) || !d.blocks.every(isStr)) errs.push(`${at}: blocks must be an array of task ids`);
    if (!Array.isArray(d.answerers) || !d.answerers.every(isNonEmpty)) errs.push(`${at}: answerers must be an array of agent names`);
    else {
      if (new Set(d.answerers).size !== d.answerers.length) errs.push(`${at}: answerers must be distinct`);
      if (d.answerers.some((agent) => ['owner', 'orchestrator'].includes(agent))) {
        errs.push(`${at}: owner and orchestrator cannot be named answerers`);
      }
    }
    if (typeof d.technical !== 'boolean') errs.push(`${at}: technical must be a boolean`);
    if (d.answer_rule !== undefined && d.answer_rule !== null
      && !isNonEmpty(d.answer_rule)) {
      errs.push(`${at}: answer_rule must be a non-empty string`);
    }
    if (!isNonEmpty(d.status)) errs.push(`${at}: status must be a non-empty string`);
    if (d.status === 'answered' && !isNonEmpty(d.answer)) errs.push(`${at}: an answered decision needs an answer`);
    if (d.status === 'withdrawn' && !(isNonEmpty(d.withdrawn_by) && isNonEmpty(d.withdraw_reason))) {
      errs.push(`${at}: a withdrawn decision needs withdrawn_by and withdraw_reason`);
    }
  }
  return errs;
}

// Fields added after the first files were written default here, so older
// files keep loading.
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return t;
  const defaults = {
    kind: 'code', needs: [], acceptance: [], depends_on: [], locks: [], environment: null, needs_owner: null, size: 'M',
    claim: null, branch: null, pr: null, sha: null, submitted_by: null, evidence: [], revision: 1, notes: [],
  };
  for (const [k, v] of Object.entries(defaults)) if (t[k] === undefined) t[k] = Array.isArray(v) ? [] : v;
  if (t.tier === undefined) t.tier = L.defaultTier(t.kind, t.size);
  // tier replaced role; a stale role would read as if it still chose the model.
  delete t.role;
  if (!t.spend) t.spend = { minutes: 0, tokens: 0 };
  return t;
}

function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return d;
  const defaults = {
    options: [], recommendation: null, why: null, blocks: [], answer: null, note: null,
    answerers: [], technical: false, answered_by: null, answered_at: null, answer_rule: null,
    withdrawn_by: null, withdrawn_at: null, withdraw_reason: null,
  };
  for (const [k, v] of Object.entries(defaults)) if (d[k] === undefined) d[k] = Array.isArray(v) ? [] : v;
  return d;
}

function checkOrRefuse(file, errs) {
  if (errs.length) throw refuse(`${file} is invalid: ${errs.join('; ')}; fix it by hand or restore it from version control`);
}

function assertSchema(project) {
  const version = project?.schema_version ?? 1;
  if (Number.isSafeInteger(version) && version > SCHEMA_VERSION) {
    throw Object.assign(refuse(`state schema ${version} is incompatible with this tool (supports through ${SCHEMA_VERSION}); upgrade Tower Crane before reading or writing this project`),
      { stateIncompatible: true });
  }
}

function loadState(dir) {
  if (!fs.existsSync(path.join(dir, 'project.json'))) {
    throw refuse(`no tower-crane state at ${dir}; run tower-crane init --name N --goal G (or point --state at the right directory)`);
  }
  // A commit writes tasks.json before it appends its events, so reading the
  // log first gives a reader without the lock files no older than its events:
  // validate's drift check cannot mistake a commit in between for a lost write.
  const events = readEvents(dir);
  const project = readJson(path.join(dir, 'project.json'));
  assertSchema(project);
  try {
    checkOrRefuse('project.json', validateProject(project));
    const tasks = readJson(path.join(dir, 'tasks.json'));
    if (tasks && Array.isArray(tasks.tasks)) tasks.tasks.forEach(normalizeTask);
    checkOrRefuse('tasks.json', validateTasks(tasks));
    for (const task of tasks.tasks) for (const entry of task.evidence) EvidenceStore.hydrate(entry, dir, task.id);
    const decisions = readJson(path.join(dir, 'decisions.json'));
    if (decisions && Array.isArray(decisions.decisions)) decisions.decisions.forEach(normalizeDecision);
    checkOrRefuse('decisions.json', validateDecisions(decisions));
    // Lock-free readers may straddle the marker and payload writes of a
    // migration. Do not return a mixed snapshot or misreport it as corruption.
    assertSchema(readJson(path.join(dir, 'project.json')));
    return { dir, project, tasks, decisions, events };
  } catch (error) {
    assertSchema(readJson(path.join(dir, 'project.json')));
    throw error;
  }
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

function appendEvents(dir, events) {
  if (!events.length) return;
  for (const e of events) {
    e.detail = Secrets.redact(e.detail);
    e.id = `E${crypto.randomUUID()}`;
    e.type = eventType(e);
    e.to = e.cmd === 'msg' ? e.detail.to : 'orchestrator';
  }
  const fd = fs.openSync(path.join(dir, 'events.jsonl'), 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    let prefix = '';
    if (size) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      // A torn final line must not consume the next receipt when the log is read again.
      if (last[0] !== 10) prefix = '\n';
    }
    fs.appendFileSync(fd, prefix + events.map((e) => JSON.stringify(e) + '\n').join(''));
  } finally {
    fs.closeSync(fd);
  }
}

function eventType(e) {
  const names = { submit: 'submitted', accept: 'accepted', rework: 'rework', ask: 'decision-opened', answer: 'decision-answer', 'decision withdraw': 'decision-withdrawn', release: 'released', msg: 'worker-message', 'spawn fallback': 'spawn-fallback', 'ci completed': 'ci-completed' };
  if (names[e.cmd]) return names[e.cmd];
  if (['task note', 'decision note'].includes(e.cmd) && e.agent === 'owner') return 'owner-comment';
  if ((e.cmd === 'evidence' || e.cmd.startsWith('check ') || e.cmd === 'merge') && e.detail.type) {
    return e.detail.type === 'merge' && e.detail.ok ? 'merged' : 'evidence';
  }
  return e.cmd;
}

function readEvents(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    // Progress from before the side log stays in place so byte cursors hold,
    // but no decision reads it. Writers put the event's own cmd before its
    // detail, and text inside a string is escaped, so neither can match.
    const progress = line.indexOf('"cmd":"hook progress"');
    const detail = line.indexOf('"detail":');
    if (!line.trim() || progress !== -1 && (detail === -1 || progress < detail)) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line from a crash; the rest of the log still counts.
    }
  }
  return out;
}

const progressFile = (dir, agent) => path.join(dir, 'progress', `${agent}.jsonl`);

// Tool activity is frequent and only shows an agent is alive, so it goes to
// the agent's own file without the state lock. One append per line keeps
// lines whole; a lost line costs nothing.
function appendProgress(dir, agent, task, detail) {
  const file = progressFile(dir, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    id: `E${crypto.randomUUID()}`, at: nowIso(), agent, cmd: 'hook progress', type: 'hook progress', task, detail: Secrets.redact(detail),
  }) + '\n');
}

function renderSafely(st) {
  try {
    require('./render').renderFiles(st);
  } catch (e) {
    process.stderr.write(`tower-crane: state written, but rendering the sketch failed: ${e.message}\n`);
  }
}

// The broker runs an agent's command with TOWER_CRANE_VIA=broker after
// checking who sent it; records it writes say so. That is provenance, not
// proof: any unsandboxed process can set the variable or write the files.
function via(ctx) {
  const value = ctx.env?.TOWER_CRANE_VIA;
  return ['broker', 'automation'].includes(value) ? { via: value } : {};
}

// Every write: take the lock, re-read, let fn change the in-memory state,
// validate, write changed files atomically, log events, re-render. A refused
// command writes nothing unless fn committed an earlier checkpoint.
function mutate(ctx, cmd, fn, waitMs = LOCK_WAIT_MS) {
  const dir = ctx.stateDir;
  let rerender = false;
  let result;
  try {
    result = withLock(dir, () => Commands.mutation(() => {
    const st = loadState(dir);
    const before = { project: json(st.project), tasks: EvidenceStore.tasksJson(st.tasks, dir), decisions: json(st.decisions) };
    const events = [];
    let changed = false;
    const emit = (task, detail, name) => {
      events.push({ at: nowIso(), agent: ctx.agent, ...via(ctx), cmd: name || cmd, task: task || null, detail: detail || {} });
    };
    // The settings audit names the command it records.
    emit.cmd = cmd;
    // A spawn can checkpoint a claim while retaining the lock, so the child
    // sees its holder before it tries to claim the task itself.
    const commit = () => {
      assertSchema(st.project);
      checkOrRefuse('project.json', validateProject(st.project));
      checkOrRefuse('tasks.json', validateTasks(st.tasks));
      checkOrRefuse('decisions.json', validateDecisions(st.decisions));
      for (const key of ['project', 'tasks', 'decisions']) {
        const text = key === 'tasks' ? EvidenceStore.tasksJson(st.tasks, dir, true) : json(st[key]);
        if (text !== before[key]) {
          writeAtomic(path.join(dir, `${key}.json`), text);
          before[key] = text;
          changed = true;
        }
      }
      if (events.length) {
        const pending = events.splice(0);
        appendEvents(dir, pending);
        // Rendering must see the receipts just appended, so a completed gate appears immediately.
        st.events.push(...pending);
      }
    };
    let result;
    let finished = false;
    try {
      result = fn(st, emit, commit);
      commit();
      finished = true;
    } finally {
      // The sketch's gate report reads the repository with git, which a
      // brokered command does not run; the next write outside it renders.
      rerender = (changed || (finished && st.rerender)) && via(ctx).via !== 'broker';
    }
    return result;
  }), waitMs);
  } finally {
    if (rerender) {
      try { require('./render').render(ctx); }
      catch (e) { process.stderr.write(`tower-crane: state written, but rendering the sketch failed: ${e.message}\n`); }
    }
  }
  return result;
}

module.exports = {
  KINDS, NEEDS, SIZES, STATUSES, EVIDENCE_TYPES, HARNESSES, TIERS, SCHEMA_VERSION, LOCK_WAIT_MS, LOCK_STALE_MS,
  git, repoAt, locateStateDir, findRepo, pidAlive, acquireLock, releaseLock, withLock, writeAtomic, readJson,
  validateProject, validateTasks, validateDecisions, loadState, mutate, via, appendEvents, readEvents, progressFile, appendProgress, eventType, json, renderSafely,
};
