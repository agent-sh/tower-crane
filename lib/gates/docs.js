'use strict';

const { resolveCommit, git, mergeBase, withWorktree, shell, how, errText } = require('./common');
const R = require('../review-carry');

async function classification(ctx) {
  const full = await resolveCommit(ctx, ctx.root, ctx.task.sha);
  if (!full || !ctx.project.base) return null;
  const base = await mergeBase(ctx, ctx.root, ctx.project.base, full, ctx.task);
  if (!base) return null;
  const result = await git(ctx, ctx.root, ['diff', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--name-only', '-z', base.sha, full]);
  if (!result.ok) return null;
  const files = result.stdout.split('\0').filter(Boolean);
  const docs_paths = R.docsPaths(ctx.project);
  const docs_exclude = ctx.project.review?.docs_exclude ?? [];
  return R.docsOnly(files, docs_paths, docs_exclude) ? { base: base.sha, full, files, docs_paths, docs_exclude } : null;
}

async function run(ctx) {
  const redact = require('./tests').diagnosticRedactor(ctx.project, ctx.root);
  const full = await resolveCommit(ctx, ctx.root, ctx.task.sha);
  if (!full) return { ok: false, summary: 'docs check cannot read the submitted commit' };
  const command = ctx.project.gates?.docs_cmd?.trim() || null;
  const receipt = { docs_cmd: command };
  if (!command) return { ok: true, summary: 'Docs check: submitted head verified; no optional docs command configured', receipt };
  const result = await withWorktree(ctx, ctx.root, full, async (dir, env) =>
    shell(ctx, command, { cwd: dir, env,
      timeout: (ctx.args?.timeout == null ? require('../gate-timeouts').minutes(ctx.project, 'docs') : Number(ctx.args.timeout)) * 60000 }));
  return { ok: result.ok, summary: redact(`Docs check: ${how(result)}${result.ok ? '' : `: ${errText(result)}`}`), receipt };
}

module.exports = { run, classification };
