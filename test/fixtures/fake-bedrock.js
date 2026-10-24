'use strict';

// A local stand-in for Amazon Bedrock, so the real claude CLI runs on its
// Bedrock route without calling a model. It answers the control plane's
// GET /inference-profiles and the runtime's InvokeModel calls, the streaming
// one in the AWS event-stream framing, and records each request's method,
// path and Authorization header. The agent's turns follow `steps`, as in a
// tool-calling model: each reply asks for the next tool call and records the
// result of the one before; once the steps run out, the model says it is
// done. A step is a function of the results so far that returns
// { name, input }. onRequest runs as each request arrives.

const http = require('node:http');
const zlib = require('node:zlib');

const text = (content) => (typeof content === 'string' ? content : (content || []).map((c) => c.text || '').join(''));

// One event-stream message: prelude (total and headers length), its CRC,
// the headers, the payload and the message CRC.
function frame(payload) {
  const header = (name, value) => {
    const n = Buffer.from(name);
    const v = Buffer.from(value);
    const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = b.writeUInt8(n.length, 0);
    o += n.copy(b, o);
    o = b.writeUInt8(7, o);
    o = b.writeUInt16BE(v.length, o);
    v.copy(b, o);
    return b;
  };
  const headers = Buffer.concat([header(':event-type', 'chunk'), header(':content-type', 'application/json'), header(':message-type', 'event')]);
  const body = Buffer.from(JSON.stringify(payload));
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(12 + headers.length + body.length + 4, 0);
  prelude.writeUInt32BE(headers.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(zlib.crc32(prelude) >>> 0, 0);
  const head = Buffer.concat([prelude, preludeCrc, headers, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(head) >>> 0, 0);
  return Buffer.concat([head, crc]);
}

function events(blocks, stop) {
  const out = [{ type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.type === 'tool_use') {
      out.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    }
    out.push({ type: 'content_block_stop', index });
  });
  out.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  out.push({ type: 'message_stop' });
  return out;
}

async function start(steps, { onRequest = () => {} } = {}) {
  const results = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null });
      onRequest(req);
      if (req.method === 'GET' && req.url.startsWith('/inference-profiles')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ inferenceProfileSummaries: [] }));
        return;
      }
      if (!/^\/model\//.test(req.url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"message":"fake 404"}');
        return;
      }
      if (/count-tokens/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"inputTokens":1}');
        return;
      }
      let json = {};
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      // Only the agent's own turns carry its tools; claude's side requests get text.
      const agent = (json.tools || []).some((x) => x.name === 'Bash');
      const seen = (json.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
      for (const r of seen) {
        const step = Number(/^toolu_step(\d+)$/.exec(r.tool_use_id)?.[1]);
        if (Number.isInteger(step) && results[step] === undefined) results[step] = { error: r.is_error === true, text: text(r.content) };
      }
      const next = results.length;
      let blocks = [{ type: 'text', text: 'done' }];
      let stop = 'end_turn';
      if (agent && next < steps.length && seen.length === next) {
        blocks = [{ type: 'tool_use', id: `toolu_step${next}`, ...steps[next](results) }];
        stop = 'tool_use';
      }
      if (/invoke-with-response-stream/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'fake' });
        for (const e of events(blocks, stop)) res.write(frame({ bytes: Buffer.from(JSON.stringify(e)).toString('base64') }));
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
        content: blocks.map(({ type, id, name, input, text: t }) => (type === 'tool_use' ? { type, id, name, input } : { type, text: t })),
        stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, results, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

module.exports = { start, frame };
