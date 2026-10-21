'use strict';

// Spawned agent homes: no user secrets, hooks or rules, provider configs,
// sandbox placeholders, owner-key denials, skills and browser kits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, BIN } = require('./helpers');
const A = require('../lib/agents');
const TOML = require('../lib/toml');
const ClaudeSandboxPlaceholders = require('../lib/claude-sandbox-placeholders');
const { readPublished } = require('./atomic-file');
const { STUB, NO_STUBS, SECRET, setup, isolateGitEnvironment, noSecretsCopied, releaseExited, spawn, isolated, commandsRead } = require('./isolation-helpers');

const CLAUDE_SANDBOX_PLACEHOLDERS = ClaudeSandboxPlaceholders.FILES;
// What the sandbox mounts over in a worker worktree, listed here rather than
// taken from the module, so the cleanup test fails if the module misses one.
const SANDBOX_MOUNTS = [
  '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea', '.mcp.json',
  '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc',
  '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/launch.json', '.claude/loop.md',
  '.claude/output-styles', '.claude/routines', '.claude/scheduled_tasks.json', '.claude/settings.json',
  '.claude/settings.local.json', '.claude/skills', '.claude/workflows',
];
// The repository tracks this file, so the sandbox never leaves a placeholder in its place.
const TRACKED_SETTINGS = '.claude/settings.json';

test('isolation spawn probes report the cause of abnormal command exits', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const [label, script, diagnostic] of [
    ['terminated', "process.kill(process.pid, 'SIGTERM')", /signal SIGTERM/],
    ['killed', "process.kill(process.pid, 'SIGKILL')", /signal SIGKILL/],
    ['failed', "process.stderr.write('fixture failure\\n'); process.exit(42)", /exited 42: fixture failure/],
  ]) {
    assert.throws(() => spawn(h, u, 'small', {}, { pre: ['-e', script] }), diagnostic, label);
  }
  for (const code of ['EAGAIN', 'ENOBUFS', 'ETIMEDOUT']) {
    const original = cp.spawnSync;
    const probe = t.mock.method(cp, 'spawnSync', (command, args, options) => {
      if (command === process.execPath && args.includes(BIN) && args.includes('spawn')) {
        return { status: null, signal: null, stdout: '', stderr: '',
          error: Object.assign(new Error('fixture launch failure'), { code }) };
      }
      return original(command, args, options);
    });
    try {
      assert.throws(() => spawn(h, u, 'small'), new RegExp(`error ${code}: fixture launch failure`), code);
    } finally {
      probe.mock.restore();
    }
  }
});

test('codex worker configs keep named provider and MCP fields without copying credentials', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const credentials = Object.fromEntries(['apikey', 'key', 'bearer', 'api_key', 'opaque_value'].map(k => [k, `${SECRET}-${k}`]));
  const provider = {
    name: 'P', base_url: 'https://provider.example/v1', env_key: 'P_KEY', wire_api: 'responses',
    requires_openai_auth: false, request_max_retries: 3, stream_max_retries: 4, stream_idle_timeout_ms: 1000,
    env_http_headers: { 'X-Provider': 'PROVIDER_HEADER' },
  };
  const server = {
    command: 'planted-mcp', args: ['x'], cwd: '/server', url: 'https://mcp.example',
    env_vars: ['MCP_KEY'], env_http_headers: { Authorization: 'MCP_AUTH' }, bearer_token_env_var: 'MCP_BEARER',
    enabled: true, required: false, startup_timeout_sec: 10, tool_timeout_sec: 20,
    enabled_tools: ['read'], disabled_tools: ['write'], default_tools_approval_mode: 'prompt',
    tools: { read: { enabled: true, approval_mode: 'prompt' } },
  };
  const doc = {
    model_provider: 'p',
    model_providers: {
      p: { ...provider, ...credentials, metadata: { opaque_value: SECRET } },
      malformed: { name: { opaque_value: SECRET }, request_max_retries: { key: SECRET } },
    },
    mcp_servers: {
      planted: {
        ...server, ...credentials, env: { MCP_KEY: SECRET }, http_headers: { Authorization: SECRET },
        tools: { read: { ...server.tools.read, ...credentials, metadata: { opaque_value: SECRET } } },
      },
      malformed: { args: [{ opaque_value: SECRET }], env_vars: [{ opaque_value: SECRET }] },
    },
  };
  for (const file of ['config.toml', 'fixture-main.config.toml']) {
    fs.writeFileSync(path.join(u.home, '.codex', file), TOML.stringify(doc));
  }
  isolated(h, 'medium', 'codex');
  h.ok(['ladder', 'set', 'medium', '--mcp', '["planted","malformed"]']);
  const started = spawn(h, u, 'medium');
  noSecretsCopied(h);
  for (const file of ['config.toml', 'fixture-main.config.toml']) {
    const config = JSON.parse(JSON.stringify(TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, file), 'utf8'))));
    assert.deepEqual(config.model_providers, { p: provider, malformed: {} }, file);
    assert.deepEqual(config.mcp_servers, { planted: server, malformed: {} }, file);
  }
});

test('codex spawns reject credential tables in scalar settings in base and every profile layout', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const credentials = { apikey: `${SECRET}-APIKEY`, key: `${SECRET}-KEY`, bearer: `${SECRET}-BEARER` };
  const safe = {
    review_model: 'review', model_context_window: 64000, model_auto_compact_token_limit: 32000,
    model_supports_reasoning_summaries: true, cli_auth_credentials_store: 'keyring',
  };
  const malformed = { model: [credentials], model_reasoning_effort: 7, model_verbosity: true };
  const doc = { ...safe, ...malformed, profiles: { safe: { model: 'legacy', ...safe }, malformed } };
  for (const file of ['config.toml', 'fixture-main.config.toml']) {
    fs.writeFileSync(path.join(u.home, '.codex', file), TOML.stringify(doc));
  }
  isolated(h, 'medium', 'codex');
  const started = spawn(h, u, 'medium');
  noSecretsCopied(h);
  for (const file of ['config.toml', 'fixture-main.config.toml']) {
    const config = JSON.parse(JSON.stringify(TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, file), 'utf8'))));
    for (const [key, value] of Object.entries(safe)) assert.equal(config[key], value, `${file}: ${key}`);
    for (const key of Object.keys(malformed)) assert.equal(config[key], undefined, `${file}: ${key}`);
    assert.deepEqual(config.profiles, { safe: { model: 'legacy', ...safe }, malformed: {} }, file);
  }
});

