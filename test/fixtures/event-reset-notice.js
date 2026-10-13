'use strict';

const { EventReader } = require('../../lib/event-reader');
const { parseEvent } = require('../../lib/events');
const read = EventReader.prototype.read;

EventReader.prototype.read = function (...args) {
  const batch = read.apply(this, args);
  if (this.parse === parseEvent || batch.rows.some((row) => typeof row.offset === 'number')) {
    // Notify after the caller handles the batch, without timing the test against a poll.
    setImmediate(() => {
      if (process.connected) process.send({ type: 'event-read', reset: batch.reset, offset: batch.offset });
    });
  }
  return batch;
};

if (process.connected) {
  process.on('message', (message) => {
    if (message !== 'stop') throw new Error('unexpected reader command');
    process.disconnect();
    process.emit('SIGTERM');
  });
  process.channel.unref();
}
