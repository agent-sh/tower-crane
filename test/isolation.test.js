'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT, BIN, detachedAlive } = require('./helpers');
const A = require('../lib/agents');
const S = require('../lib/state');
const TOML = require('../lib/toml');
const ClaudeSandboxPlaceholders = require('../lib/claude-sandbox-placeholders');

const STUB = path.join(__dirname, 'fixtures', 'harness-stub.js');
// The stubs are scripts started through a shebang; Windows starts only .exe
// and .com files from a rung, so the end-to-end runs are POSIX only.
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET = 'PLANTED-SECRET';
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

// A user home holding what must never reach a tower-crane agent: memory and
// instruction files, hooks, an MCP server, approved-command rules, and
// credentials that must reach it only through a link.
function plant(h) {
  const home = path.join(h.base, 'home');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  put('.claude/CLAUDE.md', 'PLANTED-MEMORY\n');
  put('.claude/settings.json', JSON.stringify({
    permissions: { allow: ['Bash(planted-rule:*)'] },
    env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: `${SECRET}-ENV` },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'planted-user-hook' }] }] },
    apiKeyHelper: `echo ${SECRET}-HELPER`,
  }));
  put('.claude.json', JSON.stringify({ mcpServers: { planted: { command: 'planted-mcp', args: ['x'], env: { TOKEN: `${SECRET}-MCP` } } } }));
  put('.claude/.credentials.json', `{"token":"${SECRET}-CRED"}`);
  put('instructions.md', 'PLANTED-INSTRUCTIONS\n');
  put('.codex/config.toml', [
    'model = "m"', 'model_provider = "p"', 'approval_policy = "never"', 'notify = ["planted-notify"]',
    `model_instructions_file = ${JSON.stringify(path.join(home, 'instructions.md'))}`, '',
    '[model_providers.p]', 'name = "P"', `experimental_bearer_token = "${SECRET}-TOKEN"`, 'env_key = "P_KEY"', '',
    '[model_providers]', `q = { name = "Q", env_key = "Q_KEY", wire_api = "responses", experimental_bearer_token = "${SECRET}-INLINE" }`, '',
    '[mcp_servers.planted]', 'command = "planted-mcp"', '',
    '[mcp_servers.planted.env]', `TOKEN = "${SECRET}-MCP"`, '',
  ].join('\n'));
  put('.codex/fixture-main.config.toml', [
    'model = "s"', `experimental_bearer_token = "${SECRET}-PROFILE"`,
    `model_instructions_file = ${JSON.stringify(path.join(home, 'instructions.md'))}`,
    `model_providers = { r = { name = "R", experimental_bearer_token = "${SECRET}-PROFILE-INLINE" } }`, '',
  ].join('\n'));
  put('.codex/AGENTS.md', 'PLANTED-MEMORY\n');
  put('.codex/memories/m.md', 'PLANTED-MEMORY-2\n');
  put('.codex/rules/default.rules', 'prefix_rule(pattern = ["planted-rule"], decision = "allow")\n');
  put('.codex/auth.json', `{"token":"${SECRET}-CRED"}`);
  put('.codex/.env', `AWS_BEARER_TOKEN_BEDROCK=${SECRET}-ENV\n`);
  put('.agents/skills/planted-user-skill/SKILL.md', '---\nname: planted-user-skill\n---\nPLANTED-SKILL\n');
  put('.gitconfig', '[user]\n\tname = planted user\n');

  const bin = path.join(h.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire(${JSON.stringify(STUB)})(${JSON.stringify(name)});\n`, { mode: 0o755 });
  }
  // gh is not on every CI runner; this one stands in for the real program
  // the agent's gh shim hands allowed calls to.
  // Like a gh whose login is in the system keyring: `auth token` answers
  // outside a sandbox, and a write without GH_TOKEN gets the 401 a sandboxed
  // agent got when the keyring was out of its reach.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = token ]; then echo stub-gh-token; exit 0; fi',
    'if [ "$1" = pr ] && [ "$2" = comment ] && [ "$GH_TOKEN" != stub-gh-token ]; then echo "HTTP 401: Requires authentication" >&2; exit 1; fi',
    'echo fake gh', '',
  ].join('\n'), { mode: 0o755 });
  // A test nested inside an agent must not cycle through the parent and
  // child git shims, and the parent's guard refuses the options a shim adds to
  // a push, so the fixture delegates past every agent shim to the real git.
  // Network pushes return a fixture error without contacting a remote.
  const parentPath = String(process.env.PATH || '').split(path.delimiter)
    .filter((dir) => !fs.existsSync(path.join(dir, '..', '.tower-crane-origin.json'))).join(path.delimiter);
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
const env = { ...process.env, PATH: ${JSON.stringify(parentPath)} };
if (args[0] === 'push') {
  const target = args.find((a, i) => i > 0 && !a.startsWith('-')) || 'origin';
  const remote = cp.spawnSync('git', ['remote', 'get-url', '--push', target], { env, encoding: 'utf8' });
  if (/^(?:https?|ssh|git):|^[^/]*@/.test(target) || /^(?:https?|ssh|git):|^[^/]*@/.test((remote.stdout || '').trim())) {
    process.stderr.write('fixture remote unavailable\\n');
    process.exit(1);
  }
}
const result = cp.spawnSync('git', args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const out = path.join(h.base, 'stub.json');
  const runEnv = { ...h.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: out };
  // Nested harness cache settings must not redirect the fake user's caches.
  runEnv.XDG_CACHE_HOME = path.join(home, '.cache');
  // The developer's own harness homes and gh tokens must not leak in: the
  // fixture's gh login lives in its stub keyring. The tokens are emptied, not
  // deleted, since the caller's own env would fill a missing key back in.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) runEnv[k] = '';
  runEnv.CLAUDE_CONFIG_DIR = '';
  runEnv.CODEX_HOME = '';
  // Credential discovery must stay inside the synthetic home unless a test
  // explicitly supplies another location.
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR', 'DOCKER_CONFIG', 'CARGO_HOME',
    'KUBECONFIG', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'AZURE_CONFIG_DIR', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig',
    'PIP_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_CLIENT_CERTIFICATE_PATH',
    'CLAUDE_CODE_CLIENT_KEY']) runEnv[key] = '';
  // Agent caches belong under the fixture's home, not the runner's cache.
  runEnv.XDG_CACHE_HOME = '';
  return { home, out, env: runEnv, report: () => JSON.parse(fs.readFileSync(out, 'utf8')) };
}

function setup(t) {
  const h = makeRepo(t);
  // A repository whose own claude settings carry a hook.
  fs.mkdirSync(path.join(h.repo, '.claude'));
  fs.writeFileSync(path.join(h.repo, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'planted-project-hook' }] }] } }));
  h.git(['add', '.']);
  h.git(['commit', '-q', '-m', 'project settings']);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Probe', '--acceptance', 'nothing planted reaches the agent']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'probe\n' });
  const wt = h.json(['worktree', 'T1']).path;
  fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'planted-local-hook' }] }] } }));
  return { h, u: plant(h), wt };
}

function isolateGitEnvironment(h, u) {
  const global = path.join(h.base, 'gitconfig');
  const xdg = path.join(u.home, 'test-xdg');
  for (const env of [h.env, u.env]) {
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|SYSTEM)$/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      HOME: u.home, USERPROFILE: u.home, XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1',
    });
  }
  return { global, xdg };
}

// Every regular file under dir, without following links into the user's home.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function noSecretsCopied(h) {
  for (const f of walk(h.state)) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), `${f} holds a copied credential`);
}

// An exited worker keeps its lease until the orchestrator releases it, so each dispatch releases the last one.
function releaseExited(h) {
  // Read the state directly: an unbound project refuses `task show` from the owner's identity.
  const claim = h.readState('tasks.json').tasks[0].claim;
  if (claim) h.ok(['release', 'T1', '--agent', claim.agent, '--reason', 'worker exited']);
}

function spawn(h, u, role, env = {}, opts = {}) {
  releaseExited(h);
  // A submitted task goes back for rework before its next worker is dispatched.
  if (['easy', 'medium', 'hard', 'research'].includes(role) && h.readState('tasks.json').tasks[0].status === 'submitted') {
    h.ok(['rework', 'T1', '--reason', 'dispatch the next worker']);
  }
  if (role === 'review' && h.readState('tasks.json').tasks[0].status !== 'submitted') {
    h.ok(['task', 'update', 'T1', '--kind', 'docs']);
    h.ok(['claim', 'T1', '--agent', 'builder']);
    h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'builder']);
  }
  // A worker needs a task it can claim; an earlier review spawn leaves T1 submitted.
  if (['easy', 'medium', 'hard', 'research'].includes(role) && h.readState('tasks.json').tasks[0].status === 'submitted') {
    h.ok(['rework', 'T1', '--reason', `probe the ${role} rung`]);
  }
  const r = h.run(['spawn', '--role', role, '--task', 'T1', '--wait', '--json'], { ...opts, env: { ...u.env, ...env } });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// The shim's decision for each command under each job's policy, as the spawn
// writes it to policy.json, in one node process: 126 for a refusal, ALLOW for
// a push or gh call the shim would hand on, and otherwise the exit code of
// the git command, which runs so later decisions see the config it changes.
const ALLOW = 'allow';
const DECIDE = `
const cp = require('node:child_process');
const { gitDenied, ghDenied, findReal } = require(process.argv[1]);
const { policies, cases } = JSON.parse(process.argv[2]);
const ALLOW = ${JSON.stringify(ALLOW)};
// The git the shim hands calls to, past any parent agent's shim.
const git = findReal('git', '');
const out = cases.map(([tool, ...args]) => {
  const push = tool === 'git' && args.includes('push');
  const seen = policies.map((policy) => {
    const pushArgs = [];
    const why = tool === 'git' ? gitDenied(args, policy, git, pushArgs) : ghDenied(args, policy);
    return { why, pushArgs };
  });
  let code = null;
  if (!push && tool === 'git' && seen.some((s) => !s.why)) code = cp.spawnSync(git, args, { stdio: 'ignore' }).status;
  return seen.map(({ why, pushArgs }) => ({ argv: [tool, ...args], code: why ? 126 : code ?? ALLOW, why, pushArgs }));
});
process.stdout.write(JSON.stringify(out));
`;
function decide(h, cwd, jobs, branch, cases) {
  const policies = jobs.map((job) => ({ ...A.policy(A.load(job)), branch, repo: 'acme/app' }));
  const r = cp.spawnSync(process.execPath, ['-e', DECIDE, path.join(ROOT, 'lib', 'shim.js'), JSON.stringify({ policies, cases })],
    { cwd, env: h.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const isolated = (h, rung, harness) => {
  const model = harness === 'claude' ? ['--model', 'fixture-large', '--clear', 'profile'] : ['--profile', 'fixture-main', '--clear', 'model'];
  h.ok(['ladder', 'set', rung, '--harness', harness, ...model, '--clear', 'effort', '--clear', 'args']);
};

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
  const r = cp.spawnSync('codex', [...overrides, 'features', 'list'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 60000 });
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
  assert.deepEqual(native.settings.sandbox.network.allowedDomains, ['*']);
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
  assert.deepEqual(box.filesystem.allowWrite, []);
  assert.equal(box.filesystem.denyWrite[0], h.state, 'the state is read-only');
  assert.ok(box.filesystem.denyWrite.includes(wt), 'the worktree is read-only');
  // claude writes a linked worktree's git directory itself; what runs code stays read-only.
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  assert.ok(box.filesystem.denyWrite.includes(path.join(common, 'config')), 'the shared git config is read-only');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'homes')), 'other agent homes are hidden, including future spawns');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'brokers')), 'no agent reads another agent\'s broker token');
  assert.ok(box.filesystem.denyRead.includes(path.join(path.dirname(h.userConfig), 'owner')), 'no agent reads the owner key');
  assert.deepEqual(box.filesystem.allowRead, [path.join(u.home, '.claude', 'CLAUDE.md'), home, path.join(h.state, 'brokers', started.agent), ...A.runReads(u.env)],
    'only the user\'s global rules under the home, this dispatch home, its own broker directory and the resolver under /run are readable');
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
  const gitignore = fs.existsSync(gitignoreFile) ? fs.readFileSync(gitignoreFile, 'utf8') : null;
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
  assert.equal(fs.existsSync(gitignoreFile) ? fs.readFileSync(gitignoreFile, 'utf8') : null, gitignore, 'the repository .gitignore is unchanged');

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
  spawn(h, u, 'small');
  for (const name of [...stale, '.claude/agents', '.claude/.cc-writes']) assert.equal(fs.existsSync(path.join(wt, name)), false, `stale ${name} is swept`);
  for (const name of ['.zshrc', '.profile', '.vscode/settings.json', '.claude/settings.json']) assert.equal(fs.existsSync(path.join(wt, name)), true, `${name} stays`);
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

// Whether the agent's commands can read file, as each sandbox decides it.
// claude mounts each denied directory empty, shallowest first, and remounts
// the allowed paths inside it, so the deepest entry naming the path wins.
// codex starts from an empty root and mounts only the paths its rules name
// (the fixture's home is no system directory): readable paths, then each
// 'none' path hidden, then the writable ones, so only a writable rule inside
// a hidden path reopens it. A special path stands for what codex resolves it
// to: :root for /, :minimal for the system directories, :tmpdir for the
// TMPDIR codex started with, :slash_tmp for /tmp.
const CODEX_MINIMAL = ['/bin', '/sbin', '/usr', '/etc', '/lib', '/lib64', '/nix/store', '/run/current-system/sw'];
function codexTargets(seen, p) {
  if (!p.startsWith(':')) return [p];
  if (p === ':root') return [path.parse(process.cwd()).root];
  if (p === ':minimal') return CODEX_MINIMAL;
  if (p === ':tmpdir') return seen.tmpdir && path.isAbsolute(seen.tmpdir) ? [seen.tmpdir] : [];
  if (p === ':slash_tmp') return ['/tmp'];
  return [];
}

function commandsRead(seen, file) {
  const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
  if (seen.harness === 'claude') {
    const box = seen.settings.sandbox.filesystem;
    const entries = [...box.denyRead.map((p) => [p, 0]), ...box.allowRead.map((p) => [p, 1])]
      .filter(([p]) => under(file, p)).sort((a, b) => a[0].length - b[0].length || a[1] - b[1]);
    return entries.length === 0 || entries.at(-1)[1] === 1;
  }
  const profile = seen.config.permissions['tower-crane'].filesystem;
  const rules = Object.entries(profile).filter(([, access]) => typeof access === 'string')
    .flatMap(([p, access]) => codexTargets(seen, p).map((target) => [target, access]));
  const named = (access) => rules.filter(([, a]) => access(a)).map(([p]) => p);
  const hidden = named((a) => a === 'none');
  const writable = named((a) => a === 'write');
  return named((a) => a !== 'none').some((p) => under(file, p))
    && !hidden.some((dir) => under(file, dir) && !writable.some((w) => under(w, dir) && under(file, w)));
}

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
    fs.writeFileSync(f, `${SECRET}-HOME\n`);
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
  // A cache root of 46 bytes or less, as /home/<user>/.cache is for a user name of up to 34 letters.
  const root = fs.mkdtempSync(path.join(require('node:os').homedir(), '.cache', 'tc-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.ok(Buffer.byteLength(root) <= 46, `${root} is short enough for this check`);
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

test('a codex agent cannot read a caller TMPDIR outside the home that an entry of / exposes', { skip: (NO_STUBS || !fs.existsSync('/var/tmp')) && 'needs /var/tmp' }, t => {
  // Found in review 2026-10-14: /var/tmp on Linux, or /var/folders through
  // /private on macOS, stayed readable through the entry of / that holds it.
  const { h, u } = setup(t);
  const caller = fs.mkdtempSync('/var/tmp/tower-crane-caller-');
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

test('an agent of another project reads the Tower Crane code in the checkout, never its state, brokers or homes', { skip: NO_STUBS }, t => {
  // The checkout the CLI runs from can hold its own project's state, whose
  // brokers/ holds tokens and homes/ links to the user's credentials. The
  // home here holds the checkout, as ~ holds ~/projects/<checkout>.
  const { h, u } = setup(t);
  const home = fs.realpathSync(path.dirname(ROOT));
  const checkout = fs.realpathSync(ROOT);
  const hidden = ['.tower-crane/brokers/orchestrator/broker.json', '.tower-crane/homes/worker-T1-1/.credentials.json', '.tower-crane/tasks.json', '.git/config']
    .map((p) => path.join(checkout, ...p.split('/')));
  const open = ['bin/tower-crane.js', 'lib/agents.js', 'skills/tower-crane-work/SKILL.md', 'agents/tower-crane-small.md', 'standards/default.md', 'package.json']
    .map((p) => path.join(checkout, ...p.split('/')));
  for (const harness of ['claude', 'codex']) {
    for (const rung of ['small', 'hard']) {
      isolated(h, rung, harness);
      spawn(h, u, rung, { HOME: home, USERPROFILE: home });
      const seen = u.report();
      for (const p of hidden) assert.equal(commandsRead(seen, p), false, `${harness} ${rung}: ${path.relative(checkout, p)} is hidden`);
      for (const p of open) assert.equal(commandsRead(seen, p), true, `${harness} ${rung}: ${path.relative(checkout, p)} is readable`);
    }
  }
});

test('node installs and harness programs under the home stay readable; other installs there do not', { skip: NO_STUBS }, t => {
  // Seen 2026-10-12: codex runs its own binary inside its sandbox through a
  // link in its home, and hiding it stopped every Codex worker from starting.
  const { h, u } = setup(t);
  const prefix = path.join(u.home, '.nvm', 'versions', 'node', 'v0');
  const other = path.join(u.home, '.nvm', 'versions', 'node', 'v1', 'bin', 'node');
  for (const node of [path.join(prefix, 'bin', 'node'), other]) {
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  }
  const vendored = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'vendor', 'codex');
  fs.mkdirSync(path.dirname(vendored), { recursive: true });
  fs.writeFileSync(vendored, '#!/bin/sh\n', { mode: 0o755 });
  // A harness installed under the home on PATH, outside any node install.
  const tools = path.join(u.home, 'tools-bin');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'opencode'), '#!/bin/sh\n', { mode: 0o755 });
  // A node in ~/.local/bin opens that directory, never ~/.local/share.
  const local = path.join(u.home, '.local', 'bin', 'node');
  const share = path.join(u.home, '.local', 'share', 'opencode', 'auth.json');
  for (const [file, text] of [[local, '#!/bin/sh\n'], [share, `${SECRET}-LOCAL\n`]]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
  }
  // The node installs last on PATH, so the real node keeps running the stubs.
  const env = { PATH: [tools, u.env.PATH, path.join(prefix, 'bin'), path.dirname(local)].join(path.delimiter) };
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'medium', env);
    const seen = u.report();
    for (const p of [vendored, path.join(prefix, 'bin', 'node'), path.join(tools, 'opencode'), local]) {
      assert.equal(commandsRead(seen, p), true, `${harness}: ${p} is readable`);
    }
    assert.equal(commandsRead(seen, other), false, `${harness}: a node install not on PATH stays hidden`);
    assert.equal(commandsRead(seen, share), false, `${harness}: a node in ~/.local/bin leaves ~/.local/share hidden`);
  }
});

test('a sandbox read path that is the whole home refuses dispatch', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: ['~'] })]);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    fs.rmSync(u.out, { force: true });
    const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
    assert.notEqual(refused.code, 0, `${harness}: reading the whole home must refuse dispatch`);
    assert.match(refused.stderr, /sandbox path .* is the user's home/);
    assert.ok(!fs.existsSync(u.out), 'the harness must not start');
  }
  // A directory that holds the home would open all of it: / mounts the whole
  // filesystem in codex's sandbox.
  for (const read of ['/', path.dirname(u.home)]) {
    h.ok(['project', 'set', '--sandbox', JSON.stringify({ read: [read] })]);
    for (const harness of ['claude', 'codex']) {
      isolated(h, 'hard', harness);
      fs.rmSync(u.out, { force: true });
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
      assert.notEqual(refused.code, 0, `${harness}: reading ${read} must refuse dispatch`);
      assert.match(refused.stderr, /sandbox path .* holds the user's home/);
      assert.ok(!fs.existsSync(u.out), 'the harness must not start');
    }
  }
  assert.notEqual(h.run(['project', 'set', '--sandbox', JSON.stringify({ read: 'tools' })]).code, 0, 'sandbox.read must be a list of paths');
});

test('repository imports of files under the home the agent may not read refuse startup', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const docker = path.join(u.home, '.docker', 'config.json');
  fs.mkdirSync(path.dirname(docker), { recursive: true });
  fs.writeFileSync(docker, '{"auths":{"example":{"auth":"IMPORT-SECRET"}}}\n');
  const auth = path.join(u.home, '.codex', 'auth.json');
  const alias = path.join(wt, 'credential-import.md');
  fs.symlinkSync(auth, alias);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const file of [auth, docker, alias]) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${file}\n`);
      if (file === alias) {
        // A global rule importing the repository's file does not make its imports the user's.
        const global = path.join(u.home, harness === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md');
        fs.appendFileSync(global, `@${path.join(wt, 'AGENTS.md')}\n`);
      }
      for (const mode of ['--dry-run', '--wait']) {
        const r = h.run(['spawn', '--task', 'T1', '--role', 'hard', mode], { env: u.env });
        assert.notEqual(r.code, 0, `${harness}: ${file} must not load into the harness`);
        assert.match(r.stderr, /house rule .* is under the user's home outside the agent's readable paths/);
        assert.doesNotMatch(r.stdout + r.stderr, /IMPORT-SECRET|PLANTED-SECRET/);
        assert.ok(!fs.existsSync(u.out), 'refuse before starting the harness');
      }
    }
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }
  // The user's own global rules may import a file under the home; it stays readable.
  const notes = path.join(u.home, 'notes', 'rules.md');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, 'USER-NOTES\n');
  fs.writeFileSync(path.join(u.home, '.claude', 'CLAUDE.md'), `PLANTED-MEMORY\n@${notes}\n`);
  isolated(h, 'hard', 'claude');
  spawn(h, u, 'hard');
  assert.equal(commandsRead(u.report(), notes), true, 'a global rule import stays readable');
});

