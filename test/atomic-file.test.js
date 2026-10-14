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

// Windows refuses to open a file while a rename replaces it or its removal is
// pending. Runs `read` as on Windows with the first open of `file` refused
// with `code`, and returns what it read and how many opens were refused.
async function readRefusedOnce(file, code, read) {
  const { readFileSync } = fs;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  let refused = 0;
  fs.readFileSync = function refuseOnce(target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(file) && !refused) {
      refused++;
      throw Object.assign(new Error(`${code}: operation not permitted, open '${target}'`), { code });
    }
    return readFileSync.call(this, target, ...rest);
  };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    return { value: await read(), refused };
  } finally {
    fs.readFileSync = readFileSync;
    Object.defineProperty(process, 'platform', platform);
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
  assert.throws(() => readPublished('x', 'utf8', refused('EPERM')), { code: 'EPERM' });
  const missing = await readRefusedOnce('unused', 'EPERM', () => {
    try { return readPublished('x', 'utf8', refused('ENOENT')); } catch (error) { return error.code; }
  });
  assert.equal(missing.value, 'ENOENT');
});

// A reader that takes a missing file for "not written yet" polls a file some
// process publishes, so it opens it with readPublished. A read whose file no
// process replaces says why in a `// read-published:` comment on its line or
// the line before.
test('test readers that wait for a file open it with readPublished', () => {
  const found = [];
  const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []);
  for (const file of files(__dirname).sort()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bfs\.readFileSync\(/.test(line)) return;
      const handler = lines.slice(i, i + 3).join('\n');
      if (!/\bcatch\b/.test(handler) || !/['"]ENOENT['"]/.test(handler)) return;
      const reason = (l) => /\/\/ read-published: \S/.test(lines[l] || '');
      if (reason(i) || reason(i - 1)) return;
      found.push(`${path.relative(path.dirname(__dirname), file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], 'read with readPublished from test/atomic-file.js, or say why no process replaces the file');
});
