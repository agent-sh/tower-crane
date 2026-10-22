'use strict';

const { fileWritten, waitOnRepo, killGroup } = require('./signals');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { cachedFixture, pinRung, pluginRoot, real, BIN, ROOT, HOOKS, PTY_AVAILABLE, makeTaskRepo } = require('./helpers');
const stack = require('./stack-fixture');
const A = require('../lib/agents');
const S = require('../lib/state');
const { readPublished } = require('./atomic-file');
const { scopeEnv, harnessArgv } = require('./containment-plan');
// Timeout tests use the real CLI with a one-second lock wait (lib/intervals.js).
const SHORT_WAIT = JSON.stringify({ lock_wait: 1000 });

function setup(t) {
  return cachedFixture(t, 'task', (h) => {
    Object.assign(h.env, {
      CLAUDE_CONFIG_DIR: path.join(h.env.HOME, '.claude'), CODEX_HOME: path.join(h.env.HOME, '.codex'),
      PI_CODING_AGENT_DIR: path.join(h.env.HOME, '.pi', 'agent'),
      XDG_CONFIG_HOME: path.join(h.env.HOME, '.config'), XDG_DATA_HOME: path.join(h.env.HOME, '.local', 'share'),
      GH_CONFIG_DIR: path.join(h.env.HOME, '.config', 'gh'),
    });
    h.init();
    h.ok(['task', 'add', '--title', 'Idempotency key on retries', '--acceptance', 'processed once', '--acceptance', 'test proves it']);
    h.ok(['brief', 'set', 'T1', '-'], { input: '- start from the webhook handler\n' });
  });
}

// The first output of a child that prints once and exits: a child that exits
// without printing fails the test at once instead of at its timeout.
async function firstOutput(child) {
  const ended = once(child.stdout, 'end').then(() => { throw new Error(`process ${child.pid} exited without printing`); });
  const [chunk] = await Promise.race([once(child.stdout, 'data'), ended]);
  return chunk;
}

const dry = (h, rung, env) => h.json(['spawn', ...(rung ? ['--role', rung] : []), '--task', 'T1', '--dry-run'], { env });

// Sets a rung to exactly these flags: every field they leave out is cleared.
function setRung(h, rung, flags) {
  const fields = {};
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i].slice(2);
    fields[key] = ['args', 'command'].includes(key) ? JSON.parse(flags[i + 1]) : flags[i + 1];
  }
  pinRung(h, rung, fields);
}

const commandRung = (h, rung, argv) => {
  const command = argv.some((arg) => /\{(prompt|brief)\}/.test(arg)) ? argv : [...argv, '{prompt}'];
  setRung(h, rung, ['--harness', 'command', '--command', JSON.stringify(command)]);
};

test('status works when the homes directory is unreadable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, (t) => {
  const h = setup(t);
  const homes = path.join(h.state, 'homes');
  fs.mkdirSync(path.join(homes, 'worker-exited'), { recursive: true });
  try {
    fs.chmodSync(homes, 0o000);
    assert.throws(() => fs.readdirSync(homes), { code: 'EACCES' });
    assert.deepEqual(h.json(['status']).kept_homes, []);
    assert.doesNotMatch(h.ok(['status']), /^home kept:/m);
  } finally {
    fs.chmodSync(homes, 0o700);
  }
});

test('status skips the stray index for a dead agent without a recorded run marker', {
  skip: process.platform !== 'linux',
}, (t) => {
  const h = setup(t);
  for (const [agent, info] of [
    ['worker-unmarked', { pid: 2147483647 }],
    ['worker-marked-live', { pid: process.pid, run_mark: `TOWERCRANE_SPAWN_RUN_${process.pid}_live` }],
  ]) {
    fs.mkdirSync(path.join(h.state, 'homes', agent), { recursive: true });
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'spawn', agent: 'owner', task: 'T1',
      detail: { agent, role: 'worker', host: require('node:os').hostname(), ...info },
    }) + '\n');
  }
  const environReads = path.join(h.base, 'environ-reads');
  fs.writeFileSync(environReads, '');
  assert.deepEqual(h.json(['status'], {
    hooks: { HOOK_DEAD_PID: '2147483647', HOOK_ENVIRON_READS: environReads },
  }).kept_homes, []);
  assert.equal(fs.readFileSync(environReads, 'utf8'), '', 'an unrelated live agent\'s marker needs no scan');
});

test('the dead-agent sweep removes orphan brokers and keeps live claims, processes and sockets', async (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Live peer', '--acceptance', 'kept']);
  h.ok(['claim', 'T2', '--agent', 'worker-live-claim']);
  const brokerDir = (agent) => path.join(h.state, 'brokers', agent);
  const plant = (agent, address) => {
    fs.mkdirSync(brokerDir(agent), { recursive: true });
    fs.writeFileSync(path.join(brokerDir(agent), 'broker.json'), JSON.stringify({
      ...address, token: 'stale-test-token', state: h.state, task: 'T2', agent, role: 'worker',
    }));
  };
  // Killing a listener leaves its Unix socket behind, as a killed supervisor does.
  const job = { state: h.state, task: 'T2', agent: 'worker-orphan', role: 'worker', harness: 'claude',
    cwd: h.repo, broker: path.join(brokerDir('worker-orphan'), 'broker.json') };
  const listener = cp.spawn(process.execPath, ['-e',
    'require(process.argv[1]).start(JSON.parse(process.argv[2])).then(() => process.stdout.write("ready\\n"))',
    path.join(ROOT, 'lib', 'broker.js'), JSON.stringify(job)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => listener.kill('SIGKILL'));
  await firstOutput(listener);
  const { socket } = JSON.parse(fs.readFileSync(job.broker, 'utf8'));
  if (process.platform !== 'win32' && path.dirname(socket) !== brokerDir('worker-orphan')) {
    t.after(() => fs.rmSync(path.dirname(socket), { recursive: true, force: true }));
  }
  const exited = once(listener, 'exit');
  listener.kill('SIGKILL');
  await exited;
  if (process.platform !== 'win32') assert.ok(fs.statSync(socket).isSocket());
  for (const agent of ['worker-orphan', 'worker-live-claim', 'worker-live-process', 'worker-live-monitor', 'worker-unknown-process']) {
    plant(agent, { socket });
  }
  const live = net.createServer((conn) => conn.end());
  live.listen({ host: '127.0.0.1', port: 0 });
  await once(live, 'listening');
  t.after(() => new Promise((resolve) => live.close(resolve)));
  plant('worker-live-socket', { socket, host: '127.0.0.1', port: live.address().port });
  const closed = net.createServer();
  closed.listen({ host: '127.0.0.1', port: 0 });
  await once(closed, 'listening');
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  plant('worker-orphan-tcp', { host: '127.0.0.1', port });
  plant('worker-uncertain', {});
  const identity = require('../lib/processes').identity(process.pid);
  for (const [agent, processInfo] of [
    ['worker-live-process', { pid: process.pid, ...identity }],
    ['worker-live-monitor', { pid: 2147483647, ...identity, monitor_pid: process.pid, monitor_start_ticks: identity.start_ticks }],
    ['worker-unknown-process', { pid: process.pid, host: 'another-host' }],
  ]) {
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'spawn', agent: 'owner', task: 'T2', detail: { agent, role: 'worker', ...processInfo },
    }) + '\n');
  }
  // A harness that exited and left a process in its group: that process can still write the
  // agent's home and broker directory, so neither is walked while it runs. Windows has no groups.
  const grouped = process.platform !== 'win32';
  const stale = (agent) => path.join(h.state, 'brokers', `.stale-${agent}-0123456789ab`);
  if (grouped) {
    const leader = cp.spawn(process.execPath, ['-e',
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); process.stdout.write(c.pid + '\\n', () => process.exit(0))"], // wait-allow: the member only idles until the test kills its group
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const left = await firstOutput(leader);
    assert.ok(Number(String(left).trim()) > 0, 'the group keeps a member');
    t.after(() => { try { killGroup(leader.pid, 'SIGKILL'); } catch {} });
    if (leader.exitCode === null) await once(leader, 'exit');
    plant('worker-group-left', { socket });
    fs.mkdirSync(path.join(h.state, 'homes', 'worker-group-left'), { recursive: true });
    fs.writeFileSync(path.join(h.state, 'homes', 'worker-group-left', 'note'), 'the agent\'s');
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'spawn', agent: 'owner', task: 'T2',
      detail: { agent: 'worker-group-left', role: 'worker', pid: leader.pid, host: require('node:os').hostname() },
    }) + '\n');
  }
  // A spawn whose harness pid now names a later group leader: the recorded group emptied before
  // Linux gave that pid out again, so the agent is gone.
  const reused = process.platform === 'linux';
  if (reused) {
    const later = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' }); // wait-allow: the later group leader only idles until the test kills its group
    t.after(() => { try { killGroup(later.pid, 'SIGKILL'); } catch {} });
    plant('worker-group-reused', { socket });
    fs.mkdirSync(path.join(h.state, 'homes', 'worker-group-reused'), { recursive: true });
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'spawn', agent: 'owner', task: 'T2',
      detail: { agent: 'worker-group-reused', role: 'worker', pid: later.pid, host: require('node:os').hostname(), start_ticks: '1',
        run_mark: `TOWERCRANE_SPAWN_RUN_${process.pid}_00000000reused` },
    }) + '\n');
  }
  // A harness that exited after starting a process in a session of its own (setsid): its group is
  // empty, and only the launch's marker, which the process inherited, names it as the agent's.
  // Only Linux reads another process's environment.
  const marked = process.platform === 'linux';
  let leftBehind = null;
  if (marked) {
    const mark = `TOWERCRANE_SPAWN_RUN_${process.pid}_0123456789ab`;
    const leader = cp.spawn(process.execPath, ['-e',
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' }); process.stdout.write(c.pid + '\\n', () => process.exit(0))"], // wait-allow: the session leader only idles until the test kills it
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, [mark]: '1' } });
    const line = await firstOutput(leader);
    const left = Number(String(line).trim());
    assert.ok(left > 0, 'the harness left a process in a session of its own');
    leftBehind = left;
    t.after(() => { try { killGroup(left, 'SIGKILL'); } catch {} });
    if (leader.exitCode === null) await once(leader, 'exit');
    plant('worker-setsid-left', { socket });
    fs.mkdirSync(path.join(h.state, 'homes', 'worker-setsid-left'), { recursive: true });
    fs.writeFileSync(path.join(h.state, 'homes', 'worker-setsid-left', 'note'), 'the agent\'s');
    fs.appendFileSync(path.join(h.state, 'events.jsonl'), JSON.stringify({
      at: new Date().toISOString(), cmd: 'spawn', agent: 'owner', task: 'T2',
      detail: { agent: 'worker-setsid-left', role: 'worker', pid: leader.pid, host: require('node:os').hostname(), run_mark: mark },
    }) + '\n');
  }
  const kept = [...(grouped ? ['worker-group-left'] : []), ...(marked ? ['worker-setsid-left'] : [])];
  // Broker directories that closing renamed aside, holding what an agent wrote there.
  for (const agent of ['worker-orphan', 'worker-live-process', 'worker-live-claim', ...kept]) {
    fs.mkdirSync(path.join(stale(agent), 'sub'), { recursive: true });
    fs.writeFileSync(path.join(stale(agent), 'sub', 'f'), 'agent');
  }
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, `codex${process.platform === 'win32' ? '.exe' : ''}`), '', { mode: 0o755 });
  const environReads = path.join(h.base, 'environ-reads');
  const out = await h.runAsync(['spawn', '--task', 'T1', '--wait'], {
    env: { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1' },
    hooks: { HOOK_USAGE_HARNESS: 'codex', HOOK_USAGE_FILE: path.join(__dirname, 'fixtures', 'usage', 'codex-stream.jsonl'),
      HOOK_ENVIRON_READS: environReads },
  });
  assert.equal(out.code, 0, out.stderr);
  // worker-setsid-left and worker-group-reused both need the marker check; one pass over /proc answers both.
  if (marked && reused) {
    const reads = fs.readFileSync(environReads, 'utf8').trim().split('\n');
    assert.ok(reads.length > 0, 'the markers were read');
    assert.equal(new Set(reads).size, reads.length, 'no process\'s environment is read twice');
  }
  assert.equal(fs.existsSync(brokerDir('worker-orphan')), false, 'broker with no home, claim or process and a dead socket is swept');
  assert.equal(fs.existsSync(brokerDir('worker-orphan-tcp')), false, 'a dead TCP-only broker is swept');
  for (const agent of ['worker-live-claim', 'worker-live-process', 'worker-live-monitor', 'worker-unknown-process', 'worker-live-socket', 'worker-uncertain', ...kept]) {
    assert.ok(fs.existsSync(path.join(brokerDir(agent), 'broker.json')), `${agent} is kept`);
  }
  if (grouped) assert.ok(fs.existsSync(path.join(h.state, 'homes', 'worker-group-left', 'note')), 'a home whose group still runs is kept');
  if (marked) assert.ok(fs.existsSync(path.join(h.state, 'homes', 'worker-setsid-left', 'note')), 'a home whose marked process left the group is kept');
  // status names the home a stray keeps, which would otherwise stay without a word.
  const status = h.json(['status']);
  const strays = status.kept_homes.find((k) => k.agent === 'worker-setsid-left');
  if (marked) {
    assert.deepEqual(strays?.pids, [leftBehind], 'status names the process keeping the home');
    assert.match(h.ok(['status']), new RegExp(`^home kept: worker-setsid-left by a stray process ${leftBehind}$`, 'm'));
  } else assert.equal(strays, undefined);
  assert.equal(status.kept_homes.some((k) => k.agent === 'worker-group-left'), false, 'a home kept by its group is not a stray\'s');
  if (reused) {
    assert.equal(fs.existsSync(path.join(h.state, 'homes', 'worker-group-reused')), false, 'a home whose group pid was given out again is removed');
    assert.equal(fs.existsSync(brokerDir('worker-group-reused')), false, 'and so is its broker directory');
  }
  assert.equal(fs.existsSync(stale('worker-orphan')), false, 'a gone agent\'s broker directory set aside is removed');
  for (const agent of ['worker-live-process', 'worker-live-claim', ...kept]) {
    assert.ok(fs.existsSync(path.join(stale(agent), 'sub', 'f')), `${agent}'s broker directory set aside is kept`);
  }
});