test('a sandboxed agent runs with the user\'s git settings but none of their credential helpers, and git reaches GitHub with the handed token', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const { global } = isolateGitEnvironment(h, u);
  const included = path.join(h.base, 'included.gitconfig');
  fs.writeFileSync(included, '[alias]\n\tst = status\n[credential "https://example.com"]\n\thelper = store\n');
  const ignore = path.join(u.home, 'global.gitignore');
  fs.writeFileSync(ignore, '*.planted\n');
  fs.writeFileSync(global, [
    '[user]', '\tname = Planted User', '\temail = planted@example.com',
    '[credential]', '\thelper = cache --timeout=3600',
    '[http "https://github.com/"]', '\textraHeader = AUTHORIZATION: bearer HEADER-SECRET',
    '[core]', '\texcludesFile = ~/global.gitignore',
    '[include]', `\tpath = ${included}`,
    // Secrets git keeps outside credential.*: a URL's userinfo and a mail password.
    '[url "https://x:URL-SECRET@github.com/"]', '\tinsteadOf = https://github.com/',
    '[url "ssh://git@example.com/"]', '\tinsteadOf = https://example.com/',
    '[http]', '\tproxy = http://u:PROXY-SECRET@proxy.example:8080',
    '[sendemail]', '\tsmtpPass = SMTP-SECRET', '',
  ].join('\n'));
  const git = require(path.join(ROOT, 'lib', 'shim.js')).findReal('git', '');
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const started = spawn(h, u, 'hard');
    const seen = u.report();
    const rendered = path.join(h.state, 'homes', started.agent, 'home', '.gitconfig');
    // O_NOFOLLOW refuses a link, so one open proves the file is the agent's own.
    const fd = fs.openSync(rendered, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
      assert.equal(fs.fstatSync(fd).isFile(), true, `${harness}: the agent's git config is its own file`);
      text = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
    assert.doesNotMatch(text, /HEADER-SECRET|cache --timeout|helper = "?store/, 'no credential helper or auth header');
    assert.doesNotMatch(text, /URL-SECRET|PROXY-SECRET|SMTP-SECRET/, 'no URL userinfo or mail password');
    const gitEnv = { ...h.env, GIT_CONFIG_GLOBAL: rendered, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const get = (key) => cp.spawnSync(git, ['config', '--global', '--get', key], { env: gitEnv, encoding: 'utf8' }).stdout.trim();
    assert.equal(get('user.name'), 'Planted User');
    assert.equal(get('alias.st'), 'status', 'included files are flattened in');
    assert.equal(get('core.excludesfile'), ignore);
    assert.equal(get('url.ssh://git@example.com/.insteadof'), 'https://example.com/', 'a user name in an ssh URL stays');
    assert.equal(get('http.proxy'), 'http://proxy.example:8080');
    assert.equal(commandsRead(seen, ignore), true, `${harness}: the excludes file it names stays readable`);
    const fill = (host, token) => cp.spawnSync(git, ['credential', 'fill'], {
      env: { ...gitEnv, GH_TOKEN: token }, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', cwd: h.base,
    });
    assert.match(fill('github.com', 'handed-token').stdout, /^password=handed-token$/m, 'GitHub gets the handed token');
    assert.notEqual(fill('example.com', 'handed-token').status, 0, 'other hosts get no credential');
  }
});

test('harness roots cover an npm package, never a whole bin directory', { skip: process.platform === 'win32' && 'shebang bins' }, t => {
  const base = makeRepo(t).base;
  const pkg = path.join(base, 'lib', 'node_modules', '@openai', 'codex');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(pkg, 'bin', 'codex.js'), path.join(bin, 'codex'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const roots = require(path.join(ROOT, 'lib', 'agents')).harnessRoots({ cwd: base, env: { PATH: bin } });
  assert.deepEqual(roots.sort(), [fs.realpathSync(path.join(bin, 'claude')), fs.realpathSync(pkg)].sort());
});

test('gh config isolation survives settings on initial and fallback launches', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  const reports = path.join(h.base, 'gh-launches.jsonl');
  const original = path.join(h.base, 'original-gh');
  const selected = path.join(h.base, 'settings-gh');
  fs.mkdirSync(original);
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const path = require('node:path');
if (process.argv[2] === 'auth') {
  if (process.env.GH_CONFIG_DIR !== ${JSON.stringify(original)}) process.exit(1);
  console.log('stub-gh-token');
} else {
  if (process.env.GH_CONFIG_DIR !== path.join(process.env.HOME, '.config', 'gh')) {
    console.error('permission denied reading gh config'); process.exit(1);
  }
  if (process.env.GH_TOKEN !== 'stub-gh-token') process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) fs.writeFileSync(path.join(h.base, 'bin', harness), `#!${process.execPath}
const fs = require('node:fs');
require(${JSON.stringify(STUB)})(${JSON.stringify(harness)});
const report = JSON.parse(fs.readFileSync(process.env.STUB_OUT, 'utf8'));
fs.appendFileSync(${JSON.stringify(reports)}, JSON.stringify({ harness: report.harness, ran: report.ran, token: report.ghToken }) + '\\n');
if (process.env.STUB_FAIL_HARNESS === ${JSON.stringify(harness)}) {
  console.error('HTTP 503 service unavailable'); process.exit(1);
}
`);
  const envFile = path.join(h.base, 'gh-settings.env');
  fs.writeFileSync(envFile, `GH_CONFIG_DIR=${JSON.stringify(selected)}\n`);
  for (const source of ['literal', 'file']) {
    h.ok(['project', 'set', '--env', source === 'literal' ? JSON.stringify({ GH_CONFIG_DIR: selected }) : '{}', '--env_file', envFile]);
    for (const primary of ['claude', 'codex']) {
      const fallback = primary === 'claude' ? 'codex' : 'claude';
      isolated(h, 'hard', primary);
      h.ok(['ladder', 'set', 'hard', '--supervision', '{"retries":0,"backoff_ms":10,"max_backoff_ms":10}']);
      fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
      fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { hard: { fallbacks: [{
        harness: fallback, model: 'second', ...(source === 'literal' ? { env: { GH_CONFIG_DIR: selected } } : {}),
      }] } } }));
      fs.rmSync(reports, { force: true });
      spawn(h, u, 'hard', { GH_CONFIG_DIR: original, STUB_FAIL_HARNESS: primary,
        STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]) });
      const seen = fs.readFileSync(reports, 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(seen.map(report => report.harness), [primary, fallback]);
      for (const report of seen) {
        assert.equal(report.token, 'stub-gh-token');
        assert.equal(report.ran[0].code, 0, `${source} ${report.harness}: ${report.ran[0].stderr}`);
      }
    }
  }
});

