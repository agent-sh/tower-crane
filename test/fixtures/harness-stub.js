'use strict';

// Stands in for the claude and codex CLIs: it loads what the real harness
// loads at startup (memory and instruction files, settings hooks, MCP
// servers, approved-command rules and auth) from the places the real CLI
// reads them, honoring the flags that narrow them, and writes what it found
// to STUB_OUT. With STUB_RUN it also runs commands the way the agent's shell
// would, so the PATH the agent gets is what resolves them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const TOML = require('../../lib/toml');

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const json = (f) => JSON.parse(read(f) || '{}');
const toml = (f) => TOML.parse(read(f) || '', f);
const files = (dir, ext) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => read(path.join(dir, f)));
  } catch {
    return [];
  }
};
// claude's @path imports, followed five hops deep from each memory file.
const withImports = (file, depth = 0) => {
  const text = read(file);
  if (text === null) return [];
  const found = [...text.matchAll(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|((?:\\\s|\S)+))/g)].map((m) => {
    const raw = (m[1] ?? m[2]).replace(/\\([\\"\s])/g, '$1').replace(/[),.;:]+$/, '');
    return raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(path.dirname(file), raw);
  });
  return [text, ...(depth < 5 ? found.flatMap((f) => withImports(f, depth + 1)) : [])];
};
// Instruction files in dir and each directory above it, up to stop.
const walkUp = (dir, names, stop = null) => {
  const out = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    for (const n of names) {
      const file = path.join(d, n);
      if (read(file) !== null) {
        out.unshift(...(stop ? [read(file)] : withImports(file)));
        if (stop) break;
      }
    }
    if (d === stop || path.dirname(d) === d) return out;
  }
};
// A claude permission rule such as Read(//abs/dir/**): a bare tool name
// covers every path; // starts an absolute path in which ** spans
// directories and * stays within one.
const toolRuleMatches = (rule, tool, file) => {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(rule);
  if (!m || m[1] !== tool) return false;
  if (m[2] === undefined) return true;
  if (!m[2].startsWith('//')) return false;
  const glob = m[2].slice(1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*|\*/g, (s) => (s === '**' ? '.*' : '[^/]*'));
  let target = path.resolve(file);
  try { target = fs.realpathSync(target); } catch { /* a missing file matches by its name */ }
  return new RegExp(`^${glob}$`).test(target);
};
const hookCommands = (settings) => Object.values(settings.hooks || {}).flat().flatMap((h) => (h.hooks || []).map((x) => x.command));

module.exports = function stub(harness) {
  const args = process.argv.slice(2);
  const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const report = { harness, args, ghToken: process.env.GH_TOKEN || null, home: os.homedir(), memory: [], skills: [], hooks: [], mcp: {}, rules: [], auth: null, env: null, ran: [] };
  const skillsIn = (dir) => {
    try {
      return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')));
    } catch {
      return [];
    }
  };
  if (harness === 'claude') {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const global = process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
    const sources = (after('--setting-sources') || 'user,project,local').split(',');
    // User memory follows its imports; project memory loads only with the
    // project source.
    report.memory = [...withImports(path.join(dir, 'CLAUDE.md')), ...files(path.join(dir, 'rules'), '.md'),
      ...(sources.includes('project') ? walkUp(process.cwd(), ['CLAUDE.md']) : [])].filter(Boolean);
    report.prompt = after('-p');
    const sourceFiles = { user: path.join(dir, 'settings.json'), project: '.claude/settings.json', local: '.claude/settings.local.json' };
    const settings = json(sourceFiles.user);
    for (const s of sources) report.hooks.push(...hookCommands(json(sourceFiles[s])));
    report.rules = (settings.permissions && settings.permissions.allow) || [];
    report.settings = settings;
    if (!args.includes('--strict-mcp-config')) Object.assign(report.mcp, json(global).mcpServers || {});
    if (after('--mcp-config')) Object.assign(report.mcp, json(after('--mcp-config')).mcpServers || {});
    report.auth = read(path.join(dir, '.credentials.json'));
    // claude's Read, Grep and Glob tools answer to permission rules, not to
    // the sandbox: STUB_READ files are read the way those tools would, after
    // the deny rules from settings and --disallowedTools. A relative file is
    // in the agent's own home.
    const from = args.indexOf('--disallowedTools') + 1;
    const end = args.findIndex((a, i) => i >= from && a.startsWith('--'));
    const disallowed = from ? args.slice(from, end === -1 ? undefined : end) : [];
    const denyRules = [...((settings.permissions && settings.permissions.deny) || []), ...disallowed];
    report.reads = JSON.parse(process.env.STUB_READ || '[]').map((f) => path.resolve(dir, f)).flatMap((file) => ['Read', 'Grep', 'Glob'].map((tool) => {
      const denied = denyRules.some((r) => toolRuleMatches(r, tool, file));
      return { file, tool, denied, text: denied ? null : read(file) };
    }));
  } else if (harness === 'codex') {
    const dir = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const disabled = args.filter((a, i) => args[i - 1] === '--disable');
    const config = toml(path.join(dir, 'config.toml'));
    const profile = after('-p') ? toml(path.join(dir, `${after('-p')}.config.toml`)) : {};
    // codex refuses to start on Bedrock without a region.
    const providerId = profile.model_provider || config.model_provider;
    const provider = { ...(config.model_providers || {}), ...(profile.model_providers || {}) }[providerId] || {};
    if (providerId === 'amazon-bedrock' && !(provider.aws && provider.aws.region) && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      process.stderr.write('Fatal error: Amazon Bedrock bearer token auth requires `model_providers.amazon-bedrock.aws.region`, `AWS_REGION`, or `AWS_DEFAULT_REGION`\n');
      process.exit(1);
    }
    report.memory = [
      read(path.join(dir, 'AGENTS.md')),
      ...[config.model_instructions_file, profile.model_instructions_file].filter(Boolean).map(read),
      ...(disabled.includes('memories') ? [] : files(path.join(dir, 'memories'), '.md')),
    ].filter(Boolean);
    // codex reads AGENTS.md from the git root down to its working directory.
    const top = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    report.projectDocs = top ? walkUp(process.cwd(), ['AGENTS.override.md', 'AGENTS.md'], path.resolve(top)) : [];
    report.prompt = args.find((a) => a.includes('## Task')) || null;
    report.rules = files(path.join(dir, 'rules'), '.rules');
    // codex finds skills in its home and in the user's ~/.agents/skills.
    report.skills = [...skillsIn(path.join(dir, 'skills')), ...skillsIn(path.join(os.homedir(), '.agents', 'skills'))];
    report.config = JSON.parse(JSON.stringify(config));
    report.configText = read(path.join(dir, 'config.toml'));
    report.mcp = Object.fromEntries(Object.keys(config.mcp_servers || {}).map((k) => [k, true]));
    report.auth = read(path.join(dir, 'auth.json'));
    report.env = read(path.join(dir, '.env'));
    // codex keeps sessions under its home; a resume must find the first one.
    const sessions = path.join(dir, 'sessions');
    report.resumed = args.includes('resume');
    if (!report.resumed) {
      const id = 'stub-thread';
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, `rollout-${process.env.TOWER_CRANE_AGENT}-${id}.jsonl`), '{}\n');
      process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: id })}\n`);
    }
    report.sessions = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
  } else {
    report.prompt = args.find((a) => a.includes('## Task')) || null;
  }
  for (const argv of JSON.parse(process.env.STUB_RUN || '[]')) {
    const r = cp.spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    report.ran.push({ argv, code: r.status, stderr: r.stderr });
  }
  fs.writeFileSync(process.env.STUB_OUT, JSON.stringify(report));
};
