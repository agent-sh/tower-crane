'use strict';

const { str, run } = require('./commands-specs');

const COMMANDS = [
  { section: 'Run', name: 'ci dispatch', pos: ['[ID]'], usage: '[ID] [--task ID]', summary: "run the repository's CI workflow (workflow_dispatch) on the task's branch at its head and record the run; ci checks shows its jobs and failing tests", flags: { task: str('ID', 'task (default TOWER_CRANE_TASK)') }, description: "dispatch the CI workflow on the task's branch at its current GitHub head and record the run id in the task's `ci_dispatches`. The workflow is `ci.dispatch.workflow`, else the one workflow of the PR's `pull_request` runs. Refused while a dispatched run at the same head has not completed, and past `ci.dispatch.per_hour` dispatches (default 4) for the task in the last hour. Only the orchestrator, the owner, or the agent that claimed or submitted the task dispatches; a sandboxed worker dispatches its own task through the state broker. `ci checks` shows the latest dispatched run's jobs and, once it completes, each failing job's failing tests; the CI gate and submit set dispatched runs aside, so they never count for or against the PR's checks. ID or `--task` defaults to TOWER_CRANE_TASK", run: run('./ci-dispatch', 'dispatch') },
];

module.exports = COMMANDS;
