'use strict';

const test = require('node:test');
const StateFiles = require('./state-files');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const { promisify } = require('node:util');
const { makeRepo, ownerFallbacks } = require('./helpers');
const { fileWritten: waitForFile } = require('./signals');
const A = require('../lib/agents');
const S = require('../lib/state');

const STUB = path.join(__dirname, 'fixtures', 'opencode-stub.js');
const NO_STUBS = process.platform === 'win32' && 'harness stub is a shebang script';

function setup(t, rung = 'medium', inheritedPathName = null) {
  const h = makeRepo(t);
  const home = path.join(h.base, 'user');
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const global = path.join(home, '.config', 'opencode');
  const memory = path.join(home, 'memory.md');
  const rules = path.join(global, 'rules', 'approved.json');
  const descriptions = path.join(home, 'mcp-tools.txt');
  put(memory, 'PLANTED-MEMORY\n' + 'm'.repeat(8192));
  put(descriptions, 'PLANTED-MCP\n' + 't'.repeat(4096));
  put(path.join(global, 'AGENTS.md'), 'OPENCODE-HOUSE-RULE\n');
  put(rules, '{"PLANTED-RULE":"allow"}\n');
  const userConfig = {
    instructions: [memory, rules], plugin: ['planted-plugin'],
    permission: { bash: { 'planted-command *': 'allow' } },
    mcp: { planted: { type: 'local', command: ['node', descriptions], enabled: true, environment: { TOKEN: 'PLANTED-SECRET' } } },
  };
  put(path.join(global, 'opencode.json'), JSON.stringify(userConfig));
  put(path.join(global, 'skills', 'planted', 'SKILL.md'), '---\nname: planted\ndescription: PLANTED-SKILL ' + 's'.repeat(512) + '\n---\nuser skill body\n');
  put(path.join(home, '.local', 'share', 'opencode', 'auth.json'), '{"fixture":{"type":"api","key":"PLANTED-SECRET"}}');
  put(path.join(h.base, 'AGENTS.md'), 'ANCESTOR-RULE\n');
  put(path.join(h.repo, 'AGENTS.md'), 'REPO-RULE\n');
  put(path.join(h.repo, 'CLAUDE.md'), 'REPO-CLAUDE-RULE\n');
  put(path.join(h.repo, 'opencode.json'), JSON.stringify({ instructions: [memory], mcp: { project: userConfig.mcp.planted }, plugin: ['project-plugin'] }));
  put(path.join(h.repo, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { directory: userConfig.mcp.planted } }));
  h.git(['add', '.']);
  h.git(['commit', '-qm', 'fixture config']);
  h.init();
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'isolate opencode']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  h.ok(['ladder', 'set', rung, '--harness', 'opencode', '--model', 'fixture/model', '--clear', 'profile', '--clear', 'effort', '--clear', 'args']);
  const bin = path.join(h.base, 'bin');
  put(path.join(bin, 'opencode'), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)});\n`);
  fs.chmodSync(path.join(bin, 'opencode'), 0o755);
  const out = path.join(h.base, 'stub.json');
  if (inheritedPathName) {
    const key = Object.keys(h.env).find((name) => name.toUpperCase() === 'PATH');
    if (key && key !== inheritedPathName) {
      h.env[inheritedPathName] = h.env[key];
      delete h.env[key];
    }
  }
  const pathKey = Object.keys(h.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...h.env, HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), GH_CONFIG_DIR: path.join(home, '.config', 'gh'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG: path.join(global, 'opencode.json'), OPENCODE_CONFIG_DIR: global,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig), OPENCODE_PERMISSION: '{"*":"allow"}',
    [pathKey]: `${bin}${path.delimiter}${h.env[pathKey] || ''}`, STUB_OUT: out, GH_TOKEN: 'fixture-gh',
  };
  return { h, home, env, out, rung, global, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const dry = (f) => f.h.json(['spawn', '--task', 'T1', '--role', f.rung, '--dry-run'], { env: f.env });
const spawn = (f, env = {}) => f.h.ok(['spawn', '--task', 'T1', '--role', f.rung, '--wait'], { env: { ...f.env, ...env } });
function releaseStub(f) {
  const claim = f.h.readState('tasks.json').tasks[0].claim;
  assert.ok(claim, 'the completed stub retains its task claim until release');
  f.h.ok(['release', 'T1', '--agent', claim.agent, '--reason', 'stub run completed']);
  assert.equal(f.h.readState('tasks.json').tasks[0].claim, null);
}

for (const [name, content] of [
  ['__proto__', '{"__proto__":{"default_agent":"polluted-agent"},"normal":{"enabled":true}}'],
  ['constructor', '{"constructor":{"prototype":{"default_agent":"polluted-agent"}},"normal":{"enabled":true}}'],
  ['nested keys', '{"normal":{"enabled":true,"__proto__":{"default_agent":"polluted-agent"},"constructor":{"prototype":{"default_agent":"polluted-agent"}},"prototype":{"unsafe":true}}}'],
]) {
  test(`opencode stub ignores ${name} without changing object prototypes`, (t) => {
    const f = setup(t);
    const result = cp.spawnSync(process.execPath, [STUB], {
      cwd: f.h.repo, env: { ...f.env, OPENCODE_CONFIG_CONTENT: content },
      encoding: 'utf8', timeout: 300000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = f.report();
    assert.equal(report.name, 'build');
    assert.deepEqual(report.config.normal, { enabled: true });
    assert.ok(!Object.hasOwn(report.config, '__proto__'));
    assert.ok(!Object.hasOwn(report.config, 'constructor'));
  });
}

test('opencode dry-run preserves Git lookup with an inherited mixed-case Path', (t) => {
  const f = setup(t, 'small', 'Path');
  // Node on Windows sorts environment keys and passes only the first
  // case-insensitive PATH entry. Reproduce that selection on POSIX too.
  const keys = Object.keys(f.env).filter((key) => key.toUpperCase() === 'PATH').sort();
  const env = { ...f.env };
  for (const key of keys) delete env[key];
  env.PATH = f.env[keys[0]];
  const preview = f.h.json(['spawn', '--task', 'T1', '--role', 'small', '--dry-run'], { env });
  assert.equal(preview.startup.target.id, 'T1');
  assert.ok(preview.argv.includes('gishra-small'));
});

test('opencode launch replaces the caller PWD with its task worktree', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  f.env.PWD = f.h.repo;
  const preview = dry(f);
  assert.notEqual(preview.cwd, f.h.repo);
  assert.equal(preview.env.PWD, preview.cwd);
  spawn(f);
  assert.equal(f.report().pwd, f.report().cwd);
  assert.equal(f.report().cwd, preview.cwd);
});

for (const [input, selected] of [
  ['file', { type: 'api', key: 'SELECTED-API-CANARY' }],
  ['inline', { type: 'oauth', access: 'SELECTED-ACCESS-CANARY', refresh: 'SELECTED-REFRESH-CANARY', expires: 9999999999999 }],
]) {
  test(`opencode ${input} auth copy contains only the rung provider and excludes a raw source link`, { skip: NO_STUBS }, (t) => {
    const f = setup(t);
    const auth = {
      fixture: selected,
      unrelated: { type: 'api', key: 'UNRELATED-API-CANARY' },
      oauth: { type: 'oauth', access: 'UNRELATED-ACCESS-CANARY', refresh: 'UNRELATED-REFRESH-CANARY', expires: 9999999999999 },
      'http://127.0.0.1:1': { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'REMOTE-CANARY' },
    };
    const source = path.join(f.home, '.local', 'share', 'opencode', 'auth.json');
    if (input === 'file') fs.writeFileSync(source, JSON.stringify(auth));
    const original = fs.readFileSync(source, 'utf8');
    // A global default from another provider must not widen the rung's auth.
    f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'unrelated/model' });
    spawn(f, input === 'inline' ? { OPENCODE_AUTH_CONTENT: JSON.stringify(auth) } : {});
    const report = f.report();
    assert.deepEqual(JSON.parse(fs.readFileSync(report.authPath, 'utf8')), { fixture: selected });
    assert.deepEqual(report.authKinds, { fixture: selected.type });
    assert.deepEqual(report.remoteContacts, []);
    assert.ok(!fs.existsSync(path.join(report.data, 'auth-source.json')));
    assert.equal(fs.readFileSync(source, 'utf8'), original);
    if (process.platform !== 'win32') assert.equal(fs.statSync(report.authPath).mode & 0o777, 0o600);
    assert.equal(dry(f).env.TOWER_CRANE_SANDBOX, '0');
  });
}

test('opencode auth refresh reads the private replacement instead of the launch snapshot', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const source = path.join(f.home, '.local', 'share', 'opencode', 'auth.json');
  const original = fs.readFileSync(source, 'utf8');
  const auth = {
    fixture: { type: 'api', key: 'INITIAL-API-CANARY' },
    'http://127.0.0.1:1': { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'REMOTE-AUTH-CANARY' },
  };
  const replacement = { fixture: { type: 'oauth', access: 'REFRESHED-ACCESS-CANARY', refresh: 'ROTATED-REFRESH-CANARY', expires: 9999999999999 } };
  spawn(f, { OPENCODE_AUTH_CONTENT: JSON.stringify(auth), STUB_REFRESH_AUTH: JSON.stringify(replacement) });
  const report = f.report();
  assert.deepEqual(report.authKinds, { fixture: 'api' });
  assert.deepEqual(report.remoteContacts, []);
  assert.deepEqual(report.refreshedKinds, { fixture: 'oauth' });
  assert.equal(report.refreshVisible, true);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(dry(f).env.OPENCODE_AUTH_CONTENT, '');
  if (process.platform !== 'win32') assert.equal(fs.statSync(report.authPath).mode & 0o777, 0o600);
});

test('native opencode auth lookups observe a rotated OAuth store with the real launch env', {
  skip: NO_STUBS || !process.env.TOWER_CRANE_NATIVE_OPENCODE,
  timeout: 300000,
}, async (t) => {
  const f = setup(t);
  const source = path.join(f.home, '.local', 'share', 'opencode', 'auth.json');
  const original = fs.readFileSync(source, 'utf8');
  const wrapper = path.join(f.h.base, 'bin', 'opencode');
  fs.writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const lookup = () => {
  const result = cp.spawnSync(${JSON.stringify(process.env.TOWER_CRANE_NATIVE_OPENCODE)}, ['auth', 'list'], {
    env: process.env, encoding: 'utf8', timeout: 300000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout + result.stderr;
};
const before = lookup();
const authPath = path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json');
fs.writeFileSync(authPath, JSON.stringify({
  fixture: { type: 'oauth', access: 'NATIVE-REFRESHED-ACCESS', refresh: 'NATIVE-ROTATED-REFRESH', expires: 9999999999999 },
}), { mode: 0o600 });
const after = lookup();
fs.writeFileSync(process.env.STUB_OUT, JSON.stringify({ before, after }));
`);
  const auth = {
    fixture: { type: 'api', key: 'NATIVE-INITIAL-API' },
    'http://127.0.0.1:1': { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'REMOTE-AUTH-CANARY' },
  };
  const result = await f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...f.env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth), OPENCODE_DISABLE_MODELS_FETCH: '1' },
  });
  assert.equal(result.code, 0, result.stderr);
  const report = f.report();
  const clean = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(clean(report.before), /fixture\s+api/);
  assert.match(clean(report.after), /fixture\s+oauth/);
  assert.doesNotMatch(clean(report.after), /fixture\s+api/);
  assert.doesNotMatch(report.before + report.after, /wellknown/);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
});

