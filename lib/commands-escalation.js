'use strict';

const { run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'recover', pos: ['ID'], usage: 'ID', summary: 'recover a ranged task after quality failure; climb or ask the owner at the top', description: 'ranged quality recovery: climb after a failed latest review or confirmed tests, clean or CI gate failure; dispatch fresh, retry a pending climb, or open an owner decision at the range top; wait for verified worker process-group cleanup before dispatch', run: run('./escalation', 'recover') },
];

module.exports = COMMANDS;
