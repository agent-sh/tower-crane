'use strict';

const { waitOnRepo } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { makeRepo, BIN, ROOT } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'message-harness.js');
const MOD = path.join(ROOT, 'hooks', 'tower-crane.mjs');
const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const size = (h) => fs.statSync(path.join(h.state, 'events.jsonl')).size;



function setup(t) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Wake', '--acceptance', 'events arrive']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'wake the orchestrator\n' });
  return h;
}

// What a pushed notice may say: event ids and kinds, never what was written.
function idOnly(text, secrets) {
  for (const secret of secrets) assert.ok(!text.includes(secret), `push carried content: ${secret}`);
}

test('the default wait wakes on every owner event and skips bookkeeping', async (t) => {
  const h = setup(t);
  h.ok(['claim', 'T1', '--agent', 'worker']);
  let after = size(h);
  h.ok(['renew', 'T1', '--agent', 'worker']);
  h.ok(['msg', '--to', 'worker', '--task', 'T1', 'owner aside to the worker', '--agent', 'owner']);
  const owner = h.run(['wait', '--agent', 'orchestrator', '--after', String(after), '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(owner.code, 0, owner.stdout || owner.stderr);
  const e = JSON.parse(owner.stdout);
  assert.equal(e.type, 'worker-message');
  assert.equal(e.agent, 'owner');
  assert.equal(e.to, 'worker');
  const all = h.json(['wait', '--agent', 'orchestrator', '--after', String(after), '--types', 'all', '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(all.type, 'renew');
  after = size(h);
  h.ok(['msg', '--to', 'orchestrator-T1-1', 'addressed by name', '--agent', 'worker']);
  const named = h.json(['wait', '--agent', 'orchestrator-T1-1', '--after', String(after), '--timeout', '0.1']); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
  assert.equal(named.detail.text, 'addressed by name');
});

test('wait --follow streams id-only lines and event prints the content', async (t) => {
  const h = setup(t);
  h.ok(['ask', '--question', 'which way?', '--option', 'left', '--option', 'right', '--blocks', 'T1', '--agent', 'worker']);
  const p = cp.spawn(process.execPath, [BIN, 'wait', '--follow', '--agent', 'orchestrator'], { cwd: h.repo, env: h.env });
  t.after(() => p.kill());
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map(JSON.parse);
  await waitOnRepo(h, () => lines().some((l) => l.type === 'ready'), 'the ready line');
  h.ok(['answer', 'D1', '--choice', 'right', '--note', 'private answer note', '--agent', 'owner']);
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'private worker text', '--agent', 'worker']);
  const wakes = await waitOnRepo(h, () => lines().length >= 3 && lines().slice(1), 'two wake lines');
  assert.deepEqual(wakes.map((w) => w.type), ['decision-answer', 'worker-message']);
  assert.equal(wakes[0].decision, 'D1');
  idOnly(out, ['private answer note', 'private worker text', 'right']);
  for (const w of wakes) assert.equal(w.detail, undefined);
  const shown = h.json(['event', wakes[1].id, '--agent', 'orchestrator']);
  assert.equal(shown.detail.text, 'private worker text');
  assert.equal(h.run(['event', 'Enope', '--agent', 'orchestrator']).code, 2);
});

// A real spawn on the orchestrator rung: the stub harness runs the hooks its
// generated home configures, the way Claude Code and Codex call them.
for (const harness of ['claude', 'codex']) {
  test(`${harness}: an orchestrator home wakes on a worker message and a decision answer`, async (t) => {
    const h = setup(t);
    const ready = path.join(h.base, 'ready');
    const out = path.join(h.base, 'report.json');
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    const program = path.join(bin, harness + (process.platform === 'win32' ? '.exe' : ''));
    fs.writeFileSync(program, `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`, { mode: 0o755 });
    const preload = path.join(h.base, 'native.js');
    fs.writeFileSync(preload, `const cp = require('node:child_process');\nconst spawn = cp.spawn;\ncp.spawn = function(cmd, args, opts) { return cmd === ${JSON.stringify(harness)} ? spawn.call(this, process.execPath, [${JSON.stringify(program)}, ...args], opts) : spawn.call(this, cmd, args, opts); };\n`);
    const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
    Object.assign(h.env, {
      MESSAGE_HARNESS: harness, MESSAGE_READY: ready, MESSAGE_OUT: out, MESSAGE_ORCHESTRATOR: '1',
      [pathKey]: bin + path.delimiter + (h.env[pathKey] || ''),
      CODEX_HOME: path.join(h.base, 'codex'), CLAUDE_CONFIG_DIR: path.join(h.base, 'claude'),
      ...(process.platform === 'win32' ? { NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"` } : {}),
    });
    h.ok(['ladder', 'set', 'orchestrator', '--harness', harness, '--model', 'stub-model', '--clear', 'profile', '--clear', 'effort']);
    h.ok(['ask', '--question', 'ship it?', '--option', 'yes', '--option', 'no', '--agent', 'worker']);
    const run = h.runAsync(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait', '--json']);
    let early = null;
    run.then((r) => { early = r; });
    await waitOnRepo(h, () => fs.existsSync(ready) || (early && assert.fail(`spawn ended: ${early.code} ${early.stderr} ${early.stdout}`)), "the harness");
    const binding = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'orchestrator-T1-1', 'hook.json'), 'utf8'));
    assert.equal(binding.role, 'orchestrator');
    const home = path.join(h.state, 'homes', 'orchestrator-T1-1');
    const settings = harness === 'claude'
      ? JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).hooks
      : require('../lib/toml').parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).hooks;
    const servers = harness === 'claude'
      ? JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')).mcpServers
      : require('../lib/toml').parse(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).mcp_servers;
    assert.ok(servers['tower-crane'].args.includes('mcp'));
    assert.ok(servers['tower-crane'].args.includes('orchestrator-T1-1'));
    assert.equal(settings.Stop[0].hooks[0].timeout, 86400, 'an orchestrator Stop outlives a long idle');
    h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'private worker report', '--agent', 'worker']);
    const message = log(h).findLast((e) => e.cmd === 'msg').id;
    assert.equal(h.run(['wait', '--inbox', '--observe', '--after', '0', '--types', 'never', '--timeout', '0.01', '--agent', 'orchestrator']).code, 2); // wait-allow: verify the CLI observation, filtering or timeout contract with already-published state
    fs.writeFileSync(ready + '.go', '');
    await waitOnRepo(h, () => fs.existsSync(ready + '.stop'), 'the Stop hook');
    fs.writeFileSync(ready + '.stop.go', '');
    // Stop finds nothing pending and holds until the owner answers.
    await new Promise((resolve) => setTimeout(resolve, 300)); // wait-allow: let Stop enter its pending-answer wait before publishing the answer
    h.ok(['answer', 'D1', '--choice', 'yes', '--note', 'private owner note', '--agent', 'owner']);
    const answer = log(h).findLast((e) => e.cmd === 'answer').id;
    const result = await run;
    assert.equal(result.code, 0, result.stderr);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    const [tool, stop] = seen.turns;
    assert.match(tool.hookSpecificOutput.additionalContext, new RegExp(`${message}: worker-message T1 from worker`));
    assert.equal(seen.blocked, true, 'Stop must block with the answer');
    assert.match(stop.reason, new RegExp(`${answer}: decision-answer D1 from owner`));
    idOnly(JSON.stringify(seen.turns), ['private worker report', 'private owner note']);
    const delivered = log(h).filter((e) => e.cmd === 'hook inbox' && e.agent === 'orchestrator-T1-1').flatMap((e) => e.detail.messages);
    assert.ok(delivered.includes(message) && delivered.includes(answer));
  });
}

