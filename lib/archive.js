'use strict';

// Task scratch outlives its task. Accept and cancel copy it into archive/<task>/ in the state
// directory before retirement removes it, so the evidence a later task needs (probe output, CI
// logs, receipts) is still there. ginza T5's RSS probe output lived only in its scratch, and T20's
// decision needed it after acceptance had removed it. Text gets the gate logs' cleanup and
// redaction; a binary file gets exact byte redaction or stays out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isUtf8 } = require('node:buffer');
const S = require('./state');
const { refuse, usage, nowIso, idNum } = require('./util');

const DIR = 'archive';
const MANIFEST = 'manifest.json';
const DEFAULT_RETENTION_DAYS = 30;
// Local CI's artifact caps (lib/gates/local-ci.js): 8 MiB holds ginza's largest measured receipt,
// 64 MiB ten of them. A file over the per-file cap keeps its head and a truncation notice; files
// past the total are listed in the manifest, not copied. Cited files pass both.
const FILE_BYTES = 8 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
// Text redaction scans at most 32 Mi characters (lib/text-redaction-budget.js), so a cited file
// over 32 MiB cannot be redacted whole, and accept refuses it.
const HARD_BYTES = 32 * 1024 * 1024;
// Omitted files are listed for diagnosis; a tree of thousands needs only a count.
const LISTED = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
// A save in progress builds in a dot directory; one left by a crashed save is removed after this.
const STALE_BUILD_MS = DAY_MS;
const UNSCANNABLE = '[unscannable text:';

function errors(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['archive must be an object'];
  const errs = Object.keys(value).filter((k) => k !== 'retention_days').map((k) => `archive: unknown field ${k}`);
  const days = value.retention_days;
  if (days !== undefined && (typeof days !== 'number' || !Number.isFinite(days) || days <= 0)) {
    errs.push('archive.retention_days must be a positive number of days');
  }
  return errs;
}

const retentionDays = (project) => project.archive?.retention_days ?? DEFAULT_RETENTION_DAYS;
const archiveDir = (stateDir, id) => path.join(stateDir, DIR, id);
const posix = (rel) => rel.split(path.sep).join('/');

// The tool caches spawn points into the scratch (lib/agents.js CACHE_ENV) hold downloads, not evidence.
function toolCaches() {
  return Object.values(require('./agents').CACHE_ENV).filter(Boolean);
}

