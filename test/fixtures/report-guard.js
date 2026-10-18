'use strict';

// test/run.js loads this into every test file process. Node's runner counts a
// file as passed when its process exits 0, however few of its tests reached
// the runner, so two things dropped tests without a failure:
// - Under --test-force-exit the process ends with process.exit() once its last
//   test finishes. Report bytes still queued for a full stdout pipe die with
//   it: on a loaded host the runner drains the pipe late and reads only the
//   first tests. Blocking writes leave nothing queued.
// - A process.exit() in a test, or in code it calls, skips every later test.
// Either one now fails the file, naming the cause.

if (process.env.NODE_TEST_CONTEXT === 'child-v8') {
  const dc = require('node:diagnostics_channel');
  const fs = require('node:fs');
  for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);

  // The runner starts the root test only after every top-level test has finished.
  let started = false;
  let finished = false;
  dc.subscribe('tracing:node.test:start', (c) => { if (c.name !== '<root>') started = true; });
  dc.subscribe('tracing:node.test:end', (c) => { if (c.name === '<root>') finished = true; });

  process.once('exit', () => {
    if (process.exitCode) return;
    const problems = [];
    if (started && !finished) problems.push('the process exited before all its tests finished, as a process.exit() in a test or the code it calls does');
    const unwritten = (process.stdout.writableLength || 0) + (process.stdout._handle?.writeQueueSize || 0);
    if (unwritten) problems.push(`${unwritten} bytes of its test report were still unwritten`);
    if (!problems.length) return;
    try { fs.writeSync(2, `test file ${process.argv[1]}: ${problems.join('; ')}\n`); } catch {}
    process.exitCode = 1;
  });
}
