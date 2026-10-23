'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Plan', name: 'browser-kit set', usage: '--servers JSON', summary: 'owner-required: save the browser kit server list in the user configuration', flags: { servers: str('JSON', 'MCP server names; [] disables the kit') }, required: ['servers'], description: "owner-required: save the kit server list in the user file (`TOWER_CRANE_CONFIG`, else the original user's `~/.config/tower-crane/config.json`). Names are deduplicated; `[]` disables automatic server attachment. Other user settings are preserved", run: run('./browser-kit', 'set') },

  { section: 'Plan', name: 'browser-kit show', summary: 'show the user browser kit MCP server list (default playwright)', description: "show the user's browser kit MCP server list, default `[\"playwright\"]`, and its config file", run: run('./browser-kit', 'show') },
];

module.exports = COMMANDS;
