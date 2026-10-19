'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic, readPublished, updateJson } = require('../atomic-file');

// Each harness's own record for an expired login, in the shape its CLI prints.
function authRecord(harness, message) {
  if (harness === 'agy') return { status: 'ERROR', error: message };
  if (harness === 'opencode') return { type: 'error', error: { name: 'APIError', data: { message } } };
  if (harness === 'pi') return { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: message } };
  if (harness === 'claude') return { type: 'result', is_error: true, result: message };
  return { type: 'turn.failed', error: { message } };
}

if (process.env.TOWER_CRANE_TEST_CLAUDE_PROVIDER) {
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  const label = (file, args) => {
    if (file !== process.execPath) return path.basename(file) + (file === 'git' ? `:${args[0]}` : '');
    const index = args.findIndex((arg, i) => /\.(?:m?js|cjs)$/.test(arg) && !['--require', '-r'].includes(args[i - 1]));
    const script = path.basename(args[index] || 'node');
    return script === 'tower-crane.js' ? `cli:${args[index + 1]}` : script;
  };
  const profile = { process: label(process.execPath, process.argv.slice(1)), children: [], delays: [] };
  const started = now();
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[method];
    cp[method] = function providerProcess(file, args, ...rest) {
      // Engine hook and spend subprocesses must not expire under runner load.
      if (method !== 'spawn') {
        if (typeof rest[0] === 'function' || rest.length === 0) rest.unshift({ timeout: 0 });
        else rest[0] = { ...rest[0], timeout: 0 };
      }
      const child = { process: label(file, args), method, timeout: rest[0]?.timeout || 0 };
      profile.children.push(child);
      const start = now();
      if (method === 'execFile' && child.process === 'cli:hook') {
        // Hook delivery has separate integration coverage. Provider fixtures
        // keep the real claim command without competing hook writers.
        const writer = new (require('node:events').EventEmitter)();
        writer.stdin = new (require('node:stream').PassThrough)();
        writer.stdin.resume();
        child.process = 'hook callback';
        queueMicrotask(() => {
          child.ms = now() - start;
          rest.at(-1)(null, '', '');
          writer.emit('close', 0);
        });
        return writer;
      }
      let result;
      try { result = original.call(this, file, args, ...rest); }
      finally { if (method.endsWith('Sync')) child.ms = now() - start; }
      if (!method.endsWith('Sync')) result.once('close', () => { child.ms = now() - start; });
      return result;
    };
  }
  if (profile.process === 'spawn-monitor.js') {
    // Exit and stream events advance these fixtures; scheduling cannot expire a job.
    Object.defineProperty(require('node:perf_hooks').performance, 'now', { value: () => 0 });
    const schedule = global.setTimeout;
    // A wait is a timer that runs. A watchdog cleared before it expires, such
    // as the output release deadline, delays nothing.
    global.setTimeout = function providerDelay(fn, ms, ...args) {
      return schedule((...values) => {
        profile.delays.push(ms);
        return fn(...values);
      }, ms, ...args);
    };
    const ladder = require(path.join(path.dirname(process.argv[1]), 'ladder.js'));
    const supervision = ladder.supervision;
    ladder.supervision = (rung) => ({ ...supervision(rung), backoff_ms: 0, max_backoff_ms: 0 });
  }
  process.once('exit', () => {
    if (process.env.TOWER_CRANE_TEST_PROVIDER_TRACE) {
      fs.appendFileSync(process.env.TOWER_CRANE_TEST_PROVIDER_TRACE, JSON.stringify({ ...profile, ms: now() - started }) + '\n');
    }
  });
}

