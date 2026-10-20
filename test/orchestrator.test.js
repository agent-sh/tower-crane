'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeProjectRepo, BIN, PTY_AVAILABLE } = require('./helpers');
const { HUNG_TEST_MS, fileWritten } = require('./signals');

test('authority and benchmark readers neither compete with a holder nor acquire a vacant lease', (t) => {
  const h = makeProjectRepo(t);
  const holder = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'holder' } };
  const reader = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'reader' } };
  const reads = [['authority'], ['bench', 'gates'], ['bench', 'tokens']];
  const inspect = () => {
    const before = h.readState('tasks.json');
    for (const command of reads) {
      const result = h.run([...command, '--json'], reader);
      assert.equal(result.code, 0, `${command.join(' ')}: ${result.stderr}`);
      assert.deepEqual(h.readState('tasks.json'), before, `${command.join(' ')} cannot change the lease`);
    }
  };
  inspect();
  h.ok(['task', 'add', '--title', 'Native writer', '--acceptance', 'keeps its lease'], holder);
  assert.ok(h.readState('tasks.json').orchestrator_lease);
  inspect();
  h.ok(['orchestrator', 'release'], holder);
  assert.equal(h.readState('tasks.json').orchestrator_lease, null);
  inspect();
  h.ok(['task', 'note', 'T1', 'writer resumes after inspection'], holder);
});

test('one orchestrator session holds writes while reads, release, expiry and owner takeover work', (t) => {
  const h = makeProjectRepo(t);
  const first = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'first' } };
  const second = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'second' } };
  h.ok(['task', 'add', '--title', 'held task', '--acceptance', 'holds the lease'], first);
  const lease = () => h.readState('tasks.json').orchestrator_lease;
  const held = lease();
  assert.ok(held?.session_id, 'first write must record the session lease');
  assert.ok(held.pid > 0);
  assert.ok(held.host);
  assert.ok(Date.parse(held.heartbeat));
  const before = h.readState('tasks.json');
  const denied = h.run(['task', 'add', '--title', 'duplicate', '--acceptance', 'must refuse'], second);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /orchestrator lease.*first.*pid.*owner.*orchestrator takeover/);
  assert.deepEqual(h.readState('tasks.json'), before);
  h.ok(['task', 'show', 'T1'], second);
  h.ok(['inbox'], second);
  assert.deepEqual(lease(), held, 'another reader cannot renew the holder');
  h.ok(['status'], first);
  assert.deepEqual(lease(), held, 'a fresh heartbeat is not renewed');
  h.ok(['status'], { env: { ...first.env, TOWER_CRANE_TEST_NOW: String(Date.parse(held.heartbeat) + 61000),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'shifted-clock.js'))}` } });
  assert.ok(Date.parse(lease().heartbeat) > Date.parse(held.heartbeat), 'a due heartbeat is renewed by a read');
  const releaseDenied = h.run(['orchestrator', 'release'], second);
  assert.equal(releaseDenied.code, 1);
  assert.match(releaseDenied.stderr, /orchestrator lease/);
  const workerDenied = h.run(['orchestrator', 'takeover'], { env: { TOWER_CRANE_AGENT: 'worker' } });
  assert.equal(workerDenied.code, 1);
  assert.match(workerDenied.stderr, /only the owner/);
  const takeoverDenied = h.run(['orchestrator', 'takeover'], second);
  assert.equal(takeoverDenied.code, 1);
  assert.match(takeoverDenied.stderr, /only the owner/);
  h.ok(['orchestrator', 'release'], first);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'second now holds it'], second);
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['orchestrator', 'takeover']);
  assert.equal(lease(), null);
  h.ok(['task', 'note', 'T1', 'first takes it back'], first);

  const idle = h.readState('project.json').limits.lease_minutes * 60000;
  h.ok(['task', 'note', 'T1', 'stale holder replaced'], { env: {
    ...second.env, TOWER_CRANE_TEST_NOW: String(Date.parse(lease().heartbeat) + idle + 1),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'clock.js'))}`,
  } });
  assert.notEqual(lease().session_id, held.session_id);
  h.ok(['validate'], second);
});

