'use strict';

// Loads agy's documented global config and custom agent locations.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const home = os.homedir();
const config = path.join(home, '.gemini', 'config');
const cli = path.join(home, '.gemini', 'antigravity-cli');
const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
const json = f => JSON.parse(read(f) || '{}');
const md = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => read(path.join(dir, f))) : [];
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
const requestedContext = [...prompt.matchAll(/^- (.+) \((?:global|project|import), read it\)$/gm)]
  .map(match => read(match[1]));
const name = args[args.indexOf('--agent') + 1];
const agentFile = path.join(config, 'agents', `${name}.md`);
const agent = read(agentFile);
const memory = [
  ...['AGENTS.md', 'GEMINI.md'].flatMap(f => [read(path.join(home, '.gemini', f)), read(path.join(config, f))]),
  ...md(path.join(config, 'rules')), ...md(path.join(cli, 'rules')),
].filter(Boolean);
const settings = json(path.join(cli, 'settings.json'));
const mcp = json(path.join(config, 'mcp_config.json')).mcpServers || {};
const rules = settings.permissions || {};
const tools = JSON.parse(/^tools: (.*)$/m.exec(agent)?.[1] || '[]');
const skills = JSON.parse(/^skills: (.*)$/m.exec(agent)?.[1] || '[]');
const contextBytes = Buffer.byteLength([agent, ...memory, JSON.stringify(mcp), JSON.stringify(rules)].join('\n'));
const ran = JSON.parse(process.env.STUB_RUN || '[]').map(argv => {
  const result = cp.spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  return { argv, code: result.status, stderr: result.stderr };
});
fs.writeFileSync(process.env.STUB_OUT, JSON.stringify({
  home, agentFile, agent, args, prompt, requestedContext, memory, settings, mcp, rules, tools, skills, contextBytes, ran,
  sandboxMarker: process.env.TOWER_CRANE_SANDBOX,
  brokered: Boolean(process.env.TOWER_CRANE_BROKER),
}));
if (process.env.STUB_HOLD) setTimeout(() => {}, Number(process.env.STUB_HOLD)); // wait-allow: fixture simulates route duration for resume and stall scenarios
