'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRepo, cachedFixture } = require('./helpers');
const TOML = require('../lib/toml');

const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET_KEY = 'TC_PRIVATE_ENV_FILE_KEY';
const SECRET = 'private-file-value $literal `literal`';

function setup(t, harness = 'codex') {
  return cachedFixture(t, harness, (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Toolchain probe', '--acceptance', 'lock written']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'probe' });
    h.ok(['ladder', 'set', 'medium', '--harness', harness,
      ...(harness === 'codex' ? ['--profile', 'sol', '--clear', 'model'] : ['--model', 'opus', '--clear', 'profile']),
      '--clear', 'effort', '--clear', 'args']);
  });
}

function noFileSecrets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) noFileSecrets(file);
    else if (entry.isFile()) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(SECRET_KEY), `${file} contains the file key`);
      assert.ok(!text.includes(SECRET), `${file} contains the file value`);
    }
  }
}

test('project and rung spawn settings require explicit owner identity, including unchanged and cleared fields', (t) => {
  const h = setup(t);
  const changes = [['--sandbox', '{"write":["~/.cargo"]}'], ['--env', '{"CARGO_HOME":"/toolchain"}'], ['--env_file', '/private.env'], ['--scope', '{"CPUQuota":"200%","MemoryMax":"8G"}']];
  for (const flags of changes) {
    const before = fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
    const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
    for (const cmd of [['project', 'set'], ['ladder', 'set', 'medium']]) {
      const r = h.run([...cmd, ...flags, '--agent', 'worker-T1-1']);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /only the owner/);
    }
    assert.equal(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), events);
    h.ok(['project', 'set', ...flags]);
    h.ok(['ladder', 'set', 'medium', ...flags]);
    assert.equal(h.run(['project', 'set', ...flags, '--agent', 'worker-T1-1']).code, 1);
    assert.equal(h.run(['project', 'set', flags[0], 'null', '--agent', 'worker-T1-1']).code, 1);
    assert.equal(h.run(['ladder', 'set', 'medium', '--clear', flags[0].slice(2), '--agent', 'worker-T1-1']).code, 1);
  }
  const fresh = makeRepo(t);
  const r = fresh.run(['init', '--name', 'test', '--goal', 'test', '--env', '{}', '--agent', 'worker-T1-1']);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(fresh.state), false);
});

