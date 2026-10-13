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
  // An installed codex also loads the generated home with the spawn's -c
  // overrides, so a field it refuses fails here instead of at dispatch.
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
    assert.deepEqual(allowRead, [ownHome, path.join(h.state, 'brokers', path.basename(ownHome))]);
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
    delete rules[broker];
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
  assert.deepEqual(Object.keys(seen.settings.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
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
  assert.deepEqual(box.filesystem.denyWrite, [h.state, wt], 'the state is read-only');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'homes')), 'other agent homes are hidden, including future spawns');
  assert.ok(box.filesystem.denyRead.includes(path.join(h.state, 'brokers')), 'no agent reads another agent\'s broker token');
  assert.ok(box.filesystem.denyRead.includes(path.join(path.dirname(h.userConfig), 'owner')), 'no agent reads the owner key');
  assert.deepEqual(box.filesystem.allowRead, [home, path.join(h.state, 'brokers', started.agent)], 'only this dispatch home and its own broker directory are readable');
  for (const p of ['/var/run/docker.sock', '/run/docker.sock', path.join(u.home, '.ssh'), path.join(u.home, '.aws')]) assert.equal(box.filesystem.denyRead.includes(p), fs.existsSync(p), p);
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

test('sandbox cleanup preserves and reports a pre-existing empty read-only file with a placeholder name', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const { global } = isolateGitEnvironment(h, u);
  isolated(h, 'small', 'claude');
  fs.rmSync(path.join(wt, '.claude', 'settings.local.json'));
  const realFile = path.join(wt, '.bash_profile');
  fs.writeFileSync(realFile, '');
  fs.chmodSync(realFile, 0o444);
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
  assert.deepEqual(seen.placeholderGitStatus, { code: 0, stdout: '?? .bash_profile\n', stderr: '' });
  assert.equal(fs.existsSync(realFile), true, 'the existing file remains');
  assert.equal(fs.statSync(realFile).size, 0, 'the existing file stays empty');
  assert.equal(fs.statSync(realFile).mode & 0o222, 0, 'the existing file keeps its read-only mode');
  for (const relative of CLAUDE_SANDBOX_PLACEHOLDERS.filter((name) => name !== '.bash_profile' && name !== TRACKED_SETTINGS)) {
    assert.equal(fs.existsSync(path.join(wt, relative)), false, `${relative} placeholder is removed`);
  }
  assert.equal(status(started.cwd), '?? .bash_profile');
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
        assert.equal(seen.config.permissions['tower-crane'].filesystem[ownerDir], 'none');
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
  assert.equal(fs.readlinkSync(path.join(home, 'home', '.gitconfig')), path.join(u.home, '.gitconfig'), 'git config is linked into its HOME');
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

test('claude and codex sandboxes hide the user\'s credential stores and keep the agent\'s home, house rules and gh token', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const stores = ['.config/gh/hosts.yml', '.claude/.credentials.json', '.claude/settings.json', '.claude.json', '.codex/auth.json',
    '.codex/.env', '.codex/config.toml', '.docker/config.json', '.npmrc', '.pypirc', '.config/pip/pip.conf', '.pip/pip.conf',
    '.cargo/credentials', '.cargo/credentials.toml', '.netrc',
    '.git-credentials', '.config/git/credentials', '.kube/config', '.config/gcloud/credentials.db', '.azure/msal_token_cache.json',
    '.ssh/id_ed25519', '.aws/credentials'].map((p) => path.join(u.home, p));
  for (const f of stores.filter((f) => !fs.existsSync(f))) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${SECRET}-STORE\n`);
  }
  const under = (p, dirs) => dirs.some((d) => p === d || p.startsWith(d + path.sep));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const started = spawn(h, u, 'hard');
    const seen = u.report();
    const home = path.join(h.state, 'homes', started.agent);
    // The house rules files the prompt names, ~/.claude/CLAUDE.md or
    // ~/.codex/AGENTS.md, stay readable inside their hidden store.
    const rules = path.join(u.home, harness === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md');
    let hidden;
    if (harness === 'claude') {
      const box = seen.settings.sandbox.filesystem;
      // Read, Grep and Glob ignore the sandbox and obey Read deny rules.
      const reads = seen.settings.permissions.deny.filter((r) => r.startsWith('Read(//')).map((r) => r.slice(6, -1).replace(/\/\*\*$/, ''));
      hidden = (p) => under(p, box.denyRead) && !under(p, box.allowRead) && under(p, reads);
      assert.ok(under(path.join(home, 'home'), box.allowRead), 'claude: its own home is reopened');
      assert.ok(under(path.join(home, 'home'), reads), 'claude: file tools deny homes while Bash reopens its own');
    } else {
      const fsRules = seen.config.permissions['tower-crane'].filesystem;
      const none = Object.keys(fsRules).filter((k) => fsRules[k] === 'none');
      const write = Object.keys(fsRules).filter((k) => fsRules[k] === 'write');
      // A writable rule under a hidden directory is the only way back in.
      hidden = (p) => none.some((d) => under(p, [d]) && !write.some((w) => w.startsWith(d + path.sep) && under(p, [w])));
      assert.equal(fsRules[home], 'read', 'codex: its own home is readable');
    }
    for (const f of stores) assert.ok(hidden(f), `${harness}: ${path.relative(u.home, f)} is hidden`);
    for (const p of [rules, path.join(home, 'home', '.gitconfig'), path.join(h.state, 'brokers', started.agent, 'broker.json')]) {
      assert.ok(!hidden(p), `${harness}: ${p} stays readable`);
    }
    assert.equal(seen.ghToken, 'stub-gh-token', `${harness}: gh gets its token`);
    assert.ok(!fs.existsSync(path.join(home, 'home', '.config', 'gh')), `${harness}: gh reads GH_TOKEN, not a config it may not read`);
    assert.equal(fs.readlinkSync(path.join(home, 'home', '.gitconfig')), path.join(u.home, '.gitconfig'));
  }
});

function assertCredentialsHidden(seen, files) {
  const under = (file, directory) => file === directory || file.startsWith(directory + path.sep);
  const hidden = file => {
    if (seen.harness === 'claude') {
      const box = seen.settings.sandbox.filesystem;
      return box.denyRead.some(dir => under(file, dir)
        && ['Read', 'Grep', 'Glob'].every(tool =>
          seen.settings.permissions.deny.includes(`${tool}(/${dir})`)
          && seen.settings.permissions.deny.includes(`${tool}(/${dir}/**)`)))
        && !box.allowRead.some(dir => under(file, dir));
    }
    const rules = seen.config.permissions['tower-crane'].filesystem;
    return Object.keys(rules).some(dir => rules[dir] === 'none' && under(file, dir)
      && !Object.keys(rules).some(write => rules[write] === 'write' && under(write, dir) && under(file, write)));
  };
  assert.deepEqual(files.flatMap(file => [path.resolve(file), fs.realpathSync(file)]).filter(file => !hidden(file)), [],
    `${seen.harness}: credential paths must be denied by the sandbox and file tools`);
}

test('codex never names a hidden path inside another hidden directory', { skip: NO_STUBS }, t => {
  // Seen 2026-10-12: ~/.claude/debug/latest links to a file in the same hidden
  // store, and Codex's bwrap could not mount over it inside the masked parent.
  const { h, u } = setup(t);
  const debug = path.join(u.home, '.claude', 'debug');
  fs.mkdirSync(debug, { recursive: true });
  fs.writeFileSync(path.join(debug, 'session.txt'), 'log\n');
  fs.symlinkSync(path.join(debug, 'session.txt'), path.join(debug, 'latest'));
  isolated(h, 'medium', 'codex');
  const started = spawn(h, u, 'medium');
  const config = TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'config.toml'), 'utf8'));
  const rules = config.permissions['tower-crane'].filesystem;
  const hidden = Object.keys(rules).filter(p => rules[p] === 'none');
  assert.ok(hidden.includes(fs.realpathSync(path.join(u.home, '.claude'))), 'the store itself stays hidden');
  const nested = hidden.filter(p => hidden.some(dir => p !== dir && p.startsWith(dir + path.sep)));
  assert.deepEqual(nested, [], 'no hidden path is named inside a hidden directory');
});

test('a hidden store link to the harness program leaves it runnable; other programs stay hidden', { skip: NO_STUBS }, t => {
  // Seen 2026-10-12: ~/.codex/tmp/arg0/*/codex-linux-sandbox links to the codex
  // binary, and hiding that target stopped every Codex worker from starting.
  const { h, u, wt } = setup(t);
  const codex = require(path.join(ROOT, 'lib', 'spawn')).findExecutable('codex', wt, true, u.env);
  assert.ok(codex, 'the codex stub is on PATH');
  const helper = path.join(h.base, 'dotfiles', 'api-key-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, '#!/bin/sh\necho LINKED-SECRET\n', { mode: 0o755 });
  const arg0 = path.join(u.home, '.codex', 'tmp', 'arg0', 'codex-arg0X');
  fs.mkdirSync(arg0, { recursive: true });
  fs.symlinkSync(codex, path.join(arg0, 'codex-linux-sandbox'));
  fs.symlinkSync(helper, path.join(arg0, 'helper'));
  // A wrapper on PATH can hide the install; the codex package's binary still counts.
  const vendored = path.join(h.base, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'codex');
  fs.mkdirSync(path.dirname(vendored), { recursive: true });
  fs.writeFileSync(vendored, '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(vendored, path.join(arg0, 'codex-execve-wrapper'));
  // A store split by a kept rule file hides its children one by one.
  const direct = path.join(u.home, '.claude', 'codex-link');
  fs.symlinkSync(codex, direct);
  isolated(h, 'medium', 'codex');
  const started = spawn(h, u, 'medium');
  const config = TOML.parse(fs.readFileSync(path.join(h.state, 'homes', started.agent, 'config.toml'), 'utf8'));
  const rules = config.permissions['tower-crane'].filesystem;
  assert.notEqual(rules[fs.realpathSync(codex)], 'none', 'the harness program stays runnable');
  assert.notEqual(rules[fs.realpathSync(vendored)], 'none', 'the codex package binary stays runnable');
  assert.equal(rules[fs.realpathSync(helper)], 'none', 'a script that prints a secret stays hidden');
  assert.equal(rules[direct], undefined, 'a harness link directly in a store is not masked');
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

test('credential symlinks hide their targets and cannot import them into startup', { skip: NO_STUBS }, t => {
  const { h, u, wt } = setup(t);
  const outside = path.join(h.base, 'outside-credentials');
  fs.mkdirSync(path.join(outside, 'directory'), { recursive: true });
  const links = ['.claude/.credentials.json', '.codex/auth.json', '.docker/nested/token'];
  const files = [];
  for (const [index, name] of links.entries()) {
    const target = path.join(outside, `credential-${index}.json`);
    const link = path.join(u.home, name);
    fs.writeFileSync(target, '{"token":"LINKED-CREDENTIAL"}\n');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(target, link);
    files.push(link, target);
  }
  const nested = path.join(outside, 'nested-token');
  fs.writeFileSync(nested, 'LINKED-CREDENTIAL\n');
  fs.symlinkSync(nested, path.join(outside, 'directory', 'token'));
  fs.symlinkSync(path.join(outside, 'directory'), path.join(u.home, '.docker', 'directory'));
  fs.symlinkSync(path.join(u.home, '.docker'), path.join(u.home, '.docker', 'cycle'));
  files.push(nested, path.join(u.home, '.docker', 'directory', 'token'));
  fs.mkdirSync(path.join(outside, 'alias-parent'));
  fs.mkdirSync(path.join(outside, 'relative-store'));
  const relativeToken = path.join(outside, 'relative-token');
  fs.writeFileSync(relativeToken, 'LINKED-CREDENTIAL\n');
  fs.symlinkSync('../relative-token', path.join(outside, 'relative-store', 'token'));
  fs.symlinkSync('../relative-store', path.join(outside, 'alias-parent', 'store'));
  const parentLink = path.join(u.home, 'linked-parent');
  fs.symlinkSync(path.join(outside, 'alias-parent'), parentLink);
  const dockerConfig = path.join(parentLink, 'store');
  files.push(relativeToken, path.join(dockerConfig, 'token'));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    const env = { ...u.env, DOCKER_CONFIG: dockerConfig };
    spawn(h, u, 'hard', { ...env, STUB_READ: JSON.stringify(files) });
    const seen = u.report();
    assertCredentialsHidden(seen, files);
    if (harness === 'claude') assert.ok(seen.reads.every(read => read.denied), 'file tools refuse aliases and targets');
    fs.rmSync(u.out);
    for (const file of files) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${file}\n`);
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait'], { env });
      assert.notEqual(refused.code, 0, `${harness}: credential import ${file} must fail`);
      assert.match(refused.stderr, /house rule.*credential store/i);
      assert.ok(!fs.existsSync(u.out), 'refuse before loading a credential into the harness');
      assert.doesNotMatch(refused.stdout + refused.stderr, /LINKED-CREDENTIAL/);
    }
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }
});

test('credential settings overlays retain every original credential location', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  const locations = label => {
    const root = path.join(h.base, label);
    const env = {
      DOCKER_CONFIG: path.join(root, 'docker'), GH_CONFIG_DIR: path.join(root, 'gh'),
      CARGO_HOME: path.join(root, 'cargo'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
      CLOUDSDK_CONFIG: path.join(root, 'gcloud'), AZURE_CONFIG_DIR: path.join(root, 'azure'),
      NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'), PIP_CONFIG_FILE: path.join(root, 'pip.conf'),
      AWS_SHARED_CREDENTIALS_FILE: path.join(root, 'aws'), KUBECONFIG: [path.join(root, 'kube-1'), path.join(root, 'kube-2')].join(path.delimiter),
    };
    const files = ['docker/config.json', 'gh/hosts.yml', 'cargo/credentials.toml', 'xdg/git/credentials',
      'gcloud/credentials.db', 'azure/token.json', 'npmrc', 'pip.conf', 'aws', 'kube-1', 'kube-2'].map(file => path.join(root, file));
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'LAYER-CREDENTIAL\n');
    }
    return { env, files };
  };
  const original = locations('original'), project = locations('project'), file = locations('file'),
    rung = locations('rung'), fallback = locations('fallback');
  const envFile = path.join(h.base, 'credential-layers.env');
  fs.writeFileSync(envFile, Object.entries(file.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
  h.ok(['project', 'set', '--env', JSON.stringify(project.env), '--env_file', envFile]);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung.env)]);
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { hard: { fallbacks: [{
      harness, model: 'second', env: fallback.env,
    }] } } }));
    spawn(h, u, 'hard', original.env);
    assertCredentialsHidden(u.report(), [original, project, file, rung, fallback].flatMap(layer => layer.files));
  }
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

for (const source of ['claude', 'codex']) {
  test(`${source} harness configuration credential paths remain denied`, { skip: NO_STUBS }, t => {
    const { h, u, wt } = setup(t);
    const root = path.join(h.base, `${source}-provider-files`);
    fs.mkdirSync(root);
    const files = ['credentials', 'config', 'previous-config'].map(file => path.join(root, file));
    for (const file of files) fs.writeFileSync(file, '[default]\nregion = us-east-1\n');
    if (source === 'claude') {
      const config = path.join(u.home, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(config, 'utf8'));
      Object.assign(settings.env, { AWS_SHARED_CREDENTIALS_FILE: files[0], AWS_CONFIG_FILE: files[1] });
      fs.writeFileSync(config, JSON.stringify(settings));
    } else {
      fs.writeFileSync(path.join(u.home, '.codex', '.env'), [
        `PROVIDER_FILES=${JSON.stringify(root)}`,
        'export AWS_SHARED_CREDENTIALS_FILE="${PROVIDER_FILES}/credentials" # provider file',
        `AWS_CONFIG_FILE='${files[2]}'`,
        `AWS_CONFIG_FILE="${files[1]}"`,
        'PROVIDER_TOKEN=HARNESS-ENV-SECRET',
        '',
      ].join('\n'));
    }
    // Both sandboxes protect every user harness's stores.
    for (const harness of ['claude', 'codex']) {
      isolated(h, 'hard', harness);
      spawn(h, u, 'hard', { STUB_READ: JSON.stringify(source === 'claude' ? files.slice(0, 2) : files) });
      const seen = u.report();
      assertCredentialsHidden(seen, source === 'claude' ? files.slice(0, 2) : files);
      if (harness === 'claude') assert.ok(seen.reads.every(read => read.denied));
      for (const file of walk(h.state)) assert.ok(!fs.readFileSync(file, 'utf8').includes('HARNESS-ENV-SECRET'), 'dotenv secrets are not copied');
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${files[0]}\n`);
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: u.env });
      assert.notEqual(refused.code, 0, 'harness-config credential imports refuse startup');
      assert.match(refused.stderr, /house rule.*credential store/i);
      fs.rmSync(path.join(wt, 'AGENTS.md'));
    }
  });
}

