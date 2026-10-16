'use strict';

const { HUNG_TEST_MS, waitOnRepo, waitUntil } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { makeRepo, stubRungs, BIN, ROOT } = require('./helpers');

const STUB = path.join(__dirname, 'fixtures', 'message-harness.js');
const MOD = path.join(ROOT, 'hooks', 'tower-crane.mjs');
const log = (h) => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const size = (h) => fs.statSync(path.join(h.state, 'events.jsonl')).size;

// An orchestrator follower prints its ready line only after the lease's
// process discovery. On Windows that is a PowerShell CIM snapshot, which takes
// many seconds on a cold runner, so readiness is the line or the exit, never a
// clock. Delivery deadlines start after it.
function readyLine(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const isReady = (line) => {
      try { return JSON.parse(line).type === 'ready'; } catch { return false; }
    };
    const finish = (settle) => {
      child.stdout.off('data', onOut);
      child.stderr.off('data', onErr);
      child.off('close', onClose);
      settle();
    };
    const onOut = (d) => {
      out += d;
      if (out.split('\n').some(isReady)) finish(resolve);
    };
    const onErr = (d) => { err += d; };
    const onClose = (code, signal) => finish(() => reject(new Error(`the follower exited (${code ?? signal}) before its ready line: ${err.trim()}`)));
    child.stdout.on('data', onOut);
    child.stderr.on('data', onErr);
    child.on('close', onClose);
  });
}

// A startup step polled without a clock: a slow start (a cold Windows CIM
// snapshot in orchestrator discovery) is not a failure, an exit is. `ended`
// returns why the process is gone, or nothing while it runs.
function started(check, ended, what) {
  return waitUntil(() => {
    const value = check();
    if (value) return value;
    const reason = ended();
    if (reason) throw new Error(`${what} never came: ${reason}`);
    return false;
  }, { what });
}

