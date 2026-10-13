'use strict';
// The task transitions every prototype runs. plan() checks the precondition
// against the current record and returns the event; apply() changes the record
// from the event alone, so a service can redo a logged event after a crash.
const crypto = require('node:crypto');

const TYPES = { claim: 'claim', submit: 'submitted', evidence: 'evidence', rework: 'rework', 'task note': 'task note', msg: 'worker-message', 'hook inbox': 'hook inbox' };
const CMD = { claim: 'claim', submit: 'submit', evidence: 'evidence', rework: 'rework', note: 'task note' };

function event(agent, cmd, task, detail) {
  return { at: new Date().toISOString(), agent, cmd, task, detail, id: `E${crypto.randomUUID()}`, type: TYPES[cmd] || cmd, to: cmd === 'msg' ? detail.to : 'orchestrator' };
}

function conflict(text) {
  const e = new Error(text);
  e.code = 'CONFLICT';
  return e;
}

function plan(task, agent, kind, args = {}) {
  if (!task) throw conflict('no such task');
  const id = task.id;
  switch (kind) {
    case 'claim':
      if (!['todo', 'rework'].includes(task.status) || task.claim) throw conflict(`${id} is ${task.status}`);
      return event(agent, 'claim', id, { until: new Date(Date.now() + 3600e3).toISOString(), from: task.status });
    case 'submit':
      if (task.status !== 'in_progress' || task.claim?.agent !== agent) throw conflict(`${id} is ${task.status}, not claimed by ${agent}`);
      return event(agent, 'submit', id, { previous_sha: task.sha || null, sha: args.sha || crypto.randomBytes(20).toString('hex') });
    case 'evidence':
      if (task.status !== 'submitted') throw conflict(`${id} is ${task.status}`);
      return event(agent, 'evidence', id, { type: 'note', ok: true, sha: task.sha, revision: task.revision || 1, summary: args.text || 'ok' });
    case 'rework':
      if (task.status !== 'submitted') throw conflict(`${id} is ${task.status}`);
      return event(agent, 'rework', id, { reason: args.text || 'again', sha: task.sha, previous_revision: task.revision || 1, revision: (task.revision || 1) + 1 });
    case 'note':
      return event(agent, 'task note', id, { text: args.text });
    default:
      throw new Error(`unknown transition ${kind}`);
  }
}

// Mutates task in place. Events this model did not produce leave it unchanged.
function apply(task, e) {
  const d = e.detail || {};
  switch (e.cmd) {
    case 'claim':
      task.status = 'in_progress';
      task.claim = { agent: e.agent, until: d.until, at: e.at };
      break;
    case 'submit':
      task.status = 'submitted';
      task.sha = d.sha;
      task.submitted_by = e.agent;
      break;
    case 'evidence':
      task.evidence = task.evidence || [];
      task.evidence.push({ type: d.type, ok: d.ok, sha: d.sha, agent: e.agent, at: e.at, summary: d.summary, ref: null, revision: d.revision });
      break;
    case 'rework':
      task.status = 'rework';
      task.claim = null;
      task.revision = d.revision;
      break;
    case 'task note':
      task.notes = Array.isArray(task.notes) ? task.notes : [];
      task.notes.push({ at: e.at, agent: e.agent, text: d.text });
      break;
    default:
  }
  return task;
}

const MUTATING = new Set(['claim', 'submit', 'evidence', 'rework', 'task note']);

// Pending worker messages per agent, from the log alone: msg events minus the
// ids a later hook inbox event delivered. Products of the real CLI and of the
// prototypes use the same two event shapes.
function inboxFrom(events) {
  const pending = new Map();
  for (const e of events) foldInbox(pending, e);
  return pending;
}

function foldInbox(pending, e) {
  if (!e) return;
  if (e.cmd === 'msg' && e.detail?.to) {
    if (!pending.has(e.detail.to)) pending.set(e.detail.to, new Map());
    pending.get(e.detail.to).set(e.id, e);
  } else if (e.cmd === 'hook inbox' && Array.isArray(e.detail?.messages)) {
    const mine = pending.get(e.agent);
    if (mine) for (const id of e.detail.messages) mine.delete(id);
  }
}

module.exports = { event, plan, apply, conflict, CMD, MUTATING, inboxFrom, foldInbox };