test('resolved Bedrock credential paths are denied at their delivered locations', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  const root = path.join(h.base, 'resolved-provider');
  fs.mkdirSync(root);
  const credentials = path.join(root, 'credentials'), config = path.join(root, 'config');
  fs.writeFileSync(credentials, '[default]\naws_access_key_id = synthetic\n');
  fs.writeFileSync(config, '[default]\nregion = us-east-1\n');
  isolated(h, 'hard', 'claude');
  h.ok(['ladder', 'set', 'hard', '--provider', 'bedrock']);
  spawn(h, u, 'hard', {
    AWS_SHARED_CREDENTIALS_FILE: path.relative(h.repo, credentials),
    AWS_CONFIG_FILE: path.relative(h.repo, config),
    STUB_RUN: JSON.stringify([[process.execPath, '-e',
      'process.stderr.write(JSON.stringify([process.env.AWS_SHARED_CREDENTIALS_FILE, process.env.AWS_CONFIG_FILE]))']]),
  });
  const seen = u.report();
  assert.deepEqual(JSON.parse(seen.ran[0].stderr), [credentials, config]);
  assertCredentialsHidden(seen, [credentials, config]);
});

test('parent-relative credential stores stay hidden on initial and fallback launches', { skip: NO_STUBS }, t => {
  const { h, u, wt } = setup(t);
  const caller = path.join(h.repo, 'caller');
  const reports = path.join(h.base, 'relative-stores.jsonl');
  fs.mkdirSync(caller);
  const files = [caller, wt].flatMap(root => ['relative-gh/hosts.yml', 'relative-docker/config.json', 'relative-aws', 'kube-a', 'kube-b']
    .map(file => path.join(root, file)));
  // Relative harness homes name the caller's stores, and so do the
  // credential paths their settings.json and .env select.
  const harnessFiles = ['custom-claude/.credentials.json', 'custom-codex/auth.json'].map(file => path.join(caller, file));
  const selectedFiles = ['claude-settings-docker/config.json', 'codex-env-aws'].map(file => path.join(h.base, file));
  files.push(...harnessFiles, ...selectedFiles);
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'SYNTHETIC-PARENT-STORE\n');
  }
  fs.writeFileSync(path.join(caller, 'custom-claude', 'settings.json'),
    JSON.stringify({ env: { DOCKER_CONFIG: path.dirname(selectedFiles[0]) } }));
  fs.writeFileSync(path.join(caller, 'custom-codex', '.env'), `AWS_SHARED_CREDENTIALS_FILE=${selectedFiles[1]}\n`);
  fs.writeFileSync(path.join(h.base, 'bin', 'gh'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] === 'auth') {
  if (fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, 'hosts.yml'), 'utf8') !== 'SYNTHETIC-PARENT-STORE\\n') process.exit(1);
  console.log('stub-gh-token');
} else if (process.env.GH_TOKEN !== 'stub-gh-token' || process.env.GH_CONFIG_DIR !== path.join(process.env.HOME, '.config', 'gh')) {
  process.exit(1);
}
`);
  for (const harness of ['claude', 'codex']) fs.writeFileSync(path.join(h.base, 'bin', harness), `#!${process.execPath}