test('a brokered ci log runs the host gh, not the agent\'s gh shim that refuses gh api', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  isolated(h, 'hard', 'claude');
  const branch = h.readState('tasks.json').tasks[0].branch;
  const sha = h.git(['rev-parse', 'HEAD']);
  const data = path.join(h.base, 'ci-feedback.json');
  fs.writeFileSync(data, JSON.stringify({
    jobs: { 42: { id: 42, name: 'test', head_branch: branch, head_sha: sha } },
    refs: { [`heads/${branch}`]: { ref: `refs/heads/${branch}`, object: { sha } } },
    logs: { 42: 'not ok 1 - read through the broker\n' },
    alerts: {},
  }));
  // The host gh: the plant's keyring login, and the CI feedback endpoints.
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
if (process.argv[2] === 'auth' && process.argv[3] === 'token') console.log('stub-gh-token');
else require(${JSON.stringify(path.join(__dirname, 'fixtures', 'ci-feedback-gh.js'))});
`, { mode: 0o755 });
  // The agent's PATH starts with its home's gh shim, which refuses gh api.
  spawn(h, u, 'hard', { CI_FEEDBACK_GH: data, STUB_RUN: JSON.stringify([[process.execPath, BIN, 'ci', 'log', '42']]) });
  const seen = u.report();
  assert.equal(seen.ran[0].code, 0, seen.ran[0].stderr);
  const scratch = h.readState('tasks.json').tasks[0].scratch;
  assert.equal(fs.readFileSync(path.join(scratch, 'ci-job-42.log'), 'utf8'), 'not ok 1 - read through the broker\n');
});

test('a codex agent writes only where its agent file says; a worker writes its git metadata, reviewer and small checks cannot write the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  // A worker fetches, adds, commits and pushes: it writes the repository's
  // git directory and its worktree's admin directory inside it.
  const common = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt));
  const own = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-dir'], wt));
  // A submodule named lib/a keeps its git directory in modules/lib/a.
  const mod = path.join(common, 'modules', 'lib', 'a');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(mod, 'config'), '');
  fs.rmSync(path.join(common, 'info'), { recursive: true, force: true });
  // What makes git outside the sandbox run commands, or read another config,
  // stays read-only though the git directory around it is writable.
  const guarded = [path.join(common, 'config'), path.join(common, 'config.worktree'), path.join(common, 'hooks'), path.join(common, 'info'),
    path.join(common, 'remotes'), path.join(common, 'branches'),
    path.join(mod, 'config'), path.join(mod, 'hooks'), path.join(own, 'config.worktree'), path.join(own, 'commondir'), path.join(own, 'gitdir'),
    path.join(fs.realpathSync(wt), '.git')];
  const globalSeen = [process.execPath, '-e', 'process.stderr.write(String(process.env.GIT_CONFIG_GLOBAL))'];
  for (const [rung, worktree] of [['hard', 'write'], ['review', 'read'], ['small', 'read']]) {
    isolated(h, rung, 'codex');
    const started = spawn(h, u, rung, { STUB_RUN: JSON.stringify([globalSeen]) });
    const home = path.join(h.state, 'homes', started.agent);
    const { config, ran } = u.report();
    const rules = config.permissions['tower-crane'].filesystem;
    for (const d of [common, own]) assert.equal(rules[d], worktree, `${rung}: ${d}`);
    for (const p of guarded) assert.equal(rules[p], worktree === 'write' ? 'read' : undefined, `${rung}: ${p}`);
    // The global config git reads, in the sandbox too: the rendered config
    // (lib/git-config.js) in the state directory, which the agent reads and
    // never writes; a codex agent writes its HOME, where the copy is read-only.
    const global = path.join(h.state, 'gitconfig', started.agent);
    assert.equal(ran[0].stderr, global, `${rung}: GIT_CONFIG_GLOBAL`);
    assert.equal(fs.readFileSync(global, 'utf8'), fs.readFileSync(path.join(home, 'home', '.gitconfig'), 'utf8'), rung);
    assert.match(fs.readFileSync(global, 'utf8'), /credential "https:\/\/github\.com"/, `${rung}: the rendered config, with the token helper`);
    assert.equal(rules[path.join(home, 'home', '.gitconfig')], 'read', `${rung}: the copy in its HOME`);
    assert.equal(rules[path.join(common, 'worktrees')], worktree === 'write' ? 'read' : undefined, `${rung}: other worktrees' admin directories`);
    assert.deepEqual(rules[':workspace_roots'], { '.': worktree }, rung);
    assert.equal(rules[':minimal'], 'read', rung);
    assert.equal(rules[h.state], 'read', `${rung}: the state is read-only; the broker writes it`);
    assert.equal(rules[path.join(h.state, 'homes')], 'none', `${rung}: other agent homes are hidden, including future spawns`);
    assert.equal(rules[home], 'read', `${rung}: its generated home remains readable`);
    const sessionRoot = path.join(h.state, 'homes', '.codex', started.agent);
    assert.equal(rules[sessionRoot], 'write', `${rung}: only its persisted sessions are writable`);
    assert.equal(started.codex_home, sessionRoot);
    assert.equal(fs.readlinkSync(path.join(h.state, 'homes', started.agent, 'sessions')), path.join(sessionRoot, 'sessions'));
    assert.equal(rules[path.join(h.state, 'brokers')], 'none', `${rung}: no agent reads another agent's broker token`);
    assert.equal(rules[path.join(h.state, 'brokers', started.agent)], 'write', `${rung}: its own broker directory is visible`);
    assert.equal(rules[path.join(home, 'home')], 'write', `${rung}: its HOME is writable`);
    // Codex mounts every readable path, then hides each 'none' directory,
    // then mounts the writable paths: a path under a hidden directory is
    // visible only if a writable rule names it or a directory between.
    const visible = (p) => {
      const named = Object.keys(rules).filter((k) => !k.startsWith(':') && (p === k || p.startsWith(k + path.sep)));
      const hidden = named.filter((k) => rules[k] === 'none');
      return hidden.every((d) => named.some((k) => rules[k] === 'write' && k.startsWith(d + path.sep)));
    };
    for (const p of [path.join(home, 'home'), path.join(h.state, 'brokers', started.agent, 'broker.json')]) {
      assert.ok(visible(p), `${rung}: the agent's commands see ${p}`);
    }
    assert.ok(!visible(path.join(h.state, 'brokers', 'worker-T9-1', 'broker.json')), `${rung}: another agent's token is hidden`);
    assert.equal(config.permissions['tower-crane'].network.enabled, true);
  }
  // The codex loop left T1 submitted; a worker needs a task it can claim.
  h.ok(['rework', 'T1', '--reason', 'probe the claude rungs']);
  // Other worktrees' admin directories, whose commondir and config.worktree
  // decide which config git reads there, are read-only, including one added
  // later: the task worktree's own lives outside worktrees/. claude adds a
  // linked worktree's common directory to its sandbox's writes itself, so a
  // read-only role gets the same carve-outs.
  assert.equal(path.dirname(own), path.join(path.dirname(fs.realpathSync(wt)), '.git-admin'));
  const worktrees = path.join(common, 'worktrees');
  for (const [rung, writes] of [['hard', true], ['small', false]]) {
    isolated(h, rung, 'claude');
    spawn(h, u, rung);
    const { allowWrite: allow, denyWrite: deny } = u.report().settings.sandbox.filesystem;
    for (const d of [common, own]) assert.equal(allow.includes(d), writes, `claude ${rung}: ${d}`);
    for (const p of [...guarded, worktrees]) assert.ok(deny.includes(p), `claude ${rung}: ${p}`);
    assert.ok(!deny.some((p) => own === p || own.startsWith(p + path.sep)), `claude ${rung}: its own admin directory stays writable`);
  }
  // Each guarded path exists, so no sandbox masks it with a placeholder.
  for (const p of guarded) assert.ok(fs.existsSync(p), p);
  assert.ok(fs.statSync(path.join(common, 'info')).isDirectory());
});

