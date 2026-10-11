'use strict';

// The state broker. A sandboxed agent reads the state directory but cannot
// write it; its tower-crane CLI sends each state change over a socket to the
// spawn monitor that started it, which runs outside the sandbox. The monitor
// knows whom it started: it checks the token it wrote into that agent's
// private broker directory, allows only the agent's role's commands on the
// agent's own task, and runs them as that agent.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
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
// Nor does the CLI it runs call git: see repoAt in lib/state.js.
const ROLES = {
  worker: ['claim', 'renew', 'release', 'submit', 'spend', 'task note', 'msg', 'ask', 'answer', 'decision withdraw', 'hook'],
  reviewer: ['evidence', 'task note', 'msg', 'ask', 'answer', 'decision withdraw', 'hook'],
  small: ['task note', 'answer', 'hook'],
};
const EVIDENCE = { reviewer: ['review'] };

// Commands that only read the state run in the agent itself, in its sandbox.
// worktree prints the task's worktree, which spawn created; creating one
// would write the state, and fails there.
const READS = new Set(['project show', 'ladder show', 'browser-kit show', 'authority', 'task show', 'task list', 'brief get', 'validate', 'ready', 'decisions', 'status', 'worktree', 'event', 'bench gates', 'bench tokens']);

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

// Where the broker listens. Codex's sandbox refuses connect() on a Unix
// socket, so a codex agent reaches its broker over TCP on 127.0.0.1 at an
// ephemeral port; the token is what keeps other local processes out.
// Claude's sandbox has no host loopback but connects to Unix sockets, so the
// socket goes in the broker directory when the path fits a socket address, else
// in a fresh private directory under the temp dir; broker.json names it
// either way. A rung whose fallbacks run both harnesses gets both.
function socketPath(where, harnesses) {
  if (process.platform === 'win32') return { socket: `\\\\.\\pipe\\tower-crane-${crypto.randomBytes(16).toString('hex')}`, dir: null, tcp: false };
  const tcp = harnesses.includes('codex');
  if (!harnesses.some((h) => h !== 'codex')) return { socket: null, dir: null, tcp };
  const own = path.join(where, 'broker.sock');
  if (Buffer.byteLength(own) <= MAX_SOCKET_PATH) return { socket: own, dir: null, tcp };
  for (const root of [os.tmpdir(), '/tmp']) {
    if (Buffer.byteLength(path.join(root, 'tower-crane-XXXXXX', 's')) > MAX_SOCKET_PATH) continue;
    const dir = fs.mkdtempSync(path.join(root, 'tower-crane-'));
    return { socket: path.join(dir, 's'), dir, tcp };
  }
  throw refuse(`no socket path short enough for ${where}`);
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
// it and whatever it started when the agent exits.
function run(job, argv, active, input) {
  const env = { ...process.env, TOWER_CRANE_STATE: job.state, TOWER_CRANE_TASK: job.task, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_VIA: 'broker' };
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

async function answer(job, token, line, active) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return { code: 2, stdout: '', stderr: 'tower-crane: the broker got a request that is not JSON\n' };
  }
  if (!req || !sameToken(req.token, token)) return { code: 1, stdout: '', stderr: 'tower-crane: the broker refused a request without its token\n' };
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

// Listens for the agent a spawn monitor starts: job is the monitor's job
// (state, task, agent, role, harness, cwd), job.broker the broker.json path in the
// agent's broker directory and job.broker_harnesses the sandboxed harnesses
// its rung and fallbacks run. Returns the env the agent runs with and close().
async function start(job) {
  const where = path.dirname(job.broker);
  fs.mkdirSync(path.dirname(where), { recursive: true, mode: 0o700 });
  // Tokens stay out of any repository the state directory sits in.
  fs.writeFileSync(path.join(path.dirname(where), '.gitignore'), '*\n');
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  fs.chmodSync(where, 0o700);
  const token = crypto.randomBytes(32).toString('hex');
  const { socket, dir: tmp, tcp } = socketPath(where, job.broker_harnesses || [job.harness]);
  const unix = socket && process.platform !== 'win32';
  if (unix && !tmp) fs.rmSync(socket, { force: true });
  // The commands running and the connections open, stopped when the agent exits.
  const active = { closed: false, children: new Set() };
  const conns = new Set();
  const serve = (conn) => {
    let buf = '';
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (d) => {
      if (buf === null) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length <= MAX_REQUEST) return;
      const line = nl < 0 ? '' : buf.slice(0, nl);
      buf = null;
      answer(job, token, line, active).then((res) => conn.destroyed || conn.end(`${JSON.stringify(res)}\n`));
    });
  };
  const listen = (where) => new Promise((resolve, reject) => {
    const server = net.createServer(serve);
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
      fs.rmSync(where, { recursive: true, force: true });
    },
  };
}

// The agent side: sends the command to the broker when it changes the
// broker's state directory. Another state directory, such as a test
// fixture's, is not the broker's to change, so null leaves the command to
// run here. input is what the command reads from stdin ("-" values).
async function forward(file, argv, stateDir, input) {
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw refuse(`cannot read the state broker at ${file} (${e.code || e.message}); it exists while the agent's spawn runs`);
  }
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

function send(to, request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(...to);
    let sent = false;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sent = true;
      sock.write(request);
    });
    sock.on('data', (d) => (buf += d));
    sock.on('error', (e) => reject(sent ? refuse(`the state broker connection failed (${e.code || e.message})`) : Object.assign(e, { unsent: true })));
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(refuse('the state broker closed without an answer'));
      }
    });
  });
}

module.exports = { ROLES, READS, FILE, dir, start, forward, authorize };
