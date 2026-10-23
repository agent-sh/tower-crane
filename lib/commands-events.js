'use strict';

const { str, num, bool, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'event', pos: ['ID'], usage: 'ID', summary: 'print one event with its detail, as a wake line names it', run: run('./events', 'show') },

  { section: 'Run', name: 'msg', pos: ['TEXT...'], usage: '--to NAME [--task ID] [--steer] TEXT', summary: 'send a worker message through the event log', flags: { to: str('NAME', 'recipient, usually orchestrator'), task: str('ID', 'task (default TOWER_CRANE_TASK)'), steer: bool('deliver into the running turn where the harness can, not after it') }, required: ['to'], run: run('./events', 'message') },

  { section: 'Run', name: 'wait', usage: '[--after CURSOR] [--for NAME] [--task ID] [--types TYPES] [--timeout SEC | --follow] [--observe] [--inbox] | --own --task ID [--timeout SEC]', summary: 'block until one matching event; print one JSON line (timeout exits 2); --follow prints an id-only line per event until interrupted; --own waits as the PR owner of the task you submitted', flags: { own: bool('as the worker that submitted --task: return when the task comes back to you to fix, or when your ownership ends'), inbox: bool('refresh actionable inbox findings at startup and each minute; emit deduplicated wakeups'), after: str('CURSOR', 'a returned cursor (OFFSET:CUTS), event id or byte offset (default now)'), for: str('NAME', 'recipient (default orchestrator)'), task: str('ID', 'only this task or decisions blocking it'), types: str('TYPES', "comma-separated event types; 'all' adds renew, spend and other bookkeeping"), timeout: num('SEC', 'maximum wait in seconds'), follow: bool('keep running; one line of ids per event, no detail'), observe: bool('watch only; run no software reactions, startup reconciliation or worker dispatch') }, run: run('./events', 'wait') },
];

module.exports = COMMANDS;
