'use strict';

// Owner approval of what a personal fallback route may reach. The user file
// is a plain file that anything running as the user can edit, and
// TOWER_CRANE_CONFIG can name any file, so a route that carries authority
// counts only after `ladder set --fallbacks` wrote it under the authority
// check. Authority is a grant (sandbox, env, env_file, scope), a harness
// without an OS sandbox, the command harness, args on such a harness,
// web_mcp, mcp or a tool that is not a harness built-in. That write pins a
// SHA-256 of each route, by its position in the list, in
// owner/route-grants.json under the project's recorded owner_config_dir,
// beside the owner key, which every agent sandbox hides. The hash covers the
// route's harness, command, args, tools, mcp, web_mcp and grants, and the
// content of its env_file, so a pinned grant moved to another route or
// harness, or an env_file edited after the approval, is not approved.
// Spawn drops a fallback route that needs a pin and has none. A hash, not
// the values: env values are often secrets, and they stay only in the files
// the owner put them in.
//
// Pins key on the user file's canonical path (Authority.canonicalPath: the
// real path, in the case the filesystem stores), so a symlink, a different
// case on a case-insensitive filesystem or a relative TOWER_CRANE_CONFIG
// that names the same file finds the same pins. The key only picks the list
// to compare: a link moved to another file after the approval reaches that
// file's pins, if any, and each route must still match its hash. Pins
// written before this keyed on the path as spelled; that key still counts
// for that spelling until the next pin write for the file folds it in.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Authority = require('./authority');
const SpawnSettings = require('./spawn-settings');
const { refuse } = require('./util');

const GRANTS = SpawnSettings.FIELDS;
const PINNED = ['harness', 'command', 'args', 'tools', 'mcp', 'web_mcp', ...GRANTS];
const HEX = /^[0-9a-f]{64}$/;

const sandboxedHarness = (h) => require('./agents').CAPABILITIES[h]?.sandbox === true;

// What a route as written carries beyond what any confined route may do,
// judged on the harness it runs on (its own, or the primary's it follows).
// A route that sets only model, profile, provider, effort or supervision on
// a sandboxed harness carries nothing. An inherited harness is the
// primary's, whose own move off a sandbox is owner-required, so only a route
// that names its harness, or adds args to an unconfined primary, counts as
// unconfined here.
function carries(rung, route, harness = route.harness) {
  const why = GRANTS.filter((k) => route[k] !== undefined);
  if (harness === 'command') why.push('the command harness');
  if (route.command !== undefined && harness !== 'command') why.push('command');
  if (route.web_mcp !== undefined) why.push('web_mcp');
  if (route.mcp?.length) why.push('mcp');
  const A = require('./agents');
  if ((route.tools || []).some((t) => !harness || A.optInKind(harness, t) !== 'builtin')) why.push('tools beyond the harness built-ins');
  const L = require('./ladder');
  if ((route.harness || route.args?.length) && harness && harness !== 'command'
    && require('./authority').unconfinedRoute(L.JOBS[rung], { ...route, harness })) why.push(`${harness}, which runs it without an OS sandbox`);
  return why;
}

// Object keys sorted at every level, so key order never changes the hash.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

// The env_file a route names, resolved as spawn resolves it (the user's
// home for ~, else the repository root), hashed by content. A relative path
// therefore names a different file in each repository.
function envFileHash(route, base) {
  if (route.env_file === undefined) return undefined;
  const file = SpawnSettings.prepare({ sandbox: {}, env_file: route.env_file }, base.home, base.cwd).env_file;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (e) {
    return `unreadable ${e.code || e.message}`;
  }
}

// The hash of a route as written, with the harness it resolves to: a route
// that inherits its harness follows the primary, which the orchestrator may
// move among sandboxed harnesses, and an approval for one harness is not
// one for another. Its authority fields and env_file content.
function hash(route, base, harness) {
  const fields = Object.fromEntries(PINNED.filter((k) => route[k] !== undefined).map((k) => [k, canonical(route[k])]));
  fields.resolved_harness = harness ?? route.harness ?? null;
  const file = envFileHash(route, base);
  if (file !== undefined) fields.env_file_sha256 = file;
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function file(project) {
  const dir = project?.owner_config_dir;
  return typeof dir === 'string' && path.isAbsolute(dir) ? path.join(dir, 'owner', 'route-grants.json') : null;
}

// { "<user file>": { "<rung>": [hash or null, by route position] } }. A
// missing or malformed file approves nothing.
function read(project) {
  const f = file(project);
  if (!f) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    return doc && doc.files && typeof doc.files === 'object' && !Array.isArray(doc.files) ? doc.files : {};
  } catch {
    return {};
  }
}

