'use strict';

const { waitUntil, HUNG_TEST_MS, killPid } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TMP_ROOT, ROOT, detachedAlive, makeRepo, stubRungs } = require('./helpers');
const { stacked } = require('./stack-fixture');
const B = require('../lib/broker');
const harnessHooks = require('../lib/harness-hooks');
const { resolveCommand, parseOptions, GLOBAL } = require('../bin/tower-crane');
const { readPublished } = require('./atomic-file');
const { socketDir } = require('./socket-dir');
const { assertFits, MAX_SOCKET_PATH, agentDir } = require('../lib/socket-path');

// This process plays the host monitor; fixture agents still run their own shims.
// The worker's outer shim would refuse the monitor's index-pack and push.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
const monitorPath = process.env[pathKey];
process.env[pathKey] = String(monitorPath || '').split(path.delimiter)
  .filter((dir) => !require('../lib/agents').agentShims(dir)).join(path.delimiter);
test.after(() => {
  if (monitorPath === undefined) delete process.env[pathKey];
  else process.env[pathKey] = monitorPath;
});

function scratch(t) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(TMP_ROOT, 'tower-crane-broker-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const state = path.join(base, 'state');
  const home = path.join(base, 'home');
  fs.mkdirSync(state);
  fs.mkdirSync(home);
  return { base, state, job: { state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: base, broker: path.join(home, B.FILE) } };
}

function parse(argv) {
  const r = resolveCommand(argv);
  return parseOptions([...r.lead, ...r.rest], { ...(r.cmd.flags || {}), ...GLOBAL }, r.cmd.name);
}

test('socket addresses fit the Unix byte limit, including multibyte names', () => {
  for (const [socket, fits] of [
    ['s'.repeat(MAX_SOCKET_PATH), true],
    ['s'.repeat(MAX_SOCKET_PATH + 1), false],
    ['é'.repeat(51) + 's', true],
    ['é'.repeat(52), false],
  ]) {
    if (fits) assert.equal(assertFits(socket), socket);
    else assert.throws(() => assertFits(socket), /socket path exceeds 103 bytes/);
  }
});

test('short socket directories serve claude, codex and mixed routes with long fixture paths', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  for (const [harnesses, stale] of [
    [['claude'], 'file'],
    [['codex'], 'owner'],
    [['claude', 'codex'], 'directory'],
    [['claude'], 'socket'],
    [['codex'], 'owner-link'],
  ]) {
    const granted = agentDir(path.join(s.base, harnesses.join('-'), stale), process.env);
    fs.mkdirSync(granted, { mode: 0o700 });
    t.after(() => fs.rmSync(granted, { recursive: true, force: true }));
    const job = { ...s.job, broker_harnesses: harnesses, agent_socket_dir: granted,
      agent_tmp: path.join(s.base, 'too-long-'.repeat(20)) };
    const previous = path.join(granted, 's');
    if (stale === 'file') fs.writeFileSync(previous, 'left by an interrupted run');
    if (stale === 'directory') fs.mkdirSync(previous);
    if (stale === 'socket') {
      const killed = require('node:child_process').spawnSync(process.execPath, ['-e',
        "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", previous]);
      assert.equal(killed.signal, 'SIGKILL');
      assert.ok(fs.lstatSync(previous).isSocket());
    }
    if (stale === 'owner') {
      const dead = require('node:child_process').spawnSync(process.execPath, ['-e', '']);
      assert.equal(dead.status, 0);
      const old = Date.now() - 10 * 60_000;
      fs.writeFileSync(path.join(granted, 'owner.json'), JSON.stringify({ pid: dead.pid, host: os.hostname(), started: old }));
      fs.utimesSync(granted, old / 1000, old / 1000);
    }
    const protectedFile = path.join(s.base, 'owner-target');
    if (stale === 'owner-link') {
      fs.writeFileSync(protectedFile, 'keep');
      fs.symlinkSync(protectedFile, path.join(granted, 'owner.json'));
    }
    const broker = await B.start(job);
    try {
      const { socket } = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
      if (harnesses.includes('claude')) {
        assert.equal(socket, path.join(granted, 's'));
        assert.equal(assertFits(socket), socket);
        assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
      } else assert.equal(socket, undefined, 'Codex keeps its TCP transport');
      assert.equal(fs.statSync(granted).mode & 0o777, 0o700);
      assert.equal(JSON.parse(fs.readFileSync(path.join(granted, 'owner.json'), 'utf8')).pid, process.pid);
      if (stale === 'owner-link') assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep', 'the monitor never writes through an agent-planted owner link');
      assert.equal(await B.dead(job.broker), false, 'the short socket accepts connections');
    } finally {
      broker.close();
    }
    assert.equal(fs.existsSync(granted), false, 'closing removes the per-run socket directory');
  }
});

test('a broker preserves existing directories and writes its ignore file only in a directory it creates', async (t) => {
  const h = makeRepo(t);
  const parent = path.join(h.base, 'brokers');
  fs.mkdirSync(parent);
  for (const existingIgnore of [false, true]) {
    const where = path.join(parent, existingIgnore ? 'with-ignore' : 'without-ignore');
    fs.mkdirSync(where);
    const ignore = path.join(where, '.gitignore');
    const sentinel = path.join(where, 'keep.txt');
    fs.writeFileSync(sentinel, 'keep\n');
    if (existingIgnore) fs.writeFileSync(ignore, 'keep.txt\n');
    const broker = await B.start({ state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker',
      harness: 'codex', cwd: h.repo, broker: path.join(where, B.FILE) });
    try {
      assert.equal(fs.existsSync(path.join(parent, '.gitignore')), false, 'the broker does not write into its existing parent');
      assert.equal(fs.existsSync(ignore), existingIgnore);
      if (existingIgnore) assert.equal(fs.readFileSync(ignore, 'utf8'), 'keep.txt\n');
    } finally {
      broker.close();
    }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep\n', 'closing a broker preserves an existing directory');
    assert.equal(fs.existsSync(path.join(where, B.FILE)), false);
  }

  const where = path.join(h.repo, 'new-brokers', 'worker-T1-1');
  const broker = await B.start({ state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker',
    harness: 'codex', cwd: h.repo, broker: path.join(where, B.FILE) });
  try {
    assert.equal(fs.readFileSync(path.join(where, '.gitignore'), 'utf8'), '*\n');
    assert.equal(fs.existsSync(path.join(path.dirname(where), '.gitignore')), false);
    assert.equal(h.git(['status', '--porcelain', '--untracked-files=all', '--', 'new-brokers']), '', 'git ignores the broker token');
  } finally {
    broker.close();
  }
  assert.equal(fs.existsSync(where), false, 'closing a broker removes its own directory');
});

test('option names from a request cannot reach Object.prototype', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseOptions([`--${name}`, 'x'], {}, 'task note'), /unknown option/, name);
    assert.throws(() => parseOptions([`--${name}=x`], { ...GLOBAL }), /unknown option/, name);
  }
  const { flags } = parseOptions(['--agent', 'a'], { ...GLOBAL });
  assert.equal(Object.getPrototypeOf(flags), Object.prototype);
  assert.deepEqual(flags, { agent: 'a' });
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  assert.throws(() => B.authorize(job, ['task', 'note', 'T1', '--__proto__', 'x']), /unknown option --__proto__/);
});

test('the broker names the agent and state before the agent\'s own "--"', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  const note = parse(B.authorize(job, ['task', 'note', 'T1', '--', '--flag', 'text']));
  assert.deepEqual(note.pos, ['T1', '--flag', 'text'], 'the note keeps the agent\'s text, and only it');
  assert.equal(note.flags.agent, 'worker-T1-1');
  assert.equal(note.flags.state, '/s');
  const claim = parse(B.authorize(job, ['claim', 'T1', '--']));
  assert.deepEqual(claim.pos, ['T1']);
  assert.deepEqual([claim.flags.agent, claim.flags.state], ['worker-T1-1', '/s']);
  const named = parse(B.authorize(job, ['task', 'note', '--agent', 'worker-T1-1', 'T1', '--', '--agent', 'owner']));
  assert.deepEqual(named.pos, ['T1', '--agent', 'owner'], 'text after "--" is the note, not an identity');
  assert.equal(named.flags.agent, 'worker-T1-1');
});

test('the broker rejects an identity that differs from its spawn', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  for (const agent of ['owner', 'worker-T2-1']) {
    assert.throws(() => B.authorize(job, ['task', 'note', 'T1', 'text', '--agent', agent]), new RegExp(`cannot act as ${agent}`));
  }
});

test('a worker broker refuses unscoped dead-claim recovery and preserves peer claims', async (t) => {
  const h = makeRepo(t);
  h.init();
  for (const id of ['T1', 'T2']) {
    h.ok(['task', 'add', '--title', id, '--acceptance', 'claim is scoped']);
    h.ok(['claim', id, '--agent', `worker-${id}-1`]);
  }
  const file = path.join(h.state, 'events.jsonl');
  fs.appendFileSync(file, JSON.stringify({ id: 'dead-peer', at: new Date().toISOString(), cmd: 'spawn',
    agent: 'orchestrator', task: 'T2', detail: { agent: 'worker-T2-1', role: 'worker', pid: 2147483647 } }) + '\n');
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'codex',
    cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const before = h.readState('tasks.json');
  const events = fs.readFileSync(file, 'utf8');
  const result = await h.runAsync(['release', '--dead'], {
    env: { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task },
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release --dead.*orchestrator|unscoped/i);
  assert.deepEqual(h.readState('tasks.json'), before);
  assert.equal(fs.readFileSync(file, 'utf8'), events);
  assert.throws(() => B.authorize(job, ['release', '--dead']), /release --dead.*orchestrator|unscoped/i);
  const own = await h.runAsync(['release', 'T1', '--reason', 'handoff'], {
    env: { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task },
  });
  assert.equal(own.code, 0, own.stderr);
  assert.equal(h.readState('tasks.json').tasks[1].claim.agent, 'worker-T2-1');
});

test('the broker answers no request without its token and acts on its own task only', async (t) => {
  const { job } = scratch(t);
  for (const argv of [['task', 'note', 'T2', 'x'], ['claim', 'T2'], ['ask', '--kind', 'technical', '--question', 'q', '--option', 'a', '--option', 'b', '--blocks', 'T2']]) {
    assert.throws(() => B.authorize(job, argv), /works on T1 only, not T2/, argv.join(' '));
  }
  const broker = await B.start(job);
  t.after(() => broker.close());
  const at = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  const reply = await new Promise((resolve, reject) => {
    const s = require('node:net').connect(at.socket || { host: at.host, port: at.port }, () => {
      s.write(JSON.stringify({ token: '0'.repeat(64), argv: ['task', 'note', 'T1', 'forged'] }) + '\n');
    });
    let out = '';
    s.on('data', (d) => { out += d; }).on('end', () => resolve(JSON.parse(out))).on('error', reject);
  });
  assert.equal(reply.code, 1);
  assert.match(reply.stderr, /without its token/);
});

for (const role of ['worker', 'reviewer', 'small']) test(`a sandboxed ${role} answers through the CLI and broker only after owner delegation`, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Choose a store', '--acceptance', 'answer is authorized']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--blocks', 'T1']);
  const job = {
    state: h.state, task: 'T1', agent: `${role}-T1-1`, role, harness: 'codex',
    cwd: h.repo, broker: path.join(h.base, 'brokers', `${role}-T1-1`, B.FILE),
  };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const env = { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task };
  const log = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const before = log();
  const denied = await h.runAsync(['answer', 'D1', '--choice', 'redis'], { env });
  assert.equal(denied.code, 1, denied.stderr);
  assert.equal(log(), before, 'a refused brokered answer writes no event');
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');

  h.ok(['decision', 'delegate', 'D1', '--answerers', JSON.stringify([job.agent]), '--agent', 'owner']);
  const answered = await h.runAsync(['answer', 'D1', '--choice', 'redis'], { env });
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(denied.stderr, /only the owner with explicit identity/);
  const granted = log();
  const forged = await h.runAsync(['answer', 'D1', '--choice', 'redis', '--agent', 'worker-other'], { env });
  assert.equal(forged.code, 1, forged.stderr);
  assert.match(forged.stderr, /cannot act as worker-other/);
  assert.equal(log(), granted, 'the broker refuses another identity even after delegation');
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.status, decision.answered_by, decision.answer_rule], [
    'answered', job.agent, 'owner-named-agent',
  ]);
  const event = log().trim().split('\n').map(JSON.parse).findLast((entry) => entry.cmd === 'answer');
  assert.deepEqual([event.agent, event.via, event.detail.answered_by, event.detail.answer_rule], [
    job.agent, 'broker', job.agent, 'owner-named-agent',
  ]);
  assert.equal(h.readState('tasks.json').tasks[0].notes.at(-1).agent, job.agent);
});

test('a sandboxed worker withdraws its own question through the broker; a reviewer cannot withdraw it', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Waits on a question', '--acceptance', 'the withdrawal frees it']);
  h.ok(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1', '--agent', 'worker-T1-1']);
  const brokerEnv = async (role) => {
    const job = {
      state: h.state, task: 'T1', agent: `${role}-T1-1`, role, harness: 'codex',
      cwd: h.repo, broker: path.join(h.base, 'brokers', `${role}-T1-1`, B.FILE),
    };
    const broker = await B.start(job);
    t.after(() => broker.close());
    return { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task };
  };
  const log = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const withdraw = ['decision', 'withdraw', 'D1', '--reason', 'the question went away'];
  const before = log();

  // The grant is for the asker only: a reviewer's withdrawal of the worker's question is refused by the CLI.
  const refused = await h.runAsync(withdraw, { env: await brokerEnv('reviewer') });
  assert.equal(refused.code, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /only the agent that opened D1 \(worker-T1-1\) or the owner/);
  assert.equal(h.readState('decisions.json').decisions[0].status, 'open');
  assert.equal(log(), before, 'a refused brokered withdrawal writes no event');

  // The worker names no other identity, and withdraws its own question with a reason.
  const worker = await brokerEnv('worker');
  const forged = await h.runAsync([...withdraw, '--agent', 'owner'], { env: worker });
  assert.equal(forged.code, 1, forged.stderr);
  assert.match(forged.stderr, /owner identity needs a process the owner runs/);
  assert.equal(log(), before, 'a forged identity writes no event');
  const done = await h.runAsync(withdraw, { env: worker });
  assert.equal(done.code, 0, done.stderr);
  const decision = h.readState('decisions.json').decisions[0];
  assert.deepEqual([decision.status, decision.withdrawn_by, decision.withdraw_reason], [
    'withdrawn', 'worker-T1-1', 'the question went away',
  ]);
  const event = log().trim().split('\n').map(JSON.parse).findLast((entry) => entry.cmd === 'decision withdraw');
  assert.deepEqual([event.type, event.agent, event.via, event.detail.reason], [
    'decision-withdrawn', 'worker-T1-1', 'broker', 'the question went away',
  ]);
  assert.match(h.readState('tasks.json').tasks[0].notes.at(-1).text, /decision D1 withdrawn: the question went away/);
});