const fs = require('node:fs');
require(${JSON.stringify(STUB)})(${JSON.stringify(harness)});
fs.appendFileSync(${JSON.stringify(reports)}, fs.readFileSync(process.env.STUB_OUT, 'utf8') + '\\n');
if (process.env.STUB_FAIL_HARNESS === ${JSON.stringify(harness)}) {
  console.error('HTTP 503 service unavailable'); process.exit(1);
}
`);
  for (const primary of ['claude', 'codex']) {
    const fallback = primary === 'claude' ? 'codex' : 'claude';
    isolated(h, 'hard', primary);
    h.ok(['ladder', 'set', 'hard', '--supervision', '{"retries":0,"backoff_ms":10,"max_backoff_ms":10}']);
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { hard: { fallbacks: [{ harness: fallback, model: 'second' }] } } }));
    fs.rmSync(reports, { force: true });
    spawn(h, u, 'hard', {
      GH_CONFIG_DIR: 'relative-gh', DOCKER_CONFIG: 'relative-docker', AWS_SHARED_CREDENTIALS_FILE: 'relative-aws',
      KUBECONFIG: ['kube-a', 'kube-b'].join(path.delimiter), STUB_FAIL_HARNESS: primary,
      CLAUDE_CONFIG_DIR: 'custom-claude', CODEX_HOME: 'custom-codex',
      STUB_RUN: JSON.stringify([['gh', 'pr', 'view', '1']]),
    }, { cwd: caller });
    const seen = fs.readFileSync(reports, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(seen.map(report => report.harness), [primary, fallback]);
    for (const report of seen) {
      assert.equal(report.ghToken, 'stub-gh-token', 'the parent token lookup succeeded');
      assert.equal(report.ran[0].code, 0, 'the handed token works');
      assertCredentialsHidden(report, files);
    }
  }
});

test('every configured env_file keeps its credential paths hidden on initial and fallback launches', { skip: NO_STUBS }, t => {
  const { h, u } = setup(t);
  const reports = path.join(h.base, 'route-env-files.jsonl');
  // The rung and the fallback route each override the project file, so
  // no launch selects it; it still names a store the user configured.
  const files = ['project', 'primary', 'route'].map(label => path.join(h.base, `${label}-aws-creds`));
  for (const [index, file] of files.entries()) {
    fs.writeFileSync(file, '[default]\naws_access_key_id = synthetic\n');
    fs.writeFileSync(path.join(h.base, `${['project', 'primary', 'route'][index]}.env`), `AWS_SHARED_CREDENTIALS_FILE=${JSON.stringify(file)}\n`);
  }
  for (const harness of ['claude', 'codex']) fs.writeFileSync(path.join(h.base, 'bin', harness), `#!${process.execPath}
