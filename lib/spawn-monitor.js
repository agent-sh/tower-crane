'use strict';

const path = require('node:path');
const cp = require('./commands');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { getSystemErrorName } = require('node:util');
const { performance } = require('node:perf_hooks');
const P = require('./processes');
const S = require('./state');
const T = require('./tasks');
const L = require('./ladder');
const Sessions = require('./spawn-session');
const ClaudeSandboxPlaceholders = require('./claude-sandbox-placeholders');
const { clearPlaceholders, REAP_DIR } = require('./git-placeholders');
const Usage = require('./usage-files');
const Authority = require('./authority');
const { nowIso, shaMatch, sleepSync } = require('./util');
const Secrets = require('./secrets');
const { removeFilteredBrief, LEASE_GATE } = require('./spawn');
const Health = require('./harness-health');
const RETRY_MS = 10 * 60 * 1000;
const LOGIN_FAILURE = 'harness login failure';
const SAMPLE_MS = L.MIN_USAGE_MS;
const TERM_GRACE_MS = 5000;
// Once the harness has exited and its group has stopped, its output pipes get
// TERM_GRACE_MS more, the time the group itself gets to flush and stop. A
// process still holding them then left the group, or runs on Windows, which
// has none: it is stopped, and the pipes get the software-gate runner's two
// seconds to drain before they are closed. Waiting for the group first keeps a
// member that ignores SIGTERM, which SIGKILL ends, from counting as a holder.
const PIPE_DRAIN_MS = 2000;
// How long the post-stop placeholder cleanup tries again while a shim the
// sandbox outlives holds the git directory; a sandbox teardown takes milliseconds.
const CLEAR_RETRY_MS = 1000;
const STARTUP_MS = 10000;

// The dispatch waits for one startup receipt. A supervisor that ends without
// writing one leaves its exit code there instead, so the dispatch can tell an
// early exit from a slow start.
let receiptWritten = false;
function writeReceipt(file, value) {
  S.writeAtomic(file, JSON.stringify(value));
  receiptWritten = true;
}

function running(spawn) {
  return !P.exited(spawn);
}

// The supervisor's own environment is the dispatcher's; its state commands
// name the dispatch they act for.
function identity(state, task, agent, hook) {
  return { TOWER_CRANE_STATE: state, TOWER_CRANE_TASK: task, TOWER_CRANE_AGENT: agent, ...(hook ? { TOWER_CRANE_HOOK: hook } : {}) };
}

function record(state, task, agent, timeout = 30000) {
  const env = { ...process.env, ...identity(state, task, agent), ...require('./automation-key').env(state, agent) };
  return cp.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'tower-crane.js'), 'spend', task, '--from-spawn', agent,
    '--state', state, '--agent', agent,
  ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout, env });
}