// A stand-in for the engine's $ with real child processes, so the mod runs
// the shipped CLI exactly as a Claude Code session would.
function engine(t, h) {
  const hooks = {};
  const on = (event, matcher, fn) => {
    if (typeof matcher === 'function') [fn, matcher] = [matcher, null];
    const entry = { matcher, fn };
    (hooks[event] ||= []).push(entry);
    // The engine answers with this handler when the hook throws.
    return { catch: (handler) => { entry.fallback = handler; } };
  };
  const seen = { prompts: [], appended: [], toasts: [], tools: [], commands: [] };
  const children = [];
  t.after(() => { for (const p of children) p.kill(); });
  async function* spawn({ argv }) {
    assert.equal(argv[0], 'node');
    const p = cp.spawn(process.execPath, argv.slice(1), { cwd: h.repo, env: h.env });
    children.push(p);
    const queue = [];
    let wake = null;
    let ended = false;
    const push = (chunk) => { queue.push(chunk); wake?.(); };
    p.stdout.on('data', (d) => push({ stream: 'stdout', text: String(d) }));
    p.stderr.on('data', (d) => push({ stream: 'stderr', text: String(d) }));
    p.on('close', () => { ended = true; wake?.(); });
    try {
      for (;;) {
        if (queue.length) yield queue.shift();
        else if (ended) return { code: p.exitCode, signal: p.signalCode };
        else await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      p.kill();
    }
  }
  const $ = {
    plugin: { name: 'tower-crane', root: ROOT },
    env: { get: async (name) => ({ TOWER_CRANE_STATE: h.state })[name] },
    tool: { register: async (spec) => { seen.tools.push(spec); return { tool: `mcp__tower-crane__${spec.name}` }; } },
    command: { register: async (spec) => { seen.commands.push(spec); } },
    prompt: { submit: async (p) => { seen.prompts.push(p.text); return { text: p.text }; } },
    session: { append: async (a) => { seen.appended.push(a.message.content[0].text); return {}; } },
    ui: { status() {}, toast: (text) => seen.toasts.push(text) },
    process: { spawn },
  };
  const fire = (event, e, match = () => true) => {
    const hook = hooks[event].find((x) => match(x.matcher));
    return hook.fn($, e, async (x) => x);
  };
  return { $, on, seen, fire };
}

test('the Claude Code mod pushes a decision answer and a worker message into the session', async (t) => {
  const h = setup(t);
  h.ok(['ask', '--question', 'merge now?', '--option', 'yes', '--option', 'later', '--agent', 'worker']);
  const { register } = await import(pathToFileURL(MOD).href);
  const cc = engine(t, h);
  register(cc.on);
  await cc.fire('session.start', { cwd: h.repo, isInteractive: true });
  assert.deepEqual(cc.seen.tools.map((x) => x.name), ['watch']);
  const armed = await cc.fire('tool.call', { tool: 'mcp__tower-crane__watch', tool_use_id: 'u1', after: String(size(h)), agent: 'orchestrator' });
  assert.match(armed.result, /tower-crane inbox/);
  // The follower takes its cursor from the call, so writes from here on count.
  h.ok(['answer', 'D1', '--choice', 'later', '--note', 'private owner note', '--agent', 'owner']);
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'private worker text', '--agent', 'worker']);
  const answer = log(h).findLast((e) => e.cmd === 'answer').id;
  const message = log(h).findLast((e) => e.cmd === 'msg').id;
  const pushed = await waitOnRepo(h, () => {
    const text = cc.seen.prompts.join('\n');
    return text.includes(answer) && text.includes(message) && text;
  }, 'both pushes');
  assert.match(pushed, new RegExp(`${answer}: decision-answer D1 from owner`));
  assert.match(pushed, new RegExp(`${message}: worker-message T1 from worker`));
  assert.match(pushed, /tower-crane inbox/);
  idOnly(pushed, ['private owner note', 'private worker text', 'later']);

  // A steer joins a running turn; one the turn never read is pushed after it.
  await cc.fire('turn.start', { turnId: 't1', text: '' });
  const before = cc.seen.prompts.length;
  h.ok(['msg', '--to', 'orchestrator', '--steer', 'private steer text', '--agent', 'owner']);
  const steer = log(h).findLast((e) => e.cmd === 'msg').id;
  await waitOnRepo(h, () => cc.seen.appended.some((x) => x.includes(steer)), 'the steer append');
  assert.equal(cc.seen.prompts.length, before, 'a steer during a turn is not a new prompt');
  await cc.fire('turn.complete', { turnId: 't1' });
  await waitOnRepo(h, () => cc.seen.prompts.slice(before).some((x) => x.includes(steer)), 'the unread steer');
  idOnly(cc.seen.appended.join('\n'), ['private steer text']);
  assert.deepEqual(cc.seen.toasts, []);
});