test('spawn settings reject invalid shapes and reserved identities without partial writes', (t) => {
  const h = setup(t);
  for (const flags of [
    ['--sandbox', '{"write":"~/.cargo"}'], ['--sandbox', '{"user_bus":1}'], ['--sandbox', '{"other":true}'],
    ['--env', '{"CARGO_HOME":1}'], ['--env', '{"HOME":"/tmp"}'], ['--env', '{"TOWER_CRANE_AGENT":"owner"}'],
    ['--env_file', ''], ['--env', '{"BAD-NAME":"value"}'], ['--sandbox', '{"write":[""]}'],
    ['--sandbox', '{"user_bus":true}'], ['--scope', '[]'], ['--scope', '{"CPUQuota":200}'],
    ['--scope', '{"--bad":"value"}'], ['--scope', '{"MemoryMax":""}'], ['--scope', '{"MemoryMax":"8G\\n"}'],
  ]) {
    const before = fs.readFileSync(path.join(h.state, 'project.json'), 'utf8');
    assert.equal(h.run(['project', 'set', '--name', 'changed', ...flags]).code, 2, flags.join(' '));
    assert.equal(h.run(['ladder', 'set', 'medium', ...flags]).code, 2, flags.join(' '));
    assert.equal(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8'), before);
  }
});

for (const harness of ['codex', 'claude']) {
  test(`${harness}: toolchain env, writable cache, quoted env file and rung overrides reach only the agent`, { skip: NO_STUBS }, (t) => {
    const h = setup(t, harness);
    const home = path.join(h.base, 'user-home');
    const cargo = path.join(home, '.cargo');
    const realCargo = path.join(h.base, 'cargo-cache');
    const rustup = path.join(home, '.rustup');
    fs.mkdirSync(home);
    fs.mkdirSync(realCargo);
    fs.symlinkSync(realCargo, cargo, 'dir');
    fs.mkdirSync(rustup);
    fs.writeFileSync(path.join(rustup, 'toolchain'), 'toolchain');
    const file = path.join(home, 'private.env');
    fs.writeFileSync(file, [
      '# comment', '; comment', `${SECRET_KEY}='${SECRET}'`, 'EMPTY=',
      'DOUBLE="a \\"quote\\" \\\\ \\$dollar \\`tick\\` \\q"',
      'SINGLE=\'two', 'lines \\ literal\'', 'JOIN=first\\', 'second',
      'UNQUOTED=  hello\\ world "literal"  ', 'ESCAPED_SPACE=kept\\ ', 'FROM_FILE=original', 'COMMON=from-file', '',
    ].join('\n'));
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    const out = path.join(h.base, 'result.json');
    const stub = [
      `#!${process.execPath}`, "'use strict';",
      'const fs = require("node:fs"), path = require("node:path");',
      'if (process.env.CARGO_HOME !== process.env.EXPECT_CARGO || process.env.RUSTUP_HOME !== process.env.EXPECT_RUSTUP) throw new Error("toolchain homes not found");',
      'if (fs.readFileSync(path.join(process.env.RUSTUP_HOME, "toolchain"), "utf8") !== "toolchain") throw new Error("missing toolchain");',
      'const lock = path.join(process.env.CARGO_HOME, ".package-cache");',
      'fs.closeSync(fs.openSync(lock, "wx"));',
      `const values = Object.fromEntries(${JSON.stringify([SECRET_KEY, 'EMPTY', 'DOUBLE', 'SINGLE', 'JOIN', 'UNQUOTED', 'ESCAPED_SPACE', 'COMMON', 'FROM_FILE', 'RUNG_ONLY'])}.map(k => [k, process.env[k]]));`,
      'const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;',
      'const config = fs.readFileSync(path.join(dir, process.env.CODEX_HOME ? "config.toml" : "settings.json"), "utf8");',
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({values, config}));`,
      'console.log("toolchain probe passed");', '',
    ].join('\n');
    fs.writeFileSync(path.join(bin, harness), stub, { mode: 0o755 });
    const env = { ...h.env, HOME: home, USERPROFILE: home, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '',
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, EXPECT_CARGO: cargo, EXPECT_RUSTUP: rustup };
    h.ok(['project', 'set', '--sandbox', '{"write":["~/.cargo","~/.cargo/missing/cache"]}', '--env', JSON.stringify({ CARGO_HOME: cargo, RUSTUP_HOME: '/wrong', COMMON: 'project' }), '--env_file', '~/private.env']);
    h.ok(['ladder', 'set', 'medium', '--env', JSON.stringify({ RUSTUP_HOME: rustup, COMMON: 'rung', RUNG_ONLY: 'yes' })]);
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.ok(!JSON.stringify(dry).includes(SECRET_KEY));
    assert.ok(!JSON.stringify(dry).includes(SECRET));
    // A dry-run must not even read the file.
    fs.renameSync(file, `${file}.saved`);
    h.ok(['spawn', '--task', 'T1', '--dry-run'], { env });
    fs.renameSync(`${file}.saved`, file);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(cargo, '.package-cache')), true);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(seen.values, {
      [SECRET_KEY]: SECRET, EMPTY: '', DOUBLE: 'a "quote" \\ $dollar `tick` \\q',
      SINGLE: 'two\nlines \\ literal', JOIN: 'firstsecond', UNQUOTED: 'hello world "literal"',
      ESCAPED_SPACE: 'kept ', FROM_FILE: 'original', COMMON: 'rung', RUNG_ONLY: 'yes',
    });
    for (const granted of [realCargo, path.join(realCargo, 'missing', 'cache')]) {
      if (harness === 'codex') assert.equal(TOML.parse(seen.config).permissions['tower-crane'].filesystem[granted], 'write');
      else assert.ok(JSON.parse(seen.config).sandbox.filesystem.allowWrite.includes(granted));
    }
    if (harness === 'codex') assert.equal(TOML.parse(seen.config).permissions['tower-crane'].network.enabled, true);
    else assert.equal(JSON.parse(seen.config).sandbox.network.allowLocalBinding, true);
    const other = path.join(home, 'other.env');
    fs.writeFileSync(other, `${SECRET_KEY}='${SECRET}'\nFROM_FILE=replacement\n`);
    h.ok(['ladder', 'set', 'medium', '--env_file', '~/other.env']);
    fs.rmSync(file);
    fs.rmSync(path.join(cargo, '.package-cache'));
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).values.FROM_FILE, 'replacement');
    noFileSecrets(h.state);
    assert.ok(!result.stdout.includes(SECRET_KEY) && !result.stderr.includes(SECRET));
  });
}

test('host scopes wrap both harnesses and retries, preserve private env and allow rung overrides', { skip: NO_STUBS || (process.platform !== 'linux' && 'Linux systemd scopes') }, (t) => {
  const h = setup(t);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'scope.jsonl');
  const wrapped = path.join(h.base, 'wrapper.jsonl');
  const file = path.join(h.base, 'private.env');
  fs.writeFileSync(file, `${SECRET_KEY}='${SECRET}'\n`);
  fs.writeFileSync(path.join(bin, 'systemd-run'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(wrapped)}, JSON.stringify(args) + '\\n');
const sep = args.indexOf('--');
if (sep < 0) throw new Error('missing command separator');
const r = cp.spawnSync(args[sep + 1], args.slice(sep + 2), {stdio: 'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const env = { ...h.env, CODEX_HOME: '', CLAUDE_CONFIG_DIR: '', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const harness of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, harness), `#!${process.execPath}
const fs = require('node:fs');
if (process.env[${JSON.stringify(SECRET_KEY)}] !== ${JSON.stringify(SECRET)}) throw new Error('private env missing');
fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({
  scoped: process.env.TOWER_CRANE_SCOPED || null, retry: process.env.TOWER_CRANE_RETRY
}) + '\\n');
${harness === 'codex' ? 'console.log(JSON.stringify({type: "thread.started", thread_id: "scope-test-session"}));' : ''}
process.exit(process.env.TOWER_CRANE_RETRY === '0' ? 75 : 0);
`, { mode: 0o755 });
    h.ok(['ladder', 'set', 'medium', '--harness', harness,
      ...(harness === 'codex' ? ['--profile', 'sol', '--clear', 'model'] : ['--model', 'opus', '--clear', 'profile']),
      '--supervision', '{"retries":1,"backoff_ms":1}']);
    h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%","MemoryMax":"8G"}', '--env_file', file]);
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.deepEqual(dry.argv.slice(0, 10), ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', '-p', 'CPUQuota=200%', '-p', 'MemoryMax=8G', '--']);
    assert.ok(!JSON.stringify(dry).includes(SECRET_KEY) && !JSON.stringify(dry).includes(SECRET));
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    let attempts = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.slice(-2), [{ scoped: '1', retry: '0' }, { scoped: '1', retry: '1' }]);
    let wrappers = fs.readFileSync(wrapped, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wrappers.slice(-2).map((a) => a.slice(0, 9)), Array(2).fill(dry.argv.slice(1, 10)));
    h.ok(['ladder', 'set', 'medium', '--scope', '{"MemoryMax":"4G"}']);
    const overridden = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.deepEqual(overridden.argv.slice(0, 8), ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', '-p', 'MemoryMax=4G', '--']);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    wrappers = fs.readFileSync(wrapped, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wrappers.at(-1).slice(0, 7), overridden.argv.slice(1, 8));
    h.ok(['ladder', 'set', 'medium', '--scope', '{}']);
    const wrapperCount = wrappers.length;
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    attempts = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.slice(-2), [{ scoped: null, retry: '0' }, { scoped: null, retry: '1' }]);
    assert.equal(fs.readFileSync(wrapped, 'utf8').trim().split('\n').length, wrapperCount);
    h.ok(['ladder', 'set', 'medium', '--clear', 'scope']);
    assert.deepEqual(h.json(['spawn', '--task', 'T1', '--dry-run'], { env }).argv.slice(0, 10), dry.argv.slice(0, 10));
    noFileSecrets(h.state);
  }
});

test('scoped arguments keep literal env references and old systemd refuses to launch the child', {
  skip: NO_STUBS || (process.platform !== 'linux' && 'Linux systemd scopes'),
}, (t) => {
  const h = setup(t);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'literal-args.json');
  const script = path.join(h.base, 'agent.js');
  const file = path.join(h.base, 'private.env');
  const literals = ['${TC_ARG_ENV}', '${TC_ARG_FILE}', 'review diff: ${TC_ARG_FILE} and $TC_ARG_ENV'];
  fs.writeFileSync(file, `TC_ARG_FILE='${SECRET}'\n`);
  fs.writeFileSync(script, `
const fs = require('node:fs');
if (process.env.TC_ARG_ENV !== 'configured-value' || process.env.TC_ARG_FILE !== ${JSON.stringify(SECRET)}) throw new Error('agent env missing');
const args = process.argv.slice(2, -1);
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(literals))}) throw new Error('scope expanded literal argv');
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(args));
console.log('literal args passed');
`);
  fs.writeFileSync(path.join(bin, 'systemd-run'), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.SIMULATE_OLD_SYSTEMD && args.includes('--expand-environment=no')) {
  console.error("systemd-run: unrecognized option '--expand-environment=no'");
  process.exit(1);
}
let command = args.slice(args.indexOf('--') + 1);
if (!args.includes('--expand-environment=no')) {
  command = command.map(a => a.replace(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, k) => process.env[k] || ''));
}
const r = cp.spawnSync(command[0], command.slice(1), {stdio: 'inherit'});
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, script, ...literals, '{prompt}']),
    '--clear', 'profile', '--supervision', '{"retries":0}']);
  h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%"}', '--env', '{"TC_ARG_ENV":"configured-value"}', '--env_file', file]);
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), literals);
  noFileSecrets(h.state);
  fs.rmSync(out);
  const refused = h.run(['spawn', '--task', 'T1', '--wait'], { env: { ...env, SIMULATE_OLD_SYSTEMD: '1' } });
  assert.equal(refused.code, 1, refused.stderr);
  assert.match(refused.stderr, /unrecognized option.*--expand-environment=no/);
  assert.equal(fs.existsSync(out), false, 'an unsupported flag must never fall back to expanding arguments');
  noFileSecrets(h.state);
});

test('configured scopes refuse unavailable systemd-run before creating a worktree', (t) => {
  const h = setup(t);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const missing = path.join(h.base, 'missing-systemd.js');
  fs.writeFileSync(missing, `
