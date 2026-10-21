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
// What of a Tower Crane checkout or plugin an agent runs: the snapshot in its
// home copies these, and its sandbox reads only these of the checkout, never
// the checkout's own state directory or git directory.
const RUNTIME = ['bin', 'lib', 'agents', 'skills', 'standards', 'package.json'];
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

// Local CI artifacts, copied as the gate's command wrote them, which can hold what the redacted
// log hides (lib/gates/local-ci.js ARTIFACTS_DIR). Every sandbox hides them like brokers/.
const CI_ARTIFACTS = 'ci-artifacts';

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
  // The worktrees root holds the relocated admin directories (lib/worktree.js),
  // which no sandboxed agent may write.
  if (out.sandbox === true && (out.writeOutside || []).includes('worktrees')) errs.push('writeOutside: the worktrees root holds every task worktree\'s admin directory, so worktrees needs sandbox: false');
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
function skillSource(env) {
  return path.join(env.TOWER_CRANE_PLUGIN_ROOT || ROOT, 'skills');
}

// Agents read role skills from a copy in the state directory's skills/,
// keyed by the skills' content. Never the dispatcher's package root, which can
// be another agent's tool snapshot (automation runs from a worker's) and goes
// when that agent exits; and never a home, which the claude and codex
// sandboxes hide even from its own agent. The state directory is readable in
// both, and no exit prunes the copy. Null when there are no skills.
function skillStore(env, stateDir) {
  const src = skillSource(env);
  const hash = crypto.createHash('sha256');
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else hash.update(`${r}\0`).update(fs.readFileSync(p)).update('\0');
    }
  };
  try {
    walk(src, '');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  return { src, dir: path.join(stateDir, 'skills', hash.digest('hex').slice(0, 16)) };
}

function skillDir(name, ctx) {
  const store = skillStore(ctx.env, ctx.stateDir);
  return store && fs.existsSync(path.join(store.src, name)) ? path.join(store.dir, name) : null;
}

// Copies the skills into their keyed directory once; a copy is complete
// before it takes the name, so a concurrent dispatch reads either nothing or
// all of it. Windows refuses the rename of a tree just written for a moment
// while a scanner or the indexer holds its new files, so it is retried as a
// state write is. A store another dispatch published first is the same copy,
// so the retry ends as soon as it exists.
function writeSkillStore(env, stateDir) {
  const store = skillStore(env, stateDir);
  if (!store || fs.existsSync(store.dir)) return;
  const root = path.dirname(store.dir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  put(root, '.gitignore', '*\n');
  const tmp = fs.mkdtempSync(path.join(root, `.${path.basename(store.dir)}-`));
  try {
    fs.cpSync(store.src, tmp, { recursive: true, dereference: true });
    S.renameRetry(tmp, store.dir, true, () => fs.existsSync(store.dir));
  } catch (error) {
    if (!fs.existsSync(store.dir)) throw error;
  } finally {
    removeTree(tmp);
  }
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
  // A test's explicit cache can itself live below the worker's scratch.
  return /[\\/]tower-crane[\\/](?:agents|tasks)[\\/][0-9a-f]{12}[\\/][^\\/]+$/.test(path.resolve(dir));
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
  return taskCachePath(ctx);
}

// Where a worker spawn will put ctx.task's scratch, for a task none has recorded yet.
function taskCachePath(ctx) {
  const state = crypto.createHash('sha256').update(resolved(ctx.stateDir)).digest('hex').slice(0, 12);
  return path.resolve(cacheDir(ctx.env, ctx.origin?.home || origin(ctx.env).home), 'tower-crane', 'tasks', state, ctx.task);
}

function writableCache(ctx) {
  return ctx.job === 'worker' ? taskCache(ctx) : agentCache(ctx);
}

function removeTaskCache(task) {
  if (task.scratch) removeCache(task.scratch);
}

// A writable cache and the short temp directory a codex agent may have had
// in its place (codexTmp).
function removeCache(dir) {
  // Named from the resolved cache, as codexTmp made it, before it goes.
  const short = shortTmp(dir);
  removeTree(dir);
  if (short) {
    removeTree(short);
    // claudeOwnTmp's fallback, padded or not.
    const parent = path.dirname(short);
    for (const name of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
      if (name.startsWith(`${path.basename(short)}-own`)) removeTree(path.join(parent, name));
    }
  }
}

// Tool caches that would land outside the writable cache: under the cache root,
// or under the agent's HOME, which claude's sandbox does not write.
const CACHE_ENV = { XDG_CACHE_HOME: '', GOCACHE: 'go-build', GOMODCACHE: 'go-mod', npm_config_cache: 'npm' };

// imports are claude @path lines: claude loads those files, and what they
// import, into the agent's context from where they are.
function instructions(agent, ctx, mcp = [], imports = []) {
  const skills = agent.skills.map((s) => [s, skillDir(s, ctx)]).filter(([, d]) => d);
  return [
    agent.body,
    ...(mcp.length ? ['', `Approved MCP servers for this dispatch: ${mcp.join(', ')}. Use browser tools only for the task's UI.`] : []),
    ...(skills.length ? ['', ...skills.map(([s, d]) => `Skill ${s}: read and follow ${path.join(d, 'SKILL.md')}.`)] : []),
    ...(imports.length ? ['', '# House rules', '', 'The user\'s global rules and the repository\'s rule files, general first:', '', ...imports] : []),
    '',
  ].join('\n');
}

// The repository's git directory and, named on its own, the worktree's
// admin directory (index, HEAD, FETCH_HEAD), which for a task worktree lives
// outside it (lib/worktree.js relocateAdmin).
function repoGitDirs(ctx) {
  const { common, own } = gitDirs(ctx);
  return [common, own].filter(Boolean);
}

// The directories outside the worktree an agent may write, by writeOutside.
function outsideDirs(agent, ctx) {
  const dirs = [...(ctx.settings?.sandbox.write || []), ...(ctx.socketDir ? [ctx.socketDir] : [])];
  for (const w of agent.writeOutside) {
    if (w === 'state') dirs.push(ctx.stateDir);
    if (w === 'homes') dirs.push(path.join(ctx.stateDir, 'homes'));
    // codex keeps a workspace's git directory read-only unless a rule names
    // it. The common directory itself stays writable because ref updates and
    // deletions take packed-refs.lock there; protectedGit() takes back what
    // runs code.
    if (w === 'git') dirs.push(...repoGitDirs(ctx));
    if (w === 'cache') dirs.push(writableCache(ctx));
    if (w === 'worktrees') dirs.push(path.join(path.dirname(ctx.repo.root), `${path.basename(ctx.repo.root).replace(/\.git$/, '')}-worktrees`));
  }
  return dirs.map(resolved);
}

// The repository's common git directory and, for a linked worktree, its own
// admin directory under it (null for the main checkout).
function gitDirs(ctx) {
  const c = ctx.gitDirs?.common || S.gitLocation(ctx.repo.root, 'common');
  const o = ctx.gitDirs ? ctx.gitDirs.own
    : fs.existsSync(ctx.cwd) ? S.gitLocation(ctx.cwd, 'own') : null;
  const common = c ? path.resolve(c) : null;
  const own = o && path.resolve(o) !== common ? path.resolve(o) : null;
  // The worktree's `.git` file names this directory and the worker writes
  // that file, so a sandbox is granted only an admin directory of this
  // repository.
  if (own && (!common || !cp.adminOf(own, common))) {
    throw refuse(`${path.join(ctx.cwd, '.git')} names ${own}, which is not a worktree admin directory of ${common || ctx.repo.root}; restore it with git worktree repair before spawning`);
  }
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
// and push write none of these (docs/ladder.md#shared-git-directory); a
// push -u would set the upstream in config, so spawn's worktree sets it.
// remotes/ and branches/ hold legacy remote definitions host git trusts.
// claude adds a linked worktree's common directory to its sandbox's writes
// whatever the settings say, so for claude this covers every sandboxed role
// in one, not only writeOutside: git.
function protectedGit(agent, ctx, harness = null) {
  const none = { files: [], dirs: [] };
  if (!agent.sandbox) return none;
  const { common, own } = gitDirs(ctx);
  if (!common || !(agent.writeOutside.includes('git') || (harness === 'claude' && own))) return none;
  const files = [path.join(common, 'config'), path.join(common, 'config.worktree')];
  const dirs = ['hooks', 'info', 'remotes', 'branches'].map((d) => path.join(common, d));
  for (const m of moduleDirs(path.join(common, 'modules'))) {
    files.push(path.join(m, 'config'));
    dirs.push(path.join(m, 'hooks'));
  }
  if (own) files.push(...['config.worktree', 'commondir', 'gitdir'].map((f) => path.join(own, f)));
  const dotGit = path.join(ctx.cwd, '.git');
  if (own && fs.existsSync(ctx.cwd) && fs.statSync(dotGit, { throwIfNoEntry: false })?.isFile()) files.push(dotGit);
  if (harness === 'claude' && own) dirs.push(...otherWorktrees(common, own));
  return { files, dirs };
}

// The repository's other worktrees, whose commondir and config.worktree
// decide which config git reads there. A task worktree's own admin directory
// lives outside worktrees/ (lib/worktree.js relocateAdmin), so all of
// worktrees/ is read-only, including what is added after launch: codex marks
// it read and claude denies it. For an admin directory still in worktrees/,
// claude's denyWrite, which wins over any write inside it, lists each one
// that exists at launch instead (docs/ladder.md#shared-git-directory). Only
// real directories: a sandbox would protect what a link points to.
function otherWorktrees(common, own) {
  const dir = path.join(common, 'worktrees');
  if (path.dirname(own) !== dir) return fs.existsSync(dir) ? [dir] : [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && path.join(dir, e.name) !== own).map((e) => path.join(dir, e.name));
}

// The global git config of a sandboxed harness and its agent: the config
// lib/git-config.js renders, in a file in the state directory, which no agent
// writes. A codex agent writes its HOME, where a ~/.gitconfig it replaced
// could name a command the harness runs.
const gitGlobalFile = (stateDir, agent) => path.join(stateDir, 'gitconfig', agent);

// A sandbox masks a missing path with an empty file or skips it, either of
// which leaves the agent free to create it, so each one exists before spawn,
// as itself: a sandbox protects what a link points to, and the agent could
// swap the link in the writable directory around it.
function prepareProtected({ files, dirs }) {
  const notItself = (p, what) => refuse(`${p} is ${what}; a sandbox cannot keep it read-only, so replace it with the file itself`);
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    if (!fs.lstatSync(d).isDirectory()) throw notItself(d, 'a link or not a directory');
  }
  for (const f of files) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const fd = openItself(f, () => notItself(f, 'a link'));
    try {
      if (!fs.fstatSync(fd).isFile()) throw notItself(f, 'not a regular file');
    } finally {
      fs.closeSync(fd);
    }
  }
  return [...files, ...dirs].map(resolved);
}

