'use strict';

const { run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Agents and worktrees', name: 'stack link', pos: ['ID'], usage: 'ID', summary: 'link submitted dependency PRs bottom to top (automatic after spawned submissions)', description: "link a submitted task's dependency chain on GitHub, bottom to top", run: run('./stack', 'link') },

  { section: 'Agents and worktrees', name: 'stack sync', pos: ['ID'], usage: 'ID', summary: 'refresh an idle stack with gh stack sync; changed heads or conflicts require rework', description: "import remote tracking with `gh stack checkout <pr> --print-path`, then run `gh stack sync` from the task worktree, without prompts", run: run('./stack', 'sync') },

  { section: 'Agents and worktrees', name: 'stack unstack', pos: ['ID'], usage: 'ID', summary: 'disable a stack for ordinary merges; lower tasks must land first', description: "remove the GitHub stack and local tracking, confirm no member remains stacked, then use ordinary merges in dependency order", run: run('./stack', 'unstack') },

  { section: 'Agents and worktrees', name: 'stack webhook', pos: ['FILE'], usage: 'FILE', summary: 'record a pull_request webhook stack object; - reads stdin', description: "ingest a trusted `pull_request` webhook payload for this project's repository; `-` reads stdin. Record `pull_request.stack` or the payload's top-level `stack` without changing acceptance or merge evidence", run: run('./stack', 'webhook') },
];

module.exports = COMMANDS;