test('opencode isolates config, memory, skills, MCP, approved rules and credentials; measures startup', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const before = [];
  const after = [];
  for (let i = 0; i < 3; i++) {
    if (i) releaseStub(f);
    const preview = dry(f);
    const baseline = cp.spawnSync(process.execPath, [STUB, ...preview.argv.slice(1)], { cwd: f.h.repo, env: f.env, encoding: 'utf8', timeout: 300000 });
    assert.equal(baseline.status, 0, baseline.stderr);
    const inherited = f.report();
    assert.ok(inherited.memory.join('').includes('PLANTED-MEMORY'));
    assert.ok(inherited.memory.join('').includes('PLANTED-RULE'));
    assert.equal(inherited.config.permission.bash['planted-command *'], 'allow');
    assert.ok(inherited.mcp.planted);
    before.push(inherited.context_bytes);
    spawn(f);
    const report = f.report();
    const own = path.dirname(report.home);
    assert.ok(own.startsWith(path.join(f.h.state, 'homes') + path.sep));
    assert.equal(report.name, 'gishra-worker');
    assert.ok(report.agent.startsWith('---\n'));
    assert.deepEqual(report.mcp, {});
    assert.deepEqual(report.memory, []);
    assert.deepEqual(report.skills, ['tower-crane-work']);
    assert.equal(report.config.plugin.length, 1);
    assert.ok(report.config.plugin[0].endsWith('/hook.mjs'));
    assert.ok(!JSON.stringify(report).includes('PLANTED-'));
    assert.ok(!fs.existsSync(path.join(report.data, 'auth-source.json')));
    assert.deepEqual(report.authKinds, { fixture: 'api' });
    assert.ok(!fs.existsSync(path.join(own, 'rules', 'approved.json')));
    after.push(report.context_bytes);
  }
  assert.ok(Math.max(...after) < Math.min(...before));
  console.log('opencode startup bytes', JSON.stringify({ before, after }));
});