// A relative path inside the scratch, or null for one that leaves it.
function relative(text) {
  const rel = path.posix.normalize(text.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!rel || rel === '.' || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) return null;
  return rel;
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A glob, a shell variable, an ellipsis segment or a <placeholder> names no one path; its literal
// prefix would cite a path nobody wrote, and accept would refuse on it.
const PATTERN = /[*?$]|(?:^|\/)(?:\.\.\.|…)(?:\/|$)/;
const PATTERN_NEXT = /^(?:[[{]|<[^/])/;
// path:12, path:12:5, path:12-40 and path#L12-L40 point at a line of the file, not another file.
const LOCATION = /(?::\d+(?:[:-]\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
const count = (s, c) => s.split(c).length - 1;

// The path a matched token names: trailing punctuation, the emphasis run that opened it, a line
// location and a closing parenthesis the path did not open come off. Parentheses inside a name
// (report(1).txt) are kept; an unclosed one starts prose (a.log(see above)), which is cut.
function trimToken(token, emphasis) {
  const opens = [];
  for (const [i, c] of [...token].entries()) {
    if (c === '(') opens.push(i);
    else if (c === ')') opens.pop();
  }
  if (opens.length) token = [...token].slice(0, opens[0]).join('');
  for (let prev = null; prev !== token;) {
    prev = token;
    token = token.replace(/[.:!?]+$/, '');
    if (emphasis && token.endsWith(emphasis)) { token = token.slice(0, -emphasis.length); emphasis = ''; }
    if (token.endsWith(')') && count(token, ')') > count(token, '(')) token = token.slice(0, -1);
    token = token.replace(LOCATION, '');
  }
  return token;
}

// The scratch paths a text names, each with where it was cited. Emphasis around a path
// (**path**) is stripped by its opening run, so a glob's own trailing * still marks a pattern.
function citedIn(found, texts, roots, where) {
  const re = new RegExp(`(\\**)(?:${roots.map(escapeRe).join('|')})[\\\\/]([^\\s'"\`<>|{}\\[\\],;]+)(?=(.{0,2}))`, 'gs');
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const token = trimToken(m[2], m[1]);
      if (PATTERN.test(token) || PATTERN_NEXT.test(m[3])) continue;
      const rel = relative(token);
      if (rel) found.set(rel, [...new Set([...(found.get(rel) || []), where])]);
    }
  }
}

// The task's workers: its claim holders and the workers spawn started for it (as lib/runaway.js counts them).
function workersOf(st, task) {
  const out = new Set(task.claim?.agent ? [task.claim.agent] : []);
  for (const e of st.events || []) {
    if (e.task !== task.id) continue;
    if (e.cmd === 'claim') out.add(e.detail?.holder || e.agent);
    else if (e.cmd === 'spawn' && e.detail?.role === 'worker') out.add(e.detail.agent);
  }
  return out;
}

// Every scratch path the task's PR body, notes, evidence and decisions cite, mapped to where:
// the scratch path itself and its ~ form anywhere, and $XDG_CACHE_HOME only where it means the
// scratch: the PR body and what the task's workers wrote. A reviewer's or the orchestrator's
// $XDG_CACHE_HOME is its own cache (lib/agents.js writableCache).
function citationSources(st, task, body = '') {
  const found = new Map();
  if (!task.scratch) return found;
  const roots = [task.scratch];
  const home = os.homedir();
  if (home && task.scratch.startsWith(home + path.sep)) roots.push(`~${task.scratch.slice(home.length)}`);
  const xdg = [...roots, '$XDG_CACHE_HOME', '${XDG_CACHE_HOME}'];
  const workers = workersOf(st, task);
  citedIn(found, [body || ''], xdg, 'the PR body');
  for (const n of task.notes) citedIn(found, [n.text], workers.has(n.agent) ? xdg : roots, 'a note');
  for (const e of task.evidence || []) citedIn(found, strings(e), workers.has(e.agent) ? xdg : roots, 'evidence');
  citedIn(found, strings(st.decisions?.decisions || []), roots, 'a decision');
  return found;
}

const citations = (st, task, body) => [...citationSources(st, task, body).keys()].sort();

function prArgs(st, task) {
  return ['pr', 'view', String(task.pr), '-R', st.project.repo, '--json', 'body'];
}

function parseBody(task, r) {
  let pr;
  try { pr = JSON.parse(r.stdout); } catch { throw refuse(`${task.id}: cannot read the PR body to find the scratch paths it cites`); }
  if (!pr || typeof pr !== 'object') throw refuse(`${task.id}: cannot read the PR body to find the scratch paths it cites`);
  // gh answers --json body with a string, empty for an empty body; an answer without one cites nothing.
  return typeof pr.body === 'string' ? pr.body : '';
}

const needsBody = (st, task) => !!(task.scratch && task.pr && st.project.repo);

// The PR body, read only when the task has scratch it could cite.
async function prBody(ctx, st, task) {
  if (!needsBody(st, task)) return '';
  const C = require('./gates/common');
  const r = await C.gh({ root: S.findRepo(ctx.stateDir, ctx.cwd)?.root, signal: ctx.gateSignal }, prArgs(st, task));
  if (!r.ok) throw refuse(C.ghFailure(r, `read PR body for ${task.id}'s cited scratch paths`));
  return parseBody(task, r);
}

// Retirement runs synchronously; a cancelled task's PR body is read there. A failed read leaves
// it out, since cancellation must not wait on GitHub.
function prBodySync(ctx, st, task) {
  if (!needsBody(st, task)) return { body: '' };
  const r = require('./stack').run(S.findRepo(ctx.stateDir, ctx.cwd)?.root || ctx.stateDir, prArgs(st, task));
  if (r.status !== 0) return { body: '', error: `gh pr view ${task.pr} failed` };
  try { return { body: parseBody(task, { stdout: r.stdout }) }; } catch (e) { return { body: '', error: e.message }; }
}

// The scratch's files, without following links: a link a worker left cannot pull in host files.
// skip(rel) leaves a directory unread.
function walk(root, skip = () => false) {
  const out = [];
  const visit = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      out.push({ rel, kind: 'unreadable', reason: e.code || e.message });
      return;
    }
    for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!skip(r)) visit(path.join(dir, d.name), r); }
      else out.push({ rel: r, abs: path.join(dir, d.name), kind: d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other' });
    }
  };
  visit(root, '');
  return out;
}

