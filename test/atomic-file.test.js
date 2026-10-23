'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const { waitFor } = require('./canary');
const { writeAtomic, readPublished } = require('./atomic-file');
const { fileWritten } = require('./signals');

const FIXTURES = path.join(__dirname, 'fixtures');
const PARTIAL = path.join(FIXTURES, 'partial-write.js');

// Starts node with partial-write.js holding the first write to `target` halfway.
function heldWriter(t, target, preload, script, env = {}) {
  const child = cp.spawn(process.execPath, ['--require', PARTIAL, ...preload.flatMap((file) => ['--require', file]), '-e', script], {
    env: { ...process.env, PARTIAL_WRITE_TARGET: target, ...env }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, closed, stderr: () => stderr };
}

test('a hook signal names its process even while the write is held halfway', async (t) => {
  const h = makeRepo(t);
  const signal = path.join(h.base, 'paused');
  const writer = heldWriter(t, signal, [path.join(FIXTURES, 'hooks.js')],
    "try { require('node:child_process').execFileSync('git', ['status'], { stdio: 'ignore' }); } catch {}",
    { HOOK_STOP_WORKTREE_STATUS: signal });
  assert.notEqual(await waitFor(`${signal}.half`), null, `the hook did not start its signal: ${writer.stderr()}`);
  // A reader polling the signal now finds nothing or the whole pid, never a part of it.
  let seen;
  try { seen = readPublished(signal, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.ok(seen === undefined || Number(seen) === writer.child.pid, `a reader found ${JSON.stringify(seen)} for pid ${writer.child.pid}`);
  fs.writeFileSync(`${signal}.finish`, '');
  assert.equal(Number(await waitFor(signal, { nonempty: true })), writer.child.pid);
  fs.writeFileSync(`${signal}.go`, '');
  assert.equal(await writer.closed, 0, writer.stderr());
});

test('a JSON wait reads through a file a plain write has left half written', async (t) => {
  const h = makeRepo(t);
  const file = path.join(h.base, 'report.json');
  const value = { harness: 'codex', args: ['exec', 'a longer argument so the half is a broken string'] };
  const writer = heldWriter(t, file, [],
    `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(value))});`);
  assert.notEqual(await waitFor(`${file}.half`), null, `the writer did not start: ${writer.stderr()}`);
  // The file exists with half its JSON: a reader that parses the first text it finds throws here.
  assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), SyntaxError);
  const read = waitFor(file, { json: true });
  fs.writeFileSync(`${file}.finish`, '');
  assert.deepEqual(await read, value);
  assert.equal(await writer.closed, 0, writer.stderr());
});

// A holder killed inside its lock leaves a lock naming a dead pid. Waiters
// that find it at once must still take turns: the takeover lets one of them
// remove it, and no second waiter removes the lock the first then took.
test('waiters on a lock left by a dead holder take turns with updateJson', async (t) => {
  const h = makeRepo(t);
  const file = path.join(h.base, 'shared.json');
  const go = path.join(h.base, 'go');
  const WAITERS = 16;
  const ROUNDS = 3;
  const script = path.join(h.base, 'waiter.js');
  fs.writeFileSync(script, `const fs = require('node:fs');
const { updateJson } = require(${JSON.stringify(path.join(__dirname, 'atomic-file.js'))});
const [ready, go, inside] = process.argv.slice(2);
fs.writeFileSync(ready, '');
const deadline = Date.now() + 300000;
const parent = process.ppid;
while (!fs.existsSync(go) && Date.now() < deadline && process.ppid === parent) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
updateJson(${JSON.stringify(file)}, (d) => {
  try { fs.writeFileSync(inside, String(process.pid), { flag: 'wx' }); } catch { d.overlaps++; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // wait-allow: a hold long enough that a second holder meets the first
  fs.rmSync(inside, { force: true });
  d.updates++;
  return d;
});
`);
  fs.writeFileSync(file, JSON.stringify({ updates: 0, overlaps: 0 }));
  const lockFile = path.join(h.base, '.shared.json.lock');
  for (let round = 0; round < ROUNDS; round++) {
    const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(lockFile, dead);
    fs.rmSync(go, { force: true });
    const waiters = Array.from({ length: WAITERS }, (_, i) => {
      const ready = path.join(h.base, `ready-${round}-${i}`);
      const child = cp.spawn(process.execPath, [script, ready, go, path.join(h.base, 'inside')], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const closed = new Promise((resolve) => child.once('close', (code) => resolve({ code, stderr })));
      t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
      return { ready, closed };
    });
    for (const w of waiters) assert.notEqual(await waitFor(w.ready), null, 'a waiter did not start');
    fs.writeFileSync(go, '');
    for (const w of waiters) {
      const { code, stderr } = await w.closed;
      assert.equal(code, 0, stderr);
    }
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { updates: WAITERS * ROUNDS, overlaps: 0 });
  assert.deepEqual(fs.readdirSync(h.base).filter((name) => name.includes('.lock')), [], 'no lock or takeover file is left');
});

// A fixture or stub that writes a file with content publishes it with
// writeAtomic, since a test may poll it. An empty marker signals by existing,
// and a write no test polls says why in a `// write-atomic:` comment on its line
// or the line before.
test('fixtures publish the files they write through writeAtomic', () => {
  const found = [];
  for (const name of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.js')).sort()) {
    const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    const lines = text.split('\n');
    const call = /(?:\bfs|\breal|require\((['"])node:fs\1\))\.writeFileSync\(/g;
    for (let m; (m = call.exec(text));) {
      const data = secondArgument(text, m.index + m[0].length);
      if (data === "''" || data === '""') continue;
      const line = text.slice(0, m.index).split('\n').length - 1;
      const reason = (l) => /\/\/ write-atomic: \S/.test(lines[l] || '');
      if (reason(line) || reason(line - 1)) continue;
      found.push(`test/fixtures/${name}:${line + 1}: ${lines[line].trim()}`);
    }
  }
  assert.deepEqual(found, [], 'use writeAtomic from test/atomic-file.js, or say why no test polls the file');
});

// The source of a call's second argument, from the index just past its `(`.
function secondArgument(text, start) {
  const args = [];
  let depth = 0;
  let quote = null;
  let from = start;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && depth-- === 0) { args.push(text.slice(from, i).trim()); break; }
    else if (c === ',' && depth === 0) { args.push(text.slice(from, i).trim()); from = i + 1; }
  }
  return args[1];
}

// A fixture that reads a whole file and writes its own copy back drops what
// a concurrent fixture process wrote between the two: gh stubs and harness
// stubs run once per call, often side by side. Such a fixture changes the
// file with updateJson from test/atomic-file.js, which holds a lock across
// the read and the write. A write back that no other process races says why
// in a `// update-json: reason` comment on its line or the line before.
const WHOLE_READ = /\b(?:readFile(?:Sync)?|readPublished)\(/g;
const WHOLE_WRITE = /\b(?:writeFile(?:Sync)?|writeAtomic)\(/g;

function writeBacks(text) {
  const lines = text.split('\n');
  // A path held in a constant or variable names the same file as its value.
  const names = new Map([...text.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;\n]+)/g)].map((m) => [m[1], m[2].trim()]));
  const target = (at) => {
    const arg = firstArgument(text, at);
    return names.get(arg) ?? arg;
  };
  const reads = [...text.matchAll(WHOLE_READ)].map((m) => ({ at: m.index, file: target(m.index + m[0].length) }));
  const found = [];
  for (const m of text.matchAll(WHOLE_WRITE)) {
    const file = target(m.index + m[0].length);
    if (!reads.some((r) => r.at < m.index && r.file === file)) continue;
    const line = text.slice(0, m.index).split('\n').length - 1;
    const reason = (l) => /\/\/ update-json: \S/.test(lines[l] || '');
    if (reason(line) || reason(line - 1)) continue;
    found.push(line + 1);
  }
  return found;
}

test('the write-back lint finds a fixture that writes back the file it read', () => {
  const flagged = [
    "const data = JSON.parse(fs.readFileSync(file, 'utf8'));\ndata.calls.push(args);\nwriteAtomic(file, JSON.stringify(data));",
    "const rows = JSON.parse(readPublished(process.env.ROWS, 'utf8'));\nfs.writeFileSync(process.env.ROWS, JSON.stringify(rows));",
    "const file = process.env.GH;\nconst state = JSON.parse(fs.readFileSync(process.env.GH, 'utf8'));\nconst save = () => writeAtomic(file, JSON.stringify(state));",
    "const s = JSON.parse(real.readFileSync(f));\nreal.writeFileSync(f, JSON.stringify(s));",
  ];
  for (const text of flagged) assert.equal(writeBacks(text).length, 1, text);
  const clean = [
    "updateJson(file, (data) => { data.calls.push(args); return data; });",
    "const data = JSON.parse(readPublished(file, 'utf8'));\nupdateJson(file, (d) => d);",
    "const data = JSON.parse(fs.readFileSync(input, 'utf8'));\nwriteAtomic(output, JSON.stringify(data));",
    "writeAtomic(file, '{}');\nconst data = JSON.parse(readPublished(file, 'utf8'));",
    "const x = fs.readFileSync(f);\n// update-json: only this process writes f.\nfs.writeFileSync(f, x);",
  ];
  for (const text of clean) assert.deepEqual(writeBacks(text), [], text);
});

test('fixtures change a file they read only through updateJson', () => {
  const found = [];
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
  for (const file of files(FIXTURES).sort()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of writeBacks(lines.join('\n'))) {
      found.push(`${path.relative(path.dirname(__dirname), file)}:${line}: ${lines[line - 1].trim()}`);
    }
  }
  assert.deepEqual(found, [], 'change the file with updateJson from test/atomic-file.js, or say why no other process writes it');
});

// Runs `fn` with process.platform reporting `name`.
async function onPlatform(name, fn) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: name });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