for (const harness of ['claude', 'codex', 'opencode', 'agy', 'pi']) {
  test(`a ${harness} rung spawns with an arbitrary model ID`, (t) => {
    const h = setup(t);
    const model = `provider/new-model-${harness}-2099`;
    pinRung(h, 'medium', { harness, model, effort: 'high' });
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    const env = { PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''), USAGE_CLAIM: '1' };
    const captured = path.join(h.base, 'argv.json');
    const out = h.json(['spawn', '--task', 'T1', '--wait'], {
      env,
      hooks: { HOOK_USAGE_HARNESS: harness, HOOK_USAGE_ARGV: captured,
        HOOK_USAGE_FILE: path.join(__dirname, 'fixtures', 'usage', 'codex-stream.jsonl') },
    });
    assert.equal(out.code, 0);
    const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n')
      .map(JSON.parse).find(e => e.cmd === 'spawn');
    assert.equal(event.detail.harness, harness);
    assert.equal(event.detail.route.model, model);
    const flag = ['codex', 'opencode'].includes(harness) ? '-m' : '--model';
    const argv = JSON.parse(fs.readFileSync(captured, 'utf8'));
    assert.equal(argv[argv.indexOf(flag) + 1], model);
  });
}

test('design tasks dispatch without a kit on unsupported worker, review and small harnesses and report the omission', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--kind', 'design']);
  for (const harness of ['pi', 'opencode', 'command']) {
    for (const role of ['medium', 'review', 'small']) {
      setRung(h, role, harness === 'command'
        ? ['--harness', harness, '--command', JSON.stringify([process.execPath, '-e', 'process.exit(0)', '{prompt}'])]
        : ['--harness', harness, '--model', 'fixture']);
      const seen = dry(h, role);
      assert.deepEqual(seen.home.mcp, []);
      assert.deepEqual(seen.browser_kit.omitted, ['playwright']);
      assert.match(seen.browser_kit.warning, /browser kit.*without it/);
      assert.match(h.ok(['spawn', '--role', role, '--task', 'T1', '--dry-run']), /browser kit.*without it/);
    }
  }
  const started = h.json(['spawn', '--task', 'T1', '--wait']);
  assert.equal(started.code, 0);
  assert.match(started.browser_kit.warning, /command.*without it/);
  const recorded = h.readState('tasks.json');
  assert.equal(recorded.tasks[0].kind, 'design');
  const event = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.cmd === 'spawn');
  assert.deepEqual(event.detail.browser_kit, started.browser_kit);
});

test('explicit browser needs refuse only when no route can provide the kit', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--needs', '["browser"]']);
  commandRung(h, 'medium', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const missing = h.run(['spawn', '--task', 'T1', '--dry-run']);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /browser/);
  assert.equal(fs.existsSync(path.join(h.base, 'repo-worktrees')), false);
  const home = path.join(h.base, 'user');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'browser-server' } } }));
  fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
  fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { medium: { fallbacks: [{ harness: 'claude', model: 'fixture' }] } } }));
  const routed = h.json(['spawn', '--task', 'T1', '--dry-run'], {
    env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: '' },
  });
  assert.match(routed.browser_kit.warning, /command.*without it/);
});

test('design tasks with an unconfigured kit still dispatch on supported harnesses', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--kind', 'design']);
  const home = path.join(h.base, 'unconfigured-user');
  fs.mkdirSync(home);
  for (const harness of ['claude', 'codex']) {
    setRung(h, 'medium', ['--harness', harness, '--model', 'fixture']);
    const seen = h.json(['spawn', '--task', 'T1', '--dry-run'], {
      env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') },
    });
    assert.deepEqual(seen.home.mcp, []);
    assert.match(seen.browser_kit.warning, /playwright.*without it/);
  }
});

