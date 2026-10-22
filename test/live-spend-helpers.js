'use strict';

// The live-spend fixture the live-spend suites share: a cached repository whose
// easy rung runs a harness stub that reports usage as it goes. Each suite file
// runs in its own process.

const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { waitOnRepo } = require('./signals');

const STUB = path.join(__dirname, 'fixtures', 'live-usage-harness.js').replace(/\\/g, '/');
const events = (h) => require('../lib/state').readEvents(h.state);
const recordedSpend = (h) => h.readState('tasks.json').tasks[0].spend;
const liveEntries = (h) => (recordedSpend(h).entries || []).filter((e) => e.live);

function until(t, h, fn, message, stream) {
  return waitOnRepo(h, fn, message, {
    signal: t.signal,
    subscribe: stream && ((probe) => {
      stream.on('data', probe);
      return () => stream.off('data', probe);
    }),
  });
}

function viewClock(h, at) {
  const file = path.join(h.base, 'view-clock');
  fs.writeFileSync(file, String(Date.parse(at) + 1000));
  return { hooks: { HOOK_CLOCK_FILE: file } };
}

function setup(t, harness, supervision = {}) {
  const h = cachedFixture(t, `live-spend:${harness}`, (fixture) => {
    fixture.init();
    fixture.ok(['task', 'add', '--title', 'Spend live', '--tier', 'easy', '--acceptance', 'budget holds']);
    fixture.ok(['brief', 'set', 'T1', '-'], { input: 'Work on T1.\n' });
    const bin = path.join(fixture.base, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, harness + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
    fixture.ok(['ladder', 'set', 'easy', '--harness', harness, '--model', 'dispatch-model', '--clear', 'profile', '--clear', 'effort',
      '--supervision', '{"usage_ms":500,"stall_ms":60000}']);
  });
  if (Object.keys(supervision).length) h.ok(['ladder', 'set', 'easy', '--supervision',
    JSON.stringify({ usage_ms: 500, stall_ms: 60000, ...supervision })]);
  const bin = path.join(h.base, 'bin');
  h.done = path.join(h.base, 'done');
  h.liveEnv = (extra = {}) => ({
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${STUB}"`, LIVE_DONE: h.done, ...extra,
  });
  return h;
}

const exited = (h, agent) => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent && e.detail.code !== undefined);

module.exports = { events, recordedSpend, liveEntries, until, viewClock, setup, exited };