test('a sandboxed reviewer asks through the broker: a technical question reaches the orchestrator, an escalation stays with the owner', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Review a store choice', '--acceptance', 'ask is authorized']);
  h.ok(['project', 'set', '--decision-delegation', '{"orchestrator_technical":true}', '--agent', 'owner']);
  const job = {
    state: h.state, task: 'T1', agent: 'reviewer-T1-1', role: 'reviewer', harness: 'codex',
    cwd: h.repo, broker: path.join(h.base, 'brokers', 'reviewer-T1-1', B.FILE),
  };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const env = { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task };

  const asked = await h.runAsync(['ask', '--kind', 'technical', '--question', 'Which store?', '--option', 'redis', '--option', 'postgres', '--blocks', 'T1'], { env });
  assert.equal(asked.code, 0, asked.stderr);
  const technical = h.readState('decisions.json').decisions[0];
  assert.deepEqual([technical.asked_by, technical.technical, technical.escalation], [job.agent, true, undefined]);
  h.ok(['answer', 'D1', '--choice', 'redis', '--agent', 'orchestrator']);
  assert.equal(h.readState('decisions.json').decisions[0].answer_rule, 'owner-technical-delegation');

  const escalated = await h.runAsync(['ask', '--kind', 'technical', '--question', 'Raise the budget?', '--option', 'yes', '--option', 'no', '--setting', 'budget.raise', '--blocks', 'T1'], { env });
  assert.equal(escalated.code, 0, escalated.stderr);
  assert.deepEqual(h.readState('decisions.json').decisions[1].escalation, { settings: ['budget.raise'], change: null });
  const refused = h.run(['answer', 'D2', '--choice', 'yes', '--agent', 'orchestrator']);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /D2 escalates budget\.raise to the owner/);

  const asks = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((event) => event.cmd === 'ask');
  assert.deepEqual(asks.map((event) => [event.agent, event.via]), [[job.agent, 'broker'], [job.agent, 'broker']]);
});

test('closing the broker stops the commands it is running and what they started', async (t) => {
  // After hooks run in registration order, so this one comes before scratch(t)'s, which deletes the
  // fixture that holds the pids file.
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_TEST_PIDS: process.env.BROKER_TEST_PIDS };
  let pids;
  let broker;
  let started = [];
  t.after(() => {
    // A failed test leaves the broker's servers open, which keeps the test runner alive.
    broker?.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    // Read the file, not `started`: a test that fails before reading it still leaves them running.
    const text = pids && fs.existsSync(pids) ? readPublished(pids, 'utf8') : '';
    const recorded = text ? JSON.parse(text) : [];
    for (const pid of recorded.filter((p) => detachedAlive({ pid: p }))) killPid(pid, 'SIGKILL');
  });
  const { base, state, job } = scratch(t);
  pids = path.join(base, 'pids.json');
  // Preloaded into the CLI the broker runs: it starts a process in a group of
  // its own, as a check's test run does, records both and never returns.
  const preload = path.join(base, 'hang.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.BROKER_TEST_PIDS;
const run = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { env, detached: process.platform !== 'win32', stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.BROKER_TEST_PIDS, JSON.stringify([process.pid, run.pid]));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`);
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_TEST_PIDS = pids;

  broker = await B.start(job);
  const answer = B.forward(job.broker, ['task', 'note', 'T1', 'slow'], state).then((r) => ({ r }), (e) => ({ e }));
  const until = (check, what) => waitUntil(check, { paths: [base], signal: t.signal, what });
  await until(() => fs.existsSync(pids) && readPublished(pids, 'utf8').length > 0, 'the brokered command started');
  started = JSON.parse(fs.readFileSync(pids, 'utf8'));
  broker.close();
  await until(() => started.every((pid) => !detachedAlive({ pid })), 'the command and its own process group stop with the broker');
  const { r, e } = await answer;
  assert.ok(e || r.code !== 0, 'the agent gets no success for a command the broker stopped');
  assert.ok(!fs.existsSync(job.broker), 'broker.json is gone');
});

test('a brokered command runs no git, whose repository config and commits the agent writes', async (t) => {
  const h = makeRepo(t);
  h.env.TOWER_CRANE_TMP = path.join(h.base, 'gate-tmp');
  h.init(['--ci-local', JSON.stringify({ command: [process.execPath, '-e', ''], timeout: 5 })]);
  h.git(['switch', '-qc', 'change']);
  fs.writeFileSync(path.join(h.repo, 'change.txt'), 'change\n');
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'change']);
  const sha = h.git(['rev-parse', 'HEAD']);
  h.git(['switch', '-q', 'main']);
  h.ok(['task', 'add', '--title', 'gated', '--kind', 'docs', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', sha, '--branch', 'change', '--pr', '1']);
  // With ok local CI evidence on a submitted task, the sketch's gate report
  // reads the repository with git (merge-tree, whose merge drivers the
  // repository's config names).
  assert.equal(h.json(['check', 'ci', 'T1', '--agent', 'checker']).ok, true);

  const log = path.join(h.base, 'git.log');
  const preload = path.join(h.base, 'git-log.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
for (const name of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  const original = cp[name];
  cp[name] = function (command, args, ...rest) {
    if (process.env.TOWER_CRANE_VIA === 'broker' && /(^|[\\\\/])git(\\.exe)?$/.test(command)) fs.appendFileSync(process.env.BROKER_GIT_LOG, JSON.stringify(args) + '\\n');
    return original.call(this, command, args, ...rest);
  };
}
`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_GIT_LOG: process.env.BROKER_GIT_LOG };
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_GIT_LOG = log;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const r = await B.forward(job.broker, ['task', 'note', 'T1', 'brokered'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => [n.agent, n.text]), [['worker-T1-1', 'brokered']]);
  assert.equal(fs.existsSync(log) ? readPublished(log, 'utf8') : '', '', 'the broker ran git');
});

test('a worker cannot have the broker run its tests, its cleanup or git', () => {
  const job = { state: '/s', task: 'T1', agent: 'worker-T1-1', role: 'worker' };
  for (const argv of [['check', 'tests', 'T1', '--cmd', 'cat ~/.ssh/id_ed25519'], ['check', 'tests', 'T1'], ['check', 'clean', 'T1'], ['check', 'ci', 'T1'], ['worktree', 'T1']]) {
    assert.throws(() => B.authorize(job, argv), /changes state only with/, argv.join(' '));
  }
  for (const role of Object.keys(B.ROLES)) for (const cmd of B.ROLES[role]) assert.ok(!/^(check|worktree|merge|spawn)\b/.test(cmd), `${role}: ${cmd}`);
});

test('a claude broker whose own directory is too deep listens in the agent\'s own temp directory, which only its sandbox reaches', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'deep', '--acceptance', 'noted']);
  // claudeTmp in lib/agents.js: the directory claude's sandbox reads and writes for this agent alone.
  const tmp = socketDir(t, require('../lib/gate-tmp').HARNESS_TMPDIR_MAX);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'claude', broker_harnesses: ['claude'],
    agent_tmp: tmp, cwd: h.repo, broker: path.join(h.base, 'w'.repeat(90), B.FILE) };
  const broker = await B.start(job);
  let closed = false;
  t.after(() => closed || broker.close());
  const { socket } = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  assert.equal(socket, path.join(tmp, 'broker.sock'));
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const r = await B.forward(job.broker, ['task', 'note', 'T1', 'from a deep state'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => n.text), ['from a deep state']);
  broker.close();
  closed = true;
  assert.equal(fs.existsSync(socket), false, 'closing removes the socket');
  assert.equal(fs.existsSync(tmp), true, 'closing keeps the agent\'s temp directory');
});

test('a claude broker with no short temp directory of its own uses its explicitly granted socket directory', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const granted = socketDir(t);
  // The caller's TMPDIR is short and under the home, as ~/.cache/... is in production. The agent's
  // temp directory is a codex rung's, too long for claude's proxy sockets, so a claude fallback has none.
  const caller = path.join(s.base, 'tmp');
  fs.mkdirSync(caller);
  const saved = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME };
  process.env.TMPDIR = caller;
  process.env.HOME = os.userInfo().homedir;
  t.after(() => {
    for (const key of ['TMPDIR', 'HOME']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const codexTmp = path.join(s.base, 'c'.repeat(80));
  assert.equal(require('../lib/gate-tmp').harnessFits(codexTmp), false);
  const job = { ...s.job, harness: 'codex', broker_harnesses: ['codex', 'claude'], agent_tmp: codexTmp, agent_socket_dir: granted, broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const { socket } = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  assert.equal(socket, path.join(granted, 's'));
  assert.equal(assertFits(socket), socket);
  assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
});

test('a claude broker refuses to start when no socket path its sandbox reaches can be made', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const attempted = [];
  t.mock.method(fs, 'mkdtempSync', (prefix) => {
    attempted.push(path.dirname(prefix));
    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  });
  const job = { ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  await assert.rejects(B.start(job), /no socket path that the agent's sandbox reaches.*XDG_CACHE_HOME/s);
  assert.deepEqual(attempted, [os.tmpdir()]);
  assert.equal(fs.existsSync(path.dirname(job.broker)), false, 'the refused start leaves no broker directory');
});

// A fallback directory as a broker's start makes it, with `s` planted in its way.
function blockedFallback(t) {
  const made = [];
  const { mkdtempSync: mkdtemp, rmSync: rm } = fs;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const dir = mkdtemp(...args);
    made.push(dir);
    // Something in the way of the socket makes listen fail.
    fs.mkdirSync(path.join(dir, 's'));
    return dir;
  });
  t.after(() => made.forEach((dir) => rm(dir, { recursive: true, force: true })));
  return made;
}

test('a broker removes the temporary socket directory it made when it cannot listen there', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const made = blockedFallback(t);
  const job = { ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  await assert.rejects(B.start(job), /EADDRINUSE/);
  assert.equal(made.length, 1);
  assert.equal(path.dirname(made[0]), os.tmpdir());
  assert.equal(fs.existsSync(made[0]), false, 'the failed start leaves no socket directory');
  assert.equal(fs.existsSync(path.dirname(job.broker)), false, 'nor the broker directory it made');
});

test('a broker start that cannot listen and cannot clean up reports the listen error with the cleanup error attached', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const made = blockedFallback(t);
  const rmdirSync = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (p, ...rest) => {
    if (made.includes(p)) throw Object.assign(new Error(`EBUSY: resource busy, rmdir '${p}'`), { code: 'EBUSY' });
    return rmdirSync(p, ...rest);
  });
  const job = { ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  await assert.rejects(B.start(job), (e) => {
    assert.equal(e.code, 'EADDRINUSE');
    assert.match(e.message, /EADDRINUSE.*cleaning up after it failed: EBUSY/s);
    assert.equal(e.cleanup?.code, 'EBUSY');
    return true;
  });
  assert.equal(fs.existsSync(path.dirname(job.broker)), false, 'the other cleanup steps still ran');
});

test('a broker start sweeps temporary socket directories of killed brokers and keeps every other one', { skip: (process.platform === 'win32' || typeof process.getuid !== 'function') && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const net = require('node:net');
  const planted = [];
  const plant = (prefix = 'tower-crane-') => {
    const dir = prefix === 'tc-'
      ? path.join(os.tmpdir(), `tc-${require('node:crypto').randomBytes(6).toString('hex')}`)
      : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    if (prefix === 'tc-') fs.mkdirSync(dir, { mode: 0o700 });
    assertFits(path.join(dir, 's'));
    planted.push(dir);
    return dir;
  };
  t.after(() => planted.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const old = Date.now() - 10 * 60_000;
  const age = (dir) => {
    fs.utimesSync(dir, old / 1000, old / 1000);
    return dir;
  };
  // A broker's monitor SIGKILLed while it listened: its socket file stays and refuses connections.
  let deadPid;
  const killed = (dir) => {
    const r = require('node:child_process').spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))", path.join(dir, 's')]);
    assert.equal(r.signal, 'SIGKILL');
    assert.ok(fs.lstatSync(path.join(dir, 's')).isSocket());
    deadPid = r.pid;
    return dir;
  };
  const record = (dir, owner) => {
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ host: os.hostname(), started: old, ...owner }), { flag: 'wx', mode: 0o600 });
    return dir;
  };
  const self = require('../lib/processes').identity(process.pid);
  // Made by an older Tower Crane, with no owner record: its socket's refusal is the proof.
  const legacyDead = age(killed(plant()));
  const legacyYoung = killed(plant());
  const live = plant();
  const server = await new Promise((resolve) => { const srv = net.createServer().listen(path.join(live, 's'), () => resolve(srv)); });
  t.after(() => server.close());
  age(live);
  const starting = age(plant());
  const shared = killed(plant());
  fs.writeFileSync(path.join(shared, 'other'), 'not the broker\'s', { flag: 'wx', mode: 0o600 });
  age(shared);
  const foreign = age(killed(plant('tower-crane-other-')));
  // Made by this version: the owner record decides, not the socket.
  const ownerGone = age(record(killed(plant()), { pid: deadPid }));
  const ownerGoneUnbound = age(record(plant(), { pid: deadPid }));
  const shortOwnerGone = age(record(killed(plant('tc-')), { pid: deadPid }));
  const ownerLive = age(record(killed(plant()), { pid: process.pid, ...self }));
  const shortOwnerLive = age(record(killed(plant('tc-')), { pid: process.pid, ...self }));
  const ownerGoneYoung = age(record(killed(plant()), { pid: deadPid, started: Date.now() }));
  const ownerElsewhere = age(record(killed(plant()), { pid: deadPid, host: `not-${os.hostname()}` }));
  // A record reached through a link is not the broker's: the link is not followed.
  const ownerLinked = killed(plant());
  const target = path.join(s.base, 'owner-target.json');
  fs.writeFileSync(target, JSON.stringify({ pid: deadPid, host: os.hostname(), started: old }));
  fs.symlinkSync(target, path.join(ownerLinked, 'owner.json'));
  age(ownerLinked);
  const reused = process.platform === 'linux' ? [age(record(killed(plant()), { pid: process.pid, host: os.hostname(), start_ticks: '1' }))] : [];
  const broker = await B.start({ ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'brokers', 'worker-T1-1', B.FILE) });
  t.after(() => broker.close());
  for (const dir of [legacyDead, ownerGone, ownerGoneUnbound, shortOwnerGone, ...reused]) assert.equal(fs.existsSync(dir), false, `a killed broker's ${dir} is swept`);
  for (const dir of [legacyYoung, live, starting, shared, foreign, ownerLive, shortOwnerLive, ownerGoneYoung, ownerElsewhere, ownerLinked]) assert.equal(fs.existsSync(dir), true, `${dir} stays`);
  assert.ok(fs.lstatSync(path.join(live, 's')).isSocket(), 'the live broker keeps its socket');
  assert.ok(fs.lstatSync(path.join(ownerLive, 's')).isSocket(), 'a live owner keeps a socket that refuses connections');
});

test('a FIFO planted as an owner record does not block a broker start', { skip: (process.platform === 'win32' || typeof process.getuid !== 'function') && 'Windows has no FIFOs' }, (t) => {
  const s = scratch(t);
  const cp = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-crane-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'owner.json');
  const made = cp.spawnSync('mkfifo', [fifo]);
  if (made.status !== 0) return t.skip('mkfifo is unavailable');
  const old = (Date.now() - 10 * 60_000) / 1000;
  fs.utimesSync(dir, old, old);
  // Opening a FIFO with no writer blocks, so the start runs in a child with a bound.
  const job = { ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'brokers', 'worker-T1-1', B.FILE) };
  const r = cp.spawnSync(process.execPath, ['-e', "require(process.argv[1]).start(JSON.parse(process.argv[2])).then((b) => { b.close(); process.stdout.write('started') })",
    path.join(ROOT, 'lib', 'broker.js'), JSON.stringify(job)], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' }); // wait-allow: a blocked FIFO open never returns, so the bound turns that hang into this test's failure
  assert.equal(r.signal, null, 'the start finished within its bound');
  assert.equal(r.stdout, 'started', r.stderr);
  assert.ok(fs.lstatSync(fifo).isFIFO(), 'a record that is not a file is not the broker\'s: the directory stays');
});