test('orchestrator status takes no state lock, and a due renewal never waits for a busy one', (t) => {
  const h = makeProjectRepo(t);
  const S = require('../lib/state');
  const holder = { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'holder' };
  h.ok(['task', 'add', '--title', 'held task', '--acceptance', 'holds the lease'], { env: holder });
  const lease = () => h.readState('tasks.json').orchestrator_lease;
  const meter = path.join(h.base, 'locked-reads.json');
  const preload = (...files) => files.map((f) => `--require=${JSON.stringify(path.join(__dirname, 'fixtures', f))}`).join(' ');
  const fresh = h.run(['status'], { env: { ...holder, LOCKED_READS: meter, NODE_OPTIONS: preload('locked-reads.js') } });
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(JSON.parse(fs.readFileSync(meter, 'utf8')).holdings, 0, 'status with a fresh lease takes no lock');
  // Age the heartbeat rather than shift the clock: without a start-ticks
  // identity (Windows, macOS) a shifted clock would make the held lock stale.
  const doc = h.readState('tasks.json');
  doc.orchestrator_lease.heartbeat = new Date(Date.now() - 61000).toISOString();
  h.writeState('tasks.json', doc);
  const aged = lease();
  const lock = S.acquireLock(h.state);
  try {
    const started = Date.now();
    const due = h.run(['status'], { env: { ...holder, LOCKED_READS: meter, NODE_OPTIONS: preload('locked-reads.js') } });
    assert.equal(due.code, 0, due.stderr);
    assert.ok(Date.now() - started < 30000, 'a read does not wait out the lock bound'); // wait-allow: verify a read skips the production lock bound
    assert.equal(JSON.parse(fs.readFileSync(meter, 'utf8')).holdings, 0);
    assert.deepEqual(lease(), aged, 'a busy lock leaves the renewal to a later command');
  } finally {
    S.releaseLock(lock);
  }
});

test('without a start-ticks identity, status with a due heartbeat leaves a live writer holding the lock', async (t) => {
  const h = makeProjectRepo(t);
  const holder = { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'holder' };
  h.ok(['task', 'add', '--title', 'held task', '--acceptance', 'holds the lease'], { env: holder });
  const doc = h.readState('tasks.json');
  doc.orchestrator_lease.heartbeat = new Date(Date.now() - 61000).toISOString();
  h.writeState('tasks.json', doc);
  const aged = h.readState('tasks.json').orchestrator_lease;
  // As on Windows and macOS: the writer's marker has no start ticks.
  const paused = path.join(h.base, 'writer-holds');
  const writer = h.runAsync(['task', 'note', 'T1', 'written behind status'], { hooks: { HOOK_PAUSE_LOCKED: paused, HOOK_NO_START_TICKS: '1' } });
  await fileWritten(paused);
  try {
    const lock = path.join(h.state, 'lock');
    const [name] = fs.readdirSync(lock);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, name), 'utf8')).start_ticks, undefined);
    const meter = path.join(h.base, 'locked-reads.json');
    const due = h.run(['status'], { env: { ...holder, LOCKED_READS: meter,
      NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'fixtures', 'locked-reads.js'))}` } });
    assert.equal(due.code, 0, due.stderr);
    assert.equal(JSON.parse(fs.readFileSync(meter, 'utf8')).holdings, 0, 'status neither waits for nor breaks the live lock');
    assert.deepEqual(fs.readdirSync(lock), [name], 'the writer still holds its lock');
    assert.deepEqual(h.readState('tasks.json').orchestrator_lease, aged);
  } finally {
    fs.writeFileSync(`${paused}.go`, '');
  }
  const done = await writer;
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(h.readState('tasks.json').tasks[0].notes.map((n) => n.text), ['written behind status']);
});

test('harness children share the lease while detached callers and rival sessions get distinct refusals', async (t) => {
  const clients = [];
  const closed = [];
  // Windows cannot remove the copied harness executable while a client runs.
  t.after(async () => {
    clients.forEach((client) => client.kill());
    await Promise.all(closed);
  });
  const h = makeProjectRepo(t);
  const env = { ...h.env, TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'resumed-session' };
  const script = path.join(h.repo, process.platform === 'win32' ? 'loop.ps1' : 'loop.sh');
  fs.writeFileSync(script, process.platform === 'win32'
    ? '$command = $args[0]\n$commandArgs = $args[1..($args.Length - 1)]\n& $command @commandArgs\nexit $LASTEXITCODE\n'
    : '"$@"\nexit $?\n');
  // Windows retains the executable name when Node changes its process title.
  const execPath = process.platform === 'win32' ? path.join(h.repo, 'claude.exe') : process.execPath;
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, execPath);
  clients.push(...['resumed-session', 'resumed-session', 'different-session'].map((session) =>
    cp.fork(path.join(__dirname, 'fixtures', 'orchestrator-session.js'), [BIN, h.repo],
      { execPath, env: { ...env, CLAUDE_SESSION_ID: session }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })));
  closed.push(...clients.map((client) => new Promise((resolve) => client.once('close', resolve))));
  const run = (client, args, fromScript = false) => new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('message', resolve);
    client.send(fromScript ? { args, script } : args);
  });
  const first = await run(clients[0], ['task', 'add', '--title', 'first copy', '--acceptance', 'one writer']);
  assert.equal(first.code, 0, first.stderr);
  const lease = h.readState('tasks.json').orchestrator_lease;
  assert.equal(lease.pid, clients[0].pid, 'the nearest harness holds the lease');
  assert.equal(lease.persistent, true, 'the harness, not its per-command script, controls early release');
  if (process.platform === 'linux') {
    assert.equal(lease.pidns, fs.readlinkSync('/proc/self/ns/pid'));
    assert.equal(typeof lease.start_ticks, 'string');
  }
  const scripted = await run(clients[0], ['task', 'note', 'T1', 'script under holder'], true);
  assert.equal(scripted.code, 0, scripted.stderr);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, lease.session_id);
  const held = `orchestrator session resumed-session (pid ${lease.pid} on ${lease.host}, heartbeat ${lease.heartbeat})`;
  const unrelated = `tower-crane: orchestrator lease held by ${held}; reads remain open. Have that session run tower-crane orchestrator release, wait for the idle lease to expire, or ask the owner to run tower-crane orchestrator takeover --agent owner\n`;
  for (const [label, call, sameId] of [
    ['detached caller', (args) => h.runAsync(args, { env, detached: true }), true],
    ['resumed copy', (args) => run(clients[1], args, true), true],
    ['unrelated session', (args) => run(clients[2], args, true), false],
  ]) {
    for (const args of [
      ['task', 'add', '--title', 'second copy', '--acceptance', 'refused'],
      ['orchestrator', 'release'],
    ]) {
      const before = h.readState('tasks.json');
      const events = StateFiles.logText(h.state);
      const denied = await call(args);
      assert.equal(denied.code, 1, label);
      if (sameId) {
        assert.match(denied.stderr, /carries the holder's session id but is outside the holder's process tree \(detached\)/, label);
        assert.match(denied.stderr, /Run the command as a child of the holding session, or let tower-crane wait\/automation run gates for it/, label);
        assert.doesNotMatch(denied.stderr, /orchestrator release/, label);
      } else {
        assert.equal(denied.stderr, unrelated, label);
      }
      assert.deepEqual(h.readState('tasks.json'), before, label);
      assert.equal(StateFiles.logText(h.state), events, label);
    }
  }
  assert.equal(h.readState('tasks.json').tasks.length, 1);
  assert.equal((await run(clients[1], ['status'])).code, 0, 'competing process can read');
  assert.equal((await run(clients[0], ['task', 'note', 'T1', 'same live process'])).code, 0);
  assert.equal(h.readState('tasks.json').orchestrator_lease.session_id, lease.session_id);
  assert.equal((await run(clients[0], ['orchestrator', 'release'], true)).code, 0);
  assert.equal((await run(clients[1], ['task', 'note', 'T1', 'released process replaced'])).code, 0);
});

test('identity selects the nearest harness or login shell and preserves the caller fallback', () => {
  const script = `
