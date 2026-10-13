'use strict';

// Agent files and agent homes. agents/tower-crane-<job>.md says what an agent of
// that job may and may not do. spawn renders it for claude, codex, opencode, agy and pi into
// flags and a home of the agent's own, built fresh for every spawn: the
// harness config directory (CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR or agy's ~/.gemini)
// and the HOME the agent runs with. Nothing the user's harness setup holds loads
// unless it is named here. Worker scratch is shared across attempts of the same task.

const fs = require('node:fs');
const crypto = require('node:crypto');
const cp = require('./commands');
const os = require('node:os');
const path = require('node:path');
const { refuse } = require('./util');
const S = require('./state');
const L = require('./ladder');
const P = require('./processes');
const TOML = require('./toml');
const BrowserKit = require('./browser-kit');
const B = require('./broker');
const ClaudeSandboxPlaceholders = require('./claude-sandbox-placeholders');
const E = require('./events');
const Rules = require('./rules');
const Settings = require('./spawn-settings');

const ROOT = path.join(__dirname, '..');
const LISTS = ['tools', 'disallowedTools', 'mcpServers', 'skills', 'ghWrite', 'writeOutside', 'codexDisable'];
const OUTSIDE = ['state', 'homes', 'git', 'cache', 'worktrees'];
// File tools that change files; acceptEdits approves them inside the
// worktree only, so they are never pre-approved by name.
const EDITS = ['Edit', 'Write', 'NotebookEdit'];
// What the agent's HOME links to in the user's: git, gh and cloud
// credentials and settings, never a harness's own files. A sandboxed agent
// gets only the cloud links, which its harness reads outside the sandbox.
const HOME_LINKS = ['.gitconfig', '.config/git', '.config/gh', '.aws', '.ssh'];
const SANDBOXED_LINKS = ['.aws', '.ssh'];
// Each home records where the user's own files are, so a spawn started from
// inside another agent links to those and never into a parent's home.
const ORIGIN = '.tower-crane-origin.json';
let sourceTool;

function toolVersion() {
  if (!sourceTool) {
    const pinned = readJson(path.join(ROOT, 'tool.json'));
    const checkout = pinned ? null : S.git(['rev-parse', '--show-toplevel'], ROOT);
    sourceTool = {
      sha: pinned ? pinned.sha : checkout && resolved(checkout) === resolved(ROOT) ? S.git(['rev-parse', 'HEAD'], ROOT) : null,
      version: readJson(path.join(ROOT, 'package.json')).version,
    };
  }
  return sourceTool;
}

// Sandbox capability is the authority boundary: native permissions count.
// OS isolation also controls the state broker and nested browser setup.
const CAPABILITIES = Object.freeze({
  claude: Object.freeze({ sandbox: true, osSandbox: true }),
  codex: Object.freeze({ sandbox: true, osSandbox: true }),
  opencode: Object.freeze({ sandbox: false, osSandbox: false }),
  agy: Object.freeze({ sandbox: false, osSandbox: false }),
  pi: Object.freeze({ sandbox: false, osSandbox: false }),
  command: Object.freeze({ sandbox: false, osSandbox: false }),
});

const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2');

// The frontmatter subset the agent files use: `key: value`, `key: []` and
// block lists of `  - item`.
function parse(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw refuse(`${file} has no frontmatter`);
  const out = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      list.push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) throw refuse(`${file}: cannot read frontmatter line "${line}"`);
    const v = kv[2].trim();
    list = null;
    if (v === '') list = out[kv[1]] = [];
    else if (v === '[]') out[kv[1]] = [];
    else if (v === 'true' || v === 'false') out[kv[1]] = v === 'true';
    else out[kv[1]] = unquote(v);
  }
  const errs = LISTS.filter((k) => !Array.isArray(out[k])).map((k) => `${k} must be a list`);
  for (const k of ['web', 'sandbox']) if (typeof out[k] !== 'boolean') errs.push(`${k} must be true or false`);
  if (!['branch', 'none'].includes(out.gitPush)) errs.push('gitPush must be branch or none');
  if (!['write', 'read'].includes(out.worktree)) errs.push('worktree must be write or read');
  if (Array.isArray(out.mcpServers) && out.mcpServers.length) errs.push('mcpServers must be empty; a rung opts in with its mcp field');
  for (const w of out.writeOutside || []) if (!OUTSIDE.includes(w)) errs.push(`writeOutside: ${w} is not one of ${OUTSIDE.join(', ')}`);
  if (out.sandbox === true && (out.writeOutside || []).includes('state')) errs.push('writeOutside: a sandboxed role changes state through the state broker, so state needs sandbox: false');
  if (errs.length) throw refuse(`${file}: ${errs.join('; ')}`);
  return { ...out, body: m[2].trim() };
}

function file(job) {
  return path.join(ROOT, 'agents', `tower-crane-${job}.md`);
}

function load(job) {
  const f = file(job);
  let text;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch {
    throw refuse(`no agent file for ${job} at ${f}; reinstall tower-crane`);
  }
  return { ...parse(text, f), file: f };
}

// Skills ship next to lib/, or TOWER_CRANE_PLUGIN_ROOT points at a plugin
// checkout that holds them.
function skillDir(name, env) {
  const dir = path.join(env.TOWER_CRANE_PLUGIN_ROOT || ROOT, 'skills', name);
  return fs.existsSync(dir) ? dir : null;
}

function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// The user's own home and claude, codex and pi config directories. When spawn runs inside
// another agent, its HOME and harness dirs are that agent's home, whose
// origin file names the user's. Relative dirs resolve from cwd, the dispatch's
// directory: a route fallback's supervisor runs inside the worktree.
function origin(env, cwd = process.cwd()) {
  const dir = (value) => (value ? path.resolve(cwd, value) : null);
  const marked = (d) => (d ? readJson(path.join(d, ORIGIN)) : null);
  const homeMark = marked(os.homedir());
  const home = homeMark ? homeMark.home : os.homedir();
  const claudeDir = dir(env.CLAUDE_CONFIG_DIR);
  const claudeMark = marked(claudeDir);
  let claude;
  if (claudeMark) claude = { dir: claudeMark.claude.dir, json: claudeMark.claude.json };
  else if (claudeDir) claude = { dir: claudeDir, json: path.join(claudeDir, '.claude.json') };
  else if (homeMark) claude = homeMark.claude;
  else claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
  const codexDir = dir(env.CODEX_HOME);
  const codexMark = marked(codexDir);
  let codex;
  if (codexMark) codex = codexMark.codex;
  else if (codexDir) codex = codexDir;
  else if (homeMark) codex = homeMark.codex;
  else codex = path.join(home, '.codex');
  const opencodeMark = marked(env.OPENCODE_CONFIG_DIR);
  const opencode = opencodeMark?.opencode || homeMark?.opencode || {
    dir: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    data: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode'),
    ...(env.OPENCODE_CONFIG_DIR ? { extra: path.resolve(env.OPENCODE_CONFIG_DIR) } : {}),
    ...(env.OPENCODE_CONFIG ? { config: path.resolve(env.OPENCODE_CONFIG) } : {}),
  };
  const piDir = dir(env.PI_CODING_AGENT_DIR);
  const pi = marked(piDir)?.pi || piDir || homeMark?.pi || path.join(home, '.pi', 'agent');
  return { home, claude, codex, opencode, pi, agy: homeMark?.agy || path.join(home, '.gemini') };
}

// The user's cache root. An XDG_CACHE_HOME that is an agent's own cache came
// from a supervisor started in that agent's env, so it is not the root.
function cacheDir(env, home) {
  if (process.platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdg = env.XDG_CACHE_HOME;
  return xdg && !agentCachePath(xdg) ? xdg : path.join(home, '.cache');
}

// A supervisor can inherit a worker's task cache or another role's agent cache.
function agentCachePath(dir) {
  return /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}(?:[\\/]|$)/.test(path.resolve(dir));
}

// The cache an agent may write: a directory of its own, never the cache root,
// where installed tools, gate commands and spawn receipts live. Agent names
// repeat across projects, so the state directory is part of the path.
function agentCache(ctx, agent = ctx.agent) {
  const state = crypto.createHash('sha256').update(resolved(ctx.stateDir)).digest('hex').slice(0, 12);
  // A fallback rebuild can remove the current home's origin marker.
  return path.join(cacheDir(ctx.env, ctx.origin?.home || origin(ctx.env).home), 'tower-crane', 'agents', state, agent);
}

function taskCache(ctx) {
  if (ctx.taskSpec?.scratch) return ctx.taskSpec.scratch;
  const state = crypto.createHash('sha256').update(resolved(ctx.stateDir)).digest('hex').slice(0, 12);
  return path.resolve(cacheDir(ctx.env, ctx.origin?.home || origin(ctx.env).home), 'tower-crane', 'tasks', state, ctx.task);
}

function writableCache(ctx) {
  return ctx.job === 'worker' ? taskCache(ctx) : agentCache(ctx);
}

function removeTaskCache(task) {
  if (task.scratch) removeTree(task.scratch);
}

// Tool caches that would land outside the writable cache: under the cache root,
// or under the agent's HOME, which claude's sandbox does not write.
const CACHE_ENV = { XDG_CACHE_HOME: '', GOCACHE: 'go-build', GOMODCACHE: 'go-mod', npm_config_cache: 'npm' };

// imports are claude @path lines: claude loads those files, and what they
// import, into the agent's context from where they are.
function instructions(agent, env, mcp = [], imports = []) {
  const skills = agent.skills.map((s) => [s, skillDir(s, env)]).filter(([, d]) => d);
  return [
    agent.body,
    ...(mcp.length ? ['', `Approved MCP servers for this dispatch: ${mcp.join(', ')}. Use browser tools only for the task's UI.`] : []),
    ...(skills.length ? ['', ...skills.map(([s, d]) => `Skill ${s}: read and follow ${path.join(d, 'SKILL.md')}.`)] : []),
    ...(imports.length ? ['', '# House rules', '', 'The user\'s global rules and the repository\'s rule files, general first:', '', ...imports] : []),
    '',
  ].join('\n');
}

// The repository's git directory and, named on its own, the worktree's
// admin directory inside it (index, HEAD, FETCH_HEAD).
function repoGitDirs(ctx) {
  const dirs = [];
  const common = ctx.gitDirs?.common || S.gitLocation(ctx.repo.root, 'common');
  if (common) dirs.push(path.resolve(common));
  const own = ctx.gitDirs ? ctx.gitDirs.own
    : fs.existsSync(ctx.cwd) ? S.gitLocation(ctx.cwd, 'own') : null;
  if (own && (!common || path.resolve(own) !== path.resolve(common))) {
    // The worktree's `.git` file names this directory and the worker writes
    // that file, so a sandbox is granted only an admin directory of this
    // repository.
    if (!common || !cp.adminOf(own, common)) {
      throw refuse(`${path.join(ctx.cwd, '.git')} names ${own}, which is not a worktree admin directory of ${common || ctx.repo.root}; restore it with git worktree repair before spawning`);
    }
    dirs.push(path.resolve(own));
  }
  return dirs;
}

