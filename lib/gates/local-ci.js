'use strict';

const Local = require('../ci-local');
const { fail, short, git, exec, treeExec, withWorktree, how, errText } = require('./common');

async function run(ctx) {
  const { root, project, task } = ctx;
  const local = Local.resolve(project.ci.local, task);
  if (local.error) return fail(local.error);
  const current = Local.snapshot(root, project, task.sha);
  if (current.error) return fail(current.error);
  const result = await withWorktree(ctx, root, current.head_sha, async (dir) => {
    // Keep HEAD at the submitted commit while the index and checkout contain the merge result.
    const checkout = await git(ctx, dir, ['read-tree', '--reset', '-u', current.tree_hash]);
    if (!checkout.ok) return fail(`local CI cannot check out the merged tree: ${errText(checkout)}`);
    ctx.log?.(`local CI (${local.variant}) at ${short(current.head_sha)} on merged tree ${short(current.tree_hash)}`);
    const start = performance.now();
    const r = await exec({ ...ctx, exec: ctx.exec || treeExec }, local.command[0], local.command.slice(1), {
      cwd: dir, timeout: Math.max(1, Math.round(local.timeout * 1000)), processTree: true,
    });
    const receipt = {
      ...current, variant: local.variant, command: [...local.command], timeout: local.timeout,
      exit: r.status, signal: r.signal, duration_ms: Math.round(performance.now() - start),
    };
    const res = (ok, summary) => ({ ok, summary, sha: current.head_sha, receipt });
    if (!r.ok) return { ...res(false, `local CI ${how(r)}: ${errText(r, 20)}`),
      ...(Number.isInteger(r.status) && ![0, 126, 127].includes(r.status) && !r.error && !r.signal ? { confirmed_failure: true } : {}) };
    const unchanged = await git(ctx, dir, ['diff', '--quiet', current.tree_hash, '--']);
    const index = await git(ctx, dir, ['write-tree']);
    if (!unchanged.ok || !index.ok || index.stdout.trim() !== current.tree_hash) {
      return res(false, 'local CI changed tracked sources; its result does not cover the merged tree');
    }
    const latest = Local.snapshot(root, project, task.sha);
    if (latest.error || latest.tree_hash !== current.tree_hash || latest.source_digest !== current.source_digest) {
      return res(false, 'local CI merged tree moved during the check; run check ci again');
    }
    return res(true, `local CI (${local.variant}) passed at ${short(current.head_sha)} on merged tree ${short(current.tree_hash)} (${receipt.duration_ms} ms)`);
  });
  return { ...result, sha: current.head_sha };
}

module.exports = { run };