const fs = require('node:fs');
require(${JSON.stringify(STUB)})(${JSON.stringify(harness)});
fs.appendFileSync(${JSON.stringify(reports)}, fs.readFileSync(process.env.STUB_OUT, 'utf8') + '\\n');
if (process.env.STUB_FAIL_HARNESS === ${JSON.stringify(harness)}) {
  console.error('HTTP 503 service unavailable'); process.exit(1);
}
`);
  h.ok(['project', 'set', '--env_file', path.join(h.base, 'project.env')]);
  for (const primary of ['claude', 'codex']) {
    const fallback = primary === 'claude' ? 'codex' : 'claude';
    isolated(h, 'hard', primary);
    h.ok(['ladder', 'set', 'hard', '--env_file', path.join(h.base, 'primary.env'),
      '--supervision', '{"retries":0,"backoff_ms":10,"max_backoff_ms":10}']);
    fs.mkdirSync(path.dirname(h.userConfig), { recursive: true });
    fs.writeFileSync(h.userConfig, JSON.stringify({ ladder: { hard: { fallbacks: [{
      harness: fallback, model: 'second', env_file: path.join(h.base, 'route.env'),
    }] } } }));
    fs.rmSync(reports, { force: true });
    spawn(h, u, 'hard', { STUB_FAIL_HARNESS: primary });
    const seen = fs.readFileSync(reports, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(seen.map(report => report.harness), [primary, fallback]);
    for (const report of seen) assertCredentialsHidden(report, files);
  }
});

test('Google credential file overrides stay hidden across environment sources', { skip: NO_STUBS }, t => {
  const { h, u, wt } = setup(t);
  const sources = ['inherited', 'project', 'rung', 'file', 'claude', 'codex'].map(label => {
    const env = Object.fromEntries(['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE'].map(key => {
      const file = path.join(h.base, `${label}-${key}.json`);
      fs.writeFileSync(file, '{"type":"service_account","private_key":"SYNTHETIC-GOOGLE-KEY"}\n');
      return [key, file];
    }));
    return env;
  });
  const [inherited, project, rung, file, claude, codex] = sources;
  const envFile = path.join(h.base, 'google.env');
  const text = env => Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  fs.writeFileSync(envFile, text(file));
  fs.writeFileSync(path.join(u.home, '.codex', '.env'), text(codex));
  const settingsFile = path.join(u.home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings.env, claude);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  h.ok(['project', 'set', '--env', JSON.stringify(project), '--env_file', envFile]);
  const files = sources.flatMap(env => Object.values(env));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung)]);
    spawn(h, u, 'hard', { ...inherited, STUB_READ: JSON.stringify(files) });
    assertCredentialsHidden(u.report(), files);
    if (harness === 'claude') assert.ok(u.report().reads.every(read => read.denied));
    for (const credential of Object.values(inherited)) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${credential}\n`);
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: { ...u.env, ...inherited } });
      assert.notEqual(refused.code, 0, 'Google credential imports must be refused');
      assert.match(refused.stderr, /house rule.*credential store/i);
    }
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }
});