test('claude spawns reject credential tables and non-string values in opted-in MCP fields', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const credentials = { apikey: `${SECRET}-APIKEY`, key: `${SECRET}-KEY`, bearer: `${SECRET}-BEARER` };
  const safe = { type: 'stdio', command: 'safe-mcp', args: ['--headless'], url: 'https://mcp.example' };
  const mcpServers = {
    nested: { command: 'nested-mcp', args: [credentials], type: credentials, url: credentials },
    mixed: { command: 'mixed-mcp', args: ['--headless', credentials] },
    malformed: { type: true, command: credentials, args: [1], url: ['https://mcp.example'] },
    safe,
  };
  fs.writeFileSync(path.join(u.home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers }));
  isolated(h, 'medium', 'claude');
  h.ok(['ladder', 'set', 'medium', '--mcp', JSON.stringify(Object.keys(mcpServers))]);
  spawn(h, u, 'medium');
  noSecretsCopied(h);
  assert.deepEqual(u.report().mcp, { nested: { command: 'nested-mcp' }, mixed: { command: 'mixed-mcp' }, malformed: {}, safe });
});

test('codex config allowlists also filter inline tables on Windows', () => {
  const doc = TOML.parse([
    `model_providers = { p = { name = "P", apikey = "${SECRET}", key = "${SECRET}", bearer = "${SECRET}", opaque_value = "${SECRET}" }, malformed = { name = ["${SECRET}"], env_http_headers = { Authorization = { value = "${SECRET}" } } } }`,
    `mcp_servers = { planted = { command = "mcp", args = ["x"], apikey = "${SECRET}", key = "${SECRET}", bearer = "${SECRET}", opaque_value = "${SECRET}", tools = { read = { enabled = true, approval_mode = "prompt", opaque_value = "${SECRET}" } } }, malformed = { args = [{ value = "${SECRET}" }], env_http_headers = { Authorization = { value = "${SECRET}" } } } }`,
  ].join('\n'));
  const filtered = A.codexConfig(doc, ['planted', 'malformed']);
  assert.deepEqual(filtered, {
    doc: {
      model_providers: { p: { name: 'P' }, malformed: {} },
      mcp_servers: { planted: { command: 'mcp', args: ['x'], tools: { read: { enabled: true, approval_mode: 'prompt' } } }, malformed: {} },
    },
    found: ['planted', 'malformed'],
  });
  assert.ok(!TOML.stringify(filtered.doc).includes(SECRET));
  const arrays = Object.fromEntries(require('../lib/ladder').CODEX_KEYS.map(key => [key, [{ apikey: SECRET, key: SECRET, bearer: SECRET }]]));
  assert.deepEqual(A.codexConfig(TOML.parse(TOML.stringify({ ...arrays, profiles: { malformed: arrays } })), []).doc, { profiles: { malformed: {} } });
});

// The built-in Bedrock provider takes only its aws table; credentials are
// planted beside the region. An Azure-style provider carries query parameters
// with keys, a SAS signature, a Functions code and an auth value planted
// among them.
const PROVIDERS = {
  'amazon-bedrock': {
    aws: {
      region: 'us-east-1', profile: 'work',
      bearer_token: `${SECRET}-BEARER`, secret_access_key: `${SECRET}-SECRET`, session_token: `${SECRET}-TOKEN`, password: `${SECRET}-PASSWORD`,
      credential_export: { command: `echo ${SECRET}-EXPORT` }, auth_refresh: { command: `echo ${SECRET}-REFRESH` },
    },
  },
  azure: {
    name: 'Azure', base_url: 'https://azure.example/openai', env_key: 'AZURE_KEY', wire_api: 'responses',
    query_params: { 'api-version': '2025-04-01-preview', key: `${SECRET}-QUERY`, apikey: `${SECRET}-QUERY`, sig: `${SECRET}-SIG`, code: `${SECRET}-CODE`, auth: `${SECRET}-AUTH`, nested: { value: SECRET } },
  },
};
const PROVIDERS_KEPT = {
  'amazon-bedrock': { aws: { region: 'us-east-1', profile: 'work' } },
  azure: { ...PROVIDERS.azure, query_params: { 'api-version': '2025-04-01-preview' } },
};
const BEDROCK_CONFIG = { model: 'openai.fixture-model', model_provider: 'amazon-bedrock', model_providers: PROVIDERS };

test('codex provider sub-tables keep their named non-credential fields', () => {
  const filtered = A.codexConfig(TOML.parse(TOML.stringify(BEDROCK_CONFIG)), []).doc;
  assert.deepEqual(JSON.parse(JSON.stringify(filtered.model_providers)), PROVIDERS_KEPT);
  assert.ok(!TOML.stringify(filtered).includes(SECRET));
});

