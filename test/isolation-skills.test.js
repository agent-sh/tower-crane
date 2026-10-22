'use strict';

// Spawned agent homes: owner-key denials of unbound projects, the user's codex
// rules, skill paths, fresh homes, nested Chrome and browser kits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const TOML = require('../lib/toml');
const { STUB, NO_STUBS, SECRET, setup, noSecretsCopied, releaseExited, spawn, isolated, commandsRead } = require('./isolation-helpers');

test('unbound projects spawn workers and reviewers with owner-key denials but still refuse headless owner access', { skip: NO_STUBS }, (t) => {
  for (const harness of ['claude', 'codex']) {
    const { h, u } = setup(t);
    for (const rung of ['easy', 'medium', 'hard', 'review']) isolated(h, rung, harness);
    h.ok(['task', 'update', 'T1', '--kind', 'docs']);
    const project = h.readState('project.json');
    delete project.owner_config_dir;
    h.writeState('project.json', project);
    const callerConfig = harness === 'claude' ? path.join(h.base, 'caller-config', 'config.json') : '';
    const env = { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: callerConfig };
    const configDir = callerConfig ? path.dirname(callerConfig) : path.join(u.home, '.config', 'tower-crane');
    const ownerDir = path.join(configDir, 'owner');
    // The fixture keeps its own owner key in the home's default directory.
    fs.rmSync(ownerDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(ownerDir), false);
    for (const role of ['hard', 'review']) {
      if (role === 'review') {
        const opts = { env: { TOWER_CRANE_AGENT: 'builder' } };
        releaseExited(h);
        h.ok(['claim', 'T1', '--agent', 'builder'], opts);
        h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder'], opts);
      }
      spawn(h, u, role, env);
      assert.ok(fs.statSync(ownerDir).isDirectory());
      const seen = u.report();
      if (harness === 'claude') {
        assert.ok(seen.settings.sandbox.filesystem.denyRead.includes(ownerDir));
        const posix = ownerDir.split(path.sep).join('/');
        for (const tool of ['Read', 'Grep', 'Glob']) {
          assert.ok(seen.settings.permissions.deny.includes(`${tool}(/${posix}/**)`));
        }
      } else {
        assert.equal(commandsRead(seen, path.join(ownerDir, 'key')), false, 'the owner key directory is hidden');
      }
      assert.equal(h.readState('project.json').owner_config_dir, undefined);
    }
    const denied = h.run(['project', 'show']);
    assert.equal(denied.code, 1, denied.stderr);
    assert.match(denied.stderr, /project.json has no valid owner_config_dir/);
  }
});