// At most room bytes from one descriptor opened without following a final link, with the size it
// had; the real path must stay inside the scratch, so a directory swapped for a link cannot pass.
function readHead(file, root, room) {
  const real = fs.realpathSync.native(file);
  const rel = path.relative(fs.realpathSync.native(root), real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'outside the scratch' };
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { error: 'not a regular file' };
    const data = Buffer.alloc(Math.min(stat.size, room));
    let total = 0;
    while (total < data.length) {
      const n = fs.readSync(fd, data, total, data.length - total, null);
      if (n === 0) break;
      total += n;
    }
    return { data: data.subarray(0, total), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

// The text or bytes to store, redacted as gate logs are, or why the file cannot be stored.
function clean(data, redact) {
  const { stripFor } = require('./gates/common');
  if (data.includes(0) || !isUtf8(data)) {
    const out = redact.bytes(data);
    if (out.missed) return { error: `binary, and ${out.missed} that exact byte redaction cannot remove` };
    return { body: Buffer.from(out.body), binary: true, redacted: !Buffer.from(out.body).equals(data) };
  }
  const text = data.toString('utf8');
  const raw = stripFor(redact, text);
  const body = redact(raw);
  if (body.startsWith(UNSCANNABLE) && !text.startsWith(UNSCANNABLE) || raw.startsWith(UNSCANNABLE) && !text.startsWith(UNSCANNABLE)) {
    return { error: body.startsWith(UNSCANNABLE) ? body : raw };
  }
  return { body: Buffer.from(body), redacted: body !== text };
}

// The head of a stored body within the per-file cap, cut on a character boundary, with a notice.
function truncate(body, binary, size) {
  const notice = Buffer.from(`\n[archive: truncated at ${FILE_BYTES / 1048576} MiB of ${size} bytes]\n`);
  let end = FILE_BYTES - notice.length;
  if (!binary) while (end > 0 && (body[end] & 0xc0) === 0x80) end -= 1;
  return Buffer.concat([body.subarray(0, end), notice]);
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && typeof m === 'object' && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

function safeRel(rel) {
  return typeof rel === 'string' && relative(rel) === rel;
}

// Removes archives older than archive.retention_days, and builds a crashed save left behind.
function sweep(stateDir, project) {
  const root = path.join(stateDir, DIR);
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const now = Date.now();
  const limit = retentionDays(project) * DAY_MS;
  const removed = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (name.startsWith('.')) {
      try { if (now - fs.lstatSync(dir).mtimeMs > STALE_BUILD_MS) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      continue;
    }
    const at = Date.parse(readManifest(dir)?.archived_at);
    if (Number.isFinite(at) && now - at > limit) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

// The files to archive and the cited paths that cannot be: cited first, whole, then the rest.
function plan(scratch, cited, old) {
  const emptyDir = (rel) => { try { return fs.lstatSync(path.join(scratch, ...rel.split('/'))).isDirectory(); } catch { return false; } };
  const caches = toolCaches();
  const excluded = (rel) => caches.includes(rel.split('/')[0]);
  const entries = scratch ? walk(scratch, (rel) => excluded(rel) && !cited.some((c) => c === rel || c.startsWith(`${rel}/`) || rel.startsWith(`${c}/`))) : [];
  const byRel = new Map(entries.map((e) => [e.rel, e]));
  const oldFiles = new Map((old?.files || []).filter((f) => safeRel(f.path)).map((f) => [f.path, f]));
  const problems = [];
  const citedFiles = new Set();
  const under = (rel, list) => list.filter((r) => r.startsWith(`${rel}/`));
  for (const rel of cited) {
    const hit = byRel.get(rel);
    if (hit && hit.kind === 'file') { citedFiles.add(rel); continue; }
    if (hit) { problems.push({ path: rel, reason: hit.kind === 'unreadable' ? `unreadable: ${hit.reason}` : 'not a regular file' }); continue; }
    const files = under(rel, entries.filter((e) => e.kind === 'file').map((e) => e.rel));
    const kept = under(rel, [...oldFiles.keys()]).filter((r) => !byRel.has(r));
    if (files.length || kept.length) for (const r of [...files, ...kept]) citedFiles.add(r);
    else if (oldFiles.has(rel)) citedFiles.add(rel);
    else problems.push({ path: rel, reason: scratch && emptyDir(rel) ? 'an empty directory' : 'missing' });
  }
  const rest = entries.filter((e) => !citedFiles.has(e.rel));
  // Files an earlier save stored that the scratch no longer holds stay in the archive.
  const carried = [...oldFiles.keys()].filter((r) => !byRel.has(r) && !citedFiles.has(r)).sort();
  return { byRel, oldFiles, problems, cited: [...citedFiles].sort(), rest, carried, excluded };
}

// Notes, evidence, decisions and an earlier archive's list only grow; the PR body is the one
// citation a worker can take back. Any other stale citation is the orchestrator's to drop.
function refuseProblems(task, problems, sources) {
  const where = (rel) => sources.get(rel) || ['an earlier archive'];
  const bodyOnly = problems.some((p) => where(p.path).every((w) => w === 'the PR body'));
  const err = refuse(`${task.id}: cited scratch paths cannot be archived: ${problems.map((p) => `${p.path} (${p.reason}; cited in ${where(p.path).join(', ')})`).join('; ')}; `
    + `restore each in the task scratch${bodyOnly ? ', or drop the citation from the PR body where only the PR body cites it' : ''}, then retry; `
    + `the orchestrator drops a stale citation with tower-crane accept ${task.id} --drop-citation PATH --reason R`);
  err.archive = problems.map((p) => ({ path: p.path, reason: p.reason, cited_in: where(p.path) }));
  throw err;
}

// The citations accept --drop-citation removed: this accept's, and those the task's audited accept
// events recorded, so a later save does not cite them again. A drop a manifest lists without such
// an event came from an accept that never landed, and its path is cited again.
function droppedList(st, task, drop) {
  const out = new Map();
  for (const e of st.events || []) {
    if (e.cmd !== 'accept' || e.task !== task.id || !Array.isArray(e.detail?.dropped_citations)) continue;
    for (const p of e.detail.dropped_citations) if (safeRel(p)) out.set(p, { path: p, reason: e.detail.reason, by: e.agent, at: e.at });
  }
  for (const d of drop) out.set(d.path, d);
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Writes archive/<task>/ from the task's scratch and returns its summary for tasks.json, or null
// when there is nothing to archive. strict (accept) refuses, writing nothing, when a cited path is
// missing or cannot be stored whole; otherwise the manifest lists it under missing_cited.
function save(ctx, st, task, { body = '', reason, strict = false, drop = [] } = {}) {
  const stateDir = ctx.stateDir;
  sweep(stateDir, st.project);
  const dest = archiveDir(stateDir, task.id);
  const old = readManifest(dest);
  const scratch = task.scratch && fs.existsSync(task.scratch) && fs.lstatSync(task.scratch).isDirectory() ? task.scratch : null;
  const sources = citationSources(st, task, body);
  const all = [...new Set([...sources.keys(), ...(old?.cited || []).filter(safeRel)])].sort();
  const unknown = drop.filter((d) => !all.includes(d.path)).map((d) => d.path);
  if (unknown.length) throw refuse(`${task.id}: --drop-citation names no cited path: ${unknown.join(', ')}${all.length ? `; cited: ${all.join(', ')}` : '; nothing is cited'}`);
  const dropped = droppedList(st, task, drop);
  const cited = all.filter((c) => !dropped.some((d) => d.path === c));
  for (const d of dropped) sources.delete(d.path);
  if (!scratch && !old) {
    if (strict && cited.length) refuseProblems(task, cited.map((p) => ({ path: p, reason: 'missing' })), sources);
    return null;
  }
  const p = plan(scratch, cited, old);
  if (!scratch && !p.problems.length && !drop.length && cited.every((c) => old.cited?.includes(c))) return summary(old);

  const root = path.join(stateDir, DIR);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const build = fs.mkdtempSync(path.join(root, `.${task.id}-`));
  try {
    fs.chmodSync(build, 0o700);
    const redact = require('./gates/tests').diagnosticRedactor(st.project, S.findRepo(stateDir, ctx.cwd)?.root || stateDir);
    const files = [];
    const omitted = [];
    let omittedMore = 0;
    let total = 0;
    const omit = (rel, size, why) => {
      if (omitted.length < LISTED) omitted.push({ path: rel, size, reason: why });
      else omittedMore += 1;
    };
    const store = (rel, out, entry) => {
      const target = path.join(build, 'files', ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, out, { mode: 0o600, flag: 'wx' });
      total += out.length;
      files.push({ path: rel, size: entry.size, stored: out.length, sha256: crypto.createHash('sha256').update(out).digest('hex'),
        ...(entry.cited ? { cited: true } : {}), ...(entry.binary ? { binary: true } : {}), ...(entry.redacted ? { redacted: true } : {}),
        ...(entry.truncated ? { truncated: true } : {}), ...(entry.carried ? { carried: true } : {}) });
    };
    // An earlier save's stored copy, checked against its manifest entry.
    const carry = (rel, isCited) => {
      const prior = p.oldFiles.get(rel);
      let out;
      try { out = fs.readFileSync(path.join(dest, 'files', ...rel.split('/'))); } catch (e) { return { error: `earlier copy unreadable: ${e.code}` }; }
      if (crypto.createHash('sha256').update(out).digest('hex') !== prior.sha256) return { error: 'earlier copy failed its content check' };
      if (!isCited && total + out.length > TOTAL_BYTES) return { omitted: true, size: prior.size };
      store(rel, out, { ...prior, cited: isCited || prior.cited, carried: true });
      return {};
    };
    const problems = [...p.problems];
    for (const rel of p.cited) {
      const entry = p.byRel.get(rel);
      if (!entry) {
        const r = carry(rel, true);
        if (r.error) problems.push({ path: rel, reason: r.error });
        continue;
      }
      let read;
      try { read = readHead(entry.abs, scratch, HARD_BYTES + 1); } catch (e) { problems.push({ path: rel, reason: e.code === 'ELOOP' ? 'a symbolic link' : e.code || e.message }); continue; }
      if (read.error) { problems.push({ path: rel, reason: read.error }); continue; }
      if (read.size > HARD_BYTES) { problems.push({ path: rel, reason: `${read.size} bytes, over the ${HARD_BYTES / 1048576} MiB hard cap` }); continue; }
      const out = clean(read.data, redact);
      if (out.error) { problems.push({ path: rel, reason: out.error }); continue; }
      store(rel, out.body, { size: read.size, cited: true, binary: out.binary, redacted: out.redacted });
    }
    if (strict && problems.length) refuseProblems(task, problems, sources);
    for (const entry of p.rest) {
      const rel = entry.rel;
      if (p.excluded(rel)) continue;
      if (entry.kind !== 'file') { omit(rel, null, entry.kind === 'unreadable' ? `unreadable: ${entry.reason}` : entry.kind === 'link' ? 'a symbolic link' : 'not a regular file'); continue; }
      if (total >= TOTAL_BYTES) { omit(rel, null, `past the ${TOTAL_BYTES / 1048576} MiB total`); continue; }
      let read;
      // Redaction reads up to the hard cap before the cut, so a secret across the cut leaves no fragment.
      try { read = readHead(entry.abs, scratch, HARD_BYTES); } catch (e) { omit(rel, null, e.code === 'ELOOP' ? 'a symbolic link' : e.code || e.message); continue; }
      if (read.error) { omit(rel, read.size ?? null, read.error); continue; }
      const out = clean(read.data, redact);
      if (out.error) { omit(rel, read.size, out.error); continue; }
      const cut = out.body.length > FILE_BYTES || read.size > read.data.length;
      const stored = cut ? truncate(out.body, out.binary, read.size) : out.body;
      if (total + stored.length > TOTAL_BYTES) { omit(rel, read.size, `past the ${TOTAL_BYTES / 1048576} MiB total`); continue; }
      store(rel, stored, { size: read.size, binary: out.binary, redacted: out.redacted, truncated: cut });
    }
    for (const rel of p.carried) {
      if (p.excluded(rel)) continue;
      const r = carry(rel, false);
      if (r.omitted) omit(rel, r.size, `past the ${TOTAL_BYTES / 1048576} MiB total`);
      else if (r.error) omit(rel, p.oldFiles.get(rel).size, r.error);
    }
    const truncated = files.filter((f) => f.truncated).length;
    const left = omitted.length + omittedMore;
    const manifest = {
      version: 1, task: task.id, reason, sha: task.sha || null, revision: task.revision, archived_at: nowIso(),
      scratch: task.scratch, caps: { file_bytes: FILE_BYTES, total_bytes: TOTAL_BYTES, hard_bytes: HARD_BYTES },
      cited, ...(dropped.length ? { dropped } : {}), files, omitted, ...(omittedMore ? { omitted_more: omittedMore } : {}),
      ...(problems.length ? { missing_cited: problems } : {}),
      bytes: total,
      notice: truncated || left
        ? `archive truncated: ${[truncated ? `${truncated} file${truncated === 1 ? '' : 's'} cut at ${FILE_BYTES / 1048576} MiB` : null,
          left ? `${left} file${left === 1 ? '' : 's'} left out` : null].filter(Boolean).join(', ')}; cited files are kept whole`
        : null,
    };
    fs.writeFileSync(path.join(build, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    // The earlier archive moves aside before the new one takes its name, so a reader sees one whole archive.
    const aside = fs.existsSync(dest) ? `${build}-old` : null;
    if (aside) fs.renameSync(dest, aside);
    fs.renameSync(build, dest);
    if (aside) fs.rmSync(aside, { recursive: true, force: true });
    return summary(manifest);
  } catch (e) {
    fs.rmSync(build, { recursive: true, force: true });
    throw e;
  }
}

function summary(m) {
  return { path: `${DIR}/${m.task}`, at: m.archived_at, reason: m.reason, files: m.files.length, bytes: m.bytes ?? m.files.reduce((n, f) => n + f.stored, 0),
    cited: m.cited?.length || 0, ...(m.notice ? { notice: m.notice } : {}), ...(m.missing_cited?.length ? { missing_cited: m.missing_cited.map((x) => x.path) } : {}) };
}

// The archive written on acceptance; refuses when a cited path cannot be kept whole. drop is
// the citations accept --drop-citation removes, each { path, reason, by, at }.
async function onAccept(ctx, st, task, drop = []) {
  const body = await prBody(ctx, st, task);
  return save(ctx, st, task, { body, reason: 'accept', strict: true, drop });
}

// A refused accept stays submitted with nobody told when automation ran it, so the refusal is an
// event the inbox reads (archive_refused). A repeat at the same head and paths records nothing.
function recordRefusal(ctx, task, paths) {
  const { isDeepStrictEqual } = require('node:util');
  S.mutate(ctx, 'archive refused', (st, emit) => {
    const t = require('./tasks').getTask(st, task.id);
    if (t.status !== 'submitted' || t.sha !== task.sha || t.revision !== task.revision) return;
    const last = st.events.findLast((e) => e.cmd === 'archive refused' && e.task === t.id);
    if (last && last.detail.sha === t.sha && last.detail.revision === t.revision && isDeepStrictEqual(last.detail.paths, paths)) return;
    emit(t.id, { sha: t.sha, revision: t.revision, automatic: !!ctx.automatic, paths });
  });
}

// The current refusal for a submitted task, or null once its head or revision moved.
function refusal(st, task) {
  if (task.status !== 'submitted') return null;
  const e = st.events.findLast((x) => x.cmd === 'archive refused' && x.task === task.id);
  return e && e.detail.sha === task.sha && e.detail.revision === task.revision ? e : null;
}

// Before retirement removes the scratch: cancelled tasks get their archive here, accepted ones
// a refresh that keeps what accept stored.
function onRetire(ctx, st, task) {
  const read = task.status === 'cancelled' ? prBodySync(ctx, st, task) : { body: '' };
  if (read.error) process.stderr.write(`${task.id}: archiving scratch without its PR body's citations: ${read.error}\n`);
  return save(ctx, st, task, { body: read.body, reason: task.status === 'cancelled' ? 'cancel' : 'accept' });
}

// Copies are written flat into the receiving scratch's root. The worker may write that root but not
// its parent (see lib/ci-feedback.js writeLog), so only the file name is its to change; a link left
// at the name is removed, and wx refuses whatever else appears there.
function copyName(source, rel) {
  return `archive-${source}-${encodeURIComponent(rel)}`;
}

function receivingScratch(ctx, task) {
  if (task.scratch) return task.scratch;
  return require('./agents').taskCachePath({ ...ctx, task: task.id });
}

// task archive ID [--path P]... [--into T] [--grant T]
function command(ctx) {
  const T = require('./tasks');
  const Authority = require('./authority');
  const f = ctx.flags;
  const st = S.loadState(ctx.stateDir);
  const source = T.getTask(st, ctx.pos[0]);
  const who = Authority.role(ctx, st.events);
  sweep(ctx.stateDir, st.project);
  if (f.grant !== undefined && f.into !== undefined) throw usage('task archive takes --grant or --into, not both');
  if (f.grant !== undefined) {
    if (!who) throw refuse(`task archive --grant is operational: only the orchestrator or the owner grants a task's worker another task's archive; ask the orchestrator with tower-crane msg --to orchestrator`);
    const result = S.mutate(ctx, 'task archive grant', (st2, emit) => {
      const into = T.getTask(st2, f.grant);
      if (into.id === source.id) throw refuse(`${source.id} cannot be granted its own archive`);
      into.archive_grants = [...new Set([...(into.archive_grants || []), source.id])].sort((a, b) => idNum(a) - idNum(b));
      emit(into.id, { from: source.id });
      return into;
    });
    return { data: { task: result.id, archive_grants: result.archive_grants }, text: `${result.id}'s worker may copy from ${source.id}'s archive with tower-crane task archive ${source.id} --into ${result.id}` };
  }
  const dir = archiveDir(ctx.stateDir, source.id);
  const manifest = readManifest(dir);
  if (!manifest) {
    throw refuse(source.archive
      ? `${source.id}'s archive from ${source.archive.at} is gone; archives are kept ${retentionDays(st.project)} days (archive.retention_days)`
      : `${source.id} has no archive; accept and cancel archive a task's scratch`);
  }
  const wanted = [f.path ?? []].flat().map((p) => {
    const rel = relative(p);
    if (!rel) throw usage(`--path ${p} must be a relative path inside the archive`);
    return rel;
  });
  let files = manifest.files.filter((x) => safeRel(x.path));
  if (wanted.length) {
    const unmatched = wanted.filter((w) => !files.some((x) => x.path === w || x.path.startsWith(`${w}/`)));
    if (unmatched.length) throw refuse(`${source.id}'s archive holds no ${unmatched.join(', ')}; tower-crane task archive ${source.id} lists it`);
    files = files.filter((x) => wanted.some((w) => x.path === w || x.path.startsWith(`${w}/`)));
  }
  if (f.into === undefined) {
    const lines = [`${source.id} archive (${manifest.reason}, ${manifest.archived_at}): ${files.length} file${files.length === 1 ? '' : 's'}, ${files.reduce((n, x) => n + x.stored, 0)} bytes stored in ${path.join(dir, 'files')}`,
      ...files.map((x) => `  ${x.path}  ${x.size} bytes${x.stored !== x.size ? `, ${x.stored} stored` : ''}  sha256 ${x.sha256}${[x.cited && 'cited', x.truncated && 'truncated', x.redacted && 'redacted', x.binary && 'binary', x.carried && 'carried'].filter(Boolean).map((s) => ` [${s}]`).join('')}`),
      ...(wanted.length ? [] : manifest.omitted.map((x) => `  left out: ${x.path}: ${x.reason}`)),
      ...(manifest.omitted_more && !wanted.length ? [`  left out: ${manifest.omitted_more} more`] : []),
      ...(manifest.notice ? [manifest.notice] : []),
      ...(manifest.missing_cited?.length ? [`cited but not archived: ${manifest.missing_cited.map((x) => `${x.path} (${x.reason})`).join('; ')}`] : [])];
    return { data: { ...manifest, files, dir }, text: lines.join('\n') };
  }
  const into = T.getTask(st, f.into);
  if (into.id === source.id) throw refuse(`${source.id}'s archive is its own; copy it into another task`);
  if (!who && !(into.claim?.agent === ctx.agent && (into.archive_grants || []).includes(source.id))) {
    throw refuse(`${ctx.agent} may copy ${source.id}'s archive only into a task it holds whose archive grant names ${source.id}; the orchestrator grants it with tower-crane task archive ${source.id} --grant ${into.id}`);
  }
  if (!['todo', 'in_progress', 'rework', 'submitted'].includes(into.status)) throw refuse(`${into.id} is ${into.status}; copy into an open task`);
  const scratch = receivingScratch(ctx, into);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const x of files) {
    const data = fs.readFileSync(path.join(dir, 'files', ...x.path.split('/')));
    if (crypto.createHash('sha256').update(data).digest('hex') !== x.sha256) throw refuse(`${source.id}'s archived ${x.path} failed its content check; nothing more was copied`);
    const name = copyName(source.id, x.path);
    if (Buffer.byteLength(name) > 255) throw refuse(`${source.id}'s archived ${x.path} has a path too long to copy flat; copy a shorter --path`);
    const target = path.join(scratch, name);
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
    copied.push({ path: x.path, file: name, sha256: x.sha256, stored: x.stored });
  }
  const entry = S.mutate(ctx, 'task archive copy', (st2, emit) => {
    const t = T.getTask(st2, into.id);
    if (!who && !(t.claim?.agent === ctx.agent && (t.archive_grants || []).includes(source.id))) throw refuse(`${t.id}'s claim or archive grant changed while copying; retry`);
    if (!t.scratch) t.scratch = scratch;
    const e = { type: 'archive', ok: true, sha: t.sha || null, agent: ctx.agent, ...S.via(ctx), at: nowIso(), revision: t.revision,
      summary: `copied ${copied.length} file${copied.length === 1 ? '' : 's'} from ${source.id}'s archive into ${scratch}`,
      ref: `${DIR}/${source.id}`, from: source.id, files: copied };
    t.evidence.push(e);
    emit(t.id, { from: source.id, files: copied.length, scratch });
    return e;
  });
  return { data: { task: into.id, ...entry }, text: [`${into.id}: ${entry.summary}`, ...copied.map((c) => `  ${path.join(scratch, c.file)}  (${c.path})`)].join('\n') };
}

module.exports = { DIR, DEFAULT_RETENTION_DAYS, FILE_BYTES, TOTAL_BYTES, HARD_BYTES, errors, retentionDays, citations, relative, save, sweep, onAccept, recordRefusal, refusal, onRetire, command, copyName };