test('a link planted at a protected git path refuses the spawn and leaves its target untouched', { skip: NO_STUBS || (process.platform === 'win32' && 'symlinks need privileges on Windows') }, (t) => {
  const { h, u, wt } = setup(t);
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  // A sandbox would protect the target and leave the link to be swapped.
  const target = path.join(h.base, 'elsewhere');
  fs.writeFileSync(target, 'untouched\n');
  fs.symlinkSync(target, path.join(common, 'config.worktree'));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const r = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
    assert.notEqual(r.code, 0, harness);
    assert.match(r.stderr, /config\.worktree is a link; a sandbox cannot keep it read-only/, harness);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n', harness);
    assert.ok(fs.lstatSync(path.join(common, 'config.worktree')).isSymbolicLink(), harness);
  }
});

test('a sandboxed harness\'s own git runs no command the shared config, hooks, nested repo or the agent\'s HOME name; the agent\'s sandboxed git still runs hooks and drivers', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  fs.writeFileSync(path.join(wt, 'f.txt'), 'one\n');
  fs.writeFileSync(path.join(wt, 'g.txt'), 'one\n');
  h.git(['add', 'f.txt', 'g.txt'], wt);
  h.git(['commit', '-qm', 'f'], wt);
  const sub = path.join(wt, 'sub');
  h.git(['init', '-q', sub]);
  fs.writeFileSync(path.join(sub, 'f.txt'), 'one\n');
  h.git(['add', 'f.txt'], sub);
  h.git(['commit', '-qm', 'sub'], sub);
  h.git(['add', 'sub'], wt);
  h.git(['commit', '-qm', 'gitlink'], wt);
  // What a worker could have planted in the shared git directory.
  const common = h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt);
  // Each marks only a run under the spawned harness, whose environment alone
  // has TOWER_CRANE_SESSION: Tower Crane's own git and this test's are out of scope here.
  const mark = (name) => path.join(h.base, `ran-${name}`);
  const touch = (name) => `[ -z "$TOWER_CRANE_SESSION" ] || touch '${mark(name)}'`;
  h.git(['config', 'core.fsmonitor', `${touch('fsmonitor')}; false`], wt);
  h.git(['config', 'filter.planted.clean', `${touch('filter')}; cat`], wt);
  fs.writeFileSync(path.join(common, 'info', 'attributes'), 'f.txt filter=planted\ng.txt filter=home\n');
  fs.writeFileSync(path.join(common, 'hooks', 'post-checkout'), `#!/bin/sh\n${touch('hook')}\n`, { mode: 0o755 });
  const marks = ['fsmonitor', 'filter', 'hook', 'home', 'submodule'];
  // A codex agent writes its HOME, so after launch it can swap the linked
  // ~/.gitconfig for one that names a driver the scan never saw.
  const homeConfig = `const fs = require('node:fs'); const f = require('node:path').join(require('node:os').homedir(), '.gitconfig');
fs.rmSync(f, { force: true }); fs.writeFileSync(f, ${JSON.stringify(`[filter "home"]
	clean = ${touch('home')}; cat
`)});`;
  // A nested repository is writable even when the shared git config is not.
  // Plant its driver after launch, beyond the harness's initial config scan.
  const subConfig = `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(sub, '.git', 'config'))}, ${JSON.stringify(`[filter "nested"]
	clean = ${touch('submodule')}; cat
