'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// This is the runner's hung-test backstop, never a readiness budget.
const HUNG_TEST_MS = 300000;

// A process the test holds can end the wait early: once it is gone and the
// condition is still false, nothing will make it true. `alive` takes a child
// process, a detached pid or a function.
function liveness(alive) {
  if (!alive) return null;
  if (typeof alive === 'function') return { running: alive };
  if (typeof alive === 'number') return { running: () => require('./helpers').detachedAlive({ pid: alive }) };
  return {
    running: () => alive.exitCode === null && alive.signalCode === null,
    subscribe: (probe) => { alive.on('exit', probe); return () => alive.off('exit', probe); },
  };
}

function waitUntil(check, { paths = [], signal, subscribe, poll = true, alive, what = 'signal wait' } = {}) {
  const held = liveness(alive);
  return new Promise((resolve, reject) => {
    const cleanups = [];
    let finished = false;
    let checking = false;
    let again = false;
    const finish = (error, value, failed = true) => {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      if (failed) reject(error);
      else resolve(value);
    };
    const probe = async () => {
      if (finished) return;
      if (checking) { again = true; return; }
      checking = true;
      try {
        // Read liveness before the condition: whatever the process wrote
        // before it exited is then visible to this check.
        const running = !held || held.running();
        const value = await check();
        if (value) finish(null, value, false);
        else if (!running) finish(new Error(`${typeof what === 'function' ? what() : what}: the process exited first`));
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
        if (again) { again = false; void probe(); }
      }
    };
    const abort = () => finish(signal.reason);
    try {
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        cleanups.push(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) { abort(); return; }
      }
      // Watch the parent so atomic replacement keeps producing notifications.
      // A missing parent is covered by its nearest existing ancestor.
      const roots = new Set(paths.map((entry) => {
        let dir = path.resolve(entry);
        while (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
        return dir;
      }));
      for (const dir of roots) {
        try {
          const watcher = fs.watch(dir, { recursive: true }, probe);
          cleanups.push(() => watcher.close());
          watcher.on('error', (error) => {
            watcher.close();
            // Node's recursive watcher can encounter intentionally restricted
            // fixture tools. The predicate probe still observes their state.
            if (!poll) finish(error);
          });
        } catch (error) {
          if (!poll) throw error;
        }
      }
      if (subscribe) cleanups.push(subscribe(probe, finish));
      if (held?.subscribe) cleanups.push(held.subscribe(probe));
      // Processes outside our child tree and browser protocol predicates have
      // no portable exit/change notification. Probes have no readiness deadline.
      if (poll) {
        const timer = setInterval(probe, 25);
        cleanups.push(() => clearInterval(timer));
      }
      const hung = setTimeout(() => finish(new Error(`${typeof what === 'function' ? what() : what}: hung-test timeout`)), HUNG_TEST_MS);
      cleanups.push(() => clearTimeout(hung));
      void probe();
    } catch (error) {
      finish(error);
    }
  });
}

// With `json`, check and the result take the parsed value. A writer that does
// not publish through writeAtomic (test/atomic-file.js) can leave the file
// empty or half written; that is not written yet, so the wait goes on.
function fileWritten(file, { check = () => true, json = false, ...options } = {}) {
  return waitUntil(() => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (!json) return check(text) ? { text } : false;
    let value;
    try { value = JSON.parse(text); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
    return check(value) ? { value } : false;
  }, { paths: [file], what: `file written: ${file}`, ...options }).then((found) => json ? found.value : found.text);
}

function waitOnRepo(h, check, what, options) {
  return waitUntil(() => {
    try { return check(); }
    catch (error) {
      // Existing fixture readers can observe JSON while a child writes it.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }, { paths: [h.base], what, ...options });
}

function eventAppended(file, predicate, options) {
  let event;
  return fileWritten(file, {
    ...options,
    // The last record may still be in flight when fs.watch fires.
    check: (text) => (event = text.split('\n').slice(0, -1).filter(Boolean).map(JSON.parse).find(predicate)),
  }).then(() => event);
}

function childExit(child, options) {
  return waitUntil(() => child.exitCode !== null || child.signalCode !== null
    ? { code: child.exitCode, signal: child.signalCode } : false, {
    ...options, poll: false,
    subscribe: (probe, fail) => {
      child.on('exit', probe);
      child.on('error', fail);
      return () => { child.off('exit', probe); child.off('error', fail); };
    },
  });
}

const closedChildren = new WeakMap();
function childClosed(child, options) {
  return waitUntil(() => closedChildren.get(child)
    || ((child.exitCode !== null || child.signalCode !== null)
      && (!child.stdout || child.stdout.closed) && (!child.stderr || child.stderr.closed)
      ? { code: child.exitCode, signal: child.signalCode } : false), {
    ...options, poll: false,
    subscribe: (probe, fail) => {
      const closed = (code, signal) => { closedChildren.set(child, { code, signal }); void probe(); };
      child.on('close', closed);
      child.on('error', fail);
      return () => { child.off('close', closed); child.off('error', fail); };
    },
  });
}

function portListening(port, host = '127.0.0.1', options) {
  let socket;
  return waitUntil(() => new Promise((resolve, reject) => {
    socket = net.connect({ port, host });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  }), {
    ...options,
    subscribe: () => () => socket?.destroy(),
  });
}

// A pid a test reads from a file or an event is 0 or NaN when the writer has
// not finished: Number('') is 0. process.kill(0) signals the test's own
// process group, which is the whole suite, and -1 every process the user
// owns. Every test signal to a pid it did not just spawn goes through these,
// and scripts/test-waits.js rejects a bare process.kill on any other pid.
function checkedPid(pid, least) {
  if (!Number.isInteger(pid) || pid < least) throw new Error(`refusing to signal pid ${String(pid)}: not a process id`);
  return pid;
}

function killPid(pid, signal = 'SIGTERM') {
  return process.kill(checkedPid(pid, 1), signal);
}

// Group 1 would be -1, every process the user can signal.
function killGroup(pid, signal = 'SIGTERM') {
  return process.kill(-checkedPid(pid, 2), signal);
}

module.exports = { HUNG_TEST_MS, waitUntil, waitOnRepo, fileWritten, eventAppended, childExit, childClosed, portListening, killPid, killGroup };
