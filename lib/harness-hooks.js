'use strict';

const fs = require('node:fs');
const path = require('node:path');
const S = require('./state');
const T = require('./tasks');
const E = require('./events');
const { refuse, usage, readStdin } = require('./util');

function binding(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[A-Za-z][\w.-]*$/.test(b.agent) || b.agent === 'owner' || !b.task || !b.state) throw refuse('invalid harness hook identity');
  const expected = path.join(b.state, 'homes', b.agent, 'hook.json');
  if (fs.realpathSync(file) !== fs.realpathSync(expected)) throw refuse('hook binding must be in its own agent home');
  return b;
}

function unread(events, agent) {
  const delivered = new Set(events.filter((e) => e.cmd === 'hook inbox' && e.agent === agent)
    .flatMap((e) => e.detail.messages));
  return events.filter((e) => e.cmd === 'msg' && e.detail.to === agent && !delivered.has(e.id));
}

function context(messages) {
  return messages.map((e) => `Message from ${e.agent}${e.task ? ` for ${e.task}` : ''}:\n${e.detail.text}`).join('\n\n');
}

// An orchestrator home wakes on what tower-crane wait would return, from the
// log offset its home was built at. It gets ids, never event detail.
function orchestratorUnread(st, b) {
  const delivered = new Set(st.events.filter((e) => e.cmd === 'hook inbox' && e.agent === b.agent)
    .flatMap((e) => e.detail.messages));
  const { rows, offset } = E.pending(st.dir, Number(b.after) || 0, { recipient: 'orchestrator', agent: b.agent });
  return { rows: rows.filter((e) => !delivered.has(e.id)), offset };
}

const open = (st) => st.tasks.tasks.some((t) => t.status !== 'cancelled'
  && (t.status !== 'accepted' || t.pr && !require('./stack').merged(st, t)));

// The harness does not report whether a background job has finished, so any
// job started in this attempt counts as pending until the task is submitted.
const backgroundStarted = (st, b, task) => st.events.some((e) => e.cmd === 'hook background' && e.task === task.id
  && e.agent === b.agent && e.detail.attempt === b.attempt);

// A headless worker that still holds its task unsubmitted gets one hold, at the
// first stop with a background job or no final report, so it finishes in the
// foreground. `final` is this stop's own message: an earlier report does not count.
function foregroundWait(st, b, task, submitted, final) {
  if (submitted || task.claim?.agent !== b.agent) return null;
  const source = `hook-wait:${b.agent}:${b.attempt}`;
  if (st.events.some((e) => e.cmd === 'hook wait' && e.detail.source === source)) return null;
  const background = backgroundStarted(st, b, task);
  const silent = !final.trim();
  if (!background && !silent) return null;
  const reasons = [background && 'a background job was started', silent && 'the turn ended with no final report']
    .filter(Boolean);
  const text = `Tower Crane: ${reasons.join(' and ')} before submit. Finish in the foreground: run each wait with a bound `
    + `(tower-crane wait --task ${task.id} --timeout SEC exits 2 on timeout), then submit, or release the task with a reason if you are blocked.`;
  return { source, reasons, text };
}