`)});
fs.writeFileSync(${JSON.stringify(path.join(sub, '.gitattributes'))}, 'f.txt filter=nested\\n');
fs.writeFileSync(${JSON.stringify(path.join(sub, 'f.txt'))}, 'two\\n');`;
  // A command the agent runs, as its sandbox marks it: the repository's hooks
  // run there, and background gc stays off.
  const agent = path.join(h.base, 'agent.json');
  const inSandbox = `const cp = require('node:child_process'); const fs = require('node:fs');
const env = { ...process.env, SANDBOX_RUNTIME: '1' };
cp.execFileSync('git', ['checkout', '-q', '-b', 'probe-agent'], { env });
cp.execFileSync('git', ['status', '--porcelain'], { env });
const gc = cp.execFileSync('git', ['config', 'gc.auto'], { env, encoding: 'utf8' }).trim();
fs.writeFileSync(${JSON.stringify(agent)}, JSON.stringify({ hook: fs.existsSync(${JSON.stringify(mark('hook'))}), submodule: fs.existsSync(${JSON.stringify(mark('submodule'))}), gc }));`;
  for (const harness of ['claude', 'codex']) {
    for (const m of marks) fs.rmSync(mark(m), { force: true });
    // Same size, so status must hash the content through the clean filter.
    for (const f of ['f.txt', 'g.txt']) fs.writeFileSync(path.join(wt, f), harness === 'claude' ? 'two\n' : 'six\n');
    isolated(h, 'hard', harness);
    const run = [[process.execPath, '-e', homeConfig], [process.execPath, '-e', subConfig], ['git', 'status', '--porcelain'], ['git', 'checkout', '-q', '-b', `probe-${harness}`], ['git', 'checkout', '-q', '-']];
    // Like the owner's own session, with no GIT_CONFIG_GLOBAL of its own.
    spawn(h, u, 'hard', { STUB_RUN: JSON.stringify(run), GIT_CONFIG_GLOBAL: undefined });
    const seen = u.report();
    for (const r of seen.ran) assert.equal(r.code, 0, `${harness}: ${r.argv.join(' ')}: ${r.stderr}`);
    assert.deepEqual(marks.filter((m) => fs.existsSync(mark(m))), [], `${harness}: the harness's git ran a planted command`);
    spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([[process.execPath, '-e', inSandbox]]) });
    assert.equal(u.report().ran[0].code, 0, u.report().ran[0].stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(agent, 'utf8')), { hook: true, submodule: true, gc: '0' }, harness);
    h.git(['checkout', '-q', '-'], wt);
    for (const b of [`probe-${harness}`, 'probe-agent']) h.git(['branch', '-D', b], wt);
  }
});

test('worker and reviewer sandboxes write a cache of their own, never the user cache root, the tower-crane install, the CLI on PATH or a gate program', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // Installed tools and scratch under the user cache run outside any sandbox.
  const root = path.join(u.home, '.cache');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(path.join(tools, 'bin'), { recursive: true });
  for (const f of ['bin/tower-crane', 'run-tests', 'clean-cmd.sh']) fs.writeFileSync(path.join(tools, f), '#!/bin/sh\n', { mode: 0o755 });
  h.ok(['project', 'set', '--tests-cmd', `${path.join(tools, 'run-tests')} --all`, '--clean-cmd', path.join(tools, 'clean-cmd.sh')]);
  const env = { PATH: `${path.join(tools, 'bin')}${path.delimiter}${u.env.PATH}`, XDG_CACHE_HOME: '' };
  const forbidden = [root, ROOT, path.join(tools, 'bin', 'tower-crane'), path.join(tools, 'run-tests'), path.join(tools, 'clean-cmd.sh')].map((p) => fs.realpathSync(p));
  const contains = (dir, p) => p === dir || p.startsWith(dir + path.sep);
  const probe = [process.execPath, '-e', `process.stderr.write(JSON.stringify(${JSON.stringify(['XDG_CACHE_HOME', 'GOCACHE', 'GOMODCACHE', 'npm_config_cache'])}.map((k) => process.env[k])))`];
  const covered = new Set();
  for (const harness of ['claude', 'codex']) {
    // A reviewer runs on the first tier rung at or above the task's tier.
    for (const rung of ['easy', 'medium', 'hard', 'review']) isolated(h, rung, harness);
    for (const rung of ['hard', 'review']) {
      const started = spawn(h, u, rung, { ...env, STUB_RUN: JSON.stringify([probe]) });
      const seen = u.report();
      covered.add(`${seen.harness} ${rung}`);
      const writes = seen.harness === 'claude' ? seen.settings.sandbox.filesystem.allowWrite
        : Object.entries(seen.config.permissions['tower-crane'].filesystem).filter(([k, v]) => !k.startsWith(':') && v === 'write').map(([k]) => k);
      for (const w of writes) {
        for (const p of forbidden) assert.ok(!contains(w, p), `${seen.harness} ${rung}: ${w} grants a write on ${p}`);
      }
      // Besides it, codex writes its temp directory, which is the short
      // tc/<12 hex> under the cache root when tmp in the cache is too long (codexTmp).
      const own = writes.filter((w) => contains(root, w) && !(seen.harness === 'codex' && w === seen.tmpdir));
      assert.equal(own.length, 1, `${seen.harness} ${rung}: one directory under the cache root: ${JSON.stringify(own)}`);
      if (seen.harness === 'codex' && !contains(own[0], seen.tmpdir)) {
        assert.match(seen.tmpdir, /[\\/]tc[\\/][0-9a-f]{12}$/, `${rung}: the codex temp directory is its own`);
      }
      assert.ok(contains(path.join(fs.realpathSync(root), 'tower-crane', rung === 'review' ? 'agents' : 'tasks'), own[0]) && path.basename(own[0]) === (rung === 'review' ? started.agent : 'T1'), own[0]);
      assert.ok(fs.statSync(own[0]).isDirectory(), 'the granted cache exists');
      assert.deepEqual(JSON.parse(seen.ran[0].stderr), [own[0], ...['go-build', 'go-mod', 'npm'].map((d) => path.join(own[0], d))], `${seen.harness} ${rung}: tool caches point at the agent cache`);
    }
  }
  assert.deepEqual([...covered].sort(), ['claude hard', 'claude review', 'codex hard', 'codex review']);
});

test('a spawn from a supervisor running in another agent\'s env gets a cache of its own under the user cache root, never nested in the inherited one', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'hard', 'claude');
  // The supervisor's XDG_CACHE_HOME is the cache of a worker, as an automation started from that worker's env has it.
  const root = path.join(u.home, '.cache');
  const inherited = path.join(root, 'tower-crane', 'agents', '22cd04e4ddaf', 'worker-T93-6');
  spawn(h, u, 'hard', { XDG_CACHE_HOME: inherited });
  const real = fs.realpathSync(root);
  const own = u.report().settings.sandbox.filesystem.allowWrite.filter((w) => w === real || w.startsWith(real + path.sep));
  assert.equal(own.length, 1, `one directory under the cache root: ${JSON.stringify(own)}`);
  // Worker scratch is keyed by task, whatever the inherited agent cache was.
  assert.equal(path.dirname(path.dirname(own[0])), path.join(real, 'tower-crane', 'tasks'), own[0]);
  assert.equal(path.basename(own[0]), 'T1');
  assert.ok(fs.statSync(own[0]).isDirectory(), 'the granted cache exists');
});

test('a second worker spawn reads and writes the first attempt scratch for the same task', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'hard', 'claude');
  const env = { XDG_CACHE_HOME: '' };
  const write = [process.execPath, '-e', `require('node:fs').writeFileSync(require('node:path').join(process.env.XDG_CACHE_HOME, 'receipt.txt'), 'first attempt\\n')`];
  const first = spawn(h, u, 'hard', { ...env, STUB_RUN: JSON.stringify([write]) });
  const cache = u.report().settings.sandbox.filesystem.allowWrite.find((w) => /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(w));
  const file = path.join(cache, 'receipt.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\n');
  // A finished worker keeps its lease until released, so the builder claims after that.
  h.ok(['release', 'T1', '--agent', first.agent, '--reason', 'first attempt exited']);
  h.ok(['claim', 'T1', '--agent', 'builder']);
  h.ok(['submit', 'T1', '--agent', 'builder', '--sha', h.git(['rev-parse', 'HEAD'], wt)]);
  const probe = [process.execPath, '-e', `const fs = require('node:fs'); const path = require('node:path'); const file = path.join(process.env.XDG_CACHE_HOME, 'receipt.txt'); process.stderr.write(fs.readFileSync(file, 'utf8')); fs.appendFileSync(file, 'second attempt\\n');`];
  const second = spawn(h, u, 'hard', { ...env, STUB_RUN: JSON.stringify([probe]) });
  assert.notEqual(second.agent, first.agent);
  const seen = u.report();
  assert.equal(seen.ran[0].code, 0, seen.ran[0].stderr);
  assert.equal(seen.ran[0].stderr, 'first attempt\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\nsecond attempt\n');
  assert.ok(seen.settings.sandbox.filesystem.allowWrite.includes(cache));
  assert.ok(seen.prompt.includes(cache), 'the worker brief names the shared scratch');
  assert.equal(h.json(['task', 'show', 'T1']).scratch, cache);
  h.ok(['task', 'add', '--title', 'Another task', '--acceptance', 'separate scratch']);
  h.ok(['brief', 'set', 'T2', '-'], { input: 'another task\n' });
  const other = h.json(['spawn', '--role', 'hard', '--task', 'T2', '--wait'], { env: { ...u.env, XDG_CACHE_HOME: cache } });
  assert.notEqual(other.agent, second.agent);
  const otherCache = h.json(['task', 'show', 'T2']).scratch;
  assert.notEqual(otherCache, cache);
  assert.equal(path.dirname(otherCache), path.dirname(cache), 'an inherited task cache never nests the next task');
  assert.ok(!fs.existsSync(path.join(otherCache, 'receipt.txt')));
  assert.equal(fs.readFileSync(file, 'utf8'), 'first attempt\nsecond attempt\n');
});

test('cancel removes worker task scratch with read-only module trees alongside the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  const first = spawn(h, u, 'medium');
  const config = u.report().config;
  const cache = Object.entries(config.permissions['tower-crane'].filesystem)
    .find(([w, v]) => v === 'write' && /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(w))[0];
  const mod = path.join(cache, 'go-mod', 'example.com', 'm@v1.0.0');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'go.mod'), 'module example.com/m\n');
  for (const p of [path.join(mod, 'go.mod'), mod, path.dirname(mod)]) fs.chmodSync(p, p === mod || p === path.dirname(mod) ? 0o555 : 0o444);
  t.after(() => {
    for (const p of [path.dirname(mod), mod]) try { fs.chmodSync(p, 0o700); } catch {}
  });
  const settings = fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8');
  h.ok(['task', 'update', 'T1', '--status', 'cancelled'], { env: u.env });
  const saved = h.json(['task', 'show', 'T1']).worktree.saved;
  assert.equal(fs.readFileSync(path.join(saved, 'files', '.claude', 'settings.local.json'), 'utf8'), settings);
  assert.ok(!fs.existsSync(wt));
  assert.ok(!fs.existsSync(cache), `${first.agent}'s task scratch is removed`);
  assert.equal(h.json(['task', 'show', 'T1']).scratch, undefined);
});

