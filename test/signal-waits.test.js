'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { makeRepo, ROOT } = require('./helpers');
const { fileWritten, eventAppended, childExit, childClosed, portListening, waitUntil } = require('./signals');
const { waitFindings } = require('../scripts/test-waits');

test('signal waits observe existing state, atomic writes, complete events, child exits and listening ports', async (t) => {
  const h = makeRepo(t);
  const file = path.join(h.base, 'ready');
  fs.writeFileSync(file, 'already');
  assert.equal(await fileWritten(file, { signal: t.signal }), 'already');
  const empty = path.join(h.base, 'empty');
  const written = fileWritten(empty, { signal: t.signal, poll: false });
  fs.writeFileSync(empty, '');
  assert.equal(await written, '');
  const replaced = fileWritten(file, { signal: t.signal, poll: false, check: (text) => text === 'replaced' && text });
  fs.writeFileSync(file + '.tmp', 'replaced');
  fs.renameSync(file + '.tmp', file);
  assert.equal(await replaced, 'replaced');
  const log = path.join(h.base, 'events.jsonl');
  const appended = eventAppended(log, (event) => event.type === 'done', { signal: t.signal, poll: false });
  fs.writeFileSync(log, '{"type":');
  fs.appendFileSync(log, '"done"}\n');
  assert.deepEqual(await appended, { type: 'done' });
  const child = cp.spawn(process.execPath, ['-e', 'process.exit(7)']);
  const closed = childClosed(child, { signal: t.signal });
  assert.deepEqual(await childExit(child, { signal: t.signal }), { code: 7, signal: null });
  assert.deepEqual(await closed, { code: 7, signal: null });
  assert.deepEqual(await childClosed(child, { signal: t.signal }), { code: 7, signal: null });
  await assert.rejects(childExit(cp.spawn(path.join(h.base, 'missing-command')), { signal: t.signal }), /ENOENT/);
  assert.deepEqual(await childExit(child, { signal: t.signal }), { code: 7, signal: null });
  const server = net.createServer((socket) => socket.end());
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  assert.equal(await portListening(server.address().port, '127.0.0.1', { signal: t.signal }), true);
  const controller = new AbortController();
  const aborted = fileWritten(path.join(h.base, 'missing'), { signal: controller.signal });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(aborted, /test cancellation/);
  for (const reason of [0, null, false]) {
    for (const alreadyAborted of [true, false]) {
      const cancellation = new AbortController();
      if (alreadyAborted) cancellation.abort(reason);
      const pending = waitUntil(() => false, { signal: cancellation.signal });
      if (!alreadyAborted) cancellation.abort(reason);
      await assert.rejects(pending, (error) => error === reason);
    }
  }
  await assert.rejects(waitUntil(() => { throw new Error('probe failed'); }), /probe failed/);
});

test('file probes recover when a recursive watcher cannot access restricted fixture tools', async (t) => {
  const h = makeRepo(t);
  for (const mode of ['throw', 'error']) {
    const file = path.join(h.base, mode);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const denied = Object.assign(new Error('restricted fixture tool'), { code: 'EACCES' });
    const watch = t.mock.method(fs, 'watch', () => {
      if (mode === 'throw') throw denied;
      queueMicrotask(() => watcher.emit('error', denied));
      return watcher;
    });
    try {
      const written = fileWritten(file, { signal: t.signal });
      fs.writeFileSync(file, 'ready');
      assert.equal(await written, 'ready');
    } finally {
      watch.mock.restore();
    }
  }
});