test('opencode excludes credential-triggered remote instructions, plugins and MCP at startup', { skip: NO_STUBS }, async (t) => {
  const f = setup(t);
  const instruction = path.join(f.h.base, 'remote-instructions.md');
  fs.writeFileSync(instruction, 'REMOTE-INSTRUCTION-CANARY\n');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/.well-known/opencode');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ config: {
      instructions: [instruction], plugin: ['remote-plugin-canary'],
      mcp: { remoteCanary: { type: 'local', command: ['node', 'remote-server-canary'], enabled: true } },
    } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const authPath = path.join(f.home, '.local', 'share', 'opencode', 'auth.json');
  const auth = {
    [url]: { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'REMOTE-SECRET-CANARY' },
    fixture: { type: 'api', key: 'API-SECRET-CANARY' },
    oauth: { type: 'oauth', access: 'ACCESS-SECRET-CANARY', refresh: 'REFRESH-SECRET-CANARY', expires: 9999999999999 },
  };
  fs.writeFileSync(authPath, JSON.stringify(auth));
  const preview = dry(f);
  await promisify(cp.execFile)(process.execPath, [STUB, ...preview.argv.slice(1)], {
    cwd: f.h.repo, env: f.env, timeout: 300000,
  });
  const baseline = f.report();
  assert.ok(baseline.memory.some((text) => text.includes('REMOTE-INSTRUCTION-CANARY')));
  assert.ok(baseline.config.plugin.includes('remote-plugin-canary'));
  assert.ok(baseline.mcp.remoteCanary);
  assert.equal(requests, 1);
  const result = await f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], { env: f.env });
  assert.equal(result.code, 0, result.stderr);
  const report = f.report();
  assert.equal(requests, 1, 'isolated dispatch must not contact the remote configuration endpoint');
  assert.deepEqual(report.remoteContacts, []);
  assert.deepEqual(report.authKinds, { fixture: 'api' });
  assert.deepEqual(JSON.parse(fs.readFileSync(report.authPath, 'utf8')), { fixture: auth.fixture });
  assert.ok(!report.memory.some((text) => text.includes('REMOTE-INSTRUCTION-CANARY')));
  assert.ok(!report.config.plugin.includes('remote-plugin-canary'));
  assert.deepEqual(report.mcp, {});
  const source = fs.openSync(authPath, 'r');
  try {
    fs.writeFileSync(report.authPath, '{"fixture":{"type":"oauth","access":"refreshed"}}');
    assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), auth, 'agent auth writes must not alter the source credential store');
  } finally {
    fs.closeSync(source);
  }
  const visible = JSON.stringify(preview) + result.stdout
    + StateFiles.logText(f.h.state)
    + fs.readFileSync(path.join(path.dirname(report.home), 'opencode.json'), 'utf8');
  assert.ok(!visible.includes('SECRET-CANARY'));
  releaseStub(f);
  const inherited = await f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
    env: { ...f.env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth) },
  });
  assert.equal(inherited.code, 0, inherited.stderr);
  assert.equal(requests, 1, 'an inherited auth override must exclude remote discovery too');
  assert.deepEqual(f.report().authKinds, { fixture: 'api' });
  assert.ok(!JSON.stringify(dry(f)).includes('SECRET-CANARY'));
});