test('a live spawn keeps its git, gh, hooks and policy on its recorded tool after a checkout upgrade', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  h.git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const checkout = path.join(h.base, 'tool-checkout');
  for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
    fs.cpSync(path.join(ROOT, name), path.join(checkout, name), { recursive: true });
  }
  h.git(['init', '-q', checkout]);
  h.git(['add', '.'], checkout);
  h.git(['commit', '-qm', 'stub tool version'], checkout);
  const toolSha = h.git(['rev-parse', 'HEAD'], checkout);
  const pushed = path.join(h.base, 'pushed.json');
  fs.writeFileSync(path.join(h.base, 'bin', 'git'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'push') {
  fs.writeFileSync(${JSON.stringify(pushed)}, JSON.stringify(args));
  process.exit(0);
}
const r = cp.spawnSync('git', args, { env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} }, stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const upgrade = `
const fs = require('node:fs');
const cp = require('node:child_process');
for (const file of ['lib/shim.js', 'lib/hook-bridge.js', 'bin/tower-crane.js']) {
  fs.writeFileSync(${JSON.stringify(checkout)} + '/' + file, 'throw new Error("upgraded tool cannot read the old policy");\\n');
}
for (const args of [['add', '.'], ['commit', '-qm', 'upgraded stub tool']]) {
  const r = cp.spawnSync('git', ['-C', ${JSON.stringify(checkout)}, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
`;
  const hooks = `
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const toml = require(${JSON.stringify(path.join(ROOT, 'lib', 'toml.js'))});
const config = toml.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'));
const calls = [
  [config.notify[0], [...config.notify.slice(1), JSON.stringify({ 'last-assistant-message': 'survived the upgrade' })], {}],
  [config.hooks.PostToolUse[0].hooks[0].command, [], { shell: true, input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }) }],
];
for (const [command, args, opts] of calls) {
  const r = cp.spawnSync(command, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(r.stderr);
}
`;
  const branch = h.git(['branch', '--show-current'], wt);
  const result = cp.spawnSync(process.execPath, [
    path.join(checkout, 'bin', 'tower-crane.js'), 'spawn', '--task', 'T1', '--wait', '--json',
  ], {
    cwd: h.repo, encoding: 'utf8', timeout: 60000,
    env: { ...u.env, STUB_RUN: JSON.stringify([
      [process.execPath, '-e', upgrade],
      ['git', 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`],
      ['gh', 'pr', 'create'],
      [process.execPath, '-e', hooks],
    ]) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(u.report().ran.map((r) => [r.code, r.stderr]), [[0, ''], [0, ''], [0, ''], [0, '']]);
  const started = JSON.parse(result.stdout);
  assert.equal(started.tool.sha, toolSha);
  assert.notEqual(h.git(['rev-parse', 'HEAD'], checkout), toolSha);
  const home = path.join(h.state, 'homes', started.agent);
  assert.equal(started.tool.path, path.join(home, 'tool'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'tool.json'), 'utf8')), started.tool);
  assert.deepEqual(JSON.parse(fs.readFileSync(pushed, 'utf8')), [
    'push', '--no-follow-tags', '--recurse-submodules=no', '-u', 'origin', `HEAD:refs/heads/${branch}`,
  ]);
  const policy = JSON.parse(fs.readFileSync(path.join(home, 'policy.json'), 'utf8'));
  assert.equal(policy.branch, branch);
  assert.equal(policy.repo, 'acme/app');
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find((e) => e.cmd === 'spawn').detail.tool.sha, toolSha);
  for (const cmd of ['hook git-push', 'hook pr-created', 'hook report']) {
    assert.ok(events.some((e) => e.cmd === cmd && e.agent === started.agent), cmd);
  }
  assert.match(fs.readFileSync(S.progressFile(h.state, started.agent), 'utf8'), /"cmd":"hook progress"/);
});

test('a claude sandboxed worker has policy masks, so its shim plumbs merges of the paths the sandbox masks', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'claude');
  spawn(h, u, 'medium');
  const policy = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'policy.json'), 'utf8'));
  assert.equal(policy.masks, true);
});

test('a codex sandboxed worker has no policy masks: the mask list is claude\'s', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  isolated(h, 'medium', 'codex');
  spawn(h, u, 'medium');
  const policy = JSON.parse(fs.readFileSync(path.join(h.state, 'homes', 'worker-T1-1', 'policy.json'), 'utf8'));
  assert.equal(policy.masks, false);
});

test('the shim migrates a pre-T112 policy using recorded state and refuses unbound migrations', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  isolated(h, 'medium', 'codex');
  spawn(h, u, 'medium');
  h.git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const home = path.join(h.state, 'homes', 'worker-T1-1');
  // Generated by policy() and worker frontmatter at e034a4325677ada9d0752a1acee60483acfd8849, the parent of T112.
  const historical = fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-pre-T112.json'), 'utf8').replace('@HOME@/hook.json', path.join(home, 'hook.json').replaceAll('\\', '\\\\'));
  const policyFile = path.join(home, 'policy.json');
  fs.writeFileSync(policyFile, historical);
  const branch = h.git(['branch', '--show-current'], wt);
  const env = {
    ...u.env, PATH: `${path.join(home, 'bin')}${path.delimiter}${u.env.PATH}`,
    TOWER_CRANE_STATE: h.state, TOWER_CRANE_TASK: 'T1', TOWER_CRANE_AGENT: 'worker-T1-1',
  };
  const run = (args, extra = {}) => cp.spawnSync('git', args, { cwd: wt, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  const allowed = run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(allowed.status, 1, allowed.stderr);
  assert.match(allowed.stderr, /fixture remote unavailable/);
  assert.equal(run(['push', 'origin', 'HEAD:refs/heads/main']).status, 126);
  assert.equal(run(['push', 'origin', `HEAD:refs/heads/${branch}`, '--force']).status, 126);
  assert.equal(run(['push', 'origin', `HEAD:refs/heads/${branch}`], { TOWER_CRANE_AGENT: 'another-worker' }).status, 126);
  assert.equal(fs.readFileSync(policyFile, 'utf8'), historical, 'migration does not write the protected policy');
  const tasks = h.readState('tasks.json');
  const recordedBranch = tasks.tasks[0].branch;
  tasks.tasks[0].branch = null;
  h.writeState('tasks.json', tasks);
  const missing = run(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(missing.status, 126);
  assert.match(missing.stderr, /git push without a task branch/);
  tasks.tasks[0].branch = recordedBranch;
  h.writeState('tasks.json', tasks);
  // init without a GitHub origin or --repo records repo null: only remote pushes lose their binding.
  const project = h.readState('project.json');
  project.repo = null;
  h.writeState('project.json', project);
  const local = path.join(h.base, 'local-T116.git');
  h.git(['init', '-q', '--bare', local]);
  const status = run(['status']);
  assert.equal(status.status, 0, status.stderr);
  const commit = run(['commit', '--allow-empty', '-q', '-m', 'probe']);
  assert.equal(commit.status, 0, commit.stderr);
  const localPush = run(['push', local, 'HEAD:refs/heads/fixture']);
  assert.equal(localPush.status, 0, localPush.stderr);
  const remote = run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  assert.equal(remote.status, 126);
  assert.match(remote.stderr, /git push outside the recorded origin repository/);
  const read = cp.spawnSync('gh', ['pr', 'view'], { cwd: wt, env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(read.status, 126, read.stderr);
  assert.doesNotMatch(read.stderr, /tower-crane:/);
  fs.writeFileSync(policyFile, '{}\n');
  assert.equal(run(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]).status, 126, 'missing permissions default to deny');
  const gh = cp.spawnSync('gh', ['pr', 'create'], { cwd: wt, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(gh.status, 126, gh.stderr);
});

test('git and gh allow git commands, local pushes and the role\'s own writes, and refuse everything else', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const branch = h.git(['branch', '--show-current'], wt);
  const own = `HEAD:refs/heads/${branch}`;
  const local = path.join(h.base, 'local.git');
  h.git(['init', '-q', '--bare', local]);
  // A remote on another machine; nothing listens there, so a push the shim
  // lets through fails in git itself, not with the shim's 126.
  h.git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const NET = 'net';
  const cases = [
    [['git', 'status'], 0, 0],
    [['git', '-C', wt, 'log', '-1'], 0, 0],
    [['git', 'commit', '--allow-empty', '-q', '-m', 'probe'], 0, 0],
    [['git', 'push', local, '+HEAD:refs/heads/fixture'], ALLOW, ALLOW],
    [['git', 'push', '--force', local, 'HEAD:refs/heads/fixture'], 126, 126],
    [['git', 'push', local, ':refs/heads/fixture'], ALLOW, ALLOW],
    [['git', 'push', 'origin', ':refs/heads/gone'], 126, 126],
    [['git', 'push', 'origin', '--delete', 'gone'], 126, 126],
    [['git', 'push', '-d', 'origin', 'gone'], 126, 126],
    [['git', 'push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'], 126, 126],
    // git takes abbreviated options; a push to another machine may use only
    // exact, harmless ones.
    ...['--del', '--pru', '--forc', '--mir', '--all', '--tags', '--no-verify'].map((o) => [['git', 'push', o, 'origin', 'HEAD:refs/heads/x'], 126, 126]),
    [['git', 'push', '-o', 'x', 'origin', 'HEAD:refs/heads/x'], 126, 126],
    [['git', 'push', 'origin', '--del', 'x'], 126, 126],
    [['git', 'push', '-u', 'origin', own], ALLOW, 126],
    [['git', 'push', '--set-upstream', '-q', 'origin', own], ALLOW, 126],
    // Configuration that turns a plain push into a mirror.
    ...['true', 'yes', 'on', '1'].flatMap((v) => [
      [['git', 'config', 'remote.origin.mirror', v], 0, 0],
      [['git', 'push', 'origin', own], 126, 126],
      [['git', 'config', '--unset', 'remote.origin.mirror'], 0, 0],
    ]),
    [['git', 'push', 'origin', own], ALLOW, 126],
    [['git', 'push', 'origin', 'HEAD:refs/heads/forced', '--force'], 126, 126],
    [['git', '-C', wt, 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/forced'], 126, 126],
    [['git', 'push', 'origin', '+HEAD:refs/heads/forced'], 126, 126],
    [['git', '-c', 'alias.p=push', 'p', 'origin', 'HEAD:refs/heads/alias'], 126, 126],
    [['git', 'p'], 126, 126],
    [['gh', 'pr', 'view', '1'], ALLOW, ALLOW],
    [['gh', 'pr', 'create', '--fill'], ALLOW, 126],
    [['gh', '--repo', 'o/r', 'pr', 'merge', '1'], 126, 126],
    [['gh', 'pr', '-R', 'o/r', 'merge', '1'], 126, 126],
    [['gh', 'pr', 'lock', '1'], 126, 126],
    [['gh', 'pr', 'update-branch', '1'], 126, 126],
    [['gh', 'cache', 'delete', 'x'], 126, 126],
    [['gh', 'co', '1'], 126, 126],
  ];
  const decided = decide(h, wt, ['worker', 'small'], branch, cases.map((c) => c[0]));
  for (const [column, job] of [[1, 'worker'], [2, 'small']]) {
    const ran = decided.map((r) => r[column - 1]);
    assert.deepEqual(ran.map((r) => r.code), cases.map((c) => c[column]), `${job}: ${JSON.stringify(ran.map((r) => [r.argv, r.why]))}`);
  }
  // A mirror key with no value, which git reads as true.
  const config = path.join(h.repo, '.git', 'config');
  const before = fs.readFileSync(config, 'utf8');
  fs.appendFileSync(config, '[remote "origin"]\n\tmirror\n');
  assert.deepEqual(decide(h, wt, ['worker'], branch, [['git', 'push', 'origin', 'HEAD:refs/heads/ok']])[0].map((r) => r.code), [126], 'a valueless mirror key');
  fs.writeFileSync(config, before);
  // Each harness and rung reaches git and gh through the shim with its job's
  // policy, and an allowed call runs the real program.
  const probes = [
    [['git', 'status'], 0, 0],
    [['git', 'push', local, '+HEAD:refs/heads/fixture'], 0, 0],
    [['git', 'push', '--force', local, 'HEAD:refs/heads/fixture'], 126, 126],
    [['git', 'push', '-u', 'origin', own], NET, 126],
    [['gh', 'pr', 'view', '1'], 0, 0],
    [['gh', 'pr', 'create', '--fill'], 0, 126],
  ];
  for (const harness of ['claude', 'codex']) {
    for (const [rung, column] of [['hard', 1], ['small', 2]]) {
      isolated(h, rung, harness);
      spawn(h, u, rung, { STUB_RUN: JSON.stringify(probes.map((c) => c[0])) });
      const ran = u.report().ran;
      const codes = ran.map((r, i) => (probes[i][column] === NET && r.code !== 126 && r.code !== 0 ? NET : r.code));
      assert.deepEqual(codes, probes.map((c) => c[column]), `${harness} ${rung}: ${JSON.stringify(ran.map((r) => r.stderr))}`);
    }
  }
});

test('remote pushes publish only the task branch, including configured and implicit destinations', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Publish', '--acceptance', 'only this branch']);
  const { path: wt, branch } = h.json(['worktree', 'T1']);
  const own = `refs/heads/${branch}`;
  h.git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  h.git(['remote', 'add', 'elsewhere', 'https://github.com/acme/app.git']);
  h.git(['config', `branch.${branch}.remote`, 'origin']);
  h.git(['config', `branch.${branch}.merge`, own]);
  const cases = [];
  const push = (args, code) => cases.push([['git', 'push', ...args], code]);
  const config = (key, value) => cases.push([['git', 'config', key, value], 0]);
  const unset = (key) => cases.push([['git', 'config', '--unset-all', key], 0]);
  push(['elsewhere', `HEAD:${own}`], 126);
  push(['https://github.com/acme/app.git', `HEAD:${own}`], 126);
  config('remote.origin.pushurl', 'https://github.com/acme/another.git');
  push(['origin', `HEAD:${own}`], 126);
  unset('remote.origin.pushurl');
  config('remote.origin.pushurl', 'https://github.com/acme/app.git');
  push(['origin', `HEAD:${own}`], ALLOW);
  cases.push([['git', 'config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/another.git'], 0]);
  push(['origin', `HEAD:${own}`], 126);
  unset('remote.origin.pushurl');
  config('remote.origin.url', 'https://github.com/acme/another.git');
  push(['origin', `HEAD:${own}`], 126);
  config('remote.origin.url', 'https://github.com.evil.invalid/acme/app.git');
  push(['origin', `HEAD:${own}`], 126);
  config('remote.origin.url', 'git@github.com:acme/app.git');
  push(['origin', `HEAD:${own}`], ALLOW);
  config('remote.origin.url', 'https://github.com/acme/app.git');
  config('remote.pushDefault', 'elsewhere');
  push([], 126);
  unset('remote.pushDefault');
  config(`branch.${branch}.pushRemote`, 'elsewhere');
  push([], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  unset(`branch.${branch}.pushRemote`);
  config('url.https://github.com/acme/another.git.pushInsteadOf', 'https://github.com/acme/app.git');
  push(['origin', `HEAD:${own}`], 126);
  unset('url.https://github.com/acme/another.git.pushInsteadOf');
  // X1 and X2 reached Git instead of being refused by the shim.
  push(['origin', 'HEAD:main'], 126);
  push(['origin', 'HEAD:refs/tags/v9.9.9'], 126);
  push(['origin', 'HEAD:refs/heads/another-task'], 126);
  push(['origin', `HEAD:${own}`, 'HEAD:main'], 126);
  push(['origin', 'refs/heads/*:refs/heads/*'], 126);
  push(['origin', 'main'], 126);
  cases.push([['git', 'tag', '-f', 'v9.9.9'], 0]);
  push(['origin', 'v9.9.9'], 126);
  push(['origin', ':'], 126);
  for (const ref of ['HEAD', branch, own, `HEAD:${branch}`, `HEAD:${own}`, `main:${own}`]) {
    push(['-u', 'origin', ref], ALLOW);
  }
  push(['origin', `HEAD:${own}`, `${branch}:${own}`], ALLOW);
  push(['origin'], ALLOW);
  push([], ALLOW);
  config('remote.origin.push', 'HEAD:main');
  push(['origin'], 126);
  push([], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  unset('remote.origin.push');
  config('remote.origin.push', `HEAD:${own}`);
  push(['origin'], ALLOW);
  cases.push([['git', 'config', '--add', 'remote.origin.push', 'HEAD:refs/tags/v9.9.9'], 0]);
  push(['origin'], 126);
  unset('remote.origin.push');
  config('push.followTags', 'true');
  push(['origin', `HEAD:${own}`], 126);
  unset('push.followTags');
  config('push.recurseSubmodules', 'on-demand');
  push(['origin', `HEAD:${own}`], 126);
  unset('push.recurseSubmodules');
  cases.push([['git', '--namespace', 'other', 'push', 'origin', `HEAD:${own}`], 126]);
  config(`branch.${branch}.merge`, 'refs/heads/main');
  config('push.default', 'upstream');
  push(['origin'], 126);
  config('push.default', 'current');
  push(['origin'], ALLOW);
  config('push.default', 'matching');
  push(['origin'], 126);
  unset('push.default');
  config(`branch.${branch}.merge`, own);
  cases.push([['git', 'checkout', '-q', '-B', 'another-task'], 0]);
  push(['origin', 'HEAD'], 126);
  push(['origin', `HEAD:${own}`], ALLOW);
  cases.push([['git', 'checkout', '-q', branch], 0]);
  const ran = decide(h, wt, ['worker'], branch, cases.map(([args]) => args)).map(([r]) => r);
  assert.deepEqual(ran.map((r) => r.code), cases.map(([, code]) => code),
    JSON.stringify(ran.map((r) => ({ args: r.argv, code: r.code, why: r.why }))));
  // What the shim hands on names only the task branch as a destination.
  for (const r of ran.filter((x) => x.code === ALLOW)) {
    const words = r.pushArgs.slice(r.pushArgs.indexOf('push') + 1).filter((a) => !a.startsWith('-'));
    assert.ok(words.length > 1 && words.slice(1).every((ref) => ref.endsWith(`:${own}`)), JSON.stringify(r));
  }
});

test('push destinations are qualified with the recorded task branch without shebang harnesses', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/app']);
  h.ok(['task', 'add', '--title', 'Publish', '--acceptance', 'only this branch']);
  const { path: wt, branch } = h.json(['worktree', 'T1']);
  h.git(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const script = `
const { gitDenied } = require(process.argv[1]);
const cp = require('node:child_process');
const branch = process.argv[2];
const policy = { gitPush: 'branch', branch, repo: 'acme/app' };
const probes = ['HEAD:main', 'HEAD:refs/tags/v9.9.9', 'HEAD:' + branch, 'HEAD:refs/heads/' + branch, 'HEAD'];
const results = probes.map(ref => {
  const args = [];
  return { why: gitDenied(['push', 'origin', ref], policy, 'git', args), args };
});
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { gitPush: 'branch' }, 'git') });
results.push({ why: gitDenied(['push', 'elsewhere', 'HEAD'], policy, 'git') });
results.push({ why: gitDenied(['push', 'https://github.com/acme/app.git', 'HEAD'], policy, 'git') });
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { ...policy, repo: 'acme/another' }, 'git') });
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], { gitPush: 'branch', branch }, 'git') });
const changed = cp.spawnSync('git', ['config', 'remote.origin.pushurl', 'https://github.com/acme/another.git']);
if (changed.status !== 0) throw new Error('fixture pushurl could not be configured');
results.push({ why: gitDenied(['push', 'origin', 'HEAD'], policy, 'git') });
process.stdout.write(JSON.stringify(results));
`;
  const result = cp.spawnSync(process.execPath, ['-e', script, path.join(ROOT, 'lib', 'shim.js'), branch],
    { cwd: wt, env: h.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const probes = JSON.parse(result.stdout);
  for (const index of [0, 1, 5, 6, 7, 8, 9, 10]) assert.ok(probes[index].why, `probe ${index} must be refused`);
  for (const index of [2, 3, 4]) {
    assert.equal(probes[index].why, null);
    assert.deepEqual(probes[index].args, ['push', '--no-follow-tags', '--recurse-submodules=no', 'origin', `HEAD:refs/heads/${branch}`]);
  }
});

test('an isolated Codex worker can publish its task branch with an allow rule and guarded git', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const remote = path.join(h.base, 'publish.git');
  h.git(['init', '-q', '--bare', remote]);
  h.git(['remote', 'add', 'origin', remote]);
  const branch = h.git(['branch', '--show-current'], wt);
  isolated(h, 'hard', 'codex');
  spawn(h, u, 'hard', { STUB_RUN: JSON.stringify([
    ['git', 'push', '-u', 'origin', branch],
    ['git', 'push', '--force', 'origin', branch],
  ]) });
  const seen = u.report();
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push"\],\n {4}decision = "allow"/);
  assert.match(seen.rules.join('\n'), /pattern = \["git", "push", "--force"\],\n {4}decision = "forbidden"/);
  assert.deepEqual(seen.ran.map((r) => r.code), [0, 126]);
  assert.equal(h.git(['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), h.git(['rev-parse', 'HEAD'], wt));
  spawn(h, u, 'review');
  assert.doesNotMatch(u.report().rules.join('\n'), /decision = "allow"/);
});

test('the orchestrator can run gh-stack atomic pushes while direct forced pushes and worker stack commands stay refused', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const bin = path.join(h.base, 'bin');
  const git = path.join(bin, 'git');
  const text = fs.readFileSync(git, 'utf8');
  fs.writeFileSync(git, text.replace('const args = process.argv.slice(2);',
    `const args = process.argv.slice(2);
