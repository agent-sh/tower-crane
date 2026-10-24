'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { makeRepo, ROOT } = require('./helpers');
const { fakeAgentEnv } = require('./agent-env');
const { HUNG_TEST_MS } = require('./signals');
const { select } = require('../lib/tests-map');
const { globToRegExp } = require('../lib/gates/tests');

const areas = {
  common: ['sourceOf', 'eligible'],
  schedule: ['busy', 'outranked', 'governorDeferred', 'backlog', 'prioritize', 'gateQueue', 'describeQueue'],
  executors: ['cpuLeases', 'gateWaits', 'describeExecutors'],
  gates: ['gatesRetry', 'CI_POLL'],
  restore: ['unrestorable', 'headMoved'],
  generated: ['refreshStacks', 'MERGEABILITY'],
  advance: ['reviewHeld'],
  merge: ['merge', 'queue', 'mergeBlockers'],
  'head-check': ['headCheck', 'suite'],
  refill: ['refillWorkers', 'refillBlockers'],
  ci: ['ciCompleted', 'ciWebhook'],
};

test('area modules load first without losing the automation exports or shared settings', () => {
  for (const [area, names] of Object.entries(areas)) {
    const modulePath = path.join(ROOT, 'lib', `automation-${area}.js`);
    const facadePath = path.join(ROOT, 'lib', 'automation.js');
    const run = cp.spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const area = require(${JSON.stringify(modulePath)});
      const automation = require(${JSON.stringify(facadePath)});
      for (const name of ${JSON.stringify(names)}) {
        assert.ok(area[name], name);
        if (Object.hasOwn(automation, name)) assert.equal(automation[name], area[name], name);
      }
      assert.equal(typeof automation.consume, 'function');
    `], { env: fakeAgentEnv(process.env), encoding: 'utf8', timeout: HUNG_TEST_MS });
    assert.equal(run.status, 0, `${area}: ${run.stderr}`);
  }
});

test('every area module selects existing suites through the repository tests map', () => {
  const map = require('../tools/tests-map.json');
  const available = new Set(Object.values(map).flat());
  const project = { tests: { expensive: true, map }, gates: { tests_proof_cmd: 'node test/run.js {tests}' },
    ci: { required: ['tests'] } };
  for (const area of Object.keys(areas)) {
    const source = `lib/automation-${area}.js`;
    assert.ok(map[source]?.length, source);
    const result = select(project, [{ path: source, status: 'M' }], (file) => file.endsWith('.test.js'),
      available, globToRegExp, { pr: 1 });
    assert.equal(result.mode, 'mapped', source);
    assert.ok(result.tests.includes('test/automation-modules.test.js'), source);
    assert.ok(result.tests.some((file) => file !== 'test/automation-modules.test.js'), source);
    for (const file of result.tests) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
});

test('the CLI routes CI webhooks through the extracted completion module', (t) => {
  const h = makeRepo(t);
  h.init(['--repo', 'acme/demo']);
  const payload = path.join(h.base, 'webhook.json');
  fs.writeFileSync(payload, JSON.stringify({ repository: { full_name: 'acme/demo' },
    action: 'created', check_run: { head_sha: 'a'.repeat(40), status: 'queued' } }));
  assert.deepEqual(h.json(['ci', 'webhook', payload]), { ignored: true });
});