test('a codex spawn on Bedrock starts with the region from the user config', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const file of ['config.toml', 'fixture-main.config.toml']) {
    fs.writeFileSync(path.join(u.home, '.codex', file), TOML.stringify(BEDROCK_CONFIG));
  }
  isolated(h, 'medium', 'codex');
  // The region comes only from the config, as on a machine whose shell sets
  // none; the stub refuses to start without it, as codex does.
  const started = spawn(h, u, 'medium', { AWS_REGION: '', AWS_DEFAULT_REGION: '' });
  noSecretsCopied(h);
  const home = path.join(h.state, 'homes', started.agent);
  const { args: spawned, config } = u.report();
  assert.deepEqual(config.model_providers, PROVIDERS_KEPT);
  const profile = TOML.parse(fs.readFileSync(path.join(home, 'fixture-main.config.toml'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(profile.model_providers)), PROVIDERS_KEPT);
  // With TOWER_CRANE_LIVE_CODEX=1 the installed codex also loads the generated
  // home with the spawn's -c overrides, so a field it refuses fails here
  // instead of at dispatch. A non-live run never starts the real harness.
  if (process.env.TOWER_CRANE_LIVE_CODEX !== '1') return t.diagnostic('set TOWER_CRANE_LIVE_CODEX=1 to load this home in the installed codex');
  const version = cp.spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) return t.diagnostic('codex is not installed; the stub alone checked startup');
  const overrides = spawned.flatMap((a, i) => (spawned[i - 1] === '-c' ? ['-c', a] : []));
  const r = cp.spawnSync('codex', [...overrides, 'features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 300000 });
  assert.equal(r.status, 0, `codex refused the generated config: ${r.stderr}`);
});

test('research Claude gets native or explicit web MCP tools with worker file and git confinement', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  fs.mkdirSync(path.join(u.home, '.cache'), { recursive: true });
  isolated(h, 'hard', 'claude');
  spawn(h, u, 'hard');
  const worker = u.report();
  const filesystem = report => {
    const { allowRead, ...shared } = report.settings.sandbox.filesystem;
    const ownHome = path.dirname(report.home);
    // Outside the user's home it reopens only the agent's own home and broker directory.
    // And under /run, which it hides, the resolver (runReads).
    assert.deepEqual(allowRead.filter((p) => !p.startsWith(fs.realpathSync(u.home) + path.sep)), [ownHome, path.join(h.state, 'brokers', path.basename(ownHome)), ...A.runReads(u.env)]);
    assert.ok(shared.denyWrite.includes(h.state));
    // A mask on a path the host lacks leaves a placeholder there, so only existing paths are masked.
    for (const p of [...shared.denyRead, ...shared.denyWrite]) assert.ok(fs.existsSync(p), `${p} is masked but missing`);
    const cache = path.join(u.home, '.cache', 'tower-crane', 'tasks');
    const writes = shared.allowWrite.filter((w) => path.dirname(path.dirname(w)) === cache);
    assert.equal(writes.length, 1);
    assert.equal(path.basename(writes[0]), 'T1');
    return shared;
  };
  isolated(h, 'research', 'claude');
  const dry = h.json(['spawn', '--role', 'research', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.match(dry.home.agent_file, /tower-crane-researcher\.md$/);
  spawn(h, u, 'research');
  const native = u.report();
  assert.ok(native.args[native.args.indexOf('--allowedTools') + 1].includes('WebSearch'));
  assert.ok(native.args[native.args.indexOf('--allowedTools') + 1].includes('WebFetch'));
  assert.deepEqual(filesystem(native), filesystem(worker));
  // Found 2026-10-14: ['*'], which Claude Code refuses as too broad, left
  // its proxy no host to allow. The list names GitHub's hosts and npm's.
  const hosts = native.settings.sandbox.network.allowedDomains;
  for (const d of ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'uploads.github.com', 'registry.npmjs.org']) assert.ok(hosts.includes(d), d);
  assert.ok(!hosts.includes('*') && hosts.every(require('../lib/spawn-settings').domainPattern), `every entry is a pattern claude takes: ${hosts}`);
  assert.ok(native.memory.join('\n').includes('Use the network'));
  h.ok(['ladder', 'set', 'research', '--web-mcp', '{"name":"harness-web","command":"node","args":["/configured/server.mjs"]}']);
  spawn(h, u, 'research');
  const web = u.report();
  assert.deepEqual(web.mcp, { 'harness-web': { command: 'node', args: ['/configured/server.mjs'] } });
  assert.ok(web.args.includes('--strict-mcp-config'));
  assert.ok(web.args.includes('--mcp-config'));
  const allowed = web.args[web.args.indexOf('--allowedTools') + 1].split(',');
  assert.ok(allowed.includes('mcp__harness-web__websearch'));
  assert.ok(allowed.includes('mcp__harness-web__webfetch'));
  assert.ok(!allowed.includes('mcp__harness-web'));
  assert.deepEqual(filesystem(web), filesystem(worker));
  noSecretsCopied(h);
  assert.equal(h.run(['ladder', 'set', 'research', '--web-mcp', '{"name":"web","command":"node","args":[],"env":{"TOKEN":"secret"}}']).code, 2);
  assert.equal(h.run(['ladder', 'set', 'research', '--web-mcp', '{"name":"web","command":"node","args":[]}', '--agent', 'worker-T1-1']).code, 1);
});