if (args[0] === 'push' && args.includes('--atomic')) process.exit(0);`));
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log('stub-gh-token'); process.exit(0); }
const r = cp.spawnSync('git', ['push', '--atomic', '--force-with-lease', 'origin', 'HEAD:refs/heads/stack'], {stdio: 'inherit'});
process.exit(r.status ?? 1);
`);
  for (const [rung, allowed] of [['orchestrator', true], ['hard', false]]) {
    isolated(h, rung, 'codex');
    spawn(h, u, rung, { STUB_RUN: JSON.stringify([
      ['git', 'push', '--force-with-lease', 'origin', 'HEAD:refs/heads/stack'],
      ['gh', 'stack', 'sync'],
    ]) });
    assert.deepEqual(u.report().ran.map((r) => r.code), [126, allowed ? 0 : 126]);
  }
});

test('an isolated reviewer posts through gh, records evidence in a symlinked state dir and runs a git fixture', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  // The state directory reached through a symlink, as .tower-crane -> .gishra was.
  const realState = path.join(h.base, 'real-state');
  fs.renameSync(h.state, realState);
  fs.symlinkSync(realState, h.state);
  releaseExited(h);
  h.ok(['task', 'update', 'T1', '--kind', 'docs']);
  for (const name of ['easy', 'medium', 'hard', 'research']) {
    h.ok(['ladder', 'set', name, '--model', 'builder', '--clear', 'profile']);
  }
  h.ok(['claim', 'T1', '--agent', 'worker-T1-1']);
  h.ok(['submit', 'T1', '--sha', h.git(['rev-parse', 'HEAD']), '--agent', 'worker-T1-1']);
  const fixture = path.join(h.base, 'fixture');
  const run = [
    ['gh', 'pr', 'comment', '1', '--body', 'Review (tower-crane, clean context)'],
    [process.execPath, BIN, 'evidence', 'T1', '--type', 'review', '--ok', '--sha', '50b732a15be40ccb2065cb2ba0e7b366d511b736', '--revision', '1', '--summary', 'nothing blocks'],
    ['git', 'init', '-q', fixture],
    ['git', '-C', fixture, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'fixture'],
    ['git', 'init', '-q', '--bare', `${fixture}.git`],
    ['git', '-C', fixture, 'push', `${fixture}.git`, 'HEAD:refs/heads/main'],
  ];
  const real = fs.realpathSync(realState);
  for (const harness of ['claude', 'codex']) {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(`${fixture}.git`, { recursive: true, force: true });
    isolated(h, 'medium', harness);
    const dry = h.json(['spawn', '--role', 'review', '--task', 'T1', '--dry-run'], { env: u.env });
    assert.ok(!JSON.stringify(dry).includes('stub-gh-token'), 'the token is not in the command or its shown env');
    spawn(h, u, 'review', { STUB_RUN: JSON.stringify(run) });
    const seen = u.report();
    assert.deepEqual(seen.ran.map((r) => r.code), run.map(() => 0), `${harness}: ${JSON.stringify(seen.ran.map((r) => r.stderr))}`);
    if (harness === 'claude') assert.ok(seen.settings.sandbox.filesystem.denyWrite.includes(real), 'claude reads the real state dir only');
    else assert.equal(seen.config.permissions['tower-crane'].filesystem[real], 'read', 'codex reads the real state dir only');
  }
  const reviews = h.json(['task', 'show', 'T1']).evidence.filter((e) => e.type === 'review');
  assert.deepEqual(reviews.map((e) => [e.agent, e.via]), [['reviewer-T1-1', 'broker'], ['reviewer-T1-2', 'broker']], 'the broker recorded each as the reviewer it started');
  for (const f of walk(realState)) assert.ok(!fs.readFileSync(f, 'utf8').includes('stub-gh-token'), `${f} holds the gh token`);
});

