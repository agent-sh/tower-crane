'use strict';

const readline = require('node:readline');
const S = require('./state');
const I = require('./inbox');
const A = require('./actions');
const { usage } = require('./util');

const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = [
  { name: 'inbox', description: 'Read actionable findings and resolving commands; acknowledge a handled message, stall, decision answer or owner comment with ack.', inputSchema: schema({ ack: { type: 'string' } }) },
  { name: 'spawn_ready', description: 'Dispatch ready todo and rework tasks without live workers within the worker limit.', inputSchema: schema() },
  { name: 'merge_accepted', description: 'Drain accepted PRs through current-base checks and stack merge gates.', inputSchema: schema() },
  { name: 'rework_from_review', description: 'Send the current head back with its latest failed review findings and comment link.', inputSchema: schema({ id: { type: 'string' } }, ['id']) },
  { name: 'release_dead', description: 'Release claims verified exited; preserve live and unobservable processes.', inputSchema: schema() },
];

async function call(ctx, name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw usage(`unknown tool ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.entries(args).some(([k, v]) => !Object.hasOwn(tool.inputSchema.properties, k) || typeof v !== 'string')
    || tool.inputSchema.required.some((k) => !args[k]?.trim())) throw usage(`invalid arguments for ${name}`);
  const action = { ...ctx, stateDir: ctx.stateDir ?? ctx.resolveStateDir(), json: true, pos: [], flags: {} };
  I.authorized(action, S.loadState(action.stateDir));
  switch (name) {
    case 'inbox': return I.inbox({ ...action, flags: args });
    case 'spawn_ready': return A.spawn({ ...action, flags: { ready: true } });
    case 'merge_accepted': return A.merge({ ...action, flags: { accepted: true } });
    case 'rework_from_review': return A.rework({ ...action, flags: { 'from-review': args.id } });
    case 'release_dead': return A.release({ ...action, flags: { dead: true } });
  }
}

async function serve(ctx) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  for await (const line of lines) {
    let request;
    try { request = JSON.parse(line); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    if (request.id === undefined) continue;
    const reply = { jsonrpc: '2.0', id: request.id };
    switch (request.method) {
      case 'initialize':
        reply.result = { protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'tower-crane', version: require('../package.json').version } };
        break;
      case 'ping': reply.result = {}; break;
      case 'tools/list': reply.result = { tools: TOOLS }; break;
      case 'tools/call':
        try {
          const result = await call(ctx, request.params?.name, request.params?.arguments ?? {});
          reply.result = { content: [{ type: 'text', text: JSON.stringify(result.data) }], isError: !!result.code };
        } catch (e) { reply.result = { content: [{ type: 'text', text: e.message }], isError: true }; }
        break;
      default: reply.error = { code: -32601, message: 'Method not found' };
    }
    send(reply);
  }
  return { printed: true };
}

module.exports = { serve };
