'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

function collectRuntimeEntries(f, runtime, socketDir) {
  const seen = { socketDir };
  try { seen.runtime = f.readdirSync(runtime); }
  catch (error) { seen.runtime = `ERR ${error.code}`; }
  return seen;
}

function runtimeProbe(runtime) {
  return `Object.assign(o,(${collectRuntimeEntries.toString()})(f,${JSON.stringify(runtime)},process.env.TOWER_CRANE_SOCKET_DIR));`;
}

function assertRuntimeEntries(seen, runtime, busEnabled) {
  assert.ok(typeof seen.socketDir === 'string' && path.isAbsolute(seen.socketDir), 'the probe records its declared socket leaf');
  assert.match(path.basename(seen.socketDir), /^tc-[0-9a-f]{12}$/);
  const expected = busEnabled ? ['bus'] : [];
  if (path.dirname(seen.socketDir) === runtime) expected.push(path.basename(seen.socketDir));
  if (!expected.length) {
    assert.match(seen.runtime, /^ERR /, 'a runtime with no granted entry stays inaccessible');
    return;
  }
  assert.ok(Array.isArray(seen.runtime), 'the runtime listing records names');
  assert.deepEqual([...seen.runtime].sort(), expected.sort(), 'only the enabled bus and declared socket leaf are visible');
}

module.exports = { collectRuntimeEntries, runtimeProbe, assertRuntimeEntries };
