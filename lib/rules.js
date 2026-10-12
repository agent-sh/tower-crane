'use strict';

// The house rules a spawned agent works under, named by path so an edit to
// them applies to the next agent: the user's global rules for its harness and
// the AGENTS.md and CLAUDE.md files from the filesystem root down to its
// working directory, plus what those files import with claude's @path syntax.
// A claude or codex agent runs in a home of its own, so its harness finds
// none of the user's global files; claude loads no repository CLAUDE.md under
// --setting-sources user and never reads AGENTS.md, and codex reads AGENTS.md
// only from the git root down. Each file records how the agent gets it:
// `harness` when the harness loads it at start (codex's own AGENTS.md walk,
// claude through the @imports in the home's CLAUDE.md), `read` when the
// prompt asks the agent to read it.
// Agy gets project instructions only; its user memory stays excluded.

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')];
// claude follows imports five hops deep.
const IMPORT_DEPTH = 5;

function real(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return fs.statSync(p).isFile() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

function ancestors(dir) {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    out.unshift(d);
    if (path.dirname(d) === d) return out;
  }
}

// claude's @path imports: outside code blocks and spans, `~/` from the user's
// home, a relative path from the importing file.
function importsOf(file, home) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const found = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\\s|\S)+))/g)) {
      const raw = (m[1] ?? m[2] ?? m[3].replace(/[),.;:]+$/, '')).replace(/\\([\\"'\s])/g, '$1');
      const fromHome = raw.startsWith('~/');
      const abs = fromHome ? path.join(home, raw.slice(2)) : path.resolve(path.dirname(file), raw);
      if (real(abs)) found.push({ file: abs, fromHome });
    }
  }
  return found;
}

