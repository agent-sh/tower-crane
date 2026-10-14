'use strict';

// Runs the real claude CLI, so it costs a model call and needs a logged-in
// claude: set TOWER_CRANE_LIVE_CLAUDE=1 to run it (TOWER_CRANE_LIVE_MODEL picks the
// model explicitly). It proves what a stub cannot: a command in a
// spawned agent's sandbox cannot reach a unix socket in a directory the
// sandbox denies, even with the socket filter off.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { pinLiveRung, makeRepo, BIN, ROOT } = require('./helpers');

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const runDir = uid === null ? null : `/run/user/${uid}`;
const skip = process.env.TOWER_CRANE_LIVE_CLAUDE !== '1' ? 'set TOWER_CRANE_LIVE_CLAUDE=1 to run against the real claude CLI'
  : !runDir || !fs.existsSync(runDir) ? `${runDir || '/run/user/<uid>'} does not exist here` : false;

// The owner's claude login. spawn links its credentials into each agent's home,
// so a live agent starts logged in only when its repository's user config is this dir.
const claudeConfig = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
function login(h) {
  h.env.CLAUDE_CONFIG_DIR = claudeConfig;
  return h;
}

// The same for codex: spawn filters the owner's codex config, profiles
// included, into each agent's home and links its login.
const codexConfig = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
function codexLogin(h) {
  h.env.CODEX_HOME = codexConfig;
  return h;
}

// The agent's commands write nothing outside the worktree, and the state
// directory is read-only, so a probe writes its result to a directory the
// project's sandbox extension adds.
function results(h) {
  const dir = path.join(h.base, 'results');
  fs.mkdirSync(dir);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [dir] })]);
  return dir;
}

// What the agent did, for a failure message.
function agentLog(h) {
  const dir = path.join(h.state, 'logs');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `--- ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').slice(-4000)}`).join('\n') : 'no agent log';
}

const node = JSON.stringify(process.execPath);

// Every live agent runs in its test's own repository, so the checkout the
// suite runs from gains no files (a sandboxed claude leaves empty mount
// points for protected dotfiles in its working directory).
function untracked() {
  const r = cp.spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? new Set(r.stdout.split('\n').filter((l) => l.startsWith('?? '))) : null;
}

if (process.env.TOWER_CRANE_LIVE_CLAUDE === '1' || process.env.TOWER_CRANE_LIVE_CODEX === '1') {
  let before;
  test.before(() => {
    before = untracked();
  });
  test.after(() => {
    const after = untracked();
    if (!before || !after) return;
    assert.deepEqual([...after].filter((l) => !before.has(l)), [], `the live agents wrote into ${ROOT}`);
  });
}

