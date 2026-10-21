'use strict';

// Broker verbs: fixed host actions a project declares for its sandboxed
// workers (docs/state.md#broker-verbs). A worker gets no raw socket to run
// something on the host; it asks its state broker to run a verb the owner
// approved, for a task the verb is granted to. What runs is pinned: the
// program and scripts come from the base branch commit recorded when the
// owner approved the verb, copied from hash-checked git objects into the state
// directory, which no sandbox writes, or from an owner path outside every
// directory an agent writes. The worker fills only typed parameters that match
// their patterns, so no edit to its worktree, and no value it passes, changes
// the program, its scripts, its mounts or its caps.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { refuse, usage, nowIso } = require('./util');

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const OUTPUT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /\{(source|out|param\.[^{}]*|mount\.[^{}]*)\}/g;
const FIELDS = ['argv', 'source', 'mounts', 'resources', 'timeout_sec', 'outputs', 'params', 'delegate'];
const TYPES = { string: null, integer: /^-?[0-9]+$/ };
const MAX_TIMEOUT_SEC = Math.floor((2 ** 31 - 1) / 1000);
// What a run returns of the verb's stdout and stderr, each.
const KEEP_CHARS = 1 << 20;
// Blobs read per git cat-file call while pinning a source.
const BATCH = 1000;
// The broker's own variables and the owner key stay out of the verb's environment.
const DROPPED_ENV = ['TOWER_CRANE_VIA', 'TOWER_CRANE_BROKER', 'TOWER_CRANE_HOOK', 'TOWER_CRANE_AGENT', 'TOWER_CRANE_STATE', 'TOWER_CRANE_TASK', 'TOWER_CRANE_OWNER_KEY'];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function pattern(source) {
  return new RegExp(`^(?:${source})$`, 'u');
}

function relPathError(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || p.endsWith('/')) return 'a relative path with / separators';
  if (p.split('/').some((s) => !s || s === '.' || s === '..' || s.toLowerCase() === '.git')) return 'a path without empty, ".", ".." or ".git" segments';
  return null;
}