// The directories outside the worktree an agent may write, by writeOutside.
function outsideDirs(agent, ctx) {
  const dirs = [...(ctx.settings?.sandbox.write || [])];
  for (const w of agent.writeOutside) {
    if (w === 'state') dirs.push(ctx.stateDir);
    if (w === 'homes') dirs.push(path.join(ctx.stateDir, 'homes'));
    // codex keeps a workspace's git directory read-only unless a rule names it.
    if (w === 'git') dirs.push(...repoGitDirs(ctx));
    if (w === 'cache') dirs.push(writableCache(ctx));
    if (w === 'worktrees') dirs.push(path.join(path.dirname(ctx.repo.root), `${path.basename(ctx.repo.root).replace(/\.git$/, '')}-worktrees`));
  }
  return dirs.map(resolved);
}

// User-owned rule files stay readable to the agent: the global rules, project
// rules above the repository and what they import, until an import chain
// enters the repository, even when a global file imports its AGENTS.md
// explicitly. A repository's files and their imports open nothing.
function trustedRules(ctx) {
  const rules = ctx.rules || [];
  const known = new Set(rules.map(rule => resolved(rule.path)));
  const paths = [ctx.repo?.root, ctx.cwd].filter(Boolean).flatMap(dir => [path.resolve(dir), resolved(dir)]);
  const inProject = file => [path.resolve(file), resolved(file)].some(actual =>
    paths.some(dir => actual === dir || actual.startsWith(dir + path.sep)));
  const keep = new Set(rules.filter(rule => rule.scope === 'global' || (rule.scope === 'project' && !inProject(rule.path)))
    .map(rule => rule.path));
  const visited = new Set();
  const visit = file => {
    const actual = resolved(file);
    if (visited.has(actual) || inProject(file)) return;
    visited.add(actual);
    for (const child of Rules.importsOf(file, ctx.origin.home)) {
      if (!known.has(resolved(child.file)) || inProject(child.file)) continue;
      keep.add(child.file);
      visit(child.file);
    }
  };
  for (const file of [...keep]) visit(file);
  return [...keep];
}

const HARNESS_COMMANDS = ['claude', 'codex', 'opencode', 'pi', 'agy'];

// The installed harness programs: the npm package that holds a harness
// command, or the command itself when it is not an npm install. Codex runs
// its own binary inside its sandbox, so the agent must be able to read it.
function harnessRoots(ctx) {
  const { findExecutable } = require('./spawn');
  const roots = new Set();
  for (const name of HARNESS_COMMANDS) {
    const found = findExecutable(name, ctx.cwd || process.cwd(), true, ctx.env || process.env);
    if (!found) continue;
    const real = resolved(found);
    const parts = real.split(path.sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0 || at + 1 >= parts.length - 1) {
      roots.add(real);
      continue;
    }
    const depth = parts[at + 1].startsWith('@') ? 3 : 2;
    roots.add(parts.slice(0, at + depth).join(path.sep));
  }
  return [...roots];
}

// A root ('/', 'C:\\') already ends in a separator, and holds every path on it.
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// The node binaries an agent runs, the one running this CLI and each node on
// PATH: each binary's directory, which holds npm and the global commands, and
// its install's node_modules, which holds their packages (a codex wrapper on
// PATH runs the codex package of the node it finds). Never the install's
// whole prefix: a node in ~/.local/bin would open ~/.local/share. A node
// directly in the home opens only itself.
function nodeInstalls(env, home) {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const bins = [process.execPath, ...String(env[pathKey(env)] || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe))];
  return [...new Set(bins.map(real).filter(Boolean).flatMap(bin => [
    path.dirname(bin) === home ? bin : path.dirname(bin),
    process.platform === 'win32' ? path.join(path.dirname(bin), 'node_modules') : path.resolve(bin, '..', '..', 'lib', 'node_modules'),
  ]))];
}

// What a sandboxed agent may read under the user's home. Both sandboxes deny
// the rest of the home, so no list of credential stores is kept: the
// worktree and its git directories, the writable directories, the agent's
// own home, the state directory, the Tower Crane checkout and plugin, the
// node binaries and their packages, the harness programs, the files the
// agent's git config points at, the user's rule files and the project's
// sandbox.read. Outside the home the harness default applies. Entries are
// real paths that exist.
function homeReads(agent, ctx) {
  return agentReads(agent, ctx).home;
}

// The same list split by the user's home: home holds the paths under it,
// outside the rest but a directory that holds the home.
function agentReads(agent, ctx) {
  const home = resolved(ctx.origin.home);
  const named = ctx.settings?.sandbox.read || [];
  const wanted = [ctx.cwd, ...repoGitDirs(ctx), ...outsideDirs(agent, ctx), ctx.home, ctx.stateDir,
    ROOT, ctx.env.TOWER_CRANE_PLUGIN_ROOT, ...nodeInstalls(ctx.env, home), ...harnessRoots(ctx),
    ...(ctx.gitConfig?.reads || []), ...trustedRules(ctx), ...named];
  const inside = new Set();
  const outside = new Set();
  for (const p of wanted.filter(Boolean)) {
    const r = real(p);
    if (!r) continue;
    if (r === home) throw refuse(`sandbox path ${p} is the user's home ${home}; name the directories the agent needs inside it`);
    // A directory that holds the home, such as /, would open all of it.
    if (within(home, r)) {
      if (named.includes(p)) throw refuse(`sandbox path ${p} holds the user's home ${home}; name the directories the agent needs`);
      continue;
    }
    (within(r, home) ? inside : outside).add(r);
  }
  return { home: [...inside], outside: [...outside] };
}

// Repository rules, and what they import, load into the harness's context
// outside its sandbox, so a rule under the user's home that the agent may not
// read refuses startup before the harness runs.
function refuseHiddenRules(ctx, reads) {
  const home = resolved(ctx.origin.home);
  for (const rule of ctx.rules || []) {
    const file = resolved(rule.path);
    if (within(file, home) && !reads.some(dir => within(file, dir))) {
      throw refuse(`house rule ${rule.path} is under the user's home outside the agent's readable paths`);
    }
  }
}

// gh commands that only read, allowed to every role.
const GH_READ = ['pr view', 'pr diff', 'pr checks', 'pr list', 'pr status', 'issue view', 'issue list', 'repo view',
  'run view', 'run list', 'run watch', 'release view', 'release list', 'workflow view', 'workflow list', 'label list',
  'search', 'auth status', 'status'];

// What the git and gh shims allow, from the agent file: git's own commands,
// push to the task's branch through origin in the recorded repo without force, and gh reads plus
// the writes ghWrite names. Anything else, aliases included, is refused.
function policy(agent) {
  return { gitPush: agent.gitPush, gh: [...GH_READ, ...agent.ghWrite] };
}

// gh keeps a login in the system keyring, which a sandboxed agent cannot
// reach (the sandbox hides the user's D-Bus socket). The token is asked of
// gh when the agent starts and handed to the agent process as GH_TOKEN; it is
// not written to files, argv, dry-run output or events. A token already
// in the spawning environment (GH_TOKEN or GITHUB_TOKEN) passes through as is.
function ghToken(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return {};
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of String(env[pathKey(env)] || '').split(path.delimiter)) {
    // A parent agent's shims are not gh.
    if (!dir || fs.existsSync(path.join(dir, '..', ORIGIN))) continue;
    for (const ext of exts) {
      const gh = path.join(dir, `gh${ext}`);
      if (!fs.existsSync(gh)) continue;
      const r = cp.spawnSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 10000, env: { ...env, GH_PROMPT_DISABLED: '1' }, windowsHide: true });
      const token = r.status === 0 ? String(r.stdout).trim() : '';
      return token ? { GH_TOKEN: token } : {};
    }
  }
  return {};
}

const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

const text = v => typeof v === 'string';
const number = v => typeof v === 'number' && Number.isFinite(v);
const boolean = v => typeof v === 'boolean';
const strings = v => Array.isArray(v) && v.every(text);
const stringMap = v => TOML.isTable(v) && Object.values(v).every(text);

// A field is a check on its value or, as an object, the allowlist of a
// sub-table. A credential-shaped name never crosses from a sub-table, whatever
// its allowlist says.
const CREDENTIAL = /key|bearer|token|secret|password/i;

function keepFields(doc, fields, nested = false) {
  return Object.fromEntries(Object.entries(doc).flatMap(([k, v]) => {
    const f = TOML.has(fields, k) ? fields[k] : null;
    if (!f || (nested && CREDENTIAL.test(k))) return [];
    if (typeof f !== 'function') return TOML.isTable(v) ? [[k, keepFields(v, f, true)]] : [];
    return f(v) ? [[k, v]] : [];
  }));
}

// --- claude -----------------------------------------------------------------

// Settings env that only selects a provider, region or model. A credential in
// the user's settings env is not carried over: it reaches the agent through
// the environment spawn runs in, or a helper command read when claude asks.
const ClaudeProvider = require('./claude-provider');
// Settings that name a command claude runs to fetch credentials. The home
// names auth-helper.js, which reads and runs the user's command each time, so
// the command (which may hold the credential) is never copied.
const CLAUDE_AUTH = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];
const CLAUDE_MCP_FIELDS = { type: text, command: text, args: strings, url: text };

function claudeMcp(user) {
  return { ...(readJson(user.json)?.mcpServers || {}), ...(readJson(path.join(user.dir, 'mcp.json'))?.mcpServers || {}) };
}

function availableMcp(harness, from, names, env = {}) {
  const defined = harness === 'claude' ? claudeMcp(from.claude)
    : harness === 'opencode' ? opencodeConfig(from.opencode, env).mcp || {}
    : harness === 'agy' ? readJson(path.join(from.agy || path.join(from.home, '.gemini'), 'config', 'mcp_config.json'))?.mcpServers || {}
    : own(readToml(path.join(from.codex, 'config.toml')), 'mcp_servers') || {};
  return names.filter((name) => Object.prototype.hasOwnProperty.call(defined, name) && TOML.isTable(defined[name]));
}

