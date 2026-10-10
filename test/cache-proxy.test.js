'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { ROOT, TMP_ROOT } = require('./helpers');

const SCRIPT = path.join(ROOT, 'scripts', 'cache-proxy.js');
const OPUS = '/model/global.anthropic.claude-opus-5-5/invoke-with-response-stream';

// One AWS event-stream message carrying an Anthropic streaming event, as Bedrock
// InvokeModelWithResponseStream sends it.
function frame(event) {
  const header = (name, value) => {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const b = Buffer.alloc(4 + n.length + v.length);
    b[0] = n.length;
    n.copy(b, 1);
    b[1 + n.length] = 7;
    b.writeUInt16BE(v.length, 2 + n.length);
    v.copy(b, 4 + n.length);
    return b;
  };
  const headers = Buffer.concat([header(':event-type', 'chunk'), header(':content-type', 'application/json'), header(':message-type', 'event')]);
  const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') }));
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(12 + headers.length + payload.length + 4, 0);
  prelude.writeUInt32BE(headers.length, 4);
  prelude.writeUInt32BE(zlib.crc32(prelude.subarray(0, 8)), 8);
  const message = Buffer.concat([prelude, headers, payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(message));
  return Buffer.concat([message, crc]);
}

const ANTHROPIC_STREAM = Buffer.concat([
  frame({ type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } } } }),
  frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'READY' } }),
  frame({ type: 'message_delta', usage: { output_tokens: 7 } }),
]);
const OPENAI_STREAM = [
  'event: response.created\ndata: {"type":"response.created"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":60,"cache_write_tokens":30},"output_tokens":5}}}\n\n',
].join('');

async function start(t, args = []) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (req.url.startsWith('/model/')) {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
        res.end(ANTHROPIC_STREAM);
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(OPENAI_STREAM);
      }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'tc-cache-proxy-'));
  const log = path.join(dir, 'log.jsonl');
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const child = cp.spawn(process.execPath, [SCRIPT, '--port', '0', '--log', log, '--runtime', base, '--mantle', base, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => {
    child.kill();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', d => {
      stderr += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', code => reject(new Error(`proxy exited ${code}: ${stderr}`)));
  });
  const send = async (url, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return Buffer.from(await response.arrayBuffer());
  };
  const entries = async n => {
    for (let i = 0; i < 100; i++) {
      const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      if (lines.length >= n) return { lines: lines.map(l => JSON.parse(l)), text: lines.join('\n') };
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`log has fewer than ${n} entries`);
  };
  return { send, entries, received };
}

const SYSTEM = 'You are a reviewer. '.repeat(20);

test('logs prefix hashes, cache usage, cost and where a request diverges, never prompt text or credentials', async (t) => {
  const proxy = await start(t);
  const auth = { authorization: 'Bearer secret-token-value' };
  const first = { system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'SENTINEL prompt one' }] };
  const reply = await proxy.send(OPUS, first, auth);
  assert.deepEqual(reply, ANTHROPIC_STREAM);
  await proxy.send(OPUS, { ...first, messages: [...first.messages, { role: 'assistant', content: 'READY' }, { role: 'user', content: 'SENTINEL two' }] }, auth);
  await proxy.send(OPUS, { ...first, system: [{ type: 'text', text: `${SYSTEM.slice(0, 10)}X${SYSTEM.slice(11)}` }] }, auth);
  const { lines, text } = await proxy.entries(3);

  assert.equal(proxy.received[0].headers.authorization, 'Bearer secret-token-value');
  assert.equal(lines[0].model, 'global.anthropic.claude-opus-5-5');
  assert.deepEqual(lines[0].usage, { input: 3, cache_read: 1000, cache_write: 200, cache_write_5m: 200, cache_write_1h: 0, output: 7 });
  assert.equal(lines[0].cost_usd, (3 * 4 + 200 * 5 + 1000 * 0.2 + 7 * 20) / 1e6);
  assert.match(lines[0].hash.static, /^[0-9a-f]{12}$/);
  assert.deepEqual(lines[0].hash.breakpoints.map(b => b.path), ['system[0]']);
  assert.equal(lines[0].divergence, null);
  assert.equal(lines[1].divergence.relation, 'extends');
  assert.equal(lines[1].divergence.against, 1);
  assert.equal(lines[2].divergence.relation, 'diverged');
  assert.equal(lines[2].divergence.segment, 'system[0]');
  assert.equal(lines[2].divergence.offset, 10);
  assert.notEqual(lines[2].hash.static, lines[0].hash.static);
  for (const secret of ['SENTINEL', 'You are a reviewer', 'secret-token-value']) assert.equal(text.includes(secret), false, secret);
});