function writeSkill(plugin, name, body) {
  pluginRoot(plugin);
  const file = path.join(plugin, 'skills', name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: fixture frontmatter\n---\n${body}\n`);
}

function reviewable(h) {
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
}

test('worktree creates the task branch from base and is idempotent', (t) => {
  const h = setup(t);
  const first = h.json(['worktree', 'T1']);
  const expected = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(first.path), real(expected));
  assert.equal(first.branch, 'tower-crane/T1-idempotency-key-on-retries');
  assert.equal(first.created, true);
  assert.equal(h.git(['rev-parse', '--abbrev-ref', 'HEAD'], first.path), first.branch);
  assert.equal(h.git(['rev-parse', 'HEAD'], first.path), h.git(['rev-parse', 'main']));
  assert.equal(h.readState('tasks.json').tasks[0].branch, first.branch);

  h.ok(['task', 'update', 'T1', '--title', 'Renamed task']);
  const again = h.json(['worktree', 'T1']);
  assert.equal(again.created, false);
  assert.equal(real(again.path), real(first.path));
  assert.equal(h.ok(['worktree', 'T1']), again.path);
});

test('spawn --dry-run builds each harness command', (t) => {
  const h = setup(t);
  // claude and codex run the small rung under tower-crane-small.md, in a home of its own.
  const small = A.load('small');
  const claudeOwn = (state) => [
    '--setting-sources', 'user', '--permission-mode', 'acceptEdits', '--tools', 'Bash,Read,Grep,Glob', '--allowedTools', 'Bash,Read,Grep,Glob',
    '--disallowedTools', ...small.disallowedTools,
    '--strict-mcp-config', '--mcp-config', path.join(state, 'homes', 'small-T1-1', 'mcp.json'), '--disable-slash-commands',
  ];
  const codexOwn = () => [
    '-c', 'default_permissions="tower-crane"', '-c', 'approval_policy="never"', '-c', 'bypass_hook_trust=true', '-c', 'web_search="disabled"',
    ...small.codexDisable.flatMap((f) => ['--disable', f]),
  ];
  const piOwn = (state) => [
    '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--tools', 'bash,read,grep,find', '--append-system-prompt', path.join(state, 'homes', 'small-T1-1', 'AGENTS.md'),
    '--extension', path.join(state, 'homes', 'small-T1-1', 'hook.mjs'),
  ];
  const cases = [
    [['--harness', 'claude', '--model', 'fixture-large'], (p, s) => ['claude', '-p', p, '--model', 'fixture-large', '--output-format', 'json', ...claudeOwn(s)]],
    [['--harness', 'claude', '--model', 'fixture-large', '--effort', 'high'], (p, s) => ['claude', '-p', p, '--model', 'fixture-large', '--effort', 'high', '--output-format', 'json', ...claudeOwn(s)]],
    [['--harness', 'codex', '--profile', 'fixture-main'], (p, s) => ['codex', 'exec', '--json', '-p', 'fixture-main', ...codexOwn(s), p]],
    [['--harness', 'codex', '--model', 'fixture-model', '--effort', 'high', '--args', '["--skip-git-repo-check"]'], (p, s) => ['codex', 'exec', '--json', '-m', 'fixture-model', '-c', 'model_reasoning_effort=high', ...codexOwn(s), p, '--skip-git-repo-check']],
    [['--harness', 'opencode', '--model', 'provider/fixture-model'], (p) => ['opencode', 'run', '--format', 'json', '-m', 'provider/fixture-model', '--agent', 'gishra-small', p]],
    [['--harness', 'opencode', '--model', 'openai/fixture-model', '--effort', 'high'], (p) => ['opencode', 'run', '--format', 'json', '-m', 'openai/fixture-model', '--variant', 'high', '--agent', 'gishra-small', p]],
    [['--harness', 'agy', '--model', 'fixture-large'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--output-format', 'json', '--model', 'fixture-large', '--agent', 'gishra-small', '--disable-slash-commands', '--sandbox']],
    [['--harness', 'agy', '--model', 'fixture-large', '--effort', 'max', '--args', '["--print-timeout","60s"]'], (p) => ['agy', '-p', p, '--mode', 'accept-edits', '--output-format', 'json', '--model', 'fixture-large', '--effort', 'max', '--agent', 'gishra-small', '--disable-slash-commands', '--sandbox', '--print-timeout', '60s']],
    [['--harness', 'pi', '--model', 'provider/fixture-model'], (p, s) => ['pi', '-p', p, '--mode', 'json', '--model', 'provider/fixture-model', ...piOwn(s)]],
    [['--harness', 'pi', '--model', 'provider/fixture-model', '--provider', 'openai', '--effort', 'xhigh', '--args', '["--no-session"]'], (p, s) => ['pi', '-p', p, '--mode', 'json', '--model', 'provider/fixture-model', '--provider', 'openai', '--thinking', 'xhigh', ...piOwn(s), '--no-session']],
  ];
  const empty = path.join(h.base, 'no-plugin');
  pluginRoot(empty);
  for (const [flags, expected] of cases) {
    setRung(h, 'small', flags);
    const out = dry(h, 'small', { ...scopeEnv(h), TOWER_CRANE_PLUGIN_ROOT: empty });
    assert.equal(out.containment.backend, process.platform === 'linux' ? 'cgroup' : 'watchdog');
    const prompt = out.argv.find((a) => a.includes('## Task'));
    assert.ok(prompt, `prompt present for ${flags.join(' ')}`);
    const argv = expected(prompt, out.env.TOWER_CRANE_STATE);
    if (flags.includes('claude')) {
      assert.match(out.session_id, /^[a-f0-9-]{36}$/);
      if (out.argv.includes('--resume')) assert.equal(out.session_id, out.argv[out.argv.indexOf('--resume') + 1]);
      else argv.push('--session-id', out.session_id);
    }
    assert.deepEqual(harnessArgv(out.argv), argv, flags.join(' '));
  }
  const out = dry(h, 'small');
  assert.equal(out.agent, 'small-T1-1');
  assert.equal(out.rung, 'small');
  for (const key of ['TOWER_CRANE_AGENT', 'TOWER_CRANE_STATE', 'TOWER_CRANE_TASK', 'TOWER_CRANE_HOOK']) assert.ok(out.env[key], key);
  assert.equal(out.env.TOWER_CRANE_AGENT, 'small-T1-1');
  assert.equal(out.env.TOWER_CRANE_TASK, 'T1');
  assert.equal(real(out.env.TOWER_CRANE_STATE), real(h.state));
  assert.equal(out.worktree_exists, false);
  assert.ok(!fs.existsSync(path.join(h.base, 'repo-worktrees')), 'a dry run creates nothing');
});

test('opencode replaces caller inline config with the generated hook plugin', (t) => {
  const h = setup(t);
  setRung(h, 'small', ['--harness', 'opencode', '--model', 'provider/fixture-model']);
  const original = {
    model: 'provider/fixture-model',
    theme: 'tower-crane-test',
    agent: { build: { temperature: 0.2 } },
    plugin: ['file:///existing/plugin.mjs'],
  };
  const out = dry(h, 'small', { OPENCODE_CONFIG_CONTENT: JSON.stringify(original) });
  const config = JSON.parse(out.env.OPENCODE_CONFIG_CONTENT);
  const generated = pathToFileURL(path.join(h.state, 'homes', out.agent, 'hook.mjs')).href;
  assert.deepEqual(config, { plugin: [generated] });
});

test('spawn embeds the role skill in the system context for isolated reviewers and before the brief for other jobs', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  reviewable(h);
  const plugin = path.join(h.base, 'plugin');
  const bodies = {
    worker: 'WORKER_SKILL_BODY_SENTINEL\n\nFix the task in the worktree.',
    reviewer: 'REVIEWER_SKILL_BODY_SENTINEL\n\nReview the submitted change.',
  };
  writeSkill(plugin, 'tower-crane-work', bodies.worker);
  writeSkill(plugin, 'tower-crane-review', bodies.reviewer);
  const cases = [
    ['claude', 'fixture-large'],
    ['codex', 'fixture-model'],
    ['opencode', 'provider/fixture-model'],
    ['agy', 'fixture-large'],
  ];
  const env = { TOWER_CRANE_PLUGIN_ROOT: plugin };

  for (const [harness, model] of cases) {
    for (const [rung, job, other] of [
      ['easy', 'worker', 'reviewer'],
      ['review', 'reviewer', 'worker'],
    ]) {
      setRung(h, rung, ['--harness', harness, '--model', model]);
      const out = dry(h, rung, env);
      const user = out.argv.find((arg) => arg.includes('## Task'));
      if (job === 'reviewer' && harness === 'codex') {
        assert.ok(!user.includes(bodies[job]));
        assert.ok(out.startup.system_bytes > bodies[job].length);
        continue;
      }
      const prompt = job === 'reviewer' && harness === 'claude'
        ? out.system : user;
      assert.ok(prompt.includes(bodies[job]), `${harness} ${job} has its skill body`);
      assert.ok(!prompt.includes(bodies[other]), `${harness} ${job} excludes the other role's skill`);
      assert.ok(!prompt.includes(`name: tower-crane-${job === 'worker' ? 'work' : 'review'}`));
      assert.ok(!prompt.includes('description: fixture frontmatter'), 'skill frontmatter is omitted');
      const context = job === 'worker' ? 'start from the webhook handler' : 'Review T1 at';
      if (prompt === user) assert.ok(prompt.indexOf(bodies[job]) < prompt.indexOf(context), 'the role skill comes before the task context');
      else assert.ok(!user.includes(bodies[job]), 'the user message holds only task context');
    }
  }
});

test('spawn warns when a role SKILL.md is missing', (t) => {
  const h = setup(t);
  const plugin = pluginRoot(path.join(h.base, 'incomplete-plugin'));
  fs.mkdirSync(path.join(plugin, 'skills', 'tower-crane-work'), { recursive: true });
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);

  const result = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--dry-run', '--json'], {
    env: { TOWER_CRANE_PLUGIN_ROOT: plugin },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /SKILL\.md.*missing/i);
  assert.equal((result.stderr.match(/SKILL\.md/gi) || []).length, 1, 'one warning per spawn');
  const output = JSON.parse(result.stdout);
  const prompt = output.argv.find((arg) => arg.includes('## Task'));
  assert.ok(!prompt.includes('Role instructions'));
});

test('spawn gives workers shared brief text and reviewers only their review section', (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: [
      'SHARED_PREAMBLE_SENTINEL',
      '```md',
      '## Reviewer',
      'FENCED_REVIEWER_SENTINEL',
      '## Worker',
      'FENCED_WORKER_SENTINEL',
      '```',
      '## Shared',
      'SHARED_SECTION_SENTINEL',
      '## wOrKeR',
      'WORKER_BRIEF_SENTINEL',
      '## rEvIeWeR',
      'REVIEWER_BRIEF_SENTINEL',
    ].join('\n'),
  });

  const worker = dry(h, 'medium').argv.find((arg) => arg.includes('## Task'));
  assert.ok(worker.includes('SHARED_PREAMBLE_SENTINEL'));
  assert.ok(worker.includes('FENCED_REVIEWER_SENTINEL'));
  assert.ok(worker.includes('FENCED_WORKER_SENTINEL'));
  assert.ok(worker.includes('SHARED_SECTION_SENTINEL'));
  assert.ok(worker.includes('WORKER_BRIEF_SENTINEL'));
  assert.ok(!worker.includes('REVIEWER_BRIEF_SENTINEL'));

  reviewable(h);
  const reviewer = dry(h, 'review').argv.find((arg) => arg.includes('## Task'));
  assert.ok(!reviewer.includes('SHARED_PREAMBLE_SENTINEL'));
  assert.ok(!reviewer.includes('FENCED_REVIEWER_SENTINEL'));
  assert.ok(!reviewer.includes('FENCED_WORKER_SENTINEL'));
  assert.ok(!reviewer.includes('SHARED_SECTION_SENTINEL'));
  assert.ok(reviewer.includes('REVIEWER_BRIEF_SENTINEL'));
  assert.ok(!reviewer.includes('WORKER_BRIEF_SENTINEL'));
});