test('research Codex explicitly enables live search with worker file and git confinement', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  fs.mkdirSync(path.join(u.home, '.cache'), { recursive: true });
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard');
  const worker = u.report();
  assert.ok(worker.args.includes('web_search="disabled"'));
  isolated(h, 'research', 'codex');
  spawn(h, u, 'research');
  const researcher = u.report();
  assert.ok(researcher.args.includes('web_search="live"'));
  const workerFs = worker.config.permissions['tower-crane'].filesystem;
  const researchFs = researcher.config.permissions['tower-crane'].filesystem;
  for (const [report, rules] of [[worker, workerFs], [researcher, researchFs]]) {
    const ownHome = path.dirname(report.home);
    const sessions = path.join(h.state, 'homes', '.codex', path.basename(ownHome));
    assert.equal(rules[path.join(h.state, 'homes')], 'none');
    assert.equal(rules[ownHome], 'read');
    assert.equal(rules[sessions], 'write');
    assert.equal(rules[report.home], 'write');
    const broker = path.join(h.state, 'brokers', path.basename(ownHome));
    assert.equal(rules[h.state], 'read');
    assert.equal(rules[path.join(h.state, 'brokers')], 'none');
    assert.equal(rules[path.join(h.state, 'ci-artifacts')], 'none', 'no agent reads unredacted local CI artifacts');
    assert.equal(rules[broker], 'write');
    assert.equal(rules[path.join(path.dirname(h.userConfig), 'owner')], 'none', 'no agent reads the owner key');
    for (const [p, mode] of Object.entries(rules)) if (mode === 'none') assert.ok(fs.existsSync(p), `${p} is masked but missing`);
    const cache = Object.keys(rules).filter((k) => path.dirname(path.dirname(k)) === path.join(u.home, '.cache', 'tower-crane', 'tasks'));
    assert.deepEqual(cache.map((k) => [path.basename(k), rules[k]]), [['T1', 'write']]);
    delete rules[cache[0]];
    delete rules[ownHome];
    delete rules[sessions];
    delete rules[report.home];
    assert.equal(rules[path.join(report.home, '.gitconfig')], 'read', 'git config in HOME stays read-only');
    delete rules[path.join(report.home, '.gitconfig')];
    assert.equal(rules[path.join(report.home, '.tower-crane-shims')], 'read', 'the shims in HOME stay read-only');
    delete rules[path.join(report.home, '.tower-crane-shims')];
    delete rules[broker];
    // What lies outside the home is listed as it is at each spawn.
    const home = fs.realpathSync(u.home);
    const above = (dir) => home.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
    for (const k of Object.keys(rules)) if (above(path.dirname(k)) && !above(k)) delete rules[k];
  }
  assert.deepEqual(researchFs, workerFs);
  assert.deepEqual(researcher.rules, worker.rules);
  noSecretsCopied(h);
});

test('a spawned claude agent imports the user\'s global rules by path, loads none of the user settings hooks, MCP servers or rules, and reaches auth through a link', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  // Present on the host, so masked; ~/.aws is absent, so it is not.
  fs.mkdirSync(path.join(u.home, '.ssh'));
  isolated(h, 'small', 'claude');
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!JSON.stringify(dry).includes(SECRET), 'no credential in the command or its env');
  const started = spawn(h, u, 'small');
  const seen = u.report();
  assert.match(seen.memory.join('\n'), /^# tower-crane-small/m, 'the role instructions load');
  const home = path.join(h.state, 'homes', started.agent);
  const instructions = fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8');
  assert.ok(instructions.split('\n').includes(`@${path.join(u.home, '.claude', 'CLAUDE.md')}`), 'the user\'s global rules are imported by path');
  assert.ok(!instructions.includes('PLANTED-MEMORY'), 'their text is not copied');
  assert.ok(seen.memory.join('\n').includes('PLANTED-MEMORY'), 'claude loads the user\'s global rules through the import');
  assert.deepEqual(Object.keys(seen.settings.hooks).sort(), ['PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.ok(!JSON.stringify(seen.hooks).includes('planted'), 'no user, project or local hooks');
  assert.deepEqual(seen.mcp, {}, 'no MCP server');
  assert.deepEqual(seen.rules, [], 'no approved-command rules');
  assert.deepEqual(seen.settings.env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, 'provider settings only, never a credential');
  assert.equal(seen.auth, `{"token":"${SECRET}-CRED"}`, 'auth reaches the agent');
  // The helper is named, not copied, and still yields the user's credential.
  const helper = cp.execSync(seen.settings.apiKeyHelper, { encoding: 'utf8', env: u.env }).trim();
  assert.equal(helper, `${SECRET}-HELPER`);
  assert.ok(fs.lstatSync(path.join(home, '.credentials.json')).isSymbolicLink(), 'credentials are linked');
  assert.equal(fs.statSync(home).mode & 0o777, 0o700, 'the home is private');
  assert.equal(fs.statSync(path.join(home, 'settings.json')).mode & 0o777, 0o600);
  assert.ok(seen.args.includes('--strict-mcp-config') && seen.args.includes('--disable-slash-commands'));
  assert.equal(seen.args[seen.args.indexOf('--tools') + 1], 'Bash,Read,Grep,Glob');
  assert.equal(seen.home, path.join(home, 'home'), 'HOME is the agent\'s own');
  // Bash is approved only because it runs in claude's sandbox, which stops
  // the agent when it cannot start; the small role writes nothing outside,
  // and its state changes go through the state broker.
  const box = seen.settings.sandbox;
  assert.equal(seen.args[seen.args.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob');
  assert.deepEqual([box.enabled, box.failIfUnavailable, box.allowUnsandboxedCommands, box.network.allowAllUnixSockets], [true, true, false, true]);
  // Nothing but its own temp directory, where claude puts its proxy sockets (claudeTmp).
  assert.deepEqual(box.filesystem.allowWrite.filter((w) => w !== seen.tmpdir), []);
  assert.equal(box.filesystem.denyWrite[0], h.state, 'the state is read-only');
  assert.ok(box.filesystem.denyWrite.includes(wt), 'the worktree is read-only');
  // claude writes a linked worktree's git directory itself; what runs code stays read-only.
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  assert.ok(box.filesystem.denyWrite.includes(path.join(common, 'config')), 'the shared git config is read-only');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'homes')), 'other agent homes are hidden, including future spawns');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'brokers')), 'no agent reads another agent\'s broker token');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'ci-artifacts')), 'no agent reads unredacted local CI artifacts');
  assert.ok(box.filesystem.denyRead.includes(path.join(path.dirname(h.userConfig), 'owner')), 'no agent reads the owner key');
  assert.deepEqual(box.filesystem.allowRead.filter((p) => p !== seen.tmpdir), [path.join(u.home, '.claude', 'CLAUDE.md'), home, path.join(h.state, 'brokers', started.agent), ...A.runReads(u.env)],
    'only the user\'s global rules under the home, this dispatch home, its own broker directory, the resolver under /run and its own temp directory are readable');
  // /run is hidden whole, with docker's, the buses' and every other host socket in it.
  for (const p of A.runDirs()) assert.ok(box.filesystem.denyRead.includes(p), p);
  // /var/run links to /run on most hosts; the sandbox follows the link into the hidden /run.
  for (const p of ['/var/run/docker.sock', '/run/docker.sock', '/run/dbus/system_bus_socket', '/run/snapd.socket']) {
    assert.equal(commandsRead(seen, fs.existsSync(p) ? fs.realpathSync(p) : p), false, p);
  }
  assert.ok(box.filesystem.denyRead.includes(u.home), 'the user\'s home is hidden whole');
  for (const p of [path.join(u.home, '.ssh'), path.join(u.home, '.aws')]) assert.equal(commandsRead(seen, p), false, p);
  assert.match(fs.readFileSync(path.join(h.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.claude\/\.cc-writes\/$/m, 'the sandbox marker is never committed');
  assert.equal(fs.readFileSync(path.join(h.state, 'homes', '.gitignore'), 'utf8'), '*\n');
  noSecretsCopied(h);
});

