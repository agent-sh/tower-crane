'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { makeRepo, ROOT } = require('./helpers');
const { fileWritten, eventAppended, childExit, childClosed, portListening, waitUntil, killPid, killGroup } = require('./signals');
const { waitFindings, killFindings, checkTestWaits } = require('../scripts/test-waits');

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

test('a wait on a held process fails once the process exits, after a last check of the condition', async (t) => {
  const h = makeRepo(t);
  const never = path.join(h.base, 'never');
  await assert.rejects(fileWritten(never, { alive: cp.spawn(process.execPath, ['-e', '']), what: 'never written' }),
    /never written: the process exited first/);
  // A process that writes and then exits still satisfies the wait.
  const late = path.join(h.base, 'late');
  const writer = cp.spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(late)}, 'x')`]);
  await childExit(writer);
  assert.equal(await fileWritten(late, { alive: writer, poll: false }), 'x');
  await assert.rejects(waitUntil(() => false, { alive: writer.pid, what: 'pid wait' }), /pid wait: the process exited first/);
  await assert.rejects(waitUntil(() => false, { alive: () => false }), /the process exited first/);
  assert.equal(await waitUntil(() => 'ready', { alive: () => false }), 'ready');
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
    'until(() => class extends /ready\\)/.constructor {}, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => output.await / 2, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => output.in / 2, "ready", 1000);', // wait-allow: rejected lint fixture
    'until(() => output.return / 2, "ready", 1000);', // wait-allow: rejected lint fixture
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
    'until(() => class extends /ready\\)/.constructor {}, "ready", 300000);',
    'until(() => output.await / 2, "ready", 300000);',
    'until(() => output.in / 2, "ready", 300000);',
    'until(() => output.return / 2, "ready", 300000);',
    'const await = 100000; until(check, "ready", await + 200000);', // wait-allow: accepted folding fixture binds its constant in the generated source
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

test('the lint rejects sleeps, counted sleep loops and other clocks, and accepts polls on a signal', () => {
  for (const source of [
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); if (!ok()) throw new Error("late");', // wait-allow: rejected lint fixture
    'const sleep = (ms) => Atomics.wait(cell, 0, 0, ms);', // wait-allow: rejected lint fixture
    'for (let i = 0; i < 1200 && !ok(); i++) Atomics.wait(cell, 0, 0, 100);', // wait-allow: rejected lint fixture
    'let tries = 0; while (!ok() && tries < 50) { tries++; Atomics.wait(cell, 0, 0, 100); }', // wait-allow: rejected lint fixture
    'let left = 50; do { Atomics.wait(cell, 0, 0, 100); } while (!ok() && --left > 0);', // wait-allow: rejected lint fixture
    'const script = `for(let i=0;i<1200&&!fs.existsSync(go);i++)Atomics.wait(s,0,0,100);`;', // wait-allow: rejected lint fixture
    'cp.spawnSync("sleep", ["1"]); if (!ok()) throw new Error("late");', // wait-allow: rejected lint fixture
    'execSync("sleep 1");', // wait-allow: rejected lint fixture
    'const hook = `while [ ! -f go ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `#!/bin/sh\\ni=0\\nwhile [ ! -f go ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\\n`;', // wait-allow: rejected lint fixture
    'const hook = `#!/bin/sh\\nn=0\\nuntil [ -f go ] || [ "$n" -ge 50 ]; do sleep 0.1; n=$((n + 1)); done\\n`;', // wait-allow: rejected lint fixture
    'const hook = `for i in $(seq 50); do [ -f go ] && break; sleep 0.1; done`;', // wait-allow: rejected lint fixture
    'const hook = `for i in 1 2 3 4 5; do [ -f go ] && break; sleep 1; done`;', // wait-allow: rejected lint fixture
    'const hook = `for i in {1..50}; do [ -f go ] && break; sleep 0.1; done`;', // wait-allow: rejected lint fixture
    'const hook = `i=0\nwhile [ ! -f go ] && [ $i -lt 300 ]\ndo\n  sleep 0.1\n  i=$((i+1))\ndone\n`;', // wait-allow: rejected lint fixture
    'const hook = `i=0\\n\\twhile [ ! -f go ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `for i in 1 2 3 4 5\\ndo [ -f go ] && break; sleep 1; done`;', // wait-allow: rejected lint fixture
    'const hook = `for ((i = 0; i < 50; i++)); do [ -f go ] && break; sleep 0.1; done`;', // wait-allow: rejected lint fixture
    'const hook = `while [ ! -f go ] && [ $i -lt 300 ]; do sleep 0.1; i=\\`expr $i + 1\\`; done`;', // wait-allow: rejected lint fixture
    'const hook = `while [ ! -f go ] && [ $i -lt 300 ]; do sleep $d; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `i=0; while true; do [ -f go ] && break; i=$((i+1)); [ $i -ge 50 ] && break; sleep 0.1; done`;', // wait-allow: rejected lint fixture
    "const hook = 'i=0\\nwhile [ $i -lt 5 ]; do\\n' + '  sleep 1\\n  i=$((i+1))\\ndone\\n';", // wait-allow: rejected lint fixture
    // A helper hides its sleep from the loop that calls it, even with a reason of its own.
    'const nap = (ms) => Atomics.wait(cell, 0, 0, ms); // wait-allow: cadence\nfor (let i = 0; i < 50 && !ok(); i++) nap(100);', // wait-allow: rejected lint fixture
    'function nap(ms) { Atomics.wait(cell, 0, 0, ms); } // wait-allow: cadence\nlet n = 0; while (!ok() && n < 50) { n++; nap(100); }', // wait-allow: rejected lint fixture
    // A loop with no bound in its header can end on a count in its body.
    'let i = 0; while (true) { if (ok() || ++i > 40) break; Atomics.wait(cell, 0, 0, 100); }', // wait-allow: rejected lint fixture
    'for (let i = 0;; i++) { if (i > 40) break; Atomics.wait(cell, 0, 0, 100); }', // wait-allow: rejected lint fixture
    "cp.spawnSync('sh', ['-c', 'sleep 2']); if (!ok()) throw new Error('late');", // wait-allow: rejected lint fixture
    "cp.execSync(\"sh -c 'sleep 2'\");", // wait-allow: rejected lint fixture
    // A loop keyword after a case pattern, !, time or an interpolation, and a sleep by path or through command.
    'const hook = `case $x in a) while [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done;; esac`;', // wait-allow: rejected lint fixture
    'const hook = `! while [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `time while [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `${x} while [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `while [ $i -lt 5 ]; do /bin/sleep 1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `while [ $i -lt 5 ]; do command sleep 1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    // A script split around an operand the check cannot read, or joined from an array of lines.
    "const hook = 'while [ $i -lt 5 ]; do sleep 1; i=$((i+1));' + x + 'done';", // wait-allow: rejected lint fixture
    "const hook = 'while [ $i -lt 5 ]; do' + x + 'sleep 1; i=$((i+1)); done';", // wait-allow: rejected lint fixture
    "const hook = ['while [ $i -lt 5 ]; do', 'sleep 1', 'i=$((i+1))', 'done'].join('\\n');", // wait-allow: rejected lint fixture
    // A loop word inside a header is text, not a loop of its own.
    'const hook = `i=0; while ! grep -q "ready for" log && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `until [ -f go ] || [ $n -ge 5 ] || echo while; do sleep 1; n=$((n+1)); done`;', // wait-allow: rejected lint fixture
    "function run() { cp.spawnSync('sh', ['-c', 'sleep 1']); } // wait-allow: cadence\nfor (let i = 0; i < 3 && !ok(); i++) run();", // wait-allow: rejected lint fixture
    // A loop word in a comment or an echo before a counted loop opens no loop.
    'const hook = `#!/bin/sh\\n# wait for the go file\\ni=0\\nwhile [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done\\n`;', // wait-allow: rejected lint fixture
    'const hook = `echo "waiting for go"; i=0; while [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`;', // wait-allow: rejected lint fixture
    'const hook = `echo "sleep until ready" >&2\\nfor i in $(seq 50); do [ -f go ] && break; sleep 0.1; done`;', // wait-allow: rejected lint fixture
    // An echo's command substitution runs, and a helper's sleep may take a quoted or interpolated operand.
    'const hook = `for i in 1 2 3; do echo $(sleep 1); done`;', // wait-allow: rejected lint fixture
    "function nap() { cp.spawnSync('sh', ['-c', 'sleep \"$d\"']); } // wait-allow: cadence\nfor (let i = 0; i < 3 && !ok(); i++) nap();", // wait-allow: rejected lint fixture
    "const hook = [\n'while [ $i -lt 5 ]; do',\n'  sleep 1',\n'  i=$((i+1))',\n'done'].join('\\n');", // wait-allow: rejected lint fixture
    'const sleep = util.promisify(setTimeout); await sleep(500);', // wait-allow: rejected lint fixture
    'await promisify(setTimeout)(500);', // wait-allow: rejected lint fixture
    'await scheduler.wait(500);', // wait-allow: rejected lint fixture
    'if (process.hrtime.bigint() - start > 5000000000n) throw new Error("late");', // wait-allow: rejected lint fixture
    'const deadline = process.hrtime.bigint() + 5000000000n;', // wait-allow: rejected lint fixture
    'const [seconds] = process.hrtime(start); assert.ok(seconds < 5);', // wait-allow: rejected lint fixture
    'assert.ok(process.hrtime(start)[0] < 5);', // wait-allow: rejected lint fixture
    'if (new Date() - start > 5000) throw new Error("late");', // wait-allow: rejected lint fixture
    'const deadline = +new Date() + 5000;', // wait-allow: rejected lint fixture
    'if ((Date.now() - start) / 1000 > 5) throw new Error("late");', // wait-allow: rejected lint fixture
  ]) {
    assert.ok(waitFindings(source).length, source);
    assert.deepEqual(waitFindings(source.split('\n').map((line) => `${line} // wait-allow: fixture behaviour`).join('\n')), [], source);
  }
  for (const source of [
    'while (!fs.existsSync(go)) Atomics.wait(cell, 0, 0, 10);',
    'const end = Date.now() + 300000; while (!ok() && Date.now() < end) Atomics.wait(cell, 0, 0, 10);',
    'while (!ok()) { if (failed()) break; Atomics.wait(cell, 0, 0, 10); }',
    'do { Atomics.wait(cell, 0, 0, 10); } while (!ok());',
    'Atomics.wait(cell, 0, 0);',
    'for (let i = 0; i < items.length; i++) handle(items[i]);',
    'for (let node = start; node; node = node.parent) Atomics.wait(cell, 0, 0, 10);',
    'const script = `while(!fs.existsSync(go))Atomics.wait(s,0,0,100);`;',
    'while (!fs.existsSync(go)) cp.spawnSync("sleep", ["1"]);',
    'const hook = `while [ ! -f go ] && [ -d dir ]; do sleep 0.1; done`;',
    'const hook = `#!/bin/sh\\nwhile [ "$(wc -l < f)" -lt 2 ]; do sleep 0.1; done\\n`;',
    'const hook = `for f in a b; do touch $f; done; while [ ! -f go ]; do sleep 0.1; done`;',
    // A counted loop that does not sleep ends at its own done.
    'const hook = `for i in $(seq 5); do echo $i; done; while [ ! -f go ]; do sleep 0.1; done`;',
    'const hook = `for i in 1 2 3; do echo $i; done; while [ ! -f go ]; do sleep 0.1; done`;',
    "cp.spawnSync('sh', ['-c', 'while [ ! -f go ]; do sleep 0.1; done']);",
    'while (true) { if (ok()) break; Atomics.wait(cell, 0, 0, 10); }',
    'function waitGo() { while (!ok()) Atomics.wait(cell, 0, 0, 10); }\nfor (let i = 0; i < 3; i++) waitGo();',
    // A return in a function the if block defines does not leave the loop.
    'let n = 0; while (!ok()) { n++; if (n > 3) { list.forEach((x) => { return x; }); } Atomics.wait(cell, 0, 0, 10); }',
    // A sh -c helper sleeps only when its command does.
    "const sh = (cmd) => cp.spawnSync('sh', ['-c', cmd]);\nfor (let i = 0; i < 3; i++) sh('git commit -qm x');",
    "function run() { cp.spawnSync('sh', ['-c', 'echo ok']); }\nfor (let i = 0; i < 3; i++) run();",
    // Echoed text, a comment and an option are not sleeps.
    'const hook = `for i in 1 2 3; do echo "sleep 1"; done`;',
    'const hook = `for i in 1 2 3; do touch f # sleep 1\ndone`;',
    'const hook = `for i in 1 2 3; do tool --sleep 1; done`;',
    'await scheduler.wait(HUNG_TEST_MS);',
    'const elapsed = process.hrtime.bigint() - start; report(elapsed);',
  ]) assert.deepEqual(waitFindings(source), [], source);
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

