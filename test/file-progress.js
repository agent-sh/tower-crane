'use strict';

// A test reporter for CI shards: one line as each test file starts and one as it
// ends, so a log cut off by a job time limit shows which files were still running.
// test/run.js runs each file in a runner of its own and prints these lines itself;
// with TC_TEST_PROGRESS_LOG each file's runner also appends them to that file as
// they happen, so the record survives a runner whose own event loop is blocked.
// Appends of a line each, from several runners at once, never mix. Without the
// variable the lines go to the reporter's destination.
const fs = require('node:fs');

module.exports = async function* fileProgress(source) {
  const log = process.env.TC_TEST_PROGRESS_LOG;
  const started = new Set();
  const say = (line) => {
    if (!log) return line;
    fs.appendFileSync(log, line);
    return '';
  };
  for await (const event of source) {
    const file = event.data?.file;
    if (!file) continue;
    if (!started.has(file) && ['test:dequeue', 'test:start'].includes(event.type)) {
      started.add(file);
      yield say(`file started: ${file}\n`);
    }
    if (event.type === 'test:summary') yield say(`file ended: ${file}\n`);
  }
};