test('a broker that falls back to a temporary socket directory names its monitor in an owner record', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const job = { ...s.job, broker_harnesses: ['claude'], broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  const before = Date.now();
  const broker = await B.start(job);
  const after = Date.now();
  t.after(() => broker.close());
  const { socket } = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(socket), 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.host, os.hostname());
  assert.ok(owner.started >= before && owner.started <= after, `${owner.started} is the start's time`);
  assert.equal(require('../lib/processes').processState(owner), 'running');
});

test('what the agent leaves at its broker.sock breaks neither the next spawn nor the broker\'s close, and the broker never walks it', { skip: process.platform === 'win32' && 'Windows uses a named pipe' }, async (t) => {
  const s = scratch(t);
  const tmp = socketDir(t, require('../lib/gate-tmp').HARNESS_TMPDIR_MAX);
  const sock = path.join(tmp, 'broker.sock');
  const stale = () => fs.readdirSync(tmp).filter((n) => n.startsWith('broker.sock.stale-'));
  const job = { ...s.job, broker_harnesses: ['claude'], agent_tmp: tmp, broker: path.join(s.base, 'w'.repeat(90), B.FILE) };
  // A tree the agent wrote is renamed aside whole, in the agent's own temp directory.
  fs.mkdirSync(path.join(sock, 'inside'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sock, 'inside', 'f'), 'x');
  let broker = await B.start(job);
  let closed = false;
  t.after(() => closed || broker.close());
  assert.equal(JSON.parse(fs.readFileSync(job.broker, 'utf8')).socket, sock);
  assert.ok(fs.lstatSync(sock).isSocket(), 'the broker listens where the directory was');
  assert.equal(stale().length, 1);
  assert.equal(fs.readFileSync(path.join(tmp, stale()[0], 'inside', 'f'), 'utf8'), 'x', 'the tree is moved, not walked');
  // The agent swaps its socket for a link to a directory outside while the broker runs.
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  fs.rmSync(sock);
  fs.symlinkSync(outside, sock);
  broker.close();
  closed = true;
  assert.equal(fs.existsSync(sock) || fs.lstatSync(sock, { throwIfNoEntry: false }) !== undefined, false, 'closing removes the link');
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k', 'and nothing it points to');
  assert.equal(fs.existsSync(path.dirname(job.broker)), false, 'and still removes the broker directory');
  // An empty directory there is removed.
  fs.mkdirSync(sock);
  broker = await B.start(job);
  closed = false;
  assert.ok(fs.lstatSync(sock).isSocket());
  assert.equal(stale().length, 1, 'an empty directory is removed, not renamed aside');
  // One that can be neither removed nor renamed refuses the spawn with the reason and leaves no broker directory.
  broker.close();
  closed = true;
  fs.mkdirSync(path.join(sock, 'inside'), { recursive: true });
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
  await assert.rejects(B.start(job), /cannot clear .*broker\.sock, which is in the way of the broker socket \(EACCES\)/);
  assert.equal(fs.existsSync(path.dirname(job.broker)), false, 'the refused start leaves no broker directory');
  assert.ok(fs.existsSync(path.join(sock, 'inside')), 'and does not walk the tree');
});