test('opencode research selects its role agent and permits native web tools', { skip: NO_STUBS }, (t) => {
  const f = setup(t, 'research');
  spawn(f, { STUB_PROBES: '[["webfetch","https://example.invalid"],["websearch","query"],["task","general"]]' });
  assert.equal(f.report().name, 'gishra-researcher');
  assert.deepEqual(f.report().probes, ['allow', 'allow', 'deny']);
});

for (const change of ['tier', 'ladder']) {
  test(`opencode launch filters credentials from the final ${change} after worktree preparation`, { skip: NO_STUBS }, async (t) => {
    const f = setup(t, 'hard');
    const instruction = path.join(f.h.base, 'race-instructions.md');
    fs.writeFileSync(instruction, 'RACE-REMOTE-INSTRUCTION\n');
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      assert.equal(req.url, '/.well-known/opencode');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ config: {
        instructions: [instruction], plugin: ['race-remote-plugin'],
        mcp: { raceRemote: { type: 'local', command: ['node', 'race-remote-server'], enabled: true } },
      } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const auth = {
      [url]: { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'RACE-SECRET-REMOTE' },
      fixture: { type: 'api', key: 'RACE-SECRET-API' },
      oauth: { type: 'oauth', access: 'RACE-SECRET-ACCESS', refresh: 'RACE-SECRET-REFRESH', expires: 9999999999999 },
    };
    fs.writeFileSync(path.join(f.h.base, 'bin', 'claude'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    f.h.ok(['ladder', 'set', 'medium', '--harness', 'claude', '--model', 'opus',
      '--clear', 'profile', '--clear', 'effort', '--clear', 'args', '--clear', 'provider']);
    const stopped = path.join(f.h.base, 'preparation-paused');
    const run = f.h.runAsync(['spawn', '--task', 'T1', '--wait', '--json'], {
      env: { ...f.env, CLAUDE_CONFIG_DIR: path.join(f.home, '.claude'), OPENCODE_AUTH_CONTENT: JSON.stringify(auth) },
      hooks: { HOOK_STOP_WORKTREE_ADD: stopped },
    });
    let result;
    try {
      await waitForFile(stopped);
      if (change === 'tier') f.h.ok(['task', 'update', 'T1', '--tier', 'hard']);
      else f.h.ok(['ladder', 'set', 'medium', '--harness', 'opencode', '--model', 'fixture/model']);
    } finally {
      fs.writeFileSync(`${stopped}.go`, '');
      result = await run;
    }
    assert.equal(result.code, 0, result.stderr);
    const started = JSON.parse(result.stdout);
    assert.equal(started.harness, 'opencode');
    assert.equal(started.rung, change === 'tier' ? 'hard' : 'medium');
    const report = f.report();
    assert.equal(requests, 0, 'final launch must not fetch unselected remote config');
    assert.deepEqual(report.remoteContacts, []);
    assert.deepEqual(report.authKinds, { fixture: 'api' });
    assert.ok(!report.memory.join('').includes('RACE-REMOTE-INSTRUCTION'));
    assert.ok(!report.config.plugin.includes('race-remote-plugin'));
    assert.deepEqual(report.mcp, {});
    const events = StateFiles.logText(f.h.state);
    assert.ok(!(result.stdout + events).includes('RACE-SECRET'));
  });
}

test('a fallback into opencode receives filtered auth instead of restoring remote discovery', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const auth = {
    'http://127.0.0.1:1': { type: 'wellknown', key: 'REMOTE_TOKEN', token: 'FALLBACK-SECRET-CANARY' },
    fixture: { type: 'api', key: 'API-SECRET-CANARY' },
  };
  fs.writeFileSync(path.join(f.home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(auth));
  ownerFallbacks(f.h, 'medium', [{ harness: 'opencode', model: 'fixture/model' }]);
  const command = [process.execPath, '-e',
    'console.log(JSON.stringify({type:"turn.failed",error:{message:"HTTP 503 service unavailable"}}));process.exit(1)', '{prompt}'];
  f.h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify(command),
    '--clear', 'model', '--supervision', '{"retries":0,"backoff_ms":1,"max_backoff_ms":1}']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.authKinds, { fixture: 'api' });
  assert.deepEqual(report.remoteContacts, []);
  const events = StateFiles.logText(f.h.state).trim().split('\n').map(JSON.parse);
  assert.ok(events.some((event) => event.cmd === 'spawn fallback' && event.detail.harness === 'opencode'));
  assert.ok(!JSON.stringify(events).includes('SECRET-CANARY'));
});