test('serve carries owner messages to the orchestrator and its replies back with content-free wakes', async (t) => {
  const h = setup(t);
  const server = cp.spawn(process.execPath, [BIN, 'serve', '--port', '0', '--json', '--agent', 'owner'], { cwd: h.repo, env: h.env });
  const exited = new Promise((resolve) => server.on('exit', resolve));
  const controller = new AbortController();
  try {
    // Only the page loaded from the one-time link carries the write token.
    const { url, open } = await new Promise((resolve, reject) => {
      let out = '';
      server.stdout.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0]));
      });
      server.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
    });
    const page = await (await fetch(open)).text();
    const token = /<meta name="tower-crane-token" content="([0-9a-f]{48})">/.exec(page)[1];
    const stream = await fetch(`${url}events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    let sse = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          sse += Buffer.from(value).toString('utf8');
        }
      } catch { /* aborted at the end of the test */ }
    })();
    await waitOnRepo(h, () => sse.includes(': connected'), 'the event stream');
    const cursor = size(h);
    const sent = await fetch(`${url}api/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token },
      body: JSON.stringify({ text: 'owner from the phone', mode: 'steer', task: 'T1' }),
    });
    assert.equal(sent.status, 200, await sent.clone().text());
    const own = log(h).at(-1);
    assert.deepEqual([own.cmd, own.agent, own.to, own.task, own.detail.steer], ['msg', 'owner', 'orchestrator', 'T1', true]);
    const woke = h.json(['wait', '--agent', 'orchestrator', '--after', String(cursor), '--timeout', '300']);
    assert.equal(woke.id, own.id);
    h.ok(['msg', '--to', 'owner', 'orchestrator reply', '--agent', 'orchestrator']);
    const reply = log(h).at(-1);
    await waitOnRepo(h, () => sse.includes(reply.id), 'the reply wake');
    const wakes = sse.split('\n\n').filter((b) => b.startsWith('event: wake')).map((b) => JSON.parse(b.split('data: ')[1]));
    assert.deepEqual(wakes.map((w) => w.id), [own.id, reply.id]);
    idOnly(sse, ['owner from the phone', 'orchestrator reply']);
    const listed = await (await fetch(`${url}api/messages?after=${cursor}`)).json();
    assert.deepEqual(listed.messages.map((m) => m.detail.text), ['owner from the phone', 'orchestrator reply']);
    assert.equal(listed.cursor, size(h));
    const bad = await fetch(`${url}api/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tower-crane-token': token },
      body: JSON.stringify({ text: 'x', mode: 'shout' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    controller.abort();
    server.kill();
    await exited;
  }
});
