'use strict';

// The owner's standing sandbox grant policy, project.json sandbox_policy:
// { version, orchestrator_may_grant: { read: [globs], write: [globs] },
// owner_only: [classes] }. The owner sets or widens it (sandbox.policy); the
// orchestrator may narrow or clear it (sandbox.policy.narrow). While it holds,
// the orchestrator widens one task's sandbox (task update --sandbox) or a
// rung's (ladder set --sandbox) itself when every added item lies inside it
// and in no owner-only class (sandbox.grant). Anything else opens the owner's
// decision as before. A grant the policy backed is checked again at every
// dispatch, so narrowing the policy, or a path that now resolves elsewhere,
// takes it away. docs/state.md#sandbox-policy has the contract.

const fs = require('node:fs');
const path = require('node:path');
const { usage, nowIso } = require('./util');

// Classes no policy delegates: a credential store, network hosts, the session
// bus and host sockets. A socket such as /run/docker.sock is root-equivalent
// on most hosts, and rootless docker can bind-mount anything the user reads.
const OWNER_ONLY = ['credentials', 'network', 'session_bus', 'sockets'];
const FIELDS = ['read', 'write'];
const PROJECT = '<project>';

// Credential stores under the user's home. A grant inside one, or of a
// directory that holds one, stays the owner's.
const HOME_CREDENTIALS = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials',
  '.npmrc', '.pypirc', '.password-store', '.config/gh', '.config/gcloud', '.config/tower-crane', '.config/claude-code',
  '.local/share/keyrings', '.claude', '.claude.json', '.codex', '.gemini', '.pi'];

const MESSAGE = `--sandbox-policy must be {"orchestrator_may_grant": {"read": [paths], "write": [paths]}, "owner_only": [${OWNER_ONLY.join(', ')}]}, each path absolute or starting with ~ or ${PROJECT}, with * and ** globs; or null`;

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Matching reads forward slashes, so a Windows path matches as a POSIX one does.
const slash = (p) => p.split(path.sep).join('/');
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const escape = (text) => text.replace(/[\\^$.|+()[\]{}*?]/g, (c) => `\\${c}`);
const pattern = (s) => typeof s === 'string' && s.trim() === s && s !== '' && !s.includes('\0')
  && (path.isAbsolute(s) || s === '~' || s.startsWith('~/') || s === PROJECT || s.startsWith(`${PROJECT}/`));

function shapeErrors(v, stored) {
  if (!object(v)) return [MESSAGE];
  const errs = [];
  for (const k of Object.keys(v)) {
    if (!['orchestrator_may_grant', 'owner_only', ...(stored ? ['version'] : [])].includes(k)) errs.push(`unknown field ${k}`);
  }
  if (stored && (!Number.isSafeInteger(v.version) || v.version < 1)) errs.push('version must be a positive integer');
  const grant = v.orchestrator_may_grant;
  if (!object(grant)) errs.push('orchestrator_may_grant must be an object of read and write path lists');
  else {
    for (const k of Object.keys(grant)) {
      if (k === 'sockets') errs.push('orchestrator_may_grant.sockets: sockets are never the orchestrator\'s to grant; they stay owner-only');
      else if (!FIELDS.includes(k)) errs.push(`orchestrator_may_grant: unknown field ${k}`);
    }
    for (const k of FIELDS) {
      if (grant[k] !== undefined && (!Array.isArray(grant[k]) || !grant[k].every(pattern))) {
        errs.push(`orchestrator_may_grant.${k} must be an array of paths, each absolute or starting with ~ or ${PROJECT}`);
      }
    }
  }
  if (v.owner_only !== undefined && (!Array.isArray(v.owner_only) || !v.owner_only.every((c) => OWNER_ONLY.includes(c)))) {
    errs.push(`owner_only must list classes among ${OWNER_ONLY.join(', ')}; they stay owner-only whether listed or not`);
  }
  return errs;
}

// What is wrong with a stored policy, for project.json validation.
function errors(policy) {
  return policy === undefined ? [] : shapeErrors(policy, true).map((e) => `sandbox_policy: ${e}`);
}

