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

test('diagnostic fan-out stays within its JSON byte budget across reporters and encodings', () => {
  const log = 'logs/tests-T1-sample/1-head.log';
  for (const reporter of ['spec', 'tap']) {
    for (const payload of ['x'.repeat(2400), 'é💡"\\'.repeat(600)]) {
      for (const count of [0, 1, 15, 16, 300]) {
        const names = Array.from({ length: count }, (_, i) => `failure ${i}`);
        const text = names.map((name, i) => reporter === 'spec'
          ? `✖ ${name} (1ms)\n  Error: own ${i}\n    at ${payload}\n`
          : `not ok ${i + 1} - ${name}\n  ---\n  error: own ${i}\n  stack: ${payload}\n  ...\n`).join('');
        const result = Logs.diagnostics(text, log);
        const label = `${reporter}/${count}/${payload[0]}`;
        assert.deepEqual(result.names, names, label);
        assert.equal(result.blocks.length + result.blocks_omitted, count, label);
        assert.ok(Buffer.byteLength(JSON.stringify(result.blocks)) <= 32 * 1024, label);
        for (const block of result.blocks) {
          assert.ok(Buffer.byteLength(block.block) <= Logs.BLOCK_BYTES, label);
          assert.ok(block.block.split('\n').length <= Logs.BLOCK_LINES, label);
          assert.ok(block.block.includes(`own ${names.indexOf(block.name)}`), label);
        }
        const all = Logs.blocks(text).map((b) => ({ name: b.name, ...Logs.cap(b.block, log) }));
        if (Buffer.byteLength(JSON.stringify(all)) <= 32 * 1024) assert.equal(result.blocks_omitted, 0, label);
        else assert.ok(result.blocks_omitted > 0, label);
        if (result.blocks_omitted) assert.equal(result.log, log, label);
      }
    }
  }
  // A name alone can exceed the aggregate budget; smaller later cases still fit.
  const huge = 'long ' + 'é'.repeat(32 * 1024);
  const result = Logs.diagnostics(`✖ ${huge} (1ms)\n  Error: huge\n✖ small (1ms)\n  Error: small\n`, log);
  assert.deepEqual(result.names, [huge, 'small']);
  assert.deepEqual(result.blocks.map((b) => b.name), ['small']);
  assert.equal(result.blocks_omitted, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.blocks)) <= 32 * 1024);
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
  const store = Logs.store({ stateDir: h.state, task: { id: 'T1', sha: 'b'.repeat(40) } }, C.createRedactor([]));
  for (const row of [
    { stream: 'stdout', script: "for(let i=0;i<100;i++)console.log('line '+i)", cut: true },
    { stream: 'stderr', script: "for(let i=0;i<100;i++)console.error('line '+i)", cut: true },
    { stream: 'both', script: "console.log('complete stdout');console.error('complete stderr')", cut: false },
  ]) {
    const result = await C.shell({}, `${C.shellQuote(process.execPath)} -e ${C.shellQuote(row.script)}`,
      { cwd: h.repo, keep: 128 });
    assert.equal(result.ok, true, row.stream);
    assert.equal(result.truncated, row.cut, row.stream);
    assert.equal(!!result.outputTruncated, row.cut, row.stream);
    const ref = store.keep('head', result);
    assert.equal(ref.truncated, row.cut, row.stream);
    const text = fs.readFileSync(path.join(h.state, ref.log), 'utf8');
    if (row.cut) assert.match(text, /log truncated.*\n[\s\S]*line 99/, row.stream);
    else assert.equal(text, result.output, row.stream);
  }
});
