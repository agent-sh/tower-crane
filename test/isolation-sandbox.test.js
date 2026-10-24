'use strict';

// What each sandbox lets a spawned agent read and write: the home, hidden links
// and credential stores, socket leaves, temp directories, the codex profile and
// the Tower Crane code. isolation-installs.test.js has the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginRoot, shortCacheRoot, ROOT, BIN, TMP_ROOT } = require('./helpers');
const A = require('../lib/agents');
const TOML = require('../lib/toml');
const ClaudeSandboxPlaceholders = require('../lib/claude-sandbox-placeholders');
const { NO_STUBS, SECRET, plant, setup, spawn, isolated, commandsRead, commandsWrite } = require('./isolation-helpers');

// What T106's credential table missed, with no entry for any of it now: an
// arbitrary dotfile, an env-pointed file, OpenCode and Azure logins.
const HOME_SECRETS = ['.config/gh/hosts.yml', '.claude/.credentials.json', '.codex/auth.json', '.aws/credentials',
  '.docker/config.json', '.npmrc', '.netrc', 'secret-test', '.local/share/opencode/auth.json', '.azure/msal_token_cache.json',
  '.config/tower-crane/config.json', '.sometool/token', 'custom/aws-credentials'];

test('claude and codex sandboxes deny the user\'s home except the paths the agent needs', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const secrets = HOME_SECRETS.map((p) => path.join(u.home, p));
  for (const f of secrets.filter((f) => !fs.existsSync(f))) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // The fixture's user file is the one in the home, so the CLI still reads it.
    fs.writeFileSync(f, f === h.userConfig ? JSON.stringify({ secret: `${SECRET}-HOME` }) : `${SECRET}-HOME\n`);
  }
  // A project names a tool directory under the home its agents need.
  const tool = path.join(u.home, 'tools', 'bin', 'tool.sh');
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, '#!/bin/sh\n');
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: ['~/tools'] })]);
  const env = { AWS_SHARED_CREDENTIALS_FILE: path.join(u.home, 'custom', 'aws-credentials') };
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const rule = path.join(u.home, harness === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md');
    const open = [tool, rule, path.join(wt, '.claude', 'settings.local.json')];
    const started = spawn(h, u, 'hard', { ...env, STUB_READ: JSON.stringify([...secrets, ...open]) });
    const seen = u.report();
    for (const f of secrets) assert.equal(commandsRead(seen, f), false, `${harness}: ${path.relative(u.home, f)} is hidden`);
    const scratch = h.readState('tasks.json').tasks[0].scratch;
    assert.ok(scratch.startsWith(u.home + path.sep), 'the task scratch is under the home');
    for (const p of [...open, scratch, path.join(h.state, 'tasks.json'), path.join(h.state, 'brokers', started.agent, 'broker.json')]) {
      assert.equal(commandsRead(seen, p), true, `${harness}: ${p} stays readable`);
    }
    assert.equal(commandsRead(seen, path.join(h.state, 'brokers', 'worker-T9-1', 'broker.json')), false, `${harness}: another agent's token is hidden`);
    if (harness === 'claude') {
      // A file made in the home after spawn is hidden too: the home is denied whole.
      assert.ok(seen.settings.sandbox.filesystem.denyRead.includes(fs.realpathSync(u.home)));
      for (const r of seen.reads) assert.equal(r.denied, !open.includes(r.file), `claude ${r.tool} ${r.file}`);
    } else {
      const rules = seen.config.permissions['tower-crane'].filesystem;
      assert.equal(rules[':root'], undefined, 'codex: nothing is read through the root');
      assert.equal(rules[':minimal'], 'read', 'codex: the system directories come from :minimal');
      const none = Object.keys(rules).filter((p) => rules[p] === 'none');
      assert.deepEqual(none.filter((p) => none.some((d) => p !== d && p.startsWith(d + path.sep))), [], 'codex: no hidden path inside another');
    }
  }
});

