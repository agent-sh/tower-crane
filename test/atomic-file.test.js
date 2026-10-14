'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo } = require('./helpers');
const { waitFor } = require('./canary');

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
  try { seen = fs.readFileSync(signal, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
while (!fs.existsSync(go) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
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