test('tests signal only checked pids, so a pid file read before it is written cannot signal the suite', () => {
  // Number('') is 0, and signalling 0 reaches the caller's whole process group.
  for (const pid of [Number(''), 0, -0, -1, NaN, undefined, null, 1.5, '123']) {
    assert.throws(() => killPid(pid, 0), /refusing to signal pid/, String(pid));
  }
  for (const pid of [Number(''), 0, 1, -2, NaN]) {
    assert.throws(() => killGroup(pid, 0), /refusing to signal pid/, String(pid));
  }
  assert.equal(killPid(process.pid, 0), true);
  // The lint scans this file too, so the calls it judges are assembled here.
  const kill = ['process', 'kill'].join('.');
  const proc = 'process';
  for (const source of [
    `${kill}(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL');`,
    `try { ${kill}(-Number(fs.readFileSync(out, 'utf8')), 'SIGKILL'); } catch {}`,
    `${kill}(spawn.pid, 'SIGKILL');`,
    `${kill} (pid, 0);`,
    `fs.writeFileSync(script, \`${kill}(Number(process.argv[2]), 'SIGTERM');\`);`,
    // An alias reaches the same call with a pid the check cannot see.
    `const signal = ${kill};\nsignal(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL');`,
    `${kill}.call(process, Number(text), 'SIGKILL');`,
    `${proc}['kill'](Number(text), 'SIGKILL');`,
    `${proc}["kill"](pid);`,
    `const { kill: signal } = ${proc};`,
    `[pid].forEach(${kill});`,
    `fs.writeFileSync(hook, \`const forward = ${kill};\\nforward(Number(process.argv[2]));\`);`,
    // Optional chaining reaches the same call.
    `${proc}?.kill(Number(text));`,
    `${kill}?.(Number(text), 'SIGKILL');`,
    `${proc}?.kill?.(0);`,
    `const signal = ${proc}?.kill;`,
    // Code inside a template interpolation or a generated script, whatever operator comes before.
    `const s = \`\${x ? ${kill}(pid) : ''}\`;`,
    `const s = \`\${typeof ${kill}(pid)}\`;`,
    `fs.writeFileSync(f, 'const ok = pid ? ${kill}(pid) : 0;');`,
    `fs.writeFileSync(f, 'module.exports = { stop: ${kill}(pid) };');`,
    `fs.writeFileSync(f, 'a + ${kill}(n)');`,
    `fs.writeFileSync(f, 'switch (n) { case 1: ${kill}(n); }');`,
    `fs.writeFileSync(f, 'run()\\n${kill}(n)');`,
    // Only a comparing assertion compares.
    `assert.doesNotThrow(${kill});`,
    // Other ways to reach the same call.
    `const { kill } = globalThis.${proc};`,
    `const p = ${proc};\np.kill(Number(text));`,
    `const p = ${proc};\np?.['kill'](pid);`,
    `${proc}[name](0);`,
    `${proc}[\`kill\`](0);`,
    // The global object's process and a spread reach this process.
    `global.${kill}(pid);`,
    `globalThis?.${kill}(0);`,
    `f(...${kill}(pid));`,
    `fs.writeFileSync(f, 'f(...${kill}(pid))');`,
    `const { kill } = global.${proc};`,
    `const k = global.${kill};`,
    `const k = globalThis?.${kill};`,
    // An escape ends the previous line of a generated script.
    `fs.writeFileSync(f, 'x;\\nglobal.${kill}(pid)');`,
    `fs.writeFileSync(f, 'x;\\tglobal.${kill}(pid)');`,
    `fs.writeFileSync(f, \`x;\\nglobalThis.${kill}(pid)\`);`,
  ]) {
    assert.equal(killFindings(source).length, 1, source);
  }
  for (const source of [
    `${kill}(process.pid, 'SIGKILL');`,
    `fs.writeFileSync(script, '${kill}(process.pid, \\'SIGKILL\\');\\n');`,
    `// ${kill}(0) signals the group`,
    'killPid(Number(text), "SIGKILL"); killGroup(child.pid, "SIGKILL");',
    // Prose after the code on the same line is not a call.
    `killPid(pid, 'SIGTERM'); // not ${kill}(0), which signals the group`,
    `fs.writeFileSync(script, \`run();\\nstop(); // ${kill}(-pid) would reach the group\\n\`);`,
    `${kill} = function interposed(pid, signal) { return true; };`,
    `test('the ${kill} interposers forward other pids', () => {});`,
    // A comparison holds no alias.
    `if (${kill} === original) return;`,
    `if (original !== ${kill}) restore();`,
    `assert.equal(${kill}, original);`,
    `assert.equal(global.${kill}, original);`,
    `Object.is(global.${kill}, k);`,
    `assert.notStrictEqual(original, ${kill}, 'restored');`,
    `Object.is(${kill}, original);`,
    // Quoted prose and another object's process are not calls.
    `throw new Error('do not call ${kill}(0), which signals the group');`,
    `log("never ${kill}(-pid) from a test");`,
    `child.${kill}(pid);`,
    `log(\`never ${kill}(-pid) \${'here'}\`);`,
    `const p = ${proc};\np.kill(p.pid, 'SIGKILL');\nconst home = p.env.HOME;`,
    `const home = ${proc}['env'].HOME;`,
  ]) {
    assert.deepEqual(killFindings(source), [], source);
  }
});