test('opencode renders worker path, web, skill, git and gh permission decisions', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const preview = dry(f);
  const probes = [
    ['webfetch', 'https://example.invalid'], ['task', 'general'], ['skill', 'planted'],
    ['skill', 'tower-crane-work'], ['edit', path.join(preview.cwd, 'src', 'file.js')],
    ['edit', path.join(f.home, 'outside.js')], ['external_directory', '/unapproved/location/*'],
    ['bash', 'git push origin HEAD'], ['bash', 'git push --force origin HEAD'],
    ['bash', 'gh pr create --title probe'], ['bash', 'gh pr merge 1'], ['bash', 'gh issue list'],
    ['edit', '..\\unapproved\\outside.js'], ['edit', 'C:/unapproved/outside.js'],
  ];
  spawn(f, { STUB_PROBES: JSON.stringify(probes) });
  assert.deepEqual(f.report().probes, ['deny', 'deny', 'deny', 'allow', 'allow', 'deny', 'deny', 'allow', 'deny', 'allow', 'deny', 'allow', 'deny', 'deny']);
  assert.equal(preview.env.TOWER_CRANE_SANDBOX, '0');
  assert.equal(A.sandboxed('worker', 'opencode'), false);
  assert.ok(preview.startup.instructions_file.endsWith('/agents/gishra-worker.md'));
  assert.ok(preview.startup.rules.some((rule) => rule.path === path.join(f.global, 'AGENTS.md')));
  assert.ok(preview.startup.rules.every((rule) => rule.loaded === 'read'));
  const events = StateFiles.logText(f.h.state).trim().split('\n').map(JSON.parse);
  const receipt = events.findLast((event) => event.cmd === 'startup').detail;
  assert.ok(receipt.rules.every((rule) => rule.loaded === 'read'));
  assert.match(preview.argv.find((arg) => arg.includes('## Task')), /REPO-RULE|AGENTS\.md/);
});

for (const rung of ['medium', 'small']) {
  test(`opencode ${rung} Bash denies unlisted interpreter and absolute-path commands`, { skip: NO_STUBS }, (t) => {
    const f = setup(t, rung);
    const canary = path.join(f.h.base, 'outside-bash-canary.txt');
    const preview = dry(f);
    const probes = [['edit', canary], ...[
      'node -e "process.exit(0)"', 'python3 -c "pass"', 'curl https://example.invalid',
      '/usr/bin/git push origin HEAD', '/usr/bin/gh pr merge 1',
    ].map((command) => ['bash', command])];
    spawn(f, { STUB_BASH_CANARY: canary, STUB_PROBES: JSON.stringify(probes) });
    const report = f.report();
    assert.deepEqual(report.probes, ['deny', 'deny', 'deny', 'deny', 'deny', 'deny']);
    assert.equal(report.permission.bash['*'], 'deny');
    assert.equal(report.bash.decision, 'deny');
    assert.equal(report.bash.code, undefined);
    assert.throws(() => fs.readFileSync(canary, 'utf8'), { code: 'ENOENT' });
    assert.equal(preview.env.TOWER_CRANE_SANDBOX, '0');
    assert.deepEqual(A.CAPABILITIES.opencode, { sandbox: false, osSandbox: false });
    assert.equal(A.sandboxed(rung === 'small' ? 'small' : 'worker', 'opencode'), false);
  });
}

