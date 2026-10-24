'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { makeRepo, pinRung } = require('./helpers');
const { collectRuntimeEntries, runtimeProbe, assertRuntimeEntries } = require('./runtime-entries');

test('runtime entry checks allow exactly the socket leaf and optional bus', () => {
  const runtime = path.resolve('runtime');
  const leaf = 'tc-012345abcdef';
  const inside = path.join(runtime, leaf);
  const outside = path.join(path.dirname(runtime), 'other-runtime', leaf);
  for (const [label, socketDir, enabled, entries, valid] of [
    ['bus off, leaf inside', inside, false, [leaf], true],
    ['bus on, leaf inside', inside, true, [leaf, 'bus'], true],
    ['bus off, leaf elsewhere', outside, false, 'ERR ENOENT', true],
    ['bus on, leaf elsewhere', outside, true, ['bus'], true],
    ['undeclared leaf', inside, false, ['tc-abcdef012345'], false],
    ['bus exposed while off', inside, false, [leaf, 'bus'], false],
    ['manager exposed', inside, true, [leaf, 'bus', 'systemd'], false],
    ['late socket exposed', inside, true, [leaf, 'bus', 'late.sock'], false],
    ['another socket exposed', inside, true, [leaf, 'bus', 'other.sock'], false],
    ['missing leaf', inside, true, ['bus'], false],
    ['missing bus', inside, true, [leaf], false],
    ['inaccessible granted leaf', inside, false, 'ERR EACCES', false],
    ['empty ungranted runtime exposed', outside, false, [], false],
  ]) {
    const seen = collectRuntimeEntries({
      readdirSync(dir) {
        assert.equal(dir, runtime);
        if (typeof entries === 'string') throw Object.assign(new Error('unmounted'), { code: entries.slice(4) });
        return entries;
      },
    }, runtime, socketDir);
    if (valid) assert.doesNotThrow(() => assertRuntimeEntries(seen, runtime, enabled), label);
    else assert.throws(() => assertRuntimeEntries(seen, runtime, enabled), assert.AssertionError, label);
  }
});

test('the runtime probe rejects the old count-only result', () => {
  const runtime = path.resolve('runtime');
  const socketDir = path.join(runtime, 'tc-012345abcdef');
  for (const [enabled, count] of [[false, 1], [true, 2]]) {
    assert.throws(() => assertRuntimeEntries({ socketDir, runtime: count }, runtime, enabled), assert.AssertionError);
  }
});

test('the serialized live probe records entry names and its environment declaration', () => {
  const runtime = path.resolve('runtime');
  const socketDir = path.join(runtime, 'tc-012345abcdef');
  for (const enabled of [false, true]) {
    const seen = {};
    vm.runInNewContext(runtimeProbe(runtime), {
      o: seen,
      process: { env: { TOWER_CRANE_SOCKET_DIR: socketDir } },
      f: { readdirSync: () => enabled ? ['bus', path.basename(socketDir)] : [path.basename(socketDir)] },
    });
    assertRuntimeEntries(seen, runtime, enabled);
  }
});

test('a spawned Codex command exposes the socket declaration to the runtime probe', {
  skip: process.platform === 'win32' && 'the stand-in uses a shebang',
}, (t) => {
  const h = makeRepo(t);
  h.init();
  h.ok(['task', 'add', '--title', 'Runtime entries', '--acceptance', 'the probe records its leaf']);
  h.ok(['brief', 'set', 'T1', '-'], { input: 'runtime entries\n' });
  const bin = path.join(h.base, 'bin');
  const out = path.join(h.base, 'entries.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const f = require('node:fs'), path = require('node:path');
const runtime = path.dirname(process.env.TOWER_CRANE_SOCKET_DIR);
const o = (${collectRuntimeEntries.toString()})(f, runtime, process.env.TOWER_CRANE_SOCKET_DIR);
f.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ runtime, seen: o }));
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'runtime' }));
`, { mode: 0o755 });
  pinRung(h, 'small', { harness: 'codex', model: 'probe' });
  h.ok(['spawn', '--role', 'small', '--task', 'T1', '--wait'], { env: {
    ...h.env, CODEX_HOME: '', PATH: `${bin}${path.delimiter}${h.env.PATH}`,
  } });
  const { runtime, seen } = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(seen.runtime.includes(path.basename(seen.socketDir)), 'the actual runtime contains the declared leaf');
  assert.equal(path.dirname(seen.socketDir), runtime);
});
