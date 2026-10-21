'use strict';

// A claude or codex stand-in that writes its own session usage over time, the
// way each harness does while it runs: claude appends assistant messages to
// <CLAUDE_CONFIG_DIR>/projects/<slug>/<session id>.jsonl, codex appends
// cumulative token_count events to its rollout under CODEX_HOME. Preloaded
// with NODE_OPTIONS, it replaces the harness binary in the supervisor.
// LIVE_STEPS steps of LIVE_STEP_TOKENS tokens, one every LIVE_EVERY ms, then
// it holds for LIVE_HOLD ms or an explicit completion signal, writes LIVE_DONE
// and exits 0. Tests stop an "until-stop" hold through the supervisor.

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../atomic-file');

// LIVE_TRACE: the supervisor's usage reads, state writes and event-loop
// heartbeat, and the harness's steps, one line each, for a wait that hangs.
const trace = (what) => {
  if (!process.env.LIVE_TRACE) return;
  try { fs.appendFileSync(process.env.LIVE_TRACE, `${new Date().toISOString()} ${process.pid} ${what}\n`); } catch { /* a trace never fails the run */ }
};

if (path.resolve(process.argv[1] || '') !== __filename) {
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_TRACE) {
    const lib = path.dirname(process.argv[1]);
    const usage = require(path.join(lib, 'usage-files.js'));
    const S = require(path.join(lib, 'state.js'));
    for (const name of ['readLive', 'readResult']) {
      const read = usage[name];
      usage[name] = function (...args) {
        trace(`supervisor ${name} start`);
        try {
          const value = read.apply(this, args);
          trace(`supervisor ${name} ${value ? value.tokens : value}`);
          return value;
        } catch (e) { trace(`supervisor ${name} threw ${e.code || e.message}`); throw e; }
      };
    }
    const mutate = S.mutate;
    S.mutate = function (ctx, cmd, ...rest) {
      trace(`supervisor mutate ${cmd} start`);
      try { return mutate.call(this, ctx, cmd, ...rest); } catch (e) { trace(`supervisor mutate ${cmd} threw ${e.code ?? ''} ${e.message}`); throw e; } finally { trace(`supervisor mutate ${cmd} end`); }
    };
    const execFile = cp.execFile;
    cp.execFile = function (file, ...rest) {
      if (!/powershell/i.test(file) || typeof rest.at(-1) !== 'function') return execFile.call(this, file, ...rest);
      const started = performance.now();
      const done = rest.pop();
      return execFile.call(this, file, ...rest, (error, ...out) => {
        if (error || performance.now() - started > 5000) trace(`supervisor ${file} took ${Math.round(performance.now() - started)} ms${error ? `, failed: ${error.code ?? ''} ${error.signal ?? ''} ${error.message.slice(0, 200)}` : ''}`);
        done(error, ...out);
      });
    };
    const spawnChild = cp.spawn;
    cp.spawn = function (...args) {
      const child = spawnChild.apply(this, args);
      trace(`supervisor spawned ${path.basename(String(args[0]))} pid ${child.pid}`);
      child.on('exit', (code, signal) => trace(`supervisor saw pid ${child.pid} exit ${code} ${signal}`));
      const emit = child.emit;
      child.emit = function (name, ...rest) {
        if (['resourceLimit', 'error'].includes(name)) trace(`supervisor child ${child.pid} ${name} ${rest[0]?.message || rest[0]}`);
        return emit.call(this, name, ...rest);
      };
      return child;
    };
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (now - last > 1500) trace(`supervisor event loop was blocked ${Math.round(now - last)} ms`);
      last = now;
    }, 500).unref();
    process.on('exit', (code) => trace(`supervisor exit ${code}`));
  }
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_PAUSE_FINAL) {
    const usage = require(path.join(path.dirname(process.argv[1]), 'usage-files.js'));
    const readResult = usage.readResult;
    let paused = false;
    // How soon a supervisor sees its harness exit varies by platform: on
    // Windows a periodic sample can read the final record before the exit.
    // LIVE_FINAL_UNSAMPLED fixes the order where only the exit reading sees it.
    if (process.env.LIVE_FINAL_UNSAMPLED && process.env.LIVE_FINISH) {
      const readLive = usage.readLive;
      let before;
      usage.readLive = function (...args) {
        if (paused) return readLive.apply(this, args);
        if (fs.existsSync(process.env.LIVE_FINISH)) return before;
        before = readLive.apply(this, args);
        return before;
      };
    }
    usage.readResult = function (...args) {
      if (!paused) {
        paused = true;
        trace('supervisor paused before its final read');
        const marker = process.env.LIVE_PAUSE_FINAL;
        fs.writeFileSync(marker, '');
        const deadline = Date.now() + 300000;
        while (!fs.existsSync(`${marker}.go`)) {
          if (Date.now() >= deadline) throw new Error('final sample was not released');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      return readResult.apply(this, args);
    };
  }
  // LIVE_PID_REUSED: once the harness exits another process holds its pid, as
  // Windows hands a freed pid to a new process within seconds.
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_PID_REUSED) {
    const P = require(path.join(path.dirname(process.argv[1]), 'processes.js'));
    const processState = P.processState;
    P.processState = function (spawn, ...rest) { return spawn?.agent ? 'running' : processState.call(this, spawn, ...rest); };
  }
  // LIVE_TASKKILL_TIMEOUT: taskkill outlasts its timeout and stops nothing, as
  // on a loaded Windows runner.
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_TASKKILL_TIMEOUT) {
    const spawnSync = cp.spawnSync;
    cp.spawnSync = function (file, ...rest) {
      if (file !== 'taskkill') return spawnSync.call(this, file, ...rest);
      fs.appendFileSync(process.env.LIVE_TASKKILL_TIMEOUT, `${rest[0].join(' ')}\n`);
      return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
    };
  }
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_READS) {
    const read = fs.readFileSync;
    let delayed = false;
    fs.readFileSync = function (file, ...args) {
      if (typeof file === 'string' && /[\\/]projects[\\/].+\.jsonl$/.test(file)) {
        if (!delayed && process.env.LIVE_READ_DELAY_MS) {
          delayed = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.LIVE_READ_DELAY_MS)); // wait-allow: the configured slow read is the fixture's behaviour
        }
        fs.appendFileSync(process.env.LIVE_READS, `${performance.now()}\n`);
      }
      return read.call(this, file, ...args);
    };
  }
  const spawn = cp.spawn;
  cp.spawn = function liveHarness(file, args, options) {
    // The supervisor's lease gate starts its harness after `tower-crane-gate`.
    const gated = file === '/bin/sh' && args[2] === 'tower-crane-gate';
    const harness = gated ? args[3] : file;
    if (['codex', 'claude', 'opencode', 'pi', 'agy'].includes(harness) && process.env.LIVE_STEPS) {
      if (gated) return spawn.call(this, file, [...args.slice(0, 3), process.execPath, __filename, ...args.slice(3)], options);
      return spawn.call(this, process.execPath, [__filename, file, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const env = process.env;
  if (env.LIVE_ATTEMPTS) fs.appendFileSync(env.LIVE_ATTEMPTS, `${harness}\n`);
  if (!env.LIVE_NO_CLAIM) cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', env.TOWER_CRANE_TASK], { env: require('../agent-env').fakeAgentEnv(process.env), stdio: 'ignore' });
  const steps = Number(env.LIVE_STEPS);
  const per = Number(env.LIVE_STEP_TOKENS || 1000);
  let file;
  if (harness === 'claude') {
    const id = args[args.indexOf('--session-id') + 1];
    file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  } else if (harness === 'codex') {
    const id = '01a11297-1067-7831-a3bc-2c04eac9aaef';
    console.log(JSON.stringify({ type: 'thread.started', thread_id: id }));
    file = path.join(env.CODEX_HOME, 'sessions', '2026', '10', '07', `rollout-2026-10-07T00-00-00-${id}.jsonl`);
  }
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  if (env.LIVE_FILE) writeAtomic(env.LIVE_FILE, file);
  let step = 0;
  trace(`harness ${harness} started`);
  process.on('exit', (code) => trace(`harness exit ${code}`));
  // Exit once both streams have flushed: a pipe write can still be pending,
  // and process.exit would drop the final usage the supervisor reads.
  const exit = (code) => process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
  const write = (final = false) => {
    step += 1;
    const output = Math.floor(per / 10);
    const record = {
      claude: { type: 'assistant', message: { id: `msg-${step}`, model: 'live-model', usage: {
        input_tokens: per - output, output_tokens: output,
        ...(env.LIVE_CACHED !== undefined ? { cache_read_input_tokens: Number(env.LIVE_CACHED) } : {}),
      } } },
      codex: { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: step * (per - output), cached_input_tokens: 0, output_tokens: step * output, total_tokens: step * per,
      } } } },
      opencode: { type: 'step_finish', part: { id: `step-${step}`, tokens: { input: per - output, output } } },
      pi: { type: 'message_end', message: { role: 'assistant', usage: { input: per - output, output } } },
      agy: { usage: { input_tokens: step * (per - output), output_tokens: step * output } },
    }[harness];
    if (file && !env.LIVE_LOG_ONLY) fs.appendFileSync(file, JSON.stringify(record) + '\n');
    trace(`harness wrote step ${step}${final ? ' (final)' : ''}`);
    if (!file || env.LIVE_LOG_ONLY || env.LIVE_LOG_PREFIX && step === 1) console.log(JSON.stringify(record));
    if (final) {
      if (env.LIVE_FINAL_RESULT_TOKENS !== undefined) {
        const tokens = Number(env.LIVE_FINAL_RESULT_TOKENS);
        const output = Math.floor(tokens / 10);
        console.log(JSON.stringify({ type: 'result', usage: {
          input_tokens: tokens - output, cache_read_input_tokens: 0, output_tokens: output,
        } }));
      }
      writeAtomic(env.LIVE_DONE, String(step));
      // A held harness leaves its final record to the periodic sampler.
      if (env.LIVE_FINAL_HOLD) return;
      exit(70);
      return;
    }
    if (step === 1 && env.LIVE_CONTINUE) {
      const resume = setInterval(() => {
        if (!fs.existsSync(env.LIVE_CONTINUE)) return;
        clearInterval(resume);
        write();
      }, 25);
    } else if (step < steps) setTimeout(write, Number(env.LIVE_EVERY || 100)); // wait-allow: model periodic telemetry samples while the harness is live
    else {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (env.LIVE_RESULT && harness === 'claude') console.log(JSON.stringify({
          type: 'result', usage: { input_tokens: step * (per - output), output_tokens: step * output },
        }));
        if (env.LIVE_OUTAGE) console.error('HTTP 503 service unavailable');
        writeAtomic(env.LIVE_DONE, String(step));
        exit(Number(env.LIVE_EXIT || 0));
      };
      if (env.LIVE_COMPLETE) {
        setInterval(() => { if (fs.existsSync(env.LIVE_COMPLETE)) finish(); }, 25);
      } else if (env.LIVE_HOLD === 'until-stop') setInterval(() => {}, 1000);
      else setTimeout(finish, Number(env.LIVE_HOLD || 0)); // wait-allow: fixture simulates harness exit after emitting its usage
    }
  };
  if (env.LIVE_UNREADABLE) {
    fs.mkdirSync(file);
    setInterval(() => {}, 1000);
  } else write();
  if (env.LIVE_FINISH) {
    const finishing = setInterval(() => {
      if (!fs.existsSync(env.LIVE_FINISH)) return;
      clearInterval(finishing);
      write(true);
    }, 25);
  }
}