function commandLine(argv) {
  const q = process.platform === 'win32' ? (a) => `"${a}"` : (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  return argv.map(q).join(' ');
}

// An orchestrator's Stop blocks until the next event (lib/hook-bridge.js), so
// it gets a day where other hooks get seconds.
function messageHooks(tool, job) {
  const command = commandLine([process.execPath, path.join(tool.path, 'lib', 'hook-bridge.js'), 'hook']);
  // PostToolUse makes two bridge calls, each with its own lock wait.
  const timeout = Math.ceil((2 * (S.LOCK_WAIT_MS + 5000) + 5000) / 1000);
  return Object.fromEntries(['PostToolUse', 'UserPromptSubmit', 'Stop'].map((event) => [
    event, [{ hooks: [{ type: 'command', command, timeout: event === 'Stop' && job === 'orchestrator' ? 86400 : timeout }] }],
  ]));
}

// The owner key's directory, made before the agent starts so the sandbox
// hides it even when the owner creates the key later.
function ownerKeyDir(ctx) {
  const dir = ownerKeyPath(ctx);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolved(dir);
}

function ownerKeyPath(ctx) {
  const authority = require('./authority');
  const project = authority.ownerProject(ctx.stateDir);
  return project?.owner_config_dir === undefined
    ? path.join(authority.resolveOwnerConfigDir(ctx.env), 'owner')
    : path.dirname(authority.ownerKeyFile(project));
}

// What both sandboxes hide inside paths they otherwise read: agent homes,
// which link to the user's credentials, broker tokens and the owner key. A
// project sandbox path inside one would reopen what lies under it: claude
// remounts an allowed path inside a denied one, and codex mounts writable
// paths after hidden ones. A writable path above one keeps the store hidden
// for that run, but codex lets the agent rename a directory between the
// path and the store, which moves the store out from under its mask, and
// the next spawn masks only the old path. A readable path above one is safe.
function refuseSandboxInStores(ctx) {
  const stores = [path.join(ctx.stateDir, 'homes'), path.join(ctx.stateDir, 'brokers'), ownerKeyPath(ctx)].map(resolved);
  for (const field of ['write', 'read']) {
    for (const p of ctx.settings?.sandbox[field] || []) {
      const r = resolved(p);
      const inside = stores.find((dir) => within(r, dir));
      if (inside) throw refuse(`sandbox.${field} path ${p} is inside ${inside}, which the sandbox hides because it holds credentials; name a directory outside it`);
      const holds = field === 'write' && stores.find((dir) => within(dir, r));
      if (holds) throw refuse(`sandbox.write path ${p} holds ${holds}, which the sandbox hides because it holds credentials; an agent that writes ${p} can move it out from under the mask, so name a directory that does not hold it`);
    }
  }
}

function runtimeDir(env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return env.XDG_RUNTIME_DIR || (uid === null ? null : `/run/user/${uid}`);
}

// The environment the worker starts with, env_file included, as spawn-monitor
// layers it. Only the write step reads it, since dry-run never reads env_file.
function workerEnv(ctx) {
  return { ...ctx.env, ...Settings.agentEnv(ctx.settings || {}) };
}

// The user's session bus, when the project sets sandbox.session_bus. The
// runtime directory stays denied; the bus socket is granted back, read and
// write, and it carries DBUS_SESSION_BUS_ADDRESS. The socket is the one in the
// environment the worker starts with, so it follows env_file and the project's
// env. Spawn refuses while it is missing rather than granting a path that is
// not there. The user manager's private socket stays denied: a scope cannot
// start through the sandbox, and the bus already reaches the same manager.
// Codex blocks AF_UNIX connections to the bus, so only claude sandboxes get it.
// docs/state.md#projectjson has the risk.
function sessionBus(agent, ctx) {
  if (!agent.sandbox || ctx.settings?.sandbox?.session_bus !== true) return null;
  const env = workerEnv(ctx);
  const runtime = runtimeDir(env);
  if (!runtime) throw refuse('sandbox.session_bus needs XDG_RUNTIME_DIR, or a user id to find the session bus');
  const bus = resolved(path.join(runtime, 'bus'));
  if (!fs.existsSync(bus)) throw refuse(`sandbox.session_bus needs ${bus}; start the user session or unset the setting`);
  return { sockets: [bus] };
}

// The bus variables a claude worker starts with where its launch environment
// names none. spawn-monitor calls this after env_file is layered in, so the
// address names the runtime directory the worker really gets, and so the socket
// sessionBus grants. Dry-run never reads env_file, so it shows none of these.
function sessionBusEnv(harness, settings, env) {
  if (harness !== 'claude' || settings?.sandbox?.session_bus !== true) return {};
  const runtime = runtimeDir(env);
  if (!runtime) return {};
  return {
    ...(env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: runtime }),
    ...(env.DBUS_SESSION_BUS_ADDRESS ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'bus')}` }),
  };
}

// Bash runs in claude's own sandbox, and stops the agent when the sandbox
// cannot start. allowAllUnixSockets skips the socket filter, whose seccomp
// helper needs a nested user namespace that many hosts refuse; reads of the
// sockets and key directories an agent has no use for are denied instead.
// The state directory is read-only: the state broker writes it. Other
// agents' homes and broker directories are unreadable, so no agent finds
// another's broker token. The owner key is unreadable too, and so is the
// user's home except the paths in reads (homeReads): claude mounts each
// denied directory empty, shallowest first, and remounts the allowed paths
// inside it, so homes/ is hidden again inside the reopened state directory.
// masks is what hides the home (claudeHomeMasks).
function claudeSandbox(agent, ctx, reads, masks, bus = null) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  stateMasks(ctx);
  const env = workerEnv(ctx);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowAllUnixSockets: true, allowLocalBinding: true, allowedDomains: ['*'] },
    filesystem: {
      allowWrite: [...outsideDirs(agent, ctx), ...(bus ? bus.sockets : [])],
      denyWrite: existing([resolved(ctx.stateDir), ...(agent.worktree === 'read' ? [resolved(ctx.cwd)] : [])]),
      denyRead: existing([
        ...masks,
        resolved(path.join(ctx.stateDir, 'homes')),
        '/var/run/docker.sock', '/run/docker.sock', ...(uid === null ? [] : [`/run/user/${uid}`]),
        // The worker env may name another runtime; the spawning one stays denied too.
        ...[...new Set([ctx.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR])].filter((dir) => dir && dir !== `/run/user/${uid}`),
        resolved(path.join(ctx.stateDir, 'brokers')), ownerKeyDir(ctx),
      ]),
      allowRead: [...new Set([...reads, resolved(ctx.home), resolved(B.dir(ctx.stateDir, ctx.agent)), ...(bus ? bus.sockets : [])])],
    },
  };
}

// claude's Read, Grep and Glob ask this hook (lib/read-guard.js) about a
// path under the user's home, since a deny rule takes no exception and the
// sandbox does not confine them.
function readGuard(ctx, reads) {
  put(ctx.home, 'read-guard.json', JSON.stringify({ home: resolved(ctx.origin.home), allow: reads }) + '\n');
  const command = commandLine([process.execPath, path.join(ctx.tool.path, 'lib', 'read-guard.js'), path.join(ctx.home, 'read-guard.json')]);
  return [{ matcher: READ_TOOLS.join('|'), hooks: [{ type: 'command', command, timeout: 30 }] }];
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

// claude checks its own Read, Grep and Glob tools against permission rules,
// never against the sandbox, so every path the sandbox hides but the home,
// which readGuard covers, is denied to them too. A deny rule takes no
// exception, so the homes and brokers rules also cover this agent's own home
// and broker directory, which Bash still reads; denying a whole entry keeps a
// home or broker spawned later hidden.
function readDenyRules(paths) {
  return paths.flatMap((p) => {
    // Rules name absolute paths with a leading //, in POSIX form on Windows.
    const posix = p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).split(path.sep).join('/');
    return READ_TOOLS.flatMap((t) => [`${t}(/${posix})`, `${t}(/${posix}/**)`]);
  });
}

function claude(agent, rung, ctx) {
  const optIn = rung.tools || [];
  const user = ctx.origin.claude;
  const tools = [...new Set([...agent.tools.filter((t) => t !== 'Skill'), ...optIn])]
    .filter(t => !rung.web_mcp || !['WebSearch', 'WebFetch'].includes(t));
  const deny = agent.disallowedTools.filter((t) => !optIn.includes(t));
  // Bash is approved because it runs in claude's sandbox (settings.json).
  const allow = tools.filter((t) => !EDITS.includes(t));
  const servers = {};
  if (rung.web_mcp) {
    const { name, command, args } = rung.web_mcp;
    servers[name] = { command, args };
  }
  const mcp = [...new Set([...(rung.mcp || []), ...ctx.browserMcp])];
  if (mcp.length) {
    const source = path.join(user.dir, 'mcp.json');
    const defined = claudeMcp(user);
    for (const name of mcp) {
      const def = Object.prototype.hasOwnProperty.call(defined, name) ? defined[name] : null;
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw refuse(`ladder ${ctx.rungName} opts in MCP server ${name}, but ${source} and ${user.json} define none by that name`);
      servers[name] = keepFields(def, CLAUDE_MCP_FIELDS);
    }
  }
  if (ctx.job === 'orchestrator') servers['tower-crane'] = {
    command: process.execPath,
    args: [path.join(ctx.tool.path, 'bin', 'tower-crane.js'), 'mcp', '--agent', ctx.agent, '--state', ctx.stateDir],
  };
  // An opted-in server's tools are approved with it; print mode would deny
  // them otherwise.
  allow.push(...Object.keys(servers).flatMap((name) => name === rung.web_mcp?.name
    ? ['websearch', 'webfetch'].map(t => `mcp__${name}__${t}`)
    : [`mcp__${name}`]));
  const home = ctx.home;
  const sandboxExcludeFile = path.join(home, 'sandbox-git-exclude');
  const gitEnv = agent.sandbox ? ClaudeSandboxPlaceholders.gitEnvironment(sandboxExcludeFile, ctx.env) : {};
  const flags = [
    // Only the generated settings: a repository's .claude/settings.json can
    // carry hooks and plugins too.
    '--setting-sources', 'user',
    '--permission-mode', 'acceptEdits',
    '--tools', tools.join(','),
    ...(allow.length ? ['--allowedTools', allow.join(',')] : []),
    ...(deny.length ? ['--disallowedTools', ...deny] : []),
    '--strict-mcp-config', '--mcp-config', path.join(home, 'mcp.json'),
    '--disable-slash-commands',
  ];
  const write = () => {
    const settingsFile = real(path.join(user.dir, 'settings.json'));
    const settings = (settingsFile && readJson(settingsFile)) || {};
    const own = {};
    own.hooks = messageHooks(ctx.tool, ctx.job);
    const env = { ...ClaudeProvider.configEnv(settings), ...ClaudeProvider.environment(rung, ctx.env, ctx.origin, settings, ctx.settings) };
    // AWS routing must use the launch environment after env_file and literal
    // overrides, rather than user settings that would override those values.
    if (ClaudeProvider.selected(rung)) for (const key of Object.keys(env)) if (key.startsWith('AWS_')) delete env[key];
    if (Object.keys(env).length) own.env = env;
    for (const k of CLAUDE_AUTH) {
      if (typeof settings[k] === 'string') own[k] = commandLine([process.execPath, path.join(__dirname, 'auth-helper.js'), settingsFile, k]);
    }
    if (agent.sandbox) {
      const reads = homeReads(agent, ctx);
      const masks = claudeHomeMasks(agent, ctx, reads);
      own.sandbox = claudeSandbox(agent, ctx, reads, masks, sessionBus(agent, ctx));
      own.permissions = { deny: readDenyRules(own.sandbox.filesystem.denyRead.filter((p) => !masks.includes(p))) };
      own.hooks.PreToolUse = readGuard(ctx, reads);
      const existed = ClaudeSandboxPlaceholders.present(ctx.cwd);
      const patterns = ClaudeSandboxPlaceholders.ignorePatterns(existed);
      const inherited = ctx.gitExcludeText || '';
      const separator = inherited && !inherited.endsWith('\n') ? '\n' : '';
      put(home, 'sandbox-git-exclude', `${inherited}${separator}${patterns.join('\n')}${patterns.length ? '\n' : ''}`);
      exclude(ctx.repo.root, '.claude/.cc-writes/', ctx.repo.commonDir);
    }
    put(home, 'settings.json', JSON.stringify(own, null, 2) + '\n');
    put(home, 'mcp.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
    put(home, 'CLAUDE.md', ctx.reviewSystem ? '' : instructions(agent, ctx.env, mcp, require('./rules').claudeImports(ctx.rules || [])));
    // A file keeps the shared reviewer prefix off argv, which Windows caps at 32,767 characters.
    if (ctx.reviewSystem) put(home, 'system.md', ctx.reviewSystem);
    put(home, '.claude.json', '{}\n');
    link(path.join(user.dir, '.credentials.json'), path.join(home, '.credentials.json'));
  };
  return { flags, env: { CLAUDE_CONFIG_DIR: home, ...ClaudeProvider.environment(rung, ctx.env, ctx.origin, undefined, ctx.settings) }, gitEnv, mcp: Object.keys(servers), tools: optIn, write };
}

// Claude's sandbox keeps a .claude/.cc-writes/ directory in the worktree; it
// must never be committed.
function exclude(root, pattern, preparedCommon) {
  const common = preparedCommon || S.gitLocation(root, 'common');
  if (!common) return;
  const f = path.join(common, 'info', 'exclude');
  const text = readText(f) || '';
  if (text.split(/\r?\n/).includes(pattern)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${text && !text.endsWith('\n') ? '\n' : ''}${pattern}\n`);
}

// --- codex ------------------------------------------------------------------

// Only named fields with their expected shapes cross into a home. Env fields
// name variables; literal env, headers and unrecognized fields stay outside.
const CODEX_FIELDS = {
  ...Object.fromEntries(L.CODEX_KEYS.map(k => [k, text])),
  model_context_window: number, model_auto_compact_token_limit: number, model_supports_reasoning_summaries: boolean,
};
const PROVIDER_FIELDS = {
  name: text, base_url: text, env_key: text, wire_api: text,
  requires_openai_auth: boolean, supports_websockets: boolean,
  request_max_retries: number, stream_max_retries: number, stream_idle_timeout_ms: number,
  env_http_headers: stringMap,
  // Bedrock reads its region and AWS profile here; credential_export and
  // auth_refresh run commands that produce credentials and stay outside.
  aws: { region: text, profile: text },
  // Azure needs api-version; every other query parameter, such as a key or a
  // SAS signature, stays outside.
  query_params: { 'api-version': text },
};
const MCP_FIELDS = {
  type: text, command: text, args: strings, cwd: text, url: text,
  env_vars: strings, env_http_headers: stringMap, bearer_token_env_var: text,
  enabled: boolean, required: boolean, startup_timeout_sec: number, startup_timeout_ms: number, tool_timeout_sec: number,
  enabled_tools: strings, disabled_tools: strings, default_tools_approval_mode: text,
};
const MCP_TOOL_FIELDS = { enabled: boolean, approval_mode: text };

function keepTables(doc, fields) {
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => TOML.isTable(v)).map(([k, v]) => [k, keepFields(v, fields)]));
}

function codexMcp(doc) {
  const out = keepFields(doc, MCP_FIELDS);
  if (own(doc, 'tools')) out.tools = keepTables(doc.tools, MCP_TOOL_FIELDS);
  return out;
}

const pick = (doc) => keepFields(doc, CODEX_FIELDS);
const own = (doc, k) => (TOML.has(doc, k) && TOML.isTable(doc[k]) ? doc[k] : null);

// What of a user codex config file an agent home keeps: the model, provider
// and auth-store keys by name, named non-credential provider fields, legacy
// profiles the same way, and the MCP servers the rung opted in to.
function codexConfig(doc, mcp) {
  const out = pick(doc);
  if (own(doc, 'model_providers')) out.model_providers = keepTables(doc.model_providers, PROVIDER_FIELDS);
  if (own(doc, 'profiles')) {
    out.profiles = Object.fromEntries(Object.entries(doc.profiles).filter(([, v]) => TOML.isTable(v)).map(([k, v]) => [k, pick(v)]));
  }
  const servers = own(doc, 'mcp_servers') || {};
  const found = mcp.filter((n) => own(servers, n));
  if (found.length) out.mcp_servers = Object.fromEntries(found.map((n) => [n, codexMcp(servers[n])]));
  return { doc: out, found };
}

function readToml(f) {
  const text = readText(f);
  return text === null ? {} : TOML.parse(text, f);
}

// Authorize branch publishing without an approval prompt. The git shim still
// checks options and refspecs, including force options after the remote.
function codexRules(deny, gitPush) {
  const rules = [];
  if (gitPush === 'branch') rules.push('prefix_rule(\n    pattern = ["git", "push"],\n    decision = "allow",\n)\n');
  for (const d of deny) {
    const m = /^Bash\(([^:*]+):\*\)$/.exec(d);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/);
    rules.push(`prefix_rule(\n    pattern = [${words.map((w) => JSON.stringify(w)).join(', ')}],\n    decision = "forbidden",\n)\n`);
  }
  return rules.join('\n');
}

// A sandbox that masks a path the host lacks leaves an empty read-only file or
// directory there, in the checkout or the home. Host paths are masked only
// when they exist. The state's own homes and brokers directories are made
// first, because hiding them is the point.
function stateMasks(ctx) {
  for (const d of ['homes', 'brokers']) fs.mkdirSync(path.join(ctx.stateDir, d), { recursive: true, mode: 0o700 });
}

function existing(paths) {
  return paths.filter((p) => fs.existsSync(p));
}

// The entries of each directory from the user's home down to dir that are
// not on the way to dir. A link is left alone: the sandbox would hide its
// target, which may be a readable path, and a target in the home is an entry
// of its own.
function offPath(home, dir) {
  const out = [];
  for (let d = home; d !== dir;) {
    const next = path.join(d, path.relative(d, dir).split(path.sep)[0]);
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (p !== next && !fs.lstatSync(p).isSymbolicLink()) out.push(p);
    }
    d = next;
  }
  return out;
}

// What claude's sandbox hides for the home: the home itself, or, when the
// worktree under it is read-only, the entries off the way to the worktree.
// claude mounts a hidden directory empty, and in an empty mount it cannot
// make the placeholders it binds over a read-only worktree's dotfiles, so
// no directory above that worktree may be hidden. An entry inside a
// readable path stays readable.
function claudeHomeMasks(agent, ctx, reads) {
  const home = resolved(ctx.origin.home);
  const cwd = resolved(ctx.cwd);
  if (agent.worktree !== 'read' || cwd === home || !within(cwd, home)) return [home];
  return offPath(home, cwd).filter((p) => !reads.some((r) => within(p, r)));
}

// What codex reads outside the user's home without naming it: each entry of
// the root but the one that holds the home. /dev, /proc and /tmp are left to
// codex's own mounts and :slash_tmp. Links are left out: codex binds a link's
// target and never makes the link, so /bin and /lib come from :minimal
// instead. The directories below the root on the way to the home are not
// listed entry by entry: /home, or a test's temp directory, can hold
// thousands of entries, and codex passes its sandbox the whole profile as
// one argument, which Linux caps at 128 KiB (MAX_ARG_STRLEN), so a profile
// that grows with them stops codex from starting. Their other entries, such
// as other users' homes, stay hidden; outsideReads names what the agent needs
// there.
function outsideHome(home) {
  const root = path.parse(home).root;
  const next = path.join(root, path.relative(root, home).split(path.sep)[0]);
  let names = [];
  try { names = fs.readdirSync(root); } catch { /* an unlistable root adds nothing */ }
  const out = [];
  for (const name of names) {
    const p = path.join(root, name);
    if (p === next || ['dev', 'proc', 'tmp'].includes(name)) continue;
    try { if (!fs.lstatSync(p).isSymbolicLink()) out.push(p); } catch { /* gone since the listing */ }
  }
  return out;
}