test('opencode worker headless Bash allows task commands, shim paths, tests and read-only tools', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const preview = dry(f);
  const probes = [
    'tower-crane claim T1 --agent worker-T1-1', 'git status --short',
    'npm test', 'npm run test', 'node --test test/value.test.js',
    'node test/value.test.js', 'cat AGENTS.md', 'rg TODO .', 'ls',
    `${path.join(preview.home.path, 'bin', 'git')} status --short`,
    `${path.join(preview.home.path, 'bin', 'gh')} pr view 1`,
  ].map((command) => ['bash', command]);
  spawn(f, { STUB_PROBES: JSON.stringify(probes) });
  assert.deepEqual(f.report().probes, probes.map(() => 'allow'));
  assert.ok(!Object.values(f.report().permission.bash).includes('ask'));
});

test('opencode allows Tower Crane repository scripts only when the main checkout has them', { skip: NO_STUBS }, (t) => {
  const scripts = ['scripts/check-shared-files.js', 'scripts/cli-docs.js'];
  const probes = scripts.map((script) => ['bash', `node ${script} --check`]);
  const bare = setup(t);
  spawn(bare, { STUB_PROBES: JSON.stringify(probes) });
  assert.deepEqual(bare.report().probes, ['deny', 'deny'], 'a user project has no such scripts');
  // A worker can plant the scripts in its own worktree; only the main checkout counts.
  const worktree = bare.report().cwd;
  assert.notEqual(fs.realpathSync(worktree), fs.realpathSync(bare.h.repo));
  for (const script of scripts) {
    fs.mkdirSync(path.join(worktree, path.dirname(script)), { recursive: true });
    fs.writeFileSync(path.join(worktree, script), '\n');
  }
  releaseStub(bare);
  spawn(bare, { STUB_PROBES: JSON.stringify(probes) });
  assert.equal(fs.realpathSync(bare.report().cwd), fs.realpathSync(worktree));
  assert.deepEqual(bare.report().probes, ['deny', 'deny'], 'scripts planted in the worktree grant nothing');

  const own = setup(t);
  for (const script of scripts) {
    fs.mkdirSync(path.join(own.h.repo, path.dirname(script)), { recursive: true });
    fs.writeFileSync(path.join(own.h.repo, script), '\n');
  }
  spawn(own, { STUB_PROBES: JSON.stringify(probes) });
  assert.deepEqual(own.report().probes, ['allow', 'allow']);
});

