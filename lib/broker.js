'use strict';

// The state broker. A sandboxed agent reads the state directory but cannot
// write it; its tower-crane CLI sends each state change over a socket to the
// spawn monitor that started it, which runs outside the sandbox. The monitor
// knows whom it started: it checks the token it wrote into that agent's
// private broker directory, allows only the agent's role's commands on the
// agent's own task, and runs them as that agent. The agent's git and gh
// shims send it their pushes of the task branch, their fetches from origin
// and their gh commands too, since the agent holds no GitHub credential
// (lib/github-broker.js).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cp = require('./commands');
const S = require('./state');
const crypto = require('node:crypto');
const { refuse, usage } = require('./util');

const FILE = 'broker.json';
const CLI = path.join(__dirname, '..', 'bin', 'tower-crane.js');
const MAX_REQUEST = 1 << 20;
// sun_path holds 104 bytes on macOS and 108 on Linux, terminator included.
const MAX_SOCKET_PATH = 100;

// The state changes each sandboxed role may make, all on its own task. hook
// is the harness hooks' delivery and progress, under the identity in the
// agent's own hook binding. The broker runs outside the sandbox, so it never
// runs a command that executes anything the agent controls: no check (the
// project's tests and cleanup are the agent's code, and --cmd its shell),
// and no worktree (git over a repository whose config the worker writes).
// A worker runs its tests in its sandbox; the gates stay the orchestrator's.
// Nor does the CLI it runs call git: see repoAt in lib/state.js. ci log,
// ci alerts and ci checks read GitHub for the task's own PR, and ci resolve
// replies on a revuto thread there: gh runs here, not in the sandbox.
const ROLES = {
  worker: ['claim', 'renew', 'release', 'submit', 'spend', 'task note', 'msg', 'ask', 'answer', 'decision withdraw', 'hook', 'ci log', 'ci alerts', 'ci checks', 'ci resolve'],
  reviewer: ['evidence', 'task note', 'msg', 'ask', 'answer', 'decision withdraw', 'hook'],
  small: ['task note', 'answer', 'hook'],
};
const EVIDENCE = { reviewer: ['review'] };

// Commands that only read the state run in the agent itself, in its sandbox.
// worktree prints the task's worktree, which spawn created; creating one
// would write the state, and fails there. wait reads the event log: for an
// identity that is neither the orchestrator nor the owner it runs no
// reactions, dispatch or observation, so it writes nothing (scopeWait).
const READS = new Set(['project show', 'ladder show', 'browser-kit show', 'authority', 'task show', 'task list', 'brief get', 'validate', 'ready', 'decisions', 'status', 'worktree', 'worktree list', 'event', 'bench gates', 'bench tokens', 'wait']);

// A sandboxed agent's wait, checked in the agent before it runs: bounded by
// --timeout, on its own task, for its own messages or the default recipient.
// The engine's options (--follow, --observe, --inbox) are the orchestrator's.
// The sandbox already lets the agent read the event log; the scope keeps the
// wait what the role skills describe. flags.task defaults to the agent's task.
function scopeWait(flags, agent, env) {
  const task = env.TOWER_CRANE_TASK;
  if (!task) throw refuse(`${agent} waits on its own task, and TOWER_CRANE_TASK is unset`);
  if (env.TOWER_CRANE_AGENT && agent !== env.TOWER_CRANE_AGENT.trim()) throw refuse(`${env.TOWER_CRANE_AGENT} cannot wait as ${agent}`);
  for (const name of ['follow', 'observe', 'inbox']) {
    if (flags[name]) throw refuse(`wait --${name} is the orchestrator's; ${agent} waits with --task ${task} --timeout SEC`);
  }
  if (flags.timeout === undefined) throw refuse(`${agent} waits with a bound: --timeout SEC`);
  if (flags.task === undefined) flags.task = task;
  if (flags.task !== task) throw refuse(`${agent} works on ${task} only, not ${flags.task}`);
  if (flags.for !== undefined && !['orchestrator', agent].includes(flags.for.trim())) {
    throw refuse(`${agent} waits for its own messages or the orchestrator's, not ${flags.for}`);
  }
}