function markdown(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function globalFiles(harness, origin, env) {
  if (harness === 'claude') {
    return [path.join(origin.claude.dir, 'CLAUDE.md'), ...markdown(path.join(origin.claude.dir, 'rules'))];
  }
  if (harness === 'codex') {
    const override = path.join(origin.codex, 'AGENTS.override.md');
    return [real(override) ? override : path.join(origin.codex, 'AGENTS.md')];
  }
  if (harness === 'opencode') {
    // An isolated parent points XDG and config variables at its own home.
    // The origin marker keeps house rules tied to the user's config.
    const dir = origin.opencode?.extra || origin.opencode?.dir || env.OPENCODE_CONFIG_DIR
      || path.join(env.XDG_CONFIG_HOME || path.join(origin.home, '.config'), 'opencode');
    const config = path.join(dir, 'AGENTS.md');
    return [real(config) ? config : path.join(origin.claude.dir, 'CLAUDE.md')];
  }
  if (harness === 'pi') {
    const dir = origin.pi || env.PI_CODING_AGENT_DIR || path.join(origin.home, '.pi', 'agent');
    const agents = path.join(dir, 'AGENTS.md');
    return [real(agents) ? agents : path.join(dir, 'CLAUDE.md')];
  }
  if (harness === 'agy') {
    const gemini = origin.agy || path.join(origin.home, '.gemini');
    return [gemini, path.join(gemini, 'config')]
      .flatMap((dir) => [path.join(dir, 'GEMINI.md'), path.join(dir, 'AGENTS.md'), ...markdown(path.join(dir, 'rules'))]);
  }
  // A command adapter has no global instruction contract; name the known
  // user files so even an adapter consuming only {brief} gets them.
  if (harness === 'command') return ['claude', 'codex', 'opencode', 'agy', 'pi'].flatMap((h) => globalFiles(h, origin, env));
  return [];
}

function agyUserRule(origin) {
  const gemini = path.resolve(origin.agy || path.join(origin.home, '.gemini'));
  let target = gemini;
  try { target = fs.realpathSync(gemini); } catch {
    // A user who has never run agy has no config directory.
  }
  const known = new Set(globalFiles('agy', origin, {}).map(real).filter(Boolean));
  const inside = (dir, file) => {
    const relative = path.relative(dir, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  return file => {
    const actual = real(file);
    return inside(gemini, path.resolve(file)) || (actual && (inside(target, actual) || known.has(actual)));
  };
}

function agyProjectRules(files, origin) {
  const userRule = agyUserRule(origin);
  return files.filter(file => file.scope !== 'global' && !userRule(file.path));
}

// gitRoot is where codex starts its own AGENTS.md walk.
function chain({ harness, cwd, gitRoot, origin, env = process.env }) {
  const seen = new Set();
  const out = [];
  const excluded = harness === 'agy' ? agyUserRule(origin) : () => false;
  const add = (file, scope, depth = 0, fromHome = false) => {
    if (excluded(file)) return;
    const r = real(file);
    if (!r) return;
    if (seen.has(r)) {
      if (fromHome) {
        const existing = out.find((f) => real(f.path) === r);
        if (existing) existing.from_home = true;
      }
      return;
    }
    seen.add(r);
    const nativeCodex = harness === 'codex' && scope === 'project' && /^AGENTS(\.override)?\.md$/.test(path.basename(file))
      && gitRoot && (path.dirname(file) + path.sep).startsWith(path.resolve(gitRoot) + path.sep);
    const loaded = nativeCodex ? 'harness' : 'read';
    out.push({ path: file, scope, bytes: fs.statSync(r).size, loaded, ...(fromHome ? { from_home: true } : {}) });
    if (depth < IMPORT_DEPTH) for (const f of importsOf(file, origin.home)) add(f.file, 'import', depth + 1, f.fromHome);
  };
  if (harness !== 'agy') for (const f of globalFiles(harness, origin, env)) add(f, 'global');
  // A harness's own global file found on the walk (~/.claude/CLAUDE.md from
  // the home directory) is another harness's rules, not the project's.
  for (const f of ['claude', 'codex', 'opencode', 'pi'].flatMap((harness) => globalFiles(harness, origin, env))) {
    const r = real(f);
    if (r) seen.add(r);
  }
  // Above the repository, a .claude/CLAUDE.md is a harness config directory
  // (the home's is claude's user memory), not project rules.
  const top = gitRoot ? path.resolve(gitRoot) : null;
  for (const dir of ancestors(cwd)) {
    const inRepo = !top || (dir + path.sep).startsWith(top + path.sep);
    for (const name of PROJECT_FILES) {
      const preferred = harness === 'codex' && name === 'AGENTS.md' && real(path.join(dir, 'AGENTS.override.md')) ? 'AGENTS.override.md' : name;
      if (inRepo || !name.includes(path.sep)) add(path.join(dir, preferred), 'project');
    }
  }
  if (harness === 'claude') markClaudeLoaded(out, origin.home);
  return out;
}

// The generated home uses one of Claude's five import hops. A ~/ import
// needs its own absolute root because the agent has an isolated HOME.
function markClaudeLoaded(files, home) {
  const byReal = new Map(files.map((f) => [real(f.path), f]));
  const queue = files.filter((f) => (f.scope !== 'import' || f.from_home) && !/[\r\n]/.test(f.path)).map((f) => [f.path, 1]);
  const visited = new Set();
  for (let i = 0; i < queue.length; i++) {
    const [file, depth] = queue[i];
    const r = real(file);
    if (!r || visited.has(r)) continue;
    visited.add(r);
    const rule = byReal.get(r);
    if (rule) rule.loaded = 'harness';
    if (depth < IMPORT_DEPTH) {
      for (const child of importsOf(file, home)) if (!child.fromHome) queue.push([child.file, depth + 1]);
    }
  }
}

const tokens = (bytes) => Math.ceil(bytes / 4);

function summary(files) {
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  return { bytes, tokens: tokens(bytes) };
}

// The lines claude's home CLAUDE.md imports: the top of each chain, since
// claude follows nested imports itself, and each `@~/` import, which claude
// would resolve from the agent's own HOME and miss.
function claudeImports(files) {
  return files.filter((f) => f.loaded === 'harness' && (f.scope !== 'import' || f.from_home))
    .map((f) => {
      // Claude accepts literal whitespace in quotes, not JSON control escapes.
      const target = /[\s"'\\]/.test(f.path) ? `"${f.path.replace(/["\\]/g, '\\$&')}"` : f.path;
      return `@${target}`;
    });
}

function section(files) {
  if (!files.length) return '';
  const read = files.some((f) => f.loaded === 'read');
  return [
    '## House rules',
    '',
    'These files hold the rules you work under, general first and nearest last; the owner\'s words in this prompt come first. They are named by path so their current text applies.',
    '',
    ...files.map((f) => `- ${f.path} (${f.scope}, ${f.loaded === 'harness' ? 'loaded in your context' : 'read it'})`),
    ...(read ? ['', 'Read every file marked "read it" before you change anything.'] : []),
  ].join('\n');
}

module.exports = { chain, importsOf, summary, tokens, claudeImports, section, agyProjectRules, PROJECT_FILES };
