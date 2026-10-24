'use strict';

const { str, run } = require('./commands-specs');

// logOnly: the command reads the event log and project.json by itself, with
// no identity, lease, lock or state load, so it runs anywhere the log is readable.
const COMMANDS = [
  { section: 'Views', name: 'metrics', logOnly: true, usage: '[--since 7d|ISO] [--until ISO] [--by day] [--claimed-after ISO]', summary: 'efficiency of merged tasks: merges, gate runs, rework causes, tokens, lead-time phases and submits, from the event log', flags: { since: str('AGE|ISO', 'window start: a relative age (7d, 12h, 30m) or an ISO time (default 7d)'), until: str('ISO', 'window end (default now)'), by: str('day', 'add a row per local day: merges, reworks raised, how many Tower Crane caused, tokens'), 'claimed-after': str('ISO', 'cohort: count only tasks whose first claim is at or after this time, in every metric') }, description: "efficiency of the tasks merged in the window (an ok `merge` event at or after `--since` and before `--until`), each with its whole history: merges per day; gate runs per merged task by gate (tests, clean, review, ci, head check) with governor deferrals and tests-gate wall time; reworks per merged task and reworks raised in the window by cause, with the share Tower Crane caused; tokens per merged task (p50, p90, sum) by role, rung and harness, with the spend entries that have no tokens counted apart, never as zero; lead-time phases (queued, working, waiting for gates, gating, reviewing, rework waiting, accepted to merged) and the waiting share; submits per merged task and first-pass time. `--claimed-after` keeps only tasks first claimed at or after that time and reports how many it excluded. Read-only and lock-free: it streams `events.jsonl` up to its size at start, leaves out a torn last line and writes nothing. `--json` names every definition", run: run('./metrics', 'metrics') },
];

module.exports = COMMANDS;