test('a sandboxed claude command cannot connect to a unix socket in a denied directory', { skip, timeout: 300000 }, async (t) => {
  const h = login(makeRepo(t));
  h.init();
  h.ok(['task', 'add', '--title', 'Socket probe', '--acceptance', 'no connection']);
  const sock = path.join(runDir, `tower-crane-probe-${process.pid}.sock`);
  const probe = path.join(results(h), 'socket-probe');
  let connections = 0;
  const server = net.createServer((c) => {
    connections++;
    c.on('error', () => {});
    c.end('HELLO\n');
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  const script = `const n=require("net"),f=require("fs");n.connect(${JSON.stringify(sock)}).on("connect",()=>{f.writeFileSync(${JSON.stringify(probe)},"CONNECTED");process.exit(0)}).on("error",e=>{f.writeFileSync(${JSON.stringify(probe)},"ERR "+e.code);process.exit(1)})`;
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly this one command with the Bash tool, then reply with its exit code. Do not use tower-crane.\n\n${node} -e '${script}'\n`,
  });
  pinLiveRung(h, 'claude');
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
  assert.ok(fs.existsSync(probe), `the command ran\n${agentLog(h)}`);
  assert.match(fs.readFileSync(probe, 'utf8'), /^ERR /);
  assert.equal(connections, 0, 'nothing reached the socket');
});

test('in a real claude sandbox with sandbox.session_bus, a command connects to the bus socket', { skip: process.env.TOWER_CRANE_LIVE_CLAUDE !== '1' && 'set TOWER_CRANE_LIVE_CLAUDE=1 to run against the real claude CLI', timeout: 300000 }, async (t) => {
  const h = login(makeRepo(t));
  h.init();
  h.ok(['task', 'add', '--title', 'Bus probe', '--acceptance', 'bus reachable']);
  // The bus is a socket in a runtime directory of the test's own, so the probe never touches the user's session.
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(runtime);
  const sock = path.join(runtime, 'bus');
  const probe = path.join(results(h), 'bus-probe');
  let connections = 0;
  const server = net.createServer((c) => {
    connections++;
    c.on('error', () => {});
    c.end();
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  const script = `const n=require("net"),f=require("fs");n.connect(${JSON.stringify(sock)}).on("connect",()=>{f.writeFileSync(${JSON.stringify(probe)},"CONNECTED");process.exit(0)}).on("error",e=>{f.writeFileSync(${JSON.stringify(probe)},"ERR "+e.code);process.exit(1)})`;
  h.ok(['project', 'set', '--session-bus', 'true']);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly this one command with the Bash tool, then reply with its exit code. Do not use tower-crane.\n\n${node} -e '${script}'\n`,
  });
  pinLiveRung(h, 'claude');
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait'], {
    env: { ...h.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${sock}` },
  });
  assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
  assert.ok(fs.existsSync(probe), `the command ran\n${agentLog(h)}`);
  assert.equal(fs.readFileSync(probe, 'utf8'), 'CONNECTED', `the command reached the bus socket\n${agentLog(h)}`);
  assert.ok(connections >= 1, 'the socket accepted the command');
});

test('in a real claude sandbox a forged state edit fails and the CLI writes through the broker', { skip: process.env.TOWER_CRANE_LIVE_CLAUDE !== '1' && 'set TOWER_CRANE_LIVE_CLAUDE=1 to run against the real claude CLI', timeout: 300000 }, async (t) => {
  const h = login(makeRepo(t));
  h.init();
  h.ok(['task', 'add', '--title', 'Forge probe', '--acceptance', 'only the broker writes']);
  const events = path.join(h.state, 'events.jsonl');
  const before = fs.readFileSync(events, 'utf8');
  const probe = path.join(results(h), 'forge-probe');
  const forge = `const f=require("fs");try{f.appendFileSync(${JSON.stringify(events)},"{}\\n");f.writeFileSync(${JSON.stringify(probe)},"WROTE")}catch(e){f.writeFileSync(${JSON.stringify(probe)},"ERR "+e.code)}`;
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly these two commands with the Bash tool, one after the other, then reply with their exit codes.\n\n${node} -e '${forge}'\n\n${node} ${JSON.stringify(BIN)} task note T1 through-the-broker\n`,
  });
  pinLiveRung(h, 'claude');
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
  assert.ok(fs.existsSync(probe), `the forge command ran\n${agentLog(h)}`);
  assert.match(fs.readFileSync(probe, 'utf8'), /^ERR /, 'the sandbox refused the direct write');
  assert.ok(!fs.readFileSync(events, 'utf8').slice(before.length).split('\n').includes('{}'), 'no forged line');
  const note = h.readState('tasks.json').tasks[0].notes.find((n) => n.text === 'through-the-broker');
  assert.equal(note?.agent, 'small-T1-1', `the broker wrote it as the spawned agent\n${agentLog(h)}`);
});

// Codex's sandbox refuses connect() on a Unix socket, so its broker listens
// on TCP loopback. Runs the real codex CLI: set TOWER_CRANE_LIVE_CODEX=1
// (TOWER_CRANE_LIVE_PROFILE picks the profile explicitly).
test('in a real codex sandbox forged state edits fail and the CLI writes through the broker over loopback', { skip: process.env.TOWER_CRANE_LIVE_CODEX !== '1' && 'set TOWER_CRANE_LIVE_CODEX=1 to run against the real codex CLI', timeout: 300000 }, async (t) => {
  const h = codexLogin(makeRepo(t));
  h.init();
  h.ok(['task', 'add', '--title', 'Forge probe', '--acceptance', 'only the broker writes']);
  const files = ['events.jsonl', 'tasks.json', 'project.json'].map((f) => path.join(h.state, f));
  const probe = path.join(results(h), 'forge-probe');
  const forge = `const f=require("fs");const out=${JSON.stringify(files)}.map(p=>{try{f.appendFileSync(p,"{}\\n");return "WROTE"}catch(e){return "ERR "+e.code}});f.writeFileSync(${JSON.stringify(probe)},JSON.stringify(out))`;
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `Sandbox probe set up by the owner. Run exactly these two commands with your command tool, one after the other, then reply with their exit codes and stop.\n\n${node} -e '${forge}'\n\n${node} ${JSON.stringify(BIN)} task note T1 through-the-broker\n`,
  });
  pinLiveRung(h, 'codex');
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait']);
  assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
  assert.ok(fs.existsSync(probe), `the forge command ran\n${agentLog(h)}`);
  const out = JSON.parse(fs.readFileSync(probe, 'utf8'));
  for (const [i, f] of files.entries()) {
    assert.match(out[i], /^ERR /, `the sandbox refused writing ${path.basename(f)}`);
    assert.ok(!fs.readFileSync(f, 'utf8').split('\n').includes('{}'), `no forged line in ${path.basename(f)}`);
  }
  const note = h.readState('tasks.json').tasks[0].notes.find((n) => n.text === 'through-the-broker');
  assert.equal(note?.agent, 'small-T1-1', `the broker wrote it as the spawned agent\n${agentLog(h)}`);
  const event = fs.readFileSync(files[0], 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.cmd === 'task note');
  assert.deepEqual([event?.agent, event?.via], ['small-T1-1', 'broker']);
});