test('request settings are logged from an allowlist and every other field as a hash', async (t) => {
  const proxy = await start(t);
  await proxy.send(OPUS, { max_tokens: 64, mcp_servers: [{ name: 'x', authorization_token: 'SENTINEL-token' }], messages: [{ role: 'user', content: 'hi' }] });
  const { lines, text } = await proxy.entries(1);
  assert.equal(lines[0].params.max_tokens, 64);
  assert.match(lines[0].params.mcp_servers, /^sha:[0-9a-f]{12}$/);
  assert.equal(text.includes('SENTINEL'), false);
});

test('a body the proxy cannot analyze is forwarded unchanged and the proxy keeps serving', async (t) => {
  const proxy = await start(t, ['--normalize', '--breakpoint', 'END']);
  const odd = { system: { text: 'x' }, messages: 'not a list' };
  await proxy.send(OPUS, odd);
  await proxy.send(OPUS, { messages: [{ role: 'user', content: 'hi' }] });
  const { lines } = await proxy.entries(2);
  assert.deepEqual(proxy.received[0].body, odd);
  assert.match(lines[0].analysis_error, /\S/);
  assert.equal(lines[1].status, 200);
});

test('a codex fork takes the prompt_cache_key of the request it extends', async (t) => {
  const proxy = await start(t, ['--inherit-cache-key']);
  const parent = { model: 'openai.gpt-6.1-sol', instructions: SYSTEM, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] }], prompt_cache_key: 'parent-thread' };
  await proxy.send('/openai/v1/responses', parent);
  await proxy.send('/openai/v1/responses', { ...parent, prompt_cache_key: 'fork-thread', input: [...parent.input, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rework' }] }] });
  await proxy.send('/openai/v1/responses', { ...parent, prompt_cache_key: 'other-thread', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'different task' }] }] });
  const { lines } = await proxy.entries(3);

  assert.deepEqual(proxy.received.map(r => r.body.prompt_cache_key), ['parent-thread', 'parent-thread', 'other-thread']);
  assert.deepEqual(lines[1].rewrites, ['cache_key:replaced']);
  assert.deepEqual(lines[0].usage, { input: 10, cache_read: 60, cache_write: 30, output: 5 });
  assert.equal(lines[0].cost_usd, (10 * 2 + 30 * 2.5 + 60 * 0.1 + 5 * 10) / 1e6);
});

test('only a request that extends an earlier one inherits its key, not one that shares the developer messages', async (t) => {
  const proxy = await start(t, ['--inherit-cache-key']);
  const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
  const session = (key, ...input) => ({ model: 'openai.gpt-6.1-sol', instructions: SYSTEM, prompt_cache_key: key,
    input: [message('developer', 'skills'), message('developer', 'permissions'), ...input] });
  const parent = session('thread-A', message('user', 'Review T1'));
  await proxy.send('/openai/v1/responses', parent);
  await proxy.send('/openai/v1/responses', session('thread-B', message('user', 'Implement T2')));
  await proxy.send('/openai/v1/responses', { ...parent, prompt_cache_key: 'fork-1', input: [...parent.input, message('assistant', 'READY'), message('user', 'rework one')] });
  await proxy.send('/openai/v1/responses', { ...parent, prompt_cache_key: 'fork-2', input: [...parent.input, message('assistant', 'READY'), message('user', 'rework two')] });
  await proxy.send('/openai/v1/responses', { ...parent, prompt_cache_key: 'fork-1', input: [...parent.input, message('assistant', 'READY'), message('user', 'rework one'), message('user', 'next')] });
  await proxy.entries(5);

  assert.deepEqual(proxy.received.map(r => r.body.prompt_cache_key), ['thread-A', 'thread-B', 'thread-A', 'thread-A', 'thread-A']);
});