// Each sandboxed agent's broker directory, brokers/<agent>/ in the state
// directory: its sandbox lets it read its own and no other. It sits outside
// homes/<agent>/ because codex mounts a readable path before hiding the
// directory above it, so a home under a hidden homes/ would hide the shims
// in it too; a writable path is mounted after, and stays visible.
function dir(stateDir, agent) {
  return path.join(stateDir, 'brokers', agent);
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Where the broker listens. A codex agent reaches its broker over TCP on
// 127.0.0.1 at an ephemeral port; the token is what keeps other local
// processes out. Codex's sandbox refuses connect() on a Unix socket only with
// network off (measured 2026-10-14, codex-cli 0.162.1: EPERM off, connected
// on); Tower Crane runs codex with network on, so the codex profile hides
// the sockets an agent must not reach (codexSockets in lib/agents.js).
// Claude's sandbox has no host loopback but connects to Unix sockets, so the
// socket goes in the broker directory when the path fits a socket address.
// Else it goes in agentTmp, the agent's own temp directory (claudeTmp in
// lib/agents.js), which its sandbox reads and writes and no other agent's
// does. A codex rung's temp directory too long for claude's proxy sockets is
// not in a claude fallback's sandbox, so it is skipped. Last comes a fresh
// private directory in /tmp: the sandbox hides the home, and with it a temp
// dir or cache there, so a socket under ~/.cache failed every brokered
// command with ENOENT. Other agents can connect there, and the token, which
// only this agent's broker directory holds, refuses them. broker.json names
// the socket either way. A rung whose fallbacks run both harnesses gets both.
function socketPath(where, harnesses, agentTmp) {
  if (process.platform === 'win32') return { socket: `\\\\.\\pipe\\tower-crane-${crypto.randomBytes(16).toString('hex')}`, dir: null, tcp: false };
  const tcp = harnesses.includes('codex');
  if (!harnesses.some((h) => h !== 'codex')) return { socket: null, dir: null, tcp };
  const own = path.join(where, 'broker.sock');
  if (Buffer.byteLength(own) <= MAX_SOCKET_PATH) return { socket: own, dir: null, tcp };
  let why = 'it has no temp directory of its own';
  if (agentTmp && !require('./gate-tmp').harnessFits(agentTmp)) why = `its temp directory ${agentTmp} is too long for claude's sockets`;
  else if (agentTmp) {
    try {
      fs.mkdirSync(agentTmp, { recursive: true, mode: 0o700 });
      return { socket: path.join(agentTmp, 'broker.sock'), dir: null, tcp };
    } catch (e) {
      why = `its temp directory ${agentTmp} cannot be made (${e.code || e.message})`;
    }
  }
  try {
    const dir = fs.mkdtempSync(path.join('/tmp', 'tower-crane-'));
    return { socket: path.join(dir, 's'), dir, tcp };
  } catch (e) {
    throw refuse(`no socket path that the agent's sandbox reaches for ${where}: ${why}, and /tmp refused a directory (${e.code || e.message}); a shorter cache root (XDG_CACHE_HOME) gives the agent a temp directory that fits`);
  }
}

// The command an agent asked for, checked against the spawn it came from.
// Returns the argv the broker runs, with the agent and state it names
// itself in place of any the request gave.
function authorize(job, argv) {
  const { resolveCommand, parseOptions, GLOBAL } = require('../bin/tower-crane');
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === 'string')) throw usage('the broker needs an argv of strings');
  const resolved = resolveCommand(argv);
  if (!resolved.cmd) throw usage('the broker runs commands, not help');
  const { cmd } = resolved;
  const tokens = [...resolved.lead, ...resolved.rest];
  const parsed = parseOptions(tokens, { ...(cmd.flags || {}), ...GLOBAL }, cmd.name);
  const allowed = ROLES[job.role] || [];
  if (!allowed.includes(cmd.name)) {
    throw refuse(`${job.agent} is a sandboxed ${job.role}; it changes state only with ${allowed.join(', ') || 'no command'}, not ${cmd.name}`);
  }
  const f = parsed.flags;
  // A message lands in the recipient's prompt, so a sandboxed agent reaches
  // only the orchestrator or the owner, never another agent.
  if (cmd.name === 'msg' && !['orchestrator', 'owner'].includes((f.to || '').trim())) {
    throw Object.assign(refuse(`${job.agent} messages only the orchestrator or the owner, not ${f.to ?? 'a missing --to'}`), { recipient: f.to ?? null });
  }
  if (cmd.name === 'release' && f.dead) throw refuse('release --dead is unscoped; only the orchestrator or owner can recover claims in a batch');
  if (f.agent !== undefined && f.agent.trim() !== job.agent) throw refuse(`${job.agent} cannot act as ${f.agent}`);
  const spec = cmd.pos || [];
  const ids = [
    ...(spec[0] === 'ID...' ? parsed.pos : ['ID', '[ID]'].includes(spec[0]) ? parsed.pos.slice(0, 1) : []),
    ...(f.task !== undefined ? [f.task] : []),
    ...(f.blocks || []),
  ];
  for (const id of ids) if (id !== job.task) throw refuse(`${job.agent} works on ${job.task} only, not ${id}`);
  if (cmd.name === 'evidence' && !(EVIDENCE[job.role] || []).includes(f.type)) {
    throw refuse(`${job.agent} records ${(EVIDENCE[job.role] || []).join(', ') || 'no'} evidence, not ${f.type}`);
  }
  if (f['from-spawn'] !== undefined && f['from-spawn'] !== job.agent) throw refuse(`${job.agent} collects its own spawn only, not ${f['from-spawn']}`);
  // The broker reads the binding outside the sandbox, so it is the agent's own or nothing.
  if (f.binding !== undefined && real(path.resolve(job.cwd, f.binding)) !== real(path.join(job.state, 'homes', job.agent, 'hook.json'))) {
    throw refuse(`${job.agent} uses its own hook binding only, not ${f.binding}`);
  }
  const dropped = new Set(parsed.spans.filter((s) => s.name === 'agent' || s.name === 'state').flatMap((s) => [s.from, s.to]));
  // Before the agent's own tokens, so a "--" among them cannot turn these into positionals.
  return [...cmd.name.split(' '), '--agent', job.agent, '--state', job.state, ...tokens.filter((_, i) => !dropped.has(i))];
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

