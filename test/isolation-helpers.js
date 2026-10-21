'use strict';

// The fixture every isolation test file builds on: a planted user home, a
// repository with hooks of its own, spawn and policy probes, and what each
// sandbox lets an agent read.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const A = require('../lib/agents');

const STUB = path.join(__dirname, 'fixtures', 'harness-stub.js');
// The stubs are scripts started through a shebang; Windows starts only .exe
// and .com files from a rung, so the end-to-end runs are POSIX only.
const NO_STUBS = process.platform === 'win32' && 'harness stubs are shebang scripts';
const SECRET = 'PLANTED-SECRET';

// A user home holding what must never reach a tower-crane agent: memory and
// instruction files, hooks, an MCP server, approved-command rules, and
// credentials that must reach it only through a link.
function plant(h, branch = null) {
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
  // gh is not on every CI runner; this one stands in for the real program a
  // sandboxed agent's broker runs on the host. Like a gh whose login is in
  // the system keyring: `auth token` answers, and a call made with a token
  // in its environment is refused, since no agent should hold one. Pull
  // request 1 is the task's own; 2 is from another branch.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = token ]; then echo stub-gh-token; exit 0; fi',
    'if [ -n "$GH_TOKEN" ]; then echo "fixture gh: a token in the environment" >&2; exit 1; fi',
    'if [ "$1" = pr ] && [ "$2" = view ] && [ "$4" = --json ] && [ "$5" = number,headRefName,isCrossRepository ]; then',
    `  if [ "$7" = 2 ]; then echo '{"number":2,"headRefName":"other","isCrossRepository":false}'; else echo '{"number":1,"headRefName":${JSON.stringify(branch || '')},"isCrossRepository":false}'; fi; exit 0`,
    'fi',
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
  return { h, u: plant(h, h.git(['branch', '--show-current'], wt)), wt };
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
  // The probes relaunch one task's worker many times on purpose; the owner
  // lifts the respawn cap each stand-in's exit without a submit counts toward.
  if (h.readState('tasks.json').tasks[0].needs_owner?.startsWith('worker exited without submitting')) h.ok(['owner-done', 'T1']);
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
  return h.json(['spawn', '--role', role, '--task', 'T1', '--wait', '--json'], { ...opts, env: { ...u.env, ...env } });
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

module.exports = {
  STUB, NO_STUBS, SECRET, plant, setup, isolateGitEnvironment, walk, noSecretsCopied, releaseExited, spawn,
  ALLOW, decide, isolated, codexTargets, commandsRead,
};