test('a spawned codex agent is pointed at the user\'s global rules, loads none of the user memory, instructions, MCP servers or rules, and reaches auth through a link', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'small', 'codex');
  // A .env name that is not credential-shaped is still kept from commands.
  fs.appendFileSync(path.join(u.home, '.codex', '.env'), 'export BEDROCK_PLAIN_SETTING=plain\n');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!JSON.stringify(dry).includes(SECRET), 'no credential in the command or its env');
  const started = spawn(h, u, 'small', { PROBE_FAKE_API_KEY: 'fake', PROBE_FAKE_SECRET: 'fake', AWS_SECRET_ACCESS_KEY: 'fake' });
  const seen = u.report();
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'user instruction files and memories stay out of its home');
  assert.ok(seen.prompt.includes(`- ${path.join(u.home, '.codex', 'AGENTS.md')} (global, read it)`), 'the prompt names the user\'s global rules for the agent to read');
  assert.match(seen.memory.join('\n'), /^# tower-crane-small/m);
  assert.deepEqual(seen.mcp, {}, 'no MCP server');
  assert.ok(!seen.rules.join('\n').includes('planted-rule'), 'no approved-command rules');
  assert.match(seen.rules.join('\n'), /pattern = \["gh", "pr", "merge"\],\n {4}decision = "forbidden"/, 'the role denies gh writes');
  assert.equal(seen.auth, `{"token":"${SECRET}-CRED"}`, 'auth.json reaches the agent');
  assert.equal(seen.env, null, 'the user\'s .env, which holds a bearer token, stays out of the home; a credential in the OS store replaces it');
  // ...but not the commands codex runs: codex hands them its environment
  // through this policy, which takes out credential-shaped names and every
  // name .env sets, and keeps what Tower Crane gave the agent.
  const policy = seen.config.shell_environment_policy;
  assert.ok(policy, 'the agent home renders a shell_environment_policy');
  assert.equal(policy.inherit, 'all');
  assert.equal(policy.ignore_default_excludes, true, 'codex\'s own default excludes would drop GIT_CONFIG_KEY_<n>');
  const excluded = (name) => policy.exclude.some((glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(name));
  for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'BEDROCK_PLAIN_SETTING', 'PROBE_FAKE_API_KEY', 'PROBE_FAKE_SECRET', 'AWS_SECRET_ACCESS_KEY', 'AWS_PROFILE',
    'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DB_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS', 'P_KEY', 'API_KEY2', 'KEY', 'npm_token', 'SIGNING_KEY_FILE']) {
    assert.ok(excluded(name), `${name} stays out of commands`);
  }
  for (const name of ['PROBE_FAKE_API_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.ok(seen.envNames.includes(name), `${name} reached codex itself`);
  const kept = seen.envNames.filter((n) => /^(TOWER_CRANE_|GIT_|XDG_|PATH$|HOME$|TMPDIR$|GH_CONFIG_DIR$)/.test(n));
  assert.ok(kept.includes('TOWER_CRANE_BROKER') && kept.includes('PATH') && kept.includes('GH_CONFIG_DIR'), kept.join(' '));
  for (const name of [...kept, 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_12']) assert.ok(!excluded(name), `${name} reaches commands`);
  assert.equal(seen.config.model_provider, 'p', 'the provider is kept');
  assert.deepEqual(seen.config.model_providers, { p: { name: 'P', env_key: 'P_KEY' }, q: { name: 'Q', env_key: 'Q_KEY', wire_api: 'responses' } }, 'providers in any layout, without credentials');
  for (const k of ['approval_policy', 'model_instructions_file']) assert.equal(seen.config[k], undefined, `${k} is the user's, not the role's`);
  assert.ok(seen.config.notify.includes(path.join(started.tool.path, 'lib', 'hook-bridge.js')));
  assert.ok(!seen.config.notify.includes('planted-notify'));
  assert.deepEqual(Object.keys(seen.config.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  const home = path.join(h.state, 'homes', started.agent);
  assert.ok(fs.lstatSync(path.join(home, 'auth.json')).isSymbolicLink(), 'auth.json is linked');
  assert.equal(fs.readFileSync(path.join(home, 'fixture-main.config.toml'), 'utf8'), 'model = "s"\n\n[model_providers.r]\nname = "R"\n', 'the profile without its tokens or instructions');
  assert.equal(fs.statSync(path.join(home, 'config.toml')).mode & 0o777, 0o600);
  assert.equal(seen.home, path.join(home, 'home'), 'HOME is the agent\'s own');
  assert.deepEqual(seen.skills, [], 'no user skill from ~/.agents/skills, and the small role has none of its own');
  assert.ok(!fs.lstatSync(path.join(home, 'home', '.gitconfig')).isSymbolicLink(), 'git config is rendered into its HOME, not linked to a file its sandbox hides');
  assert.equal(seen.config.permissions['tower-crane'].filesystem[path.join(home, 'home', '.gitconfig')], 'read', 'the copy in its writable HOME is read-only');
  spawn(h, u, 'review');
  assert.deepEqual(u.report().skills, ['tower-crane-review'], 'the reviewer gets its own skill only');
  noSecretsCopied(h);
});

// Why the real codex sandbox cannot run here, or false. `codex sandbox`
// calls no model, but it is the real codex, which only a live opt-in runs.
function codexSandboxSkip() {
  if (process.env.TOWER_CRANE_LIVE_CODEX !== '1') return 'set TOWER_CRANE_LIVE_CODEX=1 to run the real codex sandbox';
  if (process.platform !== 'linux') return 'the probe covers the Linux sandbox';
  const r = cp.spawnSync('codex', ['sandbox', '--', 'true'], { encoding: 'utf8', timeout: 120000 }); // wait-allow: backstop for a codex sandbox that never starts
  if (r.error?.code === 'ENOENT') return 'codex is not on PATH';
  return r.status === 0 ? false : `codex sandbox does not start here: ${String(r.stderr).trim().split('\n').pop()}`;
}

// A stand-in codex runs the real `codex sandbox` with the home spawn wrote,
// so the command runs as codex would run an agent's, and no model is called.
// Every value here is fake.
test('in the real codex sandbox an agent\'s command gets no credential-shaped variable and no .env name, and keeps what Tower Crane gives the agent', { skip: NO_STUBS, timeout: 300000 }, (t) => {
  const why = codexSandboxSkip();
  if (why) {
    t.skip(why);
    return;
  }
  const { h, u } = setup(t);
  isolated(h, 'small', 'codex');
  fs.appendFileSync(path.join(u.home, '.codex', '.env'), 'BEDROCK_PLAIN_SETTING=fake-plain\n');
  const envFile = path.join(h.base, 'private.env');
  fs.writeFileSync(envFile, 'TC_FILE_TOKEN=fake-file-token\nTC_FILE_PLAIN=fake-plain\n', { mode: 0o600 });
  h.ok(['project', 'set', '--env_file', envFile]);
  const out = path.join(h.base, 'sandbox-env.json');
  const bin = path.join(h.base, 'bin');
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const PATH = process.env.PATH.split(path.delimiter).filter((d) => path.resolve(d) !== ${JSON.stringify(bin)}).join(path.delimiter);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'probe' }) + '\\n');
const r = cp.spawnSync('codex', ['sandbox', '-c', 'default_permissions="tower-crane"', '--', process.execPath, '-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { env: { ...process.env, PATH }, encoding: 'utf8' });
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: r.status, stderr: r.stderr, inside: r.status === 0 ? JSON.parse(r.stdout) : null, outside: Object.keys(process.env) }));
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  spawn(h, u, 'small', { PROBE_FAKE_API_KEY: 'fake', AWS_SECRET_ACCESS_KEY: 'fake', AWS_REGION: 'fake-region' });
  const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(seen.status, 0, seen.stderr);
  const gone = ['PROBE_FAKE_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'TC_FILE_TOKEN'];
  for (const name of gone) assert.ok(seen.outside.includes(name), `${name} reached codex itself`);
  for (const name of [...gone, 'AWS_BEARER_TOKEN_BEDROCK', 'BEDROCK_PLAIN_SETTING']) assert.ok(!seen.inside.includes(name), `${name} stays out of the command`);
  const given = seen.outside.filter((n) => /^(TOWER_CRANE_|GIT_|XDG_)/.test(n) || ['HOME', 'TMPDIR', 'GH_CONFIG_DIR', 'TC_FILE_PLAIN'].includes(n));
  assert.ok(given.includes('TOWER_CRANE_BROKER') && given.includes('TC_FILE_PLAIN'), given.join(' '));
  for (const name of given) assert.ok(seen.inside.includes(name), `${name} reaches the command`);
});

// Automation dispatches from inside a worker's monitor, so its package root is
// that worker's tool snapshot, removed when the worker exits. Skill paths name
// the state directory's skill store instead, which no exit removes and which,
// unlike homes/, the claude and codex sandboxes can read
// (test/live-sandbox.test.js reads it from inside them).
test('every skill path a worker, reviewer or researcher is told to read is in the state directory\'s skill store at launch and after, also when a worker\'s snapshot dispatches it', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  fs.mkdirSync(path.join(u.home, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(h.base, 'bin', 'opencode'), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})("opencode");\n`, { mode: 0o755 });
  const fromSnapshot = (tool, role) => {
    const r = cp.spawnSync(process.execPath, [path.join(tool, 'bin', 'tower-crane.js'), 'spawn', '--role', role, '--task', 'T1', '--wait', '--json'],
      { cwd: h.repo, env: { ...h.env, ...u.env }, encoding: 'utf8' });
    assert.equal(r.code ?? r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const named = new Set();
  const ownPaths = (harness, role) => {
    const store = path.join(fs.realpathSync(h.state), 'skills') + path.sep;
    const seen = u.report();
    assert.ok(seen.skillPaths.length, `${harness} ${role}: names its skill`);
    if (harness !== 'claude') assert.ok(seen.skillLinks.length, `${harness} ${role}: links its skill in its home`);
    for (const { file, real: at } of [...seen.skillPaths, ...seen.skillLinks]) {
      assert.ok(at, `${harness} ${role}: ${file} exists at launch`);
      assert.ok(at.startsWith(store), `${harness} ${role}: ${file} resolves to ${at}, in the skill store ${store}, not a home or the dispatcher's package`);
      named.add(at);
    }
  };
  for (const harness of ['claude', 'codex', 'opencode']) {
    const model = { claude: ['--model', 'fixture-large', '--clear', 'profile'], codex: ['--profile', 'fixture-main', '--clear', 'model'], opencode: ['--model', 'fixture/probe', '--clear', 'profile'] }[harness];
    for (const rung of ['medium', 'review', 'research']) h.ok(['ladder', 'set', rung, '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args']);
    const worker = spawn(h, u, 'medium');
    ownPaths(harness, 'worker');
    // A copy, since the next dispatch prunes the exited worker's home it would run from.
    const snapshot = path.join(h.base, `${harness}-worker-snapshot`);
    fs.cpSync(worker.tool.path, snapshot, { recursive: true });
    releaseExited(h);
    if (h.readState('tasks.json').tasks[0].needs_owner) h.ok(['owner-done', 'T1']);
    h.ok(['task', 'update', 'T1', '--kind', 'docs']);
    h.ok(['claim', 'T1', '--agent', 'builder']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
    fromSnapshot(snapshot, 'review');
    ownPaths(harness, 'reviewer');
    h.ok(['rework', 'T1', '--reason', 'probe the research rung']);
    fromSnapshot(snapshot, 'research');
    ownPaths(harness, 'researcher');
  }
  // Later spawns pruned the exited agents' homes; what they were told to read stays.
  for (const file of named) assert.ok(fs.existsSync(file), `${file} outlives the agents that were told to read it`);
});