// The processes under pid, by the parent links ps lists.
function descendants(pid) {
  const r = cp.spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true });
  const kids = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p && pp) kids.set(pp, [...(kids.get(pp) || []), p]);
  }
  const out = [];
  for (let i = -1; i < out.length; i++) for (const k of kids.get(i < 0 ? pid : out[i]) || []) if (!out.includes(k)) out.push(k);
  return out;
}

// Stops a command and everything it started, including a process in a group
// of its own: the tree is frozen until no new process appears
// under it, then killed, each process with its group.
function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return;
  }
  signal(-child.pid, 'SIGSTOP');
  let tree = [child.pid];
  for (let round = 0; round < 10; round++) {
    const found = [child.pid, ...descendants(child.pid)];
    for (const pid of found) signal(pid, 'SIGSTOP');
    if (found.every((pid) => tree.includes(pid))) break;
    tree = [...new Set([...tree, ...found])];
  }
  for (const pid of tree) {
    signal(-pid, 'SIGKILL');
    signal(pid, 'SIGKILL');
  }
}

// Each command runs in a process group of its own, so the broker can stop
// it and whatever it started when the agent exits. It runs on the host in
// the monitor's environment, the dispatcher's, under the agent's identity
// only: never the agent's home, shims or cache.
function run(job, argv, active, input) {
  const env = { ...process.env, TOWER_CRANE_STATE: job.state, TOWER_CRANE_TASK: job.task, TOWER_CRANE_AGENT: job.agent,
    ...(job.hook ? { TOWER_CRANE_HOOK: job.hook } : {}), TOWER_CRANE_VIA: 'broker' };
  delete env.TOWER_CRANE_BROKER;
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [CLI, ...argv], { cwd: job.cwd, env, stdio: [typeof input === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    active.children.add(child);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const done = (res) => {
      active.children.delete(child);
      resolve(res);
    };
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: 1, stdout, stderr: `${stderr}tower-crane: broker could not run the command: ${e.message}\n` }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

function sameToken(given, token) {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A refused message goes in the event log, so the orchestrator and the board
// see the attempt. Only the intended recipient is kept, never the text.
function recordRefusal(job, to) {
  try {
    S.mutate({ stateDir: job.state, agent: job.agent, env: { TOWER_CRANE_VIA: 'broker' } }, 'msg refused', (st, emit) => emit(job.task, { to }));
    return '';
  } catch (e) {
    return `tower-crane: the refusal was not recorded: ${e.message}\n`;
  }
}

function parseRequest(token, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { error: { code: 2, stdout: '', stderr: 'tower-crane: the broker got a request that is not JSON\n' } };
  }
  if (!req || !sameToken(req.token, token)) return { error: { code: 1, stdout: '', stderr: 'tower-crane: the broker refused a request without its token\n' } };
  return { req };
}

async function answer(job, req, active) {
  let argv;
  try {
    argv = authorize(job, req.argv);
  } catch (e) {
    const note = e.recipient === undefined ? '' : recordRefusal(job, e.recipient);
    return { code: e.code || 1, stdout: '', stderr: `tower-crane: ${e.message}\n${note}` };
  }
  if (active.closed) return { code: 1, stdout: '', stderr: 'tower-crane: the state broker closed with its agent\n' };
  return run(job, argv, active, req.input);
}

// A push or gh command from the agent's shims (lib/github-broker.js). Its
// output streams back as it comes, one JSON line per chunk, then the exit
// code; when the agent hangs up (a timeout killed its shim), what it started
// is stopped.
//
// A push asks the agent for a pack of its commit with a {need} line; the
// agent's bytes after its request line are that pack (body), in frames that
// end with an empty one (see frames).
async function github(job, req, conn, active, body) {
  const G = require('./github-broker');
  const send = (msg) => { if (!conn.destroyed) conn.write(`${JSON.stringify(msg)}\n`); };
  const io = {
    stdout: (text) => send({ stdout: text }),
    stderr: (text) => send({ stderr: text }),
    // framed tells the shim this broker reads frames (see frames).
    need: (what) => send({ need: { ...what, framed: true } }),
    refs: (refs) => send({ refs }),
    // A fetch's pack, base64 in JSON lines like the rest of the answer.
    // False while the connection's buffer is full.
    pack: (chunk) => {
      send({ pack: chunk.toString('base64') });
      return conn.destroyed || !conn.writableNeedDrain;
    },
    drained: (fn) => (conn.destroyed ? fn() : conn.once('drain', fn)),
    body,
    gone: () => conn.destroyed || active.closed,
    track: (child) => {
      active.children.add(child);
      const stop = () => stopTree(child);
      conn.on('close', stop);
      child.on('close', () => {
        active.children.delete(child);
        conn.off('close', stop);
      });
    },
  };
  let code;
  try {
    if (active.closed) throw refuse('the state broker closed with its agent');
    code = req.push !== undefined ? await G.push(job, req.push, io)
      : req.fetch !== undefined ? await G.fetch(job, req.fetch, io)
        : await G.gh(job, req.gh, typeof req.input === 'string' ? req.input : undefined, io);
  } catch (e) {
    io.stderr(`tower-crane: ${e.message}\n`);
    code = e.code || 1;
  }
  if (!conn.destroyed) conn.end(`${JSON.stringify({ code })}\n`);
  // Whatever pack is still coming has no reader: drop it and read on to the
  // agent's end, so the connection closes.
  if (body) {
    body.destroy();
    conn.resume();
  }
}

// The pack travels in frames, a 4-byte big-endian length and that many
// bytes, and an empty frame ends it. The agent never ends its side of the
// connection to mark the end of the pack: a Windows named pipe has no half
// close, and libuv closes the whole pipe 50 ms after the writer's shutdown
// unless data arrives, so the agent lost the answer while the broker checked
// the push. Any end of the agent's side is a hang-up.
const FRAME = 4;
function frame(chunk) {
  const head = Buffer.alloc(FRAME);
  head.writeUInt32BE(chunk.length);
  return chunk.length ? Buffer.concat([head, chunk]) : head;
}

// What a shim and a broker from either side of the change to frames tell
// the agent, instead of index-pack's "pack signature mismatch".
const SKEW = 'the git shim and the state broker are from different Tower Crane versions, as after an upgrade while the agent runs; spawn the agent again so both run one version';

// Unframes what the agent sends into body and ends body at the empty frame.
// Returns the function the connection's data goes to, which returns false
// when body wants no more until it drains. An ended body emits no drain, so
// it never asks to wait: a connection paused for it would miss the agent's
// hang-up during the checks and the push.
//
// A shim from before frames sends the bare pack, whose first four bytes are
// its signature "PACK"; a first frame that long never comes, since the shim
// frames each chunk its pack stream gives. body ends there with unframed set
// to the reason.
function frames(body) {
  let head = Buffer.alloc(0);
  let left = 0;
  let first = true;
  return (d) => {
    let room = true;
    for (let at = 0; at < d.length && !body.writableEnded;) {
      if (left === 0) {
        const take = Math.min(FRAME - head.length, d.length - at);
        head = Buffer.concat([head, d.subarray(at, at + take)]);
        at += take;
        if (head.length < FRAME) break;
        if (first && head.toString('latin1') === 'PACK') {
          body.unframed = SKEW;
          body.end();
          break;
        }
        first = false;
        left = head.readUInt32BE(0);
        head = Buffer.alloc(0);
        if (left === 0) body.end();
        continue;
      }
      const piece = d.subarray(at, at + left);
      at += piece.length;
      left -= piece.length;
      room = body.write(piece) && room;
    }
    return room || body.writableEnded;
  };
}

// Listens for the agent a spawn monitor starts: job is the monitor's job
// (state, task, agent, role, harness, cwd), job.broker the broker.json path in the
// agent's broker directory and job.broker_harnesses the sandboxed harnesses
// its rung and fallbacks run. Returns the env the agent runs with and close().
async function start(job) {
  const where = path.dirname(job.broker);
  fs.mkdirSync(path.dirname(where), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.mkdirSync(where, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Tokens stay out of git, but a caller's existing directory gets no .gitignore. Its mode still
  // drops to 0700 so other users cannot read the token.
  if (created) fs.writeFileSync(path.join(where, '.gitignore'), '*\n');
  fs.chmodSync(where, 0o700);
  const token = crypto.randomBytes(32).toString('hex');
  const { socket, dir: tmp, tcp } = socketPath(where, job.broker_harnesses || [job.harness], job.agent_tmp);
  const unix = socket && process.platform !== 'win32';
  if (unix && !tmp) fs.rmSync(socket, { force: true });
  // The commands running and the connections open, stopped when the agent exits.
  const active = { closed: false, children: new Set() };
  const conns = new Set();
  const serve = (conn) => {
    let buf = Buffer.alloc(0);
    // A push's pack: the framed bytes after the request line.
    let body = null;
    let unframe = null;
    conns.add(conn);
    conn.on('close', () => {
      conns.delete(conn);
      if (body && !body.writableEnded) body.end();
    });
    conn.on('error', () => {});
    // An agent that ends its side has hung up: the connection closes, so the
    // broker stops what it runs for the agent. A shim from before frames ends
    // its side after its bare pack and waits for the answer that says so.
    conn.on('end', () => {
      if (!body?.unframed) conn.destroy();
    });
    conn.on('data', (d) => {
      if (body) {
        if (body.destroyed) return;
        if (!unframe(d)) {
          conn.pause();
          body.once('drain', () => conn.resume());
        }
        return;
      }
      if (buf === null) return;
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0 && buf.length <= MAX_REQUEST) return;
      const line = nl < 0 ? '' : buf.subarray(0, nl).toString('utf8');
      const rest = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
      buf = null;
      const { req, error } = parseRequest(token, line);
      if (error) conn.end(`${JSON.stringify(error)}\n`);
      else if (req.push !== undefined) {
        body = new (require('node:stream').PassThrough)().on('error', () => {});
        unframe = frames(body);
        if (rest.length) unframe(rest);
        github(job, req, conn, active, body);
      } else if (req.gh !== undefined || req.fetch !== undefined) github(job, req, conn, active);
      else answer(job, req, active).then((res) => conn.destroyed || conn.end(`${JSON.stringify(res)}\n`));
    });
  };
  const listen = (where) => new Promise((resolve, reject) => {
    // Half open, so the broker decides what an agent's end means: a hang-up.
    const server = net.createServer({ allowHalfOpen: true }, serve);
    server.once('error', reject);
    server.listen(where, () => resolve(server));
  });
  const servers = [];
  try {
    if (socket) servers.push(await listen(socket));
    if (tcp) servers.push(await listen({ host: '127.0.0.1', port: 0 }));
  } catch (e) {
    for (const server of servers) server.close();
    throw e;
  }
  if (unix) fs.chmodSync(socket, 0o600);
  const address = { ...(socket ? { socket } : {}), ...(tcp ? { host: '127.0.0.1', port: servers.at(-1).address().port } : {}) };
  const file = job.broker;
  fs.writeFileSync(file, `${JSON.stringify({ ...address, token, state: real(job.state), task: job.task, agent: job.agent, role: job.role })}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return {
    env: { TOWER_CRANE_BROKER: file },
    close: () => {
      active.closed = true;
      for (const server of servers) server.close();
      for (const child of active.children) stopTree(child);
      for (const conn of conns) conn.destroy();
      fs.rmSync(file, { force: true });
      if (unix) fs.rmSync(socket, { force: true });
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      if (created) fs.rmSync(where, { recursive: true, force: true });
    },
  };
}

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw refuse(`cannot read the state broker at ${file} (${e.code || e.message}); it exists while the agent's spawn runs`);
  }
}

// Home construction holds the state lock synchronously. Probe in a child so
// connect events can run, with a short bound that keeps uncertain endpoints.
function dead(file) {
  let b;
  try { b = read(file); } catch { return false; }
  if (!b || typeof b !== 'object') return false;
  const addresses = [];
  if (b.socket !== undefined) {
    if (typeof b.socket !== 'string' || !b.socket) return false;
    addresses.push({ path: b.socket });
  }
  if (b.port !== undefined) {
    if (b.host !== '127.0.0.1' || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) return false;
    addresses.push({ host: b.host, port: b.port });
  }
  if (!addresses.length) return false;
  const probe = cp.spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    Promise.all(JSON.parse(process.argv[1]).map(address => new Promise(resolve => {
      const socket = net.connect(address);
      const done = dead => { socket.destroy(); resolve(dead); };
      socket.once('connect', () => done(false));
      socket.once('error', error => done(['ECONNREFUSED', 'ENOENT'].includes(error.code)));
      socket.setTimeout(1000, () => done(false));
    }))).then(results => { process.exitCode = results.every(Boolean) ? 0 : 1; });
  `, JSON.stringify(addresses)], { timeout: 5000, stdio: 'ignore' });
  return probe.status === 0;
}

// Whether the broker at file serves stateDir. Another state directory, such
// as a test fixture's, is not the broker's to change.
function serves(file, stateDir) {
  return real(stateDir) === read(file).state;
}

// The agent side: sends the command to the broker when it changes the
// broker's state directory. Another state directory, such as a test
// fixture's, is not the broker's to change, so null leaves the command to
// run here. input is what the command reads from stdin ("-" values).
async function forward(file, argv, stateDir, input) {
  const b = read(file);
  if (real(stateDir) !== b.state) return null;
  const request = `${JSON.stringify({ token: b.token, argv, ...(typeof input === 'string' ? { input } : {}) })}\n`;
  // Codex's sandbox refuses the Unix socket before anything is sent, so a
  // broker with both tries TCP next.
  const addresses = [...(b.socket ? [{ where: b.socket, to: [b.socket] }] : []), ...(b.port ? [{ where: `${b.host}:${b.port}`, to: [b.port, b.host] }] : [])];
  let failed;
  for (const { where, to } of addresses) {
    try {
      return await send(to, request);
    } catch (e) {
      if (!e.unsent) throw e;
      failed = refuse(`cannot reach the state broker at ${where} (${e.code || e.message}); it runs while the agent's spawn does`);
    }
  }
  throw failed || refuse(`the state broker at ${file} names no address`);
}

// The answer is one JSON line with the exit code; a streamed answer sends
// {stdout} and {stderr} lines before it, which io receives as they come.
function send(to, request, io = null, pack = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(...to);
    let packing = false;
    // Once the answer is in or the connection is gone, the pack has no
    // reader: stop it, so a pack the broker refused partway does not keep
    // the agent's push waiting on a full pipe.
    let stream = null;
    const stopPack = () => {
      if (!stream) return;
      const s = stream;
      stream = null;
      s.removeAllListeners('data');
      s.destroy();
      s.stop?.();
    };
    sock.on('close', stopPack);
    sock.on('drain', () => stream?.resume());
    // The pack in frames, then the empty frame that ends it; a pack that
    // fails ends there too, and the broker refuses what it got.
    const sendPack = (s) => {
      stream = s;
      const finish = () => {
        if (stream !== s) return;
        stream = null;
        if (!sock.destroyed) sock.write(frame(Buffer.alloc(0)));
      };
      s.on('data', (chunk) => {
        // An empty chunk framed would be the empty frame that ends the pack.
        if (stream !== s || !chunk.length) return;
        if (!sock.write(frame(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))) s.pause();
      });
      s.on('end', finish);
      s.on('error', finish);
    };
    let sent = false;
    let buf = '';
    let final = null;
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sent = true;
      sock.write(request);
    });
    sock.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.code !== undefined) final = msg;
        else if (msg?.need && !packing) {
          // The pack of the pushed commit; with none, the empty pack.
          packing = true;
          // A broker from before frames would read them as a broken pack.
          if (msg.need.framed !== true) {
            reject(refuse(SKEW));
            sock.destroy();
            return;
          }
          const have = Array.isArray(msg.need.have) ? msg.need.have.filter((h) => typeof h === 'string' && /^[0-9a-f]{40,64}$/.test(h)) : [];
          const s = pack ? pack(have) : null;
          if (s) sendPack(s);
          else sock.write(frame(Buffer.alloc(0)));
        } else if (io?.refs && msg?.refs && typeof msg.refs === 'object') io.refs(msg.refs);
        else if (io?.pack && typeof msg?.pack === 'string') {
          // A fetch's pack: the connection waits while its reader is full.
          if (io.pack(Buffer.from(msg.pack, 'base64')) === false) {
            sock.pause();
            io.drained(() => sock.resume());
          }
        } else if (io && typeof msg?.stdout === 'string') io.stdout(msg.stdout);
        else if (io && typeof msg?.stderr === 'string') io.stderr(msg.stderr);
      }
    });
    sock.on('error', (e) => reject(sent ? refuse(`the state broker connection failed (${e.code || e.message})`) : Object.assign(e, { unsent: true })));
    sock.on('end', () => {
      stopPack();
      if (!final && buf.trim()) {
        try { final = JSON.parse(buf); } catch { final = null; }
      }
      if (final) resolve(final);
      else reject(refuse('the state broker closed without an answer'));
    });
  });
}

// The shims' side: sends a push, fetch or gh request ({push}, {fetch} or
// {gh, input}) to the broker in file and returns the exit code, writing its
// output to io. For a push, pack(have) returns a stream of the pack the
// broker asks for. A fetch's answer goes to io.refs and io.pack.
async function request(file, payload, io, { pack = null } = {}) {
  const b = read(file);
  const line = `${JSON.stringify({ token: b.token, ...payload })}\n`;
  const addresses = [...(b.socket ? [{ where: b.socket, to: [b.socket] }] : []), ...(b.port ? [{ where: `${b.host}:${b.port}`, to: [b.port, b.host] }] : [])];
  let failed;
  for (const { where, to } of addresses) {
    try {
      const res = await send(to, line, io, pack);
      return Number.isInteger(res.code) ? res.code : 1;
    } catch (e) {
      if (!e.unsent) throw e;
      failed = refuse(`cannot reach the state broker at ${where} (${e.code || e.message}); it runs while the agent's spawn does`);
    }
  }
  throw failed || refuse(`the state broker at ${file} names no address`);
}

module.exports = { ROLES, READS, scopeWait, FILE, dir, start, forward, request, serves, authorize, dead, stopTree, frame, frames };