// Opens f, creating it empty when missing, without following a link there.
// Windows has no O_NOFOLLOW; its links need privileges an agent lacks.
function openItself(f, link) {
  const { O_RDONLY, O_CREAT, O_NOFOLLOW } = fs.constants;
  if (O_NOFOLLOW === undefined) {
    if (fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink()) throw link();
    try { fs.closeSync(fs.openSync(f, 'wx')); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return fs.openSync(f, 'r');
  }
  try {
    return fs.openSync(f, O_RDONLY | O_CREAT | O_NOFOLLOW);
  } catch (e) {
    if (e.code === 'ELOOP') throw link();
    throw e;
  }
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

// The code of a Tower Crane checkout or plugin root, and a pinned install's
// tool.json. The root itself can hold a project's state directory, whose
// brokers/ holds tokens and homes/ links to the user's credentials.
function runtimeReads(root) {
  return root ? [...RUNTIME, 'tool.json'].map((name) => path.join(root, name)) : [];
}

// The same for TOWER_CRANE_PLUGIN_ROOT, which must be a Tower Crane checkout or
// plugin: set to the home, or to any other directory, it would open that
// directory's bin/, lib/ and package.json. A root that does not exist opens
// nothing.
function pluginReads(root, home) {
  const r = root && real(root);
  if (!r) return [];
  if (r === home) throw refuse(`TOWER_CRANE_PLUGIN_ROOT ${root} is the user's home ${home}; point it at a Tower Crane checkout or plugin, or unset it`);
  if (within(home, r)) throw refuse(`TOWER_CRANE_PLUGIN_ROOT ${root} holds the user's home ${home}; point it at a Tower Crane checkout or plugin, or unset it`);
  if (!towerCraneRuntime(r)) throw refuse(`TOWER_CRANE_PLUGIN_ROOT ${root} is not a Tower Crane checkout or plugin: its package.json does not name ${PACKAGE_NAME}; point it at one, or unset it`);
  return runtimeReads(r);
}

const PACKAGE_NAME = require('../package.json').name;

function towerCraneRuntime(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

// What a sandboxed agent may read under the user's home. Both sandboxes deny
// the rest of the home, so no list of credential stores is kept: the
// worktree and its git directories, the writable directories, the agent's
// own home, the state directory, the Tower Crane code (runtimeReads), the
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
    ...runtimeReads(ROOT), ...pluginReads(ctx.env.TOWER_CRANE_PLUGIN_ROOT, home), ...nodeInstalls(ctx.env, home), ...harnessRoots(ctx),
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

// The user's gh token, for an agent without an OS sandbox, which can read the
// user's gh login anyway. A sandboxed agent gets none: its broker pushes and
// runs gh (lib/github-broker.js). The token is asked of gh when the agent
// starts and handed to the agent process as GH_TOKEN; it is not written to
// files, argv, dry-run output or events. A token already in the spawning
// environment (GH_TOKEN or GITHUB_TOKEN) passes through as is.
function ghToken(env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return {};
  const exts = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of String(env[pathKey(env)] || '').split(path.delimiter)) {
    // A parent agent's shims are not gh.
    if (!dir || agentShims(dir)) continue;
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

// A PATH directory of an agent's git and gh shims: its parent holds the
// origin mark the agent's home and shim directories get (isolation).
const agentShims = (dir) => fs.existsSync(path.join(dir, '..', ORIGIN));

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
  const stores = [path.join(ctx.stateDir, 'homes'), path.join(ctx.stateDir, 'brokers'), path.join(ctx.stateDir, CI_ARTIFACTS), ownerKeyPath(ctx)].map(resolved);
  for (const field of ['write', 'read']) {
    for (const p of ctx.settings?.sandbox[field] || []) {
      const r = resolved(p);
      const inside = stores.find((dir) => within(r, dir));
      if (inside) throw refuse(`sandbox.${field} path ${p} is inside ${inside}, which the sandbox hides because it holds credentials; name a directory outside it`);
      const holds = field === 'write' && stores.find((dir) => within(dir, r));
      if (holds) throw refuse(`sandbox.write path ${p} holds ${holds}, which the sandbox hides because it holds credentials; an agent that writes ${p} can move it out from under the mask, so name a directory that does not hold it`);
    }
  }
  refuseWriteOverWorktreeLock(ctx);
}

// The worktree lock lives in the state directory and guards the admin
// directories in the worktrees root (lib/worktree.js), which no sandboxed
// agent may write. A sandbox.write path inside the state directory reopens
// it for codex, which mounts a writable path over a read-only parent, and
// one that holds the state directory or the worktrees root lets an agent
// move them, or write every task worktree's admin directory.
function refuseWriteOverWorktreeLock(ctx) {
  const state = resolved(ctx.stateDir);
  const root = ctx.repo?.root;
  const worktrees = root ? resolved(path.join(path.dirname(root), `${path.basename(root).replace(/\.git$/, '')}-worktrees`)) : null;
  for (const p of ctx.settings?.sandbox.write || []) {
    const r = resolved(p);
    if (within(r, state) || within(state, r)) throw refuse(`sandbox.write path ${p} ${r === state || within(state, r) ? 'holds' : 'is inside'} the state directory ${state}, which holds the worktree lock and the state that only the state broker writes; name a directory outside it`);
    if (worktrees && within(worktrees, r)) throw refuse(`sandbox.write path ${p} holds the worktrees root ${worktrees}, which holds every task worktree's admin directory; name a directory that does not hold it`);
  }
}

function runtimeDir(env) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return env.XDG_RUNTIME_DIR || (uid === null ? null : `/run/user/${uid}`);
}

// The environment the worker starts with, env_file included, as spawn-monitor
// layers it. A dry run leaves env_file out: it never reads that file, and
// claudeOwnTmp asks for this environment before any write step, whenever the
// cache root is short enough for claudeTmp.
function workerEnv(ctx) {
  const settings = ctx.preview ? { ...ctx.settings, env_file: undefined } : ctx.settings || {};
  return { ...Settings.cleanAgentEnv(ctx.env), ...Settings.agentEnv(settings) };
}

// The user's session bus, when the project sets sandbox.session_bus. The
// runtime directory stays denied; the bus socket is granted back, read and
// write, and it carries DBUS_SESSION_BUS_ADDRESS. The socket is the one in the
// environment the worker starts with, so it follows env_file and the project's
// env. Spawn refuses while it is missing rather than granting a path that is
// not there. The user manager's private socket stays denied: a scope cannot
// start through the sandbox, and the bus already reaches the same manager.
// claude and codex sandboxes both get it (codexSockets).
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

// The bus variables a claude or codex worker starts with where its launch
// environment names none. spawn-monitor calls this after env_file is layered
// in, so the address names the runtime directory the worker really gets, and
// so the socket sessionBus grants. Dry-run never reads env_file, so it shows none of these.
function sessionBusEnv(harness, settings, env) {
  if (!['claude', 'codex'].includes(harness) || settings?.sandbox?.session_bus !== true) return {};
  const runtime = runtimeDir(env);
  if (!runtime) return {};
  return {
    ...(env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: runtime }),
    ...(env.DBUS_SESSION_BUS_ADDRESS ? {} : { DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, 'bus')}` }),
  };
}

// Hosts a sandboxed claude command reaches through claude's proxy; any
// other gets 403 (measured with Claude Code 2.1.296). Owner decision
// 2026-10-14: an explicit list in place of ['*'], which the proxy honors as
// every host. It names GitHub (git, the API, release and raw downloads),
// the npm registry, and sandbox.domains from the project and rung, where *
// opts back in to every host. claude's own API calls run outside the
// sandbox and need none. The in-process WebFetch and WebSearch tools are
// not gated by this list.
const CLAUDE_DOMAINS = ['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com',
  'raw.githubusercontent.com', 'uploads.github.com', 'registry.npmjs.org'];

// The list holds only the defaults and what the owner approved. A remote's
// host is never added on its own: the orchestrator may add a remote, and
// that would widen every claude agent's egress without an owner decision.
// A localhost or tailnet remote would also open every port and service on
// that host, since the proxy skips its loopback and private-address checks
// for a listed name. A remote the list does not cover is named in a notice.
function claudeDomains(ctx) {
  const all = [...new Set([...CLAUDE_DOMAINS, ...(ctx.settings?.sandbox?.domains || [])])];
  const bad = Settings.domainProblems(all);
  if (bad.length) throw refuse(`sandbox.domains: ${bad.join('; ')}; fix sandbox.domains`);
  return all;
}

function remoteNotice(ctx, domains) {
  const left = (ctx.remoteHosts || []).filter((h) => !Settings.domainCovered(domains, h));
  if (!left.length) return null;
  const named = left.map((h) => {
    const kind = hostKind(h);
    return kind === 'name' ? h : `${h} (${kind})`;
  });
  return `claude's sandbox does not allow the repository's remote host ${named.join(', ')}, so commands that reach it get 403 from claude's proxy; an owner allows a host with sandbox.domains (project set --sandbox or ladder set --sandbox)`;
}

// The hosts of the repository's remotes, fetch and push URLs after git's
// own rewriting (insteadOf), for https, ssh and scp-style URLs, each with
// the URL's port when it names one, and an http or https URL's default port
// (80, 443) when it does not, which is the port claude's proxy is asked for.
// A local path names none. Spawn reads
// them before it takes the state lock, where git cannot run.
function remoteHosts(cwd, env) {
  const git = (args) => {
    const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
    return r.status === 0 ? String(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean) : [];
  };
  const hosts = new Set();
  for (const remote of git(['remote'])) {
    for (const url of [...git(['remote', 'get-url', '--all', remote]), ...git(['remote', 'get-url', '--push', '--all', remote])]) {
      const host = urlHost(url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts];
}

// host or host:port, an IPv6 literal in brackets, lower case.
function urlHost(url) {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d*))?(?:[/?#]|$)/i.exec(url);
  if (scheme) {
    if (/^file:/i.test(url)) return null;
    const host = scheme[1].toLowerCase();
    const port = scheme[2] ? Number(scheme[2]) : ({ http: 80, https: 443 })[url.split(':')[0].toLowerCase()] || 0;
    return port >= 1 && port <= 65535 ? `${host}:${port}` : host;
  }
  // scp-like user@host:path; a Windows drive letter is a path.
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)/.exec(url);
  return scp && scp[1].length > 1 ? scp[1].toLowerCase() : null;
}

// What a remote host is, for the notice: a name, or the address class the
// proxy would otherwise refuse to reach.
function hostKind(entry) {
  const net = require('node:net');
  let host = /^(\[[^\]]+\]|[^:]+)/.exec(entry)?.[1] || entry;
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) host = mapped[1];
  if (net.isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127) return 'loopback';
    if (a === 169 && b === 254) return 'link-local address';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private address';
    if (a === 100 && b >= 64 && b <= 127) return 'shared address space, such as a tailnet';
    return 'IP literal';
  }
  if (net.isIP(host) === 6) {
    if (host === '::1') return 'loopback';
    if (/^fe[89ab]/i.test(host)) return 'link-local address';
    if (/^f[cd]/i.test(host)) return 'private address';
    return 'IP literal';
  }
  return host.includes('.') ? 'name' : 'single-label name claude cannot list';
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
// inside it, so homes/ is hidden again inside the reopened state directory,
// and whatever is made in the home later is hidden as well.
function claudeSandbox(agent, ctx, reads, bus = null) {
  stateMasks(ctx);
  const env = workerEnv(ctx);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowAllUnixSockets: true, allowLocalBinding: true, allowedDomains: claudeDomains(ctx) },
    filesystem: {
      allowWrite: [...outsideDirs(agent, ctx), ...(claudeTmp(ctx) ? [claudeTmp(ctx)] : []), ...(bus ? bus.sockets : [])],
      denyWrite: [...existing([resolved(ctx.stateDir), ...(claudeTmp(ctx) && claudeOwnTmp(ctx) ? [claudeOwnTmp(ctx)] : [])]), ...(agent.worktree === 'read' ? readOnlyWorktree(ctx.cwd) : []),
        ...existing(prepareProtected(protectedGit(agent, ctx, 'claude')))],
      denyRead: existing([
        resolved(ctx.origin.home),
        resolved(path.join(ctx.stateDir, 'homes')),
        // /run whole (runDirs), and a runtime directory outside it: the
        // worker env may name another runtime; the spawning one stays denied too.
        ...runDirs(),
        ...[...new Set([ctx.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR])].filter((dir) => dir && !runDirs().some((r) => within(resolved(dir), r))),
        resolved(path.join(ctx.stateDir, 'brokers')), resolved(path.join(ctx.stateDir, CI_ARTIFACTS)), ownerKeyDir(ctx),
      ]),
      allowRead: [...new Set([...reads, resolved(ctx.home), resolved(B.dir(ctx.stateDir, ctx.agent)), ...runReads(ctx.env), ...(claudeTmp(ctx) ? [claudeTmp(ctx)] : []),
        ...(claudeTmp(ctx) && claudeOwnTmp(ctx) ? [claudeOwnTmp(ctx)] : []), ...(ctx.socketDir ? [ctx.socketDir] : []), ...(bus ? bus.sockets : [])])],
    },
  };
}

