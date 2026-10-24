'use strict';

const S = require('./state');
const T = require('./tasks');
const P = require('./processes');
const C = require('./gates/common');
const { createHash } = require('node:crypto');

function sourceOf(event) {
  const { at, cmd, agent, task, detail } = event;
  return event.id || `legacy:${createHash('sha256').update(JSON.stringify({ at, cmd, agent, task, detail })).digest('hex')}`;
}

// Only the owner or the orchestrator acts on the event reactions; a worker
// that names its own identity is verified as a worker and refused here.
function trusted(ctx) {
  return !!require('./authority').role(ctx, S.readEvents(ctx.stateDir));
}

function reactionContext(ctx) {
  const env = { ...ctx.env, TOWER_CRANE_AGENT: 'orchestrator' };
  delete env.TOWER_CRANE_BROKER;
  delete env.TOWER_CRANE_VIA;
  const st = S.loadState(ctx.stateDir);
  const holder = require('./orchestrator').holder(st);
  return { ...ctx, agent: 'orchestrator', agentExplicit: true, automation: true, env, flags: {},
    orchestratorSession: Object.hasOwn(ctx, 'orchestratorSession') ? ctx.orchestratorSession : holder };
}

function current(ctx, id) {
  const st = S.loadState(ctx.stateDir);
  return { st, task: T.getTask(st, id) };
}

function merged(st, task) {
  return require('./stack').merged(st, task);
}

// Whether the task's submitter is waiting on its head as the PR's owner.
function ownerWaits(st, task) {
  const owner = require('./ownership').state(st, task);
  return owner?.phase === 'waiting' && owner.agent === task.submitted_by;
}

// A software gate run by hand settles its failure the same way a CI check does.
const GATE_CHECKS = ['check tests', 'check clean', 'check ci'];

function eligible(st, event) {
  if (!['submit', 'hotfix', 'accept', 'ci completed', 'ci resolve', 'spawn exit', 'worker-exited', 'merge', 'automation reconcile', ...GATE_CHECKS].includes(event.cmd)
    && !(event.cmd === 'evidence' && event.detail.type === 'review')) return false;
  const task = st.tasks.tasks.find((t) => t.id === event.task);
  if (!task || !['submitted', 'accepted'].includes(task.status)) return false;
  if (event.detail?.sha && !C.sameSha(event.detail.sha, task.sha)) return false;
  if (event.detail?.revision && event.detail.revision !== task.revision) return false;
  if (event.cmd === 'merge') return event.detail.ok === true;
  if (merged(st, task)) return false;
  return ['submit', 'hotfix', 'accept', 'ci completed', 'ci resolve', 'spawn exit', 'worker-exited', 'automation reconcile'].includes(event.cmd)
    || GATE_CHECKS.includes(event.cmd) || event.cmd === 'evidence' && event.detail.type === 'review';
}

function live(detail) {
  return detail?.phase === 'running' && P.processState(detail) !== 'exited';
}

const GOVERNOR_RETRY_MS = 5000;

module.exports = { sourceOf, trusted, reactionContext, current, merged, ownerWaits, GATE_CHECKS, eligible, live, GOVERNOR_RETRY_MS };