test('shared checks reject readiness budgets and require a reason on allowed timing waits', (t) => {
  const lexicalWaits = [
    'until(() => /ready\\)/.test(output), "ready", 1000);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(() => /ready\\)/.test(output), "ready", delay);', // wait-allow: rejected lint fixture
    'until(() => { return /ready\\)/.test(output); }, "ready", 1000);', // wait-allow: rejected lint fixture
    'waitFor(() => /[),/]/.test(output), "ready", 1000);', // wait-allow: rejected lint fixture
    'waitUntil(() => /[\\]/),]/.test(output), "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => `ready${output.includes(")") ? `nested${output}` : ","}`, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => `ready${/[,/)]/.test(output) /* ) */}`, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(check /* ), 300000 */ , "ready", /* ) */ 1000);', // wait-allow: rejected lint fixture
    'until(check, // ), 300000\n "ready", 1000);', // wait-allow: rejected lint fixture
    'setTimeout(() => /ready\\)/.test(output), 1000);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(() => count / 2 > 1, "ready", delay / 2);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", (delay + 1000 - 500) * 2 / 3);', // wait-allow: rejected lint fixture
    'const first = 0, delay = 1000; until(check, "ready", delay);', // wait-allow: rejected lint fixture
    'function ready(delay = 1000) { until(check, "ready", +(-(-delay))); }', // wait-allow: rejected lint fixture
    'waitOnRepo(repo, check, 1000);', // wait-allow: rejected lint fixture
    'fileWritten(file, 1000);', // wait-allow: rejected lint fixture
    'eventAppended(file, check, 1000);', // wait-allow: rejected lint fixture
    'childExit(child, 1000);', // wait-allow: rejected lint fixture
    'childClosed(child, 1000);', // wait-allow: rejected lint fixture
    'portListening(port, 1000);', // wait-allow: rejected lint fixture
    'const delay = 1000; setTimeout(check, delay * 2);', // wait-allow: rejected lint fixture
    'until(check, "ready", 500 + 500);', // wait-allow: rejected lint fixture
    'until(check, "ready", 2000 - 1000);', // wait-allow: rejected lint fixture
    'until(check, "ready", 10 * 100);', // wait-allow: rejected lint fixture
    'until(check, "ready", 10000 / 10);', // wait-allow: rejected lint fixture
    'function ready(/* c */ window = 1000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'function ready(window /* c */ = 1000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'function until(check, /* c */ delay = 1000) {}', // wait-allow: rejected lint fixture
    'waitUntil(async () => await /ready\\)/.test(output), "ready", 1000);', // wait-allow: rejected lint fixture
    'const delay = 1000; waitUntil(async () => await /[),/]/.test(output), "ready", delay);', // wait-allow: rejected lint fixture
    'until(() => /x/ instanceof /ready\\)/.constructor, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => "source" in /ready\\)/, "ready", 1000);', // wait-allow: rejected lint fixture
  ];
  for (const source of [
    ...lexicalWaits,
    'const deadline = Date.now() + 15000;', // wait-allow: rejected lint fixture
    'const deadline = performance.now() + budget;', // wait-allow: rejected lint fixture
    'async function until(fn, what, ms = 15000) {', // wait-allow: rejected lint fixture
    'await until(check, "ready", 20000);', // wait-allow: rejected lint fixture
    'await new Promise((r) => setTimeout(r, 50));', // wait-allow: rejected lint fixture
    'assert.ok(Date.now() - started < 5000);', // wait-allow: rejected lint fixture
    'await waitFor(\n  file,\n  20000\n);', // wait-allow: rejected lint fixture
    'await new Promise((resolve) => setTimeout(\n  resolve,\n  25\n));', // wait-allow: rejected lint fixture
    'await h.runAsync(["wait", "--timeout", "10"]);', // wait-allow: rejected lint fixture
    'const deadline =\n  Date.now()\n  + 1000;', // wait-allow: rejected lint fixture
    'await waitFor(ready, { timeout: 1000 });', // wait-allow: rejected lint fixture
    'const deadline = Date.now() + 300000 / 1000;', // wait-allow: rejected lint fixture
    'const HUNG_TEST_MS = 1000;', // wait-allow: rejected lint fixture
    'cp.spawnSync("node", ["worker.js"], { timeout: 1000 });', // wait-allow: rejected lint fixture
    'test("worker", { timeout: 1000 }, async () => {});', // wait-allow: rejected lint fixture
    'const elapsed = Date.now() - started;\nassert.ok(elapsed < 1000);', // wait-allow: rejected lint fixture
    'await h.cleanup({ monitorGraceMs: 1000 });', // wait-allow: rejected lint fixture
    'await h.runAsync(["wait", "--timeout=1"]);', // wait-allow: rejected lint fixture
    'cp.spawn("node", ["--test-timeout=1000", "worker.test.js"]);', // wait-allow: rejected lint fixture
    'cp.spawn("node", ["--test-timeout", "1000", "worker.test.js"]);', // wait-allow: rejected lint fixture
    'describe("workers", { timeout: 1000 }, () => {});', // wait-allow: rejected lint fixture
    'test.after(() => {}, { timeout: 1000 });', // wait-allow: rejected lint fixture
    'const budget = 1000; await until(check, "ready", budget);', // wait-allow: rejected lint fixture
    'async function until(check, what, budget = 1000) {}', // wait-allow: rejected lint fixture
    'cp.spawnSync("node", ["worker.js"], { timeout: budget });', // wait-allow: rejected lint fixture
    'assert.ok((Date.now() - started) < 1000);', // wait-allow: rejected lint fixture
    'const elapsed = Date.now() - started; assert.ok(elapsed <= 1000);', // wait-allow: rejected lint fixture
    'assert.ok(1000 > performance.now() - started);', // wait-allow: rejected lint fixture
    'await h.runAsync(["wait", "--timeout",\n "10"]);', // wait-allow: rejected lint fixture
    'await fileWritten(file, { signal: AbortSignal.timeout(1000) });', // wait-allow: rejected lint fixture
    'async function until(check, what, budget = 10 * 1000) {}', // wait-allow: rejected lint fixture
    'async function waitFor(check, timeout = (10 * 1000)) {}', // wait-allow: rejected lint fixture
    'const budget = 10 * 1000; until(check, "ready", budget);', // wait-allow: rejected lint fixture
    'const window = 10 * 1000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", (delay));', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", +delay);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", -delay);', // wait-allow: rejected lint fixture
    'const delay = 300000; until(check, "ready", -(delay));', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", delay /* c */);', // wait-allow: rejected lint fixture
    'const delay = (1000); until(check, "ready", ((+delay)));', // wait-allow: rejected lint fixture
    'const delay = /* c */ 1000; until(check, "ready", /* c */ (delay));', // wait-allow: rejected lint fixture
    'function ready(window = 1000) { until(check, "ready", (window)); }', // wait-allow: rejected lint fixture
    'function ready(window = /* c */ (1000)) { until(check, "ready", +(window)); }', // wait-allow: rejected lint fixture
    'const seconds = 10; const window = seconds * 1000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const delay = 1e4; const window = delay; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const window =\n (10 * 1000);\n until(check, "ready", window);', // wait-allow: rejected lint fixture
    'async function until(check, what, budget = S.LOCK_WAIT_MS / 4) {}', // wait-allow: rejected lint fixture
    'const window = Math.min(HUNG_TEST_MS, 1000); until(check, "ready", window);', // wait-allow: rejected lint fixture
    'if (Date.now() - started >= budget) throw new Error("late");', // wait-allow: rejected lint fixture
    'assert.ok(Date.now() - started < S.LOCK_WAIT_MS / 4);', // wait-allow: rejected lint fixture
    'assert.ok(S.LOCK_WAIT_MS / 4 > (performance.now() - started));', // wait-allow: rejected lint fixture
    'const elapsed = Date.now() - started; assert.ok(elapsed < 10 * 1000);', // wait-allow: rejected lint fixture
    'const elapsed = Date.now() - started; assert.ok(budget > elapsed);', // wait-allow: rejected lint fixture
    'const window = ready ? 10000 : 20000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const budget = getBudget(); until(check, "ready", budget);', // wait-allow: rejected lint fixture
    'const window = getBudget() + 1000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const label = "ready", delay = 1000; until(check, label, delay);', // wait-allow: rejected lint fixture
    'const window = 10 * 1000\nuntil(() => ready, "ready", window)', // wait-allow: rejected lint fixture
    'const window = 10000\nawait until(check, "ready", window)', // wait-allow: rejected lint fixture
    'const window =\n  10 *\n  1000\nuntil(check, "ready", window)', // wait-allow: rejected lint fixture
    'function ready(window = 10000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'function ready(window = 10 * 1000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'const ready = (window = 10000) => until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const ready = (window = 10 * 1000) => { until(check, "ready", window); };', // wait-allow: rejected lint fixture
    'function ready(window = 1000) { until(check, "ready", window); } function other(window = 300000) {}', // wait-allow: rejected lint fixture
    'if (Date.now() > start + 5000) throw new Error("late");', // wait-allow: rejected lint fixture
    'if (start + (5 * 1000) < performance.now()) throw new Error("late");', // wait-allow: rejected lint fixture
    'var deadline = Date.now() + 5000; while (!ok()) { if (Date.now() > deadline) throw new Error("late"); }', // wait-allow: rejected lint fixture
    'let deadline; deadline = Date.now() + 5000; while (!ok()) { if (Date.now() > deadline) throw new Error("late"); }', // wait-allow: rejected lint fixture
    'const window = 5000; if (Date.now() > start + window) throw new Error("late");', // wait-allow: rejected lint fixture
    'const { setTimeout: sleep } = require("node:timers/promises"); await sleep(500); if (!ok()) throw new Error("late");', // wait-allow: rejected lint fixture
    'const { setTimeout } = require("timers/promises"); await setTimeout(500);', // wait-allow: rejected lint fixture
    'const timers = require("node:timers/promises"); await timers.setTimeout(500);', // wait-allow: rejected lint fixture
    'const label = "ready", delay = 10 * 1000, alias = delay; until(check, label, alias);', // wait-allow: rejected lint fixture
    'const { unused } = settings, window = 1000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'const [unused] = settings, window = 1000; until(check, "ready", window);', // wait-allow: rejected lint fixture
    'function short() { const delay = 1000; const pattern = /[},]/; until(check, "ready", delay); }', // wait-allow: rejected lint fixture
    'function short() { if (ready) { var window = 1000; } until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'function short() { if (ready) { const delay = 1000; var window = delay; } until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'const unused = 0, HUNG_TEST_MS = 1000; until(check, "ready", HUNG_TEST_MS);', // wait-allow: rejected lint fixture
    'const delay = 1000, window = delay; function ready() { const delay = 300000; until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'const delay = 1000; { const window = delay; { const delay = window; until(check, "ready", delay); } }', // wait-allow: rejected lint fixture
    'function short() { const delay = 1000; until(check, "ready", delay); } function long() { const delay = 300000; until(check, "ready", delay); }', // wait-allow: rejected lint fixture
    'function long() { const delay = 300000; until(check, "ready", delay); } function short() { const delay = 1000; until(check, "ready", delay); }', // wait-allow: rejected lint fixture
    'assert.ok(Date.now() - started\n < S.LOCK_WAIT_MS / 4);', // wait-allow: rejected lint fixture
  ]) {
    assert.ok(waitFindings(source).length, source);
    const annotated = source.split('\n').map((line) => line
      .replace('// ), 300000', '// wait-allow: verifies the production timer contract')
      + ' // wait-allow: verifies the production timer contract').join('\n');
    assert.deepEqual(waitFindings(annotated), [], source);
    assert.ok(waitFindings(source + ' // wait-allow:').length, 'an empty reason is refused');
  }
  assert.deepEqual(waitFindings('const deadline = Date.now() + HUNG_TEST_MS;'), []);
  assert.deepEqual(waitFindings('const deadline = Date.now() + 300000;'), []);
  assert.deepEqual(waitFindings('cp.spawnSync("node", [], { timeout: Math.max(budget, HUNG_TEST_MS) });'), []);
  assert.deepEqual(waitFindings('async function until(check, what, budget = Math.max(HUNG_TEST_MS, other)) {}'), []);
  assert.deepEqual(waitFindings('const budget = 300000; const guard = budget; until(check, "ready", guard);'), []);
  assert.deepEqual(waitFindings('const delay = 300000; until(check, "ready", ((+delay)) /* c */);'), []);
  assert.deepEqual(waitFindings('const delay = -300000; until(check, "ready", -delay);'), []);
  assert.deepEqual(waitFindings('function ready(window = /* c */ (300000)) { until(check, "ready", +(window)); }'), []);
  assert.deepEqual(waitFindings('const label = "/* 1000 */"; until(check, label);'), []);
  assert.deepEqual(waitFindings('const window = Math.max(HUNG_TEST_MS, other); until(check, "ready", window);'), []);
  assert.deepEqual(waitFindings('const { unused } = settings, window = 300000; until(check, "ready", window);'), []);
  assert.deepEqual(waitFindings('const delay = 300000, window = delay; function ready() { const delay = 1000; until(check, "ready", window); }'), []);
  assert.deepEqual(waitFindings('const delay = 300000; { const window = delay; { const delay = window; until(check, "ready", delay); } }'), []);
  assert.deepEqual(waitFindings('async function waitFor(check, what = "ready", options = {}) {}'), []);
  assert.deepEqual(waitFindings('const h = setup(t, "codex", { cpu_ms: 1000 }); until(t, h, check);'), []);
  assert.deepEqual(waitFindings('const h = setup(t, "codex", { cpu_ms: 10 * 1000 }); until(t, h, check);'), []);
  assert.deepEqual(waitFindings('const label = "ready", delay = 300000; until(check, label, delay);'), []);
  assert.deepEqual(waitFindings('const window = 300000\nuntil(check, "ready", window)'), []);
  assert.deepEqual(waitFindings('const window = 300000 // hung guard\nuntil(check, "ready", window)'), []);
  assert.deepEqual(waitFindings('function ready(window = 300000) { until(check, "ready", window); }'), []);
  assert.deepEqual(waitFindings('const ready = (window = 300000) => until(check, "ready", window);'), []);
  assert.deepEqual(waitFindings('function ready(window = 300000) { until(check, "ready", window); } function other(window = 1000) {}'), []);
  assert.deepEqual(waitFindings('const window = 300000; function ready(delay = window) { const window = 1000; until(check, "ready", delay); }'), []);
  assert.deepEqual(waitFindings('var deadline = Date.now() + HUNG_TEST_MS;'), []);
  assert.deepEqual(waitFindings('let deadline; deadline = performance.now() + 300000;'), []);
  assert.deepEqual(waitFindings('if (Date.now() > start + HUNG_TEST_MS) throw new Error("hung");'), []);
  assert.deepEqual(waitFindings('if (start + 300000 < performance.now()) throw new Error("hung");'), []);
  assert.deepEqual(waitFindings('const { setTimeout: sleep } = require("node:timers/promises"); await sleep(300000);'), []);
  assert.deepEqual(waitFindings('const timers = require("node:timers/promises"); await timers.setTimeout(HUNG_TEST_MS);'), []);
  for (const source of [
    'until(() => /ready\\)/.test(output), "ready", 300000);',
    'waitFor(() => /[),/]/.test(output), "ready", 300000);',
    'until(() => `ready${output.includes(")") ? `nested${output}` : ","}`, "ready", 300000);',
    'until(check /* ), 1000 */, "ready", 300000);',
    'const delay = 300000; until(() => count / 2 > 1, "ready", delay / 1);', // wait-allow: accepted folding fixture binds its constant in the generated source
    'until(check, "ready", 300000 + 1000);',
    'until(check, "ready", (600000 - 1000) * 2 / 3);',
    'const delay = 1000; until(check, "ready", delay * 300);', // wait-allow: accepted folding fixture binds its constant in the generated source
    'const delay = 300000; setTimeout(check, delay / 1);', // wait-allow: accepted folding fixture binds its constant in the generated source
    'function ready(/* c */ window = 300000) { until(check, "ready", window); }',
    'function ready(window /* c */ = 300000) { until(check, "ready", window); }',
    'function until(check, /* c */ delay = 300000) {}',
    'waitUntil(async () => await /ready\\)/.test(output), "ready", 300000);',
    'until(() => /x/ instanceof /ready\\)/.constructor, "ready", 300000);',
    'until(() => "source" in /ready\\)/, "ready", 300000);',
  ]) assert.deepEqual(waitFindings(source), [], source);
  assert.deepEqual(waitFindings('function other() { const delay = 1000; } function long() { const delay = 300000; until(check, "ready", delay); }'), []);
  const scoped = waitFindings('function short() {\nconst delay = 1000;\nuntil(check, "ready", delay);\n}\nfunction long() {\nconst delay = 300000;\nuntil(check, "ready", delay);\n}');
  assert.deepEqual(scoped.map((finding) => finding.line), [3]);
  assert.ok(waitFindings('await until(check, "// wait-allow: fake reason", 1000);').length); // wait-allow: rejected lint fixture
  const h = makeRepo(t);
  for (const dir of ['scripts', 'bin', 'lib', 'docs', 'changelog.d']) {
    fs.cpSync(path.join(ROOT, dir), path.join(h.repo, dir), { recursive: true });
  }
  fs.mkdirSync(path.join(h.repo, 'test'));
  const bad = path.join(h.repo, 'test', 'wait.test.js');
  fs.writeFileSync(bad, 'const deadline = Date.now() + 1000;\n'); // wait-allow: rejected lint fixture
  const run = () => cp.spawnSync(process.execPath, [path.join(h.repo, 'scripts/check-shared-files.js')], {
    cwd: h.repo, env: h.env, encoding: 'utf8',
  });
  const rejected = run();
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /test\/wait.test.js:1 readiness deadline/);
  fs.writeFileSync(bad, [
    'async function until(check, what, budget = 10 * 1000) {', // wait-allow: rejected lint fixture
    '  const started = Date.now();',
    '  while (!check()) {',
    '    if (Date.now() - started >= budget) throw new Error(what);', // wait-allow: rejected lint fixture
    '    await new Promise(setImmediate);',
    '  }',
    '}',
  ].join('\n'));
  const expression = run();
  assert.equal(expression.status, 1, expression.stdout + expression.stderr);
  assert.match(expression.stderr, /test\/wait.test.js:1 wait supplies/);
  fs.writeFileSync(bad, 'const label = "ready", delay = 1000; until(check, label, delay);\n'); // wait-allow: rejected lint fixture
  const declarations = run();
  assert.equal(declarations.status, 1, declarations.stdout + declarations.stderr);
  assert.match(declarations.stderr, /test\/wait.test.js:1 wait supplies/);
  for (const source of [
    ...lexicalWaits,
    'const delay = 1000; until(check, "ready", (delay));', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", +delay);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", -delay);', // wait-allow: rejected lint fixture
    'const delay = 1000; until(check, "ready", delay /* c */);', // wait-allow: rejected lint fixture
    'function ready(window = 1000) { until(check, "ready", (window)); }', // wait-allow: rejected lint fixture
    'const window = 10 * 1000\nuntil(() => ready, "ready", window)', // wait-allow: rejected lint fixture
    'function ready(window = 10000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'function ready(window = 10 * 1000) { until(check, "ready", window); }', // wait-allow: rejected lint fixture
    'async function f(ok) { const start = Date.now(); while (!ok()) { if (Date.now() > start + 5000) throw new Error("late"); await new Promise(setImmediate); } }', // wait-allow: rejected lint fixture
    'async function f(ok) { var deadline = Date.now() + 5000; while (!ok()) { if (Date.now() > deadline) throw new Error("late"); await new Promise(setImmediate); } }', // wait-allow: rejected lint fixture
    'async function f(ok) { let deadline; deadline = Date.now() + 5000; while (!ok()) { if (Date.now() > deadline) throw new Error("late"); await new Promise(setImmediate); } }', // wait-allow: rejected lint fixture
    'async function f(ok) { const { setTimeout: sleep } = require("node:timers/promises"); await sleep(500); if (!ok()) throw new Error("late"); }', // wait-allow: rejected lint fixture
  ]) {
    fs.writeFileSync(bad, "'use strict';\n" + source + '\n');
    const result = run();
    assert.equal(result.status, 1, source + '\n' + result.stdout + result.stderr);
    assert.match(result.stderr, /test\/wait.test.js:\d+ (wait supplies|readiness deadline|timer wait)/);
  }
  fs.writeFileSync(bad, 'const deadline = Date.now() + 1000; // wait-allow: tests a production timeout\n'); // wait-allow: allowed lint fixture
  assert.equal(run().status, 0);
});

