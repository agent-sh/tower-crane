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
const Usage = require('./usage-files');
const Authority = require('./authority');
const { nowIso } = require('./util');
const Secrets = require('./secrets');
const { removeFilteredBrief } = require('./spawn');
const Health = require('./harness-health');
const RETRY_MS = 10 * 60 * 1000;
const LOGIN_FAILURE = 'harness login failure';
const SAMPLE_MS = L.MIN_USAGE_MS;
const TERM_GRACE_MS = 5000;

function running(spawn) {
  return !P.exited(spawn);
}

function record(state, task, agent, timeout = 30000, dispatchPath) {
  const env = { ...process.env };
  // The engine collector links PRs with the dispatcher's policy; the harness keeps its own.
  if (dispatchPath) env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'] = dispatchPath;
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
      const result = record(spawn.state, spawn.task, spawn.agent, timeout, spawn.dispatch_path);
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
// so the failure is a harness outage, not a task attempt. Returns the message.
function authFailure(text) {
  const match = /(?:\bfailed to authenticate\b|\boauth session expired\b|\bnot logged in\b|\b(?:sign|log) in again\b|\brefresh token\b[^"\n]*?\bexpired\b)[^"\n]*/i.exec(text);
  return match ? match[0].trim().slice(0, 200) : null;
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

// Only harness error envelopes and stderr are evidence of an outage. Tool
// output and assistant messages may quote the same errors while doing work.
function errorReader(harness, stderr, reportOutage) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let oversized = false;
  let refused = false;
  function record(text, envelope = false) {
    const outage = providerFailure(text, envelope);
    const auth = authFailure(text);
    // A later harness error record replaces an earlier recovered reconnect.
    if (envelope || outage) reportOutage(outage, auth);
    else if (auth) reportOutage(null, auth);
  }
  function line(text) {
    let value;
    try { value = JSON.parse(text); } catch {
      if (stderr) record(text);
      return;
    }
    if (!value || typeof value !== 'object') return;
    refused ||= refusal(value, harness);
    if (['codex', 'command'].includes(harness) && ['error', 'turn.failed'].includes(value.type)) {
      record(JSON.stringify(value.error || value.message || ''), true);
    } else if (['claude', 'command'].includes(harness)
      && (value.is_error === true || value.type === 'error' || value.api_error_status !== undefined)) {
      record(JSON.stringify({
        api_error_status: value.api_error_status, error: value.error, errors: value.errors,
        result: value.is_error ? value.result : undefined, message: value.message,
      }), true);
    } else if (stderr && value.type === undefined) {
      record(text);
    }
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
    return { refusal: refused };
  };
}

function resume(spawn, id, reason) {
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
  const argv = require('./spawn').buildCommand(spawn.role, rung, prompt, { ...spawn.subs, prompt }, process.env, spawn.owned_flags || [], warm ? id : null);
  return { argv, inbox: inbox.map((e) => e.id) };
}

function pathProgress(spawn, config) {
  const files = [spawn.log, ...config.progress_paths.map((p) => path.join(spawn.cwd, p))];
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

// A sandboxed agent's state changes reach the state through a broker this
// process runs for as long as it supervises the agent.
async function supervise(spawn) {
  try {
    return await superviseWithBroker(spawn);
  } finally {
    removeFilteredBrief(spawn.filteredBriefFile);
  }
}

async function superviseWithBroker(spawn) {
  // File values exist only in the harness environment, never in the job,
  // monitor environment or the state-writing subprocesses.
  let agentEnv;
  try {
    agentEnv = { ...process.env, ...require('./spawn-settings').agentEnv(spawn.settings || {}) };
  } catch (e) {
    S.writeAtomic(spawn.receipt, JSON.stringify({ error: e.message }));
    return 1;
  }
  let broker = null;
  if (spawn.broker) {
    try {
      broker = await require('./broker').start(spawn);
    } catch (e) {
      S.writeAtomic(spawn.receipt, JSON.stringify({ error: `state broker: ${e.message}` }));
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
  const ctx = { stateDir: spawn.state, agent: spawn.agent, env: process.env, flags: {}, pos: [] };
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
  let stamp;
  let cpu;
  let exit;
  let attemptOffset = 0;
  let providerError = false;
  let authError = null;
  let harnessRefusal = false;
  let stalled = false;
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
  let hookQueue = Promise.resolve();
  // Live usage of the current route segment, under the exit collector's key.
  let liveSource = T.spawnSource(spawn.agent, spawn.resumed, spawn.attempt, spawn.route_index, null);
  let liveBaseline;
  let liveLast;
  let liveKnown = false;
  let nextLive;
  let budgetStop = null;
  const hookSend = (action, payload = {}) => {
    if (!spawn.hook || incompatible) return;
    // Dispatch holds the state lock at startup; hook writers wait in children.
    hookQueue = hookQueue.then(() => new Promise((resolve) => {
      const writer = cp.execFile(process.execPath, [
        path.join(__dirname, '..', 'bin', 'tower-crane.js'), 'hook', action,
        '--binding', spawn.hook, '--state', spawn.state, '--agent', spawn.agent,
        '--payload', '-', '--json',
      ], { timeout: S.LOCK_WAIT_MS + 5000, windowsHide: true }, (error, _stdout, stderr) => {
        if (error) process.stderr.write(`tower-crane: harness event failed: ${stderr || error.message}\n`);
        resolve();
      });
      writer.stdin.on('error', () => {});
      writer.stdin.end(JSON.stringify(payload));
    }));
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
    route: spawn.route, route_index: spawn.route_index || 0, log_start: spawn.log_start || 0,
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
    if (spawn.task_status === 'submitted' && (task.status !== 'submitted' || task.sha !== spawn.task_sha || task.revision !== spawn.task_revision)) return false;
    if (task.claim && spawn.role === 'worker') {
      if (task.claim.agent !== spawn.agent) {
        if (claimedSince || !T.leaseExpired(task, Date.now())) return false;
      } else {
        if (claimedSince && claimedSince !== task.claim.since) return false;
        claimedSince ||= task.claim.since;
      }
    } else if (claimedSince) return false;
    return !st.events.some((e) => e.task === task.id && ['release', 'rework', 'interrupt'].includes(e.cmd) && Date.parse(e.at) >= Date.parse(latest.at));
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
        profile: spawn.rung_config.profile || null, source: liveSource,
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
  const launch = (argv, initial = false, fallbackReason = null, fresh = false, inbox = []) => {
    const start = (emit, st) => {
      let previous;
      if (fallbackReason) {
        let fallback;
        for (let index = (spawn.route_index || 0) + 1; index < spawn.routes.length; index++) {
          // A paused harness, the one that just failed included, would reject the same login.
          if (st && !Health.usable(st, [spawn.routes[index]]).length) continue;
          try {
            fallback = { index, rung: spawn.routes[index], c: require('./spawn').fallbackCommand(spawn, spawn.routes[index], secrets) };
            // Only the route that runs takes a paused harness's probe interval.
            if (st) Health.admitted(st, emit, [spawn.routes[index]]);
            break;
          } catch (e) {
            process.stderr.write(`tower-crane: skipping fallback ${index}: ${e.message}\n`);
          }
        }
        if (!fallback) return false;
        previous = { ...detail(), retry: attempt, code: exit.code, signal: exit.signal };
        const { index, rung, c } = fallback;
        removeFilteredBrief(spawn.filteredBriefFile);
        Object.assign(spawn, {
          harness: rung.harness, rung_config: rung, route: rung, route_index: index,
          prompt: c.prompt, subs: c.subs, owned_flags: c.iso?.flags || [], settings: c.settings,
          session_id: c.session_id || (rung.harness === 'command' ? crypto.randomUUID() : null),
          session_env: crypto.randomUUID(), filteredBriefFile: c.briefCopy?.file,
          codex_home: c.iso?.usageRoot || c.agentEnv.CODEX_HOME,
          claude_home: c.iso?.env.CLAUDE_CONFIG_DIR || c.agentEnv.CLAUDE_CONFIG_DIR || spawn.claude_home,
          browser_kit: c.iso?.browser_kit || null, startup: c.startup,
        });
        if (spawn.browser_kit?.warning) process.stderr.write(`tower-crane: ${spawn.browser_kit.warning}\n`);
        argv = c.argv;
        agentEnv = c.iso?.sandbox ? { ...c.agentEnv, ...brokerEnv } : c.agentEnv;
        inbox = c.inbox;
        spawn.hook = c.env.TOWER_CRANE_HOOK;
        config = L.supervision(rung);
        attempt = 0;
        sessionRecorded = false;
        observedSession = c.session_id;
        spawn.log_start = fs.statSync(spawn.log).size;
        readSession = Sessions.logReader(spawn.log, spawn.harness, spawn.log_start);
      }
      exit = undefined;
      captureComplete = false;
      groupComplete = false;
      cleanupGroup = undefined;
      providerError = false;
      authError = null;
      harnessRefusal = false;
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
      const stdoutError = errorReader(spawn.harness, false, reportHarness);
      const stderrError = errorReader(spawn.harness, true, reportHarness);
      const hookReader = require('./hook-stream').reader(spawn.harness, hookSend);
      const launchEnv = require('./spawn-settings').cleanAgentEnv({ ...agentEnv, TOWER_CRANE_SESSION: spawn.session_id || spawn.session_env || spawn.agent, TOWER_CRANE_RETRY: String(attempt) });
      const launchArgv = require('./spawn').launchCommand(
        require('./spawn-settings').scopeCommand(spawn.settings || {}, argv), spawn.cwd, launchEnv);
      child = cp.spawn(launchArgv[0], launchArgv.slice(1), {
        cwd: spawn.cwd, env: launchEnv,
        stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true,
      });
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
      child.stdout.on('end', () => hookReader(null, true));
      child.stderr.on('data', capture(process.stderr, stderrError));
      child.on('error', (e) => {
        if (child !== current) return;
        exit = { code: 1, signal: null, error: e.message };
        if (initial) S.writeAtomic(spawn.receipt, JSON.stringify({ error: e.message }));
      });
      const ended = (code, signal) => {
        if (child === current) {
          exit = { ...exit, code: exit?.error ? 1 : code, signal };
          if (current.pid) terminateGroup(current);
          else groupComplete = true;
          wake();
        }
      };
      child.on('exit', ended);
      child.on('close', (code, signal) => {
        ended(code, signal);
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
        S.writeAtomic(spawn.receipt, JSON.stringify(detail()));
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
  launch(spawn.argv, true);
  if (!child.pid) return 1;
  // Startup runs while the dispatch CLI holds the state lock. Its spawn event
  // commits the job before supervision can renew or rerun it.
  const startupDeadline = performance.now() + 10000;
  async function tick() {
    if (!fs.existsSync(path.join(spawn.state, 'project.json'))) {
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
          terminateGroup(child);
          retired = true;
        }
        return;
      }
      hookSend('inbox', { ids: spawn.inbox || [] });
    }
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
      if (exit && captureComplete && groupComplete) {
        retired = true;
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
          ? { argv: require('./spawn').buildCommand(spawn.role, spawn.rung_config, prompt, { ...spawn.subs, prompt }, process.env, spawn.owned_flags || []), inbox: inbox.map((e) => e.id) }
          : resume(spawn, spawn.session_id, reason);
        launch(retry.argv, false, null, freshRetry, retry.inbox);
        nextRetry = undefined;
      }
      return;
    }
    if (!exit && !budgetStop) {
      // The first reading waits one interval, so short runs record usage once, at exit.
      nextLive ??= performance.now() + config.usage_ms;
      if (performance.now() >= nextLive) {
        nextLive = performance.now() + config.usage_ms;
        sampleUsage();
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
    const loginFailed = !budgetStop && !!authError && exit.code !== 0;
    if (loginFailed) {
      S.mutate(ctx, 'harness health', (st, emit) => Health.failed(st, emit, { harness: spawn.harness, agent: spawn.agent, reason: authError }));
    }
    const retryable = !budgetStop && !stalled && !loginFailed && transient(exit.code, exit.signal, providerError);
    if (retryable && !spawn.session_id && spawn.harness === 'command') spawn.session_id = spawn.agent;
    const canResume = retryable && resume(spawn, spawn.session_id, exit.signal || `exit ${exit.code}`);
    freshRetry = !budgetStop && !canResume && providerError && (spawn.routes?.length || 0) > 1;
    if (!harnessRefusal && retryable && attempt < config.retries && (canResume || freshRetry)) {
      attempt++;
      const delay = Math.min(config.max_backoff_ms, config.backoff_ms * 2 ** (attempt - 1));
      nextRetry = performance.now() + delay;
      setPhase('retrying', exit.signal || `exit ${exit.code}`, { backoff_ms: delay, session_id: spawn.session_id });
      retryTimer = setTimeout(() => wake(), Math.min(delay, 2147483647));
      return;
    }
    if (!budgetStop && (harnessRefusal || loginFailed || providerError && exit.code !== 0 && attempt >= config.retries)
      && (spawn.route_index || 0) + 1 < (spawn.routes?.length || 0)) {
      if (launch(null, false, harnessRefusal ? 'harness refusal' : loginFailed ? LOGIN_FAILURE : `provider outage after ${attempt} retries`) !== false) return;
    }
    const reason = budgetStop || harnessRefusal ? budgetStop || 'harness refusal; no fallback route remains'
      : loginFailed ? `${spawn.harness} login failed (${authError}); no fallback on another harness remains`
        : retryable ? (attempt >= config.retries ? `transient exit after ${attempt} retries`
          : `cannot resume ${spawn.harness} without a supported session`) : (exit.error || exit.signal || `exit ${exit.code}`);
    hookSend('stop', { hold: false });
    await hookQueue;
    S.mutate(ctx, 'spawn exit', (currentState, emit) => {
      if (!valid(currentState)) { retired = true; return; }
      currentState.rerender = true;
      const done = exit.code === 0 && !harnessRefusal && !budgetStop && !stalled;
      // A clean exit on a paused harness proves its login, which clears the pause.
      if (done && !authError && Health.paused(currentState, spawn.harness)) Health.cleared(emit, spawn.harness, 'spawn');
      emit(spawn.task, { ...detail(), phase: done ? 'waiting' : 'blocked', retry: attempt, reason: done ? null : reason }, 'spawn phase');
      emit(spawn.task, { ...detail(), code: exit.code, signal: exit.signal, retry: attempt,
        availability_failure: !stalled && (providerError || harnessRefusal || retryable || loginFailed) });
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
            process.stderr.write(`tower-crane: supervision stopped: ${e.message}; allowing worker ${spawn.agent} to finish without termination; recover the lease and collect usage with the upgraded tool after it exits\n`);
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
        emit(spawn.task, { ...detail(), code: exit?.code ?? null, signal: exit?.signal || null, retry: attempt,
          availability_failure: !!stoppedBy || failed || !stalled && (providerError || harnessRefusal || !!authError && exit?.code !== 0 || transient(exit?.code, exit?.signal, false)) });
      }
    });
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
    // Gate and merge commands use the dispatcher's PATH; the exited agent's
    // policy shims remain in its own environment and deny those operations.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    const agentPath = process.env[pathKey];
    if (spawn.dispatch_path) process.env[pathKey] = spawn.dispatch_path;
    try {
      await require('./automation').consume({ ...ctx, cwd: spawn.cwd }, events, true);
    } finally {
      if (agentPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = agentPath;
    }
  }
  return failed || harnessRefusal ? 1 : exit?.code ?? 1;
}

if (require.main === module) {
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
    Promise.resolve().then(() => {
      if (secrets instanceof Error) throw secrets;
      return supervise(secrets === undefined ? job : Secrets.join(job, secrets));
    }).then((code) => { process.exitCode = code; }).catch((e) => {
      removeFilteredBrief(job.filteredBriefFile);
      process.stderr.write(`tower-crane: supervisor failed: ${e.message}\n`);
      process.exitCode = 1;
    });
  } else collect(job);
}

module.exports = { running, record, transient, resume, errorReader };