// The paths outside the home codex names besides outsideHome: the agent's
// reads there, and the install prefix of each PATH directory there (the
// directory itself when its parent holds the home), so a program installed
// next to the home, such as Homebrew's under /home/linuxbrew, still runs with
// the libraries beside it. Paths inside a root entry are already read.
function outsideReads(reads, ctx, home, named) {
  const out = new Set();
  for (const dir of String(ctx.env[pathKey(ctx.env)] || '').split(path.delimiter).filter(Boolean)) {
    const r = real(dir);
    if (!r || within(r, home) || within(home, r)) continue;
    // Never a prefix that holds the home: / for a PATH directory at the root.
    out.add(within(home, path.dirname(r)) ? r : path.dirname(r));
  }
  for (const r of reads) out.add(r);
  return [...out].filter((p) => !named.some((dir) => within(p, dir)));
}

// The sandbox for the agent's commands: hide other homes, write the worktree
// (or not), the writeOutside directories and the agent's own HOME, never the
// state directory (the state broker writes it), and never read another
// agent's broker directory, or the user's home outside homeReads. Codex
// cannot reopen a readable path inside a hidden directory: under :root it
// mounts readable paths before it hides one, and hiding each other entry of
// the home overflows the single argument it passes the profile in. So
// nothing is read through :root: :minimal holds the system directories, and
// outsideHome, outsideReads and homeReads are named. Writable paths
// are mounted after hidden ones, so the agent's own broker directory, under
// the hidden brokers/, is writable to stay visible; the broker never reads
// it back.
function permissions(agent, ctx) {
  stateMasks(ctx);
  const fsRules = { ':minimal': 'read', ':tmpdir': 'write', ':slash_tmp': 'write' };
  const home = resolved(ctx.origin.home);
  const reads = agentReads(agent, ctx);
  const outside = outsideHome(home);
  for (const p of [...outside, ...outsideReads(reads.outside, ctx, home, outside), ...reads.home]) fsRules[p] = 'read';
  for (const d of outsideDirs(agent, ctx)) fsRules[d] = 'write';
  fsRules[resolved(ctx.stateDir)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes'))] = 'none';
  fsRules[resolved(ctx.home)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes', '.codex', ctx.agent))] = 'write';
  fsRules[resolved(path.join(ctx.stateDir, 'brokers'))] = 'none';
  fsRules[resolved(B.dir(ctx.stateDir, ctx.agent))] = 'write';
  if (fs.existsSync(ownerKeyDir(ctx))) fsRules[ownerKeyDir(ctx)] = 'none';
  fsRules[resolved(path.join(ctx.home, 'home'))] = 'write';
  // A hidden path inside a hidden directory makes codex mount over a path in
  // a masked, read-only parent.
  const none = Object.keys(fsRules).filter((p) => fsRules[p] === 'none');
  for (const p of none) if (none.some((dir) => p !== dir && within(p, dir))) delete fsRules[p];
  fsRules[':workspace_roots'] = { '.': agent.worktree };
  return { 'tower-crane': { filesystem: fsRules, network: { enabled: true } } };
}

function codex(agent, rung, ctx) {
  const optIn = rung.tools || [];
  const mcp = [...new Set([...(rung.mcp || []), ...ctx.browserMcp])];
  const user = ctx.origin.codex;
  const home = ctx.home;
  const base = codexConfig(readToml(path.join(user, 'config.toml')), mcp);
  approveBrowserServers(base.doc, ctx.browserMcp);
  const missing = mcp.filter((n) => !base.found.includes(n));
  if (missing.length) throw refuse(`ladder ${ctx.rungName} opts in MCP server ${missing.join(', ')}, but ${path.join(user, 'config.toml')} defines no [mcp_servers.${missing[0]}]`);
  if (ctx.job === 'orchestrator') {
    mcp.push('tower-crane');
    base.doc.mcp_servers ||= {};
    base.doc.mcp_servers['tower-crane'] = {
      command: process.execPath,
      args: [path.join(ctx.tool.path, 'bin', 'tower-crane.js'), 'mcp', '--agent', ctx.agent, '--state', ctx.stateDir],
    };
  }
  const webOn = agent.web || optIn.includes('web_search');
  const flags = [
    '-c', `default_permissions="${agent.sandbox ? 'tower-crane' : ':danger-full-access'}"`,
    '-c', 'approval_policy="never"',
    // This home contains only generated hook commands; project trust is omitted.
    '-c', 'bypass_hook_trust=true',
    '-c', `web_search="${webOn ? 'live' : 'disabled'}"`,
    ...agent.codexDisable.filter((f) => !optIn.includes(f)).flatMap((f) => ['--disable', f]),
    ...optIn.filter((t) => t !== 'web_search').flatMap((t) => ['--enable', t]),
  ];
  const write = () => {
    const doc = base.doc;
    doc.notify = [process.execPath, path.join(ctx.tool.path, 'lib', 'hook-bridge.js'), 'codex'];
    doc.hooks = messageHooks(ctx.tool, ctx.job);
    if (agent.sandbox) doc.permissions = permissions(agent, ctx);
    put(home, 'config.toml', TOML.stringify(doc) + '\n');
    // Profiles (`-p NAME` layers NAME.config.toml) are filtered the same
    // way; all of them, since a wrapper on PATH may pick one the rung does
    // not name.
    let names = [];
    try {
      names = fs.readdirSync(user).filter((f) => /^[\w.-]+\.config\.toml$/.test(f));
    } catch {
      // No codex home yet.
    }
    for (const f of names) {
      const profile = codexConfig(readToml(path.join(user, f)), mcp).doc;
      approveBrowserServers(profile, ctx.browserMcp);
      put(home, f, TOML.stringify(profile) + '\n');
    }
    put(home, 'AGENTS.md', ctx.reviewSystem || instructions(agent, ctx.env, mcp));
    put(path.join(home, 'rules'), 'tower-crane.rules', codexRules(agent.disallowedTools, agent.gitPush));
    // auth.json holds a login, .env the variables codex loads at start (an
    // AWS profile or bearer token for Bedrock): both are linked.
    for (const f of ['auth.json', '.env']) link(path.join(user, f), path.join(home, f));
    for (const s of agent.skills) {
      const d = skillDir(s, ctx.env);
      if (d) link(d, path.join(home, 'skills', s));
    }
    // Sessions outlive the home, for usage collected after the agent exits.
    const sessions = path.join(ctx.stateDir, 'homes', '.codex', ctx.agent, 'sessions');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    link(sessions, path.join(home, 'sessions'));
  };
  return { flags, env: { CODEX_HOME: home }, mcp, tools: optIn, write, usageRoot: path.join(ctx.stateDir, 'homes', '.codex', ctx.agent) };
}

function approveBrowserServers(doc, names) {
  const withoutEnv = (v) => {
    if (Array.isArray(v)) return v.map(withoutEnv);
    if (!TOML.isTable(v)) return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/^env(?:_|$)/.test(k) && !/headers/i.test(k)).map(([k, x]) => [k, withoutEnv(x)]));
  };
  for (const name of names) {
    const def = doc.mcp_servers?.[name];
    if (!def) continue;
    const server = withoutEnv(def);
    server.enabled = true;
    server.default_tools_approval_mode = 'approve';
    for (const tool of Object.values(server.tools || {})) {
      if (TOML.isTable(tool)) tool.approval_mode = 'approve';
    }
    doc.mcp_servers[name] = server;
  }
}

