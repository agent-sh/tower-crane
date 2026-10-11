'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// This is the runner's hung-test backstop, never a readiness budget.
const HUNG_TEST_MS = 300000;

function waitUntil(check, { paths = [], signal, subscribe, poll = true, what = 'signal wait' } = {}) {
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
        const value = await check();
        if (value) finish(null, value, false);
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

function fileWritten(file, { check = () => true, ...options } = {}) {
  return waitUntil(() => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      return check(text) ? { text } : false;
    }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, { paths: [file], what: `file written: ${file}`, ...options }).then(({ text }) => text);
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

module.exports = { HUNG_TEST_MS, waitUntil, waitOnRepo, fileWritten, eventAppended, childExit, childClosed, portListening };