test('OpenCode credential files stay hidden at default and selected data homes', { skip: NO_STUBS }, async t => {
  const { h, u, wt } = setup(t);
  const names = ['auth.json', 'mcp-auth.json'];
  const files = [];
  const put = root => {
    const dir = path.join(root, 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, '{"token":"SYNTHETIC-OPENCODE-CREDENTIAL"}\n');
      files.push(file);
    }
  };
  put(path.join(u.home, '.local', 'share'));
  const sources = ['inherited', 'project', 'rung', 'file', 'claude', 'codex'].map(label => {
    const root = label === 'inherited' ? 'owner-data'
      : label === 'project' ? '~/project-data' : path.join(h.base, `${label}-data`);
    for (const dir of new Set([path.resolve(h.repo, root), path.resolve(wt, root)])) put(dir);
    if (root.startsWith('~/')) put(path.join(u.home, root.slice(2)));
    return { XDG_DATA_HOME: root };
  });
  const [inherited, project, rung, file, claude, codex] = sources;
  // A selected directory alias must protect the real files as well.
  const alias = path.join(h.base, 'data-alias');
  fs.symlinkSync(rung.XDG_DATA_HOME, alias, 'dir');
  rung.XDG_DATA_HOME = alias;
  files.push(...names.map(name => path.join(alias, 'opencode', name)));
  const text = env => `XDG_DATA_HOME=${JSON.stringify(env.XDG_DATA_HOME)}\n`;
  const envFile = path.join(h.base, 'opencode-sources.env');
  fs.writeFileSync(envFile, text(file));
  fs.writeFileSync(path.join(u.home, '.codex', '.env'), text(codex));
  const settingsFile = path.join(u.home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings.env, claude);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  h.ok(['project', 'set', '--env', JSON.stringify(project), '--env_file', envFile]);
  for (const harness of ['claude', 'codex']) await t.test(harness, () => {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung)]);
    spawn(h, u, 'hard', { ...inherited, STUB_READ: JSON.stringify(files) });
    assertCredentialsHidden(u.report(), files);
    if (harness === 'claude') assert.ok(u.report().reads.every(read => read.denied));
    for (const credential of [files[0], path.join(h.repo, 'owner-data', 'opencode', 'auth.json'),
      path.join(wt, '~', 'project-data', 'opencode', 'mcp-auth.json')]) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${credential}\n`);
      try {
        const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: { ...u.env, ...inherited } });
        assert.notEqual(refused.code, 0, 'OpenCode credential imports must be refused');
        assert.match(refused.stderr, /house rule.*credential store/i);
      } finally { fs.rmSync(path.join(wt, 'AGENTS.md')); }
    }
  });
});

test('harness token and key files stay hidden across environment sources', { skip: NO_STUBS }, async t => {
  const { h, u, wt } = setup(t);
  const keys = ['AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AZURE_FEDERATED_TOKEN_FILE',
    'AZURE_CLIENT_CERTIFICATE_PATH', 'CLAUDE_CODE_CLIENT_KEY'];
  const sources = ['inherited', 'project', 'rung', 'file', 'claude', 'codex'].map(label =>
    Object.fromEntries(keys.map(key => {
      const file = path.join(h.base, `${label}-${key}`);
      fs.writeFileSync(file, 'SYNTHETIC-HARNESS-CREDENTIAL\n');
      return [key, file];
    })));
  const [inherited, project, rung, file, claude, codex] = sources;
  const text = env => Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  const envFile = path.join(h.base, 'harness-credentials.env');
  fs.writeFileSync(envFile, text(file));
  fs.writeFileSync(path.join(u.home, '.codex', '.env'), text(codex));
  const settingsFile = path.join(u.home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings.env, claude);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  h.ok(['project', 'set', '--env', JSON.stringify(project), '--env_file', envFile]);
  const files = sources.flatMap(env => Object.values(env));
  for (const harness of ['claude', 'codex']) await t.test(harness, () => {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung)]);
    spawn(h, u, 'hard', { ...inherited, STUB_READ: JSON.stringify(files) });
    assertCredentialsHidden(u.report(), files);
    if (harness === 'claude') assert.ok(u.report().reads.every(read => read.denied));
    for (const credential of Object.values(inherited)) {
      fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${credential}\n`);
      try {
        const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: { ...u.env, ...inherited } });
        assert.notEqual(refused.code, 0, 'harness credential imports must be refused');
        assert.match(refused.stderr, /house rule.*credential store/i);
      } finally { fs.rmSync(path.join(wt, 'AGENTS.md')); }
    }
  });
});