const fs = require('node:fs'), path = require('node:path');
const stat = fs.statSync;
fs.statSync = function(file, ...args) {
  if (path.basename(String(file)) === 'systemd-run') throw Object.assign(new Error('not found'), {code: 'ENOENT'});
  return stat.call(this, file, ...args);
};
`);
  const harness = path.join(bin, 'agent');
  fs.writeFileSync(harness, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, harness, '{prompt}']), '--clear', 'profile']);
  h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%"}']);
  const before = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8');
  const result = h.run(['spawn', '--task', 'T1', '--wait'], { env: { NODE_OPTIONS: `--require ${JSON.stringify(missing)}` } });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /scope requires.*systemd-run|scope requires Linux/);
  assert.equal(fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8'), before);
  assert.equal(h.json(['task', 'show', 'T1']).branch, null);
});

test('invalid or unreadable env files fail without echoing their contents', { skip: NO_STUBS }, (t) => {
  const h = setup(t);
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const file = path.join(h.base, 'private.env');
  h.ok(['project', 'set', '--env_file', file]);
  for (const text of [null, `${SECRET_KEY}="${SECRET}`, `${SECRET_KEY}='${SECRET}' trailing`, `HOME='${SECRET}'`]) {
    if (text !== null) fs.writeFileSync(file, text);
    const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(!r.stderr.includes(SECRET_KEY) && !r.stderr.includes(SECRET));
    noFileSecrets(h.state);
  }
});