const assert = require('node:assert/strict');
const C = require(${JSON.stringify(path.join(__dirname, '../lib/commands'))});
const modulePath = ${JSON.stringify(path.join(__dirname, '../lib/orchestrator'))};
Object.defineProperty(process, 'platform', { value: 'win32' });
const variants = [
  ...['claude', 'codex', 'opencode', 'agy', 'pi', 'gemini', 'aider', 'goose', 'cursor-agent'].map(name => [name + '.exe', name, true]),
  ['node', 'node --max-old-space-size=8192 /tools/node_modules/@google/gemini-cli/dist/index.js', true],
  ['python3', 'python3 /home/u/.local/bin/aider', true],
  ['python3.12', 'python3.12 -m aider --model x', true],
  ['python3', 'python3 /tools/script.py aider', false],
  ['node.exe', '"C:\\\\Program Files\\\\node.exe" "C:\\\\tools\\\\pi.js"', true],
  ['node', 'node /tools/node_modules/@anthropic-ai/claude-code/cli.js', true],
  ['node', 'node /tools/node_modules/@mariozechner/pi-coding-agent/dist/cli.js', true],
  ['bash', '-bash', true],
  ['zsh', 'zsh -il', true],
  ['bash', 'bash -l /tools/script.sh', false],
  ['bash', 'bash /tools/codex', false],
  ['powershell.exe', 'powershell.exe -NoProfile', true],
  ['powershell.exe', 'powershell.exe -NoProfile -File loop.ps1', false],
  ['node.exe', 'node.exe /tools/script.js codex', false],
  ['node', 'node /tools/codex/loop.js', false],
];
for (const [Name, CommandLine, isHarness] of variants) {
  const caller = { ProcessId: process.ppid, ParentProcessId: 444444, Name: 'helper.exe',
    CreationDate: 'helper-start', CommandLine: 'helper.exe' };
  const candidate = { ProcessId: 444444, ParentProcessId: 555555, Name,
    CreationDate: 'harness-start', CommandLine };
  const outer = { ProcessId: 555555, ParentProcessId: 1, Name: 'codex.exe', CreationDate: 'outer-start' };
  C.execFileSync = () => JSON.stringify([caller, candidate, ...(isHarness ? [outer] : [])]);
  delete require.cache[require.resolve(modulePath)];
  const O = require(modulePath);
  const ctx = { env: { CLAUDE_SESSION_ID: 'session' }, agent: 'orchestrator' };
  const first = O.identity(ctx);
  assert.equal(first.pid, isHarness ? candidate.ProcessId : caller.ProcessId, CommandLine);
  assert.equal(first.persistent, isHarness, CommandLine);
  const differentId = O.identity({ ...ctx, env: { CLAUDE_SESSION_ID: 'different' } });
  assert.notEqual(first.session_id, differentId.session_id, CommandLine);
  if (!isHarness) {
    const st = { tasks: { orchestrator_lease: { ...first, pid: 2147483647, heartbeat: new Date().toISOString() } },
      project: { limits: { lease_minutes: 60 } } };
    assert.equal(O.live(st), true, 'a fallback caller cannot release by exiting: ' + CommandLine);
    continue;
  }
  caller.ProcessId = 666666;
  // A different intermediate script process still belongs to the nearest harness.
  const shell = { ProcessId: process.ppid, ParentProcessId: 666666, Name: 'powershell.exe',
    CreationDate: 'shell-start', CommandLine: 'powershell.exe -File loop.ps1' };
  C.execFileSync = () => JSON.stringify([shell, caller, candidate, outer]);
  delete require.cache[require.resolve(modulePath)];
  assert.deepEqual(require(modulePath).identity(ctx), first, CommandLine);
  candidate.CreationDate = 'reused-pid-start';
  delete require.cache[require.resolve(modulePath)];
  assert.notEqual(require(modulePath).identity(ctx).session_id, first.session_id, CommandLine);
}
`;
  const result = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, result.stderr);
});

// Runs identity() in a child that sees the given process rows; PPID and SELF name the child's own pids.
function mockedIdentity(platform, rows) {
  const script = `
