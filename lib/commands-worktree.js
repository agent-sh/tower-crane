'use strict';

const { bool, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Agents and worktrees', name: 'worktree', pos: ['ID...'], usage: 'ID [ID ...]', summary: 'prepare task worktrees serially from one fetched base before dispatch', description: "create (or print) a git worktree and branch `tower-crane/<id>-<slug>` from the freshest base for each task, at `<repo-parent>/<repo>-worktrees/<id>-<slug>`, with its git admin directory in `.git-admin/<id>-<slug>` beside it (linked from the repository's `worktrees/`, which sandboxed agents cannot write); records path, branch, base, creation time and last observed head on the task. With an `origin` remote and no upstream yet, the branch tracks its namesake on origin, so a plain `git push` publishes it: a sandboxed worker cannot write the config `git push -u` changes. Once the task has a branch, its worktree is found by branch, so renaming the task does not move it", run: run('./worktree', 'worktree') },

  { section: 'Agents and worktrees', name: 'worktree list', summary: 'list managed worktrees with task status, live/stale/orphan state, counts and paths', run: run('./worktree', 'worktreeList') },

  { section: 'Agents and worktrees', name: 'worktree prune', usage: '[--dry-run] [--orphans]', summary: 'orchestrator or owner: remove stale worktrees and branches; list orphans unless --orphans opts in', flags: { 'dry-run': bool('print the removal plan without changes'), orphans: bool('also save and remove orphan worktrees under the managed root') }, run: run('./worktree', 'worktreePrune') },
];

module.exports = COMMANDS;