test('the prompt is the role skill, brief, task, then how to use tower-crane', (t) => {
  const h = setup(t);
  h.ok(['task', 'update', 'T1', '--lock', 'lab/rdma', '--environment', 'lab']);
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);
  const p = dry(h).argv.find((a) => a.includes('## Task'));
  assert.ok(p.startsWith('## Role instructions: tower-crane-work'));
  const iSkill = p.indexOf('# Tower Crane: work one task');
  const iBrief = p.indexOf('start from the webhook handler');
  const iTask = p.indexOf('"acceptance": [');
  const iUse = p.indexOf('Use the tower-crane CLI for every state change');
  assert.ok(iSkill < iBrief && iBrief < iTask && iTask < iUse, 'role skill, brief, task JSON, instruction in order');
  const json = JSON.parse(p.slice(p.indexOf('```json\n') + 8, p.indexOf('\n```', p.indexOf('```json'))));
  assert.deepEqual(json, { id: 'T1', title: 'Idempotency key on retries', acceptance: ['processed once', 'test proves it'], kind: 'code', needs: [], locks: ['lab/rdma'], environment: 'lab' });
  assert.match(p, /TOWER_CRANE_STATE, TOWER_CRANE_TASK and TOWER_CRANE_AGENT are set/);
  assert.ok(p.includes('you are not the owner; never pass --agent owner'));
  assert.ok(p.endsWith("run tower-crane with --agent worker-T1-1 if TOWER_CRANE_AGENT is missing. After submit you own T1's PR until it is green: stay in this session, run tower-crane wait --own --task T1 --timeout 540, fix what it hands back, submit again and wait again, and exit only when it says your ownership ended."));
});

test('prompts name role skills in the state directory\'s skill store, since a user worktree has no skills directory', (t) => {
  const h = setup(t);
  setRung(h, 'medium', ['--harness', 'opencode', '--model', 'a/b']);
  const store = A.skillStore({}, h.state).dir;
  const prompt = (rung) => dry(h, rung).argv.find((arg) => arg.includes('## Task'));
  const relative = /(?<![\\/\w.-])skills[\\/]tower-crane-(?:work|review)[\\/]SKILL\.md/;
  const packaged = (text, skill) => {
    const named = new RegExp(`Follow the ${skill} skill \\((.+?SKILL\\.md)\\)`).exec(text);
    assert.ok(named, `${skill} is named`);
    assert.equal(named[1], path.join(store, skill, 'SKILL.md'), 'the copy in the state directory, which the spawn makes');
  };
  assert.doesNotMatch(prompt('medium'), relative, 'the embedded work skill points at no worktree path');

  reviewable(h);
  const review = prompt('review');
  assert.doesNotMatch(review, relative);
  packaged(review, 'tower-crane-review');

  h.ok(['rework', 'T1', '--reason', 'Next round']);
  const rework = prompt('medium');
  assert.doesNotMatch(rework, relative);
  packaged(rework, 'tower-crane-work');
});

// Windows refuses the rename of a freshly copied tree for a moment while a
// scanner holds its files (CI run 38702275511), which failed the agent's start.
test('spawn waits out a refused rename of the skill store it just copied', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'ran.txt');
  commandRung(h, 'medium', [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', out]);
  const store = A.skillStore({}, h.state).dir;
  const r = h.run(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_BUSY_RENAME: `^${path.basename(store)}$` } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'ran');
  assert.ok(fs.existsSync(path.join(store, 'tower-crane-work', 'SKILL.md')));
  assert.deepEqual(fs.readdirSync(path.dirname(store)).sort(), ['.gitignore', path.basename(store)], 'the temporary copy is gone');
});

// Windows refuses a rename onto an existing directory, so the loser of a race
// to publish the store sees EPERM; the store is there, so it stops at once.
test('spawn takes a skill store another dispatch published first without waiting on its own rename', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'ran.txt');
  commandRung(h, 'medium', [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', out]);
  const store = A.skillStore({}, h.state).dir;
  const refusals = path.join(h.base, 'refusals.txt');
  const r = h.run(['spawn', '--task', 'T1', '--wait'], {
    hooks: { HOOK_BUSY_RENAME: `^${path.basename(store)}$`, HOOK_BUSY_RENAME_TIMES: '0', HOOK_BUSY_RENAME_PUBLISHED: '1', HOOK_BUSY_RENAME_LOG: refusals },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'ran');
  assert.equal(fs.readFileSync(refusals, 'utf8'), `${store}\n`, 'one refused rename, no retries');
  assert.ok(fs.existsSync(path.join(store, 'tower-crane-work', 'SKILL.md')));
  assert.deepEqual(fs.readdirSync(path.dirname(store)).sort(), ['.gitignore', path.basename(store)], 'the temporary copy is gone');
});

test('a prompt that names a role skill warns when the plugin root lacks it', (t) => {
  const h = setup(t);
  // A command rung neither embeds nor loads the skill, so only the named path can warn.
  commandRung(h, 'medium', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  reviewable(h);
  h.ok(['rework', 'T1', '--reason', 'Next round']);
  const plugin = path.join(h.base, 'no-work-skill');
  writeSkill(plugin, 'tower-crane-review', 'review body');
  const result = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--dry-run', '--json'], {
    env: { TOWER_CRANE_PLUGIN_ROOT: plugin },
  });
  assert.equal(result.code, 0, result.stderr);
  const missing = path.join(plugin, 'skills', 'tower-crane-work', 'SKILL.md');
  assert.ok(JSON.parse(result.stdout).argv.some((arg) => arg.includes('Follow the tower-crane-work skill and submit')), 'the prompt names the skill without a path that would not exist');
  assert.ok(result.stderr.includes(`role skill ${missing} is missing`), result.stderr);
});

test('without an embedded skill the goal leads the prompt, so a brief opening with a dash is never read as a flag', (t) => {
  const h = setup(t);
  setRung(h, 'small', ['--harness', 'opencode', '--model', 'a/b']);
  const prompt = dry(h, 'small').argv.find((arg) => arg.includes('## Task'));
  assert.ok(prompt.startsWith('## Goal\n\nProject goal: prove the engine\nTask target: T1, "Idempotency key on retries"'));
  assert.ok(prompt.includes('\n\n- start from the webhook handler\n'));
});

test('a spawned reviewer that loses all TOWER_CRANE variables cannot record evidence as owner', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'lost-agent.json');
  const script = `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});

const fs = require('node:fs');
const cp = require('node:child_process');
const env = { ...process.env };
const agent = env.TOWER_CRANE_AGENT;
const task = env.TOWER_CRANE_TASK;
const state = env.TOWER_CRANE_STATE;
for (const key of Object.keys(env)) if (key.startsWith('TOWER_CRANE_')) delete env[key];
const r = cp.spawnSync(process.execPath, [process.argv[1], 'evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--state', state], {
  env: fakeAgentEnv(env), encoding: 'utf8', timeout: 300000,
});
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('TOWER_CRANE_')), code: r.status, stderr: r.stderr }));
process.exit(r.status === null ? 1 : r.status);
`;
  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, BIN, out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 2, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen, {
    agent: 'reviewer-T1-1',
    task: 'T1',
    remaining: [],
    code: 2,
    stderr: 'tower-crane: no agent: pass --agent NAME or set TOWER_CRANE_AGENT\n',
  });
  assert.deepEqual(h.readState('tasks.json').tasks[0].evidence, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'evidence'));
});

test('a spawned reviewer losing all TOWER_CRANE variables in a terminal cannot clear owner work', { skip: !PTY_AVAILABLE }, (t) => {
  const h = setup(t);
  h.ok(['task', 'add', '--title', 'Owner action', '--acceptance', 'approved', '--needs-owner', 'approve access']);
  const out = path.join(h.base, 'lost-agent-terminal.json');
  const script = `
const fs = require('node:fs');
const { runPty } = require(process.argv[1]);
const env = { ...process.env };
const agent = env.TOWER_CRANE_AGENT;
const task = env.TOWER_CRANE_TASK;
const state = env.TOWER_CRANE_STATE;
for (const key of Object.keys(env)) if (key.startsWith('TOWER_CRANE_')) delete env[key];
const r = runPty(['owner-done', 'T2', '--state', state], { cwd: process.cwd(), env });
fs.writeFileSync(process.argv[2], JSON.stringify({ agent, task, remaining: Object.keys(env).filter((key) => key.startsWith('TOWER_CRANE_')), ...r }));
process.exit(r.code === null ? 99 : r.code);
`;
  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, require.resolve('./helpers'), out]);
  const r = h.run(['spawn', '--role', 'review', '--task', 'T1', '--wait']);
  assert.equal(r.code, 1, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.agent, 'reviewer-T1-1');
  assert.equal(seen.task, 'T1');
  assert.deepEqual(seen.remaining, []);
  assert.equal(seen.code, 1, seen.stdout + seen.stderr);
  assert.match(seen.stdout, /only the orchestrator or the owner/);
  const task = h.readState('tasks.json').tasks[1];
  assert.equal(task.needs_owner, 'approve access');
  assert.deepEqual(task.notes, []);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.cmd === 'owner-done'));
});

