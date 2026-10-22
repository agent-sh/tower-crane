'use strict';

// The escalation fixture the escalation suites share: a cached repository whose
// rungs run a command harness that records each attempt, and a socket that
// reports the exit of each detached worker and supervisor. Each suite file runs
// in its own process.

const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { cachedFixture, detachedAlive, fakeAgentEnv, BIN } = require('./helpers');
const { killGroup } = require('./signals');
const { readPublished } = require('./atomic-file');

const events = (h) => require('../lib/state').readEvents(h.state);
const preloadOption = (file) => `--require ${JSON.stringify(file)}`;

function until(t, dir, fn) {
  return new Promise((resolve, reject) => {
    const watchers = dir.map((entry) => fs.watch(entry, check));
    const abort = () => finish(t.signal.reason);
    function finish(error) {
      for (const watcher of watchers) watcher.close();
      t.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      try { if (fn()) finish(); }
      catch (error) { finish(error); }
    }
    for (const watcher of watchers) watcher.once('error', finish);
    t.signal.addEventListener('abort', abort, { once: true });
    if (t.signal.aborted) abort();
    else check();
  });
}

function configure(h, trigger) {
  h.attempts = path.join(h.base, 'attempts.json');
  for (const [index, rung] of ['easy', 'medium', 'hard'].entries()) {
    const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const cli = (args) => cp.execFileSync(process.execPath, [process.argv[1], ...args], { encoding: 'utf8' });
${index === 0 && trigger === 'preclaim' ? '' : "cli(['claim', 'T1']);"}
const attempts = fs.existsSync(process.argv[2]) ? JSON.parse(require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))}).readPublished(process.argv[2])) : [];
attempts.push({ rung: '${rung}', agent: process.env.TOWER_CRANE_AGENT, session: process.env.TOWER_CRANE_SESSION,
  previous: process.argv[3], cwd: process.cwd() });
// Readers and fs.watch can briefly prevent replacing an existing file on Windows.
require(require('node:path').join(require('node:path').dirname(process.argv[1]), '../lib/state'))
  .writeAtomic(process.argv[2], JSON.stringify(attempts));
console.log(JSON.stringify({ type: 'thread.started', thread_id: '${rung}-thread' }));
console.log(JSON.stringify({ type: 'result', modelUsage: { 'fixture-light': {} },
  usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 } }));
${index === 0 && ['cleanup', 'orphan'].includes(trigger) ? `
cp.spawn(process.execPath, ['-e', \`
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync(process.argv[1] + '.term', 'stopping'));
fs.writeFileSync(process.argv[1] + '.ready.tmp', String(process.pid));
fs.renameSync(process.argv[1] + '.ready.tmp', process.argv[1] + '.ready');
setInterval(() => {}, 1000);
\`, process.argv[2]], { stdio: 'ignore' });
` : ''}
${index === 0 && ['stall', 'hold', 'orphan'].includes(trigger) ? 'setInterval(() => {}, 1000);'
    : index === 0 && trigger === 'outage' ? "console.error('HTTP 503 service unavailable'); process.exit(1);"
      : index === 0 && trigger === 'refusal' ? "console.log(JSON.stringify({ type: 'refusal' })); process.exit(1);"
        : trigger === 'top' || index === 0 && ['exit', 'preclaim'].includes(trigger) ? 'process.exit(0);'
      : "cli(['submit', 'T1', '--sha', fs.readFileSync(process.argv[2] + '.sha', 'utf8')]);"}
${index === 0 && trigger === 'cleanup' ? `
const stop = () => { if (fs.existsSync(process.argv[2] + '.exit')) process.exit(0); };
fs.watch(require('node:path').dirname(process.argv[2]), stop);
stop();
` : ''}
`;
    h.ok(['ladder', 'set', rung, '--harness', 'command', '--command',
      JSON.stringify([process.execPath, '-e', script, BIN, h.attempts, '{session}', '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--clear', 'model', '--supervision',
      JSON.stringify({ retries: 0, ...(index === 0 && trigger === 'stall' ? { stall_ms: 100 } : {}), backoff_ms: 10, max_backoff_ms: 10 })]);
  }
}

async function setup(t, trigger = 'exit', range = 'easy..medium', prepare = null) {
  const h = cachedFixture(null, `escalation:${range}:${trigger}`, (repo) => {
    repo.init();
    repo.ok(['task', 'add', '--title', 'Start low', '--tier', range, '--acceptance', 'climbs on quality failure']);
    repo.ok(['brief', 'set', 'T1', '-'], { input: 'Finish the task.\n' });
    configure(repo, trigger);
  });
  // Harness discovery must use fixture credentials and origin directories.
  Object.assign(h.env, {
    USERPROFILE: h.env.HOME,
    CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'),
    CODEX_HOME: path.join(h.env.HOME, '.codex'),
    PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
    GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'),
    XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
    OPENCODE_CONFIG_DIR: path.join(h.env.HOME, '.config', 'opencode'),
  });
  h.attempts = path.join(h.base, 'attempts.json');
  const exits = new Map();
  const sockets = new Set();
  const signal = path.join(h.base, 'process-signal.cjs');
  // Socket closure observes detached exits even when SIGKILL prevents a receipt.
  fs.writeFileSync(signal, `
