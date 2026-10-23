'use strict';

const { run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'orchestrator release', summary: 'release the calling orchestrator session lease', description: 'holding orchestrator session only: clear the lease so another session can write; refuses another session even when it uses the same agent name', run: run('./orchestrator', 'release') },

  { section: 'Run', name: 'orchestrator takeover', summary: 'owner-only clear the orchestrator lease for a new session', description: 'owner only: explicitly clear the orchestrator lease; the next orchestrator write acquires it. Records the previous holder', run: run('./orchestrator', 'takeover') },
];

module.exports = COMMANDS;
