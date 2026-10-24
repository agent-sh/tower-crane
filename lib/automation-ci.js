'use strict';

const S = require('./state');
const T = require('./tasks');
const C = require('./gates/common');
const fs = require('node:fs');
const path = require('node:path');
const { refuse, usage, readStdin } = require('./util');
const { current, merged, trusted } = require('./automation-common');

async function ciCompleted(ctx) {
  const { consume } = require('./automation');
  if (!trusted(ctx)) throw refuse('ci completed is an orchestrator or owner command');
  if (!/^[a-f\d]{7,64}$/i.test(ctx.flags.sha || '')) throw usage('ci completed needs --sha with the completed commit');
  S.mutate(ctx, 'ci completed', (st, emit) => {
    const task = T.getTask(st, ctx.pos[0]);
    if (!['submitted', 'accepted'].includes(task.status) || !C.sameSha(task.sha, ctx.flags.sha)) {
      throw refuse(`${task.id}: CI completion does not match an active submitted head`);
    }
    emit(task.id, { sha: task.sha, revision: task.revision });
  });
  // emit's event ID is assigned by mutate when it appends the audit record.
  const latest = S.readEvents(ctx.stateDir).findLast((e) => e.cmd === 'ci completed' && e.task === ctx.pos[0]);
  await consume(ctx, [latest]);
  const { st, task } = current(ctx, ctx.pos[0]);
  return { data: T.describeTask(st, task, Date.now()), text: `${task.id}: CI completion handled at ${task.sha.slice(0, 7)}` };
}

async function ciWebhook(ctx) {
  if (!trusted(ctx)) throw refuse('ci webhook is an orchestrator or owner command');
  let payload;
  try {
    const raw = ctx.pos[0] === '-' ? readStdin() : fs.readFileSync(path.resolve(ctx.cwd, ctx.pos[0]), 'utf8');
    payload = JSON.parse(raw);
  } catch (e) { throw usage(`cannot read CI webhook JSON: ${e.message}`); }
  const st = S.loadState(ctx.stateDir);
  if (payload.repository?.full_name !== st.project.repo) throw refuse('webhook repository differs from project repo');
  const check = payload.check_run || payload.check_suite || payload.workflow_run;
  if (!check || typeof check.head_sha !== 'string') throw usage('expected a check_run, check_suite or workflow_run webhook');
  if (payload.action !== 'completed' || check.status !== 'completed') {
    return { data: { ignored: true }, text: 'CI notification ignored: check is not completed' };
  }
  const tasks = st.tasks.tasks.filter((t) => t.pr && ['submitted', 'accepted'].includes(t.status)
    && C.sameSha(t.sha, check.head_sha) && !merged(st, t));
  const handled = [];
  for (const task of tasks) {
    await ciCompleted({ ...ctx, pos: [task.id], flags: { sha: check.head_sha } });
    handled.push(task.id);
  }
  return { data: { tasks: handled }, text: `CI completion handled for ${handled.join(', ') || 'no active submitted heads'}` };
}

module.exports = { ciCompleted, ciWebhook };