test('every spawn gets a fresh home, and an exited agent\'s home is removed', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'small', harness);
    const first = spawn(h, u, 'small').agent;
    const old = path.join(h.state, 'homes', first);
    // What an agent could leave behind for the next one.
    fs.writeFileSync(path.join(old, 'CLAUDE.md'), 'PLANTED-BY-AGENT\n');
    fs.writeFileSync(path.join(old, 'AGENTS.md'), 'PLANTED-BY-AGENT\n');
    fs.mkdirSync(path.join(old, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(old, 'rules', 'previous-agent.rules'), 'prefix_rule(pattern = ["planted-by-agent"], decision = "allow")\n');
    fs.writeFileSync(path.join(old, 'rules', 'previous-agent.md'), 'PLANTED-BY-AGENT\n');
    const second = spawn(h, u, 'small').agent;
    assert.notEqual(second, first);
    const seen = u.report();
    assert.ok(!seen.memory.join('\n').includes('PLANTED-BY-AGENT'), `${harness}: nothing carries over`);
    assert.ok(!seen.rules.join('\n').includes('planted-by-agent'), `${harness}: no rules carry over`);
    assert.ok(!fs.existsSync(old), `${harness}: the exited agent's home is gone`);
  }
});

test('only sandboxed claude and codex dispatches mark commands for nested Chrome', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const output = path.join(wt, 'sandbox-marker.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env.TOWER_CRANE_SANDBOX))`;
  for (const harness of ['claude', 'codex']) {
    for (const [role, expected] of [['hard', '1'], ['orchestrator', '0']]) {
      isolated(h, role, harness);
      spawn(h, u, role, {
        TOWER_CRANE_SANDBOX: expected === '1' ? '0' : '1',
        STUB_RUN: JSON.stringify([[process.execPath, '-e', script]]),
      });
      assert.equal(u.report().ran[0].code, 0);
      assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')), expected, `${harness} ${role} replaces an inherited marker`);
    }
  }
});