test('pi rungs load the tower-crane skill for workers and reviewers when it is installed', (t) => {
  const h = setup(t);
  const plugin = path.join(h.base, 'plugin');
  writeSkill(plugin, 'tower-crane-work', 'PI_WORK_SKILL_MUST_NOT_BE_EMBEDDED');
  writeSkill(plugin, 'tower-crane-review', 'PI_REVIEW_SKILL_MUST_NOT_BE_EMBEDDED');
  const env = { TOWER_CRANE_PLUGIN_ROOT: plugin };
  for (const rung of ['easy', 'medium', 'review', 'small']) setRung(h, rung, ['--model', 'm']);
  h.ok(['ladder', 'harness', 'pi']);
  const at = (argv) => argv.slice(argv.indexOf('--skill'), argv.indexOf('--skill') + 2);
  // The copy in the state directory's skill store, which the spawn makes from the plugin root.
  const own = (out, skill) => ['--skill', path.join(A.skillStore(env, h.state).dir, skill)];
  const workerOut = dry(h, 'medium', env);
  const reviewerOut = dry(h, 'review', env);
  const easyOut = dry(h, 'easy', env);
  const worker = workerOut.argv;
  const reviewer = reviewerOut.argv;
  assert.deepEqual(at(worker), own(workerOut, 'tower-crane-work'));
  assert.deepEqual(at(easyOut.argv), own(easyOut, 'tower-crane-work'));
  assert.deepEqual(at(reviewer), own(reviewerOut, 'tower-crane-review'));
  assert.ok(!worker.find((arg) => arg.includes('## Task')).includes('PI_WORK_SKILL_MUST_NOT_BE_EMBEDDED'));
  assert.ok(!reviewer.find((arg) => arg.includes('## Task')).includes('PI_REVIEW_SKILL_MUST_NOT_BE_EMBEDDED'));
  assert.ok(!dry(h, 'small', env).argv.includes('--skill'), 'other rungs get no skill');
  const missing = path.join(h.base, 'empty-plugin');
  pluginRoot(missing);
  assert.ok(!dry(h, 'medium', { TOWER_CRANE_PLUGIN_ROOT: missing }).argv.includes('--skill'), 'no skill when it is not installed');

  const incomplete = pluginRoot(path.join(h.base, 'incomplete-plugin'));
  fs.mkdirSync(path.join(incomplete, 'skills', 'tower-crane-work'), { recursive: true });
  const warning = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--dry-run', '--json'], {
    env: { TOWER_CRANE_PLUGIN_ROOT: incomplete },
  });
  assert.equal(warning.code, 0, warning.stderr);
  assert.match(warning.stderr, /SKILL\.md.*missing/i);
  assert.ok(!JSON.parse(warning.stdout).argv.includes('--skill'));
});

test('spawn --wait runs the command rung in the task worktree with the tower-crane environment', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'seen.json');
  const script = 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), task: process.argv[2], brief: process.argv[3], briefText: fs.readFileSync(process.argv[3], "utf8"), cwdArg: process.argv[4], prompt: process.argv[5], env: { s: process.env.TOWER_CRANE_STATE, t: process.env.TOWER_CRANE_TASK, a: process.env.TOWER_CRANE_AGENT } })); process.exit(7)';
  commandRung(h, 'medium', [process.execPath, '-e', script, out, '{task}', '{brief}', '{cwd}', 'P:{prompt}']);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  fs.mkdirSync(tempRoot);
  const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: { TOWER_CRANE_TMP: tempRoot } });
  assert.equal(r.code, 7, r.stderr);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  const wt = path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');
  assert.equal(real(seen.cwd), real(wt));
  assert.equal(real(seen.cwdArg), real(wt));
  assert.equal(seen.task, 'T1');
  assert.notEqual(path.resolve(seen.brief), path.resolve(path.join(h.state, 'briefs', 'T1.md')));
  assert.match(seen.briefText, /^## Goal\n[\s\S]*\n- start from the webhook handler\n\nTask scratch: [^\n]+\n\n## Task\n/);
  const scratch = h.json(['task', 'show', 'T1']).scratch;
  assert.ok(seen.briefText.includes(scratch));
  assert.ok(seen.prompt.includes(scratch));
  assert.ok(!fs.existsSync(seen.brief), 'the temporary brief copy is removed after exit');
  assert.match(seen.prompt, /^P:## Goal\n[\s\S]*\n- start from the webhook handler/);
  assert.deepEqual([real(seen.env.s), seen.env.t, seen.env.a], [real(h.state), 'T1', 'worker-T1-1']);
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const spawnEv = events.find((e) => e.cmd === 'spawn');
  assert.equal(spawnEv.detail.agent, 'worker-T1-1');
  assert.equal(spawnEv.detail.rung, 'medium');
  assert.ok(Number.isInteger(spawnEv.detail.pid));
  assert.equal(events.find((e) => e.cmd === 'spawn exit').detail.code, 7);
});

test('a spawned agent never inherits the owner key that admitted its spawn', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'agent-env.json');
  commandRung(h, 'medium', [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)))`]);
  assert.ok(h.env.TOWER_CRANE_OWNER_KEY);
  h.ok(['spawn', '--task', 'T1', '--wait']);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(seen.includes('TOWER_CRANE_AGENT'));
  assert.ok(!seen.includes('TOWER_CRANE_OWNER_KEY'));
});

test('spawn removes outer Node test runner variables so an agent can run its own test suite', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'nested-run.json');
  const marker = path.join(h.base, 'nested-test-ran');
  const file = path.join(h.repo, 'nested.test.js');
  fs.writeFileSync(file, `
const test = require('node:test');
test('the agent runs a real nested test', () => {
  require('node:assert/strict').equal(process.env.NESTED_KEEP, 'kept');
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
});
`);
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'nested runner fixture']);
  const script = `
const cp = require('node:child_process');
const result = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', ${JSON.stringify(file)}], { encoding: 'utf8', timeout: 300000 });
require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  runnerEnv: Object.keys(process.env).filter((key) => /^NODE_TEST_/i.test(key)),
  code: result.status, stdout: result.stdout, stderr: result.stderr,
}));
`;
  commandRung(h, 'medium', [process.execPath, '-e', script]);
  h.ok(['project', 'set', '--env', '{"NODE_TEST_CONTEXT":"child-v8","NESTED_KEEP":"kept"}']);
  h.ok(['spawn', '--task', 'T1', '--wait'], {
    env: { NODE_TEST_WORKER_ID: 'outer-worker', NODE_TEST_REPORTER: 'outer-reporter', NODE_TEST_FUTURE: 'outer-value' },
  });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen.runnerEnv, []);
  assert.equal(seen.code, 0, seen.stderr);
  assert.equal(seen.stderr, '');
  assert.match(seen.stdout, /# pass 1\b/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
});

test('agents drop dispatcher Node injection variables and keep explicit rung values on retries and fallbacks', (t) => {
  const names = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_PRESERVE_SYMLINKS', 'NODE_PRESERVE_SYMLINKS_MAIN', 'NODE_COMPILE_CACHE'];
  for (const source of ['dispatcher', 'env', 'env_file', 'fallback_dispatcher', 'fallback_env']) {
    const h = setup(t);
    const out = path.join(h.base, 'agent-env.json');
    const marker = path.join(h.base, 'agent-preload-ran');
    const preload = path.join(h.base, 'preload.cjs');
    const fake = path.join(h.repo, 'fake-agent.cjs');
    fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(fake)}) {
  require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');
}
`);
    fs.writeFileSync(fake, `
const names = ${JSON.stringify(names)};
const fs = require('node:fs');
const { readPublished } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const file = ${JSON.stringify(out)};
const attempts = fs.existsSync(file) ? JSON.parse(readPublished(file, 'utf8')) : [];
attempts.push({
  injection: Object.fromEntries(Object.entries(process.env).filter(([key]) => names.includes(key.toUpperCase()))),
  keep: process.env.NODE_AGENT_KEEP,
});
fs.writeFileSync(file, JSON.stringify(attempts));
if (process.env.TOWER_CRANE_RETRY === '0' && !process.env.NODE_AGENT_FALLBACK) {
  console.error('API Error: 503 service unavailable');
  process.exit(1);
}
`);
    h.git(['add', '.']);
    h.git(['commit', '-qm', 'fake agent environment fixture']);
    commandRung(h, 'medium', [process.execPath, fake]);
    const fallback = source.startsWith('fallback_');
    h.ok(['ladder', 'set', 'medium', '--supervision', JSON.stringify({ retries: fallback ? 0 : 1, backoff_ms: 1 })]);
    const injection = {
      NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
      NODE_PATH: h.base,
      NODE_REPL_EXTERNAL_MODULE: preload,
      NODE_PRESERVE_SYMLINKS: '1',
      NODE_PRESERVE_SYMLINKS_MAIN: '1',
      NODE_COMPILE_CACHE: path.join(h.base, 'compile-cache'),
    };
    if (source === 'env') h.ok(['ladder', 'set', 'medium', '--env', JSON.stringify(injection)]);
    if (source === 'env_file') {
      const file = path.join(h.base, 'rung.env');
      fs.writeFileSync(file, Object.entries(injection).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
      h.ok(['ladder', 'set', 'medium', '--env_file', file]);
    }
    if (fallback) {
      h.ok(['ladder', 'set', 'medium', '--fallbacks', JSON.stringify([{
        harness: 'command', command: [process.execPath, fake, '{prompt}'],
        env: { NODE_AGENT_FALLBACK: '1', ...(source === 'fallback_env' ? injection : {}) },
      }])]);
    }
    h.ok(['spawn', '--task', 'T1', '--wait'], { env: { ...injection, NODE_AGENT_KEEP: 'kept' } });
    const attempts = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(attempts.length, 2, 'the initial launch and retry or fallback both ran');
    for (const [index, seen] of attempts.entries()) {
      assert.equal(seen.keep, 'kept', source);
      const explicit = source === 'env' || source === 'env_file' || (source === 'fallback_env' && index === 1);
      assert.deepEqual(seen.injection, explicit ? injection : {}, source);
    }
    assert.equal(fs.existsSync(marker), !['dispatcher', 'fallback_dispatcher'].includes(source), source);
  }
  const { cleanAgentEnv } = require('../lib/spawn-settings');
  for (const name of names) {
    assert.deepEqual(cleanAgentEnv({ [name]: 'injected', KEEP: 'kept' }), { KEEP: 'kept' });
    const lower = name.toLowerCase();
    assert.deepEqual(cleanAgentEnv({ [lower]: 'injected', KEEP: 'kept' }),
      process.platform === 'win32' ? { KEEP: 'kept' } : { [lower]: 'injected', KEEP: 'kept' });
  }
});

