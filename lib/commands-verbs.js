'use strict';

const { str, many, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'verb', pos: ['NAME'], usage: 'NAME [--param KEY=VALUE]... [--task ID]', summary: "run a broker verb granted to the task on the host: the owner's pinned program with typed parameters, caps and a timeout; records verb evidence", flags: { param: many('KEY=VALUE', 'a value for one of the verb\'s declared parameters; repeat for each'), task: str('ID', 'task (default TOWER_CRANE_TASK)') }, description: "run broker verb `NAME` from `broker.verbs` for a task whose `broker_verbs` grants it, as the task's claimant (or the orchestrator or owner). A sandboxed worker's call goes through its state broker, which runs it on the host. Every declared parameter is required, matches its type and whole-value pattern, and is substituted into its own argv element; there is no shell. The program runs in the pinned source: the copy of the approved base branch commit in the state directory, whose files are checked against their recorded SHA-256 first, or the owner's `source.path`. It runs in a contained scope with the verb's `resources` (default: the gate caps) and `timeout_sec`, with `{out}` and `TOWER_CRANE_VERB_OUT` naming a directory no sandbox writes. Each declared output it wrote is copied to the task scratch as `verb-NAME-STAMP-OUTPUT` with an exclusive create. Prints the verb's stdout, then its exit and each output's path and SHA-256; stderr goes to stderr. Exits with the verb's exit code, or 1 for a timeout, signal or cap. Every run appends `verb` evidence: params, exit code, signal, timeout, resource cap, duration, output digests and the pinned source ([Broker verbs](state.md#broker-verbs))", run: run('../lib/verbs', 'run') },
];

module.exports = COMMANDS;
