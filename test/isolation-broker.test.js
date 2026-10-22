'use strict';

// A sandboxed agent's state writes through its broker, the state and worktree paths it
// cannot write, its gh token and config, local pushes, resumed and nested spawns,
// rung opt-ins and TOML output.

const { waitUntil, killPid } = require('./signals');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN, detachedAlive } = require('./helpers');
const A = require('../lib/agents');
const TOML = require('../lib/toml');
const { NO_STUBS, SECRET, setup, noSecretsCopied, releaseExited, spawn, ALLOW, decide, isolated, commandsRead, commandsWrite } = require('./isolation-helpers');

test('a sandboxed agent changes the state only through its spawn\'s broker: as itself, on its own task, with its role\'s commands', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'untouched']);
  const tests = h.readState('project.json').tests;
  const fixture = path.join(h.base, 'fixture-state');
  const cli = (...args) => [process.execPath, BIN, ...args];
  const envOwner = [
    process.execPath, '-e',
    `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp=require("node:child_process");const r=cp.spawnSync(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'as env owner'])},{env: fakeAgentEnv({...process.env,TOWER_CRANE_AGENT:'owner'}),encoding:'utf8'});process.stderr.write(r.stderr||'');process.exit(r.status??1);`,
  ];
  // Reaches the broker named in broker.json, but with a token of its own.
  const forged = `const f=require("fs"),n=require("net");const b=JSON.parse(f.readFileSync(process.env.TOWER_CRANE_BROKER,"utf8"));const s=n.connect(b.socket||{host:b.host,port:b.port},()=>s.write(JSON.stringify({token:"0".repeat(64),argv:["task","note","T1","forged"]})+"\\n"));let o="";s.on("data",d=>o+=d).on("end",()=>{process.stderr.write(o);process.exit(JSON.parse(o).code)})`;
  const cases = [
    [cli('task', 'note', 'T1', 'through the broker'), 0],
    [cli('task', 'note', 'T1', 'as the owner', '--agent', 'owner'), 1],
    [cli('task', 'note', 'T2', 'another task'), 1],
    [cli('task', 'add', '--title', 'X', '--acceptance', 'Y'), 1],
    [cli('project', 'set', '--tests-mode', 'none', '--agent', 'owner'), 1],
    [cli('evidence', 'T1', '--type', 'note', '--ok'), 1],
    [cli('task', 'show', 'T1'), 0],
    [[process.execPath, '-e', forged], 1],
    // A test fixture's own state is not the broker's; it runs in the agent.
    [cli('init', '--name', 'fixture', '--goal', 'own state', '--state', fixture), 0],
    [[process.execPath, '-e', 'process.stderr.write(require("fs").readFileSync(process.env.TOWER_CRANE_BROKER, "utf8"))'], 0],
    // Harness hooks write through the broker too, their payload from stdin,
    // with the agent's own binding and no other.
    [[process.execPath, '-e', `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const StateFiles = require('./state-files');
require("child_process").execFileSync(process.execPath, [${JSON.stringify(BIN)}, "hook", "report", "--binding", require("path").join(process.env.TOWER_CRANE_STATE, "homes", process.env.TOWER_CRANE_AGENT, "hook.json"), "--payload", "-"], { env: fakeAgentEnv(process.env), input: JSON.stringify({ report: "hooked" }), stdio: ["pipe", "ignore", "inherit"] })`], 0],
    [cli('hook', 'report', '--binding', path.join(h.state, 'homes', 'worker-T1-1', 'hook.json'), '--payload', '{"report":"as another"}'), 1],
    [envOwner, 1],
  ];
  const noted = [];
  for (const [n, harness] of ['claude', 'codex'].entries()) {
    isolated(h, 'small', harness);
    // The skills name the agent on every call, as itself.
    const named = [cli('task', 'note', 'T1', 'named', '--agent', `small-T1-${n + 1}`), 0];
    const agent = spawn(h, u, 'small', { STUB_RUN: JSON.stringify([...cases, named].map((c) => c[0])) }).agent;
    noted.push(agent);
    const ran = u.report().ran;
    assert.deepEqual(ran.map((r) => r.code), [...cases, named].map((c) => c[1]), `${harness}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    assert.match(ran[1].stderr, /a task process never acts as owner/);
    assert.match(ran[2].stderr, /works on T1 only, not T2/);
    assert.match(ran[3].stderr, /sandboxed small; it changes state only with task note, answer, hook, not task add/);
    assert.match(ran[11].stderr, /uses its own hook binding only/);
    assert.match(ran[7].stderr, /without its token/);
    assert.match(ran[12].stderr, /a task process never acts as owner/);
    // Codex's sandbox refuses connecting to a Unix socket; claude's has no
    // host loopback.
    const address = JSON.parse(ran[9].stderr);
    if (harness === 'codex') assert.deepEqual([address.socket, address.host, Number.isInteger(address.port) && address.port > 0], [undefined, '127.0.0.1', true]);
    else assert.deepEqual([typeof address.socket, address.host], ['string', undefined]);
    assert.ok(fs.existsSync(path.join(fixture, 'project.json')), `${harness}: the fixture got its own state`);
    assert.ok(!fs.existsSync(path.join(h.state, 'brokers', agent)), `${harness}: the broker closes with its agent`);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  isolated(h, 'hard', 'claude');
  const worker = spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([cli('claim', 'T1'), cli('evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736')]) }).agent;
  assert.deepEqual(u.report().ran.map((r) => r.code), [0, 1], JSON.stringify(u.report().ran.map((r) => r.stderr)));
  const [t1, t2] = h.readState('tasks.json').tasks;
  assert.equal(t1.claim.agent, worker, 'the worker claimed as itself');
  assert.deepEqual(t1.notes.map((n) => [n.agent, n.text]), noted.flatMap((a) => [[a, 'through the broker'], [a, 'named']]));
  assert.deepEqual(t1.evidence, []);
  assert.deepEqual(t2.notes, []);
  assert.deepEqual(h.readState('project.json').tests, tests);
  const events = StateFiles.logText(h.state).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.filter((e) => e.via === 'broker').map((e) => [e.cmd, e.agent, e.task]),
    [...noted.flatMap((a) => [['task note', a, 'T1'], ['hook report', a, 'T1'], ['task note', a, 'T1']]), ['claim', worker, 'T1']], 'only brokered changes, each as its agent');
  assert.deepEqual(events.filter((e) => e.via === 'automation' && ['hook stop', 'msg'].includes(e.cmd))
    .map((e) => [e.cmd, e.agent, e.task]), [...noted, worker].flatMap((agent) =>
      [['hook stop', agent, 'T1'], ['msg', agent, 'T1']]), 'supervisor notifications retain their engine provenance and agent');
  assert.deepEqual(events.filter((e) => e.cmd === 'hook report').map((e) => e.detail.report), noted.map(() => 'hooked'), 'the hook payload came through stdin');
});

test('a brokered command still running when its agent exits is killed, and spawn --wait returns', { skip: NO_STUBS, timeout: 300000 }, async (t) => {
  const { h, u } = setup(t);
  // Stands in for a slow brokered command: preloaded into every node process
  // the spawn starts, it holds only the CLI the broker runs for the note
  // "late", before it writes anything. The agent's own code never runs there.
  const preload = path.join(h.base, 'slow-broker.js');
  fs.writeFileSync(preload, `
if (process.env.TOWER_CRANE_VIA === 'broker' && process.argv.includes('late')) {
  require('node:fs').writeFileSync(process.env.SLOW_BROKER_PID, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
`);
  for (const harness of ['claude', 'codex']) {
    const pidFile = path.join(h.base, `${harness}-late.pid`);
    // The agent leaves the note waiting in the background and exits once the
    // broker is running it.
    const background = `
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp=require("child_process"),f=require("fs");cp.spawn(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'late'])},{ env: fakeAgentEnv(process.env),detached:true,stdio:"ignore"}).unref();const end=Date.now()+300000;while(!f.existsSync(${JSON.stringify(pidFile)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)`;
    let pid = null;
    t.after(() => {
      if (pid && detachedAlive({ pid })) killPid(pid, 'SIGKILL');
    });
    isolated(h, 'hard', harness);
    const run = [[process.execPath, BIN, 'task', 'note', 'T1', 'early'], [process.execPath, '-e', background]];
    const env = { ...u.env, STUB_RUN: JSON.stringify(run), NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, SLOW_BROKER_PID: pidFile };
    const started = Date.now();
    releaseExited(h);
    const r = await h.runAsync(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 60000, `${harness}: spawn --wait returned`); // wait-allow: verify broker shutdown stops a held subprocess promptly
    assert.deepEqual(u.report().ran.map((x) => x.code), [0, 0], JSON.stringify(u.report().ran.map((x) => x.stderr)));
    assert.ok(fs.existsSync(pidFile), `${harness}: the broker ran the late note`);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !detachedAlive({ pid }), { signal: t.signal });
    assert.ok(!detachedAlive({ pid }), `${harness}: the brokered command stopped with the broker`);
  }
  const notes = h.readState('tasks.json').tasks[0].notes.map((n) => n.text).filter((text) => ['early', 'late'].includes(text));
  assert.deepEqual(notes, ['early', 'early'], 'nothing the broker was still running wrote after its spawn ended');
});

test('a sandboxed role cannot write the state directory itself', () => {
  // A Windows checkout has CRLF line ends.
  const text = fs.readFileSync(A.file('worker'), 'utf8').replace(/^writeOutside:(\r?\n)/m, 'writeOutside:$1  - state$1');
  assert.match(text, /- state/);
  assert.throws(() => A.parse(text, 'worker.md'), /state needs sandbox: false/);
  for (const job of ['worker', 'researcher', 'reviewer', 'small']) assert.ok(!A.load(job).writeOutside.includes('state'), job);
});

test('a sandboxed role cannot write the worktrees root, which holds the admin directories', () => {
  const text = fs.readFileSync(A.file('worker'), 'utf8').replace(/^writeOutside:(\r?\n)/m, 'writeOutside:$1  - worktrees$1');
  assert.match(text, /- worktrees/);
  assert.throws(() => A.parse(text, 'worker.md'), /worktrees needs sandbox: false/);
  for (const job of ['worker', 'researcher', 'reviewer', 'small']) assert.ok(!A.load(job).writeOutside.includes('worktrees'), job);
  assert.ok(A.load('orchestrator').writeOutside.includes('worktrees') && !A.load('orchestrator').sandbox);
});

// A project's sandbox.write would reopen the worktree lock in the state
// directory, or every admin directory in the worktrees root.
test('spawn refuses a sandbox.write path over the state directory or the worktrees root', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const root = path.dirname(wt);
  const cases = [
    // Holding the state directory, it holds the agent homes too, which an earlier check names.
    [h.base, /sandbox\.write path .* holds /],
    [path.join(h.state, 'worktree'), /is inside the state directory/],
    [root, /holds the worktrees root/],
  ];
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const [dir, why] of cases) {
      h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [dir] })]);
      const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: u.env });
      assert.notEqual(r.code, 0, `${harness} ${dir}`);
      assert.match(r.stderr, why, `${harness} ${dir}`);
    }
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [path.join(h.base, 'elsewhere')] })]);
    const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.equal(r.code, 0, `${harness}: ${r.stderr}`);
  }
});

// The worktree lock (lib/worktree.js underWorktreeLock) moved out of the git
// directory, which a sandboxed worker writes, to the state directory.
test('no sandboxed claude or codex role can write the worktree lock, as every worker could write its old place', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const real = (p) => fs.realpathSync.native(p);
  const common = real(path.join(h.repo, '.git'));
  const lock = path.join(real(h.state), 'worktree', 'lock');
  const legacy = path.join(common, 'tower-crane-worktree.lock');
  for (const harness of ['claude', 'codex']) {
    for (const rung of ['hard', 'review', 'research', 'small']) {
      isolated(h, rung, harness);
      spawn(h, u, rung);
      const seen = u.report();
      assert.equal(commandsWrite(seen, real(wt), common, lock), false, `${harness} ${rung}: the lock is read-only`);
      assert.equal(commandsWrite(seen, real(wt), common, path.join(real(path.dirname(wt)), '.git-admin', 'other')), false, `${harness} ${rung}: other admin directories are read-only`);
      if (rung === 'hard') assert.equal(commandsWrite(seen, real(wt), common, legacy), true, `${harness}: a worker writes the old lock path`);
    }
  }
});

test('a sandboxed agent gets no gh token, from the keyring or the spawning environment, and its gh runs on the host with the user\'s config', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'review');
    assert.equal(u.report().ghToken, null, `${harness}: no token from the keyring`);
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      spawn(h, u, 'review', { [name]: 'spawner-token' });
      assert.deepEqual(u.report().tokens, [], `${harness}: no ${name} from the spawner`);
    }
    // Nor from the project's env, which the owner sets for every agent.
    h.ok(['project', 'set', '--env', JSON.stringify({ GH_TOKEN: 'project-token' })]);
    spawn(h, u, 'review');
    assert.deepEqual(u.report().tokens, [], `${harness}: no token from the project env`);
    h.ok(['project', 'set', '--env', '{}']);
  }
});

test('sandboxed gh runs on the host with the user\'s custom config directory, which the agent cannot read', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const custom = path.join(u.home, 'custom-config');
  fs.mkdirSync(path.join(custom, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const path = require('node:path');
const env = process.env;
const config = env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'gh');
if (!config.startsWith(${JSON.stringify(custom)} + path.sep) || env.GH_TOKEN) {
  process.stderr.write('not the gh login of the user');
  process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const customEnv of [{ GH_CONFIG_DIR: path.join(custom, 'gh'), XDG_CONFIG_HOME: '' }, { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: custom }]) {
      spawn(h, u, 'hard', { ...customEnv, STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]) });
      const seen = u.report();
      assert.equal(seen.ran[0].code, 0, `${harness}: ${seen.ran[0].stderr}`);
      assert.equal(seen.ghToken, null, `${harness}: the agent holds no token`);
      assert.equal(commandsRead(seen, path.join(custom, 'gh')), false, `${harness}: the original gh config stays hidden`);
    }
  }
});

test('a push counts as local only when every URL git would use is local, so rewriting cannot reach another machine', (t) => {
  const h = makeRepo(t);
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  const away = 'https://127.0.0.1:9/away.git';
  // A fixture repo the agent may write, with a rewrite rule and a remote
  // whose second push URL is on another machine.
  const fx = path.join(h.base, 'fx');
  h.git(['init', '-q', fx]);
  h.git(['-C', fx, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  h.git(['-C', fx, 'remote', 'add', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', local]);
  h.git(['-C', fx, 'remote', 'set-url', '--add', '--push', 'two', away]);
  h.git(['-C', fx, 'remote', 'add', 'loc', local]);
  h.git(['-C', fx, 'remote', 'add', 'up', away]);
  const rewritten = path.join(h.base, 'rewritten.git');
  const cases = [
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/plain'], ALLOW],
    [['git', '-C', fx, 'push', 'loc', 'HEAD:refs/heads/named'], ALLOW],
    // An abbreviated option takes the next argument as its value; any option
    // voids the local exception, so `loc` cannot vouch for `up`.
    [['git', '-C', fx, 'push', '--push-opt', 'loc', 'up', 'HEAD:refs/heads/x', '--force'], 126],
    [['git', '-C', fx, '-c', `url.${away}.insteadOf=${rewritten}`, 'push', rewritten, 'HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, '-c', 'remote.two.pushurl=' + away, 'push', 'two', 'HEAD'], 126],
    [['git', '-C', fx, 'config', `url.${away}.insteadOf`, rewritten], 0],
    [['git', '-C', fx, 'push', rewritten, '+HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, 'push', 'two', '+HEAD:refs/heads/x'], 126],
    [['git', '-C', fx, 'config', '--unset', `url.${away}.insteadOf`], 0],
    [['git', '-C', fx, 'config', `url.${away}.pushInsteadOf`, local], 0],
    [['git', '-C', fx, 'push', local, '+HEAD:refs/heads/x'], 126],
  ];
  // Both a job that may push its branch and one that may not.
  const decided = decide(h, h.base, ['worker', 'small'], 'tower-crane/T1-probe', cases.map((c) => c[0]));
  for (const [n, job] of ['worker', 'small'].entries()) {
    const ran = decided.map((r) => r[n]);
    assert.deepEqual(ran.map((r) => r.code), cases.map((c) => c[1]), `${job}: ${JSON.stringify(ran.map((r) => [r.argv, r.why]))}`);
  }
});

test('a codex rework resumes in a fresh isolated home and finds its first session', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'codex');
  const first = spawn(h, u, 'medium');
  const home = path.join(h.state, 'homes', first.agent);
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'PLANTED-BY-AGENT\n');
  h.ok(['claim', 'T1', '--agent', first.agent]);
  h.ok(['submit', 'T1', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--agent', first.agent]);
  h.ok(['evidence', 'T1', '--type', 'review', '--fail', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', h.revision('T1'), '--agent', 'reviewer-T1-1', '--summary', 'redo']);
  h.ok(['rework', 'T1', '--reason', 'redo']);
  const next = spawn(h, u, 'medium');
  assert.equal(next.resumed, true);
  assert.equal(next.agent, first.agent);
  const seen = u.report();
  assert.ok(seen.resumed, 'codex runs exec resume');
  assert.equal(seen.home, path.join(home, 'home'), 'the resume runs in the agent\'s isolated home');
  assert.deepEqual(seen.sessions, [`rollout-${first.agent}-stub-thread.jsonl`], 'the first session is there');
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'the home was rebuilt');
});

test('a spawn started inside another agent links to the user\'s own files, so removing the parent home breaks nothing', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'claude');
  const parent = path.join(h.state, 'homes', spawn(h, u, 'small').agent);
  // A spawned orchestrator runs with its own home in these variables.
  const inside = { CLAUDE_CONFIG_DIR: parent, HOME: path.join(parent, 'home'), USERPROFILE: path.join(parent, 'home') };
  const child = path.join(h.state, 'homes', spawn(h, u, 'small', inside).agent);
  for (const f of ['.credentials.json']) assert.equal(fs.readlinkSync(path.join(child, f)), path.join(u.home, '.claude', f), f);
  assert.ok(!fs.lstatSync(path.join(child, 'home', '.gitconfig')).isSymbolicLink(), 'git config is the home\'s own file');
  const helper = JSON.parse(fs.readFileSync(path.join(child, 'settings.json'), 'utf8')).apiKeyHelper;
  assert.ok(helper.includes(path.join(u.home, '.claude', 'settings.json')), 'the helper reads the user\'s settings');
  fs.rmSync(parent, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(child, '.credentials.json'), 'utf8'), `{"token":"${SECRET}-CRED"}`, 'auth still resolves');
  assert.equal(cp.execSync(helper, { encoding: 'utf8', env: u.env }).trim(), `${SECRET}-HELPER`);
});

test('a rung opts back in to a named tool and MCP server, shown by spawn --dry-run', (t) => {
  const { h, u } = setup(t);
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'fixture-large', '--clear', 'profile', '--clear', 'effort', '--tools', '["WebFetch"]', '--mcp', '["planted"]']);
  let dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(dry.argv[dry.argv.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob,WebFetch');
  assert.ok(!dry.argv.includes('WebFetch'), 'no longer denied');
  assert.equal(dry.argv[dry.argv.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob,WebFetch,mcp__planted');
  assert.deepEqual([dry.home.tools, dry.home.mcp], [['WebFetch'], ['planted']]);
  const text = h.ok(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.match(text, /^# agent file .*tower-crane-small\.md; home .*small-T1-1; MCP servers: planted; opted-in tools: WebFetch$/m);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    assert.deepEqual(u.report().mcp, { planted: { command: 'planted-mcp', args: ['x'] } }, 'the server, without its env');
  }

  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--profile', 'fixture-main', '--clear', 'model', '--tools', '["web_search","multi_agent"]', '--mcp', '["planted"]']);
  dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!dry.argv.includes('web_search="disabled"'));
  assert.ok(!dry.argv.join(' ').includes('--disable multi_agent'));
  assert.ok(dry.argv.join(' ').includes('--enable multi_agent'));
  assert.deepEqual(dry.home.mcp, ['planted']);
  if (!NO_STUBS) {
    spawn(h, u, 'small');
    const seen = u.report();
    assert.deepEqual(seen.mcp, { planted: true });
    assert.ok(!seen.configText.includes(SECRET), 'the server env stays out');
    noSecretsCopied(h);
  }

  h.ok(['ladder', 'set', 'small', '--mcp', '["missing"]']);
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /opts in MCP server missing, but .*config\.toml defines no \[mcp_servers\.missing\]/);
  // Moving to pi drops the codex opt-ins; named on pi, they are refused.
  const pi = h.ok(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'x', '--clear', 'profile']);
  assert.match(pi, /^ladder small: moving from codex to pi dropped tools \["web_search","multi_agent"\], mcp \["missing"\], which do not fit pi$/m);
  const named = h.run(['ladder', 'set', 'small', '--tools', '["web_search"]', '--mcp', '["planted"]']);
  assert.equal(named.code, 1);
  assert.match(named.stderr, /MCP opt-ins are unsupported on pi/);
  assert.match(named.stderr, /pi tools must be built-ins/);
});

test('only the orchestrator or the owner widens a rung, a command needs the owner, and args hold only allowlisted flags', (t) => {
  const { h } = setup(t);
  isolated(h, 'small', 'claude');
  const as = (agent, flags) => h.run(['ladder', 'set', 'small', ...flags, '--agent', agent]);
  for (const flags of [['--tools', '["Agent"]'], ['--mcp', '["planted"]'], ['--args', '["--verbose"]'], ['--harness', 'command', '--command', '["sh"]', '--clear', 'model']]) {
    const r = as('worker-T1-1', flags);
    assert.equal(r.code, 1, flags.join(' '));
    assert.match(r.stderr, flags.includes('--command') ? /only the owner with an explicit identity can change ladder\.command/ : /operational: only the orchestrator or the owner/);
  }
  const command = as('orchestrator', ['--harness', 'command', '--command', '["sh"]', '--clear', 'model']);
  assert.equal(command.code, 1);
  assert.match(command.stderr, /ladder\.command, ladder\.reach are owner-required; opened D1/);
  h.ok(['ladder', 'set', 'small', '--model', 'fixture-other', '--agent', 'orchestrator']);
  assert.equal(as('orchestrator', ['--tools', '["Agent"]']).code, 0);
  assert.equal(as('owner', ['--args', '["--verbose","--max-turns","40"]']).code, 0);
  const refused = [
    ['claude', '["--dangerously-skip-permissions"]'], ['claude', '["--settings","{}"]'], ['claude', '["--setting-sources=user,project"]'],
    ['codex', '["--sandbox","danger-full-access"]'], ['codex', '["-s","danger-full-access"]'], ['codex', '["-cmodel_verbosity=low"]'],
    ['codex', '["-c","sandbox_mode=\\"danger-full-access\\""]'], ['codex', '["--ignore-rules"]'], ['codex', '["--enable","x"]'],
  ];
  for (const [harness, args] of refused) {
    if (harness === 'codex') isolated(h, 'small', 'codex');
    const r = as('owner', ['--args', args]);
    assert.equal(r.code, 1, args);
    assert.match(r.stderr, /args may only use .*; refused /, args);
  }
  assert.equal(as('owner', ['--args', '["-c","model_reasoning_effort=\\"high\\"","--disable","memories","--skip-git-repo-check"]']).code, 0);
});

test('TOML tables have no prototype, so __proto__ and inherited names are plain keys', () => {
  const doc = TOML.parse('a.__proto__.polluted = true\nconstructor = 1\ntoString = 2\n[__proto__]\nx = 1\n[[b]]\n__proto__ = 3\n');
  assert.equal(({}).polluted, undefined, 'Object.prototype is untouched');
  assert.deepEqual(Object.keys(doc), ['a', 'constructor', 'toString', '__proto__', 'b']);
  assert.equal(doc.constructor, 1);
  assert.equal(Object.getPrototypeOf(doc), null);
  assert.equal(doc.a.__proto__.polluted, true);
});

test('claude, codex, opencode, agy and pi rungs dispatch through spawn, never as native subagents', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'tower-crane', 'SKILL.md'), 'utf8');
  const ladder = fs.readFileSync(path.join(ROOT, 'docs', 'ladder.md'), 'utf8');
  for (const text of [skill, ladder]) {
    assert.match(text, /A rung on claude, codex, opencode, agy or pi always runs through `tower-crane spawn`/);
    assert.doesNotMatch(text, /dispatch natively with (that|the) rung's model/);
  }
});

test('each role has an agent file that states its tools, MCP servers, skills, web, git push, gh writes and outside paths', () => {
  const components = JSON.parse(fs.readFileSync(path.join(ROOT, 'components.json'), 'utf8'));
  for (const job of ['worker', 'reviewer', 'small', 'orchestrator']) {
    assert.ok(components.agents.includes(`tower-crane-${job}`), `components.json registers tower-crane-${job}`);
    const a = A.load(job);
    assert.deepEqual(a.mcpServers, [], `${job}: no MCP servers by default`);
    assert.deepEqual(a.tools.filter((x) => a.disallowedTools.includes(x)), [], `${job}: a tool is not both allowed and denied`);
    // Claude Code reads disallowedTools directly for native agents, so it
    // has to spell out every denial the other fields state.
    const derived = [
      ...(a.web ? [] : ['WebFetch', 'WebSearch']),
      ...(a.gitPush === 'none' ? ['Bash(git push:*)'] : ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)']),
    ];
    for (const d of derived) assert.ok(a.disallowedTools.includes(d), `${job}: disallowedTools lacks ${d}`);
    for (const g of a.ghWrite) assert.ok(!a.disallowedTools.includes(`Bash(gh ${g}:*)`), `${job}: ${g} is both allowed and denied`);
    assert.ok(A.policy(a).gh.includes('pr view') && a.ghWrite.every((g) => A.policy(a).gh.includes(g)), `${job}: the gh allowlist is reads plus ghWrite`);
  }
  // The parsed config the codex filter works on survives a round trip.
  const doc = TOML.parse('a = 1\n[b]\nc = { d = [1, "x"] }\n');
  assert.deepEqual(TOML.parse(TOML.stringify(doc)), doc);
  // Prefixed integers keep their base.
  assert.deepEqual({ ...TOML.parse('o = 0o17\nx = 0x1F\nb = 0b101\nd = 1_000\n') }, { o: 15, x: 31, b: 5, d: 1000 });
});

// TOML forbids every control character raw in a basic string but tab, DEL
// included. A path codex's profile names can hold any of them, and one raw
// DEL made codex reject the whole config.
test('TOML strings and keys escape every control character TOML forbids raw, DEL included', () => {
  const forbidden = /[\x00-\x08\x0a-\x1f\x7f]/;
  for (let c = 0; c < 0x80; c++) {
    if (c >= 0x20 && c < 0x7f) continue;
    const ch = String.fromCharCode(c);
    const doc = { [`/var/tmp/a${ch}b`]: `v${ch}w` };
    const text = TOML.stringify({ t: doc });
    for (const line of text.split('\n')) assert.doesNotMatch(line, forbidden, `U+${c.toString(16).padStart(4, '0')} stays escaped`);
    assert.deepEqual({ ...TOML.parse(text).t }, doc, `U+${c.toString(16).padStart(4, '0')} reads back`);
  }
  assert.throws(() => TOML.stringify({ k: 'a\ud800b' }), /lone surrogate/);
  assert.deepEqual({ ...TOML.parse(TOML.stringify({ k: 'a\u{1f600}b' })) }, { k: 'a\u{1f600}b' });
});

// readAround lists the entries of the directories on the way to a runtime
// directory, and codex binds each again for every command, following a link.
// An entry stays listed only when nobody but root and the user can swap it.
test('the codex profile lists an entry beside the runtime directory only when nobody else can turn it into a link', () => {
  const me = 1000;
  const st = (uid, mode, link = false) => ({ uid, mode, isSymbolicLink: () => link });
  const dir = 0o40755, sticky = 0o41777, open = 0o40777, group = 0o40775, file = 0o100644;
  const cases = [
    ['root directory, root entry', st(0, dir), st(0, file), true],
    ['root directory, own entry', st(0, dir), st(me, file), true],
    ['sticky world-writable directory, own entry', st(0, sticky), st(me, dir), true],
    ['sticky world-writable directory, root entry', st(0, sticky), st(0, dir), true],
    ['sticky world-writable directory, another user\'s entry', st(0, sticky), st(1001, dir), false],
    ['root directory, another user\'s entry', st(0, dir), st(1001, file), false],
    ['world-writable directory without the sticky bit', st(0, open), st(0, file), false],
    ['group-writable directory without the sticky bit', st(0, group), st(me, file), false],
    ['another user\'s directory', st(1001, dir), st(me, file), false],
    ['a link', st(0, dir), st(me, 0o120777, true), false],
    ['an unreadable directory', null, st(me, file), false],
  ];
  for (const [what, parent, entry, listed] of cases) assert.equal(A.steadyEntry(parent, entry, me), listed, what);
});