// A read-only worktree's denyWrite entries: each protected dotfile the
// worktree lacks, then the worktree. claude writes the worktree, binds an
// empty placeholder over each such dotfile, and binds denyWrite paths
// read-only in the order given. Under the hidden home it remounts the
// worktree writable and binds every placeholder, so each must come before
// the worktree turns read-only: bubblewrap cannot make a placeholder in a
// read-only directory, and the command would not start. The placeholders
// land in the worktree as they do for a worker, under the same exclude file
// and cleanup.
function readOnlyWorktree(cwd) {
  const root = resolved(cwd);
  if (!fs.existsSync(root)) return [];
  const present = new Set(ClaudeSandboxPlaceholders.present(root));
  return [...ClaudeSandboxPlaceholders.FILES.filter((f) => !present.has(f)).map((f) => path.join(root, ...f.split('/'))), root];
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
      if (claudeTmp(ctx)) {
        ownDir(claudeTmp(ctx));
        if (claudeOwnTmp(ctx)) ownDir(claudeOwnTmp(ctx));
      }
      own.sandbox = claudeSandbox(agent, ctx, reads, sessionBus(agent, ctx));
      // readGuard covers the home for those tools.
      const userHome = resolved(ctx.origin.home);
      own.permissions = { deny: readDenyRules(own.sandbox.filesystem.denyRead.filter((p) => p !== userHome)) };
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
    put(home, 'CLAUDE.md', ctx.reviewSystem ? '' : instructions(agent, ctx, mcp, require('./rules').claudeImports(ctx.rules || [])));
    // A file keeps the shared reviewer prefix off argv, which Windows caps at 32,767 characters.
    if (ctx.reviewSystem) put(home, 'system.md', ctx.reviewSystem);
    put(home, '.claude.json', '{}\n');
    link(path.join(user.dir, '.credentials.json'), path.join(home, '.credentials.json'));
  };
  const tmp = agent.sandbox ? claudeTmp(ctx) : null;
  const notices = agent.sandbox ? [remoteNotice(ctx, [...CLAUDE_DOMAINS, ...(ctx.settings?.sandbox?.domains || [])]),
    tmp ? null : `claude's proxy sockets need a TMPDIR of at most ${require('./gate-tmp').HARNESS_TMPDIR_MAX} bytes and the agent's own, ${codexTmp(ctx)}, is longer, so the agent keeps the caller's TMPDIR ${ctx.env.TMPDIR || os.tmpdir()}: under the home, which the sandbox hides, https from its commands fails, and under /tmp other agents' proxy sockets are in its reach; a shorter cache root (XDG_CACHE_HOME) avoids this`].filter(Boolean) : [];
  const own = tmp ? claudeOwnTmp(ctx) : null;
  if (tmp && !own) notices.push(`no directory for claude's own temp files keeps its messaging socket within ${CLAUDE_SOCKET_MAX} bytes, so claude keeps them in its commands' TMPDIR ${path.join(tmp, claudeUidDir())}, where a command can change them; XDG_RUNTIME_DIR, a shorter state directory path or a shorter cache root (XDG_CACHE_HOME) avoids this`);
  const tmpSpec = tmp ? { dir: tmp, ...(own ? { own } : {}) } : null;
  return { flags, tmp, tmpSpec, notices, env: { CLAUDE_CONFIG_DIR: home, ...ClaudeProvider.environment(rung, ctx.env, ctx.origin, undefined, ctx.settings), ...(tmp ? ownTmpEnv(tmpSpec, ctx.env) : {}) }, gitEnv, mcp: Object.keys(servers), tools: optIn, write };
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
  for (const d of ['homes', 'brokers', CI_ARTIFACTS]) fs.mkdirSync(path.join(ctx.stateDir, d), { recursive: true, mode: 0o700 });
}