test('a sandboxed claude removes its ignored cwd placeholders after exit', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const { xdg } = isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const gitignoreFile = path.join(h.repo, '.gitignore');
  const gitignore = fs.existsSync(gitignoreFile) ? readPublished(gitignoreFile, 'utf8') : null;
  const globalIgnore = path.join(xdg, 'git', 'ignore');
  fs.mkdirSync(path.dirname(globalIgnore), { recursive: true });
  fs.writeFileSync(globalIgnore, 'globally-ignored/\n');
  fs.mkdirSync(path.join(wt, 'globally-ignored'));
  fs.writeFileSync(path.join(wt, 'globally-ignored', 'file.txt'), "ignored by the user's global excludes\n");
  const status = (cwd) => cp.execFileSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd, env: u.env, encoding: 'utf8',
  }).trim();

  const started = spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(SANDBOX_MOUNTS),
  });
  const seen = u.report();
  assert.deepEqual(seen.placeholderGitStatus, { code: 0, stdout: '', stderr: '' }, 'git status stays clean while the placeholders exist');
  for (const relative of SANDBOX_MOUNTS.filter((name) => name !== TRACKED_SETTINGS)) {
    assert.equal(fs.existsSync(path.join(wt, relative)), false, `${relative} is removed after exit`);
  }
  assert.equal(fs.existsSync(path.join(wt, TRACKED_SETTINGS)), true, 'the tracked project settings stay');
  assert.equal(status(started.cwd), '', 'the worktree stays clean after exit');

  const excludes = fs.readFileSync(path.join(h.repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
  for (const pattern of ClaudeSandboxPlaceholders.IGNORE_PATTERNS) {
    assert.ok(!excludes.includes(pattern), `${pattern} is not left in shared git info/exclude`);
  }
  assert.equal(fs.existsSync(gitignoreFile) ? readPublished(gitignoreFile, 'utf8') : null, gitignore, 'the repository .gitignore is unchanged');

  const other = path.join(h.base, 'other-worktree');
  h.git(['worktree', 'add', '--detach', other, 'main']);
  for (const cwd of [wt, other]) {
    fs.writeFileSync(path.join(cwd, '.bashrc'), 'a real shell config\n');
    fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'x.md'), 'a real project agent\n');
    assert.equal(status(cwd), '?? .bashrc\n?? .claude/agents/x.md');
  }
});

test('a sandboxed claude removes the .claude directory its placeholders made', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude'), { recursive: true });
  spawn(h, u, 'small', { STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(SANDBOX_MOUNTS) });
  assert.equal(u.report().placeholderGitStatus.code, 0, 'the placeholders were made');
  assert.equal(fs.existsSync(path.join(wt, '.claude')), false, '.claude is gone after exit');
  for (const name of SANDBOX_MOUNTS.filter((n) => !n.includes('/'))) assert.equal(fs.existsSync(path.join(wt, name)), false, `${name} is gone after exit`);
});

test('a spawn sweeps placeholders an earlier agent left, and keeps the worktree\'s own files by those names', { skip: NO_STUBS }, (t) => {
  // An agent whose monitor died before its cleanup leaves empty read-only
  // files; the next spawn would take them for the worktree's own, leave them
  // out of its exclude file, and a worker could commit them.
  const { h, u, wt } = setup(t);
  isolated(h, 'small', 'claude');
  fs.writeFileSync(path.join(wt, '.zshrc'), '');
  h.git(['add', '.zshrc'], wt);
  h.git(['commit', '-q', '-m', 'an empty zshrc of the project'], wt);
  const stale = ['.bashrc', '.gitconfig', '.claude/loop.md'];
  for (const name of [...stale, '.zshrc']) {
    fs.writeFileSync(path.join(wt, name), '');
    fs.chmodSync(path.join(wt, name), 0o444);
  }
  fs.writeFileSync(path.join(wt, '.profile'), '');
  fs.mkdirSync(path.join(wt, '.claude', 'agents'));
  fs.mkdirSync(path.join(wt, '.claude', '.cc-writes'));
  fs.mkdirSync(path.join(wt, '.vscode'));
  fs.writeFileSync(path.join(wt, '.vscode', 'settings.json'), '{}\n');
  // A shared settings directory linked in is the worktree's own, and no
  // warning about it repeats at every spawn.
  const shared = path.join(h.base, 'shared-idea');
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, path.join(wt, '.idea'), 'dir');
  const r = h.run(['spawn', '--role', 'small', '--task', 'T1', '--wait', '--json'], { env: u.env });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /could not remove stale Claude sandbox placeholder/);
  for (const name of [...stale, '.claude/agents', '.claude/.cc-writes']) assert.equal(fs.existsSync(path.join(wt, name)), false, `stale ${name} is swept`);
  for (const name of ['.zshrc', '.profile', '.vscode/settings.json', '.claude/settings.json']) assert.equal(fs.existsSync(path.join(wt, name)), true, `${name} stays`);
  assert.equal(fs.lstatSync(path.join(wt, '.idea')).isSymbolicLink(), true, 'the linked .idea stays');
  const exclude = fs.readFileSync(path.join(h.state, 'homes', fs.readdirSync(path.join(h.state, 'homes')).find((n) => n.startsWith('small-')), 'sandbox-git-exclude'), 'utf8').split('\n');
  assert.ok(exclude.includes('/.bashrc'), 'a swept name is excluded again');
});