// --- agy --------------------------------------------------------------------

const AGY_TOOLS = {
  Bash: ['run_command'],
  Read: ['view_file', 'list_dir'],
  Edit: ['replace_file_content', 'multi_replace_file_content'],
  Write: ['write_to_file'],
  Grep: ['grep_search'],
  Glob: ['find_by_name'],
  WebFetch: ['read_url_content'],
  WebSearch: ['search_web'],
  Agent: ['invoke_subagent', 'define_subagent'],
};

function agyResource(action, target) {
  return `${action}(${resolved(target).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')})`;
}

function agySiblingDenials(stateDir, agent) {
  const peers = new Set();
  for (const parent of ['homes', 'brokers']) {
    const dir = path.join(stateDir, parent);
    if (fs.existsSync(dir)) for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== agent) peers.add(entry.name);
    }
  }
  // A supervisor creates its broker after its home, so reserve both paths.
  return [...peers].sort().flatMap(peer => ['homes', 'brokers'].map(parent =>
    agyResource('read_file', path.join(stateDir, parent, peer))));
}

function refreshAgyPermissions(stateDir) {
  const homes = path.join(stateDir, 'homes');
  for (const entry of fs.readdirSync(homes, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const home = path.join(homes, entry.name);
    if (readJson(path.join(home, 'hook.json'))?.harness !== 'agy') continue;
    const file = path.join(home, 'home', '.gemini', 'antigravity-cli', 'settings.json');
    const settings = readJson(file);
    if (!settings) throw refuse(`cannot refresh agy permissions in ${file}`);
    if (!settings.enableTerminalSandbox) continue;
    if (!Array.isArray(settings.permissions?.deny)) throw refuse(`cannot refresh agy permissions in ${file}`);
    const deny = [...new Set([...settings.permissions.deny, ...agySiblingDenials(stateDir, entry.name)])];
    if (deny.length === settings.permissions.deny.length) continue;
    settings.permissions.deny = deny;
    S.writeAtomic(file, JSON.stringify(settings, null, 2) + '\n');
  }
}

function agy(agent, rung, ctx) {
  const optIn = rung.tools || [];
  const mcp = [...new Set([...(rung.mcp || []), ...ctx.browserMcp])];
  const user = ctx.origin.agy;
  const gemini = path.join(ctx.home, 'home', '.gemini');
  const config = path.join(gemini, 'config');
  const cli = path.join(gemini, 'antigravity-cli');
  const defined = readJson(path.join(user, 'config', 'mcp_config.json'))?.mcpServers || {};
  const missing = mcp.filter(name => !Object.hasOwn(defined, name) || !TOML.isTable(defined[name]));
  if (missing.length) throw refuse(`ladder ${ctx.rungName} opts in MCP server ${missing.join(', ')}, but ${path.join(user, 'config', 'mcp_config.json')} defines no such server`);
  const servers = Object.fromEntries(mcp.map(name => [name, Object.fromEntries(
    Object.entries(defined[name]).filter(([key]) => ['command', 'args', 'url', 'serverUrl', 'cwd', 'authProviderType', 'disabledTools'].includes(key)),
  )]));
  const tools = [...new Set([...agent.tools.flatMap(tool => AGY_TOOLS[tool] || []), ...optIn])];
  const name = `gishra-${path.basename(agent.file, '.md').replace(/^tower-crane-/, '')}`;
  // Agy has no setting-source flag. Refuse workspace MCP and role overrides
  // rather than starting a server or selecting permissions outside this home.
  for (const directory of ['.agents', '.agent', '_agents', '_agent']) {
    const workspace = path.join(ctx.cwd, directory);
    if (Object.keys(readJson(path.join(workspace, 'mcp_config.json'))?.mcpServers || {}).length) {
      throw refuse(`agy isolation cannot load workspace ${directory}/mcp_config.json; opt in servers from the user config with ladder set --mcp`);
    }
    for (const file of [path.join(workspace, 'agents', `${name}.md`), path.join(workspace, 'agents', name, 'agent.md')]) {
      if (fs.existsSync(file)) throw refuse(`agy isolation cannot select ${name} while workspace agent ${file} overrides it`);
    }
  }
  const instructionsFile = path.join(config, 'agents', `${name}.md`);
  const resource = agyResource;
  const stateReads = fs.readdirSync(ctx.stateDir).filter(entry => !['homes', 'brokers'].includes(entry))
    .map(entry => resource('read_file', path.join(ctx.stateDir, entry)));
  const allow = [...stateReads, resource('read_file', ctx.home), resource('read_file', B.dir(ctx.stateDir, ctx.agent)),
    ...agent.skills.map(skill => skillDir(skill, ctx.env)).filter(Boolean).map(dir => resource('read_file', dir)),
    ...Rules.agyProjectRules(ctx.rules || [], ctx.origin).map(rule => resource('read_file', rule.path)),
    ...outsideDirs(agent, ctx).map(dir => resource('write_file', dir)),
    ...mcp.map(server => `mcp(${server}/*)`),
    // Web tools are limited by the selected agent's tool allowlist. Shell
    // networking also needs this grant for fetch, push and package installs.
    'read_url(*)',
  ];
  const deny = agent.disallowedTools.flatMap(tool => {
    const match = /^Bash\((.*):\*\)$/.exec(tool);
    return match ? [`command(${match[1]})`] : [];
  });
  if (agent.sandbox) {
    deny.push('unsandboxed(*)', resource('write_file', ctx.stateDir));
    deny.push(...agySiblingDenials(ctx.stateDir, ctx.agent));
  }
  if (agent.worktree === 'read') deny.push(resource('write_file', ctx.cwd));
  if (!agent.web) deny.push('execute_url(*)');
  const skills = agent.skills.filter(skill => skillDir(skill, ctx.env)).map(skill => path.join(config, 'skills', skill));
  const settings = {
    enableTerminalSandbox: agent.sandbox,
    toolPermission: agent.sandbox ? 'proceed-in-sandbox' : 'always-proceed',
    allowNonWorkspaceAccess: !agent.sandbox,
    permissions: { allow, deny },
  };
  const provider = readJson(path.join(user, 'antigravity-cli', 'settings.json'))?.modelProvider;
  if (provider === 'gemini') settings.modelProvider = provider;
  const write = () => {
    put(cli, 'settings.json', JSON.stringify(settings, null, 2) + '\n');
    put(config, 'mcp_config.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
    put(path.dirname(instructionsFile), path.basename(instructionsFile), [
      '---', `name: ${name}`, `description: ${JSON.stringify(agent.description)}`,
      `tools: ${JSON.stringify(tools)}`, 'mainAgent: true', 'subagent: false', 'model: inherit',
      `commandExecutionPolicy: ${agent.sandbox ? 'sandbox' : 'off'}`,
      `mcpServers: ${JSON.stringify(mcp.map(server => ({ name: server, ...servers[server] })))}`,
      `skills: ${JSON.stringify(skills)}`, 'plugins: []', '---', '', instructions(agent, ctx.env, mcp),
    ].join('\n'));
    for (const skill of agent.skills) {
      const dir = skillDir(skill, ctx.env);
      if (dir) link(dir, path.join(config, 'skills', skill));
    }
    // Agy signs in through the OS keyring or GEMINI_API_KEY. Only MCP OAuth
    // and ADC have credential files; neither is copied into the config home.
    if (mcp.length) link(path.join(user, 'antigravity', 'mcp_oauth_tokens.json'), path.join(gemini, 'antigravity', 'mcp_oauth_tokens.json'));
    link(path.join(ctx.origin.home, '.config', 'gcloud', 'application_default_credentials.json'),
      path.join(ctx.home, 'home', '.config', 'gcloud', 'application_default_credentials.json'));
  };
  return { flags: ['--agent', name, '--disable-slash-commands', ...(agent.sandbox ? ['--sandbox'] : [])],
    env: { XDG_CONFIG_HOME: path.join(ctx.home, 'home', '.config'), XDG_DATA_HOME: path.join(ctx.home, 'home', '.local', 'share') },
    mcp, tools: optIn, write, instructionsFile };
}

// --- homes ------------------------------------------------------------------

// Homes and everything in them are the user's alone: they link to the
// user's credentials.
function put(dir, name, content, mode = 0o600) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, { mode });
  fs.chmodSync(f, mode);
}