// Windows refuses to open a file while a rename replaces it or its removal is
// pending. Runs `read` as on Windows with the first open of `file` refused
// with `code`, and returns what it read and how many opens were refused.
async function readRefusedOnce(file, code, read) {
  const { readFileSync } = fs;
  let refused = 0;
  fs.readFileSync = function refuseOnce(target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file) && !refused) {
      refused++;
      throw Object.assign(new Error(`${code}: operation not permitted, open '${target}'`), { code });
    }
    return readFileSync.call(this, target, ...rest);
  };
  try {
    return await onPlatform('win32', async () => ({ value: await read(), refused }));
  } finally {
    fs.readFileSync = readFileSync;
  }
}

test('readers of published files read through a Windows sharing refusal', async (t) => {
  const h = makeRepo(t);
  const record = path.join(h.base, 'detached', '4242.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  writeAtomic(record, JSON.stringify({ pid: 4242, kind: 'worker' }));
  const state = path.join(h.state, 'tasks.json');
  fs.mkdirSync(h.state, { recursive: true });
  writeAtomic(state, JSON.stringify({ tasks: [] }));
  const report = path.join(h.base, 'report.json');
  writeAtomic(report, JSON.stringify({ ok: true }));
  try {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const detached = await readRefusedOnce(record, code, () => h.detached().map((r) => r.pid));
      assert.deepEqual(detached, { value: [4242], refused: 1 }, `${code}: a refused detached record was dropped`);
      assert.deepEqual(await readRefusedOnce(state, code, () => h.readState('tasks.json')), { value: { tasks: [] }, refused: 1 }, `${code}: readState`);
      assert.deepEqual(await readRefusedOnce(report, code, () => fileWritten(report, { json: true })), { value: { ok: true }, refused: 1 }, `${code}: fileWritten`);
    }
  } finally {
    // Teardown would otherwise signal pid 4242.
    fs.rmSync(record, { force: true });
  }
});