const fs = require('node:fs');
const C = require(${JSON.stringify(path.join(__dirname, '../lib/commands'))});
const pids = (value) => value === 'PPID' ? process.ppid : value === 'SELF' ? process.pid : value;
const raw = JSON.parse(process.env.ROWS);
// A string is recorded ps output, with PPID and SELF in place of pids.
const rows = typeof raw === 'string' ? raw.replace(/\\b(PPID|SELF)\\b/g, pids)
  : raw.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, pids(v)])));
Object.defineProperty(process, 'platform', { value: process.env.PLATFORM });
C.execFileSync = () => typeof rows === 'string' ? rows : JSON.stringify(rows);
const { readFileSync, readlinkSync } = fs;
const row = (file) => rows.find((r) => file.startsWith('/proc/' + r.ProcessId + '/'));
fs.readFileSync = (file, ...rest) => {
  if (typeof file !== 'string' || !file.startsWith('/proc/') || file.startsWith('/proc/self/')) return readFileSync(file, ...rest);
  const r = row(file);
  if (!r) throw Object.assign(new Error('no process'), { code: 'ENOENT' });
  if (file.endsWith('/cmdline')) return r.Args.join('\\0') + '\\0';
  return r.ProcessId + ' (' + r.Name + ') S ' + r.ParentProcessId + ' 0'.repeat(17) + ' ' + r.CreationDate + ' 0 0';
};
fs.readlinkSync = (file, ...rest) => {
  if (file === '/proc/self/ns/pid') return 'pid:[4026531836]';
  if (typeof file !== 'string' || !file.startsWith('/proc/')) return readlinkSync(file, ...rest);
  const r = row(file);
  if (!r?.Stdin) throw Object.assign(new Error('no descriptor'), { code: 'EACCES' });
  return r.Stdin;
};
const O = require(${JSON.stringify(path.join(__dirname, '../lib/orchestrator'))});
const lease = O.identity({ env: { CLAUDE_SESSION_ID: 'session' }, agent: 'orchestrator' });
console.log(JSON.stringify({ ...lease, ppid: process.ppid }));
`;
  const result = cp.spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, PLATFORM: platform, ROWS: JSON.stringify(rows) }, encoding: 'utf8', timeout: 300000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('session shells are recognized by login or interactive options or a terminal on stdin', () => {
  for (const [Name, Args, Stdin, session] of [
    ['bash', ['/bin/bash', '--posix', '--login'], 'pipe:[7]', true],
    ['bash', ['-bash'], null, true],
    ['bash', ['bash'], '/dev/pts/3', true],
    ['zsh', ['zsh'], '/dev/tty2', true],
    ['fish', ['fish', '--interactive'], null, true],
    ['fish', ['fish', '-i', '-C', 'source x'], null, true],
    ['fish', ['fish', '-iC', 'source x'], null, true],
    ['fish', ['fish', '-Csource x'], '/dev/pts/3', true],
    ['fish', ['fish', '-C', 'source x', 'loop.fish'], '/dev/pts/3', false],
    ['bash', ['bash', '-C', '-l'], null, true],
    ['bash', ['bash', '--rcfile', 'profile.sh', '-o', 'vi'], '/dev/pts/3', true],
    ['bash', ['bash'], 'pipe:[42]', false],
    ['bash', ['bash'], null, false],
    ['bash', ['bash', '-ci', 'tower-crane task list'], '/dev/pts/3', false],
    ['bash', ['/bin/bash', '--login', '-c', 'loop'], '/dev/pts/3', false],
    ['bash', ['bash', '--login', 'loop.sh'], '/dev/pts/3', false],
  ]) {
    const label = `${Args.join(' ')} stdin ${Stdin}`;
    const lease = mockedIdentity('linux', [
      { ProcessId: 'PPID', ParentProcessId: 444444, Name: 'node', Args: ['node', 'helper.js'], CreationDate: '300' },
      { ProcessId: 444444, ParentProcessId: 555555, Name, Args, Stdin, CreationDate: '200' },
      { ProcessId: 555555, ParentProcessId: 1, Name: 'kitty', Args: ['kitty'], CreationDate: '100' },
    ]);
    assert.equal(lease.pid, session ? 444444 : lease.ppid, label);
    assert.equal(lease.persistent, session, label);
  }
});

test('Windows command lines keep backslash-escaped quotes inside one argument', () => {
  const { commandLineArgs } = require('../lib/orchestrator');
  for (const [line, args] of [
    ['bash.exe -c -l "cd /x && grep -i \\"a b\\" f"', ['bash.exe', '-c', '-l', 'cd /x && grep -i "a b" f']],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', ['C:\\Program Files\\Git\\bin\\bash.exe', '--login', '-i']],
    ['node.exe "C:\\a b\\\\" x', ['node.exe', 'C:\\a b\\', 'x']],
    ['x a\\\\\\"b c\\d', ['x', 'a\\"b', 'c\\d']],
    ['bash.exe -c -l "cd /x && \\"grep -i x\\""', ['bash.exe', '-c', '-l', 'cd /x && "grep -i x"']],
    ['x "a""b"', ['x', 'a"b']],
    // The doubled quote also ends the quoted run, so the next quote opens one.
    ['x "a""b" c', ['x', 'a"b c']],
    ['x "" c', ['x', '', 'c']],
    ['x "a""b c" d', ['x', 'a"b', 'c d']],
    ['x """', ['x', '"']],
    ['x a"""b c"', ['x', 'a"b', 'c']],
    ['', []],
    [null, []],
  ]) assert.deepEqual(commandLineArgs(line), args, String(line));
  const shell = (CommandLine) => mockedIdentity('win32', [
    { ProcessId: 'PPID', ParentProcessId: 444444, Name: 'helper.exe', CreationDate: 'helper-start', CommandLine: 'helper.exe' },
    { ProcessId: 444444, ParentProcessId: 1, Name: 'bash.exe', CreationDate: 'bash-start', CommandLine },
  ]);
  // Splitting on every quote would leave -i as an option after the command string.
  const command = shell('bash.exe -c -l "cd /x && \\"grep -i x\\""');
  assert.equal(command.pid, command.ppid, 'a Git Bash -c shell is a per-command shell');
  assert.equal(command.persistent, false);
  const login = shell('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i');
  assert.equal(login.pid, 444444, 'a Git Bash login shell is a session');
  assert.equal(login.persistent, true);
});

// macOS ps sample in the shape Terminal.app produces: login starts the user's
// shell with a leading '-', and ps prints that name as both comm and args.
const MACOS_PS = `    1     0 /sbin/launchd    /sbin/launchd
  611     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  614   611 login            login -pf avi