test('browser tasks attach the user kit on every rung with approved tools and no copied secrets', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const definitions = {
    playwright: { command: 'browser-mcp', args: ['--headless'], env: { TOKEN: SECRET }, headers: { Authorization: SECRET } },
    visual: { command: 'visual-mcp', args: [], env: { TOKEN: SECRET }, headers: { Authorization: SECRET } },
  };
  fs.writeFileSync(path.join(u.home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: definitions }));
  const config = path.join(u.home, '.codex', 'config.toml');
  fs.appendFileSync(config, '\n' + TOML.stringify({ mcp_servers: definitions }));
  fs.appendFileSync(path.join(u.home, '.codex', 'fixture-main.config.toml'), '\n' + TOML.stringify({
    mcp_servers: { playwright: {
      command: 'profile-browser-mcp', enabled: false, default_tools_approval_mode: 'prompt',
      env_vars: [SECRET], env_http_headers: { Authorization: SECRET },
      tools: { browser_navigate: { approval_mode: 'prompt' } },
    } },
  }));
  for (const harness of ['claude', 'codex']) {
    // Every rung for the design kind; an explicit browser need takes the same path.
    for (const [declaration, roles] of [
      [['--kind', 'design', '--needs', '[]'], ['easy', 'medium', 'hard', 'research', 'review', 'small', 'orchestrator']],
      [['--kind', 'code', '--needs', '["browser"]'], ['hard', 'review']],
    ]) {
      releaseExited(h);
      h.ok(['task', 'update', 'T1', ...declaration]);
      for (const role of roles) {
        isolated(h, role, harness);
        const dry = h.json(['spawn', '--role', role, '--task', 'T1', '--dry-run'], { env: u.env });
        const servers = role === 'orchestrator' ? ['playwright', 'tower-crane'] : ['playwright'];
        assert.deepEqual(dry.home.mcp, servers, `${harness} ${role} ${declaration}`);
        if (harness === 'claude') {
          const allowed = dry.argv[dry.argv.indexOf('--allowedTools') + 1];
          assert.match(allowed, /mcp__playwright/);
          assert.equal(allowed.includes('mcp__tower-crane'), role === 'orchestrator');
        }
      }
    }
    const started = spawn(h, u, 'hard');
    const seen = u.report();
    assert.match(seen.memory.join('\n'), /Approved MCP servers for this dispatch: playwright/);
    if (harness === 'claude') assert.deepEqual(seen.mcp, { playwright: { command: 'browser-mcp', args: ['--headless'] } });
    else {
      assert.deepEqual(seen.config.mcp_servers.playwright, {
        command: 'browser-mcp', args: ['--headless'], enabled: true, default_tools_approval_mode: 'approve',
      });
      const profile = TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'fixture-main.config.toml'), 'utf8')).mcp_servers.playwright;
      assert.equal(profile.enabled, true);
      assert.equal(profile.default_tools_approval_mode, 'approve');
      assert.equal(profile.tools.browser_navigate.approval_mode, 'approve');
      assert.equal(profile.env_vars, undefined);
      assert.equal(profile.env_http_headers, undefined);
    }
    noSecretsCopied(h);
    h.ok(['browser-kit', 'set', '--servers', '["visual","playwright"]']);
    const custom = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.deepEqual(custom.home.mcp, ['visual', 'playwright']);
    releaseExited(h);
    h.ok(['task', 'update', 'T1', '--needs', '[]']);
    const plain = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.deepEqual(plain.home.mcp, [], 'a plain code task gets no kit');
    h.ok(['browser-kit', 'set', '--servers', '["playwright"]']);
  }
});