test('closing never walks a broker directory the agent wrote: what else is there is moved aside whole, links unfollowed', async (t) => {
  const s = scratch(t);
  const brokers = path.join(s.base, 'brokers');
  // A codex agent's sandbox writes its own broker directory.
  const job = { ...s.job, harness: 'codex', broker_harnesses: ['codex'], broker: path.join(brokers, 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  let closed = false;
  t.after(() => closed || broker.close());
  const where = path.dirname(job.broker);
  fs.mkdirSync(path.join(where, 'sub'));
  fs.writeFileSync(path.join(where, 'sub', 'f'), 'agent');
  const outside = path.join(s.base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  fs.symlinkSync(outside, path.join(where, 'link'));
  const notices = [];
  const write = process.stderr.write;
  t.mock.method(process.stderr, 'write', (chunk, ...rest) => {
    if (String(chunk).includes('the broker left')) notices.push(String(chunk));
    else return write.call(process.stderr, chunk, ...rest);
    return true;
  });
  broker.close();
  closed = true;
  assert.equal(fs.existsSync(where), false, 'the broker directory is gone from its name');
  const aside = fs.readdirSync(brokers).filter((n) => n.startsWith('.stale-worker-T1-1-'));
  assert.equal(aside.length, 1, fs.readdirSync(brokers).join(' '));
  const moved = path.join(brokers, aside[0]);
  assert.deepEqual(fs.readdirSync(moved).sort(), ['link', 'sub'], 'what the broker wrote is removed, the rest moved whole');
  assert.equal(fs.readFileSync(path.join(moved, 'sub', 'f'), 'utf8'), 'agent');
  assert.ok(fs.lstatSync(path.join(moved, 'link')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(outside), ['keep'], 'the link\'s target is kept');
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(`left ${where.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} as ${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('a broker for claude and codex routes listens on both, and an agent that cannot use the socket uses TCP', { skip: process.platform === 'win32' && 'Windows uses a named pipe for both' }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'routes', '--acceptance', 'noted']);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'claude', broker_harnesses: ['claude', 'codex'], cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const address = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  assert.deepEqual([typeof address.socket, address.host, Number.isInteger(address.port)], ['string', '127.0.0.1', true]);
  // As in codex's sandbox, where connecting to the socket fails.
  fs.writeFileSync(job.broker, JSON.stringify({ ...address, socket: path.join(h.base, 'refused.sock') }));
  const r = await B.forward(job.broker, ['task', 'note', 'T1', 'over tcp'], h.state);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => n.text), ['over tcp']);
});

test('a brokered resubmit asks gh about its PR by name, with no repository for git', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'pr', '--acceptance', 'checked']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--agent', 'worker-T1-1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--branch', 'change', '--pr', '7']);
  const log = path.join(h.base, 'gh.log');
  const preload = path.join(h.base, 'gh.js');
  fs.writeFileSync(preload, `
const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function (command, args, opts) {
  if (command !== 'gh' || process.env.TOWER_CRANE_VIA !== 'broker') return original.call(this, command, args, opts);
  require('node:fs').appendFileSync(process.env.BROKER_GH_LOG, JSON.stringify({ args, cwd: opts.cwd, git_dir: opts.env.GIT_DIR || null }) + '\\n');
  // The submit also reads the head's green checks, so the stub answers those endpoints too.
  const green = { name: 'test (ubuntu)', status: 'completed', conclusion: 'success', app: 'github-actions', suite: 1, url: null, output: null };
  const suite = { id: 1, app: 'github-actions', status: 'completed', conclusion: 'success', runs: 1 };
  const out = args[0] === 'pr' ? { state: 'OPEN', headRefName: 'change', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
    : args[1].includes('check-runs') ? green : args[1].includes('check-suites') ? suite : null;
  return { status: 0, stdout: out ? JSON.stringify(out) : '', stderr: '' };
};
`);
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, BROKER_GH_LOG: process.env.BROKER_GH_LOG };
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.BROKER_GH_LOG = log;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const refused = await B.forward(job.broker, ['submit', 'T1', '--sha', '5bfcb6f56ab912a009883c798a61298c507dada4', '--pr', '7'], h.state);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /needs the project's repo/);
  assert.ok(!fs.existsSync(log), 'gh did not run without a repository name');
  h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const abbreviated = await B.forward(job.broker, ['submit', 'T1', '--sha', '5bfcb6f5'], h.state);
  assert.equal(abbreviated.code, 1);
  assert.match(abbreviated.stderr, /needs a full commit sha/);
  const r = await h.runAsync(['--agent', job.agent, 'submit', 'T1', '--sha=5BFCB6F5', '--pr', '7'],
    { env: { TOWER_CRANE_BROKER: job.broker } });
  assert.equal(r.code, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // The submit reads the PR twice: its state and branch, then its mergeability.
  const views = calls.filter((c) => c.args[0] === 'pr');
  assert.equal(views.length, 2);
  for (const view of views) assert.deepEqual(view.args.slice(0, 5), ['pr', 'view', '7', '-R', 'acme/demo']);
  assert.ok(calls.some((c) => c.args[0] === 'api' && c.args[1].includes('/check-runs')), 'the submit reads the head checks');
  for (const call of calls) {
    assert.equal(call.cwd, h.state);
    assert.ok(call.git_dir && !fs.existsSync(call.git_dir), 'git finds no repository');
  }
  assert.equal(h.readState('tasks.json').tasks[0].sha, '5bfcb6f56ab912a009883c798a61298c507dada4');
});

test('SHA-256 repositories submit full commits through the CLI and worker broker', async (t) => {
  const h = makeRepo(t);
  fs.rmSync(h.repo, { recursive: true, force: true });
  fs.mkdirSync(h.repo);
  h.git(['init', '-q', '--object-format=sha256', '-b', 'main']);
  fs.writeFileSync(path.join(h.repo, 'README.md'), '# SHA-256\n');
  h.git(['add', 'README.md']);
  h.git(['commit', '-q', '-m', 'init']);
  const sha = h.git(['rev-parse', 'HEAD']);
  assert.equal(sha.length, 64);
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  assert.equal(h.json(['submit', 'T1', '--sha', sha.slice(0, 8), '--agent', 'worker-T1-1']).sha, sha);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo,
    broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const resubmitted = await h.runAsync(['submit', 'T1', '--sha', sha.slice(0, 8).toUpperCase(),
    '--agent', job.agent, '--json'], { env: { TOWER_CRANE_BROKER: job.broker } });
  assert.equal(resubmitted.code, 0, resubmitted.stderr);
  assert.equal(JSON.parse(resubmitted.stdout).sha, sha);
});

test('a worker resolves a remote-only abbreviation before forwarding it to the broker', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Docs', '--acceptance', 'reads well', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  const origin = path.join(h.base, 'origin.git');
  const upstream = path.join(h.base, 'upstream');
  h.git(['init', '--bare', '-q', origin]);
  h.git(['remote', 'set-url', 'origin', origin]);
  h.git(['push', 'origin', 'main']);
  h.git(['clone', '-q', '--branch', 'main', origin, upstream]);
  h.git(['checkout', '-q', '-b', 'remote-change'], upstream);
  fs.appendFileSync(path.join(upstream, 'README.md'), 'remote change\n');
  h.git(['add', 'README.md'], upstream);
  h.git(['commit', '-q', '-m', 'remote change'], upstream);
  const sha = h.git(['rev-parse', 'HEAD'], upstream);
  h.git(['push', 'origin', 'remote-change'], upstream);
  assert.throws(() => h.git(['cat-file', '-e', `${sha}^{commit}`]));
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo,
    broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const result = await h.runAsync(['submit', 'T1', '--sha', sha.slice(0, 8), '--branch', 'remote-change',
    '--agent', job.agent, '--json'], { env: { TOWER_CRANE_BROKER: job.broker } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sha, sha);
  assert.equal(h.git(['rev-parse', 'origin/remote-change']), sha);
});

test('a brokered worker or reviewer messages only the orchestrator or the owner', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'one', '--acceptance', 'noted']);
  h.ok(['task', 'add', '--title', 'two', '--acceptance', 'noted']);
  const events = () => fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const reviewer = { state: h.state, task: 'T2', agent: 'reviewer-T2-1', role: 'reviewer' };
  assert.throws(() => B.authorize(reviewer, ['msg', '--to', 'worker-T1-1', 'note from T2']), /messages only the orchestrator or the owner, not worker-T1-1/);
  assert.throws(() => B.authorize(reviewer, ['msg', '--to=worker-T1-1', 'note from T2']), /not worker-T1-1/);

  const job = { state: h.state, task: 'T2', agent: 'worker-T2-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T2-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  // A worker's message to another task's agent would enter that agent's
  // prompt, so the broker refuses it and the recipient's inbox stays empty.
  const refused = await B.forward(job.broker, ['msg', '--to', 'worker-T1-1', 'note from T2'], h.state);
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /messages only the orchestrator or the owner, not worker-T1-1/);
  assert.deepEqual(harnessHooks.unread(events(), 'worker-T1-1'), []);
  assert.equal(events().filter((e) => e.cmd === 'msg').length, 0, 'the refused message wrote no message event');
  // The attempt is logged for the orchestrator and the board, without its text.
  const refusals = events().filter((e) => e.cmd === 'msg refused');
  assert.deepEqual(refusals.map((e) => [e.agent, e.task, e.to, e.detail.to]), [['worker-T2-1', 'T2', 'orchestrator', 'worker-T1-1']]);
  assert.ok(!fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').includes('note from T2'), 'the refusal keeps the text out of the log');

  for (const to of ['orchestrator', 'owner']) {
    const r = await B.forward(job.broker, ['msg', '--to', to, `status from T2 to ${to}`], h.state);
    assert.equal(r.code, 0, r.stderr);
  }
  assert.deepEqual(events().filter((e) => e.cmd === 'msg').map((e) => [e.task, e.detail.to]), [['T2', 'orchestrator'], ['T2', 'owner']]);
});

test('a sandboxed worker can print and list its prepared worktree without state writes', async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Prepared', '--acceptance', 'read worktree state']);
  const wt = h.json(['worktree', 'T1']);
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', harness: 'codex',
    cwd: wt.path, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const env = { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task };
  const before = h.readState('tasks.json');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  for (const args of [['worktree', 'T1'], ['worktree', 'list']]) {
    const result = await h.runAsync([...args, '--json'], { env });
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(args[1] === 'T1' ? data.path : data.worktrees[0].path, wt.path);
  }
  assert.deepEqual(h.readState('tasks.json'), before);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  const denied = await h.runAsync(['worktree', 'prune'], { env });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /not worktree prune/);
});

test('a sandboxed worker prints its worktree without the state lock, though a stack sync would write', async (t) => {
  const f = stacked(t);
  const { wt } = f.upper;
  // origin's main moves, so the linked stack is due a sync that writes state.
  f.h.git(['commit', '--allow-empty', '-qm', 'main moves']);
  const remote = path.join(f.h.base, 'remote.git');
  f.h.git(['--git-dir', remote, 'fetch', '-q', f.h.repo, 'HEAD:refs/heads/main']);
  const job = { state: f.h.state, task: 'T2', agent: 'worker-T2-1', role: 'worker', cwd: wt.path, broker: path.join(f.h.base, 'brokers', 'worker-T2-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const tasks = path.join(f.h.state, 'tasks.json');
  const before = fs.readFileSync(tasks, 'utf8');
  // The sandbox leaves the state directory read-only, so the lock cannot be created.
  fs.chmodSync(f.h.state, 0o555);
  let r;
  try {
    r = f.h.run(['worktree', 'T2'], { cwd: wt.path, env: { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task } });
  } finally {
    fs.chmodSync(f.h.state, 0o755);
  }
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), wt.path);
  assert.equal(fs.readFileSync(tasks, 'utf8'), before, 'the sandboxed worktree wrote no state');
  assert.equal(fs.existsSync(path.join(f.h.state, 'lock')), false, 'no state lock was taken');
});

test('a test fixture with an inherited broker variable creates its own worktree; the broker serves only its state', async (t) => {
  const sandbox = makeRepo(t);
  sandbox.init();
  const job = { state: sandbox.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: sandbox.base, broker: path.join(sandbox.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  // The fixture is writable, so it is not the sandboxed worker's state.
  const fixture = makeRepo(t);
  fixture.init();
  fixture.ok(['task', 'add', '--title', 'Change', '--acceptance', 'it works']);
  const r = fixture.run(['worktree', 'T1'], { env: { TOWER_CRANE_BROKER: broker.env.TOWER_CRANE_BROKER } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fixture.registers(r.stdout.trim()), 'the worktree was created');
  assert.ok(fixture.readState('tasks.json').tasks.find((x) => x.id === 'T1').branch, 'the fixture recorded its branch');
});

function spawnAsync(command, args, { cwd, env, input }) {
  return new Promise((resolve) => {
    const child = require('node:child_process').spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.stdin.end(input);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// A worker's push and gh commands go through its broker. The fixture is the
// task worktree with origin a bare repository on this machine, a broker for
// the worker, and its git shim with the policy spawn writes for a sandboxed
// agent.
async function pushFixture(t, { role = 'worker', title = 'Push' } = {}) {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', title, '--acceptance', 'pushes through the broker']);
  const remote = path.join(h.base, 'remote.git');
  h.git(['init', '-q', '--bare', remote]);
  h.git(['remote', 'set-url', 'origin', remote]);
  h.git(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const wt = h.json(['worktree', 'T1']);
  const task = h.readState('tasks.json').tasks[0];
  const common = path.resolve(h.repo, h.git(['rev-parse', '--git-common-dir']));
  const agent = `${role}-T1-1`;
  const job = { state: h.state, task: 'T1', agent, role, harness: 'claude', cwd: wt.path,
    broker: path.join(h.base, 'brokers', agent, B.FILE), dispatch: { gitDirs: { common } } };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const A = require('../lib/agents');
  const policy = path.join(shimDir, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ ...A.policy(A.load(role)), branch: task.branch, repo: null, masks: false, hook: null,
    broker: true, repoDir: common }));
  // Asynchronous: the broker answers from this process.
  const shim = (tool, args, opts = {}) => spawnAsync(process.execPath,
    [path.join(ROOT, 'lib', 'shim.js'), policy, path.join(shimDir, 'bin'), tool, ...args],
    { cwd: opts.cwd || wt.path, input: opts.input, env: { ...h.env, ...broker.env, GIT_TERMINAL_PROMPT: '0', ...opts.env } });
  const commit = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(wt.path, file)), { recursive: true });
    fs.writeFileSync(path.join(wt.path, file), text);
    h.git(['add', file], wt.path);
    h.git(['commit', '-qm', `add ${file}`], wt.path);
    return h.git(['rev-parse', 'HEAD'], wt.path);
  };
  const remoteRef = (ref) => {
    const r = require('node:child_process').spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  // What the shim sends: the request, then the pack the broker asks for,
  // built in the worktree (or by opts.pack, an agent with another view).
  const raw = (payload, opts = {}) => {
    let stdout = '';
    let stderr = '';
    const pack = opts.pack || (payload?.push ? require('../lib/shim').packFor('git', ['-C', wt.path], String(payload.push.sha)) : null);
    return B.request(job.broker, payload, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }, { pack })
      .then((code) => ({ code, stdout, stderr }));
  };
  return { h, wt, task, job, remote, shim, commit, remoteRef, raw };
}

test('a worker\'s git push goes through its broker to its own task branch on origin, and the shim and broker refuse another branch, a force push and a workflow change', async (t) => {
  const f = await pushFixture(t);
  const branch = f.task.branch;
  const first = f.commit('a.txt', 'a\n');
  const pushed = await f.shim('git', ['push', 'origin', 'HEAD']);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stderr, /the broker pushes/);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), first, 'the broker pushed the commit to the task branch');
  assert.equal(f.h.git(['rev-parse', `refs/remotes/origin/${branch}`], f.wt.path), first, 'the shim records origin\'s branch');
  const second = f.commit('b.txt', 'b\n');
  const plain = await f.shim('git', ['push']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), second, 'a plain push from the task branch goes to origin');

  // The shim names its reason before a round trip.
  for (const args of [['push', 'origin', 'HEAD:refs/heads/main'], ['push', 'origin', 'HEAD:other'],
    ['push', '--force', 'origin', 'HEAD'], ['push', 'origin', `+HEAD:${branch}`], ['push', 'origin', `:${branch}`]]) {
    const r = await f.shim('git', args);
    assert.equal(r.status, 126, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /not allowed by this agent's agent file/);
  }
  assert.equal(f.remoteRef('refs/heads/other'), null);
  assert.equal(f.remoteRef('refs/heads/main'), f.h.git(['rev-parse', 'main']), 'main is untouched');

  // The broker trusts no field of the request but the commit: a request that
  // names another branch still lands on the task branch only.
  const third = f.commit('c.txt', 'c\n');
  const named = await f.raw({ push: { sha: third, branch: 'main', ref: 'refs/heads/main', remote: 'elsewhere' } });
  assert.equal(named.code, 0, named.stderr);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), third);
  assert.equal(f.remoteRef('refs/heads/main'), f.h.git(['rev-parse', 'main']), 'main is untouched');

  // A rewritten history is not a fast-forward, and the broker never forces.
  f.h.git(['reset', '-q', '--hard', first], f.wt.path);
  const rewritten = f.commit('d.txt', 'd\n');
  const force = await f.raw({ push: { sha: rewritten, force: true } });
  assert.notEqual(force.code, 0, 'a non-fast-forward push is refused');
  assert.match(force.stderr, /rejected|non-fast-forward|fetch first/);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), third, 'the remote branch keeps its history');
  f.h.git(['reset', '-q', '--hard', third], f.wt.path);

  // A workflow file the task does not name stays off the remote, even inside a merge.
  f.h.git(['checkout', '-q', '-b', 'side'], f.wt.path);
  const workflow = f.commit('.github/workflows/ci.yml', 'on: push\n');
  f.h.git(['checkout', '-q', branch], f.wt.path);
  f.h.git(['merge', '-q', '--no-edit', 'side'], f.wt.path);
  const merged = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  const refused = await f.shim('git', ['push', 'origin', 'HEAD']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /changes \.github\/workflows\/ci\.yml/);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), third);
  // The brief names the file, so the task allows it.
  f.h.ok(['brief', 'set', 'T1', '-'], { input: 'Change `.github/workflows/ci.yml` to run on push.\n' });
  const allowed = await f.shim('git', ['push', 'origin', 'HEAD']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), merged);
  assert.ok(workflow);
  assert.deepEqual(fs.readdirSync(path.join(f.h.state, 'push')).filter((n) => n !== '.gitignore'), ['cache.git'],
    'the broker keeps its verified cache and removes its other scratch');
});

// origin at git@github.com: as in a real project. The broker's ssh, the
// user's own, reaches the fixture's bare repository; the agent's fails as
// ssh does in a sandbox's user namespace, where root-owned config files
// appear owned by nobody.
async function sshOriginFixture(t) {
  const f = await pushFixture(t);
  f.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  f.h.git(['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git']);
  // Spawn writes the recorded repository into the shim's policy.
  const policy = path.join(f.h.base, 'shim', 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ ...JSON.parse(fs.readFileSync(policy, 'utf8')), repo: 'acme/demo' }));
  const ssh = path.join(f.h.base, 'ssh.js');
  fs.writeFileSync(ssh, `const args = process.argv.slice(2);
if (args.includes('-G')) process.exit(0);
const m = /^git-(upload|receive)-pack '(.*)'$/.exec(args[args.length - 1]);
if (!m || m[2] !== 'acme/demo.git') { process.stderr.write('ssh: unexpected ' + args.join(' ') + '\\n'); process.exit(255); }
const r = require('node:child_process').spawnSync('git', [m[1] + '-pack', ${JSON.stringify(f.remote)}], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
  const sandboxSsh = path.join(f.h.base, 'sandbox-ssh.js');
  fs.writeFileSync(sandboxSsh, `process.stderr.write('Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf\\n');
process.exit(255);
`);
  const command = (file) => `"${process.execPath.replace(/\\/g, '/')}" "${file.replace(/\\/g, '/')}"`;
  const saved = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = command(ssh);
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = saved;
  });
  const shim = (tool, args, opts = {}) => f.shim(tool, args, { ...opts, env: { GIT_SSH_COMMAND: command(sandboxSsh), ...opts.env } });
  // Another clone moves origin's main, as a merged pull request does.
  const advance = (file, content = `${file}\n`) => {
    const other = fs.mkdtempSync(path.join(f.h.base, 'other-'));
    f.h.git(['clone', '-q', f.remote, other]);
    fs.writeFileSync(path.join(other, file), content);
    f.h.git(['add', file], other);
    f.h.git(['commit', '-qm', `add ${file}`], other);
    f.h.git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], other);
    return f.h.git(['rev-parse', 'HEAD'], other);
  };
  return { ...f, shim, advance };
}

test('a sandboxed worker whose origin is an ssh URL fetches the base and its task branch through its broker, and only those', async (t) => {
  const f = await sshOriginFixture(t);
  const branch = f.task.branch;
  const tracked = (ref) => {
    const r = require('node:child_process').spawnSync('git', ['-C', f.wt.path, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8', env: f.h.env });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const main = f.advance('upstream.txt');
  assert.notEqual(tracked('refs/remotes/origin/main'), main);
  const direct = await f.shim('git', ['ls-remote', 'origin']);
  assert.notEqual(direct.status, 0, 'git in the sandbox cannot reach origin itself');
  assert.match(direct.stderr, /Bad owner/);

  const fetched = await f.shim('git', ['fetch', 'origin']);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.equal(tracked('refs/remotes/origin/main'), main, 'origin/main is origin\'s main');
  // A pack of a few MiB pauses the connection many times.
  const big = f.advance('big.bin', require('node:crypto').randomBytes(3 * 1024 * 1024));
  const large = await f.shim('git', ['fetch', '-q', 'origin']);
  assert.equal(large.status, 0, large.stderr);
  assert.equal(tracked('refs/remotes/origin/main'), big);
  assert.doesNotMatch(large.stderr, /MaxListeners|Warning/);
  assert.match(fetched.stderr, /From git@github\.com:acme\/demo\.git/);
  f.h.git(['merge', '-q', '--no-ff', '--no-edit', 'origin/main'], f.wt.path);
  assert.equal(fs.readFileSync(path.join(f.wt.path, 'upstream.txt'), 'utf8'), 'upstream.txt\n', 'the fetched objects are whole');

  // The skill's spelling, and a plain fetch with no remote, after origin moves again.
  const later = f.advance('later.txt');
  const skill = await f.shim('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  assert.equal(skill.status, 0, skill.stderr);
  assert.equal(tracked('refs/remotes/origin/main'), later);
  const head = fs.readFileSync(path.join(f.h.git(['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'], f.wt.path)), 'utf8');
  assert.equal(head, `${later}\t\tbranch 'main' of git@github.com:acme/demo.git\n`, 'FETCH_HEAD names the fetched branch');
  const plain = await f.shim('git', ['fetch', '-q']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stderr, '');

  // The task branch, once pushed through the broker over the same ssh URL.
  const own = f.commit('mine.txt', 'mine\n');
  const pushed = await f.shim('git', ['push', 'origin', 'HEAD']);
  assert.equal(pushed.status, 0, pushed.stderr);
  f.h.git(['update-ref', '-d', `refs/remotes/origin/${branch}`], f.wt.path);
  const task = await f.shim('git', ['fetch', 'origin', branch]);
  assert.equal(task.status, 0, task.stderr);
  assert.equal(tracked(`refs/remotes/origin/${branch}`), own);

  // Another branch on origin stays out of reach, and so do options the broker does not take.
  f.h.git(['push', '-q', f.remote, `${main}:refs/heads/other`]);
  for (const args of [['fetch', 'origin', 'other'], ['fetch', 'origin', 'refs/tags/v1'], ['fetch', 'origin', 'main:main'], ['fetch', '--unshallow', 'origin']]) {
    const r = await f.shim('git', args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /fetches|broker/, args.join(' '));
  }
  assert.equal(tracked('refs/remotes/origin/other'), '', 'nothing of another branch was recorded');
  const refused = await f.raw({ fetch: { branches: ['other'] } });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`fetches main, ${branch} from origin, not other`));

  // pull cannot reach origin; the shim names the way that can.
  const pull = await f.shim('git', ['pull']);
  assert.equal(pull.status, 126);
  assert.match(pull.stderr, /git fetch origin goes through the broker/);
});

// A reviewer's git directory is read-only under codex, and a disk can fill:
// index-pack then exits while the broker still sends the pack. The fetch
// must fail with index-pack's error, not wait on a drain that never comes
// and exit 0 with origin's branches unchanged.
test('a brokered fetch whose pack cannot be indexed fails with the reason', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a directory its user cannot write' }, async (t) => {
  const f = await sshOriginFixture(t);
  const before = f.h.git(['rev-parse', 'refs/remotes/origin/main'], f.wt.path);
  // Random bytes do not compress, so the pack is larger than the pipe buffers on the way.
  const other = fs.mkdtempSync(path.join(f.h.base, 'big-'));
  f.h.git(['clone', '-q', f.remote, other]);
  fs.writeFileSync(path.join(other, 'big.bin'), require('node:crypto').randomBytes(768 * 1024));
  f.h.git(['add', 'big.bin'], other);
  f.h.git(['commit', '-qm', 'big'], other);
  f.h.git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], other);
  const pack = path.join(f.job.dispatch.gitDirs.common, 'objects', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  fs.chmodSync(pack, 0o555);
  let r;
  try {
    r = await f.shim('git', ['fetch', 'origin']);
  } finally {
    fs.chmodSync(pack, 0o755);
  }
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /cannot index the pack the broker sent/);
  assert.equal(f.h.git(['rev-parse', 'refs/remotes/origin/main'], f.wt.path), before, 'origin/main is unchanged');
});

test('the broker fetches only from the recorded repository, and any other origin is fetched in the sandbox', async (t) => {
  const f = await pushFixture(t);
  const r = await f.raw({ fetch: {} });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /records no repository/);
  f.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  f.h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);
  const other = await f.raw({ fetch: {} });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /not the project's repository acme\/demo/);
  // Any origin but the recorded repository runs as git's own fetch in the
  // sandbox: a path on this machine, absolute or relative.
  for (const url of [f.remote, path.relative(f.wt.path, f.remote)]) {
    f.h.git(['remote', 'set-url', 'origin', url]);
    const local = await f.shim('git', ['fetch', 'origin']);
    assert.equal(local.status, 0, `${url}: ${local.stderr}`);
    assert.doesNotMatch(local.stderr, /tower-crane/, url);
  }
});

test('only a role whose agent file pushes can push through the broker, and only to the recorded repository', async (t) => {
  const f = await pushFixture(t, { role: 'reviewer' });
  const sha = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  const r = await f.raw({ push: { sha } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /reviewer-T1-1 is a reviewer; its agent file allows no push/);
  const w = await pushFixture(t);
  const commit = w.commit('a.txt', 'a\n');
  for (const sha of ['HEAD', commit.slice(0, 12), 'f'.repeat(40)]) {
    const bad = await w.raw({ push: { sha } });
    assert.notEqual(bad.code, 0, sha);
    assert.match(bad.stderr, /full commit sha|not in the task repository/, sha);
  }
  // A project that records a GitHub repository pushes only to it.
  w.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const local = await w.raw({ push: { sha: commit } });
  assert.equal(local.code, 1);
  assert.match(local.stderr, /not to the project's repository acme\/demo/);
  w.h.git(['remote', 'set-url', 'origin', 'https://github.com/acme/other.git']);
  const other = await w.raw({ push: { sha: commit } });
  assert.match(other.stderr, /not to the project's repository acme\/demo/);
  assert.equal(w.remoteRef(`refs/heads/${w.task.branch}`), null, 'nothing was pushed');
});

// git trusts a loose object's file name on read, and the task repository's
// object store is the agent's to write. Here the remote already holds a tree
// that changes a workflow, the agent's new commit points at it, and the agent
// rewrites that tree's file in its store to hold the parent's tree. The broker
// must check the content the remote ends up with, not the rewritten file.
test('the broker checks a push against verified objects, so a rewritten object in the task repository\'s store hides no workflow change', async (t) => {
  const f = await pushFixture(t);
  const cp = require('node:child_process');
  const zlib = require('node:zlib');
  const branch = f.task.branch;
  const base = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  f.h.git(['checkout', '-q', '-b', 'side'], f.wt.path);
  const side = f.commit('.github/workflows/ci.yml', 'on: push\n');
  f.h.git(['push', '-q', 'origin', 'side'], f.wt.path);
  f.h.git(['checkout', '-q', branch], f.wt.path);
  const tree = f.h.git(['rev-parse', `${side}^{tree}`], f.wt.path);
  const commit = f.h.git(['commit-tree', tree, '-p', base, '-m', 'looks empty'], f.wt.path);
  const common = f.job.dispatch.gitDirs.common;
  const loose = path.join(common, 'objects', tree.slice(0, 2), tree.slice(2));
  assert.ok(fs.existsSync(loose), 'the workflow tree is a loose object in the task repository');
  const parentTree = cp.execFileSync('git', ['--git-dir', common, 'cat-file', 'tree', `${base}^{tree}`]);
  fs.chmodSync(loose, 0o644);
  fs.writeFileSync(loose, zlib.deflateSync(Buffer.concat([Buffer.from(`tree ${parentTree.length}\0`), parentTree])));
  assert.equal(f.h.git(['diff-tree', '-r', '--name-only', '--no-commit-id', commit], f.wt.path), '', 'diff-tree reads the rewritten tree');
  const r = await f.raw({ push: { sha: commit } });
  assert.notEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /changes \.github\/workflows\/ci\.yml/);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), null, 'nothing was pushed');
});

// The broker reads with the user's permissions, outside the sandbox. An
// alternates entry the agent writes into the task repository's store could
// point it at a repository the sandbox hides. Here the agent's pack is built
// from what its sandbox shows, the store without that entry, and the broker
// must take the commit from that pack only.
test('the broker pushes only objects the agent sends, never a repository the task store points it at', async (t) => {
  const f = await pushFixture(t);
  const cp = require('node:child_process');
  const secret = path.join(f.h.base, 'secret');
  f.h.git(['init', '-q', secret]);
  fs.writeFileSync(path.join(secret, 'key.txt'), 'not the agent\'s\n');
  f.h.git(['add', 'key.txt'], secret);
  f.h.git(['commit', '-qm', 'secret'], secret);
  const hidden = f.h.git(['rev-parse', 'HEAD'], secret);
  const common = f.job.dispatch.gitDirs.common;
  fs.mkdirSync(path.join(common, 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(common, 'objects', 'info', 'alternates'), `${path.join(secret, '.git', 'objects')}\n`);
  // The agent's view: the store without the entry its sandbox cannot follow.
  const view = path.join(f.h.base, 'sandbox-objects');
  fs.cpSync(path.join(common, 'objects'), view, { recursive: true, filter: (p) => path.basename(p) !== 'alternates' });
  const pack = (sha) => (have) => {
    const child = cp.spawn('git', ['-C', f.wt.path, 'pack-objects', '--stdout', '--revs', '--thin', '-q'],
      { env: { ...process.env, GIT_OBJECT_DIRECTORY: view }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.end([sha, ...have.map((h) => `^${h}`)].join('\n') + '\n');
    return child.stdout;
  };
  const r = await f.raw({ push: { sha: hidden } }, { pack: pack(hidden) });
  assert.notEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /not in the task repository/);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null, 'the hidden commit stays off the remote');
  // The agent's own commit still goes out.
  fs.rmSync(path.join(common, 'objects', 'info', 'alternates'));
  const own = f.commit('a.txt', 'a\n');
  const ok = await f.raw({ push: { sha: own } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), own);
});

// The cache's object format is the remote's, never what the agent writes in
// the task repository's config.
test('the broker\'s cache takes the remote\'s object format and is made again when its own differs', async (t) => {
  const f = await pushFixture(t);
  const branch = f.task.branch;
  const common = f.job.dispatch.gitDirs.common;
  const cache = path.join(f.h.state, 'push', 'cache.git');
  // A wrong format in the task config before the first push. The agent's own
  // git refuses that config, so its pack is built without it.
  const config = path.join(common, 'config');
  const clean = fs.readFileSync(config, 'utf8');
  const first = f.commit('a.txt', 'a\n');
  const shim = require('../lib/shim');
  const packed = (sha) => (have) => {
    fs.writeFileSync(config, clean);
    return shim.packFor('git', ['-C', f.wt.path], sha)(have);
  };
  fs.writeFileSync(config, `${clean}[extensions]\n\tobjectformat = sha256\n`);
  const r1 = await f.raw({ push: { sha: first } }, { pack: packed(first) });
  fs.writeFileSync(config, clean);
  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), first);
  // A cache left in another format is made again.
  fs.rmSync(cache, { recursive: true, force: true });
  f.h.git(['init', '-q', '--bare', '--object-format=sha256', cache]);
  const third = f.commit('c.txt', 'c\n');
  const r3 = await f.raw({ push: { sha: third } });
  assert.equal(r3.code, 0, r3.stderr);
  assert.equal(f.remoteRef(`refs/heads/${branch}`), third);
});

