'use strict';

// Owner approval of the sandbox, env, env_file and scope that personal
// fallback routes carry. The user file is a plain file that anything running
// as the user can edit, and TOWER_CRANE_CONFIG can name any file, so a grant
// there counts only after `ladder set --fallbacks` wrote it under the
// authority check. That write pins a SHA-256 of each route's grants in
// owner/route-grants.json under the project's recorded owner_config_dir,
// beside the owner key, which every agent sandbox hides. Spawn drops a
// fallback route whose grants are not pinned for its user file and rung.
// A hash, not the values: env values are often secrets, and they stay only
// in the file the owner put them in.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const SpawnSettings = require('./spawn-settings');
const { refuse } = require('./util');

const FIELDS = SpawnSettings.FIELDS;
const HEX = /^[0-9a-f]{64}$/;

// The grant fields a route sets, in FIELDS order.
function fields(route) {
  return FIELDS.filter((k) => route?.[k] !== undefined);
}

// Object keys sorted at every level, so key order never changes the hash.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

// The hash of a route's grants, or null when it sets none.
function hash(route) {
  const set = fields(route);
  if (!set.length) return null;
  const grants = Object.fromEntries(set.map((k) => [k, canonical(route[k])]));
  return crypto.createHash('sha256').update(JSON.stringify(grants)).digest('hex');
}

function file(project) {
  const dir = project?.owner_config_dir;
  return typeof dir === 'string' && path.isAbsolute(dir) ? path.join(dir, 'owner', 'route-grants.json') : null;
}

// { "<user file>": { "<rung>": [hash, ...] } }. A missing or malformed file
// approves nothing.
function read(project) {
  const f = file(project);
  if (!f) return {};
  try {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    return doc && typeof doc.files === 'object' && !Array.isArray(doc.files) && doc.files ? doc.files : {};
  } catch {
    return {};
  }
}

function approved(pins, userFile, rung) {
  const list = pins[userFile]?.[rung];
  return new Set(Array.isArray(list) ? list.filter((h) => typeof h === 'string' && HEX.test(h)) : []);
}

// The routes of a fallback list whose grants are not pinned: [{ route, fields }],
// route counted from 1.
function unapproved(project, userFile, rung, routes, pins = read(project)) {
  const ok = approved(pins, userFile, rung);
  return (routes || []).flatMap((route, i) => {
    const h = hash(route);
    return h && !ok.has(h) ? [{ route: i + 1, fields: fields(route) }] : [];
  });
}

// The layers spawn dispatches from: each rung keeps only the fallback routes
// whose grants are pinned. refused names the others.
function filter(project, layers) {
  const pins = read(project);
  const refused = [];
  const ladder = {};
  for (const [name, entry] of Object.entries(layers.ladder)) {
    const bad = entry.fallbacks ? unapproved(project, layers.user_file, name, entry.fallbacks, pins) : [];
    refused.push(...bad.map((b) => ({ rung: name, ...b })));
    const drop = new Set(bad.map((b) => b.route - 1));
    ladder[name] = drop.size ? { ...entry, fallbacks: entry.fallbacks.filter((_, i) => !drop.has(i)) } : entry;
  }
  return { layers: { ...layers, ladder }, refused };
}

function describe(r, userFile) {
  return `${r.rung} fallback ${r.route} from user file ${userFile} sets ${r.fields.join(', ')}, which the owner has not approved for that file; `
    + `skipped. The owner approves it by writing the list with tower-crane ladder set ${r.rung} --fallbacks JSON`;
}

// Refuses a list with grants when the project has no owner directory to pin
// them in, before anything is written.
function canPin(project, routes) {
  if (!file(project) && (routes || []).some(hash)) {
    throw refuse(`fallback routes that set ${FIELDS.join(', ')} need the project's owner_config_dir to record the owner's approval; the owner runs tower-crane owner-key --agent owner at a terminal first`);
  }
}

// Records the grants of the list ladder set just wrote, once the authority
// check allowed it. An empty or cleared list removes the rung's pins.
function pin(project, userFile, rung, routes) {
  canPin(project, routes);
  const f = file(project);
  if (!f) return;
  const hashes = [...new Set((routes || []).map(hash).filter(Boolean))].sort();
  const files = read(project);
  const rungs = { ...files[userFile] };
  if (hashes.length) rungs[rung] = hashes;
  else delete rungs[rung];
  if (Object.keys(rungs).length) files[userFile] = rungs;
  else delete files[userFile];
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  require('./state').writeAtomic(f, JSON.stringify({ version: 1, files }, null, 2) + '\n');
}

module.exports = { FIELDS, fields, hash, file, read, unapproved, filter, describe, canPin, pin };