test('the agent honors its worktree\'s own core.excludesFile, not the main checkout\'s', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const worktreeIgnore = path.join(h.base, 'worktree-ignore');
  fs.writeFileSync(worktreeIgnore, 'worktree-ignored/\n');
  const mainIgnore = path.join(h.base, 'main-ignore');
  fs.writeFileSync(mainIgnore, 'main-ignored/\n');
  h.git(['config', 'extensions.worktreeConfig', 'true']);
  h.git(['config', '--worktree', 'core.excludesFile', mainIgnore]);
  h.git(['config', '--worktree', 'core.excludesFile', worktreeIgnore], wt);
  for (const dir of ['worktree-ignored', 'main-ignored']) {
    fs.mkdirSync(path.join(wt, dir));
    fs.writeFileSync(path.join(wt, dir, 'data'), 'a file\n');
  }

  spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(SANDBOX_MOUNTS),
  });
  assert.deepEqual(u.report().placeholderGitStatus, { code: 0, stdout: '?? main-ignored/data\n', stderr: '' }, 'the worktree\'s excludes hide its ignored directory and the main checkout\'s do not reach it');
});

test('an untracked empty read-only file with a placeholder name is a stale placeholder: swept, excluded and never reported', { skip: NO_STUBS }, (t) => {
  // Nothing tells it from a placeholder an earlier agent left, and kept as
  // the worktree's own it would stay out of the exclude file.
  const { h, u, wt } = setup(t);
  const { global } = isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const stale = path.join(wt, '.bash_profile');
  fs.writeFileSync(stale, '');
  fs.chmodSync(stale, 0o444);
  const globalIgnore = path.join(h.base, 'explicit-global-ignore');
  fs.writeFileSync(globalIgnore, 'explicitly-ignored/\n');
  fs.mkdirSync(path.join(wt, 'explicitly-ignored'));
  fs.writeFileSync(path.join(wt, 'explicitly-ignored', 'file.txt'), 'ignored by the configured core.excludesFile\n');
  u.env.GIT_CONFIG_PARAMETERS = `'core.excludesFile'='${globalIgnore.replace(/\\/g, '/')}'`;
  const status = (cwd) => cp.execFileSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd, env: u.env, encoding: 'utf8',
  }).trim();

  const started = spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(CLAUDE_SANDBOX_PLACEHOLDERS),
  });
  const seen = u.report();
  assert.deepEqual(seen.placeholderGitStatus, { code: 0, stdout: '', stderr: '' });
  for (const relative of CLAUDE_SANDBOX_PLACEHOLDERS.filter((name) => name !== TRACKED_SETTINGS)) {
    assert.equal(fs.existsSync(path.join(wt, relative)), false, `${relative} placeholder is removed`);
  }
  assert.equal(status(started.cwd), '');
  assert.equal(u.env.GIT_CONFIG_GLOBAL, global, 'Git uses the test-only global config');
});

test('sandbox cleanup refuses placeholder paths under a symlinked parent', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const outside = path.join(h.base, 'outside-claude');
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, 'loop.md');
  fs.writeFileSync(outsideFile, '');
  fs.chmodSync(outsideFile, 0o444);
  const claudeDir = path.join(wt, '.claude');
  const replaceParent = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `fs.rmSync(path.join(process.cwd(), ".claude"), { recursive: true, force: true });`,
    `fs.symlinkSync(${JSON.stringify(outside)}, path.join(process.cwd(), ".claude"), "dir");`,
  ].join('\n');

  const started = spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(CLAUDE_SANDBOX_PLACEHOLDERS),
    STUB_RUN: JSON.stringify([[process.execPath, '-e', replaceParent]]),
  });
  assert.equal(u.report().ran[0].code, 0);
  assert.equal(fs.lstatSync(claudeDir).isSymbolicLink(), true, 'the parent symlink remains');
  assert.equal(fs.existsSync(outsideFile), true, 'cleanup leaves the outside file alone');
  assert.equal(fs.statSync(outsideFile).size, 0);
  assert.equal(fs.statSync(outsideFile).mode & 0o222, 0, 'the outside file keeps its read-only mode');

  fs.unlinkSync(claudeDir);
  fs.mkdirSync(claudeDir);
  fs.copyFileSync(path.join(h.repo, '.claude', 'settings.json'), path.join(claudeDir, 'settings.json'));
  const status = cp.execFileSync('git', ['status', '--short', '--untracked-files=all'], {
    cwd: started.cwd, env: u.env, encoding: 'utf8',
  }).trim();
  assert.equal(status, '', 'restoring the tracked project settings leaves the worktree clean');
});

test('sandbox cleanup changes only the file it checked when a parent is swapped after the check', { skip: NO_STUBS }, (t) => {
  const { base } = makeRepo(t);
  const wt = path.join(base, 'worktree');
  const claudeDir = path.join(wt, '.claude');
  const outside = path.join(base, 'outside');
  const outsideFile = path.join(outside, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), '');
  fs.chmodSync(path.join(claudeDir, 'settings.json'), 0o444);
  fs.writeFileSync(outsideFile, 'REAL USER SETTINGS\n');
  fs.chmodSync(outsideFile, 0o444);
  // Swap .claude for a symlink to outside just before the first removal, after every check.
  const originals = { unlinkSync: fs.unlinkSync, spawnSync: cp.spawnSync };
  let swapped = false;
  const swapBefore = (target) => {
    if (swapped || !String(target).startsWith(claudeDir)) return;
    swapped = true;
    fs.renameSync(claudeDir, path.join(base, 'claude-moved'));
    fs.symlinkSync(outside, claudeDir, 'dir');
  };
  let result;
  try {
    fs.unlinkSync = (file) => { swapBefore(file); return originals.unlinkSync(file); };
    cp.spawnSync = (command, args, options) => { swapBefore(options?.cwd || ''); return originals.spawnSync(command, args, options); };
    result = ClaudeSandboxPlaceholders.remove(wt, []);
  } finally {
    fs.unlinkSync = originals.unlinkSync;
    cp.spawnSync = originals.spawnSync;
  }
  assert.equal(swapped, true, 'the swap ran before the first change');
  assert.deepEqual(result.removed, [], 'no file is reported as removed');
  assert.equal(result.failures[0].relative, '.claude/settings.json');
  assert.match(result.failures[0].error.message, /directory changed/);
  assert.ok(result.failures.slice(1).every((failure) => /symlink/.test(failure.error.message)), 'later entries are refused as symlinked');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'REAL USER SETTINGS\n', 'the outside file keeps its content');
  assert.equal(fs.statSync(outsideFile).mode & 0o222, 0, 'the outside file keeps its mode');
});