test('the turn breakpoint marks the user turn before trailing system messages', async (t) => {
  const proxy = await start(t, ['--turn-breakpoint']);
  const marked = { type: 'ephemeral' };
  await proxy.send(OPUS, {
    system: [{ type: 'text', text: 'a', cache_control: marked }, { type: 'text', text: 'b', cache_control: marked }, { type: 'text', text: 'c', cache_control: marked }],
    messages: [{ role: 'user', content: 'review this' }, { role: 'system', content: [{ type: 'text', text: 'env', cache_control: marked }] }],
  });
  await proxy.entries(1);
  const { body } = proxy.received[0];
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'review this', cache_control: marked }]);
  assert.equal(body.system[0].cache_control, undefined, 'the fifth breakpoint drops the first system one');
  assert.deepEqual(body.system.slice(1).map(b => b.cache_control), [marked, marked]);
});

test('an added 1-hour breakpoint raises the 5-minute ones before it, and an added 5-minute one before a 1-hour one is raised', async (t) => {
  const short = { type: 'ephemeral' };
  const long = { type: 'ephemeral', ttl: '1h' };
  const turn = await start(t, ['--turn-breakpoint', '--breakpoint-ttl', '1h']);
  await turn.send(OPUS, {
    tools: [{ name: 't', input_schema: {}, cache_control: short }],
    system: [{ type: 'text', text: 'a', cache_control: short }, { type: 'text', text: 'b', cache_control: short }],
    messages: [{ role: 'user', content: 'review this' }, { role: 'system', content: 'env' }],
  });
  const marker = await start(t, ['--breakpoint', 'END', '--breakpoint-ttl', '1h']);
  await marker.send(OPUS, { system: [{ type: 'text', text: 'a', cache_control: short }], messages: [{ role: 'user', content: 'skill END' }] });
  const before = await start(t, ['--breakpoint', 'END']);
  await before.send(OPUS, { system: [{ type: 'text', text: 'skill END' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: long }] }] });
  const [turnLog, markerLog, beforeLog] = await Promise.all([turn.entries(1), marker.entries(1), before.entries(1)]);

  const body = turn.received[0].body;
  assert.deepEqual([body.tools[0], ...body.system, body.messages[0].content[0]].map(b => b.cache_control), [long, long, long, long]);
  assert.deepEqual(turnLog.lines[0].rewrites, ['turn_breakpoint:messages[0]', 'ttl:promoted system[1]', 'ttl:promoted system[0]', 'ttl:promoted tools[0]']);
  assert.deepEqual(marker.received[0].body.system[0].cache_control, long);
  assert.deepEqual(markerLog.lines[0].rewrites, ['breakpoint:marked', 'ttl:promoted system[0]']);
  assert.deepEqual(before.received[0].body.system[0].cache_control, long);
  assert.deepEqual(beforeLog.lines[0].rewrites, ['breakpoint:marked', 'ttl:promoted system[0]']);
});

test('normalize keeps tools and system identical across working directories and moves git status after the prompt', async (t) => {
  const proxy = await start(t, ['--normalize']);
  const request = cwd => ({
    system: [{ type: 'text', text: `Memory lives at /cfg/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/memory/. Keep it short.` }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: `<system-reminder>\ngitStatus: branch ${cwd}\n</system-reminder>` }, { type: 'text', text: 'Review T1' }] },
      { role: 'system', content: [{ type: 'text', text: `# Environment\n - Primary working directory: ${cwd}\n` }] },
    ],
  });
  await proxy.send(OPUS, request('/w/a'));
  await proxy.send(OPUS, request('/w/b'));
  const { lines } = await proxy.entries(2);

  const [a, b] = proxy.received.map(r => r.body);
  assert.equal(a.system[0].text, 'Memory lives at /cfg/projects/$CWD_SLUG/memory/. Keep it short.');
  assert.equal(lines[0].hash.static, lines[1].hash.static);
  assert.deepEqual(a.messages[0].content.map(c => c.text), ['Review T1', '<system-reminder>\ngitStatus: branch /w/a\n</system-reminder>']);
  assert.match(b.messages[1].content[0].text, /\$CWD is \/w\/b and \$CWD_SLUG is -w-b/);
  assert.equal(lines[1].divergence.segment, 'messages[0].content[1]');
});