// Usage stays keyed by the dispatch agent across transient attempts.
function collect(spawn) {
  const readSession = Sessions.logReader(spawn.log, spawn.harness, spawn.log_start || 0);
  let sessionRecorded = false;
  let deadline;
  let unknownDeadline;
  let failures = 0;
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
        clearInterval(timer);
        return;
      }
      const observed = P.processState(spawn);
      if (!sessionRecorded) {
        const id = readSession(observed === 'exited');
        if (id) {
          try {
            Sessions.record({ stateDir: spawn.state, agent: spawn.agent, task: spawn.task }, spawn, id, 0);
            sessionRecorded = true;
          } catch (e) {
            if (e.code !== 3) throw e;
          }
        }
      }
      if (observed === 'unknown') {
        unknownDeadline ??= performance.now() + RETRY_MS;
        if (performance.now() >= unknownDeadline) {
          clearInterval(timer);
          process.stderr.write(`tower-crane: cannot observe pid ${spawn.pid} after 10 min; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
          process.exitCode = 1;
        }
        return;
      }
      unknownDeadline = undefined;
      if (observed === 'running') return;
      removeFilteredBrief(spawn.filteredBriefFile);
      deadline ??= performance.now() + RETRY_MS;
      const timeout = Math.max(1, Math.min(30000, Math.floor(deadline - performance.now())));
      const result = record(spawn.state, spawn.task, spawn.agent, timeout);
      if (result.status === 0) {
        clearInterval(timer);
      } else if (performance.now() >= deadline) {
        clearInterval(timer);
        process.stderr.write(result.stderr || '');
        process.stderr.write(`tower-crane: usage not recorded after 10 min; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
        process.exitCode = 1;
      } else if (failures++ === 0) {
        process.stderr.write(`tower-crane: usage collection failed (${result.status ?? result.error?.code}); retrying for up to 10 min\n`);
      }
    } catch (e) {
      clearInterval(timer);
      process.stderr.write(`tower-crane: usage monitor failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
      process.exitCode = 1;
    }
  }, 500);
}

function transient(code, signal, providerError) {
  if (code === 75 || ['SIGTERM', 'SIGINT'].includes(signal)) return true;
  if (code === 0) return false;
  return providerError;
}

function providerFailure(text, envelope = false) {
  return /\b(?:HTTP(?:Error)?|status(?:[_ ]code)?|api_error_status|API(?: error)?|error)\s*["':= ]*\s*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway timeout)\b|\b(?:service unavailable|provider outage|overloaded_error|internal_server_error|server overloaded)\b/i.test(text)
    || envelope && /\b(?:429|rate[ _-]limit(?:ed|ing|[ _-]exceeded)?|temporarily unavailable|overloaded)\b/i.test(text);
}

// An expired or revoked harness login. Retrying the same login cannot succeed,
// so the failure is a harness outage, not a task attempt. Returns the sentence.
function authFailure(text) {
  const found = /\bfailed to authenticate\b|\bauthentication failed\b|\boauth session expired\b|\bnot logged in\b|\b(?:sign|log) in again\b|\brefresh token\b[^"\n]*?\bexpired\b/i.exec(text);
  if (!found) return null;
  // The sentence runs from the quote or line break before the phrase to the next one after it.
  const start = Math.max(text.lastIndexOf('"', found.index), text.lastIndexOf('\n', found.index)) + 1;
  const stop = text.slice(found.index).search(/["\n]/);
  const end = stop === -1 ? text.length : found.index + stop;
  return text.slice(start, end).trim().slice(0, 200).replace(/[.\s]+$/, '');
}

function refusal(value, harness) {
  if (!['codex', 'claude', 'command'].includes(harness)) return false;
  if (['refusal', 'response.refusal.done'].includes(value.type)) return true;
  if (['codex', 'command'].includes(harness) && value.type === 'item.completed') {
    return value.item?.type === 'refusal'
      || value.item?.type === 'agent_message' && typeof value.item.refusal === 'string' && !!value.item.refusal;
  }
  if (['claude', 'command'].includes(harness) && ['assistant', 'result'].includes(value.type)) {
    return value.stop_reason === 'refusal' || value.subtype === 'refusal'
      || value.message?.stop_reason === 'refusal'
      || Array.isArray(value.message?.content) && value.message.content.some((block) => block?.type === 'refusal');
  }
  return false;
}

// The error a harness records for its own failure, for the harnesses whose
// outage parsing does not read it. Assistant text and tool output never count.
function harnessError(value, harness) {
  if (harness === 'agy' && value.status === 'ERROR') return value.error;
  if (harness === 'pi' && value.type === 'message_end' && value.message?.role === 'assistant' && value.message.stopReason === 'error') {
    return value.message.errorMessage;
  }
  if (['agy', 'opencode', 'pi'].includes(harness) && value.type === 'error') return value.error || value.message;
  return undefined;
}

// Only harness error envelopes and stderr are evidence of an outage. Tool
// output and assistant messages may quote the same errors while doing work.
function errorReader(harness, stderr, reportOutage, reportOverflow = () => {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  let refused = false;
  let overflowed = false;
  // A quoted record is untyped JSON on stderr: it can report an outage, never a login failure.
  function record(text, envelope = false, quoted = false) {
    const outage = providerFailure(text, envelope);
    const auth = quoted ? null : authFailure(text);
    if (!quoted && ['codex', 'claude', 'command'].includes(harness)) {
      const overflow = /\bran out of room in the model's context window\b|\bprompt is too long\b|\bprompt_too_long\b|\bcontext_length_exceeded\b/i.test(text);
      if (overflow) {
        overflowed = true;
        reportOverflow(true);
      }
    }
    // A later harness error record replaces an earlier recovered reconnect.
    if (envelope || outage) reportOutage(outage, auth);
    else if (auth) reportOutage(null, auth);
  }
  // Records that are not outage evidence still count as a login failure.
  function login(text) {
    const auth = authFailure(text);
    if (auth) reportOutage(null, auth);
  }
  function line(text) {
    let value;
    try { value = JSON.parse(text); } catch {
      if (stderr) record(text);
      return;
    }
    if (!value || typeof value !== 'object') return;
    refused ||= refusal(value, harness);
    if (['codex', 'command'].includes(harness) && value.type === 'turn.completed'
      || ['claude', 'command'].includes(harness) && value.type === 'result' && value.is_error === false) {
      overflowed = false;
      reportOverflow(false);
    }
    if (['codex', 'command'].includes(harness) && ['error', 'turn.failed'].includes(value.type)) {
      record(JSON.stringify(value.error || value.message || ''), true);
    } else if (['claude', 'command'].includes(harness)
      && (value.is_error === true || value.type === 'error' || value.api_error_status !== undefined)) {
      record(JSON.stringify({
        api_error_status: value.api_error_status, error: value.error, errors: value.errors,
        result: value.is_error ? value.result : undefined, message: value.message,
      }), true);
    } else if (['claude', 'command'].includes(harness) && value.type === 'assistant'
      && value.isApiErrorMessage === true) {
      record(JSON.stringify(value.message?.content || ''), true);
    } else if (stderr && value.type === undefined) {
      record(text, false, true);
    }
    // Only the harness's own error envelope is a login failure, on either stream.
    const failure = harnessError(value, harness);
    if (failure !== undefined) login(JSON.stringify(failure));
  }
  return (chunk, final = false) => {
    const text = chunk ? decoder.write(chunk) : final ? decoder.end() : '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      pending += lines[i];
      // Bound memory when agent output contains a huge JSON record, and
      // discard its whole line so a truncated quote cannot become an error.
      if (pending.length > 65536) { oversized = true; pending = ''; }
      if (i < lines.length - 1 || final) {
        if (!oversized) line(pending);
        pending = '';
        oversized = false;
      }
    }
    return { refusal: refused, overflowed };
  };
}

function resume(spawn, id, reason, env = process.env) {
  const warm = Sessions.resumable(spawn.harness);
  if ((!warm && spawn.harness !== 'claude') || (warm && !id)) return null;
  const rung = { ...spawn.rung_config, args: [...(spawn.rung_config.args || [])] };
  const note = `Previous attempt exited with ${reason}; continue.`;
  const hooks = require('./harness-hooks');
  const receivesPrompt = spawn.harness !== 'command' || rung.command.some((arg) => arg.includes('{prompt}'));
  const inbox = receivesPrompt ? hooks.unread(S.readEvents(spawn.state), spawn.agent) : [];
  const messages = hooks.context(inbox);
  const prompt = [warm ? note : `${spawn.prompt}\n\n${note}`, messages].filter(Boolean).join('\n\n');
  if (spawn.harness === 'claude') {
    for (let i = 0; i < rung.args.length;) {
      if (['--resume', '--session-id'].includes(rung.args[i])) rung.args.splice(i, 2);
      else if (rung.args[i] === '--fork-session' || /^--(?:resume|session-id)=/.test(rung.args[i])) rung.args.splice(i, 1);
      else i++;
    }
    rung.args.push('--session-id', crypto.randomUUID());
  }
  const argv = require('./spawn').buildCommand(spawn.role, rung, prompt, { ...spawn.subs, prompt }, env, spawn.owned_flags || [], warm ? id : null, spawn.state);
  return { argv, inbox: inbox.map((e) => e.id) };
}

function pathProgress(spawn, config) {
  // Tool hooks append to the agent's progress file outside the event log.
  const files = [spawn.log, S.progressFile(spawn.state, spawn.agent), ...config.progress_paths.map((p) => path.join(spawn.cwd, p))];
  const stamps = [];
  function visit(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      stamps.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) if (!['.git', '.tower-crane', 'node_modules'].includes(name)) visit(path.join(file, name));
      }
    } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) throw e; }
  }
  for (const file of files) visit(file);
  return stamps.join('|');
}

// The config scan for the harness's git reads what that git will read, so it
// keeps the agent's home and git variables, but it runs the host's git, not
// the agent's shims first on its PATH. The shims check the agent's policy and
// clear lock placeholders before each call; this read needs neither, and a
// shim that waits on another cleanup would hold up the start past the
// dispatch's startup window. Like the gates this process runs, it is the
// host's own git, and lib/commands.js neutralizes the repository's config for it.
function hostGit(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'PATH') delete out[key];
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') out[key] = process.env[key];
  return out;
}

// The processes still holding an exited harness's output, stopped here.
// Linux finds the ones that carry the launch's mark, by the mark alone: the
// group is gone, and its leader's pid may now lead another process's group.
// Windows walks the tree the harness left from a process snapshot. Other
// systems cannot name a holder outside the group. Both process queries run
// under the bound the orchestrator's CIM process query uses.
async function outputHolders(harness, mark, launchedAt, exitedAt) {
  if (process.platform === 'win32') {
    const rows = await P.windowsProcesses(cp.execFile, S.LOCK_WAIT_MS);
    const outcomes = await P.windowsStop(cp.execFile, P.windowsTree(rows, harness.pid, launchedAt, exitedAt), S.LOCK_WAIT_MS);
    const failed = outcomes.filter((o) => ['failed', 'unreported'].includes(o.outcome));
    if (failed.length) process.stderr.write(`tower-crane: could not stop ${failed.map((o) => `${o.pid} (${o.outcome})`).join(', ')}\n`);
    return outcomes.filter((o) => o.outcome === 'stopped').map((o) => o.pid);
  }
  const pids = P.strays(null, mark, { spareSupervisors: true });
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  return pids;
}

// A sandboxed agent's state changes reach the state through a broker this
// process runs for as long as it supervises the agent.
async function supervise(spawn) {
  const release = S.retainEvents(spawn.state);
  try {
    return await superviseWithBroker(spawn);
  } finally {
    release();
    removeFilteredBrief(spawn.filteredBriefFile);
  }
}

async function superviseWithBroker(spawn) {
  // File values exist only in the harness environment, never in the job,
  // monitor environment or the state-writing subprocesses. So do the
  // agent's home, shims, cache and identity: the gates, merges and broker
  // commands this process runs keep the dispatcher's.
  let agentEnv;
  try {
    agentEnv = { ...process.env, ...spawn.agent_env?.env, ...require('./spawn-settings').agentEnv(spawn.settings || {}) };
    if (spawn.agent_tmp) Object.assign(agentEnv, require('./agents').ownTmpEnv(spawn.agent_tmp, agentEnv));
  } catch (e) {
    writeReceipt(spawn.receipt, { error: e.message });
    return 1;
  }
  let broker = null;
  if (spawn.broker) {
    try {
      broker = await require('./broker').start(spawn);
    } catch (e) {
      writeReceipt(spawn.receipt, { error: `state broker: ${e.message}` });
      return 1;
    }
  }
  try {
    const brokerEnv = broker ? broker.env : {};
    return await superviseAgent(spawn, spawn.sandboxed ? { ...agentEnv, ...brokerEnv } : agentEnv, brokerEnv);
  } finally {
    broker?.close();
  }
}

// brokerEnv reaches each route that runs sandboxed, a fallback's included.
async function superviseAgent(spawn, agentEnv, brokerEnv) {
  let config = L.supervision(spawn.rung_config || {});
  const ctx = { stateDir: spawn.state, agent: spawn.agent, env: { ...process.env, ...identity(spawn.state, spawn.task, spawn.agent, spawn.hook) }, flags: {}, pos: [] };
  let gitEnv = spawn.git_env || {};
  let child;
  let childIdentity;
  let closed;
  let captureComplete = false;
  let attempt = 0;
  let claimedSince;
  let phase = 'running';
  let nextRetry;
  let freshRetry = false;
  let lastProgress = performance.now();
  let sandboxed = !!spawn.sandboxed;
  // Launches can run inside a state mutation, where git cannot run.
  const gitPairs = require('./harness-git').pairs(spawn.cwd, hostGit(agentEnv));
  let stamp;
  let cpu;
  let exit;
  let attemptOffset = 0;
  let providerError = false;
  let authError = null;
  let harnessRefusal = false;
  let contextOverflow = false;
  let resumedSession = false;
  let overflowRetried = false;
  let stalled = false;
  let stopReason;
  let awaitingLease = false;
  let gateStdin = null;
  let stoppedBy;
  let groupComplete = true;
  let cleanupGroup;
  let committed = false;
  let retired = false;
  let incompatible = false;
  let timer;
  let retryTimer;
  let watcher;
  let wake = () => {};
  let stateStamp;
  let state;
  let nextSample = 0;
  let initialDetail;
  let sessionRecorded = false;
  let readSession = Sessions.logReader(spawn.log, spawn.harness);
  let observedSession = spawn.session_id;
  let claudePlaceholders = null;
  let hookQueue = Promise.resolve();
  // Live usage of the current route segment, under the exit collector's key.
  let liveSource = T.spawnSource(spawn.agent, spawn.resumed, spawn.attempt, spawn.route_index, null);
  let liveBaseline;
  let liveLast;
  let liveKnown = false;
  let nextLive;
  let budgetStop = null;
  let outputHeld = null;
  const hookSend = (action, payload = {}) => {
    if (!spawn.hook || incompatible) return;
    // Dispatch holds the state lock at startup; hook writers wait in children.
    hookQueue = hookQueue.then(() => new Promise((resolve) => {
      const writer = cp.execFile(process.execPath, [
        path.join(__dirname, '..', 'bin', 'tower-crane.js'), 'hook', action,
        '--binding', spawn.hook, '--state', spawn.state, '--agent', spawn.agent,
        '--payload', '-', '--json',
      ], { timeout: S.LOCK_WAIT_MS + 5000, windowsHide: true,
        env: { ...ctx.env, ...require('./automation-key').env(spawn.state, spawn.agent) } }, (error, _stdout, stderr) => {
        if (error) process.stderr.write(`tower-crane: harness event failed: ${stderr || error.message}\n`);
        else {
          try {
            const notice = JSON.parse(_stdout);
            if (notice.exit) { process.stderr.write(notice.context + '\n'); stop('stale'); }
          } catch { /* Non-JSON output is reported by the command receipt. */ }
        }
        resolve();
      });
      writer.stdin.on('error', () => {});
      writer.stdin.end(JSON.stringify(payload));
    }));
  };
  const removeClaudePlaceholders = () => {
    if (!claudePlaceholders || claudePlaceholders.cleaned) return;
    claudePlaceholders.cleaned = true;
    const result = ClaudeSandboxPlaceholders.remove(spawn.cwd, claudePlaceholders.existed);
    for (const { relative, error } of result.failures) {
      process.stderr.write(`tower-crane: could not remove Claude sandbox placeholder ${relative}: ${error.message}\n`);
    }
  };
  // A sandboxed worker can create the common directory's commondir file, which
  // points git in the main checkout at another repository's config, hooks and
  // refs (docs/ladder.md#the-common-directorys-commondir). Git never writes
  // one there, so the supervisor removes it as soon as it sees it.
  const commonDir = spawn.dispatch?.gitDirs?.common;
  let commonWatcher;
  const removeCommondir = () => {
    if (!commonDir) return;
    const file = path.join(commonDir, 'commondir');
    let named = null;
    try { named = fs.readFileSync(file, 'utf8').trim().slice(0, 1024); } catch (e) {
      if (e.code === 'ENOENT') return;
      // A directory or a dangling link: removed below all the same.
    }
    // Removed without a separate existence check: whatever is there now goes.
    try { fs.rmSync(file, { recursive: true }); } catch (e) {
      if (e.code !== 'ENOENT') removals.error ??= e.message;
      return;
    }
    removals.count++;
    // A read between the worker's create and its write sees an empty file;
    // the event names the last target the file actually held.
    if (named || removals.named === null) removals.named = named;
  };
  // At most one event per sample interval, with a count, so a write loop
  // cannot flood the log or the state lock; the event's own write wakes the
  // sampler. Recorded once the spawn is: until then its dispatch holds the
  // state lock.
  const removals = { count: 0, named: null, error: null, at: -Infinity };
  const recordRemovals = (final = false) => {
    const file = commonDir && path.join(commonDir, 'commondir');
    if (removals.error) process.stderr.write(`tower-crane: could not remove ${file}: ${removals.error}\n`);
    removals.error = null;
    if (!committed || !removals.count || !final && performance.now() - removals.at < SAMPLE_MS) return;
    removals.at = performance.now();
    const detail = { agent: spawn.agent, pid: child?.pid ?? null, path: file, named: removals.named, count: removals.count };
    removals.count = 0;
    process.stderr.write(`tower-crane: removed ${file} ${detail.count} time(s); it pointed git at ${JSON.stringify(detail.named)}\n`);
    try {
      S.mutate(ctx, 'commondir removed', (st, emit) => {
        st.rerender = true;
        emit(spawn.task, detail);
      });
    } catch (e) {
      process.stderr.write(`tower-crane: could not record the removal of ${file}: ${e.message}\n`);
    }
  };
  const sessionFromLog = (final) => {
    try { return readSession(final); } catch { return null; }
  };
  const monitor = { monitor_pid: process.pid, monitor_start_ticks: P.identity(process.pid).start_ticks };
  // Events and the startup receipt name the route's env variables only.
  const detail = () => Secrets.redact({
    role: spawn.role, rung: spawn.rung, harness: spawn.harness, agent: spawn.agent, cwd: spawn.cwd,
    pid: child?.pid, ...childIdentity, log: spawn.log, ...monitor,
    active: !exit || !captureComplete || !groupComplete || nextRetry !== undefined,
    session_id: spawn.session_id || null,
    attempt: spawn.attempt,
    route: spawn.route, route_index: spawn.route_index || 0, log_start: spawn.log_start || 0, billing: spawn.billing ?? null,
    model: spawn.rung_config.model || null, profile: spawn.rung_config.profile || null,
    ...(spawn.browser_kit ? { browser_kit: spawn.browser_kit } : {}),
    ...(spawn.harness === 'codex' ? { codex_home: spawn.codex_home } : {}),
  });
  const interrupted = (st) => st.events.some((e) => e.cmd === 'interrupt' && e.task === spawn.task
    && e.detail.active && e.detail.agent === spawn.agent && e.detail.attempt === spawn.attempt && e.detail.monitor_pid === process.pid);
  const valid = (st) => {
    const task = T.getTask(st, spawn.task);
    T.requireSupportedTask(task, st);
    const latest = st.events.findLast((e) => e.task === task.id && e.cmd === 'spawn');
    if (!latest) return false;
    if (latest.detail.agent !== spawn.agent || latest.detail.monitor_pid !== process.pid) return false;
    if (['accepted', 'cancelled'].includes(task.status) || spawn.role === 'worker' && task.status === 'submitted') return false;
    if (spawn.task_status === 'submitted' && (task.status !== 'submitted' || !shaMatch(task.sha, spawn.task_sha) || task.revision !== spawn.task_revision)) return false;
    if (task.claim && spawn.role === 'worker') {
      if (task.claim.agent !== spawn.agent) {
        if (claimedSince || !T.leaseExpired(task, Date.now())) return false;
      } else {
        if (claimedSince && claimedSince !== task.claim.since) return false;
        claimedSince ||= task.claim.since;
      }
    } else if (claimedSince) return false;
    // Log order decides, not the clock: a rework recorded after this spawn is newer.
    const since = st.events.lastIndexOf(latest);
    return !st.events.slice(since + 1).some((e) => e.task === task.id && ['release', 'rework', 'interrupt'].includes(e.cmd));
  };
  const setPhase = (name, reason, extra = {}) => {
    S.mutate(ctx, 'spawn phase', (st, emit) => {
      if (!valid(st)) return;
      st.rerender = true;
      emit(spawn.task, { ...detail(), phase: name, retry: attempt, reason: reason || null, ...extra });
    });
    phase = name;
  };
  const groupAlive = (pid) => {
    try { process.kill(-pid, 0); } catch (e) {
      if (e.code === 'ESRCH') return false;
      throw e;
    }
    if (process.platform !== 'linux') return true;
    // Orphan zombies cannot execute or hold a pipe open. A live descendant
    // with redirected stdio still has to exit before another attempt starts.
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) return true;
      } catch (e) { if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
    }
    return false;
  };
  // A git shim in the group may have died holding the git directory's
  // placeholder cleanup. Its marker is judged only from outside the command
  // sandboxes, so until a host cleanup ran, every sandboxed git call of the
  // other agents waited on it. This process is that host cleanup, right when
  // the marker is made. A sandbox can run the shim in a session of its own,
  // outside the group, that ends only when the sandbox is torn down after the
  // group, so a held directory is tried again for a short while. Each try
  // does not wait on a live holder, and the retries yield the event loop.
  const clearAfterGroup = async () => {
    if (!commonDir) return;
    const dir = path.join(commonDir, REAP_DIR);
    const deadline = performance.now() + CLEAR_RETRY_MS;
    for (;;) {
      try {
        clearPlaceholders(commonDir, { waitMs: 0, quiet: true });
      } catch (e) {
        process.stderr.write(`tower-crane: could not clear placeholders in ${commonDir}: ${e.message}\n`);
        return;
      }
      if (!fs.existsSync(dir) || performance.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const terminateGroup = (current) => {
    if (cleanupGroup) return;
    groupComplete = false;
    const signal = (name) => {
      if (process.platform === 'win32') {
        cp.spawnSync('taskkill', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      } else {
        try { process.kill(-current.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      }
    };
    // Windows cannot address descendants by process group after the parent
    // exits. Its released pid may already identify another CLI invocation.
    if (process.platform !== 'win32' || !exit) signal('SIGTERM');
    cleanupGroup = (async () => {
      const deadline = performance.now() + TERM_GRACE_MS;
      while (process.platform !== 'win32' && groupAlive(current.pid)) {
        if (performance.now() >= deadline) {
          signal('SIGKILL');
          const killDeadline = performance.now() + 2000;
          while (groupAlive(current.pid)) {
            if (performance.now() >= killDeadline) throw new Error(`process group ${current.pid} did not stop after SIGKILL`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await clearAfterGroup();
      groupComplete = true;
      wake();
    })();
    cleanupGroup.catch((e) => {
      retired = true;
      process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      wake();
    });
  };
  // A budget crossing stops the agent (budget.stop, operational) and asks the
  // owner, who alone raises a budget (budget.raise).
  const checkBudget = (st, emit) => {
    if (budgetStop) return;
    const over = T.budgetBreaches(st, T.getTask(st, spawn.task));
    if (!over.length) return;
    budgetStop = `budget: ${over.map(T.breachText).join('; ')}`;
    st.rerender = true;
    emit(spawn.task, { agent: spawn.agent, pid: child.pid, breaches: over, action: 'stop', authority: Authority.classOf('budget.stop') }, 'budget stop');
    for (const b of over) {
      const task = b.scope === 'project' ? null : b.scope;
      Authority.escalateQuestion(spawn.agent, st, emit, { settings: ['budget.raise'], change: { scope: b.scope, what: b.what, limit: b.limit } },
        `${spawn.agent} on ${spawn.task} was stopped: ${T.breachText(b)}. Raise the ${task ? `${task} task` : 'project'} ${b.what} budget to continue, or leave it stopped.`,
        'owner-required (docs/state.md#authority): the supervisor stopped the agent; only the owner raises a budget', task ? [task] : []);
    }
    emit(spawn.task, { ...detail(), phase: 'blocked', retry: attempt, reason: budgetStop }, 'spawn phase');
    phase = 'blocked';
  };
  // Read errors preserve measured usage; before any measurement they must
  // expose unavailable telemetry without publishing paths or error messages.
  const sampleUsage = (final = false) => {
    let parsed = null;
    let readError = null;
    let authoritative = false;
    try {
      // Claude results describe the invocation; session files and Codex
      // rollouts include earlier usage, so those retain the resume baseline.
      if (final && spawn.harness === 'claude') {
        parsed = Usage.readResult(spawn);
        authoritative = !!parsed;
      }
      if (!parsed) parsed = T.usageSince(Usage.readLive(spawn), liveBaseline);
    } catch (e) {
      if (liveKnown) return;
      const system = Number.isInteger(e.errno) && e.errno < 0 ? getSystemErrorName(e.errno) : '';
      readError = /^E[A-Z0-9_]+$/.test(system) ? system : 'Error';
    }
    const key = JSON.stringify([parsed, readError, authoritative]);
    if (key === liveLast) return;
    S.mutate(ctx, 'spend live', (st, emit) => {
      st.rerender = true;
      const entry = {
        at: nowIso(), agent: spawn.agent, minutes: 0, tokens: null, input: null, cached: null, output: null, ...parsed,
        rung: spawn.rung || null, harness: spawn.harness, model: parsed?.model || spawn.rung_config.model || null,
        profile: spawn.rung_config.profile || null, source: liveSource, billing: spawn.billing ?? null,
        live: { state: parsed ? 'live' : 'unavailable', interval_ms: config.usage_ms, ...(readError ? { error: readError } : {}) },
      };
      const provider = spawn.rung_config.provider;
      if (spawn.harness === 'claude' && provider) {
        entry.provider = provider;
        if (entry.model) entry.model = require('./claude-provider').model(provider, entry.model);
      }
      T.recordLive(st, emit, spawn.task, entry, { final, authoritative });
      checkBudget(st, emit);
    });
    liveLast = key;
    liveKnown ||= !!parsed;
  };
  const launch = (argv, initial = false, fallbackReason = null, fresh = false, inbox = [], overflowFallback = false) => {
    const start = (emit, st) => {
      let previous;
      if (fallbackReason) {
        let fallback;
        const firstIndex = (spawn.route_index || 0) + (overflowFallback ? 0 : 1);
        const endIndex = overflowFallback ? firstIndex + 1 : spawn.routes.length;
        for (let index = firstIndex; index < endIndex; index++) {
          // A paused harness, the one that just failed included, would reject the same login.
          if (st && !Health.usable(st, [spawn.routes[index]]).length) continue;
          try {
            fallback = { index, rung: spawn.routes[index], c: require('./spawn').fallbackCommand(spawn, spawn.routes[index], secrets) };
            // Only the route that runs takes a paused harness's probe interval.
            fallback.probe = st ? Health.admitted(st, emit, spawn.routes[index]) : null;
            break;
          } catch (e) {
            process.stderr.write(`tower-crane: skipping fallback ${index}: ${e.message}\n`);
          }
        }
        if (!fallback) return false;
        previous = { ...detail(), retry: attempt, code: exit.code, signal: exit.signal,
          ...(overflowFallback ? { overflowed: true } : {}) };
        const { index, rung, c, probe } = fallback;
        removeFilteredBrief(spawn.filteredBriefFile);
        Object.assign(spawn, {
          harness: rung.harness, rung_config: rung, route: rung, route_index: index, probe,
          prompt: c.prompt, subs: c.subs, owned_flags: c.iso?.flags || [], settings: c.settings,
          session_id: c.session_id || (rung.harness === 'command' ? crypto.randomUUID() : null),
          session_env: crypto.randomUUID(), filteredBriefFile: c.briefCopy?.file,
          codex_home: c.iso?.usageRoot || c.agentEnv.CODEX_HOME,
          claude_home: c.iso?.env.CLAUDE_CONFIG_DIR || c.agentEnv.CLAUDE_CONFIG_DIR || spawn.claude_home,
          browser_kit: c.iso?.browser_kit || null,
          git_env: c.iso?.gitEnv || {},
          agent_tmp: c.iso?.tmp || null,
          startup: c.startup, billing: c.billing,
        });
        gitEnv = spawn.git_env;
        if (spawn.browser_kit?.warning) process.stderr.write(`tower-crane: ${spawn.browser_kit.warning}\n`);
        for (const n of c.iso?.notices || []) process.stderr.write(`tower-crane: ${n}\n`);
        argv = c.argv;
        agentEnv = c.iso?.sandbox ? { ...c.agentEnv, ...brokerEnv } : c.agentEnv;
        sandboxed = !!c.iso?.sandbox;
        inbox = c.inbox;
        spawn.hook = c.env.TOWER_CRANE_HOOK;
        config = L.supervision(rung);
        attempt = 0;
        if (overflowFallback) {
          overflowRetried = true;
          fresh = true;
        }
        sessionRecorded = false;
        observedSession = c.session_id;
        spawn.log_start = fs.statSync(spawn.log).size;
        readSession = Sessions.logReader(spawn.log, spawn.harness, spawn.log_start);
      }
      exit = undefined;
      captureComplete = false;
      outputHeld = null;
      groupComplete = false;
      cleanupGroup = undefined;
      providerError = false;
      authError = null;
      harnessRefusal = false;
      contextOverflow = false;
      attemptOffset = fs.statSync(spawn.log).size;
      if (fresh) {
        spawn.log_start = attemptOffset;
        spawn.session_id = null;
        spawn.session_env = crypto.randomUUID();
        observedSession = null;
        readSession = Sessions.logReader(spawn.log, spawn.harness, attemptOffset);
      }
      if (!initial && !fallbackReason && spawn.harness === 'claude') {
        fresh = true;
        spawn.log_start = attemptOffset;
        spawn.session_id = argv[argv.indexOf('--session-id') + 1];
        observedSession = spawn.session_id;
        readSession = Sessions.logReader(spawn.log, spawn.harness, attemptOffset);
      }
      resumedSession = initial ? !!spawn.resumed || argv.includes('--resume') : !fresh && !fallbackReason;
      if (fresh) sessionRecorded = false;
      if (fallbackReason || fresh) {
        liveSource = T.spawnSource(spawn.agent, spawn.resumed, spawn.attempt, spawn.route_index, fresh ? attempt : null);
        liveLast = undefined;
        liveKnown = false;
      }
      if (initial || fallbackReason || fresh) {
        // A resumed session's file already holds earlier usage; only what this
        // segment adds is its own. Codex resumes measure from the dispatch's baseline.
        liveBaseline = initial && spawn.resumed && spawn.harness === 'codex' ? spawn.usage_before ?? null : undefined;
        if (spawn.harness === 'claude') {
          try { liveBaseline = Usage.readLive(spawn) || undefined; } catch { liveBaseline = null; }
        }
      }
      const reportHarness = (outage, auth) => {
        if (outage !== null) providerError = outage;
        authError ||= auth;
      };
      const reportOverflow = (overflow) => { contextOverflow = overflow; };
      const stdoutError = errorReader(spawn.harness, false, reportHarness, reportOverflow);
      const stderrError = errorReader(spawn.harness, true, reportHarness, reportOverflow);
      const hookReader = require('./hook-stream').reader(spawn.harness, hookSend);
      const ownEnv = { ...agentEnv, ...gitEnv, ...require('./agents').sessionBusEnv(spawn.harness, spawn.settings || {}, agentEnv), TOWER_CRANE_SESSION: spawn.session_id || spawn.session_env || spawn.agent, TOWER_CRANE_RETRY: String(attempt) };
      // A sandboxed harness runs its own git outside its sandbox, in the
      // worktree the agent writes.
      const launchEnv = require('./spawn-settings').cleanAgentEnv(sandboxed ? require('./harness-git').harnessEnv(ownEnv, spawn.cwd, gitPairs) : ownEnv);
      // A sandboxed agent holds no GitHub token, whether the dispatcher's
      // environment, a project or rung env or an env_file sets one: its
      // broker pushes and runs gh with the user's login (lib/github-broker.js).
      if (sandboxed) for (const key of Object.keys(launchEnv)) if (require('./github-broker').TOKEN_ENV.includes(key.toUpperCase())) delete launchEnv[key];
      // Enforce this after every settings merge, including route fallbacks.
      if (launchEnv.TOWER_CRANE_SANDBOX === '1') launchEnv.GH_CONFIG_DIR = path.join(launchEnv.HOME, '.config', 'gh');
      const launchArgv = require('./spawn').launchCommand(
        require('./spawn-settings').scopeCommand(spawn.settings || {}, argv), spawn.cwd, launchEnv);
      claudePlaceholders = spawn.harness === 'claude' && spawn.broker_harnesses?.includes('claude')
        ? { existed: ClaudeSandboxPlaceholders.present(spawn.cwd), cleaned: false }
        : null;
      // A worker's first launch waits for its lease, behind the gate or, after
      // a handshake, already past it. A rerun or fallback already holds it.
      const gated = initial && spawn.role === 'worker' && !spawn.handshake;
      const runArgv = gated ? [...LEASE_GATE, ...launchArgv] : launchArgv;
      // Descendants that leave the process group keep this variable, so they
      // can be found once the harness is gone (lib/processes.js strays).
      const mark = process.platform === 'win32' ? null : `TOWERCRANE_SPAWN_RUN_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
      const launchedAt = Date.now();
      child = cp.spawn(runArgv[0], runArgv.slice(1), {
        cwd: spawn.cwd, env: mark ? { ...launchEnv, [mark]: '1' } : launchEnv,
        stdio: [gated ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      });
      if (gated) {
        gateStdin = child.stdin;
        gateStdin.on('error', () => {});
      }
      // After a handshake the dispatch recorded the lease before this launch.
      awaitingLease = gated;
      const current = child;
      let captureError;
      const capture = (dest, readError) => (data) => {
        if (dest === process.stdout) hookReader(data);
        const result = readError(data);
        harnessRefusal ||= result.refusal;
        if (!captureError) {
          try { fs.writeFileSync(3, data); } catch (e) {
            captureError = e;
            process.stderr.write(`tower-crane: usage log capture failed: ${e.message}; retry spend ${spawn.task} --from-spawn ${spawn.agent}\n`);
          }
        }
        if (spawn.wait) dest.write(data);
      };
      child.stdout.on('data', capture(process.stdout, stdoutError));
      let stdoutEnded = false;
      child.stdout.on('end', () => {
        stdoutEnded = true;
        hookReader(null, true);
      });
      child.stderr.on('data', capture(process.stderr, stderrError));
      child.on('error', (e) => {
        if (child !== current) return;
        exit = { code: 1, signal: null, error: e.message };
        if (initial) writeReceipt(spawn.receipt, { error: e.message, code: e.code });
      });
      let outputClosed = false;
      let pipeArmed = false;
      let pipeTimer;
      // Output already read is kept; what the stopped holders still had
      // buffered arrives before the close, and only a holder that cannot be
      // stopped loses what it writes after the drain.
      const releaseOutput = async (exitedAt) => {
        let pids = [];
        let error = null;
        try {
          pids = await outputHolders(current, mark, launchedAt, exitedAt);
        } catch (e) { error = e.message; }
        if (outputClosed) return;
        outputHeld = { pids, ...(error ? { error } : {}) };
        process.stderr.write(`tower-crane: harness output stayed open ${TERM_GRACE_MS / 1000} s after the harness exited; `
          + `${pids.length ? `stopped ${pids.join(', ')}` : `found no process to stop${error ? ` (${error})` : ''}`}; closing it\n`);
        pipeTimer = setTimeout(() => {
          current.stdout.destroy();
          current.stderr.destroy();
        }, PIPE_DRAIN_MS);
      };
      const ended = (code, signal) => {
        if (child === current) {
          exit = { ...exit, code: exit?.error ? 1 : code, signal };
          if (current.pid) terminateGroup(current);
          else groupComplete = true;
          if (!outputClosed && !pipeArmed) {
            pipeArmed = true;
            const exitedAt = Date.now();
            const arm = () => {
              if (outputClosed) return;
              pipeTimer = setTimeout(() => {
                releaseOutput(exitedAt).catch((e) => process.stderr.write(`tower-crane: could not release harness output: ${e.message}\n`));
              }, TERM_GRACE_MS);
            };
            // A group that cannot be stopped fails the supervisor; its pipes still get released.
            Promise.resolve(cleanupGroup).then(arm, arm);
          }
          wake();
        }
      };
      child.on('exit', ended);
      child.on('close', (code, signal) => {
        outputClosed = true;
        clearTimeout(pipeTimer);
        ended(code, signal);
        if (!stdoutEnded) hookReader(null, true);
        if (child === current) {
          for (const readError of [stdoutError, stderrError]) {
            const result = readError(null, true);
            harnessRefusal ||= result.refusal;
          }
          captureComplete = true;
          wake();
        }
      });
      closed = new Promise((resolve) => child.once('close', resolve));
      if (!child.pid) return;
      childIdentity = P.identity(child.pid);
      if (initial) {
        writeReceipt(spawn.receipt, detail());
      } else {
        const current = { ...detail(), retry: attempt, session_id: spawn.session_id,
          ...(fresh ? { fresh: true, resumed: false } : {}),
          ...(fallbackReason ? { reason: fallbackReason, previous, resumed: false } : {}) };
        // Another route is another harness's prompt and rules.
        if (fallbackReason && spawn.startup) emit(spawn.task, { ...spawn.startup, route_index: spawn.route_index }, 'startup');
        emit(spawn.task, current);
        if (fallbackReason || fresh) initialDetail = current;
        emit(spawn.task, { ...detail(), phase: 'running', retry: attempt, reason: null }, 'spawn phase');
        phase = 'running';
      }
      lastProgress = performance.now();
      if (!initial) hookSend('inbox', { ids: inbox });
      stamp = pathProgress(spawn, config);
      cpu = P.cpuTicks(child.pid);
      nextSample = performance.now() + SAMPLE_MS;
      nextLive = performance.now() + config.usage_ms;
    };
    // Only a fallback rebuilds the command, and its gh token is read unlocked.
    const secrets = fallbackReason ? require('./spawn').fallbackSecrets(spawn) : null;
    if (initial) return start();
    return S.mutate(ctx, fallbackReason ? 'spawn fallback' : 'spawn retry', (st, emit) => {
      if (!valid(st)) { retired = true; return; }
      checkBudget(st, emit);
      if (budgetStop) return false;
      const started = start(emit, st);
      if (started !== false) st.rerender = true;
      return started;
    });
  };
  if (spawn.handshake) {
    // The dispatch holds the state lock until its spawn is recorded, so it
    // takes the lease itself, then opens go. Nothing runs here before launch,
    // so the wait blocks, as the dispatch's own wait for ready does.
    fs.writeFileSync(spawn.handshake.ready, '');
    const deadline = performance.now() + STARTUP_MS;
    while (!fs.existsSync(spawn.handshake.go)) {
      if (performance.now() >= deadline) {
        const reason = `no lease: it was not recorded within ${STARTUP_MS / 1000} s`;
        process.stderr.write(`tower-crane: ${reason}\n`);
        writeReceipt(spawn.receipt, { error: reason });
        return 1;
      }
      sleepSync(10);
    }
  }
  removeCommondir();
  if (commonDir) {
    try {
      commonWatcher = fs.watch(commonDir, (_, file) => {
        if (!file || String(file) === 'commondir') removeCommondir();
      });
      commonWatcher.on('error', () => commonWatcher.close());
      commonWatcher.unref();
    } catch {
      // The seconds-scale sampler below checks it too.
    }
  }
  launch(spawn.argv, true);
  if (!child.pid) return 1;
  // Startup runs while the dispatch CLI holds the state lock. Its spawn event
  // commits the job before supervision can renew or rerun it.
  const startupDeadline = performance.now() + STARTUP_MS;
  async function tick() {
    removeCommondir();
    if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
      // Without its state nothing the agent does can be recorded, and no
      // receipt or reaction can follow, so the agent is stopped, not left to spend.
      if (!exit && child.pid) {
        stopReason = `state directory ${spawn.state} is gone`;
        process.stderr.write(`tower-crane: supervision stopped: ${stopReason}; stopping ${spawn.agent}\n`);
        terminateGroup(child);
      }
      retired = true;
      return;
    }
    const eventStat = fs.statSync(path.join(spawn.state, 'events.jsonl'));
    const projectStat = fs.statSync(path.join(spawn.state, 'project.json'));
    const signature = `${eventStat.ino}:${eventStat.size}:${eventStat.mtimeMs}:${projectStat.ino}:${projectStat.size}:${projectStat.mtimeMs}`;
    if (!state || signature !== stateStamp) {
      state = S.loadState(spawn.state);
      stateStamp = signature;
    }
    const st = state;
    if (!committed) {
      initialDetail = st.events.find((e) => e.cmd === 'spawn' && e.task === spawn.task
        && e.detail.agent === spawn.agent && e.detail.monitor_pid === process.pid)?.detail;
      committed = !!initialDetail;
      if (!committed) {
        if (performance.now() >= startupDeadline) {
          // Without a recorded spawn no lease was taken, so a worker's harness is still behind its gate.
          stopReason = `${awaitingLease ? 'no lease: ' : ''}its spawn was not recorded within ${STARTUP_MS / 1000} s`;
          process.stderr.write(`tower-crane: ${stopReason}\n`);
          terminateGroup(child);
          retired = true;
        }
        return;
      }
      hookSend('inbox', { ids: spawn.inbox || [] });
    }
    recordRemovals();
    const id = observedSession || sessionFromLog(!!exit && captureComplete);
    if (id) {
      observedSession = id;
      spawn.session_id = id;
      if (!sessionRecorded) {
        try {
          Sessions.record({ ...ctx, task: spawn.task }, initialDetail, id, 0);
          sessionRecorded = true;
        } catch (e) { if (e.code !== 3) throw e; }
      }
    }
    if (require('./worktree').staleReason(st, T.getTask(st, spawn.task))) {
      process.stderr.write(`Tower Crane: ${spawn.task} is stale; stopping its agent before removing its worktree\n`);
      stop('stale');
      return;
    }
    if (interrupted(st)) {
      stop('interrupt');
      return;
    }
    // Ending the assignment ends lease keeping and retries. Its process can
    // still spend, so accounting and budget enforcement last until closure.
    const supervised = valid(st);
    if (!supervised) {
      nextRetry = undefined;
      clearTimeout(retryTimer);
      // A worker still behind its gate has nothing to wait for once it is retired.
      if (awaitingLease && !exit) {
        awaitingLease = false;
        stopReason = 'no lease: its spawn was superseded before its lease was taken';
        // A superseded spawn records no phase of its own, so its reason goes to the dispatch.
        process.stderr.write(`tower-crane: ${stopReason}\n`);
        stalled = true;
        terminateGroup(child);
      }
      if (exit && captureComplete && groupComplete) {
        retired = true;
        return;
      }
    }
    // The lease is taken before the gate opens, so no edit can precede it, and
    // a gate that exits first never ran its harness. A claim that is refused or
    // cannot be written stops the worker.
    if (awaitingLease && supervised && !exit) {
      awaitingLease = false;
      try {
        // A live lease the worker already holds keeps its length; only a new lease is taken.
        const current = T.getTask(st, spawn.task);
        if (current.claim?.agent !== spawn.agent || T.leaseExpired(current, Date.now())) T.claim({ ...ctx, pos: [spawn.task] });
        gateStdin.end('\n');
      } catch (e) {
        stopReason = `no lease: ${e.message}`;
        process.stderr.write(`tower-crane: ${stopReason}\n`);
        stalled = true;
        terminateGroup(child);
        return;
      }
    }
    const task = T.getTask(st, spawn.task);
    if (supervised && task.claim?.agent === spawn.agent && (!exit || !captureComplete || !groupComplete || nextRetry !== undefined)) {
      const grant = st.events.findLast((e) => e.task === task.id && e.agent === spawn.agent && ['claim', 'renew'].includes(e.cmd));
      const duration = grant ? Date.parse(grant.detail.until) - Date.parse(grant.at) : st.project.limits.lease_minutes * 60000;
      if (Date.parse(task.claim.until) - Date.now() <= duration / 2) {
        T.renew({ ...ctx, pos: [task.id], claimSince: claimedSince, flags: { lease: Math.max(1, Math.round(duration / 60000)) } });
      }
    }
    if (exit && (!captureComplete || !groupComplete)) return;
    if (exit) removeClaudePlaceholders();
    // A budget crossed or lowered during backoff cancels the queued paid attempt.
    if (nextRetry !== undefined && T.budgetBreaches(st, task).length) {
      S.mutate(ctx, 'budget stop', (current, emit) => {
        if (!valid(current)) { retired = true; return; }
        checkBudget(current, emit);
      });
      if (retired) return;
      if (budgetStop) {
        nextRetry = undefined;
        clearTimeout(retryTimer);
      }
    }
    if (nextRetry !== undefined) {
      if (performance.now() >= nextRetry) {
        const reason = exit.signal || `exit ${exit.code}`;
        const hooks = require('./harness-hooks');
        const inbox = freshRetry ? hooks.unread(S.readEvents(spawn.state), spawn.agent) : [];
        const prompt = [spawn.prompt, `Previous attempt exited with ${reason}; continue.`, hooks.context(inbox)].filter(Boolean).join('\n\n');
        const retry = freshRetry
          ? { argv: require('./spawn').buildCommand(spawn.role, spawn.rung_config, prompt, { ...spawn.subs, prompt }, agentEnv, spawn.owned_flags || [], null, spawn.state), inbox: inbox.map((e) => e.id) }
          : resume(spawn, spawn.session_id, reason, agentEnv);
        launch(retry.argv, false, null, freshRetry, retry.inbox);
        nextRetry = undefined;
      }
      return;
    }
    if (!exit && !budgetStop) {
      // The first reading waits one interval, so short runs record usage once, at exit.
      nextLive ??= performance.now() + config.usage_ms;
      if (performance.now() >= nextLive) {
        try { sampleUsage(); } finally {
          // A slow read or write must not shorten the next sampling interval.
          nextLive = performance.now() + config.usage_ms;
        }
      }
      if (!budgetStop && T.budgetBreaches(st, task).length) {
        // Another agent's usage or a lowered budget crossed a limit.
        S.mutate(ctx, 'budget stop', (current, emit) => {
          checkBudget(current, emit);
        });
      }
      if (retired) return;
      if (budgetStop) {
        terminateGroup(child);
        return;
      }
    }
    if (!supervised) return;
    if (!exit) {
      if (budgetStop) return;
      if (performance.now() < nextSample) return;
      nextSample = performance.now() + SAMPLE_MS;
      const current = pathProgress(spawn, config);
      const ticks = P.cpuTicks(child.pid);
      const progress = st.events.findLast((e) => e.task === task.id && e.agent === spawn.agent
        && !['claim', 'renew', 'spawn phase', 'spawn retry', 'stall', 'spend live', 'budget stop'].includes(e.cmd))?.id;
      const signature = `${current}|${progress || ''}`;
      if (signature !== stamp || ticks !== null && ticks !== cpu) {
        lastProgress = performance.now();
        stamp = signature;
        cpu = ticks;
        if (phase === 'blocked') setPhase('running');
      } else if (phase !== 'blocked' && performance.now() - lastProgress >= config.stall_ms && ticks !== null) {
        const reason = 'no progress paths or CPU activity';
        S.mutate(ctx, 'stall', (currentState, emit) => {
          if (!valid(currentState)) return;
          currentState.rerender = true;
          emit(spawn.task, { ...detail(), reason, source: JSON.stringify(['supervisor-stall', spawn.agent, child.pid, lastProgress]) });
          emit(spawn.task, { ...detail(), phase: 'blocked', retry: attempt, reason }, 'spawn phase');
        });
        phase = 'blocked';
        if (task.tier_range && spawn.role === 'worker') {
          stalled = true;
          stopReason = reason;
          terminateGroup(child);
        }
      }
      return;
    }
    // Short attempts can finish before the periodic sample. Account for every
    // harness here before a retry or fallback can spend again.
    sampleUsage(true);
    // A login failure is a harness outage: no same-route retry, and the harness
    // pauses until a probe finds its login working. Its exit is no task attempt.
    // Pi exits zero after recording the failure, so the exit code does not decide it.
    const loginFailed = !budgetStop && !!authError;
    if (loginFailed) {
      S.mutate(ctx, 'harness health', (st, emit) => Health.failed(st, emit, { harness: spawn.harness, agent: spawn.agent, reason: authError }));
    }
    if (!budgetStop && !stalled && !loginFailed && contextOverflow && resumedSession && !overflowRetried) {
      if (launch(null, false, 'session context overflow', false, [], true) !== false) return;
    }
    const retryable = !budgetStop && !stalled && !loginFailed && !contextOverflow && transient(exit.code, exit.signal, providerError);
    if (retryable && !spawn.session_id && spawn.harness === 'command') spawn.session_id = spawn.agent;
    const canResume = retryable && resume(spawn, spawn.session_id, exit.signal || `exit ${exit.code}`, agentEnv);
    freshRetry = !budgetStop && !contextOverflow && !canResume && providerError && (spawn.routes?.length || 0) > 1;
    if (!harnessRefusal && retryable && attempt < config.retries && (canResume || freshRetry)) {
      attempt++;
      const delay = Math.min(config.max_backoff_ms, config.backoff_ms * 2 ** (attempt - 1));
      nextRetry = performance.now() + delay;
      setPhase('retrying', exit.signal || `exit ${exit.code}`, { backoff_ms: delay, session_id: spawn.session_id });
      retryTimer = setTimeout(() => wake(), Math.min(delay, 2147483647));
      return;
    }
    if (!budgetStop && !contextOverflow && (harnessRefusal || loginFailed || providerError && exit.code !== 0 && attempt >= config.retries)
      && (spawn.route_index || 0) + 1 < (spawn.routes?.length || 0)) {
      if (launch(null, false, harnessRefusal ? 'harness refusal' : loginFailed ? LOGIN_FAILURE : `provider outage after ${attempt} retries`) !== false) return;
    }
    const reason = stopReason || budgetStop || (contextOverflow ? 'session context overflow'
      : harnessRefusal ? 'harness refusal; no fallback route remains'
      : loginFailed ? `${spawn.harness} login failed (${authError}); no fallback on another harness remains`
        : retryable ? (attempt >= config.retries ? `transient exit after ${attempt} retries`
          : `cannot resume ${spawn.harness} without a supported session`) : (exit.error || exit.signal || `exit ${exit.code}`));
    hookSend('stop', { hold: false });
    await hookQueue;
    // A supervisor stop stays blocked whatever code its harness exits with.
    const stopped = !!stopReason || !!budgetStop || stalled || contextOverflow || harnessRefusal || loginFailed || exit.code !== 0;
    S.mutate(ctx, 'spawn exit', (currentState, emit) => {
      if (!valid(currentState)) { retired = true; return; }
      currentState.rerender = true;
      // Only the probe admitted under this pause proves its login. Any other clean exit leaves the pause as it is.
      if (!stopped && spawn.probe && Health.probed(currentState, spawn.harness, spawn.probe)) Health.cleared(emit, spawn.harness, 'spawn');
      emit(spawn.task, { ...detail(), phase: stopped ? 'blocked' : 'waiting', retry: attempt, reason: stopped ? reason : null }, 'spawn phase');
    });
    retired = true;
  }
  let failed = false;
  const stop = (signal) => {
    stoppedBy = signal;
    retired = true;
    nextRetry = undefined;
    terminateGroup(child);
    wake();
  };
  const onTerm = () => stop('SIGTERM');
  const onInt = () => stop('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  await new Promise((resolve) => {
    let queued = false;
    wake = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(async () => {
        try { if (!retired) await tick(); } catch (e) {
          if (e.stateIncompatible) {
            incompatible = true;
            retired = true;
            nextRetry = undefined;
            // A gate still waiting for its lease has no work to finish, and no lease will open it.
            if (awaitingLease && !exit) {
              awaitingLease = false;
              terminateGroup(child);
              process.stderr.write(`tower-crane: supervision stopped: ${e.message}; stopping worker ${spawn.agent} before its lease was taken\n`);
            } else {
              process.stderr.write(`tower-crane: supervision stopped: ${e.message}; allowing worker ${spawn.agent} to finish without termination; recover the lease and collect usage with the upgraded tool after it exits\n`);
            }
          } else if (e.code !== 3) {
            failed = true;
            retired = true;
            terminateGroup(child);
            process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
          }
        } finally {
          queued = false;
          if (retired) {
            clearInterval(timer);
            clearTimeout(retryTimer);
            watcher?.close();
            resolve();
          }
        }
      });
    };
    timer = setInterval(wake, SAMPLE_MS);
    try { watcher = fs.watch(spawn.state, (_, file) => { if (!file || ['events.jsonl', 'project.json'].includes(String(file))) wake(); }); } catch {
      // The seconds-scale sampler also observes state when watching is unavailable.
    }
    watcher?.on('error', () => watcher.close());
    wake();
  });
  // A submit ends lease keeping and reruns. The process can still be writing
  // its final usage, so collection waits for stream closure.
  await closed;
  await cleanupGroup;
  removeClaudePlaceholders();
  // codex leaves a file its commands made; claude removes it after each command.
  commonWatcher?.close();
  removeCommondir();
  if (fs.existsSync(path.join(spawn.state, 'project.json'))) recordRemovals(true);
  if (committed && !incompatible && fs.existsSync(path.join(spawn.state, 'project.json'))) sampleUsage(true);
  removeFilteredBrief(spawn.filteredBriefFile);
  if (incompatible) {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    await hookQueue;
    return 1;
  }
  if (committed && !sessionRecorded && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    const id = observedSession || sessionFromLog(true);
    if (id) Sessions.record({ ...ctx, task: spawn.task }, initialDetail, id);
  }
  process.removeListener('SIGTERM', onTerm);
  process.removeListener('SIGINT', onInt);
  if (committed) {
    hookSend('stop', { hold: false });
    await hookQueue;
  }
  if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    S.mutate(ctx, 'spawn exit', (st, emit) => {
      const run = P.runPhase(st, T.getTask(st, spawn.task));
      const budgetActive = budgetStop && run?.agent === spawn.agent && run.active;
      if (stoppedBy === 'interrupt' || interrupted(st)) {
        st.rerender = true;
        emit(spawn.task, { ...detail(), phase: 'stopped', active: false, retry: attempt, reason: 'dispatch interrupted' }, 'spawn phase');
      } else if (budgetActive || (stoppedBy || failed) && valid(st)) {
        st.rerender = true;
        emit(spawn.task, { ...detail(), phase: 'blocked', retry: attempt,
          reason: budgetStop || (stoppedBy ? `supervisor stopped by ${stoppedBy}` : 'supervisor failed') }, 'spawn phase');
      }
      if (!st.events.some((e) => e.task === spawn.task && e.cmd === 'spawn exit'
        && e.detail.agent === spawn.agent && e.detail.pid === child.pid)) {
        const exitDetail = { ...detail(), code: exit?.code ?? null, signal: exit?.signal || null, retry: attempt,
          ...(contextOverflow ? { overflowed: true } : {}),
          // A supervisor failure is an availability failure, but the tool
          // failed, not the provider; the reviewer cap counts it (reviewer.js).
          ...(failed ? { supervisor_failed: true } : {}),
          ...(outputHeld ? { output_held: outputHeld } : {}),
          availability_failure: !!stoppedBy || failed || !stalled && (providerError || harnessRefusal || !!authError || transient(exit?.code, exit?.signal, false)) };
        emit(spawn.task, exitDetail);
        if (spawn.role === 'worker') {
          require('./escalation').capRespawns(st, emit, spawn.task, { cmd: 'spawn exit', task: spawn.task, detail: exitDetail }, spawn.agent);
        }
      }
    });
  }
  if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    const task = T.getTask(S.loadState(spawn.state), spawn.task);
    require('./worktree').retireTask(ctx, [{ id: task.id, sha: task.sha, revision: task.revision }]);
  }
  if (committed && !stoppedBy && !failed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    await require('./escalation').recover({ ...ctx, pos: [spawn.task] });
  }
  if (committed && !spawn.wait) collect({ ...spawn, ...detail(), host: spawn.host || detail().host });
  if (committed && fs.existsSync(path.join(spawn.state, 'project.json'))) {
    const events = S.readEvents(spawn.state).filter((e) => e.task === spawn.task
      && (e.cmd === 'submit' && e.agent === spawn.agent
        || e.cmd === 'evidence' && e.agent === spawn.agent && e.detail.type === 'review'
        || e.cmd === 'spawn exit' && e.detail.agent === spawn.agent));
    // Gates and merges run on the host in the dispatcher's environment, as
    // the orchestrator, never with this agent's home, shims or identity.
    // TOWER_CRANE_TMP overrides gates.tmp_root for the dispatch only; when
    // the project sets a root, these gates run under it.
    const hostEnv = { ...process.env };
    if (S.loadState(spawn.state).project.gates?.tmp_root) delete hostEnv.TOWER_CRANE_TMP;
    await require('./automation').consume({ ...ctx, env: hostEnv, cwd: spawn.cwd }, events, true);
  }
  // A login failure on the route that ended the dispatch is a failure, even when the harness exits zero.
  return failed || contextOverflow || harnessRefusal || stopReason || authError ? 1 : exit?.code ?? 1;
}

