'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeRepo, cachedFixture } = require('./helpers');
const TOML = require('../lib/toml');
const A = require('../lib/agents');

const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET_KEY = 'TC_PRIVATE_ENV_FILE_KEY';
const SECRET = 'private-file-value $literal `literal`';

function setup(t, harness = 'codex') {
  const h = cachedFixture(t, harness, (h) => {
    h.init();
    h.ok(['task', 'add', '--title', 'Toolchain probe', '--acceptance', 'lock written']);
    h.ok(['brief', 'set', 'T1', '-'], { input: 'probe' });
    h.ok(['ladder', 'set', 'medium', '--harness', harness,
      ...(harness === 'codex' ? ['--profile', 'fixture-main', '--clear', 'model'] : ['--model', 'fixture-large', '--clear', 'profile']),
      '--clear', 'effort', '--clear', 'args']);
  });
  // Native harness fixtures must not copy the parent's credential tree.
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
  return h;
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

// An exited worker keeps its lease until the orchestrator releases it, so each dispatch releases the last one.
function releaseExited(h) {
  const task = h.json(['task', 'show', 'T1']);
  if (task.claim) h.ok(['release', 'T1', '--agent', task.claim.agent, '--reason', 'worker exited']);
  // These probes relaunch one task's worker on purpose; the owner lifts the
  // respawn cap each stand-in's exit without a submit counts toward.
  if (task.needs_owner?.startsWith('worker exited without submitting')) h.ok(['owner-done', 'T1']);
}

for (const harness of ['codex', 'claude']) {
  test(`${harness}: external gate tools and declared wrapper dependencies are read-only`, { skip: NO_STUBS }, (t) => {
    const h = setup(t, harness);
    const tools = path.join(h.env.HOME, 'gate-tools');
    const dependencies = path.join(h.base, 'gate-dependencies');
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(dependencies);
    const clean = path.join(tools, 'clean.sh');
    const proof = path.join(tools, 'proof.js');
    const secrets = path.join(h.env.HOME, '.ssh');
    const credential = path.join(secrets, 'fixture-key');
    fs.mkdirSync(secrets);
    fs.writeFileSync(credential, 'fixture secret', { mode: 0o600 });
    fs.writeFileSync(clean, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(proof, '');
    h.ok(['project', 'set', '--clean-cmd', `"${clean}" "${credential}"`, '--tests-proof-cmd', `node "${proof}" "${credential}" {tests}`,
      '--clean-paths', JSON.stringify([dependencies])]);
    const config = path.join(h.base, 'gate-profile');
    const bin = path.join(h.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR;
fs.copyFileSync(path.join(dir, ${JSON.stringify(harness === 'codex' ? 'config.toml' : 'settings.json')}), ${JSON.stringify(config)});
`, { mode: 0o755 });
    if (harness === 'claude') {
      const project = h.json(['project', 'show']);
      const iso = A.isolation('worker', { harness, model: 'fixture-large' }, 'medium', {
        stateDir: h.state, repo: { root: h.repo }, project, cwd: h.repo, parentCwd: h.repo,
        env: h.env, agent: 'worker-T1-1', task: 'T1', taskSpec: { id: 'T1' }, attempt: 1,
        settings: { sandbox: { read: [], write: [] }, env: {} },
      });
      iso.write();
      fs.copyFileSync(path.join(iso.home, 'settings.json'), config);
    } else {
      h.ok(['spawn', '--task', 'T1', '--wait'], { env: { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    }
    const raw = fs.readFileSync(config, 'utf8');
    for (const file of [credential, secrets].map(p => fs.realpathSync(p))) {
      if (harness === 'codex') assert.equal(TOML.parse(raw).permissions['tower-crane'].filesystem[file], undefined, file);
      else assert.ok(!JSON.parse(raw).sandbox.filesystem.allowRead.includes(file), file);
    }
    for (const file of [clean, proof, tools, dependencies].map(p => fs.realpathSync(p))) {
      if (harness === 'codex') assert.equal(TOML.parse(raw).permissions['tower-crane'].filesystem[file], 'read', file);
      else {
        assert.ok(JSON.parse(raw).sandbox.filesystem.allowRead.includes(file), file);
        assert.ok(JSON.parse(raw).sandbox.filesystem.denyWrite.includes(file), file);
      }
    }
    releaseExited(h);
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [dependencies] })]);
    assert.match(h.run(['spawn', '--task', 'T1', '--dry-run']).stderr, /inside a read-only gate tool path/);
    h.ok(['project', 'set', '--sandbox', 'null', '--clean-paths', JSON.stringify([path.join(h.state, 'brokers')])]);
    assert.match(h.run(['spawn', '--task', 'T1', '--dry-run']).stderr, /sandbox hides because it holds credentials/);
  });
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
    releaseExited(h);
    const result = h.run(['spawn', '--task', 'T1', '--wait'], { env });
    assert.equal(result.code, 0, result.stderr);
    // The exited worker's lease holds the task until it is released.
    h.ok(['release', 'T1', '--agent', h.json(['task', 'show', 'T1']).claim.agent, '--reason', 'worker finished']);
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
    releaseExited(h);
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
const supported = new Set(['CPUQuota', 'MemoryMax', 'TasksMax', 'MemorySwapMax', 'OOMPolicy', 'Delegate']);
for (let i = 0; i < args.indexOf('--'); i++) {
  if (args[i] === '-p' && !supported.has(args[++i].split('=')[0])) {
    console.error('Unknown assignment: ' + args[i]);
    process.exit(1);
  }
}
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
      ...(harness === 'codex' ? ['--profile', 'fixture-main', '--clear', 'model'] : ['--model', 'fixture-large', '--clear', 'profile']),
      '--supervision', '{"retries":1,"backoff_ms":1}']);
    h.ok(['project', 'set', '--scope', '{"CPUQuota":"200%","MemoryMax":"8G"}', '--env_file', file]);
    const dry = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.deepEqual(dry.argv.slice(0, 10), ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', '-p', 'CPUQuota=200%', '-p', 'MemoryMax=8G', '--']);
    assert.ok(!JSON.stringify(dry).includes(SECRET_KEY) && !JSON.stringify(dry).includes(SECRET));
    releaseExited(h);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    let attempts = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(attempts.slice(-2), [{ scoped: '1', retry: '0' }, { scoped: '1', retry: '1' }]);
    let wrappers = fs.readFileSync(wrapped, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wrappers.slice(-2).map((a) => a.slice(0, 9)), Array(2).fill(dry.argv.slice(1, 10)));
    h.ok(['ladder', 'set', 'medium', '--scope', '{"MemoryMax":"4G"}']);
    const overridden = h.json(['spawn', '--task', 'T1', '--dry-run'], { env });
    assert.deepEqual(overridden.argv.slice(0, 8), ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', '-p', 'MemoryMax=4G', '--']);
    releaseExited(h);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    wrappers = fs.readFileSync(wrapped, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(wrappers.at(-1).slice(0, 7), overridden.argv.slice(1, 8));
    h.ok(['ladder', 'set', 'medium', '--scope', '{}']);
    const wrapperCount = wrappers.length;
    releaseExited(h);
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
const supported = new Set(['CPUQuota', 'MemoryMax', 'TasksMax', 'MemorySwapMax', 'OOMPolicy', 'Delegate']);
for (let i = 0; i < args.indexOf('--'); i++) {
  if (args[i] === '-p' && !supported.has(args[++i].split('=')[0])) {
    console.error('Unknown assignment: ' + args[i]);
    process.exit(1);
  }
}
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
  releaseExited(h);
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), literals);
  noFileSecrets(h.state);
  fs.rmSync(out);
  releaseExited(h);
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
  releaseExited(h);
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
    releaseExited(h);
    const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(!r.stderr.includes(SECRET_KEY) && !r.stderr.includes(SECRET));
    noFileSecrets(h.state);
  }
});

test('real Codex worker writes the toolchain lock, receives a private env file, serves loopback and inherits scope limits', {
  skip: process.env.TOWER_CRANE_LIVE_CODEX !== '1' && 'set TOWER_CRANE_LIVE_CODEX=1 to run a real Codex worker',
  timeout: 300000,
}, async (t) => {
  assert.ok(process.env.TOWER_CRANE_LIVE_PROFILE, 'set TOWER_CRANE_LIVE_PROFILE to run a live codex probe');
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
  // Codex mounts nothing beside the home but the paths the project names.
  const script = path.join(results, 'cargo-probe.js');
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
    'const deadline = setTimeout(() => { console.error("loopback timeout"); process.exit(1); }, 10000);', // wait-allow: hung-child backstop for the live sandbox network probe
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
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [cargo, results], read: [rustup] }), '--scope', '{"CPUQuota":"200%","MemoryMax":"8G"}',
    '--env', JSON.stringify({ CARGO_HOME: cargo, RUSTUP_HOME: rustup }), '--env_file', file]);
  h.ok(['ladder', 'set', 'medium', '--harness', 'codex', '--profile', process.env.TOWER_CRANE_LIVE_PROFILE,
    '--clear', 'model', '--clear', 'effort', '--supervision', '{"retries":0}']);
  h.ok(['brief', 'set', 'T1', '-'], {
    input: `This task is a live sandbox verification fixture. Run exactly this command with your command tool, then report its exit code and stop. Do not read the script or private environment file, print environment variables, change files, use tower-crane, open a PR or delegate work.\n\n${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`,
  });
  const dry = h.ok(['spawn', '--task', 'T1', '--dry-run']);
  assert.ok(!dry.includes(SECRET_KEY) && !dry.includes(SECRET));
  releaseExited(h);
  const result = await h.runAsync(['spawn', '--task', 'T1', '--wait'], { env: { TMPDIR: privateTmp } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(out), true, result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { toolchain: true, privateEnv: true, loopback: true, scoped: true });
  assert.equal(fs.existsSync(path.join(cargo, '.package-cache')), true);
  noFileSecrets(h.state);
  assert.ok(!result.stdout.includes(SECRET_KEY) && !result.stderr.includes(SECRET));
});

// A claude stub that writes the settings, its sandbox apart, and the env its spawn gave it to out.
function writeClaudeStub(bin, out) {
  const stub = [
    `#!${process.execPath}`, "'use strict';",
    'const fs = require("node:fs"), path = require("node:path");',
    'const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));',
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ sandbox: settings.sandbox, settings, env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }, tmp: { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR } }));`,
    'console.log("bus probe passed");', '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'claude'), stub, { mode: 0o755 });
}

test('claude: the sandbox allows GitHub, npm and sandbox.domains, names the remotes it leaves out, and refuses a pattern claude does not take', { skip: NO_STUBS }, (t) => {
  // Owner decision 2026-10-14: an explicit list in place of ['*'], which
  // claude's proxy honors as every host.
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  const env = { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  const wt = h.json(['worktree', 'T1']).path;
  // A remote never widens the list: the orchestrator can add one without
  // the owner. A loopback or tailnet remote, listed as a bare name, would
  // open every port and service on that host to the agent's commands.
  for (const args of [['remote', 'add', 'mirror', 'https://git.example.org/acme/app.git'], ['remote', 'set-url', '--add', '--push', 'mirror', 'git@push.example.net:acme/app.git'],
    ['remote', 'add', 'intranet', 'ssh://gitserver/acme/app.git'], ['remote', 'add', 'local', 'http://localhost:8300/acme/app.git'],
    ['remote', 'add', 'tailnet', 'http://100.64.0.10:7447/git'], ['remote', 'add', 'v6', 'http://[::1]:8080/app.git'],
    ['remote', 'add', 'lan', 'https://192.168.1.20:8443/app.git'], ['remote', 'add', 'plain', 'http://plain.example.com/app.git']]) h.git(['-C', wt, ...args]);
  // Each message carries the whole spawn output and the settings claude got,
  // so a failure under load says what differed.
  const spawned = () => {
    releaseExited(h);
    const stdout = h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    const seen = `spawn stdout:\n${stdout}\nclaude settings:\n${JSON.stringify(result.settings, null, 2)}`;
    return { domains: result.sandbox.network.allowedDomains, stdout, seen };
  };
  const base = spawned();
  for (const d of ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'uploads.github.com', 'registry.npmjs.org']) {
    assert.ok(base.domains.includes(d), `${d} in the allowed domains\n${base.seen}`);
  }
  for (const host of ['*', 'git.example.org', 'push.example.net', 'gitserver', 'localhost', '100.64.0.10', '[::1]', '192.168.1.20']) {
    assert.ok(!base.domains.some((d) => d === host || d.startsWith(`${host}:`)), `${host} stays out of the allowed domains\n${base.seen}`);
  }
  // Each one left out is named, with its port (an https or http URL's
  // default when it names none) and what kind of address it is.
  for (const named of ['git.example.org:443', 'plain.example.com:80', 'push.example.net', 'gitserver (single-label', 'localhost:8300 (loopback)', '100.64.0.10:7447 (shared address space',
    '[::1]:8080 (loopback)', '192.168.1.20:8443 (private address)']) assert.ok(base.stdout.includes(named), `${named} in the notice\n${base.seen}`);
  const spawnEvent = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).findLast((e) => e.cmd === 'spawn');
  assert.ok(spawnEvent.detail.notices?.some((n) => n.includes('localhost:8300')), `the spawn event records the notice: ${JSON.stringify(spawnEvent)}`);
  // The whole result of a refusal: a CLI killed by a signal, or never
  // started, also exits nonzero with nothing on stderr.
  const refused = (domains) => {
    const r = h.run(['project', 'set', '--sandbox', JSON.stringify({ domains })]);
    return { ...r, seen: `project set --sandbox ${JSON.stringify({ domains })}: ${JSON.stringify({ code: r.code, signal: r.signal, error: r.error, stdout: r.stdout, stderr: r.stderr })}` };
  };
  for (const bad of ['*.com', 'https://pypi.org', 'pypi', 'a.b:0', '*.*.org', 'github.com:080', 'github.com:65536', '2001:db8::1:443', '::1',
    '*.co.uk', '*.github.io', '*.amazonaws.com', '*.s3.amazonaws.com']) {
    const r = refused([bad]);
    assert.notEqual(r.code, 0, `${bad} is refused: ${r.seen}`);
    assert.match(r.stderr, /sandbox\.domains/, r.seen);
  }
  const shared = refused(['*.co.uk']);
  assert.match(shared.stderr, /co\.uk, a suffix many owners share/, shared.seen);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ domains: ['pypi.org', '*.pythonhosted.org', 'git.example.org:443', 'plain.example.com:80', '100.64.0.10:7447', '[2001:db8::1]:443'] })]);
  h.ok(['ladder', 'set', 'medium', '--sandbox', JSON.stringify({ domains: ['proxy.golang.org:443'] })]);
  const extended = spawned();
  for (const d of ['pypi.org', '*.pythonhosted.org', 'proxy.golang.org:443', 'github.com', 'git.example.org:443', '100.64.0.10:7447']) assert.ok(extended.domains.includes(d), `${d}: a rung adds to the project's list\n${extended.seen}`);
  // What the owner listed is no longer named, host:443 covering a portless
  // https remote and host:80 a portless http one; the rest still is.
  assert.ok(!extended.stdout.includes('git.example.org') && !extended.stdout.includes('plain.example.com') && !extended.stdout.includes('100.64.0.10'), extended.seen);
  assert.ok(extended.stdout.includes('localhost:8300 (loopback)'), extended.seen);
  // * is the explicit opt-in to every host, which claude's proxy honors, and then nothing is left out.
  h.ok(['ladder', 'set', 'medium', '--sandbox', JSON.stringify({ domains: ['*'] })]);
  const all = spawned();
  assert.ok(all.domains.includes('*'), all.seen);
  assert.ok(!all.stdout.includes('remote host'), all.seen);
});

test('host patterns match Claude Code 2.1.296: ports 1 to 65535 without a leading zero, IPv6 only in brackets, no wildcard over a shared suffix', () => {
  const Settings = require('../lib/spawn-settings');
  for (const ok of ['*', 'github.com', 'github.com:443', 'a.b:65535', 'localhost', 'localhost:8300', '[::1]', '[2001:db8::1]:443', '*.example.com', '*.pythonhosted.org', '100.64.0.10:7447', '*.githubusercontent.com']) {
    assert.equal(Settings.domainPattern(ok), true, ok);
  }
  for (const bad of ['github.com:080', 'github.com:0', 'github.com:65536', 'github.com:', '2001:db8::1:443', '::1', '[::1]:080', '[::1]:', '*.com', '*.*.org', 'pypi', 'https://pypi.org', 'a.b/c', '',
    // Only ASCII names: a fullwidth letter or colon, a zero-width space, an
    // ideographic full stop, # or @ never reaches the shared-suffix check.
    '\uff47ithub.com', 'github.com\uff1a443', 'git\u200bhub.com', 'github\u3002com', '*.github\u3002io', 'evil.com#.github.com', 'user@github.com',
    'git hub.com', '[fe80::1%25eth0]', '[::1 ]']) {
    assert.equal(Settings.domainPattern(bad), false, bad);
  }
  for (const shared of ['*.co.uk', '*.com.au', '*.github.io', '*.amazonaws.com', '*.s3.us-east-1.amazonaws.com', '*.vercel.app:443', '*.googleapis.com', '*.storage.googleapis.com', '*.oast.fun', '*.me.uk', '*.blogspot.co.uk']) {
    assert.equal(Settings.domainProblems([shared]).length, 1, shared);
  }
  assert.deepEqual(Settings.domainProblems(['*.example.co.uk', '*.pythonhosted.org', 'bucket.s3.amazonaws.com']), []);
  // Coverage follows the proxy: a port-free pattern any port, *. names under it but not itself.
  const list = ['github.com', '*.example.org', 'git.example.net:8443'];
  for (const [entry, covered] of [['github.com:22', true], ['github.com', true], ['a.example.org', true], ['example.org', false],
    ['git.example.net:8443', true], ['git.example.net', false], ['git.example.net:443', false], ['localhost:8300', false]]) {
    assert.equal(Settings.domainCovered(list, entry), covered, entry);
  }
  assert.equal(Settings.domainCovered(['*'], 'localhost:8300'), true);
});

test('claude: a sandboxed agent gets a temp directory of its own that its commands reach, where claude puts its proxy sockets, and claude keeps its own temp files apart', { skip: NO_STUBS }, (t) => {
  // Found 2026-10-14: claude makes its proxy bridge sockets in TMPDIR, and
  // with the caller's under the home, which the sandbox hides, every https
  // request from a command failed with "Proxy CONNECT aborted". Found in the
  // T276 review: claude keeps its own temp files in <TMPDIR>/claude-<uid>,
  // the directory its commands write, and reads them back.
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  const caller = path.join(h.base, 'caller-tmp');
  fs.mkdirSync(caller);
  // A cache root short enough for claude's 73-byte socket bound.
  const cache = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'tcl-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  // Exercise the runtime-directory branch independently of the caller's session.
  const runtime = path.join(cache, 'runtime');
  fs.mkdirSync(runtime);
  const spawnSeen = (xdg, fx = h, extra = {}) => {
    releaseExited(fx);
    const stdout = fx.ok(['spawn', '--task', 'T1', '--wait'], { env: { ...fx.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '', TMPDIR: caller, TMP: caller, TEMP: caller, XDG_CACHE_HOME: xdg, XDG_RUNTIME_DIR: runtime, ...extra } });
    return { ...JSON.parse(fs.readFileSync(out, 'utf8')), stdout };
  };
  const seen = spawnSeen(cache);
  const tmp = seen.tmp.TMPDIR;
  assert.ok(tmp && tmp !== caller && tmp.startsWith(fs.realpathSync(cache) + path.sep), `the agent's own: ${tmp}`);
  assert.deepEqual([seen.tmp.TMP, seen.tmp.TEMP], [tmp, tmp]);
  assert.ok(Buffer.byteLength(path.join(tmp, 'claude-socks-0123456789abcdef.sock')) <= 108, 'claude\'s bridge socket fits');
  const { allowRead, allowWrite } = seen.sandbox.filesystem;
  assert.ok(allowRead.includes(tmp) && allowWrite.includes(tmp), 'its commands reach the sockets and write their temp files there');
  assert.ok(fs.lstatSync(tmp).isDirectory());
  // claude's own temp files go under CLAUDE_CODE_TMPDIR in the agent's home,
  // which the commands read and never write, long enough (over 44 bytes with
  // claude-<uid>) that claude gives the commands <TMPDIR>/claude-<uid> instead.
  const ownOf = (s) => {
    const own = s.tmp.CLAUDE_CODE_TMPDIR;
    assert.ok(own, 'CLAUDE_CODE_TMPDIR is set');
    assert.ok(Buffer.byteLength(path.join(own, `claude-${process.getuid()}`)) > 44, own);
    const fs2 = s.sandbox.filesystem;
    assert.ok(!fs2.allowWrite.some((d) => own === d || own.startsWith(d + path.sep)), `its commands cannot write claude's own temp files: ${fs2.allowWrite}`);
    assert.ok(fs2.denyWrite.includes(own) && fs2.allowRead.includes(own), 'a read-only bind covers the per-user directory claude itself binds writable');
    assert.ok(fs.lstatSync(own).isDirectory());
    return own;
  };
  const own = ownOf(seen);
  const homes = [fs.realpathSync(h.state), h.state].map((d) => path.join(d, 'homes') + path.sep);
  assert.ok(homes.some((d) => own.startsWith(d)), `in the agent's home: ${own}`);
  // Without XDG_RUNTIME_DIR, as on macOS, claude's messaging socket goes
  // under CLAUDE_CODE_TMPDIR and must stay within 103 bytes, or every claude
  // of the user shares /tmp/cc-socks-<uid>. This state path is too deep for
  // that, so the directory moves beside claude's TMPDIR.
  const bare = spawnSeen(cache, h, { XDG_RUNTIME_DIR: '' });
  const short = ownOf(bare);
  assert.ok(Buffer.byteLength(path.join(short, 'cc-socks', '4194304.sock')) <= 103, short);
  assert.ok(short.startsWith(`${bare.tmp.TMPDIR}-own`), `beside claude's TMPDIR: ${short}`);
  assert.ok(!seen.stdout.includes('TMPDIR'), seen.stdout);
  // Under a root too deep for the sockets, the caller's TMPDIR stays, and
  // spawn says so: under the home the agent's https fails, and under /tmp
  // other agents' proxy sockets are in reach. A fresh task, since a worker
  // keeps the scratch its first spawn recorded.
  const other = setup(t, 'claude');
  const deep = spawnSeen(path.join(other.base, 'a-cache-root-deep-enough-that-no-socket-path-fits-under-it'), other);
  assert.equal(deep.tmp.TMPDIR, caller);
  assert.ok(deep.stdout.includes(`keeps the caller's TMPDIR ${caller}`), deep.stdout);
});

test('claude: sandbox.session_bus grants the bus socket, read and write, and off it grants nothing', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  // The runtime directory is the test's own, so the host's session bus never matters.
  // The stub never connects, so an empty file stands in for the socket.
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(path.join(runtime, 'systemd'), { recursive: true });
  const bus = path.join(fs.realpathSync(runtime), 'bus');
  const manager = path.join(fs.realpathSync(runtime), 'systemd', 'private');
  fs.writeFileSync(bus, '');
  fs.writeFileSync(manager, '');
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  const env = { ...h.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  const spawnSeen = () => {
    releaseExited(h);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };

  const off = spawnSeen();
  assert.ok(!off.sandbox.filesystem.allowRead.includes(bus), 'off by default: no read grant');
  assert.ok(!off.sandbox.filesystem.allowWrite.includes(bus), 'off by default: no write grant');

  assert.equal(h.run(['project', 'set', '--session-bus', 'maybe']).code, 2);
  h.ok(['project', 'set', '--session-bus', 'true']);
  fs.rmSync(bus);
  releaseExited(h);
  const refused = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.notEqual(refused.code, 0, 'a missing bus socket refuses the spawn');
  assert.match(refused.stderr, /\/bus/);
  fs.writeFileSync(bus, '');
  const on = spawnSeen();
  assert.ok(on.sandbox.filesystem.allowRead.includes(bus), 'the sandbox reads the bus socket');
  assert.ok(on.sandbox.filesystem.allowWrite.includes(bus), 'the sandbox writes the bus socket');
  assert.ok(!on.sandbox.filesystem.allowRead.includes(manager), 'the user manager socket stays unreadable: a scope cannot start through it from the sandbox');
  assert.ok(!on.sandbox.filesystem.allowWrite.includes(manager), 'the user manager socket stays unwritable');
  assert.ok(on.sandbox.filesystem.denyRead.includes(fs.realpathSync(runtime)), 'the rest of the runtime directory stays denied');
  assert.deepEqual(on.sandbox.filesystem.allowWrite.filter((p) => p.startsWith(fs.realpathSync(runtime))), [bus], 'only the bus socket is writable under the runtime directory');
  assert.deepEqual(on.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` });

  h.ok(['project', 'set', '--session-bus', 'false']);
  assert.ok(!spawnSeen().sandbox.filesystem.allowRead.includes(bus), 'false turns the grant off again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'project.json'), 'utf8')).sandbox, undefined);
});

// Found in review 2026-10-14: the codex profile read /run whole, so a codex
// agent reached the user's session bus, and through it ran host commands with
// systemd-run --user, and the docker socket. test/live-sandbox.test.js runs
// both against the real codex sandbox.
test('codex: the profile hides /run but the resolver, and a runtime directory elsewhere, and sandbox.session_bus reopens the bus alone', { skip: (NO_STUBS || !fs.existsSync('/var/tmp')) && 'needs /var/tmp' }, (t) => {
  const h = setup(t, 'codex');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  fs.writeFileSync(path.join(bin, 'codex'), [
    `#!${process.execPath}`, "'use strict';",
    'const fs = require("node:fs"), path = require("node:path");',
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), config: fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"), env: { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } }));`,
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "bus" }));', '',
  ].join('\n'), { mode: 0o755 });
  // Outside the home, an entry of / exposes it as one does /run/user/<uid>.
  // The stub never connects, so empty files stand in for the sockets.
  // The runtime directory sits one level down, so the directory on the way
  // is the test's own and holds what the profile must handle there.
  const way = fs.realpathSync(fs.mkdtempSync('/var/tmp/tower-crane-runtime-'));
  const runtime = path.join(way, 'rt');
  const beside = fs.realpathSync(fs.mkdtempSync('/var/tmp/tower-crane-beside-'));
  t.after(() => {
    fs.rmSync(way, { recursive: true, force: true });
    fs.rmSync(beside, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(runtime, 'systemd'), { recursive: true });
  // A name with DEL, which TOML forbids raw, and a link, which codex would follow.
  const del = path.join(way, 'del\x7f');
  fs.mkdirSync(del);
  fs.symlinkSync(h.base, path.join(way, 'link'));
  const bus = path.join(runtime, 'bus');
  for (const f of [bus, path.join(runtime, 'systemd', 'private'), path.join(runtime, 'openssh_agent')]) fs.writeFileSync(f, '');
  const env = { ...h.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_HOME: '' };
  const spawnSeen = () => {
    releaseExited(h);
    h.ok(['spawn', '--task', 'T1', '--wait'], { env });
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    return { rules: TOML.parse(seen.config).permissions['tower-crane'].filesystem, env: seen.env, config: seen.config };
  };
  const refused = (spawnEnv = env) => {
    releaseExited(h);
    const r = h.run(['spawn', '--task', 'T1', '--wait'], { env: spawnEnv });
    assert.notEqual(r.code, 0, 'spawn refuses');
    return r.stderr;
  };
  const uid = process.getuid();
  // Whether a rule mounts p: codex mounts only what its rules name.
  const mounted = (rules, p) => Object.entries(rules).some(([r, a]) => !r.startsWith(':') && a !== 'none' && (p === r || p.startsWith(`${r}/`)))
    && !Object.entries(rules).some(([r, a]) => a === 'none' && (p === r || p.startsWith(`${r}/`)));
  const off = spawnSeen();
  assert.equal(off.rules[runtime], 'none', 'the runtime directory is hidden');
  // /run is no rule, so nothing in it is mounted but the resolver.
  for (const p of [`/run/user/${uid}/bus`, '/run/docker.sock', '/var/run/docker.sock', '/run/dbus/system_bus_socket', '/run/snapd.socket']) {
    assert.equal(mounted(off.rules, fs.existsSync(p) ? fs.realpathSync(p) : p), false, `${p} is hidden`);
  }
  for (const p of ['/run', '/var/run']) assert.equal(off.rules[p], undefined, `${p} is not mounted`);
  if (fs.existsSync('/run/systemd/resolve')) assert.equal(off.rules['/run/systemd/resolve'], 'read', 'the resolver stays');
  assert.equal(off.rules[bus], undefined, 'off by default: no bus grant');
  assert.equal(off.env.DBUS_SESSION_BUS_ADDRESS, '');

  h.ok(['project', 'set', '--session-bus', 'true']);
  const on = spawnSeen();
  assert.equal(on.rules[bus], 'read', 'the bus socket is reachable: a readable rule mounts it');
  assert.equal(mounted(on.rules, bus), true, 'the bus socket is mounted');
  // codex cannot reopen a path inside a hidden one, so the runtime directory
  // is left unmounted, and the bus socket is mounted alone.
  for (const p of ['systemd/private', 'openssh_agent', 'made-after-spawn.sock']) assert.equal(mounted(on.rules, path.join(runtime, p)), false, `${p} is not mounted`);
  assert.equal(on.rules['/var'], undefined, '/var is not mounted whole');
  assert.equal(mounted(on.rules, path.join(way, 'made-after-spawn')), false, 'nor is a later entry on the way to the runtime directory');
  assert.equal(mounted(on.rules, path.join('/var/tmp', 'made-after-spawn')), false, 'or in /var/tmp');
  assert.equal(mounted(on.rules, beside), true, 'a directory beside it stays readable');
  for (const p of ['/var/lib', '/var/cache']) if (fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink()) assert.equal(mounted(on.rules, p), true, `${p} stays readable`);
  assert.equal(on.rules[del], 'read', 'an entry named with DEL is listed');
  assert.doesNotMatch(on.config, /\x7f/, 'and written escaped, since TOML forbids DEL raw');
  assert.equal(mounted(on.rules, path.join(way, 'link')), false, 'a link is never listed: codex would follow it');
  assert.deepEqual(on.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` });

  // Each entry on the way is a rule, and codex takes the profile as one
  // argument of at most 128 KiB: spawn refuses and names the directory.
  const many = 700;
  for (let i = 0; i < many; i++) fs.writeFileSync(path.join(way, `${String(i).padStart(4, '0')}-${'x'.repeat(180)}`), '');
  const tooMany = refused();
  assert.match(tooMany, /sandbox\.session_bus/);
  assert.ok(tooMany.includes(`${way} holds ${many + 1}`), `names the directory and its count: ${tooMany}`);
  for (const name of fs.readdirSync(way)) if (name.endsWith('x'.repeat(180))) fs.rmSync(path.join(way, name));

  // A writable rule mounts the runtime directory whole.
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ write: [way], session_bus: true })]);
  const written = refused();
  assert.match(written, /sandbox\.session_bus/);
  assert.ok(written.includes(`${runtime} lies in ${way}, which the codex sandbox writes`), written);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ session_bus: true })]);
  assert.equal(spawnSeen().rules[bus], 'read', 'without it the bus is granted again');

  // The worktree is the workspace root, which codex mounts whole.
  const worktree = fs.realpathSync(JSON.parse(fs.readFileSync(out, 'utf8')).cwd);
  const inside = path.join(worktree, '.runtime');
  fs.mkdirSync(inside);
  fs.writeFileSync(path.join(inside, 'bus'), '');
  const inWorktree = refused({ ...env, XDG_RUNTIME_DIR: inside });
  assert.match(inWorktree, /sandbox\.session_bus/);
  assert.ok(inWorktree.includes(`${inside} lies in the agent's worktree ${worktree}`), inWorktree);
  fs.rmSync(inside, { recursive: true });
});

// codex's :minimal mounts /usr and /etc whole, so a runtime directory there
// cannot be left out; spawn cannot place a bus socket there in a test, so
// the check runs in process.
test('codex: sandbox.session_bus refuses a runtime directory a writable rule or a system directory mounts whole', { skip: process.platform !== 'linux' && 'the session bus grant and its POSIX paths are Linux only' }, () => {
  const cases = [
    ['under a writable rule', '/var/tmp/x/rt', { '/var/tmp/x': 'write' }, [], /lies in \/var\/tmp\/x, which the codex sandbox writes/],
    ['a writable rule itself', '/var/tmp/x/rt', { '/var/tmp/x/rt': 'write' }, [], /lies in \/var\/tmp\/x\/rt, which the codex sandbox writes/],
    ['under /usr', '/usr/local/rt', { '/usr/local': 'read' }, ['/usr', '/etc'], /lies in \/usr, which the codex sandbox mounts whole/],
    ['under /etc', '/etc/rt', {}, ['/usr', '/etc'], /lies in \/etc, which the codex sandbox mounts whole/],
    ['under a readable rule', '/var/tmp/x/rt', { '/var': 'read' }, ['/usr', '/etc'], null],
    ['under /run', '/run/user/1000', {}, ['/usr', '/etc'], null],
    ['in the agent\'s worktree', '/w/T1/.rt', { '/var': 'read' }, ['/usr', '/etc'], /lies in the agent's worktree \/w\/T1, which the codex sandbox mounts whole/, '/w/T1'],
    ['beside the agent\'s worktree', '/w/T1-rt', {}, ['/usr', '/etc'], null, '/w/T1'],
  ];
  for (const [what, dir, rules, system, refusal, worktree = '/w/T9'] of cases) {
    const why = A.wholeMount(dir, rules, system, worktree);
    if (refusal) assert.match(why, refusal, what);
    else assert.equal(why, null, what);
  }
});

test('claude: sandbox.session_bus grants the sockets the worker env names, even when the spawning env names none', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  // The spawning environment names a runtime directory with no bus; the project's env names one that has both sockets.
  const absent = path.join(h.base, 'absent');
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(path.join(runtime, 'systemd'), { recursive: true });
  const bus = path.join(fs.realpathSync(runtime), 'bus');
  const manager = path.join(fs.realpathSync(runtime), 'systemd', 'private');
  fs.writeFileSync(bus, '');
  fs.writeFileSync(manager, '');
  const env = { ...h.env, XDG_RUNTIME_DIR: absent, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(absent, 'bus')}`,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  h.ok(['project', 'set', '--session-bus', 'true', '--env', JSON.stringify({ XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` })]);
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` });
  assert.ok(seen.sandbox.filesystem.allowRead.includes(bus), 'the bus the worker env names is granted');
  assert.ok(!seen.sandbox.filesystem.allowWrite.includes(manager), 'the manager socket in that runtime stays denied');
  assert.ok(seen.sandbox.filesystem.denyRead.includes(fs.realpathSync(runtime)), 'that runtime is denied');
});

test('claude: sandbox.session_bus addresses the bus of the runtime the env_file names, not the spawning one', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  // The spawning environment names a runtime directory with no bus, and an empty bus address; the env_file moves the worker to a runtime that has one.
  const parent = path.join(h.base, 'parent');
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(parent);
  fs.mkdirSync(runtime);
  const bus = path.join(fs.realpathSync(runtime), 'bus');
  fs.writeFileSync(bus, '');
  const file = path.join(h.base, 'worker.env');
  fs.writeFileSync(file, `XDG_RUNTIME_DIR=${runtime}\n`);
  const env = { ...h.env, XDG_RUNTIME_DIR: parent, DBUS_SESSION_BUS_ADDRESS: '',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  h.ok(['project', 'set', '--session-bus', 'true', '--env_file', file]);
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(seen.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'bus')}` });
  assert.ok(seen.sandbox.filesystem.allowRead.includes(bus), 'the sandbox grants the socket the bus address names');
  assert.ok(seen.sandbox.filesystem.allowWrite.includes(bus), 'the sandbox writes the socket the bus address names');
});