test('real Codex worker writes the toolchain lock, receives a private env file, serves loopback and inherits scope limits', {
  skip: process.env.TOWER_CRANE_LIVE_CODEX !== '1' && 'set TOWER_CRANE_LIVE_CODEX=1 to run a real Codex worker',
  timeout: 240000,
}, async (t) => {
  const fixtureRoot = process.env.TOWER_CRANE_TEST_TMP;
  const inside = (dir, target) => {
    const rel = path.relative(path.resolve(dir), path.resolve(target));
    return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
  };
  assert.ok(fixtureRoot && ![os.tmpdir(), '/tmp', process.env.XDG_CACHE_HOME || path.join(require('../lib/agents').origin(process.env).home, '.cache')]
    .some((dir) => inside(dir, fixtureRoot)), 'set TOWER_CRANE_TEST_TMP outside the standard writable temp and cache directories so the live lock proves the extra write grant');
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Live sandbox probe', '--acceptance', 'probe succeeds']);
  const cargo = path.join(h.base, 'cargo');
  const rustup = path.join(h.base, 'rustup');
  fs.mkdirSync(cargo);
  fs.mkdirSync(rustup);
  fs.writeFileSync(path.join(rustup, 'toolchain'), 'toolchain');
  const file = path.join(h.base, 'private.env');
  fs.writeFileSync(file, `${SECRET_KEY}='${SECRET}'\n`, { mode: 0o600 });
  // The state directory is read-only in the sandbox.
  const results = path.join(h.base, 'results');
  fs.mkdirSync(results);
  const out = path.join(results, 'live-result.json');
  const script = path.join(h.base, 'cargo-probe.js');
  const privateTmp = path.join(h.base, 'agent-tmp');
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  assert.equal(process.platform, 'linux', 'live scope verification requires Linux');
  fs.writeFileSync(script, [
    "'use strict';",
    'const fs = require("node:fs"), path = require("node:path"), net = require("node:net");',
    `if (process.env[${JSON.stringify(SECRET_KEY)}] !== ${JSON.stringify(SECRET)}) throw new Error("private environment missing");`,
    `if (process.env.CARGO_HOME !== ${JSON.stringify(cargo)} || process.env.RUSTUP_HOME !== ${JSON.stringify(rustup)}) throw new Error("toolchain homes missing");`,
    'if (fs.readFileSync(path.join(process.env.RUSTUP_HOME, "toolchain"), "utf8") !== "toolchain") throw new Error("toolchain missing");',
    'fs.closeSync(fs.openSync(path.join(process.env.CARGO_HOME, ".package-cache"), "wx"));',
    'let denied = false;',
    'try { fs.writeFileSync(path.join(process.env.RUSTUP_HOME, "unconfigured-write"), "unexpected"); }',
    'catch (e) { if (!["EACCES", "EPERM", "EROFS"].includes(e.code)) throw e; denied = true; }',
    'if (!denied) throw new Error("sandbox permitted an unconfigured toolchain write");',
    'if (process.env.TOWER_CRANE_SCOPED !== "1") throw new Error("scope marker missing");',
    'const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").split("\\n").find(s => s.startsWith("0::"));',
    'if (!cgroup) throw new Error("unified cgroup missing");',
    'let dir = path.join("/sys/fs/cgroup", cgroup.slice(3));',
    'let limited = false;',
    'while (dir.startsWith("/sys/fs/cgroup/")) {',
    '  const cpu = path.join(dir, "cpu.max"), memory = path.join(dir, "memory.max");',
    '  if (fs.existsSync(cpu) && fs.existsSync(memory)) {',
    '    const [quota, period] = fs.readFileSync(cpu, "utf8").trim().split(/\\s+/);',
    '    if (Number(quota) / Number(period) === 2 && fs.readFileSync(memory, "utf8").trim() === "8589934592") { limited = true; break; }',
    '  }',
    '  dir = path.dirname(dir);',
    '}',
    'if (!limited) throw new Error("agent did not inherit CPUQuota=200% and MemoryMax=8G");',
    'const server = net.createServer(c => c.end("loopback"));',
    'const deadline = setTimeout(() => { console.error("loopback timeout"); process.exit(1); }, 10000);',
    'server.on("error", e => { throw e; });',
    'server.listen(0, "127.0.0.1", () => {',
    '  let text = "";',
    '  const client = net.connect(server.address().port, "127.0.0.1");',
    '  client.on("error", e => { throw e; });',
    '  client.on("data", d => { text += d; });',
    '  client.on("end", () => {',
    '    if (text !== "loopback") throw new Error("loopback response failed");',
    `    fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({toolchain: true, privateEnv: true, loopback: true, scoped: true}));`,
    '    clearTimeout(deadline); server.close(); console.log("sandbox probe passed");',
    '  });',
    '});', '',
  ].join('\n'));
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [cargo, results] }), '--scope', '{"CPUQuota":"200%","MemoryMax":"8G"}',
    '--env', JSON.stringify({ CARGO_HOME: cargo, RUSTUP_HOME: rustup }), '--env_file', file]);
  h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', process.env.TOWER_CRANE_LIVE_PROFILE || 'sol',
    '--clear', 'model', '--clear', 'effort', '--supervision', '{"retries":0}']);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `This task is a live sandbox verification fixture. Run exactly this command with your command tool, then report its exit code and stop. Do not read the script or private environment file, print environment variables, change files, use tower-crane, open a PR or delegate work.\n\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`,
  });
  const dry = h.ok(['spawn', '--task', 'T1', '--dry-run']);
  assert.ok(!dry.includes(SECRET_KEY) && !dry.includes(SECRET));
  const result = await h.runAsync(['spawn', '--task', 'T1', '--wait'], { env: { TMPDIR: privateTmp } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(out), true, result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { toolchain: true, privateEnv: true, loopback: true, scoped: true });
  assert.equal(fs.existsSync(path.join(cargo, '.package-cache')), true);
  noFileSecrets(h.state);
  assert.ok(!result.stdout.includes(SECRET_KEY) && !result.stderr.includes(SECRET));
});

