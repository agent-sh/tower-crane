'use strict';

// Agent files and agent homes. agents/tower-crane-<job>.md says what an agent of
// that job may and may not do. spawn renders it for claude, codex, agy and pi into
// flags and a home of the agent's own, built fresh for every spawn: the
// harness config directory (CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR or agy's ~/.gemini)
// and the HOME the agent runs with. Nothing the user's harness setup holds loads
// unless it is named here, and one agent cannot leave anything for the next.

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
const E = require('./events');
const Rules = require('./rules');

const ROOT = path.join(__dirname, '..');
const LISTS = ['tools', 'disallowedTools', 'mcpServers', 'skills', 'ghWrite', 'writeOutside', 'codexDisable'];
const OUTSIDE = ['state', 'homes', 'git', 'cache', 'worktrees'];
// File tools that change files; acceptEdits approves them inside the
// worktree only, so they are never pre-approved by name.
const EDITS = ['Edit', 'Write', 'NotebookEdit'];
// What the agent's HOME links to in the user's: git, gh and cloud
// credentials and settings, never a harness's own files.
const HOME_LINKS = ['.gitconfig', '.config/git', '.config/gh', '.aws', '.ssh'];
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
// origin file names the user's.
function origin(env) {
  const marked = (dir) => (dir ? readJson(path.join(dir, ORIGIN)) : null);
  const homeMark = marked(os.homedir());
  const home = homeMark ? homeMark.home : os.homedir();
  const claudeMark = marked(env.CLAUDE_CONFIG_DIR);
  let claude;
  if (claudeMark) claude = { dir: claudeMark.claude.dir, json: claudeMark.claude.json };
  else if (env.CLAUDE_CONFIG_DIR) claude = { dir: path.resolve(env.CLAUDE_CONFIG_DIR), json: path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') };
  else if (homeMark) claude = homeMark.claude;
  else claude = { dir: path.join(home, '.claude'), json: path.join(home, '.claude.json') };
  const codexMark = marked(env.CODEX_HOME);
  let codex;
  if (codexMark) codex = codexMark.codex;
  else if (env.CODEX_HOME) codex = path.resolve(env.CODEX_HOME);
  else if (homeMark) codex = homeMark.codex;
  else codex = path.join(home, '.codex');
  const piMark = marked(env.PI_CODING_AGENT_DIR);
  const pi = piMark?.pi || (env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR)
    : homeMark?.pi || path.join(home, '.pi', 'agent'));
  return { home, claude, codex, pi, agy: homeMark?.agy || path.join(home, '.gemini') };
}