test('a published read waits out a Windows refusal only', async () => {
  const refused = (code) => ({ readFileSync() { throw Object.assign(new Error(code), { code }); } });
  // Elsewhere a refusal is a real permission error, and a missing file is the caller's answer everywhere.
  for (const platform of ['linux', 'darwin']) {
    await onPlatform(platform, () => {
      let calls = 0;
      const impl = { readFileSync() { calls++; return refused('EPERM').readFileSync(); } };
      assert.throws(() => readPublished('x', 'utf8', impl), { code: 'EPERM' }, platform);
      assert.equal(calls, 1, `${platform}: a refusal is not retried`);
    });
  }
  await onPlatform('win32', () => {
    assert.throws(() => readPublished('x', 'utf8', refused('ENOENT')), { code: 'ENOENT' });
  });
});

// A reader that takes a missing file for "not written yet", by catching
// ENOENT or by checking existsSync on the same path first, polls a file some
// process publishes, so it opens it with readPublished. A read whose file no
// process replaces says why in a `// read-published:` comment on its line or
// the line before.
const PLAIN_READ = /(?:^|[^\w.$]|\b(?:fs|real)\.|\)\.)readFileSync\(/g;

// The source of a call's first argument, from the index just past its `(`.
function firstArgument(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && depth-- === 0) return text.slice(start, i).trim();
    else if (c === ',' && depth === 0) return text.slice(start, i).trim();
  }
  return null;
}