test('claude and codex keep a link inside a hidden directory and its target hidden; codex names no hidden path inside another', { skip: NO_STUBS }, t => {
  // Seen 2026-10-12: ~/.claude/debug/latest links to a file in the same hidden
  // directory, and Codex's bwrap could not mount over it inside the masked parent.
  const { h, u } = setup(t);
  const debug = path.join(u.home, '.claude', 'debug');
  fs.mkdirSync(debug, { recursive: true });
  fs.writeFileSync(path.join(debug, 'session.txt'), 'log\n');
  fs.symlinkSync(path.join(debug, 'session.txt'), path.join(debug, 'latest'));
  const project = h.readState('project.json');
  const secrets = [path.join(debug, 'latest'), path.join(debug, 'session.txt'), path.join(u.home, '.config', 'tower-crane', 'owner', 'key')];
  for (const harness of ['claude', 'codex']) {
    h.writeState('project.json', project);
    isolated(h, 'small', harness);
    // The owner key directory sits inside ~/.config.
    const { owner_config_dir: _, ...unbound } = project;
    h.writeState('project.json', unbound);
    spawn(h, u, 'small', { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: '' });
    const seen = u.report();
    for (const p of secrets) assert.equal(commandsRead(seen, p), false, `${harness}: ${p} stays hidden`);
    if (harness === 'codex') {
      const rules = seen.config.permissions['tower-crane'].filesystem;
      const hidden = Object.keys(rules).filter(p => rules[p] === 'none');
      const nested = hidden.filter(p => hidden.some(dir => p !== dir && p.startsWith(dir + path.sep)));
      assert.deepEqual(nested, [], 'no hidden path is named inside a hidden directory');
    }
  }
});

test('a project sandbox path inside a hidden credential store, or a writable one holding it, refuses dispatch', { skip: NO_STUBS }, t => {
  // A path inside a hidden store reopens what lies under it: codex mounts
  // writable paths after hidden ones, and claude remounts an allowed path
  // inside a denied one. A writable path holding a store keeps it masked for
  // the run, but in codex the agent can rename a directory between the two
  // and so move the store out from under the next spawn's mask.
  const { h, u } = setup(t);
  const owner = path.join(path.dirname(h.userConfig), 'owner');
  const refused = [
    ['write', path.join(h.state, 'brokers', 'worker-T9-1'), 'is inside'],
    ['write', path.join(h.state, 'homes', 'worker-T9-1', 'home', '.aws'), 'is inside'],
    ['read', owner, 'is inside'],
    ['write', h.state, 'holds'],
    ['write', path.dirname(owner), 'holds'],
  ];
  for (const [field, p, why] of refused) {
    fs.mkdirSync(p, { recursive: true });
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ [field]: [p] })]);
    for (const harness of ['claude', 'codex']) {
      isolated(h, 'hard', harness);
      fs.rmSync(u.out, { force: true });
      const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
      assert.notEqual(r.code, 0, `${harness}: sandbox.${field} ${p} must refuse dispatch`);
      assert.match(r.stderr, new RegExp(`sandbox\\.${field} path .* ${why} .* which the sandbox hides because it holds credentials`));
      assert.ok(!fs.existsSync(u.out), `${harness}: the harness must not start`);
    }
  }
  // A readable path holding a store keeps it hidden: the deeper mask wins.
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: [h.state, path.dirname(owner)] })]);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    spawn(h, u, 'hard');
    const seen = u.report();
    for (const f of [path.join(owner, 'key'), path.join(h.state, 'brokers', 'worker-T9-1', 'broker.json')]) {
      assert.equal(commandsRead(seen, f), false, `${harness}: ${f} stays hidden under a readable parent`);
    }
  }
});