// The shape of one verb. A stored commit source carries the digest of its
// pinned copy; project set adds it, so its input may leave it out.
function verbErrors(name, v, stored) {
  const at = `broker.verbs.${name}`;
  if (!NAME.test(name)) return [`${at}: a verb name is lowercase letters, digits and hyphens, starting with a letter`];
  if (!isObject(v)) return [`${at} must be an object`];
  const errs = Object.keys(v).filter((k) => !FIELDS.includes(k)).map((k) => `${at}.${k} is unknown`);
  const params = isObject(v.params) ? v.params : {};
  const mounts = isObject(v.mounts) ? v.mounts : {};
  if (!Array.isArray(v.argv) || !v.argv.length || !v.argv.every((a) => typeof a === 'string' && a && !a.includes('\0'))) {
    errs.push(`${at}.argv must be a non-empty array of non-empty strings`);
  } else {
    const used = new Set();
    v.argv.forEach((arg, i) => {
      for (const [, key] of arg.matchAll(PLACEHOLDER)) {
        const [kind, ref] = key.split(/\.(.*)/s);
        if (kind === 'param') {
          if (i === 0) errs.push(`${at}.argv[0] names the program, which takes no parameter`);
          if (!Object.hasOwn(params, ref)) errs.push(`${at}.argv uses {param.${ref}}, which params does not declare`);
          used.add(ref);
        }
        if (kind === 'mount' && !Object.hasOwn(mounts, ref)) errs.push(`${at}.argv uses {mount.${ref}}, which mounts does not declare`);
      }
    });
    for (const key of Object.keys(params)) if (!used.has(key)) errs.push(`${at}.params.${key} is declared but argv never uses it`);
  }
  const s = v.source;
  if (!isObject(s) || (s.commit === undefined) === (s.path === undefined)) {
    errs.push(`${at}.source must be {commit, paths?} on the base branch or {path} outside every directory an agent writes`);
  } else if (s.commit !== undefined) {
    if (!COMMIT.test(s.commit)) errs.push(`${at}.source.commit must be a full lowercase commit hash`);
    for (const k of Object.keys(s)) if (!['commit', 'paths', 'digest'].includes(k)) errs.push(`${at}.source.${k} is unknown`);
    if (s.paths !== undefined) {
      if (!Array.isArray(s.paths) || !s.paths.length || new Set(s.paths).size !== s.paths.length) errs.push(`${at}.source.paths must be a non-empty array of distinct paths`);
      else for (const p of s.paths) { const bad = relPathError(p); if (bad) errs.push(`${at}.source.paths entry ${JSON.stringify(p)} must be ${bad}`); }
    }
    if (stored ? !DIGEST.test(s.digest ?? '') : s.digest !== undefined) {
      errs.push(stored ? `${at}.source.digest must be the SHA-256 of the pinned copy that project set made` : `${at}.source.digest is written by project set, not given`);
    }
  } else {
    if (typeof s.path !== 'string' || !path.isAbsolute(s.path) || s.path.includes('\0')) errs.push(`${at}.source.path must be an absolute path`);
    for (const k of Object.keys(s)) if (k !== 'path') errs.push(`${at}.source.${k} is unknown`);
  }
  if (v.mounts !== undefined) {
    if (!isObject(v.mounts)) errs.push(`${at}.mounts must be an object of names to absolute paths`);
    else for (const [k, p] of Object.entries(v.mounts)) {
      if (!KEY.test(k)) errs.push(`${at}.mounts.${k}: a mount name is lowercase letters, digits and underscores`);
      if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) errs.push(`${at}.mounts.${k} must be an absolute path`);
    }
  }
  if (v.resources !== undefined) errs.push(...require('./containment').errors(v.resources).map((e) => `${at}.${e}`));
  if (!Number.isSafeInteger(v.timeout_sec) || v.timeout_sec < 1 || v.timeout_sec > MAX_TIMEOUT_SEC) {
    errs.push(`${at}.timeout_sec must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}`);
  }
  if (v.outputs !== undefined) {
    if (!Array.isArray(v.outputs) || new Set(v.outputs).size !== v.outputs.length || !v.outputs.every((o) => typeof o === 'string' && OUTPUT.test(o))) {
      errs.push(`${at}.outputs must be distinct file names of letters, digits, ".", "_" and "-"`);
    }
  }
  if (v.params !== undefined) {
    if (!isObject(v.params)) errs.push(`${at}.params must be an object of names to {type, pattern}`);
    else for (const [k, p] of Object.entries(v.params)) {
      if (!KEY.test(k)) errs.push(`${at}.params.${k}: a parameter name is lowercase letters, digits and underscores`);
      if (!isObject(p) || Object.keys(p).some((f) => !['type', 'pattern'].includes(f)) || !Object.hasOwn(TYPES, p.type) || typeof p.pattern !== 'string' || !p.pattern) {
        errs.push(`${at}.params.${k} must be {type: ${Object.keys(TYPES).join(' or ')}, pattern: a regular expression the whole value matches}`);
        continue;
      }
      try { pattern(p.pattern); } catch (e) { errs.push(`${at}.params.${k}.pattern is not a regular expression (${e.message})`); }
    }
  }
  if (v.delegate !== undefined && typeof v.delegate !== 'boolean') errs.push(`${at}.delegate must be a boolean`);
  return errs;
}

// project.json broker: { verbs: { NAME: verb } }.
function errors(broker, stored = true) {
  if (broker === undefined) return [];
  if (!isObject(broker) || Object.keys(broker).some((k) => k !== 'verbs') || !isObject(broker.verbs)) return ['broker must be {verbs: {NAME: verb}}'];
  return Object.entries(broker.verbs).flatMap(([name, v]) => verbErrors(name, v, stored));
}

// project set --broker-verbs: the whole verb map, or null to remove it.
function parse(text) {
  let verbs;
  try { verbs = JSON.parse(text); } catch { throw usage('--broker-verbs must be a JSON object of verb names to verbs, or null'); }
  if (verbs === null) return null;
  if (!isObject(verbs)) throw usage('--broker-verbs must be a JSON object of verb names to verbs, or null');
  const errs = errors({ verbs }, false);
  if (errs.length) throw usage(errs.join('; '));
  return verbs;
}