444444   614 -zsh             -zsh
 PPID 444444 /bin/bash        /bin/bash /Users/avi/bin/loop.sh
 SELF  PPID node             node /usr/local/bin/tower-crane task note T1 x
`;

test('a macOS login shell whose ps name is -zsh is a session shell', () => {
  const lease = mockedIdentity('darwin', MACOS_PS);
  assert.equal(lease.pid, 444444, 'the -zsh login shell is the session');
  assert.equal(lease.persistent, true);
  const command = mockedIdentity('darwin', MACOS_PS.replace('-zsh             -zsh', '/bin/zsh         /bin/zsh -c loop'));
  assert.equal(command.pid, command.ppid, 'a -c zsh is a per-command shell');
  assert.equal(command.persistent, false);
});

test('the Windows ancestor walk stops at a parent created after its child', () => {
  const walk = (callerStart, harnessStart) => mockedIdentity('win32', [
    { ProcessId: 'SELF', ParentProcessId: 'PPID', Name: 'node.exe', CreationDate: '500', CommandLine: 'node.exe tower-crane.js' },
    { ProcessId: 'PPID', ParentProcessId: 444444, Name: 'helper.exe', CreationDate: callerStart, CommandLine: 'helper.exe' },
    { ProcessId: 444444, ParentProcessId: 1, Name: 'claude.exe', CreationDate: harnessStart, CommandLine: 'claude.exe' },
  ]);
  const parent = walk('400', '300');
  assert.equal(parent.pid, 444444, 'an older harness is the session');
  assert.equal(parent.persistent, true);
  const reused = walk('400', '450');
  assert.equal(reused.pid, reused.ppid, 'a newer process at the dead parent pid is not an ancestor');
  assert.equal(reused.persistent, false);
  const callerReused = walk('600', '300');
  assert.equal(callerReused.pid, callerReused.ppid);
  assert.equal(callerReused.persistent, false, 'a caller newer than this process breaks the chain at once');
});

test('a lease whose holder process exited is released at once, including a reused pid', async (t) => {
  const clients = [];
  const closed = [];
  t.after(async () => {
    clients.forEach((client) => client.kill());
    await Promise.all(closed);
  });
  const h = makeProjectRepo(t);
  const env = { ...h.env, TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'restarted-session' };
  const execPath = process.platform === 'win32' ? path.join(h.repo, 'claude.exe') : process.execPath;
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, execPath);
  const fork = () => cp.fork(path.join(__dirname, 'fixtures', 'orchestrator-session.js'),
    [BIN, h.repo], { execPath, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  clients.push(fork(), fork());
  closed.push(...clients.map((client) => new Promise((resolve) => client.once('close', resolve))));
  const run = (client, args) => new Promise((resolve, reject) => {
    client.once('error', reject);
    client.once('message', resolve);
    client.send(args);
  });
  assert.equal((await run(clients[0], ['task', 'add', '--title', 'held', '--acceptance', 'dead holder'])).code, 0);
  const held = h.readState('tasks.json').orchestrator_lease;
  assert.equal(held.pid, clients[0].pid);
  assert.equal((await run(clients[1], ['task', 'note', 'T1', 'refused'])).code, 1, 'a live holder keeps the lease');
  if (process.platform === 'linux') {
    // A fallback or legacy lease without persistent identity waits out the idle window.
    const { persistent, ...legacy } = held;
    assert.equal(persistent, true);
    h.writeState('tasks.json', { ...h.readState('tasks.json'), orchestrator_lease: { ...legacy, start_ticks: '1' } });
    assert.equal((await run(clients[1], ['task', 'note', 'T1', 'refused'])).code, 1, 'a legacy lease is not released early');
    // A pid reused by another process does not keep a dead holder's lease.
    h.writeState('tasks.json', { ...h.readState('tasks.json'), orchestrator_lease: { ...held, start_ticks: '1' } });
    const reused = await run(clients[1], ['task', 'note', 'T1', 'pid was reused']);
    assert.equal(reused.code, 0, reused.stderr);
    assert.equal(h.readState('tasks.json').orchestrator_lease.pid, clients[1].pid);
    assert.equal((await run(clients[1], ['orchestrator', 'release'])).code, 0);
    assert.equal((await run(clients[0], ['task', 'note', 'T1', 'holder again'])).code, 0);
  }
  clients[0].kill();
  await closed[0];
  const taken = await run(clients[1], ['task', 'note', 'T1', 'dead holder replaced']);
  assert.equal(taken.code, 0, taken.stderr);
  assert.equal(h.readState('tasks.json').orchestrator_lease.pid, clients[1].pid);
});

test('TOWER_CRANE_VIA=automation in the environment cannot write under another session lease', (t) => {
  const h = makeProjectRepo(t);
  const holder = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'holder' } };
  h.ok(['task', 'add', '--title', 'Held', '--acceptance', 'one writer'], holder);
  const before = h.readState('tasks.json');
  const events = () => StateFiles.logText(h.state);
  const log = events();
  for (const [label, extra, input] of [
    ['claim alone', {}],
    ['wrong key', { TOWER_CRANE_AUTOMATION_KEY_FD: '0' }, 'guessed\n'],
  ]) {
    const rival = h.run(['task', 'add', '--title', 'Rival', '--acceptance', 'refused'],
      { input, env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'rival', TOWER_CRANE_VIA: 'automation', ...extra } });
    assert.equal(rival.code, 1, `${label}: ${rival.stderr}`);
    assert.match(rival.stderr, /orchestrator lease held by orchestrator session holder/, label);
    assert.deepEqual(h.readState('tasks.json'), before, label);
    assert.equal(events(), log, label);
  }
  // The holder's own write with the claim still renews its lease and records no engine provenance.
  // A heartbeat renews once it is a sixtieth of the lease window old, so age it first.
  const aged = h.readState('tasks.json');
  aged.orchestrator_lease.heartbeat = new Date(Date.now() - 61000).toISOString();
  h.writeState('tasks.json', aged);
  h.ok(['task', 'note', 'T1', 'holder continues'], { env: { ...holder.env, TOWER_CRANE_VIA: 'automation' } });
  const after = h.readState('tasks.json');
  assert.equal(after.orchestrator_lease.session_id, before.orchestrator_lease.session_id);
  assert.notEqual(after.orchestrator_lease.heartbeat, aged.orchestrator_lease.heartbeat);
  const note = events().trim().split('\n').map(JSON.parse).findLast((e) => e.cmd === 'task note');
  assert.equal(note.via, undefined);
});

test('a key line longer than any key is refused, not dropped into the command input', (t) => {
  const h = makeProjectRepo(t);
  const holder = { env: { TOWER_CRANE_AGENT: 'orchestrator', CLAUDE_SESSION_ID: 'holder' } };
  h.ok(['task', 'add', '--title', 'Held', '--acceptance', 'one writer'], holder);
  const log = StateFiles.logText(h.state);
  const long = h.run(['task', 'note', 'T1', 'from a long line'], { input: `${'a'.repeat(300)}\n`,
    env: { ...holder.env, TOWER_CRANE_VIA: 'automation', TOWER_CRANE_AUTOMATION_KEY_FD: '0' } });
  assert.equal(long.code, 1, long.stderr);
  assert.match(long.stderr, /automation key line on descriptor 0 is longer than 256 bytes/);
  assert.equal(StateFiles.logText(h.state), log);
});

// script gives the CLI a terminal on stdin; the open pipe to script means no
// end of input ever reaches it, as in an interactive shell.
test('a key marker leaked into a terminal neither reads nor waits on it', { skip: !PTY_AVAILABLE && 'needs script(1)' }, async (t) => {
  const h = makeProjectRepo(t);
  const command = [process.execPath, BIN, '--version'].map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(' ');
  const child = cp.spawn('script', ['-qec', command, '/dev/null'], {
    env: { ...h.env, TOWER_CRANE_VIA: 'automation', TOWER_CRANE_AUTOMATION_KEY_FD: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  const deadline = new Promise((resolve) => setTimeout(resolve, 60000, 'timeout')); // wait-allow: bounds a CLI that blocks on its terminal, the failure under test
  assert.equal(await Promise.race([closed, deadline]), 0, `the CLI waited on its terminal; output: ${out}`);
  assert.ok(out.includes(require('../package.json').version), `--version printed: ${out}`);
});

test('engine lease bindings reject stale work without extending the idle window', () => {
  const O = require('../lib/orchestrator');
  const old = { session_id: 'old', heartbeat: new Date().toISOString() };
  const replacement = { ...old, session_id: 'new' };
  const expired = { ...old, heartbeat: '2000-01-01T00:00:00.000Z' };
  for (const [label, lease, bound, ok] of [
    ['vacant', null, null, true],
    ['idle', expired, expired, true],
    ['native writer arrived and idled out', expired, null, false],
    ['holder', old, old, true],
    ['released', null, old, false],
    ['taken over', replacement, old, false],
    ['expired during work', expired, old, true],
    ['native writer arrived', old, null, false],
  ]) {
    const st = { events: [], project: { limits: { lease_minutes: 60 } }, tasks: { orchestrator_lease: lease } };
    const before = structuredClone(st);
    const ctx = { agent: 'orchestrator', agentExplicit: true, automation: true, orchestratorSession: bound,
      env: { TOWER_CRANE_AGENT: 'orchestrator' } };
    if (ok) assert.doesNotThrow(() => O.guard(ctx, st, true), label);
    else assert.throws(() => O.guard(ctx, st, true), /lease changed during automation/, label);
    assert.deepEqual(st, before, label);
  }
});

test('mutation lease checks preserve the command heartbeat and refuse a released binding', () => {
  const O = require('../lib/orchestrator');
  const session = { session_id: 'caller', heartbeat: '2000-01-01T00:00:00.000Z' };
  const ctx = { agent: 'orchestrator', agentExplicit: true, orchestratorSession: session,
    orchestratorLeaseSession: session.session_id, env: { TOWER_CRANE_AGENT: 'orchestrator' } };
  const st = { events: [], project: { limits: { lease_minutes: 60 } }, tasks: { orchestrator_lease: session } };
  const before = structuredClone(st);
  O.guard(ctx, st, true, false);
  assert.deepEqual(st, before, 'rechecking a mutation cannot wake its own filesystem watcher');
  st.tasks.orchestrator_lease = null;
  assert.throws(() => O.guard(ctx, st, true, false), /lease changed during command/);
  assert.equal(st.tasks.orchestrator_lease, null, 'an old waiter cannot undo release');
});

test('native lease heartbeats preserve archived evidence references', (t) => {
  const h = makeProjectRepo(t);
  h.ok(['task', 'add', '--title', 'Archived note', '--acceptance', 'preserve its payload', '--kind', 'docs']);
  h.ok(['evidence', 'T1', '--type', 'note', '--ok', '--sha', h.git(['rev-parse', 'HEAD']), '--summary', 'x'.repeat(2048)]);
  const entry = () => h.readState('tasks.json').tasks[0].evidence[0];
  const before = entry();
  assert.ok(before.evidence_refs?.summary, 'the fixture must contain an archived payload');
  h.ok(['task', 'note', 'T1', 'take the lease', '--agent', 'orchestrator']);
  h.ok(['status', '--agent', 'orchestrator']);
  assert.deepEqual(entry(), before);
  const payload = path.join(h.state, 'evidence', 'T1', before.evidence_refs.summary.sha256 + '.json');
  assert.equal(JSON.parse(fs.readFileSync(payload, 'utf8')), 'x'.repeat(2048));
});

test('Windows parent discovery stays stable when whole-machine command lines exceed the buffer', () => {
  const script = `