// A real agent of each harness, with the user's own home as the original
// home, reads none of the user's credential files or a file planted in the
// home, and still runs node, npm install and a git push: a small agent, whose
// worktree is read-only, and a worker. Writes stay in the test's
// directories: the cache is redirected, and results land in a directory the
// project's sandbox extension adds.
for (const [harness, rung] of [['claude', 'small'], ['claude', 'easy'], ['codex', 'small'], ['codex', 'easy']]) {
  const flag = `TOWER_CRANE_LIVE_${harness.toUpperCase()}`;
  test(`a real ${harness} ${rung} sandbox reads nothing in the user's home but what the agent needs`, { skip: process.env[flag] !== '1' && `set ${flag}=1 to run against the real ${harness} CLI`, timeout: 300000 }, async (t) => {
    const h = makeRepo(t);
    h.init();
    h.ok(['task', 'add', '--title', 'Home probe', '--acceptance', 'no credential is read']);
    const home = require('node:os').homedir();
    const secret = path.join(home, `tower-crane-secret-test-${process.pid}`);
    fs.writeFileSync(secret, 'PLANTED-HOME-SECRET\n', { mode: 0o600 });
    t.after(() => fs.rmSync(secret, { force: true }));
    const dir = results(h);
    const out = path.join(dir, 'home-probe.json');
    const pkg = path.join(dir, 'pkg');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"probe","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}\n');
    fs.writeFileSync(path.join(pkg, 'probe.test.js'), "require('node:test')('runs', () => {});\n");
    const repo = path.join(dir, 'repo');
    const bare = path.join(dir, 'bare.git');
    for (const args of [['init', '-q', '--bare', bare], ['init', '-q', repo], ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'probe']]) h.git(args);
    const targets = Object.fromEntries(['.config/gh', '.claude/.credentials.json', '.codex/auth.json', '.aws', '.docker/config.json', '.npmrc', '.netrc']
      .map((p) => [p, path.join(home, p)]).concat([['secret-test', secret]]));
    const script = `const fs=require("fs"),cp=require("child_process");const o={};for(const[k,p]of Object.entries(${JSON.stringify(targets)})){try{const s=fs.statSync(p);if(s.isDirectory())fs.readdirSync(p);else fs.readFileSync(p);o[k]="READABLE"}catch(e){o[k]="ERR "+e.code}}`
      + `const run=(c,a,cwd)=>cp.spawnSync(c,a,{cwd,encoding:"utf8"}).status;o.node=process.version;`
      + `o.npm=run("npm",["install","--no-audit","--no-fund","--cache",${JSON.stringify(path.join(dir, 'npm-cache'))}],${JSON.stringify(pkg)});`
      + `o.test=run("npm",["test"],${JSON.stringify(pkg)});`
      + `o.push=run("git",["push",${JSON.stringify(bare)},"HEAD:refs/heads/probe"],${JSON.stringify(repo)});fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(o))`;
    h.ok(['brief', 'set', 'T1', '-'], {
      input: `Sandbox probe set up by the owner. Run exactly this one command with your command tool, then reply with its exit code and stop. Do not use tower-crane.\n\n${node} -e '${script}'\n`,
    });
    pinLiveRung(h, harness, rung);
    const env = { ...h.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CACHE_HOME: path.join(h.base, 'cache') };
    const r = await h.runAsync(['spawn', '--role', rung, '--task', 'T1', '--wait'], { env });
    // A model that refuses the prompt never runs the command, so the sandbox
    // gave no verdict: a skip, not a pass or a sandbox failure.
    if (r.code !== 0 && !fs.existsSync(out) && /"stop_reason":"refusal"/.test(`${r.stderr}\n${agentLog(h)}`)) {
      t.skip(`${harness} ${rung}: the model refused the probe prompt; no sandbox verdict`);
      return;
    }
    assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
    assert.ok(fs.existsSync(out), `the probe ran\n${agentLog(h)}`);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`${harness} ${rung} home probe: ${JSON.stringify(seen)}`);
    for (const k of Object.keys(targets)) assert.match(seen[k], /^ERR /, `${harness} ${rung}: ~/${k} is not readable`);
    assert.equal(seen.npm, 0, 'npm install runs');
    assert.equal(seen.test, 0, 'npm test runs node --test');
    assert.equal(seen.push, 0, 'git push to a local repository runs');
    assert.equal(h.git(['--git-dir', bare, 'rev-parse', 'probe']), h.git(['-C', repo, 'rev-parse', 'HEAD']));
  });
}

