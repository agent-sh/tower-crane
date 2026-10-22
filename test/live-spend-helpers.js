'use strict';

// The live-spend fixture the live-spend suites share: a cached repository whose
// easy rung runs a harness stub that reports usage as it goes. Each suite file
// runs in its own process.

const fs = require('node:fs');
const path = require('node:path');
const { cachedFixture } = require('./helpers');
const { waitOnRepo, killPid } = require('./signals');

const STUB = path.join(__dirname, 'fixtures', 'live-usage-harness.js').replace(/\\/g, '/');
const events = (h) => require('../lib/state').readEvents(h.state);
const recordedSpend = (h) => h.readState('tasks.json').tasks[0].spend;
const liveEntries = (h) => (recordedSpend(h).entries || []).filter((e) => e.live);

// What the fixture shows of a stuck wait: the last events, whether the
// supervisor and harness still run, the state lock's holder, and the end of
// the dispatch log, where the supervisor writes, and of the supervisor trace.
function fixtureState(h) {
  try {
    const log = events(h);
    const spawned = log.findLast((e) => e.cmd === 'spawn')?.detail;
    const alive = (pid) => { try { killPid(pid, 0); return 'alive'; } catch (e) { return e.code || e.message; } };
    const lock = path.join(h.state, 'lock');
    const holders = fs.existsSync(lock) ? fs.readdirSync(lock).map((n) => fs.readFileSync(path.join(lock, n), 'utf8')).join(' ') : 'none';
    return `last events: ${log.slice(-12).map((e) => e.cmd).join(', ')}; supervisor ${spawned?.monitor_pid} ${spawned ? alive(spawned.monitor_pid) : '-'}; `
      + `harness ${spawned?.pid} ${spawned?.pid ? alive(spawned.pid) : '-'}, done: ${fs.existsSync(h.done)}; state lock: ${holders}; `
      + `dispatch log ends: ${spawned ? fs.readFileSync(spawned.log, 'utf8').slice(-2000) : '(none)'}; `
      // read-published: the trace is only appended to, never replaced
      + `trace ends: ${fs.existsSync(h.trace) ? fs.readFileSync(h.trace, 'utf8').split('\n').slice(-60).join('\n') : '(none)'}`;
  } catch (e) { return `fixture unreadable: ${e.message}`; }
}

// The runner's timeout reports only the test, so an aborted wait names itself
// and what the fixture shows.
function until(t, h, fn, message, stream) {
  return waitOnRepo(h, fn, message, {
    signal: t.signal,
    subscribe: stream && ((probe) => {
      stream.on('data', probe);
      return () => stream.off('data', probe);
    }),
  }).catch((error) => {
    if (t.signal.aborted) process.stderr.write(`${message}: still waiting when the test was aborted; ${fixtureState(h)}\n`);
    throw error;
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
  h.trace = path.join(h.base, 'live-trace');
  h.liveEnv = (extra = {}) => ({
    PATH: bin + path.delimiter + (h.env.PATH || h.env.Path || ''),
    NODE_OPTIONS: `--require "${STUB}"`, LIVE_DONE: h.done, LIVE_TRACE: h.trace, ...extra,
  });
  return h;
}

const exited = (h, agent) => events(h).some((e) => e.cmd === 'spawn exit' && e.detail.agent === agent && e.detail.code !== undefined);

module.exports = { events, recordedSpend, liveEntries, fixtureState, until, viewClock, setup, exited };