// The policy a --sandbox-policy flag asks for, or null to clear it.
function parse(text) {
  let v;
  try { v = JSON.parse(text); } catch { throw usage(MESSAGE); }
  if (v === null) return null;
  const errs = shapeErrors(v, false);
  if (errs.length) throw usage(`--sandbox-policy: ${errs.join('; ')}`);
  return {
    orchestrator_may_grant: Object.fromEntries(FIELDS.map((k) => [k, [...new Set(v.orchestrator_may_grant[k] || [])]])),
    owner_only: [...OWNER_ONLY],
  };
}

// The grant entries next has that before lacks. None means next narrows,
// which the orchestrator may do; any is a widening, the owner's.
function widens(before, next) {
  if (!next) return [];
  return FIELDS.flatMap((k) => (next.orchestrator_may_grant[k] || [])
    .filter((p) => !(before?.orchestrator_may_grant?.[k] || []).includes(p)).map((p) => `${k} ${p}`));
}

// Each policy written gets the next version, even after a clear, so a grant
// names the one it relied on.
function versioned(policy, previous, events) {
  const last = Math.max(previous?.version || 0, ...events.filter((e) => e.cmd === 'sandbox policy').map((e) => e.detail?.version || 0));
  return { version: last + 1, ...policy };
}

// The items a sandbox object widens: each read and write path, each network
// host and the session bus.
function itemsOf(sandbox) {
  if (!object(sandbox)) return [];
  return [
    ...['read', 'write', 'domains'].flatMap((field) => (sandbox[field] || []).map((value) => ({ field, value }))),
    ...(sandbox.session_bus === true ? [{ field: 'session_bus', value: true }] : []),
  ];
}

const key = (item) => `${item.field}\0${item.value}`;

// The items after has that before does not.
function added(before, after) {
  const was = new Set(itemsOf(before).map(key));
  return itemsOf(after).filter((item) => !was.has(key(item)));
}

function sandboxOf(items) {
  const out = {};
  for (const { field, value } of items) {
    if (field === 'session_bus') out.session_bus = true;
    else if (!(out[field] ||= []).includes(value)) out[field].push(value);
  }
  return out;
}

// A sandbox object with the records' path items taken out.
function without(sandbox, records) {
  const out = { ...sandbox };
  for (const g of records) {
    if (!Array.isArray(out[g.field])) continue;
    out[g.field] = out[g.field].filter((v) => v !== g.value);
    if (!out[g.field].length) delete out[g.field];
  }
  return out;
}

function describe(items) {
  return items.map((i) => (i.field === 'session_bus' ? 'session_bus' : `${i.field} ${i.value}`)).join(', ');
}

// Where a path leads: its canonical form, following a link whose target does
// not exist yet, so a dangling link is judged by what it would reach.
function canonical(p, depth = 0) {
  const real = require('./authority').canonicalPath(p);
  if (depth > 40) return real;
  let link = null;
  try { if (fs.lstatSync(real).isSymbolicLink()) link = fs.readlinkSync(real); } catch { /* nothing there */ }
  return link === null ? real : canonical(path.resolve(path.dirname(real), link), depth + 1);
}

// An item path as spawn reads it: ~ in the user's home, a relative path in
// the repository root (lib/spawn-settings.js prepare).
function expandItem(value, r) {
  const p = value === '~' ? r.home : /^~[/\\]/.test(value) ? path.join(r.home, value.slice(2)) : value;
  return path.resolve(r.project || path.parse(process.cwd()).root, p);
}

function expandPattern(value, r) {
  if (value === '~' || value.startsWith('~/')) return path.join(r.home, value.slice(1));
  if (value === PROJECT || value.startsWith(`${PROJECT}/`)) return r.project ? path.join(r.project, value.slice(PROJECT.length)) : null;
  return value;
}