test('the broker\'s cache outlives a git killed while it held a ref lock', async (t) => {
  const f = await pushFixture(t);
  const branch = f.task.branch;
  const cache = path.join(f.h.state, 'push', 'cache.git');
  const first = f.commit('a.txt', 'a\n');
  assert.equal((await f.raw({ push: { sha: first } })).code, 0);
  fs.writeFileSync(path.join(cache, 'refs', 'push', 'task.lock'), '');
  fs.writeFileSync(path.join(cache, 'refs', 'remotes', 'origin', 'main.lock'), '');
  for (const file of ['b.txt', 'c.txt']) {
    const sha = f.commit(file, `${file}\n`);
    const r = await f.raw({ push: { sha } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(f.remoteRef(`refs/heads/${branch}`), sha);
  }
});

// Two pushes wait on a lock whose holder died. The first to look removes it
// and takes the lock; the second, which read the same dead holder, must not
// remove the lock the first now holds.
test('a stale cache lock is broken once, so two waiters never hold the cache together', async (t) => {
  const G = require('../lib/github-broker');
  const { base } = scratch(t);
  const root = path.join(base, 'push');
  fs.mkdirSync(root);
  const io = { stderr: () => {}, gone: () => false };
  const dead = require('node:child_process').spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(ROOT, 'lib', 'github-broker.js'))}).lockCache(${JSON.stringify(root)}, { stderr() {} }).then(() => process.exit(0))`], { encoding: 'utf8' });
  assert.equal(dead.status, 0, dead.stderr);
  assert.ok(fs.existsSync(path.join(root, 'cache.lock')), 'the dead holder left its lock');
  // The second waiter reads the dead holder; before it acts, the first
  // breaks the lock and takes it.
  const read = fs.readFileSync;
  let first = null;
  let fired = false;
  fs.readFileSync = function hooked(file, ...rest) {
    const out = read.call(fs, file, ...rest);
    if (!fired && String(file).includes('cache.lock')) {
      fired = true;
      first = G.lockCache(root, io);
    }
    return out;
  };
  let second;
  try {
    second = G.lockCache(root, io);
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(first, 'the first waiter ran while the second looked');
  const releaseFirst = await first;
  const settled = await Promise.race([second.then(() => 'held'), new Promise((r) => setTimeout(() => r('waiting'), 600))]); // wait-allow: negative observation window; the second waiter must still wait while the first holds the lock
  assert.equal(settled, 'waiting', 'the second waiter waits while the first holds the lock');
  releaseFirst();
  const releaseSecond = await second;
  releaseSecond();
  assert.deepEqual(fs.readdirSync(root), [], 'the lock is gone once both released');
});

// The shim as the agent runs it, with its process, so a test can kill it.
function shimChild(f, args) {
  const cp = require('node:child_process');
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'lib', 'shim.js'), path.join(f.h.base, 'shim', 'policy.json'), path.join(f.h.base, 'shim', 'bin'), ...args],
    { cwd: f.wt.path, env: { ...f.h.env, TOWER_CRANE_BROKER: f.job.broker, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  child.stdout.resume();
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, exited, stderr: () => stderr };
}

const alive = (pid) => { try { killPid(pid, 0); return true; } catch { return false; } };

// A Windows named pipe has no half close: libuv closes the whole pipe 50 ms
// after the writer's shutdown, so an agent that ends its side to mark the end
// of its pack loses the answer. A peer that closes the connection when the
// agent ends its side stands in for that pipe on every platform.
test('a push gets its answer over a connection that closes when the agent ends its side, as a Windows named pipe does, and an empty chunk of its pack ends nothing', async (t) => {
  // The {need} of every broker release names no framing; each reads frames.
  const { base } = scratch(t);
  const net = require('node:net');
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\tower-crane-test-${process.pid}-${Date.now()}` : assertFits(path.join(socketDir(t), 's'));
  let got = Buffer.alloc(0);
  let request = null;
  let answered = false;
  const framed = Buffer.from([0, 0, 0, 3, ...Buffer.from('abc'), 0, 0, 0, 4, ...Buffer.from('defg'), 0, 0, 0, 0]);
  const server = net.createServer({ allowHalfOpen: false }, (conn) => {
    conn.on('error', () => {});
    conn.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (request === null) {
        const nl = got.indexOf(10);
        if (nl < 0) return;
        request = JSON.parse(got.subarray(0, nl).toString('utf8'));
        got = got.subarray(nl + 1);
        conn.write(`${JSON.stringify({ stderr: 'checking\n' })}\n${JSON.stringify({ need: { have: [] } })}\n`);
      }
      // The broker checks the push for a while before it answers.
      if (got.length < framed.length || answered) return;
      answered = true;
      setTimeout(() => conn.end(`${JSON.stringify({ code: 0 })}\n`), 200); // wait-allow: the fake broker's checking time, so the agent's side must stay open past its own pack
    });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => server.close());
  const file = path.join(base, B.FILE);
  fs.writeFileSync(file, JSON.stringify({ socket, token: 'k' }));
  let stderr = '';
  const pack = () => require('node:stream').Readable.from([Buffer.from('abc'), Buffer.alloc(0), Buffer.from('defg')]);
  const code = await B.request(file, { push: { sha: 'a'.repeat(40) } }, { stdout() {}, stderr: (s) => { stderr += s; } }, { pack });
  assert.equal(code, 0);
  assert.deepEqual(request, { token: 'k', push: { sha: 'a'.repeat(40) } });
  assert.equal(stderr, 'checking\n');
  assert.ok(got.equals(framed), 'the pack arrives in frames, ended by an empty frame');
});

// A body that cannot take a whole frame asks the connection to wait for its
// drain, but once the end frame came in the same read no drain comes, and a
// connection paused for it would miss the agent's hang-up during the checks
// and the push.
test('the broker\'s unframing never waits on a body the end frame has ended', () => {
  const { PassThrough } = require('node:stream');
  const body = new PassThrough({ highWaterMark: 4 });
  const unframe = B.frames(body);
  const room = unframe(Buffer.concat([B.frame(Buffer.from('abcdefgh')), B.frame(Buffer.alloc(0))]));
  assert.equal(body.writableEnded, true, 'the empty frame ended the body');
  assert.equal(room, true, 'an ended body never asks the connection to wait');
  // A full body that has not ended still asks it to wait.
  const open = new PassThrough({ highWaterMark: 4 });
  assert.equal(B.frames(open)(B.frame(Buffer.from('abcdefgh'))), false);
});

// An agent that speaks the push protocol by hand: it sends the request
// line and, when the broker asks for the pack, writes what send(have)
// returns, each buffer as one write; end then ends its side, as a shim from
// before frames did, and socket receives the connection. Resolves with the
// answer's code (null without one), its stderr and the {need} the broker
// sent.
function handPush(f, sha, send, { end = false, socket = () => {} } = {}) {
  const net = require('node:net');
  const b = JSON.parse(fs.readFileSync(f.job.broker, 'utf8'));
  return new Promise((resolve) => {
    const sock = b.socket ? net.connect({ path: b.socket, allowHalfOpen: true }) : net.connect({ port: b.port, host: b.host, allowHalfOpen: true });
    let buf = '';
    let code = null;
    let stderr = '';
    let need = null;
    socket(sock);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('connect', () => sock.write(`${JSON.stringify({ token: b.token, push: { sha } })}\n`));
    sock.on('data', (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.code !== undefined) code = msg.code;
        else if (typeof msg.stderr === 'string') stderr += msg.stderr;
        else if (msg.need && !need) {
          need = msg.need;
          for (const part of send(need.have)) sock.write(part);
          if (end) sock.end();
        }
      }
    });
    sock.on('end', () => sock.destroy());
    sock.on('close', () => resolve({ code, stderr, need }));
  });
}

// The pack the shim would send for sha, whole, as one buffer.
function packOf(f, sha, have) {
  return require('node:child_process').execFileSync('git', ['pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'],
    { cwd: f.wt.path, input: [sha, ...have.map((h) => `^${h}`)].map((l) => `${l}\n`).join('') });
}

// Bad frames from an agent's own client: none allocates by its claimed
// length, a frame or header that stops short is ended by the idle limit, and
// each leaves the cache lock free and the branch unpushed. A pack index-pack
// reads whole needs no more, and bytes after the end frame are dropped.
test('the broker refuses bad frames from the agent and frees the cache lock', async (t) => {
  const f = await pushFixture(t);
  const G = require('../lib/github-broker');
  const saved = { ...G.LIMITS };
  t.after(() => Object.assign(G.LIMITS, saved));
  const lock = path.join(f.h.state, 'push', 'cache.lock');
  const branch = `refs/heads/${f.task.branch}`;
  const head = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const sha = f.commit('a.txt', 'a\n');
  const refused = async (what, send) => {
    const started = Date.now();
    const r = await handPush(f, sha, send);
    assert.notEqual(r.code, null, `${what}: the broker answered\n${r.stderr}`);
    assert.notEqual(r.code, 0, `${what}: refused`);
    assert.equal(fs.existsSync(lock), false, `${what}: the cache lock is free`);
    assert.equal(f.remoteRef(branch), null, `${what}: nothing was pushed`);
    return { ...r, ms: Date.now() - started };
  };
  // A length near 4 GiB followed by 1 MB that is no pack: index-pack refuses
  // its first bytes and nothing was held for the length.
  const oversized = await refused('oversized length', () => [head(0xFFFFFFF0), Buffer.alloc(1 << 20, 0x41)]);
  assert.match(oversized.stderr, /signature|not in the task repository/);
  G.LIMITS.idleMs = 500;
  const partial = await refused('partial header', () => [Buffer.from([0, 0])]);
  assert.match(partial.stderr, /stalled/);
  const short = await refused('length past the data', (have) => [head(1 << 20), packOf(f, sha, have).subarray(0, 12)]);
  assert.match(short.stderr, /stalled/);
  for (const r of [partial, short]) assert.ok(r.ms < 10000, 'the idle limit ended the push'); // wait-allow: the 500 ms idle limit under test ends the push long before any other limit
  G.LIMITS.idleMs = saved.idleMs;
  // The whole pack with no end frame: index-pack stops at the pack's
  // trailer, so the push has every object it checks and goes through.
  const whole = await handPush(f, sha, (have) => [B.frame(packOf(f, sha, have))]);
  assert.equal(whole.code, 0, whole.stderr);
  assert.equal(f.remoteRef(branch), sha);
  // Bytes after the end frame are dropped.
  const next = f.commit('b.txt', 'b\n');
  const trailing = await handPush(f, next, (have) => [Buffer.concat([B.frame(packOf(f, next, have)), B.frame(Buffer.alloc(0)), Buffer.from('trailing bytes')])]);
  assert.equal(trailing.code, 0, trailing.stderr);
  assert.equal(f.remoteRef(branch), next);
  assert.equal(fs.existsSync(lock), false);
});

