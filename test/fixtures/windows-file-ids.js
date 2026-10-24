'use strict';

// File ids as Windows reports them. NTFS puts a sequence number in the top 16
// bits of a file id, so ids run past 2^53, where Node rounds a Number stat's
// ino and neighbouring files share one value; a bigint stat keeps the exact id.
// Preloaded with TOWER_CRANE_TEST_WINDOWS_IDS set, it shifts every id the CLI
// sees. A test calls windowsFileIds to shift the ids it sees the same way.
const fs = require('node:fs');

const BASE = 2n ** 63n;

// Ids a test chooses, whatever id the runner hands out. Past 2^63 a Number
// keeps multiples of 2^11: `exact` ids are such multiples and survive a Number
// unchanged, `rounds` ids sit one past one and always round. The low 48 bits
// of a real id (an NTFS file record number, a Unix inode) keep live files apart.
const INJECTED = {
  exact: (ino) => BASE + (ino % 2n ** 48n) * 2n ** 12n,
  rounds: (ino) => BASE + (ino % 2n ** 48n) * 2n ** 12n + 1n,
};

// `exact` maps a file's real inode to its simulated exact id.
function windowsFileIds(exact = (ino) => BASE + ino) {
  const originals = { statSync: fs.statSync, lstatSync: fs.lstatSync, fstatSync: fs.fstatSync };
  for (const [name, original] of Object.entries(originals)) {
    fs[name] = function windowsIds(target, options, ...rest) {
      const st = original.call(this, target, options, ...rest);
      if (!st) return st;
      if (typeof st.ino === 'bigint') st.ino = exact(st.ino);
      else {
        // Node rounds a Number ino from the exact id once. A Windows runner's
        // real id is already past 2^53, so shifting the rounded Number would
        // round twice and can land on another value than the exact id does.
        const big = original.call(this, target, { ...options, bigint: true }, ...rest);
        st.ino = Number(exact(big ? big.ino : BigInt(st.ino)));
      }
      return st;
    };
  }
  return () => Object.assign(fs, originals);
}

const preload = process.env.TOWER_CRANE_TEST_WINDOWS_IDS;
if (preload) windowsFileIds(INJECTED[preload]);

module.exports = { windowsFileIds, BASE, INJECTED };
