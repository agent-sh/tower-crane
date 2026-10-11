'use strict';

// Harness input is data. Identity, task and state come from the protected home.
const path = require('node:path');
const cp = require('./commands');
const { binding } = require('./harness-hooks');
const { LOCK_WAIT_MS } = require('./state');
const { readStdin } = require('./util');
const CLI = path.join(__dirname, '..', 'bin', 'tower-crane.js');
const CALL_TIMEOUT_MS = LOCK_WAIT_MS + 5000;

function call(action, payload = {}) {
  if (!['inbox', 'tool', 'report', 'stop', 'git-push', 'pr-created'].includes(action)) throw new Error('unknown hook action');
  const agent = process.env.TOWER_CRANE_AGENT;
  const state = process.env.TOWER_CRANE_STATE;
  if (!agent || !state) throw new Error('hook requires its dispatch identity and state');
  const file = path.join(state, 'homes', agent, 'hook.json');
  if (process.env.TOWER_CRANE_HOOK && path.resolve(process.env.TOWER_CRANE_HOOK) !== path.resolve(file)) {
    throw new Error('hook binding must match the invoking dispatch identity');
  }
  const b = binding(file);
  if (b.agent !== agent || path.resolve(b.state) !== path.resolve(state)) {
    throw new Error('hook identity and state must match the invoking dispatch');
  }
  const r = cp.spawnSync(process.execPath, [
    CLI, 'hook', action, '--binding', file, '--agent', b.agent, '--state', b.state,
    '--payload', '-', '--json',
  ], { input: JSON.stringify(payload), encoding: 'utf8', timeout: CALL_TIMEOUT_MS, windowsHide: true });
  if (r.status !== 0) {
    const message = r.stderr || r.error?.message || 'harness hook failed';
    // A failed hook blocks a prompt and can end a starting worker. Progress
    // and an inbox poll can both wait for the next turn; the messages stay unread.
    if (action !== 'tool' && !(action === 'inbox' && !Array.isArray(payload.ids))) throw new Error(message);
    process.stderr.write(`tower-crane hook: ${action} skipped: ${message.trim()}\n`);
    return { block: false, context: '', ids: [] };
  }
  return JSON.parse(r.stdout);
}

// An orchestrator's Stop with nothing to deliver blocks here, outside the
// state lock, until the next event after offset; then Stop asks again.
function hold(offset) {
  const r = cp.spawnSync(process.execPath, [
    CLI, 'wait', '--inbox', '--after', String(offset), '--agent', process.env.TOWER_CRANE_AGENT, '--state', process.env.TOWER_CRANE_STATE,
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr || r.error?.message || 'orchestrator wait failed');
}

// The Stop hook needs to know a background Bash job started, since the turn can
// end while the job still runs.
function toolPayload(p) {
  const background = p.tool_name === 'Bash' && p.tool_input?.run_in_background === true;
  return { tool: p.tool_name, ...(background ? { background: true } : {}) };
}

function main(mode) {
  if (!['hook', 'codex'].includes(mode)) throw new Error('hook bridge accepts only a mode, never a binding path');
  const input = mode === 'codex' ? process.argv[3] || '{}' : readStdin() || '{}';
  const p = JSON.parse(input);
  if (mode === 'codex') {
    call('report', { report: p['last-assistant-message'] });
    return;
  }
  const event = p.hook_event_name;
  if (event === 'PostToolUse') call('tool', toolPayload(p));
  const stop = event === 'Stop';
  let out = call(stop ? 'stop' : 'inbox', stop ? { report: p.last_assistant_message } : {});
  while (stop && out.hold) {
    hold(out.offset);
    out = call('stop', { report: p.last_assistant_message });
  }
  if (out.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: out.context }) + '\n');
  else if (!stop && out.context) process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: out.context },
  }) + '\n');
}

if (require.main === module) {
  try { main(process.argv[2]); } catch (e) {
    process.stderr.write(`tower-crane hook: ${e.message}\n`);
    process.exitCode = process.argv[2] === 'codex' ? 1 : 2;
  }
}

module.exports = { call };