// Every release frames the pack, and a spawn's shims and broker run one
// copy of the tool, so only a shim from a snapshot before framed packs sends
// a bare one. Its broker says so, not "pack signature mismatch", and the
// shim, which ends its side after its pack, still gets that answer.
test('a broker tells a shim from before framed packs why its push failed', async (t) => {
  const f = await pushFixture(t);
  const sha = f.commit('a.txt', 'a\n');
  const old = await handPush(f, sha, (have) => [packOf(f, sha, have)], { end: true });
  assert.notEqual(old.code, null, 'the old shim gets the answer');
  assert.notEqual(old.code, 0);
  assert.match(old.stderr, /sent its pack unframed, as a Tower Crane snapshot from before framed packs \(T291\) does/);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null);
});

// The read that brings the whole pack and its end frame finds the body
// full, so it asks the connection to wait for a drain that an ended body
// never emits. The agent then sends a few more bytes and hangs up while the
// broker's git push waits in the remote's pre-receive hook: the broker must
// see it and stop the push. A paused connection still reports the end of an
// agent that sent nothing more, but bytes after the end frame sit unread in
// front of that end.
// A body fills only when index-pack falls behind the socket, which depends
// on the platform's pipe sizes and read boundaries, so the body the broker
// makes for this push reports itself full on every write. Like a real body
// it drains on a later tick unless it has ended, so a pack that comes in two
// reads still reaches the end frame.
test('a broker whose agent sent its whole pack in one read sees the agent hang up during the push', async (t) => {
  const f = await pushFixture(t);
  const stream = require('node:stream');
  const real = stream.PassThrough;
  t.after(() => { stream.PassThrough = real; });
  class Full extends real {
    write(...args) {
      super.write(...args);
      process.nextTick(() => this.writableEnded || this.emit('drain'));
      return false;
    }
  }
  const lock = path.join(f.h.state, 'push', 'cache.lock');
  const started = path.join(f.h.base, 'hook-started');
  const release = path.join(f.h.base, 'hook-release');
  const slash = (p) => p.replace(/\\/g, '/');
  // It waits for the release file, or for the fixture to be removed when the
  // test ends. The push runs in a process group of its own, so a cancelled
  // test run would leave it waiting: on POSIX it also stops once this test
  // process is gone (Git for Windows' kill does not see a Windows pid).
  const tester = process.platform === 'win32' ? '' : ` && kill -0 ${process.pid} 2>/dev/null`;
  fs.writeFileSync(path.join(f.remote, 'hooks', 'pre-receive'),
    `#!/bin/sh\n: > '${slash(started)}'\nwhile [ ! -f '${slash(release)}' ] && [ -d '${slash(f.h.base)}' ]${tester}; do sleep 0.1; done\n`, { mode: 0o755 });
  t.after(() => { try { fs.writeFileSync(release, ''); } catch {} });
  const sha = f.commit('a.txt', 'a\n');
  let sock = null;
  // Only the next PassThrough, the body the broker makes when it reads the
  // request line.
  stream.PassThrough = function PassThrough(...args) {
    stream.PassThrough = real;
    return new Full(...args);
  };
  const done = handPush(f, sha, (have) => [Buffer.concat([B.frame(packOf(f, sha, have)), B.frame(Buffer.alloc(0))])],
    { socket: (s) => { sock = s; } });
  await waitUntil(() => fs.existsSync(started), { paths: [f.h.base], what: 'the broker\'s push reaches the remote\'s hook' });
  sock.end(Buffer.from('after the end frame'));
  // A broker that missed the hang-up holds the cache lock in the hook until
  // the release file appears, so the wait is bounded and then releases it.
  const bound = AbortSignal.timeout(20000); // wait-allow: a broker that missed the hang-up never stops the push; the bound turns that into a prompt failure
  const stopped = await waitUntil(() => !fs.existsSync(lock), { paths: [path.dirname(lock)], signal: bound, what: 'the push ends and frees the cache lock' })
    .then(() => true, () => false);
  fs.writeFileSync(release, '');
  await done;
  assert.ok(stopped, 'the broker saw the agent hang up and stopped its push within 20 s');
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null, 'the push of an agent that hung up was stopped');
});

// index-pack stops at the first object fsck refuses, long before a large
// pack is read. The agent's push must end with the broker's answer, not wait
// on a pack-objects blocked on a full pipe, and the broker keeps nothing.
test('a pack the broker refuses partway ends the agent\'s push at once and leaves nothing in the cache', async (t) => {
  const f = await pushFixture(t);
  const base = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  f.commit('seed.txt', 'seed\n');
  assert.equal((await f.raw({ push: { sha: f.h.git(['rev-parse', 'HEAD'], f.wt.path) } })).code, 0);
  f.h.git(['reset', '-q', '--hard', base], f.wt.path);
  fs.writeFileSync(path.join(f.wt.path, 'big.bin'), require('node:crypto').randomBytes(8 << 20));
  f.h.git(['add', 'big.bin'], f.wt.path);
  const tree = f.h.git(['write-tree'], f.wt.path);
  const bad = require('node:child_process').execFileSync('git', ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'],
    { cwd: f.wt.path, encoding: 'utf8', input: `tree ${tree}\nparent ${base}\nauthor A <a@example.invalid> 1700000000 +99999\ncommitter A <a@example.invalid> 1700000000 +99999\n\nbad zone\n` }).trim();
  f.h.git(['reset', '-q', '--hard', bad], f.wt.path);
  const run = shimChild(f, ['git', 'push']);
  const timer = setTimeout(() => run.child.kill('SIGKILL'), HUNG_TEST_MS);
  const code = await run.exited;
  clearTimeout(timer);
  assert.notEqual(code, null, `the shim ended by itself\n${run.stderr()}`);
  assert.notEqual(code, 0, run.stderr());
  assert.match(run.stderr(), /badTimezone|fsck/);
  const cache = path.join(f.h.state, 'push', 'cache.git');
  const left = fs.readdirSync(cache, { recursive: true }).filter((n) => /tmp_pack_|quarantine/.test(n));
  assert.deepEqual(left, [], 'no temporary pack is left in the cache');
  assert.deepEqual(fs.readdirSync(path.join(f.h.state, 'push')).filter((n) => n.startsWith('quarantine-')), []);
  assert.notEqual(require('node:child_process').spawnSync('git', ['--git-dir', cache, 'cat-file', '-e', `${tree}^{tree}`]).status, 0,
    'nothing of the refused pack is in the cache');
});

// index-pack has just written the pack, and Windows refuses its move into the
// cache for a moment while a scanner holds it.
test('the broker waits out a refused move of the agent\'s pack into its cache', async (t) => {
  const f = await pushFixture(t);
  const sha = f.commit('a.txt', 'a\n');
  const cache = path.join(f.h.state, 'push', 'cache.git');
  const rename = fs.renameSync;
  let refused = 0;
  fs.renameSync = function busyPack(from, to, ...rest) {
    if (!refused && String(to).startsWith(cache + path.sep) && String(to).endsWith('.pack')) {
      refused++;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { fs.renameSync = rename; });
  const r = await f.raw({ push: { sha } });
  fs.renameSync = rename;
  assert.equal(refused, 1, 'the move of the pack was refused once');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), sha);
});

// A push refused after its pack was indexed leaves none of its objects; the
// pack has a size cap and an idle limit, after which the cache lock is free.
test('the agent\'s pack is quarantined until the checks pass, capped in size, and dropped when it stalls', async (t) => {
  const f = await pushFixture(t);
  const G = require('../lib/github-broker');
  const saved = { ...G.LIMITS };
  t.after(() => Object.assign(G.LIMITS, saved));
  const cache = path.join(f.h.state, 'push', 'cache.git');
  const inCache = (sha) => require('node:child_process').spawnSync('git', ['--git-dir', cache, 'cat-file', '-e', sha]).status === 0;
  const workflow = f.commit('.github/workflows/ci.yml', 'on: push\n');
  const refused = await f.raw({ push: { sha: workflow } });
  assert.match(refused.stderr, /changes \.github\/workflows\/ci\.yml/);
  assert.equal(inCache(workflow), false, 'a refused push leaves its objects out of the cache');
  f.h.git(['reset', '-q', '--hard', 'HEAD~1'], f.wt.path);
  // Over the size cap.
  G.LIMITS.input = 4096;
  fs.writeFileSync(path.join(f.wt.path, 'noise.bin'), require('node:crypto').randomBytes(64 << 10));
  f.h.git(['add', 'noise.bin'], f.wt.path);
  f.h.git(['commit', '-qm', 'noise'], f.wt.path);
  const large = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  const big = await f.raw({ push: { sha: large } });
  assert.notEqual(big.code, 0);
  assert.match(big.stderr, /maximum allowed size|exceeds/);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null);
  G.LIMITS.input = saved.input;
  // A sender that stalls after the pack header.
  G.LIMITS.idleMs = 300;
  const stuck = new (require('node:stream').PassThrough)();
  stuck.write(Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]));
  const started = Date.now();
  const stalled = await f.raw({ push: { sha: large } }, { pack: () => stuck });
  assert.notEqual(stalled.code, 0);
  assert.match(stalled.stderr, /stalled/);
  assert.ok(Date.now() - started < 10000, 'the stalled pack ended the push'); // wait-allow: the 300 ms idle limit under test ends the push long before any other limit
  G.LIMITS.idleMs = saved.idleMs;
  const ok = await f.raw({ push: { sha: large } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), large);
});

// The cache lock every push and fetch of the project waits on is freed when
// an agent stops reading its fetch's pack (idle cap) or reads it too slowly
// (total cap), and when its push's pack trickles past the total cap.
test('a fetch or push pack that outlasts its caps frees the cache lock', async (t) => {
  const f = await sshOriginFixture(t);
  const G = require('../lib/github-broker');
  const saved = { ...G.LIMITS };
  t.after(() => Object.assign(G.LIMITS, saved));
  const lock = path.join(f.h.state, 'push', 'cache.lock');
  // Larger than the socket buffers, so the broker's writes wait for a drain.
  f.advance('big.bin', require('node:crypto').randomBytes(4 << 20));
  const net = require('node:net');
  const b = JSON.parse(fs.readFileSync(f.job.broker, 'utf8'));
  // An agent that sends a fetch and never reads the answer.
  const silent = () => new Promise((resolve) => {
    const sock = b.socket ? net.connect(b.socket) : net.connect(b.port, b.host);
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.pause();
      sock.write(`${JSON.stringify({ token: b.token, fetch: {} })}\n`);
      resolve(sock);
    });
  });
  for (const [what, limits] of [['idle', { idleMs: 300, totalMs: saved.totalMs }], ['total', { idleMs: saved.idleMs, totalMs: 500 }]]) {
    Object.assign(G.LIMITS, limits);
    const sock = await silent();
    await waitUntil(() => fs.existsSync(lock), { paths: [path.dirname(lock)], what: `${what}: the fetch takes the lock` });
    await waitUntil(() => !fs.existsSync(lock), { paths: [path.dirname(lock)], what: `${what}: the cap frees the cache lock` });
    sock.destroy();
  }
  Object.assign(G.LIMITS, saved);
  // A push whose pack trickles in, a byte at a time, never idle.
  G.LIMITS.totalMs = 500;
  const sha = f.commit('slow.txt', 'slow\n');
  const trickle = () => {
    const out = new (require('node:stream').PassThrough)();
    const timer = setInterval(() => out.write(Buffer.from([0x50])), 50); // wait-allow: the fixture's trickle rate, under the idle cap and over the total cap under test
    out.on('close', () => clearInterval(timer));
    out.stop = () => { clearInterval(timer); out.destroy(); };
    return out;
  };
  const slow = await f.raw({ push: { sha } }, { pack: trickle });
  assert.notEqual(slow.code, 0);
  assert.match(slow.stderr, /took longer than 0 s|took longer than 1 s/);
  assert.equal(fs.existsSync(lock), false, 'the push freed the cache lock');
  Object.assign(G.LIMITS, saved);
  const fetched = await f.shim('git', ['fetch', '-q', 'origin']);
  assert.equal(fetched.status, 0, fetched.stderr);
});

