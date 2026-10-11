'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
    if (['codex', 'claude', 'agy', 'command'].includes(harness) && process.env.TOWER_CRANE_TEST_FALLBACK_FILE) {
      if (gated) return spawn.call(this, file, [...args.slice(0, 3), process.execPath, __filename, harness, ...args.slice(4)], options);
      return spawn.call(this, process.execPath, [__filename, harness, ...args], options);
    }
    return spawn.call(this, file, args, options);
  };
} else {
  const harness = process.argv[2];
  const args = process.argv.slice(3);
  const file = process.env.TOWER_CRANE_TEST_FALLBACK_FILE;
  const cli = (argv) => cp.execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'tower-crane.js'), ...argv], {
    encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (process.env.TOWER_CRANE_TEST_NESTED_DISPATCH && process.env.TOWER_CRANE_AGENT.startsWith('orchestrator-')) {
    const ladder = JSON.parse(cli(['ladder', 'show', '--json']));
    const dispatch = JSON.parse(cli(['spawn', '--task', 'T2', '--wait', '--json']));
    fs.writeFileSync(process.env.TOWER_CRANE_TEST_NESTED_DISPATCH, JSON.stringify({
      config: process.env.TOWER_CRANE_CONFIG, home: process.env.HOME, ladder, dispatch,
    }));
    process.exit(0);
  }
  let attempts;
  try {
    attempts = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  const claudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claude = harness === 'claude' ? {
    mcp: JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers,
    sandbox: JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).sandbox,
    policy: JSON.parse(fs.readFileSync(path.join(claudeHome, 'policy.json'), 'utf8')),
  } : {};
  attempts.push({
    harness, model, args, session: process.env.TOWER_CRANE_SESSION, retry: process.env.TOWER_CRANE_RETRY,
    agent: process.env.TOWER_CRANE_AGENT, claim: JSON.parse(cli(['task', 'show', process.env.TOWER_CRANE_TASK, '--json'])).claim,
    env: process.env.ROUTE_ENV || null, broker: Boolean(process.env.TOWER_CRANE_BROKER),
    ...claude,
    node_test: Object.keys(process.env).filter((key) => /^NODE_TEST_/i.test(key)),
    ...(providerTest ? { provider, provider_env: Object.fromEntries([
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
      'ANTHROPIC_MODEL', 'AWS_PROFILE', 'AWS_REGION', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    ].map((key) => [key, providerEnv[key] || null])) } : {}),
  });
  if (process.env.TOWER_CRANE_TEST_FALLBACK_NOTE) cli(['task', 'note', process.env.TOWER_CRANE_TASK, `${harness} ${model} ${process.env.TOWER_CRANE_RETRY}`]);
  fs.writeFileSync(file, JSON.stringify(attempts));
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
  if (model === 'first' || model === 'second' && process.env.TOWER_CRANE_TEST_FALLBACK_CHAIN
    || providerTest && provider === process.env.TOWER_CRANE_TEST_FAIL_PROVIDER) {
    if (process.env.TOWER_CRANE_TEST_FALLBACK_REASON === 'refusal') {
      console.log(JSON.stringify(harness === 'codex'
        ? { type: 'item.completed', item: { type: 'refusal', text: 'Request refused by policy' } }
        : { type: 'assistant', message: { stop_reason: 'refusal', content: [] } }));
      process.exit(0);
    }
    const type = process.env.TOWER_CRANE_TEST_FALLBACK_REASON;
    const message = 'rate limit exceeded: The service is temporarily unavailable.';
    if (harness === 'agy') console.error('HTTP 503 service unavailable');
    console.log(JSON.stringify(type === 'quoted'
      ? { type: 'item.completed', item: { type: 'agent_message', text: message + ' Request refused by policy' } }
      : ['signal', 'permanent'].includes(type) ? { type: 'error', message: 'invalid configuration' }
        : harness === 'claude' ? { type: 'result', is_error: true, result: message }
          : { type: 'turn.failed', error: { message } }));
    process.exit(type === 'permanent' ? 2 : type === 'signal' ? 75 : 1);
  }
  if (process.env.TOWER_CRANE_TEST_FALLBACK_FINISH) {
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.TOWER_CRANE_TEST_FALLBACK_FINISH)) clearInterval(timer);
    }, 25);
  } else if (process.env.TOWER_CRANE_TEST_FALLBACK_HOLD) setTimeout(() => {}, Number(process.env.TOWER_CRANE_TEST_FALLBACK_HOLD));
}