test('web identity tokens stay hidden across environment sources', { skip: NO_STUBS }, t => {
  const { h, u, wt } = setup(t);
  const sources = ['inherited', 'project', 'rung', 'file', 'claude', 'codex'].map(label => {
    const file = path.join(h.base, `${label}-web-identity`);
    fs.writeFileSync(file, 'SYNTHETIC-WEB-IDENTITY-TOKEN\n');
    return { AWS_WEB_IDENTITY_TOKEN_FILE: file };
  });
  const [inherited, project, rung, file, claude, codex] = sources;
  const text = env => `AWS_WEB_IDENTITY_TOKEN_FILE=${JSON.stringify(env.AWS_WEB_IDENTITY_TOKEN_FILE)}\n`;
  const envFile = path.join(h.base, 'web-identity.env');
  fs.writeFileSync(envFile, text(file));
  fs.writeFileSync(path.join(u.home, '.codex', '.env'), text(codex));
  const settingsFile = path.join(u.home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings.env, claude);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  h.ok(['project', 'set', '--env', JSON.stringify(project), '--env_file', envFile]);
  const files = sources.map(env => env.AWS_WEB_IDENTITY_TOKEN_FILE);
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung)]);
    spawn(h, u, 'hard', { ...inherited, STUB_READ: JSON.stringify(files) });
    assertCredentialsHidden(u.report(), files);
    if (harness === 'claude') assert.ok(u.report().reads.every(read => read.denied));
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${inherited.AWS_WEB_IDENTITY_TOKEN_FILE}\n`);
    const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: { ...u.env, ...inherited } });
    assert.notEqual(refused.code, 0, 'web identity token imports must be refused');
    assert.match(refused.stderr, /house rule.*credential store/i);
    fs.rmSync(path.join(wt, 'AGENTS.md'));
  }
});

test('credential stores equal to required runtime directories refuse dispatch', { skip: NO_STUBS }, t => {
  const { h, u, wt } = setup(t);
  fs.writeFileSync(path.join(wt, 'config.json'), '{"auths":{"example":{"auth":"SYNTHETIC-DOCKER-TOKEN"}}}\n');
  const alias = path.join(h.base, 'worktree-alias');
  fs.symlinkSync(wt, alias, 'dir');
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    for (const store of [wt, alias, h.state]) {
      fs.rmSync(u.out, { force: true });
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], {
        env: { ...u.env, DOCKER_CONFIG: store },
      });
      assert.notEqual(refused.code, 0, `${harness}: ${store} must refuse dispatch`);
      assert.match(refused.stderr, /credential store.*required.*path/i);
      assert.ok(!fs.existsSync(u.out), 'the harness must not start');
    }
    spawn(h, u, 'hard');
    assert.equal(u.report().harness, harness, 'a refused dispatch leaves the worktree usable');
  }
});

test('AWS profile web identity tokens stay hidden and cannot be imported', { skip: NO_STUBS }, async t => {
  const { h, u, wt } = setup(t);
  const files = [];
  const profileFile = (file, label) => {
    const token = path.join(h.base, `${label}-profile-token.jwt`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(token, 'SYNTHETIC-PROFILE-TOKEN\n');
    const comment = label === 'default' ? ' # deployment token' : '\t; deployment token';
    fs.writeFileSync(file, `[default]\nregion = us-east-1\nrole_arn = arn:aws:iam::123456789012:role/test\nweb_identity_token_file = ${token}${comment}\n`);
    files.push(token);
    return file;
  };
  profileFile(path.join(u.home, '.aws', 'config'), 'default');
  profileFile(path.join(u.home, '.aws', 'credentials'), 'shared-default');
  const sources = ['inherited', 'project', 'rung', 'file', 'claude', 'codex'].map(label => ({
    AWS_CONFIG_FILE: profileFile(path.join(h.base, `${label}-aws-config`), label),
  }));
  const [inherited, project, rung, file, claude, codex] = sources;
  // Named profiles and relative tokens must retain both caller and child paths.
  const relativeToken = 'relative profile#token;literal.jwt';
  for (const dir of [h.repo, wt]) {
    fs.writeFileSync(path.join(dir, relativeToken), 'SYNTHETIC-PROFILE-TOKEN\n');
    files.push(path.join(dir, relativeToken));
  }
  fs.appendFileSync(inherited.AWS_CONFIG_FILE, `[profile named]\nweb_identity_token_file = ${relativeToken}\n`);
  const text = env => `AWS_CONFIG_FILE=${JSON.stringify(env.AWS_CONFIG_FILE)}\n`;
  const envFile = path.join(h.base, 'profile-sources.env');
  fs.writeFileSync(envFile, text(file));
  fs.writeFileSync(path.join(u.home, '.codex', '.env'), text(codex));
  const settingsFile = path.join(u.home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  Object.assign(settings.env, claude);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  h.ok(['project', 'set', '--env', JSON.stringify(project), '--env_file', envFile]);
  for (const harness of ['claude', 'codex']) await t.test(harness, () => {
    isolated(h, 'hard', harness);
    h.ok(['ladder', 'set', 'hard', '--env', JSON.stringify(rung)]);
    spawn(h, u, 'hard', { ...inherited, AWS_PROFILE: 'named', STUB_READ: JSON.stringify(files) });
    assertCredentialsHidden(u.report(), files);
    if (harness === 'claude') assert.ok(u.report().reads.every(read => read.denied));
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), `@${files[0]}\n`);
    try {
      const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--dry-run'], { env: { ...u.env, ...inherited } });
      assert.notEqual(refused.code, 0, 'profile token imports must be refused');
      assert.match(refused.stderr, /house rule.*credential store/i);
    } finally { fs.rmSync(path.join(wt, 'AGENTS.md')); }
  });
});

test('nested credential links to required runtime directories refuse dispatch', { skip: NO_STUBS }, async t => {
  const { h, u, wt } = setup(t);
  fs.writeFileSync(path.join(wt, 'cached-token.json'), '{"accessToken":"SYNTHETIC-CACHED-TOKEN"}\n');
  const link = path.join(u.home, '.aws', 'sso', 'cache');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const alias = path.join(h.base, 'runtime-alias');
  fs.symlinkSync(wt, alias, 'dir');
  for (const rule of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) {
    const from = path.join(u.home, rule), target = path.join(h.base, path.basename(rule));
    fs.renameSync(from, target);
    fs.symlinkSync(target, from);
  }
  for (const harness of ['claude', 'codex']) await t.test(harness, () => {
    isolated(h, 'hard', harness);
    for (const target of [wt, alias, h.state]) {
      fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir');
      fs.rmSync(u.out, { force: true });
      try {
        const refused = h.run(['spawn', '--role', 'hard', '--task', 'T1', '--wait', '--json'], { env: u.env });
        assert.notEqual(refused.code, 0, `${harness}: nested link to ${target} must refuse dispatch`);
        assert.match(refused.stderr, /credential store.*required.*path/i);
        assert.ok(!fs.existsSync(u.out), 'the harness must not start');
      } finally { fs.rmSync(link); }
    }
    spawn(h, u, 'hard');
    assert.equal(u.report().harness, harness, 'removing the link restores safe dispatch');
  });
});

test('repository imports cannot authorize credential reads or send credentials to a harness', { skip: NO_STUBS }, (t) => {
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
        const global = path.join(u.home, harness === 'claude' ? '.claude/CLAUDE.md' : '.codex/AGENTS.md');
        fs.appendFileSync(global, `@${path.join(wt, 'AGENTS.md')}\n`);
      }
      for (const mode of ['--dry-run', '--wait']) {
        const r = h.run(['spawn', '--task', 'T1', '--role', 'hard', mode], { env: u.env });
        assert.notEqual(r.code, 0, `${harness}: ${file} must not become an authorized rule`);
        assert.match(r.stderr, /house rule.*credential store/i);
        assert.doesNotMatch(r.stdout + r.stderr, /IMPORT-SECRET|PLANTED-SECRET/);
        assert.ok(!fs.existsSync(u.out), 'refuse before starting the harness');
      }
    }
  }
});

test('credential location overrides are denied in both harnesses', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  const root = path.join(h.base, 'selected-credentials');
  const env = {
    DOCKER_CONFIG: path.join(root, 'docker'),
    CARGO_HOME: path.join(root, 'cargo'),
    KUBECONFIG: [path.join(root, 'kube-one'), '', path.relative(wt, path.join(root, 'kube-two'))].join(path.delimiter),
    CLOUDSDK_CONFIG: path.join(root, 'gcloud'),
    AZURE_CONFIG_DIR: path.join(root, 'azure'),
    NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'),
    npm_config_userconfig: path.join(root, 'npmrc-lower'),
    PIP_CONFIG_FILE: path.join(root, 'pip.conf'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(root, 'aws-credentials'),
    AWS_CONFIG_FILE: path.join(root, 'aws-config'),
  };
  const files = ['docker/config.json', 'cargo/credentials', 'cargo/credentials.toml', 'kube-one', 'kube-two',
    'gcloud/credentials.db', 'azure/msal_token_cache.json', 'npmrc', 'npmrc-lower', 'pip.conf', 'aws-credentials', 'aws-config']
    .map(file => path.join(root, file));
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'OVERRIDE-SECRET\n');
  }
  // A selected directory may be a symlink; deny its real target too.
  env.DOCKER_CONFIG = path.join(root, 'docker-link');
  fs.symlinkSync(path.join(root, 'docker'), env.DOCKER_CONFIG);
  const envFile = path.join(h.base, 'credential-paths.env');
  fs.writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
  for (const source of ['inherited', 'literal', 'file']) {
    if (source === 'literal') h.ok(['project', 'set', '--env', JSON.stringify(env)]);
    if (source === 'file') h.ok(['project', 'set', '--env', '{}', '--env_file', envFile]);
    for (const harness of ['claude', 'codex']) {
      isolated(h, 'hard', harness);
      spawn(h, u, 'hard', source === 'inherited' ? env : {});
      assertCredentialsHidden(u.report(), files);
    }
  }
});

test('Tower Crane, Pi and Agy credential stores and selected locations are denied', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const selected = path.join(h.base, 'selected-harness-config');
  const env = { TOWER_CRANE_CONFIG: path.join(selected, 'tower-crane.json'), PI_CODING_AGENT_DIR: path.join(selected, 'pi') };
  const files = [path.join(u.home, '.config', 'tower-crane', 'config.json'),
    path.join(u.home, '.pi', 'agent', 'auth.json'), path.join(u.home, '.pi', 'agent', 'models.json'),
    env.TOWER_CRANE_CONFIG, path.join(env.PI_CODING_AGENT_DIR, 'auth.json'), path.join(env.PI_CODING_AGENT_DIR, 'models.json'),
    path.join(selected, 'gemini', 'antigravity', 'mcp_oauth_tokens.json')];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
  }
  fs.symlinkSync(path.join(selected, 'gemini'), path.join(u.home, '.gemini'));
  for (const harness of ['claude', 'codex']) {
    isolated(h, 'hard', harness);
    spawn(h, u, 'hard', env);
    assertCredentialsHidden(u.report(), [...files, path.join(u.home, '.gemini', 'antigravity', 'mcp_oauth_tokens.json')]);
  }
});

test('a codex agent writes only where its agent file says; a worker writes its git metadata, reviewer and small checks cannot write the worktree', { skip: NO_STUBS }, (t) => {
  const { h, u, wt } = setup(t);
  // A worker fetches, adds, commits and pushes: it writes the repository's
  // git directory and its worktree's admin directory inside it.
  const common = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt));
  const own = fs.realpathSync(h.git(['rev-parse', '--path-format=absolute', '--git-dir'], wt));
  for (const [rung, worktree] of [['hard', 'write'], ['review', 'read'], ['small', 'read']]) {
    isolated(h, rung, 'codex');
    const started = spawn(h, u, rung);
    const home = path.join(h.state, 'homes', started.agent);
    const { config } = u.report();
    const rules = config.permissions['tower-crane'].filesystem;
    for (const d of [common, own]) assert.equal(rules[d], worktree === 'write' ? 'write' : undefined, `${rung}: ${d}`);
    assert.deepEqual(rules[':workspace_roots'], { '.': worktree }, rung);
    assert.equal(rules[':root'], 'read', rung);
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
  for (const [rung, writes] of [['hard', true], ['small', false]]) {
    isolated(h, rung, 'claude');
    spawn(h, u, rung);
    const allow = u.report().settings.sandbox.filesystem.allowWrite;
    for (const d of [common, own]) assert.equal(allow.includes(d), writes, `claude ${rung}: ${d}`);
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
      const own = writes.filter((w) => contains(root, w));
      assert.equal(own.length, 1, `${seen.harness} ${rung}: one directory under the cache root: ${JSON.stringify(own)}`);
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
      const hidden = harness === 'claude' ? seen.settings.sandbox.filesystem.denyRead
        : Object.keys(seen.config.permissions['tower-crane'].filesystem).filter((p) => seen.config.permissions['tower-crane'].filesystem[p] === 'none');
      assert.ok(hidden.includes(path.join(custom, 'gh')), `${harness}: the original gh config stays hidden`);
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
  assert.equal(fs.readlinkSync(path.join(child, 'home', '.gitconfig')), path.join(u.home, '.gitconfig'));
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