test('worker sandboxes grant their short socket leaf without granting writes to siblings', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    spawn(h, u, 'hard');
    const seen = u.report();
    const dir = seen.socketDir;
    assert.ok(dir, `${harness}: the environment names the granted directory`);
    assert.ok(Buffer.byteLength(path.join(dir, 'tc-XXXXXX', 's')) <= 103, dir);
    if (harness === 'claude') assert.ok(seen.settings.sandbox.filesystem.allowRead.includes(dir), 'Claude reopens the socket leaf inside its hidden runtime root');
    assert.equal(commandsRead(seen, path.join(dir, 's')), true, `${harness}: the socket leaf is readable`);
    assert.equal(commandsWrite(seen, wt, common, path.join(dir, 's')), true, `${harness}: the socket leaf is writable`);
    const sibling = path.join(path.dirname(dir), 'tower-crane-another-worker', 's');
    assert.equal(commandsWrite(seen, wt, common, sibling), false, `${harness}: sibling sockets stay unwritable`);
    assert.equal(fs.existsSync(dir), false, `${harness}: an exited broker removes its leaf`);
  }
});

test('under a deep temp root, runtime directory and agent home the broker starts, and its sandboxed agent reaches it through a socket within the limit', { skip: NO_STUBS }, (t) => {
  const { MAX_SOCKET_PATH } = require('../lib/socket-path');
  const root = path.join(TMP_ROOT, 'r'.repeat(MAX_SOCKET_PATH));
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { h, u } = setup(t, { root });
  const deep = (name) => {
    const dir = path.join(h.base, name, 'd'.repeat(MAX_SOCKET_PATH));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const runtime = deep('runtime');
  const cli = (...args) => [process.execPath, BIN, ...args];
  const address = [process.execPath, '-e', 'process.stderr.write(require("fs").readFileSync(process.env.TOWER_CRANE_BROKER, "utf8"))'];
  // A short TMPDIR is passed over too: no socket goes under TMPDIR.
  for (const [label, tmp] of [['deep TMPDIR', deep('tmp')], ['short TMPDIR', shortCacheRoot(t, MAX_SOCKET_PATH - 40)]]) {
    assert.ok(tmp, `${label}: the account cache holds a short directory`);
    isolated(h, 'small', 'claude');
    const { agent } = spawn(h, u, 'small', { TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_RUNTIME_DIR: runtime,
      STUB_RUN: JSON.stringify([cli('task', 'note', 'T1', `from a deep root, ${label}`), address]) });
    const home = path.join(h.state, 'homes', agent);
    assert.ok(Buffer.byteLength(path.join(h.state, 'brokers', agent, 'broker.sock')) > MAX_SOCKET_PATH, `${label}: the broker directory is too deep for its socket`);
    assert.ok(Buffer.byteLength(home) > MAX_SOCKET_PATH, `${label}: the agent home is deep: ${home}`);
    const seen = u.report();
    assert.deepEqual(seen.ran.map((r) => r.code), [0, 0], `${label}: ${JSON.stringify(seen.ran.map((r) => r.stderr))}`);
    const { socket } = JSON.parse(seen.ran[1].stderr);
    assert.ok(Buffer.byteLength(socket) <= MAX_SOCKET_PATH, `${label}: ${socket} fits the socket limit`);
    assert.equal(path.dirname(socket), seen.socketDir, `${label}: the broker listens in the leaf the spawn granted`);
    for (const shared of [tmp, runtime, '/tmp', TMP_ROOT]) assert.ok(!socket.startsWith(shared + path.sep), `${label}: ${socket} is not under ${shared}`);
    for (const access of ['allowRead', 'allowWrite']) assert.ok(seen.settings.sandbox.filesystem[access].includes(seen.socketDir), `${label}: ${access} grants the socket leaf`);
    assert.deepEqual(h.readState('tasks.json').tasks[0].notes.filter((n) => n.agent === agent).map((n) => n.text), [`from a deep root, ${label}`], `${label}: the note came through the broker`);
    assert.equal(fs.existsSync(seen.socketDir), false, `${label}: the exited broker removes its leaf`);
  }
});

test('a codex agent\'s temp directory is its own, never the caller\'s TMPDIR or /tmp', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-13: codex resolves :tmpdir from the TMPDIR it
  // starts with, so with the caller's TMPDIR under the home (~/.cache/tct
  // here) every codex agent read and wrote other tasks' scratch and fixtures.
  // :slash_tmp gave it the host's /tmp, which every other process shares.
  const { h, u } = setup(t);
  const caller = path.join(u.home, '.cache', 'tct');
  const planted = path.join(caller, 'other-task', 'fixture.txt');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, `${SECRET}-TMP\n`);
  for (const rung of ['small', 'hard', 'review']) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung, { TMPDIR: caller, TMP: caller, TEMP: caller });
    const seen = u.report();
    const rules = seen.config.permissions['tower-crane'].filesystem;
    assert.equal(commandsRead(seen, planted), false, `${rung}: the caller's TMPDIR stays hidden`);
    assert.equal(commandsRead(seen, '/tmp/another-session/scratch.txt'), false, `${rung}: the host's /tmp stays hidden`);
    assert.ok(seen.tmpdir && !seen.tmpdir.startsWith(caller), `${rung}: codex starts with a TMPDIR of its own, not ${seen.tmpdir}`);
    // Found in review 2026-10-14: on Windows codex and programs read TMP and TEMP, not TMPDIR.
    assert.deepEqual([seen.tmpEnv.TMP, seen.tmpEnv.TEMP], [seen.tmpdir, seen.tmpdir], `${rung}: TMP and TEMP name the same directory`);
    assert.equal(seen.tmpEnv.JAVA_TOOL_OPTIONS, `-Djava.io.tmpdir=${seen.tmpdir}`, `${rung}: the JVM uses it too`);
    const writes = Object.keys(rules).filter((p) => rules[p] === 'write' && !p.startsWith(':'));
    assert.ok(writes.some((w) => seen.tmpdir === w || seen.tmpdir.startsWith(w + path.sep)), `${rung}: the agent writes its own temp directory`);
    assert.ok(fs.lstatSync(seen.tmpdir).isDirectory(), `${rung}: the temp directory exists before codex starts`);
    if (rung === 'hard') {
      // A worker's is in its task scratch, or, when that path is too long for
      // a browser's singleton socket, the short directory kept for it.
      const scratch = h.readState('tasks.json').tasks[0].scratch;
      const long = Buffer.byteLength(path.join(scratch, 'tmp')) > 62;
      if (long) assert.match(seen.tmpdir, /[\\/]tc[\\/][0-9a-f]{12}$/, 'a long scratch path gets the short temp directory');
      else assert.equal(seen.tmpdir, path.join(scratch, 'tmp'));
    }
  }
});