test('native opencode headless worker runs claim, git and tests and denies an unlisted command', {
  skip: !process.env.TOWER_CRANE_NATIVE_OPENCODE && 'set TOWER_CRANE_NATIVE_OPENCODE to the installed executable',
  timeout: 300000,
}, async (t) => {
  const f = setup(t);
  const native = process.env.TOWER_CRANE_NATIVE_OPENCODE;
  fs.mkdirSync(path.join(f.h.repo, 'test'));
  fs.writeFileSync(path.join(f.h.repo, 'test', 'headless.test.js'),
    "require('node:test')('headless workspace', () => require('node:assert/strict').equal(2 + 2, 4));\n");
  fs.writeFileSync(path.join(f.h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/headless.test.js' } }));
  f.h.git(['add', '.']);
  f.h.git(['commit', '-qm', 'headless test runner']);
  const commands = [
    'tower-crane claim T1 --agent worker-T1-1',
    'pwd',
    'git rev-parse --show-toplevel',
    'git status --short',
    'node --test test/headless.test.js',
    'npm test',
    'python3 -c "raise RuntimeError()"',
  ];
  let turn = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const command = request.tools?.some((tool) => tool.function?.name === 'bash') ? commands[turn++] : undefined;
    if (command === commands[0]) {
      f.h.ok(['msg', '--to', 'worker-T1-1', '--task', 'T1', 'NATIVE-INBOX-CANARY', '--agent', 'orchestrator']);
    }
    const calls = command ? [{ index: 0, id: `probe-${turn}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: 'headless native probe', timeout: 300000 }) } }] : undefined;
    const message = calls ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: 'probe done' };
    const base = { id: `mock-${turn}`, created: 1, model: 'mock' };
    if (request.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  fs.writeFileSync(path.join(f.global, 'opencode.json'), JSON.stringify({
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL },
      models: { mock: { name: 'mock', tool_call: true, limit: { context: 32768, output: 1024 } } } } },
  }));
  const bin = path.join(f.h.base, 'bin');
  fs.writeFileSync(path.join(bin, 'opencode'), `#!${process.execPath}
const cp = require('node:child_process');
const result = cp.spawnSync(${JSON.stringify(native)}, process.argv.slice(2), { stdio: 'inherit', timeout: 300000 });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tower-crane'), `#!${process.execPath}
const { fakeAgentEnv } = require(${JSON.stringify(path.join(__dirname, 'agent-env.js'))});
const cp = require('node:child_process');
const cli = require('node:path').join(require('node:path').dirname(process.env.TOWER_CRANE_HOOK), 'tool', 'bin', 'tower-crane.js');
const result = cp.spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { env: fakeAgentEnv(process.env), stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  f.h.ok(['ladder', 'set', 'medium', '--model', 'fixture/mock']);
  const result = await f.h.runAsync(['spawn', '--task', 'T1', '--wait'], {
    env: { ...f.env, PWD: f.h.repo, OPENCODE_CONFIG_CONTENT: '{}', OPENCODE_DISABLE_MODELS_FETCH: '1' },
  });
  let logs = '';
  if (result.code !== 0) {
    const logDir = path.join(f.h.state, 'homes', 'worker-T1-1', 'data', 'opencode', 'log');
    try {
      logs = fs.readdirSync(logDir).map((file) => fs.readFileSync(path.join(logDir, file), 'utf8')).join('\n');
    } catch (error) { logs = error.message; }
  }
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}\nmock requests: ${turn}\n${logs}`);
  const events = result.stdout.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const tools = events.filter((event) => event.part?.tool === 'bash').map((event) => event.part.state);
  assert.equal(tools.length, commands.length, result.stdout + result.stderr);
  for (const [index, command] of commands.slice(0, -1).entries()) {
    assert.equal(tools[index].input.command, command);
    assert.equal(tools[index].status, 'completed', JSON.stringify(tools[index]));
    assert.equal(tools[index].metadata.exit, 0, JSON.stringify(tools[index]));
  }
  assert.equal(tools.at(-1).status, 'error', JSON.stringify(tools.at(-1)));
  const audit = StateFiles.logText(f.h.state).trim().split('\n').map(JSON.parse);
  const worktree = fs.realpathSync(audit.findLast((event) => event.cmd === 'spawn').detail.cwd);
  assert.notEqual(worktree, fs.realpathSync(f.h.repo));
  assert.equal(tools[1].output.trim(), worktree);
  assert.equal(tools[2].output.trim(), worktree);
  assert.match(tools[4].output, /headless workspace/);
  assert.match(tools[5].output, /headless workspace/);
  assert.ok(audit.some((event) => event.cmd === 'hook inbox'), 'production plugin acknowledges the queued inbox');
  const progress = fs.readFileSync(S.progressFile(f.h.state, 'worker-T1-1'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(progress.some((event) => event.cmd === 'hook progress'), 'production tool hook runs');
  assert.ok(tools.some((tool) => tool.output?.includes('NATIVE-INBOX-CANARY')), 'production plugin delivers the queued inbox');
  assert.equal(f.h.readState('tasks.json').tasks[0].claim.agent, 'worker-T1-1');
});

test('opencode rung tool and MCP opt-ins appear in dry-run and exclude copied secrets', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  f.h.ok(['ladder', 'set', 'medium', '--tools', '["WebFetch","websearch"]', '--mcp', '["planted"]']);
  const preview = dry(f);
  assert.deepEqual(preview.home.tools, ['WebFetch', 'websearch']);
  assert.deepEqual(preview.home.mcp, ['planted']);
  assert.match(f.h.ok(['spawn', '--task', 'T1', '--dry-run'], { env: f.env }), /MCP servers: planted; opted-in tools: WebFetch, websearch/);
  spawn(f, { STUB_PROBES: '[["webfetch","https://example.invalid"],["websearch","query"],["planted_search","query"]]' });
  const report = f.report();
  assert.deepEqual(report.probes, ['allow', 'allow', 'allow']);
  assert.deepEqual(report.mcp.planted, { type: 'local', command: ['node', path.join(f.home, 'mcp-tools.txt')], enabled: true });
  assert.ok(!JSON.stringify(report.config).includes('PLANTED-SECRET'));
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["missing"]']);
  assert.match(f.h.run(['spawn', '--task', 'T1', '--dry-run'], { env: f.env }).stderr, /missing.*defines no|missing.*define none/);
});

test('opencode reads JSONC opt-ins and provider choices without user plugins or provider secrets', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.global, 'opencode.jsonc'), `{
    // User-selected connection and model, with trailing commas.
    "provider": { "fixture": { "npm": "@ai-sdk/openai-compatible", "bearer": "PLANTED-SECRET", "name": ["PLANTED-SECRET"],
      "options": { "baseURL": "https://provider.invalid/v1", "apiKey": "PLANTED-SECRET", "key": "PLANTED-SECRET", },
      "models": { "m": { "name": "M", "headers": { "X-Key": "PLANTED-SECRET" }, "limit": { "context": "PLANTED-SECRET" } } }, }, },
    "mcp": { "docs": { "type": "remote", "url": "https://docs.invalid/mcp",
      "headers": { "Authorization": "PLANTED-SECRET" }, "enabled": false, }, },
  }`);
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["docs"]']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.config.provider.fixture, {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://provider.invalid/v1' }, models: { m: { name: 'M' } },
  });
  assert.ok(!JSON.stringify(report.config).includes('PLANTED-SECRET'));
  assert.deepEqual(report.mcp.docs, { type: 'remote', url: 'https://docs.invalid/mcp', enabled: true });
  const own = path.dirname(report.home);
  const nested = f.h.json(['spawn', '--task', 'T1', '--dry-run'], { env: {
    ...f.env, HOME: report.home, USERPROFILE: report.home, OPENCODE_TEST_HOME: report.home,
    OPENCODE_CONFIG_DIR: own, OPENCODE_CONFIG: path.join(own, 'opencode.json'), OPENCODE_CONFIG_CONTENT: '{}',
    XDG_CONFIG_HOME: path.join(own, 'config'), XDG_DATA_HOME: path.join(own, 'data'),
  } });
  assert.ok(nested.startup.rules.some((rule) => rule.path === path.join(f.global, 'AGENTS.md')));
  assert.deepEqual(nested.home.mcp, ['docs']);
});

test('opencode recursively merges partial provider and MCP overrides across config layers', { skip: NO_STUBS }, (t) => {
  const f = setup(t);
  const base = {
    provider: { fixture: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://provider.invalid/v1', timeout: 1000, apiKey: 'PLANTED-SECRET' },
      models: { fixture: { limit: { context: 32000, output: 2000 } } },
    } },
    mcp: {
      docs: { type: 'local', command: ['node', 'base-server.js'], environment: { TOKEN: 'PLANTED-SECRET' } },
      remote: { type: 'remote', url: 'https://docs.invalid/mcp', headers: { Authorization: 'PLANTED-SECRET' } },
    },
  };
  fs.writeFileSync(path.join(f.global, 'opencode.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(f.global, 'opencode.jsonc'), JSON.stringify({
    provider: { fixture: { options: { timeout: 2000 }, models: { fixture: { limit: { output: 4000 } } } } },
    mcp: { docs: { enabled: false }, remote: { timeout: 3000 } },
  }));
  const custom = path.join(f.h.base, 'custom-opencode.json');
  fs.writeFileSync(custom, JSON.stringify({
    provider: { fixture: { options: { baseURL: 'https://override.invalid/v1' } } },
    mcp: { docs: { command: ['node', 'override-server.js'] } },
  }));
  const extra = path.join(f.h.base, 'extra-opencode');
  fs.mkdirSync(extra);
  fs.writeFileSync(path.join(extra, 'opencode.json'), JSON.stringify({
    provider: { fixture: { options: { maxRetries: 2 } } },
    mcp: { remote: { timeout: 4000 } },
  }));
  f.env.OPENCODE_CONFIG = custom;
  f.env.OPENCODE_CONFIG_DIR = extra;
  f.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    provider: { fixture: { options: { timeout: 5000 } } },
    mcp: { docs: { enabled: true }, remote: { enabled: true } },
  });
  f.h.ok(['ladder', 'set', 'medium', '--mcp', '["docs","remote"]']);
  assert.deepEqual(dry(f).home.mcp, ['docs', 'remote']);
  spawn(f);
  const report = f.report();
  assert.deepEqual(report.config.provider.fixture, {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL: 'https://override.invalid/v1', timeout: 5000, maxRetries: 2 },
    models: { fixture: { limit: { context: 32000, output: 4000 } } },
  });
  assert.deepEqual(report.mcp, {
    docs: { type: 'local', command: ['node', 'override-server.js'], enabled: true },
    remote: { type: 'remote', url: 'https://docs.invalid/mcp', timeout: 4000, enabled: true },
  });
  assert.ok(!JSON.stringify(report.config).includes('PLANTED-SECRET'));
});

test('opencode small denies edits, publishing and skills; args cannot override isolation', (t) => {
  const f = setup(t, 'small');
  const preview = dry(f);
  assert.ok(preview.argv.includes('--agent'));
  assert.equal(preview.argv[preview.argv.indexOf('--agent') + 1], 'gishra-small');
  assert.notEqual(preview.env.HOME, f.home);
  assert.equal(preview.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(preview.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, '0');
  assert.equal(preview.env.OPENCODE_PURE, '0');
  assert.equal(preview.startup.rules.every((rule) => rule.loaded === 'read'), true);
  const permissions = JSON.parse(preview.env.OPENCODE_PERMISSION);
  assert.equal(permissions.edit, 'deny');
  assert.equal(permissions.skill, 'deny');
  assert.equal(permissions.bash['git push *'], 'deny');
  assert.equal(permissions.bash['gh pr create *'], undefined);
  for (const args of [['--agent', 'build'], ['--attach', 'http://example.invalid'], ['--auto']]) {
    const rejected = f.h.run(['ladder', 'set', 'small', '--args', JSON.stringify(args)]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /args may only use/);
  }
});