// Sandboxes match the paths they mount, which are real paths: a state
// directory reached through a symlink must be named by its target.
function resolved(p) {
  const r = real(p);
  if (r) return r;
  const parent = path.dirname(p);
  return parent === p ? p : path.join(resolved(parent), path.basename(p));
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Points at the user's file instead of copying it, so a credential is never
// written into the state directory and a refreshed token is seen at once.
// The link goes to the file itself, past any link in a parent agent's home,
// so removing that home never breaks this one. Windows creates directory
// junctions without privileges; a file symlink there needs developer mode,
// so it falls back to a hard link.
function link(target, at) {
  const to = real(target);
  if (!to) return;
  fs.mkdirSync(path.dirname(at), { recursive: true, mode: 0o700 });
  const dir = fs.statSync(to).isDirectory();
  try {
    fs.symlinkSync(to, at, dir && process.platform === 'win32' ? 'junction' : dir ? 'dir' : 'file');
  } catch (e) {
    if (dir || !['EPERM', 'EACCES'].includes(e.code)) throw refuse(`cannot link ${at} to ${to} (${e.code || e.message})`);
    fs.linkSync(to, at);
  }
}

// git and gh on the agent's PATH check every call against the agent file.
// masks: claude's sandbox mounts over the paths its protected list names, so
// the shim builds a merge that brings one in with plumbing.
function shims(agent, home, branch, repo, runtime, masks) {
  const bin = path.join(home, 'bin');
  put(home, 'policy.json', JSON.stringify({ ...policy(agent), branch, repo, masks, hook: path.join(home, 'hook.json') }) + '\n');
  for (const tool of ['git', 'gh']) {
    const argv = [process.execPath, path.join(runtime.path, 'lib', 'shim.js'), path.join(home, 'policy.json'), bin, tool];
    put(bin, tool, `#!/bin/sh\nexec ${commandLine(argv)} "$@"\n`, 0o700);
    put(bin, `${tool}.cmd`, `@${argv.map((a) => `"${a}"`).join(' ')} %*\r\n`, 0o700);
  }
}

// The HOME the agent runs with: its own, so a harness finds nothing of the
// user's by default (codex reads skills from $HOME/.agents, for one), with
// links to what git, gh and cloud CLIs need.
// A sandboxed agent's sandbox hides the user's home, so it gets no gh or git
// link: gh uses GH_TOKEN when it finds no config but stops on one it may not
// read, and git gets the config spawn rendered without credential helpers
// (lib/git-config.js). The harness itself, outside the sandbox, still reads
// .aws through its link.
function agentHome(ctx, sandbox, confined) {
  const dir = path.join(ctx.home, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const links = confined ? SANDBOXED_LINKS : HOME_LINKS.filter((f) => !sandbox || f !== '.config/gh');
  for (const f of links) link(path.join(ctx.origin.home, f), path.join(dir, f));
  if (confined) put(dir, '.gitconfig', ctx.gitConfig?.text ?? require('./git-config').TOKEN_ONLY);
  return dir;
}

// Removes homes, per-agent caches and dead brokers before a new home is built.
// Task scratch outlives homes and retires with the worktree.
function prune(stateDir, cacheOf) {
  const dir = path.join(stateDir, 'homes');
  const homes = new Set();
  const brokers = new Set();
  for (const [parent, entries] of [[dir, homes], [path.join(stateDir, 'brokers'), brokers]]) {
    try { for (const name of fs.readdirSync(parent)) entries.add(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const names = new Set([...homes, ...brokers]);
  const claims = brokers.size ? new Set(S.loadState(stateDir).tasks.tasks
    .filter(t => t.claim && Date.parse(t.claim.until) > Date.now()).map(t => t.claim.agent)) : new Set();
  const last = new Map();
  for (const e of S.readEvents(stateDir)) {
    if (['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd) && e.detail && e.detail.agent) last.set(e.detail.agent, e.detail);
  }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const spawned = last.get(n);
    // The supervisor retains the home through backoff and queued hook writes.
    const monitor = spawned?.monitor_pid
      ? P.processState({ pid: spawned.monitor_pid, host: spawned.host, start_ticks: spawned.monitor_start_ticks })
      : 'exited';
    if (!spawned || (monitor === 'exited' && P.exited(spawned))) {
      if (homes.has(n)) {
        removeTree(path.join(dir, n));
        removeTree(cacheOf(n));
      }
      if (brokers.has(n) && !claims.has(n) && B.dead(path.join(B.dir(stateDir, n), B.FILE))) {
        removeTree(B.dir(stateDir, n));
      }
    }
  }
}

// Go extracts modules read-only and Windows refuses to unlink a read-only
// file, so a tree an agent wrote may need write permission back before it goes.
function removeTree(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return;
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
  }
  const open = (q) => {
    let st;
    try {
      st = fs.lstatSync(q);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    fs.chmodSync(q, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const n of fs.readdirSync(q)) open(path.join(q, n));
  };
  open(p);
  fs.rmSync(p, { recursive: true, force: true });
}


const PI_TOOLS = { Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'write', Grep: 'grep', Glob: 'find' };

function pi(agent, rung, ctx) {
  const adapter = hookAdapter(rung, ctx);
  const optIn = rung.tools || [];
  const denied = agent.disallowedTools.flatMap((tool) => PI_TOOLS[tool] ? [PI_TOOLS[tool]] : [])
    .filter((tool) => !optIn.includes(tool));
  const tools = [...new Set([...agent.tools.flatMap((tool) => PI_TOOLS[tool] ? [PI_TOOLS[tool]] : []), ...optIn])]
    .filter((tool) => !denied.includes(tool));
  const flags = [
    '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
    '--tools', tools.join(','), '--append-system-prompt', path.join(ctx.home, 'AGENTS.md'),
    ...adapter.flags,
  ];
  return {
    flags, env: { PI_CODING_AGENT_DIR: ctx.home, PI_CODING_AGENT_SESSION_DIR: path.join(ctx.home, 'sessions') }, mcp: [], tools: optIn,
    write: () => {
      put(ctx.home, 'settings.json', JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [], themes: [], defaultProjectTrust: 'never' }) + '\n');
      put(ctx.home, 'AGENTS.md', instructions(agent, ctx.env));
      link(path.join(ctx.origin.pi, 'auth.json'), path.join(ctx.home, 'auth.json'));
      link(path.join(ctx.origin.pi, 'models.json'), path.join(ctx.home, 'models.json'));
      adapter.write();
    },
  };
}

const RENDER = { claude, codex, opencode, agy, pi };

// JSONC comments and trailing commas are accepted by OpenCode. Preserve
// strings while removing syntax JSON.parse cannot read.
function readJsonc(file) {
  const text = readText(file);
  if (text === null) return {};
  const tokens = text.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[^"/]+|[\/]/g) || [];
  const clean = tokens.filter((s) => !s.startsWith('//') && !s.startsWith('/*')).join('');
  const parts = clean.match(/"(?:\\.|[^"\\])*"|[^"]+/g) || [];
  // A comma before a closing bracket is outside every quoted string.
  const json = parts.map((s) => s.startsWith('"') ? s : s.replace(/,\s*([}\]])/g, '$1')).join('');
  try { return JSON.parse(json); } catch (error) {
    throw refuse(`cannot read ${file}: ${error.message}`);
  }
}

// Config objects merge recursively; arrays and scalar values replace the
// earlier value. Object.fromEntries keeps prototype-shaped names as data.
function mergeOpencode(base, override) {
  if (!TOML.isTable(base) || !TOML.isTable(override)) return override;
  const keys = [...new Set([...Object.keys(base), ...Object.keys(override)])];
  return Object.fromEntries(keys.map((key) => [
    key, Object.hasOwn(override, key)
      ? mergeOpencode(Object.hasOwn(base, key) ? base[key] : undefined, override[key])
      : base[key],
  ]));
}

function opencodeConfig(user, env = {}) {
  const files = [
    path.join(user.dir, 'config.json'), path.join(user.dir, 'opencode.json'), path.join(user.dir, 'opencode.jsonc'),
    ...(user.config ? [user.config] : []),
    ...(user.extra ? [path.join(user.extra, 'opencode.json'), path.join(user.extra, 'opencode.jsonc')] : []),
  ];
  const configs = files.map(readJsonc);
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { configs.push(JSON.parse(env.OPENCODE_CONFIG_CONTENT)); } catch (error) {
      throw refuse(`OPENCODE_CONFIG_CONTENT must be valid JSON: ${error.message}`);
    }
  }
  const out = {};
  for (const config of configs) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw refuse('opencode config must contain a JSON object');
    for (const key of ['model', 'small_model', 'provider', 'mcp']) {
      if (config[key] === undefined) continue;
      out[key] = mergeOpencode(out[key], config[key]);
    }
  }
  return out;
}