test('a codex worker\'s temp directory replaces a file or link an earlier attempt left there, and goes with its scratch', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-14: mkdirSync threw EEXIST on a file or a
  // dangling link, so the next worker spawn for the task failed.
  const { h, u } = setup(t);
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard');
  const tmp = u.report().tmpdir;
  // Found in review 2026-10-14: against a lib/ that passes the caller's
  // TMPDIR this was the runner's own temp directory, which the loop below
  // removes. Only a path in the fixture is touched.
  assert.ok(tmp && [h.base, fs.realpathSync(h.base)].some((b) => tmp.startsWith(b + path.sep)), `the temp directory is in the fixture: ${tmp}`);
  const outside = path.join(u.home, '.ssh');
  fs.mkdirSync(outside, { recursive: true });
  for (const plant of [() => fs.writeFileSync(tmp, 'x'), () => fs.symlinkSync(path.join(u.home, 'gone'), tmp), () => fs.symlinkSync(outside, tmp)]) {
    fs.rmSync(tmp, { recursive: true, force: true });
    plant();
    spawn(h, u, 'hard');
    assert.equal(u.report().tmpdir, tmp);
    const st = fs.lstatSync(tmp);
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'a directory of its own replaced what was there');
    assert.ok(fs.existsSync(outside), 'a link is removed, never followed');
  }
  const scratch = h.readState('tasks.json').tasks[0].scratch;
  A.removeTaskCache({ scratch });
  assert.ok(!fs.existsSync(scratch) && !fs.existsSync(tmp), 'removing the scratch removes the temp directory');
});