// A remote that stops answering, as over a dropped network, while the
// broker's own git talks to it under the cache lock: its ls-remote, fetch
// and push each end at the idle cap with the ssh they started, the agent
// gets the reason, and the lock is free for the next push or fetch. Only the
// git command each step stalls runs under the short cap. The healthy fetch
// the broker runs before every push, and the healthy steps, keep the default
// cap: their silent phases (starting sh, node and the remote's git through
// the ssh below, index-pack, the connectivity check) outlasted a 300 ms cap
// on Windows runners.
test('the broker\'s ls-remote, fetch and push to a stalled remote end at the idle cap and free the cache lock', async (t) => {
  const f = await sshOriginFixture(t);
  const G = require('../lib/github-broker');
  const saved = { ...G.LIMITS };
  t.after(() => Object.assign(G.LIMITS, saved));
  const lock = path.join(f.h.state, 'push', 'cache.lock');
  const pids = path.join(f.h.base, 'stalled-ssh.pids');
  const ssh = path.join(f.h.base, 'stalling-ssh.js');
  // Serves the fixture's remote as ssh would, but never answers the
  // service named by its first argument.
  fs.writeFileSync(ssh, `const args = process.argv.slice(3);
if (args.includes('-G')) process.exit(0);
const m = /^git-(upload|receive)-pack '(.*)'$/.exec(args[args.length - 1]);
if (!m || m[2] !== 'acme/demo.git') { process.stderr.write('ssh: unexpected ' + args.join(' ') + '\\n'); process.exit(255); }
if (m[1] === process.argv[2]) {
  require('node:fs').appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
  setInterval(() => {}, 1e9);
} else {
  const r = require('node:child_process').spawnSync('git', [m[1] + '-pack', ${JSON.stringify(f.remote)}], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
`);
  const using = (service) => {
    process.env.GIT_SSH_COMMAND = `"${process.execPath.replace(/\\/g, '/')}" "${ssh.replace(/\\/g, '/')}" ${service}`;
  };
  // The broker reads LIMITS.idleMs as it starts each git, so the cap is set
  // per command: 2 s, long enough for the stalling ssh to start and record
  // its pid, for the one named by capped, and the default for the rest.
  const childProcess = require('node:child_process');
  const spawn = childProcess.spawn;
  let capped = null;
  childProcess.spawn = function (command, args, ...rest) {
    if (command === 'git' && Array.isArray(args)) G.LIMITS.idleMs = capped && args.includes(capped) ? 2000 : saved.idleMs;
    return spawn.call(this, command, args, ...rest);
  };
  t.after(() => { childProcess.spawn = spawn; });
  const deadline = (p, what) => Promise.race([p, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${what}: the broker still waits on the stalled remote`)), 30000))]); // wait-allow: a 2 s idle cap ends each stall; without it the broker waits forever
  const stalled = async (service, command, payload, what) => {
    using(service);
    capped = command;
    const r = await deadline(f.raw(payload), what).finally(() => { capped = null; });
    assert.equal(r.code, 1, `${what}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${what.replace(/[.\\]/g, '\\$&')} stalled for \\d+ s; the broker stopped it and freed the cache lock`));
    assert.equal(fs.existsSync(lock), false, `${what}: the cache lock is free`);
    const stuck = fs.readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number);
    assert.ok(stuck.length, `${what}: the stalling ssh ran`);
    await waitUntil(() => stuck.every((pid) => !alive(pid)), { what: `${what}: the broker stopped the ssh its git started` });
    fs.rmSync(pids);
  };
  // The first use reads the remote's object format with ls-remote.
  await stalled('upload', 'ls-remote', { fetch: {} }, 'the broker\'s ls-remote of git@github.com:acme/demo.git');
  using('none');
  const first = await f.raw({ fetch: {} });
  assert.equal(first.code, 0, first.stderr);
  await stalled('upload', 'fetch', { fetch: {} }, 'the broker\'s fetch from git@github.com:acme/demo.git');
  const sha = f.commit('stalled.txt', 'stalled\n');
  await stalled('receive', 'push', { push: { sha } }, 'the broker\'s push to git@github.com:acme/demo.git');
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null);
  // With the remote answering again, the next push takes the lock and runs.
  using('none');
  const pushed = await f.raw({ push: { sha } });
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), sha);
});

// An agent that hangs up is stopped: a gh that prints nothing, and a push
// still waiting for the cache lock.
test('the broker stops a silent gh and a waiting push when the agent hangs up', async (t) => {
  const f = await pushFixture(t);
  // The commit is in the cache whole, so the push needs no pack.
  const sha = f.commit('a.txt', 'a\n');
  assert.equal((await f.raw({ push: { sha } })).code, 0);
  require('node:child_process').execFileSync('git', ['--git-dir', f.remote, 'update-ref', '-d', `refs/heads/${f.task.branch}`]);
  const G = require('../lib/github-broker');
  const release = await G.lockCache(path.join(f.h.state, 'push'), { stderr() {}, gone: () => false });
  const push = shimChild(f, ['git', 'push']);
  await waitUntil(() => /waits for another push/.test(push.stderr()), { alive: push.child, what: () => `the push waits for the lock\n${push.stderr()}` });
  push.child.kill('SIGKILL');
  await push.exited;
  // A branch the remote gains now shows in the cache only if the push
  // still ran its fetch once the lock was free.
  require('node:child_process').execFileSync('git', ['--git-dir', f.remote, 'update-ref', 'refs/heads/later', sha]);
  await new Promise((r) => setTimeout(r, 400)); // wait-allow: lets the broker see the hang-up while the lock is still held
  release();
  await new Promise((r) => setTimeout(r, 1500)); // wait-allow: negative observation window; a push still waiting would fetch once the lock is free
  const cacheRefs = require('node:child_process').execFileSync('git', ['--git-dir', path.join(f.h.state, 'push', 'cache.git'), 'for-each-ref'], { encoding: 'utf8' });
  assert.doesNotMatch(cacheRefs, /refs\/remotes\/origin\/later/, 'the push of an agent that hung up stopped waiting and never fetched');
  assert.equal(f.remoteRef(`refs/heads/${f.task.branch}`), null, 'the push of an agent that hung up does not run');

  f.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const pidFile = path.join(f.h.base, 'gh.pid');
  hostGh(t, path.join(f.h.base, 'silent-bin'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  const gh = shimChild(f, ['gh', 'pr', 'checks']);
  await waitUntil(() => fs.existsSync(pidFile) && readPublished(pidFile, 'utf8'), { paths: [pidFile], alive: gh.child, what: () => `gh started\n${gh.stderr()}` });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  gh.child.kill('SIGKILL');
  await gh.exited;
  await waitUntil(() => !alive(pid), { what: 'the broker stopped the gh of an agent that hung up' });
});

// cache.lock was a plain file in earlier versions of the broker.
test('a cache lock left as a file by a dead holder is removed, without stopping the event loop', (t) => {
  const { base } = scratch(t);
  const root = path.join(base, 'push');
  fs.mkdirSync(root);
  const cp = require('node:child_process');
  const gone = cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'cache.lock'), JSON.stringify({ pid: Number(gone.stdout), host: os.hostname() }));
  const r = cp.spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(ROOT, 'lib', 'github-broker.js'))}).lockCache(${JSON.stringify(root)}, { stderr() {} }).then((release) => { release(); console.log('held'); })`],
  { encoding: 'utf8', timeout: HUNG_TEST_MS });
  assert.equal(r.status, 0, `lockCache took the lock: ${r.signal || r.stderr}`);
  assert.match(r.stdout, /held/);
});

// GitHub runs local actions from the pushed tree: those under .github/actions
// and any other directory a workflow names with uses: ./path.
test('the broker refuses a push that changes a local action a workflow runs, and keeps git tracing out of the agent\'s output', async (t) => {
  const f = await pushFixture(t);
  const branch = f.task.branch;
  f.commit('.github/workflows/ci.yml', 'jobs:\n  a:\n    steps:\n      - uses: "./tools/act"\n      - uses: actions/checkout@v4\n');
  f.h.git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], f.wt.path);
  const pushedBase = f.h.git(['rev-parse', 'HEAD'], f.wt.path);
  for (const file of ['.github/actions/setup/action.yml', 'tools/act/action.yml', 'tools/act/action.yaml']) {
    f.h.git(['reset', '-q', '--hard', pushedBase], f.wt.path);
    const sha = f.commit(file, 'runs:\n  using: composite\n');
    const r = await f.raw({ push: { sha } });
    assert.notEqual(r.code, 0, `${file}: ${r.stderr}`);
    assert.ok(r.stderr.includes(`changes ${file}`), `${file}: ${r.stderr}`);
  }
  assert.equal(f.remoteRef(`refs/heads/${branch}`), pushedBase, 'no action change reached the remote');
  // An action no workflow runs is an ordinary file. git's tracing stays on
  // the host.
  f.h.git(['reset', '-q', '--hard', pushedBase], f.wt.path);
  const free = f.commit('other/action.yml', 'runs:\n  using: composite\n');
  const saved = { GIT_TRACE: process.env.GIT_TRACE, GIT_TRACE_PACKET: process.env.GIT_TRACE_PACKET, GIT_CURL_VERBOSE: process.env.GIT_CURL_VERBOSE };
  Object.assign(process.env, { GIT_TRACE: '1', GIT_TRACE_PACKET: '1', GIT_CURL_VERBOSE: '1' });
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const ok = await f.raw({ push: { sha: free } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(ok.stderr, /trace: |packet: /, 'no git trace reaches the agent');
  assert.equal(f.remoteRef(`refs/heads/${branch}`), free);
});

test('a sandboxed agent\'s push to another machine from outside its task repository is refused by its shim; a local push runs', async (t) => {
  const f = await pushFixture(t);
  const other = path.join(f.h.base, 'other');
  f.h.git(['init', '-q', other]);
  f.h.git(['commit', '-q', '--allow-empty', '-m', 'x'], other);
  const bare = path.join(f.h.base, 'other.git');
  f.h.git(['init', '-q', '--bare', bare]);
  f.h.git(['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], other);
  // The recorded repository, which origin here names: the shim's checks
  // pass, and only the missing credentials remain.
  const policy = path.join(f.h.base, 'shim', 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ ...JSON.parse(fs.readFileSync(policy, 'utf8')), repo: 'acme/demo' }));
  const local = await f.shim('git', ['push', bare, 'HEAD:refs/heads/x'], { cwd: other });
  assert.equal(local.status, 0, local.stderr);
  const remote = await f.shim('git', ['push', 'origin', `HEAD:${f.task.branch}`], { cwd: other });
  assert.equal(remote.status, 126, remote.stderr);
  assert.match(remote.stderr, /has no credentials/);
});