test('sandbox cleanup keeps a real file that takes a placeholder name just before its removal', { skip: NO_STUBS }, (t) => {
  const { base } = makeRepo(t);
  const wt = path.join(base, 'worktree');
  fs.mkdirSync(wt);
  const bashrc = path.join(wt, '.bashrc');
  fs.writeFileSync(bashrc, '');
  fs.chmodSync(bashrc, 0o444);
  // Loaded only into the cleanup child, through NODE_OPTIONS: the first change to the
  // placeholder finds a real file at its name, which the child would otherwise delete.
  const preload = path.join(base, 'race-preload.js');
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { renameSync, unlinkSync, writeFileSync } = fs;',
    'const target = process.env.TOWER_CRANE_RACE_TARGET;',
    'let raced = false;',
    'const race = (file) => {',
    '  if (raced || path.resolve(String(file)) !== target) return;',
    '  raced = true;',
    '  unlinkSync(target);',
    '  writeFileSync(target, "REAL SHELL CONFIG\\n");',
    '};',
    'fs.renameSync = (from, ...rest) => { race(from); return renameSync(from, ...rest); };',
    'fs.unlinkSync = (file) => { race(file); return unlinkSync(file); };',
  ].join('\n'));
  const race = {
    NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
    TOWER_CRANE_RACE_TARGET: fs.realpathSync(bashrc),
  };
  const saved = Object.fromEntries(Object.keys(race).map((key) => [key, process.env[key]]));
  let result;
  Object.assign(process.env, race);
  try {
    result = ClaudeSandboxPlaceholders.remove(wt, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(result.removed, [], 'the replaced file is not reported as removed');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error.message, /changed during cleanup/);
  assert.equal(fs.readFileSync(bashrc, 'utf8'), 'REAL SHELL CONFIG\n', 'the real file keeps its content');
  assert.deepEqual(fs.readdirSync(wt).filter((name) => name.startsWith('.tower-crane-cleanup-')), [], 'no moved name is left behind');
});

test('sandbox cleanup puts back a directory that takes a placeholder name just before its removal', { skip: NO_STUBS }, (t) => {
  const { base } = makeRepo(t);
  const wt = path.join(base, 'worktree');
  fs.mkdirSync(wt);
  const bashrc = path.join(wt, '.bashrc');
  fs.writeFileSync(bashrc, '');
  fs.chmodSync(bashrc, 0o444);
  // Loaded only into the cleanup child: the first rename of the placeholder finds a
  // directory at its name, which the child moves aside before it can check it.
  const preload = path.join(base, 'race-preload.js');
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { renameSync } = fs;',
    'const target = process.env.TOWER_CRANE_RACE_TARGET;',
    'let raced = false;',
    'fs.renameSync = (from, ...rest) => {',
    '  if (!raced && path.resolve(String(from)) === target) {',
    '    raced = true;',
    '    fs.unlinkSync(target);',
    '    fs.mkdirSync(target);',
    '    fs.writeFileSync(path.join(target, "user-data"), "REAL USER DATA\\n");',
    '  }',
    '  return renameSync(from, ...rest);',
    '};',
  ].join('\n'));
  const race = {
    NODE_OPTIONS: `--require "${preload.replace(/\\/g, '/')}"`,
    TOWER_CRANE_RACE_TARGET: fs.realpathSync(bashrc),
  };
  const saved = Object.fromEntries(Object.keys(race).map((key) => [key, process.env[key]]));
  let result;
  Object.assign(process.env, race);
  try {
    result = ClaudeSandboxPlaceholders.remove(wt, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(result.removed, [], 'the directory is not reported as removed');
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error.message, /changed during cleanup/);
  assert.equal(fs.readFileSync(path.join(bashrc, 'user-data'), 'utf8'), 'REAL USER DATA\n', 'the directory is put back under its name');
  assert.deepEqual(fs.readdirSync(wt).filter((name) => name.startsWith('.tower-crane-cleanup-')), [], 'no moved name is left behind');
});

test('the Claude sandbox git env drops only core.excludesFile from an inherited GIT_CONFIG_PARAMETERS', () => {
  const own = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/x' };
  const cases = [
    ["'advice.detachedHead'", {}],
    ["'core.excludesFile'='/g' 'advice.detachedHead'", { GIT_CONFIG_PARAMETERS: "'advice.detachedHead'" }],
    ["'core.excludesFile=/g' 'advice.detachedHead'", { GIT_CONFIG_PARAMETERS: "'advice.detachedHead'" }],
    ["'url.https://h/?a=b.insteadOf'='x' 'core.excludesfile'='/g'", { GIT_CONFIG_PARAMETERS: "'url.https://h/?a=b.insteadOf'='x'" }],
    ["'core.excludesfile=/g' 'url.https://h/?a=b.insteadOf'='x'", { GIT_CONFIG_PARAMETERS: "'url.https://h/?a=b.insteadOf'='x'" }],
    ["'a'\\''b'='c' 'core.excludesFile'='/g'", { GIT_CONFIG_PARAMETERS: "'a'\\''b'='c'" }],
  ];
  for (const [parameters, kept] of cases) {
    assert.deepEqual(ClaudeSandboxPlaceholders.gitEnvironment('/x', { GIT_CONFIG_PARAMETERS: parameters }), { ...kept, ...own }, parameters);
  }
});

