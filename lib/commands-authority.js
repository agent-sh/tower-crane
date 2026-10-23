'use strict';

const { run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Plan', name: 'authority', summary: 'list every guarded setting, its class (operational, owner-required or refused) and the command that changes it', description: 'list every guarded setting with its class (`operational`, `owner-required` or `refused`) and the command that changes it; `--json` gives `[{ setting, class, how }]`, the list the board reads', run: run('./authority', 'show') },

  { section: 'Run', name: 'owner-key', summary: 'owner only: create the owner key that stands in for a terminal; prints its path, never the key', description: "the owner, explicitly and at a terminal or with the current key, creates the key under the project's recorded `owner_config_dir` and prints `created PATH` or `exists PATH`; never prints the key. An unbound project requires a terminal owner to record the directory first. `TOWER_CRANE_OWNER_KEY` with its contents stands in for a terminal ([Agent identity](state.md#agent-identity))", run: run('./authority', 'ownerKey') },
];

module.exports = COMMANDS;