if (require.main === module) {
  // A foreground dispatch forwards the harness output through this process's
  // stdout and stderr. Once that dispatch is gone (an agent's output release
  // stops the spawn --wait it left running), the agent keeps working and its
  // log keeps every byte; only the forwarding ends.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error) => {
      if (error.code !== 'EPIPE') throw error;
      stream.destroy();
    });
  }
  const input = process.argv[2];
  const job = JSON.parse(input.startsWith('{') ? input : fs.readFileSync(input, 'utf8'));
  // Only the supervised agent sends its changes to a broker; this process
  // and the usage commands it runs write the state themselves.
  delete process.env.TOWER_CRANE_BROKER;
  // Env values the job file names but does not hold; no child inherits them
  // in this form.
  let secrets;
  try { secrets = Secrets.receive(process.env); } catch (e) { secrets = e; }
  if (job.argv) {
    let failure = null;
    process.on('exit', (code) => {
      if (receiptWritten || !job.receipt) return;
      try {
        S.writeAtomic(job.receipt, JSON.stringify({ error: failure, exit_code: code }));
      } catch {
        // The dispatch gave up and removed its receipt directory.
      }
    });
    Promise.resolve().then(() => {
      if (secrets instanceof Error) throw secrets;
      return supervise(secrets === undefined ? job : Secrets.join(job, secrets));
    }).then((code) => { process.exitCode = code; }).catch((e) => {
      removeFilteredBrief(job.filteredBriefFile);
      process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      failure = e.message;
      process.exitCode = 1;
    });
  } else collect(job);
}

module.exports = { running, record, transient, resume, errorReader };