function existing(paths) {
  return paths.filter((p) => fs.existsSync(p));
}

// What codex reads outside the user's home without naming it: each entry of
// the root but the one that holds the home. /dev and /proc are left to
// codex's own mounts, and /tmp stays out, since the agent's TMPDIR is its
// own (codexTmp). Links are left out: codex binds a link's target and never
// makes the link, so /bin and /lib come from :minimal instead. The
// directories below the root on the way to the home are not listed entry
// by entry: /home, or a test's temp directory, can hold
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
    if (p === next || ['dev', 'proc', 'tmp', 'run'].includes(name)) continue;
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
// it back. The same holds inside homes/: the agent's own homes/<agent> stays
// hidden whatever its read rule says, and only its HOME, with the shims
// read-only inside it (codexShims), and its codex sessions show. The agent's
// temp directory is named, never :tmpdir or
// :slash_tmp: codex resolves :tmpdir from the TMPDIR it starts with, and the
// caller's can hold other tasks' scratch and test fixtures; :slash_tmp is the
// host's /tmp, shared with every other process.
function permissions(agent, ctx) {
  stateMasks(ctx);
  const fsRules = { ':minimal': 'read' };
  const home = resolved(ctx.origin.home);
  const reads = agentReads(agent, ctx);
  const outside = outsideHome(home);
  for (const p of [...outside, ...outsideReads(reads.outside, ctx, home, outside), ...reads.home, ...runReads(ctx.env)]) fsRules[p] = 'read';
  for (const d of outsideDirs(agent, ctx)) fsRules[d] = 'write';
  // A worker's or reviewer's writable cache already holds it.
  const tmp = codexTmp(ctx);
  if (!Object.keys(fsRules).some((p) => fsRules[p] === 'write' && within(tmp, p))) fsRules[tmp] = 'write';
  // Read-only carve-outs in the writable git directory, as claude's denyWrite.
  // worktrees/ is read-only too, all but the agent's own admin directory
  // when it is still there (otherWorktrees).
  const protectedPaths = prepareProtected(protectedGit(agent, ctx));
  if (protectedPaths.length) {
    const { common, own } = gitDirs(ctx);
    const worktrees = path.join(common, 'worktrees');
    if (own && fs.existsSync(worktrees)) {
      fsRules[resolved(worktrees)] = 'read';
      fsRules[resolved(own)] = 'write';
    }
  }
  for (const p of protectedPaths) fsRules[p] = 'read';
  // git's config in HOME (agentHome): git reads the one GIT_CONFIG_GLOBAL
  // names, and this copy stays as rendered.
  const homeGit = path.join(ctx.home, 'home', '.gitconfig');
  if (fs.existsSync(homeGit)) fsRules[resolved(homeGit)] = 'read';
  // The shims, read-only inside the writable HOME (codexShims).
  fsRules[resolved(codexShims(ctx))] = 'read';
  hideCallerTmp(fsRules, ctx, home);
  fsRules[resolved(ctx.stateDir)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes'))] = 'none';
  fsRules[resolved(ctx.home)] = 'read';
  fsRules[resolved(path.join(ctx.stateDir, 'homes', '.codex', ctx.agent))] = 'write';
  fsRules[resolved(path.join(ctx.stateDir, 'brokers'))] = 'none';
  fsRules[resolved(path.join(ctx.stateDir, CI_ARTIFACTS))] = 'none';
  fsRules[resolved(B.dir(ctx.stateDir, ctx.agent))] = 'write';
  if (fs.existsSync(ownerKeyDir(ctx))) fsRules[ownerKeyDir(ctx)] = 'none';
  fsRules[resolved(path.join(ctx.home, 'home'))] = 'write';
  const listed = codexSockets(fsRules, agent, ctx);
  // A hidden path inside a hidden directory makes codex mount over a path in
  // a masked, read-only parent.
  const none = Object.keys(fsRules).filter((p) => fsRules[p] === 'none');
  for (const p of none) if (none.some((dir) => p !== dir && within(p, dir))) delete fsRules[p];
  fsRules[':workspace_roots'] = { '.': agent.worktree };
  profileFits(fsRules, ctx, listed);
  return { 'tower-crane': { filesystem: fsRules, network: { enabled: true } } };
}

// codex passes its sandbox the filesystem profile as one JSON argument, and
// Linux caps one argument at 128 KiB with its NUL (MAX_ARG_STRLEN). Past it
// codex fails with "Argument list too long" and names nothing, so spawn
// refuses first. The size follows codex-cli 0.162.1's argument: one entry
// per rule, the workspace root as the working directory's path.
const CODEX_ARG_MAX = 128 * 1024 - 1;

function codexProfileBytes(fsRules, cwd) {
  const entries = Object.entries(fsRules).flatMap(([p, access]) => {
    if (p === ':workspace_roots') return Object.values(access).map((a) => ({ path: { type: 'path', path: resolved(cwd) }, access: a }));
    if (p.startsWith(':')) return [{ path: { type: 'special', value: { kind: p.slice(1) } }, access }];
    return [{ path: { type: 'path', path: p }, access }];
  });
  return Buffer.byteLength(JSON.stringify({ type: 'managed', file_system: { type: 'restricted', entries }, network: 'enabled' }));
}

function profileFits(fsRules, ctx, listed = []) {
  const bytes = codexProfileBytes(fsRules, ctx.cwd);
  if (bytes <= CODEX_ARG_MAX) return;
  const why = `the codex sandbox profile would be ${bytes} bytes, over the ${CODEX_ARG_MAX} codex can pass its sandbox`;
  const most = [...listed].sort((a, b) => b.count - a.count)[0];
  if (most) throw refuse(`sandbox.session_bus: ${why}. The runtime directory lies under a path the sandbox reads, so the profile names each entry of the directories on the way to it, and ${most.dir} holds ${most.count}; move XDG_RUNTIME_DIR, clear ${most.dir}, or unset sandbox.session_bus`);
  throw refuse(`${why}; name fewer sandbox.read and sandbox.write paths`);
}

// The caller's temp directory, when it lies outside the home and away from
// /tmp, is readable through an entry of /: /var/tmp on Linux, /var/folders
// through /private on macOS, where /private/tmp is /tmp. Each is hidden,
// unless a path the agent needs lies in it: codex mounts readable paths
// before hidden ones, so hiding it would hide that path too.
function hideCallerTmp(fsRules, ctx, home) {
  const named = Object.keys(fsRules).filter((p) => !p.startsWith(':') && fsRules[p] !== 'none');
  const needed = [...named, resolved(ctx.cwd), resolved(ctx.stateDir)];
  // The project's env and env_file can name one too; the agent never gets
  // it (the temp env wins, ownTmpEnv), but the directory stays hidden.
  const env = workerEnv(ctx);
  const tmps = [ctx.env.TMPDIR, ctx.env.TMP, ctx.env.TEMP, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter((t) => t && path.isAbsolute(t));
  for (const t of new Set(tmps.map(resolved))) {
    if (t === '/tmp' || within(t, home) || within(home, t) || !fs.existsSync(t)) continue;
    if (!named.some((p) => fsRules[p] === 'read' && within(t, p))) continue;
    if (needed.some((p) => within(p, t))) continue;
    fsRules[t] = 'none';
  }
}

// /run holds the host's sockets: the system and session buses, systemd's
// varlink and journal sockets, snapd, docker, sshd and others. With network
// on, neither sandbox blocks connect() on a Unix socket (measured
// 2026-10-14, codex-cli 0.162.1: a codex agent connected to the session bus
// and docker.sock, and systemd-run --user touched a file on the host; a
// claude agent connected to the system bus and snapd). Both sandboxes hide
// /run, and /var/run where it is a directory of its own, and allow back only
// runReads and, with sandbox.session_bus, the bus socket. Linux only: on
// macOS /var/run is /private/var/run, where DNS asks mDNSResponder's socket,
// and Docker Desktop's socket there links into the hidden home; Windows has
// no /run.
function runDirs() {
  if (process.platform !== 'linux') return [];
  return [...new Set(existing(['/run', '/var/run']).map(resolved))];
}

// What an agent needs under /run: the resolver configuration
// /etc/resolv.conf links to (systemd-resolved's stub, NetworkManager's or
// resolvconf's), systemd-resolved's directory, whose varlink socket
// nss-resolve asks, and the PATH directories there (NixOS keeps
// /run/current-system/sw/bin and /run/wrappers/bin).
function runReads(env) {
  const runs = runDirs();
  if (!runs.length) return [];
  const under = (p) => runs.some((r) => within(p, r));
  const out = new Set();
  const conf = resolved('/etc/resolv.conf');
  if (fs.existsSync(conf) && under(conf)) out.add(path.dirname(conf));
  for (const p of existing(['/run/systemd/resolve'])) out.add(resolved(p));
  for (const dir of String(env[pathKey(env)] || '').split(path.delimiter).filter(Boolean)) {
    const r = resolved(dir);
    if (under(r) && fs.existsSync(r)) out.add(r);
  }
  return [...out];
}

// The runtime directories and /run as codex sees them. outsideHome leaves
// /run out, so it is mounted only where runReads names it; /var/run, where it
// is no link to /run, and a runtime directory outside /run are hidden where a
// readable rule exposes them. sandbox.session_bus keeps the bus socket
// reachable, as for claude, and mounts it alone. codex cannot reopen it
// inside a hidden directory: a readable path is mounted before the hidden
// one, and a writable one must be a directory, since codex mounts a .git
// guard in it. So a runtime directory exposed that way is left unmounted
// instead (readAround), and an entry made there after spawn stays out of
// reach, as it does under /run.
function codexSockets(fsRules, agent, ctx) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const env = workerEnv(ctx);
  const named = Object.keys(fsRules).filter((p) => !p.startsWith(':') && fsRules[p] !== 'none');
  const hide = existing([...runDirs(), ...(uid === null ? [] : [`/run/user/${uid}`]), ctx.env.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR]
    .filter((p) => p && path.isAbsolute(p)));
  const bus = sessionBus(agent, ctx)?.sockets || [];
  const listed = [];
  for (const p of new Set(hide.map(resolved))) {
    const holds = bus.some((sock) => sock !== p && within(sock, p));
    const whole = holds && wholeMount(p, fsRules, minimalDirs(), resolved(ctx.cwd));
    if (whole) throw refuse(whole);
    if (!named.some((r) => within(p, r) && fsRules[r] === 'read' && r !== p)) continue;
    if (holds) listed.push(...readAround(fsRules, p));
    else fsRules[p] = 'none';
  }
  for (const sock of bus) fsRules[sock] = 'read';
  return listed;
}

// Why codex would mount the runtime directory dir whole, or null. A
// writable rule mounts all of it, :workspace_roots the agent's worktree,
// read or write, and :minimal its system directories; none leaves it out,
// so the bus cannot come alone.
function wholeMount(dir, fsRules, system, worktree) {
  if (worktree && within(dir, worktree)) return `sandbox.session_bus: the runtime directory ${dir} lies in the agent's worktree ${worktree}, which the codex sandbox mounts whole, so codex would mount all of it; set XDG_RUNTIME_DIR outside the worktree`;
  const writes = Object.keys(fsRules).find((r) => !r.startsWith(':') && fsRules[r] === 'write' && within(dir, r));
  if (writes) return `sandbox.session_bus: the runtime directory ${dir} lies in ${writes}, which the codex sandbox writes, so codex would mount all of it; take ${writes} out of sandbox.write or move XDG_RUNTIME_DIR`;
  const sys = system.find((d) => within(dir, d));
  if (sys) return `sandbox.session_bus: the runtime directory ${dir} lies in ${sys}, which the codex sandbox mounts whole, so codex would mount all of it; move XDG_RUNTIME_DIR`;
  return null;
}

// What codex's :minimal mounts whole (codex-cli 0.162.1), as real paths.
function minimalDirs() {
  if (process.platform !== 'linux') return [];
  return [...new Set(existing(['/bin', '/etc', '/lib', '/lib64', '/sbin', '/usr']).map(resolved))];
}

// Leaves dir unmounted under the readable rules that hold it, so a path
// inside it that a rule names, the bus socket, is mounted alone. Each such
// rule gives way to the entries of the directories from it down to dir, all
// but the one on the way. An entry another rule names keeps that rule. An
// entry made in one of those directories after spawn is not mounted either.
// Returns how many entries each directory added, for profileFits.
function readAround(fsRules, dir) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const listed = [];
  for (const r of Object.keys(fsRules)) {
    if (r.startsWith(':') || fsRules[r] !== 'read' || r === dir || !within(dir, r)) continue;
    delete fsRules[r];
    for (let at = r; at !== dir;) {
      const next = path.join(at, path.relative(at, dir).split(path.sep)[0]);
      let names = [];
      let parent = null;
      try {
        parent = fs.lstatSync(at);
        names = fs.readdirSync(at);
      } catch { /* an unlistable directory adds nothing */ }
      let count = 0;
      for (const name of names) {
        const p = path.join(at, name);
        if (p === next || fsRules[p] !== undefined) continue;
        try {
          if (steadyEntry(parent, fs.lstatSync(p), uid)) {
            fsRules[p] = 'read';
            count++;
          }
        } catch { /* gone since the listing */ }
      }
      if (count) listed.push({ dir: at, count });
      at = next;
    }
  }
  return listed;
}

