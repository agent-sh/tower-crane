'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'hook', pos: ['ACTION'], usage: 'ACTION --binding FILE [--payload JSON|-]', summary: 'deliver harness messages and record activity under the home identity', flags: { binding: str('FILE', 'protected hook binding in the agent home'), payload: str('JSON|-', 'harness event data (- reads stdin)') }, required: ['binding'], run: run('./harness-hooks', 'hook') },
];

module.exports = COMMANDS;