const path = require('node:path');
if (process.execArgv.includes('-e') && process.env.TOWER_CRANE_SESSION
  || ['spawn-monitor.js', 'usage-harness.js'].includes(path.basename(process.argv[1] || ''))) {
  const socket = require('node:net').connect(Number(process.env.HOOK_ESCALATION_SIGNAL_PORT), '127.0.0.1', () => {
    socket.write(String(process.pid) + '\\n');
    socket.unref();
  });
  socket.on('error', () => socket.destroy());
}
`);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let text = '';
    const exited = new Promise((resolve) => socket.once('close', () => {
      sockets.delete(socket);
      resolve();
    }));
    socket.on('data', (data) => {
      text += data;
      if (text.includes('\n')) {
        exits.set(Number(text.trim()), exited);
        fs.writeFileSync(path.join(h.base, 'process-connected'), text);
      }
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  h.env.HOOK_ESCALATION_SIGNAL_PORT = String(server.address().port);
  h.env.NODE_OPTIONS = preloadOption(signal);
  h.task = () => h.readState('tasks.json').tasks.find((task) => task.id === 'T1');
  h.openDecisions = () => h.readState('decisions.json').decisions.filter((decision) => decision.status === 'open');
  h.until = (fn, dirs = [h.state, h.base]) => until(t, dirs, () => {
    // The predicate must see a ceiling the guard saw before rejecting that ceiling.
    const ceiling = h.openDecisions().find((decision) => decision.blocks.includes('T1'));
    if (fn()) return true;
    if (ceiling) {
      const exit = events(h).findLast((event) => event.cmd === 'spawn exit' && event.task === 'T1');
      const log = exit?.detail.log;
      throw new Error(`Unexpected escalation ceiling: ${ceiling.question}\n`
        + `Worker ${exit?.agent}: exit ${exit?.detail.code}, signal ${exit?.detail.signal}, log ${log}\n`
        + (log && fs.existsSync(log) ? readPublished(log, 'utf8') : 'No worker log'));
    }
    return false;
  });
  h.exitSignal = async (child) => {
    // Teardown must still observe exits after an expected ceiling decision.
    await until(t, [h.base], () => exits.has(child.pid) || !detachedAlive(child));
    return { exited: exits.get(child.pid) || Promise.resolve() };
  };
  t.after(async () => {
    try {
      if (t.signal.aborted) {
        t.diagnostic(JSON.stringify({ task: h.task(), attempts: h.readAttempts?.(), events: events(h).slice(-12) }));
      }
      // Stop background usage and gate retries before removing fixture state.
      for (const child of h.detached()) {
        if (child.kind !== 'monitor' || !detachedAlive(child)) continue;
        const { exited } = await h.exitSignal(child);
        if (process.platform === 'win32') {
          cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { killGroup(child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await exited;
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await h.cleanup();
    }
  });
  if (prepare) prepare(h);
  // Exit signals and publication faults are explicit worker instrumentation.
  h.ok(['project', 'set', '--env', JSON.stringify(fakeAgentEnv({ ...h.readState('project.json').env, NODE_OPTIONS: h.env.NODE_OPTIONS }))]);
  // Gate preparation can change HEAD after the cached ladder was built.
  fs.writeFileSync(h.attempts + '.sha', h.git(['rev-parse', 'HEAD']));
  h.readAttempts = () => fs.existsSync(h.attempts) ? JSON.parse(readPublished(h.attempts)) : [];
  return h;
}

module.exports = { events, preloadOption, until, setup };