// Where ~ and <project> point, and what no policy hands out, for one command
// or dispatch: home is the user's own (lib/agents.js origin), project the
// repository's main checkout, settings the project.json in force.
function roots({ home, project, stateDir, env, settings }) {
  const canonical = require('./authority').canonicalPath;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtime = env?.XDG_RUNTIME_DIR || (uid === null ? null : `/run/user/${uid}`);
  const envFiles = [settings?.env_file, ...Object.values(settings?.ladder || {}).map((rung) => rung?.env_file)]
    .filter((f) => typeof f === 'string' && f.trim()).map((f) => expandItem(f, { home, project }));
  const ownerDir = typeof settings?.owner_config_dir === 'string' ? settings.owner_config_dir : null;
  return {
    home, project,
    bus: runtime ? [path.join(runtime, 'bus'), path.join(runtime, 'systemd')].map(canonical) : [],
    sockets: [...(process.platform === 'win32' ? [] : ['/run', '/var/run']), ...(runtime ? [runtime] : [])].map(canonical),
    credentials: [
      ...HOME_CREDENTIALS.map((p) => path.join(home, p)),
      ...(stateDir ? ['homes', 'brokers', 'ci-artifacts'].map((d) => path.join(stateDir, d)) : []),
      ...(ownerDir ? [ownerDir] : []), ...envFiles,
    ].map(canonical),
  };
}

// The repository's main checkout for <project>. A command the state broker
// runs finds no repository, so the checkout holding the state stands in.
function projectRoot(ctx) {
  const repo = require('./state').findRepo(ctx.stateDir, ctx.cwd || process.cwd());
  return repo?.root || (path.basename(ctx.stateDir) === '.tower-crane' ? path.dirname(ctx.stateDir) : null);
}

// roots for a CLI command; find project with projectRoot before taking the
// state lock, since it runs git.
function rootsFor(ctx, settings, project) {
  return roots({ home: require('./agents').origin(ctx.env).home, project, stateDir: ctx.stateDir, env: ctx.env, settings });
}

// A policy path as a regular expression over canonical paths: * is any part
// of a name, ? one character, a whole ** segment any depth, none included.
// The literal directories before the first glob are resolved as an item is,
// so a link on the way does not move the match.
function patternRegExp(value, r) {
  const found = expandPattern(value, r);
  if (!found) return null;
  const expanded = slash(found);
  const first = expanded.search(/[*?]/);
  const cut = first < 0 ? expanded.length : expanded.lastIndexOf('/', first);
  const prefix = slash(require('./authority').canonicalPath(expanded.slice(0, cut) || '/'));
  const rest = expanded.slice(cut);
  let re = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '*' && rest[i + 1] === '*' && rest[i - 1] === '/' && (i + 2 === rest.length || rest[i + 2] === '/')) {
      re = `${re.slice(0, -1)}(?:/.*)?`;
      i++;
    } else if (c === '*' && rest[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escape(c);
  }
  // rest starts with a slash whenever there is one, so the root adds none.
  return new RegExp(`^${prefix === '/' && rest ? '' : escape(prefix)}${re}$`);
}

// Whether p is a socket or a directory holding one at any depth, a link to a
// socket included. A mount of the directory lets the agent connect to it, and
// a read-only mount does not stop connect(). A directory the walk cannot read
// may hold one, so it counts. Linked directories are not entered: what they
// hold is judged where it lies.
function holdsSocket(p) {
  let st;
  try { st = fs.statSync(p); } catch { return false; }
  if (st.isSocket()) return true;
  if (!st.isDirectory()) return false;
  const dirs = [p];
  while (dirs.length) {
    const dir = dirs.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSocket()) return true;
      if (e.isDirectory()) dirs.push(full);
      else if (e.isSymbolicLink()) {
        try { if (fs.statSync(full).isSocket()) return true; } catch { /* dangling */ }
      }
    }
  }
  return false;
}