const C = require(${JSON.stringify(path.join(__dirname, '../lib/commands'))});
Object.defineProperty(process, 'platform', { value: 'win32' });
C.execFileSync = (command, args) => {
  if (command !== 'powershell.exe') throw new Error('unexpected command');
  if (process.env.PARENT_QUERY_CASE === 'large' && !args[2].includes('ConvertTo-Json -InputObject @($taskParents)')) {
    throw Object.assign(new Error('process listing exceeds maxBuffer'), { code: 'ENOBUFS' });
  }
  return JSON.stringify([{ ProcessId: process.ppid, ParentProcessId: 444444, Name: 'node.exe',
    CreationDate: 'stable-start', CommandLine: 'node harness' },
    { ProcessId: 444444, ParentProcessId: 1, Name: 'ancestor.exe',
      CreationDate: process.env.PARENT_QUERY_CASE, CommandLine: 'ancestor display metadata' }]);
};
const O = require(${JSON.stringify(path.join(__dirname, '../lib/orchestrator'))});
console.log(JSON.stringify(O.identity({ env: { CLAUDE_SESSION_ID: 'same-session' }, agent: 'orchestrator' })));
`;
  const identities = ['large', 'small'].map((value) => {
    const result = cp.spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, PARENT_QUERY_CASE: value }, encoding: 'utf8', timeout: HUNG_TEST_MS,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(identities[0], identities[1], 'changing process-list size cannot change the session key');
});

test('Windows parent discovery waits for query completion with the cold-start hang guard', async (t) => {
  const h = makeProjectRepo(t);
  const release = path.join(h.base, 'query-release');
  const script = `
