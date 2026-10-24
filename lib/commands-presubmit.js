'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'presubmit override', pos: ['ID'], usage: 'ID --reason R', summary: 'orchestrator or owner: bypass the current presubmit refusal once at its head', flags: { reason: str('R', 'why this refusal may be bypassed') }, required: ['reason'], description: 'record an override of the last presubmit refusal, with a reason, for one successful submit at that SHA, task revision and command configuration. The worker submits under its own identity; the orchestrator never runs the hook on the host. A new head, command, revision or successful submission retires the override', run: run('./presubmit', 'resolve') },

  { section: 'Run', name: 'presubmit retry', pos: ['ID'], usage: 'ID --reason R', summary: 'orchestrator or owner: resume a paused presubmit hook after fixing its cause', flags: { reason: str('R', 'what changed to make another attempt useful') }, required: ['reason'], description: 'clear the current presubmit escalation and reset the identical-failure count, with a recorded reason. The next submit runs the hook again in the worker sandbox; this grants no new tools or credentials', run: run('./presubmit', 'resolve') },
];

module.exports = COMMANDS;