// The real path of p, or of its nearest existing ancestor joined with the
// rest, so a path not written yet compares like one that is.
function resolved(p) {
  const rest = [];
  for (let dir = path.resolve(p); ;) {
    try { return path.join(fs.realpathSync.native(dir), ...rest); } catch { /* walk up */ }
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(p);
    rest.unshift(path.basename(dir));
    dir = up;
  }
}

function within(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// The directories some agent writes, as far as this process can tell: the
// repository and its git directory, the task worktrees, the task scratch and
// agent caches, the state directory and the owner's extra sandbox writes.
function writableRoots(ctx, project, repo, tasks = []) {
  const A = require('./agents');
  const roots = [ctx.stateDir, path.join(A.cacheDir(ctx.env, A.origin(ctx.env).home), 'tower-crane')];
  if (repo) {
    roots.push(repo.root, repo.commonDir, path.join(path.dirname(repo.root), `${path.basename(repo.root).replace(/\.git$/, '')}-worktrees`));
  } else if (path.basename(ctx.stateDir) === '.tower-crane') roots.push(path.dirname(ctx.stateDir));
  for (const t of tasks) roots.push(...[t.worktree?.path, t.scratch].filter((p) => typeof p === 'string' && path.isAbsolute(p)));
  for (const p of project.sandbox?.write || []) if (typeof p === 'string' && path.isAbsolute(p)) roots.push(p);
  return [...new Set(roots.map(resolved))];
}

// The paths one argument can name: the pieces between "=", "," and the path
// list separator, as in --config=/x or a search path.
const PIECES = new RegExp(`[=,${path.delimiter}]`);

// A template piece's literal text before its first placeholder, cut back to
// the directory that text ends in: /repo/tools/{param.step}.sh reaches /repo/tools.
function literalDir(piece) {
  const at = piece.indexOf('{');
  if (at < 0) return piece;
  const head = piece.slice(0, at);
  return head.slice(0, Math.max(head.lastIndexOf('/'), head.lastIndexOf(path.sep)));
}

function refuseInside(name, field, p, roots, allowed = []) {
  const real = resolved(p);
  if (allowed.some((r) => within(real, r))) return;
  const root = roots.find((r) => within(real, r));
  if (root) throw refuse(`broker verb ${name}: ${field} ${p} is inside ${root}, which an agent writes; a verb runs only what no worker can change (docs/state.md#broker-verbs)`);
}

// A path source, a mount or a literal absolute path in an argument inside a
// directory an agent writes would let the worker change what the verb runs.
function checkReach(name, v, roots) {
  const named = [
    ...(v.source.path ? [['source.path', v.source.path]] : []),
    ...Object.entries(v.mounts || {}).map(([k, p]) => [`mounts.${k}`, p]),
    ...v.argv.flatMap((a) => a.split(PIECES).map(literalDir).filter((p) => path.isAbsolute(p)).map((p) => ['argv', p])),
  ];
  for (const [field, p] of named) refuseInside(name, field, p, roots);
}

// The filled argv, checked again: a parameter value, or one that walks out of
// {source} with "..", must not name a directory an agent writes either.
function checkFilled(name, argv, roots, allowed) {
  for (const a of argv) for (const p of a.split(PIECES).filter((x) => path.isAbsolute(x))) refuseInside(name, 'argv', p, roots, allowed);
}

// Reads objects through git and checks each against its own name, so an
// object a worker rewrote in the shared git directory is refused, not pinned.
function objects(root, oids) {
  const Commands = require('./commands');
  const want = [...new Set(oids)];
  const out = new Map();
  for (let i = 0; i < want.length; i += BATCH) {
    const part = want.slice(i, i + BATCH);
    const r = Commands.spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input: `${part.join('\n')}\n`, maxBuffer: Infinity, windowsHide: true });
    if (r.status !== 0) throw refuse(`git cat-file in ${root} failed: ${String(r.stderr || r.error?.message || '').trim()}`);
    let at = 0;
    for (const oid of part) {
      const nl = r.stdout.indexOf(10, at);
      const [got, type, size] = r.stdout.subarray(at, nl).toString('latin1').split(' ');
      if (got !== oid || type === 'missing' || !/^\d+$/.test(size || '')) throw refuse(`object ${oid} is not in ${root}`);
      const content = r.stdout.subarray(nl + 1, nl + 1 + Number(size));
      at = nl + 2 + Number(size);
      const hash = crypto.createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`${type} ${size}\0`).update(content).digest('hex');
      if (hash !== oid) throw refuse(`object ${oid} in ${root} does not hash to its name; its git objects were changed, so nothing is pinned from them`);
      out.set(oid, { type, content });
    }
  }
  return out;
}

