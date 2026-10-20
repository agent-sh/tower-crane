'use strict';

// A test reporter for CI shards: one line as each test file starts and one as it
// ends, so a log cut off by a job time limit shows which files were still running.
// The runner enqueues every file up front, so a file starts with the first dequeue
// or start that names it, and ends with its own summary.
module.exports = async function* fileProgress(source) {
  const started = new Set();
  for await (const event of source) {
    const file = event.data?.file;
    if (!file) continue;
    if (!started.has(file) && ['test:dequeue', 'test:start'].includes(event.type)) {
      started.add(file);
      yield `file started: ${file}\n`;
    }
    if (event.type === 'test:summary') yield `file ended: ${file}\n`;
  }
};