const cp = require('node:child_process');
const C = require(${JSON.stringify(path.join(__dirname, '../lib/commands'))});
Object.defineProperty(process, 'platform', { value: 'win32' });
C.execFileSync = (command, args, options) => {
  if (command !== 'powershell.exe') throw new Error('unexpected command');
  const result = [{ ProcessId: process.ppid, ParentProcessId: 1, Name: 'claude.exe',
    CreationDate: 'stable-start', CommandLine: 'claude harness' }];
  process.send({ timeout: options.timeout });
  return cp.execFileSync(process.execPath, ['-e',
    ${JSON.stringify(`
const fs = require('node:fs');
const release = ${JSON.stringify(release)};
const watcher = fs.watch(${JSON.stringify(h.base)}, check);
function check() {
  if (!fs.existsSync(release)) return;
  watcher.close();
  process.stdout.write(process.argv[1]);
}
check();
`)}, JSON.stringify(result)], options);
};
const O = require(${JSON.stringify(path.join(__dirname, '../lib/orchestrator'))});
const identity = O.identity({ env: { CLAUDE_SESSION_ID: 'cold-session' }, agent: 'orchestrator' });
if (identity.pid !== process.ppid || !identity.persistent) throw new Error('query lost the persistent caller');
console.log(identity.harness_session_id);
`;
  const child = cp.spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const query = new Promise(resolve => child.once('message', resolve));
  const options = await Promise.race([query, closed.then(code => { throw new Error(`query exited ${code}: ${stderr}`); })]);
  fs.writeFileSync(release, '');
  assert.equal(await closed, 0, stderr);
  assert.equal(stdout.trim(), 'cold-session');
  assert.equal(options.timeout, 60000, 'cold discovery cannot reuse a ten-second deadline');
});
