'use strict';

const fs = require('node:fs');
const path = require('node:path');
const rename = fs.renameSync;
const lock = path.join(process.env.HOOK_STATE, 'lock');

// Another writer recreates the lock after each cleanup, before acquisition.
fs.renameSync = function reclaimRace(from, to, ...args) {
  if (to !== lock) return rename.call(this, from, to, ...args);
  fs.mkdirSync(lock, { recursive: true });
  if (process.env.LOCK_RECLAIM_KIND === 'stale') {
    const marker = path.join(lock, '00112233aabbccdd');
    fs.writeFileSync(marker, JSON.stringify({ pid: 1, host: 'another-host' }));
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(marker, old, old);
  }
  fs.appendFileSync(process.env.LOCK_RECLAIM_ATTEMPTS, '.');
  throw Object.assign(new Error('concurrent lock replacement'), { code: 'EEXIST' });
};