test('a sandboxed agent changes the state only through its spawn\'s broker: as itself, on its own task, with its role\'s commands', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  h.ok(['task', 'add', '--title', 'Other', '--acceptance', 'untouched']);
  const tests = h.readState('project.json').tests;
  const fixture = path.join(h.base, 'fixture-state');
  const cli = (...args) => [process.execPath, BIN, ...args];
  const envOwner = [
    process.execPath, '-e',
    `const cp=require("node:child_process");const r=cp.spawnSync(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'as env owner'])},{env:{...process.env,TOWER_CRANE_AGENT:'owner'},encoding:'utf8'});process.stderr.write(r.stderr||'');process.exit(r.status??1);`,
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
    [[process.execPath, '-e', `require("child_process").execFileSync(process.execPath, [${JSON.stringify(BIN)}, "hook", "report", "--binding", require("path").join(process.env.TOWER_CRANE_STATE, "homes", process.env.TOWER_CRANE_AGENT, "hook.json"), "--payload", "-"], { input: JSON.stringify({ report: "hooked" }), stdio: ["pipe", "ignore", "inherit"] })`], 0],
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
  const events = fs.readFileSync(path.join(h.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.filter((e) => e.via === 'broker').map((e) => [e.cmd, e.agent, e.task]),
    [...noted.flatMap((a) => [['task note', a, 'T1'], ['hook report', a, 'T1'], ['task note', a, 'T1']]), ['claim', worker, 'T1']], 'only brokered changes, each as its agent');
  assert.deepEqual(events.filter((e) => e.via === 'automation' && ['hook stop', 'msg'].includes(e.cmd))
    .map((e) => [e.cmd, e.agent, e.task]), [...noted, worker].flatMap((agent) =>
      [['hook stop', agent, 'T1'], ['msg', agent, 'T1']]), 'supervisor notifications retain their engine provenance and agent');
  assert.deepEqual(events.filter((e) => e.cmd === 'hook report').map((e) => e.detail.report), noted.map(() => 'hooked'), 'the hook payload came through stdin');
});

test('a brokered command still running when its agent exits is killed, and spawn --wait returns', { skip: NO_STUBS, timeout: 120000 }, async (t) => {
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
    const background = `const cp=require("child_process"),f=require("fs");cp.spawn(process.execPath,${JSON.stringify([BIN, 'task', 'note', 'T1', 'late'])},{detached:true,stdio:"ignore"}).unref();const end=Date.now()+30000;while(!f.existsSync(${JSON.stringify(pidFile)})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)`;
    let pid = null;
    t.after(() => {
      if (pid && detachedAlive({ pid })) process.kill(pid, 'SIGKILL');
    });
    isolated(h, 'hard', harness);
    const run = [[process.execPath, BIN, 'task', 'note', 'T1', 'early'], [process.execPath, '-e', background]];
    const env = { ...u.env, STUB_RUN: JSON.stringify(run), NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, SLOW_BROKER_PID: pidFile };
    const started = Date.now();
    releaseExited(h);
    const r = await h.runAsync(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - started < 60000, `${harness}: spawn --wait returned`);
    assert.deepEqual(u.report().ran.map((x) => x.code), [0, 0], JSON.stringify(u.report().ran.map((x) => x.stderr)));
    assert.ok(fs.existsSync(pidFile), `${harness}: the broker ran the late note`);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 10000;
    while (detachedAlive({ pid }) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
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

test('a gh token in the spawning environment passes through, and the keyring is asked only without one', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'medium', harness);
    spawn(h, u, 'review');
    assert.equal(u.report().ghToken, 'stub-gh-token', `${harness}: the keyring's token`);
    spawn(h, u, 'review', { GH_TOKEN: 'spawner-token' });
    assert.equal(u.report().ghToken, 'spawner-token', `${harness}: the spawner's own token`);
    spawn(h, u, 'review', { GITHUB_TOKEN: 'spawner-github-token' });
    assert.equal(u.report().ghToken, null, `${harness}: GITHUB_TOKEN is left for gh to read`);
  }
});

test('sandboxed gh uses its handed token when the user selects a custom config directory', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const custom = path.join(u.home, 'custom-config');
  fs.mkdirSync(path.join(custom, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const path = require('node:path');
const env = process.env;
const config = env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME, '.config'), 'gh');
if (process.argv[2] === 'auth' && process.argv[3] === 'token') {
  if (!config.startsWith(${JSON.stringify(custom)} + path.sep)) process.exit(1);
  console.log('stub-gh-token');
} else {
  if (config.startsWith(${JSON.stringify(custom)} + path.sep)) {
    process.stderr.write('permission denied reading gh config');
    process.exit(1);
  }
  if (env.GH_TOKEN !== 'stub-gh-token') process.exit(1);
  if (config !== path.join(env.HOME, '.config', 'gh')) process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const customEnv of [{ GH_CONFIG_DIR: path.join(custom, 'gh'), XDG_CONFIG_HOME: '' }, { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: custom }]) {
      spawn(h, u, 'hard', { ...customEnv, STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]) });
      const seen = u.report();
      assert.equal(seen.ran[0].code, 0, `${harness}: ${seen.ran[0].stderr}`);
      assert.equal(seen.ghToken, 'stub-gh-token', 'the parent reads the token from the original config');
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
  const pi = h.run(['ladder', 'set', 'small', '--harness', 'pi', '--model', 'x', '--clear', 'profile']);
  assert.equal(pi.code, 1);
  assert.match(pi.stderr, /MCP opt-ins are unsupported on pi/);
  assert.match(pi.stderr, /pi tools must be built-ins/);
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
});