// The user's cache root. An XDG_CACHE_HOME that is an agent's own cache came
// from a supervisor started in that agent's env, so it is not the root.
function cacheDir(env, home) {
  if (process.platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdg = env.XDG_CACHE_HOME;
  return xdg && !agentCachePath(xdg) ? xdg : path.join(home, '.cache');
}

// Whether a directory is an agent cache, tower-crane/agents/<state hash>/<agent>, or sits inside one.
function agentCachePath(dir) {
  return /[\\/]tower-crane[\\/]agents[\\/][0-9a-f]{12}(?:[\\/]|$)/.test(path.resolve(dir));
}

// The cache an agent may write: a directory of its own, never the cache root,
// where installed tools, gate commands and spawn receipts live. Agent names
// repeat across projects, so the state directory is part of the path.
function agentCache(ctx, agent = ctx.agent) {
  const state = crypto.createHash('sha256').update(resolved(ctx.stateDir)).digest('hex').slice(0, 12);
  // A fallback rebuild can remove the current home's origin marker.
  return path.join(cacheDir(ctx.env, ctx.origin?.home || origin(ctx.env).home), 'tower-crane', 'agents', state, agent);
}

// Tool caches that would land outside the agent cache: under the cache root,
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

// The directories outside the worktree an agent may write, by writeOutside.
function outsideDirs(agent, ctx) {
  const dirs = [...(ctx.settings?.sandbox.write || [])];
  for (const w of agent.writeOutside) {
    if (w === 'state') dirs.push(ctx.stateDir);
    if (w === 'homes') dirs.push(path.join(ctx.stateDir, 'homes'));
    if (w === 'git') {
      // The repository's git directory and, named on its own, the worktree's
      // admin directory inside it (index, HEAD, FETCH_HEAD): codex keeps a
      // workspace's git directory read-only unless a rule names it. The
      // common directory itself stays writable because every ref update
      // takes packed-refs.lock there; protectedGit() takes back what runs code.
      const { common, own } = gitDirs(ctx);
      if (common) dirs.push(common);
      if (own) dirs.push(own);
    }
    if (w === 'cache') dirs.push(agentCache(ctx));
    if (w === 'worktrees') dirs.push(path.join(path.dirname(ctx.repo.root), `${path.basename(ctx.repo.root).replace(/\.git$/, '')}-worktrees`));
  }
  return dirs.map(resolved);
}

// The repository's common git directory and, for a linked worktree, its own
// admin directory under it (null for the main checkout).
function gitDirs(ctx) {
  const c = ctx.gitDirs?.common || S.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.repo.root);
  const o = ctx.gitDirs ? ctx.gitDirs.own
    : fs.existsSync(ctx.cwd) ? S.git(['rev-parse', '--path-format=absolute', '--git-dir'], ctx.cwd) : null;
  const common = c ? path.resolve(c) : null;
  const own = o && path.resolve(o) !== common ? path.resolve(o) : null;
  return { common, own };
}

// Submodule git directories under modules/, nested ones included. A module
// named a/b lives in modules/a/b, so a directory without HEAD is walked into.
function moduleDirs(dir, depth = 0, out = []) {
  if (depth > 8) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (fs.existsSync(path.join(p, 'HEAD'))) {
      out.push(p);
      moduleDirs(path.join(p, 'modules'), depth + 1, out);
    } else moduleDirs(p, depth + 1, out);
  }
  return out;
}

// What a sandboxed agent that writes the git directory must not write: git
// outside the sandbox (the harness, Tower Crane, the owner) runs commands the
// config, hooks and attributes there name, and commondir, gitdir and the
// worktree's .git file decide which config it reads. Commit, rebase, fetch
// and push write none of these (docs/ladder.md#agent-files-and-homes); a
// push -u would set the upstream in config, so spawn's worktree sets it.
function protectedGit(agent, ctx) {
  if (!agent.sandbox || !agent.writeOutside.includes('git')) return { files: [], dirs: [] };
  const { common, own } = gitDirs(ctx);
  if (!common) return { files: [], dirs: [] };
  const files = [path.join(common, 'config'), path.join(common, 'config.worktree')];
  const dirs = [path.join(common, 'hooks'), path.join(common, 'info')];
  for (const m of moduleDirs(path.join(common, 'modules'))) {
    files.push(path.join(m, 'config'));
    dirs.push(path.join(m, 'hooks'));
  }
  if (own) files.push(...['config.worktree', 'commondir', 'gitdir'].map((f) => path.join(own, f)));
  const dotGit = path.join(ctx.cwd, '.git');
  if (own && fs.existsSync(ctx.cwd) && fs.statSync(dotGit, { throwIfNoEntry: false })?.isFile()) files.push(dotGit);
  return { files, dirs };
}

// The global git config of a sandboxed harness and its agent: a file in the
// generated home, which no agent writes, including the user's own files. A
// codex agent writes its HOME, where ~/.gitconfig and ~/.config/git are
// links it could replace with config naming a command the harness runs.
function gitGlobal(ctx) {
  const xdg = ctx.env.XDG_CONFIG_HOME ? path.resolve(ctx.env.XDG_CONFIG_HOME) : path.join(ctx.origin.home, '.config');
  const files = (ctx.env.GIT_CONFIG_GLOBAL ? [path.resolve(ctx.env.GIT_CONFIG_GLOBAL)]
    : [path.join(xdg, 'git', 'config'), path.join(ctx.origin.home, '.gitconfig')]).filter((f) => fs.existsSync(f));
  const quote = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return { files, text: ['[include]', ...files.map((f) => `\tpath = ${quote(f)}`), ''].join('\n') };
}