test('command brief copies default to the user cache and keep explicit temp overrides', (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'brief-location.json');
  commandRung(h, 'medium', [process.execPath, '-e',
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ file: process.argv[2], text: require('node:fs').readFileSync(process.argv[2], 'utf8') }))",
    out, '{brief}']);
  const cache = process.platform === 'win32'
    ? path.join(h.env.HOME, 'AppData', 'Local')
    : path.join(h.env.HOME, '.cache');
  const env = { USERPROFILE: h.env.HOME, XDG_CACHE_HOME: '', LOCALAPPDATA: '', TOWER_CRANE_TMP: '', TOWER_CRANE_TEST_TMP: '' };
  const expected = path.join(cache, 'tower-crane');
  const planned = dry(h, 'medium', env);
  const file = planned.argv.find((arg) => arg.endsWith('-brief.md'));
  assert.equal(path.dirname(file), expected);
  assert.equal(fs.existsSync(file), false, 'dry-run does not create a brief');
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(path.dirname(seen.file), expected);
  assert.match(seen.text, /webhook handler/);
  assert.equal(fs.existsSync(seen.file), false, 'the cache brief is removed after the command exits');
  for (const overrides of [
    { TOWER_CRANE_TEST_TMP: path.join(h.base, 'test-tmp') },
    { TOWER_CRANE_TEST_TMP: path.join(h.base, 'test-tmp'), TOWER_CRANE_TMP: path.join(h.base, 'spawn-tmp') },
  ]) {
    const next = dry(h, 'medium', { ...env, ...overrides }).argv.find((arg) => arg.endsWith('-brief.md'));
    assert.equal(path.dirname(next), overrides.TOWER_CRANE_TMP || overrides.TOWER_CRANE_TEST_TMP);
  }
});

test('command brief placeholders point to role-filtered temporary copies', async (t) => {
  const h = setup(t);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: [
      'SHARED_FOR_COMMANDS',
      '## Worker',
      'WORKER_ONLY_COMMAND',
      '## Reviewer',
      'REVIEWER_ONLY_COMMAND',
      '## Rework notes',
      'REWORK_SHARED_COMMAND',
    ].join('\n'),
  });
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  fs.mkdirSync(tempRoot);
  const workerOut = path.join(h.base, 'worker-brief.json');
  const reviewerOut = path.join(h.base, 'reviewer-brief.json');
  const cleanupOut = path.join(h.base, 'brief-cleanup.jsonl');
  const hook = path.join(h.base, 'brief-cleanup.js');
  fs.writeFileSync(hook, `
// Record the unlink boundary before the supervisor finishes its exit path.
const fs = require('node:fs');
const rm = fs.rmSync;
fs.rmSync = function(file, ...args) {
  const result = rm.call(this, file, ...args);
  if (String(file).startsWith(${JSON.stringify(tempRoot + path.sep)} + 'tower-crane-brief-') && String(file).endsWith('brief.md')) {
    fs.appendFileSync(${JSON.stringify(cleanupOut)}, JSON.stringify(fs.readdirSync(${JSON.stringify(tempRoot)})) + '\\n');
  }
  return result;
};
`);
  const env = { TOWER_CRANE_TMP: tempRoot, NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` };
  const script = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], JSON.stringify({ path: process.argv[2], text: fs.readFileSync(process.argv[2], 'utf8') }));
process.once('SIGTERM', () => process.exit(0));
setImmediate(() => process.platform === 'win32' ? process.exit(0) : process.kill(process.pid, 'SIGTERM'));
`;
  commandRung(h, 'medium', [process.execPath, '-e', script, workerOut, '{brief}']);
  commandRung(h, 'review', [process.execPath, '-e', script, reviewerOut, '{brief}']);

  const planned = dry(h, 'medium', { TOWER_CRANE_TMP: tempRoot });
  const dryCopy = planned.argv.find((arg) => arg.startsWith(tempRoot + path.sep) && arg.endsWith('brief.md'));
  assert.ok(dryCopy);
  assert.ok(dryCopy.startsWith(tempRoot + path.sep));
  assert.ok(!fs.existsSync(dryCopy), 'dry-run only prints the copy path');

  const worker = h.run(['spawn', '--role', 'medium', '--task', 'T1', '--wait'], { env });
  assert.equal(worker.code, 0, worker.stderr);
  const workerCopy = JSON.parse(fs.readFileSync(workerOut, 'utf8'));
  assert.match(workerCopy.text, /SHARED_FOR_COMMANDS/);
  assert.match(workerCopy.text, /WORKER_ONLY_COMMAND/);
  assert.match(workerCopy.text, /REWORK_SHARED_COMMAND/);
  assert.ok(!workerCopy.text.includes('REVIEWER_ONLY_COMMAND'));
  assert.ok(!fs.existsSync(workerCopy.path));

  // The supervised worker claimed the task, and its exit leaves that lease until released.
  h.ok(['release', 'T1', '--agent', 'worker-T1-1', '--reason', 'worker finished']);
  reviewable(h);
  commandRung(h, 'medium', [process.execPath, '-e', script, reviewerOut, '{brief}']);
  fs.writeFileSync(cleanupOut, '');
  const cleaned = fileWritten(cleanupOut, { signal: t.signal, check: (text) => text.includes('\n') });
  const reviewer = h.json(['spawn', '--role', 'review', '--task', 'T1'], { env });
  assert.equal(reviewer.agent, 'reviewer-T1-1');
  await cleaned;
  const reviewerCopy = JSON.parse(fs.readFileSync(reviewerOut, 'utf8'));
  assert.ok(!reviewerCopy.text.includes('SHARED_FOR_COMMANDS'));
  assert.match(reviewerCopy.text, /REVIEWER_ONLY_COMMAND/);
  assert.ok(!reviewerCopy.text.includes('REWORK_SHARED_COMMAND'));
  assert.ok(!reviewerCopy.text.includes('WORKER_ONLY_COMMAND'));
  assert.ok(!fs.existsSync(reviewerCopy.path));
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  const snapshots = fs.readFileSync(cleanupOut, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(snapshots.length > 0, 'cleanup reached the unlink boundary');
  for (const snapshot of snapshots) assert.deepEqual(snapshot, []);
});

test('temporary brief copies are removed before normal and signalled foreground exits return', (t) => {
  const h = setup(t);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  const out = path.join(h.base, 'brief-path');
  fs.mkdirSync(tempRoot);
  h.ok(['ladder', 'set', 'medium', '--supervision', '{"retries":0}']);
  for (const [exit, code] of [
    ['process.exit(0)', 0],
    ['process.exit(7)', 7],
    ['setImmediate(() => process.kill(process.pid, "SIGTERM"))', 1],
  ]) {
    const script = `require('node:fs').writeFileSync(process.argv[1], process.argv[2]); ${exit};`;
    commandRung(h, 'medium', [process.execPath, '-e', script, out, '{brief}']);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { env: { TOWER_CRANE_TMP: tempRoot } });
    assert.equal(result.code, code, result.stderr);
    assert.ok(!fs.existsSync(fs.readFileSync(out, 'utf8')));
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    // The supervised worker's lease outlives its exit until it is released.
    const claim = h.json(['task', 'show', 'T1']).claim;
    if (claim) h.ok(['release', 'T1', '--agent', claim.agent, '--reason', 'worker finished']);
  }
});