test('a codex agent\'s short temp directory is named from the resolved cache, so it goes with a cache behind a link', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-14: spawn named it from the resolved cache path
  // and removal from the recorded one, so a cache root behind a link
  // (/home -> /var/home on Fedora Atomic) leaked it.
  const { h, u } = setup(t);
  const real = path.join(h.base, 'real-cache');
  const linked = path.join(h.base, 'c');
  fs.mkdirSync(real);
  fs.symlinkSync(real, linked, 'dir');
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard', { XDG_CACHE_HOME: linked });
  const tmp = u.report().tmpdir;
  const scratch = h.readState('tasks.json').tasks[0].scratch;
  assert.ok(tmp.startsWith(fs.realpathSync(real) + path.sep), `made under the resolved root: ${tmp}`);
  assert.ok(fs.lstatSync(tmp).isDirectory());
  A.removeTaskCache({ scratch });
  assert.ok(!fs.existsSync(tmp), 'removing the scratch through the link removes the temp directory');
});

test('a codex agent\'s temp directory fits a browser\'s singleton socket when its cache root is short enough', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-14: the short fallback had no length check, and
  // ran 98 to 104 bytes under a fixture's root.
  const { h, u } = setup(t);
  isolated(h, 'review', 'codex');
  // The private path under tower-crane adds 28 bytes to the cache root.
  // Made after the fixture, so it is removed after the fixture's agents stop.
  const root = shortCacheRoot(t, 34);
  if (!root) return t.skip('no writable cache root of at most 34 bytes');
  spawn(h, u, 'review', { XDG_CACHE_HOME: root });
  const tmp = u.report().tmpdir;
  assert.ok(Buffer.byteLength(tmp) <= 62, `${tmp} is ${Buffer.byteLength(tmp)} bytes`);
  assert.ok(tmp.startsWith(fs.realpathSync(root) + path.sep), tmp);
});

test('the project\'s env and env_file cannot move a codex agent\'s temp directory', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-14: spawn applies the project's env after the
  // harness's, so it overrode TMPDIR, TMP, TEMP and JAVA_TOOL_OPTIONS.
  const { h, u } = setup(t);
  const elsewhere = path.join(u.home, '.cache', 'tct');
  fs.mkdirSync(elsewhere, { recursive: true });
  const file = path.join(h.base, 'agent.env');
  fs.writeFileSync(file, `TMP=${elsewhere}\nTEMP=${elsewhere}\n`);
  h.ok(['project', 'set', '--env', JSON.stringify({ TMPDIR: elsewhere, JAVA_TOOL_OPTIONS: `-Xss2m -Djava.io.tmpdir=${elsewhere}` }), '--env_file', file]);
  isolated(h, 'small', 'codex');
  spawn(h, u, 'small');
  const seen = u.report();
  assert.ok(seen.tmpdir && !seen.tmpdir.startsWith(elsewhere), `TMPDIR is the agent's own: ${seen.tmpdir}`);
  assert.deepEqual([seen.tmpEnv.TMP, seen.tmpEnv.TEMP], [seen.tmpdir, seen.tmpdir]);
  assert.equal(seen.tmpEnv.JAVA_TOOL_OPTIONS, `-Xss2m -Djava.io.tmpdir=${seen.tmpdir}`, 'the project\'s other options stay');
  assert.equal(commandsRead(seen, path.join(elsewhere, 'x')), false, 'the directory the project names stays hidden');
});