// The owner-only class an item falls in, or null.
function ownerOnly(item, r) {
  if (item.field === 'domains') return 'network';
  if (item.field === 'session_bus') return 'session_bus';
  const p = canonical(expandItem(item.value, r));
  const touches = (dirs) => dirs.some((d) => within(p, d) || within(d, p));
  if (touches(r.bus)) return 'session_bus';
  if (touches(r.sockets)) return 'sockets';
  if (touches(r.credentials)) return 'credentials';
  // After the cheap checks, so a grant of ~ is refused without a walk of it.
  if (holdsSocket(p)) return 'sockets';
  return null;
}

function covered(policy, item, r) {
  if (!FIELDS.includes(item.field)) return false;
  const p = slash(canonical(expandItem(item.value, r)));
  const lists = item.field === 'read' ? ['read', 'write'] : ['write'];
  return lists.some((k) => (policy.orchestrator_may_grant[k] || []).some((g) => patternRegExp(g, r)?.test(p)));
}

// Why the orchestrator may not grant an item on its own, or null.
function refusal(policy, item, r) {
  const cls = ownerOnly(item, r);
  if (cls) return `${cls} stays owner-only`;
  if (!policy) return 'no sandbox policy is set';
  return covered(policy, item, r) ? null : 'outside the sandbox policy';
}

// Every item with why it falls outside, and ok when none does.
function judge(policy, items, r) {
  const outside = items.map((item) => ({ ...item, why: refusal(policy, item, r) })).filter((i) => i.why);
  return { ok: !outside.length, outside };
}

function outsideText(outside) {
  return outside.map((i) => `${describe([i])} (${i.why})`).join('; ');
}

// A grant record the policy backs counts while its item still lies inside the
// current policy; one the owner made or approved counts until it is removed.
function live(policy, record, r) {
  return record.policy_version == null || (!!policy && !refusal(policy, record, r));
}

// What one dispatch gets: the rung with grants the policy no longer backs
// taken out, the task's sandbox from its live grants, and what was revoked.
function dispatch(project, rungName, rung, task, r) {
  const policy = project.sandbox_policy || null;
  const present = new Set(itemsOf(rung?.sandbox).map(key));
  const rungRevoked = (project.sandbox_grants || []).filter((g) => g.rung === rungName && present.has(key(g)) && !live(policy, g, r));
  const grants = task?.sandbox_grants || [];
  const taskRevoked = grants.filter((g) => !live(policy, g, r));
  return {
    rung: rungRevoked.length ? { ...rung, sandbox: without(rung.sandbox, rungRevoked) } : rung,
    task: sandboxOf(grants.filter((g) => live(policy, g, r))),
    revoked: [...rungRevoked.map((g) => ({ ...g, scope: `ladder ${rungName}` })), ...taskRevoked.map((g) => ({ ...g, scope: task.id }))],
  };
}

function revokedNotice(revoked) {
  return `sandbox grants the policy no longer backs were left out: ${revoked.map((g) => `${g.scope} ${describe([g])}`).join(', ')}`;
}

// The task's grants, each with whether it is active now.
function widenings(project, task, r) {
  return (task.sandbox_grants || []).map((g) => ({ ...g, active: live(project.sandbox_policy || null, g, r) }));
}

function widenText(g) {
  const basis = g.policy_version != null ? ` under sandbox policy v${g.policy_version}` : g.approved_by ? ` approved in ${g.approved_by}` : '';
  return `${describe([g])} by ${g.by}${basis}${g.active === false ? ' (revoked: no longer inside the policy)' : ''}`;
}

// Evidence for a change to a task's sandbox grants, beside its event.
function evidence(t, agent, summary, sandbox) {
  t.evidence.push({ type: 'sandbox', ok: true, sha: t.sha, agent, at: nowIso(), summary, ref: null, revision: t.revision, sandbox });
}