test('claude: sandbox.session_bus grants the bus and the user manager sockets, read and write, and off it grants nothing', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  // The runtime directory is the test's own, so the host's session bus never matters.
  // The stub never connects, so empty files stand in for the two sockets.
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(path.join(runtime, 'systemd'), { recursive: true });
  const bus = path.join(fs.realpathSync(runtime), 'bus');
  const manager = path.join(fs.realpathSync(runtime), 'systemd', 'private');
  fs.writeFileSync(bus, '');
  fs.writeFileSync(manager, '');
  const out = path.join(h.base, 'result.json');
  const stub = [
    `#!${process.execPath}`, "'use strict';",
    'const fs = require("node:fs"), path = require("node:path");',
    'const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));',
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ sandbox: settings.sandbox, env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } }));`,
    'console.log("bus probe passed");', '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), stub, { mode: 0o755 });
  const env = { ...h.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  const spawnSeen = () => {
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };

  const off = spawnSeen();
  assert.ok(!off.sandbox.filesystem.allowRead.includes(bus), 'off by default: no read grant');
  assert.ok(!off.sandbox.filesystem.allowWrite.includes(bus), 'off by default: no write grant');

  assert.equal(h.run(['project', 'set', '--session-bus', 'maybe']).code, 2);
  h.ok(['project', 'set', '--session-bus', 'true']);
  fs.rmSync(manager);
  const refused = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.notEqual(refused.code, 0, 'a missing user manager socket refuses the spawn');
  assert.match(refused.stderr, /systemd\/private/);
  fs.writeFileSync(manager, '');
  const on = spawnSeen();
  assert.ok(on.sandbox.filesystem.allowRead.includes(bus), 'the sandbox reads the bus socket');
  assert.ok(on.sandbox.filesystem.allowWrite.includes(bus), 'the sandbox writes the bus socket');
  assert.ok(on.sandbox.filesystem.allowRead.includes(manager), 'the sandbox reads the user manager socket');
  assert.ok(on.sandbox.filesystem.allowWrite.includes(manager), 'the sandbox writes the user manager socket, which systemd-run connects to');
  assert.ok(on.sandbox.filesystem.denyRead.includes(fs.realpathSync(runtime)), 'the rest of the runtime directory stays denied');
  assert.deepEqual(on.sandbox.filesystem.allowWrite.filter((p) => p.startsWith(fs.realpathSync(runtime))), [bus, manager], 'only the two sockets are writable under the runtime directory');
  assert.deepEqual(on.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` });

  h.ok(['project', 'set', '--session-bus', 'false']);
  assert.ok(!spawnSeen().sandbox.filesystem.allowRead.includes(bus), 'false turns the grant off again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8')).sandbox, undefined);
});