test('a codex agent cannot read a caller TMPDIR outside the home that an entry of / exposes', { skip: NO_STUBS }, t => {
  // Found in review 2026-10-14: /var/tmp on Linux, or /var/folders through
  // /private on macOS, stayed readable through the entry of / that holds it.
  const { h, u } = setup(t);
  let caller;
  try {
    caller = fs.mkdtempSync('/var/tmp/tower-crane-caller-');
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) return t.skip('needs writable /var/tmp');
    throw error;
  }
  t.after(() => fs.rmSync(caller, { recursive: true, force: true }));
  const planted = path.join(caller, 'other-task', 'fixture.txt');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, `${SECRET}-TMP\n`);
  for (const rung of ['small', 'review']) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung, { TMPDIR: caller });
    const seen = u.report();
    assert.equal(commandsRead(seen, planted), false, `${rung}: the caller's TMPDIR in /var/tmp stays hidden`);
    assert.equal(commandsRead(seen, '/var/tmp/another/file'), true, `${rung}: the rest of /var/tmp stays as it was`);
  }
});

test('codex names the same rules however many entries the home holds', { skip: NO_STUBS }, t => {
  // Seen 2026-10-13: a rule per hidden entry of a large ~/.cache made codex's
  // profile, which it passes its sandbox as one argument, too long to exec.
  const { h, u } = setup(t);
  isolated(h, 'small', 'codex');
  // Rules outside the fixture's home name what holds it in the real filesystem.
  const home = fs.realpathSync(u.home);
  const rules = () => {
    const started = spawn(h, u, 'small');
    return Object.keys(TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'config.toml'), 'utf8'))
      .permissions['tower-crane'].filesystem).filter((p) => p.startsWith(home + path.sep)).length;
  };
  const before = rules();
  for (const dir of [u.home, path.join(u.home, '.cache')]) {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `entry-${i}`), '');
  }
  assert.equal(rules(), before);
});

// The profile as codex hands it to its sandbox: one JSON argument with an
// entry per rule. Linux caps one argument at MAX_ARG_STRLEN, 32 pages or
// 131072 bytes with its terminating NUL; the 2,143-rule profile seen on
// 2026-10-13 passed 200 KB and failed to exec.
const MAX_ARG_STRLEN = 32 * 4096;
function codexProfileArg(rules) {
  const entry = (p, access) => ({ path: p.startsWith(':') ? { type: 'special', value: { kind: p.slice(1) } } : { type: 'path', path: p },
    access: access === 'none' ? 'deny' : access });
  const entries = Object.entries(rules).flatMap(([p, access]) => typeof access === 'string' ? [entry(p, access)]
    : Object.entries(access).map(([sub, a]) => entry(`${p}/${sub}`, a)));
  return JSON.stringify({ type: 'managed', file_system: { type: 'restricted', entries }, network: 'enabled' });
}

test('codex keeps its profile under the argument limit however many entries the home and the directories above it hold', { skip: NO_STUBS }, t => {
  // Seen 2026-10-13: a home in a test's temp directory under ~/.cache made
  // codex name every entry of ~/.cache, and it failed with "Argument list too
  // long (os error 7)". /home on a shared host is the same shape.
  const { h, u, wt } = setup(t);
  isolated(h, 'small', 'codex');
  const rules = () => {
    const started = spawn(h, u, 'small');
    return TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'config.toml'), 'utf8')).permissions['tower-crane'].filesystem;
  };
  const before = Object.keys(rules()).length;
  const beside = path.join(h.base, 'entry-0');
  for (const dir of [u.home, h.base]) {
    for (let i = 0; i < 5000; i++) fs.mkdirSync(path.join(dir, `entry-${i}`));
  }
  const after = rules();
  assert.equal(Object.keys(after).length, before, 'no rule per entry');
  const bytes = Buffer.byteLength(codexProfileArg(after)) + 1;
  t.diagnostic(`codex profile: ${Object.keys(after).length} rules, ${bytes} bytes`);
  assert.ok(bytes < MAX_ARG_STRLEN, `the profile argument is ${bytes} bytes`);
  // What sits beside the home is hidden; what the agent needs there is named.
  const seen = { harness: 'codex', config: { permissions: { 'tower-crane': { filesystem: after } } } };
  assert.equal(commandsRead(seen, beside), false, 'an entry beside the home is hidden');
  for (const p of [path.join(h.state, 'tasks.json'), wt, path.join(h.repo, '.git', 'HEAD')]) assert.equal(commandsRead(seen, p), true, `${p} stays readable`);
});