function treeEntries(content, hexLength) {
  const list = [];
  for (let at = 0; at < content.length;) {
    const sp = content.indexOf(32, at);
    const nul = content.indexOf(0, sp);
    const end = nul + 1 + hexLength / 2;
    if (sp < 0 || nul < 0 || end > content.length) throw refuse('a tree object does not parse');
    list.push({ mode: content.subarray(at, sp).toString('latin1'), name: content.subarray(sp + 1, nul).toString('utf8'), oid: content.subarray(nul + 1, end).toString('hex') });
    at = end;
  }
  return list;
}

function sourcesDir(stateDir) {
  return path.join(stateDir, 'verbs', 'sources');
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// The pinned copy of a commit source: its manifest names every file with its
// SHA-256, and the digest is the manifest's own. Checked before every run.
function verifyPinned(stateDir, digest) {
  const dir = path.join(sourcesDir(stateDir), digest);
  let text;
  try { text = fs.readFileSync(path.join(dir, 'manifest.json')); } catch (e) {
    throw refuse(`the pinned source ${digest} is missing from ${sourcesDir(stateDir)} (${e.code || e.message}); the owner pins it again with project set --broker-verbs`);
  }
  if (sha256(text) !== digest) throw refuse(`the pinned source ${digest} has a manifest that does not match its digest; the owner pins it again with project set --broker-verbs`);
  const manifest = JSON.parse(text);
  const tree = path.join(dir, 'tree');
  for (const [rel, , sum] of manifest.files) {
    const file = path.join(tree, ...rel.split('/'));
    let ok = false;
    try { ok = fs.lstatSync(file).isFile() && hashFile(file) === sum; } catch { ok = false; }
    if (!ok) throw refuse(`the pinned copy of ${rel} in ${digest} changed or went missing since the owner approved it; the owner pins it again with project set --broker-verbs`);
  }
  return { tree, manifest };
}

function intact(stateDir, digest) {
  try { verifyPinned(stateDir, digest); return true; } catch { return false; }
}

// Copies the files at commit (under paths, when given) into the state
// directory. Symbolic links are refused: one could point into a worktree.
// Submodules are left out; their commits are not in this repository.
function pinCommit(stateDir, root, commit, paths) {
  const head = objects(root, [commit]).get(commit);
  if (head.type !== 'commit') throw refuse(`${commit} is a ${head.type}, not a commit`);
  const tree = /^tree ([0-9a-f]+)\n/.exec(head.content.toString('latin1'))?.[1];
  if (!tree) throw refuse(`commit ${commit} names no tree`);
  const want = paths || [];
  const inside = (rel) => !want.length || want.some((p) => rel === p || rel.startsWith(`${p}/`));
  const toward = (rel) => want.some((p) => p.startsWith(`${rel}/`));
  const files = [];
  for (let level = [{ oid: tree, rel: '' }]; level.length;) {
    const found = objects(root, level.map((x) => x.oid));
    const next = [];
    for (const { oid, rel } of level) {
      const o = found.get(oid);
      if (o.type !== 'tree') throw refuse(`${rel || 'the root'} at ${commit} is a ${o.type}, not a tree`);
      for (const e of treeEntries(o.content, commit.length)) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (relPathError(p)) throw refuse(`${JSON.stringify(p)} at ${commit} is not a path a pinned source can hold`);
        if (e.mode === '40000') {
          if (inside(p) || toward(p)) next.push({ oid: e.oid, rel: p });
        } else if (!inside(p) || e.mode === '160000') {
          continue;
        } else if (e.mode === '120000') {
          throw refuse(`${p} is a symbolic link at ${commit}; a pinned source holds regular files only, so narrow source.paths past it`);
        } else if (e.mode === '100644' || e.mode === '100755') files.push({ path: p, mode: e.mode, oid: e.oid });
        else throw refuse(`${p} at ${commit} has mode ${e.mode}, which a pinned source does not hold`);
      }
    }
    level = next;
  }
  const absent = want.filter((p) => !files.some((f) => f.path === p || f.path.startsWith(`${p}/`)));
  if (absent.length) throw refuse(`source.paths ${absent.join(', ')} hold no file at ${commit}`);
  if (!files.length) throw refuse(`commit ${commit} holds no file to pin`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  fs.mkdirSync(sourcesDir(stateDir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(sourcesDir(stateDir), '.staging-'));
  const aside = `${staging}-damaged`;
  try {
    const rows = [];
    for (let i = 0; i < files.length; i += BATCH) {
      const part = files.slice(i, i + BATCH);
      const blobs = objects(root, part.map((f) => f.oid));
      for (const f of part) {
        const blob = blobs.get(f.oid);
        if (blob.type !== 'blob') throw refuse(`${f.path} at ${commit} is a ${blob.type}, not a file`);
        const file = path.join(staging, 'tree', ...f.path.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, blob.content, { mode: f.mode === '100755' ? 0o755 : 0o644 });
        rows.push([f.path, f.mode, sha256(blob.content)]);
      }
    }
    const text = `${JSON.stringify({ version: 1, commit, paths: want, files: rows })}\n`;
    const digest = sha256(text);
    fs.writeFileSync(path.join(staging, 'manifest.json'), text);
    const final = path.join(sourcesDir(stateDir), digest);
    if (!intact(stateDir, digest)) {
      // A damaged copy gives way to the one just built from hash-checked objects.
      try { fs.renameSync(final, aside); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      try {
        fs.renameSync(staging, final);
      } catch (e) {
        // Another project set placed the same copy first.
        if (!fs.existsSync(final)) throw e;
        verifyPinned(stateDir, digest);
      }
    }
    return digest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(aside, { recursive: true, force: true });
  }
}

// Whether commit is on the project's base branch: origin's copy of it when
// there is one, else the local branch.
function onBase(root, base, commit) {
  const Commands = require('./commands');
  const git = (args) => Commands.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const remote = `refs/remotes/origin/${base}`;
  const ref = git(['rev-parse', '--verify', '-q', `${remote}^{commit}`]).status === 0 ? remote : `refs/heads/${base}`;
  const r = git(['merge-base', '--is-ancestor', commit, ref]);
  if (r.status === 0) return;
  if (r.status === 1) throw refuse(`${commit} is not on ${ref}; a broker verb pins a commit of the base branch ${base}`);
  throw refuse(`cannot tell whether ${commit} is on ${ref}: ${String(r.stderr || '').trim()}`);
}

// project set --broker-verbs, before the state lock (git does not run under
// it): checks what each verb reaches and pins each commit source. The
// copies are named by their content, so a refused request leaves only a copy
// the same approved request reuses.
function prepare(ctx, repo, project, tasks, text) {
  const verbs = parse(text);
  if (verbs === null) return null;
  if (!repo) throw refuse('project set --broker-verbs pins verb sources from the repository; run it from the repository');
  const roots = writableRoots(ctx, project, repo, tasks);
  const out = {};
  for (const [name, v] of Object.entries(verbs)) {
    checkReach(name, v, roots);
    if (v.source.path !== undefined && !isDirectory(v.source.path)) throw refuse(`broker verb ${name}: source.path ${v.source.path} is not a directory`);
    const source = v.source.commit === undefined ? v.source : (() => {
      onBase(repo.root, project.base, v.source.commit);
      return { ...v.source, digest: pinCommit(ctx.stateDir, repo.root, v.source.commit, v.source.paths) };
    })();
    out[name] = { ...v, source };
  }
  return out;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The authority setting a grant change needs: delegated verbs and removals
// are the orchestrator's, any other verb the owner's.
function grantSettings(project, task, names) {
  const verbs = project.broker?.verbs || {};
  const unknown = names.filter((n) => !Object.hasOwn(verbs, n));
  if (unknown.length) throw refuse(`no broker verb ${unknown.join(', ')} in project.json; the owner declares verbs with project set --broker-verbs`);
  const current = task.broker_verbs || [];
  const added = names.filter((n) => !current.includes(n));
  if (added.some((n) => verbs[n].delegate !== true)) return ['task.broker_verbs_owner'];
  return added.length || current.some((n) => !names.includes(n)) ? ['task.broker_verbs'] : [];
}

function grantList(text) {
  const names = [...new Set(String(text).split(',').map((s) => s.trim()).filter(Boolean))];
  for (const n of names) if (!NAME.test(n)) throw usage(`--broker-verbs takes verb names separated by commas; "${n}" is not one`);
  return names;
}

function params(name, verb, given) {
  const declared = verb.params || {};
  const out = {};
  for (const item of given || []) {
    const eq = item.indexOf('=');
    const key = eq < 0 ? item : item.slice(0, eq);
    if (eq < 0) throw usage(`--param takes KEY=VALUE, not ${JSON.stringify(item)}`);
    const value = item.slice(eq + 1);
    if (!Object.hasOwn(declared, key)) throw refuse(`verb ${name} has no parameter ${key}; it takes ${Object.keys(declared).join(', ') || 'none'}`);
    if (Object.hasOwn(out, key)) throw refuse(`--param ${key} is given twice`);
    const spec = declared[key];
    if (value.includes('\0') || (TYPES[spec.type] && !TYPES[spec.type].test(value)) || !pattern(spec.pattern).test(value)) {
      throw refuse(`--param ${key}=${JSON.stringify(value)} is outside verb ${name}'s ${spec.type} pattern ${spec.pattern}`);
    }
    out[key] = value;
  }
  const missing = Object.keys(declared).filter((k) => !Object.hasOwn(out, k));
  if (missing.length) throw refuse(`verb ${name} needs --param ${missing.map((k) => `${k}=VALUE`).join(' --param ')}`);
  return out;
}

// Outputs land flat in the task scratch, beside the worker's own files. The
// scratch is the worker's to write, but not its parent, so the worker cannot
// swap the directory itself; an exclusive create refuses a name it planted,
// a link included, so nothing is written through it.
function collect(out, scratch, prefix, names) {
  const list = [];
  for (const name of names) {
    const src = path.join(out, name);
    let st = null;
    try { st = fs.lstatSync(src); } catch { st = null; }
    if (!st?.isFile()) {
      list.push({ name, missing: true });
      continue;
    }
    const dest = path.join(scratch, `${prefix}-${name}`);
    try {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    } catch (e) {
      list.push({ name, sha256: hashFile(src), bytes: st.size, refused: `${dest} (${e.code || e.message})` });
      continue;
    }
    list.push({ name, path: dest, sha256: hashFile(src), bytes: st.size });
  }
  return list;
}

// tower-crane verb NAME --param K=V: runs a granted verb for the task. In a
// sandboxed agent it goes through the state broker, which runs this on the
// host under the agent's identity.
async function run(ctx) {
  const S = require('./state');
  const T = require('./tasks');
  const C = require('./containment');
  const G = require('./gates/common');
  const name = ctx.pos[0];
  const id = ctx.flags.task || ctx.env.TOWER_CRANE_TASK;
  if (!id) throw usage('verb needs --task ID outside a task process');
  const st = S.loadState(ctx.stateDir);
  const t = T.getTask(st, id);
  const verb = st.project.broker?.verbs?.[name];
  if (!verb) throw refuse(`no broker verb ${name} in project.json; the owner declares verbs with project set --broker-verbs`);
  const who = require('./authority').role(ctx, st.events);
  if (!who && !(t.status === 'in_progress' && t.claim?.agent === ctx.agent)) {
    throw refuse(`${ctx.agent} does not hold ${t.id}'s claim; a verb runs for the task's claimant`);
  }
  if (!(t.broker_verbs || []).includes(name)) {
    throw refuse(`${t.id} has no grant for broker verb ${name}; ${verb.delegate === true ? 'the orchestrator' : 'the owner'} grants it with task update ${t.id} --broker-verbs ${[...(t.broker_verbs || []), name].join(',')}`);
  }
  const values = params(name, verb, ctx.flags.param);
  const roots = writableRoots(ctx, st.project, null, st.tasks.tasks);
  checkReach(name, verb, roots);
  let cwd;
  if (verb.source.commit !== undefined) cwd = verifyPinned(ctx.stateDir, verb.source.digest).tree;
  else if (isDirectory(verb.source.path)) cwd = verb.source.path;
  else throw refuse(`broker verb ${name}: source.path ${verb.source.path} is not a directory`);
  const outputs = verb.outputs || [];
  if (outputs.length && !t.scratch) throw refuse(`${t.id} has no task scratch directory yet for verb ${name}'s outputs; spawn records it when the worker starts`);
  if (outputs.length && !(() => { try { return fs.lstatSync(t.scratch).isDirectory(); } catch { return false; } })()) {
    throw refuse(`${t.id}'s task scratch ${t.scratch} is not a directory`);
  }
  const stamp = `${nowIso().replace(/[-:]|\.\d+/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  // The verb writes its outputs where no sandbox writes; they reach the scratch after it exits.
  const out = path.join(ctx.stateDir, 'verbs', 'runs', `${t.id}-${name}-${stamp}`);
  const argv = verb.argv.map((arg) => arg.replace(PLACEHOLDER, (_, key) => {
    if (key === 'source') return cwd;
    if (key === 'out') return out;
    const [kind, ref] = key.split(/\.(.*)/s);
    return kind === 'param' ? values[ref] : verb.mounts[ref];
  }));
  checkFilled(name, argv, roots, [resolved(cwd), resolved(out)]);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const env = { ...ctx.env, TOWER_CRANE_VERB: name, TOWER_CRANE_VERB_OUT: out };
  for (const k of DROPPED_ENV) delete env[k];
  const resources = { ...C.resolveGate(st.project), ...verb.resources };
  const started = performance.now();
  let r;
  let collected;
  try {
    r = await G.exec({ exec: G.treeExec, project: st.project }, argv[0], argv.slice(1),
      { cwd, env, resources, timeout: verb.timeout_sec * 1000, keep: KEEP_CHARS });
    collected = collect(out, t.scratch, `verb-${name}-${stamp}`, outputs);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  const duration = Math.round(performance.now() - started);
  const redact = G.createRedactor(Object.entries(env).filter(([k, v]) => G.secretValue(k, v)));
  const ok = r.ok && !r.resource_reason;
  const how = r.resource_reason || (r.timedOut ? `timed out after ${verb.timeout_sec} s` : G.how(r));
  const record = {
    name, params: values, exit_code: r.status, signal: r.signal, timed_out: r.timedOut,
    ...(r.resource_reason ? { resource_reason: r.resource_reason } : {}), duration_ms: duration,
    outputs: collected, source: { ...verb.source },
  };
  const entry = S.mutate(ctx, 'verb', (now, emit) => {
    const task = T.getTask(now, t.id);
    const e = { type: 'verb', ok, sha: task.sha, agent: ctx.agent, ...S.via(ctx), at: nowIso(), summary: `${name}: ${how}`, ref: null, revision: task.revision, verb: record };
    task.evidence.push(e);
    emit(task.id, { verb: name, ok, exit_code: r.status, timed_out: r.timedOut, ...(r.resource_reason ? { resource_reason: r.resource_reason } : {}), duration_ms: duration, outputs: collected });
    return e;
  });
  const stdout = redact(r.stdout);
  const stderr = redact(r.stderr);
  if (stderr && !ctx.json) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`);
  const lines = [
    ...(stdout ? [stdout.replace(/\n$/, '')] : []),
    `verb ${name} for ${t.id}: ${how} in ${(duration / 1000).toFixed(1)} s`,
    ...collected.map((o) => (o.missing ? `  ${o.name}: not written`
      : o.refused ? `  ${o.name}: sha256 ${o.sha256}, not copied to ${o.refused}` : `  ${o.name}: ${o.path} sha256 ${o.sha256}`)),
  ];
  return { data: { ...entry, stdout, stderr }, text: lines.join('\n'), code: ok ? 0 : Number.isInteger(r.status) && r.status > 0 ? r.status : 1 };
}

module.exports = { errors, parse, prepare, grantSettings, grantList, verifyPinned, pinCommit, writableRoots, run, sourcesDir };
