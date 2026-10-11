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
  for (const source of [
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
    const annotated = source.split('\n').map((line) => line + ' // wait-allow: verifies the production timer contract').join('\n');
    assert.deepEqual(waitFindings(annotated), []);
    assert.ok(waitFindings(source + ' // wait-allow:').length, 'an empty reason is refused');
  }
  assert.deepEqual(waitFindings('const deadline = Date.now() + HUNG_TEST_MS;'), []);
  assert.deepEqual(waitFindings('const deadline = Date.now() + 300000;'), []);
  assert.deepEqual(waitFindings('cp.spawnSync("node", [], { timeout: Math.max(budget, HUNG_TEST_MS) });'), []);
  assert.deepEqual(waitFindings('async function until(check, what, budget = Math.max(HUNG_TEST_MS, other)) {}'), []);
  assert.deepEqual(waitFindings('const budget = 300000; const guard = budget; until(check, "ready", guard);'), []);
  assert.deepEqual(waitFindings('const window = Math.max(HUNG_TEST_MS, other); until(check, "ready", window);'), []);
  assert.deepEqual(waitFindings('const { unused } = settings, window = 300000; until(check, "ready", window);'), []);
  assert.deepEqual(waitFindings('const delay = 300000, window = delay; function ready() { const delay = 1000; until(check, "ready", window); }'), []);
  assert.deepEqual(waitFindings('const delay = 300000; { const window = delay; { const delay = window; until(check, "ready", delay); } }'), []);
  assert.deepEqual(waitFindings('async function waitFor(check, what = "ready", options = {}) {}'), []);
  assert.deepEqual(waitFindings('const h = setup(t, "codex", { cpu_ms: 1000 }); until(t, h, check);'), []);
  assert.deepEqual(waitFindings('const h = setup(t, "codex", { cpu_ms: 10 * 1000 }); until(t, h, check);'), []);
  assert.deepEqual(waitFindings('const label = "ready", delay = 300000; until(check, label, delay);'), []);
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
