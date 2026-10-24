'use strict';

// Leaves a process whose parent has exited, then never ends: the shard guard test stops it.
// Windows does not reparent, so taskkill /T from the root cannot reach that process.
const cp = require('node:child_process');

require('node:test')('shard orphan', () => {
  const keep = 'setInterval(() => {}, 60000)'; // wait-allow: the orphan stays until the guard stops it
  const parent = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(keep)}], { detached: true, stdio: 'ignore' });
require('node:fs').writeFileSync(process.env.TC_ORPHAN_FILE, JSON.stringify({ pid: c.pid, token: process.env.TC_SHARD_PROGRESS_TOKEN ?? null }));
c.unref();`;
  cp.spawnSync(process.execPath, ['-e', parent], { stdio: 'ignore', timeout: 60000 }); // wait-allow: one short parent process
  return new Promise(() => setInterval(() => {}, 60000)); // wait-allow: held open until the guard's deadline under test
});