test('a valueless GIT_CONFIG_PARAMETERS entry does not stop a sandboxed claude from starting', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  u.env.GIT_CONFIG_PARAMETERS = "'advice.detachedHead'";

  spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(SANDBOX_MOUNTS),
  });
  assert.deepEqual(u.report().placeholderGitStatus, { code: 0, stdout: '', stderr: '' }, 'git status stays clean while the placeholders exist');
  assert.equal(fs.existsSync(path.join(wt, '.bashrc')), false, '.bashrc placeholder is removed after exit');
});

test('an older-form GIT_CONFIG_PARAMETERS excludes entry does not stop a sandboxed claude from hiding its placeholders', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const globalIgnore = path.join(h.base, 'explicit-global-ignore');
  fs.writeFileSync(globalIgnore, 'explicitly-ignored/\n');
  u.env.GIT_CONFIG_PARAMETERS = `'core.excludesFile=${globalIgnore.replace(/\\/g, '/')}'`;

  spawn(h, u, 'small', {
    STUB_CLAUDE_SANDBOX_PLACEHOLDERS: JSON.stringify(SANDBOX_MOUNTS),
  });
  assert.deepEqual(u.report().placeholderGitStatus, { code: 0, stdout: '', stderr: '' }, 'git status stays clean while the placeholders exist');
  assert.equal(fs.existsSync(path.join(wt, '.bashrc')), false, '.bashrc placeholder is removed after exit');
});

test('claude\'s own Read, Grep and Glob tools are denied every path its sandbox hides', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'small', 'claude');
  const ssh = path.join(u.home, '.ssh', 'id_probe');
  fs.mkdirSync(path.dirname(ssh), { recursive: true });
  fs.writeFileSync(ssh, 'ssh key\n');
  // The owner key, and a home and broker token of an agent spawned after this one.
  const hidden = [path.join(path.dirname(h.userConfig), 'owner', 'key'), ssh,
    path.join(h.state, 'homes', 'worker-later', 'settings.json'), path.join(h.state, 'brokers', 'worker-later', 'token')];
  const open = path.join(wt, '.claude', 'settings.local.json');
  spawn(h, u, 'small', { STUB_READ: JSON.stringify([...hidden, open]) });
  const reads = u.report().reads;
  assert.equal(reads.length, 15);
  for (const r of reads) {
    if (r.file === open) assert.match(r.text, /planted-local-hook/, `${r.tool} reads the worktree`);
    else assert.equal(r.denied, true, `${r.tool} ${r.file}`);
  }
});

test('sandbox owner-key denials use the project binding after the caller changes config', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const ownerDir = path.join(h.readState('project.json').owner_config_dir, 'owner');
  const callerConfig = path.join(h.base, 'caller-config', 'config.json');
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'small', harness);
    spawn(h, u, 'small', { TOWER_CRANE_AGENT: 'orchestrator', TOWER_CRANE_CONFIG: callerConfig });
    const seen = u.report();
    if (harness === 'claude') {
      assert.ok(seen.settings.sandbox.filesystem.denyRead.includes(ownerDir));
      const posix = ownerDir.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).split(path.sep).join('/');
      for (const tool of ['Read', 'Grep', 'Glob']) {
        assert.ok(seen.settings.permissions.deny.includes(`${tool}(/${posix}/**)`));
      }
    } else {
      assert.equal(seen.config.permissions['tower-crane'].filesystem[ownerDir], 'none');
    }
  }
});

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
  const dry = h.json(['spawn', '--role', 'small', '--task', 'T1', '--dry-run'], { env: u.env });
  assert.ok(!JSON.stringify(dry).includes(SECRET), 'no credential in the command or its env');
  const started = spawn(h, u, 'small');
  const seen = u.report();
  assert.ok(!seen.memory.join('\n').includes('PLANTED'), 'user instruction files and memories stay out of its home');
  assert.ok(seen.prompt.includes(`- ${path.join(u.home, '.codex', 'AGENTS.md')} (global, read it)`), 'the prompt names the user\'s global rules for the agent to read');
  assert.match(seen.memory.join('\n'), /^# tower-crane-small/m);
  assert.deepEqual(seen.mcp, {}, 'no MCP server');
  assert.ok(!seen.rules.join('\n').includes('planted-rule'), 'no approved-command rules');
  assert.match(seen.rules.join('\n'), /pattern = \["gh", "pr", "merge"\],\n {4}decision = "forbidden"/, 'the role denies gh writes');
  assert.equal(seen.auth, `{"token":"${SECRET}-CRED"}`, 'auth.json reaches the agent');
  assert.equal(seen.env, `AWS_BEARER_TOKEN_BEDROCK=${SECRET}-ENV\n`, '.env reaches the agent');
  assert.equal(seen.config.model_provider, 'p', 'the provider is kept');
  assert.deepEqual(seen.config.model_providers, { p: { name: 'P', env_key: 'P_KEY' }, q: { name: 'Q', env_key: 'Q_KEY', wire_api: 'responses' } }, 'providers in any layout, without credentials');
  for (const k of ['approval_policy', 'model_instructions_file']) assert.equal(seen.config[k], undefined, `${k} is the user's, not the role's`);
  assert.ok(seen.config.notify.includes(path.join(started.tool.path, 'lib', 'hook-bridge.js')));
  assert.ok(!seen.config.notify.includes('planted-notify'));
  assert.deepEqual(Object.keys(seen.config.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  const home = path.join(h.state, 'homes', started.agent);
  for (const f of ['auth.json', '.env']) assert.ok(fs.lstatSync(path.join(home, f)).isSymbolicLink(), `${f} is linked`);
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