// Files the user's global config includes through ~/, which git resolves in
// the agent's HOME: each one, relative to HOME, so a codex agent cannot
// create it there. Followed five includes deep.
function homeIncludes(files, home, depth = 0, out = new Set()) {
  if (depth > 5) return out;
  for (const f of files) {
    let section = '';
    for (const line of (readText(f) || '').split(/\r?\n/)) {
      const head = /^\s*\[\s*([\w.-]+)/.exec(line);
      if (head) section = head[1].toLowerCase();
      const m = /^\s*path\s*=\s*"?([^"#;]*)"?/i.exec(head ? '' : line);
      if (!m || !['include', 'includeif'].includes(section)) continue;
      const value = m[1].trim();
      if (value.startsWith('~/')) {
        const rel = value.slice(2);
        if (out.has(rel)) continue;
        out.add(rel);
        homeIncludes([path.join(home, rel)], home, depth + 1, out);
      } else if (value) homeIncludes([path.resolve(path.dirname(f), value)], home, depth + 1, out);
    }
  }
  return out;
}

// A sandbox masks a missing path with an empty file or skips it, either of
// which leaves the agent free to create it, so each one exists before spawn.
function prepareProtected({ files, dirs }) {
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  for (const f of files) {
    if (fs.existsSync(f)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '', { flag: 'a' });
  }
  return [...files, ...dirs].map(resolved);
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

function availableMcp(harness, from, names) {
  const defined = harness === 'claude' ? claudeMcp(from.claude)
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
  const authority = require('./authority');
  const project = authority.ownerProject(ctx.stateDir);
  const dir = project?.owner_config_dir === undefined
    ? path.join(authority.resolveOwnerConfigDir(ctx.env), 'owner')
    : path.dirname(authority.ownerKeyFile(project));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return resolved(dir);
}

// Bash runs in claude's own sandbox, and stops the agent when the sandbox
// cannot start. allowAllUnixSockets skips the socket filter, whose seccomp
// helper needs a nested user namespace that many hosts refuse; reads of the
// sockets and key directories an agent has no use for are denied instead.
// The state directory is read-only: the state broker writes it. Other
// agents' homes and broker directories are unreadable, so no agent finds
// another's broker token, and so is the owner key.
function claudeSandbox(agent, ctx) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowAllUnixSockets: true, allowLocalBinding: true, allowedDomains: ['*'] },
    filesystem: {
      allowWrite: outsideDirs(agent, ctx),
      denyWrite: [resolved(ctx.stateDir), ...(agent.worktree === 'read' ? [resolved(ctx.cwd)] : []),
        ...prepareProtected(protectedGit(agent, ctx))],
      denyRead: [
        resolved(path.join(ctx.stateDir, 'homes')),
        '/var/run/docker.sock', '/run/docker.sock', ...(uid === null ? [] : [`/run/user/${uid}`]),
        ...(ctx.env.XDG_RUNTIME_DIR && ctx.env.XDG_RUNTIME_DIR !== `/run/user/${uid}` ? [ctx.env.XDG_RUNTIME_DIR] : []),
        path.join(ctx.origin.home, '.ssh'), path.join(ctx.origin.home, '.aws'),
        resolved(path.join(ctx.stateDir, 'brokers')), ownerKeyDir(ctx),
      ],
      allowRead: [resolved(ctx.home), resolved(B.dir(ctx.stateDir, ctx.agent))],
    },
  };
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