test('claude: the runtime the spawning env names stays denied when the project env names another', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(h.base, 'result.json');
  writeClaudeStub(bin, out);
  // Both runtimes sit outside /run/user/<uid>, so only the sandbox's own denial hides the spawning one.
  const host = path.join(h.base, 'host-runtime');
  const runtime = path.join(h.base, 'runtime');
  fs.mkdirSync(host);
  fs.mkdirSync(runtime);
  const bus = path.join(fs.realpathSync(runtime), 'bus');
  const env = { ...h.env, XDG_RUNTIME_DIR: host, DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(host, 'bus')}`,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  h.ok(['project', 'set', '--env', JSON.stringify({ XDG_RUNTIME_DIR: runtime })]);
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  const off = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(off.env.XDG_RUNTIME_DIR, runtime, 'the worker starts in the project runtime');
  assert.ok(off.sandbox.filesystem.denyRead.includes(fs.realpathSync(host)), 'off: the spawning runtime stays denied');
  assert.ok(off.sandbox.filesystem.denyRead.includes(fs.realpathSync(runtime)), 'off: the worker runtime stays denied');

  fs.writeFileSync(bus, '');
  h.ok(['project', 'set', '--session-bus', 'true']);
  releaseExited(h);
  h.ok(['spawn', '--task', 'T1', '--wait'], { env });
  const on = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(on.sandbox.filesystem.denyRead.includes(fs.realpathSync(host)), 'on: the spawning runtime stays denied');
  assert.ok(on.sandbox.filesystem.denyRead.includes(fs.realpathSync(runtime)), 'on: the worker runtime stays denied');
  assert.deepEqual(on.sandbox.filesystem.allowRead.filter((p) => p.startsWith(fs.realpathSync(host))), [], 'on: no socket in the spawning runtime is granted');
  assert.ok(on.sandbox.filesystem.allowRead.includes(bus), 'on: the worker bus is granted');
});

test('claude: dry-run never reads env_file, and a real spawn that cannot read it refuses', { skip: NO_STUBS }, (t) => {
  const h = setup(t, 'claude');
  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  writeClaudeStub(bin, path.join(h.base, 'result.json'));
  const env = { ...h.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: '' };
  h.ok(['project', 'set', '--session-bus', 'true', '--env_file', path.join(h.base, 'missing.env')]);
  h.ok(['spawn', '--task', 'T1', '--dry-run'], { env });
  const real = h.run(['spawn', '--task', 'T1', '--wait'], { env });
  assert.notEqual(real.code, 0, 'the real spawn refuses');
  assert.match(real.stderr, /cannot read env_file/);
});
