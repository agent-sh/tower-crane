'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Gates', name: 'gate log', pos: ['ID'], usage: 'ID [--type tests] [--test NAME] [--run head|base|scoped|reverted]', summary: "print a task's latest stored tests log or one failing test's first error block", flags: { type: str('tests', 'gate type (default tests)'), test: str('NAME', 'exact failing test name'), run: str('PHASE', 'head (default), base, scoped or reverted') }, description: "read the latest audited tests evidence that has logs, including after rework. Prints the complete retained head output by default; --test selects the first diagnostic block of that exact name, without the summary's per-test or aggregate cap. Summary diagnostics have a 32 KiB compact-JSON budget; every name remains listed, with an omitted count and log pointer for remaining blocks. --run selects base reruns, scoped proof or reverted proof output. Multiple commands in a phase print in run order. Logs are redacted, bounded to 1 MiB per command and kept for the newest five gate runs per task. A missing or pruned log is reported explicitly. Workers and reviewers can read only their own task's logs through the state broker", run: run('./gate-log', 'log') },
];

module.exports = COMMANDS;