// Writes a task's grants to match sandbox. An owner's write records every
// item as the owner's; another keeps each surviving record and records new
// items as its own. Returns the items added and removed.
function grantTask(t, sandbox, grant) {
  const before = t.sandbox_grants || [];
  const want = itemsOf(sandbox);
  const keep = grant.role === 'owner' ? [] : before.filter((g) => want.some((i) => key(i) === key(g)));
  const fresh = want.filter((i) => !keep.some((g) => key(g) === key(i))).map((i) => ({
    field: i.field, value: i.value, by: grant.by, role: grant.role, policy_version: grant.policy_version ?? null,
    ...(grant.approved_by ? { approved_by: grant.approved_by } : {}), at: grant.at,
  }));
  const next = [...keep, ...fresh];
  if (next.length) t.sandbox_grants = next;
  else delete t.sandbox_grants;
  return {
    added: fresh.filter((g) => !before.some((b) => key(b) === key(g))),
    removed: before.filter((b) => !want.some((i) => key(i) === key(b))),
  };
}

// The rung grant records after a ladder write: records for items a rung no
// longer has go, an owner's write of a rung's sandbox makes all of it the
// owner's, and items the orchestrator added under the policy are recorded.
function rungRecords(records, ladder, writes) {
  const out = (records || []).filter((g) => {
    const w = writes.find((x) => x.rung === g.rung);
    if (w?.role === 'owner') return false;
    return itemsOf(ladder?.[g.rung]?.sandbox).some((i) => key(i) === key(g));
  });
  for (const w of writes) {
    if (w.role === 'owner') continue;
    for (const i of w.items) out.push({ rung: w.rung, field: i.field, value: i.value, by: w.by, policy_version: w.policy_version, at: w.at });
  }
  return out;
}

// After the policy changed: grants it backed that it no longer covers are
// removed from tasks and rungs, with an event each and evidence on the task.
function revokeOutside(st, emit, agent, r) {
  const policy = st.project.sandbox_policy || null;
  const version = policy?.version ?? null;
  for (const t of st.tasks.tasks) {
    const gone = (t.sandbox_grants || []).filter((g) => !live(policy, g, r));
    if (!gone.length) continue;
    t.sandbox_grants = t.sandbox_grants.filter((g) => !gone.includes(g));
    if (!t.sandbox_grants.length) delete t.sandbox_grants;
    const items = gone.map(({ field, value, policy_version }) => ({ field, value, policy_version }));
    evidence(t, agent, `sandbox revoked: ${describe(gone)}, no longer inside the sandbox policy`, { revoked: items, policy_version: version });
    emit(t.id, { revoked: items, policy_version: version }, 'sandbox revoke');
  }
  const records = st.project.sandbox_grants || [];
  const gone = records.filter((g) => !live(policy, g, r));
  if (!gone.length) return;
  for (const g of gone) {
    const rung = st.project.ladder?.[g.rung];
    if (object(rung?.sandbox)) {
      rung.sandbox = without(rung.sandbox, [g]);
      if (!Object.keys(rung.sandbox).length) delete rung.sandbox;
    }
    emit(null, { rung: g.rung, revoked: [{ field: g.field, value: g.value, policy_version: g.policy_version }], policy_version: version }, 'sandbox revoke');
  }
  st.project.sandbox_grants = records.filter((g) => !gone.includes(g));
  if (!st.project.sandbox_grants.length) delete st.project.sandbox_grants;
}

// What is wrong with stored grant records; rung records also name their rung.
function recordErrors(records, rung) {
  const ok = Array.isArray(records) && records.every((g) => object(g)
    && ['read', 'write', 'domains', 'session_bus'].includes(g.field)
    && (g.field === 'session_bus' ? g.value === true : typeof g.value === 'string' && g.value !== '')
    && typeof g.by === 'string' && (g.policy_version == null || Number.isSafeInteger(g.policy_version))
    && (!rung || typeof g.rung === 'string'));
  return ok ? [] : [`sandbox_grants must be an array of { ${rung ? 'rung, ' : ''}field, value, by, policy_version, at } records`];
}

module.exports = {
  OWNER_ONLY, FIELDS, MESSAGE, errors, parse, widens, versioned, itemsOf, added, sandboxOf, describe, roots, projectRoot, rootsFor, expandItem,
  patternRegExp, ownerOnly, covered, refusal, judge, outsideText, live, dispatch, revokedNotice, widenings, widenText,
  evidence, grantTask, rungRecords, revokeOutside, recordErrors,
};
