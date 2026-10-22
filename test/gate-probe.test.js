'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { HUNG_TEST_MS } = require('./signals');
const probe = require('./fixtures/gate-probe');

test('gate probe launcher awaits success, tool failure results, and failed dispatches', { timeout: HUNG_TEST_MS }, async (t) => {
  for (const row of [
    { name: 'success', tool: 0, dispatch: 0 },
    { name: 'tool failure', tool: 7, dispatch: 0 },
    { name: 'dispatch failure', tool: 0, dispatch: 7 },
  ]) {
    const h = cachedFixture(t, 'gate-probe', h => {
      h.init();
      h.ok(['task', 'add', '--title', 'Gate probe', '--acceptance', 'probe finished']);
      h.ok(['brief', 'set', 'T1', '-'], { input: 'Gate probe launcher' });
    });
    const result = path.join(h.base, 'result.json');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({status:${row.tool}})); process.exit(${row.dispatch});`;
    h.ok(['ladder', 'set', 'medium', '--harness', 'command', '--command', JSON.stringify([process.execPath, '-e', script, '{prompt}']),
      '--clear', 'profile', '--clear', 'effort', '--clear', 'args', '--supervision', '{"retries":0}']);
    const running = probe.run(t, h);
    if (row.dispatch) await assert.rejects(running, /gate probe dispatch exited 7/, row.name);
    else await running;
    assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { status: row.tool }, row.name);
  }
});
