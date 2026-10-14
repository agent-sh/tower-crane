'use strict';

// Models OpenCode's merged config, instruction and skill discovery without
// contacting a provider. Permissions use its last-matching-pattern rule.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { writeAtomic } = require('../atomic-file');

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
};
const json = (file) => JSON.parse(read(file) || '{}');
const flag = (name) => ['1', 'true'].includes(process.env[name]);
const merge = (a, b) => {
  for (const [k, v] of Object.entries(b)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Array.isArray(v)) a[k] = ['instructions', 'plugin'].includes(k) ? [...new Set([...(a[k] || []), ...v])] : v;
    else if (v && typeof v === 'object') a[k] = merge(a[k] || {}, v);
    else a[k] = v;
  }
  return a;
};
const match = (pattern, value) => new RegExp('^' + pattern.split('*').map((s) =>
  s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.')).join('.*') + '$').test(value);
const decision = (permission, tool, input) => {
  const rules = Object.entries(permission).filter(([pattern]) => match(pattern, tool)).at(-1)?.[1] ?? 'allow';
  return typeof rules === 'string' ? rules : Object.entries(rules)
    .filter(([pattern]) => match(pattern, input)).at(-1)?.[1] || 'ask';
};
const skillFiles = (dir) => {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name, 'SKILL.md'))
      .filter((file) => fs.existsSync(file));
  } catch { return []; }
};

async function main() {
  const args = process.argv.slice(2);
  const after = (flag) => args[args.indexOf(flag) + 1];
  const home = process.env.OPENCODE_TEST_HOME || os.homedir();
  const global = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  const data = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode');
  const dirs = [...new Set([global,
    ...(!flag('OPENCODE_DISABLE_PROJECT_CONFIG') ? [path.join(process.cwd(), '.opencode')] : []),
    path.join(home, '.opencode'), ...(process.env.OPENCODE_CONFIG_DIR ? [process.env.OPENCODE_CONFIG_DIR] : [])])];
  const authPath = path.join(data, 'auth.json');
  const loadAuth = () => JSON.parse(process.env.OPENCODE_AUTH_CONTENT || read(authPath) || '{}');
  const auth = loadAuth();
  const remoteContacts = [];
  const config = {};
  for (const [url, credential] of Object.entries(auth)) {
    if (credential.type !== 'wellknown') continue;
    const endpoint = url.replace(/\/+$/, '') + '/.well-known/opencode';
    remoteContacts.push(endpoint);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('remote configuration request failed');
    merge(config, (await response.json()).config || {});
  }
  merge(config, json(path.join(global, 'opencode.json')));
  if (process.env.OPENCODE_CONFIG) merge(config, json(process.env.OPENCODE_CONFIG));
  if (!flag('OPENCODE_DISABLE_PROJECT_CONFIG')) merge(config, json(path.join(process.cwd(), 'opencode.json')));
  for (const dir of dirs) if (dir !== global) merge(config, json(path.join(dir, 'opencode.json')));
  merge(config, JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'));
  if (config.plugin) config.plugin = [...new Set(config.plugin)];
  const memory = [];
  const globalMemory = read(path.join(process.env.OPENCODE_CONFIG_DIR || global, 'AGENTS.md'));
  if (globalMemory) memory.push(globalMemory);
  else if (!flag('OPENCODE_DISABLE_CLAUDE_CODE')) memory.push(read(path.join(home, '.claude', 'CLAUDE.md')));
  if (!flag('OPENCODE_DISABLE_PROJECT_CONFIG')) {
    memory.push(read(path.join(process.cwd(), 'AGENTS.md')) || read(path.join(process.cwd(), 'CLAUDE.md')));
  }
  for (const file of config.instructions || []) memory.push(read(file));
  const name = args.includes('--agent') ? after('--agent') : config.default_agent || 'build';
  let agent = '';
  for (const dir of dirs) agent = read(path.join(dir, 'agents', `${name}.md`)) || agent;
  const body = agent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const permission = JSON.parse(process.env.OPENCODE_PERMISSION || 'null') || config.permission || {};
  const skills = dirs.flatMap((dir) => skillFiles(path.join(dir, 'skills')));
  const compatible = [
    path.join(home, '.agents', 'skills'),
    ...(!flag('OPENCODE_DISABLE_CLAUDE_CODE') ? [path.join(home, '.claude', 'skills')] : []),
  ];
  for (const dir of compatible) skills.push(...skillFiles(dir));
  const visibleSkills = skills.filter((file) => decision(permission, 'skill', path.basename(path.dirname(file))) !== 'deny');
  const mcp = Object.fromEntries(Object.entries(config.mcp || {}).filter(([, server]) => server.enabled !== false));
  const descriptions = Object.values(mcp).map((server) => read(server.command?.at(-1)));
  const prompt = args.find((arg) => arg.includes('## Task')) || '';
  const skillDescriptions = visibleSkills.map((file) => read(file).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '');
  const context = [prompt, body, ...memory.filter(Boolean), ...skillDescriptions, ...descriptions].join('');
  const report = {
    home, global, data, dirs, cwd: process.cwd(), pwd: process.env.PWD, config, agent, name, permission, memory: memory.filter(Boolean),
    skills: visibleSkills.map((file) => path.basename(path.dirname(file))), mcp,
    authPath, remoteContacts,
    authKinds: Object.fromEntries(Object.entries(auth).map(([name, value]) => [name, value.type])),
    context_bytes: Buffer.byteLength(context),
    probes: JSON.parse(process.env.STUB_PROBES || '[]').map(([tool, input]) => decision(permission, tool,
      ['read', 'edit'].includes(tool) && path.isAbsolute(input) ? path.relative(process.cwd(), input).replace(/\\/g, '/') : input)),
  };
  if (process.env.STUB_REFRESH_AUTH) {
    const replacement = JSON.parse(process.env.STUB_REFRESH_AUTH);
    // write-atomic: this stub reads the refreshed file back itself; no test polls it.
    fs.writeFileSync(authPath, JSON.stringify(replacement), { mode: 0o600 });
    const refreshed = loadAuth();
    report.refreshedKinds = Object.fromEntries(Object.entries(refreshed).map(([name, value]) => [name, value.type]));
    report.refreshVisible = JSON.stringify(refreshed) === JSON.stringify(replacement);
  }
  if (process.env.STUB_BASH_CANARY) {
    // write-atomic: the test reads this canary only after the command has exited.
    const script = 'require("node:fs").writeFileSync(process.argv[1], "BASH-CANARY")';
    const input = [process.execPath, '-e', script, '--', process.env.STUB_BASH_CANARY].map((word) => JSON.stringify(word)).join(' ');
    const action = decision(permission, 'bash', input);
    report.bash = { decision: action };
    if (action === 'allow') {
      const result = cp.spawnSync(process.execPath, ['-e', script, '--', process.env.STUB_BASH_CANARY], { encoding: 'utf8', timeout: 10000 });
      report.bash.code = result.status;
      report.bash.stderr = result.stderr;
    }
  }
  writeAtomic(process.env.STUB_OUT, JSON.stringify(report));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
