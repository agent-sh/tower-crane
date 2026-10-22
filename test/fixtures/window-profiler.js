'use strict';

// Preloaded by scripts/bench-supervision.js --profile: SIGUSR2 starts a CPU
// profile and the next SIGUSR2 writes it to WINDOW_PROFILE_DIR/<pid>.cpuprofile,
// so a profile covers one measured window and not startup.
const path = require('node:path');
const inspector = require('node:inspector');
const { writeAtomic } = require('../atomic-file');

let session = null;
process.on('SIGUSR2', () => {
  if (!session) {
    session = new inspector.Session();
    session.connect();
    session.post('Profiler.enable', () => session.post('Profiler.start'));
    return;
  }
  const done = session;
  session = null;
  done.post('Profiler.stop', (error, result) => {
    if (!error) writeAtomic(path.join(process.env.WINDOW_PROFILE_DIR, `${process.pid}.cpuprofile`), JSON.stringify(result.profile));
    done.disconnect();
  });
});