test('a PATH directory at the root never opens the root or a directory that holds the home to codex', { skip: NO_STUBS }, t => {
  // Seen in review 2026-10-13: /opt on PATH named its parent, /, and codex
  // mounted the whole filesystem, the home with it.
  const { h, u } = setup(t);
  isolated(h, 'small', 'codex');
  const home = fs.realpathSync(u.home);
  const started = spawn(h, u, 'small', { PATH: `${u.env.PATH}${path.delimiter}/usr${path.delimiter}${path.dirname(home)}` });
  const rules = TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'config.toml'), 'utf8')).permissions['tower-crane'].filesystem;
  const holders = Object.keys(rules).filter((p) => !p.startsWith(':') && rules[p] !== 'none' && (p === path.parse(p).root || home.startsWith(p.endsWith(path.sep) ? p : p + path.sep)));
  assert.deepEqual(holders, [], 'no rule opens a directory that holds the home');
  assert.equal(commandsRead({ harness: 'codex', config: { permissions: { 'tower-crane': { filesystem: rules } } } }, path.join(home, '.codex', 'auth.json')), false);
});

test('a read-only claude worktree under the home hides the home whole and binds its placeholders before the worktree turns read-only', { skip: NO_STUBS }, t => {
  // A file made in the home after spawn must stay hidden, so the home is
  // hidden whole. claude remounts the worktree inside it and binds a
  // placeholder over each absent protected dotfile; bubblewrap cannot make
  // one once the worktree is read-only, so each comes before the worktree
  // in denyWrite.
  const { h, u, wt } = setup(t);
  const home = fs.realpathSync(h.base);
  fs.writeFileSync(path.join(wt, '.bashrc'), '');
  const present = ClaudeSandboxPlaceholders.present(wt);
  assert.ok(present.includes('.bashrc') && present.length < ClaudeSandboxPlaceholders.FILES.length);
  for (const rung of ['small', 'hard']) {
    isolated(h, rung, 'claude');
    spawn(h, u, rung, { HOME: home, USERPROFILE: home });
    const seen = u.report();
    const box = seen.settings.sandbox.filesystem;
    assert.ok(box.denyRead.includes(home), `${rung}: the home is hidden whole`);
    const later = path.join(home, 'made-after-spawn', 'token');
    assert.equal(commandsRead(seen, later), false, `${rung}: a path made in the home later is hidden`);
    for (const p of [path.join(wt, '.claude', 'settings.local.json'), path.join(h.state, 'tasks.json')]) assert.equal(commandsRead(seen, p), true, `${rung}: ${p} stays readable`);
    for (const p of [path.join(u.home, '.codex', 'auth.json'), path.join(h.base, 'gitconfig')]) assert.equal(commandsRead(seen, p), false, `${rung}: ${p} is hidden`);
    const at = box.denyWrite.indexOf(wt);
    if (rung === 'hard') {
      assert.equal(at, -1, 'a worker writes its worktree');
      continue;
    }
    assert.ok(at > 0, 'the worktree is read-only');
    const before = box.denyWrite.slice(0, at).filter((p) => p.startsWith(wt + path.sep)).map((p) => path.relative(wt, p).split(path.sep).join('/'));
    assert.deepEqual(before, ClaudeSandboxPlaceholders.FILES.filter((f) => !present.includes(f)), 'each absent placeholder precedes the worktree');
    assert.deepEqual(box.denyWrite.slice(at + 1).filter((p) => p.startsWith(wt + path.sep) && ClaudeSandboxPlaceholders.FILES.includes(path.relative(wt, p).split(path.sep).join('/'))), [], 'none follows it');
  }
});

