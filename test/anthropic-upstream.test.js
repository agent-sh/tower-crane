'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { NO_STUBS, setup, spawn } = require('./isolation-helpers');
const { makeRepo } = require('./helpers');

const digest = (value) => crypto.createHash('sha256').update(value || '').digest('hex').slice(0, 12);

function credential(dir) {
  const name = `tc-test-fake-upstream-${process.pid}`;
  const file = path.join(dir, 'upstream-config.json');
  const secretFile = path.join(dir, 'upstream.env');
  const rotate = () => {
    const value = `tc-test-fake-${crypto.randomBytes(16).toString('hex')}`;
    fs.writeFileSync(secretFile, `ANTHROPIC_API_KEY=${value}\n`, { mode: 0o600 });
    return digest(value);
  };
  const hash = rotate();
  fs.writeFileSync(file, JSON.stringify({ credentials: { [name]: { store: 'env', env_file: secretFile, var: 'ANTHROPIC_API_KEY' } } }));
  return { name, file, hash, rotate };
}

test('Anthropic upstreams inject either auth style, restrict paths, rotate credentials and drop cache TTL', async (t) => {
  const h = makeRepo(t);
  const cred = credential(h.base);
  const seen = [];
  let status = 200;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, bearer: digest(req.headers.authorization?.replace(/^Bearer /, '')),
      key: digest(req.headers['x-api-key']), hasBearer: !!req.headers.authorization, hasKey: !!req.headers['x-api-key'],
      body: Buffer.concat(chunks).toString(), length: req.headers['content-length'] });
    res.writeHead(status, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
    res.write('data: first\n\n');
    res.end('data: last\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const broker = await require('../lib/bedrock-broker').start();
  t.after(() => broker.close());
  const base_url = `http://127.0.0.1:${upstream.address().port}/prefix/`;
  broker.target({ name: cred.name, config: cred.file, base_url, region: 'us-east-1' });
  for (const [method, rest] of [['POST', '/model/global.anthropic.fake/invoke'], ['GET', '/inference-profiles']]) {
    const response = await fetch(broker.url + rest, { method });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(seen.at(-1).url, '/prefix' + rest);
    assert.equal(seen.at(-1).bearer, cred.hash);
  }
  for (const auth of ['bearer', 'x-api-key']) {
    broker.target({ name: cred.name, config: cred.file, upstream: { base_url, auth } });
    for (const [method, rest] of [['POST', '/v1/messages'], ['POST', '/v1/messages/count_tokens?beta=true'], ['GET', '/v1/models']]) {
      const response = await fetch(broker.url + rest, { method, headers: { authorization: 'Bearer tc-test-fake-client', 'X-Api-Key': 'tc-test-fake-client' },
        ...(method === 'POST' ? { body: '{"messages":[]}' } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-upstream'), 'yes');
      assert.equal(await response.text(), 'data: first\n\ndata: last\n\n');
      const last = seen.at(-1);
      assert.equal(last.url, '/prefix' + rest);
      assert.equal(last.method, method);
      assert.equal(last[auth === 'bearer' ? 'bearer' : 'key'], cred.hash);
      assert.equal(last[auth === 'bearer' ? 'hasKey' : 'hasBearer'], false);
    }
  }
  const count = seen.length;
  for (const [method, rest] of [['GET', '/v1/messages'], ['DELETE', '/v1/models'], ['POST', '/v1/models'],
    ['POST', '/model/x'], ['GET', '/inference-profiles'], ['POST', '/v1/messages/extra'], ['POST', '/v1/messages%2fextra'],
    ['POST', '/v1/messages/../admin'], ['POST', '/v1/messages/count_tokens/']]) {
    const response = await fetch(broker.url + rest, { method });
    assert.equal(response.status, 404, `${method} ${rest}`);
    await response.text();
  }
  assert.equal((await fetch(`http://127.0.0.1:${new URL(broker.url).port}/v1/models`)).status, 404);
  assert.equal(seen.length, count);
  let previousHash = cred.hash;
  for (const rejected of [401, 403]) {
    const rotatedHash = cred.rotate();
    await (await fetch(broker.url + '/v1/messages', { method: 'POST', body: '{}' })).text();
    assert.equal(seen.at(-1).key, previousHash, 'the credential stays cached before rejection');
    status = rejected;
    const response = await fetch(broker.url + '/v1/messages', { method: 'POST', body: '{}' });
    assert.equal(response.status, rejected);
    await response.text();
    status = 200;
    await (await fetch(broker.url + '/v1/messages', { method: 'POST', body: '{}' })).text();
    assert.equal(seen.at(-1).key, rotatedHash, `re-read after ${rejected}`);
    previousHash = rotatedHash;
  }
  const body = { messages: [{ content: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
    system: [{ cache_control: { type: 'ephemeral', ttl: '5m' } }], ttl: 'keep', nested: { cache_control: { type: 'ephemeral' } } };
  for (const drop_cache_ttl of [false, true]) {
    broker.target({ name: cred.name, config: cred.file, upstream: { base_url, auth: 'bearer', drop_cache_ttl } });
    const response = await fetch(broker.url + '/v1/messages', { method: 'POST', body: JSON.stringify(body) });
    await response.text();
    const actual = JSON.parse(seen.at(-1).body);
    assert.equal(actual.ttl, 'keep');
    assert.equal(actual.messages[0].content[0].cache_control.ttl, drop_cache_ttl ? undefined : '1h');
    assert.equal(actual.system[0].cache_control.ttl, drop_cache_ttl ? undefined : '5m');
    assert.equal(Number(seen.at(-1).length), Buffer.byteLength(seen.at(-1).body));
  }
  const malformed = await fetch(broker.url + '/v1/messages', { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  await malformed.text();
});

test('ladder upstream validation refuses mixed routes and unsafe URL shapes', (t) => {
  const h = makeRepo(t);
  h.init();
  const good = { base_url: 'http://127.0.0.1:8090/prefix', auth: 'bearer', drop_cache_ttl: true };
  const args = ['ladder', 'set', 'small', '--harness', 'claude', '--model', 'gpt-fixture', '--clear', 'profile', '--clear', 'effort',
    '--credential', 'tc-test-fake-local', '--provider', 'anthropic'];
  h.ok([...args, '--upstream', JSON.stringify(good)]);
  assert.deepEqual(h.json(['ladder', 'show']).ladder.small.upstream, good);
  for (const upstream of [{ ...good, auth: 'basic' }, { ...good, drop_cache_ttl: 1 }, { ...good, extra: true },
    { ...good, base_url: 'file:///tmp/server' }, { ...good, base_url: 'http://user:password@localhost' },
    { ...good, base_url: 'http://localhost?key=hidden' }, { ...good, base_url: 'http://localhost/#fragment' }]) {
    assert.ok(require('../lib/ladder').shapeErrors({ ladder: { small: { upstream } } }).length > 0);
  }
  assert.notEqual(h.run([...args, '--upstream', '{"base_url":"file:///tmp/server","auth":"bearer"}']).code, 0);
  assert.match(h.run(['ladder', 'set', 'small', '--provider', 'bedrock']).stderr, /upstream.*bedrock|upstream.*anthropic/);
  assert.match(h.run(['ladder', 'set', 'small', '--clear', 'credential']).stderr, /upstream.*credential/);
  const edit = h.run(['ladder', 'set', 'small', '--upstream', JSON.stringify({ ...good, base_url: 'https://other.example' }), '--agent', 'orchestrator']);
  assert.notEqual(edit.code, 0, 'changing the credential recipient needs owner approval');
  assert.deepEqual(h.json(['ladder', 'show']).ladder.small.upstream, good);
  const grants = require('../lib/route-grants');
  const route = { harness: 'claude', provider: 'anthropic', model: 'local', credential: 'tc-test-fake-local', upstream: good };
  const hash = grants.hash(route, h.base, 'claude');
  assert.ok(grants.carries('small', route, 'claude').includes('upstream'));
  for (const upstream of [{ ...good, base_url: 'http://other.example' }, { ...good, auth: 'x-api-key' },
    { ...good, drop_cache_ttl: false }, undefined]) {
    assert.notEqual(grants.hash({ ...route, upstream }, h.base, 'claude'), hash, 'a changed upstream invalidates a fallback grant');
  }
});

test('a spawned Claude upstream route receives the nonce URL and placeholder, with no credential or client auth', { skip: NO_STUBS }, (t) => {
  const { h, u } = setup(t);
  const cred = credential(h.base);
  h.env.TOWER_CRANE_CONFIG = cred.file;
  u.env.TOWER_CRANE_CONFIG = cred.file;
  u.env.ANTHROPIC_API_KEY = 'tc-test-fake-inherited-key';
  u.env.ANTHROPIC_AUTH_TOKEN = 'tc-test-fake-inherited-token';
  u.env.AWS_BEARER_TOKEN_BEDROCK = 'tc-test-fake-inherited-aws';
  h.ok(['ladder', 'set', 'small', '--harness', 'claude', '--model', 'glm-5.3', '--provider', 'anthropic',
    '--clear', 'profile', '--clear', 'effort', '--credential', cred.name,
    '--upstream', '{"base_url":"http://127.0.0.1:8090/prefix","auth":"bearer"}']);
  spawn(h, u, 'small');
  const seen = u.report();
  assert.equal(seen.claudeRoute.nonceUrl, true);
  assert.equal(seen.claudeRoute.authHash, digest('tower-crane-placeholder'));
  assert.ok(!seen.envNames.includes('ANTHROPIC_API_KEY'));
  assert.ok(!seen.envNames.includes('AWS_BEARER_TOKEN_BEDROCK'));
  assert.ok(!seen.envNames.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.equal(seen.claudeRoute.bedrock, '0');
  assert.equal(seen.claudeRoute.model, 'glm-5.3');
  const settings = seen.settings;
  assert.ok(settings.sandbox.credentials.envVars.some((e) => e.name === 'ANTHROPIC_BASE_URL' && e.mode === 'deny'));
  assert.equal(settings.apiKeyHelper, undefined);
});
