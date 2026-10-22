'use strict';

// A local stand-in for the Anthropic Messages API, so the real claude CLI
// runs an agent without calling a model. Each reply asks for the next tool
// call in `steps` and records the result of the one before; once the steps
// run out, the model says it is done. A step is a function of the results so
// far that returns { name, input }.

const http = require('node:http');

function sse(res, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}

const text = (content) => (typeof content === 'string' ? content : (content || []).map((c) => c.text || '').join(''));

async function start(steps) {
  const results = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      if (!/\/v1\/messages/.test(req.url) || /count_tokens/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      // Only the agent's own turns carry its tools; claude's side requests get text.
      const agent = (json.tools || []).some((x) => x.name === 'Bash');
      const seen = (json.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result');
      for (const r of seen) {
        const step = Number(/^toolu_step(\d+)$/.exec(r.tool_use_id)?.[1]);
        if (Number.isInteger(step) && results[step] === undefined) results[step] = { error: r.is_error === true, text: text(r.content) };
      }
      const next = results.length;
      let blocks;
      let stop = 'end_turn';
      if (agent && next < steps.length && seen.length === next) {
        blocks = [{ type: 'tool_use', id: `toolu_step${next}`, ...steps[next](results) }];
        stop = 'tool_use';
      } else {
        blocks = [{ type: 'text', text: 'done' }];
      }
      if (json.stream) {
        sse(res, blocks, stop);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: blocks.map(({ type, id, name, input, text: t }) => (type === 'tool_use' ? { type, id, name, input } : { type, text: t })),
        stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, results, close: () => new Promise((resolve) => server.close(resolve)) };
}

module.exports = { start };