test('an agent of another project reads the Tower Crane code in its own snapshot, never the checkout, its state, brokers or homes', { skip: NO_STUBS }, t => {
  // The checkout the CLI runs from can hold its own project's state, whose
  // brokers/ holds tokens and homes/ links to the user's credentials, and it
  // can be retired while the agent runs. The home here holds the checkout, as
  // ~ holds ~/projects/<checkout>.
  const { h, u } = setup(t);
  const home = fs.realpathSync(path.dirname(ROOT));
  const checkout = fs.realpathSync(ROOT);
  const code = ['bin/tower-crane.js', 'lib/agents.js', 'skills/tower-crane-work/SKILL.md', 'agents/tower-crane-small.md', 'standards/default.md', 'package.json'];
  const hidden = ['.tower-crane/brokers/orchestrator/broker.json', '.tower-crane/homes/worker-T1-1/.credentials.json', '.tower-crane/tasks.json', '.git/config', ...code]
    .map((p) => path.join(checkout, ...p.split('/')));
  for (const harness of ['claude', 'codex']) {
    for (const rung of ['small', 'hard']) {
      isolated(h, rung, harness);
      const started = spawn(h, u, rung, { HOME: home, USERPROFILE: home });
      const seen = u.report();
      const own = path.join(fs.realpathSync(path.join(h.state, 'homes', started.agent)), ...(harness === 'codex' ? ['home', '.tower-crane-shims'] : []), 'tool');
      for (const p of hidden) assert.equal(commandsRead(seen, p), false, `${harness} ${rung}: ${path.relative(checkout, p)} is hidden`);
      for (const p of code) assert.equal(commandsRead(seen, path.join(own, ...p.split('/'))), true, `${harness} ${rung}: its own ${p} is readable`);
    }
  }
});

test('TOWER_CRANE_PLUGIN_ROOT opens only a Tower Crane checkout or plugin, never the home or another directory', { skip: NO_STUBS }, t => {
  // A plugin root at the home would open ~/bin, ~/lib and ~/package.json.
  const { h, u } = setup(t);
  isolated(h, 'small', 'claude');
  const other = path.join(u.home, 'projects');
  fs.mkdirSync(path.join(other, 'lib'), { recursive: true });
  for (const [root, why] of [[u.home, /is the user's home/], [path.dirname(u.home), /holds the user's home/], [other, /is not a Tower Crane checkout or plugin/]]) {
    const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env: { ...u.env, TOWER_CRANE_PLUGIN_ROOT: root } });
    assert.notEqual(r.code, 0, `${root}: ${r.stdout}`);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /TOWER_CRANE_PLUGIN_ROOT/);
  }
  const plugin = pluginRoot(path.join(u.home, 'plugin'));
  for (const dir of ['bin', 'skills']) fs.mkdirSync(path.join(plugin, dir));
  fs.mkdirSync(path.join(plugin, '.tower-crane'));
  spawn(h, u, 'small', { TOWER_CRANE_PLUGIN_ROOT: plugin });
  const seen = u.report();
  assert.equal(commandsRead(seen, path.join(fs.realpathSync(plugin), 'bin')), true, 'the plugin\'s code is readable');
  assert.equal(commandsRead(seen, path.join(fs.realpathSync(plugin), '.tower-crane')), false, 'the rest of the plugin root is hidden');
});