// Files a command could read once the sandbox started: whatever is made in
// the user's home after spawn, at the top or in a new directory, and in a
// directory on the way from the home to a read-only worktree, stays hidden.
// The command writes `ready` and waits for `go`, so the test makes them after
// the sandbox around that very command is up. Seen 2026-10-14: a claude small
// agent's sandbox hid only the entries each such directory held at spawn, and
// read all three. Codex mounts only the paths its profile names. The fixture
// must sit under the home (TOWER_CRANE_TEST_TMP under ~/.cache, the default).
for (const harness of ['claude', 'codex']) {
  const flag = `TOWER_CRANE_LIVE_${harness.toUpperCase()}`;
  test(`a real ${harness} small sandbox hides files made in the user's home after it starts`, { skip: process.env[flag] !== '1' && `set ${flag}=1 to run against the real ${harness} CLI`, timeout: 300000 }, async (t) => {
    const home = fs.realpathSync(os.homedir());
    const h = makeRepo(t);
    if (!h.base.startsWith(home + path.sep)) {
      t.skip(`the fixture ${h.base} is outside the home ${home}`);
      return;
    }
    h.init();
    h.ok(['task', 'add', '--title', 'Late home probe', '--acceptance', 'no late file is read']);
    const dir = results(h);
    const ready = path.join(dir, 'ready');
    const go = path.join(dir, 'go');
    const out = path.join(dir, 'late-probe.json');
    const tag = `tower-crane-late-${harness}-${process.pid}`;
    const targets = {
      home: path.join(home, tag),
      newDir: path.join(home, `${tag}-dir`, 'token'),
      config: path.join(home, '.config', tag, 'token'),
      onPath: path.join(path.dirname(h.base), tag),
    };
    t.after(() => {
      for (const p of Object.values(targets)) fs.rmSync([home, path.dirname(h.base)].includes(path.dirname(p)) ? p : path.dirname(p), { recursive: true, force: true });
    });
    const script = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(ready)},"1");const s=new Int32Array(new SharedArrayBuffer(4));`
      + `for(let i=0;i<1200&&!fs.existsSync(${JSON.stringify(go)});i++)Atomics.wait(s,0,0,100);const o={go:fs.existsSync(${JSON.stringify(go)})};`
      + `for(const[k,p]of Object.entries(${JSON.stringify(targets)})){try{fs.readFileSync(p);o[k]="READABLE"}catch(e){o[k]="ERR "+e.code}}`
      + `try{fs.readdirSync(".");o.worktree="READABLE"}catch(e){o.worktree="ERR "+e.code}fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(o))`;
    h.ok(['brief', 'set', 'T1', '-'], {
      input: `Sandbox probe set up by the owner. Run exactly this one command with your command tool, then reply with its exit code and stop. It waits up to two minutes for a signal file; let it finish. Do not use tower-crane.\n\n${node} -e '${script}'\n`,
    });
    pinLiveRung(h, harness, 'small');
    // Codex grants its temp directory, so temp must not hold the fixture.
    const tmp = path.join(h.base, 'agent-tmp');
    fs.mkdirSync(tmp);
    const env = { ...h.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CACHE_HOME: path.join(h.base, 'cache'), TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    let done = false;
    const run = h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env }).finally(() => { done = true; });
    // The command's own signal; the spawn ending first means it never ran.
    while (!done && !fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 100));
    if (fs.existsSync(ready)) {
      for (const p of Object.values(targets)) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, 'PLANTED-LATE-SECRET\n', { mode: 0o600 });
      }
      fs.writeFileSync(go, '1');
    }
    const r = await run;
    if (r.code !== 0 && !fs.existsSync(out) && /"stop_reason":"refusal"/.test(`${r.stderr}\n${agentLog(h)}`)) {
      t.skip(`${harness} small: the model refused the probe prompt; no sandbox verdict`);
      return;
    }
    assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
    assert.ok(fs.existsSync(out), `the probe ran\n${agentLog(h)}`);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    console.log(`${harness} small late home probe: ${JSON.stringify(seen)}`);
    assert.equal(seen.go, true, 'the files were made while the command ran');
    assert.equal(seen.worktree, 'READABLE');
    for (const k of Object.keys(targets)) assert.match(seen[k], /^ERR /, `${harness} small: ${targets[k]}, made after the sandbox started, is not readable`);
    // The placeholders claude bound in the read-only worktree are gone again.
    const trees = path.join(h.base, 'repo-worktrees');
    for (const name of fs.readdirSync(trees).filter((n) => n !== '.git-admin')) {
      assert.equal(h.git(['-C', path.join(trees, name), 'status', '--porcelain', '--untracked-files=all']), '', `${name} is left clean`);
    }
  });
}

// Codex hands its sandbox the permission profile as one argument, which
// Linux caps at 128 KiB. A home in a directory of thousands of entries (a
// test's temp directory under ~/.cache, or /home on a shared host) once grew
// the profile past it, and codex failed with "Argument list too long (os
// error 7)". A stand-in harness runs the real `codex sandbox` with the
// profile spawn wrote, so no model call is made.
function realCodexSandbox() {
  if (process.env.TOWER_CRANE_LIVE_CODEX !== '1') return 'set TOWER_CRANE_LIVE_CODEX=1 to run against the real codex CLI';
  if (process.platform !== 'linux') return 'the probe covers the Linux sandbox';
  const r = cp.spawnSync('codex', ['sandbox', '--', 'true'], { encoding: 'utf8', timeout: 60000, cwd: process.env.TOWER_CRANE_TEST_TMP || undefined });
  if (r.error?.code === 'ENOENT') return 'codex is not on PATH';
  return r.status === 0 ? false : `codex sandbox does not start here: ${String(r.stderr).trim().split('\n').pop()}`;
}

test('a real codex sandbox starts for a home among 5,000 entries and reads nothing beside it but what the agent needs', { skip: realCodexSandbox(), timeout: 300000 }, async (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Wide probe', '--acceptance', 'codex starts']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'wide probe\n' });
  const home = h.env.HOME;
  for (const dir of [h.base, home]) {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5000; i++) fs.mkdirSync(path.join(dir, `entry-${i}`));
  }
  const secret = path.join(home, 'secret-test');
  fs.writeFileSync(secret, 'PLANTED-HOME-SECRET\n', { mode: 0o600 });
  const out = path.join(results(h), 'wide-probe.json');
  const targets = { secret, beside: path.join(h.base, 'entry-0'), worktree: '.', state: path.join(h.state, 'tasks.json') };
  const script = `const fs=require("fs");const o={node:process.version};for(const[k,p]of Object.entries(${JSON.stringify(targets)})){try{const s=fs.statSync(p);if(s.isDirectory())fs.readdirSync(p);else fs.readFileSync(p);o[k]="READABLE"}catch(e){o[k]="ERR "+e.code}}fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(o))`;
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const cp = require('node:child_process');
const path = require('node:path');
const PATH = process.env.PATH.split(path.delimiter).filter((d) => path.resolve(d) !== ${JSON.stringify(bin)}).join(path.delimiter);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'probe' }) + '\\n');
const r = cp.spawnSync('codex', ['sandbox', '-c', 'default_permissions="tower-crane"', '--', process.execPath, '-e', ${JSON.stringify(script)}], { env: { ...process.env, PATH }, encoding: 'utf8' });
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  h.ok(['ladder', 'set', 'small', '--harness', 'codex', '--model', 'probe', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  // Temp is writable in codex's sandbox, so it must not hold the home here.
  const tmp = path.join(h.base, 'agent-tmp');
  fs.mkdirSync(tmp);
  const r = await h.runAsync(['spawn', '--role', 'small', '--task', 'T1', '--wait'],
    { env: { ...h.env, PATH: `${bin}${path.delimiter}${h.env.PATH}`, TMPDIR: tmp, TMP: tmp, TEMP: tmp } });
  assert.equal(r.code, 0, `${r.stderr}\n${agentLog(h)}`);
  assert.ok(fs.existsSync(out), `the probe ran\n${agentLog(h)}`);
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  console.log(`codex wide-home probe: ${JSON.stringify(seen)}`);
  assert.match(seen.secret, /^ERR /, 'the planted file in the home is hidden');
  assert.match(seen.beside, /^ERR /, 'an entry beside the home is hidden');
  assert.equal(seen.worktree, 'READABLE');
  assert.equal(seen.state, 'READABLE');
});
