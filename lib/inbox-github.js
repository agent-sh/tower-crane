'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const S = require('./state');
const C = require('./gates/common');

// Match the host follower's refresh interval. Foreground reads never launch gh.
const REUSE_MS = 60000;

function reader(ctx, st, refresh = false) {
  const file = path.join(ctx.stateDir, 'inbox-github-cache.json');
  const scope = createHash('sha256').update(JSON.stringify([st.project.repo, st.project.base, process.env.GH_HOST])).digest('hex');
  let cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const entries = cache?.scope === scope && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  const versions = st.tasks.tasks.filter((t) => ['submitted', 'accepted', 'rework'].includes(t.status)
    && !require('./stack').merged(st, t))
    .map((t) => [t.id, t.status, t.pr, t.sha, t.revision]);
  const pending = new Map();
  const missing = new Set();
  const current = cache?.scope === scope;
  if (!refresh && !current && st.project.repo) missing.add('project');
  let mainError = current ? cache.main_error || null : null;
  let changed = !current;
  const live = new Map(versions.map((t) => [t[0], JSON.stringify(t)]));
  const fresh = (entry) => {
    const at = Date.parse(entry?.at);
    return Number.isFinite(at) && at <= Date.now() && Date.now() - at < REUSE_MS;
  };
  // Keep only observations for current task versions. A closed task or a
  // resubmission must not leave its response bodies in the next cache write.
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || !Array.isArray(entry.tasks) || entry.tasks.some((t) => live.get(t[0]) !== JSON.stringify(t)) || !fresh(entry)) {
      delete entries[key];
      changed = true;
    }
  }
  const exec = async (cmd, args, opts) => {
    const endpoint = decodeURIComponent(args[1] || '');
    const pr = args[0] === 'pr' ? Number(args[2]) : Number(/\/(?:pulls?|issues)\/(\d+)/.exec(endpoint)?.[1]);
    const sha = /\/commits\/([a-f0-9]+)/.exec(endpoint)?.[1];
    const tasks = versions.filter((t) => pr && t[2] === pr || sha && t[3] === sha);
    const key = createHash('sha256').update(JSON.stringify([cmd, args, tasks])).digest('hex');
    if (fresh(entries[key]) && !(refresh && endpoint.includes('/actions/'))) return entries[key].result;
    if (!refresh) {
      for (const task of tasks) missing.add(task[0]);
      if (!tasks.length) missing.add('project');
      return { status: null, signal: null, stdout: '', stderr: '',
        error: { code: 'INBOX_GITHUB_PENDING', message: 'GitHub data not yet refreshed by the host follower' } };
    }
    if (pending.has(key)) return pending.get(key);
    const read = C.treeExec(cmd, args, opts).then((result) => {
      entries[key] = { at: new Date().toISOString(), tasks,
        result: { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
          ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}) } };
      changed = true;
      return result;
    });
    pending.set(key, read);
    return read;
  };
  const save = (error) => {
    if (refresh && mainError !== (error || null)) { mainError = error || null; changed = true; }
    if (!refresh || !changed) return;
    S.writeAtomic(file, JSON.stringify({ scope, read_at: new Date().toISOString(),
      main_error: mainError,
      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => fresh(entry))) }));
  };
  return { exec, save, missing, main_error: mainError, read_at: current ? cache.read_at || null : null };
}

module.exports = { reader };