test('normalize replaces the working directory only as a whole path', async (t) => {
  const proxy = await start(t, ['--normalize']);
  const request = cwd => ({
    system: [{ type: 'text', text: `Use /usr/bin and ${cwd}/src, not ${cwd}-worktrees/x or ${cwd}.git. Run in ${cwd}.` }],
    messages: [{ role: 'system', content: [{ type: 'text', text: `Primary working directory: ${cwd}` }] }],
  });
  await proxy.send(OPUS, request('/'));
  await proxy.send(OPUS, request('/w/repo'));
  await proxy.entries(2);
  const [root, repo] = proxy.received.map(r => r.body.system[0].text);
  assert.equal(root, 'Use /usr/bin and //src, not /-worktrees/x or /.git. Run in /.');
  assert.equal(repo, 'Use /usr/bin and $CWD/src, not /w/repo-worktrees/x or /w/repo.git. Run in $CWD.');
});

test('normalize moves the codex environment message after the prompt', async (t) => {
  const proxy = await start(t, ['--normalize']);
  const message = (role, text) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
  await proxy.send('/openai/v1/responses', {
    model: 'openai.gpt-6.1-sol', instructions: 'base',
    input: [message('developer', 'rules'), message('user', '<environment_context>\n<cwd>/w/a</cwd>'), message('user', 'Review T1')],
  });
  await proxy.entries(1);
  assert.deepEqual(proxy.received[0].body.input.map(i => i.content[0].text), ['rules', 'Review T1', '<environment_context>\n<cwd>/w/a</cwd>']);
});

test('a breakpoint goes right after the shared prefix marker on both providers', async (t) => {
  const proxy = await start(t, ['--breakpoint', 'END OF PREFIX.']);
  await proxy.send(OPUS, { messages: [{ role: 'user', content: 'skill text END OF PREFIX.\nReview T1' }] });
  await proxy.send('/openai/v1/responses', {
    model: 'openai.gpt-6.1-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'skill text END OF PREFIX.\nReview T1' }] }],
  });
  const { lines } = await proxy.entries(2);

  assert.deepEqual(proxy.received[0].body.messages[0].content, [
    { type: 'text', text: 'skill text END OF PREFIX.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\nReview T1' },
  ]);
  assert.deepEqual(proxy.received[1].body.input[0].content, [
    { type: 'input_text', text: 'skill text END OF PREFIX.', prompt_cache_breakpoint: { mode: 'explicit' } },
    { type: 'input_text', text: '\nReview T1' },
  ]);
  assert.deepEqual(lines[0].hash.breakpoints.map(b => b.path), ['messages[0].content[0]']);
});

test('a breakpoint that would exceed the provider maximum is not added', async (t) => {
  const proxy = await start(t, ['--breakpoint', 'END']);
  const marked = { type: 'ephemeral' };
  const request = {
    system: [{ type: 'text', text: 'END of prefix' }],
    messages: [{ role: 'user', content: ['a', 'b', 'c', 'd'].map(text => ({ type: 'text', text, cache_control: marked })) }],
  };
  await proxy.send(OPUS, request);
  const { lines } = await proxy.entries(1);
  assert.deepEqual(proxy.received[0].body, request);
  assert.deepEqual(lines[0].rewrites, ['breakpoint:over_limit']);
});

test('the developer breakpoint marks the end of the leading codex developer messages', async (t) => {
  const proxy = await start(t, ['--developer-breakpoint']);
  const message = (role, ...texts) => ({ type: 'message', role, content: texts.map(text => ({ type: 'input_text', text })) });
  await proxy.send('/openai/v1/responses', {
    model: 'openai.gpt-6.1-sol', instructions: 'base',
    input: [message('developer', 'skills'), message('developer', 'permissions', 'mode'), message('user', '<environment_context>'), message('user', 'Review T1')],
  });
  const { lines } = await proxy.entries(1);
  const input = proxy.received[0].body.input;
  assert.deepEqual(input[1].content[1], { type: 'input_text', text: 'mode', prompt_cache_breakpoint: { mode: 'explicit' } });
  assert.equal(input.filter(i => i.content.some(c => c.prompt_cache_breakpoint)).length, 1);
  assert.deepEqual(lines[0].rewrites, ['developer_breakpoint:input[1]']);
});