test('an interposer may hold process.kill only to forward its own pid and signal', () => {
  // The lint scans this file too, so the sources it judges are assembled here.
  const kill = ['process', 'kill'].join('.');
  const proc = 'process';
  const hold = `const kill = ${kill};\n${kill} = function probe(pid, signal) {\n  if (pid === 7 && signal === 0) return true;\n  return kill.call(this, pid, signal);\n};\n`;
  const late = `const kill = ${kill};\n${kill} = function probe(pid, signal) {\n  queueMicrotask(() => { try { kill.call(process, pid, signal); } catch {} });\n};\n`;
  assert.deepEqual(killFindings(hold, { interposer: true }), []);
  assert.deepEqual(killFindings(late, { interposer: true }), []);
  assert.deepEqual(killFindings(`fs.writeFileSync(hook, \`\n${hold}\`);`, { interposer: true }), [], 'a generated interposer');
  assert.deepEqual(killFindings(hold).map((f) => f.line), [1], 'a file not named as an interposer may not hold one');
  for (const [extra, line] of [
    [`${proc}['kill'](0);`, 6],
    [`kill.call(process, 0, 'SIGKILL');`, 6],
    ['kill(Number(text));', 6],
    ['[pid].forEach(kill);', 6],
    [`${kill} = function again(pid, signal) {\n  return kill.call(this, 0, signal);\n};`, 7],
  ]) {
    assert.deepEqual(killFindings(hold + extra, { interposer: true }).map((f) => f.line), [line], extra);
  }
  const body = (lines) => `const kill = ${kill};\n${kill} = function probe(pid, signal) {\n${lines}\n};\n`;
  assert.deepEqual(killFindings(body('  pid = 0;\n  return kill.call(this, pid, signal);'), { interposer: true }).map((f) => f.line), [4],
    'a forward of a changed pid is not a forward');
  assert.deepEqual(killFindings(body("  if (pid === 7) log('}');\n  return kill.call(this, pid, signal);"), { interposer: true }), [],
    'a brace in a string does not end the replacement');
  assert.deepEqual(killFindings(body('  calls[pid] = signal;\n  return kill.call(this, pid, signal);'), { interposer: true }), [],
    'a write to another object keyed by the pid leaves the pid unchanged');
  assert.deepEqual(killFindings(`fs.writeFileSync(hook, \`kill(0);\n${hold}\`);`, { interposer: true }).map((f) => f.line), [1],
    'a use at the start of a generated script');
  assert.deepEqual(killFindings(body("  log('{');\n  return kill.call(this, pid, signal);")
    + 'function other(pid, signal) {\n  return kill.call(this, pid, signal);\n}\n', { interposer: true }).map((f) => f.line), [7],
  'a brace in a string does not stretch the replacement over the next function');
  for (const [lines, line] of [
    ['  [pid] = [0];\n  return kill.call(this, pid, signal);', 4],
    ['  ({ pid } = options);\n  return kill.call(this, pid, signal);', 4],
    ['  for (pid of [0]) break;\n  return kill.call(this, pid, signal);', 4],
    ['  arguments[0] = 0;\n  return kill.call(this, pid, signal);', 4],
    ['  arguments[0]++;\n  return kill.call(this, pid, signal);', 4],
    ['  if (x) [pid] = [0];\n  return kill.call(this, pid, signal);', 4],
    ['  Object.assign(arguments, [0]);\n  return kill.call(this, pid, signal);', 4],
    ['  function inner(pid) { return kill.call(this, pid, signal); }\n  return inner(0);', 3],
  ]) {
    assert.deepEqual(killFindings(body(lines), { interposer: true }).map((f) => f.line), [line], lines);
  }
  for (const [extra, line] of [
    // A default value uses the alias; it binds another name.
    ['function f(a = kill) { return a(0); }', 6],
    ['((a = kill) => a(0))();', 6],
    // A declaration in a comment or a string rebinds nothing.
    ['// const kill holds the original\nkill(0);', 7],
    ["log('let kill');\nkill(0);", 7],
    // A ternary branch and a case label are uses, not object keys.
    ['const f = c ? kill : noop;', 6],
    ['switch (x) { case kill: break; }', 6],
  ]) {
    assert.deepEqual(killFindings(hold + extra, { interposer: true }).map((f) => f.line), [line], extra);
  }
  assert.deepEqual(killFindings(`${hold}const o = { kill: 1, other: 2 };\n`, { interposer: true }), [], 'an object key is not a use');
  assert.deepEqual(killFindings(`if (x) {\n  function later() { return kill(0); }\n  ${hold}}\n`, { interposer: true }).map((f) => f.line), [2],
    'a function declared above the interposer in its block sees the same alias');
  // Another binding named like the alias is another value.
  assert.deepEqual(killFindings(`${hold}function relay(kill) { return kill(); }\nconst stop = (kill) => kill.now();\n[1].map(kill => kill + 1);\n`,
    { interposer: true }), []);
  assert.deepEqual(killFindings(`if (env.X) {\n  ${hold}}\nfunction later(pid) { const kill = signals.kill; kill(pid); }\n`, { interposer: true }), []);
  const apart = `const kill = ${kill};\nconst read = fs.readFileSync;\n${kill} = function probe(pid, signal) {\n  return kill.call(this, pid, signal);\n};\n`;
  assert.deepEqual(killFindings(apart, { interposer: true }).map((f) => f.line), [1],
    'the replacement must follow the held original at once');
});

test('only the named interposers may hold an alias of the signal call, and only on its line', (t) => {
  const { base } = makeRepo(t);
  const kill = ['process', 'kill'].join('.');
  const alias = `const forward = ${kill};\n${kill} = function probe(pid, signal) {\n  return forward.call(this, pid, signal);\n};\n`;
  fs.mkdirSync(path.join(base, 'test', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(base, 'test', 'fixtures', 'hooks.js'), `${alias}${['process', "['kill']"].join('')}(0);\n`);
  fs.writeFileSync(path.join(base, 'test', 'fixtures', 'other.js'), alias);
  assert.throws(() => checkTestWaits(base), (error) => {
    const lines = error.message.split('\n');
    assert.equal(lines.length, 2, error.message);
    assert.match(lines[0], /^test\/fixtures\/hooks\.js:5 `process\['kill'\]\(0\);` aliases process\.kill/);
    assert.match(lines[1], /^test\/fixtures\/other\.js:1 `const forward = process\.kill;` aliases process\.kill/);
    return true;
  });
});