// The key a user file's pins live under. A path that cannot be resolved
// (a loop, a directory it may not read) keys as spelled, which is how it
// was keyed before.
function keyOf(userFile) {
  try {
    return Authority.canonicalPath(userFile);
  } catch {
    return path.resolve(userFile);
  }
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The rungs pinned for a user file: the canonical key's entry once a write
// made one, else the entry an earlier version wrote under the path as
// spelled. Once the canonical entry exists the spelled one is never read,
// so it cannot bring back a pin the owner since cleared.
function entryOf(pins, userFile) {
  const key = keyOf(userFile);
  if (isObject(pins[key])) return pins[key];
  return isObject(pins[userFile]) ? pins[userFile] : {};
}

function pinsOf(entry, rung) {
  const list = entry[rung];
  return Array.isArray(list) ? list.map((h) => (typeof h === 'string' && HEX.test(h) ? h : null)) : [];
}

// Whether route i of a rung's list is the route the owner approved there.
function pinned(entry, rung, i, route, base, harness) {
  return pinsOf(entry, rung)[i] === hash(route, base, harness);
}

// The routes of a fallback list that carry authority without a pin:
// [{ route, why }], route counted from 1. harnesses names each route's
// resolved harness.
function unapproved(project, userFile, rung, routes, harnesses, base, pins = read(project)) {
  const entry = entryOf(pins, userFile);
  return (routes || []).flatMap((route, i) => {
    const why = carries(rung, route, harnesses[i]);
    return why.length && !pinned(entry, rung, i, route, base, harnesses[i]) ? [{ route: i + 1, why }] : [];
  });
}

// The layers spawn dispatches from: each rung keeps only the fallback routes
// that carry no authority or whose pin matches. refused names the others.
// skip lists more routes to leave out ({ rung, route }, from 1), which the
// caller names itself.
function filter(project, layers, base, skip = []) {
  const L = require('./ladder');
  const pins = read(project);
  const refused = [];
  const ladder = {};
  for (const [name, entry] of Object.entries(layers.ladder)) {
    const harnesses = entry.fallbacks ? L.routes(L.rungOf(layers, name)).slice(1).map((r) => r.harness) : [];
    const skipped = new Set(skip.filter((s) => s.rung === name).map((s) => s.route - 1));
    const bad = entry.fallbacks ? unapproved(project, layers.user_file, name, entry.fallbacks, harnesses, base, pins).filter((b) => !skipped.has(b.route - 1)) : [];
    refused.push(...bad.map((b) => ({ rung: name, ...b })));
    const drop = new Set([...bad.map((b) => b.route - 1), ...skipped]);
    // A kept route's env_file carries the content hash the owner approved;
    // whoever reads the file at launch, retry or switch checks it
    // (SpawnSettings.agentEnv), so a file changed after dispatch is refused.
    const kept = entry.fallbacks?.flatMap((route, i) => (drop.has(i) ? []
      : [route.env_file === undefined ? route : { ...route, env_file_sha256: envFileHash(route, base) }]));
    ladder[name] = kept ? { ...entry, fallbacks: kept } : entry;
  }
  return { layers: { ...layers, ladder }, refused };
}

function describe(r, userFile) {
  return `${r.rung} fallback ${r.route} from user file ${userFile} carries ${r.why.join(', ')}, which the owner has not approved for that file and position; `
    + `skipped. The owner approves it by writing the list with tower-crane ladder set ${r.rung} --fallbacks JSON`;
}

// The routes of the old list the owner approved: pinned, or carrying
// nothing on any harness they may resolve to. ladder set compares a new list
// with these, not with the file, so a route edited into the file by hand
// counts as new.
function approvedRoutes(project, userFile, rung, routes, harnesses, base) {
  const entry = entryOf(read(project), userFile);
  return (routes || []).filter((route, i) => pinned(entry, rung, i, route, base, harnesses[i])
    || (!PINNED.some((k) => k !== 'harness' && route[k] !== undefined) && (!route.harness || sandboxedHarness(route.harness))));
}

// Refuses a list that needs pins when the project has no owner directory to
// pin them in, before anything is written.
function canPin(project, rung, routes, harnesses) {
  if (!file(project) && (routes || []).some((r, i) => carries(rung, r, harnesses[i]).length)) {
    throw refuse('fallback routes that carry sandbox, env, env_file, scope, an unsandboxed or command harness, web_mcp, mcp or non-built-in tools need the project\'s owner_config_dir to record the owner\'s approval; the owner runs tower-crane owner-key --agent owner at a terminal first');
  }
}

// Records the list ladder set just wrote, once the authority check allowed
// it: a hash for each route position that names anything beyond a model,
// null for the others. An empty or cleared list removes the rung's pins.
// Projects bound to the same owner directory share the file, so the
// read-modify-write holds a lock in that directory. The write moves every
// entry an earlier version keyed on another spelling of the same file under
// the canonical key: the canonical entry's rungs win, then the spelling
// this write used, then the others. The store records no write times, so
// of two old spellings holding the same rung the one written through wins.
// The canonical entry stays, empty when no rung is pinned: an old spelling
// that resolved to another file at this write (a link moved since) and
// resolves here again later must still not be read.
function pin(project, userFile, rung, routes, harnesses, base) {
  canPin(project, rung, routes, harnesses);
  const f = file(project);
  if (!f) return;
  const list = (routes || []).map((r, i) => (PINNED.some((k) => r[k] !== undefined) ? hash(r, base, harnesses[i]) : null));
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const S = require('./state');
  S.withLock(dir, () => {
    const files = read(project);
    const key = keyOf(userFile);
    const spellings = Object.keys(files).filter((k) => k !== key && path.isAbsolute(k) && keyOf(k) === key)
      .sort((a, b) => (a === userFile) - (b === userFile));
    const rungs = Object.assign({}, ...spellings.map((k) => (isObject(files[k]) ? files[k] : {})), isObject(files[key]) ? files[key] : {});
    for (const k of spellings) delete files[k];
    if (list.some(Boolean)) rungs[rung] = list;
    else delete rungs[rung];
    files[key] = rungs;
    S.writeAtomic(f, JSON.stringify({ version: 1, files }, null, 2) + '\n');
  }, S.LOCK_WAIT_MS, 'route-grants');
}

module.exports = { GRANTS, PINNED, carries, hash, envFileHash, file, keyOf, read, unapproved, filter, describe, approvedRoutes, canPin, pin };