test('child exit is observable while inherited output is held, and close waits for its final bytes', {
  skip: process.platform === 'win32' && 'inherited output handles do not survive a forced parent exit',
}, async (t) => {
  const h = makeRepo(t);
  const release = path.join(h.base, 'release');
  const writer = `
    const fs = require('node:fs');
    const file = ${JSON.stringify(release)};
    let done = false;
    const watcher = fs.watch(require('node:path').dirname(file), check);
    function check() {
      if (done || !fs.existsSync(file)) return;
      done = true;
      process.stdout.write('final output');
      watcher.close();
    }
    check();
  `;
  const parent = cp.spawn(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {
      stdio: ['ignore', 'inherit', 'inherit'],
    }).unref();
    process.exit(0);
  `]);
  let output = '';
  let drained = false;
  const nativeClose = new Promise((resolve) => parent.once('close', resolve));
  parent.stdout.on('data', (data) => { output += data; });
  const closed = childClosed(parent, { signal: t.signal }).then((result) => { drained = true; return result; });
  try {
    assert.equal((await childExit(parent, { signal: t.signal })).code, 0);
    assert.equal(drained, false, 'the descendant retains the output pipe');
  } finally {
    fs.writeFileSync(release, '');
    await nativeClose;
  }
  assert.equal((await closed).code, 0);
  assert.equal(output, 'final output');
});