const existsArguments = (line) => [...line.matchAll(/\bexistsSync\(/g)].map((m) => firstArgument(line, m.index + m[0].length));

function unpublishedReads(text) {
  const lines = text.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    const reads = [...line.matchAll(PLAIN_READ)].map((m) => firstArgument(line, m.index + m[0].length));
    if (!reads.length) return;
    const handler = lines.slice(i, i + 3).join('\n');
    // The guard is on the same line, opens the block the read is in, or is
    // the condition a continued `?`, `&&` or `||` line completes.
    const continues = /\{\s*$/.test(lines[i - 1] || '') || /^\s*(?:\?|&&|\|\|)/.test(line);
    const guarded = [...existsArguments(line), ...(continues ? existsArguments(lines[i - 1]) : [])];
    const missing = (/\bcatch\b/.test(handler) && /['"]ENOENT['"]/.test(handler)) || reads.some((r) => guarded.includes(r));
    if (!missing) return;
    const reason = (l) => /\/\/ read-published: \S/.test(lines[l] || '');
    if (reason(i) || reason(i - 1)) return;
    found.push(i + 1);
  });
  return found;
}

test('the published-read lint finds each form of a reader waiting for a file', () => {
  const flagged = [
    "try { x = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }", // read-published: lint sample
    "const read = () => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];", // read-published: lint sample
    "if (fs.existsSync(path.join(d, f))) {\n  data = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));", // read-published: lint sample
    "try { x = readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }", // read-published: lint sample
    "try { x = real.readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }", // read-published: lint sample
    "const x = fs.existsSync(f) && require('node:fs').readFileSync(f);", // read-published: lint sample
    "const x = () => fs.existsSync(f)\n  ? fs.readFileSync(f, 'utf8') : '';", // read-published: lint sample
    "const rows = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];", // read-published: lint sample
  ];
  for (const text of flagged) assert.equal(unpublishedReads(text).length, 1, text);
  const clean = [
    "const x = fs.existsSync(f) ? JSON.parse(readPublished(f, 'utf8')) : [];",
    "const rows = () => fs.existsSync(marker) ? readPublished(marker, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : [];",
    "const x = fs.readFileSync(f, 'utf8');",
    "assert.ok(fs.existsSync(f), fs.readFileSync(log, 'utf8'));", // read-published: lint sample
    "assert.ok(fs.existsSync(f));\nconst x = fs.readFileSync(f, 'utf8');", // read-published: lint sample
    "// read-published: appended only.\ntry { x = fs.readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }",
    "try { return impl.readFileSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; }",
  ];
  for (const text of clean) assert.deepEqual(unpublishedReads(text), [], text);
});

test('test readers that wait for a file open it with readPublished', () => {
  const found = [];
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
  for (const file of files(__dirname).sort()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of unpublishedReads(lines.join('\n'))) {
      found.push(`${path.relative(path.dirname(__dirname), file)}:${line}: ${lines[line - 1].trim()}`);
    }
  }
  assert.deepEqual(found, [], 'read with readPublished from test/atomic-file.js, or say why no process replaces the file');
});