test('temporary brief copies are removed before spawn startup failure returns', (t) => {
  const h = setup(t);
  const tempRoot = path.join(h.base, 'tower-crane-tmp');
  const hook = path.join(h.base, 'brief-launch-failure.js');
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(hook, `
if (process.argv[1].endsWith('spawn-monitor.js')) {
  const cp = require('node:child_process');
  const spawn = cp.spawn;
  cp.spawn = function(file, args, opts) {
    return spawn.call(this, ${JSON.stringify(path.join(h.base, 'missing-harness'))}, args, opts);
  };
}
`);
  commandRung(h, 'medium', [process.execPath, '-e', 'process.exit(0)', '{brief}']);
  for (const flags of [[], ['--wait']]) {
    const result = h.run(['spawn', '--task', 'T1', ...flags], {
      env: { TOWER_CRANE_TMP: tempRoot, NODE_OPTIONS: `--require "${hook.replace(/\\/g, '/')}"` },
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /could not start.*ENOENT/);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  }
  const dispatch = h.run(['spawn', '--task', 'T1'], {
    env: { TOWER_CRANE_TMP: tempRoot }, hooks: { HOOK_SPAWN_FAIL: '1' },
  });
  assert.notEqual(dispatch.code, 0);
  assert.match(dispatch.stderr, /supervisor startup failed/);
  assert.deepEqual(fs.readdirSync(tempRoot), []);
});

// A plain file there is a failed start's log, which the spawn moves aside
// (spawn-startup.test.js); a link or a directory is not.
test('background spawn refuses a log name held by a link or a directory without writing or recording a spawn', (t) => {
  for (const linked of [false, true]) {
    const h = setup(t);
    commandRung(h, 'small', [process.execPath, '-e', 'console.log("agent output")']);
    const logs = path.join(h.state, 'logs');
    fs.mkdirSync(logs);
    const log = path.join(logs, 'T1-small-T1-1.log');
    const target = path.join(h.base, 'unrelated-file');
    fs.writeFileSync(target, 'preserve this file\n');
    if (linked) {
      try {
        fs.symlinkSync(target, log);
      } catch (e) {
        if (process.platform === 'win32' && e.code === 'EPERM') continue;
        throw e;
      }
    } else {
      fs.mkdirSync(log);
      fs.writeFileSync(path.join(log, 'kept'), 'preserve this log\n');
    }
    const tasks = fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    const result = h.run(['spawn', '--role', 'small', '--task', 'T1', '--json']);
    assert.notEqual(result.code, 0, result.stdout);
    assert.match(result.stderr, /log already exists/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve this file\n');
    assert.equal(fs.readFileSync(linked ? log : path.join(log, 'kept'), 'utf8'), linked ? 'preserve this file\n' : 'preserve this log\n');
    assert.equal(fs.readFileSync(path.join(h.state, 'tasks.json'), 'utf8'), tasks);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
  }
});

test('spawn in the background detaches, logs output and numbers agents', async (t) => {
  const h = setup(t);
  // The harness prints the launch marker it was given, which the spawn event must name.
  commandRung(h, 'small', [process.execPath, '-e',
    'console.log("hello from " + process.env.TOWER_CRANE_AGENT + " marked " + Object.keys(process.env).filter((k) => k.startsWith("TOWERCRANE_SPAWN_RUN_")).join(","))']);
  const started = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  assert.equal(started.agent, 'small-T1-1');
  assert.ok(Number.isInteger(started.pid));
  assert.equal(real(path.dirname(started.log)), real(path.join(h.state, 'logs')));
  assert.equal(path.basename(started.log), 'T1-small-T1-1.log');
  if (process.platform !== 'win32') assert.equal(fs.statSync(started.log).mode & 0o777, 0o600);
  await waitOnRepo(h, () => (fs.existsSync(started.log) && readPublished(started.log, 'utf8').includes('hello')));
  assert.match(fs.readFileSync(started.log, 'utf8'), /hello from small-T1-1/);
  const marker = /marked (\S*)/.exec(fs.readFileSync(started.log, 'utf8'))[1];
  const spawned = S.readEvents(h.state).find((e) => e.cmd === 'spawn' && e.detail.agent === 'small-T1-1');
  if (process.platform === 'win32') assert.equal(spawned.detail.run_mark, undefined);
  else {
    assert.match(marker, /^TOWERCRANE_SPAWN_RUN_\d+_[0-9a-f]{12}$/, 'the harness carries one launch marker');
    assert.equal(spawned.detail.run_mark, marker, 'the spawn event records the marker the harness carries');
  }
  assert.equal(h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run']).agent, 'small-T1-2');

  reviewable(h);
  commandRung(h, 'medium', ['tower-crane-no-such-program']);
  const missing = h.run(['spawn', '--role', 'review', '--task', 'T1']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /could not start tower-crane-no-such-program/);
  h.ok(['task', 'add', '--title', 'No brief', '--acceptance', 'x']);
  const noBrief = h.run(['spawn', '--role', 'small', '--task', 'T2', '--dry-run']);
  assert.equal(noBrief.code, 1);
  assert.match(noBrief.stderr, /T2 has no brief; write one with tower-crane brief set T2/);
});

// An agent's git runs through its shim, which cleans up placeholders in the
// git directory first; stopping the agent kills its process group, shim
// included. A supervisor runs its own git through the agent's shims before it
// reports its start, so a directory the killed shim left held made every
// later supervisor miss its startup window.
test('a git shim killed while it cleans up placeholders does not keep the next supervisor from starting', (t) => {
  const h = setup(t);
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  // An empty process table lets the shim take the directory where there is no /proc.
  const table = fs.mkdtempSync(path.join(h.base, 'proc-'));
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  // On the host, and inside an agent's command sandbox, which has a pid namespace of its own.
  for (const [attempt, hooks] of [[1, {}], [2, { HOOK_PIDNS: 'pid:[4026599999]' }]]) {
    cp.spawnSync(process.execPath, ['--require', HOOKS, path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'status'],
      { cwd: h.repo, env: { ...h.env, TOWER_CRANE_PROC: table, HOOK_STATE: h.state, HOOK_DIE_REAP: '1', ...hooks } });
    assert.equal(fs.existsSync(path.join(h.repo, '.git', 'tower-crane-reap')), true, 'the killed shim held the directory');
    const started = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).agent, `small-T1-${attempt}`);
  }
});

// Only a cleanup outside every command sandbox judges a marker from a
// sandbox's pid namespace. A stopped sandboxed agent's shim leaves one, and
// until a host cleanup ran, every git call of every other sandboxed agent
// waited 5 s on it. The supervisor is on the host when its agent's group ends.
test('a supervisor clears the git directory a git shim in its agent\'s sandbox died holding', { skip: process.platform !== 'linux' && 'pid namespaces are Linux only' }, (t) => {
  const h = setup(t);
  for (const mark of ['TOWER_CRANE_SANDBOX', 'SANDBOX_RUNTIME', 'CODEX_SANDBOX']) delete h.env[mark];
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  // The agent is a git call through its shim, killed once it holds the directory.
  commandRung(h, 'small', ['env', 'HOOK_DIE_REAP=1', 'HOOK_PIDNS=pid:[4026599999]', 'TOWER_CRANE_SANDBOX=1', `HOOK_STATE=${h.state}`,
    process.execPath, '--require', HOOKS, path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'status', '--short', '{prompt}']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  assert.notEqual(r.code, 0, 'the agent was killed');
  const dir = path.join(h.repo, '.git', 'tower-crane-reap');
  const marker = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(marker, [], marker.length ? fs.readFileSync(path.join(dir, marker[0]), 'utf8') : '');
  assert.equal(fs.existsSync(dir), false);
});

// claude's command sandbox runs in a session of its own, so a shim in it is
// outside the agent's process group and dies only when the sandbox is torn
// down after the group ends. The supervisor tries again while that lags.
test('a supervisor clears the git directory a git shim held a moment past its agent\'s group', { skip: process.platform !== 'linux' && 'needs /proc to judge the holder' }, (t) => {
  const h = setup(t);
  for (const mark of ['TOWER_CRANE_SANDBOX', 'SANDBOX_RUNTIME', 'CODEX_SANDBOX']) delete h.env[mark];
  const policy = path.join(h.base, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ gitPush: 'branch', branch: 'task-T1', repo: null, gh: [] }));
  const shimDir = path.join(h.base, 'shim');
  fs.mkdirSync(shimDir);
  const dir = path.join(h.repo, '.git', 'tower-crane-reap');
  // The agent starts the shim in a session of its own and exits once the shim
  // holds the directory; the shim holds it 400 ms longer, then is killed.
  const agent = path.join(h.base, 'agent.js');
  fs.writeFileSync(agent, `
const cp = require('node:child_process'), fs = require('node:fs');
const shim = cp.spawn(process.execPath, ${JSON.stringify(['--require', HOOKS, path.join(ROOT, 'lib', 'shim.js'), policy, shimDir, 'git', 'status', '--short'])},
  { detached: true, stdio: 'ignore', env: { ...process.env, HOOK_DIE_REAP: '1', HOOK_DIE_REAP_AFTER: '400', HOOK_STATE: ${JSON.stringify(h.state)} } });
shim.unref();
const end = Date.now() + 300000;
while (!fs.existsSync(${JSON.stringify(dir)}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
`);
  commandRung(h, 'small', [process.execPath, agent, '{prompt}']);
  h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json']);
  const marker = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(marker, [], marker.length ? fs.readFileSync(path.join(dir, marker[0]), 'utf8') : '');
  assert.equal(fs.existsSync(dir), false);
});

// Everything a spawn could leave behind: state files, events, logs, the
// worktree and its branch.
function footprint(h) {
  const read = (f) => (fs.existsSync(path.join(h.state, f)) ? readPublished(path.join(h.state, f), 'utf8') : null);
  return {
    tasks: read('tasks.json'),
    events: read('events.jsonl'),
    logs: fs.existsSync(path.join(h.state, 'logs')) ? fs.readdirSync(path.join(h.state, 'logs')) : null,
    worktrees: fs.existsSync(path.join(h.base, 'repo-worktrees')),
    branches: h.git(['branch', '--list', 'tower-crane/*']),
  };
}

test('a spawn refused for a missing program creates and writes nothing', (t) => {
  const h = setup(t);
  for (const command of [['tower-crane-no-such-program', '{prompt}'], [path.join(h.base, 'missing', 'agent')]]) {
    commandRung(h, 'small', command);
    const before = footprint(h);
    assert.equal(h.readState('tasks.json').tasks[0].branch, null);
    for (const mode of [[], ['--wait']]) {
      const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode]);
      assert.equal(r.code, 1, r.stderr);
      assert.deepEqual(footprint(h), before, `${command[0]} ${mode.join(' ')}`);
      assert.ok(r.stderr.includes(`could not start ${command[0]}: no executable file by that name`), r.stderr);
    }
  }
});

const leftover = (h) => path.join(h.base, 'repo-worktrees', 'T1-idempotency-key-on-retries');

test('a spawn whose program fails to start records nothing and leaves its worktree for the next spawn', (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const { tasks, events } = footprint(h);
  for (const mode of [[], ['--wait']]) {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', ...mode], { hooks: { HOOK_SPAWN_FAIL: '1' } });
    assert.equal(r.code, 1, r.stderr);
    const now = footprint(h);
    assert.ok(fs.existsSync(leftover(h)), 'the worktree stays');
    assert.equal(now.branches.replace(/^[*+ ]+/, ''), 'tower-crane/T1-idempotency-key-on-retries', 'the branch stays');
    assert.deepEqual([now.tasks, now.events, now.logs || []], [tasks, events, []], `${mode.join(' ') || 'background'}: no spawn is recorded`);
    assert.match(r.stderr, /could not start .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
  }
  const next = h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(next.code, 0);
  assert.equal(next.agent, 'small-T1-1', 'a failed spawn does not consume an agent name');
  assert.equal(real(next.cwd), real(leftover(h)), 'the next spawn reuses it');
  assert.equal(h.readState('tasks.json').tasks[0].branch, 'tower-crane/T1-idempotency-key-on-retries');
});

test('a spawn that cannot take the lock leaves its worktree, names it and exits 3', (t) => {
  const h = setup(t);
  commandRung(h, 'small', [process.execPath, '-e', 'process.exit(0)', '{prompt}']);
  const { tasks } = footprint(h);
  // The test process keeps the lock until the spawn exhausts its short budget.
  const lock = S.acquireLock(h.state);
  try {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1'], {
      env: { TOWER_CRANE_INTERVALS: SHORT_WAIT },
    });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /state is locked by .*; its worktree stays at .*T1-idempotency-key-on-retries for the next spawn/);
    assert.ok(fs.existsSync(lock.file), 'the holder keeps its lock through the refusal');
    assert.equal(footprint(h).tasks, tasks);
    assert.ok(fs.existsSync(leftover(h)));
  } finally {
    S.releaseLock(lock);
  }
  assert.equal(real(h.json(['spawn', '--role', 'small', '--task', 'T1', '--wait']).cwd), real(leftover(h)));
});

