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

if (path.resolve(process.argv[1] || '') !== __filename) {
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_PAUSE_FINAL) {
    const usage = require(path.join(path.dirname(process.argv[1]), 'usage-files.js'));
    const readResult = usage.readResult;
    let paused = false;
    usage.readResult = function (...args) {
      if (!paused) {
        paused = true;
        const marker = process.env.LIVE_PAUSE_FINAL;
        fs.writeFileSync(marker, '');
        const deadline = Date.now() + 60000;
        while (!fs.existsSync(`${marker}.go`)) {
          if (Date.now() >= deadline) throw new Error('final sample was not released');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      return readResult.apply(this, args);
    };
  }
  if (path.basename(process.argv[1] || '') === 'spawn-monitor.js' && process.env.LIVE_READS) {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (typeof file === 'string' && /[\\/]projects[\\/].+\.jsonl$/.test(file)) {
        fs.appendFileSync(process.env.LIVE_READS, `${Date.now()}\n`);
      }
      return read.call(this, file, ...args);
    };
  }
  const spawn = cp.spawn;
  cp.spawn = function liveHarness(file, args, options) {
    if (['codex', 'claude', 'opencode', 'pi', 'agy'].includes(file) && process.env.LIVE_STEPS) {
      return spawn.call(this, process.execPath, [__filename, file, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const env = process.env;
  if (env.LIVE_ATTEMPTS) fs.appendFileSync(env.LIVE_ATTEMPTS, `${harness}\n`);
  if (!env.LIVE_NO_CLAIM) cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), 'claim', env.TOWER_CRANE_TASK], { stdio: 'ignore' });
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
  if (env.LIVE_FILE) fs.writeFileSync(env.LIVE_FILE, file);
  let step = 0;
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
    if (!file || env.LIVE_LOG_ONLY || env.LIVE_LOG_PREFIX && step === 1) console.log(JSON.stringify(record));
    if (final) {
      if (env.LIVE_FINAL_RESULT_TOKENS !== undefined) {
        const tokens = Number(env.LIVE_FINAL_RESULT_TOKENS);
        const output = Math.floor(tokens / 10);
        console.log(JSON.stringify({ type: 'result', usage: {
          input_tokens: tokens - output, cache_read_input_tokens: 0, output_tokens: output,
        } }));
      }
      fs.writeFileSync(env.LIVE_DONE, String(step));
      process.exit(70);
    }
    if (step === 1 && env.LIVE_CONTINUE) {
      const resume = setInterval(() => {
        if (!fs.existsSync(env.LIVE_CONTINUE)) return;
        clearInterval(resume);
        write();
      }, 25);
    } else if (step < steps) setTimeout(write, Number(env.LIVE_EVERY || 100));
    else {
      const finish = () => {
        if (env.LIVE_RESULT && harness === 'claude') console.log(JSON.stringify({
          type: 'result', usage: { input_tokens: step * (per - output), output_tokens: step * output },
        }));
        if (env.LIVE_OUTAGE) console.error('HTTP 503 service unavailable');
        fs.writeFileSync(env.LIVE_DONE, String(step));
        process.exit(Number(env.LIVE_EXIT || 0));
      };
      if (env.LIVE_COMPLETE) {
        setInterval(() => { if (fs.existsSync(env.LIVE_COMPLETE)) finish(); }, 25);
      } else if (env.LIVE_HOLD === 'until-stop') setInterval(() => {}, 1000);
      else setTimeout(finish, Number(env.LIVE_HOLD || 0));
    }
  };
  if (env.LIVE_UNREADABLE) {
    fs.mkdirSync(file);
    setInterval(() => {}, 1000);
  } else write();
  if (env.LIVE_FINISH) {
    setInterval(() => {
      if (fs.existsSync(env.LIVE_FINISH)) write(true);
    }, 25);
  }
}
