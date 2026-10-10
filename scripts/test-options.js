#!/usr/bin/env node
'use strict';

// Node 26 option probes. Three interleaved runs per variant, including the
// number of executed assertions so a filter matching nothing cannot win.
// node scripts/test-options.js [--json results.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { measure, median } = require('./test-cost');

const ROOT = path.join(__dirname, '..');
const FILES = ['test/browser-startup.test.js', 'test/gates/tests.test.js', 'test/test-tools.test.js'];

async function main() {
  const scratch = fs.mkdtempSync(path.join(process.env.TOWER_CRANE_TEST_TMP || os.tmpdir(), 'tower-crane-options-'));
  const fixture = path.join(scratch, 'options.test.cjs');
  fs.writeFileSync(path.join(scratch, 'service.cjs'), 'exports.read = () => "real";\n');
  fs.writeFileSync(fixture, `
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mode = process.env.OPTION_PROBE;
let executed = 0;
test.after(() => fs.writeFileSync(process.env.OPTION_COUNT, String(executed)));
if (mode.endsWith('timers')) {
  test('timer callbacks', async (t) => {
    if (mode === 'mock-timers') t.mock.timers.enable({ apis: ['setTimeout'] });
    for (let i = 0; i < 24; i++) {
      const fired = new Promise(resolve => setTimeout(() => resolve(i), 50));
      if (mode === 'mock-timers') t.mock.timers.tick(50);
      assert.equal(await fired, i);
      executed++;
    }
  });
} else if (['manual', 'method', 'module'].includes(mode)) {
  test('local dependency', (t) => {
    let service;
    if (mode === 'module') {
      t.mock.module('./service.cjs', { namedExports: { read: () => 'stub' } });
      service = require('./service.cjs');
    } else {
      service = require('./service.cjs');
      if (mode === 'method') t.mock.method(service, 'read', () => 'stub');
      else {
        const original = service.read;
        service.read = () => 'stub';
        t.after(() => { service.read = original; });
      }
    }
    for (let i = 0; i < 24; i++) { assert.equal(service.read(), 'stub'); executed++; }
  });
} else {
  for (let i = 0; i < 20; i++) {
    test(i === 0 ? 'selected' : 'other ' + i, { tags: [i === 0 ? 'focus' : 'other'] }, async () => {
      assert.equal(await new Promise(resolve => setTimeout(() => resolve(i), 25)), i);
      executed++;
    });
  }
}
`);
  const samples = {};
  const commands = {};
  const run = async (name, argv, env = process.env) => {
    commands[name] = {
      argv: argv.map((arg) => arg === fixture ? '<probe>/options.test.cjs' : arg),
      ...(env.OPTION_PROBE ? { env: { OPTION_PROBE: env.OPTION_PROBE, OPTION_COUNT: '<probe>/count' } } : {}),
    };
    const sample = await measure(ROOT, argv, env);
    assert.equal(sample.status, 0, `${name} failed`);
    (samples[name] ||= []).push(sample);
    return sample;
  };
  try {
    const workers = Math.min(2, Math.max(1, os.availableParallelism() - 1));
    for (let trial = 0; trial < 3; trial++) {
      await run('files', ['test/run.js', `--test-concurrency=${workers}`, ...FILES]);
      const shards = [];
      // Never exceed the unsharded worker count on the measurement machine.
      for (let first = 1; first <= 3; first += workers) {
        const batch = [];
        for (let shard = first; shard < Math.min(first + workers, 4); shard++) {
          batch.push(measure(ROOT, ['test/run.js', '--test-concurrency=1', `--test-shard=${shard}/3`, ...FILES]));
        }
        shards.push(await Promise.all(batch));
      }
      assert.ok(shards.flat().every((s) => s.status === 0), 'a shard failed');
      (samples.shards ||= []).push({
        wall: shards.reduce((sum, batch) => sum + Math.max(...batch.map((s) => s.wall)), 0),
        cpu: shards.flat().reduce((sum, s) => sum + s.cpu, 0), status: 0,
      });
      commands.shards = { argv: ['test/run.js', '--test-concurrency=1', '--test-shard=N/3', ...FILES] };
      for (const [name, mode, flags, count] of [
        ['real timers', 'real-timers', [], 24],
        ['mock timers', 'mock-timers', [], 24],
        ['manual stub', 'manual', [], 24],
        ['t.mock.method', 'method', [], 24],
        ['t.mock.module', 'module', ['--experimental-test-module-mocks'], 24],
        ['all cases', 'filter', [], 20],
        ['name filter', 'filter', ['--test-name-pattern=^selected$'], 1],
        ['tag filter', 'filter', ['--experimental-test-tag-filter=focus'], 1],
      ]) {
        const countFile = path.join(scratch, 'count');
        fs.rmSync(countFile, { force: true });
        const sample = await run(name, ['--test', '--test-concurrency=1', ...flags, fixture],
          { ...process.env, OPTION_PROBE: mode, OPTION_COUNT: countFile });
        sample.assertions = Number(fs.readFileSync(countFile, 'utf8'));
        assert.equal(sample.assertions, count, name);
      }
      console.error(`trial ${trial + 1}/3 complete`);
    }
    const rows = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
      cpu: median(values.map((s) => s.cpu)), wall: median(values.map((s) => s.wall)),
      cpu_range: [Math.min(...values.map(s => s.cpu)), Math.max(...values.map(s => s.cpu))],
      wall_range: [Math.min(...values.map(s => s.wall)), Math.max(...values.map(s => s.wall))],
    }]));
    const result = { node: process.version, runs: 3, workers, commands, samples, rows };
    console.log(JSON.stringify(result, null, 2));
    const out = process.argv.indexOf('--json');
    if (out !== -1) fs.writeFileSync(process.argv[out + 1], JSON.stringify(result, null, 2) + '\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