const waitForFile = (file) => fileWritten(file);

test('a failed spawn never deletes a worktree another command took up', async (t) => {
  const h = setup(t);
  const output = 'worker-output.txt';
  const release = path.join(h.base, 'worker-may-write');
  // The worker stays alive with nothing written until the test releases it,
  // then writes into its working directory.
  const worker = `const fs = require("fs"); const end = Date.now() + 300000;
while (!fs.existsSync(process.argv[1]) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(${JSON.stringify(output)}, "work in progress");`;
  commandRung(h, 'small', [process.execPath, '-e', worker, release]);
  const branchExists = (b) => h.git(['branch', '--list', b]).replace(/^[*+ ]+/, '') === b;

  // A creates T1's worktree and stops before it takes the lock; its program
  // will fail to start. B spawns into the same worktree and its worker starts.
  const aCreated = path.join(h.base, 'a-created');
  const a = h.runAsync(['spawn', '--role', 'small', '--task', 'T1'], { hooks: { HOOK_STOP_WORKTREE_ADD: aCreated, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(aCreated);
  const b = h.json(['spawn', '--role', 'small', '--task', 'T1']);
  fs.writeFileSync(`${aCreated}.go`, '');
  assert.equal((await a).code, 1);
  assert.ok(fs.existsSync(b.cwd), "B's worktree is still there");
  assert.ok(branchExists(h.readState('tasks.json').tasks[0].branch), "T1's recorded branch still exists");
  fs.writeFileSync(release, '');
  await waitForFile(path.join(b.cwd, output));

  // T2 already names a branch but has no worktree. A creates the worktree
  // and stops; B gets it from tower-crane worktree, claims T2 and works there
  // before writing anything. Then A fails.
  h.git(['branch', 'feature/second']);
  h.ok(['task', 'add', '--title', 'Second', '--acceptance', 'b']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'second brief\n' });
  h.ok(['claim', 'T2', '--agent', 'w-1']);
  h.ok(['submit', 'T2', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--branch', 'feature/second', '--agent', 'w-1']);
  h.ok(['rework', 'T2', '--reason', 'again']);
  const a2Created = path.join(h.base, 'a2-created');
  const a2 = h.runAsync(['spawn', '--role', 'small', '--task', 'T2'], { hooks: { HOOK_STOP_WORKTREE_ADD: a2Created, HOOK_SPAWN_FAIL: '1' } });
  await waitForFile(a2Created);
  const handed = h.json(['worktree', 'T2']).path;
  h.ok(['claim', 'T2', '--agent', 'w-b']);
  fs.writeFileSync(`${a2Created}.go`, '');
  assert.equal((await a2).code, 1);
  assert.ok(fs.existsSync(handed), "the claimant's worktree is still there");
  assert.ok(branchExists('feature/second'));
  fs.writeFileSync(path.join(handed, 'claimant-output.txt'), 'work');
});

test('spawn runs the rung of the tier and ladder it finds under the lock, not the one it saw first', async (t) => {
  const h = setup(t);
  const out = path.join(h.base, 'ran.txt');
  const writes = (word) => [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', out, word];
  h.ok(['task', 'update', 'T1', '--tier', 'easy']);
  commandRung(h, 'easy', writes('easy'));
  commandRung(h, 'hard', writes('hard'));
  // The spawn stops after it made the worktree and before it takes the lock;
  // meanwhile the task moves to hard and the hard rung changes.
  const stopped = path.join(h.base, 'stopped');
  const a = h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { hooks: { HOOK_STOP_WORKTREE_ADD: stopped } });
  await waitForFile(stopped);
  h.ok(['task', 'update', 'T1', '--tier', 'hard']);
  commandRung(h, 'hard', writes('hard, changed'));
  fs.writeFileSync(`${stopped}.go`, '');
  const r = await a;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), 'hard, changed');
  assert.equal(JSON.parse(r.stdout).rung, 'hard');
  const ev = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.cmd === 'spawn');
  assert.deepEqual([ev.detail.rung, ev.detail.agent], ['hard', 'worker-T1-1']);

  // A rung that broke in the meantime is refused under the lock, and nothing
  // is recorded. The first worker's lease outlives its exit until it is released.
  h.ok(['release', 'T1', '--agent', 'worker-T1-1', '--reason', 'first worker finished']);
  fs.rmSync(out);
  const stopped2 = path.join(h.base, 'stopped2');
  h.git(['worktree', 'remove', '--force', ev.detail.cwd]);
  const b = h.runAsync(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_STOP_WORKTREE_ADD: stopped2 } });
  await waitForFile(stopped2);
  setRung(h, 'hard', ['--harness', 'command', '--command', JSON.stringify([path.join(h.base, 'no-such-program'), '{prompt}'])]);
  fs.writeFileSync(`${stopped2}.go`, '');
  const rb = await b;
  assert.equal(rb.code, 1);
  assert.match(rb.stderr, /could not start .*no-such-program: no executable file by that name; install it, or fix the rung with tower-crane ladder set hard/);
  assert.ok(!fs.existsSync(out));
  const spawns = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.cmd === 'spawn');
  assert.equal(spawns.length, 1);
});

test('spawn refuses a stacked rework with claim\'s reason when its dependency went back to in_progress, before its worktree work', (t) => {
  const f = stack.stacked(t);
  stack.worker(f);
  // T2's worktree is prepared on T1's head. T1 then takes a new head and goes back to in_progress.
  f.h.ok(['rework', 'T2', '--reason', 'more upper work']);
  stack.resubmit(f, false);
  f.h.ok(['rework', 'T1', '--reason', 'more lower work']);
  f.h.ok(['claim', 'T1', '--agent', 'worker-T1']);
  // The stack is not linked on GitHub, so T2's worktree is stale and must be revalidated at dispatch.
  const state = f.h.readState('tasks.json');
  state.tasks.find((item) => item.id === 'T2').stack.linked = false;
  f.h.writeState('tasks.json', state);
  f.write((d) => { d.linked = false; });

  const r = f.h.run(['spawn', '--task', 'T2']);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /T2 is blocked: depends on T1 \(in_progress\)/);
  assert.doesNotMatch(r.stderr, /prepared on T1|before dispatch/);
  assert.equal(f.h.json(['task', 'show', 'T2']).status, 'rework');
});

// A worker writes its worktree's `.git` file. The directory it names is
// granted to the next sandbox in that worktree, so it must be an admin
// directory of this repository.
test('a spawn refuses a worktree whose .git file names a git directory of another repository', (t) => {
  const h = makeTaskRepo(t, [{ args: ['--title', 'Grant', '--acceptance', 'works'], brief: 'Do it.\n' }]);
  const wt = h.json(['worktree', 'T1', '--agent', 'orchestrator']).path;
  assert.equal(h.run(['spawn', '--task', 'T1', '--dry-run', '--json']).code, 0);
  const other = path.join(h.base, 'other');
  fs.cpSync(h.repo, other, { recursive: true });
  const dotgit = path.join(wt, '.git');
  const original = fs.readFileSync(dotgit, 'utf8');
  // Git hides a worktree's .git file on Windows, and opening a hidden file for
  // writing fails there, so it is replaced rather than rewritten.
  const rewrite = (text) => { fs.rmSync(dotgit); fs.writeFileSync(dotgit, text); };
  h.git(['worktree', 'add', '-q', '--detach', path.join(h.base, 'other-wt'), 'main'], other);
  for (const named of [path.join(other, '.git'), path.join(other, '.git', 'worktrees', 'other-wt')]) {
    rewrite(`gitdir: ${named}\n`);
    const r = h.run(['spawn', '--task', 'T1', '--dry-run', '--json']);
    assert.notEqual(r.code, 0, named);
    assert.match(r.stderr, /is not a worktree admin directory of/, named);
  }
  rewrite(original);
  assert.equal(h.run(['spawn', '--task', 'T1', '--dry-run', '--json']).code, 0);
});

test('a worker spawn in a repository without origin is refused before its worktree or harness starts', (t) => {
  const h = setup(t);
  const marker = path.join(h.base, 'harness-started');
  commandRung(h, 'medium', [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]);
  h.git(['remote', 'remove', 'origin']);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const r = h.run(['spawn', '--task', 'T1']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /this repository has no origin remote; workers push their task branch to origin and open the PR there\. Add it with git remote add origin URL, then spawn again/);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before, 'no state was written');
  assert.equal(h.readState('tasks.json').tasks[0].worktree, undefined);
  assert.ok(!fs.existsSync(marker), 'the harness did not start');
  assert.equal(h.git(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  // A dry run still previews the command, on the rung the marker belongs to.
  assert.equal(h.json(['spawn', '--task', 'T1', '--dry-run']).rung, 'medium');
});

test('a failed origin read is read again, and one that keeps failing reports git, not a missing origin', async (t) => {
  for (const [mode, starts] of [['once', true], ['always', false]]) {
    await t.test(mode, (t) => {
      const h = setup(t);
      const marker = path.join(h.base, 'harness-started');
      commandRung(h, 'medium', [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]);
      const r = h.run(['spawn', '--task', 'T1', '--wait'], { hooks: { HOOK_ORIGIN_READ_FAIL: mode } });
      assert.doesNotMatch(r.stderr, /no origin remote/);
      if (starts) {
        assert.equal(r.code, 0, r.stderr);
        assert.ok(fs.existsSync(marker), 'the harness started');
        return;
      }
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, /cannot read this repository's origin remote: fatal: unable to access '\.git\/config': Permission denied/);
      assert.equal(h.readState('tasks.json').tasks[0].worktree, undefined);
      assert.ok(!fs.existsSync(marker), 'the harness did not start');
    });
  }
});
