'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo } = require('./helpers');
const Logs = require('../lib/gates/test-log');

test('first error blocks select the detailed occurrence and stop at the next case', () => {
  for (const row of [
    { text: '✖ early (1ms)\nrunner progress\n✔ pass (2ms)\nℹ tests 2\n✖ failing tests:\ntest at a.js:1:1\n✖ early (1ms)\n  Error: own\n    at a.js:2:1\ntest at b.js:1:1\n✖ next (2ms)\n  Error: other\n',
      names: ['early', 'next'], own: '  Error: own\n    at a.js:2:1' },
    { text: 'not ok 1 - early\n  ---\n  error: own\n  stack: |-\n    at a.js:2:1\n  ...\nok 2 - pass\n',
      names: ['early'], own: '  error: own\n  stack: |-\n    at a.js:2:1' },
    { text: '✖ early (1ms)\n  Error: own\n✖ early (2ms)\n  Error: repeated\n',
      names: ['early'], own: '  Error: own' },
    { text: '  ✖ early (1ms)\r\n    Error: own\r\n  ✔ pass (2ms)\r\n',
      names: ['early'], own: '    Error: own' },
  ]) {
    const blocks = Logs.blocks(row.text);
    assert.deepEqual(blocks.map((b) => b.name), row.names);
    assert.ok(blocks[0].block.includes(row.own), row.text);
    assert.doesNotMatch(blocks[0].block, /Error: other|Error: repeated|✔ pass|ℹ tests|runner progress/);
  }
});

test('test logs redact before byte limits, report cuts and prune only old runs of their task', (t) => {
  const h = makeRepo(t);
  const ctx = { stateDir: h.state, task: { id: 'T1', sha: 'a'.repeat(40) } };
  const secret = 'ghp_' + 's'.repeat(40);
  const redact = require('../lib/gates/common').createRedactor([]);
  const store = Logs.store(ctx, redact);
  const safe = store.keep('base', { output: 'Error: \u001b[31m' + secret + '\u001b[0m\n' });
  assert.equal(fs.readFileSync(path.join(h.state, safe.log), 'utf8'), 'Error: [redacted:GITHUB_TOKEN]\n');
  const text = '✖ early (1ms)\n  Error: ' + secret + '\n' + 'é'.repeat(Logs.LOG_BYTES);
  const ref = store.keep('head', { output: text });
  const output = fs.readFileSync(path.join(h.state, ref.log), 'utf8');
  assert.ok(Buffer.byteLength(output) <= Logs.LOG_BYTES);
  assert.equal(ref.truncated, true);
  assert.doesNotMatch(output, /ghp_|ssss/);
  assert.match(output, /log truncated/);
  const capped = Logs.cap('✖ early\n  Error: ' + 'é'.repeat(2048), ref.log);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.block) <= Logs.BLOCK_BYTES);
  assert.ok(capped.block.split('\n').length <= Logs.BLOCK_LINES);
  assert.match(capped.block, /error block truncated.*logs\/tests-T1-/);
  const peer = Logs.store({ ...ctx, task: { ...ctx.task, id: 'T2' } }, redact).keep('head', { output: 'peer' });
  fs.utimesSync(path.dirname(path.join(h.state, ref.log)), new Date(0), new Date(0));
  for (let i = 0; i < Logs.RUNS_KEPT; i++) {
    Logs.store(ctx, redact).keep('head', { output: 'fresh ' + i });
  }
  assert.equal(fs.existsSync(path.join(h.state, ref.log)), false);
  assert.equal(fs.existsSync(path.join(h.state, peer.log)), true);
});

test('command capture reports truncation before saving its retained output', async (t) => {
  const h = makeRepo(t);
  const C = require('../lib/gates/common');
  const result = await C.shell({}, `${C.shellQuote(process.execPath)} -e "for(let i=0;i<100;i++)console.log('line '+i)"`,
    { cwd: h.repo, keep: 128 });
  assert.equal(result.ok, true);
  assert.equal(result.outputTruncated, true);
  const ref = Logs.store({ stateDir: h.state, task: { id: 'T1', sha: 'b'.repeat(40) } }, C.createRedactor([])).keep('head', result);
  assert.equal(ref.truncated, true);
  assert.match(fs.readFileSync(path.join(h.state, ref.log), 'utf8'), /log truncated.*\n[\s\S]*line 99/);
});