test('browser spawns use the original user kit through a nested isolated home and refuse missing servers', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // An operational spawn follows the user's browser settings across homes.
  const orchestrator = { TOWER_CRANE_AGENT: 'orchestrator' };
  const userFile = path.join(u.home, '.config', 'tower-crane', 'config.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ browser_kit: ['planted'] }));
  releaseExited(h);
  h.ok(['task', 'update', 'T1', '--needs', '["browser"]']);
  isolated(h, 'hard', 'codex');
  const parent = spawn(h, u, 'hard', { TOWER_CRANE_CONFIG: '', ...orchestrator });
  const generated = path.join(h.state, 'homes', parent.agent);
  const nestedEnv = { ...u.env, HOME: path.join(generated, 'home'), CODEX_HOME: generated, TOWER_CRANE_CONFIG: '', ...orchestrator };
  assert.deepEqual(h.json(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: nestedEnv }).home.mcp, ['planted']);
  fs.writeFileSync(userFile, JSON.stringify({ browser_kit: ['missing-browser'] }));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'small', harness);
    const result = h.run(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: { ...u.env, TOWER_CRANE_CONFIG: '', ...orchestrator } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /missing-browser.*(?:mcp\.json|config\.toml)/);
  }
  releaseExited(h);
  h.ok(['task', 'update', 'T1', '--needs', '[]']);
  assert.deepEqual(h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: { ...u.env, TOWER_CRANE_CONFIG: '', ...orchestrator } }).home.mcp, []);
});