// spawn reads the remote hosts without the system config (agents.js
// remoteHosts), so the shim's git reads none either, even when the agent
// drops GIT_CONFIG_NOSYSTEM from its environment: a system insteadOf here
// turns the remote into a path on this machine.
test('a sandboxed agent\'s git reads the remote hosts without the system config', async (t) => {
  const f = await pushFixture(t);
  const other = path.join(f.h.base, 'other');
  f.h.git(['init', '-q', other]);
  f.h.git(['commit', '-q', '--allow-empty', '-m', 'x'], other);
  const bare = path.join(f.h.base, 'other.git');
  f.h.git(['init', '-q', '--bare', bare]);
  f.h.git(['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], other);
  const system = path.join(f.h.base, 'system-gitconfig');
  fs.writeFileSync(system, `[url "${bare.replace(/\\/g, '/')}"]\n\tinsteadOf = https://github.com/acme/demo.git\n`);
  const env = { GIT_CONFIG_SYSTEM: system, GIT_CONFIG_NOSYSTEM: undefined };
  const url = await f.shim('git', ['ls-remote', '--get-url', 'origin'], { cwd: other, env });
  assert.equal(url.stdout.trim(), 'https://github.com/acme/demo.git', url.stderr);
  const push = await f.shim('git', ['push', 'origin', 'HEAD:refs/heads/x'], { cwd: other, env });
  assert.equal(push.status, 126, push.stderr);
  assert.equal(f.h.git(['--git-dir', bare, 'for-each-ref']).trim(), '', 'nothing reached the path the system config names');
});

// The gh the broker in this process runs: a script first on PATH. Windows
// runs no shebang script and finds only gh.exe, so there the broker's spawn
// of gh runs the script with node instead.
function hostGh(t, bin, source) {
  fs.mkdirSync(bin);
  const script = path.join(bin, 'gh');
  fs.writeFileSync(script, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  if (process.platform === 'win32') {
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (command, args, opts) => (command === 'gh' ? spawn(process.execPath, [script, ...(args || [])], opts) : spawn(command, args, opts));
    t.after(() => { cp.spawn = spawn; });
    return;
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
}

// A gh on the broker's PATH that logs each call and answers a pull request
// lookup: number 7 is the task's, 9 another branch's.
function fakeGh(t, f) {
  const log = path.join(f.h.base, 'gh-calls.jsonl');
  hostGh(t, path.join(f.h.base, 'host-bin'), `const fs = require('node:fs');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, env: process.env }) + '\\n');
if (args[0] === 'pr' && args[1] === 'view' && args.includes('number,headRefName,isCrossRepository')) {
  const sel = args.at(-1);
  console.log(JSON.stringify(sel === '9' || sel === 'other' ? { number: 9, headRefName: 'other', isCrossRepository: false } : { number: 7, headRefName: ${JSON.stringify(f.task.branch)}, isCrossRepository: false }));
} else console.log('gh ran ' + args.join(' '));
`);
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN, SECRET_PROBE: process.env.SECRET_PROBE };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.SECRET_PROBE = 'host-secret';
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return () => (fs.existsSync(log) ? readPublished(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
}

test('the broker runs gh only with a config directory no agent can write', async (t) => {
  const f = await pushFixture(t);
  f.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const calls = fakeGh(t, f);
  const saved = process.env.GH_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.GH_CONFIG_DIR; else process.env.GH_CONFIG_DIR = saved; });
  for (const dir of [path.join(f.h.state, 'homes', 'worker-T1-1', 'gh'), path.join(f.wt.path, 'gh'), f.h.state]) {
    process.env.GH_CONFIG_DIR = dir;
    const r = await f.shim('gh', ['pr', 'view', '--json', 'body']);
    assert.equal(r.status, 1, `${dir}: ${r.stderr}`);
    assert.match(r.stderr, /gh's config directory .* is inside .*, which an agent can write/);
  }
  assert.equal(calls().length, 0, 'gh never ran');
  process.env.GH_CONFIG_DIR = path.join(f.h.base, 'user-gh');
  const r = await f.shim('gh', ['pr', 'view', '--json', 'body']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls().at(-1).env.GH_CONFIG_DIR, path.join(f.h.base, 'user-gh'));
});

test('a sandboxed worker\'s gh runs through its broker in the project repository, on its own pull request, in an environment without the host\'s variables', async (t) => {
  const f = await pushFixture(t);
  f.h.ok(['project', 'set', '--repo', 'acme/demo', '--agent', 'owner']);
  const calls = fakeGh(t, f);
  const branch = f.task.branch;
  fs.writeFileSync(path.join(f.wt.path, 'body.md'), 'what changed\n');
  const created = await f.shim('gh', ['pr', 'create', '-t', 'Title', '-F', 'body.md', '-d']);
  assert.equal(created.status, 0, created.stderr);
  let call = calls().at(-1);
  assert.deepEqual(call.args, ['pr', 'create', '--title=Title', '--body-file=-', '--draft', '--repo=acme/demo', `--head=${branch}`]);
  assert.equal(call.stdin, 'what changed\n', 'the shim read the body file in the sandbox and sent it');
  assert.equal(call.env.SECRET_PROBE, undefined, 'gh runs without the host\'s other variables');
  assert.equal(call.env.GH_PROMPT_DISABLED, '1');
  assert.ok(call.env.GIT_DIR && !fs.existsSync(call.env.GIT_DIR), 'gh finds no local repository to read');
  assert.equal(call.env.HOME, process.env.HOME, 'gh finds the user\'s login');

  const viewed = await f.shim('gh', ['pr', 'view', '--json', 'body']);
  assert.equal(viewed.status, 0, viewed.stderr);
  assert.match(viewed.stdout, /^gh ran pr view/);
  assert.deepEqual(calls().at(-1).args, ['pr', 'view', '--json=body', '--repo=acme/demo', '--', branch], 'the task branch names the pull request');

  const edited = await f.shim('gh', ['pr', 'edit', '--title', 'New']);
  assert.equal(edited.status, 0, edited.stderr);
  assert.deepEqual(calls().at(-1).args, ['pr', 'edit', '--title=New', '--repo=acme/demo', '--', '7']);

  const before = calls().length;
  const foreign = await f.shim('gh', ['pr', 'edit', '9', '--title', 'New']);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /#9 is from other, not the task branch/);
  assert.deepEqual(calls().slice(before).map((c) => c.args.slice(0, 2)), [['pr', 'view']], 'only the lookup ran');

  // Refused before gh runs: the agent file, commands with no broker route,
  // flags that act on the host, another repository.
  const refusals = [
    [['api', 'user'], 126, /gh api user is not allowed/],
    [['pr', 'comment', '7', '--body', 'x'], 126, /gh pr comment is not allowed/],
    [['search', 'prs', 'x'], 126, /gh search prs is not available/],
    [['pr', 'view', '7', '--web'], 1, /--web would act on the broker's host/],
    [['pr', 'create', '--title', 'x', '--body', 'y', '--attach', '/etc/passwd'], 1, /--attach would act on the broker's host/],
    [['pr', 'create', '--title', 'x', '-T', '/etc/passwd'], 1, /--template reads a file/],
    [['pr', 'create', '--title', 'x', '--body', 'y', '--head', 'main'], 1, /comes from the task branch/],
    [['pr', 'view', '-R', 'acme/other', '7'], 1, /acme\/demo only, not acme\/other/],
    [['pr', 'view', 'https://github.com/acme/other/pull/7'], 1, /by number or branch/],
    [['repo', 'view', 'acme/other'], 1, /repo view shows the project's repository/],
    [['auth', 'status', '-t'], 1, /--show-token would act/],
    [['pr', 'view', '7', '--no-such-flag'], 126, /has no flag --no-such-flag/],
  ];
  const count = calls().length;
  for (const [args, code, message] of refusals) {
    const r = await f.shim('gh', args);
    assert.equal(r.status, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, message, args.join(' '));
  }
  assert.equal(calls().length, count, 'no refused command reached gh');

  // gh's --jq reads the environment gh runs with, so it is refused while a token is there.
  const jq = await f.shim('gh', ['pr', 'view', '7', '--json', 'title', '--jq', '.title']);
  assert.equal(jq.status, 0, jq.stderr);
  process.env.GH_TOKEN = 'host-token';
  const leak = await f.shim('gh', ['pr', 'view', '7', '--json', 'title', '--jq', '$ENV.GH_TOKEN']);
  assert.equal(leak.status, 1);
  assert.match(leak.stderr, /--jq can read the token/);
});

test('gh arguments parse as gh does: clusters, attached values and "--", and an unknown flag is refused', () => {
  const G = require('../lib/github-broker');
  assert.deepEqual(G.parseGh(['pr', 'create', '-dtTitle', '--body=x', '-B', 'main', '--', '-x']),
    { command: 'pr create', flags: [{ name: 'draft' }, { name: 'title', value: 'Title' }, { name: 'body', value: 'x' }, { name: 'base', value: 'main' }], pos: ['-x'] });
  assert.deepEqual(G.buildGh(G.parseGh(['pr', 'view', '12', '-c', '--json', 'body'])), ['pr', 'view', '--comments', '--json=body', '--', '12']);
  // -w is --web in pr view and --workflow in run list.
  assert.deepEqual(G.parseGh(['run', 'list', '-w', 'ci.yml']).flags, [{ name: 'workflow', value: 'ci.yml' }]);
  assert.deepEqual(G.parseGh(['pr', 'view', '-w']).flags, [{ name: 'web' }]);
  assert.throws(() => G.parseGh(['pr', 'view', '-z']), /no flag -z/);
  assert.throws(() => G.parseGh(['pr', 'view', '--draft']), /no flag --draft/);
  assert.throws(() => G.parseGh(['pr', 'create', '--title']), /needs a value/);
  assert.throws(() => G.parseGh(['--repo', 'x', 'pr', 'view']), /not available/);
});

// Each sandboxed role's instructions, and the broker role its agent runs as:
// the researcher is a worker on the research rung. A .js file is prompt text
// built in code; its comment lines are skipped.
const ROLE_FILES = {
  'skills/tower-crane-work/SKILL.md': 'worker',
  'agents/tower-crane-worker.md': 'worker',
  'agents/tower-crane-researcher.md': 'worker',
  'lib/harness-hooks.js': 'worker',
  'skills/tower-crane-review/SKILL.md': 'reviewer',
  'agents/tower-crane-reviewer.md': 'reviewer',
  'agents/tower-crane-small.md': 'small',
};
// A line that names a command another role runs, without telling this role
// to run it: the file, the command and text on that same line.
const OTHER_ROLE = [
  ['skills/tower-crane-work/SKILL.md', 'stack sync', "Stack refresh runs through the orchestrator's `tower-crane stack sync`"],
  ['skills/tower-crane-review/SKILL.md', 'spawn', 'A reviewer that `tower-crane spawn` did not start'],
  ['skills/tower-crane-review/SKILL.md', 'ci resolve', 'The worker or the orchestrator closes the finding'],
];
const SCOPE = { TOWER_CRANE_TASK: 'T1', TOWER_CRANE_AGENT: 'worker-T1-1' };

// The code in a file, as [start, text] regions: fenced blocks (``` or ~~~)
// and inline spans, which may wrap across lines but not a paragraph break,
// in markdown; every line but comments in JavaScript.
function codeRegions(text, js) {
  if (js) {
    let at = 0;
    return text.split('\n').map((line) => { const r = [at, line]; at += line.length + 1; return r; }).filter(([, line]) => !/^\s*\/\//.test(line));
  }
  const regions = [];
  const masked = text.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[^\n]*$/gm, (m, fence, body, offset) => {
    regions.push([offset + m.indexOf('\n') + 1, body]);
    return ' '.repeat(m.length);
  });
  for (const m of masked.matchAll(/`((?:[^`\n]|\n(?![ \t]*\n))+)`/g)) regions.push([m.index + 1, m[1].replace(/\n/g, ' ')]);
  return regions;
}

// Each tower-crane command a region shows: its name, the source line, and
// its arguments up to a shell separator, the next tower-crane or the end of a
// fenced line, cut where the command's own syntax ends (prose after it).
// CRLF text (a Windows checkout) reads as LF, so a blank line stays a
// paragraph break and a code span cannot run across it.
function commandMentions(text, js = false) {
  const { resolveCommand: resolve } = require('../bin/tower-crane');
  text = text.replace(/\r\n?/g, '\n');
  const out = [];
  for (const [start, region] of codeRegions(text, js)) {
    for (const m of region.matchAll(/(?<![\w-])tower-crane(?![\w-])/g)) {
      const at = start + m.index;
      const line = text.slice(text.lastIndexOf('\n', at) + 1, text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at));
      const rest = region.slice(m.index + m[0].length).split(/\n|&&|\|\||;|\||(?<![\w-])tower-crane(?![\w-])/)[0];
      const words = rest.trim().split(/\s+/).filter(Boolean);
      let r;
      try { r = resolve(words); } catch (e) { r = { error: e.message }; }
      if (!r.cmd) {
        out.push({ name: `unknown: tower-crane ${rest.trim()} (${r.error || 'no command'})`, line });
        continue;
      }
      const pos = r.cmd.pos || [];
      const args = [];
      let positionals = 0;
      for (let i = 0; i < r.rest.length; i++) {
        const tok = r.rest[i].replace(/[),.]+$/, '');
        if (tok.startsWith('--')) {
          const spec = { ...(r.cmd.flags || {}), ...GLOBAL }[tok.slice(2).split('=')[0]];
          args.push(tok);
          if (spec && spec.type !== 'bool' && !tok.includes('=') && i + 1 < r.rest.length) args.push(r.rest[++i].replace(/[),.]+$/, ''));
        } else if (pos[0] === 'ID...' || positionals < pos.length) {
          args.push(tok);
          positionals++;
        } else break;
      }
      out.push({ name: r.cmd.name, line, lead: r.lead, args, cmd: r.cmd });
    }
  }
  return out;
}

// A wait mention as the agent would run it, placeholders filled, through the
// scope its sandbox applies.
function scopedWait(mention) {
  const fill = (t) => t.replace(/^(<id>|<task id>|ID|\$\{task\.id\})$/, SCOPE.TOWER_CRANE_TASK)
    .replace(/^(<name>|NAME)$/, SCOPE.TOWER_CRANE_AGENT).replace(/^(SEC|<sec>)$/, '60');
  const { flags } = parseOptions([...mention.lead, ...mention.args].map(fill), { ...(mention.cmd.flags || {}), ...GLOBAL }, 'wait');
  B.scopeWait(flags, flags.agent ?? SCOPE.TOWER_CRANE_AGENT, SCOPE);
}

test('the command extractor finds every tower-crane command in code and checks the wait scope', () => {
  const names = (text, js) => commandMentions(text, js).map((m) => m.name);
  assert.deepEqual(names('Run `tower-crane task show T1 && tower-crane spend T1` now.'), ['task show', 'spend']);
  assert.deepEqual(names('~~~sh\ntower-crane claim T1 --agent a\ntower-crane submit T1\n~~~\n'), ['claim', 'submit']);
  assert.deepEqual(names('```\ntower-crane renew T1; tower-crane release T1 --reason x\n```\n'), ['renew', 'release']);
  assert.deepEqual(names('Wait with `tower-crane wait --task <id>\n--timeout SEC` and go on.'), ['wait']);
  assert.deepEqual(names('Prose tower-crane check is not code.\n\n`a`\n\n`tower-crane spawn`'), ['spawn']);
  assert.deepEqual(names('One stray ` here.\r\n\r\nRun `tower-crane spawn` now.\r\n'), ['spawn'], 'a CRLF blank line ends a paragraph');
  assert.deepEqual(names('~~~sh\r\ntower-crane claim T1 --agent a\r\n~~~\r\n'), ['claim']);
  assert.deepEqual(commandMentions('Run `tower-crane spawn` now.\r\n')[0].line, 'Run `tower-crane spawn` now.');
  assert.deepEqual(names('// tower-crane check in a comment\nconst s = `(tower-crane wait --task ${task.id} --timeout SEC exits 2)`;', true), ['wait']);
  const wait = (text) => commandMentions(text, true).find((m) => m.name === 'wait');
  assert.deepEqual(wait('`(tower-crane wait --task ${task.id} --timeout SEC exits 2 on timeout)`').args, ['--task', '${task.id}', '--timeout', 'SEC']);
  assert.doesNotThrow(() => scopedWait(wait('tower-crane wait --task <id> --agent <name> --timeout SEC')));
  for (const [text, why] of [
    ['tower-crane wait --task <id> --follow', /--follow is the orchestrator's/],
    ['tower-crane wait --task <id>', /waits with a bound/],
    ['tower-crane wait --task T9 --timeout SEC', /works on T1 only/],
    ['tower-crane wait --task <id> --timeout SEC --for owner', /not owner/],
  ]) assert.throws(() => scopedWait(wait(text)), why, text);
});

test('every tower-crane command a sandboxed role is told to run is one its broker allows or a read it runs itself', () => {
  const seen = new Set();
  for (const [file, role] of Object.entries(ROLE_FILES)) {
    const mentions = commandMentions(fs.readFileSync(path.join(ROOT, file), 'utf8'), file.endsWith('.js'));
    const exempt = (m) => OTHER_ROLE.some(([f, name, text]) => {
      const hit = f === file && name === m.name && m.line.includes(text);
      if (hit) seen.add(`${f} ${name}`);
      return hit;
    });
    const refused = mentions.filter((m) => !exempt(m) && !B.READS.has(m.name) && !B.ROLES[role].includes(m.name));
    assert.deepEqual(refused.map((m) => `${m.name}: ${m.line.trim().slice(0, 120)}`), [], `${file} tells a sandboxed ${role} to run commands its broker refuses`);
    // A bare command name refers to the command; one with arguments is a call to run.
    for (const m of mentions.filter((x) => x.name === 'wait' && x.args.length)) assert.doesNotThrow(() => scopedWait(m), `${file}: ${m.line.trim()}`);
  }
  assert.deepEqual(OTHER_ROLE.filter(([f, name]) => !seen.has(`${f} ${name}`)), [], 'every exemption still matches its line');
  const work = commandMentions(fs.readFileSync(path.join(ROOT, 'skills/tower-crane-work/SKILL.md'), 'utf8'));
  assert.ok(work.some((m) => m.name === 'wait' && m.args.includes('--timeout')));
  const hooks = commandMentions(fs.readFileSync(path.join(ROOT, 'lib/harness-hooks.js'), 'utf8'), true);
  assert.ok(hooks.some((m) => m.name === 'wait' && m.args.includes('--timeout')), 'the hook prompt is checked');
});

// Every path, mode-free, and file content under dir.
function treeHash(dir) {
  const hash = require('node:crypto').createHash('sha256');
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) { hash.update(`d ${p}\n`); walk(p); }
      else if (e.isSymbolicLink()) hash.update(`l ${p} ${fs.readlinkSync(path.join(dir, p))}\n`);
      else hash.update(`f ${p}\n`).update(fs.readFileSync(path.join(dir, p)));
    }
  };
  walk('');
  return hash.digest('hex');
}

// Makes every directory and file under dir read-only, as the agent's sandbox
// leaves the state; returns the restore.
function readOnly(dir) {
  const modes = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    modes.push([p, st.mode & 0o7777]);
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    fs.chmodSync(p, st.isDirectory() ? 0o555 : 0o444);
  };
  walk(dir);
  return () => { for (const [p, mode] of modes.reverse()) fs.chmodSync(p, mode); };
}

test('a sandboxed agent waits in its sandbox on its own task, bounded and without writing the state', async (t) => {
  const h = makeRepo(t);
  // Work an orchestrator's wait would act on: a ready task with a brief that
  // its refill dispatches, so a wait that leaks the orchestrator's role writes.
  stubRungs(h);
  h.init();
  h.ok(['task', 'add', '--title', 'one', '--acceptance', 'noted']);
  h.ok(['task', 'add', '--title', 'two', '--acceptance', 'noted']);
  h.ok(['brief', 'set', 'T2', '-'], { input: '# Two\n\nDo two.\n' });
  const offset = fs.statSync(path.join(h.state, 'events.jsonl')).size;
  h.ok(['msg', '--to', 'worker-T1-1', '--task', 'T1', 'rebase on main', '--agent', 'orchestrator']);
  assert.ok(h.json(['ready']).ready.some((x) => x.id === 'T2'), 'T2 is ready for a refill to dispatch');
  const job = { state: h.state, task: 'T1', agent: 'worker-T1-1', role: 'worker', cwd: h.repo, broker: path.join(h.base, 'brokers', 'worker-T1-1', B.FILE) };
  const broker = await B.start(job);
  t.after(() => broker.close());
  const env = { ...broker.env, TOWER_CRANE_AGENT: job.agent, TOWER_CRANE_TASK: job.task };
  const wait = (args) => h.runAsync(['wait', ...args], { env });
  // Refused waits never start, and the message is already published.
  const bound = String(HUNG_TEST_MS / 1000);
  const before = treeHash(h.state);
  // Writable first, so a leaked write shows in the tree; then read-only, as
  // the sandbox runs it, where a leaked write is an error on stderr.
  for (const sandboxed of [false, true]) {
    const restore = sandboxed ? readOnly(h.state) : () => {};
    try {
      const woke = await wait(['--task', 'T1', '--after', String(offset), '--timeout', bound]);
      assert.equal(woke.code, 0, woke.stderr);
      assert.equal(woke.stderr, '');
      assert.equal(JSON.parse(woke.stdout).cmd, 'msg', 'the message to the worker wakes it');
      const timedOut = await wait(['--timeout', '0.1']); // wait-allow: verify the CLI timeout contract with already-published state
      assert.equal(timedOut.code, 2, timedOut.stderr);
      assert.equal(timedOut.stderr, '');
      assert.equal(JSON.parse(timedOut.stdout).type, 'timeout');
      for (const [args, why] of [
        [['--task', 'T2', '--timeout', bound], /works on T1 only, not T2/],
        [['--task', 'T1'], /waits with a bound: --timeout SEC/],
        [['--task', 'T1', '--follow'], /wait --follow is the orchestrator's/],
        [['--task', 'T1', '--timeout', bound, '--observe'], /wait --observe is the orchestrator's/],
        [['--task', 'T1', '--timeout', bound, '--inbox'], /wait --inbox is the orchestrator's/],
        [['--task', 'T1', '--timeout', bound, '--for', 'reviewer-T1-1'], /own messages or the orchestrator's, not reviewer-T1-1/],
        [['--task', 'T1', '--timeout', bound, '--agent', 'orchestrator'], /worker-T1-1 cannot wait as orchestrator/],
      ]) {
        const r = await wait(args);
        assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
        assert.match(r.stderr, why);
      }
    } finally {
      restore();
    }
    assert.equal(treeHash(h.state), before, `the ${sandboxed ? 'read-only' : 'writable'} waits wrote nothing under the state directory`);
  }
});