if (path.resolve(process.argv[1] || '') !== __filename) {
  if (process.env.TOWER_CRANE_TEST_VERIFIED_AGY === '1') {
    const agentsFile = path.join(path.dirname(path.dirname(process.argv[1])), 'lib', 'agents.js');
    if (fs.existsSync(agentsFile)) {
      const agents = require(agentsFile);
      agents.CAPABILITIES = { ...agents.CAPABILITIES, agy: { sandbox: true, osSandbox: true } };
    }
  }
  const spawn = cp.spawn;
  cp.spawn = function offlineHarness(file, args, options) {
    // The supervisor's lease gate starts its harness after `tower-crane-gate`.
    const gated = file === '/bin/sh' && args[2] === 'tower-crane-gate';
    const target = gated ? args[3] : file;
    const harness = /[\\/]scripts[\\/]fallback(?:\.exe)?$/.test(target) ? 'command' : target;
    if (['codex', 'claude', 'agy', 'opencode', 'pi', 'command'].includes(harness) && process.env.TOWER_CRANE_TEST_FALLBACK_FILE) {
      options = { ...options, env: require('../agent-env').fakeAgentEnv(options.env) };
      if (gated) return spawn.call(this, file, [...args.slice(0, 3), process.execPath, __filename, harness, ...args.slice(4)], options);
      return spawn.call(this, process.execPath, [__filename, harness, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const file = process.env.TOWER_CRANE_TEST_FALLBACK_FILE;
  // Nested dispatch needs the fixture adapter as well as the agent's account preload.
  const cli = (argv) => cp.execFileSync(process.execPath, [
    '--require', __filename,
    path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), ...argv,
  ], {
    encoding: 'utf8', timeout: process.env.TOWER_CRANE_TEST_CLAUDE_PROVIDER ? 0 : 300000, stdio: ['pipe', 'pipe', 'pipe'], // wait-allow: provider fixtures disable the child watchdog; the caller retains the suite hang guard
  });
  if (process.env.TOWER_CRANE_TEST_NESTED_DISPATCH && process.env.TOWER_CRANE_AGENT.startsWith('orchestrator-')) {
    const ladder = JSON.parse(cli(['ladder', 'show', '--json']));
    const dispatch = JSON.parse(cli(['spawn', '--task', 'T2', '--wait', '--json']));
    writeAtomic(process.env.TOWER_CRANE_TEST_NESTED_DISPATCH, JSON.stringify({
      config: process.env.TOWER_CRANE_CONFIG, home: process.env.HOME, ladder, dispatch,
    }));
    process.exit(0);
  }
  // A login flag file stands for a completed re-login: the primary route then works, unless the login is broken despite it.
  // Read before the attempt is recorded: a test removes the flag as soon as it sees the attempt.
  const relogged = Boolean(process.env.TOWER_CRANE_TEST_LOGIN_FLAG) && fs.existsSync(process.env.TOWER_CRANE_TEST_LOGIN_FLAG);
  // The first attempt claims the task. The record is built from CLI calls outside the lock and appended under it.
  let attempts;
  try {
    attempts = JSON.parse(readPublished(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    attempts = [];
  }
  const modelFlag = args.includes('-m') ? '-m' : harness === 'codex' ? '-p' : '--model';
  const model = args[args.indexOf(modelFlag) + 1];
  const providerTest = process.env.TOWER_CRANE_TEST_CLAUDE_PROVIDER;
  const providerEnv = providerTest ? {
    ...process.env,
    ...JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).env,
  } : {};
  const provider = providerTest ? providerEnv.CLAUDE_CODE_USE_BEDROCK === '1' ? 'bedrock' : 'anthropic' : null;
  if (!attempts.length) cli(['claim', process.env.TOWER_CRANE_TASK]);
  // Claim assertions need the real record, without another CLI per attempt.
  const claim = providerTest
    ? JSON.parse(fs.readFileSync(path.join(process.env.TOWER_CRANE_STATE, 'tasks.json'), 'utf8'))
      .tasks.find((task) => task.id === process.env.TOWER_CRANE_TASK).claim
    : JSON.parse(cli(['task', 'show', process.env.TOWER_CRANE_TASK, '--json'])).claim;
  const claudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claude = harness === 'claude' ? {
    mcp: JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers,
    sandbox: JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).sandbox,
    policy: JSON.parse(fs.readFileSync(path.join(claudeHome, 'policy.json'), 'utf8')),
  } : {};
  const attempt = {
    harness, model, args, session: process.env.TOWER_CRANE_SESSION, retry: process.env.TOWER_CRANE_RETRY,
    agent: process.env.TOWER_CRANE_AGENT, claim,
    env: process.env.ROUTE_ENV || null, broker: Boolean(process.env.TOWER_CRANE_BROKER),
    ...claude,
    node_test: Object.keys(process.env).filter((key) => /^NODE_TEST_/i.test(key)),
    ...(providerTest ? { provider, provider_env: Object.fromEntries([
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE',
      'ANTHROPIC_MODEL', 'AWS_PROFILE', 'AWS_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    ].map((key) => [key, providerEnv[key] || null])) } : {}),
  };
  if (process.env.TOWER_CRANE_TEST_FALLBACK_NOTE) cli(['task', 'note', process.env.TOWER_CRANE_TASK, `${harness} ${model} ${process.env.TOWER_CRANE_RETRY}`]);
  updateJson(file, (list) => [...list, attempt], []);
  // Edits a file while the primary runs, after dispatch read it.
  if (model === 'first' && process.env.TOWER_CRANE_TEST_FALLBACK_TOUCH) fs.appendFileSync(process.env.TOWER_CRANE_TEST_FALLBACK_TOUCH, 'CHANGED_AFTER_DISPATCH=1\n');
  if (harness === 'codex') {
    if (model !== 'first' || process.env.TOWER_CRANE_TEST_FALLBACK_REASON !== 'no-session') {
      console.log(JSON.stringify({ type: 'thread.started', thread_id: model === 'first' ? '11111111-1111-1111-1111-111111111111' : '22222222-2222-2222-2222-222222222222' }));
      const turns = Number(process.env.TOWER_CRANE_RETRY) + 1;
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 * turns, cached_input_tokens: 2 * turns, output_tokens: 3 * turns } }));
    }
  } else if (harness === 'agy') {
    console.log(JSON.stringify({ model, usage: { total_tokens: 12257, input_tokens: 10000,
      cache_read_tokens: 2000, output_tokens: 2257 } }));
  } else {
    console.log(JSON.stringify({ type: 'result', is_error: false, model,
      usage: { input_tokens: 20, output_tokens: 4 } }));
  }
  if (model === 'first' && (!relogged || process.env.TOWER_CRANE_TEST_LOGIN_BROKEN) || model === 'second' && process.env.TOWER_CRANE_TEST_FALLBACK_CHAIN
    || providerTest && provider === process.env.TOWER_CRANE_TEST_FAIL_PROVIDER) {
    if (process.env.TOWER_CRANE_TEST_FALLBACK_REASON === 'refusal') {
      console.log(JSON.stringify(harness === 'codex'
        ? { type: 'item.completed', item: { type: 'refusal', text: 'Request refused by policy' } }
        : { type: 'assistant', message: { stop_reason: 'refusal', content: [] } }));
      process.exit(0);
    }
    const type = process.env.TOWER_CRANE_TEST_FALLBACK_REASON;
    const auth = type === 'auth' || type === 'auth-stderr';
    const message = auth ? 'Failed to authenticate: OAuth session expired and could not be refreshed'
      : 'rate limit exceeded: The service is temporarily unavailable.';
    if (harness === 'agy' && !auth) console.error('HTTP 503 service unavailable');
    // An assistant record that quotes a login failure on stderr, from a run that succeeds.
    if (type === 'quoted-stderr') {
      const text = 'The task log says: Failed to authenticate: OAuth session expired and could not be refreshed';
      console.error(JSON.stringify(harness === 'codex'
        ? { type: 'item.completed', item: { type: 'agent_message', text } }
        : harness === 'agy' ? { status: 'SUCCESS', response: text }
          : { type: 'assistant', message: { content: [{ type: 'text', text }] } }));
      process.exit(0);
    }
    // A typed record on stderr is the case the supervisor must still read.
    if (type === 'auth-stderr') {
      console.error(JSON.stringify({ type: 'error', message }));
      process.exit(1);
    }
    // Codex's own plain-text wording for an expired login, as its CLI printed it.
    if (type === 'auth-text') {
      console.error('Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.');
      process.exit(1);
    }
    console.log(JSON.stringify(type === 'quoted'
      ? { type: 'item.completed', item: { type: 'agent_message', text: message + ' Request refused by policy' } }
      : ['signal', 'permanent'].includes(type) ? { type: 'error', message: 'invalid configuration' }
        : auth ? authRecord(harness, message)
          : harness === 'claude' ? { type: 'result', is_error: true, result: message }
            : { type: 'turn.failed', error: { message } }));
    // Pi records its failed turn and exits zero, as the real CLI does.
    process.exit(type === 'permanent' ? 2 : type === 'signal' ? 75 : auth && harness === 'pi' ? 0 : 1);
  }
  if (process.env.TOWER_CRANE_TEST_FALLBACK_FINISH) {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.TOWER_CRANE_TEST_FALLBACK_FINISH)) return;
      clearInterval(timer);
      // A login that expires while the worker runs: its last request fails with the harness's own record.
      if (process.env.TOWER_CRANE_TEST_LATE_AUTH) {
        console.log(JSON.stringify(authRecord(harness, 'Failed to authenticate: OAuth session expired and could not be refreshed')));
        process.exit(1);
      }
    }, 25);
  }
}