function hook(ctx) {
  const b = binding(ctx.flags.binding);
  if (ctx.agent !== b.agent || path.resolve(ctx.stateDir) !== path.resolve(b.state)) {
    throw refuse('hook identity and state must match its agent home');
  }
  const action = ctx.pos[0];
  if (!['inbox', 'tool', 'report', 'stop', 'git-push', 'pr-created'].includes(action)) throw usage('unknown hook action');
  let payload = {};
  if (ctx.flags.payload !== undefined) payload = JSON.parse(ctx.flags.payload === '-' ? readStdin() : ctx.flags.payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw usage('hook payload must be an object');
  const data = S.mutate(ctx, `hook ${action}`, (st, emit) => {
    const task = T.getTask(st, b.task);
    if (b.role === 'orchestrator') return orchestrator(st, emit, b, task, action, payload);
    const messages = action === 'inbox' || action === 'stop' && payload.hold !== false ? unread(st.events, b.agent)
      .filter((e) => !Array.isArray(payload.ids) || payload.ids.includes(e.id)) : [];
    const text = context(messages);
    if (messages.length && !(action === 'inbox' && payload.ack === false)) emit(task.id, { messages: messages.map((e) => e.id) }, 'hook inbox');
    if (action === 'stop' && messages.length && payload.hold !== false) return { block: true, context: text };
    if (action === 'tool') {
      emit(task.id, { harness: b.harness, tool: String(payload.tool || 'tool') }, 'hook progress');
      if (payload.background === true) emit(task.id, { harness: b.harness, attempt: b.attempt }, 'hook background');
    }
    // The binding is the agent's own, so a call with no push or PR behind it records the same event
    // as a shim call. Nothing checked the remote: consumers verify on GitHub or in the repository.
    if (['git-push', 'pr-created'].includes(action)) emit(task.id, { harness: b.harness, unverified: true }, `hook ${action}`);
    if (action === 'report' && typeof payload.report === 'string' && payload.report.trim()) {
      emit(task.id, { report: payload.report }, 'hook report');
    }
    if (action === 'stop') {
      const report = typeof payload.report === 'string' && payload.report.trim() ? payload.report
        : st.events.findLast((e) => e.task === task.id && e.agent === b.agent && ['hook report', 'hook stop'].includes(e.cmd))?.detail.report || '';
      const submitted = task.submitted_by === b.agent && ['submitted', 'accepted'].includes(task.status);
      const source = `hook-stop:${b.agent}:${b.attempt}`;
      // The supervisor's stop after the process exited (hold:false) has no turn left to hold.
      const wait = payload.hold === false ? null
        : foregroundWait(st, b, task, submitted, typeof payload.report === 'string' ? payload.report : '');
      if (wait) {
        emit(task.id, { harness: b.harness, attempt: b.attempt, source: wait.source, reasons: wait.reasons }, 'hook wait');
        return { block: true, context: wait.text };
      }
      const previous = st.events.findLast((e) => e.cmd === 'hook stop' && e.detail.source === source);
      if (!previous || previous.detail.report !== report || previous.detail.submitted !== submitted) {
        emit(task.id, { harness: b.harness, submitted, report, source }, 'hook stop');
        // A pending job sends no note: the worker may resume, and a process that exits is reported by its exit event.
        const pending = !submitted && task.claim?.agent === b.agent && backgroundStarted(st, b, task);
        if (!pending) emit(task.id, { to: 'orchestrator', text: `${b.agent} stopped ${submitted ? 'after submit' : 'without submit'}.${report ? `\n${report}` : '\nNo final report captured.'}` }, 'msg');
      }
    }
    return { block: false, context: text, ...(action === 'inbox' ? { ids: messages.map((e) => e.id) } : {}) };
  });
  return { data, text: data.context };
}

// Stop holds while tasks are open: the bridge blocks on tower-crane wait from
// offset and asks again, so an idle orchestrator wakes on the next event.
function orchestrator(st, emit, b, task, action, payload) {
  if (action === 'tool') emit(task.id, { harness: b.harness, tool: String(payload.tool || 'tool') }, 'hook progress');
  if (!['inbox', 'stop'].includes(action)) return { block: false, context: '' };
  const { rows, offset } = orchestratorUnread(st, b);
  const held = action === 'inbox' || payload.hold !== false;
  const picked = held ? rows.filter((e) => !Array.isArray(payload.ids) || payload.ids.includes(e.id)) : [];
  const text = picked.length ? E.notice(picked.map(E.wake), b.agent) : '';
  if (picked.length && !(action === 'inbox' && payload.ack === false)) emit(task.id, { messages: picked.map((e) => e.id) }, 'hook inbox');
  if (action === 'stop') {
    if (picked.length) return { block: true, context: text };
    return { block: false, context: '', hold: held && open(st), offset };
  }
  return { block: false, context: text, ids: picked.map((e) => e.id) };
}

module.exports = { hook, binding, unread, context };
