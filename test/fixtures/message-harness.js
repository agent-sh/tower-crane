'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const TOML = require('../../lib/toml');
const BIN = path.join(__dirname, '..', '..', 'bin', 'tower-crane.js');

async function main() {
  const harness = process.env.MESSAGE_HARNESS;
  const args = process.argv.slice(2);
  const prompt = args.find((a) => a.includes('## Task') || a.includes('## Rework') || a.includes('Previous attempt')) || '';
  const out = { prompt, turns: [], blocked: false };
  const cli = (...argv) => {
    const r = cp.spawnSync(process.execPath, [BIN, ...argv, '--agent', process.env.TOWER_CRANE_AGENT], { encoding: 'utf8', timeout: 15000 });
    if (r.status) throw new Error(r.stderr);
  };
  const event = (value) => console.log(JSON.stringify(value));
  const task = JSON.parse(cp.execFileSync(process.execPath, [BIN, 'task', 'show', 'T1', '--json', '--agent', process.env.TOWER_CRANE_AGENT]));
  if (!task.claim) cli('claim', 'T1');
  let plugin;
  const probe = process.env.MESSAGE_OPENCODE_PROBE;
  if (harness === 'opencode') {
    out.promptCalls = [];
    const url = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).plugin[0];
    plugin = await (await import(url)).TowerCrane({ client: { session: { promptAsync: async (p) => {
      out.promptCalls.push(p);
      if (out.promptCalls.length === 1 && probe === 'reject') throw new Error('prompt rejected');
      if (out.promptCalls.length === 1 && probe === 'error') return { error: { message: 'prompt rejected' } };
      out.blocked = true;
      out.turns.push(p.body);
      return { data: {} };
    } } } });
    await plugin['chat.message']({ sessionID: 'parent' }, { parts: [] });
  }
  if (harness === 'codex') {
    const sessions = path.join(process.env.CODEX_HOME, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'rollout-message-session.jsonl'), '{}\n');
  }
  event({ type: 'thread.started', thread_id: 'message-session' });
  if (process.env.MESSAGE_RESUME === '1' || process.env.MESSAGE_RETRY === '1' && Number(process.env.TOWER_CRANE_RETRY) > 0) {
    fs.writeFileSync(process.env.MESSAGE_OUT, JSON.stringify(out));
    return;
  }
  fs.writeFileSync(process.env.MESSAGE_READY, '');
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(process.env.MESSAGE_READY + '.go')) {
    if (Date.now() >= deadline) throw new Error('message test never released harness');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (harness === 'claude' && process.env.MESSAGE_HEADLESS) {
    // Stop is asked twice, so the test shows the hold is taken once. A resumed
    // turn reports, then ends with an empty final message.
    const mode = process.env.MESSAGE_HEADLESS;
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')));
    const hookWith = (name, body) => {
      const command = settings.hooks[name][0].hooks[0].command;
      const text = cp.execSync(command, {
        input: JSON.stringify({ hook_event_name: name, ...body }), encoding: 'utf8', timeout: 15000,
      }).trim();
      return text ? JSON.parse(text) : {};
    };
    const background = ['background', 'submitted'].includes(mode);
    const report = mode === 'silent' ? '' : 'last report from claude';
    const reports = mode === 'resumed' ? ['last report from claude', ''] : [report, report];
    if (background) out.turns.push(hookWith('PostToolUse', {
      tool_name: 'Bash', tool_input: { command: 'gh pr checks 1 --watch', run_in_background: true },
    }));
    if (mode === 'submitted') cli('submit', 'T1', '--sha', 'abcdef1');
    out.stops = reports.map((last) => hookWith('Stop', { last_assistant_message: last }));
    out.blocked = out.stops.some((stop) => stop.decision === 'block');
    fs.writeFileSync(process.env.MESSAGE_OUT, JSON.stringify(out));
    return;
  }
  if (harness === 'claude' || harness === 'codex' && process.env.MESSAGE_NOTIFY_ONLY !== '1') {
    const settings = harness === 'claude'
      ? JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')))
      : TOML.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));
    const hook = (name) => {
      const command = settings.hooks[name][0].hooks[0].command;
      const text = cp.execSync(command, {
        input: JSON.stringify({ hook_event_name: name, tool_name: 'Bash', agent: 'owner', task: 'T999', last_assistant_message: `last report from ${harness}` }),
        encoding: 'utf8', timeout: 15000,
      }).trim();
      return text ? JSON.parse(text) : {};
    };
    out.turns.push(hook('PostToolUse'));
    // A second message exercises the Stop gate after the first delivery.
    fs.writeFileSync(process.env.MESSAGE_READY + '.stop', '');
    while (!fs.existsSync(process.env.MESSAGE_READY + '.stop.go')) {
      if (Date.now() >= deadline) throw new Error('stop test never released harness');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const held = hook('Stop');
    out.blocked = held.decision === 'block';
    out.turns.push(held);
    out.turns.push(hook('UserPromptSubmit'));
    // An orchestrator's Stop holds while tasks are open; the test ends it.
    if (process.env.MESSAGE_ORCHESTRATOR !== '1') hook('Stop');
  } else if (harness === 'pi') {
    const handlers = {};
    const pi = { on: (name, fn) => { handlers[name] = fn; }, sendMessage: (m, options) => {
      out.blocked = options.triggerTurn;
      out.turns.push(m);
    } };
    const ext = args[args.indexOf('--extension') + 1];
    (await import(pathToFileURL(ext).href)).default(pi);
    out.turns.push(await handlers.tool_result({ toolName: 'bash', content: [] }));
    fs.writeFileSync(process.env.MESSAGE_READY + '.stop', '');
    while (!fs.existsSync(process.env.MESSAGE_READY + '.stop.go')) {
      if (Date.now() >= deadline) throw new Error('stop test never released harness');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'last report from pi' }] }] });
    await handlers.agent_end({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'last report from pi' }] }] });
    event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'last report from pi' }] } });
  } else if (harness === 'opencode') {
    const idle = (sessionID) => plugin.event({ event: { type: 'session.idle', properties: { sessionID } } });
    const receipts = () => fs.readFileSync(path.join(process.env.TOWER_CRANE_STATE, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(JSON.parse).filter((e) => e.cmd === 'hook inbox').flatMap((e) => e.detail.messages).length;
    if (probe) {
      if (probe === 'sessions') {
        await idle('unrelated');
        await idle('child');
        await plugin['chat.message']({ sessionID: 'child' }, { parts: [] });
        await plugin['tool.execute.after']({ sessionID: 'child', tool: 'bash' }, { output: 'child result' });
        await idle('child');
        out.unrelatedCalls = out.promptCalls.length;
        out.unrelatedReceipts = receipts();
      } else {
        try { await idle('parent'); } catch { /* The following idle must retry delivery. */ }
        out.failedReceipts = receipts();
      }
      await idle('parent');
      fs.writeFileSync(process.env.MESSAGE_OUT, JSON.stringify(out));
      return;
    }
    const output = { output: 'tool result' };
    await plugin['tool.execute.after']({ sessionID: 'parent', tool: 'bash' }, output);
    out.turns.push(output);
    fs.writeFileSync(process.env.MESSAGE_READY + '.stop', '');
    while (!fs.existsSync(process.env.MESSAGE_READY + '.stop.go')) {
      if (Date.now() >= deadline) throw new Error('stop test never released harness');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await idle('parent');
    event({ type: 'text', part: { text: 'last report from opencode' } });
  } else {
    event({ type: 'item.completed', item: { type: 'command_execution', command: 'build' } });
    event({ type: 'tool_execution_end', toolName: 'bash' });
    event({ type: 'result', result: `last report from ${harness}` });
    event({ type: 'item.completed', item: { type: 'agent_message', text: `last report from ${harness}` } });
    if (harness === 'codex') {
      const doc = TOML.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));
      cp.execFileSync(doc.notify[0], [...doc.notify.slice(1), JSON.stringify({
        type: 'agent-turn-complete', 'last-assistant-message': 'last report from codex', agent: 'owner',
      })]);
    }
  }
  if (process.env.MESSAGE_COMMANDS === '1') {
    const run = (tool, argv) => {
      const r = cp.spawnSync(tool, argv, { encoding: 'utf8', timeout: 15000, shell: process.platform === 'win32' });
      if (r.status !== 0) throw new Error(r.stderr || r.error?.message);
    };
    run('git', ['push', process.env.MESSAGE_REMOTE, 'HEAD:refs/heads/probe']);
    run('gh', ['pr', 'create', '--title', 'probe']);
  }
  if (process.env.MESSAGE_SUBMIT === '1') cli('submit', 'T1', '--sha', 'abcdef1');
  fs.writeFileSync(process.env.MESSAGE_OUT, JSON.stringify(out));
  if (process.env.MESSAGE_RETRY === '1') process.exitCode = 75;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
