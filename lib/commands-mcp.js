'use strict';

const { run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'mcp', summary: 'serve orchestrator inbox and actions as MCP tools over stdio', description: "start the newline-delimited JSON-RPC MCP server on stdin/stdout. Tools: `inbox` (optional `ack`), `spawn_ready`, `merge_accepted`, `rework_from_review` (`id`), and `release_dead`. Initialization and tool discovery work without a project; tool calls resolve the project and return missing-state or authorization errors as tool results. Calls retain the CLI process identity and state; there are no identity, state or shell overrides. Batch actions require the orchestrator or owner; all existing command checks and authority rules remain in force", run: run('./mcp', 'serve') },
];

module.exports = COMMANDS;