function setup(t) {
  const h = makeRepo(t);
  // An orchestrator wait refills workers for the ready task.
  stubRungs(h);
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
  h.ok(['ask', '--kind', 'technical', '--question', 'which way?', '--option', 'left', '--option', 'right', '--blocks', 'T1', '--agent', 'worker']);
  const p = cp.spawn(process.execPath, [BIN, 'wait', '--observe', '--follow', '--agent', 'orchestrator'], { cwd: h.repo, env: h.env });
  t.after(() => p.kill());
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const lines = () => out.split('\n').filter(Boolean).map(JSON.parse);
  await readyLine(p);
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

// A commit that died in its append left its first line whole and the start
// of its second, with its staged tasks.json and manifest. The next lock
// holder cuts both lines off and appends its own. Returns the crashed line's
// event and the number of bytes the cut removes.
function tornCommit(h) {
  const message = (text) => ({ at: new Date().toISOString(), agent: 'worker', cmd: 'msg', task: null, detail: { to: 'orchestrator', text },
    id: `E${crypto.randomUUID()}`, type: 'worker-message', to: 'orchestrator' });
  const first = message('crashed first');
  const second = message(`crashed second ${'s'.repeat(300)}`);
  const fd = fs.openSync(path.join(h.state, 'events.jsonl'), 'a');
  const { size, dev, ino } = fs.fstatSync(fd);
  fs.writeFileSync(path.join(h.state, `tasks.json.${second.id}.commit`), fs.readFileSync(path.join(h.state, 'tasks.json')));
  fs.writeFileSync(path.join(h.state, `commit.${second.id}.json`), JSON.stringify({ size, dev, ino, ids: [first.id, second.id] }));
  const torn = `${JSON.stringify(first)}\n${JSON.stringify(second).slice(0, 200)}`;
  fs.writeSync(fd, torn);
  fs.closeSync(fd);
  return { first, cut: Buffer.byteLength(torn) };
}

// The bytes a worker message's log line takes besides its text, from the
// last message the worker sent.
function overhead(h) {
  const raw = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').at(-1);
  return Buffer.byteLength(raw) + 1 - Buffer.byteLength(JSON.parse(raw).detail.text);
}

// Recovery cuts a crashed commit's lines off the log, and the next commit can
// append exactly as many bytes, so the log keeps its size and inode. A
// follower delivers that commit's event whether it read the crashed lines
// from before the crash or started after it, with its cursor inside them.
for (const started of ['before the crash', 'after the crash and before recovery']) {
  test(`a follower started ${started} delivers the event appended after recovery cuts the crashed lines, at the same size`, async (t) => {
    const h = setup(t);
    const log = path.join(h.state, 'events.jsonl');
    h.ok(['msg', '--to', 'orchestrator', 'sizes the next message', '--agent', 'worker']);
    const extra = overhead(h);
    const early = started === 'before the crash';
    // Marks the follower's own read of the log through the crashed bytes, and
    // holds its next read while `hold` exists, so it reads the log only once
    // recovery has cut and the next commit has appended. `held` records that a
    // read was held, so a moved call cannot skip the hold unnoticed.
    const read = path.join(h.base, 'read-through');
    const hold = path.join(h.base, 'hold-reads');
    const held = path.join(h.base, 'held-read');
    const preload = path.join(h.base, 'read-mark.js');
    fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const log = ${JSON.stringify(log)};
const hold = ${JSON.stringify(hold)};
const held = ${JSON.stringify(held)};
const cell = new Int32Array(new SharedArrayBuffer(4));
const fds = new Set();
const { openSync, closeSync, readSync } = fs;
// Only the wait's own reader: EventReader.read called from events.js.
const waitRead = () => {
  const frames = new Error().stack.split('\\n');
  const i = frames.findIndex((line) => line.includes('event-reader.js'));
  return i !== -1 && /[\\\\/]lib[\\\\/]events\\.js/.test(frames[i + 1] || '');
};
fs.openSync = function (file, ...args) {
  const ours = path.resolve(String(file)) === log;
  if (ours && fs.existsSync(hold) && waitRead()) {
    fs.writeFileSync(held, '');
    const deadline = Date.now() + 300000;
    while (fs.existsSync(hold) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);
  }
  const fd = openSync.call(this, file, ...args);
  if (ours) fds.add(fd);
  return fd;
};
fs.closeSync = function (fd) { fds.delete(fd); return closeSync.call(this, fd); };
fs.readSync = function (fd, buffer, offset, length, position) {
  const n = readSync.call(this, fd, buffer, offset, length, position);
  const from = Number(process.env.READ_FROM || -1);
  if (fds.has(fd) && position === from && position + n === Number(process.env.READ_END)) fs.writeFileSync(${JSON.stringify(read)}, '');
  return n;
};
`);
    const follow = (env = {}) => {
      const p = cp.spawn(process.execPath, ['--require', preload, BIN, 'wait', '--observe', '--follow', '--agent', 'orchestrator'], { cwd: h.repo, env: { ...h.env, ...env } });
      t.after(() => p.kill());
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      return { p, ids: () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line).id).filter(Boolean) };
    };
    let f;
    if (early) {
      f = follow();
      await readyLine(f.p);
    }
    const base = size(h);
    const { first, cut } = tornCommit(h);
    if (early) {
      await waitOnRepo(h, () => f.ids().includes(first.id), 'the crashed commit\'s whole line');
    } else {
      // The cursor is the end of the crashed commit's whole line.
      f = follow({ READ_FROM: String(base + Buffer.byteLength(`${JSON.stringify(first)}\n`)), READ_END: String(base + cut) });
      await readyLine(f.p);
      await waitOnRepo(h, () => fs.existsSync(read), 'the follower\'s read of the torn line');
    }
    const end = size(h);
    fs.writeFileSync(hold, '');
    h.ok(['msg', '--to', 'orchestrator', 'n'.repeat(cut - extra), '--agent', 'worker']);
    assert.equal(size(h), end, 'recovery cut the crashed lines and the next message took their place');
    await waitOnRepo(h, () => fs.existsSync(held), 'the follower\'s read held across recovery');
    fs.rmSync(hold);
    const next = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).id;
    // A reader resuming mid-line loses the first line it reads, never the second.
    h.ok(['msg', '--to', 'orchestrator', 'later', '--agent', 'worker']);
    h.ok(['msg', '--to', 'orchestrator', 'last', '--agent', 'worker']);
    const [later, last] = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-2).map((line) => JSON.parse(line).id);
    await waitOnRepo(h, () => f.ids().includes(last), 'the events after the cut');
    assert.deepEqual(f.ids(), [...(early ? [first.id] : []), next, later, last]);
  });
}

// The Claude Code mod arms its follower at now on session start. A cold
// discovery takes seconds; what is written meanwhile must still arrive.
test('a follower armed at now delivers events written during orchestrator discovery', async (t) => {
  const h = setup(t);
  const held = path.join(h.base, 'discovery-held');
  const release = path.join(h.base, 'discovery-release');
  const preload = path.join(h.base, 'slow-discovery.js');
  // Holds the first ancestry lookup of orchestrator discovery (/proc on Linux,
  // ps on macOS, the CIM snapshot on Windows) until the test releases it.
  fs.writeFileSync(preload, `'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
let pending = true;
function hold() {
  if (!pending || !/\\bparents\\b[^\\n]*orchestrator\\.js/.test(new Error().stack)) return;
  pending = false;
  fs.writeFileSync(${JSON.stringify(held)}, '');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 300000;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);
}
const readFileSync = fs.readFileSync;
fs.readFileSync = function (...args) { hold(); return readFileSync.apply(this, args); };
const execFileSync = cp.execFileSync;
cp.execFileSync = function (...args) { hold(); return execFileSync.apply(this, args); };
`);
  const p = cp.spawn(process.execPath, ['--require', preload, BIN, 'wait', '--observe', '--follow', '--after', 'now', '--agent', 'orchestrator'], { cwd: h.repo, env: h.env });
  t.after(() => p.kill());
  let out = '';
  let err = '';
  let exit = null;
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code, signal) => { exit = `exited ${code ?? signal}: ${err.trim()}`; });
  const ready = readyLine(p);
  await started(() => fs.existsSync(held), () => exit, 'orchestrator discovery');
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'during discovery', '--agent', 'worker']);
  const during = log(h).findLast((e) => e.cmd === 'msg').id;
  fs.writeFileSync(release, '');
  await ready;
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'after ready', '--agent', 'worker']);
  const later = log(h).findLast((e) => e.cmd === 'msg').id;
  const ids = () => out.split('\n').filter(Boolean).map((line) => JSON.parse(line).id);
  await waitOnRepo(h, () => ids().includes(later), 'the message after ready');
  assert.deepEqual(ids().filter(Boolean), [during, later]);
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
    h.ok(['ask', '--kind', 'technical', '--question', 'ship it?', '--option', 'yes', '--option', 'no', '--agent', 'worker']);
    const run = h.runAsync(['spawn', '--task', 'T1', '--role', 'orchestrator', '--wait', '--json']);
    let early = null;
    run.then((r) => { early = r; });
    // Orchestrator CLI calls (the harness start, then its hooks) run process
    // discovery, seconds on a cold Windows runner: wait on readiness or exit.
    const ended = () => early && `spawn ended: ${early.code} ${early.stderr} ${early.stdout}`;
    await started(() => fs.existsSync(ready), ended, 'the harness');
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
    await started(() => fs.existsSync(ready + '.stop'), ended, 'the Stop hook');
    fs.writeFileSync(ready + '.stop.go', '');
    // Stop finds nothing pending and holds until the owner answers.
    if (process.platform === 'linux') {
      // The hold's wait lives as long as the idle; its initial environment
      // stays readable in /proc for that whole time.
      const pid = await waitOnRepo(h, () => holdWait(h.state), 'the Stop hold wait --inbox');
      // read-published: the kernel serves /proc; nothing replaces the file.
      const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const key = fs.readFileSync(path.join(home, 'automation.key'), 'utf8').trim();
      assert.ok(environ.includes('TOWER_CRANE_VIA=automation'), 'the hold wait runs for the engine');
      assert.ok(!environ.some((entry) => entry.includes(key)), 'the automation key is not in the hold wait environment');
    } else await new Promise((resolve) => setTimeout(resolve, 300)); // wait-allow: let Stop enter its pending-answer wait before publishing the answer
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
    const inbox = log(h).filter((e) => e.cmd === 'hook inbox' && e.agent === 'orchestrator-T1-1');
    const delivered = inbox.flatMap((e) => e.detail.messages);
    assert.ok(delivered.includes(message) && delivered.includes(answer));
    assert.ok(inbox.every((e) => e.via === 'automation'), 'the bridge presents the key on stdin');
  });
}

// The pid of the Stop hold's wait --inbox for this state, from /proc.
function holdWait(state) {
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let argv;
    // read-published: the kernel serves /proc; nothing replaces the file.
    try { argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (argv.includes('wait') && argv.includes('--inbox') && argv.includes(state) && !argv.includes('--observe')) return Number(name);
  }
  return null;
}

// A stand-in for the engine's $ with real child processes, so the mod runs
// the shipped CLI exactly as a Claude Code session would.
function engine(t, h, { appendPause } = {}) {
  const hooks = {};
  const on = (event, matcher, fn) => {
    if (typeof matcher === 'function') [fn, matcher] = [matcher, null];
    const entry = { matcher, fn };
    (hooks[event] ||= []).push(entry);
    // The engine answers with this handler when the hook throws.
    return { catch: (handler) => { entry.fallback = handler; } };
  };
  const seen = { prompts: [], appended: [], toasts: [], tools: [], commands: [] };
  const notices = new EventEmitter();
  const record = (kind, text) => {
    seen[kind].push(text);
    notices.emit('notice');
  };
  const waitFor = async (kind, ids) => {
    const signal = AbortSignal.timeout(HUNG_TEST_MS);
    for (;;) {
      const text = seen[kind].join('\n');
      if (ids.every((id) => text.includes(id))) return text;
      try {
        await once(notices, 'notice', { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
        assert.fail(`${kind} did not receive ${ids.join(', ')}; prompts: ${JSON.stringify(seen.prompts)}; appended: ${JSON.stringify(seen.appended)}; toasts: ${JSON.stringify(seen.toasts)}`);
      }
    }
  };
  const children = [];
  let followerReady = null;
  t.after(() => { for (const p of children) p.kill(); });
  async function* spawn({ argv }) {
    assert.equal(argv[0], 'node');
    const p = cp.spawn(process.execPath, argv.slice(1), { cwd: h.repo, env: h.env });
    children.push(p);
    followerReady = readyLine(p);
    // A follower the test never waits on may exit before its ready line.
    followerReady.catch(() => {});
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
    prompt: { submit: async (p) => { record('prompts', p.text); return { text: p.text }; } },
    session: { append: async (a) => { record('appended', a.message.content[0].text); if (appendPause) await appendPause; return {}; } },
    ui: { status() {}, toast: (text) => seen.toasts.push(text) },
    process: { spawn },
  };
  const fire = (event, e, match = () => true) => {
    const hook = hooks[event].find((x) => match(x.matcher));
    return hook.fn($, e, async (x) => x);
  };
  return { $, on, seen, fire, waitFor, followerReady: () => followerReady };
}

test('the Claude Code mod pushes a decision answer and a worker message into the session', async (t) => {
  const h = setup(t);
  h.ok(['project', 'set', '--paused', 'notification-only probe']);
  h.ok(['ask', '--kind', 'technical', '--question', 'merge now?', '--option', 'yes', '--option', 'later', '--agent', 'worker']);
  const { register } = await import(pathToFileURL(MOD).href);
  let finishAppend;
  const appendPause = new Promise((resolve) => { finishAppend = resolve; });
  t.after(() => finishAppend());
  const cc = engine(t, h, { appendPause });
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
  await cc.followerReady();
  const pushed = await cc.waitFor('prompts', [answer, message]);
  assert.match(pushed, new RegExp(`${answer}: decision-answer D1 from owner`));
  assert.match(pushed, new RegExp(`${message}: worker-message T1 from worker`));
  assert.match(pushed, /tower-crane inbox/);
  idOnly(pushed, ['private owner note', 'private worker text', 'later']);

  // A steer joins a running turn; one the turn never read is pushed after it.
  await cc.fire('turn.start', { turnId: 't1', text: '' });
  const before = cc.seen.prompts.length;
  // Inbox reconciliation can wake separately after the first two pushes.
  // An ordinary message forces that overlap regardless of process startup speed.
  h.ok(['msg', '--to', 'orchestrator', '--task', 'T1', 'private concurrent worker text', '--agent', 'worker']);
  const concurrent = log(h).findLast((e) => e.cmd === 'msg').id;
  h.ok(['msg', '--to', 'orchestrator', '--steer', 'private steer text', '--agent', 'owner']);
  const steer = log(h).findLast((e) => e.cmd === 'msg').id;
  await cc.waitFor('prompts', [concurrent]);
  await cc.waitFor('appended', [steer]);
  assert.ok(!cc.seen.prompts.slice(before).some((x) => x.includes(steer)), 'a steer during a turn is not a new prompt');
  await cc.fire('turn.complete', { turnId: 't1' });
  finishAppend();
  await cc.waitFor('prompts', [steer]);
  idOnly(cc.seen.prompts.join('\n'), ['private concurrent worker text', 'private steer text']);
  idOnly(cc.seen.appended.join('\n'), ['private steer text']);
  assert.deepEqual(cc.seen.toasts, []);
});

test('serve carries owner messages to the orchestrator and its replies back with content-free wakes', async (t) => {
  const h = setup(t);
  // A worker holds T1, so the orchestrator wait refills nothing: a refilled
  // worker's spawn events would race the event cursor the test compares.
  h.ok(['claim', 'T1', '--agent', 'worker']);
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