const OPENCODE_TOOLS = {
  Bash: 'bash', Read: 'read', Edit: 'edit', Write: 'edit',
  Grep: 'grep', Glob: 'glob', Skill: 'skill', Agent: 'task', WebFetch: 'webfetch', WebSearch: 'websearch',
};

const opencodeTool = (tool) => OPENCODE_TOOLS[tool] || tool;

function opencodePermissions(agent, rung, ctx, mcp) {
  const native = opencodeTool;
  const optIn = (rung.tools || []).map(native);
  const denied = agent.disallowedTools.filter((tool) => /^\w+$/.test(tool)).map(native).filter((tool) => !optIn.includes(tool));
  const tools = [...new Set([...agent.tools.map(native), ...optIn])].filter((tool) => !denied.includes(tool));
  const permission = { '*': 'deny' };
  for (const tool of tools) permission[tool] = 'allow';
  for (const tool of ['webfetch', 'websearch']) permission[tool] = agent.web || tools.includes(tool) ? 'allow' : 'deny';
  permission.skill = tools.includes('skill')
    ? { '*': 'deny', ...Object.fromEntries(agent.skills.map((name) => [name, 'allow'])) } : 'deny';
  const pattern = (dir) => resolved(dir).replace(/\\/g, '/') + '/**';
  const relativePatterns = (dir, action) => {
    const rel = path.relative(resolved(ctx.cwd), resolved(dir));
    return [...new Set([rel + path.sep + '**', rel.replace(/\\/g, '/') + '/**'])].map((p) => [p, action]);
  };
  const writable = [...outsideDirs(agent, ctx), path.join(ctx.home, 'home')];
  // OpenCode's read/edit/patch tools match paths relative to the worktree.
  // A wildcard alone also matches ../, so block escapes before granting
  // the role's named writable directories outside it.
  permission.edit = tools.includes('edit') ? {
    '*': agent.worktree === 'write' ? 'allow' : 'deny',
    '../*': 'deny', '..\\*': 'deny', '/*': 'deny', '\\*': 'deny', '?:/*': 'deny', '?:\\*': 'deny',
    ...Object.fromEntries(writable.flatMap((dir) => relativePatterns(dir, 'allow'))),
  } : 'deny';
  const readable = [ctx.stateDir, ...writable,
    ...agent.skills.map((name) => skillDir(name, ctx.env)).filter(Boolean)];
  permission.external_directory = { '*': 'deny' };
  for (const dir of readable) {
    const base = resolved(dir).replace(/\\/g, '/');
    permission.external_directory[base] = 'allow';
    permission.external_directory[base + '/*'] = 'allow';
  }
  for (const rule of ctx.rules || []) {
    const base = resolved(path.dirname(rule.path)).replace(/\\/g, '/');
    permission.external_directory[base + '/*'] = 'allow';
  }
  if (agent.sandbox) {
    for (const dir of ['homes', 'brokers']) {
      const base = resolved(path.join(ctx.stateDir, dir)).replace(/\\/g, '/');
      permission.external_directory[base] = 'deny';
      permission.external_directory[base + '/*'] = 'deny';
    }
  }
  permission.external_directory[resolved(ctx.home).replace(/\\/g, '/')] = 'allow';
  permission.external_directory[pattern(ctx.home)] = 'allow';
  // The state is readable, but other agents' credentials and broker tokens
  // are private. Later rules open only this dispatch's home.
  if (tools.includes('read') && agent.sandbox) permission.read = {
    '*': 'allow', ...Object.fromEntries([
      ...relativePatterns(path.join(ctx.stateDir, 'homes'), 'deny'),
      ...relativePatterns(path.join(ctx.stateDir, 'brokers'), 'deny'),
      ...relativePatterns(ctx.home, 'allow'),
    ]),
  };
  if (tools.includes('bash')) {
    // Headless run rejects prompts. Named task commands remain permission-level only.
    const bash = { '*': agent.sandbox ? 'deny' : 'allow' };
    const allow = (command) => {
      bash[command] = 'allow';
      bash[command + ' *'] = 'allow';
    };
    if (agent.sandbox) {
      for (const command of ['tower-crane', 'git', 'npm test', 'npm run test', 'npm run test:*',
        'npm run check:*', 'npm run docs:generate', 'node --test', 'node test/*',
        'node scripts/check-shared-files.js', 'node scripts/cli-docs.js',
        'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'stat', 'file', 'readlink', 'realpath', 'which']) allow(command);
      for (const program of [path.join(ctx.home, 'bin', 'git'), path.join(ctx.home, 'bin', 'gh')]) {
        for (const name of [program, program.replace(/\\/g, '/'), JSON.stringify(program)]) allow(name);
      }
      const cli = path.join(ctx.tool.path, 'bin', 'tower-crane.js');
      for (const name of [cli, cli.replace(/\\/g, '/'), JSON.stringify(cli)]) {
        allow(name);
        allow('node ' + name);
      }
    }
    Object.assign(bash, { 'git push': agent.gitPush === 'branch' ? 'allow' : 'deny',
      'git push *': agent.gitPush === 'branch' ? 'allow' : 'deny', gh: 'deny', 'gh *': 'deny' });
    for (const command of policy(agent).gh) {
      bash[`gh ${command}`] = 'allow';
      bash[`gh ${command} *`] = 'allow';
    }
    for (const rule of agent.disallowedTools) {
      const command = /^Bash\((git [^:]+):\*\)$/.exec(rule)?.[1];
      if (command) {
        bash[command] = 'deny';
        bash[command + ' *'] = 'deny';
      }
    }
    permission.bash = bash;
  }
  for (const name of mcp) permission[`${name}_*`] = 'allow';
  return permission;
}

// OpenCode's wellknown auth entries fetch and merge remote configuration.
// Seed only logins; a permanent auth override would hide native OAuth writes.
function opencodeAuth(user, env, model) {
  let auth;
  if (env.OPENCODE_AUTH_CONTENT) {
    try { auth = JSON.parse(env.OPENCODE_AUTH_CONTENT); } catch {
      throw refuse('OPENCODE_AUTH_CONTENT must be a JSON auth object');
    }
  } else auth = readJson(path.join(user.data, 'auth.json')) || {};
  if (!TOML.isTable(auth)) throw refuse('opencode auth must contain an object');
  const provider = model.split('/')[0];
  const logins = Object.fromEntries(Object.entries(auth)
    .filter(([name, value]) => name === provider && TOML.isTable(value) && ['api', 'oauth'].includes(value.type)));
  return logins;
}

// Provider connection and model metadata cross into a home by name and shape,
// as for codex: apiKey, headers, literal env and unrecognized options stay out.
const numbers = v => TOML.isTable(v) && Object.values(v).every(number);
const OPENCODE_MODEL_FIELDS = {
  id: text, name: text, family: text, attachment: boolean, reasoning: boolean, temperature: boolean, tool_call: boolean,
  limit: numbers, cost: numbers, modalities: v => TOML.isTable(v) && Object.values(v).every(strings),
};
const OPENCODE_OPTION_FIELDS = {
  baseURL: text, enterpriseUrl: text, timeout: v => number(v) || v === false, maxRetries: number, setCacheKey: boolean,
  region: text, profile: text, project: text, location: text,
};
const OPENCODE_MCP_FIELDS = { type: text, command: strings, url: text, timeout: number };

function opencodeProvider(doc) {
  const out = keepFields(doc, { npm: text, name: text, api: text, id: text, env: strings, whitelist: strings, blacklist: strings });
  if (TOML.isTable(doc.options)) out.options = keepFields(doc.options, OPENCODE_OPTION_FIELDS);
  if (TOML.isTable(doc.models)) out.models = Object.fromEntries(Object.entries(doc.models)
    .filter(([, v]) => TOML.isTable(v)).map(([k, v]) => [k, keepFields(v, OPENCODE_MODEL_FIELDS)]));
  return out;
}

function opencode(agent, rung, ctx) {
  const home = ctx.home;
  const user = ctx.origin.opencode;
  const source = opencodeConfig(user, ctx.env);
  const mcp = [...new Set(rung.mcp || [])];
  const servers = {};
  for (const name of mcp) {
    const server = source.mcp?.[name];
    if (!TOML.isTable(server) || !['local', 'remote'].includes(server.type)) {
      throw refuse(`ladder ${ctx.rungName} opts in MCP server ${name}, but ${user.dir} defines no local or remote server by that name`);
    }
    servers[name] = { ...keepFields(server, OPENCODE_MCP_FIELDS), enabled: true };
  }
  const permission = opencodePermissions(agent, rung, ctx, mcp);
  const name = `gishra-${path.basename(agent.file, '.md').replace(/^tower-crane-/, '')}`;
  const adapter = hookAdapter(rung, { ...ctx, home });
  const plugin = require('node:url').pathToFileURL(path.join(home, 'hook.mjs')).href;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    ...(typeof source.model === 'string' ? { model: source.model } : {}),
    ...(typeof source.small_model === 'string' ? { small_model: source.small_model } : {}),
    ...(TOML.isTable(source.provider) ? { provider: Object.fromEntries(Object.entries(source.provider)
      .filter(([, v]) => TOML.isTable(v)).map(([k, v]) => [k, opencodeProvider(v)])) } : {}),
    default_agent: name, permission, mcp: servers, instructions: [], plugin: [plugin],
    autoupdate: false, share: 'disabled',
  };
  const xdg = (kind) => path.join(home, kind);
  const env = {
    PWD: resolved(ctx.cwd),
    XDG_CONFIG_HOME: xdg('config'), XDG_DATA_HOME: xdg('data'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: xdg('cache'),
    OPENCODE_CONFIG_DIR: home, OPENCODE_CONFIG: path.join(home, 'opencode.json'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin] }), OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_AUTH_CONTENT: '',
    OPENCODE_TEST_HOME: path.join(home, 'home'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
    // Built-in auth plugins use the selected login; user plugins are excluded
    // by the isolated config sources. Pure mode would also drop our hook.
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '0', OPENCODE_PURE: '0',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_AUTO_SHARE: '0',
  };
  return {
    flags: ['--agent', name], env, mcp, tools: rung.tools || [],
    instructionsFile: path.join(home, 'agents', `${name}.md`),
    write: () => {
      put(home, 'opencode.json', JSON.stringify(config, null, 2) + '\n');
      put(path.join(home, 'agents'), `${name}.md`, [
        '---', `description: ${JSON.stringify(agent.description)}`, 'mode: primary',
        // JSON is a YAML value; OpenCode reads this frontmatter natively.
        `permission: ${JSON.stringify(permission)}`, '---', instructions(agent, ctx.env, mcp),
      ].join('\n'));
      for (const skill of agent.skills) {
        const dir = skillDir(skill, ctx.env);
        if (dir) link(dir, path.join(home, 'skills', skill));
      }
      // Auth writes belong to the agent. A linked active store would let a
      // refresh overwrite the user's omitted wellknown entries.
      const data = path.join(xdg('data'), 'opencode');
      put(data, 'auth.json', JSON.stringify(opencodeAuth(user, ctx.env, rung.model)) + '\n');
      adapter.write();
    },
  };
}

function hookAdapter(rung, ctx) {
  const home = ctx.home;
  const bridge = path.join(ctx.tool.path, 'lib', 'hook-bridge.js');
  // A packaged harness may expose its own executable as process.execPath.
  const preamble = `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst { call: bridgeCall } = require(${JSON.stringify(bridge)});\nconst call = (action, payload) => bridgeCall(action, payload, ${JSON.stringify(process.execPath)});\n`;
  if (rung.harness === 'pi') return {
    flags: ['--extension', path.join(home, 'hook.mjs')], env: {}, mcp: [], tools: [],
    write: () => put(home, 'hook.mjs', preamble + `
export default function(pi) {
  pi.on('before_agent_start', async (event) => {
    const out = call('inbox');
    if (out.context) return { systemPrompt: event.systemPrompt + '\\n\\n' + out.context };
  });
  pi.on('tool_result', async (event) => {
    call('tool', { tool: event.toolName });
    const out = call('inbox');
    if (out.context) return { content: [...event.content, { type: 'text', text: out.context }] };
  });
  pi.on('agent_end', async (event) => {
    const report = (event.messages || []).filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\\n');
    const out = call('stop', { report });
    if (out.block) pi.sendMessage({ customType: 'tower-crane', content: out.context, display: true }, { triggerTurn: true });
  });
}
`),
  };
  if (rung.harness === 'opencode') {
    const plugin = require('node:url').pathToFileURL(path.join(home, 'hook.mjs')).href;
    return {
      flags: [], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [plugin] }) },
      mcp: [], tools: [],
      write: () => put(home, 'hook.mjs', preamble + `
export const TowerCrane = async ({ client }) => {
  let sessionID;
  let delivering = false;
  return {
    'chat.message': async (input, output) => {
      sessionID ??= input.sessionID;
      if (!sessionID || input.sessionID !== sessionID || delivering) return;
      const out = call('inbox');
      if (out.context) output.parts.push({ type: 'text', text: out.context });
    },
    'tool.execute.after': async (input, output) => {
      if (!sessionID || input.sessionID !== sessionID || delivering) return;
      call('tool', { tool: input.tool });
      const out = call('inbox');
      if (out.context) output.output += '\\n\\n' + out.context;
    },
    event: async ({ event }) => {
      if (event.type !== 'session.idle' || !sessionID || event.properties?.sessionID !== sessionID || delivering) return;
      delivering = true;
      try {
        const out = call('inbox', { ack: false });
        if (!out.context) return;
        const result = await client.session.promptAsync({
          path: { id: sessionID },
          body: { parts: [{ type: 'text', text: out.context }] },
        });
        if (result?.error) throw new Error('OpenCode rejected the inbox prompt');
        call('inbox', { ids: out.ids });
      } finally {
        delivering = false;
      }
    },
  };
};
`),
    };
  }
  return { flags: [], env: {}, mcp: [], tools: [], write: () => {} };
}

