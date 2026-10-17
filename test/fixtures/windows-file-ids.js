'use strict';

// File ids as Windows reports them. NTFS puts a sequence number in the top 16
// bits of a file id, so ids run past 2^53, where Node rounds a Number stat's
// ino and neighbouring files share one value; a bigint stat keeps the exact id.
// Preloaded with TOWER_CRANE_TEST_WINDOWS_IDS set, it shifts every id the CLI
// sees. A test calls windowsFileIds to shift the ids it sees the same way.
const fs = require('node:fs');

const BASE = 2n ** 63n;

// `exact` maps a file's real inode to its simulated exact id.
function windowsFileIds(exact = (ino) => BASE + ino) {
  const originals = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
  for (const [name, original] of Object.entries(originals)) {
    fs[name] = function windowsIds(...args) {
      const st = original.apply(this, args);
      if (st) st.ino = typeof st.ino === 'bigint' ? exact(st.ino) : Number(exact(BigInt(st.ino)));
      return st;
    };
  }
  return () => Object.assign(fs, originals);
}

if (process.env.TOWER_CRANE_TEST_WINDOWS_IDS) windowsFileIds();

module.exports = { windowsFileIds, BASE };
