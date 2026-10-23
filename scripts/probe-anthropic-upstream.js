'use strict';

// Run on the host: the keyring and the real Claude executable stay outside
// the worker sandbox. Only success flags and request counts leave this probe.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const Credentials = require('../lib/credentials');
const Provider = require('../lib/claude-provider');
const Broker = require('../lib/bedrock-broker');

async function turn(dir, broker, { name, model, config, upstream }) {
  const ready = Credentials.check(name, { file: config });
  console.log(JSON.stringify({ credential: name, credential_available: ready.ok, store: ready.store }));
  assert.equal(ready.ok, true, `${name}: credential unavailable`);
  if (!name.startsWith('tc-test-fake-')) assert.equal(ready.store, 'secret-service', `${name}: live proof requires the keyring`);
  broker.target({ name, config, upstream });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, ANTHROPIC_BASE_URL: broker.url };
  for (const key of Credentials.authEnv({ harness: 'claude', provider: 'anthropic', credential: name, upstream })) delete env[key];
  for (const key of Provider.ROUTES) env[key] = '0';
  for (const key of Object.keys(env)) if (/^ANTHROPIC_(MODEL|DEFAULT_[A-Z]+_MODEL|SMALL_FAST_MODEL)$/.test(key)) delete env[key];
  env.ANTHROPIC_AUTH_TOKEN = 'tower-crane-placeholder';
  env.ANTHROPIC_MODEL = model;
  for (const alias of Object.keys(require('../lib/ladder').BUILTIN.claude_aliases)) env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = model;
  const result = await new Promise((resolve) => {
    cp.execFile(process.env.TOWER_CRANE_PROBE_CLAUDE_BIN || 'claude', ['-p', 'Reply with exactly OK.', '--model', model, '--max-turns', '1', '--tools', '',
      '--no-session-persistence', '--output-format', 'json', '--setting-sources', 'user', '--strict-mcp-config',
      '--mcp-config', path.join(dir, 'mcp.json')], { env, cwd: dir, timeout: 180000, maxBuffer: 1 << 20 },
    (error, stdout, stderr) => {
      let doc;
      try { doc = JSON.parse(stdout); } catch { /* Report no raw harness output. */ }
      resolve({ exit: error ? error.code || 'failed' : 0, subtype: doc?.subtype, is_error: doc?.is_error,
        diagnostic_flags: ['unknown option', 'auth', 'permission', 'sandbox', 'mcp', 'model', 'proxy', 'network', 'settings', 'resource', 'EACCES', 'ENOENT']
          .filter((word) => String(stderr).toLowerCase().includes(word.toLowerCase())),
        success: doc?.subtype === 'success' && doc?.is_error === false,
        reply: typeof doc?.result === 'string' && /^OK[.!]?$/.test(doc.result.trim()) });
    });
  });
  console.log(JSON.stringify({ credential: name, model, ...result }));
  assert.equal(result.exit, 0, `${name}: Claude failed`);
  assert.equal(result.success, true, `${name}: no successful turn`);
  assert.equal(result.reply, true, `${name}: unexpected reply`);
}

async function main() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, 'tc-upstream-proof-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(dir, '.claude.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'mcp.json'), '{"mcpServers":{}}\n');
  const broker = await Broker.start();
  let local;
  try {
    if (!process.argv.includes('--local-only')) {
      await turn(dir, broker, { name: 'glm-api-key', model: 'glm-5.3', config: Credentials.configFile(),
        upstream: { base_url: 'https://api.z.ai/api/anthropic', auth: 'bearer' } });
    }
    const name = `tc-test-fake-live-local-${process.pid}`;
    const value = `tc-test-fake-${crypto.randomBytes(16).toString('hex')}`;
    // Only a per-probe fingerprint leaves the fake server's auth check.
    const fingerprintKey = crypto.randomBytes(32);
    const fingerprint = (token) => crypto.createHmac('sha256', fingerprintKey).update(token || '').digest('hex').slice(0, 12);
    const expected = fingerprint(value);
    const file = path.join(dir, 'credential.json');
    const secretFile = path.join(dir, 'credential.env');
    fs.writeFileSync(secretFile, `ANTHROPIC_API_KEY=${value}\n`, { mode: 0o600 });
    fs.writeFileSync(file, JSON.stringify({ credentials: { [name]: { store: 'env', env_file: secretFile, var: 'ANTHROPIC_API_KEY' } } }));
    let messages = 0;
    local = http.createServer(async (req, res) => {
      for await (const chunk of req) { void chunk; }
      const actual = fingerprint(req.headers['x-api-key']);
      if (actual !== expected || req.headers.authorization) { res.writeHead(403); return res.end('{}'); }
      const pathname = req.url.split('?')[0];
      if (pathname === '/v1/messages/count_tokens') return res.end('{"input_tokens":10}');
      if (pathname === '/v1/models') return res.end('{"data":[{"id":"tc-test-fake-local","type":"model","display_name":"Local proof"}],"has_more":false}');
      if (pathname !== '/v1/messages') { res.writeHead(404); return res.end('{}'); }
      messages++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [event, data] of [
        ['message_start', { type: 'message_start', message: { id: 'msg_tc_local', type: 'message', role: 'assistant', model: 'tc-test-fake-local',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }],
      ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    });
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    await turn(dir, broker, { name, model: 'tc-test-fake-local', config: file,
      upstream: { base_url: `http://127.0.0.1:${local.address().port}`, auth: 'x-api-key' } });
    assert.ok(messages > 0, 'Claude must call the local Messages API');
    console.log(JSON.stringify({ local_messages: messages, auth_hmac_sha256_prefix: expected }));
  } finally {
    broker.close();
    local?.closeAllConnections();
    local?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(() => { console.error('Anthropic upstream live proof failed; raw credential and harness output omitted'); process.exitCode = 1; });
