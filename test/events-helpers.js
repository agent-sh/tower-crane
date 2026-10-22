'use strict';

// The fixture, child waiter and event checks the events suites share; each suite file runs in its own process.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const { HUNG_TEST_MS, killPid } = require('./signals');
const { cachedFixture, BIN, HOOKS } = require('./helpers');
const StateFiles = require('./state-files');

function log(h) {
  const raw = StateFiles.logText(h.state);
  // A concurrent append becomes readable only when its final newline arrives.
  return raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}

function setup(t, flags = []) {
  const h = cachedFixture(null, JSON.stringify(flags), (h) => {
    h.init(flags);
    h.ok(['task', 'add', '--title', 'Change', '--acceptance', 'works']);
  });
  h.children = [];
  h.workerPids = [];
  t.after(async () => {
    for (const pid of h.workerPids) {
      try { killPid(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    for (const { p } of h.children) {
      if (p.exitCode === null && p.signalCode === null) p.kill();
    }
    await Promise.all(h.children.map((c) => c.result));
    // Windows keeps a running child's cwd open, so stop children first.
    await h.cleanup();
  });
  return h;
}

function child(t, h, args, hooks = {}) {
  const p = cp.spawn(process.execPath, ['--require', HOOKS, BIN, ...args], {
    cwd: h.repo, env: { ...h.env, HOOK_STATE: h.state, ...hooks },
  });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  // A hung child cannot hold teardown beyond the suite backstop.
  const timer = setTimeout(() => p.kill(), HUNG_TEST_MS);
  const result = once(p, 'close').then(([code]) => {
    clearTimeout(timer);
    return { code, stdout, stderr };
  });
  const c = { p, result };
  h.children.push(c);
  return c;
}

async function event(result, type, task = 'T1') {
  const r = await (result.result || result);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const e = JSON.parse(r.stdout);
  assert.equal(e.type, type);
  assert.equal(e.task, task);
  assert.match(e.id, /^E/);
  assert.ok(e.offset > 0);
  return e;
}

module.exports = { log, setup, child, event };