// claude checks its own Read, Grep and Glob tools against permission rules,
// never against the sandbox, so every path the sandbox hides is denied to
// them too. A deny rule takes no exception, so the homes and brokers rules
// also cover this agent's own home and broker directory, which Bash still
// reads; denying a whole entry keeps a home or broker spawned later hidden.
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
      own.sandbox = claudeSandbox(agent, ctx);
      own.permissions = { deny: readDenyRules(own.sandbox.filesystem.denyRead) };
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
  return { flags, env: { CLAUDE_CONFIG_DIR: home, ...ClaudeProvider.environment(rung, ctx.env, ctx.origin, undefined, ctx.settings) }, mcp: Object.keys(servers), tools: optIn, write };
}

// claude's sandbox keeps a .claude/.cc-writes/ directory in the worktree; it
// must never be committed.
function exclude(root, pattern, preparedCommon) {
  const common = preparedCommon || S.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
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

// The sandbox for the agent's commands: hide other homes, write the worktree
// (or not), the writeOutside directories and the agent's own HOME, never the
// state directory (the state broker writes it), and never read another
// agent's broker directory. Codex mounts readable paths before it hides a
// directory and writable ones after, so the agent's own broker directory,
// under the hidden brokers/, is writable to stay visible; the broker never
// reads it back.
function permissions(agent, ctx) {
  const fsRules = { ':root': 'read', ':tmpdir': 'write', ':slash_tmp': 'write' };
  for (const d of outsideDirs(agent, ctx)) fsRules[d] = 'write';
  // Read-only carve-outs in the writable git directory, as claude's denyWrite.
  // Other worktrees' admin directories are read-only too: their commondir
  // and gitdir decide which config git reads there.
  const protectedPaths = prepareProtected(protectedGit(agent, ctx));
  if (protectedPaths.length) {
    const { common, own } = gitDirs(ctx);
    if (own && path.dirname(own) === path.join(common, 'worktrees')) {
      fsRules[resolved(path.dirname(own))] = 'read';
      fsRules[resolved(own)] = 'write';
    }
  }
  for (const p of protectedPaths) fsRules[p] = 'read';
  // An include under a HOME link reads the user's own file through it.
  const linked = (rel) => HOME_LINKS.some((l) => rel === l || rel.startsWith(`${l}/`));
  const includes = [...homeIncludes(gitGlobal(ctx).files, ctx.origin.home)].filter((rel) => !linked(rel))
    .map((rel) => path.join(ctx.home, 'home', rel));
  for (const p of prepareProtected({ files: includes, dirs: [] })) fsRules[p] = 'read';
  fsRules[resolved(ctx.stateDir)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes'))] = 'none';
  fsRules[resolved(ctx.home)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes', '.codex', ctx.agent))] = 'write';
  fsRules[resolved(path.join(ctx.stateDir, 'brokers'))] = 'none';
  fsRules[resolved(B.dir(ctx.stateDir, ctx.agent))] = 'write';
  fsRules[ownerKeyDir(ctx)] = 'none';
  fsRules[resolved(path.join(ctx.home, 'home'))] = 'write';
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
function shims(agent, home, branch, repo, runtime) {
  const bin = path.join(home, 'bin');
  put(home, 'policy.json', JSON.stringify({ ...policy(agent), branch, repo, hook: path.join(home, 'hook.json') }) + '\n');
  for (const tool of ['git', 'gh']) {
    const argv = [process.execPath, path.join(runtime.path, 'lib', 'shim.js'), path.join(home, 'policy.json'), bin, tool];
    put(bin, tool, `#!/bin/sh\nexec ${commandLine(argv)} "$@"\n`, 0o700);
    put(bin, `${tool}.cmd`, `@${argv.map((a) => `"${a}"`).join(' ')} %*\r\n`, 0o700);
  }
}

// The HOME the agent runs with: its own, so a harness finds nothing of the
// user's by default (codex reads skills from $HOME/.agents, for one), with
// links to what git, gh and cloud CLIs need.
function agentHome(ctx) {
  const dir = path.join(ctx.home, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of HOME_LINKS) link(path.join(ctx.origin.home, f), path.join(dir, f));
  return dir;
}

// Removes the homes and caches of agents whose process has exited, and of
// spawns that never started. Runs under the state lock, before a new home is
// built. Nothing links into a home, so removing one never breaks another.
function prune(stateDir, cacheOf) {
  const dir = path.join(stateDir, 'homes');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
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
      removeTree(path.join(dir, n));
      removeTree(cacheOf(n));
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

const RENDER = { claude, codex, agy, pi };

function opencodeConfigContent(env, plugin) {
  let config = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    } catch (error) {
      throw refuse(`OPENCODE_CONFIG_CONTENT must be valid JSON: ${error.message}`);
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw refuse('OPENCODE_CONFIG_CONTENT must contain a JSON object');
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : config.plugin == null ? [] : [config.plugin];
  return JSON.stringify({ ...config, plugin: [...plugins, plugin] });
}

function hookAdapter(rung, ctx) {
  const home = ctx.home;
  const bridge = path.join(ctx.tool.path, 'lib', 'hook-bridge.js');
  const preamble = `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst { call } = require(${JSON.stringify(bridge)});\n`;
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
      flags: [], env: { OPENCODE_CONFIG_CONTENT: opencodeConfigContent(ctx.env, plugin) },
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
  const from = origin(ctx.env);
  const browserKit = BrowserKit.attachment(ctx.taskSpec, rung.harness, ctx.env, from);
  BrowserKit.requireRoute(ctx.taskSpec, ctx.routes || L.routes(rung), ctx.env, from);
  const browserMcp = browserKit?.attached || [];
  const r = render ? render(agent, rung, { ...ctx, job, browserMcp, rungName, home, tool, origin: from }) : hookAdapter(rung, { ...ctx, home, tool });
  const bin = path.join(home, 'bin');
  const key = pathKey(ctx.env);
  const homeDir = path.join(home, 'home');
  const cache = render && agent.sandbox && agent.writeOutside.includes('cache') ? agentCache(ctx) : null;
  const env = {
    ...r.env, ...(render ? { HOME: homeDir, ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}) } : {}),
    ...(cache ? Object.fromEntries(Object.entries(CACHE_ENV).map(([k, sub]) => [k, path.join(cache, sub)])) : {}),
    TOWER_CRANE_SANDBOX: sandboxed(job, rung.harness) ? '1' : '0',
    ...(sandboxed(job, rung.harness) ? { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig') } : {}),
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
    r.write();
    shims(agent, home, ctx.taskSpec?.branch, ctx.projectRepo, tool);
    agentHome({ ...ctx, home, origin: from });
    if (sandboxed(job, rung.harness)) put(home, 'gitconfig', gitGlobal({ ...ctx, origin: from }).text);
    const mark = JSON.stringify(from) + '\n';
    put(home, ORIGIN, mark);
    put(homeDir, ORIGIN, mark);
    // Refresh every agy home, even when the new sibling uses another harness.
    refreshAgyPermissions(ctx.stateDir);
  };
  return { home, tool, agent_file: agent.file, instructions_file: r.instructionsFile, sandbox: sandboxed(job, rung.harness), browser_kit: browserKit, mcp: r.mcp, tools: r.tools, flags: r.flags, env, write, usageRoot: r.usageRoot || null, secretEnv: () => ghToken(ctx.env) };
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
  if ((REACH[harness] || []).includes(tool)) return 'reach';
  if (harness === 'agy') return Object.values(AGY_TOOLS).flat().includes(tool) ? 'builtin' : 'unknown';
  if (harness === 'pi') return ['read', 'bash', 'grep', 'find', 'ls'].includes(tool) ? 'builtin' : 'unknown';
  const known = harness === 'codex'
    ? ['web_search', ...AGENT_JOBS.flatMap((j) => load(j).codexDisable)]
    : AGENT_JOBS.flatMap((j) => [...load(j).tools, ...load(j).disallowedTools]).filter((t) => /^\w+$/.test(t));
  return known.includes(tool) ? 'builtin' : 'unknown';
}

module.exports = { parse, load, file, isolation, sandboxed, origin, availableMcp, optInKind, codexConfig, codexRules, policy, ghToken, GH_READ, LISTS, CAPABILITIES };
