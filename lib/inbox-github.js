'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const S = require('./state');
const C = require('./gates/common');

// Match the inbox follower's refresh interval. Leave half of the three-second
// inbox budget for loading state, deriving local findings and rendering output.
const REUSE_MS = 60000;
const READ_MS = 1500;

function reader(ctx, st) {
  const file = path.join(ctx.stateDir, 'inbox-github-cache.json');
  const scope = createHash('sha256').update(JSON.stringify([st.project.repo, st.project.base, process.env.GH_HOST,
    st.tasks.tasks.filter((t) => ['submitted', 'accepted', 'rework'].includes(t.status))
      .map((t) => [t.id, t.status, t.pr, t.sha, t.revision])])).digest('hex');
  let cache;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const entries = cache?.scope === scope && cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  const deadline = Date.now() + READ_MS;
  const pending = new Map();
  let changed = false;
  const fresh = (entry) => {
    const at = Date.parse(entry?.at);
    return Number.isFinite(at) && at <= Date.now() && Date.now() - at < REUSE_MS;
  };
  const exec = async (cmd, args, opts) => {
    const key = createHash('sha256').update(JSON.stringify([cmd, args])).digest('hex');
    if (fresh(entries[key])) return entries[key].result;
    if (pending.has(key)) return pending.get(key);
    const remaining = deadline - Date.now();
    const error = () => ({ status: null, signal: null, stdout: '', stderr: '',
      error: Object.assign(new Error('inbox GitHub read deadline exceeded (1500 ms)'), { code: 'ETIMEDOUT' }) });
    if (remaining <= 0) return error();
    const signal = AbortSignal.timeout(remaining);
    const read = C.treeExec(cmd, args, { ...opts,
      signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal,
      timeout: remaining,
    }).then((result) => {
      if (signal.aborted) return error();
      if (result.status === 0 && !result.error && !result.signal) {
        entries[key] = { at: new Date().toISOString(),
          result: { status: 0, signal: null, stdout: result.stdout, stderr: result.stderr } };
        changed = true;
      }
      return result;
    });
    pending.set(key, read);
    return read;
  };
  const save = () => {
    if (!changed) return;
    S.writeAtomic(file, JSON.stringify({ scope, entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => fresh(entry))) }));
  };
  return { exec, save };
}

module.exports = { reader };
