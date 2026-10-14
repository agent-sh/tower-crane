'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');

const text = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const json = (file) => JSON.parse(text(file) || '{}');

async function main() {
  const args = process.argv.slice(2);
  const at = (flag) => args[args.indexOf(flag) + 1];
  const home = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, '.pi', 'agent');
  const handlers = new Map();
  const tools = [];
  const pi = {
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]),
    registerTool: (tool) => tools.push(tool.name),
    sendMessage: () => {},
  };
  const extensions = args.flatMap((arg, i) => arg === '--extension' ? [args[i + 1]] : []);
  if (!args.includes('--no-extensions')) {
    const dir = path.join(home, 'extensions');
    if (fs.existsSync(dir)) extensions.unshift(...fs.readdirSync(dir).map((file) => path.join(dir, file)));
  }
  for (const file of extensions) (await import(pathToFileURL(file).href)).default(pi);
  let systemPrompt = text(path.join(home, 'SYSTEM.md')) + text(path.join(home, 'APPEND_SYSTEM.md'));
  if (!args.includes('--no-context-files')) {
    systemPrompt += text(path.join(home, 'AGENTS.md')) + text(path.join(process.cwd(), 'AGENTS.md'));
  }
  if (args.includes('--append-system-prompt')) systemPrompt += text(at('--append-system-prompt'));
  for (const handler of handlers.get('before_agent_start') || []) {
    const result = await handler({ systemPrompt });
    systemPrompt = result?.systemPrompt || systemPrompt;
  }
  const prompt = at('-p');
  const probe = (command, argv) => {
    const result = cp.spawnSync(command, argv, { encoding: 'utf8', timeout: 300000 });
    return { code: result.status, stderr: result.stderr };
  };
  const report = {
    home, userHome: process.env.HOME, args, extensions, tools,
    settings: json(path.join(home, 'settings.json')),
    systemPrompt, contextBytes: Buffer.byteLength(systemPrompt + prompt),
    auth: fs.existsSync(path.join(home, 'auth.json')) ? fs.realpathSync(path.join(home, 'auth.json')) : null,
    shims: { git: probe('git', ['push', '--force', 'origin']), gh: probe('gh', ['pr', 'merge']) },
  };
  fs.writeFileSync(process.env.PI_STUB_OUT, JSON.stringify(report));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