// Whether an entry readAround lists stays what it was at spawn. codex binds
// each path again for every command and follows a link there, so an entry
// someone else turns into a link after spawn would expose the link's target.
// So an entry is listed only when root or the user owns both it and its
// directory, and the directory is either writable by its owner alone or
// sticky, where only an entry's owner can rename it. Links are never listed,
// as in outsideHome.
function steadyEntry(parent, entry, uid) {
  if (!parent || entry.isSymbolicLink()) return false;
  if (uid === null) return true;
  const ours = (st) => st.uid === 0 || st.uid === uid;
  const shared = (parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0;
  return ours(parent) && !shared && ours(entry);
}

// Chromium makes its singleton socket at
// $TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket (Chrome:
// com.google.Chrome.XXXXXX), and a socket address holds 107 bytes. Measured
// 2026-10-14: Playwright's Chromium 1243 starts with a 62-byte TMPDIR and
// fails at 63 with "Socket path too long", Chrome 66 and 67. A browser the
// agent or its MCP server starts inherits the agent's TMPDIR.
const AGENT_TMP_MAX = 62;

// A sandboxed codex agent's TMPDIR: a directory of its own, never the
// caller's TMPDIR. It is tmp in its writable cache (the task scratch for a
// worker) when that fits AGENT_TMP_MAX, else the shorter shortTmp. That fits
// for a cache root of up to 46 bytes (/home/<user>/.cache for a user name of
// up to 34 letters); under a deeper root, such as a test fixture's, the
// agent still gets its own directory, and a browser it starts fails.
// A sandboxed claude agent's TMPDIR, the same directory as codex's
// (codexTmp). claude makes its HTTP and SOCKS proxy bridge sockets there
// and its sandbox mounts them for the agent's commands, which write their
// own temp files and cwd tracking files in <TMPDIR>/claude-<uid> there.
// Found 2026-10-14: with the caller's TMPDIR under the home, which the
// sandbox hides, every https request from a command failed with "Proxy
// CONNECT aborted". socat takes a TMPDIR of at most 73 bytes for those
// sockets (gate-tmp.js). codexTmp already takes <cache root>/tc/<hex> when
// tmp in the cache is long, which fits for a cache root of up to 57 bytes;
// under a deeper one, such as a test fixture's, the caller's TMPDIR stays
// and spawn says so in a notice (claude).
function claudeTmp(ctx) {
  const dir = codexTmp(ctx);
  return require('./gate-tmp').harnessFits(dir) ? dir : null;
}

// Where claude keeps its own temp files: CLAUDE_CODE_TMPDIR, which its
// commands read and cannot write. claude binds its per-user directory there
// writable for its commands, after denyWrite and before allowRead (measured
// on Linux, 2.1.301), so the directory is in allowRead, whose read-only bind
// covers it, and in denyWrite for a sandbox that applies rules, not mounts.
// Claude Code (2.1.301) keeps its per-user temp files (prompts, plugin
// staging, task output, fs probes) in <CLAUDE_CODE_TMPDIR or
// TMPDIR>/claude-<uid> and reads them back. A command's TMPDIR is that same
// directory when the path is at most 44 bytes, else <TMPDIR>/claude-<uid>.
// With TMPDIR alone, as before, the commands wrote claude's own files (found
// in the T276 review, measured 2026-10-15). The directory is padded past 44
// bytes so the commands get the second, in claudeTmp.
// claude also makes its messaging socket at <XDG_RUNTIME_DIR or
// CLAUDE_CODE_TMPDIR or TMPDIR>/cc-socks/<pid>.sock, and past 103 bytes in
// /tmp/cc-socks-<uid>, which every claude of the user shares. Without
// XDG_RUNTIME_DIR, as on macOS, CLAUDE_CODE_TMPDIR must keep that path in
// bounds: tmp in the agent's home when it does, else <cache root>/tc/<hex>-own
// beside claudeTmp, else none, and spawn says so.
const CLAUDE_SHARED_TMP_MAX = 44;
const CLAUDE_SOCKET_MAX = 103;
const CLAUDE_SOCKET = path.join('cc-socks', '4194304.sock');
const claudeUidDir = () => `claude-${typeof process.getuid === 'function' ? process.getuid() : 0}`;

function claudeOwnTmp(ctx) {
  const runtime = workerEnv(ctx).XDG_RUNTIME_DIR;
  const fits = (dir) => Buffer.byteLength(path.join(runtime || dir, CLAUDE_SOCKET)) <= CLAUDE_SOCKET_MAX;
  const short = shortTmp(writableCache(ctx));
  for (const dir of [path.join(ctx.home, 'tmp'), short && `${short}-own`].filter(Boolean)) {
    const pad = CLAUDE_SHARED_TMP_MAX + 1 - Buffer.byteLength(path.join(dir, claudeUidDir()));
    const padded = pad > 0 ? `${dir}-${'x'.repeat(pad)}` : dir;
    if (fits(padded)) return padded;
  }
  return null;
}

function codexTmp(ctx) {
  const cache = resolved(writableCache(ctx));
  const own = path.join(cache, 'tmp');
  if (Buffer.byteLength(own) <= AGENT_TMP_MAX) return own;
  const short = shortTmp(cache);
  return short && Buffer.byteLength(short) < Buffer.byteLength(own) ? short : own;
}

// <cache root>/tc/<12 hex of the resolved cache>: 38 bytes under
// /home/<user>/.cache for an 8-letter user name, the same for every attempt
// on that cache and removed with it (removeCache). The resolved path, so a
// cache root behind a link (/home -> /var/home on Fedora Atomic) names the
// same directory when the cache is made and when it is removed. Only for a
// cache of the usual layout, <cache root>/tower-crane/{agents,tasks}/<state>/<name>.
function shortTmp(cache) {
  const dir = resolved(cache);
  const top = path.dirname(path.dirname(path.dirname(dir)));
  if (!agentCachePath(dir) || path.basename(top) !== 'tower-crane') return null;
  return path.join(path.dirname(top), 'tc', crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12));
}