// The isolation of one spawn on its harness: the flags and env spawn adds and
// a write() that builds the agent's home. Other harnesses get a hook adapter
// and command shims without permission rendering.
function isolation(job, rung, rungName, ctx) {
  const render = RENDER[rung.harness];
  const agent = load(job === 'worker' && rungName === 'research' ? 'researcher' : job);
  const home = path.join(ctx.stateDir, 'homes', ctx.agent);
  const tool = {
    ...toolVersion(),
    path: path.join(home, 'tool'),
  };
  const from = origin(ctx.env, ctx.parentCwd);
  const browserKit = BrowserKit.attachment(ctx.taskSpec, rung.harness, ctx.env, from);
  BrowserKit.requireRoute(ctx.taskSpec, ctx.routes || L.routes(rung), ctx.env, from);
  const browserMcp = browserKit?.attached || [];
  const renderCtx = { ...ctx, job, browserMcp, rungName, home, tool, origin: from };
  const r = render ? render(agent, rung, renderCtx) : hookAdapter(rung, { ...ctx, home, tool });
  // Before rendering, so a dry run refuses what a real start would.
  if (sandboxed(job, rung.harness)) {
    refuseSandboxInStores(renderCtx);
    refuseHiddenRules(renderCtx, [...homeReads(agent, renderCtx), ...[ctx.repo?.root, ctx.cwd].filter(Boolean).map(resolved)]);
  }
  const bin = path.join(home, 'bin');
  const key = pathKey(ctx.env);
  const homeDir = path.join(home, 'home');
  const cache = agent.writeOutside.includes('cache') && (job === 'worker' || render && agent.sandbox)
    ? writableCache({ ...ctx, job }) : null;
  const env = {
    ...r.env, ...(render ? { HOME: homeDir, ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}) } : {}),
    // gh reads config before using GH_TOKEN; inherited paths may be denied.
    // git reads the config rendered into the home, not a user file it may not read.
    ...(render && agent.sandbox ? { GH_CONFIG_DIR: path.join(homeDir, '.config', 'gh') } : {}),
    ...(sandboxed(job, rung.harness) ? { GIT_CONFIG_GLOBAL: path.join(homeDir, '.gitconfig') } : {}),
    ...(cache ? Object.fromEntries(Object.entries(CACHE_ENV).map(([k, sub]) => [k, path.join(cache, sub)])) : {}),
    TOWER_CRANE_SANDBOX: sandboxed(job, rung.harness) ? '1' : '0',
    TOWER_CRANE_HOOK: path.join(home, 'hook.json'),
    [key]: `${bin}${path.delimiter}${ctx.env[key] || ''}`,
  };
  const write = () => {
    const homes = path.join(ctx.stateDir, 'homes');
    fs.mkdirSync(homes, { recursive: true, mode: 0o700 });
    // Homes link to the user's credentials; keep them out of any repository
    // the state directory sits in.
    put(homes, '.gitignore', '*\n');
    prune(ctx.stateDir, (name) => agentCache(ctx, name));
    // A route fallback runs from this snapshot; keep its source while rebuilding.
    if (resolved(ROOT) === resolved(tool.path)) {
      for (const name of fs.readdirSync(home)) if (name !== 'tool') removeTree(path.join(home, name));
    } else {
      removeTree(home);
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    if (resolved(ROOT) !== resolved(tool.path)) {
      for (const name of ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json']) {
        fs.cpSync(path.join(ROOT, name), path.join(tool.path, name), { recursive: true, dereference: true });
      }
      put(tool.path, 'tool.json', JSON.stringify(tool) + '\n');
    }
    put(home, 'tool.json', JSON.stringify(tool) + '\n');
    // The sandbox grants only a directory that exists.
    if (cache) fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    // An orchestrator wakes on events after its home was built, not on history.
    const after = job === 'orchestrator' ? E.readFrom(path.join(ctx.stateDir, 'events.jsonl'), 0).offset : undefined;
    put(home, 'hook.json', JSON.stringify({ agent: ctx.agent, task: ctx.task, state: ctx.stateDir, harness: rung.harness, attempt: ctx.attempt, ...(after === undefined ? {} : { role: job, after }) }) + '\n');
    // A fresh key per home build: the supervisor and hook bridge present it so
    // their CLI children run as engine work for this agent only.
    require('./automation-key').create(home);
    r.write();
    shims(agent, home, ctx.taskSpec?.branch, ctx.projectRepo, tool, rung.harness === 'claude' && sandboxed(job, rung.harness));
    agentHome({ ...ctx, home, origin: from }, Boolean(render) && agent.sandbox, sandboxed(job, rung.harness));
    const mark = JSON.stringify(from) + '\n';
    put(home, ORIGIN, mark);
    put(homeDir, ORIGIN, mark);
    // Refresh every agy home, even when the new sibling uses another harness.
    refreshAgyPermissions(ctx.stateDir);
  };
  const credentialEnv = r.secretEnv || (() => ({}));
  return { home, tool, scratch: job === 'worker' ? cache : null, agent_file: agent.file, instructions_file: r.instructionsFile || null, sandbox: sandboxed(job, rung.harness), browser_kit: browserKit, mcp: r.mcp, tools: r.tools, flags: r.flags, env, gitEnv: r.gitEnv || {}, write, usageRoot: r.usageRoot || null,
    credentialEnv, secretEnv: () => ({ ...ghToken(ctx.env), ...credentialEnv() }) };
}

// Only verified OS isolation gets broker tokens and the nested browser marker.
function sandboxed(job, harness) {
  return module.exports.CAPABILITIES[harness]?.osSandbox === true && load(job).sandbox === true;
}

// What a rung's tools opt-in does, for lib/authority.js. A tool an agent file
// names (claude tool names, codex features) or codex web search re-enables a
// harness built-in inside the same sandbox: builtin. One of REACH changes
// what the sandbox confines: file edits on a read-only rung, memories kept in
// the user's harness home, plugins, a browser, the desktop or connected
// accounts. Anything else, such as a Bash(...) rule, is not a built-in.
const REACH = { claude: ['Edit', 'Write', 'NotebookEdit'], codex: ['memories', 'plugins', 'apps', 'browser_use', 'computer_use'],
  pi: ['edit', 'write'], agy: ['replace_file_content', 'multi_replace_file_content', 'write_to_file', 'invoke_subagent', 'define_subagent'] };
const AGENT_JOBS = ['orchestrator', 'worker', 'reviewer', 'small'];

function optInKind(harness, tool) {
  const normalize = harness === 'opencode' ? opencodeTool : (name) => name;
  tool = normalize(tool);
  if ((REACH[harness] || []).map(normalize).includes(tool)) return 'reach';
  if (harness === 'agy') return Object.values(AGY_TOOLS).flat().includes(tool) ? 'builtin' : 'unknown';
  if (harness === 'pi') return ['read', 'bash', 'grep', 'find', 'ls'].includes(tool) ? 'builtin' : 'unknown';
  const known = harness === 'codex'
    ? ['web_search', ...AGENT_JOBS.flatMap((j) => load(j).codexDisable)]
    : AGENT_JOBS.flatMap((j) => [...load(j).tools, ...load(j).disallowedTools]).filter((t) => /^\w+$/.test(t));
  return known.map(normalize).includes(tool) ? 'builtin' : 'unknown';
}

module.exports = { parse, load, file, isolation, harnessRoots, outsideHome, sandboxed, origin, availableMcp, optInKind, codexConfig, codexRules, policy, ghToken, removeTaskCache, sessionBusEnv, GH_READ, LISTS, CAPABILITIES };