// The agent writes its cache, so an earlier attempt can leave a file or a
// link where its temp directory goes. Either is removed, never followed. The
// leaf is made without recursion, and then must be a directory of this
// user's: a link planted between the two steps refuses the spawn.
function ownDir(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) fs.rmSync(dir, { force: true });
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const made = fs.lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!made.isDirectory() || (uid !== null && made.uid !== uid)) throw refuse(`${dir} is not a directory of this user's; remove it and spawn again`);
}

// Every name programs read their temp directory from: TMPDIR on POSIX, TMP
// and TEMP on Windows, where codex resolves the sandbox's temp from them too,
// and java.io.tmpdir, which the JVM takes from /tmp, absent in the sandbox,
// unless told. They win over the project's env and env_file, which spawn
// applies later (spawn.js, spawn-monitor.js). JAVA_TOOL_OPTIONS keeps the
// options env names, drops a java.io.tmpdir among them, and gets ours only
// for a path with no whitespace or quote, since the JVM splits the value on
// whitespace; otherwise the JVM keeps its default.
// A claude agent's spec, { dir, own }, adds CLAUDE_CODE_TMPDIR (claudeOwnTmp).
function ownTmpEnv(spec, env = {}) {
  const { dir, own } = typeof spec === 'string' ? { dir: spec } : spec;
  const out = { TMPDIR: dir, TMP: dir, TEMP: dir, ...(own ? { CLAUDE_CODE_TMPDIR: own } : {}) };
  const kept = String(env.JAVA_TOOL_OPTIONS || '').split(/\s+/).filter((o) => o && !o.startsWith('-Djava.io.tmpdir='));
  if (!/[\s"'\\]/.test(dir)) kept.push(`-Djava.io.tmpdir=${dir}`);
  if (kept.length) out.JAVA_TOOL_OPTIONS = kept.join(' ');
  return out;
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
    if (agent.sandbox) {
      // The sandbox grants only a directory that exists.
      ownDir(codexTmp(ctx));
      doc.permissions = permissions(agent, ctx);
    }
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
    put(home, 'AGENTS.md', ctx.reviewSystem || instructions(agent, ctx, mcp));
    put(path.join(home, 'rules'), 'tower-crane.rules', codexRules(agent.disallowedTools, agent.gitPush));
    // auth.json holds a login, .env the variables codex loads at start (an
    // AWS profile or bearer token for Bedrock): both are linked.
    for (const f of ['auth.json', '.env']) link(path.join(user, f), path.join(home, f));
    for (const s of agent.skills) {
      const d = skillDir(s, ctx);
      if (d) link(d, path.join(home, 'skills', s));
    }
    // Sessions outlive the home, for usage collected after the agent exits.
    const sessions = path.join(ctx.stateDir, 'homes', '.codex', ctx.agent, 'sessions');
    fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
    link(sessions, path.join(home, 'sessions'));
  };
  return { flags, shims: agent.sandbox ? codexShims(ctx) : null, tmp: agent.sandbox ? codexTmp(ctx) : null, env: { CODEX_HOME: home, ...(agent.sandbox ? ownTmpEnv(codexTmp(ctx), ctx.env) : {}) }, mcp, tools: optIn, write, usageRoot: path.join(ctx.stateDir, 'homes', '.codex', ctx.agent) };
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
  const stateReads = fs.readdirSync(ctx.stateDir).filter(entry => !['homes', 'brokers', CI_ARTIFACTS].includes(entry))
    .map(entry => resource('read_file', path.join(ctx.stateDir, entry)));
  const allow = [...stateReads, resource('read_file', ctx.home), resource('read_file', B.dir(ctx.stateDir, ctx.agent)),
    ...agent.skills.map(skill => skillDir(skill, ctx)).filter(Boolean).map(dir => resource('read_file', dir)),
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
  const skills = agent.skills.filter(skill => skillDir(skill, ctx)).map(skill => path.join(config, 'skills', skill));
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
      `skills: ${JSON.stringify(skills)}`, 'plugins: []', '---', '', instructions(agent, ctx, mcp),
    ].join('\n'));
    for (const skill of agent.skills) {
      const dir = skillDir(skill, ctx);
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

// git and gh on the agent's PATH check every call against the agent file:
// dir/bin holds them, dir/policy.json their policy, and lib the shim.js they
// run. masks: claude's sandbox mounts over the paths its protected list
// names, so the shim builds a merge that brings one in with plumbing. hook:
// the binding a push or PR is recorded through, null where the agent cannot
// read it. brokered: the agent holds no GitHub credential, so its pushes of
// the task branch from repoDir, the task repository's git directory, and its
// gh commands go to its broker (lib/github-broker.js).
function shims(agent, dir, branch, repo, lib, masks, hook, brokered = null) {
  const bin = path.join(dir, 'bin');
  put(dir, 'policy.json', JSON.stringify({ ...policy(agent), branch, repo, masks, hook,
    broker: !!brokered, repoDir: brokered?.repoDir || null }) + '\n');
  for (const tool of ['git', 'gh']) {
    const argv = [process.execPath, path.join(lib, 'shim.js'), path.join(dir, 'policy.json'), bin, tool];
    put(bin, tool, `#!/bin/sh\nunset ${Settings.NODE_INJECT.join(' ')}\nexec ${commandLine(argv)} "$@"\n`, 0o700);
    put(bin, `${tool}.cmd`, `${Settings.NODE_INJECT.map((k) => `@set "${k}="\r\n`).join('')}@${argv.map((a) => `"${a}"`).join(' ')} %*\r\n`, 0o700);
  }
}

// A sandboxed codex agent's shims, in its HOME. Codex cannot reopen a
// readable path inside a hidden one (measured 2026-10-14, codex-cli 0.162.1,
// in either rule order): it mounts every readable path, then masks each
// hidden directory, then binds each writable path with the readable paths
// inside it (codex-rs/linux-sandbox/src/bwrap.rs). homes/ is hidden, so
// homes/<agent>/bin, its policy and the runtime snapshot never showed, and
// `git` on PATH was the host's. HOME is writable and bound after that mask,
// and this directory, a readable path inside it, is bound read-only after
// HOME: the agent runs it and cannot change, rename or replace it. It holds
// the shims, their policy and a copy of lib, since the snapshot stays hidden.
// The hook binding stays hidden too, so a push or PR made through these shims
// is not recorded as a hook event.
const CODEX_SHIMS = '.tower-crane-shims';

function codexShims(ctx) {
  return path.join(ctx.home, 'home', CODEX_SHIMS);
}

function writeCodexShims(agent, dir, branch, repo, tool, brokered) {
  const lib = path.join(dir, 'lib');
  fs.cpSync(path.join(tool.path, 'lib'), lib, { recursive: true, dereference: true });
  // node takes a .js file's module type from the nearest package.json above
  // it. Without one here that is the project's or HOME's, and "type": "module"
  // there, from the project or written by the agent, makes shim.js an ES
  // module that cannot require.
  put(dir, 'package.json', '{"type":"commonjs"}\n');
  shims(agent, dir, branch, repo, lib, false, null, brokered);
}

// The HOME the agent runs with: its own, so a harness finds nothing of the
// user's by default (codex reads skills from $HOME/.agents, for one), with
// links to what git, gh and cloud CLIs need.
// A sandboxed agent's sandbox hides the user's home, so it gets no gh or git
// link: its gh runs on the host through its broker, and git gets the config
// spawn rendered without credential helpers (lib/git-config.js). The harness
// itself, outside the sandbox, still reads .aws through its link.
function agentHome(ctx, sandbox, confined) {
  const dir = path.join(ctx.home, 'home');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const links = confined ? SANDBOXED_LINKS : HOME_LINKS.filter((f) => !sandbox || f !== '.config/gh');
  for (const f of links) link(path.join(ctx.origin.home, f), path.join(dir, f));
  if (confined) put(dir, '.gitconfig', ctx.gitConfig?.text ?? require('./git-config').CLEARED);
  return dir;
}

// Each agent's liveness from its spawn events, as a memoized lookup: gone
// when its last spawn's monitor, its harness, every process left in the
// harness's group and, on Linux, every process carrying one of its launch
// markers have exited; strays names the marked processes that alone keep it.
// The marker finds a process that left the group with setsid. The supervisor
// retains the home through backoff and queued hook writes, and a process the
// agent left behind can still write its home and broker directory, so a
// removal walking them cannot race it. The group id is not passed: the group
// is gone, and its leader's pid may now lead another process's group.
// The marked processes of every agent are read in one /proc pass, made the
// first time an agent with a recorded marker and no other live processes needs it.
function agentLiveness(stateDir, events = S.readEvents(stateDir)) {
  const last = new Map();
  // Every launch's marker for each agent: a process an earlier attempt left
  // behind is the agent's as much as one from the last.
  const marks = new Map();
  for (const e of events) {
    const agent = e.detail && e.detail.agent;
    if (!agent) continue;
    if (['spawn', 'spawn retry', 'spawn fallback'].includes(e.cmd)) last.set(agent, e.detail);
    if (typeof e.detail.run_mark === 'string') marks.set(agent, (marks.get(agent) || new Set()).add(e.detail.run_mark));
  }
  let index = null;
  const verdicts = new Map();
  return (n) => {
    if (verdicts.has(n)) return verdicts.get(n);
    const spawned = last.get(n);
    let verdict = { gone: true, strays: [] };
    if (spawned) {
      const monitor = spawned.monitor_pid
        ? P.processState({ pid: spawned.monitor_pid, host: spawned.host, start_ticks: spawned.monitor_start_ticks })
        : 'exited';
      if (monitor === 'exited' && P.exited(spawned) && P.processGroupState(spawned) === 'exited') {
        if (marks.get(n)?.size) {
          index ??= P.strayIndex([...marks.values()].flatMap((set) => [...set]), {
            spared: require('./containment').recorded(stateDir).filter(id => id.kind === 'supervisor'),
          });
          const strays = index([...marks.get(n)]);
          verdict = { gone: !strays.length, strays };
        }
      } else verdict = { gone: false, strays: [] };
    }
    verdicts.set(n, verdict);
    return verdict;
  };
}

// The homes prune keeps only because a process carrying one of the agent's
// launch markers still runs, such as a daemon that inherited the marker and
// left the harness's session: [{ agent, pids }], for status to name.
function keptHomes(stateDir, events) {
  let names;
  try { names = fs.readdirSync(path.join(stateDir, 'homes')); }
  catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return []; throw error; }
  const liveness = agentLiveness(stateDir, events);
  return names.filter((n) => !n.startsWith('.')).sort()
    .map((agent) => ({ agent, pids: liveness(agent).strays }))
    .filter((x) => x.pids.length);
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
  const liveness = agentLiveness(stateDir);
  const gone = (n) => liveness(n).gone;
  for (const n of names) {
    if (n.startsWith('.')) continue;
    if (gone(n) && !require('./runtime').inUse(path.join(dir, n, 'tool'))) {
      if (homes.has(n)) {
        removeTree(path.join(dir, n));
        removeCache(cacheOf(n));
      }
      fs.rmSync(gitGlobalFile(stateDir, n), { force: true });
      if (brokers.has(n) && !claims.has(n) && B.dead(path.join(B.dir(stateDir, n), B.FILE))) {
        removeTree(B.dir(stateDir, n));
      }
    }
  }
  // A broker directory closing found the agent's files in, renamed aside
  // (removeOwnDir in lib/broker.js), goes once that agent is gone. The tree is
  // the agent's, and walking it is safe only then: with no process of the
  // agent's left, nothing swaps a link in during the walk, which never
  // follows one.
  for (const n of brokers) {
    const agent = /^\.stale-(.+)-[0-9a-f]{12}$/.exec(n)?.[1];
    if (agent && !claims.has(agent) && gone(agent)) removeTree(path.join(stateDir, 'brokers', n));
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
      put(ctx.home, 'AGENTS.md', instructions(agent, ctx));
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
    ...agent.skills.map((name) => skillDir(name, ctx)).filter(Boolean)];
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
    for (const dir of ['homes', 'brokers', CI_ARTIFACTS]) {
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
      ...relativePatterns(path.join(ctx.stateDir, CI_ARTIFACTS), 'deny'),
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
        // Tower Crane's own repository checks, allowed only for a project whose main
        // checkout has them. The command still runs the worktree's copy, so this grants
        // nothing beyond what npm run check:* and node test/* already run.
        ...['scripts/check-shared-files.js', 'scripts/cli-docs.js']
          .filter((script) => ctx.repo?.root && fs.existsSync(path.join(ctx.repo.root, script)))
          .map((script) => `node ${script}`),
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
        `permission: ${JSON.stringify(permission)}`, '---', instructions(agent, ctx, mcp),
      ].join('\n'));
      for (const skill of agent.skills) {
        const dir = skillDir(skill, ctx);
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
  const socketDir = sandboxed(job, rung.harness) && process.platform !== 'win32'
    ? require('./socket-path').agentDir(home, ctx.env) : null;
  const renderCtx = { ...ctx, job, browserMcp, rungName, home, tool, origin: from, socketDir };
  const r = render ? render(agent, rung, renderCtx) : hookAdapter(rung, { ...ctx, home, tool });
  // Before rendering, so a dry run refuses what a real start would.
  if (sandboxed(job, rung.harness)) {
    refuseSandboxInStores(renderCtx);
    refuseHiddenRules(renderCtx, [...homeReads(agent, renderCtx), ...[ctx.repo?.root, ctx.cwd].filter(Boolean).map(resolved)]);
  }
  // The first git and gh on the agent's PATH: its shims (codexShims).
  const bin = path.join(r.shims || home, 'bin');
  const key = pathKey(ctx.env);
  const homeDir = path.join(home, 'home');
  const cache = agent.writeOutside.includes('cache') && (job === 'worker' || render && agent.sandbox)
    ? writableCache({ ...ctx, job }) : null;
  const env = {
    ...r.env, ...(render ? { HOME: homeDir, ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}) } : {}),
    // gh reads its config first, and inherited paths may be denied.
    ...(render && agent.sandbox ? { GH_CONFIG_DIR: path.join(homeDir, '.config', 'gh') } : {}),
    ...(cache ? Object.fromEntries(Object.entries(CACHE_ENV).map(([k, sub]) => [k, path.join(cache, sub)])) : {}),
    TOWER_CRANE_SANDBOX: sandboxed(job, rung.harness) ? '1' : '0',
    ...(socketDir ? { TOWER_CRANE_SOCKET_DIR: socketDir } : {}),
    ...(sandboxed(job, rung.harness) ? { GIT_CONFIG_GLOBAL: gitGlobalFile(ctx.stateDir, ctx.agent) } : {}),
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
    // A fallback or retained controller can still execute this snapshot.
    const keepTool = require('./runtime').inUse(tool.path);
    if (keepTool) {
      const pinned = readJson(path.join(tool.path, 'tool.json'));
      if (pinned) Object.assign(tool, { sha: pinned.sha, version: pinned.version });
      for (const name of fs.readdirSync(home)) if (name !== 'tool') removeTree(path.join(home, name));
    } else {
      removeTree(home);
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    if (!keepTool) {
      for (const name of RUNTIME) {
        fs.cpSync(path.join(ROOT, name), path.join(tool.path, name), { recursive: true, dereference: true });
      }
      put(tool.path, 'tool.json', JSON.stringify(tool) + '\n');
    }
    put(home, 'tool.json', JSON.stringify(tool) + '\n');
    writeSkillStore(ctx.env, ctx.stateDir);
    // The sandbox grants only a directory that exists.
    if (cache) fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (socketDir) ownDir(socketDir);
    // An orchestrator wakes on events after its home was built, not on
    // history. `cuts` makes a later cut move that offset exactly; a separate
    // field, so an older tool still reads `after` as a plain offset.
    const end = job === 'orchestrator' ? E.readFrom(path.join(ctx.stateDir, 'events.jsonl'), 0) : null;
    put(home, 'hook.json', JSON.stringify({ agent: ctx.agent, task: ctx.task, state: ctx.stateDir, harness: rung.harness, attempt: ctx.attempt, ...(end ? { role: job, after: end.offset, cuts: end.cuts } : {}) }) + '\n');
    agentHome({ ...ctx, home, origin: from }, Boolean(render) && agent.sandbox, sandboxed(job, rung.harness));
    // A fresh key per home build: the supervisor and hook bridge present it so
    // their CLI children run as engine work for this agent only.
    require('./automation-key').create(home);
    r.write();
    const brokered = sandboxed(job, rung.harness) ? { repoDir: ctx.gitDirs?.common || ctx.repo?.commonDir || null } : null;
    shims(agent, home, ctx.taskSpec?.branch, ctx.projectRepo, path.join(tool.path, 'lib'), rung.harness === 'claude' && sandboxed(job, rung.harness), path.join(home, 'hook.json'), brokered);
    if (r.shims) writeCodexShims(agent, r.shims, ctx.taskSpec?.branch, ctx.projectRepo, tool, brokered);
    if (sandboxed(job, rung.harness)) {
      // The rendered global config (lib/git-config.js), out of any
      // repository the state directory sits in, as homes/.
      const dir = path.dirname(gitGlobalFile(ctx.stateDir, ctx.agent));
      put(dir, '.gitignore', '*\n');
      put(dir, ctx.agent, ctx.gitConfig?.text ?? require('./git-config').CLEARED);
    }
    const mark = JSON.stringify(from) + '\n';
    put(home, ORIGIN, mark);
    put(homeDir, ORIGIN, mark);
    // A nested spawn and its shims skip a PATH directory whose parent holds the mark.
    if (r.shims) put(r.shims, ORIGIN, mark);
    // Refresh every agy home, even when the new sibling uses another harness.
    refreshAgyPermissions(ctx.stateDir);
  };
  const credentialEnv = r.secretEnv || (() => ({}));
  return { home, bin, tool, scratch: job === 'worker' ? cache : null, agent_file: agent.file, instructions_file: r.instructionsFile || null, sandbox: sandboxed(job, rung.harness), socketDir, browser_kit: browserKit, mcp: r.mcp, tools: r.tools, flags: r.flags, env, gitEnv: r.gitEnv || {}, write, usageRoot: r.usageRoot || null, tmp: r.tmp || null, tmpSpec: r.tmpSpec || r.tmp || null, notices: r.notices || [],
    credentialEnv, secretEnv: () => ({ ...(sandboxed(job, rung.harness) ? {} : ghToken(ctx.env)), ...credentialEnv() }) };
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

module.exports = { CI_ARTIFACTS, CACHE_ENV, parse, keptHomes, load, file, isolation, agentShims, skillStore, harnessRoots, outsideHome, sandboxed, origin, cacheDir, availableMcp, optInKind, codexConfig, codexRules, policy, ghToken, removeTaskCache, taskCachePath, remoteHosts, ownTmpEnv, sessionBusEnv, runDirs, runReads, steadyEntry, wholeMount, codexProfileBytes, CODEX_ARG_MAX, GH_READ, LISTS, CAPABILITIES };
